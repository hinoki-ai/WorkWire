#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { createRecoveryController } from "../../lib/recovery/ww-recovery-controller.mjs";
import { createRecoveryClient } from "../../lib/recovery/ww-recovery-client.mjs";
import { createRecoveryAgent } from "../../lib/recovery/ww-recovery-agent.mjs";
import { createRecoveryExecutor } from "../../lib/recovery/ww-recovery-executor.mjs";
import { createRecoveryActionRegistry } from "../../lib/recovery/ww-recovery-actions.mjs";

function parseFlags(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    result[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function summarize(values) {
  return {
    samples: values.length,
    minMs: Number(Math.min(...values).toFixed(3)),
    medianMs: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
  };
}

async function waitFor(task, { timeoutMs = 15_000, intervalMs = 10, label = "condition" } = {}) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const value = await task();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function startAgent(info, root, id) {
  const executor = createRecoveryExecutor();
  const inventory = {
    collect: async ({ identity } = {}) => ({
      collectedAt: new Date().toISOString(),
      agent: identity,
      system: { platform: "linux", hostname: id },
      block: { devices: [], mounts: [] },
      errors: [],
    }),
  };
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
  });
  await agent.start();
  return agent;
}

async function main() {
  const options = parseFlags(process.argv.slice(2));
  const agentCount = Math.max(3, Number(options.agents || 3));
  const rounds = Math.max(3, Number(options.rounds || 6));
  const outputPath = options.output ? path.resolve(String(options.output)) : null;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-commander-benchmark-"));
  const controller = createRecoveryController({
    config: {
      stateDir: path.join(root, "controller"),
      host: "127.0.0.1",
      port: 0,
      bootHost: "127.0.0.1",
      bootPort: 0,
      heartbeatMs: 100,
      staleAfterMs: 500,
      offlineAfterMs: 1_000,
    },
  });
  const agents = [];
  const registrationStartedAt = performance.now();
  try {
    const info = await controller.start();
    const client = createRecoveryClient({ url: info.localUrl });
    const agentIds = Array.from({ length: agentCount }, (_, index) => `wwra_benchmark_${index + 1}`);
    for (const id of agentIds) agents.push(await startAgent(info, root, id));
    await waitFor(async () => (await client.listAgents({ online: true })).length === agentCount, { label: `${agentCount} online agents` });
    const registrationMs = performance.now() - registrationStartedAt;

    for (const agentId of agentIds) await client.setFleetMachine(agentId, { labels: { benchmark: "commander" } });
    const group = await client.saveFleetGroup({ id: "wwg_commander_benchmark", name: "Commander benchmark", query: "labels.benchmark=commander" });
    const latencies = { "all-at-once": [], bounded: [], canary: [] };
    let exactTargetResults = 0;
    let exactOutputEvents = 0;

    for (let round = 0; round < rounds; round += 1) {
      const modes = [
        { mode: "all-at-once" },
        { mode: "bounded", concurrency: 2 },
        { mode: "canary", canaryCount: 1, concurrency: 2 },
      ];
      const rollout = modes[round % modes.length];
      const startedAt = performance.now();
      const run = await client.executeFleet({
        groupId: group.id,
        operation: { type: "command", argv: ["/bin/sh", "-c", `printf 'commander-round-${round}'`] },
        rollout,
      });
      const completed = await waitFor(async () => {
        const current = await client.getFleetRun(run.id);
        return ["succeeded", "partial", "failed"].includes(current.state) ? current : null;
      }, { label: `fleet run ${run.id}` });
      latencies[rollout.mode].push(performance.now() - startedAt);
      if (completed.state !== "succeeded") throw new Error(`Benchmark fleet run ${run.id} ended ${completed.state}.`);
      const summary = await client.getFleetSummary(run.id);
      exactTargetResults += summary.targets.length;
      exactOutputEvents += summary.targets.reduce((total, target) => total + target.stdout.length + target.stderr.length, 0);
      for (const target of summary.targets) {
        if (!target.startedAt || !target.endedAt || target.attempt !== 1) throw new Error(`Fleet target evidence was incomplete for ${target.agentId}.`);
      }
    }

    const sessionOpenStartedAt = performance.now();
    const session = await client.openSession({ agentId: agentIds[0], cwd: root, argv: ["/bin/sh"], rows: 24, cols: 80 });
    const sessionOpenMs = performance.now() - sessionOpenStartedAt;
    const firstByteStartedAt = performance.now();
    await client.sessionInput(session.id, "printf 'commander-terminal-ready\\n'\n");
    const sessionEvents = await waitFor(async () => {
      const events = await client.listSessionEvents(session.id);
      return events.some((event) => event.type === "session.output" && String(event.data).includes("commander-terminal-ready")) ? events : null;
    }, { label: "interactive terminal first byte" });
    const sessionFirstOutputMs = performance.now() - firstByteStartedAt;
    await client.terminateSession(session.id);
    await waitFor(async () => (await client.getSession(session.id)).state === "exited", { label: "terminal exit" });

    const lanes = await client.getNextStage({ refresh: true });
    const result = {
      benchmark: "recovery-fleet-commander-real-loopback",
      generatedAt: new Date().toISOString(),
      platform: { platform: process.platform, arch: process.arch, node: process.version },
      configuration: { agents: agentCount, rounds, rolloutConcurrency: 2 },
      registration: { allAgentsOnlineMs: Number(registrationMs.toFixed(3)) },
      fleetEndToEnd: Object.fromEntries(Object.entries(latencies).map(([mode, values]) => [mode, summarize(values)])),
      interactive: {
        openRoundTripMs: Number(sessionOpenMs.toFixed(3)),
        inputToObservedOutputMs: Number(sessionFirstOutputMs.toFixed(3)),
        eventCount: sessionEvents.length,
        terminalMode: session.terminalMode,
      },
      evidence: { exactTargetResults, exactOutputEvents, lostTargetResults: 0, terminalOutputGap: false },
      optionalLanes: Object.fromEntries(Object.entries(lanes).map(([lane, value]) => [lane, Boolean(value.available)])),
      assertions: {
        threeOrMoreRealAgents: agentCount >= 3,
        everyTargetHadExactEvidence: exactTargetResults === agentCount * rounds,
        terminalRoundTripObserved: sessionEvents.some((event) => String(event.data).includes("commander-terminal-ready")),
      },
    };
    if (!Object.values(result.assertions).every(Boolean)) throw new Error(`Commander benchmark assertion failed: ${JSON.stringify(result.assertions)}`);
    if (outputPath) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await Promise.all(agents.map((agent) => agent.stop().catch(() => {})));
    await controller.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
