import { randomBytes } from "node:crypto";
import { WW_RECOVERY_PROTOCOL_VERSION } from "./ww-recovery-config.mjs";

export { WW_RECOVERY_PROTOCOL_VERSION };

export const RECOVERY_JOB_STATES = Object.freeze([
  "queued", "leased", "running", "succeeded", "failed", "canceled", "interrupted", "abandoned",
]);
export const RECOVERY_CASE_STATES = Object.freeze([
  "open", "running", "stopped", "completed", "failed", "abandoned",
]);
export const RECOVERY_STEP_STATES = Object.freeze([
  "queued", "running", "waiting-for-reboot", "succeeded", "failed", "canceled", "interrupted",
]);
export const RECOVERY_AGENT_SESSION_STATES = Object.freeze([
  "online", "stale", "offline",
]);
export const RECOVERY_JOB_MODES = Object.freeze([
  "typed", "unrestricted", "autonomous-unrestricted",
]);

export const RECOVERY_ERROR_CODES = Object.freeze({
  BAD_REQUEST: "ERR_WW_RECOVERY_BAD_REQUEST",
  PROTOCOL: "ERR_WW_RECOVERY_PROTOCOL",
  NOT_FOUND: "ERR_WW_RECOVERY_NOT_FOUND",
  AGENT_OFFLINE: "ERR_WW_RECOVERY_AGENT_OFFLINE",
  AGENT_REPLACED: "ERR_WW_RECOVERY_AGENT_REPLACED",
  DEVICE_NOT_FOUND: "ERR_WW_RECOVERY_DEVICE_NOT_FOUND",
  DEVICE_CHANGED: "ERR_WW_RECOVERY_DEVICE_CHANGED",
  TOOL_MISSING: "ERR_WW_RECOVERY_TOOL_MISSING",
  COMMAND_START: "ERR_WW_RECOVERY_COMMAND_START",
  COMMAND_FAILED: "ERR_WW_RECOVERY_COMMAND_FAILED",
  TIMEOUT: "ERR_WW_RECOVERY_TIMEOUT",
  CANCELED: "ERR_WW_RECOVERY_CANCELED",
  INTERRUPTED: "ERR_WW_RECOVERY_INTERRUPTED",
  INVALID_TRANSITION: "ERR_WW_RECOVERY_INVALID_TRANSITION",
  LEASE: "ERR_WW_RECOVERY_LEASE",
  EVENT_SEQUENCE: "ERR_WW_RECOVERY_EVENT_SEQUENCE",
  ARTIFACT_OFFSET: "ERR_WW_RECOVERY_ARTIFACT_OFFSET",
  ARTIFACT_HASH: "ERR_WW_RECOVERY_ARTIFACT_HASH",
  ARTIFACT_SPACE: "ERR_WW_RECOVERY_ARTIFACT_SPACE",
  PXE_CONFIG: "ERR_WW_RECOVERY_PXE_CONFIG",
  PXE_PROCESS: "ERR_WW_RECOVERY_PXE_PROCESS",
  BOOT_ARTIFACT: "ERR_WW_RECOVERY_BOOT_ARTIFACT",
  PLANNER_PROTOCOL: "ERR_WW_RECOVERY_PLANNER_PROTOCOL",
  PLANNER_EXIT: "ERR_WW_RECOVERY_PLANNER_EXIT",
  PLANNER_LIMIT: "ERR_WW_RECOVERY_PLANNER_LIMIT",
});

const JOB_TRANSITIONS = Object.freeze({
  queued: new Set(["leased", "canceled", "abandoned"]),
  leased: new Set(["queued", "running", "canceled", "interrupted", "abandoned"]),
  running: new Set(["succeeded", "failed", "canceled", "interrupted", "abandoned"]),
  succeeded: new Set(),
  failed: new Set(["queued"]),
  canceled: new Set(),
  // A controller may reconcile an interrupted lease when the same agent
  // reconnects and proves that the original process is still active or has a
  // durable completed result. Operator retry continues to use queued.
  interrupted: new Set(["queued", "running", "succeeded", "failed"]),
  abandoned: new Set(),
});

