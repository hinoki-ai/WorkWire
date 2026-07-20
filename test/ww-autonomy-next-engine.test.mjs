import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRecoveryController } from "../lib/recovery/ww-recovery-controller.mjs";
import { createRecoveryAgent } from "../lib/recovery/ww-recovery-agent.mjs";
import { createRecoveryExecutor } from "../lib/recovery/ww-recovery-executor.mjs";
import { createRecoveryActionRegistry } from "../lib/recovery/ww-recovery-actions.mjs";
import { createRecoveryAutonomyEngine } from "../lib/recovery/ww-recovery-autonomy.mjs";
import { createDeterministicPlanner } from "../lib/recovery/ww-recovery-planner-process.mjs";
import {
  createAutonomousPlanGraph,
  addPlanNode,
  addPlanEdge,
  exportRecoveryProcedure,
  replayRecoveryProcedure,
  runShadowRecoveryPlan,
  detectIdentityChange,
  verifyRecoveryPostconditions,
} from "../lib/recovery/ww-recovery-autonomy-next.mjs";

const execFileAsync = promisify(execFile);

function markerCommand(output) {
  return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`];
}

function markerShell(markerPath, { output = "", sleepMs = 0 } = {}) {
  if (process.platform === "win32") {
    const literalPath = String(markerPath).replaceAll("'", "''");
    return [
      `[System.IO.File]::AppendAllText('${literalPath}', 'x')`,
      sleepMs > 0 ? `Start-Sleep -Milliseconds ${sleepMs}` : "",
      output ? `[Console]::Write('${String(output).replaceAll("'", "''")}')` : "",
    ].filter(Boolean).join("; ");
  }
  return `printf x >> ${JSON.stringify(markerPath)}; ${sleepMs > 0 ? `sleep ${sleepMs / 1_000}; ` : ""}${output ? `printf ${JSON.stringify(output)}` : ""}`;
}

function failingCommand() {
  return process.platform === "win32"
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "exit 7"]
    : ["/bin/sh", "-c", "exit 7"];
}

function inventory(identity = {}) {
  return {
    collectedAt: new Date().toISOString(),
    agent: identity,
    system: { platform: "linux" },
    block: { devices: [{ deviceId: "disk_fixture", canonicalPath: "/dev/fixture", type: "disk", size: 1024 }], mounts: [] },
    platformFacts: { services: "fixture.service active" },
    errors: [],
  };
}

async function setup(root, id = "wwra_autonomy_next") {
  const controller = createRecoveryController({
    config: { stateDir: path.join(root, "controller"), host: "127.0.0.1", port: 0, bootHost: "127.0.0.1", bootPort: 0, heartbeatMs: 100, staleAfterMs: 500, offlineAfterMs: 1_000 },
    autonomy: { start() {}, stop() {} },
  });
  const info = await controller.start();
  const executor = createRecoveryExecutor();
  const collector = { collect: async ({ identity } = {}) => inventory(identity) };
  const agent = createRecoveryAgent({ controllerUrl: info.localUrl, id, stateDir: path.join(root, "agent"), installedIdPath: path.join(root, "agent-id"), executor, inventory: collector, registry: createRecoveryActionRegistry({ executor, inventory: collector }), reconnectDelays: [25] });
  await agent.start();
  return { controller, agent, store: controller.getStore() };
}

