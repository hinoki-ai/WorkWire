import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { renameRecoveryFile } from "./ww-recovery-atomic.mjs";

function buildBaseUrl(options = {}) {
  const explicit = String(options.url || options.baseUrl || "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  const host = String(options.host || "127.0.0.1").trim();
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}:${Number(options.port) || 4852}`;
}

function timeoutSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  let timer = null;
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  if (Number(timeoutMs) > 0) {
    timer = setTimeout(() => controller.abort(new Error(`Recovery request timed out after ${timeoutMs}ms.`)), Number(timeoutMs));
    timer.unref?.();
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
    },
  };
}

async function responseError(response) {
  let payload = null;
  try { payload = await response.json(); } catch {}
  const error = new Error(payload?.error?.message || `Recovery request failed with ${response.status} ${response.statusText}.`);
  error.code = payload?.error?.code || `ERR_HTTP_${response.status}`;
  error.status = response.status;
  error.details = payload?.error?.details;
  if (payload?.error?.actualOffset !== undefined) error.actualOffset = payload.error.actualOffset;
  if (payload?.error?.actualHash !== undefined) error.actualHash = payload.error.actualHash;
  return error;
}

function isRetryableRecoveryTransportError(error, signal) {
  if (signal?.aborted || Number(error?.status) > 0) return false;
  const code = String(error?.code || error?.cause?.code || "");
  return error instanceof TypeError || [
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
  ].includes(code);
}

function isRetryableArtifactUploadError(error, signal) {
  return error?.code === "ERR_WW_RECOVERY_ARTIFACT_OFFSET"
    || isRetryableRecoveryTransportError(error, signal);
}

function recoveryRetryDelay(attempt) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(800, 150 * (2 ** attempt))));
}

export function createRecoveryClient(options = {}) {
  const baseUrl = buildBaseUrl(options);
  const token = String(options.token || "");
  const fetchImpl = options.fetchImpl || fetch;
  const defaultTimeoutMs = Number(options.timeoutMs) || 8_000;
  const transferTimeoutMs = options.transferTimeoutMs === undefined ? 0 : Number(options.transferTimeoutMs);

  function headers(extra = {}) {
    return {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  }

  async function requestJson(pathname, {
    method = "GET",
    body,
    timeoutMs = defaultTimeoutMs,
    signal,
  } = {}) {
    const timeout = timeoutSignal(timeoutMs, signal);
    try {
      const response = await fetchImpl(`${baseUrl}${pathname}`, {
        method,
        headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: timeout.signal,
      });
      if (!response.ok) throw await responseError(response);
      return await response.json();
    } catch (error) {
      if (timeout.signal.aborted && !error.code) {
        error.code = "ERR_WW_RECOVERY_TIMEOUT";
      }
      throw error;
    } finally {
      timeout.cleanup();
    }
  }

  async function connect(options = {}) {
    const payload = await requestJson("/v1/recovery/info", options);
    if (Number(payload.controller?.protocol) !== 1) {
      const error = new Error(`Unsupported recovery controller protocol ${payload.controller?.protocol}.`);
      error.code = "ERR_WW_RECOVERY_PROTOCOL";
      throw error;
    }
    return payload.controller;
  }

  async function getInfo(options = {}) {
    return (await requestJson("/v1/recovery/info", options)).controller;
  }

  async function listAgents({ online = false, ...options } = {}) {
    return (await requestJson(`/v1/recovery/agents${online ? "?online=true" : ""}`, options)).agents;
  }

  async function getAgent(agentId, options = {}) {
    return requestJson(`/v1/recovery/agents/${encodeURIComponent(agentId)}`, options);
  }

  async function listMacAddresses(options = {}) {
    return (await requestJson("/v1/recovery/mac-addresses", options)).machines;
  }

  async function requestInventory(agentId, options = {}) {
    const { timeoutMs = 120_000, ...body } = options;
    return requestJson(`/v1/recovery/agents/${encodeURIComponent(agentId)}/inventory`, {
      method: "POST",
      body,
      timeoutMs: body.wait ? timeoutMs : defaultTimeoutMs,
    });
  }

  async function createCase(input, options = {}) {
    return (await requestJson("/v1/recovery/cases", { method: "POST", body: input, ...options })).case;
  }

  async function listCases(filters = {}, options = {}) {
    const query = new URLSearchParams();
    if (filters.agentId) query.set("agentId", filters.agentId);
    if (filters.state) query.set("state", filters.state);
    return (await requestJson(`/v1/recovery/cases${query.size ? `?${query}` : ""}`, options)).cases;
  }

  async function getCase(caseId, options = {}) {
    return requestJson(`/v1/recovery/cases/${encodeURIComponent(caseId)}`, options);
  }

  async function updateGoal(caseId, goal, options = {}) {
    return (await requestJson(`/v1/recovery/cases/${encodeURIComponent(caseId)}/goal`, { method: "POST", body: { goal }, ...options })).case;
  }

  async function runCase(caseId, options = {}) {
    return requestJson(`/v1/recovery/cases/${encodeURIComponent(caseId)}/run`, { method: "POST", body: {}, ...options });
  }

  async function stopCase(caseId, options = {}) {
    return requestJson(`/v1/recovery/cases/${encodeURIComponent(caseId)}/stop`, { method: "POST", body: {}, ...options });
  }

  async function submitCaseAction(caseId, action, options = {}) {
    return requestJson(`/v1/recovery/cases/${encodeURIComponent(caseId)}/action`, { method: "POST", body: action, ...options });
  }

  async function listPlaybooks(options = {}) {
    return (await requestJson("/v1/recovery/playbooks", options)).playbooks;
  }

  async function expandPlaybook(playbookId, input = {}, options = {}) {
    return (await requestJson(`/v1/recovery/playbooks/${encodeURIComponent(playbookId)}/expand`, { method: "POST", body: input, ...options })).plan;
  }

  async function createJob(input, options = {}) {
    return (await requestJson("/v1/recovery/jobs", { method: "POST", body: input, ...options })).job;
  }

  async function getJob(jobId, { after = 0, ...options } = {}) {
    return requestJson(`/v1/recovery/jobs/${encodeURIComponent(jobId)}${after ? `?after=${after}` : ""}`, options);
  }

  async function cancelJob(jobId, options = {}) {
    return (await requestJson(`/v1/recovery/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: {}, ...options })).job;
  }

  async function retryJob(jobId, options = {}) {
    return (await requestJson(`/v1/recovery/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST", body: {}, ...options })).job;
  }

  async function listEvents(caseId, { after = 0, ...options } = {}) {
    return (await requestJson(`/v1/recovery/cases/${encodeURIComponent(caseId)}/events?after=${Number(after) || 0}`, options)).events;
  }

  function subscribeEvents(caseId, {
    after = 0,
    onEvent = () => {},
    onError = () => {},
    signal,
  } = {}) {
    const controller = new AbortController();
    const abortExternal = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortExternal();
    else signal?.addEventListener("abort", abortExternal, { once: true });
    const done = (async () => {
      try {
        const response = await fetchImpl(`${baseUrl}/v1/recovery/cases/${encodeURIComponent(caseId)}/events/stream?after=${Number(after) || 0}`, {
          headers: headers({ accept: "text/event-stream" }),
          signal: controller.signal,
        });
        if (!response.ok) throw await responseError(response);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (true) {
          const { done: ended, value } = await reader.read();
          if (ended) break;
          pending += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = pending.indexOf("\n\n")) !== -1) {
            const block = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            if (!block || block.startsWith(":")) continue;
            const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            try { onEvent(JSON.parse(data)); } catch {}
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) onError(error);
      } finally {
        signal?.removeEventListener("abort", abortExternal);
      }
    })();
    return {
      abort(reason) { controller.abort(reason); },
      done,
    };
  }

  async function listArtifacts({ caseId = "", jobId = "" } = {}, options = {}) {
    const query = new URLSearchParams();
    if (caseId) query.set("caseId", caseId);
    if (jobId) query.set("jobId", jobId);
    return requestJson(`/v1/recovery/artifacts${query.size ? `?${query}` : ""}`, options);
  }

  async function createArtifact(metadata, options = {}) {
    return (await requestJson("/v1/recovery/artifacts", { method: "POST", body: metadata, ...options })).artifact;
  }

  async function headArtifact(artifactId, options = {}) {
    const timeout = timeoutSignal(options.timeoutMs ?? transferTimeoutMs, options.signal);
    try {
      const response = await fetchImpl(`${baseUrl}/v1/recovery/artifacts/${encodeURIComponent(artifactId)}`, {
        method: "HEAD",
        headers: headers(),
        signal: timeout.signal,
      });
      if (!response.ok) throw await responseError(response);
      return {
        id: artifactId,
        size: Number(response.headers.get("x-ww-artifact-size") || response.headers.get("content-length") || 0),
        complete: response.headers.get("x-ww-artifact-complete") === "true",
        hash: response.headers.get("x-ww-artifact-hash") || null,
        contentType: response.headers.get("content-type") || "application/octet-stream",
      };
    } finally {
      timeout.cleanup();
    }
  }

  async function uploadArtifact(artifactOrMetadata, source, {
    offset,
    complete = true,
    size,
    timeoutMs = transferTimeoutMs,
    signal,
    onProgress,
    retries = 2,
  } = {}) {
    const artifact = artifactOrMetadata?.id
      ? artifactOrMetadata
      : await createArtifact(artifactOrMetadata || {});
    const explicitOffset = Number.isSafeInteger(Number(offset)) && Number(offset) >= 0;
    let start = Number(offset);
    if (!Number.isSafeInteger(start) || start < 0) {
      const head = await headArtifact(artifact.id, { timeoutMs, signal });
      if (head.complete) return { ...artifact, ...head };
      start = head.size;
    }
    const initialStart = start;
    const sourceIsPath = typeof source === "string";
    const sourceBuffer = Buffer.isBuffer(source) || ArrayBuffer.isView(source)
      ? Buffer.from(source)
      : null;
    const sourceStats = sourceIsPath ? await fs.stat(source) : null;
    const requestedSize = Number(size);
    const endOffset = sourceIsPath
      ? (Number.isSafeInteger(requestedSize) && requestedSize >= 0
          ? initialStart + requestedSize
          : sourceStats.size)
      : sourceBuffer
        ? (explicitOffset ? initialStart + sourceBuffer.length : sourceBuffer.length)
        : null;
    const replayable = sourceIsPath || Boolean(sourceBuffer);
    const maximumAttempts = 1 + Math.max(0, Number(retries) || 0);

    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      let body = source;
      let length = null;
      if (sourceIsPath) {
        length = Math.max(0, endOffset - start);
        body = fsSync.createReadStream(source, {
          start,
          ...(length > 0 ? { end: start + length - 1 } : {}),
        });
      } else if (sourceBuffer) {
        const bufferOffset = explicitOffset ? start - initialStart : start;
        body = sourceBuffer.subarray(Math.max(0, bufferOffset));
        length = body.length;
      } else if (attempt > 0) {
        throw new TypeError("A non-replayable recovery artifact stream cannot be retried.");
      }
      if (!body) throw new TypeError("Recovery artifact upload requires a source stream, buffer, or path.");
      let sent = 0;
      if (typeof body?.on === "function" && onProgress) body.on("data", (chunk) => {
        sent += chunk.length;
        onProgress({
          artifactId: artifact.id,
          direction: "upload",
          bytes: start + sent,
          total: endOffset,
        });
      });
      const timeout = timeoutSignal(timeoutMs, signal);
      let failure = null;
      try {
        const response = await fetchImpl(`${baseUrl}/v1/recovery/artifacts/${encodeURIComponent(artifact.id)}`, {
          method: "PUT",
          headers: headers({
            "x-ww-artifact-offset": String(start),
            "x-ww-artifact-complete": String(complete),
            ...(endOffset === null ? {} : { "x-ww-artifact-final-size": String(endOffset) }),
            ...(length === null ? {} : { "content-length": String(length) }),
          }),
          body,
          duplex: "half",
          signal: timeout.signal,
        });
        if (!response.ok) throw await responseError(response);
        return (await response.json()).artifact;
      } catch (error) {
        failure = error;
      } finally {
        timeout.cleanup();
      }
      body?.destroy?.();
      if (
        attempt + 1 >= maximumAttempts
        || !isRetryableArtifactUploadError(failure, signal)
      ) {
        throw failure;
      }
      await recoveryRetryDelay(attempt);
      const head = await headArtifact(artifact.id, { timeoutMs, signal });
      if (head.complete) {
        if (endOffset === null || head.size === endOffset) {
          return { ...artifact, ...head };
        }
        const error = new Error(`Recovery artifact ${artifact.id} completed at ${head.size} bytes; expected ${endOffset}.`);
        error.code = "ERR_WW_RECOVERY_ARTIFACT_SIZE";
        throw error;
      }
      if (!replayable) throw failure;
      if (head.size < initialStart || (endOffset !== null && head.size > endOffset)) {
        const error = new Error(`Recovery artifact ${artifact.id} resumed at unsafe offset ${head.size}.`);
        error.code = "ERR_WW_RECOVERY_ARTIFACT_OFFSET";
        throw error;
      }
      start = head.size;
    }
    throw new Error(`Recovery artifact upload retry loop ended unexpectedly for ${artifact.id}.`);
  }

  async function downloadArtifact(artifactId, {
    destinationPath,
    offset = 0,
    timeoutMs = transferTimeoutMs,
    signal,
    onProgress,
  } = {}) {
    const timeout = timeoutSignal(timeoutMs, signal);
    try {
      const response = await fetchImpl(`${baseUrl}/v1/recovery/artifacts/${encodeURIComponent(artifactId)}`, {
        headers: headers(Number(offset) > 0 ? { range: `bytes=${Number(offset)}-` } : {}),
        signal: timeout.signal,
      });
      if (!response.ok) throw await responseError(response);
      if (!destinationPath) return { response, stream: Readable.fromWeb(response.body) };
      const target = path.resolve(destinationPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporaryPath = `${target}.partial`;
      const append = Number(offset) > 0;
      let received = 0;
      const source = Readable.fromWeb(response.body);
      if (onProgress) source.on("data", (chunk) => {
        received += chunk.length;
        onProgress({ artifactId, direction: "download", bytes: Number(offset) + received });
      });
      await pipeline(source, fsSync.createWriteStream(temporaryPath, { flags: append ? "a" : "w", mode: 0o600 }));
      await renameRecoveryFile(fs, temporaryPath, target);
      return { path: target, bytes: Number(offset) + received, hash: response.headers.get("x-ww-artifact-hash") || null };
    } finally {
      timeout.cleanup();
    }
  }

  async function wake(input, options = {}) {
    return (await requestJson("/v1/recovery/wake", { method: "POST", body: input, ...options })).wake;
  }

  async function getNextStage({ refresh = false, ...options } = {}) {
    return (await requestJson(`/v1/recovery/next-stage${refresh ? "/refresh" : ""}`, refresh ? { method: "POST", body: {}, ...options } : options)).lanes;
  }
  async function invokeNextStage(lane, component, method, args = [], options = {}) {
    return (await requestJson(`/v1/recovery/next-stage/${encodeURIComponent(lane)}/${encodeURIComponent(component)}/${encodeURIComponent(method)}`, { method: "POST", body: { args }, timeoutMs: options.timeoutMs ?? 120_000, ...options })).result;
  }

  async function getFleet(options = {}) {
    return (await requestJson("/v1/recovery/fleet", options)).fleet;
  }

  async function listFleetMachines(query = "", options = {}) {
    return (await requestJson(`/v1/recovery/fleet/machines${query ? `?query=${encodeURIComponent(query)}` : ""}`, options)).machines;
  }

  async function setFleetMachine(agentId, patch, options = {}) {
    return (await requestJson(`/v1/recovery/fleet/machines/${encodeURIComponent(agentId)}`, { method: "POST", body: patch, ...options })).machine;
  }

  async function listFleetGroups(options = {}) { return (await requestJson("/v1/recovery/fleet/groups", options)).groups; }
  async function saveFleetGroup(input, options = {}) { return (await requestJson("/v1/recovery/fleet/groups", { method: "POST", body: input, ...options })).group; }
  async function deleteFleetGroup(id, options = {}) { return requestJson(`/v1/recovery/fleet/groups/${encodeURIComponent(id)}`, { method: "DELETE", ...options }); }
  async function listFleetQueries(options = {}) { return (await requestJson("/v1/recovery/fleet/queries", options)).queries; }
  async function saveFleetQuery(input, options = {}) { return (await requestJson("/v1/recovery/fleet/queries", { method: "POST", body: input, ...options })).query; }
  async function listFleetRuns(filters = {}, options = {}) { return (await requestJson(`/v1/recovery/fleet/runs${filters.state ? `?state=${encodeURIComponent(filters.state)}` : ""}`, options)).runs; }
  async function executeFleet(input, options = {}) { return (await requestJson("/v1/recovery/fleet/runs", { method: "POST", body: input, timeoutMs: options.timeoutMs ?? 30_000, ...options })).run; }
  async function getFleetRun(id, options = {}) { return (await requestJson(`/v1/recovery/fleet/runs/${encodeURIComponent(id)}`, options)).run; }
  async function getFleetSummary(id, options = {}) { return (await requestJson(`/v1/recovery/fleet/runs/${encodeURIComponent(id)}/summary`, options)).summary; }
  async function retryFleetFailed(id, input = {}, options = {}) { return (await requestJson(`/v1/recovery/fleet/runs/${encodeURIComponent(id)}/retry-failed`, { method: "POST", body: input, ...options })).run; }
  async function listFleetSchedules(options = {}) { return (await requestJson("/v1/recovery/fleet/schedules", options)).schedules; }
  async function saveFleetSchedule(input, options = {}) { return (await requestJson("/v1/recovery/fleet/schedules", { method: "POST", body: input, ...options })).schedule; }
  async function deleteFleetSchedule(id, options = {}) { return requestJson(`/v1/recovery/fleet/schedules/${encodeURIComponent(id)}`, { method: "DELETE", ...options }); }
  async function listFleetHealthRules(options = {}) { return requestJson("/v1/recovery/fleet/health-rules", options); }
  async function saveFleetHealthRule(input, options = {}) { return (await requestJson("/v1/recovery/fleet/health-rules", { method: "POST", body: input, ...options })).rule; }
  async function deleteFleetHealthRule(id, options = {}) { return requestJson(`/v1/recovery/fleet/health-rules/${encodeURIComponent(id)}`, { method: "DELETE", ...options }); }

  async function listSessions(filters = {}, options = {}) { return (await requestJson(`/v1/recovery/sessions${filters.agentId ? `?agentId=${encodeURIComponent(filters.agentId)}` : ""}`, options)).sessions; }
  async function openSession(input, options = {}) { return (await requestJson("/v1/recovery/sessions", { method: "POST", body: input, timeoutMs: options.timeoutMs ?? 30_000, ...options })).session; }
  async function getSession(id, options = {}) { return (await requestJson(`/v1/recovery/sessions/${encodeURIComponent(id)}`, options)).session; }
  async function listSessionEvents(id, { after = 0, ...options } = {}) { return (await requestJson(`/v1/recovery/sessions/${encodeURIComponent(id)}/events?after=${Number(after) || 0}`, options)).events; }
  async function sessionAction(id, action, body = {}, options = {}) { return requestJson(`/v1/recovery/sessions/${encodeURIComponent(id)}/${action}`, { method: "POST", body, timeoutMs: options.timeoutMs ?? 30_000, ...options }); }
  async function sessionInput(id, data, options = {}) { return sessionAction(id, "input", Buffer.isBuffer(data) ? { data: data.toString("base64"), encoding: "base64" } : { data: String(data ?? ""), encoding: options.encoding || "utf8" }, options); }
  async function sessionResize(id, rows, cols, options = {}) { return sessionAction(id, "resize", { rows, cols }, options); }
  async function sessionSignal(id, signal, options = {}) { return sessionAction(id, "signal", { signal }, options); }
  async function detachSession(id, options = {}) { return sessionAction(id, "detach", {}, options); }
  async function reconnectSession(id, input = {}, options = {}) { return sessionAction(id, "reconnect", input, options); }
  async function terminateSession(id, options = {}) { return sessionAction(id, "terminate", {}, options); }
  async function putSessionFile(id, remotePath, value, options = {}) { const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value); return requestJson(`/v1/recovery/sessions/${encodeURIComponent(id)}/files/put`, { method: "POST", body: { path: remotePath, data: buffer.toString("base64"), encoding: "base64", mode: options.mode }, timeoutMs: options.timeoutMs ?? 120_000 }); }
  async function getSessionFile(id, remotePath, options = {}) { const file = (await requestJson(`/v1/recovery/sessions/${encodeURIComponent(id)}/files/get`, { method: "POST", body: { path: remotePath }, timeoutMs: options.timeoutMs ?? 120_000 })).file; return { ...file, buffer: Buffer.from(file.data, "base64") }; }
  async function listTunnels(options = {}) { return (await requestJson("/v1/recovery/tunnels", options)).tunnels; }
  async function openTunnel(input, options = {}) { return (await requestJson("/v1/recovery/tunnels", { method: "POST", body: input, ...options })).tunnel; }
  async function closeTunnel(id, options = {}) { return (await requestJson(`/v1/recovery/tunnels/${encodeURIComponent(id)}/close`, { method: "POST", body: {}, ...options })).tunnel; }
  async function discoverConsoles(options = {}) { return (await requestJson("/v1/recovery/console/adapters", options)).adapters; }
  async function resolveConsole(input, options = {}) { return (await requestJson("/v1/recovery/console/resolve", { method: "POST", body: input, ...options })).console; }
  async function launchConsole(input, options = {}) { return (await requestJson("/v1/recovery/console/launch", { method: "POST", body: input, ...options })).console; }

  return {
    baseUrl,
    connect,
    getInfo,
    listAgents,
    getAgent,
    listMacAddresses,
    requestInventory,
    createCase,
    listCases,
    getCase,
    updateGoal,
    runCase,
    stopCase,
    submitCaseAction,
    listPlaybooks,
    expandPlaybook,
    createJob,
    getJob,
    cancelJob,
    retryJob,
    listEvents,
    subscribeEvents,
    listArtifacts,
    createArtifact,
    headArtifact,
    uploadArtifact,
    downloadArtifact,
    wake,
    getNextStage,
    invokeNextStage,
    getFleet,
    listFleetMachines,
    setFleetMachine,
    listFleetGroups,
    saveFleetGroup,
    deleteFleetGroup,
    listFleetQueries,
    saveFleetQuery,
    listFleetRuns,
    executeFleet,
    getFleetRun,
    getFleetSummary,
    retryFleetFailed,
    listFleetSchedules,
    saveFleetSchedule,
    deleteFleetSchedule,
    listFleetHealthRules,
    saveFleetHealthRule,
    deleteFleetHealthRule,
    listSessions,
    openSession,
    getSession,
    listSessionEvents,
    sessionInput,
    sessionResize,
    sessionSignal,
    detachSession,
    reconnectSession,
    terminateSession,
    putSessionFile,
    getSessionFile,
    listTunnels,
    openTunnel,
    closeTunnel,
    discoverConsoles,
    resolveConsole,
    launchConsole,
  };
}

export { buildBaseUrl };