const CASE_TRANSITIONS = Object.freeze({
  open: new Set(["running", "completed", "failed", "abandoned"]),
  running: new Set(["stopped", "completed", "failed", "abandoned"]),
  stopped: new Set(["running", "completed", "failed", "abandoned"]),
  completed: new Set(),
  failed: new Set(["running", "abandoned"]),
  abandoned: new Set(),
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function nowIso(clock = Date) {
  const value = typeof clock === "function" && !clock.now
    ? clock()
    : new Date(clock.now());
  return new Date(value).toISOString();
}

function normalizeTimestamp(value, fallback = nowIso()) {
  const timestamp = new Date(value || fallback);
  return Number.isNaN(timestamp.getTime()) ? fallback : timestamp.toISOString();
}

function string(value = "") {
  return String(value ?? "").trim();
}

function error(message, code = RECOVERY_ERROR_CODES.BAD_REQUEST, details) {
  const next = new Error(message);
  next.code = code;
  if (details !== undefined) next.details = details;
  return next;
}

export function assertRecoveryId(value, label = "id") {
  const id = string(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,191}$/.test(id) || id.includes("..")) {
    throw error(`Invalid recovery ${label}.`);
  }
  return id;
}

export function generateRecoveryId(prefix = "wwr", {
  clock = Date,
  randomBytesImpl = randomBytes,
} = {}) {
  const safePrefix = String(prefix || "wwr").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "wwr";
  const milliseconds = typeof clock === "function" && !clock.now ? Number(clock()) : Number(clock.now());
  const sortable = Math.max(0, milliseconds).toString(36).padStart(10, "0");
  const entropy = randomBytesImpl(9).toString("base64url");
  return `${safePrefix}_${sortable}${entropy}`;
}

export function assertJsonSerializable(value, label = "value") {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("undefined");
    JSON.parse(serialized);
  } catch (cause) {
    throw error(`${label} must be JSON-serializable.`, RECOVERY_ERROR_CODES.BAD_REQUEST, {
      cause: cause.message,
    });
  }
  return value;
}

export function assertJsonMessageSize(value, maxBytes) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (Number(maxBytes) > 0 && bytes > Number(maxBytes)) {
    throw error(`Recovery message is ${bytes} bytes; limit is ${maxBytes}.`);
  }
  return bytes;
}

export function encodeOutputChunk(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");
  const decoded = buffer.toString("utf8");
  if (Buffer.from(decoded, "utf8").equals(buffer)) {
    return { data: decoded, encoding: "utf8" };
  }
  return { data: buffer.toString("base64"), encoding: "base64" };
}

export function decodeOutputChunk({ data = "", encoding = "utf8" } = {}) {
  return Buffer.from(String(data), encoding === "base64" ? "base64" : "utf8");
}

export function createStep(input = {}, options = {}) {
  const createdAt = nowIso(options.clock);
  const step = {
    id: string(input.id) || generateRecoveryId("step", options),
    action: string(input.action),
    params: isObject(input.params) || Array.isArray(input.params) ? clone(input.params) : {},
    timeoutMs: input.timeoutMs === undefined ? 120_000 : Number(input.timeoutMs),
    continueOnError: input.continueOnError === true,
    parallel: input.parallel === true,
    state: string(input.state) || "queued",
    createdAt: normalizeTimestamp(input.createdAt, createdAt),
  };
  if (input.force !== undefined) step.force = input.force === true;
  return assertValidStep(step);
}

export function createCase(input = {}, options = {}) {
  const createdAt = nowIso(options.clock);
  const record = {
    id: string(input.id) || generateRecoveryId("wwc", options),
    protocol: WW_RECOVERY_PROTOCOL_VERSION,
    targetAgentId: string(input.targetAgentId || input.agentId),
    goal: String(input.goal ?? ""),
    mode: string(input.mode) || (input.autonomous ? "autonomous-unrestricted" : "unrestricted"),
    state: string(input.state) || "open",
    createdAt: normalizeTimestamp(input.createdAt, createdAt),
    updatedAt: normalizeTimestamp(input.updatedAt, createdAt),
    createdBy: string(input.createdBy) || "operator",
    notes: Array.isArray(input.notes) ? clone(input.notes) : [],
    metadata: isObject(input.metadata) ? clone(input.metadata) : {},
  };
  return normalizeCase(record);
}

