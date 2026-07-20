import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRecoveryError, generateRecoveryId, RECOVERY_ERROR_CODES } from "./ww-recovery-protocol.mjs";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
function readPath(value, dottedPath) {
  return String(dottedPath || "").split(".").filter(Boolean).reduce((record, key) => record?.[key], value);
}

function compare(actual, operator, expected) {
  if (operator === "equals" || operator === "=") return actual === expected || String(actual) === String(expected);
  if (operator === "not-equals" || operator === "!=") return !(actual === expected || String(actual) === String(expected));
  if (operator === "exists") return actual !== undefined && actual !== null;
  if (operator === "absent") return actual === undefined || actual === null;
  if (operator === "contains") return Array.isArray(actual) ? actual.some((item) => String(item) === String(expected)) : String(actual ?? "").includes(String(expected));
  if (operator === "matches") {
    try { return new RegExp(String(expected), "m").test(String(actual ?? "")); } catch { return false; }
  }
  if (operator === "greater-than") return Number(actual) > Number(expected);
  if (operator === "less-than") return Number(actual) < Number(expected);
  return false;
}

export function createAutonomousPlanGraph(input = {}) {
  const at = input.createdAt || new Date().toISOString();
  return {
    version: 1,
    id: String(input.id || generateRecoveryId("wwpg")),
    caseId: String(input.caseId || ""),
    goal: String(input.goal || ""),
    state: String(input.state || "active"),
    createdAt: at,
    updatedAt: input.updatedAt || at,
    nodes: Array.isArray(input.nodes) ? clone(input.nodes) : [],
    edges: Array.isArray(input.edges) ? clone(input.edges) : [],
    currentHypothesisId: String(input.currentHypothesisId || ""),
    nextActionId: String(input.nextActionId || ""),
    finalProofIds: Array.isArray(input.finalProofIds) ? [...input.finalProofIds] : [],
  };
}

export function addPlanNode(graph, node = {}) {
  const type = String(node.type || "fact");
  const id = String(node.id || generateRecoveryId(type.slice(0, 8) || "node"));
  const record = {
    id,
    type,
    state: String(node.state || (type === "action" ? "planned" : "observed")),
    label: String(node.label || node.summary || node.action || id),
    createdAt: node.createdAt || new Date().toISOString(),
    ...clone(node),
    id,
    type,
  };
  const index = graph.nodes.findIndex((candidate) => candidate.id === id);
  if (index === -1) graph.nodes.push(record);
  else graph.nodes[index] = { ...graph.nodes[index], ...record };
  graph.updatedAt = new Date().toISOString();
  if (type === "hypothesis" && ["current", "active"].includes(record.state)) graph.currentHypothesisId = id;
  if (type === "action" && ["planned", "ready", "running"].includes(record.state)) graph.nextActionId = id;
  if (type === "proof" && record.verified === true && !graph.finalProofIds.includes(id)) graph.finalProofIds.push(id);
  return record;
}

export function addPlanEdge(graph, edge = {}) {
  const record = {
    id: String(edge.id || generateRecoveryId("edge")),
    from: String(edge.from || ""),
    to: String(edge.to || ""),
    type: String(edge.type || "depends-on"),
    condition: edge.condition === undefined ? null : clone(edge.condition),
    createdAt: edge.createdAt || new Date().toISOString(),
  };
  graph.edges.push(record);
  graph.updatedAt = new Date().toISOString();
  return record;
}

function outputText(events = [], stream = "") {
  return events.filter((event) => event.type === "step.output" && (!stream || event.stream === stream)).map((event) => {
    if (event.encoding === "base64") return Buffer.from(String(event.data || ""), "base64").toString("utf8");
    return String(event.data || "");
  }).join("");
}

export function verifyRecoveryPostconditions(postconditions = [], context = {}) {
  const checks = (Array.isArray(postconditions) ? postconditions : [postconditions]).filter(Boolean).map((condition) => {
    const type = String(condition.type || "path");
    if (type === "job-state") {
      const actual = context.job?.state;
      return { condition: clone(condition), actual, ok: compare(actual, condition.operator || "equals", condition.value || "succeeded") };
    }
    if (type === "exit-code") {
      const steps = context.job?.result?.steps || [];
      const actual = readPath(steps.at(-1), "result.exitCode") ?? readPath(steps.at(-1), "exitCode") ?? context.job?.result?.exitCode;
      return { condition: clone(condition), actual, ok: compare(actual, condition.operator || "equals", condition.value ?? 0), weak: true };
    }
    if (type === "stdout" || type === "stderr" || type === "output") {
      const actual = outputText(context.events || [], type === "output" ? "" : type);
      return { condition: clone(condition), actual, ok: compare(actual, condition.operator || "contains", condition.value) };
    }
    if (type === "inventory") {
      const actual = readPath(context.inventory, condition.path);
      return { condition: clone(condition), actual: clone(actual), ok: compare(actual, condition.operator || "equals", condition.value) };
    }
    if (type === "device-identity") {
      const devices = context.inventory?.block?.devices || [];
      const actual = devices.find((device) => device.deviceId === condition.deviceId);
      const ok = Boolean(actual) && (!condition.path || [actual.path, actual.canonicalPath, ...(actual.byId || [])].includes(condition.path));
      return { condition: clone(condition), actual: clone(actual), ok };
    }
    if (type === "hash") {
      const actual = readPath(context, condition.path || "result.hash");
      return { condition: clone(condition), actual, ok: String(actual || "") === String(condition.value || "") };
    }
    const actual = readPath(context, condition.path || "");
    return { condition: clone(condition), actual: clone(actual), ok: compare(actual, condition.operator || "equals", condition.value) };
  });
  const strong = checks.filter((check) => check.ok && check.weak !== true);
  return {
    ok: checks.length > 0 && checks.every((check) => check.ok) && strong.length > 0,
    checks,
    strongProofCount: strong.length,
    zeroExitOnly: checks.length > 0 && checks.every((check) => check.weak === true),
  };
}

