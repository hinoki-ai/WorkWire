import fs from "node:fs/promises";
import path from "node:path";
import { generateRecoveryId, RECOVERY_ERROR_CODES } from "./ww-recovery-protocol.mjs";
import { renameRecoveryFile } from "./ww-recovery-atomic.mjs";

const TERMINAL_JOBS = new Set(["succeeded", "failed", "canceled", "interrupted", "abandoned"]);
const TERMINAL_TARGETS = new Set(["succeeded", "failed", "canceled", "skipped"]);
const ROLLOUT_MODES = new Set(["all-at-once", "bounded", "canary"]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function iso(clock = Date) {
  const value = typeof clock === "function" && !clock.now ? clock() : clock.now();
  return new Date(value).toISOString();
}

function nowMs(clock = Date) {
  return new Date(iso(clock)).getTime();
}

function asId(value, label) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,191}$/.test(id) || id.includes("..")) {
    const error = new Error(`Invalid fleet ${label}.`);
    error.code = RECOVERY_ERROR_CODES.BAD_REQUEST;
    throw error;
  }
  return id;
}

function readPath(value, dottedPath) {
  return String(dottedPath || "").split(".").filter(Boolean).reduce((record, key) => record?.[key], value);
}

function scalar(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return String(value || "").replace(/^(['"])(.*)\1$/, "$2");
}

function compare(actual, operator, expected) {
  if (operator === "=") return actual === expected || String(actual) === String(expected);
  if (operator === "!=") return !(actual === expected || String(actual) === String(expected));
  if (operator === "~=") {
    try { return new RegExp(String(expected), "i").test(String(actual ?? "")); } catch { return false; }
  }
  if (operator === "has") return Array.isArray(actual)
    ? actual.map(String).includes(String(expected))
    : actual && typeof actual === "object"
      ? Object.hasOwn(actual, String(expected))
      : String(actual ?? "").includes(String(expected));
  if (operator === "in") return Array.isArray(expected) && expected.map(String).includes(String(actual));
  if ([">", ">=", "<", "<="].includes(operator)) {
    const left = Number(actual);
    const right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (operator === ">") return left > right;
    if (operator === ">=") return left >= right;
    if (operator === "<") return left < right;
    return left <= right;
  }
  return false;
}

export function compileFleetQuery(input = {}) {
  if (typeof input === "function") return input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const entries = Object.entries(input);
    return (record) => entries.every(([field, expected]) => {
      const actual = readPath(record, field);
      return Array.isArray(expected) ? expected.map(String).includes(String(actual)) : compare(actual, "=", expected);
    });
  }
  const source = String(input || "").trim();
  if (!source || source === "*") return () => true;
  const clauses = source.split(/\s+(and|or)\s+/i);
  const predicates = [];
  const joins = [];
  for (let index = 0; index < clauses.length; index += 2) {
    const clause = clauses[index].trim();
    const match = clause.match(/^([A-Za-z0-9_.-]+)\s*(>=|<=|!=|~=|=|>|<|\bhas\b|\bin\b)\s*(.+)$/i);
    if (!match) throw new TypeError(`Invalid fleet query clause: ${clause}`);
    const [, field, rawOperator, rawExpected] = match;
    const operator = rawOperator.toLowerCase();
    const expected = operator === "in"
      ? rawExpected.replace(/^\[|\]$/g, "").split(",").map((part) => scalar(part.trim()))
      : scalar(rawExpected.trim());
    predicates.push((record) => compare(readPath(record, field), operator, expected));
    if (clauses[index + 1]) joins.push(clauses[index + 1].toLowerCase());
  }
  return (record) => predicates.reduce((result, predicate, index) => (
    index === 0 ? predicate(record) : joins[index - 1] === "or" ? result || predicate(record) : result && predicate(record)
  ), false);
}

export function evaluateFleetPostcondition(condition, context = {}) {
  if (!condition) return { ok: true, skipped: true, reason: "no-postcondition" };
  const conditions = Array.isArray(condition) ? condition : [condition];
  const checks = conditions.map((item) => {
    if (typeof item === "string") {
      const predicate = compileFleetQuery(item);
      return { condition: item, ok: predicate(context) };
    }
    const actual = readPath(context, item?.path || item?.field || "");
    const operator = String(item?.operator || "=");
    const expected = item?.value;
    return { condition: clone(item), actual: clone(actual), ok: compare(actual, operator, expected) };
  });
  return { ok: checks.every((check) => check.ok), checks };
}

function inMaintenanceWindow(window, at = new Date()) {
  if (!window?.start || !window?.end) return true;
  const minutes = at.getHours() * 60 + at.getMinutes();
  const parse = (value) => {
    const [hours, mins] = String(value).split(":").map(Number);
    return hours * 60 + mins;
  };
  const start = parse(window.start);
  const end = parse(window.end);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function operationSteps(operation = {}) {
  if (Array.isArray(operation.steps) && operation.steps.length > 0) return clone(operation.steps);
  const type = String(operation.type || operation.action || "command");
  const params = clone(operation.params || {});
  if (type === "command") return [{ id: "fleet_command", action: "command.exec", params: { argv: clone(operation.argv || params.argv || []) }, timeoutMs: operation.timeoutMs, force: operation.force === true }];
  if (type === "shell") return [{ id: "fleet_shell", action: "shell.exec", params: { script: String(operation.script ?? params.script ?? "") }, timeoutMs: operation.timeoutMs, force: operation.force === true }];
  if (type === "inventory" || type === "health-refresh") return [];
  if (type === "reboot") return [{ id: "fleet_reboot", action: "power.reboot", params, timeoutMs: operation.timeoutMs, force: operation.force === true }];
  if (type === "poweroff" || type === "power") return [{ id: "fleet_power", action: "power.poweroff", params, timeoutMs: operation.timeoutMs, force: operation.force === true }];
  if (type === "playbook") return clone(operation.steps || []);
  if (type === "artifact-put") return [{ id: "fleet_artifact_put", action: "artifact.download", params, timeoutMs: operation.timeoutMs }];
  if (type === "artifact-get") return [{ id: "fleet_artifact_get", action: "artifact.upload", params, timeoutMs: operation.timeoutMs }];
  if (type.includes(".")) return [{ id: "fleet_action", action: type, params, timeoutMs: operation.timeoutMs, force: operation.force === true }];
  return null;
}

export function createRecoveryFleetCommander({
  stateDir,
  store,
  controller,
  clock = Date,
  fsImpl = fs,
  pollMs = 50,
  schedulePollMs = 1_000,
  laneInvoker = null,
  wakeImpl = null,
  machineContextProvider = null,
  healthRecommendationsProvider = null,
  log = () => {},
} = {}) {
  if (!stateDir || !store || !controller) throw new TypeError("Fleet commander requires stateDir, store, and controller.");
  const root = path.join(path.resolve(stateDir), "fleet");
  const statePath = path.join(root, "state.json");
  let state = { version: 1, machines: {}, groups: {}, queries: {}, schedules: {}, healthRules: {}, recommendations: {}, runs: {}, updatedAt: null };
  let mutationTail = Promise.resolve();
  let scheduleTimer = null;
  let closed = false;
  const activeRuns = new Map();

  async function atomicJson(filename, value) {
    await fsImpl.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${process.pid}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await renameRecoveryFile(fsImpl, temporary, filename);
    } finally {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
    }
  }

  function mutate(task) {
    const run = mutationTail.then(task, task);
    mutationTail = run.catch(() => {});
    return run;
  }

  async function persist() {
    state.updatedAt = iso(clock);
    await atomicJson(statePath, state);
  }

  async function init() {
    closed = false;
    await fsImpl.mkdir(root, { recursive: true, mode: 0o700 });
    try {
      const loaded = JSON.parse(await fsImpl.readFile(statePath, "utf8"));
      state = { ...state, ...loaded };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await persist();
    }
    scheduleTimer = setInterval(() => void tick().catch((error) => log(`Fleet scheduler: ${error.message}`)), schedulePollMs);
    scheduleTimer.unref?.();
    const resumable = [];
    for (const record of Object.values(state.runs)) {
      if (record.state === "running") {
        for (const target of Object.values(record.targets || {})) {
          if (!TERMINAL_TARGETS.has(target.state)) target.state = "pending";
        }
        record.resumedAt = iso(clock);
        resumable.push(record.id);
      }
    }
    if (resumable.length > 0) await persist();
    for (const runId of resumable) void continueRun(runId).catch((error) => log(`Fleet run ${runId}: ${error.message}`));
    return api;
  }

  async function resumeAgentRuns(agentId) {
    const id = String(agentId || "");
    let diskState = null;
    try { diskState = JSON.parse(await fsImpl.readFile(statePath, "utf8")); } catch {}
    for (const [runId, diskRun] of Object.entries(diskState?.runs || {})) {
      if (activeRuns.has(runId) || diskRun.state !== "running" || !diskRun.targets?.[id]) continue;
      const local = state.runs[runId];
      if (!local || local.state !== "running" || !local.targets?.[id]?.jobId) state.runs[runId] = diskRun;
    }
    const resumed = [];
    for (const run of Object.values(state.runs)) {
      const target = run.targets?.[id];
      if (run.state !== "running" || !target || TERMINAL_TARGETS.has(target.state) || activeRuns.has(run.id)) continue;
      target.state = "pending";
      run.resumedAt = iso(clock);
      resumed.push(run.id);
    }
    if (resumed.length > 0) await mutate(persist);
    for (const runId of resumed) void continueRun(runId).catch((error) => log(`Fleet run ${runId}: ${error.message}`));
    return resumed;
  }

  async function close() {
    closed = true;
    clearInterval(scheduleTimer);
    scheduleTimer = null;
    await Promise.allSettled([...activeRuns.values()]);
    await mutationTail.catch(() => {});
    await persist();
  }

  function enrichAgent(agent) {
    const metadata = state.machines[agent.agentId] || {};
    return {
      ...clone(agent),
      alias: metadata.alias || "",
      labels: clone(metadata.labels || {}),
      operatorGroups: Object.values(state.groups).filter((group) => (group.targetIds || []).includes(agent.agentId)).map((group) => group.id),
      continuity: clone(machineContextProvider?.(agent.agentId) || null),
    };
  }

  function listMachines(query = "") {
    const records = store.listAgents().map(enrichAgent);
    const predicate = compileFleetQuery(query);
    return records.filter(predicate);
  }

  async function setMachineMetadata(agentId, patch = {}) {
    const id = asId(agentId, "agent id");
    return mutate(async () => {
      const previous = state.machines[id] || { agentId: id, labels: {} };
      const record = {
        ...previous,
        ...clone(patch),
        agentId: id,
        labels: { ...previous.labels, ...(patch.labels || {}) },
        updatedAt: iso(clock),
      };
      state.machines[id] = record;
      await persist();
      return clone(record);
    });
  }

  async function saveGroup(input = {}) {
    const id = asId(input.id || generateRecoveryId("wwg", { clock }), "group id");
    return mutate(async () => {
      const record = {
        id,
        name: String(input.name || id),
        targetIds: [...new Set((input.targetIds || []).map((value) => asId(value, "agent id")))],
        query: input.query ? clone(input.query) : "",
        createdAt: state.groups[id]?.createdAt || iso(clock),
        updatedAt: iso(clock),
      };
      state.groups[id] = record;
      await persist();
      return clone(record);
    });
  }

  async function deleteGroup(groupId) {
    const id = asId(groupId, "group id");
    return mutate(async () => {
      const existed = Boolean(state.groups[id]);
      delete state.groups[id];
      await persist();
      return existed;
    });
  }

  async function saveQuery(input = {}) {
    const id = asId(input.id || generateRecoveryId("wwq", { clock }), "query id");
    compileFleetQuery(input.expression || input.query || "*");
    return mutate(async () => {
      const record = {
        id,
        name: String(input.name || id),
        expression: clone(input.expression || input.query || "*"),
        createdAt: state.queries[id]?.createdAt || iso(clock),
        updatedAt: iso(clock),
      };
      state.queries[id] = record;
      await persist();
      return clone(record);
    });
  }

  function resolveTargets(selection = {}) {
    const requested = new Set((selection.targetIds || selection.targets || []).map(String));
    if (selection.groupId) {
      const group = state.groups[asId(selection.groupId, "group id")];
      if (!group) throw Object.assign(new Error(`Fleet group ${selection.groupId} was not found.`), { code: RECOVERY_ERROR_CODES.NOT_FOUND });
      for (const id of group.targetIds || []) requested.add(id);
      if (group.query) for (const agent of listMachines(group.query)) requested.add(agent.agentId);
    }
    let expression = selection.query || "";
    if (selection.queryId) {
      const saved = state.queries[asId(selection.queryId, "query id")];
      if (!saved) throw Object.assign(new Error(`Fleet query ${selection.queryId} was not found.`), { code: RECOVERY_ERROR_CODES.NOT_FOUND });
      expression = saved.expression;
    }
    if (expression) for (const agent of listMachines(expression)) requested.add(agent.agentId);
    if (requested.size === 0 && selection.all === true) for (const agent of listMachines("*")) requested.add(agent.agentId);
    const agents = new Map(store.listAgents().map((agent) => [agent.agentId, enrichAgent(agent)]));
    return [...requested].map((id) => agents.get(id) || { agentId: id, state: "unknown", connected: false, labels: {}, alias: "" });
  }

  async function waitForJob(jobId, { reconcileInterrupted = false } = {}) {
    while (!closed) {
      const job = store.getJob(jobId);
      if (!job) throw Object.assign(new Error(`Fleet job ${jobId} disappeared.`), { code: RECOVERY_ERROR_CODES.NOT_FOUND });
      if (TERMINAL_JOBS.has(job.state) && !(reconcileInterrupted && job.state === "interrupted")) {
        return { job, events: await store.readJobEvents(jobId) };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    const error = new Error("Fleet execution paused for controller restart.");
    error.code = "ERR_WW_FLEET_CONTROLLER_RESTART";
    throw error;
  }

  async function executeTarget(run, target) {
    const resuming = Boolean(target.jobId);
    target.state = "running";
    target.startedAt = target.startedAt || iso(clock);
    if (resuming) target.resumeCount = (Number(target.resumeCount) || 0) + 1;
    else target.attempt = (Number(target.attempt) || 0) + 1;
    await mutate(persist);
    const operation = run.operation;
    try {
      if (["inventory", "health-refresh"].includes(operation.type)) {
        const inventory = await controller.requestInventory(target.agentId, { wait: true, timeoutMs: operation.timeoutMs || 120_000, lightweight: operation.lightweight === true });
        target.result = { inventoryCollectedAt: inventory?.collectedAt, errors: inventory?.errors || [] };
        target.postcondition = evaluateFleetPostcondition(operation.postcondition, { inventory, result: target.result, target });
        target.state = target.postcondition.ok ? "succeeded" : "failed";
      } else if (operation.type === "wol") {
        if (!wakeImpl) throw new Error("Fleet Wake-on-LAN adapter is unavailable.");
        target.result = await wakeImpl({ ...clone(operation.params || {}), agentId: target.agentId });
        target.postcondition = evaluateFleetPostcondition(operation.postcondition, { result: target.result, target });
        target.state = target.postcondition.ok ? "succeeded" : "failed";
      } else if (["image-deploy", "vault-snapshot", "salvage-plan", "sync"].includes(operation.type)) {
        if (!laneInvoker) throw Object.assign(new Error(`Optional lane action ${operation.type} is unavailable.`), { code: "ERR_WW_NEXT_STAGE_UNAVAILABLE" });
        target.result = await laneInvoker(operation.type, { target: clone(target), operation: clone(operation), run: clone(run) });
        target.postcondition = evaluateFleetPostcondition(operation.postcondition, { result: target.result, target });
        target.state = target.postcondition.ok ? "succeeded" : "failed";
      } else {
        const steps = operationSteps(operation);
        if (!steps || steps.length === 0) throw new TypeError(`Fleet operation ${operation.type || "<missing>"} has no executable steps.`);
        let caseRecord = target.caseId ? store.getCase(target.caseId) : null;
        if (!caseRecord) {
          caseRecord = await store.createCase({
            targetAgentId: target.agentId,
            goal: operation.goal || run.name || `Fleet ${operation.type || "operation"}`,
            mode: operation.mode || "unrestricted",
            createdBy: "fleet-commander",
            metadata: { fleetRunId: run.id, scheduleId: run.scheduleId || "" },
          });
          target.caseId = caseRecord.id;
        }
        let job = target.jobId ? store.getJob(target.jobId) : null;
        if (!job) {
          job = await store.createJob(caseRecord.id, {
            targetAgentId: target.agentId,
            goal: operation.goal || caseRecord.goal,
            mode: operation.mode || "unrestricted",
            force: operation.force === true,
            createdBy: "fleet-commander",
            metadata: { fleetRunId: run.id, fleetTargetId: target.agentId },
            steps,
          });
          target.jobId = job.id;
        }
        if (!TERMINAL_JOBS.has(job.state)) await controller.dispatchNext(target.agentId);
        const completed = await waitForJob(job.id, { reconcileInterrupted: job.state === "interrupted" });
        target.events = completed.events;
        target.result = completed.job.result || { state: completed.job.state };
        target.jobState = completed.job.state;
        target.postcondition = evaluateFleetPostcondition(operation.postcondition, { job: completed.job, result: target.result, events: completed.events, target });
        target.state = completed.job.state === "succeeded" && target.postcondition.ok ? "succeeded" : "failed";
      }
    } catch (error) {
      if (error.code === "ERR_WW_FLEET_CONTROLLER_RESTART") return target;
      target.state = "failed";
      target.error = { code: error.code || "ERR_WW_FLEET_TARGET", message: error.message };
    }
    target.endedAt = iso(clock);
    await mutate(persist);
    return target;
  }

  function stopTriggered(run) {
    const targets = Object.values(run.targets || {});
    const failures = targets.filter((target) => target.state === "failed").length;
    const stop = run.rollout.stop || {};
    if (Number.isFinite(Number(stop.maxFailures)) && failures >= Number(stop.maxFailures)) return `max-failures:${stop.maxFailures}`;
    if (stop.onAnyFailure === true && failures > 0) return "target-failure";
    return "";
  }

  async function runBatch(run, ids, concurrency) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), ids.length) }, async () => {
      while (cursor < ids.length && !run.stopReason) {
        const targetId = ids[cursor++];
        const target = run.targets[targetId];
        if (!target || TERMINAL_TARGETS.has(target.state)) continue;
        await executeTarget(run, target);
        run.stopReason = stopTriggered(run);
      }
    });
    await Promise.all(workers);
  }

  async function continueRun(runId) {
    const id = asId(runId, "run id");
    if (activeRuns.has(id)) return activeRuns.get(id);
    const run = state.runs[id];
    if (!run) throw Object.assign(new Error(`Fleet run ${id} was not found.`), { code: RECOVERY_ERROR_CODES.NOT_FOUND });
    const promise = (async () => {
      run.state = "running";
      run.startedAt = run.startedAt || iso(clock);
      await mutate(persist);
      const pending = Object.values(run.targets).filter((target) => !TERMINAL_TARGETS.has(target.state)).map((target) => target.agentId);
      if (run.rollout.mode === "canary" && pending.length > 0 && !run.canaryCompleted) {
        const count = Math.max(1, Math.min(pending.length, Number(run.rollout.canaryCount) || 1));
        const canaries = pending.slice(0, count);
        await runBatch(run, canaries, Math.min(count, Number(run.rollout.concurrency) || 1));
        run.canaryCompleted = true;
        if (canaries.some((targetId) => run.targets[targetId].state !== "succeeded")) run.stopReason = run.stopReason || "canary-failed";
      }
      if (!run.stopReason) {
        const remaining = Object.values(run.targets).filter((target) => !TERMINAL_TARGETS.has(target.state)).map((target) => target.agentId);
        const concurrency = run.rollout.mode === "all-at-once" ? Math.max(1, remaining.length) : Math.max(1, Number(run.rollout.concurrency) || 1);
        await runBatch(run, remaining, concurrency);
      }
      if (closed) return clone(run);
      for (const target of Object.values(run.targets)) {
        if (!TERMINAL_TARGETS.has(target.state)) {
          target.state = "skipped";
          target.error = { code: "ERR_WW_FLEET_STOP_CONDITION", message: run.stopReason || "Fleet rollout stopped." };
          target.endedAt = iso(clock);
        }
      }
      const values = Object.values(run.targets);
      run.state = values.every((target) => target.state === "succeeded") ? "succeeded" : values.some((target) => target.state === "succeeded") ? "partial" : "failed";
      run.endedAt = iso(clock);
      await mutate(persist);
      return clone(run);
    })().finally(() => activeRuns.delete(id));
    activeRuns.set(id, promise);
    return promise;
  }

  async function execute(input = {}) {
    const targets = resolveTargets(input);
    if (targets.length === 0) throw new TypeError("Fleet execution resolved no targets.");
    const mode = String(input.rollout?.mode || input.mode || "bounded");
    if (!ROLLOUT_MODES.has(mode)) throw new TypeError(`Unsupported fleet rollout mode ${mode}.`);
    const id = asId(input.id || generateRecoveryId("wwfr", { clock }), "run id");
    const run = {
      id,
      name: String(input.name || input.operation?.goal || `Fleet ${input.operation?.type || "operation"}`),
      state: "queued",
      createdAt: iso(clock),
      updatedAt: iso(clock),
      scheduleId: String(input.scheduleId || ""),
      selection: clone({ targetIds: input.targetIds, groupId: input.groupId, queryId: input.queryId, query: input.query, all: input.all }),
      operation: clone(input.operation || {}),
      rollout: {
        mode,
        concurrency: Math.max(1, Number(input.rollout?.concurrency ?? input.concurrency) || 1),
        canaryCount: Math.max(1, Number(input.rollout?.canaryCount ?? input.canaryCount) || 1),
        stop: clone(input.rollout?.stop || input.stop || {}),
      },
      stopReason: "",
      targets: Object.fromEntries(targets.map((target) => [target.agentId, {
        agentId: target.agentId,
        hostname: target.hostname || "",
        alias: target.alias || "",
        state: "pending",
        attempt: 0,
        events: [],
      }])),
    };
    await mutate(async () => {
      if (state.runs[id]) throw new Error(`Fleet run ${id} already exists.`);
      state.runs[id] = run;
      await persist();
    });
    const completion = continueRun(id);
    return input.wait === true ? completion : { ...clone(run), completion };
  }

  function getRun(runId) {
    const run = state.runs[asId(runId, "run id")];
    return run ? clone(run) : null;
  }

  function listRuns(filters = {}) {
    return Object.values(state.runs).filter((run) => !filters.state || run.state === filters.state).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).map(clone);
  }

  async function retryFailed(runId, options = {}) {
    const previous = getRun(runId);
    if (!previous) throw Object.assign(new Error(`Fleet run ${runId} was not found.`), { code: RECOVERY_ERROR_CODES.NOT_FOUND });
    const targetIds = Object.values(previous.targets).filter((target) => target.state === "failed" || target.state === "skipped").map((target) => target.agentId);
    if (targetIds.length === 0) throw new Error(`Fleet run ${runId} has no failed targets.`);
    return execute({
      name: `${previous.name} retry`,
      targetIds,
      operation: previous.operation,
      rollout: { ...previous.rollout, ...(options.rollout || {}) },
      wait: options.wait === true,
    });
  }

  function summarize(runId) {
    const run = getRun(runId);
    if (!run) throw Object.assign(new Error(`Fleet run ${runId} was not found.`), { code: RECOVERY_ERROR_CODES.NOT_FOUND });
    const targets = Object.values(run.targets).map((target) => ({
      agentId: target.agentId,
      hostname: target.hostname,
      state: target.state,
      attempt: target.attempt,
      jobId: target.jobId || "",
      startedAt: target.startedAt || null,
      endedAt: target.endedAt || null,
      error: target.error || null,
      result: target.result || null,
      postcondition: target.postcondition || null,
      stdout: (target.events || []).filter((event) => event.type === "step.output" && event.stream === "stdout"),
      stderr: (target.events || []).filter((event) => event.type === "step.output" && event.stream === "stderr"),
    }));
    return {
      id: run.id,
      state: run.state,
      stopReason: run.stopReason,
      counts: Object.fromEntries(["pending", "running", "succeeded", "failed", "canceled", "skipped"].map((name) => [name, targets.filter((target) => target.state === name).length])),
      targets,
    };
  }

  async function saveSchedule(input = {}) {
    const id = asId(input.id || generateRecoveryId("wwfs", { clock }), "schedule id");
    const everyMs = Number(input.everyMs || input.timing?.everyMs || 0);
    const at = input.at || input.timing?.at || "";
    if (!(everyMs > 0) && !at) throw new TypeError("Fleet schedule requires at or everyMs.");
    return mutate(async () => {
      const previous = state.schedules[id];
      const createdAt = previous?.createdAt || iso(clock);
      const nextRunAt = at ? new Date(at).toISOString() : new Date(nowMs(clock) + everyMs).toISOString();
      const record = {
        id,
        name: String(input.name || id),
        enabled: input.enabled !== false,
        selection: clone(input.selection || { targetIds: input.targetIds, groupId: input.groupId, queryId: input.queryId, query: input.query, all: input.all }),
        operation: clone(input.operation || {}),
        rollout: clone(input.rollout || {}),
        timing: { at: at ? new Date(at).toISOString() : "", everyMs: everyMs > 0 ? everyMs : 0 },
        missed: ["skip", "run-once", "catch-up"].includes(input.missed) ? input.missed : "run-once",
        maintenance: clone(input.maintenance || null),
        offlineQueue: input.offlineQueue !== false,
        createdAt,
        updatedAt: iso(clock),
        nextRunAt: previous && input.preserveNextRun === true ? previous.nextRunAt : nextRunAt,
        lastRunAt: previous?.lastRunAt || null,
        lastRunId: previous?.lastRunId || "",
      };
      state.schedules[id] = record;
      await persist();
      return clone(record);
    });
  }

  async function deleteSchedule(scheduleId) {
    const id = asId(scheduleId, "schedule id");
    return mutate(async () => {
      const existed = Boolean(state.schedules[id]);
      delete state.schedules[id];
      await persist();
      return existed;
    });
  }

  async function saveHealthRule(input = {}) {
    const id = asId(input.id || generateRecoveryId("wwhr", { clock }), "health rule id");
    const mode = String(input.mode || "recommend");
    if (!["observe", "recommend", "execute"].includes(mode)) throw new TypeError(`Unsupported health rule mode ${mode}.`);
    if (!String(input.recommendation || input.operationMatch || "").trim()) throw new TypeError("Health rule requires a recommendation operation to match.");
    if (mode === "execute" && !input.executionOperation) throw new TypeError("Executing health rules require an explicit executionOperation.");
    return mutate(async () => {
      const previous = state.healthRules[id];
      const record = {
        id,
        name: String(input.name || id),
        enabled: input.enabled !== false,
        mode,
        recommendation: String(input.recommendation || input.operationMatch),
        minimumSeverity: String(input.minimumSeverity || "low"),
        selection: clone(input.selection || { targetIds: input.targetIds, groupId: input.groupId, queryId: input.queryId, query: input.query, all: input.all }),
        executionOperation: clone(input.executionOperation || null),
        rollout: clone(input.rollout || { mode: "bounded", concurrency: 1 }),
        createdAt: previous?.createdAt || iso(clock),
        updatedAt: iso(clock),
      };
      state.healthRules[id] = record;
      await persist();
      return clone(record);
    });
  }

  async function deleteHealthRule(ruleId) {
    const id = asId(ruleId, "health rule id");
    return mutate(async () => {
      const existed = Boolean(state.healthRules[id]);
      delete state.healthRules[id];
      await persist();
      return existed;
    });
  }

  async function evaluateHealthRules() {
    if (typeof healthRecommendationsProvider !== "function") return;
    const severityRank = { low: 0, medium: 1, high: 2, critical: 3 };
    for (const rule of Object.values(state.healthRules)) {
      if (!rule.enabled) continue;
      for (const target of resolveTargets(rule.selection)) {
        const matches = (healthRecommendationsProvider(target.agentId) || []).filter((recommendation) => (
          recommendation.operation === rule.recommendation
          && (severityRank[recommendation.severity] ?? 0) >= (severityRank[rule.minimumSeverity] ?? 0)
        ));
        for (const recommendation of matches) {
          const key = `${rule.id}:${target.agentId}:${recommendation.id}`;
          const previous = state.recommendations[key];
          if (previous?.fleetRunId || previous?.state === "observed") continue;
          const record = state.recommendations[key] = {
            id: key,
            ruleId: rule.id,
            agentId: target.agentId,
            recommendation: clone(recommendation),
            disposition: rule.mode,
            state: rule.mode === "execute" ? "queued" : "observed",
            observedAt: iso(clock),
          };
          if (rule.mode === "execute") {
            try {
              const run = await execute({
                targetIds: [target.agentId],
                name: `${rule.name}: ${recommendation.operation}`,
                operation: rule.executionOperation,
                rollout: rule.rollout,
                wait: false,
              });
              record.fleetRunId = run.id;
              record.state = "submitted";
            } catch (error) {
              record.state = "failed";
              record.error = { code: error.code || "ERR_WW_HEALTH_RULE", message: error.message };
            }
          }
          await mutate(persist);
        }
      }
    }
  }

  async function reconcileRuns() {
    let changed = false;
    for (const run of Object.values(state.runs).filter((record) => record.state === "running")) {
      for (const target of Object.values(run.targets || {})) {
        if (!target.jobId || TERMINAL_TARGETS.has(target.state)) continue;
        const job = store.getJob(target.jobId);
        if (!job || job.state === "interrupted" || !TERMINAL_JOBS.has(job.state)) continue;
        const events = await store.readJobEvents(job.id);
        target.events = events;
        target.result = job.result || { state: job.state };
        target.jobState = job.state;
        target.postcondition = evaluateFleetPostcondition(run.operation?.postcondition, { job, result: target.result, events, target });
        target.state = job.state === "succeeded" && target.postcondition.ok ? "succeeded" : "failed";
        target.endedAt = target.endedAt || iso(clock);
        changed = true;
      }
      const targets = Object.values(run.targets || {});
      if (targets.length > 0 && targets.every((target) => TERMINAL_TARGETS.has(target.state))) {
        run.state = targets.every((target) => target.state === "succeeded") ? "succeeded" : targets.some((target) => target.state === "succeeded") ? "partial" : "failed";
        run.endedAt = run.endedAt || iso(clock);
        changed = true;
      }
    }
    if (changed) await mutate(persist);
  }

  async function tick() {
    await reconcileRuns();
    await evaluateHealthRules();
    const now = nowMs(clock);
    for (const schedule of Object.values(state.schedules)) {
      if (!schedule.enabled || !schedule.nextRunAt || new Date(schedule.nextRunAt).getTime() > now) continue;
      const dueAt = new Date(schedule.nextRunAt).getTime();
      if (!inMaintenanceWindow(schedule.maintenance, new Date(now))) continue;
      const interval = Number(schedule.timing.everyMs) || 0;
      let occurrences = 1;
      if (interval > 0 && schedule.missed === "catch-up") occurrences = Math.min(10, Math.max(1, Math.floor((now - dueAt) / interval) + 1));
      if (schedule.missed === "skip" && interval > 0 && now - dueAt >= interval) occurrences = 0;
      for (let index = 0; index < occurrences; index += 1) {
        const run = await execute({
          ...clone(schedule.selection),
          scheduleId: schedule.id,
          name: schedule.name,
          operation: schedule.operation,
          rollout: schedule.rollout,
          wait: false,
        });
        schedule.lastRunId = run.id;
      }
      schedule.lastRunAt = iso(clock);
      if (interval > 0) {
        const steps = Math.max(1, Math.floor((now - dueAt) / interval) + 1);
        schedule.nextRunAt = new Date(dueAt + steps * interval).toISOString();
      } else {
        schedule.enabled = false;
        schedule.nextRunAt = null;
      }
      await mutate(persist);
    }
  }

  const api = {
    init,
    close,
    getState: () => clone(state),
    listMachines,
    setMachineMetadata,
    listGroups: () => Object.values(state.groups).map(clone),
    saveGroup,
    deleteGroup,
    listQueries: () => Object.values(state.queries).map(clone),
    saveQuery,
    resolveTargets,
    execute,
    continueRun,
    getRun,
    listRuns,
    retryFailed,
    summarize,
    listSchedules: () => Object.values(state.schedules).map(clone),
    saveSchedule,
    deleteSchedule,
    listHealthRules: () => Object.values(state.healthRules).map(clone),
    saveHealthRule,
    deleteHealthRule,
    listRecommendations: () => Object.values(state.recommendations).map(clone),
    evaluateHealthRules,
    reconcileRuns,
    resumeAgentRuns,
    tick,
  };
  return api;
}

export { inMaintenanceWindow, operationSteps };