export function createJob(input = {}, options = {}) {
  const createdAt = nowIso(options.clock);
  const job = {
    id: string(input.id) || generateRecoveryId("wwj", options),
    caseId: string(input.caseId),
    targetAgentId: string(input.targetAgentId || input.agentId),
    protocol: WW_RECOVERY_PROTOCOL_VERSION,
    goal: String(input.goal ?? ""),
    mode: string(input.mode) || "unrestricted",
    force: input.force === true,
    state: string(input.state) || "queued",
    createdAt: normalizeTimestamp(input.createdAt, createdAt),
    updatedAt: normalizeTimestamp(input.updatedAt, createdAt),
    createdBy: string(input.createdBy) || "operator",
    leaseMs: Number.isFinite(Number(input.leaseMs)) ? Number(input.leaseMs) : 30_000,
    attempt: Number.isInteger(Number(input.attempt)) ? Number(input.attempt) : 0,
    steps: (Array.isArray(input.steps) ? input.steps : []).map((step) => createStep(step, options)),
    metadata: isObject(input.metadata) ? clone(input.metadata) : {},
  };
  return assertValidJob(job);
}

export function createEvent(input = {}, options = {}) {
  const at = nowIso(options.clock);
  const eventRecord = {
    ...(Number.isSafeInteger(Number(input.seq)) && Number(input.seq) > 0 ? { seq: Number(input.seq) } : {}),
    at: normalizeTimestamp(input.at, at),
    type: string(input.type),
    ...(string(input.caseId) ? { caseId: string(input.caseId) } : {}),
    ...(string(input.jobId) ? { jobId: string(input.jobId) } : {}),
    ...(string(input.stepId) ? { stepId: string(input.stepId) } : {}),
    ...(string(input.agentId) ? { agentId: string(input.agentId) } : {}),
    ...(string(input.bootId) ? { bootId: string(input.bootId) } : {}),
    ...(Number.isSafeInteger(Number(input.agentSeq)) && Number(input.agentSeq) >= 0
      ? { agentSeq: Number(input.agentSeq) }
      : {}),
  };
  for (const [key, value] of Object.entries(input)) {
    if (!(key in eventRecord) && value !== undefined) eventRecord[key] = clone(value);
  }
  return assertValidEvent(eventRecord);
}

export function createArtifactRecord(input = {}, options = {}) {
  const createdAt = nowIso(options.clock);
  const artifact = {
    id: string(input.id) || generateRecoveryId("wwa", options),
    caseId: string(input.caseId),
    jobId: string(input.jobId),
    stepId: string(input.stepId),
    agentId: string(input.agentId),
    kind: string(input.kind) || "generic",
    filename: String(input.filename || "artifact.bin"),
    contentType: string(input.contentType) || "application/octet-stream",
    size: Number.isSafeInteger(Number(input.size)) && Number(input.size) >= 0 ? Number(input.size) : 0,
    hash: string(input.hash) || null,
    complete: input.complete === true,
    createdAt: normalizeTimestamp(input.createdAt, createdAt),
    updatedAt: normalizeTimestamp(input.updatedAt, createdAt),
    metadata: isObject(input.metadata) ? clone(input.metadata) : {},
  };
  assertRecoveryId(artifact.id, "artifact id");
  if (artifact.caseId) assertRecoveryId(artifact.caseId, "case id");
  if (artifact.jobId) assertRecoveryId(artifact.jobId, "job id");
  return artifact;
}

export function normalizeAgentHello(input = {}) {
  const raw = isObject(input) ? input : {};
  const hello = {
    type: "agent.hello",
    protocol: Number(raw.protocol),
    agentId: string(raw.agentId),
    bootId: string(raw.bootId),
    hostname: string(raw.hostname) || "unknown",
    mode: ["installed", "pxe", "test"].includes(string(raw.mode)) ? string(raw.mode) : "installed",
    version: string(raw.version) || "0.0.0",
    startedAt: normalizeTimestamp(raw.startedAt),
    controllerHint: string(raw.controllerHint),
    addresses: (Array.isArray(raw.addresses) ? raw.addresses : []).map((address) => ({
      name: string(address?.name),
      mac: string(address?.mac).toLowerCase(),
      address: string(address?.address),
    })),
    capabilities: isObject(raw.capabilities) ? clone(raw.capabilities) : {},
  };
  if (isObject(raw.identity)) hello.identity = clone(raw.identity);
  return hello;
}

