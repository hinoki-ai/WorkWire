import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { createRemoteWwClient } from "./ww-client.mjs";
import {
  copyLocalPath,
  isWwTemporaryBasename,
  pathExists,
  writeReadableToFile,
  WW_INTERNAL_PORTAL_BASENAMES,
} from "./ww-fs.mjs";

export const WW_MIRROR_VERSION = 2;
export const WW_MIRROR_INTERVAL_MS = 1_500;
export const WW_MIRROR_INTERNAL_NAMES = WW_INTERNAL_PORTAL_BASENAMES;

function normalizePath(value = "") {
  return path.resolve(String(value || ""));
}

function normalizeRelative(value = "") {
  const raw = String(value || "").replaceAll(path.sep, "/");
  if (!raw || raw.startsWith("/") || raw.includes("\0")) {
    return "";
  }
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    return "";
  }
  return segments.join("/");
}

function pathFor(rootPath, relativePath) {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedRelative = normalizeRelative(relativePath);
  if (!normalizedRelative) {
    const error = new Error("WW mirror refused an empty or unsafe relative path.");
    error.code = "ERR_WW_MIRROR_PATH";
    throw error;
  }
  return path.join(normalizedRoot, ...normalizedRelative.split("/"));
}

function recordSignature(record) {
  if (!record) return "missing";
  if (record.kind === "directory") return "directory";
  return [record.kind, Number(record.size) || 0, Math.round(Number(record.mtimeMs) || 0)].join(":");
}

function recordsEqual(left, right) {
  return recordSignature(left) === recordSignature(right);
}

function serializeRecords(records) {
  return Object.fromEntries([...records.entries()].map(([relativePath, record]) => [
    relativePath,
    {
      kind: record.kind,
      size: Number(record.size) || 0,
      mtimeMs: Math.round(Number(record.mtimeMs) || 0),
    },
  ]));
}

function deserializeRecords(records = {}) {
  const result = new Map();
  for (const [relativePath, record] of Object.entries(records || {})) {
    const normalizedRelative = normalizeRelative(relativePath);
    const kind = String(record?.kind || "");
    if (!normalizedRelative || (kind !== "file" && kind !== "directory")) {
      continue;
    }
    result.set(normalizedRelative, {
      kind,
      size: Number(record?.size) || 0,
      mtimeMs: Math.round(Number(record?.mtimeMs) || 0),
    });
  }
  return result;
}

function makeRecord(kind, stats) {
  return {
    kind,
    size: kind === "file" ? Number(stats.size) || 0 : 0,
    mtimeMs: Math.round(Number(stats.mtimeMs) || 0),
  };
}

function shouldSkipRootName(name) {
  return WW_MIRROR_INTERNAL_NAMES.includes(String(name || ""));
}

function shouldSkipEntry(name, relativeDirectory = "") {
  return isWwTemporaryBasename(name)
    || (!relativeDirectory && shouldSkipRootName(name));
}

export async function scanLocalMirrorTree(rootPath) {
  const normalizedRoot = normalizePath(rootPath);
  const records = new Map();

  async function walk(directoryPath, relativeDirectory = "") {
    const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (shouldSkipEntry(entry.name, relativeDirectory)) {
        continue;
      }

      const relativePath = normalizeRelative(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      const absolutePath = path.join(directoryPath, entry.name);
      const stats = await fsp.lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        continue;
      }
      if (stats.isDirectory()) {
        records.set(relativePath, makeRecord("directory", stats));
        await walk(absolutePath, relativePath);
      } else if (stats.isFile()) {
        records.set(relativePath, makeRecord("file", stats));
      }
    }
  }

  await walk(normalizedRoot);
  return records;
}

export async function scanRemoteMirrorTree(client, rootPath) {
  const normalizedRoot = normalizePath(rootPath);
  const records = new Map();

  async function walk(directoryPath) {
    const listing = await client.listDirectory({
      path: directoryPath,
      includeHidden: true,
    });
    for (const item of listing.items || []) {
      const relativePath = normalizeRelative(path.relative(normalizedRoot, item.path));
      if (
        !relativePath
        || isWwTemporaryBasename(item.name)
        || (!relativePath.includes("/") && shouldSkipRootName(item.name))
      ) {
        continue;
      }
      if (item.kind !== "file" && item.kind !== "directory") {
        continue;
      }
      records.set(relativePath, {
        kind: item.kind,
        size: Number(item.size) || 0,
        mtimeMs: Math.round(Number(item.mtimeMs) || 0),
      });
      if (item.kind === "directory") {
        await walk(item.path);
      }
    }
  }

  await walk(normalizedRoot);
  return records;
}

