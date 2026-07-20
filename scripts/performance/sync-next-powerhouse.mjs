import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSalvageEngine } from "../../lib/salvage/index.mjs";
import { createWorkWireSyncEngine } from "../../lib/sync/index.mjs";

const MiB = 1024 * 1024;
const base = await fs.mkdtemp(path.join(os.tmpdir(), "ww-sync-benchmark-"));
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function throughput(bytes, milliseconds) {
  return Number((bytes / MiB / (milliseconds / 1000)).toFixed(2));
}

async function writePattern(target, bytes, value) {
  const handle = await fs.open(target, "w");
  const block = Buffer.alloc(MiB, value);
  try {
    for (let offset = 0; offset < bytes; offset += block.length) await handle.write(block, 0, Math.min(block.length, bytes - offset), offset);
  } finally {
    await handle.close();
  }
}

const results = { benchmark: "sync-next-powerhouse", at: new Date().toISOString() };
let engine;
let salvage;
try {
  const left = path.join(base, "left");
  const right = path.join(base, "right");
  const third = path.join(base, "third");
  await Promise.all([left, right, third].map((root) => fs.mkdir(root)));
  const largePath = path.join(left, "large.bin");
  const largeBytes = 16 * MiB;
  await writePattern(largePath, largeBytes, 0x21);
  engine = createWorkWireSyncEngine({ stateDir: path.join(base, "sync-state"), machineId: "bench-a" });
  await engine.init();
  await engine.addPeer({ id: "bench-b", rootPath: right });
  await engine.addFolder({ id: "bench", rootPath: left, peers: ["bench-b"], chunkSize: MiB, largeFileThreshold: 0, concurrency: 4 });

  let started = process.hrtime.bigint();
  const full = await engine.sync("bench");
  const fullMs = elapsedMs(started);
  const handle = await fs.open(largePath, "r+");
  await handle.write(Buffer.alloc(MiB, 0x72), 0, MiB, 7 * MiB);
  await handle.close();
  started = process.hrtime.bigint();
  const delta = await engine.sync("bench");
  const deltaMs = elapsedMs(started);
  results.fullCopy = { bytes: full.transferredBytes, milliseconds: Number(fullMs.toFixed(2)), throughputMiBPerSecond: throughput(full.transferredBytes, fullMs) };
  results.deltaUpdate = {
    logicalBytes: largeBytes,
    transferredBytes: delta.transferredBytes,
    reusedBytes: delta.reusedBytes,
    bytesAvoided: largeBytes - delta.transferredBytes,
    percentAvoided: Number((((largeBytes - delta.transferredBytes) / largeBytes) * 100).toFixed(2)),
    milliseconds: Number(deltaMs.toFixed(2)),
  };

  await writePattern(largePath, largeBytes, 0x45);
  const controller = new AbortController();
  const interruptedAt = process.hrtime.bigint();
  try {
    await engine.sync("bench", { signal: controller.signal, onProgress(progress) { if (progress.processedBytes >= 4 * MiB) controller.abort(); } });
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  }
  const interruptMs = elapsedMs(interruptedAt);
  await engine.close();
  engine = createWorkWireSyncEngine({ stateDir: path.join(base, "sync-state"), machineId: "bench-a" });
  await engine.init();
  started = process.hrtime.bigint();
  const resumed = await engine.sync("bench");
  const resumeMs = elapsedMs(started);
  results.largeFileRestart = { interruptionMilliseconds: Number(interruptMs.toFixed(2)), resumeMilliseconds: Number(resumeMs.toFixed(2)), resumedTransferredBytes: resumed.transferredBytes, restartCostMilliseconds: Number(resumeMs.toFixed(2)) };

  const smallRoot = path.join(left, "small");
  await fs.mkdir(smallRoot);
  await Promise.all(Array.from({ length: 500 }, (_, index) => fs.writeFile(path.join(smallRoot, `file-${String(index).padStart(4, "0")}.txt`), Buffer.alloc(1024, index % 251))));
  started = process.hrtime.bigint();
  const small = await engine.sync("bench");
  const smallMs = elapsedMs(started);
  results.manySmallFiles = { files: 500, bytes: small.transferredBytes, milliseconds: Number(smallMs.toFixed(2)), filesPerSecond: Number((500 / (smallMs / 1000)).toFixed(2)) };

  await engine.addPeer({ id: "bench-c", rootPath: third });
  await engine.updateFolder("bench", { peers: ["bench-b", "bench-c"] });
  await fs.writeFile(path.join(left, "three-peer.txt"), "converge");
  started = process.hrtime.bigint();
  const convergence = await engine.sync("bench");
  const convergenceMs = elapsedMs(started);
  results.threePeerConvergence = { peers: 3, milliseconds: Number(convergenceMs.toFixed(2)), transferredBytes: convergence.transferredBytes, converged: await fs.readFile(path.join(third, "three-peer.txt"), "utf8") === "converge" };
  await engine.close();
  engine = null;

  const salvageSource = path.join(base, "salvage-source");
  const salvageDestination = path.join(base, "salvage-destination");
  await fs.mkdir(salvageSource);
  await writePattern(path.join(salvageSource, "critical.bin"), 8 * MiB, 0x66);
  const salvageState = path.join(base, "salvage-state");
  salvage = createSalvageEngine({ stateDir: salvageState });
  await salvage.init();
  const inventory = await salvage.inventory(salvageSource, { explicitPaths: ["critical.bin"] });
  await salvage.buildPlan(inventory, [{ path: salvageDestination, capacityBytes: 16 * MiB }], { id: "restart", chunkSize: MiB });
  const salvageController = new AbortController();
  try {
    await salvage.run("restart", { signal: salvageController.signal, onProgress(progress) { if (progress.offset >= 2 * MiB) salvageController.abort(); } });
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  }
  const checkpointBytes = salvage.getJob("restart").files[0].offset;
  await salvage.close();
  salvage = createSalvageEngine({ stateDir: salvageState });
  await salvage.init();
  started = process.hrtime.bigint();
  const salvageReport = await salvage.resume("restart");
  const salvageResumeMs = elapsedMs(started);
  results.salvageRestart = { logicalBytes: 8 * MiB, checkpointBytes, resumeMilliseconds: Number(salvageResumeMs.toFixed(2)), restartCostMilliseconds: Number(salvageResumeMs.toFixed(2)), recovered: salvageReport.recovered };
} finally {
  clearInterval(sampler);
  await engine?.close().catch(() => {});
  await salvage?.close().catch(() => {});
  results.memory = { peakRssBytes: peakRss, peakRssMiB: Number((peakRss / MiB).toFixed(2)) };
  await fs.rm(base, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