export function assertValidAgentHello(input) {
  const hello = normalizeAgentHello(input);
  if (hello.protocol !== WW_RECOVERY_PROTOCOL_VERSION) {
    throw error(
      `Unsupported recovery protocol ${hello.protocol}; expected ${WW_RECOVERY_PROTOCOL_VERSION}.`,
      RECOVERY_ERROR_CODES.PROTOCOL,
    );
  }
  assertRecoveryId(hello.agentId, "agent id");
  if (!hello.bootId) throw error("Recovery agent hello requires bootId.");
  assertJsonSerializable(hello.capabilities, "Agent capabilities");
  return hello;
}

export function normalizeInventory(input = {}) {
  const raw = isObject(input) ? input : {};
  return {
    collectedAt: normalizeTimestamp(raw.collectedAt),
    agent: isObject(raw.agent) ? clone(raw.agent) : {},
    system: isObject(raw.system) ? clone(raw.system) : {},
    network: {
      interfaces: Array.isArray(raw.network?.interfaces) ? clone(raw.network.interfaces) : [],
      routes: Array.isArray(raw.network?.routes) ? clone(raw.network.routes) : [],
    },
    firmware: {
      uefi: raw.firmware?.uefi === true,
      secureBoot: typeof raw.firmware?.secureBoot === "boolean" ? raw.firmware.secureBoot : null,
      entries: Array.isArray(raw.firmware?.entries) ? clone(raw.firmware.entries) : [],
    },
    tools: isObject(raw.tools) ? clone(raw.tools) : {},
    block: {
      devices: Array.isArray(raw.block?.devices) ? clone(raw.block.devices) : [],
      filesystems: Array.isArray(raw.block?.filesystems) ? clone(raw.block.filesystems) : [],
      mounts: Array.isArray(raw.block?.mounts) ? clone(raw.block.mounts) : [],
      raid: Array.isArray(raw.block?.raid) ? clone(raw.block.raid) : [],
      lvm: isObject(raw.block?.lvm) ? clone(raw.block.lvm) : {},
      crypt: Array.isArray(raw.block?.crypt) ? clone(raw.block.crypt) : [],
      graph: {
        nodes: Array.isArray(raw.block?.graph?.nodes) ? clone(raw.block.graph.nodes) : [],
        edges: Array.isArray(raw.block?.graph?.edges) ? clone(raw.block.graph.edges) : [],
      },
    },
    health: {
      smart: Array.isArray(raw.health?.smart) ? clone(raw.health.smart) : [],
      nvme: Array.isArray(raw.health?.nvme) ? clone(raw.health.nvme) : [],
      kernelWarnings: Array.isArray(raw.health?.kernelWarnings) ? clone(raw.health.kernelWarnings) : [],
    },
    platformFacts: isObject(raw.platformFacts) ? clone(raw.platformFacts) : {},
    raw: isObject(raw.raw) ? clone(raw.raw) : {},
    errors: Array.isArray(raw.errors) ? clone(raw.errors) : [],
  };
}

export function normalizeCase(input = {}) {
  const raw = isObject(input) ? input : {};
  const normalized = {
    ...clone(raw),
    id: string(raw.id),
    protocol: Number(raw.protocol || WW_RECOVERY_PROTOCOL_VERSION),
    targetAgentId: string(raw.targetAgentId || raw.agentId),
    goal: String(raw.goal ?? ""),
    mode: string(raw.mode) || "unrestricted",
    state: string(raw.state) || "open",
    createdAt: normalizeTimestamp(raw.createdAt),
    updatedAt: normalizeTimestamp(raw.updatedAt || raw.createdAt),
    createdBy: string(raw.createdBy) || "operator",
    notes: Array.isArray(raw.notes) ? clone(raw.notes) : [],
    metadata: isObject(raw.metadata) ? clone(raw.metadata) : {},
  };
  assertRecoveryId(normalized.id, "case id");
  if (!RECOVERY_CASE_STATES.includes(normalized.state)) throw error(`Invalid case state ${normalized.state}.`);
  if (normalized.targetAgentId) assertRecoveryId(normalized.targetAgentId, "target agent id");
  return normalized;
}

