import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  atomicWriteJson,
  delay,
  hashBuffer,
  hashFile,
  isZeroBuffer,
  jsonRecord,
  makeId,
  mapLimit,
  normalizeRelative,
  pathExists,
  readJson,
  readRange,
  resolveInside,
  throwIfAborted,
  writeAll,
} from "./primitives.mjs";

export const WW_SYNC_ENGINE_VERSION = 3;

const MODES = new Set(["send-receive", "send-only", "receive-only", "archive-only"]);
const SYMLINK_POLICIES = new Set(["ignore", "preserve-link", "follow-within-root"]);
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_LARGE_FILE = 4 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function globToRegExp(pattern, directoryOnly) {
  let source = String(pattern || "").replaceAll("\\", "/");
  const anchored = source.startsWith("/");
  if (anchored) source = source.slice(1);
  if (source.endsWith("/")) source = source.slice(0, -1);
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "*") {
      if (source[index + 1] === "*") {
        index += 1;
        if (source[index + 1] === "/") {
          index += 1;
          result += "(?:.*/)?";
        } else {
          result += ".*";
        }
      } else {
        result += "[^/]*";
      }
    } else if (char === "?") {
      result += "[^/]";
    } else {
      result += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  const prefix = anchored || source.includes("/") ? "^" : "(?:^|/)";
  const suffix = directoryOnly ? "(?:/.*)?$" : "$";
  return new RegExp(`${prefix}${result}${suffix}`, "u");
}

/** Compile gitignore-style rules. Later rules win; ! negates an exclusion. */
export function compileSyncPolicy(input = {}) {
  const sourceRules = Array.isArray(input)
    ? input
    : Array.isArray(input.rules)
      ? input.rules
      : typeof input.rules === "string"
        ? input.rules.split(/\r?\n/u)
        : [
            ...(Array.isArray(input.exclude) ? input.exclude : []),
            ...(Array.isArray(input.include) ? input.include.map((value) => `!${value}`) : []),
          ];
  const rules = [];
  for (let index = 0; index < sourceRules.length; index += 1) {
    let text = String(sourceRules[index] ?? "").trim();
    if (!text || text.startsWith("#")) continue;
    if (text.startsWith("\\#")) text = text.slice(1);
    let include = false;
    if (text.startsWith("!") && !text.startsWith("\\!")) {
      include = true;
      text = text.slice(1);
    } else if (text.startsWith("\\!")) {
      text = text.slice(1);
    }
    if (!text) continue;
    const directoryOnly = text.endsWith("/");
    rules.push({
      index,
      text: String(sourceRules[index]),
      pattern: text,
      include,
      directoryOnly,
      regex: globToRegExp(text, directoryOnly),
    });
  }

  function explain(candidate, options = {}) {
    const relativePath = normalizeRelative(candidate);
    const directory = Boolean(options.directory);
    let included = input.defaultInclude !== false;
    let matchedRule = null;
    for (const rule of rules) {
      if (rule.directoryOnly && !directory && !relativePath.includes("/")) continue;
      if (rule.regex.test(relativePath)) {
        included = rule.include;
        matchedRule = rule;
      }
    }
    return {
      path: relativePath,
      included,
      ignored: !included,
      reason: matchedRule
        ? `${matchedRule.include ? "included" : "excluded"} by rule ${matchedRule.text}`
        : `included by ${input.defaultInclude === false ? "explicit-only" : "default"} policy`,
      rule: matchedRule ? {
        index: matchedRule.index,
        text: matchedRule.text,
        pattern: matchedRule.pattern,
        negated: matchedRule.include,
        directoryOnly: matchedRule.directoryOnly,
      } : null,
    };
  }

  return Object.freeze({
    rules: rules.map(({ regex: _regex, ...rule }) => ({ ...rule })),
    explain,
    test(candidate, options) {
      return explain(candidate, options).included;
    },
    matches(candidate, options) {
      return explain(candidate, options).included;
    },
  });
}

function entrySignature(entry) {
  if (!entry) return "missing";
  return `${entry.kind}:${entry.hash || entry.target || ""}:${entry.size || 0}`;
}

function entriesEqual(left, right) {
  return entrySignature(left) === entrySignature(right);
}

function serializeError(error) {
  return { code: String(error?.code || error?.name || "ERR_SYNC"), message: String(error?.message || error) };
}

function sanitizeFolder(input) {
  const rootPath = path.resolve(String(input?.rootPath || input?.path || ""));
  if (!String(input?.rootPath || input?.path || "").trim()) throw new Error("A sync folder rootPath is required.");
  const mode = String(input.mode || "send-receive");
  if (!MODES.has(mode)) throw new Error(`Unsupported sync folder mode: ${mode}`);
  const symlinkPolicy = String(input.symlinkPolicy || "ignore");
  if (!SYMLINK_POLICIES.has(symlinkPolicy)) throw new Error(`Unsupported symlink policy: ${symlinkPolicy}`);
  return {
    ...clone(input),
    id: String(input.id || makeId("folder", rootPath)),
    rootPath,
    label: String(input.label || path.basename(rootPath) || rootPath),
    mode,
    peers: [...new Set((input.peers || input.peerIds || []).map(String))],
    rules: Array.isArray(input.rules) ? [...input.rules] : typeof input.rules === "string" ? input.rules.split(/\r?\n/u) : [],
    symlinkPolicy,
    chunkSize: Math.max(64 * 1024, Number(input.chunkSize) || DEFAULT_CHUNK_SIZE),
    largeFileThreshold: Math.max(0, Number(input.largeFileThreshold) || DEFAULT_LARGE_FILE),
    concurrency: Math.max(1, Number(input.concurrency) || 3),
    bandwidthLimit: Math.max(0, Number(input.bandwidthLimit || input.bandwidthBytesPerSecond) || 0),
    versionRetention: Math.max(0, Number(input.versionRetention ?? 50)),
    priority: Array.isArray(input.priority) ? [...input.priority] : [],
  };
}

