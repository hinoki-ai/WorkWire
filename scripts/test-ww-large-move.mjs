#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BYTES = 4 * 1024 * 1024 * 1024;

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (["managed", "json", "one-way"].includes(key)) {
      flags[key] = true;
      continue;
    }
    if (argv[index + 1] === undefined) throw new TypeError(`--${key} requires a value.`);
    flags[key] = String(argv[index + 1]);
    index += 1;
  }
  return flags;
}

function assert(condition, message, code = "ERR_WW_LARGE_MOVE_ASSERTION") {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

function secondsSince(started) {
  return Number(process.hrtime.bigint() - started) / 1e9;
}

function mibPerSecond(bytes, seconds) {
  return seconds > 0 ? Number((bytes / 1024 / 1024 / seconds).toFixed(2)) : 0;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function hashZeroBytes(bytes) {
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  let remaining = bytes;
  while (remaining > 0) {
    const size = Math.min(chunk.length, remaining);
    hash.update(size === chunk.length ? chunk : chunk.subarray(0, size));
    remaining -= size;
    if (remaining % (32 * 1024 * 1024) === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return hash.digest("hex");
}

async function hashDownload(endpoint, targetPath) {
  const download = await endpoint.createDownloadStream(targetPath, { timeoutMs: 0 });
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of download.stream) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, hash: hash.digest("hex") };
}

async function hashDownloadWithMutationHeartbeat(endpoint, targetPath, {
  heartbeatEndpoint,
  heartbeatPath,
} = {}) {
  let stopped = false;
  let heartbeatFailure = null;
  const heartbeat = (async () => {
    while (!stopped) {
      await delay(1_500);
      if (stopped) break;
      try {
        await heartbeatEndpoint.createFile({
          path: heartbeatPath,
          contents: `${new Date().toISOString()}\n`,
          overwrite: true,
        });
      } catch (error) {
        heartbeatFailure = error;
        break;
      }
    }
  })();
  try {
    const result = await hashDownload(endpoint, targetPath);
    if (heartbeatFailure) throw heartbeatFailure;
    return result;
  } finally {
    stopped = true;
    await heartbeat;
  }
}

async function statOrNull(endpoint, targetPath) {
  return endpoint.stat({ path: targetPath, allowMissing: true });
}

async function deleteIfPresent(endpoint, targetPath) {
  if (!await statOrNull(endpoint, targetPath).catch(() => null)) return true;
  const result = await endpoint.deletePaths({ paths: [targetPath] });
  return result.every((entry) => entry?.ok === true);
}

const flags = parseArgs();
if (flags.managed || (process.platform !== "win32" && !process.env.WW_CONFIG_DIR)) {
  process.env.WW_PORTAL_PATH = process.env.WW_PORTAL_PATH || repoRoot;
  process.env.WW_HOME_DIR = process.env.WW_HOME_DIR || path.join(repoRoot, ".workwire");
  process.env.WW_CONFIG_DIR = process.env.WW_CONFIG_DIR || path.join(repoRoot, ".workwire", "config");
}

const [{ loadWwConfig }, { createRemoteWwClient }, { transferSelections }, { buildWwReleaseInfo }] = await Promise.all([
  import("../lib/ww-config-store.mjs"),
  import("../lib/ww-client.mjs"),
  import("../lib/ww-transfer.mjs"),
  import("../lib/ww-release.mjs"),
]);

const bytes = Number(flags.bytes || DEFAULT_BYTES);
assert(Number.isSafeInteger(bytes) && bytes > 0, "--bytes must be a positive safe integer.");
const config = await loadWwConfig();
const release = await buildWwReleaseInfo({ baseDir: repoRoot });
const localHost = ["0.0.0.0", "::", ""].includes(String(config.service.host || ""))
  ? "127.0.0.1"
  : config.service.host;
const local = createRemoteWwClient({
  host: localHost,
  port: config.service.port,
  token: config.service.token,
  localMachineId: config.service.machineId,
  localService: true,
  transferTimeoutMs: 0,
});
const remote = createRemoteWwClient({
  ...config.peer,
  localMachineId: config.service.machineId,
  transferTimeoutMs: 0,
});

const runName = `.ww-large-move-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
const relativeRunRoot = path.posix.join("Portal", runName);
let localInfo = null;
let remoteInfo = null;
let sourcePath = "";
let destinationPath = "";
let expectedHash = "";
let sourcePhysicalBytes = null;
let forwardResult = null;
let reverseResult = null;
let forwardSeconds = 0;
let reverseSeconds = 0;
let remoteVerifySeconds = 0;
let localVerifySeconds = 0;
let hashPreparationSeconds = 0;
let returnedPath = "";
let failure = null;
let stage = "connect";
let cleanupOk = false;
let peakRssBytes = process.memoryUsage().rss;
let peakHeapBytes = process.memoryUsage().heapUsed;
let pingSamples = 0;
let pingFailures = 0;
let maximumPingMs = 0;
let pingRunning = false;

const memoryTimer = setInterval(() => {
  const memory = process.memoryUsage();
  peakRssBytes = Math.max(peakRssBytes, memory.rss);
  peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed);
}, 250);
memoryTimer.unref?.();

const pingTimer = setInterval(async () => {
  if (pingRunning || !localInfo || !remoteInfo) return;
  pingRunning = true;
  const started = process.hrtime.bigint();
  try {
    await Promise.all([local.ping({ timeoutMs: 3_000 }), remote.ping({ timeoutMs: 3_000 })]);
    maximumPingMs = Math.max(maximumPingMs, secondsSince(started) * 1_000);
    pingSamples += 1;
  } catch {
    pingFailures += 1;
  } finally {
    pingRunning = false;
  }
}, 5_000);
pingTimer.unref?.();

try {
  [localInfo, remoteInfo] = await Promise.all([
    local.getInfo({ timeoutMs: 5_000 }),
    remote.getInfo({ timeoutMs: 5_000 }),
  ]);
  assert(localInfo.machineId === config.service.machineId, "Local file identity is not pinned.");
  assert(remoteInfo.machineId === config.peer.machineId, "Remote file identity is not pinned.");
  assert(localInfo.versions?.app === release.version, "HINOKI is not running the current source release.");
  assert(remoteInfo.versions?.app === release.version, "Sakura is not running the current source release.");

  stage = "expected-hash";
  const hashStarted = process.hrtime.bigint();
  expectedHash = await hashZeroBytes(bytes);
  hashPreparationSeconds = secondsSince(hashStarted);

  const localRunRoot = path.posix.join("Portal", runName);
  const remoteRunRoot = path.win32.join("Portal", runName);
  const remoteDestinationDirectory = path.win32.join(remoteRunRoot, "destination");
  const remoteHeartbeatPath = path.win32.join(remoteRunRoot, ".mirror-pause");
  await remote.createDirectory({ path: remoteDestinationDirectory });

  stage = "sparse-fixture";
  const absoluteSourceDirectory = path.resolve(localInfo.rootPath, localRunRoot, "source");
  const absoluteSourcePath = path.join(absoluteSourceDirectory, "fake-4GiB.zero");
  assert(
    absoluteSourcePath.startsWith(`${path.resolve(localInfo.rootPath, "Portal")}${path.sep}`),
    "Sparse fixture escaped the Portal directory.",
  );
  await fs.mkdir(absoluteSourceDirectory, { recursive: true });
  const handle = await fs.open(absoluteSourcePath, "wx", 0o600);
  try {
    await handle.truncate(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const sparseStats = await fs.stat(absoluteSourcePath);
  sourcePhysicalBytes = Number.isFinite(Number(sparseStats.blocks))
    ? Number(sparseStats.blocks) * 512
    : null;
  sourcePath = path.posix.join(localRunRoot, "source", "fake-4GiB.zero");

  stage = "move";
  const transferStarted = process.hrtime.bigint();
  forwardResult = await transferSelections({
    sourceEndpoint: local,
    destinationEndpoint: remote,
    sourcePaths: [sourcePath],
    destinationDir: remoteDestinationDirectory,
    conflictPolicy: "overwrite",
    move: true,
    onProgress(event) {
      if (event?.result) {
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      }
    },
  });
  forwardSeconds = secondsSince(transferStarted);
  destinationPath = String(forwardResult.items?.[0]?.targetPath || "");
  assert(forwardResult.items?.[0]?.deletedSource === true, "The HINOKI to Sakura 4 GiB move did not delete its source.");
  assert(!await statOrNull(local, sourcePath), "The 4 GiB source still exists after move completion.");
  const destinationRecord = await statOrNull(remote, destinationPath);
  assert(destinationRecord?.size === bytes, "The 4 GiB destination logical size is wrong.");

  stage = "destination-hash";
  const verifyStarted = process.hrtime.bigint();
  const destinationHash = await hashDownload(remote, destinationPath);
  remoteVerifySeconds = secondsSince(verifyStarted);
  assert(destinationHash.bytes === bytes, "The destination verification stream returned the wrong byte count.");
  assert(destinationHash.hash === expectedHash, "The destination SHA-256 differs from the sparse zero fixture.");

  if (!flags["one-way"]) {
    stage = "return-move";
    await remote.createFile({ path: remoteHeartbeatPath, contents: "return-move\n", overwrite: true });
    const localReturnDirectory = path.posix.join(localRunRoot, "returned");
    await local.createDirectory({ path: localReturnDirectory });
    const reverseStarted = process.hrtime.bigint();
    reverseResult = await transferSelections({
      sourceEndpoint: remote,
      destinationEndpoint: local,
      sourcePaths: [destinationPath],
      destinationDir: localReturnDirectory,
      conflictPolicy: "overwrite",
      move: true,
      onProgress(event) {
        if (event?.result) {
          peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
        }
      },
    });
    reverseSeconds = secondsSince(reverseStarted);
    returnedPath = String(reverseResult.items?.[0]?.targetPath || "");
    assert(reverseResult.items?.[0]?.deletedSource === true, "The Sakura to HINOKI 4 GiB move did not delete its source.");
    assert(!await statOrNull(remote, destinationPath), "The Sakura source still exists after the return move.");
    const returnedRecord = await statOrNull(local, returnedPath);
    assert(returnedRecord?.size === bytes, "The returned HINOKI destination logical size is wrong.");

    stage = "return-hash";
    await remote.createFile({ path: remoteHeartbeatPath, contents: "return-hash\n", overwrite: true });
    const localVerifyStarted = process.hrtime.bigint();
    const returnedHash = await hashDownloadWithMutationHeartbeat(local, returnedPath, {
      heartbeatEndpoint: remote,
      heartbeatPath: remoteHeartbeatPath,
    });
    localVerifySeconds = secondsSince(localVerifyStarted);
    assert(returnedHash.bytes === bytes, "The returned verification stream produced the wrong byte count.");
    assert(returnedHash.hash === expectedHash, "The returned HINOKI SHA-256 differs from the original fixture.");
  }
} catch (error) {
  failure = error;
} finally {
  clearInterval(memoryTimer);
  clearInterval(pingTimer);
  const localRoot = path.posix.join("Portal", runName);
  const remoteRoot = path.win32.join("Portal", runName);
  try {
    const deleted = await Promise.all([
      deleteIfPresent(local, localRoot),
      deleteIfPresent(remote, remoteRoot),
    ]);
    cleanupOk = deleted.every(Boolean)
      && !await statOrNull(local, localRoot).catch(() => null)
      && !await statOrNull(remote, remoteRoot).catch(() => null);
  } catch (cleanupError) {
    if (!failure) failure = cleanupError;
  }
}

const forwardBytes = Number(forwardResult?.transferredBytes || 0);
const reverseBytes = Number(reverseResult?.transferredBytes || 0);
const report = {
  ok: !failure && cleanupOk,
  checkedAt: new Date().toISOString(),
  stage: failure ? stage : "complete",
  fixture: {
    kind: "sparse-zero-file",
    logicalBytes: bytes,
    logicalGiB: Number((bytes / 1024 / 1024 / 1024).toFixed(3)),
    sourcePhysicalBytes,
    sha256: expectedHash,
  },
  source: localInfo ? {
    machineId: localInfo.machineId,
    platform: localInfo.platform,
    version: localInfo.versions?.app || "",
  } : null,
  destination: remoteInfo ? {
    machineId: remoteInfo.machineId,
    platform: remoteInfo.platform,
    version: remoteInfo.versions?.app || "",
  } : null,
  moves: {
    hinokiToSakura: {
      sourceDeleted: forwardResult?.items?.[0]?.deletedSource === true,
      destinationPath: destinationPath ? `Portal/${runName}/destination/fake-4GiB.zero` : "",
      transferredBytes: forwardBytes,
      seconds: Number(forwardSeconds.toFixed(3)),
      mibPerSecond: mibPerSecond(forwardBytes, forwardSeconds),
    },
    sakuraToHinoki: flags["one-way"] ? null : {
      sourceDeleted: reverseResult?.items?.[0]?.deletedSource === true,
      destinationPath: returnedPath ? `Portal/${runName}/returned/fake-4GiB.zero` : "",
      transferredBytes: reverseBytes,
      seconds: Number(reverseSeconds.toFixed(3)),
      mibPerSecond: mibPerSecond(reverseBytes, reverseSeconds),
    },
    totalTransferredBytes: forwardBytes + reverseBytes,
  },
  verification: {
    hashPreparationSeconds: Number(hashPreparationSeconds.toFixed(3)),
    sakura: {
      seconds: Number(remoteVerifySeconds.toFixed(3)),
      mibPerSecond: mibPerSecond(bytes, remoteVerifySeconds),
    },
    hinoki: flags["one-way"] ? null : {
      seconds: Number(localVerifySeconds.toFixed(3)),
      mibPerSecond: mibPerSecond(bytes, localVerifySeconds),
    },
  },
  responsiveness: {
    pingSamples,
    pingFailures,
    maximumRoundTripMs: Number(maximumPingMs.toFixed(2)),
  },
  memory: {
    peakRssBytes,
    peakHeapBytes,
  },
  cleanupOk,
  error: failure ? {
    code: String(failure?.code || "ERR_WW_LARGE_MOVE"),
    message: String(failure?.message || failure),
    causeCode: String(failure?.cause?.code || ""),
  } : null,
};

process.stdout.write(`${JSON.stringify(report, null, flags.json ? 0 : 2)}\n`);
if (!report.ok) process.exitCode = 1;