export function normalizeJob(input = {}) {
  return createJob(input);
}

export function normalizeEvent(input = {}) {
  return createEvent(input);
}

export function assertValidStep(input) {
  if (!isObject(input)) throw error("Recovery step must be an object.");
  assertRecoveryId(input.id, "step id");
  if (!string(input.action)) throw error("Recovery step requires an action.");
  const timeoutMs = Number(input.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw error("Recovery step timeout must be zero or greater.");
  if (!RECOVERY_STEP_STATES.includes(input.state || "queued")) throw error(`Invalid step state ${input.state}.`);
  assertJsonSerializable(input.params ?? {}, "Step params");
  return input;
}

export function assertValidJob(input) {
  if (!isObject(input)) throw error("Recovery job must be an object.");
  assertRecoveryId(input.id, "job id");
  assertRecoveryId(input.caseId, "case id");
  assertRecoveryId(input.targetAgentId, "target agent id");
  if (Number(input.protocol) !== WW_RECOVERY_PROTOCOL_VERSION) {
    throw error("Recovery job protocol mismatch.", RECOVERY_ERROR_CODES.PROTOCOL);
  }
  if (!RECOVERY_JOB_STATES.includes(input.state)) throw error(`Invalid job state ${input.state}.`);
  if (!RECOVERY_JOB_MODES.includes(input.mode)) throw error(`Invalid job mode ${input.mode}.`);
  if (!Array.isArray(input.steps) || input.steps.length === 0) throw error("Recovery job requires at least one step.");
  const ids = new Set();
  for (const step of input.steps) {
    assertValidStep(step);
    if (ids.has(step.id)) throw error(`Duplicate recovery step id ${step.id}.`);
    ids.add(step.id);
  }
  assertJsonSerializable(input, "Recovery job");
  return input;
}

export function assertValidEvent(input) {
  if (!isObject(input)) throw error("Recovery event must be an object.");
  if (!string(input.type)) throw error("Recovery event requires a type.");
  if (input.seq !== undefined && (!Number.isSafeInteger(input.seq) || input.seq <= 0)) {
    throw error("Recovery event seq must be a positive safe integer.");
  }
  if (input.agentSeq !== undefined && (!Number.isSafeInteger(input.agentSeq) || input.agentSeq < 0)) {
    throw error("Recovery event agentSeq must be a nonnegative safe integer.");
  }
  for (const field of ["caseId", "jobId", "stepId", "agentId"]) {
    if (input[field]) assertRecoveryId(input[field], field);
  }
  assertJsonSerializable(input, "Recovery event");
  return input;
}

export function transitionJobState(job, nextState, patch = {}, options = {}) {
  const current = string(job?.state);
  const next = string(nextState);
  if (!RECOVERY_JOB_STATES.includes(next) || !JOB_TRANSITIONS[current]?.has(next)) {
    throw error(
      `Invalid recovery job transition ${current || "<missing>"} -> ${next || "<missing>"}.`,
      RECOVERY_ERROR_CODES.INVALID_TRANSITION,
    );
  }
  return assertValidJob({
    ...clone(job),
    ...clone(patch),
    state: next,
    updatedAt: nowIso(options.clock),
  });
}

export function transitionCaseState(caseRecord, nextState, patch = {}, options = {}) {
  const current = string(caseRecord?.state);
  const next = string(nextState);
  if (!RECOVERY_CASE_STATES.includes(next) || !CASE_TRANSITIONS[current]?.has(next)) {
    throw error(
      `Invalid recovery case transition ${current || "<missing>"} -> ${next || "<missing>"}.`,
      RECOVERY_ERROR_CODES.INVALID_TRANSITION,
    );
  }
  return normalizeCase({
    ...clone(caseRecord),
    ...clone(patch),
    state: next,
    updatedAt: nowIso(options.clock),
  });
}

export function isTerminalJobState(state) {
  return ["succeeded", "failed", "canceled", "abandoned"].includes(string(state));
}

export function isTerminalCaseState(state) {
  return ["completed", "abandoned"].includes(string(state));
}

export function createRecoveryError(code, message, details) {
  return error(message, code, details);
}
