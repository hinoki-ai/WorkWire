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
import { createRecoveryFleetCommander } from "./ww-recovery-fleet.mjs";
import { createRecoveryInteractiveController } from "./ww-recovery-interactive.mjs";
import { createRecoveryConsoleLauncher } from "./ww-recovery-console.mjs";
import { createNextStageRuntime, discoverNextStageAdapters } from "./ww-next-stage-adapters.mjs";

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
  nextStageInstances = {},
  discoverNextStageAdaptersImpl = discoverNextStageAdapters,
  log = () => {},
} = {}) {
  const defaults = buildDefaultRecoveryConfig();
  const config = normalizeRecoveryConfig(rawConfig || defaults, defaults, { env: {} });
  const store = providedStore || createStoreImpl({ stateDir: config.stateDir, clock, randomBytesImpl });
  const ownsStore = !providedStore;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const sessions = new Map();
  const dispatches = new Map();
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
  let fleetCommander = null;
  let interactiveController = null;
  let consoleLauncher = null;
  let nextStageAdapters = {};
  let nextStageRuntime = null;
  const continuityFleetContext = new Map();
  const continuityTasks = new Set();

  function laneAvailable(lane) {
    return Boolean(!stopping && nextStageAdapters[lane]?.available && nextStageRuntime);
  }

  function trackContinuity(task) {
    const promise = Promise.resolve(task);
    continuityTasks.add(promise);
    promise.then(() => continuityTasks.delete(promise), () => continuityTasks.delete(promise));
    return promise;
  }

  async function recordContinuityInventory(agentId, inventory) {
    if (!laneAvailable("continuity")) return null;
    const event = await nextStageRuntime.invoke("continuity", "store", "ingestInventory", [agentId, inventory]);
    const machineId = event.machineId || agentId;
    await nextStageRuntime.invoke("continuity", "health", "observe", [machineId, inventory]);
    const [timeline, recommendations] = await Promise.all([
      nextStageRuntime.invoke("continuity", "store", "getTimeline", [machineId, { limit: 200 }]),
      nextStageRuntime.invoke("continuity", "health", "recommendations", [machineId]),
    ]);
    continuityFleetContext.set(String(agentId), {
      machineId,
      eventCount: timeline.length,
      lastEventAt: timeline.at(-1)?.timestamp || inventory?.collectedAt || "",
      healthRecommendations: recommendations,
    });
    return event;
  }

  async function recordContinuityBoot(hello, connectedAt) {
    if (!laneAvailable("continuity")) return null;
    return nextStageRuntime.invoke("continuity", "store", "ingestBoot", [{
      id: `boot:${hello.agentId}:${hello.bootId}`,
      timestamp: connectedAt,
      agentId: hello.agentId,
      bootId: hello.bootId,
      hostname: hello.hostname,
      mode: hello.mode,
      addresses: hello.addresses,
      identity: hello.identity,
    }]);
  }

  async function recordContinuityCaseEvent(event) {
    if (!laneAvailable("continuity") || !event?.caseId) return null;
    return nextStageRuntime.invoke("continuity", "store", "ingestCaseEvent", [{
      id: `recovery:${event.id || event.seq || generateRecoveryId("event", { clock, randomBytesImpl })}`,
      timestamp: event.at || event.timestamp,
      caseId: event.caseId,
      agentId: event.agentId || event.targetAgentId || "",
      event,
    }]);
  }

  async function plannerLaneContext({ caseRecord, agent } = {}) {
    const context = { lanes: api.getNextStageAdapters() };
    if (laneAvailable("continuity")) {
      const machineId = agent?.agentId || caseRecord?.targetAgentId || "";
      const [timeline, recommendations, vault] = await Promise.all([
        nextStageRuntime.invoke("continuity", "store", "getTimeline", [machineId, { limit: 200 }]),
        nextStageRuntime.invoke("continuity", "health", "recommendations", [machineId]),
        nextStageRuntime.invoke("continuity", "vault", "getStats", []),
      ]);
      context.continuity = { machineId, timeline, recommendations, vault };
    }
    if (laneAvailable("imaging")) context.images = await nextStageRuntime.invoke("imaging", "catalog", "list", [{}]);
    return context;
  }

  async function plannerCrossCaseMemory({ caseRecord, agent, similarCases = [] } = {}) {
    const baseline = similarCases.map((record) => ({ ...record, sourceCaseId: record.id }));
    if (!laneAvailable("continuity")) return baseline;
    const records = await nextStageRuntime.invoke("continuity", "store", "search", [{
      machineId: agent?.agentId || caseRecord?.targetAgentId || "",
      type: "case.event",
      limit: 100,
    }]);
    return [...baseline, ...records.map((record) => ({
      sourceCaseId: record.caseId,
      sourceEventId: record.id,
      timestamp: record.timestamp,
      summary: record.text,
    }))];
  }

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
      state: session?.state || record.state,
      lastSeenAt: session?.lastSeenAt || record.lastSeenAt,
      connected: Boolean(session && session.state !== "offline" && session.socket.readyState === 1),
      sessionId: session?.sessionId || record.sessionId || "",
    };
  }

  function heartbeatPersistenceInterval(job = null) {
    const leaseMs = Number(job?.leaseMs || config.jobLeaseMs);
    return Math.max(1_000, Math.min(
      5_000,
      Number(config.staleAfterMs) / 2,
      Number(config.offlineAfterMs) / 3,
      Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs / 3 : 5_000,
    ));
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
      capabilities: {
        fleet: true,
        interactive: true,
        tcpTunnel: true,
        consoleLauncher: true,
        arm64: process.arch === "arm64",
        architecture: process.arch,
        optionalLanes: Object.fromEntries(Object.entries(nextStageAdapters).map(([lane, adapter]) => [lane, {
          available: adapter.available === true,
          capabilities: adapter.capabilities || null,
          reason: adapter.reason || "",
        }])),
      },
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
    const key = String(agentId || "");
    const activeDispatch = dispatches.get(key);
    if (activeDispatch) return activeDispatch;
    const dispatch = (async () => {
      const session = sessions.get(key);
      if (!session || session.state !== "online" || session.socket.readyState !== 1 || session.currentJobId) return null;
      const queued = store.listJobs(null, { agentId: key, state: "queued" });
      if (queued.length === 0) return null;
      const job = queued[0];
      const leasedAt = iso(clock);
      const leased = await store.transitionJob(job.id, "leased", {
        leaseOwner: key,
        leaseSessionId: session.sessionId,
        leasedAt,
        leaseExpiresAt: new Date(new Date(leasedAt).getTime() + (job.leaseMs || config.jobLeaseMs)).toISOString(),
        attempt: (Number(job.attempt) || 0) + 1,
      });
      session.currentJobId = leased.id;
      if (sessions.get(key) !== session || !sendSocket(session.socket, { type: "controller.job.offer", job: leased })) {
        session.currentJobId = "";
        await store.transitionJob(leased.id, "interrupted", { reason: "socket-closed-before-offer" });
        return null;
      }
      return leased;
    })();
    dispatches.set(key, dispatch);
    try {
      return await dispatch;
    } finally {
      if (dispatches.get(key) === dispatch) dispatches.delete(key);
    }
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
    if (interactiveController && (
      String(message.type || "").startsWith("agent.session.")
      || String(message.type || "").startsWith("agent.tunnel.")
    )) {
      await interactiveController.handleAgentMessage(session.agentId, message);
      return;
    }
    if (message.type === "agent.heartbeat") {
      session.lastSeenAt = session.lastSeenAt || iso(clock);
      session.state = "online";
      sendSocket(session.socket, { type: "controller.heartbeat.ack", at: session.lastSeenAt, agentSeq: message.agentSeq });
      const job = session.currentJobId ? store.getJob(session.currentJobId) : null;
      const observedMs = new Date(session.lastSeenAt).getTime();
      const durableMs = new Date(session.lastDurableHeartbeatAt || 0).getTime();
      if (!Number.isFinite(durableMs) || observedMs - durableMs >= heartbeatPersistenceInterval(job)) {
        session.lastDurableHeartbeatAt = session.lastSeenAt;
        await store.upsertAgent({
          ...store.getAgent(session.agentId),
          agentId: session.agentId,
          sessionId: session.sessionId,
          state: "online",
          lastSeenAt: session.lastSeenAt,
        });
        if (job && ["leased", "running"].includes(job.state)) {
          await store.updateJob(job.id, {
            leaseExpiresAt: new Date(new Date(session.lastSeenAt).getTime() + (job.leaseMs || config.jobLeaseMs)).toISOString(),
          });
        }
      }
      if (!session.currentJobId) await dispatchNext(session.agentId);
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
      await recordContinuityInventory(session.agentId, message.inventory || {}).catch((error) => log(`Continuity inventory ${session.agentId}: ${error.message}`));
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
        if (job.state === "interrupted") {
          await store.updateJob(jobId, { result: message.result || {}, endedAt: iso(clock) });
        } else if (!isTerminalJobState(job.state)) {
          await store.transitionJob(jobId, "interrupted", {
            result: message.result || {},
            reason: message.result?.message || "agent-restarted-during-job",
            endedAt: iso(clock),
          });
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
        const unavailable = store.getJob(message.unavailableJobId);
        if (unavailable?.state === "interrupted") {
          await store.transitionJob(unavailable.id, "failed", {
            endedAt: iso(clock),
            result: { ok: false, interrupted: true, resumeUnavailable: true, message: "Agent rebooted before the interrupted job could reconcile." },
          });
        }
        session.currentJobId = "";
      }
      sendSocket(session.socket, { type: "controller.resume.ack", throughAgentSeq: message.throughAgentSeq || 0 });
      if (!session.currentJobId) await dispatchNext(session.agentId);
      return;
    }
    throw createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, `Unsupported agent message ${message.type}.`);
  }

  async function registerSocket(socket, request, rawMessage) {
    if (stopping) {
      try { socket.close(1012, "controller restarting"); } catch {}
      throw createRecoveryError(RECOVERY_ERROR_CODES.INTERRUPTED, "Recovery controller is restarting.");
    }
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
      lastDurableHeartbeatAt: connectedAt,
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
    await recordContinuityBoot(hello, connectedAt).catch((error) => log(`Continuity boot ${hello.agentId}: ${error.message}`));
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
    let registeredAgentId = "";
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
        registeredAgentId = String(message.agentId || "");
        clearTimeout(helloTimer);
        void registerSocket(socket, request, message).then((value) => {
          session = value;
          if (fleetCommander) void fleetCommander.resumeAgentRuns(value.agentId).catch((error) => log(`Fleet reconnect ${value.agentId}: ${error.message}`));
          if (interactiveController) void interactiveController.reconnectAgent(value.agentId).catch((error) => log(`Interactive reconnect ${value.agentId}: ${error.message}`));
        }).catch((error) => {
          sendSocket(socket, { type: "controller.error", error: serializeError(error) });
          socket.close(4002, "invalid agent hello");
        });
        return;
      }
      const target = session || sessions.get(registeredAgentId || message.agentId);
      if (!target) return;
      // Socket receipt is the liveness signal. Durable inventory/continuity
      // ingestion is intentionally serialized below and may outlast a very
      // aggressive heartbeat window on recovery hardware.
      target.lastSeenAt = iso(clock);
      target.state = "online";
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
      const markStale = () => store.upsertAgent({
          ...store.getAgent(session.agentId),
          state: "stale",
          disconnectedAt: session.disconnectedAt,
        });
      session.messageTail = session.messageTail.then(markStale, markStale).catch(() => {});
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
    const lengthHeader = request.headers["content-length"];
    const length = lengthHeader === undefined ? null : Number(lengthHeader);
    const finalSizeHeader = request.headers["x-ww-artifact-final-size"];
    const finalSize = finalSizeHeader === undefined ? null : Number(finalSizeHeader);
    if (length !== null && (!Number.isSafeInteger(length) || length < 0)) {
      throw createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, "Recovery artifact Content-Length is invalid.");
    }
    if (finalSize !== null && (!Number.isSafeInteger(finalSize) || finalSize < 0)) {
      throw createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, "Recovery artifact final size is invalid.");
    }
    const writer = await store.openArtifactWrite(artifactId, { offset });
    if (
      config.maxArtifactBytes > 0
      && (
        (length !== null && writer.offset + length > config.maxArtifactBytes)
        || (finalSize !== null && finalSize > config.maxArtifactBytes)
      )
    ) {
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
    if (
      (length !== null && received !== length)
      || (finalSize !== null && currentOffset !== finalSize)
    ) {
      const error = createRecoveryError(
        RECOVERY_ERROR_CODES.ARTIFACT_OFFSET,
        `Recovery artifact upload stopped at ${currentOffset} bytes before the expected ${finalSize ?? writer.offset + length}.`,
      );
      error.actualOffset = currentOffset;
      throw error;
    }
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
      if (method === "GET" && url.pathname === `${API_PREFIX}/next-stage`) {
        sendJson(response, 200, { ok: true, lanes: api.getNextStageAdapters() });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/next-stage/refresh`) {
        await nextStageRuntime?.close();
        nextStageAdapters = await discoverNextStageAdaptersImpl({ refresh: true });
        nextStageRuntime = createNextStageRuntime({ adapters: nextStageAdapters, stateDir: config.stateDir, instances: nextStageInstances });
        sendJson(response, 200, { ok: true, lanes: api.getNextStageAdapters() });
        return;
      }
      let route = matches(url.pathname, /^\/v1\/recovery\/next-stage\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (method === "POST" && route) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        const result = await nextStageRuntime.invoke(route[0], route[1], route[2], Array.isArray(body.args) ? body.args : []);
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/fleet`) {
        sendJson(response, 200, { ok: true, fleet: fleetCommander.getState() });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/fleet/machines`) {
        sendJson(response, 200, { ok: true, machines: fleetCommander.listMachines(url.searchParams.get("query") || "*") });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/fleet\/machines\/([^/]+)$/);
      if (method === "POST" && route) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        sendJson(response, 200, { ok: true, machine: await fleetCommander.setMachineMetadata(route[0], body) });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/fleet/groups`) {
        sendJson(response, 200, { ok: true, groups: fleetCommander.listGroups() });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/fleet/groups`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        sendJson(response, 201, { ok: true, group: await fleetCommander.saveGroup(body) });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/fleet\/groups\/([^/]+)$/);
      if (method === "DELETE" && route) {
        sendJson(response, 200, { ok: true, deleted: await fleetCommander.deleteGroup(route[0]) });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/fleet/queries`) {
        sendJson(response, 200, { ok: true, queries: fleetCommander.listQueries() });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/fleet/queries`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        sendJson(response, 201, { ok: true, query: await fleetCommander.saveQuery(body) });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/fleet/runs`) {
        sendJson(response, 200, { ok: true, runs: fleetCommander.listRuns({ state: url.searchParams.get("state") || "" }) });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/fleet/runs`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        const created = await fleetCommander.execute({ ...body, wait: false });
        sendJson(response, 202, { ok: true, run: fleetCommander.getRun(created.id) });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/fleet\/runs\/([^/]+)$/);
      if (method === "GET" && route) {
        const run = fleetCommander.getRun(route[0]);
        if (!run) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Fleet run ${route[0]} was not found.`);
        sendJson(response, 200, { ok: true, run });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/fleet\/runs\/([^/]+)\/summary$/);
      if (method === "GET" && route) {
        sendJson(response, 200, { ok: true, summary: fleetCommander.summarize(route[0]) });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/fleet\/runs\/([^/]+)\/retry-failed$/);
      if (method === "POST" && route) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        const created = await fleetCommander.retryFailed(route[0], { ...body, wait: false });
        sendJson(response, 202, { ok: true, run: fleetCommander.getRun(created.id) });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/fleet/schedules`) {
        sendJson(response, 200, { ok: true, schedules: fleetCommander.listSchedules() });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/fleet/schedules`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        sendJson(response, 201, { ok: true, schedule: await fleetCommander.saveSchedule(body) });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/fleet\/schedules\/([^/]+)$/);
      if (method === "DELETE" && route) {
        sendJson(response, 200, { ok: true, deleted: await fleetCommander.deleteSchedule(route[0]) });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/fleet/schedules/tick`) {
        await fleetCommander.tick();
        sendJson(response, 200, { ok: true, schedules: fleetCommander.listSchedules() });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/fleet/health-rules`) {
        sendJson(response, 200, { ok: true, rules: fleetCommander.listHealthRules(), recommendations: fleetCommander.listRecommendations() });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/fleet/health-rules`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        sendJson(response, 201, { ok: true, rule: await fleetCommander.saveHealthRule(body) });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/fleet\/health-rules\/([^/]+)$/);
      if (method === "DELETE" && route) {
        sendJson(response, 200, { ok: true, deleted: await fleetCommander.deleteHealthRule(route[0]) });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/sessions`) {
        sendJson(response, 200, { ok: true, sessions: interactiveController.listSessions({ agentId: url.searchParams.get("agentId") || "" }) });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/sessions`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        sendJson(response, 201, { ok: true, session: await interactiveController.openSession(body) });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/sessions\/([^/]+)$/);
      if (method === "GET" && route) {
        const session = interactiveController.getSession(route[0]);
        if (!session) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Interactive session ${route[0]} was not found.`);
        sendJson(response, 200, { ok: true, session });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/sessions\/([^/]+)\/events$/);
      if (method === "GET" && route) {
        sendJson(response, 200, { ok: true, events: await interactiveController.readEvents(route[0], Number(url.searchParams.get("after") || 0)) });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/sessions\/([^/]+)\/(input|resize|signal|detach|reconnect|terminate)$/);
      if (method === "POST" && route) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        const [sessionId, action] = route;
        let result;
        if (action === "input") result = await interactiveController.input(sessionId, body.data || "", body.encoding || "utf8");
        else if (action === "resize") result = await interactiveController.resize(sessionId, body.rows, body.cols);
        else if (action === "signal") result = await interactiveController.signal(sessionId, body.signal);
        else if (action === "detach") result = await interactiveController.detach(sessionId);
        else if (action === "reconnect") result = await interactiveController.reconnect(sessionId, body);
        else result = await interactiveController.terminate(sessionId);
        sendJson(response, 200, { ok: true, result, session: interactiveController.getSession(sessionId) });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/sessions\/([^/]+)\/files\/(put|get)$/);
      if (method === "POST" && route) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        if (route[1] === "put") {
          const value = Buffer.from(String(body.data || ""), body.encoding === "base64" ? "base64" : "utf8");
          sendJson(response, 200, { ok: true, result: await interactiveController.putFile(route[0], body.path, value, body) });
        } else {
          const result = await interactiveController.getFile(route[0], body.path);
          sendJson(response, 200, { ok: true, file: { ...result, buffer: undefined, data: result.buffer.toString("base64"), encoding: "base64" } });
        }
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/tunnels`) {
        sendJson(response, 200, { ok: true, tunnels: interactiveController.listTunnels() });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/tunnels`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        sendJson(response, 201, { ok: true, tunnel: await interactiveController.openTunnel(body) });
        return;
      }
      route = matches(url.pathname, /^\/v1\/recovery\/tunnels\/([^/]+)\/close$/);
      if (method === "POST" && route) {
        sendJson(response, 200, { ok: true, tunnel: await interactiveController.closeTunnel(route[0]) });
        return;
      }
      if (method === "GET" && url.pathname === `${API_PREFIX}/console/adapters`) {
        sendJson(response, 200, { ok: true, adapters: await consoleLauncher.discover() });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/console/resolve`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        sendJson(response, 200, { ok: true, console: await consoleLauncher.resolve(body) });
        return;
      }
      if (method === "POST" && url.pathname === `${API_PREFIX}/console/launch`) {
        const body = await readJsonBody(request, config.maxJsonBytes);
        sendJson(response, 200, { ok: true, console: await consoleLauncher.launch(body) });
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
      route = matches(url.pathname, /^\/v1\/recovery\/agents\/([^/]+)$/);
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
        const caseDirectory = path.join(store.getPaths().cases, caseRecord.id);
        const [planGraph, procedure] = await Promise.all([
          fs.readFile(path.join(caseDirectory, "plan-graph.json"), "utf8").then(JSON.parse).catch(() => null),
          fs.readFile(path.join(caseDirectory, "procedure.json"), "utf8").then(JSON.parse).catch(() => null),
        ]);
        sendJson(response, 200, {
          ok: true,
          case: caseRecord,
          jobs: store.listJobs(caseRecord.id),
          artifacts: store.listArtifacts(caseRecord.id),
          inventory: await store.readInventory(caseRecord.targetAgentId),
          planGraph,
          procedure,
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
    nextStageAdapters = await discoverNextStageAdaptersImpl();
    nextStageRuntime = createNextStageRuntime({ adapters: nextStageAdapters, stateDir: config.stateDir, instances: nextStageInstances });
    interactiveController = createRecoveryInteractiveController({
      stateDir: config.stateDir,
      store,
      sendToAgent(agentId, message) {
        const session = sessions.get(String(agentId));
        return Boolean(session && sendSocket(session.socket, message));
      },
      isAgentOnline(agentId) {
        const session = sessions.get(String(agentId));
        return Boolean(session && session.state === "online" && session.socket.readyState === 1);
      },
      clock,
      log,
    });
    await interactiveController.init();
    fleetCommander = createRecoveryFleetCommander({
      stateDir: config.stateDir,
      store,
      controller: api,
      clock,
      wakeImpl,
      laneInvoker: async (type, { target, operation, run }) => {
        if (type === "vault-snapshot") return nextStageRuntime.invoke("continuity", "vault", "snapshotPaths", [operation.params?.paths || [], { ...(operation.params?.options || {}), sourceAgentId: target.agentId, fleetRunId: run.id }]);
        if (type === "image-deploy") return nextStageRuntime.invoke("imaging", "provisioning", operation.planOnly === false ? "deploy" : "planDeployment", [{ ...operation.params, targetAgentId: target.agentId }]);
        if (type === "salvage-plan") return nextStageRuntime.invoke("salvage", "engine", "plan", [{ ...operation.params, targetAgentId: target.agentId }]);
        if (type === "sync") return nextStageRuntime.invoke("sync", "engine", "sync", [operation.params?.folderId, operation.params?.options || {}]);
        throw createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, `Unsupported optional lane fleet action ${type}.`);
      },
      machineContextProvider: (agentId) => continuityFleetContext.get(String(agentId)) || null,
      healthRecommendationsProvider: (agentId) => continuityFleetContext.get(String(agentId))?.healthRecommendations || [],
      log,
    });
    await fleetCommander.init();
    consoleLauncher = createRecoveryConsoleLauncher();
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
        contextProvider: plannerLaneContext,
        memoryProvider: plannerCrossCaseMemory,
        protectionProvider: async ({ caseRecord, message }) => {
          if (!nextStageAdapters.continuity?.available || !Array.isArray(message.protectionPaths) || message.protectionPaths.length === 0) {
            return { available: false, reason: "Continuity vault or protectionPaths are unavailable." };
          }
          const snapshot = await nextStageRuntime.invoke("continuity", "vault", "snapshotPaths", [message.protectionPaths, { sourceCaseId: caseRecord.id }]);
          return { available: true, kind: "continuity-vault", snapshot };
        },
        log,
      });
    }
    storeUnsubscribe = store.onEvent((event) => {
      emitter.emit("event", event);
      if (event?.caseId) void trackContinuity(recordContinuityCaseEvent(event)).catch((error) => log(`Continuity case event: ${error.message}`));
    });
    server = createHttpServerImpl((request, response) => void handleRequest(request, response));
    server.on("upgrade", (request, socket, head) => {
      try {
        if (stopping) {
          socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
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
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
      // Recovery event streams are intentionally long-lived. During a release
      // activation they must not keep the old controller (and port 4852) alive.
      httpServer.closeAllConnections?.();
    }).catch(() => {});
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    storeUnsubscribe?.();
    storeUnsubscribe = null;
    clearInterval(sweepTimer);
    const activeSessions = [...sessions.values()];
    const socketClosures = [];
    for (const session of activeSessions) {
      if (session.socket.readyState !== 3) {
        socketClosures.push(Promise.race([
          new Promise((resolve) => session.socket.once("close", resolve)),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 500);
            timer.unref?.();
          }),
        ]));
      }
      sendSocket(session.socket, { type: "controller.shutdown", at: iso(clock) });
      try { session.socket.terminate(); } catch {}
    }
    for (const socket of wss.clients || []) {
      try { socket.terminate(); } catch {}
    }
    await Promise.allSettled(socketClosures);
    await Promise.allSettled(activeSessions.map((session) => session.messageTail));
    await Promise.allSettled([...dispatches.values()]);
    sessions.clear();
    for (const waiters of pendingInventory.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(createRecoveryError(RECOVERY_ERROR_CODES.INTERRUPTED, "Recovery controller stopped."));
      }
    }
    pendingInventory.clear();
    await Promise.allSettled([...continuityTasks]);
    await Promise.all([
      fleetCommander?.close().catch(() => {}),
      interactiveController?.close().catch(() => {}),
      nextStageRuntime?.close().catch(() => {}),
    ]);
    fleetCommander = null;
    interactiveController = null;
    consoleLauncher = null;
    nextStageRuntime = null;
    await Promise.all([closeServer(server), closeServer(bootServer)]);
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
    getFleet: () => fleetCommander,
    getInteractive: () => interactiveController,
    getNextStageAdapters: () => Object.fromEntries(Object.entries(nextStageAdapters).map(([lane, adapter]) => [lane, {
      available: adapter.available === true,
      capabilities: adapter.capabilities ? clone(adapter.capabilities) : null,
      reason: adapter.reason || "",
      source: adapter.source || "",
    }])),
  };
  return api;
}
