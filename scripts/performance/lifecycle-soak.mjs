import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createRemoteWwClient } from "../../lib/ww-client.mjs";
import { createWwService } from "../../lib/ww-service.mjs";
import {
  emitResult,
  environmentRecord,
  numberArg,
  parseArgs,
} from "./common.mjs";

const args = parseArgs();
const durationSeconds = numberArg(args["duration-seconds"], 60, { min: 5, max: 3_600 });
const maximumIterations = numberArg(args.iterations, 10_000, { min: 10, max: 1_000_000 });
const sampleEvery = numberArg(args["sample-every"], 25, { min: 5, max: 1_000 });
const restartEvery = numberArg(args["restart-every"], 100, { min: 10, max: 10_000 });
const payloadBytes = numberArg(args["payload-bytes"], 256 * 1024, { min: 0, max: 64 * 1024 * 1024 });
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-perf-soak-"));
const portalRoot = path.join(root, "Portal");
await fs.mkdir(portalRoot);

function activeHandleCounts() {
  const counts = {};
  for (const handle of process._getActiveHandles()) {
    const name = handle?.constructor?.name || typeof handle;
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

async function openFileDescriptorCount() {
  try {
    return (await fs.readdir("/proc/self/fd")).length;
  } catch {
    return null;
  }
}

function linearSlope(samples, field) {
  if (samples.length < 2) return 0;
  const meanX = samples.reduce((total, sample) => total + sample.iteration, 0) / samples.length;
  const meanY = samples.reduce((total, sample) => total + sample[field], 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    numerator += (sample.iteration - meanX) * (sample[field] - meanY);
    denominator += (sample.iteration - meanX) ** 2;
  }
  return denominator ? numerator / denominator : 0;
}

const warnings = [];
const warningHandler = (warning) => warnings.push({
  name: String(warning?.name || "Warning"),
  message: String(warning?.message || warning).slice(0, 500),
});
process.on("warning", warningHandler);

let service = createWwService({
  host: "127.0.0.1",
  port: 0,
  token: "soak-token",
  machineId: "ww_perf_soak_service",
  rootPath: root,
  recoverPortCollision: false,
});
let serviceInfo;
let client;
const samples = [];
const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();
const handlesBefore = activeHandleCounts();
const fdsBefore = await openFileDescriptorCount();
const cpuStart = process.cpuUsage();
const utilizationStart = performance.eventLoopUtilization();
const startedAt = performance.now();
let iterations = 0;
let transferredBytes = 0;
let restartCycles = 0;

function connectClient() {
  client = createRemoteWwClient({
    host: "127.0.0.1",
    port: serviceInfo.port,
    token: "soak-token",
    localMachineId: "ww_perf_soak_client",
    transferTimeoutMs: 30_000,
  });
}

async function sample() {
  globalThis.gc?.();
  await new Promise((resolve) => setImmediate(resolve));
  const memory = process.memoryUsage();
  samples.push({
    iteration: iterations,
    elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    activeHandles: process._getActiveHandles().length,
    activeRequests: process._getActiveRequests().length,
    fileDescriptors: await openFileDescriptorCount(),
  });
}

try {
  serviceInfo = await service.start();
  connectClient();
  await client.connect();
  await sample();
  while (
    iterations < maximumIterations
    && performance.now() - startedAt < durationSeconds * 1_000
  ) {
    iterations += 1;
    await client.ping();
    if (iterations % 5 === 0) {
      const targetPath = path.join(portalRoot, `cycle-${iterations % 7}.bin`);
      let remaining = payloadBytes;
      const stream = new Readable({
        read() {
          if (remaining <= 0) {
            this.push(null);
            return;
          }
          const size = Math.min(64 * 1024, remaining);
          remaining -= size;
          this.push(Buffer.alloc(size, iterations & 0xff));
        },
      });
      await client.uploadFileStream(targetPath, stream, { overwrite: true });
      const download = await client.createDownloadStream(targetPath);
      let downloaded = 0;
      for await (const chunk of download.stream) downloaded += chunk.length;
      if (downloaded !== payloadBytes) throw new Error("Soak download size mismatch.");
      transferredBytes += downloaded * 2;
    }
    if (iterations % 10 === 0) {
      const listing = await client.listDirectory({ path: portalRoot, includeHidden: true });
      if (!Array.isArray(listing.items)) throw new Error("Soak listing was invalid.");
    }
    if (iterations % restartEvery === 0) {
      const stablePort = serviceInfo.port;
      await service.stop();
      service = createWwService({
        host: "127.0.0.1",
        port: stablePort,
        token: "soak-token",
        machineId: "ww_perf_soak_service",
        rootPath: root,
        recoverPortCollision: false,
      });
      serviceInfo = await service.start();
      connectClient();
      await client.connect();
      restartCycles += 1;
    }
    if (iterations % sampleEvery === 0) await sample();
  }
  await sample();
} finally {
  histogram.disable();
  await service?.stop().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
  process.removeListener("warning", warningHandler);
}

globalThis.gc?.();
await new Promise((resolve) => setTimeout(resolve, 50));
const handlesAfter = activeHandleCounts();
const fdsAfter = await openFileDescriptorCount();
const cpu = process.cpuUsage(cpuStart);
const utilization = performance.eventLoopUtilization(utilizationStart);
const plateauSamples = samples.slice(Math.floor(samples.length / 3));
const heapSlopeBytesPerIteration = linearSlope(plateauSamples, "heapUsedBytes");
const rssSlopeBytesPerIteration = linearSlope(plateauSamples, "rssBytes");
const firstPlateau = plateauSamples[0] || samples[0];
const lastPlateau = plateauSamples.at(-1) || samples.at(-1);
const maxListenersWarning = warnings.some((warning) => warning.name === "MaxListenersExceededWarning");
const leakDetected = maxListenersWarning
  || (lastPlateau?.heapUsedBytes - firstPlateau?.heapUsedBytes > 64 * 1024 * 1024
    && heapSlopeBytesPerIteration > 64 * 1024)
  || (fdsAfter != null && fdsBefore != null && fdsAfter > fdsBefore + 4);

await emitResult({
  benchmark: "active-service-transfer-lifecycle-soak",
  scopeNote: "Exercises the implemented HTTP service, client, streaming upload/download, listing, reconnect, and shutdown paths. Recovery jobs/SSE/inventory do not exist yet.",
  conditions: {
    requestedDurationSeconds: durationSeconds,
    maximumIterations,
    sampleEvery,
    restartEvery,
    payloadBytes,
  },
  environment: environmentRecord(),
  results: {
    actualDurationMs: Number((performance.now() - startedAt).toFixed(3)),
    iterations,
    restartCycles,
    transferredBytes,
    samples,
    plateau: {
      sampleCount: plateauSamples.length,
      heapSlopeBytesPerIteration: Number(heapSlopeBytesPerIteration.toFixed(3)),
      rssSlopeBytesPerIteration: Number(rssSlopeBytesPerIteration.toFixed(3)),
      heapChangeBytes: (lastPlateau?.heapUsedBytes || 0) - (firstPlateau?.heapUsedBytes || 0),
      rssChangeBytes: (lastPlateau?.rssBytes || 0) - (firstPlateau?.rssBytes || 0),
    },
    eventLoopDelayMs: {
      mean: Number((histogram.mean / 1e6).toFixed(3)),
      p95: Number((histogram.percentile(95) / 1e6).toFixed(3)),
      p99: Number((histogram.percentile(99) / 1e6).toFixed(3)),
      max: Number((histogram.max / 1e6).toFixed(3)),
    },
    eventLoopUtilization: Number(utilization.utilization.toFixed(6)),
    cpuUserMs: Number((cpu.user / 1_000).toFixed(3)),
    cpuSystemMs: Number((cpu.system / 1_000).toFixed(3)),
    handlesBefore,
    handlesAfter,
    fdsBefore,
    fdsAfter,
    warnings,
    leakDetected,
  },
}, { output: String(args.output || "") });

if (leakDetected) process.exitCode = 1;
