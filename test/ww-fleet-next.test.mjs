import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRecoveryController } from "../lib/recovery/ww-recovery-controller.mjs";
import { createRecoveryClient } from "../lib/recovery/ww-recovery-client.mjs";
import { createRecoveryAgent } from "../lib/recovery/ww-recovery-agent.mjs";
import { createRecoveryExecutor } from "../lib/recovery/ww-recovery-executor.mjs";
import { createRecoveryActionRegistry } from "../lib/recovery/ww-recovery-actions.mjs";

async function waitFor(task, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await task();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for fleet condition.");
}

function nativeShellOutput(value) {
  return process.platform === "win32"
    ? `[Console]::Write(${JSON.stringify(value)})`
    : `printf ${JSON.stringify(value)}`;
}

function appendMarkerShell(markerPath, output, delayMs) {
  if (process.platform === "win32") {
    const literalPath = String(markerPath).replaceAll("'", "''");
    return `[System.IO.File]::AppendAllText('${literalPath}', 'x'); Start-Sleep -Milliseconds ${delayMs}; [Console]::Write('${output}')`;
  }
  return `printf x >> ${JSON.stringify(markerPath)}; sleep ${delayMs / 1_000}; printf ${output}`;
}

async function startAgent(info, root, id, log = () => {}) {
  const executor = createRecoveryExecutor();
  const inventory = { collect: async ({ identity } = {}) => ({ collectedAt: new Date().toISOString(), agent: identity, system: { platform: process.platform, hostname: id }, block: { devices: [], mounts: [] }, errors: [] }) };
  const agent = createRecoveryAgent({
    controllerUrl: info.localUrl,
    id,
    name: id,
    stateDir: path.join(root, id),
    installedIdPath: path.join(root, `${id}.id`),
    executor,
    inventory,
    registry: createRecoveryActionRegistry({ executor, inventory }),
    reconnectDelays: [25, 50],
    log,
  });
  await agent.start();
  return agent;
}

