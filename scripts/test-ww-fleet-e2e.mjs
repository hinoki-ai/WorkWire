#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (["managed", "json"].includes(key)) {
      flags[key] = true;
      continue;
    }
    if (argv[index + 1] === undefined) throw new TypeError(`--${key} requires a value.`);
    flags[key] = String(argv[index + 1]);
    index += 1;
  }
  return flags;
}

function assert(condition, message, code = "ERR_WW_FLEET_E2E_ASSERTION") {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorRecord(error) {
  return {
    code: String(error?.code || "ERR_WW_FLEET_E2E"),
    message: String(error?.message || error || "Fleet acceptance failed."),
    causeCode: String(error?.cause?.code || ""),
  };
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deterministicBytes(size, seed) {
  const output = Buffer.alloc(Math.max(0, Number(size) || 0));
  let block = crypto.createHash("sha256").update(String(seed)).digest();
  for (let offset = 0; offset < output.length; offset += block.length) {
    block.copy(output, offset, 0, Math.min(block.length, output.length - offset));
    block = crypto.createHash("sha256").update(block).update(String(seed)).digest();
  }
  return output;
}

async function streamSha256(stream) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { hash: hash.digest("hex"), bytes };
}

async function readHash(endpoint, targetPath) {
  const download = await endpoint.createDownloadStream(targetPath, { timeoutMs: 0 });
  return streamSha256(download.stream);
}

async function writeBytes(endpoint, targetPath, value, options = {}) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return endpoint.uploadFileStream(targetPath, Readable.from([buffer]), {
    overwrite: options.overwrite === true,
    mtimeMs: options.mtimeMs ?? Date.now(),
    timeoutMs: 0,
  });
}

async function statOrNull(endpoint, targetPath) {
  return endpoint.stat({ path: targetPath, allowMissing: true });
}

async function waitFor(check, {
  description,
  timeoutMs = 45_000,
  intervalMs = 500,
} = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const error = new Error(
    `${description || "Fleet condition"} did not converge within ${timeoutMs}ms${
      lastError ? `: ${lastError.message}` : "."
    }`,
  );
  error.code = "ERR_WW_FLEET_E2E_TIMEOUT";
  throw error;
}

async function waitForMirrorGeneration(endpoint, {
  description,
  timeoutMs = 90_000,
} = {}) {
  const observed = await waitFor(async () => {
    const status = await endpoint.getMirrorStatus({ timeoutMs: 5_000 });
    return status?.role === "leader" && status?.instanceId ? status : null;
  }, {
    description: `${description || "mirror"} leader status`,
    timeoutMs,
  });
  const instanceId = String(observed.instanceId);
  const completedCycles = Number(observed.completedCycles) || 0;
  return waitFor(async () => {
    const status = await endpoint.getMirrorStatus({ timeoutMs: 5_000 });
    if (!status || status.role !== "leader" || status.error) return null;
    const sameInstanceAdvanced = String(status.instanceId) === instanceId
      && Number(status.completedCycles) > completedCycles;
    const replacementCompleted = String(status.instanceId) !== instanceId
      && Number(status.completedCycles) >= 1;
    return sameInstanceAdvanced || replacementCompleted ? status : null;
  }, {
    description: `${description || "mirror"} completed-generation barrier`,
    timeoutMs,
  });
}

async function assertHash(endpoint, targetPath, expected, label) {
  const actual = await readHash(endpoint, targetPath);
  assert(
    actual.hash === expected.hash && actual.bytes === expected.bytes,
    `${label} hash or byte count differs after transfer.`,
    "ERR_WW_FLEET_E2E_HASH",
  );
  return actual;
}

async function createFixtureTree(endpoint, pathApi, rootPath, fixtures) {
  await endpoint.createDirectory({ path: rootPath });
  for (const fixture of fixtures) {
    const targetPath = pathApi.join(rootPath, ...fixture.relativePath.split("/"));
    await writeBytes(endpoint, targetPath, fixture.data);
  }
}

async function verifyFixtureTree(endpoint, pathApi, rootPath, fixtures, label) {
  for (const fixture of fixtures) {
    const targetPath = pathApi.join(rootPath, ...fixture.relativePath.split("/"));
    await assertHash(endpoint, targetPath, fixture, `${label}: ${fixture.relativePath}`);
  }
}

