import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRecoveryController } from "../lib/recovery/ww-recovery-controller.mjs";
import { createRecoveryAgent } from "../lib/recovery/ww-recovery-agent.mjs";
import { createRecoveryExecutor } from "../lib/recovery/ww-recovery-executor.mjs";
import { createRecoveryActionRegistry } from "../lib/recovery/ww-recovery-actions.mjs";
import { createRecoveryAutonomyEngine } from "../lib/recovery/ww-recovery-autonomy.mjs";
import { createDeterministicPlanner } from "../lib/recovery/ww-recovery-planner-process.mjs";
import { expandRecoveryPlaybook, loadRecoveryPlaybooks } from "../lib/recovery/ww-recovery-playbooks.mjs";

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function inventory(identity = {}) {
  return {
    collectedAt: new Date().toISOString(), agent: identity,
    system: { hostname: "planner-target" }, network: { interfaces: [], routes: [] },
    firmware: { uefi: false, secureBoot: null, entries: [] }, tools: {},
    block: { devices: [], filesystems: [], mounts: [], raid: [], lvm: {}, crypt: [], graph: { nodes: [], edges: [] } },
    health: { smart: [], nvme: [], kernelWarnings: [] }, raw: {}, errors: [],
  };
}

test("autonomous recovery loop observes a real remote action and completes with summary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-autonomy-"));
  const port = await unusedPort();
  const controller = createRecoveryController({
    config: { stateDir: path.join(root, "controller"), host: "127.0.0.1", port, bootHost: "127.0.0.1", bootPort: 0, heartbeatMs: 100, staleAfterMs: 500, offlineAfterMs: 1000 },
    autonomy: { start() {}, stop() {} },
  });
  await controller.start();
  const executor = createRecoveryExecutor();
  const collector = { collect: async ({ identity } = {}) => inventory(identity) };
  const agent = createRecoveryAgent({
    controllerUrl: `http://127.0.0.1:${port}`,
    id: "wwra_planner",
    stateDir: path.join(root, "agent"),
    installedIdPath: path.join(root, "agent-id"),
    executor,
    inventory: collector,
    registry: createRecoveryActionRegistry({ executor, inventory: collector }),
    reconnectDelays: [50],
  });
  try {
    await agent.start();
    const store = controller.getStore();
    let caseRecord = await store.createCase({ id: "wwc_autonomytest", targetAgentId: "wwra_planner", goal: "Print and verify an exact marker", mode: "autonomous-unrestricted" });
    caseRecord = await store.updateCase(caseRecord.id, { state: "running" });
    const planner = createDeterministicPlanner([
      { type: "planner.note", note: "Run a non-mutating marker command." },
      { type: "planner.action", requestId: "marker-1", action: "command.exec", params: { argv: [process.execPath, "-e", "process.stdout.write('AUTONOMY-MARKER')"] }, expectedObservation: "stdout contains marker" },
      { type: "planner.complete", outcome: "Marker observed exactly.", verification: ["remote exit 0", "stdout marker"] },
    ]);
    const engine = createRecoveryAutonomyEngine({ store, controller, plannerConfig: { maxIterations: 10, iterationTimeoutMs: 5_000 }, pollMs: 20 });
    assert.equal(engine.start(caseRecord.id, { planner }).started, true);
    const outcome = await engine.wait(caseRecord.id);
    assert.equal(outcome.completed, true);
    assert.equal(store.getCase(caseRecord.id).state, "completed");
    const events = await store.readCaseEvents(caseRecord.id);
    assert.ok(events.some((event) => event.type === "planner.action"));
    assert.ok(events.some((event) => event.type === "step.output" && event.data === "AUTONOMY-MARKER"));
    assert.ok(events.some((event) => event.type === "planner.completed"));
    const summary = await fs.readFile(path.join(root, "controller", "cases", caseRecord.id, "summary.md"), "utf8");
    assert.match(summary, /Marker observed exactly/);
    const observations = planner.getObservations();
    assert.equal(observations[0].type, "planner.init");
    assert.ok(observations.some((message) => message.type === "planner.observation" && message.job.state === "succeeded"));
  } finally {
    await agent.stop();
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recovery playbooks load and expand conditional input without removing force", async () => {
  const playbooks = await loadRecoveryPlaybooks();
  assert.equal(playbooks.length, 7);
  const source = playbooks.find((playbook) => playbook.id === "linux-boot-repair-v1");
  const expanded = expandRecoveryPlaybook(source, {
    inputs: {
      diskDeviceId: "disk_alpha",
      rootDeviceId: "root_alpha",
      rootPath: "/dev/test-root",
      filesystemType: "ext4",
      rootMount: "/mnt/workwire/patient",
      efiPath: "/dev/test-efi",
      distribution: "fedora",
    },
    force: true,
    skip: ["smart-before"],
    insert: [{ before: "cleanup", step: { id: "verify-marker", action: "file.read", params: { path: "${input.rootMount}/etc/os-release" } } }],
  });
  assert.equal(expanded.steps.some((step) => step.id === "smart-before"), false);
  assert.equal(expanded.steps.find((step) => step.id === "filesystem-repair").params.path, "/dev/test-root");
  assert.equal(expanded.steps.find((step) => step.id === "filesystem-repair").force, true);
  assert.equal(expanded.steps.find((step) => step.id === "verify-marker").params.path, "/mnt/workwire/patient/etc/os-release");
});

test("recovery playbook loading ignores preserved WW conflict copies", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-playbooks-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, "safe-v1.json"),
    JSON.stringify({ id: "safe-v1", steps: [] }),
  );
  await fs.writeFile(
    path.join(directory, "safe-v1 (WW conflict deadbeef-1234).json"),
    "this preserved losing version is intentionally not runtime JSON",
  );

  assert.deepEqual(await loadRecoveryPlaybooks({ directory }), [{ id: "safe-v1", steps: [] }]);
});