export function verificationClaimsAreMachineProof(claims = []) {
  const values = (Array.isArray(claims) ? claims : [claims]).map((value) => typeof value === "string" ? value : JSON.stringify(value));
  const strongPattern = /stdout|stderr|contain|match|hash|inventory|device|mount|service|listen|reachable|exists|absent|boot|filesystem|byte|marker|checksum|health|postcondition/i;
  return values.some((value) => strongPattern.test(value)) && !values.every((value) => /^(?:remote\s+)?exit(?:\s+code)?\s*0$/i.test(value.trim()));
}

export function detectIdentityChange(before = {}, after = {}) {
  const key = (device) => String(device.deviceId || "");
  const beforeDevices = new Map((before?.block?.devices || []).filter((device) => key(device)).map((device) => [key(device), device]));
  const afterDevices = new Map((after?.block?.devices || []).filter((device) => key(device)).map((device) => [key(device), device]));
  const missing = [...beforeDevices.keys()].filter((id) => !afterDevices.has(id));
  const added = [...afterDevices.keys()].filter((id) => !beforeDevices.has(id));
  const changedPaths = [...beforeDevices.keys()].filter((id) => afterDevices.has(id)).filter((id) => {
    const left = beforeDevices.get(id);
    const right = afterDevices.get(id);
    return String(left.canonicalPath || left.path) !== String(right.canonicalPath || right.path);
  }).map((id) => ({ deviceId: id, before: beforeDevices.get(id).canonicalPath || beforeDevices.get(id).path, after: afterDevices.get(id).canonicalPath || afterDevices.get(id).path }));
  return { changed: missing.length > 0 || added.length > 0 || changedPaths.length > 0, missing, added, changedPaths };
}

async function readJsonLines(stream, onMessage) {
  let pending = "";
  for await (const chunk of stream) {
    pending += chunk.toString("utf8");
    let index;
    while ((index = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      if (line) onMessage(JSON.parse(line));
    }
  }
  if (pending.trim()) onMessage(JSON.parse(pending));
}

export function createCodexCliPlanner({
  command = ["codex", "exec", "--json", "--full-auto", "-"],
  spawnImpl = spawn,
  cwd,
  env = process.env,
  prompt = "Return exactly one WorkWire planner JSON object and no prose.",
} = {}) {
  const context = [];
  let stopped = false;
  return {
    type: "codex-cli",
    async start() { return this; },
    async send(message) { context.push(clone(message)); },
    async next({ signal } = {}) {
      if (stopped) throw createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_EXIT, "Codex planner stopped.");
      const child = spawnImpl(command[0], command.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      const abort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.end(`${prompt}\n\nContext JSON:\n${JSON.stringify(context)}\n`);
      let finalText = "";
      const stderr = [];
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      const records = [];
      await Promise.all([
        readJsonLines(child.stdout, (record) => records.push(record)).catch(() => {}),
        new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => code === 0 ? resolve() : reject(createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_EXIT, `Codex CLI exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`)));
        }),
      ]).finally(() => signal?.removeEventListener("abort", abort));
      for (const record of records) {
        const candidate = record.result || record.message?.content || record.content || record.text || "";
        if (typeof candidate === "string") finalText = candidate;
      }
      const match = finalText.match(/\{[\s\S]*\}/);
      if (!match) throw createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_PROTOCOL, "Codex CLI did not return a planner JSON object.");
      const result = JSON.parse(match[0]);
      context.push({ type: "planner.adapter.output", value: clone(result) });
      return result;
    },
    async stop() { stopped = true; },
    getContext: () => clone(context),
  };
}

