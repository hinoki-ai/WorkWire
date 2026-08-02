import http from "node:http";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { pipeline } from "node:stream/promises";
import { WebSocketServer } from "ws";
import {
  buildDefaultRecoveryConfig,
  normalizeRecoveryConfig,
  WW_RECOVERY_PROTOCOL_VERSION,
} from "./ww-recovery-config.mjs";
import { createRecoveryStore } from "./ww-recovery-store.mjs";
import {
  assertJsonMessageSize,
  assertValidAgentHello,
  createRecoveryError,
  generateRecoveryId,
  isTerminalJobState,
  RECOVERY_ERROR_CODES,
} from "./ww-recovery-protocol.mjs";
import { resolveAdvertisedHost } from "../ww-network.mjs";
import { sendWakeOnLan } from "./ww-recovery-wol.mjs";
import { createRecoveryAutonomyEngine } from "./ww-recovery-autonomy.mjs";
import { expandRecoveryPlaybook, loadRecoveryPlaybooks } from "./ww-recovery-playbooks.mjs";
import { createRecoveryBootManager } from "./ww-recovery-boot.mjs";

const API_PREFIX = "/v1/recovery";

function clone(value) {
  return structuredClone(value);
}

function iso(clock) {
  const milliseconds = typeof clock === "function" && !clock.now ? clock() : clock.now();
  return new Date(milliseconds).toISOString();
}

function serializeError(error) {
  return {
    code: error?.code || "ERR_WW_RECOVERY_INTERNAL",
    message: error?.message || "Recovery controller error.",
    ...(error?.details !== undefined ? { details: error.details } : {}),
    ...(error?.actualOffset !== undefined ? { actualOffset: error.actualOffset } : {}),
    ...(error?.actualHash !== undefined ? { actualHash: error.actualHash } : {}),
  };
}

function statusForError(error) {
  if (error?.code === RECOVERY_ERROR_CODES.NOT_FOUND) return 404;
  if (error?.code === RECOVERY_ERROR_CODES.AGENT_OFFLINE) return 409;
  if (error?.code === RECOVERY_ERROR_CODES.ARTIFACT_OFFSET) return 409;
  if (error?.code === RECOVERY_ERROR_CODES.INVALID_TRANSITION) return 409;
  if (error?.code === "ERR_WW_RECOVERY_UNAUTHORIZED") return 401;
  if (error?.code?.startsWith("ERR_WW_RECOVERY_BAD") || error?.code === RECOVERY_ERROR_CODES.PROTOCOL) return 400;
  return 500;
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    pragma: "no-cache",
  });
  response.end(body);
}

async function readJsonBody(request, maximumBytes) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > maximumBytes) {
    throw createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, "Recovery JSON request is too large.");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximumBytes) {
      throw createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, "Recovery JSON request is too large.");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("object required");
    return value;
  } catch (cause) {
    throw createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, `Invalid recovery JSON: ${cause.message}`);
  }
}

function matches(requestPath, expression) {
  const match = requestPath.match(expression);
  return match ? match.slice(1).map((value) => decodeURIComponent(value)) : null;
}

