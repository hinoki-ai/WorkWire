import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createRemoteWwClient } from "../../lib/ww-client.mjs";
import { createWwService } from "../../lib/ww-service.mjs";
import {
  emitResult,
  environmentRecord,
  listArg,
  mapWithConcurrency,
  numberArg,
  parseArgs,
  summarize,
} from "./common.mjs";

const args = parseArgs();
const fleetSizes = listArg(args.agents, [1, 10, 50, 100]);
const rounds = numberArg(args.rounds, 5, { min: 2, max: 50 });
const reconnectOnly = args["reconnect-only"] === true || args["reconnect-only"] === "true";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-perf-service-"));
const portalRoot = path.join(root, "Portal");
await fs.mkdir(portalRoot);
await mapWithConcurrency(Array.from({ length: 1_000 }, (_, index) => index), 64, async (index) => {
  const handle = await fs.open(path.join(portalRoot, `service-entry-${String(index).padStart(5, "0")}.txt`), "wx");
  await handle.close();
});

let controller = createWwService({
  host: "127.0.0.1",
  port: 0,
  token: "performance-token",
  machineId: "ww_perf_service",
  rootPath: root,
  recoverPortCollision: false,
});

const results = [];
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
const utilizationStart = performance.eventLoopUtilization();
const cpuStart = process.cpuUsage();
const memoryStart = process.memoryUsage();
let peakMemory = { ...memoryStart };
const memoryTimer = setInterval(() => {
  const memory = process.memoryUsage();
  for (const key of Object.keys(peakMemory)) peakMemory[key] = Math.max(peakMemory[key], memory[key]);
}, 2);
const handlesBefore = process._getActiveHandles().map((handle) => handle?.constructor?.name || typeof handle);
try {
  let info = await controller.start();

  for (const count of fleetSizes) {
    const clients = Array.from({ length: count }, (_, index) => createRemoteWwClient({
      host: "127.0.0.1",
      port: info.port,
      token: "performance-token",
      localMachineId: `ww_perf_client_${index}`,
    }));
    const latenciesMs = [];
    const batchDurationsMs = [];
    for (let round = 0; round < rounds; round += 1) {
      const batchStartedAt = performance.now();
      await Promise.all(clients.map(async (client) => {
        const startedAt = performance.now();
        await client.connect();
        latenciesMs.push(performance.now() - startedAt);
      }));
      batchDurationsMs.push(performance.now() - batchStartedAt);
    }
    results.push({
      concurrentClients: count,
      operation: "simultaneous-connect-negotiation",
      requestLatencyMs: summarize(latenciesMs),
      batchDurationMs: summarize(batchDurationsMs),
      requests: latenciesMs.length,
    });
  }

  const reconnectStormRounds = numberArg(args["storm-rounds"], 3, { min: 2, max: 20 });
  for (const count of fleetSizes) {
    const batchDurationsMs = [];
    const requestLatenciesMs = [];
    for (let round = 0; round < reconnectStormRounds; round += 1) {
      const stablePort = info.port;
      await controller.stop();
      controller = createWwService({
        host: "127.0.0.1",
        port: stablePort,
        token: "performance-token",
        machineId: "ww_perf_service",
        rootPath: root,
        recoverPortCollision: false,
      });
      info = await controller.start();
      const clients = Array.from({ length: count }, (_, index) => createRemoteWwClient({
        host: "127.0.0.1",
        port: info.port,
        token: "performance-token",
        localMachineId: `ww_perf_storm_${round}_${index}`,
      }));
      const batchStartedAt = performance.now();
      await Promise.all(clients.map(async (client) => {
        const startedAt = performance.now();
        await client.connect();
        requestLatenciesMs.push(performance.now() - startedAt);
      }));
      batchDurationsMs.push(performance.now() - batchStartedAt);
    }
    results.push({
      concurrentClients: count,
      operation: "simultaneous-reconnect-after-service-restart",
      rounds: reconnectStormRounds,
      requestLatencyMs: summarize(requestLatenciesMs),
      batchDurationMs: summarize(batchDurationsMs),
      requests: requestLatenciesMs.length,
    });
  }

  if (!reconnectOnly) {
    const client = createRemoteWwClient({
      host: "127.0.0.1",
      port: info.port,
      token: "performance-token",
      localMachineId: "ww_perf_latency",
    });
    for (const operation of ["ping", "list-1000"]) {
      const latenciesMs = [];
      for (let index = 0; index < Math.max(10, rounds * 4); index += 1) {
        const startedAt = performance.now();
        if (operation === "ping") {
          await client.ping();
        } else {
          const listing = await client.listDirectory({ path: portalRoot, includeHidden: true });
          if (listing.items.length !== 1_000) throw new Error("Incomplete service listing.");
        }
        latenciesMs.push(performance.now() - startedAt);
      }
      results.push({
        concurrentClients: 1,
        operation,
        requestLatencyMs: summarize(latenciesMs),
        requests: latenciesMs.length,
      });
    }
  }

  const restartCycles = numberArg(args["restart-cycles"], 10, { min: 2, max: 100 });
  const restartLatenciesMs = [];
  const stablePort = info.port;
  await controller.stop();
  for (let cycle = 0; cycle < restartCycles; cycle += 1) {
    controller = createWwService({
      host: "127.0.0.1",
      port: stablePort,
      token: "performance-token",
      machineId: "ww_perf_service",
      rootPath: root,
      recoverPortCollision: false,
    });
    const startedAt = performance.now();
    info = await controller.start();
    const client = createRemoteWwClient({
      host: "127.0.0.1",
      port: info.port,
      token: "performance-token",
      localMachineId: `ww_perf_restart_${cycle}`,
    });
    await client.connect();
    restartLatenciesMs.push(performance.now() - startedAt);
    await controller.stop();
  }
  results.push({
    operation: "controller-stop-start-reconnect",
    cycles: restartCycles,
    latencyMs: summarize(restartLatenciesMs),
  });
  controller = null;
} finally {
  await controller?.stop().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
  clearInterval(memoryTimer);
  const memory = process.memoryUsage();
  for (const key of Object.keys(peakMemory)) peakMemory[key] = Math.max(peakMemory[key], memory[key]);
  histogram.disable();
}

const cpu = process.cpuUsage(cpuStart);
const utilization = performance.eventLoopUtilization(utilizationStart);
const memoryEnd = process.memoryUsage();
const handlesAfter = process._getActiveHandles().map((handle) => handle?.constructor?.name || typeof handle);

await emitResult({
  benchmark: "file-service-and-reconnect-stress",
  scopeNote: "This is the active WorkWire HTTP file service; the Phase 3 recovery controller and agents do not exist yet.",
  conditions: { fleetSizes, rounds, listingEntries: 1_000, loopback: true },
  environment: environmentRecord(),
  resources: {
    memoryStartBytes: memoryStart,
    peakMemoryBytes: peakMemory,
    memoryEndBytes: memoryEnd,
    cpuUserMs: Number((cpu.user / 1_000).toFixed(3)),
    cpuSystemMs: Number((cpu.system / 1_000).toFixed(3)),
    eventLoopUtilization: Number(utilization.utilization.toFixed(6)),
    eventLoopDelayMs: {
      mean: Number((histogram.mean / 1e6).toFixed(3)),
      p95: Number((histogram.percentile(95) / 1e6).toFixed(3)),
      p99: Number((histogram.percentile(99) / 1e6).toFixed(3)),
      max: Number((histogram.max / 1e6).toFixed(3)),
    },
    handlesBefore,
    handlesAfter,
  },
  results,
}, { output: String(args.output || "") });