function sanitizePeer(input) {
  const id = String(input?.id || input?.machineId || "").trim();
  if (!id) throw new Error("A sync peer id is required.");
  return {
    ...clone(Object.fromEntries(Object.entries(input).filter(([, value]) => typeof value !== "function" && typeof value !== "object"))),
    id,
    label: String(input.label || id),
    machineId: String(input.machineId || id),
    rootPath: input.rootPath ? path.resolve(String(input.rootPath)) : "",
    folderId: String(input.folderId || ""),
    online: input.online !== false,
    engineVersion: Number(input.engineVersion) || WW_SYNC_ENGINE_VERSION,
  };
}

async function scanTree(folder, previous = {}, { signal, onEntry } = {}) {
  const root = folder.rootPath;
  const policy = compileSyncPolicy({ rules: folder.rules });
  const records = {};
  const explanations = {};
  const rootReal = await fsp.realpath(root);

  async function walk(directory, relativeDirectory = "") {
    throwIfAborted(signal);
    const dirents = await fsp.readdir(directory, { withFileTypes: true });
    dirents.sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of dirents) {
      throwIfAborted(signal);
      const relative = normalizeRelative(relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name);
      if (!relative) continue;
      const absolute = resolveInside(root, relative);
      const stats = await fsp.lstat(absolute);
      const isDirectory = stats.isDirectory();
      const explanation = policy.explain(relative, { directory: isDirectory });
      explanations[relative] = explanation;
      if (!explanation.included) {
        // Descend through ignored directories so a later negated rule can
        // deliberately re-include a child, while never recording the ignored
        // parent itself as synchronized content.
        if (isDirectory) await walk(absolute, relative);
        continue;
      }
      if (stats.isSymbolicLink()) {
        if (folder.symlinkPolicy === "ignore") continue;
        const target = await fsp.readlink(absolute);
        if (folder.symlinkPolicy === "preserve-link") {
          records[relative] = {
            path: relative,
            kind: "symlink",
            target,
            hash: hashBuffer(Buffer.from(target)),
            size: Buffer.byteLength(target),
            mtimeMs: Number(stats.mtimeMs),
            ctimeMs: Number(stats.ctimeMs),
          };
          onEntry?.(records[relative]);
          continue;
        }
        const resolved = await fsp.realpath(absolute);
        const inside = path.relative(rootReal, resolved);
        if (inside.startsWith("..") || path.isAbsolute(inside)) {
          explanations[relative] = { ...explanation, included: false, ignored: true, reason: "symlink target escapes root" };
          continue;
        }
        const followed = await fsp.stat(absolute);
        if (followed.isDirectory()) {
          records[relative] = { path: relative, kind: "directory", size: 0, mtimeMs: Number(followed.mtimeMs) };
          await walk(absolute, relative);
        } else if (followed.isFile()) {
          const hash = await hashFile(absolute, { signal });
          records[relative] = makeFileRecord(relative, followed, hash);
        }
        onEntry?.(records[relative]);
        continue;
      }
      if (stats.isDirectory()) {
        records[relative] = { path: relative, kind: "directory", size: 0, mtimeMs: Number(stats.mtimeMs) };
        onEntry?.(records[relative]);
        await walk(absolute, relative);
      } else if (stats.isFile()) {
        const prior = previous[relative];
        const identity = [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
        // ctime and inode/device make this stronger than size+mtime. If any identity fact
        // changes we hash; equal size/mtime alone can never establish equality.
        const hash = prior?.identity === identity && prior?.hash
          ? prior.hash
          : await hashFile(absolute, { signal });
        records[relative] = { ...makeFileRecord(relative, stats, hash), identity };
        onEntry?.(records[relative]);
      }
    }
  }

  await walk(root);
  return { records, explanations };
}

function makeFileRecord(relative, stats, hash) {
  return {
    path: relative,
    kind: "file",
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    ctimeMs: Number(stats.ctimeMs),
    mode: Number(stats.mode),
    dev: Number(stats.dev),
    ino: Number(stats.ino),
    hash,
  };
}

async function chunkManifest(targetPath, record, chunkSize, signal) {
  const chunks = [];
  const handle = await fsp.open(targetPath, "r");
  try {
    for (let offset = 0, index = 0; offset < record.size; offset += chunkSize, index += 1) {
      throwIfAborted(signal);
      const length = Math.min(chunkSize, record.size - offset);
      const bytes = await readRange(handle, offset, length);
      chunks.push({ index, offset, length, hash: hashBuffer(bytes), zero: isZeroBuffer(bytes) });
    }
  } finally {
    await handle.close();
  }
  return { algorithm: "sha256", chunkSize, size: record.size, hash: record.hash, chunks };
}

function priorityFor(relative, priority = []) {
  const normalized = normalizeRelative(relative);
  const index = priority.findIndex((candidate) => normalized === normalizeRelative(candidate) || normalized.startsWith(`${normalizeRelative(candidate)}/`));
  return index < 0 ? priority.length + 1 : index;
}