async function deleteIfPresent(endpoint, targetPath) {
  const record = await statOrNull(endpoint, targetPath).catch(() => null);
  if (!record) return true;
  const results = await endpoint.deletePaths({ paths: [targetPath] });
  return results.every((entry) => entry?.ok === true);
}

async function listConflictItems(endpoint, directoryPath, stem) {
  const listing = await endpoint.listDirectory({ path: directoryPath, includeHidden: true });
  return (listing.items || []).filter((item) => (
    item.kind === "file"
    && item.name.startsWith(`${stem} (WW conflict `)
  ));
}

const flags = parseArgs();
if (flags.managed || (process.platform !== "win32" && !process.env.WW_CONFIG_DIR)) {
  process.env.WW_PORTAL_PATH = process.env.WW_PORTAL_PATH || repoRoot;
  process.env.WW_HOME_DIR = process.env.WW_HOME_DIR || path.join(repoRoot, ".workwire");
  process.env.WW_CONFIG_DIR = process.env.WW_CONFIG_DIR || path.join(repoRoot, ".workwire", "config");
}
if (flags["config-dir"]) process.env.WW_CONFIG_DIR = path.resolve(flags["config-dir"]);
if (flags.portal) process.env.WW_PORTAL_PATH = path.resolve(flags.portal);

const [{ loadWwConfig }, { createRemoteWwClient }, { transferSelections }, { buildWwReleaseInfo }] = await Promise.all([
  import("../lib/ww-config-store.mjs"),
  import("../lib/ww-client.mjs"),
  import("../lib/ww-transfer.mjs"),
  import("../lib/ww-release.mjs"),
]);

const config = await loadWwConfig();
const sourceRelease = await buildWwReleaseInfo({ baseDir: repoRoot });
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
const unauthorizedRemote = createRemoteWwClient({
  ...config.peer,
  token: `invalid-${crypto.randomBytes(24).toString("hex")}`,
  localMachineId: config.service.machineId,
});