function isDescendant(relativePath, parentPath) {
  return relativePath !== parentPath && relativePath.startsWith(`${parentPath}/`);
}

function addUniqueDelete(actions, relativePath) {
  if (!relativePath) return;
  if (actions.some((action) => action.type === "delete" && (
    action.path === relativePath || isDescendant(relativePath, action.path)
  ))) {
    return;
  }
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (action.type === "delete" && isDescendant(action.path, relativePath)) {
      actions.splice(index, 1);
    }
  }
  actions.push({ type: "delete", path: relativePath });
}

function chooseWinner(localRecord, remoteRecord, machineId, peerMachineId = "") {
  if ((localRecord?.mtimeMs || 0) !== (remoteRecord?.mtimeMs || 0)) {
    return (localRecord?.mtimeMs || 0) > (remoteRecord?.mtimeMs || 0) ? "local" : "remote";
  }
  return String(machineId || "") <= String(peerMachineId || "") ? "local" : "remote";
}

export function isMirrorLeader(machineId = "", peerMachineId = "") {
  const localId = String(machineId || "");
  const remoteId = String(peerMachineId || "");
  return !localId || !remoteId || localId <= remoteId;
}

export function buildMirrorConflictPath(relativePath, losingMachineId = "", record = {}) {
  const normalizedRelative = normalizeRelative(relativePath);
  if (!normalizedRelative) {
    throw new Error("A valid relative path is required for a WW conflict copy.");
  }
  const parsed = path.posix.parse(normalizedRelative);
  const machineTag = crypto.createHash("sha256")
    .update(String(losingMachineId || "unknown"))
    .digest("hex")
    .slice(0, 8);
  const timestamp = Math.max(0, Math.round(Number(record?.mtimeMs) || 0));
  const extension = record?.kind === "file" ? parsed.ext : "";
  const stem = extension ? parsed.base.slice(0, -extension.length) : parsed.base;
  const suffix = ` (WW conflict ${machineTag}-${timestamp})`;
  let conflictName = `${stem}${suffix}${extension}`;
  if (Buffer.byteLength(conflictName) > 240) {
    const pathTag = crypto.createHash("sha256").update(normalizedRelative).digest("hex").slice(0, 12);
    conflictName = `WW conflict ${pathTag}-${machineTag}-${timestamp}${extension}`;
  }
  return parsed.dir ? `${parsed.dir}/${conflictName}` : conflictName;
}