export function createWorkWireSyncEngine(options = {}) {
  const machineId = String(options.machineId || os.hostname());
  const stateDir = path.resolve(String(options.stateDir || options.storagePath || path.join(process.cwd(), ".workwire-sync")));
  const statePath = path.join(stateDir, "state.json");
  const vault = options.vault || null;
  const runtimePeers = new Map();
  const listeners = new Set();
  const watchers = new Map();
  const pauseWaiters = new Map();
  let initialized = false;
  let persistTail = Promise.resolve();
  let state = {
    version: WW_SYNC_ENGINE_VERSION,
    machineId,
    folders: {},
    peers: {},
    scans: {},
    links: {},
    statuses: {},
    conflicts: {},
    versions: {},
    transfers: {},
    journal: [],
    updatedAt: nowIso(),
  };

  function emit(type, detail = {}) {
    const event = jsonRecord({ type, machineId, at: nowIso(), ...detail });
    for (const listener of listeners) {
      try { listener(event); } catch {}
    }
    options.onEvent?.(event);
  }

  async function persist() {
    const write = async () => {
      state.updatedAt = nowIso();
      await atomicWriteJson(statePath, state);
    };
    const pending = persistTail.then(write, write);
    persistTail = pending.catch(() => {});
    await pending;
  }

  function requireInit() {
    if (!initialized) throw new Error("The WorkWire sync engine is not initialized.");
  }

  function requireFolder(id) {
    requireInit();
    const folder = state.folders[String(id)];
    if (!folder) {
      const error = new Error(`Unknown sync folder: ${id}`);
      error.code = "ERR_WW_SYNC_FOLDER";
      throw error;
    }
    return folder;
  }

  function setStatus(folderId, phase, detail = {}) {
    state.statuses[folderId] = {
      folderId,
      phase,
      state: phase,
      updatedAt: nowIso(),
      ...detail,
    };
    emit("folder-status", state.statuses[folderId]);
  }

  function journal(folderId, event, relativePath = "", detail = {}) {
    state.journal.push({ id: makeId("journal"), folderId, event, path: relativePath, at: nowIso(), ...detail });
    if (state.journal.length > 10_000) state.journal.splice(0, state.journal.length - 10_000);
  }

  function startWatcher(folder) {
    watchers.get(folder.id)?.close?.();
    watchers.delete(folder.id);
    try {
      const watcher = fs.watch(folder.rootPath, { recursive: true }, (eventType, filename) => {
        if (!initialized) return;
        const relative = filename ? String(filename).replaceAll(path.sep, "/") : "";
        journal(folder.id, eventType || "change", relative, { source: "native-watch" });
        state.statuses[folder.id] = { ...(state.statuses[folder.id] || {}), needsScan: true, updatedAt: nowIso() };
        void persist().catch(() => {});
      });
      watcher.on("error", (error) => {
        journal(folder.id, "watch-overflow", "", { error: serializeError(error), requiresFullScan: true });
      });
      watchers.set(folder.id, watcher);
    } catch (error) {
      journal(folder.id, "watch-unavailable", "", { error: serializeError(error), requiresFullScan: true });
    }
  }

  async function getPeerAccess(peerId, folderId) {
    const peer = state.peers[peerId];
    if (!peer) throw Object.assign(new Error(`Unknown sync peer: ${peerId}`), { code: "ERR_WW_SYNC_PEER" });
    if (peer.online === false) throw Object.assign(new Error(`Sync peer ${peerId} is offline.`), { code: "ERR_WW_SYNC_OFFLINE" });
    const runtime = runtimePeers.get(peerId);
    const remoteEngine = runtime?.engine || runtime?.syncEngine;
    if (remoteEngine?._syncProtocol) {
      const negotiated = remoteEngine._syncProtocol.negotiate({ minVersion: 2, maxVersion: WW_SYNC_ENGINE_VERSION });
      if (!negotiated.compatible) throw Object.assign(new Error("No compatible sync protocol version."), { code: "ERR_WW_SYNC_PROTOCOL" });
      const remoteFolderId = String(runtime.folderId || peer.folderId || folderId);
      return {
        peer,
        remoteFolderId,
        rootPath: remoteEngine._syncProtocol.getRoot(remoteFolderId),
        scan: (scanOptions) => remoteEngine._syncProtocol.scan(remoteFolderId, scanOptions),
        createVersion: (relative, reason) => remoteEngine._syncProtocol.createVersion(remoteFolderId, relative, reason),
        machineId: remoteEngine._syncProtocol.machineId,
        persistRemote: () => remoteEngine._syncProtocol.persist(),
      };
    }
    const rootPath = runtime?.rootPath || peer.rootPath;
    if (!rootPath) throw Object.assign(new Error(`Sync peer ${peerId} has no engine or rootPath.`), { code: "ERR_WW_SYNC_PEER_TARGET" });
    const remoteFolder = sanitizeFolder({ ...state.folders[folderId], id: `${folderId}@${peerId}`, rootPath, peers: [] });
    return {
      peer,
      remoteFolderId: remoteFolder.id,
      rootPath,
      scan: async (scanOptions) => (await scanTree(remoteFolder, {}, scanOptions)).records,
      createVersion: async () => null,
      machineId: peer.machineId,
      persistRemote: async () => {},
    };
  }

  async function createVersionFor(folderId, relativePath, reason = "overwrite") {
    const folder = requireFolder(folderId);
    const relative = normalizeRelative(relativePath);
    const source = resolveInside(folder.rootPath, relative);
    const stats = await fsp.lstat(source).catch(() => null);
    if (!stats?.isFile()) return null;
    const hash = await hashFile(source);
    const id = makeId("version", folderId, relative, hash, nowIso(), crypto.randomBytes(4).toString("hex"));
    const record = {
      id,
      folderId,
      path: relative,
      reason,
      hash,
      size: Number(stats.size),
      mtimeMs: Number(stats.mtimeMs),
      createdAt: nowIso(),
      machineId,
      storage: null,
    };
    if (vault?.ingestFile && vault?.openObject) {
      try {
        const object = await vault.ingestFile(source, { kind: "sync-version", folderId, path: relative, reason });
        const objectHash = object?.objectHash || (/^(?:sha256:)?[a-f0-9]{64}$/iu.test(String(object?.hash || "")) ? object.hash : null);
        if (objectHash) record.storage = { type: "vault-object", objectHash };
        else if (object?.id && vault?.restoreSnapshot) record.storage = { type: "vault-snapshot", snapshotId: object.id };
      } catch {}
    }
    if (!record.storage) {
      const objectPath = path.join(stateDir, "versions", hash.slice(0, 2), hash);
      await fsp.mkdir(path.dirname(objectPath), { recursive: true });
      if (!await pathExists(objectPath)) await fsp.copyFile(source, objectPath);
      record.storage = { type: "filesystem", path: objectPath };
    }
    state.versions[id] = record;
    const related = Object.values(state.versions)
      .filter((version) => version.folderId === folderId && version.path === relative)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const expired of related.slice(folder.versionRetention)) delete state.versions[expired.id];
    await persist();
    emit("version-created", { version: record });
    return record;
  }

  async function openVersion(record) {
    if (record.storage?.type === "vault-object") return vault.openObject(record.storage.objectHash);
    if (record.storage?.type === "vault-snapshot") {
      const stream = new PassThrough();
      void vault.restoreSnapshot(record.storage.snapshotId, stream, { asFile: true }).catch((error) => stream.destroy(error));
      return stream;
    }
    return fs.createReadStream(record.storage.path);
  }

  async function waitWhilePaused(folderId, signal) {
    while (state.statuses[folderId]?.phase === "paused") {
      throwIfAborted(signal);
      await new Promise((resolve) => {
        const waiters = pauseWaiters.get(folderId) || [];
        waiters.push(resolve);
        pauseWaiters.set(folderId, waiters);
        if (signal) signal.addEventListener("abort", resolve, { once: true });
      });
    }
    throwIfAborted(signal);
  }

  async function copyFileDelta({ folderId, sourceRoot, destinationRoot, relative, sourceRecord, signal, onProgress, bandwidthLimit = 0 }) {
    const sourcePath = resolveInside(sourceRoot, relative);
    const destinationPath = resolveInside(destinationRoot, relative);
    const folder = state.folders[folderId];
    const manifest = await chunkManifest(sourcePath, sourceRecord, folder.chunkSize, signal);
    const transferKey = makeId("transfer", destinationRoot, relative, sourceRecord.hash);
    const temporary = path.join(stateDir, "transfers", `${transferKey}.part`);
    await fsp.mkdir(path.dirname(temporary), { recursive: true });
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });

    let checkpoint = state.transfers[transferKey];
    if (!checkpoint || checkpoint.hash !== sourceRecord.hash || checkpoint.size !== sourceRecord.size || checkpoint.temporary !== temporary) {
      checkpoint = {
        id: transferKey,
        folderId,
        path: relative,
        source: sourcePath,
        destination: destinationPath,
        temporary,
        hash: sourceRecord.hash,
        size: sourceRecord.size,
        completedChunks: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.transfers[transferKey] = checkpoint;
      await fsp.rm(temporary, { force: true });
      await persist();
    }

    const sourceHandle = await fsp.open(sourcePath, "r");
    const tempHandle = await fsp.open(temporary, await pathExists(temporary) ? "r+" : "w+");
    const destinationHandle = await fsp.open(destinationPath, "r").catch(() => null);
    const destinationStats = destinationHandle ? await destinationHandle.stat() : null;
    let destinationManifest = null;
    if (destinationHandle && destinationStats.isFile() && destinationStats.size === sourceRecord.size) {
      const destinationHash = await hashFile(destinationPath, { signal });
      destinationManifest = await chunkManifest(destinationPath, { ...sourceRecord, hash: destinationHash }, folder.chunkSize, signal);
    }
    const completed = new Set(checkpoint.completedChunks || []);
    let transferredBytes = 0;
    let reusedBytes = 0;
    let processedBytes = [...completed].reduce((total, index) => total + (manifest.chunks[index]?.length || 0), 0);
    const startedAt = Date.now();
    try {
      await tempHandle.truncate(sourceRecord.size);
      for (const chunk of manifest.chunks) {
        await waitWhilePaused(folderId, signal);
        if (completed.has(chunk.index)) {
          const current = await readRange(tempHandle, chunk.offset, chunk.length);
          if (current.length === chunk.length && hashBuffer(current) === chunk.hash) {
            onProgress?.({ stage: "transfer-progress", path: relative, processedBytes, totalBytes: sourceRecord.size, transferredBytes, reusedBytes, resumed: true });
            continue;
          }
          completed.delete(chunk.index);
        }
        const reusable = destinationManifest?.chunks[chunk.index];
        if (reusable?.hash === chunk.hash) {
          if (!chunk.zero) {
            const bytes = await readRange(destinationHandle, chunk.offset, chunk.length);
            await writeAll(tempHandle, bytes, chunk.offset);
          }
          reusedBytes += chunk.length;
        } else {
          const bytes = await readRange(sourceHandle, chunk.offset, chunk.length);
          if (hashBuffer(bytes) !== chunk.hash) throw Object.assign(new Error(`Source changed while transferring ${relative}.`), { code: "ERR_WW_SYNC_SOURCE_CHANGED" });
          if (!chunk.zero) await writeAll(tempHandle, bytes, chunk.offset);
          transferredBytes += bytes.length;
          if (bandwidthLimit > 0) {
            const expectedMs = (transferredBytes / bandwidthLimit) * 1000;
            const waitMs = expectedMs - (Date.now() - startedAt);
            if (waitMs > 1) await delay(waitMs, signal);
          }
        }
        completed.add(chunk.index);
        processedBytes += chunk.length;
        checkpoint.completedChunks = [...completed].sort((a, b) => a - b);
        checkpoint.updatedAt = nowIso();
        checkpoint.transferredBytes = (checkpoint.transferredBytes || 0) + (reusable?.hash === chunk.hash ? 0 : chunk.length);
        await tempHandle.sync();
        await persist();
        const progress = { stage: "transfer-progress", folderId, path: relative, processedBytes, totalBytes: sourceRecord.size, transferredBytes, reusedBytes };
        emit("progress", progress);
        onProgress?.(progress);
      }
      await tempHandle.sync();
    } finally {
      await sourceHandle.close();
      await tempHandle.close();
      await destinationHandle?.close();
    }

    const finalHash = await hashFile(temporary, { signal });
    if (finalHash !== sourceRecord.hash) {
      checkpoint.completedChunks = [];
      await persist();
      throw Object.assign(new Error(`Final verification failed for ${relative}.`), { code: "ERR_WW_SYNC_VERIFY" });
    }
    if (await pathExists(destinationPath)) {
      const existing = await fsp.lstat(destinationPath);
      if (!existing.isFile() && !existing.isSymbolicLink()) await fsp.rm(destinationPath, { recursive: true, force: true });
    }
    await fsp.rename(temporary, destinationPath);
    await fsp.chmod(destinationPath, sourceRecord.mode & 0o777).catch(() => {});
    const timestamp = sourceRecord.mtimeMs / 1000;
    await fsp.utimes(destinationPath, timestamp, timestamp).catch(() => {});
    delete state.transfers[transferKey];
    await persist();
    return { path: relative, transferredBytes, reusedBytes, totalBytes: sourceRecord.size, chunks: manifest.chunks.length };
  }

  async function applyRecord({ folderId, sourceRoot, destinationRoot, relative, record, signal, onProgress, remoteVersion }) {
    const destination = resolveInside(destinationRoot, relative);
    const existing = await fsp.lstat(destination).catch(() => null);
    if (existing && destinationRoot === state.folders[folderId].rootPath) await createVersionFor(folderId, relative, "overwrite");
    else if (existing && remoteVersion) await remoteVersion(relative, "overwrite");
    if (record.kind === "directory") {
      if (existing && !existing.isDirectory()) await fsp.rm(destination, { recursive: true, force: true });
      await fsp.mkdir(destination, { recursive: true });
      return { path: relative, transferredBytes: 0, reusedBytes: 0 };
    }
    if (record.kind === "symlink") {
      if (existing) await fsp.rm(destination, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.symlink(record.target, destination);
      return { path: relative, transferredBytes: Buffer.byteLength(record.target), reusedBytes: 0 };
    }
    if (existing && !existing.isFile()) await fsp.rm(destination, { recursive: true, force: true });
    return copyFileDelta({
      folderId,
      sourceRoot,
      destinationRoot,
      relative,
      sourceRecord: record,
      signal,
      onProgress,
      bandwidthLimit: state.folders[folderId].bandwidthLimit,
    });
  }

  async function deleteRecord({ folderId, rootPath, relative, remoteVersion, archive = false }) {
    const target = resolveInside(rootPath, relative);
    if (!await pathExists(target)) return false;
    if (rootPath === state.folders[folderId].rootPath) await createVersionFor(folderId, relative, "delete");
    else if (remoteVersion) await remoteVersion(relative, "delete");
    if (!archive) await fsp.rm(target, { recursive: true, force: true });
    return !archive;
  }

  async function recordConflict(folderId, peerId, relative, local, remote, remoteAccess) {
    const id = makeId("conflict", folderId, peerId, relative, local?.hash || "missing", remote?.hash || "missing");
    if (state.conflicts[id] && state.conflicts[id].resolutionState === "unresolved") return state.conflicts[id];
    const leftVersion = local?.kind === "file" ? await createVersionFor(folderId, relative, "conflict-left") : null;
    let rightVersion = null;
    if (remote?.kind === "file") rightVersion = await remoteAccess.createVersion(relative, "conflict-right");
    // A filesystem-only peer cannot persist its own version; keep a verified local copy.
    if (remote?.kind === "file" && !rightVersion) {
      const source = resolveInside(remoteAccess.rootPath, relative);
      const objectPath = path.join(stateDir, "versions", remote.hash.slice(0, 2), remote.hash);
      await fsp.mkdir(path.dirname(objectPath), { recursive: true });
      if (!await pathExists(objectPath)) await fsp.copyFile(source, objectPath);
      const versionId = makeId("version", folderId, peerId, relative, remote.hash);
      rightVersion = { id: versionId, folderId, path: relative, hash: remote.hash, size: remote.size, createdAt: nowIso(), storage: { type: "filesystem", path: objectPath } };
      state.versions[versionId] = rightVersion;
    }
    const conflict = {
      id,
      folderId,
      peerId,
      path: relative,
      left: { machineId, observedAt: nowIso(), entry: local || null, versionId: leftVersion?.id || null },
      right: { machineId: remoteAccess.machineId, observedAt: nowIso(), entry: remote || null, versionId: rightVersion?.id || null },
      base: clone(state.links[folderId]?.[peerId] || null),
      createdAt: nowIso(),
      resolutionState: "unresolved",
      resolution: null,
    };
    state.conflicts[id] = conflict;
    await persist();
    setStatus(folderId, "conflict", { conflictCount: Object.values(state.conflicts).filter((item) => item.folderId === folderId && item.resolutionState === "unresolved").length });
    emit("conflict", { conflict });
    return conflict;
  }

  async function syncPeer(folder, peerId, optionsForSync) {
    const { signal, onProgress } = optionsForSync;
    const access = await getPeerAccess(peerId, folder.id);
    const local = (await scanTree(folder, state.scans[folder.id]?.records || {}, { signal })).records;
    const remote = await access.scan({ signal });
    state.links[folder.id] ||= {};
    const baseline = state.links[folder.id][peerId] || { local: {}, remote: {} };
    const paths = [...new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(baseline.local || {}), ...Object.keys(baseline.remote || {})])].sort();
    const actions = [];
    let conflicts = 0;

    for (const relative of paths) {
      const left = local[relative] || null;
      const right = remote[relative] || null;
      if (entriesEqual(left, right)) continue;
      const leftChanged = !entriesEqual(left, baseline.local?.[relative] || null);
      const rightChanged = !entriesEqual(right, baseline.remote?.[relative] || null);
      if (folder.mode === "send-only") {
        actions.push({ direction: "push", relative, record: left });
      } else if (folder.mode === "receive-only" || folder.mode === "archive-only") {
        actions.push({ direction: "pull", relative, record: right, archive: folder.mode === "archive-only" });
      } else if (leftChanged && rightChanged) {
        await recordConflict(folder.id, peerId, relative, left, right, access);
        conflicts += 1;
      } else if (leftChanged) {
        actions.push({ direction: "push", relative, record: left });
      } else if (rightChanged) {
        actions.push({ direction: "pull", relative, record: right });
      } else if (!baseline.local?.[relative] && !baseline.remote?.[relative]) {
        await recordConflict(folder.id, peerId, relative, left, right, access);
        conflicts += 1;
      }
    }

    actions.sort((left, right) => priorityFor(left.relative, folder.priority) - priorityFor(right.relative, folder.priority)
      || (left.record?.kind === "directory" ? -1 : 1) - (right.record?.kind === "directory" ? -1 : 1)
      || left.relative.localeCompare(right.relative));
    const results = await mapLimit(actions, folder.concurrency, async (action) => {
      throwIfAborted(signal);
      await waitWhilePaused(folder.id, signal);
      const sourceRoot = action.direction === "push" ? folder.rootPath : access.rootPath;
      const destinationRoot = action.direction === "push" ? access.rootPath : folder.rootPath;
      if (!action.record) {
        const deleted = await deleteRecord({
          folderId: folder.id,
          rootPath: destinationRoot,
          relative: action.relative,
          remoteVersion: action.direction === "push" ? access.createVersion : null,
          archive: action.archive,
        });
        return { ...action, deleted, transferredBytes: 0, reusedBytes: 0 };
      }
      const result = await applyRecord({
        folderId: folder.id,
        sourceRoot,
        destinationRoot,
        relative: action.relative,
        record: action.record,
        signal,
        onProgress,
        remoteVersion: action.direction === "push" ? access.createVersion : null,
      });
      return { ...action, ...result };
    });
    const nextLocal = (await scanTree(folder, local, { signal })).records;
    const remoteFolder = sanitizeFolder({ ...folder, id: access.remoteFolderId, rootPath: access.rootPath, peers: [] });
    const nextRemote = await access.scan({ signal });
    state.scans[folder.id] = { records: nextLocal, scannedAt: nowIso(), complete: true };
    state.links[folder.id][peerId] = { local: nextLocal, remote: nextRemote, syncedAt: nowIso() };
    await access.persistRemote();
    await persist();
    return {
      peerId,
      actions: results.length,
      conflicts,
      transferredBytes: results.reduce((sum, item) => sum + (item.transferredBytes || 0), 0),
      reusedBytes: results.reduce((sum, item) => sum + (item.reusedBytes || 0), 0),
      results,
      remoteFolder: remoteFolder.id,
    };
  }

  const engine = {
    async init() {
      if (initialized) return engine;
      await fsp.mkdir(stateDir, { recursive: true });
      const loaded = await readJson(statePath, state);
      state = { ...state, ...loaded, machineId, version: WW_SYNC_ENGINE_VERSION };
      for (const key of ["folders", "peers", "scans", "links", "statuses", "conflicts", "versions", "transfers"]) state[key] ||= {};
      state.journal ||= [];
      initialized = true;
      await vault?.init?.();
      for (const folder of Object.values(state.folders)) {
        await fsp.mkdir(folder.rootPath, { recursive: true });
        startWatcher(folder);
      }
      await persist();
      return engine;
    },

    async close() {
      if (!initialized) return;
      initialized = false;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      await persist();
    },

    async addFolder(config) {
      requireInit();
      const folder = sanitizeFolder(config);
      if (state.folders[folder.id]) throw Object.assign(new Error(`Sync folder already exists: ${folder.id}`), { code: "ERR_WW_SYNC_FOLDER_EXISTS" });
      await fsp.mkdir(folder.rootPath, { recursive: true });
      state.folders[folder.id] = folder;
      setStatus(folder.id, "scanning", { needsScan: true });
      journal(folder.id, "folder-added", "", { requiresFullScan: true });
      startWatcher(folder);
      await persist();
      return clone(folder);
    },

    async updateFolder(id, patch) {
      const current = requireFolder(id);
      const folder = sanitizeFolder({ ...current, ...clone(patch), id: current.id });
      state.folders[id] = folder;
      startWatcher(folder);
      journal(id, "folder-updated", "", { requiresFullScan: true });
      await persist();
      return clone(folder);
    },

    async removeFolder(id) {
      requireFolder(id);
      watchers.get(id)?.close();
      watchers.delete(id);
      delete state.folders[id];
      delete state.scans[id];
      delete state.links[id];
      delete state.statuses[id];
      await persist();
      return true;
    },

    async addPeer(config) {
      requireInit();
      const peer = sanitizePeer(config);
      if (state.peers[peer.id]) throw Object.assign(new Error(`Sync peer already exists: ${peer.id}`), { code: "ERR_WW_SYNC_PEER_EXISTS" });
      state.peers[peer.id] = peer;
      runtimePeers.set(peer.id, config);
      await persist();
      return clone(peer);
    },

    async updatePeer(id, patch) {
      requireInit();
      if (!state.peers[id]) throw Object.assign(new Error(`Unknown sync peer: ${id}`), { code: "ERR_WW_SYNC_PEER" });
      const runtime = { ...(runtimePeers.get(id) || {}), ...patch, id };
      runtimePeers.set(id, runtime);
      state.peers[id] = sanitizePeer({ ...state.peers[id], ...patch, id });
      await persist();
      return clone(state.peers[id]);
    },

    async removePeer(id) {
      requireInit();
      delete state.peers[id];
      runtimePeers.delete(id);
      for (const links of Object.values(state.links)) delete links[id];
      await persist();
      return true;
    },

    async scan(folderId, scanOptions = {}) {
      const folder = requireFolder(folderId);
      setStatus(folderId, "scanning");
      try {
        const result = await scanTree(folder, state.scans[folderId]?.records || {}, {
          signal: scanOptions.signal,
          onEntry: (entry) => {
            scanOptions.onProgress?.({ stage: "scanning", folderId, path: entry.path });
          },
        });
        const prior = state.scans[folderId]?.records || {};
        for (const relative of new Set([...Object.keys(prior), ...Object.keys(result.records)])) {
          if (!entriesEqual(prior[relative], result.records[relative])) journal(folderId, result.records[relative] ? "changed" : "deleted", relative);
        }
        state.scans[folderId] = { records: result.records, explanations: result.explanations, scannedAt: nowIso(), complete: true };
        setStatus(folderId, "in-sync", { needsScan: false, entries: Object.keys(result.records).length });
        await persist();
        return clone(state.scans[folderId]);
      } catch (error) {
        setStatus(folderId, error?.code === "ENOSPC" ? "out-of-space" : "error", { error: serializeError(error) });
        await persist();
        throw error;
      }
    },

    async sync(folderId, syncOptions = {}) {
      const folder = requireFolder(folderId);
      const peerIds = syncOptions.peers || syncOptions.peerIds || folder.peers;
      setStatus(folderId, "scanning", { peers: peerIds });
      try {
        await engine.scan(folderId, syncOptions);
        setStatus(folderId, "hashing", { peers: peerIds });
        const peerResults = [];
        for (const peerId of peerIds) {
          setStatus(folderId, "transferring", { peerId });
          try {
            peerResults.push(await syncPeer(folder, String(peerId), syncOptions));
          } catch (error) {
            if (error?.code === "ERR_WW_SYNC_OFFLINE") {
              setStatus(folderId, "offline", { peerId, error: serializeError(error) });
              peerResults.push({ peerId, offline: true, error: serializeError(error) });
              continue;
            }
            throw error;
          }
        }
        const unresolved = Object.values(state.conflicts).filter((item) => item.folderId === folderId && item.resolutionState === "unresolved").length;
        setStatus(folderId, unresolved ? "conflict" : "in-sync", { conflictCount: unresolved, peers: peerIds });
        await persist();
        const result = {
          folderId,
          state: unresolved ? "conflict" : "in-sync",
          peers: peerResults,
          transferredBytes: peerResults.reduce((sum, item) => sum + (item.transferredBytes || 0), 0),
          reusedBytes: peerResults.reduce((sum, item) => sum + (item.reusedBytes || 0), 0),
          conflicts: unresolved,
          completedAt: nowIso(),
        };
        emit("sync-complete", result);
        return result;
      } catch (error) {
        const phase = error?.name === "AbortError" ? (state.statuses[folderId]?.phase === "paused" ? "paused" : "error") : error?.code === "ENOSPC" ? "out-of-space" : "error";
        setStatus(folderId, phase, { error: serializeError(error) });
        await persist();
        throw error;
      }
    },

    async pause(folderId) {
      requireFolder(folderId);
      setStatus(folderId, "paused");
      await persist();
      return clone(state.statuses[folderId]);
    },

    async resume(folderId) {
      requireFolder(folderId);
      setStatus(folderId, "scanning", { needsScan: true });
      for (const resolve of pauseWaiters.get(folderId) || []) resolve();
      pauseWaiters.delete(folderId);
      await persist();
      return clone(state.statuses[folderId]);
    },

    getFolderStatus(folderId) {
      const folder = requireFolder(folderId);
      return clone({ folder, ...(state.statuses[folderId] || { folderId, phase: "scanning", state: "scanning" }) });
    },

    getPeerStatus(peerId) {
      requireInit();
      const peer = state.peers[peerId];
      if (!peer) return null;
      return clone({ ...peer, state: peer.online === false ? "offline" : "online", configuredFolders: Object.values(state.folders).filter((folder) => folder.peers.includes(peerId)).map((folder) => folder.id) });
    },

    getConflicts(folderId, query = {}) {
      requireFolder(folderId);
      return clone(Object.values(state.conflicts).filter((conflict) => conflict.folderId === folderId
        && (!query.state || conflict.resolutionState === query.state)
        && (!query.path || conflict.path === normalizeRelative(query.path))).sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
    },

    async resolveConflict(conflictId, resolution) {
      requireInit();
      const conflict = state.conflicts[conflictId];
      if (!conflict) throw Object.assign(new Error(`Unknown conflict: ${conflictId}`), { code: "ERR_WW_SYNC_CONFLICT" });
      const choice = typeof resolution === "string" ? resolution : String(resolution?.choice || resolution?.type || "");
      const folder = requireFolder(conflict.folderId);
      const peerAccess = await getPeerAccess(conflict.peerId, conflict.folderId);
      const target = resolveInside(folder.rootPath, conflict.path);
      async function restoreSide(side, destination = target) {
        const version = state.versions[conflict[side].versionId];
        if (!version) {
          if (!conflict[side].entry) await fsp.rm(destination, { recursive: true, force: true });
          return;
        }
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        const stream = await openVersion(version);
        const temporary = `${destination}.ww-merged-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
        await pipeline(stream, fs.createWriteStream(temporary, { flags: "wx" }));
        await fsp.rename(temporary, destination);
      }
      if (choice === "keep-left") await restoreSide("left");
      else if (choice === "keep-right") {
        const localVersion = state.versions[conflict.right.versionId];
        if (localVersion) await restoreSide("right");
        else if (conflict.right.entry) await applyRecord({ folderId: folder.id, sourceRoot: peerAccess.rootPath, destinationRoot: folder.rootPath, relative: conflict.path, record: conflict.right.entry, remoteVersion: null });
      } else if (choice === "keep-both") {
        const parsed = path.parse(target);
        const other = path.join(parsed.dir, `${parsed.name} (conflict ${conflict.right.machineId})${parsed.ext}`);
        await restoreSide("left", target);
        const rightVersion = state.versions[conflict.right.versionId];
        if (rightVersion) await restoreSide("right", other);
        else if (conflict.right.entry) await applyRecord({ folderId: folder.id, sourceRoot: peerAccess.rootPath, destinationRoot: parsed.dir, relative: path.basename(other), record: conflict.right.entry, remoteVersion: null });
      } else if (choice === "merged") {
        const content = resolution?.content ?? resolution?.mergedContent;
        if (content === undefined) throw new Error("Merged conflict resolution requires content.");
        await createVersionFor(folder.id, conflict.path, "pre-merge");
        await fsp.mkdir(path.dirname(target), { recursive: true });
        if (content && typeof content.pipe === "function") {
          await pipeline(content, fs.createWriteStream(target, { flags: "w" }));
        } else {
          await fsp.writeFile(target, Buffer.isBuffer(content) ? content : String(content));
        }
      } else {
        throw new Error(`Unsupported conflict resolution: ${choice}`);
      }
      conflict.resolutionState = "resolved";
      conflict.resolution = { choice, resolvedAt: nowIso(), machineId };
      await persist();
      emit("conflict-resolved", { conflict });
      return clone(conflict);
    },

    getVersions(relativePath, query = {}) {
      requireInit();
      const relative = normalizeRelative(relativePath);
      return clone(Object.values(state.versions).filter((version) => version.path === relative
        && (!query.folderId || version.folderId === query.folderId)
        && (!query.reason || version.reason === query.reason)).sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
    },

    async restoreVersion(versionId, destination, restoreOptions = {}) {
      requireInit();
      const version = state.versions[versionId];
      if (!version) throw Object.assign(new Error(`Unknown version: ${versionId}`), { code: "ERR_WW_SYNC_VERSION" });
      const folder = requireFolder(version.folderId);
      const target = destination ? path.resolve(String(destination)) : resolveInside(folder.rootPath, version.path);
      if (!destination) await createVersionFor(folder.id, version.path, "pre-restore");
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.ww-restore-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      const stream = await openVersion(version);
      try {
        await pipeline(stream, fs.createWriteStream(temporary, { flags: "wx" }), {
          signal: restoreOptions.signal,
        });
      } catch (error) {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      if (await hashFile(temporary) !== version.hash) {
        await fsp.rm(temporary, { force: true });
        throw Object.assign(new Error("Restored version failed verification."), { code: "ERR_WW_SYNC_VERIFY" });
      }
      await fsp.rename(temporary, target);
      emit("version-restored", { versionId, destination: target });
      return { versionId, destination: target, hash: version.hash, verified: true };
    },

    onEvent(listener) {
      if (typeof listener !== "function") throw new TypeError("A sync event listener must be a function.");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    _syncProtocol: {
      machineId,
      negotiate({ minVersion = 1, maxVersion = Infinity } = {}) {
        const selectedVersion = Math.min(WW_SYNC_ENGINE_VERSION, Number(maxVersion) || WW_SYNC_ENGINE_VERSION);
        return { compatible: selectedVersion >= Math.max(2, Number(minVersion) || 1), selectedVersion, engineVersion: WW_SYNC_ENGINE_VERSION };
      },
      getRoot(folderId) { return requireFolder(folderId).rootPath; },
      async scan(folderId, scanOptions = {}) {
        const folder = requireFolder(folderId);
        return (await scanTree(folder, state.scans[folderId]?.records || {}, scanOptions)).records;
      },
      createVersion: createVersionFor,
      persist,
    },
  };
  return engine;
}

export function getSyncCapabilities() {
  return {
    engineVersion: WW_SYNC_ENGINE_VERSION,
    protocol: { minimumCompatibleVersion: 2, maximumCompatibleVersion: WW_SYNC_ENGINE_VERSION },
    folderModes: [...MODES],
    symlinkPolicies: [...SYMLINK_POLICIES],
    hashing: ["sha256", "lazy-identity-cache"],
    transfer: ["fixed-chunk-delta", "durable-resume", "atomic-replace", "sparse-zero-ranges", "bandwidth-limit", "priority", "parallel"],
    conflictResolutions: ["keep-left", "keep-right", "keep-both", "merged"],
    versionBackends: ["filesystem", "injected-recovery-vault"],
    changeObservation: ["native-watch-when-supported", "durable-journal", "full-scan-fallback"],
  };
}