test("autonomy rejects zero-exit completion, records graph proof, and exports a sourced procedure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-autonomy-proof-"));
  const { controller, agent, store } = await setup(root);
  try {
    let caseRecord = await store.createCase({ id: "wwc_proof_case", targetAgentId: "wwra_autonomy_next", goal: "Prove the marker exists", mode: "autonomous-unrestricted" });
    caseRecord = await store.updateCase(caseRecord.id, { state: "running" });
    const planner = createDeterministicPlanner([
      { type: "planner.hypothesis", hypothesisId: "hyp_marker", summary: "The command path is healthy.", state: "current" },
      { type: "planner.action", requestId: "proof_action", action: "command.exec", params: { argv: markerCommand("PROOF-MARKER") }, expectedObservation: "stdout contains marker" },
      { type: "planner.complete", requestId: "weak_complete", outcome: "Weak", verification: ["exit code 0"] },
      { type: "planner.proof", proofId: "proof_marker", summary: "Exact stdout contains PROOF-MARKER", verified: true, evidence: { sourceJobRequestId: "proof_action", stdoutContains: "PROOF-MARKER" } },
      { type: "planner.complete", requestId: "strong_complete", outcome: "Marker proved", verification: ["stdout contains PROOF-MARKER"] },
    ]);
    const engine = createRecoveryAutonomyEngine({ store, controller, pollMs: 20, plannerConfig: { maxIterations: 10, iterationTimeoutMs: 5_000 } });
    engine.start(caseRecord.id, { planner });
    const result = await engine.wait(caseRecord.id);
    assert.equal(result.completed, true);
    const events = await store.readCaseEvents(caseRecord.id);
    assert.ok(events.some((event) => event.type === "planner.proof-required"));
    assert.ok(events.some((event) => event.type === "planner.procedure.exported" && event.sourceCaseId === caseRecord.id));
    const graph = JSON.parse(await fs.readFile(path.join(root, "controller", "cases", caseRecord.id, "plan-graph.json"), "utf8"));
    assert.ok(graph.nodes.some((node) => node.type === "proof" && node.verified === true));
    const procedure = JSON.parse(await fs.readFile(path.join(root, "controller", "cases", caseRecord.id, "procedure.json"), "utf8"));
    assert.equal(procedure.sourceCaseId, caseRecord.id);
    assert.match(procedure.hash, /^sha256:/);
    assert.equal(store.getCase(caseRecord.id).finalReport.initialFailure, "Prove the marker exists");
    assert.ok(planner.getObservations().some((message) => message.completionRejected === true));
  } finally {
    await agent.stop();
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("planner crash resume reuses request id and never duplicates a completed mutation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-autonomy-resume-"));
  const markerPath = path.join(root, "mutation-marker");
  const { controller, agent, store } = await setup(root, "wwra_autonomy_resume");
  try {
    let caseRecord = await store.createCase({ id: "wwc_resume_case", targetAgentId: "wwra_autonomy_resume", goal: "Mutate once", mode: "autonomous-unrestricted" });
    caseRecord = await store.updateCase(caseRecord.id, { state: "running" });
    const firstPlanner = createDeterministicPlanner([
      { type: "planner.action", requestId: "stable_mutation", action: "shell.exec", params: { script: markerShell(markerPath, { output: "replay-marker" }) }, expectedObservation: "stdout marker", postconditions: [{ type: "stdout", operator: "contains", value: "replay-marker" }] },
    ]);
    let engine = createRecoveryAutonomyEngine({ store, controller, pollMs: 20, plannerConfig: { maxIterations: 5, iterationTimeoutMs: 5_000 } });
    engine.start(caseRecord.id, { planner: firstPlanner });
    const crashed = await engine.wait(caseRecord.id);
    assert.ok(crashed.error);
    assert.equal(store.getCase(caseRecord.id).state, "failed");

    await store.updateCase(caseRecord.id, { state: "running" });
    const resumedPlanner = createDeterministicPlanner([
      { type: "planner.action", requestId: "stable_mutation", action: "shell.exec", params: { script: markerShell(markerPath, { output: "replay-marker" }) }, expectedObservation: "stdout marker", postconditions: [{ type: "stdout", operator: "contains", value: "replay-marker" }] },
      { type: "planner.complete", outcome: "Mutation replay proved", verification: ["stdout contains replay-marker"] },
    ]);
    engine = createRecoveryAutonomyEngine({ store, controller, pollMs: 20, plannerConfig: { maxIterations: 5, iterationTimeoutMs: 5_000 } });
    engine.start(caseRecord.id, { planner: resumedPlanner, resume: true });
    assert.equal((await engine.wait(caseRecord.id)).completed, true);
    assert.equal(await fs.readFile(markerPath, "utf8"), "x");
    const events = await store.readCaseEvents(caseRecord.id);
    assert.equal(events.filter((event) => event.type === "planner.action" && event.requestId === "stable_mutation").length, 1);
    assert.equal(store.listJobs(caseRecord.id).length, 1);
  } finally {
    await agent.stop();
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("postcondition, graph, procedure replay, and real QEMU shadow helpers preserve proof ordering", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-shadow-qemu-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const graph = createAutonomousPlanGraph({ caseId: "wwc_helpers", goal: "Repair boot byte" });
  const hypothesis = addPlanNode(graph, { id: "hyp_boot", type: "hypothesis", state: "current", label: "Boot marker is wrong" });
  const action = addPlanNode(graph, { id: "action_boot", type: "action", action: "write-marker" });
  addPlanEdge(graph, { from: hypothesis.id, to: action.id, type: "proposes" });
  assert.equal(graph.edges.length, 1);
  const proof = verifyRecoveryPostconditions([{ type: "stdout", operator: "contains", value: "fixed" }, { type: "exit-code", value: 0 }], {
    events: [{ type: "step.output", stream: "stdout", data: "fixed", encoding: "utf8" }],
    job: { result: { steps: [{ result: { exitCode: 0 } }] } },
  });
  assert.equal(proof.ok, true);
  assert.equal(verifyRecoveryPostconditions([{ type: "exit-code", value: 0 }], { job: { result: { steps: [{ result: { exitCode: 0 } }] } } }).zeroExitOnly, true);

  const procedure = await exportRecoveryProcedure({ caseRecord: { id: "wwc_helpers", goal: "Repair boot byte", metadata: {} }, actions: [{ action: "write-marker", request: { requestId: "write", action: "write-marker", params: { value: "${input.marker}" } } }], proofs: [proof] });
  const replayed = await replayRecoveryProcedure(procedure, { parameters: { marker: "fixed" }, executor: async (_name, params) => ({ ok: params.value === "fixed" }) });
  assert.equal(replayed.ok, true);

  const qemu = await execFileAsync("sh", ["-c", "command -v qemu-system-x86_64 || true"]).catch(() => ({ stdout: "" }));
  if (!qemu.stdout.trim()) return;
  const shadowImage = path.join(root, "shadow.raw");
  await fs.writeFile(shadowImage, Buffer.alloc(1024 * 1024));
  const order = [];
  const runQemuProbe = async () => new Promise((resolve, reject) => {
    const child = spawn(qemu.stdout.trim(), ["-machine", "q35", "-nodefaults", "-display", "none", "-S", "-drive", `file=${shadowImage},format=raw,if=none,id=shadowdisk`, "-qmp", "stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(errors).toString("utf8"))));
    child.stdin.write('{"execute":"qmp_capabilities"}\n');
    child.stdin.write('{"execute":"quit"}\n');
  });
  const shadowResult = await runShadowRecoveryPlan({
    image: { path: shadowImage, disposable: true, engine: "qemu-system-x86_64" },
    plan: { actions: [{ id: "repair-byte", postconditions: [{ type: "byte", value: 0x57 }] }] },
    shadowExecutor: async () => { order.push("qemu-shadow"); await runQemuProbe(); const file = await fs.open(shadowImage, "r+"); await file.write(Buffer.from([0x57]), 0, 1, 510); await file.close(); return { ok: true, byte: (await fs.readFile(shadowImage))[510] }; },
    physicalExecutor: async (_action, contextValue) => { order.push("fake-physical"); assert.equal(contextValue.shadowEvidence.length, 1); return { ok: true, replayed: true }; },
    verify: async (_conditions, value) => ({ ok: value.stage === "shadow" ? value.result.byte === 0x57 : value.result.replayed === true }),
  });
  assert.equal(shadowResult.ok, true);
  assert.deepEqual(order, ["qemu-shadow", "fake-physical"]);
  assert.ok(shadowResult.evidence.provedAt);
});

test("repeated failures are explicit, changed identity is detected, and manual takeover stops autonomy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-autonomy-failure-matrix-"));
  const { controller, agent, store } = await setup(root, "wwra_failure_matrix");
  try {
    let caseRecord = await store.createCase({ id: "wwc_failure_matrix", targetAgentId: "wwra_failure_matrix", goal: "Diagnose a repeated command failure", mode: "autonomous-unrestricted" });
    caseRecord = await store.updateCase(caseRecord.id, { state: "running" });
    const planner = createDeterministicPlanner([
      ...[1, 2, 3].map((index) => ({ type: "planner.action", requestId: `repeat_${index}`, action: "command.exec", params: { argv: failingCommand() }, expectedObservation: "command fails consistently" })),
      { type: "planner.takeover", reason: "operator-needs-unrestricted-console" },
    ]);
    const engine = createRecoveryAutonomyEngine({ store, controller, pollMs: 20, plannerConfig: { maxIterations: 10, iterationTimeoutMs: 5_000 } });
    engine.start(caseRecord.id, { planner });
    const result = await engine.wait(caseRecord.id);
    assert.equal(result.manualTakeover, true, JSON.stringify(result));
    assert.equal(store.getCase(caseRecord.id).state, "stopped");
    const events = await store.readCaseEvents(caseRecord.id);
    assert.equal(events.filter((event) => event.type === "planner.observation" && event.state === "failed").length, 3);
    assert.equal(events.find((event) => event.type === "planner.repeated-failure")?.count, 3);
    assert.equal(events.find((event) => event.type === "planner.manual-takeover")?.reason, "operator-needs-unrestricted-console");

    const change = detectIdentityChange(
      { block: { devices: [{ deviceId: "disk-a", canonicalPath: "/dev/sda" }, { deviceId: "disk-lost", canonicalPath: "/dev/sdb" }] } },
      { block: { devices: [{ deviceId: "disk-a", canonicalPath: "/dev/nvme0n1" }, { deviceId: "disk-new", canonicalPath: "/dev/sdc" }] } },
    );
    assert.equal(change.changed, true);
    assert.deepEqual(change.missing, ["disk-lost"]);
    assert.deepEqual(change.added, ["disk-new"]);
    assert.deepEqual(change.changedPaths, [{ deviceId: "disk-a", before: "/dev/sda", after: "/dev/nvme0n1" }]);
  } finally {
    await agent.stop();
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("agent reboot reconciles an interrupted mutation and stable request replay never duplicates it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-autonomy-agent-reboot-"));
  const markerPath = path.join(root, "reboot-marker");
  const controller = createRecoveryController({
    config: { stateDir: path.join(root, "controller"), host: "127.0.0.1", port: 0, bootHost: "127.0.0.1", bootPort: 0, heartbeatMs: 100, staleAfterMs: 500, offlineAfterMs: 1_000 },
    autonomy: { start() {}, stop() {} },
  });
  const info = await controller.start();
  const executor = createRecoveryExecutor();
  const collector = { collect: async ({ identity } = {}) => inventory(identity) };
  const registry = createRecoveryActionRegistry({ executor, inventory: collector });
  const agentState = path.join(root, "agent");
  let agent = createRecoveryAgent({ controllerUrl: info.localUrl, identity: { agentId: "wwra_agent_reboot", bootId: "boot-before", stability: "test" }, stateDir: agentState, executor, inventory: collector, registry, reconnectDelays: [25] });
  const store = controller.getStore();
  try {
    await agent.start();
    let caseRecord = await store.createCase({ id: "wwc_agent_reboot", targetAgentId: "wwra_agent_reboot", goal: "Write the marker once across reboot", mode: "autonomous-unrestricted" });
    caseRecord = await store.updateCase(caseRecord.id, { state: "running" });
    const firstPlanner = createDeterministicPlanner([
      { type: "planner.action", requestId: "reboot_stable_mutation", action: "shell.exec", params: { script: markerShell(markerPath, { sleepMs: 10_000 }) }, expectedObservation: "marker exists after reboot" },
    ]);
    let engine = createRecoveryAutonomyEngine({ store, controller, pollMs: 20, plannerConfig: { maxIterations: 5, iterationTimeoutMs: 20_000 } });
    engine.start(caseRecord.id, { planner: firstPlanner });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await fs.readFile(markerPath, "utf8").catch(() => "")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await fs.readFile(markerPath, "utf8"), "x");
    await agent.stop("simulated-agent-reboot");
    await engine.wait(caseRecord.id);

    agent = createRecoveryAgent({ controllerUrl: info.localUrl, identity: { agentId: "wwra_agent_reboot", bootId: "boot-after", stability: "test" }, stateDir: agentState, executor, inventory: collector, registry, reconnectDelays: [25] });
    await agent.start();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (controller.getConnectedAgent("wwra_agent_reboot")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await store.updateCase(caseRecord.id, { state: "running" });
    const resumedPlanner = createDeterministicPlanner([
      { type: "planner.action", requestId: "reboot_stable_mutation", action: "shell.exec", params: { script: markerShell(markerPath, { sleepMs: 10_000 }) }, expectedObservation: "marker exists after reboot" },
      { type: "planner.proof", proofId: "proof_reboot_marker", summary: "Marker from the interrupted mutation exists", verified: true, evidence: { path: markerPath } },
      { type: "planner.complete", outcome: "Reboot interruption reconciled", verification: ["marker exists"] },
    ]);
    engine = createRecoveryAutonomyEngine({ store, controller, pollMs: 20, plannerConfig: { maxIterations: 6, iterationTimeoutMs: 5_000 } });
    engine.start(caseRecord.id, { planner: resumedPlanner, resume: true });
    assert.equal((await engine.wait(caseRecord.id)).completed, true);
    assert.equal(await fs.readFile(markerPath, "utf8"), "x");
    assert.equal(store.listJobs(caseRecord.id).length, 1);
    assert.equal(store.getAgent("wwra_agent_reboot").rebooted, true);
  } finally {
    await agent.stop();
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