const runName = `.ww-e2e-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
assert(/^\.ww-e2e-[0-9]+-[a-f0-9]{8}$/u.test(runName), "Unsafe fleet fixture root.");
const runRootParts = ["Portal", runName];
const largeBytes = Math.max(1, Number(flags["large-bytes"]) || 16 * 1024 * 1024);
const checks = {};
const metrics = {
  transferredFiles: 0,
  transferredBytes: 0,
  conflictCopies: 0,
};
const startedAt = Date.now();
let localInfo = null;
let remoteInfo = null;
let failure = null;
let stage = "connect";
let failureStage = "";
let cleanupOk = false;

try {
  [localInfo, remoteInfo] = await Promise.all([
    local.getInfo({ timeoutMs: 5_000 }),
    remote.getInfo({ timeoutMs: 5_000 }),
  ]);
  assert(localInfo.machineId === config.service.machineId, "The local service identity is not the pinned identity.");
  assert(remoteInfo.machineId === config.peer.machineId, "The remote service identity is not the pinned identity.");
  assert(localInfo.versions?.app === sourceRelease.version, "The local service is not running the current source release.");
  assert(remoteInfo.versions?.app === sourceRelease.version, "The remote service is not running the current source release.");
  assert(localInfo.versions?.app === remoteInfo.versions?.app, "The two services are running different releases.");
  checks.identitiesPinned = true;
  checks.exactReleaseOnBoth = true;

  stage = "authentication";
  let rejectedStatus = 0;
  try {
    await unauthorizedRemote.getInfo({ timeoutMs: 5_000 });
  } catch (error) {
    rejectedStatus = Number(error?.status) || 0;
  }
  assert(rejectedStatus === 401, `A wrong file-plane token returned HTTP ${rejectedStatus || "success"}, not 401.`);
  checks.wrongTokenRejected = true;

  const localApi = localInfo.platform === "win32" ? path.win32 : path.posix;
  const remoteApi = remoteInfo.platform === "win32" ? path.win32 : path.posix;
  const linuxFixtures = [
    { relativePath: "empty.bin", bytes: Buffer.alloc(0) },
    { relativePath: "pattern-256k.bin", bytes: deterministicBytes(256 * 1024, "hinoki-binary") },
    { relativePath: "nested/árbol-桜-🌸.txt", bytes: Buffer.from("HINOKI → Sakura\nNFC áéíóú\n桜 🌸\n", "utf8") },
    { relativePath: "large.bin", bytes: deterministicBytes(largeBytes, "hinoki-large") },
  ].map((fixture) => ({
    relativePath: fixture.relativePath,
    data: fixture.bytes,
    hash: sha256Bytes(fixture.bytes),
    bytes: fixture.bytes.length,
  }));
  const windowsFixtures = [
    { relativePath: "empty.bin", bytes: Buffer.alloc(0) },
    { relativePath: "pattern-256k.bin", bytes: deterministicBytes(256 * 1024, "sakura-binary") },
    { relativePath: "nested/raíces-檜-🌲.txt", bytes: Buffer.from("Sakura → HINOKI\r\nUnicode ñ ü 檜 🌲\r\n", "utf8") },
    { relativePath: "large.bin", bytes: deterministicBytes(largeBytes, "sakura-large") },
  ].map((fixture) => ({
    relativePath: fixture.relativePath,
    data: fixture.bytes,
    hash: sha256Bytes(fixture.bytes),
    bytes: fixture.bytes.length,
  }));

  stage = "hinoki-fixture-create";
  const localRunRoot = localApi.join(...runRootParts);
  const remoteRunRoot = remoteApi.join(...runRootParts);
  const localSource = localApi.join(localRunRoot, "from-hinoki");
  const remoteInbox = remoteApi.join(remoteRunRoot, "explicit-from-hinoki");
  await Promise.all([
    createFixtureTree(local, localApi, localSource, linuxFixtures),
    remote.createDirectory({ path: remoteInbox }),
  ]);
  stage = "hinoki-to-sakura-transfer";
  const toWindows = await transferSelections({
    sourceEndpoint: local,
    destinationEndpoint: remote,
    sourcePaths: [localSource],
    destinationDir: remoteInbox,
    conflictPolicy: "overwrite",
  });
  const remoteLinuxTree = remoteApi.join(remoteInbox, localApi.basename(localSource));
  await verifyFixtureTree(remote, remoteApi, remoteLinuxTree, linuxFixtures, "HINOKI to Sakura");
  metrics.transferredFiles += toWindows.transferredFiles;
  metrics.transferredBytes += toWindows.transferredBytes;

  stage = "sakura-fixture-create";
  const remoteSource = remoteApi.join(remoteRunRoot, "from-sakura");
  const localInbox = localApi.join(localRunRoot, "explicit-from-sakura");
  await Promise.all([
    createFixtureTree(remote, remoteApi, remoteSource, windowsFixtures),
    local.createDirectory({ path: localInbox }),
  ]);
  stage = "sakura-to-hinoki-transfer";
  const toLinux = await transferSelections({
    sourceEndpoint: remote,
    destinationEndpoint: local,
    sourcePaths: [remoteSource],
    destinationDir: localInbox,
    conflictPolicy: "overwrite",
  });
  const localWindowsTree = localApi.join(localInbox, remoteApi.basename(remoteSource));
  await verifyFixtureTree(local, localApi, localWindowsTree, windowsFixtures, "Sakura to HINOKI");
  metrics.transferredFiles += toLinux.transferredFiles;
  metrics.transferredBytes += toLinux.transferredBytes;
  checks.bidirectionalExactTransfers = true;

  stage = "remote-crud";
  const crudDirectory = remoteApi.join(remoteRunRoot, "crud");
  const crudOriginal = remoteApi.join(crudDirectory, "draft.txt");
  const crudRenamed = remoteApi.join(crudDirectory, "final.txt");
  await remote.createDirectory({ path: crudDirectory });
  await remote.createFile({ path: crudOriginal, contents: "created" });
  await remote.createFile({ path: crudOriginal, contents: "edited", overwrite: true });
  const renamed = await remote.rename({ path: crudOriginal, nextName: "final.txt" });
  assert(renamed.name === "final.txt", "Remote rename did not return the final filename.");
  const edited = Buffer.from("edited");
  await assertHash(remote, crudRenamed, { hash: sha256Bytes(edited), bytes: edited.length }, "remote CRUD edit");
  const deleteResults = await remote.deletePaths({ paths: [crudRenamed] });
  assert(deleteResults.every((entry) => entry.ok), "Remote CRUD delete failed.");
  assert(!await statOrNull(remote, crudRenamed), "Remote CRUD path still exists after delete.");
  checks.remoteCrud = true;

  stage = "remote-move";
  const moveSource = remoteApi.join(remoteRunRoot, "move-source.bin");
  const moveDestination = localApi.join(localRunRoot, "moves");
  const moveBytes = deterministicBytes(96 * 1024, "move-sakura-to-hinoki");
  const moveExpected = { hash: sha256Bytes(moveBytes), bytes: moveBytes.length };
  await local.createDirectory({ path: moveDestination });
  await writeBytes(remote, moveSource, moveBytes);
  const moveResult = await transferSelections({
    sourceEndpoint: remote,
    destinationEndpoint: local,
    sourcePaths: [moveSource],
    destinationDir: moveDestination,
    conflictPolicy: "overwrite",
    move: true,
  });
  assert(moveResult.items[0]?.deletedSource === true, "Move did not report source deletion.");
  assert(!await statOrNull(remote, moveSource), "Move source still exists on Sakura after completion.");
  await assertHash(local, localApi.join(moveDestination, remoteApi.basename(moveSource)), moveExpected, "remote move");
  checks.moveDeletesSource = true;

  stage = "rename-conflict-policy";
  const collisionSourceDirectory = remoteApi.join(remoteRunRoot, "collision-source");
  const collisionDestination = localApi.join(localRunRoot, "collision-destination");
  const collisionSource = remoteApi.join(collisionSourceDirectory, "same.bin");
  const collisionExisting = localApi.join(collisionDestination, "same.bin");
  const collisionCopy = localApi.join(collisionDestination, "same (copy).bin");
  const sourceCollisionBytes = Buffer.from("source-from-sakura");
  const existingCollisionBytes = Buffer.from("existing-on-hinoki");
  await Promise.all([
    remote.createDirectory({ path: collisionSourceDirectory }),
    local.createDirectory({ path: collisionDestination }),
  ]);
  await Promise.all([
    writeBytes(remote, collisionSource, sourceCollisionBytes),
    writeBytes(local, collisionExisting, existingCollisionBytes),
  ]);
  const collisionResult = await transferSelections({
    sourceEndpoint: remote,
    destinationEndpoint: local,
    sourcePaths: [collisionSource],
    destinationDir: collisionDestination,
    conflictPolicy: "rename",
  });
  assert(collisionResult.items[0]?.targetPath?.endsWith("same (copy).bin"), "Rename conflict policy did not select a copy path.");
  await Promise.all([
    assertHash(local, collisionExisting, {
      hash: sha256Bytes(existingCollisionBytes),
      bytes: existingCollisionBytes.length,
    }, "rename policy original"),
    assertHash(local, collisionCopy, {
      hash: sha256Bytes(sourceCollisionBytes),
      bytes: sourceCollisionBytes.length,
    }, "rename policy copy"),
  ]);
  checks.renameConflictPolicy = true;

  stage = "mirror-baseline";
  const mirrorDirectoryLocal = localApi.join(localRunRoot, "mirror");
  const mirrorDirectoryRemote = remoteApi.join(remoteRunRoot, "mirror");
  const mirrorPathLocal = localApi.join(mirrorDirectoryLocal, "mirror-conflict.txt");
  const mirrorPathRemote = remoteApi.join(mirrorDirectoryRemote, "mirror-conflict.txt");
  const baseline = Buffer.from("shared mirror baseline\n");
  const baselineExpected = { hash: sha256Bytes(baseline), bytes: baseline.length };
  await local.createDirectory({ path: mirrorDirectoryLocal });
  await writeBytes(local, mirrorPathLocal, baseline);
  await waitFor(async () => {
    const current = await readHash(remote, mirrorPathRemote);
    return current.hash === baselineExpected.hash && current.bytes === baselineExpected.bytes;
  }, { description: "local-to-remote mirror baseline" });
  await waitForMirrorGeneration(remote, { description: "baseline" });
  const checkpoint = Buffer.from("shared mirror checkpoint after settled baseline\n");
  const checkpointExpected = { hash: sha256Bytes(checkpoint), bytes: checkpoint.length };
  await writeBytes(local, mirrorPathLocal, checkpoint, { overwrite: true });
  await waitFor(async () => {
    const current = await readHash(remote, mirrorPathRemote);
    return current.hash === checkpointExpected.hash && current.bytes === checkpointExpected.bytes;
  }, { description: "settled mirror checkpoint" });
  await waitForMirrorGeneration(remote, { description: "checkpoint" });
  checks.mirrorConvergence = true;
  checks.mirrorGenerationBarrier = true;

  stage = "mirror-simultaneous-conflict";
  const localVariant = Buffer.from("HINOKI simultaneous mirror variant\n");
  const remoteVariant = Buffer.from("Sakura simultaneous mirror variant with a distinct byte length\n");
  const variantHashes = new Set([sha256Bytes(localVariant), sha256Bytes(remoteVariant)]);
  const simultaneousMtime = Date.now() - 1_000;
  await Promise.all([
    writeBytes(local, mirrorPathLocal, localVariant, { overwrite: true, mtimeMs: simultaneousMtime }),
    writeBytes(remote, mirrorPathRemote, remoteVariant, { overwrite: true, mtimeMs: simultaneousMtime }),
  ]);

  const conflictState = await waitFor(async () => {
    const [localConflicts, remoteConflicts, localCanonical, remoteCanonical] = await Promise.all([
      listConflictItems(local, mirrorDirectoryLocal, "mirror-conflict"),
      listConflictItems(remote, mirrorDirectoryRemote, "mirror-conflict"),
      readHash(local, mirrorPathLocal),
      readHash(remote, mirrorPathRemote),
    ]);
    if (localCanonical.hash !== remoteCanonical.hash || localConflicts.length === 0 || remoteConflicts.length === 0) {
      return null;
    }
    const [localConflictHash, remoteConflictHash] = await Promise.all([
      readHash(local, localConflicts[0].path),
      readHash(remote, remoteConflicts[0].path),
    ]);
    const observed = new Set([
      localCanonical.hash,
      remoteCanonical.hash,
      localConflictHash.hash,
      remoteConflictHash.hash,
    ]);
    return [...variantHashes].every((hash) => observed.has(hash))
      ? { localConflicts, remoteConflicts }
      : null;
  }, { description: "simultaneous-edit mirror conflict preservation", timeoutMs: 60_000 });
  metrics.conflictCopies = Math.max(conflictState.localConflicts.length, conflictState.remoteConflicts.length);
  checks.simultaneousConflictPreserved = true;
} catch (error) {
  failure = error;
  failureStage = stage;
} finally {
  const localPath = localInfo?.platform === "win32" ? path.win32 : path.posix;
  const remotePath = remoteInfo?.platform === "win32" ? path.win32 : path.posix;
  const localRoot = localPath.join(...runRootParts);
  const remoteRoot = remotePath.join(...runRootParts);
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Promise.allSettled([
        deleteIfPresent(local, localRoot),
        deleteIfPresent(remote, remoteRoot),
      ]);
      await delay(800);
      const [localRemaining, remoteRemaining] = await Promise.all([
        statOrNull(local, localRoot).catch(() => null),
        statOrNull(remote, remoteRoot).catch(() => null),
      ]);
      if (!localRemaining && !remoteRemaining) {
        cleanupOk = true;
        break;
      }
    }
    if (localInfo?.rootPath) {
      const exactLocalFixture = path.resolve(localInfo.rootPath, ...runRootParts);
      assert(
        exactLocalFixture.startsWith(`${path.resolve(localInfo.rootPath)}${path.sep}`),
        "Cleanup path escaped the local portal.",
      );
      await fs.rm(exactLocalFixture, { recursive: true, force: true });
    }
  } catch (cleanupError) {
    if (!failure) failure = cleanupError;
  }
}

checks.fixtureCleanup = cleanupOk;
if (!cleanupOk && !failure) {
  const error = new Error("Fleet fixtures did not disappear from both services.");
  error.code = "ERR_WW_FLEET_E2E_CLEANUP";
  failure = error;
}

const report = {
  ok: !failure && Object.values(checks).every(Boolean),
  checkedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  runName,
  fixtureRoot: `Portal/${runName}`,
  source: {
    version: sourceRelease.version,
    hash: sourceRelease.hash,
  },
  local: localInfo ? {
    machineId: localInfo.machineId,
    platform: localInfo.platform,
    version: localInfo.versions?.app || "",
  } : null,
  remote: remoteInfo ? {
    machineId: remoteInfo.machineId,
    platform: remoteInfo.platform,
    version: remoteInfo.versions?.app || "",
  } : null,
  fixtureBytesPerDirection: largeBytes + 256 * 1024,
  metrics,
  checks,
  error: failure ? { stage: failureStage || stage, ...errorRecord(failure) } : null,
};

process.stdout.write(`${JSON.stringify(report, null, flags.json ? 0 : 2)}\n`);
if (!report.ok) process.exitCode = 1;