function safeFilename(value = "artifact.bin") {
  return String(value || "artifact.bin").replace(/[\r\n"\\/]/g, "_").slice(0, 240) || "artifact.bin";
}

export function createRecoveryController({
  config: rawConfig,
  store: providedStore = null,
  createStoreImpl = createRecoveryStore,
  createHttpServerImpl = http.createServer,
  WebSocketServerImpl = WebSocketServer,
  wakeImpl = sendWakeOnLan,
  bootManager = null,
  autonomy: providedAutonomy = null,
  clock = Date,
  randomBytesImpl = randomBytes,
  networkInterfaces,
  log = () => {},
} = {}) {
  const defaults = buildDefaultRecoveryConfig();
  const config = normalizeRecoveryConfig(rawConfig || defaults, defaults, { env: {} });
  const store = providedStore || createStoreImpl({ stateDir: config.stateDir, clock, randomBytesImpl });
  const ownsStore = !providedStore;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const sessions = new Map();
  const pendingInventory = new Map();
  const controllerId = generateRecoveryId("wwrc", { clock, randomBytesImpl });
  const wss = new WebSocketServerImpl({ noServer: true, maxPayload: config.maxJsonBytes });
  let server = null;
  let bootServer = null;
  let serverInfo = null;
  let bootInfo = null;
  let sweepTimer = null;
  let storeUnsubscribe = null;
  let started = false;
  let stopping = false;
  let autonomyEngine = providedAutonomy;
  let availablePlaybooks = [];
  let activeBootManager = bootManager;

  function authorized(request) {
    if (!config.token) return true;
    return request.headers.authorization === `Bearer ${config.token}`;
  }

  function requireAuthorization(request) {
    if (authorized(request)) return;
    const error = new Error("Recovery controller authorization failed.");
    error.code = "ERR_WW_RECOVERY_UNAUTHORIZED";
    throw error;
  }

  function publicAgent(record) {
    if (!record) return null;
    const session = sessions.get(record.agentId);
    return {
      ...clone(record),
      connected: Boolean(session && session.state !== "offline" && session.socket.readyState === 1),
      sessionId: session?.sessionId || record.sessionId || "",
    };
  }

  async function freeSpace() {
    try {
      const stats = await fs.statfs(config.stateDir);
      return {
        bytesAvailable: Number(stats.bavail) * Number(stats.bsize),
        bytesTotal: Number(stats.blocks) * Number(stats.bsize),
      };
    } catch {
      return { bytesAvailable: null, bytesTotal: null };
    }
  }

  function getInfo() {
    const advertisedHost = resolveAdvertisedHost(config.advertisedHost || config.host, { networkInterfaces });
    const mainPort = serverInfo?.port ?? config.port;
    const activeBootPort = bootInfo?.port ?? (bootServer ? config.bootPort : mainPort);
    return {
      controllerId,
      protocol: WW_RECOVERY_PROTOCOL_VERSION,
      version: 1,
      state: started && !stopping ? "online" : "stopped",
      host: config.host,
      port: mainPort,
      advertisedHost,
      url: `http://${advertisedHost}:${mainPort}`,
      localUrl: `http://127.0.0.1:${mainPort}`,
      socketPath: `${API_PREFIX}/socket`,
      boot: {
        host: config.bootHost,
        port: activeBootPort,
        url: `http://${advertisedHost}:${activeBootPort}`,
      },
      heartbeatMs: config.heartbeatMs,
      staleAfterMs: config.staleAfterMs,
      offlineAfterMs: config.offlineAfterMs,
      tokenRequired: Boolean(config.token),
      agentsOnline: [...sessions.values()].filter((session) => session.state === "online" && session.socket.readyState === 1).length,
      startedAt: serverInfo?.startedAt || null,
    };
  }

  async function appendAgentCaseEvent(agentId, event) {
    const targetCases = store.listCases({ agentId });
    await Promise.all(targetCases.map((record) => store.appendCaseEvent(record.id, {
      ...event,
      agentId,
    }).catch(() => {})));
  }

  function sendSocket(socket, message) {
    if (socket.readyState !== 1) return false;
    assertJsonMessageSize(message, config.maxJsonBytes);
    socket.send(JSON.stringify(message));
    return true;
  }

  async function dispatchNext(agentId) {
    const session = sessions.get(agentId);
    if (!session || session.state !== "online" || session.socket.readyState !== 1 || session.currentJobId) return null;
    const queued = store.listJobs(null, { agentId, state: "queued" });
    if (queued.length === 0) return null;
    const job = queued[0];
    const leasedAt = iso(clock);
    const leased = await store.transitionJob(job.id, "leased", {
      leaseOwner: agentId,
      leaseSessionId: session.sessionId,
      leasedAt,
      leaseExpiresAt: new Date(new Date(leasedAt).getTime() + (job.leaseMs || config.jobLeaseMs)).toISOString(),
      attempt: (Number(job.attempt) || 0) + 1,
    });
    session.currentJobId = leased.id;
    if (!sendSocket(session.socket, { type: "controller.job.offer", job: leased })) {
      session.currentJobId = "";
      await store.transitionJob(leased.id, "interrupted", { reason: "socket-closed-before-offer" });
      return null;
    }
    return leased;
  }

  async function markSessionOffline(session, reason) {
    if (!session || session.state === "offline") return;
    session.state = "offline";
    await store.markAgentOffline(session.agentId, reason).catch(() => {});
    await appendAgentCaseEvent(session.agentId, {
      type: "agent.disconnected",
      sessionId: session.sessionId,
      reason,
    });
    const currentJob = session.currentJobId ? store.getJob(session.currentJobId) : null;
    if (currentJob && ["leased", "running"].includes(currentJob.state)) {
      await store.transitionJob(currentJob.id, "interrupted", {
        reason: `agent-${reason}`,
        interruptedAt: iso(clock),
      }).catch(() => {});
    }
    session.currentJobId = "";
  }

  async function sweepSessions() {
    const now = new Date(iso(clock)).getTime();
    for (const session of sessions.values()) {
      const age = now - new Date(session.lastSeenAt).getTime();
      if (age >= config.offlineAfterMs) {
        await markSessionOffline(session, "heartbeat-timeout");
      } else if (age >= config.staleAfterMs && session.state === "online") {
        session.state = "stale";
        await store.upsertAgent({
          ...store.getAgent(session.agentId),
          state: "stale",
          sessionId: session.sessionId,
          lastSeenAt: session.lastSeenAt,
        }).catch(() => {});
      }
    }
  }

  function resolveInventoryWaiters(agentId, inventory) {
    const waiters = pendingInventory.get(agentId) || [];
    pendingInventory.delete(agentId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(inventory);
    }
  }

  async function requestInventory(agentId, { wait = false, timeoutMs = 120_000, lightweight = false } = {}) {
    const session = sessions.get(agentId);
    if (!session || session.state === "offline" || session.socket.readyState !== 1) {
      throw createRecoveryError(RECOVERY_ERROR_CODES.AGENT_OFFLINE, `Recovery agent ${agentId} is offline.`);
    }
    sendSocket(session.socket, { type: "controller.inventory.request", lightweight });
    if (!wait) return { requested: true, inventory: await store.readInventory(agentId) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = pendingInventory.get(agentId) || [];
        pendingInventory.set(agentId, list.filter((item) => item.resolve !== resolve));
        reject(createRecoveryError(RECOVERY_ERROR_CODES.TIMEOUT, `Timed out waiting for inventory from ${agentId}.`));
      }, timeoutMs);
      timer.unref?.();
      const list = pendingInventory.get(agentId) || [];
      list.push({ resolve, reject, timer });
      pendingInventory.set(agentId, list);
    });
  }

  async function handleAgentMessage(session, message) {
    if (message.type === "agent.heartbeat") {
      session.lastSeenAt = iso(clock);
      session.state = "online";
      await store.upsertAgent({
        ...store.getAgent(session.agentId),
        agentId: session.agentId,
        sessionId: session.sessionId,
        state: "online",
        lastSeenAt: session.lastSeenAt,
      });
      if (session.currentJobId) {
        const job = store.getJob(session.currentJobId);
        if (job && ["leased", "running"].includes(job.state)) {
          await store.updateJob(job.id, {
            leaseExpiresAt: new Date(new Date(session.lastSeenAt).getTime() + (job.leaseMs || config.jobLeaseMs)).toISOString(),
          });
        }
      }
      sendSocket(session.socket, { type: "controller.heartbeat.ack", at: session.lastSeenAt, agentSeq: message.agentSeq });
      return;
    }
    if (message.type === "agent.inventory") {
      session.lastSeenAt = iso(clock);
      await store.writeInventory(session.agentId, message.inventory || {});
      await store.upsertAgent({
        ...store.getAgent(session.agentId),
        agentId: session.agentId,
        state: "online",
        lastSeenAt: session.lastSeenAt,
        inventoryAt: message.inventory?.collectedAt || session.lastSeenAt,
      });
      await appendAgentCaseEvent(session.agentId, {
        type: "agent.inventory",
        collectedAt: message.inventory?.collectedAt,
        summary: {
          devices: message.inventory?.block?.devices?.length || 0,
          errors: message.inventory?.errors?.length || 0,
        },
      });
      resolveInventoryWaiters(session.agentId, message.inventory);
      sendSocket(session.socket, { type: "controller.inventory.ack", agentSeq: message.agentSeq });
      return;
    }
    if (message.type === "agent.job.accept") {
      const jobId = String(message.jobId || "");
      const job = store.getJob(jobId);
      if (!job || job.targetAgentId !== session.agentId || job.state !== "leased" || job.leaseSessionId !== session.sessionId) {
        throw createRecoveryError(RECOVERY_ERROR_CODES.LEASE, `Recovery job ${jobId} is not leased to this session.`);
      }
      session.currentJobId = jobId;
      await store.transitionJob(jobId, "running", { startedAt: iso(clock) });
      return;
    }
    if (message.type === "agent.job.event") {
      const jobId = String(message.jobId || message.event?.jobId || "");
      const job = store.getJob(jobId);
      if (!job || job.targetAgentId !== session.agentId) throw createRecoveryError(RECOVERY_ERROR_CODES.LEASE, `Unknown leased recovery job ${jobId}.`);
      session.lastSeenAt = iso(clock);
      const event = await store.appendJobEvent(jobId, {
        ...(message.event || {}),
        agentId: session.agentId,
        bootId: session.bootId,
        agentSeq: Number(message.agentSeq ?? message.event?.agentSeq),
      });
      await store.updateJob(jobId, {
        leaseExpiresAt: new Date(new Date(session.lastSeenAt).getTime() + (job.leaseMs || config.jobLeaseMs)).toISOString(),
      });
      sendSocket(session.socket, { type: "controller.event.ack", jobId, agentSeq: message.agentSeq, seq: event.seq });
      return;
    }
    if (message.type === "agent.job.result") {
      const jobId = String(message.jobId || "");
      let job = store.getJob(jobId);
      if (!job || job.targetAgentId !== session.agentId) throw createRecoveryError(RECOVERY_ERROR_CODES.LEASE, `Unknown recovery job ${jobId}.`);
      if (message.result?.interrupted === true) {
        if (!isTerminalJobState(job.state)) {
          await store.transitionJob(jobId, "interrupted", {
            result: message.result || {},
            reason: message.result?.message || "agent-restarted-during-job",
            endedAt: iso(clock),
          });
        } else if (job.state === "interrupted") {
          await store.updateJob(jobId, { result: message.result || {}, endedAt: iso(clock) });
        }
      } else if (!isTerminalJobState(job.state) || job.state === "interrupted") {
        if (job.state === "leased") job = await store.transitionJob(jobId, "running", { startedAt: iso(clock) });
        const succeeded = message.result?.ok === true;
        await store.transitionJob(jobId, succeeded ? "succeeded" : "failed", {
          result: message.result || {},
          endedAt: iso(clock),
          reconciledAfterReconnect: job.state === "interrupted" || job.resumedAfterInterruption === true,
        });
      }
      session.currentJobId = "";
      sendSocket(session.socket, { type: "controller.result.ack", jobId, agentSeq: message.agentSeq });
      await dispatchNext(session.agentId);
      return;
    }
    if (message.type === "agent.resume") {
      if (message.active?.jobId) {
        const activeJob = store.getJob(message.active.jobId);
        if (activeJob?.targetAgentId === session.agentId) {
          session.currentJobId = activeJob.id;
          if (activeJob.state === "interrupted") {
            await store.transitionJob(activeJob.id, "running", {
              resumedAt: iso(clock),
              resumedAfterInterruption: true,
              leaseOwner: session.agentId,
              leaseSessionId: session.sessionId,
              leaseExpiresAt: new Date(new Date(iso(clock)).getTime() + (activeJob.leaseMs || config.jobLeaseMs)).toISOString(),
            });
          }
        }
      }
      for (const event of Array.isArray(message.events) ? message.events : []) {
        const jobId = String(event.jobId || message.jobId || "");
        if (store.getJob(jobId)) {
          await store.appendJobEvent(jobId, {
            ...event,
            agentId: session.agentId,
            bootId: session.bootId,
          });
        }
      }
      if (message.result?.jobId) {
        await handleAgentMessage(session, {
          type: "agent.job.result",
          jobId: message.result.jobId,
          result: message.result.result,
          agentSeq: message.result.agentSeq,
        });
      }
      if (message.unavailableJobId && session.currentJobId === message.unavailableJobId) {
        session.currentJobId = "";
      }
      sendSocket(session.socket, { type: "controller.resume.ack", throughAgentSeq: message.throughAgentSeq || 0 });
      if (!session.currentJobId) await dispatchNext(session.agentId);
      return;
    }
    throw createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, `Unsupported agent message ${message.type}.`);
  }

  async function registerSocket(socket, request, rawMessage) {
    assertJsonMessageSize(rawMessage, config.maxJsonBytes);
    const hello = assertValidAgentHello(rawMessage);
    const prior = sessions.get(hello.agentId);
    if (prior && prior.socket !== socket) {
      prior.superseded = true;
      try { prior.socket.close(4001, "superseded by reconnect"); } catch {}
    }
    const sessionId = generateRecoveryId("wwrs", { clock, randomBytesImpl });
    const connectedAt = iso(clock);
    const session = {
      agentId: hello.agentId,
      bootId: hello.bootId,
      sessionId,
      socket,
      request,
      hello,
      connectedAt,
      lastSeenAt: connectedAt,
      state: "online",
      currentJobId: "",
      superseded: false,
      messageTail: Promise.resolve(),
    };
    sessions.set(hello.agentId, session);
    const oldAgent = store.getAgent(hello.agentId);
    await store.upsertAgent({
      ...(oldAgent || {}),
      ...hello,
      agentId: hello.agentId,
      sessionId,
      state: "online",
      connectedAt,
      lastSeenAt: connectedAt,
      remoteAddress: request.socket.remoteAddress || "",
      rebooted: Boolean(oldAgent?.bootId && oldAgent.bootId !== hello.bootId),
    });
    await fs.appendFile(
      path.join(config.stateDir, "agents", hello.agentId, "sessions.jsonl"),
      `${JSON.stringify({ sessionId, bootId: hello.bootId, connectedAt, remoteAddress: request.socket.remoteAddress || "" })}\n`,
      { mode: 0o600 },
    );
    await appendAgentCaseEvent(hello.agentId, {
      type: "agent.connected",
      sessionId,
      bootId: hello.bootId,
      rebooted: Boolean(oldAgent?.bootId && oldAgent.bootId !== hello.bootId),
    });
    if (hello.mode === "pxe" && activeBootManager?.consumeMachinePolicy) {
      const mac = hello.addresses?.map((record) => record.mac).find(Boolean);
      if (mac) {
        const policy = await activeBootManager.consumeMachinePolicy(mac).catch(() => null);
        if (policy) {
          await appendAgentCaseEvent(hello.agentId, {
            type: "boot.policy.consumed",
            mac,
            previous: policy.next,
            next: policy.after || "local",
          });
        }
      }
    }
    const resumable = store.listJobs(null, { agentId: hello.agentId }).find((job) => job.state === "interrupted") || null;
    if (resumable) session.currentJobId = resumable.id;
    sendSocket(socket, {
      type: "controller.welcome",
      protocol: WW_RECOVERY_PROTOCOL_VERSION,
      sessionId,
      heartbeatMs: config.heartbeatMs,
      controllerTime: connectedAt,
      resumableJob: resumable,
    });
    if (!resumable) await dispatchNext(hello.agentId);
    return session;
  }

  wss.on("connection", (socket, request) => {
    let session = null;
    let helloReceived = false;
    const helloTimer = setTimeout(() => {
      if (!helloReceived) socket.close(4000, "agent hello timeout");
    }, 10_000);
    helloTimer.unref?.();
    socket.on("message", (data, binary) => {
      if (binary) {
        socket.close(1003, "binary control messages are unsupported");
        return;
      }
      let message;
      try {
        if (Buffer.byteLength(data) > config.maxJsonBytes) throw new Error("message too large");
        message = JSON.parse(data.toString("utf8"));
      } catch (error) {
        sendSocket(socket, { type: "controller.error", error: serializeError(createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, error.message)) });
        return;
      }
      if (!helloReceived) {
        helloReceived = true;
        clearTimeout(helloTimer);
        void registerSocket(socket, request, message).then((value) => {
          session = value;
        }).catch((error) => {
          sendSocket(socket, { type: "controller.error", error: serializeError(error) });
          socket.close(4002, "invalid agent hello");
        });
        return;
      }
      const target = session || sessions.get(message.agentId);
      if (!target) return;
      target.messageTail = target.messageTail.then(
        () => handleAgentMessage(target, message),
        () => handleAgentMessage(target, message),
      ).catch((error) => {
        sendSocket(socket, { type: "controller.error", error: serializeError(error) });
      });
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (!session || session.superseded) return;
      session.state = "stale";
      session.disconnectedAt = iso(clock);
      void store.upsertAgent({
        ...store.getAgent(session.agentId),
        state: "stale",
        disconnectedAt: session.disconnectedAt,
      }).catch(() => {});
    });
    socket.on("error", (error) => log(`Recovery agent socket error: ${error.message}`));
  });

  async function serveArtifact(request, response, artifactId) {
    const record = store.getArtifact(artifactId);
    if (!record) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Recovery artifact ${artifactId} was not found.`);
    const filename = store.resolveArtifactPath(artifactId, { partial: !record.complete });
    const stats = await fs.stat(filename);
    const headers = {
      "accept-ranges": "bytes",
      "content-type": record.contentType || "application/octet-stream",
      "content-disposition": `attachment; filename="${safeFilename(record.filename)}"`,
      "cache-control": "no-store",
      "x-ww-artifact-id": artifactId,
      "x-ww-artifact-complete": String(record.complete),
      "x-ww-artifact-hash": record.hash || "",
      "x-ww-artifact-size": String(stats.size),
    };
    if (request.method === "HEAD") {
      response.writeHead(200, { ...headers, "content-length": stats.size });
      response.end();
      return;
    }
    let start = 0;
    let end = stats.size > 0 ? stats.size - 1 : 0;
    let status = 200;
    const range = String(request.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
    if (range && stats.size > 0) {
      start = range[1] ? Number(range[1]) : 0;
      end = range[2] ? Math.min(Number(range[2]), stats.size - 1) : stats.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stats.size) {
        response.writeHead(416, { "content-range": `bytes */${stats.size}` });
        response.end();
        return;
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${stats.size}`;
    }
    headers["content-length"] = stats.size === 0 ? 0 : end - start + 1;
    response.writeHead(status, headers);
    if (stats.size === 0) {
      response.end();
      return;
    }
    await pipeline(fsSync.createReadStream(filename, { start, end }), response);
  }

  async function writeArtifact(request, response, artifactId) {
    const record = store.getArtifact(artifactId);
    if (!record) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Recovery artifact ${artifactId} was not found.`);
    if (record.complete) throw createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, `Recovery artifact ${artifactId} is already complete.`);
    const offset = request.headers["x-ww-artifact-offset"] === undefined
      ? undefined
      : Number(request.headers["x-ww-artifact-offset"]);
    const length = Number(request.headers["content-length"] || 0);
    const writer = await store.openArtifactWrite(artifactId, { offset });
    if (config.maxArtifactBytes > 0 && writer.offset + length > config.maxArtifactBytes) {
      writer.stream.destroy();
      throw createRecoveryError(RECOVERY_ERROR_CODES.ARTIFACT_SPACE, "Recovery artifact exceeds maxArtifactBytes.");
    }
    let received = 0;
    request.on("data", (chunk) => {
      received += chunk.length;
      emitter.emit("event", {
        type: "artifact.progress",
        artifactId,
        direction: "upload",
        bytes: writer.offset + received,
      });
    });
    await pipeline(request, writer.stream);
    const currentOffset = await writer.currentOffset();
    const shouldComplete = String(request.headers["x-ww-artifact-complete"] || "true") !== "false";
    const updated = shouldComplete
      ? await store.completeArtifact(artifactId, {})
      : { ...record, size: currentOffset, complete: false };
    sendJson(response, 200, { ok: true, artifact: updated, offset: currentOffset });
  }

  async function streamCaseEvents(request, response, caseId, afterSeq) {
    const initial = await store.readCaseEvents(caseId, afterSeq);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event) => {
      if (event.caseId !== caseId || response.destroyed) return;
      response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of initial) send(event);
    const unsubscribe = store.onEvent(send);
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(`: heartbeat ${Date.now()}\n\n`);
    }, config.heartbeatMs);
    heartbeat.unref?.();
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.once("close", cleanup);
    response.once("close", cleanup);
  }

  async function handleBootRequest(request, response, url) {
    if (activeBootManager?.handleRequest) {
      const handled = await activeBootManager.handleRequest(request, response, url, getInfo());
      if (handled !== false) return;
    }
    const ipxeMatch = matches(url.pathname, /^\/v1\/recovery\/boot\/([^/]+)\/boot\.ipxe$/);
    if (ipxeMatch) {
      const info = getInfo();
      const base = info.boot.url;
      const controller = info.url;
      const script = `#!ipxe\nset controller ${controller}\nset boot ${base}\nmenu WorkWire Recovery\nitem --default recovery WorkWire Recovery\nitem local Local boot\nitem shell iPXE shell\nchoose --timeout 4000 --default recovery target || goto local\ngoto \${target}\n:recovery\nkernel \${boot}/v1/recovery/boot/live/vmlinuz boot=live components ip=dhcp fetch=\${boot}/v1/recovery/boot/live/filesystem.squashfs ww.controller=\${controller} ww.mode=pxe\ninitrd \${boot}/v1/recovery/boot/live/initrd.img\nboot\n:local\nexit\n:shell\nshell\n`;
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end(script);
      return;
    }
    const liveMatch = matches(url.pathname, /^\/v1\/recovery\/boot\/live\/([^/]+)$/);
    if (liveMatch) {
      const allowed = new Set(["vmlinuz", "initrd.img", "filesystem.squashfs", "SHA256SUMS", "manifest.json"]);
      if (!allowed.has(liveMatch[0])) throw createRecoveryError(RECOVERY_ERROR_CODES.BOOT_ARTIFACT, "Unsupported boot artifact name.");
      const filename = path.join(config.stateDir, "boot", "live", liveMatch[0]);
      const stats = await fs.stat(filename).catch(() => null);
      if (!stats?.isFile()) throw createRecoveryError(RECOVERY_ERROR_CODES.BOOT_ARTIFACT, `Boot artifact ${liveMatch[0]} is missing.`);
      response.writeHead(200, { "content-length": stats.size, "content-type": "application/octet-stream", "cache-control": "no-store" });
      await pipeline(fsSync.createReadStream(filename), response);
      return;
    }
    sendJson(response, 404, { ok: false, error: { code: RECOVERY_ERROR_CODES.NOT_FOUND, message: "Recovery boot route not found." } });
  }

  async function handleRequest(request, response, { bootOnly = false } = {}) {
    try {
      const url = new URL(request.url || "/", "http://recovery.local");
      if (url.pathname.startsWith(`${API_PREFIX}/boot/`)) {
        await handleBootRequest(request, response, url);
        return;
      }
      if (bootOnly) {
        sendJson(response, 404, { ok: false, error: { code: RECOVERY_ERROR_CODES.NOT_FOUND, message: "Recovery boot route not found." } });
        return;
      }
      if (!url.pathname.startsWith(API_PREFIX)) {
        sendJson(response, 404, { ok: false, error: { code: RECOVERY_ERROR_CODES.NOT_FOUND, message: "Recovery route not found." } });
        return;
      }
      requireAuthorization(request);
      const method = request.method || "GET";

      if (method === "GET" && url.pathname === `${API_PREFIX}/info`) {
        sendJson(response, 200, { ok: true, controller: getInfo(), storage: await freeSpace() });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/agents`) {
        const onlineOnly = url.searchParams.get("online") === "true";
        const values = store.listAgents().map(publicAgent).filter((agent) => !onlineOnly || agent.state === "online");
        sendJson(response, 200, { ok: true, agents: values });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/mac-addresses`) {
        sendJson(response, 200, { ok: true, machines: store.listMacAddresses() });
        return;
      }
      let route = matches(url.pathname, /^\/v1\/recovery\/agents\/([^/]+)$/);
      if (method === "GET" && route) {
        const agent = publicAgent(store.getAgent(route[0]));
        if (!agent) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Recovery agent ${route[0]} was not found.`);
        sendJson(response, 200, { ok: true, agent, inventory: await store.readInventory(route[0]) });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/agents\/([^/]+)\/inventory$/);
      if (method === "POST" && route) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        const result = await requestInventory(route[0], {
          wait: body.wait === true,
          timeoutMs: body.timeoutMs,
          lightweight: body.lightweight,
        });
        sendJson(response, body.wait ? 200 : 202, { ok: true, ...result });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/cases`) {
        sendJson(response, 200, { ok: true, cases: store.listCases({ agentId: url.searchParams.get("agentId") || "", state: url.searchParams.get("state") || "" }) });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/playbooks`) {
        sendJson(response, 200, { ok: true, playbooks: availablePlaybooks });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/playbooks\/([^/]+)\/expand$/);
      if (method === "POST" && route) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        const playbook = availablePlaybooks.find((candidate) => candidate.id === route[0]);
        if (!playbook) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Recovery playbook ${route[0]} was not found.`);
        sendJson(response, 200, { ok: true, plan: expandRecoveryPlaybook(playbook, body) });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/cases`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        const caseRecord = await store.createCase(body);
        sendJson(response, 201, { ok: true, case: caseRecord });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/cases\/([^/]+)$/);
      if (method === "GET" && route) {
        const caseRecord = store.getCase(route[0]);
        if (!caseRecord) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Recovery case ${route[0]} was not found.`);
        sendJson(response, 200, {
          ok: true,
          case: caseRecord,
          jobs: store.listJobs(caseRecord.id),
          artifacts: store.listArtifacts(caseRecord.id),
          inventory: await store.readInventory(caseRecord.targetAgentId),
        });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/cases\/([^/]+)\/goal$/);
      if (method === "POST" && route) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        const caseRecord = await store.updateCase(route[0], { goal: String(body.goal ?? "") });
        sendJson(response, 200, { ok: true, case: caseRecord });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/cases\/([^/]+)\/run$/);
      if (method === "POST" && route) {
        let caseRecord = store.getCase(route[0]);
        if (!caseRecord) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Recovery case ${route[0]} was not found.`);
        const resume = ["stopped", "failed"].includes(caseRecord.state);
        if (caseRecord.state !== "running") caseRecord = await store.updateCase(route[0], { state: "running" });
        const run = autonomyEngine?.start ? await autonomyEngine.start(caseRecord.id, { resume }) : { mode: "operator", started: true };
        sendJson(response, 202, { ok: true, case: caseRecord, run });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/cases\/([^/]+)\/stop$/);
      if (method === "POST" && route) {
        if (autonomyEngine?.stop) await autonomyEngine.stop(route[0]);
        const current = store.getCase(route[0]);
        const caseRecord = current?.state === "running" ? await store.updateCase(route[0], { state: "stopped" }) : current;
        if (!caseRecord) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Recovery case ${route[0]} was not found.`);
        sendJson(response, 200, { ok: true, case: caseRecord });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/cases\/([^/]+)\/action$/);
      if (method === "POST" && route) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        if (!autonomyEngine?.submitOperatorAction) throw createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_PROTOCOL, "Operator planner is unavailable.");
        autonomyEngine.submitOperatorAction(route[0], body);
        sendJson(response, 202, { ok: true, accepted: true });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/cases\/([^/]+)\/events$/);
      if (method === "GET" && route) {
        const after = Number(url.searchParams.get("after") || 0);
        sendJson(response, 200, { ok: true, events: await store.readCaseEvents(route[0], after) });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/cases\/([^/]+)\/events\/stream$/);
      if (method === "GET" && route) {
        const after = Number(url.searchParams.get("after") || request.headers["last-event-id"] || 0);
        await streamCaseEvents(request, response, route[0], after);
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/jobs`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        let caseId = String(body.caseId || "");
        if (!caseId) {
          const caseRecord = await store.createCase({
            targetAgentId: body.targetAgentId,
            goal: body.goal || body.steps?.[0]?.action || "Recovery job",
            mode: body.mode || "unrestricted",
            createdBy: body.createdBy || "operator",
          });
          caseId = caseRecord.id;
        }
        const job = await store.createJob(caseId, body);
        await dispatchNext(job.targetAgentId);
        sendJson(response, 201, { ok: true, job });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/jobs\/([^/]+)$/);
      if (method === "GET" && route) {
        const job = store.getJob(route[0]);
        if (!job) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Recovery job ${route[0]} was not found.`);
        sendJson(response, 200, { ok: true, job, events: await store.readJobEvents(route[0], Number(url.searchParams.get("after") || 0)) });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/jobs\/([^/]+)\/cancel$/);
      if (method === "POST" && route) {
        const job = store.getJob(route[0]);
        if (!job) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Recovery job ${route[0]} was not found.`);
        const canceled = isTerminalJobState(job.state) ? job : await store.transitionJob(job.id, "canceled", { cancelRequestedAt: iso(clock) });
        const session = sessions.get(job.targetAgentId);
        if (session) sendSocket(session.socket, { type: "controller.job.cancel", jobId: job.id });
        sendJson(response, 200, { ok: true, job: canceled });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/jobs\/([^/]+)\/retry$/);
      if (method === "POST" && route) {
        const job = store.getJob(route[0]);
        if (!job) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Recovery job ${route[0]} was not found.`);
        const retried = await store.transitionJob(job.id, "queued", {
          retryRequestedAt: iso(clock),
          leaseOwner: "",
          leaseSessionId: "",
          leaseExpiresAt: "",
        });
        await dispatchNext(retried.targetAgentId);
        sendJson(response, 200, { ok: true, job: retried });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/artifacts`) {
        sendJson(response, 200, { ok: true, artifacts: store.listArtifacts(url.searchParams.get("caseId") || "", url.searchParams.get("jobId") || ""), storage: await freeSpace() });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/artifacts`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        const artifact = await store.createArtifact(body);
        sendJson(response, 201, { ok: true, artifact, offset: 0 });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/artifacts\/([^/]+)$/);
      if (["GET", "HEAD"].includes(method) && route) {
        await serveArtifact(request, response, route[0]);
        return;
      }
      if (method === "PUT" && route) {
        await writeArtifact(request, response, route[0]);
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/wake`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        const result = await wakeImpl(body);
        await store.rememberMacAddress({
          mac: result.mac || body.mac,
          name: body.name || "",
          agentId: body.agentId || "",
          broadcast: body.broadcast || "",
          source: "wake",
          lastWakeAt: iso(clock),
        });
        if (body.caseId && store.getCase(body.caseId)) {
          await store.appendCaseEvent(body.caseId, { type: "power.wake", result });
        }
        sendJson(response, 200, { ok: true, wake: result });
        return;
      }
      sendJson(response, 404, { ok: false, error: { code: RECOVERY_ERROR_CODES.NOT_FOUND, message: "Recovery route not found." } });
    } catch (error) {
      if (!response.headersSent) sendJson(response, statusForError(error), { ok: false, error: serializeError(error) });
      else response.destroy(error);
    }
  }

  async function listen(httpServer, host, port) {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, host);
    });
    const address = httpServer.address();
    return {
      host: typeof address === "object" ? address.address : host,
      port: typeof address === "object" ? address.port : port,
    };
  }

  async function start() {
    if (started) return getInfo();
    await store.init();
    await store.recoverInterruptedState("controller-restarted");
    if (!activeBootManager) {
      activeBootManager = createRecoveryBootManager({
        config,
        controllerInfo: getInfo,
        networkInterfaces,
        log,
      });
    }
    availablePlaybooks = await loadRecoveryPlaybooks();
    if (!autonomyEngine) {
      autonomyEngine = createRecoveryAutonomyEngine({
        store,
        controller: api,
        plannerConfig: config.planner,
        playbooks: availablePlaybooks,
        log,
      });
    }
    storeUnsubscribe = store.onEvent((event) => emitter.emit("event", event));
    server = createHttpServerImpl((request, response) => void handleRequest(request, response));
    server.on("upgrade", (request, socket, head) => {
      try {
        const url = new URL(request.url || "/", "http://recovery.local");
        if (url.pathname !== `${API_PREFIX}/socket`) {
          socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        requireAuthorization(request);
        wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });
    try {
      const listened = await listen(server, config.host, config.port);
      serverInfo = { ...listened, startedAt: iso(clock) };
      if (config.bootPort !== serverInfo.port || config.bootHost !== config.host) {
        bootServer = createHttpServerImpl((request, response) => void handleRequest(request, response, { bootOnly: true }));
        bootInfo = await listen(bootServer, config.bootHost, config.bootPort);
      } else {
        bootInfo = { host: serverInfo.host, port: serverInfo.port };
      }
    } catch (error) {
      await new Promise((resolve) => server?.close(() => resolve())).catch(() => {});
      if (ownsStore) await store.close().catch(() => {});
      if (error?.code === "EADDRINUSE") {
        const collision = new Error(`Recovery controller address ${config.host}:${config.port} is already in use.`);
        collision.code = "EADDRINUSE";
        throw collision;
      }
      throw error;
    }
    started = true;
    sweepTimer = setInterval(() => void sweepSessions().catch((error) => log(error.message)), Math.max(250, Math.min(config.heartbeatMs, config.staleAfterMs / 2)));
    sweepTimer.unref?.();
    log(`Recovery controller ready at ${getInfo().url}`);
    return getInfo();
  }

  async function closeServer(httpServer) {
    if (!httpServer) return;
    await new Promise((resolve) => httpServer.close(() => resolve())).catch(() => {});
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(sweepTimer);
    for (const session of sessions.values()) {
      sendSocket(session.socket, { type: "controller.shutdown", at: iso(clock) });
      try { session.socket.terminate(); } catch {}
    }
    sessions.clear();
    for (const waiters of pendingInventory.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(createRecoveryError(RECOVERY_ERROR_CODES.INTERRUPTED, "Recovery controller stopped."));
      }
    }
    pendingInventory.clear();
    await Promise.all([closeServer(server), closeServer(bootServer)]);
    storeUnsubscribe?.();
    storeUnsubscribe = null;
    if (ownsStore) await store.close();
    started = false;
    stopping = false;
  }

  function onEvent(listener) {
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  }

  async function publishEvent(event) {
    if (event?.caseId) return store.appendCaseEvent(event.caseId, event);
    return store.appendControllerEvent(event);
  }

  const api = {
    start,
    stop,
    getInfo,
    getStore: () => store,
    onEvent,
    publishEvent,
    getConnectedAgent(agentId) {
      const session = sessions.get(String(agentId));
      return session?.state === "online" && session.socket.readyState === 1 ? session : null;
    },
    requestInventory,
    dispatchNext,
    getAutonomy: () => autonomyEngine,
  };
  return api;
}