test("three real loopback agents group, query, schedule, and execute exact all/bounded/canary rollouts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-fleet-next-"));
  const stateDir = path.join(root, "controller");
  const diagnostics = [];
  const captureLog = (source) => (message) => diagnostics.push({ at: new Date().toISOString(), source, message: String(message) });
  const controller = createRecoveryController({
    config: { stateDir, host: "127.0.0.1", port: 0, bootHost: "127.0.0.1", bootPort: 0, heartbeatMs: 100, staleAfterMs: 5_000, offlineAfterMs: 15_000 },
    log: captureLog("controller"),
  });
  const info = await controller.start();
  const client = createRecoveryClient({ url: info.localUrl });
  const agents = [];
  try {
    for (const id of ["wwra_fleet_a", "wwra_fleet_b", "wwra_fleet_c"]) agents.push(await startAgent(info, root, id, captureLog(id)));
    await waitFor(async () => (await client.listAgents({ online: true })).length === 3);
    await client.setFleetMachine("wwra_fleet_a", { alias: "alpha", labels: { rack: "red", role: "patient" } });
    await client.setFleetMachine("wwra_fleet_b", { alias: "beta", labels: { rack: "red", role: "patient" } });
    await client.setFleetMachine("wwra_fleet_c", { alias: "canary", labels: { rack: "blue", role: "patient" } });
    const group = await client.saveFleetGroup({ id: "wwg_patients", name: "Patients", targetIds: ["wwra_fleet_c"], query: "labels.rack=red" });
    const query = await client.saveFleetQuery({ id: "wwq_red", name: "Red rack", expression: "labels.rack=red and state=online" });
    assert.equal((await client.listFleetMachines("labels.role=patient")).length, 3);
    assert.equal(group.id, "wwg_patients");
    assert.equal(query.id, "wwq_red");

    const all = await client.executeFleet({
      groupId: group.id,
      operation: { type: "command", argv: [process.execPath, "-e", "process.stdout.write('fleet:ignoredmarker')"], env: { WW_FLEET_UNUSED: "ignored" } },
      rollout: { mode: "all-at-once" },
    });
    const allDone = await waitFor(async () => {
      const value = await client.getFleetRun(all.id);
      return ["succeeded", "partial", "failed"].includes(value.state) ? value : null;
    });
    assert.equal(allDone.state, "succeeded");
    const allSummary = await client.getFleetSummary(all.id);
    assert.equal(allSummary.counts.succeeded, 3);
    for (const target of allSummary.targets) {
      assert.ok(target.stdout.some((event) => String(event.data).includes("marker")));
      assert.equal(target.attempt, 1);
      assert.ok(target.startedAt && target.endedAt);
    }

    const bounded = await client.executeFleet({
      queryId: query.id,
      operation: { type: "shell", script: nativeShellOutput("bounded-marker") },
      rollout: { mode: "bounded", concurrency: 1 },
    });
    let boundedSnapshot = null;
    const boundedDone = await waitFor(async () => {
      boundedSnapshot = await client.getFleetRun(bounded.id);
      return ["succeeded", "partial", "failed"].includes(boundedSnapshot.state) ? boundedSnapshot : null;
    }).catch((error) => {
      error.message = `${error.message} ${JSON.stringify({
        run: {
          id: boundedSnapshot?.id,
          state: boundedSnapshot?.state,
          targets: Object.fromEntries(Object.entries(boundedSnapshot?.targets || {}).map(([agentId, target]) => [agentId, {
            state: target.state,
            jobId: target.jobId,
            startedAt: target.startedAt,
            endedAt: target.endedAt,
          }])),
        },
        jobs: controller.getStore().listJobs()
          .filter((job) => job.metadata?.fleetRunId === boundedSnapshot?.id)
          .map((job) => ({
            id: job.id,
            targetAgentId: job.targetAgentId,
            state: job.state,
            leaseSessionId: job.leaseSessionId,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
            result: job.result,
          })),
        agents: controller.getStore().listAgents().map((agent) => ({
          agentId: agent.agentId,
          state: agent.state,
          sessionId: agent.sessionId,
          lastSeenAt: agent.lastSeenAt,
        })),
        diagnostics,
      })}`;
      throw error;
    });
    assert.equal(boundedDone.state, "succeeded");
    assert.equal(Object.keys(boundedDone.targets).length, 2);

    const canary = await client.executeFleet({
      targetIds: ["wwra_fleet_c", "wwra_fleet_a", "wwra_fleet_b"],
      operation: { type: "command", argv: [process.execPath, "-e", "process.exit(9)"] },
      rollout: { mode: "canary", canaryCount: 1, concurrency: 2 },
    });
    const canaryDone = await waitFor(async () => {
      const value = await client.getFleetRun(canary.id);
      return ["succeeded", "partial", "failed"].includes(value.state) ? value : null;
    });
    assert.equal(canaryDone.stopReason, "canary-failed");
    assert.equal(Object.values(canaryDone.targets).filter((target) => target.state === "failed").length, 1);
    assert.equal(Object.values(canaryDone.targets).filter((target) => target.state === "skipped").length, 2);

    const schedule = await client.saveFleetSchedule({
      id: "wwfs_once",
      name: "one shot",
      at: new Date(Date.now() - 100).toISOString(),
      selection: { queryId: query.id },
      operation: { type: "command", argv: [process.execPath, "-e", "process.stdout.write('scheduled')"] },
      rollout: { mode: "bounded", concurrency: 2 },
      missed: "run-once",
    });
    assert.equal(schedule.id, "wwfs_once");
    await waitFor(async () => (await client.listFleetRuns()).some((run) => run.scheduleId === schedule.id && ["succeeded", "partial", "failed"].includes(run.state)));
    const persisted = (await client.listFleetSchedules()).find((record) => record.id === schedule.id);
    assert.equal(persisted.enabled, false);
    assert.ok(persisted.lastRunId);
  } finally {
    await Promise.all(agents.map((agent) => agent.stop()));
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent dispatch signals lease one queued job exactly once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-fleet-dispatch-race-"));
  const controller = createRecoveryController({
    config: { stateDir: path.join(root, "controller"), host: "127.0.0.1", port: 0, bootHost: "127.0.0.1", bootPort: 0, heartbeatMs: 50, staleAfterMs: 500, offlineAfterMs: 1_000 },
  });
  const info = await controller.start();
  const agent = await startAgent(info, root, "wwra_dispatch_race");
  try {
    await waitFor(() => controller.getConnectedAgent("wwra_dispatch_race"));
    const store = controller.getStore();
    const caseRecord = await store.createCase({
      id: "wwc_dispatch_race",
      targetAgentId: "wwra_dispatch_race",
      goal: "Lease once under simultaneous scheduler and heartbeat dispatch",
    });
    const job = await store.createJob(caseRecord.id, {
      id: "wwj_dispatch_race",
      steps: [{ id: "step_dispatch_race", action: "command.exec", params: { argv: [process.execPath, "-e", "setTimeout(() => process.stdout.write('dispatched-once'), 250)"] } }],
    });

    await Promise.all(Array.from({ length: 64 }, () => controller.dispatchNext("wwra_dispatch_race")));
    const completed = await waitFor(() => {
      const current = store.getJob(job.id);
      return ["succeeded", "failed"].includes(current?.state) ? current : null;
    });
    const events = await store.readJobEvents(job.id);
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.attempt, 1);
    assert.equal(events.filter((event) => event.type === "job.leased").length, 1);
  } finally {
    await agent.stop();
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("controller blackout preserves fleet run and schedule without duplicating a completed mutation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-fleet-restart-"));
  const stateDir = path.join(root, "controller");
  const marker = path.join(root, "mutation-marker");
  let controller = createRecoveryController({ config: { stateDir, host: "127.0.0.1", port: 0, bootHost: "127.0.0.1", bootPort: 0, heartbeatMs: 100, staleAfterMs: 500, offlineAfterMs: 1_000 } });
  const firstInfo = await controller.start();
  const agent = await startAgent(firstInfo, root, "wwra_fleet_restart");
  let client = createRecoveryClient({ url: firstInfo.localUrl });
  try {
    await waitFor(async () => (await client.getAgent("wwra_fleet_restart")).agent?.connected === true);
    const schedule = await client.saveFleetSchedule({
      id: "wwfs_restart_preserved",
      name: "future preserved schedule",
      at: new Date(Date.now() + 60_000).toISOString(),
      selection: { targetIds: ["wwra_fleet_restart"] },
      operation: { type: "inventory" },
    });
    const run = await client.executeFleet({
      targetIds: ["wwra_fleet_restart"],
      operation: { type: "shell", script: appendMarkerShell(marker, "FLEET_RECONCILED", 800) },
      rollout: { mode: "bounded", concurrency: 1 },
    });
    await waitFor(async () => {
      const current = await client.getFleetRun(run.id);
      const target = current.targets.wwra_fleet_restart;
      return target?.jobId && controller.getStore().getJob(target.jobId)?.state === "running";
    });

    await controller.stop();
    controller = createRecoveryController({ config: { stateDir, host: "127.0.0.1", port: firstInfo.port, bootHost: "127.0.0.1", bootPort: firstInfo.boot.port, heartbeatMs: 100, staleAfterMs: 500, offlineAfterMs: 1_000 } });
    const secondInfo = await controller.start();
    client = createRecoveryClient({ url: secondInfo.localUrl });
    await waitFor(async () => (await client.getAgent("wwra_fleet_restart")).agent?.connected === true);
    const completed = await waitFor(async () => {
      const current = await client.getFleetRun(run.id);
      return ["succeeded", "partial", "failed"].includes(current.state) ? current : null;
    });
    assert.equal(completed.state, "succeeded", JSON.stringify(completed, null, 2));
    const target = completed.targets.wwra_fleet_restart;
    assert.equal(target.attempt, 1);
    assert.ok(target.resumeCount >= 1);
    assert.equal(await fs.readFile(marker, "utf8"), "x");
    assert.equal(controller.getStore().listJobs(target.caseId).length, 1);
    const events = await controller.getStore().readJobEvents(target.jobId);
    assert.deepEqual(events.map((event) => event.seq), [...new Set(events.map((event) => event.seq))]);
    assert.equal((await client.listFleetSchedules()).find((item) => item.id === schedule.id)?.enabled, true);
  } finally {
    await agent.stop();
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
