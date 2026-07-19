import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  assertRecoveryId,
  createArtifactRecord,
  createCase as createCaseRecord,
  createEvent,
  createJob as createJobRecord,
  decodeOutputChunk,
  generateRecoveryId,
  normalizeCase,
  transitionCaseState,
  transitionJobState,
  RECOVERY_ERROR_CODES,
} from "./ww-recovery-protocol.mjs";

const STORE_LOCK_STALE_MS = 60_000;
const STORE_LOCK_TIMEOUT_MS = 5_000;

function clone(value) {
  return structuredClone(value);
}

function nowIso(clock) {
  const value = typeof clock === "function" && !clock.now ? clock() : clock.now();
  return new Date(value).toISOString();
}

function notFound(kind, id) {
  const error = new Error(`Recovery ${kind} ${id} was not found.`);
  error.code = RECOVERY_ERROR_CODES.NOT_FOUND;
  return error;
}

function safeId(value, label = "id") {
  return assertRecoveryId(String(value || ""), label);
}

async function pathExists(fsApi, candidate) {
  try {
    await fsApi.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readJson(fsApi, filename, fallback = null) {
  try {
    return JSON.parse(await fsApi.readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readJsonLines(fsApi, filename) {
  let raw;
  try {
    raw = await fsApi.readFile(filename, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (cause) {
      const error = new Error(`Malformed recovery journal ${filename}: ${cause.message}`);
      error.code = "ERR_WW_RECOVERY_JOURNAL";
      throw error;
    }
  }
  return records;
}

function buildArtifactEvent(record, type = "step.artifact") {
  return {
    type,
    caseId: record.caseId || undefined,
    jobId: record.jobId || undefined,
    stepId: record.stepId || undefined,
    agentId: record.agentId || undefined,
    artifact: clone(record),
  };
}

export function createRecoveryStore({
  stateDir,
  clock = Date,
  randomBytesImpl = randomBytes,
  fsImpl = fs,
  fsSyncImpl = fsSync,
  lockStaleMs = STORE_LOCK_STALE_MS,
  lockTimeoutMs = STORE_LOCK_TIMEOUT_MS,
} = {}) {
  if (!stateDir) throw new TypeError("Recovery store requires stateDir.");
  const root = path.resolve(stateDir);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const agents = new Map();
  const cases = new Map();
  const jobs = new Map();
  const artifacts = new Map();
  const macAddresses = new Map();
  const jobToCase = new Map();
  const agentEventKeys = new Map();
  const jobEventSeqs = new Map();
  let mutationTail = Promise.resolve();
  let initialized = false;
  let closed = false;
  let lockHandle = null;
  let lockPath = path.join(root, ".store.lock");

  const paths = {
    root,
    agentsSnapshot: path.join(root, "agents.json"),
    macAddresses: path.join(root, "mac-addresses.json"),
    agents: path.join(root, "agents"),
    cases: path.join(root, "cases"),
    boot: path.join(root, "boot"),
    bootIpxe: path.join(root, "boot", "ipxe"),
    bootLive: path.join(root, "boot", "live"),
    pxe: path.join(root, "pxe"),
    uploads: path.join(root, "uploads"),
    downloads: path.join(root, "downloads"),
    scratch: path.join(root, "scratch"),
    controllerLog: path.join(root, "controller.log"),
  };

  function caseDir(caseId) {
    return path.join(paths.cases, safeId(caseId, "case id"));
  }

  function casePath(caseId) {
    return path.join(caseDir(caseId), "case.json");
  }

  function caseEventsPath(caseId) {
    return path.join(caseDir(caseId), "events.jsonl");
  }

  function jobDir(jobId) {
    const caseId = jobToCase.get(jobId) || jobs.get(jobId)?.caseId;
    if (!caseId) throw notFound("job", jobId);
    return path.join(caseDir(caseId), "jobs", safeId(jobId, "job id"));
  }

  function jobPath(jobId) {
    return path.join(jobDir(jobId), "job.json");
  }

  function artifactMetadataPath(artifactId) {
    return path.join(paths.uploads, `${safeId(artifactId, "artifact id")}.json`);
  }

  function artifactBytesPath(record, { partial = false } = {}) {
    const suffix = partial ? ".partial" : ".bin";
    if (record.caseId && record.jobId && jobToCase.get(record.jobId) === record.caseId) {
      return path.join(jobDir(record.jobId), "artifacts", `${record.id}${suffix}`);
    }
    return path.join(paths.uploads, `${record.id}${suffix}`);
  }

  async function atomicJson(filename, value) {
    await fsImpl.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filename}.${process.pid}.${randomBytesImpl(8).toString("hex")}.tmp`;
    try {
      await fsImpl.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const handle = await fsImpl.open(temporaryPath, "r");
      await handle.sync();
      await handle.close();
      await fsImpl.rename(temporaryPath, filename);
      await fsImpl.chmod(filename, 0o600).catch(() => {});
    } finally {
      await fsImpl.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async function appendJsonLine(filename, value) {
    await fsImpl.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const handle = await fsImpl.open(filename, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  function enqueue(task) {
    if (closed) return Promise.reject(new Error("Recovery store is closed."));
    const run = mutationTail.then(task, task);
    mutationTail = run.catch(() => {});
    return run;
  }

  async function waitForLock(delayMs = 25) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  async function acquireLock() {
    await fsImpl.mkdir(root, { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    while (!lockHandle) {
      try {
        lockHandle = await fsImpl.open(lockPath, "wx", 0o600);
        await lockHandle.writeFile(`${JSON.stringify({
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAt: nowIso(clock),
        })}\n`, "utf8");
        await lockHandle.sync();
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const stats = await fsImpl.stat(lockPath).catch(() => null);
        let stale = Boolean(stats && Date.now() - stats.mtimeMs > lockStaleMs);
        const owner = await readJson(fsImpl, lockPath, null).catch(() => null);
        if (!stale && owner?.hostname === os.hostname() && Number.isInteger(owner?.pid)) {
          try {
            process.kill(owner.pid, 0);
          } catch (probeError) {
            if (probeError?.code === "ESRCH") stale = true;
          }
        }
        if (stale) {
          await fsImpl.rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() - startedAt >= lockTimeoutMs) {
          const timeoutError = new Error(`Recovery state is already owned: ${lockPath}`);
          timeoutError.code = "ERR_WW_RECOVERY_STORE_LOCK";
          timeoutError.owner = owner;
          throw timeoutError;
        }
        await waitForLock();
      }
    }
  }

  async function loadState() {
    const agentsSnapshot = await readJson(fsImpl, paths.agentsSnapshot, { agents: [] });
    for (const agent of Array.isArray(agentsSnapshot) ? agentsSnapshot : agentsSnapshot?.agents || []) {
      if (!agent?.agentId) continue;
      try {
        safeId(agent.agentId, "agent id");
        agents.set(agent.agentId, agent);
      } catch {}
    }
    const macSnapshot = await readJson(fsImpl, paths.macAddresses, { machines: [] });
    for (const record of Array.isArray(macSnapshot) ? macSnapshot : macSnapshot?.machines || []) {
      const mac = normalizeStoredMac(record?.mac);
      if (mac) macAddresses.set(mac, { ...record, mac });
    }

    const caseEntries = await fsImpl.readdir(paths.cases, { withFileTypes: true }).catch(() => []);
    for (const entry of caseEntries) {
      if (!entry.isDirectory()) continue;
      let caseId;
      try {
        caseId = safeId(entry.name, "case id");
      } catch {
        continue;
      }
      const record = await readJson(fsImpl, casePath(caseId), null);
      if (!record) continue;
      const events = await readJsonLines(fsImpl, caseEventsPath(caseId));
      const lastSeq = events.reduce((maximum, event) => Math.max(maximum, Number(event.seq) || 0), 0);
      record.lastSeq = Math.max(Number(record.lastSeq) || 0, lastSeq);
      cases.set(caseId, record);
      for (const event of events) {
        const key = dedupeKey(event);
        if (key) agentEventKeys.set(key, event);
      }
      const jobsDir = path.join(caseDir(caseId), "jobs");
      const jobEntries = await fsImpl.readdir(jobsDir, { withFileTypes: true }).catch(() => []);
      for (const jobEntry of jobEntries) {
        if (!jobEntry.isDirectory()) continue;
        let jobId;
        try {
          jobId = safeId(jobEntry.name, "job id");
        } catch {
          continue;
        }
        const jobRecord = await readJson(fsImpl, path.join(jobsDir, jobId, "job.json"), null);
        if (!jobRecord) continue;
        jobs.set(jobId, jobRecord);
        jobToCase.set(jobId, caseId);
        const persistedJobEvents = await readJsonLines(
          fsImpl,
          path.join(jobsDir, jobId, "events.jsonl"),
        );
        jobEventSeqs.set(jobId, new Set(persistedJobEvents.map((event) => event.seq)));
      }
    }

    const artifactEntries = await fsImpl.readdir(paths.uploads, { withFileTypes: true }).catch(() => []);
    for (const entry of artifactEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = await readJson(fsImpl, path.join(paths.uploads, entry.name), null);
      if (record?.id) artifacts.set(record.id, record);
    }
  }

  function dedupeKey(event) {
    if (
      !event?.agentId
      || !event?.bootId
      || !event?.jobId
      || !Number.isSafeInteger(Number(event?.agentSeq))
    ) return "";
    return `${event.agentId}|${event.bootId}|${event.jobId}|${event.agentSeq}`;
  }

  async function persistAgents() {
    const values = [...agents.values()].sort((left, right) => String(left.agentId).localeCompare(String(right.agentId)));
    await atomicJson(paths.agentsSnapshot, {
      version: 1,
      updatedAt: nowIso(clock),
      agents: values,
    });
  }

  function normalizeStoredMac(value = "") {
    const compact = String(value || "").toLowerCase().replace(/[^0-9a-f]/g, "");
    if (!/^[0-9a-f]{12}$/.test(compact) || compact === "000000000000") return "";
    return compact.match(/.{2}/g).join(":");
  }

  async function persistMacAddresses() {
    await atomicJson(paths.macAddresses, {
      version: 1,
      updatedAt: nowIso(clock),
      machines: [...macAddresses.values()].sort((left, right) => String(left.mac).localeCompare(String(right.mac))),
    });
  }

  function rememberMacUnlocked(input = {}) {
    const mac = normalizeStoredMac(input.mac);
    if (!mac) return null;
    const previous = macAddresses.get(mac) || {};
    const record = {
      ...previous,
      ...clone(input),
      mac,
      name: String(input.name || input.hostname || previous.name || ""),
      agentId: String(input.agentId || previous.agentId || ""),
      firstSeenAt: previous.firstSeenAt || nowIso(clock),
      lastSeenAt: nowIso(clock),
    };
    macAddresses.set(mac, record);
    return record;
  }

  async function persistCase(record) {
    await atomicJson(casePath(record.id), record);
  }

  async function persistJob(record) {
    await fsImpl.mkdir(path.join(jobDir(record.id), "artifacts"), { recursive: true, mode: 0o700 });
    await atomicJson(jobPath(record.id), record);
  }

  async function appendCaseEventUnlocked(caseId, input) {
    const record = cases.get(caseId);
    if (!record) throw notFound("case", caseId);
    const duplicateKey = dedupeKey(input);
    if (duplicateKey && agentEventKeys.has(duplicateKey)) return clone(agentEventKeys.get(duplicateKey));
    const event = createEvent({
      ...clone(input),
      caseId,
      seq: (Number(record.lastSeq) || 0) + 1,
      at: nowIso(clock),
    });
    await appendJsonLine(caseEventsPath(caseId), event);
    record.lastSeq = event.seq;
    record.updatedAt = event.at;
    await persistCase(record);
    if (duplicateKey) agentEventKeys.set(duplicateKey, event);
    queueMicrotask(() => emitter.emit("event", clone(event)));
    return clone(event);
  }

  async function appendJobEventUnlocked(jobId, input) {
    const record = jobs.get(jobId);
    if (!record) throw notFound("job", jobId);
    const jobEventInput = {
      ...clone(input),
      jobId,
    };
    const replayKey = dedupeKey(jobEventInput);
    if (replayKey && agentEventKeys.has(replayKey)) {
      return clone(agentEventKeys.get(replayKey));
    }
    const event = await appendCaseEventUnlocked(record.caseId, jobEventInput);
    const eventPath = path.join(jobDir(jobId), "events.jsonl");
    const persistedSequences = jobEventSeqs.get(jobId) || new Set();
    jobEventSeqs.set(jobId, persistedSequences);
    if (!persistedSequences.has(event.seq)) {
      await appendJsonLine(eventPath, event);
      persistedSequences.add(event.seq);
    }
    if (event.type === "step.output" && ["stdout", "stderr"].includes(event.stream)) {
      const output = decodeOutputChunk(event);
      const logPath = path.join(jobDir(jobId), `${event.stream}.log`);
      await fsImpl.appendFile(logPath, output, { mode: 0o600 });
    }
    return event;
  }

  async function init() {
    if (initialized) return api;
    await acquireLock();
    const directories = [
      paths.root, paths.agents, paths.cases, paths.boot, paths.bootIpxe, paths.bootLive,
      paths.pxe, paths.uploads, paths.downloads, paths.scratch,
    ];
    for (const directory of directories) {
      await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await loadState();
    initialized = true;
    return api;
  }

  async function close() {
    if (closed) return;
    await mutationTail.catch(() => {});
    closed = true;
    emitter.removeAllListeners();
    if (lockHandle) {
      await lockHandle.close().catch(() => {});
      lockHandle = null;
      await fsImpl.rm(lockPath, { force: true }).catch(() => {});
    }
  }

  function listAgents(filters = {}) {
    return [...agents.values()]
      .filter((record) => !filters.state || record.state === filters.state)
      .sort((left, right) => String(left.hostname || left.agentId).localeCompare(String(right.hostname || right.agentId)))
      .map(clone);
  }

  function getAgent(agentId) {
    const record = agents.get(safeId(agentId, "agent id"));
    return record ? clone(record) : null;
  }

  function upsertAgent(input) {
    return enqueue(async () => {
      const agentId = safeId(input?.agentId || input?.id, "agent id");
      const previous = agents.get(agentId) || {};
      const record = {
        ...clone(previous),
        ...clone(input),
        agentId,
        state: input.state || "online",
        firstSeenAt: previous.firstSeenAt || input.firstSeenAt || nowIso(clock),
        lastSeenAt: input.lastSeenAt || nowIso(clock),
        updatedAt: nowIso(clock),
      };
      agents.set(agentId, record);
      await persistAgents();
      const agentDirectory = path.join(paths.agents, agentId);
      await fsImpl.mkdir(agentDirectory, { recursive: true, mode: 0o700 });
      await atomicJson(path.join(agentDirectory, "latest.json"), record);
      let learnedMac = false;
      for (const address of Array.isArray(record.addresses) ? record.addresses : []) {
        if (rememberMacUnlocked({
          mac: address?.mac,
          name: record.hostname || record.name,
          agentId,
          interface: address?.name || "",
          address: address?.address || "",
          source: "agent-hello",
        })) learnedMac = true;
      }
      if (learnedMac) await persistMacAddresses();
      return clone(record);
    });
  }

  function rememberMacAddress(input = {}) {
    return enqueue(async () => {
      const record = rememberMacUnlocked(input);
      if (!record) {
        const error = new Error("A valid non-zero MAC address is required.");
        error.code = RECOVERY_ERROR_CODES.BAD_REQUEST;
        throw error;
      }
      await persistMacAddresses();
      return clone(record);
    });
  }

  function listMacAddresses() {
    return [...macAddresses.values()].map(clone);
  }

  function markAgentOffline(agentId, reason = "connection-lost") {
    return enqueue(async () => {
      const id = safeId(agentId, "agent id");
      const previous = agents.get(id);
      if (!previous) throw notFound("agent", id);
      const record = {
        ...previous,
        state: "offline",
        offlineReason: String(reason || "connection-lost"),
        offlineAt: nowIso(clock),
        updatedAt: nowIso(clock),
      };
      agents.set(id, record);
      await persistAgents();
      await atomicJson(path.join(paths.agents, id, "latest.json"), record);
      return clone(record);
    });
  }

  function createCase(input) {
    return enqueue(async () => {
      const record = createCaseRecord(input, { clock, randomBytesImpl });
      if (cases.has(record.id)) throw new Error(`Recovery case ${record.id} already exists.`);
      record.lastSeq = 0;
      cases.set(record.id, record);
      await fsImpl.mkdir(path.join(caseDir(record.id), "jobs"), { recursive: true, mode: 0o700 });
      await persistCase(record);
      await appendCaseEventUnlocked(record.id, {
        type: "case.created",
        case: clone(record),
      });
      return clone(record);
    });
  }

  function listCases(filters = {}) {
    return [...cases.values()]
      .filter((record) => !filters.agentId || record.targetAgentId === filters.agentId)
      .filter((record) => !filters.state || record.state === filters.state)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .map(clone);
  }

  function getCase(caseId) {
    const record = cases.get(safeId(caseId, "case id"));
    return record ? clone(record) : null;
  }

  function updateCase(caseId, patch) {
    return enqueue(async () => {
      const id = safeId(caseId, "case id");
      const previous = cases.get(id);
      if (!previous) throw notFound("case", id);
      let record;
      if (patch?.state && patch.state !== previous.state) {
        record = transitionCaseState(previous, patch.state, patch, { clock });
      } else {
        record = normalizeCase({
          ...previous,
          ...clone(patch || {}),
          id,
          updatedAt: nowIso(clock),
        });
      }
      record.lastSeq = previous.lastSeq || 0;
      cases.set(id, record);
      await persistCase(record);
      await appendCaseEventUnlocked(id, {
        type: patch?.goal !== undefined ? "case.goal.updated" : "case.updated",
        patch: clone(patch || {}),
        state: record.state,
      });
      return clone(record);
    });
  }

  function createJob(caseId, input) {
    return enqueue(async () => {
      const id = safeId(caseId, "case id");
      const caseRecord = cases.get(id);
      if (!caseRecord) throw notFound("case", id);
      const record = createJobRecord({
        ...clone(input),
        caseId: id,
        targetAgentId: input?.targetAgentId || caseRecord.targetAgentId,
        goal: input?.goal ?? caseRecord.goal,
      }, { clock, randomBytesImpl });
      if (jobs.has(record.id)) throw new Error(`Recovery job ${record.id} already exists.`);
      jobs.set(record.id, record);
      jobToCase.set(record.id, id);
      jobEventSeqs.set(record.id, new Set());
      await persistJob(record);
      await appendCaseEventUnlocked(id, {
        type: "job.created",
        jobId: record.id,
        job: clone(record),
      });
      await appendJobEventUnlocked(record.id, {
        type: "job.queued",
        state: "queued",
      });
      return clone(record);
    });
  }

  function getJob(jobId) {
    const record = jobs.get(safeId(jobId, "job id"));
    return record ? clone(record) : null;
  }

  function listJobs(caseId, filters = {}) {
    const caseKey = caseId ? safeId(caseId, "case id") : "";
    return [...jobs.values()]
      .filter((record) => !caseKey || record.caseId === caseKey)
      .filter((record) => !filters.state || record.state === filters.state)
      .filter((record) => !filters.agentId || record.targetAgentId === filters.agentId)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map(clone);
  }

  function transitionJob(jobId, nextState, patch = {}) {
    return enqueue(async () => {
      const id = safeId(jobId, "job id");
      const previous = jobs.get(id);
      if (!previous) throw notFound("job", id);
      const record = transitionJobState(previous, nextState, patch, { clock });
      jobs.set(id, record);
      await persistJob(record);
      const type = `job.${nextState === "succeeded" ? "succeeded" : nextState}`;
      await appendJobEventUnlocked(id, {
        type,
        state: nextState,
        ...(patch?.reason ? { reason: patch.reason } : {}),
        ...(patch?.result ? { result: clone(patch.result) } : {}),
      });
      if (patch?.result !== undefined) {
        await atomicJson(path.join(jobDir(id), "result.json"), patch.result);
      }
      return clone(record);
    });
  }

  function updateJob(jobId, patch = {}) {
    return enqueue(async () => {
      const id = safeId(jobId, "job id");
      const previous = jobs.get(id);
      if (!previous) throw notFound("job", id);
      if (patch.state && patch.state !== previous.state) {
        throw new Error("Use transitionJob() to change a recovery job state.");
      }
      const record = {
        ...previous,
        ...clone(patch),
        id,
        state: previous.state,
        updatedAt: nowIso(clock),
      };
      jobs.set(id, record);
      await persistJob(record);
      return clone(record);
    });
  }

  function appendCaseEvent(caseId, event) {
    return enqueue(() => appendCaseEventUnlocked(safeId(caseId, "case id"), event));
  }

  function appendJobEvent(jobId, event) {
    return enqueue(() => appendJobEventUnlocked(safeId(jobId, "job id"), event));
  }

  async function readCaseEvents(caseId, afterSeq = 0) {
    const id = safeId(caseId, "case id");
    if (!cases.has(id)) throw notFound("case", id);
    return (await readJsonLines(fsImpl, caseEventsPath(id)))
      .filter((event) => Number(event.seq) > Number(afterSeq || 0));
  }

  async function readJobEvents(jobId, afterSeq = 0) {
    const id = safeId(jobId, "job id");
    if (!jobs.has(id)) throw notFound("job", id);
    return (await readJsonLines(fsImpl, path.join(jobDir(id), "events.jsonl")))
      .filter((event) => Number(event.seq) > Number(afterSeq || 0));
  }

  function writeInventory(agentId, inventory) {
    return enqueue(async () => {
      const id = safeId(agentId, "agent id");
      if (!agents.has(id)) {
        agents.set(id, {
          agentId: id,
          state: "offline",
          firstSeenAt: nowIso(clock),
          lastSeenAt: nowIso(clock),
        });
        await persistAgents();
      }
      const agentDirectory = path.join(paths.agents, id);
      await fsImpl.mkdir(agentDirectory, { recursive: true, mode: 0o700 });
      await atomicJson(path.join(agentDirectory, "inventory.json"), inventory);
      const record = agents.get(id);
      record.inventoryAt = inventory?.collectedAt || nowIso(clock);
      record.updatedAt = nowIso(clock);
      await atomicJson(path.join(agentDirectory, "latest.json"), record);
      await persistAgents();
      let learnedMac = false;
      for (const networkRecord of Array.isArray(inventory?.network?.interfaces) ? inventory.network.interfaces : []) {
        if (rememberMacUnlocked({
          mac: networkRecord?.address,
          name: record.hostname || record.name,
          agentId: id,
          interface: networkRecord?.ifname || networkRecord?.name || "",
          source: "inventory",
        })) learnedMac = true;
      }
      if (learnedMac) await persistMacAddresses();
      return clone(inventory);
    });
  }

  async function readInventory(agentId) {
    const id = safeId(agentId, "agent id");
    return readJson(fsImpl, path.join(paths.agents, id, "inventory.json"), null);
  }

  function createArtifact(metadata) {
    return enqueue(async () => {
      const record = createArtifactRecord(metadata, { clock, randomBytesImpl });
      if (artifacts.has(record.id)) throw new Error(`Recovery artifact ${record.id} already exists.`);
      artifacts.set(record.id, record);
      await atomicJson(artifactMetadataPath(record.id), record);
      await fsImpl.mkdir(path.dirname(artifactBytesPath(record, { partial: true })), { recursive: true, mode: 0o700 });
      await fsImpl.writeFile(artifactBytesPath(record, { partial: true }), Buffer.alloc(0), {
        flag: "wx",
        mode: 0o600,
      });
      if (record.caseId && cases.has(record.caseId)) {
        await appendCaseEventUnlocked(record.caseId, buildArtifactEvent(record, "artifact.created"));
      }
      return clone(record);
    });
  }

  async function openArtifactWrite(artifactId, { offset, truncate = false } = {}) {
    const id = safeId(artifactId, "artifact id");
    const record = artifacts.get(id);
    if (!record) throw notFound("artifact", id);
    const partialPath = artifactBytesPath(record, { partial: true });
    const stats = await fsImpl.stat(partialPath).catch(() => ({ size: 0 }));
    const expectedOffset = offset === undefined ? stats.size : Number(offset);
    if (!truncate && expectedOffset !== stats.size) {
      const error = new Error(`Artifact offset ${expectedOffset} does not match ${stats.size}.`);
      error.code = RECOVERY_ERROR_CODES.ARTIFACT_OFFSET;
      error.actualOffset = stats.size;
      throw error;
    }
    if (truncate) await fsImpl.truncate(partialPath, 0);
    const start = truncate ? 0 : stats.size;
    const stream = fsSyncImpl.createWriteStream(partialPath, {
      flags: start === 0 && truncate ? "w" : "a",
      mode: 0o600,
    });
    return {
      stream,
      offset: start,
      path: partialPath,
      async currentOffset() {
        return (await fsImpl.stat(partialPath)).size;
      },
    };
  }

  function resolveArtifactPath(artifactId, { partial = false } = {}) {
    const id = safeId(artifactId, "artifact id");
    const record = artifacts.get(id);
    if (!record) throw notFound("artifact", id);
    return artifactBytesPath(record, { partial: partial || !record.complete });
  }

  async function hashFile(filename) {
    const hash = createHash("sha256");
    const stream = fsSyncImpl.createReadStream(filename);
    for await (const chunk of stream) hash.update(chunk);
    return `sha256:${hash.digest("hex")}`;
  }

  function completeArtifact(artifactId, metadata = {}) {
    return enqueue(async () => {
      const id = safeId(artifactId, "artifact id");
      const previous = artifacts.get(id);
      if (!previous) throw notFound("artifact", id);
      const partialPath = artifactBytesPath(previous, { partial: true });
      const finalPath = artifactBytesPath(previous, { partial: false });
      const stats = await fsImpl.stat(partialPath);
      const computedHash = await hashFile(partialPath);
      if (metadata.hash && metadata.hash !== computedHash && metadata.hash !== computedHash.slice(7)) {
        const error = new Error(`Artifact hash mismatch: expected ${metadata.hash}, received ${computedHash}.`);
        error.code = RECOVERY_ERROR_CODES.ARTIFACT_HASH;
        error.actualHash = computedHash;
        throw error;
      }
      await fsImpl.rename(partialPath, finalPath);
      const record = {
        ...previous,
        ...clone(metadata),
        id,
        size: stats.size,
        hash: computedHash,
        complete: true,
        updatedAt: nowIso(clock),
        completedAt: nowIso(clock),
      };
      artifacts.set(id, record);
      await atomicJson(artifactMetadataPath(id), record);
      if (record.caseId && cases.has(record.caseId)) {
        await appendCaseEventUnlocked(record.caseId, buildArtifactEvent(record));
      }
      return clone(record);
    });
  }

  function getArtifact(artifactId) {
    const record = artifacts.get(safeId(artifactId, "artifact id"));
    return record ? clone(record) : null;
  }

  function listArtifacts(caseId = "", jobId = "") {
    const safeCaseId = caseId ? safeId(caseId, "case id") : "";
    const safeJobId = jobId ? safeId(jobId, "job id") : "";
    return [...artifacts.values()]
      .filter((record) => !safeCaseId || record.caseId === safeCaseId)
      .filter((record) => !safeJobId || record.jobId === safeJobId)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map(clone);
  }

  function recoverInterruptedState(reason = "controller-restarted") {
    return enqueue(async () => {
      const recovered = [];
      for (const record of [...jobs.values()]) {
        if (!["leased", "running"].includes(record.state)) continue;
        const next = transitionJobState(record, "interrupted", {
          interruptedAt: nowIso(clock),
          reason,
        }, { clock });
        jobs.set(next.id, next);
        await persistJob(next);
        await appendJobEventUnlocked(next.id, {
          type: "job.interrupted",
          state: "interrupted",
          reason,
        });
        recovered.push(clone(next));
      }
      return recovered;
    });
  }

  function appendControllerEvent(event) {
    return enqueue(async () => {
      const record = createEvent({ ...event, at: nowIso(clock) });
      await appendJsonLine(paths.controllerLog, record);
      queueMicrotask(() => emitter.emit("event", clone(record)));
      return record;
    });
  }

  function onEvent(listener) {
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  }

  async function writeSummary(caseId, markdown) {
    const id = safeId(caseId, "case id");
    if (!cases.has(id)) throw notFound("case", id);
    const filename = path.join(caseDir(id), "summary.md");
    const temporaryPath = `${filename}.${process.pid}.tmp`;
    await fsImpl.writeFile(temporaryPath, String(markdown), { mode: 0o600 });
    await fsImpl.rename(temporaryPath, filename);
    return filename;
  }

  async function writeFacts(caseId, facts) {
    const id = safeId(caseId, "case id");
    if (!cases.has(id)) throw notFound("case", id);
    await atomicJson(path.join(caseDir(id), "facts.json"), facts);
    return clone(facts);
  }

  const api = {
    init,
    close,
    getPaths: () => clone(paths),
    listAgents,
    getAgent,
    upsertAgent,
    markAgentOffline,
    rememberMacAddress,
    listMacAddresses,
    createCase,
    listCases,
    getCase,
    updateCase,
    createJob,
    getJob,
    listJobs,
    updateJob,
    transitionJob,
    appendCaseEvent,
    appendJobEvent,
    readCaseEvents,
    readJobEvents,
    writeInventory,
    readInventory,
    createArtifact,
    getArtifact,
    openArtifactWrite,
    resolveArtifactPath,
    completeArtifact,
    listArtifacts,
    recoverInterruptedState,
    appendControllerEvent,
    onEvent,
    writeSummary,
    writeFacts,
    pathExists: (candidate) => pathExists(fsImpl, candidate),
  };
  return api;
}