export function createLocalModelPlanner({
  url,
  command = null,
  model = "local",
  fetchImpl = fetch,
  spawnImpl = spawn,
  headers = {},
} = {}) {
  if (!url && (!Array.isArray(command) || command.length === 0)) throw new TypeError("Local model planner requires url or command argv.");
  const messages = [];
  let stopped = false;
  return {
    type: url ? "local-model-http" : "local-model-command",
    async start() { return this; },
    async send(message) { messages.push(clone(message)); },
    async next({ signal } = {}) {
      if (stopped) throw createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_EXIT, "Local model planner stopped.");
      if (url) {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ model, stream: false, messages: [{ role: "system", content: "Return one WorkWire planner JSON object." }, { role: "user", content: JSON.stringify(messages) }] }),
          signal,
        });
        if (!response.ok) throw createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_EXIT, `Local model HTTP ${response.status}.`);
        const payload = await response.json();
        const value = payload.type ? payload : JSON.parse(payload.message?.content || payload.choices?.[0]?.message?.content || payload.response || "{}");
        messages.push({ type: "planner.adapter.output", value: clone(value) });
        return value;
      }
      const child = spawnImpl(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end(`${JSON.stringify({ messages })}\n`);
      const records = [];
      await readJsonLines(child.stdout, (record) => records.push(record));
      const value = records.at(-1);
      if (!value) throw createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_PROTOCOL, "Local model command produced no JSON.");
      messages.push({ type: "planner.adapter.output", value: clone(value) });
      return value;
    },
    async stop() { stopped = true; },
    getContext: () => clone(messages),
  };
}

export async function exportRecoveryProcedure({
  caseRecord,
  actions = [],
  prerequisites = [],
  proofs = [],
  destination,
  fsImpl = fs,
} = {}) {
  if (!caseRecord?.id) throw new TypeError("Procedure export requires a case record.");
  const procedure = {
    version: 1,
    id: `procedure_${caseRecord.id}`,
    sourceCaseId: caseRecord.id,
    title: String(caseRecord.goal || `Recovery procedure ${caseRecord.id}`),
    parameters: clone(caseRecord.metadata?.parameters || {}),
    prerequisites: clone(prerequisites),
    steps: actions.map((record, index) => ({
      id: String(record.request?.requestId || `step_${index + 1}`),
      action: record.request?.action || record.action,
      params: clone(record.request?.params || {}),
      force: record.request?.force === true,
      postconditions: clone(record.request?.postconditions || []),
    })),
    proofs: clone(proofs),
    createdAt: new Date().toISOString(),
  };
  procedure.hash = `sha256:${createHash("sha256").update(JSON.stringify(procedure)).digest("hex")}`;
  if (destination) {
    await fsImpl.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fsImpl.writeFile(destination, `${JSON.stringify(procedure, null, 2)}\n`, { mode: 0o600 });
  }
  return procedure;
}

function substitute(value, parameters) {
  if (typeof value === "string") return value.replace(/\$\{(?:input|parameter)\.([A-Za-z0-9_.-]+)\}/g, (_match, key) => String(readPath(parameters, key) ?? ""));
  if (Array.isArray(value)) return value.map((item) => substitute(item, parameters));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, parameters)]));
  return value;
}

export async function replayRecoveryProcedure(procedure, { parameters = {}, executor, verify } = {}) {
  if (!executor) throw new TypeError("Procedure replay requires executor(action, params, context).");
  const results = [];
  for (const step of procedure.steps || []) {
    const params = substitute(step.params || {}, parameters);
    const result = await executor(step.action, params, { step, sourceCaseId: procedure.sourceCaseId, force: step.force === true });
    const proof = verify ? await verify(step.postconditions || [], { step, params, result }) : { ok: result?.ok !== false, skipped: true };
    results.push({ stepId: step.id, action: step.action, params, result, proof });
    if (result?.ok === false || proof.ok === false) break;
  }
  return { ok: results.length === (procedure.steps || []).length && results.every((record) => record.result?.ok !== false && record.proof?.ok !== false), sourceCaseId: procedure.sourceCaseId, results };
}

export async function runShadowRecoveryPlan({
  plan,
  shadowExecutor,
  physicalExecutor,
  verify,
  bypass = false,
  image = null,
} = {}) {
  if (!physicalExecutor) throw new TypeError("Shadow recovery requires a physical executor.");
  const evidence = { image: clone(image), bypass, shadow: [], physical: [], provedAt: null };
  if (!bypass) {
    if (!shadowExecutor) throw createRecoveryError(RECOVERY_ERROR_CODES.TOOL_MISSING, "A shadow executor/QEMU adapter is required unless bypass is explicit.");
    for (const action of plan.actions || []) {
      const result = await shadowExecutor(action);
      const proof = verify ? await verify(action.postconditions || [], { action, result, stage: "shadow" }) : { ok: result?.ok !== false };
      evidence.shadow.push({ action: clone(action), result: clone(result), proof: clone(proof) });
      if (result?.ok === false || proof.ok === false) return { ok: false, stage: "shadow", evidence };
    }
    evidence.provedAt = new Date().toISOString();
  }
  for (const action of plan.actions || []) {
    const result = await physicalExecutor(action, { shadowEvidence: evidence.shadow });
    const proof = verify ? await verify(action.postconditions || [], { action, result, stage: "physical" }) : { ok: result?.ok !== false };
    evidence.physical.push({ action: clone(action), result: clone(result), proof: clone(proof) });
    if (result?.ok === false || proof.ok === false) return { ok: false, stage: "physical", evidence };
  }
  return { ok: true, stage: "complete", evidence };
}
