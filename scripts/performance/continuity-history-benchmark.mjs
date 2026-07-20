import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createContinuityStore } from "../../lib/continuity/index.mjs";
import { emitResult, environmentRecord, parseArgs, numberArg, summarize } from "./common.mjs";

const args = parseArgs();
const eventCount = numberArg(args.events, 100_000, { min: 1_000, max: 1_000_000 });
const inventoryCount = numberArg(args.inventories, 100, { min: 2, max: 10_000 });
const repeats = numberArg(args.repeats, 9, { min: 3, max: 100 });
const temporary = !args.root;
const root = args.root ? path.resolve(String(args.root)) : await fs.mkdtemp(path.join(os.tmpdir(), "ww-continuity-benchmark-"));

function inventory(index) {
  return {
    collectedAt: new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString(),
    machineId: "continuity-benchmark-machine",
    dmiUuid: "continuity-benchmark-dmi",
    system: { hostname: index < 50 ? "benchmark-old" : "benchmark-new", platform: "linux", release: `6.${index}` },
    agent: { bootId: `benchmark-boot-${Math.floor(index / 10)}`, capabilities: { shell: true, smart: index >= 50 } },
    block: {
      devices: [{ type: "disk", deviceId: "benchmark-disk", path: "/dev/benchmark", size: 1_000_000 + index }],
      filesystems: [{ deviceId: "benchmark-disk", uuid: "benchmark-root", type: index < 50 ? "ext4" : "xfs", mountpoints: ["/"] }],
      mounts: [{ source: "/dev/benchmark", target: "/", size: 1_000_000, used: index * 1_000 }],
    },
    network: { interfaces: [{ ifname: "eth0", address: "02:00:00:00:00:01" }] },
    health: { smart: [{ deviceId: "benchmark-disk", passed: true, pendingSectors: index > 90 ? index - 90 : 0 }], nvme: [], kernelWarnings: [] },
  };
}

async function timed(operation) {
  const started = performance.now();
  const value = await operation();
  return { durationMs: performance.now() - started, value };
}

async function samples(operation) {
  const values = [];
  let last;
  for (let index = 0; index < repeats; index += 1) {
    const result = await timed(operation);
    values.push(result.durationMs);
    last = result.value;
  }
  return { summary: summarize(values), last };
}

let store;
try {
  store = createContinuityStore({ root });
  await store.init();
  const ingestStarted = performance.now();
  for (let index = 0; index < inventoryCount; index += 1) await store.ingestInventory("benchmark-agent", inventory(index));
  for (let index = 0; index < eventCount; index += 1) {
    await store.ingestObservation({
      id: `benchmark-event-${index}`,
      type: index % 10 === 0 ? "health.observation" : index % 7 === 0 ? "case.event" : "observation",
      timestamp: new Date(Date.UTC(2025, 1, 1) + index * 1_000).toISOString(),
      machineId: "continuity-benchmark-machine",
      entityId: `entity-${index % 250}`,
      caseId: `case-${index % 40}`,
      diskIds: ["benchmark-disk"],
      health: index % 10 === 0,
      text: `generated continuity corpus storage group-${index % 100} sequence-${index}`,
    });
  }
  const ingestDurationMs = performance.now() - ingestStarted;
  const beforeReload = store.getStats();
  await store.close();
  store = createContinuityStore({ root });
  const reload = await timed(() => store.init());
  const machineId = store.listMachines()[0].id;
  const textSearch = await samples(() => store.search({ text: "storage group-42", limit: 2_000 }));
  const indexedComposite = await samples(() => store.search({
    machineId, diskId: "benchmark-disk", caseId: "case-0", health: true,
    from: "2025-02-01T00:00:00.000Z", to: "2025-02-02T00:00:00.000Z", limit: 2_000,
  }));
  const timelineRange = await samples(() => store.getTimeline(machineId, {
    from: "2025-02-01T12:00:00.000Z", to: "2025-02-01T13:00:00.000Z",
  }));
  const semanticDiff = await samples(() => store.diffMachine(
    machineId, inventory(0).collectedAt, inventory(inventoryCount - 1).collectedAt,
  ));
  const result = {
    kind: "workwire-continuity-history-benchmark",
    capturedAt: new Date().toISOString(), environment: environmentRecord(),
    configuration: { root, temporary, eventCount, inventoryCount, totalRecords: eventCount + inventoryCount, repeats },
    ingest: { durationMs: Number(ingestDurationMs.toFixed(3)), recordsPerSecond: Number(((eventCount + inventoryCount) / (ingestDurationMs / 1000)).toFixed(1)) },
    reload: { durationMs: Number(reload.durationMs.toFixed(3)), stats: store.getStats() },
    queries: {
      textSearch: { ...textSearch.summary, resultCount: textSearch.last.length },
      indexedComposite: { ...indexedComposite.summary, resultCount: indexedComposite.last.length },
      timelineRange: { ...timelineRange.summary, resultCount: timelineRange.last.length },
      semanticDiff: { ...semanticDiff.summary, changed: semanticDiff.last.changed },
    },
    assertions: {
      beforeReloadEventCount: beforeReload.eventCount,
      afterReloadEventCount: store.getStats().eventCount,
      onePhysicalMachine: store.getStats().machineCount === 1,
      completeReload: store.getStats().eventCount === eventCount + inventoryCount,
    },
  };
  if (!result.assertions.onePhysicalMachine || !result.assertions.completeReload) throw new Error(`Continuity benchmark assertion failed: ${JSON.stringify(result.assertions)}`);
  await emitResult(result, { output: args.output || "" });
} finally {
  await store?.close().catch(() => {});
  if (temporary && !args["keep-root"]) await fs.rm(root, { recursive: true, force: true });
}
