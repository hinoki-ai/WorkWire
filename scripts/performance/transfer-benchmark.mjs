import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createLocalEndpoint, createRemoteEndpoint } from "../../lib/ww-endpoint.mjs";
import { createWwService } from "../../lib/ww-service.mjs";
import { transferSelections } from "../../lib/ww-transfer.mjs";
import {
  emitResult,
  environmentRecord,
  listArg,
  measureSamples,
  numberArg,
  parseArgs,
  summarize,
} from "./common.mjs";

const MIB = 1024 * 1024;
const args = parseArgs();
const sizesMiB = listArg(args["sizes-mib"], [0, 0.0625, 100, 384]);
const sizes = sizesMiB.map((value) => Math.round(value * MIB));
const repeats = numberArg(args.repeats, 3, { min: 2, max: 10 });
const concurrentTransfers = numberArg(args["concurrent-transfers"], 4, { min: 0, max: 32 });
const concurrentSizeMiB = numberArg(args["concurrent-size-mib"], 100, { min: 0, max: 2_048 });
const modes = String(args.modes || "local,loopback-upload,loopback-download")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ww-perf-transfer-"));
const sourceRoot = path.join(root, "source");
const localDestinationRoot = path.join(root, "local-destination");
const serviceDestinationRoot = path.join(root, "service-destination");
const downloadDestinationRoot = path.join(root, "download-destination");
await Promise.all([
  fsp.mkdir(sourceRoot),
  fsp.mkdir(localDestinationRoot),
  fsp.mkdir(serviceDestinationRoot),
  fsp.mkdir(downloadDestinationRoot),
]);