export function planMirrorActions({
  local,
  remote,
  previousLocal = new Map(),
  previousRemote = new Map(),
  machineId = "",
  peerMachineId = "",
} = {}) {
  const paths = new Set([
    ...local.keys(),
    ...remote.keys(),
    ...previousLocal.keys(),
    ...previousRemote.keys(),
  ]);
  const actions = [];

  for (const relativePath of [...paths].sort()) {
    const localRecord = local.get(relativePath) || null;
    const remoteRecord = remote.get(relativePath) || null;
    const previousLocalRecord = previousLocal.get(relativePath) || null;
    const previousRemoteRecord = previousRemote.get(relativePath) || null;
    const localChanged = !recordsEqual(localRecord, previousLocalRecord);
    const remoteChanged = !recordsEqual(remoteRecord, previousRemoteRecord);

    if (localRecord && remoteRecord && recordsEqual(localRecord, remoteRecord)) {
      continue;
    }

    if (!localRecord && !remoteRecord) {
      continue;
    }

    if (localRecord && !remoteRecord) {
      if (previousRemoteRecord && remoteChanged && !localChanged) {
        addUniqueDelete(actions, relativePath);
      } else {
        actions.push({ type: "copy", from: "local", path: relativePath, record: localRecord });
      }
      continue;
    }

    if (!localRecord && remoteRecord) {
      if (previousLocalRecord && localChanged && !remoteChanged) {
        addUniqueDelete(actions, relativePath);
      } else {
        actions.push({ type: "copy", from: "remote", path: relativePath, record: remoteRecord });
      }
      continue;
    }

    if (localChanged && !remoteChanged) {
      actions.push({ type: "copy", from: "local", path: relativePath, record: localRecord });
    } else if (remoteChanged && !localChanged) {
      actions.push({ type: "copy", from: "remote", path: relativePath, record: remoteRecord });
    } else {
      const winner = chooseWinner(localRecord, remoteRecord, machineId, peerMachineId);
      actions.push({
        type: "copy",
        from: winner,
        path: relativePath,
        record: winner === "local" ? localRecord : remoteRecord,
        conflict: true,
      });
    }
  }

  const fileReplacements = actions.filter((action) => {
    if (action.type !== "copy" || action.record?.kind !== "file") return false;
    const losingRecord = action.from === "local"
      ? remote.get(action.path)
      : local.get(action.path);
    return losingRecord?.kind === "directory";
  });
  return actions.filter((action) => !fileReplacements.some((replacement) => (
    action !== replacement && isDescendant(action.path, replacement.path)
  ))).sort((left, right) => {
    if (left.type !== right.type) return left.type === "delete" ? 1 : -1;
    const leftDepth = left.path.split("/").length;
    const rightDepth = right.path.split("/").length;
    return left.type === "delete" ? rightDepth - leftDepth : leftDepth - rightDepth;
  });
}

async function removeLocalPath(rootPath, relativePath) {
  await fsp.rm(pathFor(rootPath, relativePath), { recursive: true, force: true });
}

async function ensureLocalDirectory(rootPath, relativePath) {
  await fsp.mkdir(pathFor(rootPath, relativePath), { recursive: true });
}

async function deleteRemotePath(remote, remotePath) {
  const results = await remote.deletePaths({ paths: [remotePath] });
  const failure = results.find((result) => !result?.ok);
  if (failure) {
    const error = new Error(failure?.error?.message || `WW could not delete ${remotePath}.`);
    error.code = failure?.error?.code || "ERR_WW_REMOTE_DELETE";
    throw error;
  }
}

async function preserveConflictCopy({
  action,
  rootPath,
  remote,
  remoteRootPath,
  localRecords,
  remoteRecords,
  machineId,
  peerMachineId,
}) {
  const losingSide = action.from === "local" ? "remote" : "local";
  const losingRecord = losingSide === "local"
    ? localRecords.get(action.path)
    : remoteRecords.get(action.path);
  if (!losingRecord) {
    return "";
  }

  const conflictPath = buildMirrorConflictPath(
    action.path,
    losingSide === "local" ? machineId : peerMachineId,
    losingRecord,
  );
  if (losingSide === "local") {
    const destinationPath = pathFor(rootPath, conflictPath);
    if (!await pathExists(destinationPath)) {
      await copyLocalPath(
        pathFor(rootPath, action.path),
        destinationPath,
        { overwrite: false },
      );
    }
  } else {
    const destinationPath = pathFor(remoteRootPath, conflictPath);
    const existing = await remote.stat({ path: destinationPath, allowMissing: true });
    if (!existing) {
      await remote.copyPath({
        sourcePath: pathFor(remoteRootPath, action.path),
        destinationPath,
        overwrite: false,
      });
    }
  }
  return conflictPath;
}

async function copyLocalToRemote({ rootPath, remote, remoteRootPath, relativePath, record }) {
  const remotePath = pathFor(remoteRootPath, relativePath);
  const localPath = pathFor(rootPath, relativePath);
  const existing = await remote.stat({ path: remotePath, allowMissing: true });
  if (record.kind === "directory") {
    if (existing && existing.kind !== "directory") {
      await deleteRemotePath(remote, remotePath);
    }
    await remote.createDirectory({ path: remotePath });
    return;
  }
  await remote.uploadFileStream(remotePath, fs.createReadStream(localPath), {
    overwrite: true,
    mtimeMs: record.mtimeMs,
  });
}

