#!/usr/bin/env node
// Small-file fleet throughput: many tiny files through transferSelections over
// the live WW file services. Loopback lane always runs; --peer adds the
// physical HINOKI <-> Sakura lane. Reports files/s on stdout as JSON.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (["managed", "json", "peer", "legacy"].includes(key)) {
      flags[key] = true;
      continue;
    }
    if (argv[index + 1] === undefined) throw new TypeError(`--${key} requires a value.`);
    flags[key] = String(argv[index + 1]);
    index += 1;
  }
  return flags;
}

const flags = parseArgs();
if (flags.managed || (process.platform !== "win32" && !process.env.WW_CONFIG_DIR)) {
  process.env.WW_PORTAL_PATH = process.env.WW_PORTAL_PATH || repoRoot;
  process.env.WW_HOME_DIR = process.env.WW_HOME_DIR || path.join(repoRoot, ".workwire");
  process.env.WW_CONFIG_DIR = process.env.WW_CONFIG_DIR || path.join(repoRoot, ".workwire", "config");
}

const [{ loadWwConfig }, { createRemoteWwClient }, { transferSelections }] = await Promise.all([
  import("../../lib/ww-config-store.mjs"),
  import("../../lib/ww-client.mjs"),
  import("../../lib/ww-transfer.mjs"),
]);

const fileCount = Math.max(1, Number(flags.files) || 500);
const fileBytes = Math.max(1, Number(flags["file-bytes"]) || 1024);
const config = await loadWwConfig();
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

const runName = `.ww-smallfile-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
const localRunRoot = path.join(repoRoot, "Portal", runName);
const sourceDir = path.join(localRunRoot, "source");
const results = {
  benchmark: "small-file-fleet",
  at: new Date().toISOString(),
  files: fileCount,
  fileBytes,
};

async function timedTransfer(destinationEndpoint, destinationDir) {
  const startedAt = process.hrtime.bigint();
  const transfer = await transferSelections({
    sourceEndpoint: local,
    destinationEndpoint,
    sourcePaths: [sourceDir],
    destinationDir,
    conflictPolicy: "overwrite",
    ...(flags.legacy ? { smallFileBatch: false, smallFileConcurrency: 1 } : {}),
  });
  const milliseconds = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (transfer.transferredFiles !== fileCount) {
    throw new Error(`Transferred ${transfer.transferredFiles} of ${fileCount} files.`);
  }
  return {
    files: transfer.transferredFiles,
    bytes: transfer.transferredBytes,
    milliseconds: Number(milliseconds.toFixed(2)),
    filesPerSecond: Number((fileCount / (milliseconds / 1000)).toFixed(2)),
  };
}

async function verifySample(endpoint, pathApi, treeRoot) {
  for (const index of [0, Math.floor(fileCount / 2), fileCount - 1]) {
    const name = `file-${String(index).padStart(4, "0")}.bin`;
    const download = await endpoint.createDownloadStream(pathApi.join(treeRoot, name), { timeoutMs: 0 });
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    for await (const chunk of download.stream) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    const expected = crypto.createHash("sha256")
      .update(Buffer.alloc(fileBytes, index % 251))
      .digest("hex");
    if (bytes !== fileBytes || hash.digest("hex") !== expected) {
      throw new Error(`Destination content mismatch for ${name}.`);
    }
  }
  return true;
}

let remote = null;
let remoteRunRoot = "";
let failure = null;
try {
  await fs.mkdir(sourceDir, { recursive: true });
  await Promise.all(Array.from({ length: fileCount }, (_, index) => fs.writeFile(
    path.join(sourceDir, `file-${String(index).padStart(4, "0")}.bin`),
    Buffer.alloc(fileBytes, index % 251),
  )));

  const loopbackDest = path.join(localRunRoot, "dest-loopback");
  await local.createDirectory({ path: loopbackDest });
  results.loopback = await timedTransfer(local, loopbackDest);
  results.loopback.verified = await verifySample(local, path.posix, path.posix.join(loopbackDest, "source"));

  if (flags.peer) {
    remote = createRemoteWwClient({
      ...config.peer,
      localMachineId: config.service.machineId,
      transferTimeoutMs: 0,
    });
    const remoteInfo = await remote.getInfo({ timeoutMs: 8_000 });
    const remoteApi = remoteInfo.platform === "win32" ? path.win32 : path.posix;
    remoteRunRoot = remoteApi.join("Portal", `${runName}-peer`);
    await remote.createDirectory({ path: remoteRunRoot });
    results.peer = await timedTransfer(remote, remoteRunRoot);
    results.peer.verified = await verifySample(remote, remoteApi, remoteApi.join(remoteRunRoot, "source"));
    results.peer.host = String(config.peer.host || "");
  }
} catch (error) {
  failure = { code: String(error?.code || "ERR_WW_SMALLFILE_BENCH"), message: String(error?.message || error) };
} finally {
  await fs.rm(localRunRoot, { recursive: true, force: true }).catch(() => {});
  if (remote && remoteRunRoot) {
    await remote.deletePaths({ paths: [remoteRunRoot] }).catch(() => {});
  }
}

results.ok = !failure;
if (failure) results.error = failure;
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.exit(failure ? 1 : 0);