function activeHandleCounts() {
  const counts = {};
  for (const handle of process._getActiveHandles()) {
    const name = handle?.constructor?.name || typeof handle;
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

async function prepareFile(targetPath, size, seed) {
  const handle = await fsp.open(targetPath, "w");
  try {
    await handle.truncate(size);
    if (size > 0) {
      const pattern = crypto.createHash("sha256").update(`${seed}:${size}`).digest();
      const block = Buffer.alloc(Math.min(64 * 1024, size));
      for (let offset = 0; offset < block.length; offset += 1) {
        block[offset] = pattern[offset % pattern.length] ^ (offset & 0xff);
      }
      await handle.write(block, 0, block.length, 0);
      if (size > block.length) {
        await handle.write(block, 0, Math.min(block.length, size - block.length), size - Math.min(block.length, size - block.length));
      }
    }
  } finally {
    await handle.close();
  }
}

async function sha256File(targetPath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(targetPath, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function throughputSummary(bytes, samplesMs) {
  if (bytes === 0) return summarize(samplesMs.map(() => 0));
  return summarize(samplesMs.map((durationMs) => (bytes / MIB) / (durationMs / 1_000)));
}

const sourceEndpoint = createLocalEndpoint({ name: "perf-source", rootPath: sourceRoot });
const localDestinationEndpoint = createLocalEndpoint({ name: "perf-local-destination", rootPath: localDestinationRoot });
let service = createWwService({
  host: "127.0.0.1",
  port: 0,
  machineId: "ww_perf_transfer_service",
  token: "perf-transfer-token",
  rootPath: serviceDestinationRoot,
  recoverPortCollision: false,
});
let serviceInfo = null;
let serviceDestinationEndpoint = null;
let serviceSourceEndpoint = null;
const results = [];
const handlesBefore = activeHandleCounts();

try {
  serviceInfo = await service.start();
  serviceDestinationEndpoint = createRemoteEndpoint({
    host: "127.0.0.1",
    port: serviceInfo.port,
    token: "perf-transfer-token",
    localMachineId: "ww_perf_transfer_client",
    transferTimeoutMs: 30 * 60 * 1_000,
  });
  serviceSourceEndpoint = serviceDestinationEndpoint;

  for (const size of sizes) {
    const fileName = `payload-${size}.bin`;
    const remoteFileName = `remote-${fileName}`;
    const sourcePath = path.join(sourceRoot, fileName);
    const serviceSourcePath = path.join(serviceDestinationRoot, remoteFileName);
    await prepareFile(sourcePath, size, fileName);
    await prepareFile(serviceSourcePath, size, `remote-${fileName}`);
    const localSourceHash = await sha256File(sourcePath);
    const remoteSourceHash = await sha256File(serviceSourcePath);

    for (const mode of modes) {
      let source;
      let destination;
      let transferSourcePath;
      let destinationDir;
      let destinationPath;
      let expectedHash;
      let pingClient = null;
      if (mode === "local") {
        source = sourceEndpoint;
        destination = localDestinationEndpoint;
        transferSourcePath = sourcePath;
        destinationDir = localDestinationRoot;
        destinationPath = path.join(localDestinationRoot, fileName);
        expectedHash = localSourceHash;
      } else if (mode === "loopback-upload") {
        source = sourceEndpoint;
        destination = serviceDestinationEndpoint;
        transferSourcePath = sourcePath;
        destinationDir = serviceDestinationRoot;
        destinationPath = path.join(serviceDestinationRoot, fileName);
        expectedHash = localSourceHash;
        pingClient = serviceDestinationEndpoint;
      } else if (mode === "loopback-download") {
        source = serviceSourceEndpoint;
        destination = createLocalEndpoint({ name: "perf-download-destination", rootPath: downloadDestinationRoot });
        transferSourcePath = serviceSourcePath;
        destinationDir = downloadDestinationRoot;
        destinationPath = path.join(downloadDestinationRoot, remoteFileName);
        expectedHash = remoteSourceHash;
        pingClient = serviceDestinationEndpoint;
      } else {
        throw new Error(`Unknown transfer benchmark mode: ${mode}`);
      }

      const controlLatenciesMs = [];
      let controlFailures = 0;
      let progressEvents = 0;
      const measurement = await measureSamples(async () => {
        await fsp.rm(destinationPath, { recursive: true, force: true });
        let pingInFlight = false;
        const controlTimer = pingClient ? setInterval(() => {
          if (pingInFlight) return;
          pingInFlight = true;
          const startedAt = performance.now();
          void pingClient.ping({ timeoutMs: 5_000 }).then(() => {
            controlLatenciesMs.push(performance.now() - startedAt);
          }, () => {
            controlFailures += 1;
          }).finally(() => {
            pingInFlight = false;
          });
        }, 50) : null;
        controlTimer?.unref?.();

        const startedAt = performance.now();
        let result;
        try {
          result = await transferSelections({
            sourceEndpoint: source,
            destinationEndpoint: destination,
            sourcePaths: [transferSourcePath],
            destinationDir,
            conflictPolicy: "overwrite",
            onProgress() {
              progressEvents += 1;
            },
          });
        } finally {
          if (controlTimer) clearInterval(controlTimer);
        }
        const transferDurationMs = performance.now() - startedAt;
        const stats = await fsp.stat(destinationPath);
        const actualHash = await sha256File(destinationPath);
        if (stats.size !== size || actualHash !== expectedHash || result.transferredBytes !== size) {
          throw new Error(`Transfer verification failed for ${mode} at ${size} bytes.`);
        }
        return {
          transferDurationMs,
          bytes: stats.size,
          sha256: actualHash,
        };
      }, { repeats, warmups: 0, sampleMemoryEveryMs: 2 });

      const transferDurationsMs = measurement.outputs.map((output) => output.transferDurationMs);
      results.push({
        mode,
        sizeBytes: size,
        sizeMiB: Number((size / MIB).toFixed(4)),
        repeats,
        transferDurationMs: summarize(transferDurationsMs),
        throughputMiBPerSecond: throughputSummary(size, transferDurationsMs),
        progressCallbackCountTotal: progressEvents,
        progressCallbacksPerTransfer: Number((progressEvents / repeats).toFixed(3)),
        controlPingLatencyMs: summarize(controlLatenciesMs),
        controlPingFailures: controlFailures,
        verification: {
          exactSize: true,
          incrementalSha256: true,
          sha256: measurement.outputs[0]?.sha256 || expectedHash,
        },
        resources: measurement.resources,
      });
    }
  }

  if (concurrentTransfers > 0 && concurrentSizeMiB > 0) {
    const concurrentSize = Math.round(concurrentSizeMiB * MIB);
    const concurrentFiles = await Promise.all(Array.from({ length: concurrentTransfers }, async (_, index) => {
      const name = `concurrent-${index}-${concurrentSize}.bin`;
      const sourcePath = path.join(sourceRoot, name);
      const destinationPath = path.join(serviceDestinationRoot, name);
      await prepareFile(sourcePath, concurrentSize, name);
      return {
        name,
        sourcePath,
        destinationPath,
        expectedHash: await sha256File(sourcePath),
      };
    }));
    const controlLatenciesMs = [];
    let controlFailures = 0;
    let progressEvents = 0;
    const measurement = await measureSamples(async () => {
      await Promise.all(concurrentFiles.map((file) => fsp.rm(file.destinationPath, { force: true })));
      let pingInFlight = false;
      const controlTimer = setInterval(() => {
        if (pingInFlight) return;
        pingInFlight = true;
        const startedAt = performance.now();
        void serviceDestinationEndpoint.ping({ timeoutMs: 5_000 }).then(() => {
          controlLatenciesMs.push(performance.now() - startedAt);
        }, () => {
          controlFailures += 1;
        }).finally(() => {
          pingInFlight = false;
        });
      }, 50);
      controlTimer.unref?.();
      const startedAt = performance.now();
      let transferResults;
      try {
        transferResults = await Promise.all(concurrentFiles.map((file) => transferSelections({
          sourceEndpoint,
          destinationEndpoint: serviceDestinationEndpoint,
          sourcePaths: [file.sourcePath],
          destinationDir: serviceDestinationRoot,
          conflictPolicy: "overwrite",
          onProgress() { progressEvents += 1; },
        })));
      } finally {
        clearInterval(controlTimer);
      }
      const transferDurationMs = performance.now() - startedAt;
      for (let index = 0; index < concurrentFiles.length; index += 1) {
        const file = concurrentFiles[index];
        const stats = await fsp.stat(file.destinationPath);
        const actualHash = await sha256File(file.destinationPath);
        if (
          stats.size !== concurrentSize
          || actualHash !== file.expectedHash
          || transferResults[index].transferredBytes !== concurrentSize
        ) throw new Error(`Concurrent transfer verification failed for ${file.name}.`);
      }
      return { transferDurationMs };
    }, { repeats, warmups: 0, sampleMemoryEveryMs: 2 });
    const transferDurationsMs = measurement.outputs.map((output) => output.transferDurationMs);
    const aggregateBytes = concurrentSize * concurrentTransfers;
    results.push({
      mode: `loopback-upload-concurrent-${concurrentTransfers}`,
      concurrentTransfers,
      sizeBytesPerTransfer: concurrentSize,
      aggregateSizeBytes: aggregateBytes,
      repeats,
      transferDurationMs: summarize(transferDurationsMs),
      aggregateThroughputMiBPerSecond: throughputSummary(aggregateBytes, transferDurationsMs),
      perTransferThroughputMiBPerSecond: throughputSummary(concurrentSize, transferDurationsMs),
      progressCallbackCountTotal: progressEvents,
      progressCallbacksPerTransfer: Number((progressEvents / (repeats * concurrentTransfers)).toFixed(3)),
      controlPingLatencyMs: summarize(controlLatenciesMs),
      controlPingFailures: controlFailures,
      verification: { exactSize: true, incrementalSha256: true, files: concurrentTransfers },
      resources: measurement.resources,
    });
  }
} finally {
  await service?.stop().catch(() => {});
  service = null;
  globalThis.gc?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const handlesAfterStop = activeHandleCounts();
await fsp.rm(root, { recursive: true, force: true });

await emitResult({
  benchmark: "transfer-throughput-and-memory",
  scopeNote: "Active Files transfer paths are measured. Recovery artifacts, range/resume, and command output are future phases and are not mocked.",
  conditions: {
    modes,
    sizesBytes: sizes,
    repeats,
    concurrentTransfers,
    concurrentSizeMiB,
    sourceGeneration: "sparse file with deterministic binary head/tail blocks",
    transport: "same-host ext4 and HTTP loopback",
    verification: "incremental SHA-256 after every transfer",
    controlProbeIntervalMs: 50,
  },
  environment: environmentRecord(),
  lifecycle: { handlesBefore, handlesAfterStop },
  results,
}, { output: String(args.output || "") });