async function copyRemoteToLocal({ rootPath, remote, remoteRootPath, relativePath, record }) {
  const remotePath = pathFor(remoteRootPath, relativePath);
  const localPath = pathFor(rootPath, relativePath);
  const localStats = await fsp.lstat(localPath).catch(() => null);
  if (record.kind === "directory") {
    if (localStats && !localStats.isDirectory()) {
      await fsp.rm(localPath, { recursive: true, force: true });
    }
    await ensureLocalDirectory(rootPath, relativePath);
    return;
  }
  const download = await remote.createDownloadStream(remotePath);
  await writeReadableToFile(localPath, download.stream, {
    overwrite: true,
    mtimeMs: record.mtimeMs,
  });
}

async function readState(statePath) {
  try {
    const raw = JSON.parse(await fsp.readFile(statePath, "utf8"));
    if (raw?.version !== WW_MIRROR_VERSION) {
      throw new Error("WW mirror state version is not current.");
    }
    return {
      version: WW_MIRROR_VERSION,
      local: deserializeRecords(raw.local),
      remote: deserializeRecords(raw.remote),
    };
  } catch {
    return {
      version: WW_MIRROR_VERSION,
      local: new Map(),
      remote: new Map(),
    };
  }
}

async function writeState(statePath, state) {
  const stateDirectory = path.dirname(statePath);
  await fsp.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fsp.chmod(stateDirectory, 0o700);
  const temporaryPath = `${statePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, JSON.stringify({
      version: WW_MIRROR_VERSION,
      local: serializeRecords(state.local),
      remote: serializeRecords(state.remote),
      updatedAt: new Date().toISOString(),
    }, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await fsp.rename(temporaryPath, statePath);
    await fsp.chmod(statePath, 0o600);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export function createWwMirror({
  rootPath,
  statePath,
  peer = {},
  getPeer = () => peer,
  machineId = "",
  intervalMs = WW_MIRROR_INTERVAL_MS,
  log = () => {},
  clientFactory = createRemoteWwClient,
  peerMachineId = String(peer?.machineId || "").trim(),
  expectedRemoteRootPath = rootPath,
} = {}) {
  const normalizedRootPath = normalizePath(rootPath);
  const normalizedExpectedRemoteRootPath = normalizePath(expectedRemoteRootPath);
  const normalizedStatePath = normalizePath(statePath || path.join(normalizedRootPath, ".workwire", "config", "ww-mirror-state.json"));
  let timer = null;
  let running = false;
  let stopped = false;
  let statePromise = readState(normalizedStatePath);
  let client = null;
  let clientPeerKey = "";
  let connectedPeerMachineId = "";
  let remoteRootPath = "";
  let lastError = "";
  let role = "waiting";

  function resetConnection() {
    client = null;
    remoteRootPath = "";
    connectedPeerMachineId = "";
  }

  function buildPeerKey(activePeer = {}) {
    return JSON.stringify([
      String(activePeer.host || "").trim(),
      Number(activePeer.port) || 0,
      String(activePeer.machineId || "").trim(),
      String(activePeer.token || ""),
    ]);
  }

  async function syncOnce() {
    if (stopped || running) return;
    running = true;
    try {
      const activePeer = await Promise.resolve(getPeer());
      if (!activePeer?.host) {
        role = "waiting";
        clientPeerKey = "";
        resetConnection();
        lastError = "";
        return;
      }

      const nextPeerKey = buildPeerKey(activePeer);
      if (clientPeerKey !== nextPeerKey) {
        resetConnection();
        clientPeerKey = nextPeerKey;
      }
      const configuredPeerMachineId = String(
        activePeer.machineId || peerMachineId || connectedPeerMachineId || "",
      ).trim();
      if (!isMirrorLeader(machineId, configuredPeerMachineId)) {
        role = "follower";
        lastError = "";
        return;
      }
      role = "leader";

      if (!client) {
        client = clientFactory({
          ...activePeer,
          localMachineId: machineId,
        });
        const info = await client.connect();
        connectedPeerMachineId = String(info?.machineId || configuredPeerMachineId || "").trim();
        if (
          configuredPeerMachineId
          && connectedPeerMachineId
          && configuredPeerMachineId !== connectedPeerMachineId
        ) {
          const error = new Error("WW mirror paused because the responding machine does not match the paired peer.");
          error.code = "ERR_WW_MIRROR_PEER_MISMATCH";
          throw error;
        }
        if (!isMirrorLeader(machineId, connectedPeerMachineId)) {
          role = "follower";
          lastError = "";
          return;
        }
        if (!String(info?.rootPath || "").trim()) {
          const error = new Error("WW mirror paused because the peer did not advertise its root path.");
          error.code = "ERR_WW_MIRROR_ROOT_MISSING";
          throw error;
        }
        remoteRootPath = normalizePath(info.rootPath);
        if (remoteRootPath !== normalizedExpectedRemoteRootPath) {
          const error = new Error(`WW mirror paused: peer root is ${remoteRootPath}, expected ${normalizedExpectedRemoteRootPath}.`);
          error.code = "ERR_WW_MIRROR_ROOT_MISMATCH";
          throw error;
        }
        log(`WW mirror linked with ${activePeer.host}:${activePeer.port} at ${remoteRootPath}`);
      }

      const [local, remote, previous] = await Promise.all([
        scanLocalMirrorTree(normalizedRootPath),
        scanRemoteMirrorTree(client, remoteRootPath),
        statePromise,
      ]);
      const actions = planMirrorActions({
        local,
        remote,
        previousLocal: previous.local,
        previousRemote: previous.remote,
        machineId,
        peerMachineId: connectedPeerMachineId || configuredPeerMachineId,
      });

      for (const action of actions) {
        if (action.type === "delete") {
          if (local.has(action.path)) {
            await removeLocalPath(normalizedRootPath, action.path);
          }
          if (remote.has(action.path)) {
            await deleteRemotePath(client, pathFor(remoteRootPath, action.path));
          }
          log(`WW mirror deleted ${action.path}`);
          continue;
        }

        if (action.conflict) {
          const conflictPath = await preserveConflictCopy({
            action,
            rootPath: normalizedRootPath,
            remote: client,
            remoteRootPath,
            localRecords: local,
            remoteRecords: remote,
            machineId,
            peerMachineId: connectedPeerMachineId || configuredPeerMachineId,
          });
          if (conflictPath) {
            log(`WW mirror preserved the losing version as ${conflictPath}`);
          }
        }

        if (action.from === "local") {
          await copyLocalToRemote({
            rootPath: normalizedRootPath,
            remote: client,
            remoteRootPath,
            relativePath: action.path,
            record: action.record,
          });
        } else {
          await copyRemoteToLocal({
            rootPath: normalizedRootPath,
            remote: client,
            remoteRootPath,
            relativePath: action.path,
            record: action.record,
          });
        }
        log(`WW mirror ${action.conflict ? "resolved conflict and " : ""}copied ${action.path} ${action.from} -> ${action.from === "local" ? "remote" : "local"}`);
      }

      const nextLocal = await scanLocalMirrorTree(normalizedRootPath);
      const nextRemote = await scanRemoteMirrorTree(client, remoteRootPath);
      statePromise = Promise.resolve({ local: nextLocal, remote: nextRemote });
      await writeState(normalizedStatePath, await statePromise);
      lastError = "";
    } catch (error) {
      const nextError = String(error?.message || "WW mirror failed.");
      if (nextError !== lastError) {
        log(nextError);
      }
      lastError = nextError;
      resetConnection();
    } finally {
      running = false;
    }
  }

  return {
    start() {
      stopped = false;
      if (!timer) {
        void syncOnce();
        timer = setInterval(() => {
          void syncOnce();
        }, Math.max(500, Number(intervalMs) || WW_MIRROR_INTERVAL_MS));
        timer.unref?.();
      }
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    getStatus() {
      return {
        connected: Boolean(client && remoteRootPath),
        role,
        rootPath: normalizedRootPath,
        remoteRootPath,
        peerMachineId: connectedPeerMachineId || String(peerMachineId || "").trim(),
        error: lastError,
      };
    },
    syncNow: syncOnce,
  };
}

export function buildMirrorStateHash(state = {}) {
  return crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
