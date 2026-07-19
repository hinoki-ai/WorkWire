import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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
  } = {}) {
    const artifact = artifactOrMetadata?.id
      ? artifactOrMetadata
      : await createArtifact(artifactOrMetadata || {});
    let body = source;
    let length = null;
    const explicitOffset = Number.isSafeInteger(Number(offset)) && Number(offset) >= 0;
    let start = Number(offset);
    if (!Number.isSafeInteger(start) || start < 0) {
      const head = await headArtifact(artifact.id, { timeoutMs, signal });
      start = head.complete ? head.size : head.size;
    }
    if (typeof source === "string") {
      const stats = await fs.stat(source);
      const requestedSize = Number(size);
      length = Number.isSafeInteger(requestedSize) && requestedSize >= 0
        ? requestedSize
        : Math.max(0, stats.size - start);
      body = fsSync.createReadStream(source, {
        start,
        ...(length > 0 ? { end: start + length - 1 } : {}),
      });
    } else if (Buffer.isBuffer(source) || ArrayBuffer.isView(source)) {
      const buffer = Buffer.from(source);
      body = explicitOffset ? buffer : buffer.subarray(start);
      length = body.length;
    }
    if (!body) throw new TypeError("Recovery artifact upload requires a source stream, buffer, or path.");
    let sent = 0;
    if (typeof body?.on === "function" && onProgress) body.on("data", (chunk) => {
      sent += chunk.length;
      onProgress({ artifactId: artifact.id, direction: "upload", bytes: start + sent, total: length == null ? null : start + length });
    });
    const timeout = timeoutSignal(timeoutMs, signal);
    try {
      const response = await fetchImpl(`${baseUrl}/v1/recovery/artifacts/${encodeURIComponent(artifact.id)}`, {
        method: "PUT",
        headers: headers({
          "x-ww-artifact-offset": String(start),
          "x-ww-artifact-complete": String(complete),
          ...(length === null ? {} : { "content-length": String(length) }),
        }),
        body,
        duplex: "half",
        signal: timeout.signal,
      });
      if (!response.ok) throw await responseError(response);
      return (await response.json()).artifact;
    } finally {
      timeout.cleanup();
    }
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
      await fs.rename(temporaryPath, target);
      return { path: target, bytes: Number(offset) + received, hash: response.headers.get("x-ww-artifact-hash") || null };
    } finally {
      timeout.cleanup();
    }
  }

  async function wake(input, options = {}) {
    return (await requestJson("/v1/recovery/wake", { method: "POST", body: input, ...options })).wake;
  }

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
  };
}

export { buildBaseUrl };
