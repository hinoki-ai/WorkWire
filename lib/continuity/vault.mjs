import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  atomicJson, canonicalJson, clone, generatedId, iso, jsonSafe, pathExists, readJson,
  safeRelative, sha256, stableId,
} from "./util.mjs";

const VAULT_SCHEMA_VERSION = 1;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;

function normalizeHash(hash) {
  const value = String(hash || "").replace(/^sha256:/, "").toLocaleLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`Invalid SHA-256 object hash: ${hash}`);
  return value;
}

function entryIdentity(chunks) {
  return `sha256:${sha256(canonicalJson(chunks.map(({ hash, size, zero = false }) => ({ hash, size, zero }))))}`;
}

function isZero(buffer) {
  for (let index = 0; index < buffer.length; index += 1) if (buffer[index] !== 0) return false;
  return true;
}

function metadataFromStats(stats) {
  return {
    size: stats.size,
    mode: stats.mode,
    uid: Number.isInteger(stats.uid) ? stats.uid : null,
    gid: Number.isInteger(stats.gid) ? stats.gid : null,
    atime: stats.atime.toISOString(),
    mtime: stats.mtime.toISOString(),
    ctime: stats.ctime.toISOString(),
    birthtime: stats.birthtime.toISOString(),
    sparse: stats.isFile() && stats.size > 0 && Number(stats.blocks) * 512 < stats.size,
  };
}

async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeFully(handle, buffer, position) {
  let cursor = 0;
  while (cursor < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, cursor, buffer.length - cursor, position + cursor);
    if (!bytesWritten) throw new Error("Vault restore made no write progress.");
    cursor += bytesWritten;
  }
}

function bucketKey(timestamp, kind) {
  const date = new Date(timestamp);
  if (kind === "hourly") return date.toISOString().slice(0, 13);
  if (kind === "daily") return date.toISOString().slice(0, 10);
  if (kind === "weekly") {
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const weekday = day.getUTCDay() || 7;
    day.setUTCDate(day.getUTCDate() + 4 - weekday);
    const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((day - yearStart) / 86400000) + 1) / 7);
    return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return "";
}

export function createRecoveryVault(options = {}) {
  const root = path.resolve(options.root || options.stateDir || path.join(process.cwd(), ".workwire", "continuity-vault"));
  const chunkSize = Math.max(4096, Number(options.chunkSize) || DEFAULT_CHUNK_SIZE);
  const paths = {
    root,
    objects: path.join(root, "objects", "sha256"),
    manifests: path.join(root, "manifests"),
    operations: path.join(root, "operations"),
    state: path.join(root, "state"),
    lastScrub: path.join(root, "state", "last-scrub.json"),
  };
  const snapshots = new Map();
  const operations = new Map();
  let initialized = false;
  let closed = false;
  let mutationTail = Promise.resolve();
  let lastScrubResult = null;

  function objectPath(hash) {
    const value = normalizeHash(hash);
    return path.join(paths.objects, value.slice(0, 2), value.slice(2));
  }

  function manifestPath(id) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(String(id)) || String(id).includes("..")) throw new TypeError("Invalid snapshot ID.");
    return path.join(paths.manifests, `${id}.json`);
  }

  function operationPath(id) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(String(id)) || String(id).includes("..")) throw new TypeError("Invalid operation ID.");
    return path.join(paths.operations, `${id}.json`);
  }

  function assertOpen() {
    if (!initialized) throw new Error("Recovery vault is not initialized.");
    if (closed) throw new Error("Recovery vault is closed.");
  }

  function enqueue(task) {
    const run = mutationTail.then(task, task);
    mutationTail = run.catch(() => {});
    return run;
  }

  async function saveOperation(operation) {
    operation.updatedAt = iso();
    operations.set(operation.id, clone(operation));
    await atomicJson(operationPath(operation.id), operation);
  }

  async function finishOperation(operationId) {
    operations.delete(operationId);
    await fs.rm(operationPath(operationId), { force: true });
  }

  async function init() {
    if (initialized && !closed) return api;
    for (const directory of Object.values(paths).filter((value) => !path.extname(value))) {
      await fs.mkdir(directory, { recursive: true });
    }
    await fs.mkdir(paths.manifests, { recursive: true });
    await fs.mkdir(paths.operations, { recursive: true });
    const manifestFiles = await fs.readdir(paths.manifests).catch(() => []);
    for (const name of manifestFiles.filter((value) => value.endsWith(".json"))) {
      const record = await readJson(path.join(paths.manifests, name), null).catch(() => null);
      if (record?.id) snapshots.set(record.id, record);
    }
    const operationFiles = await fs.readdir(paths.operations).catch(() => []);
    for (const name of operationFiles.filter((value) => value.endsWith(".json"))) {
      const record = await readJson(path.join(paths.operations, name), null).catch(() => null);
      if (record?.id) operations.set(record.id, record);
    }
    lastScrubResult = await readJson(paths.lastScrub, null).catch(() => null);
    initialized = true;
    closed = false;
    return api;
  }

  async function close() {
    if (!initialized || closed) return;
    await mutationTail.catch(() => {});
    closed = true;
  }

  async function storeObject(buffer) {
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (isZero(buffer)) return { hash: `sha256:${hash}`, size: buffer.length, zero: true, created: false };
    const filename = objectPath(hash);
    if (await pathExists(filename)) return { hash: `sha256:${hash}`, size: buffer.length, created: false };
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.${generatedId("tmp")}`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, filename);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    return { hash: `sha256:${hash}`, size: buffer.length, created: true };
  }

  function interruptionError(message, operation) {
    const error = new Error(message);
    error.code = "ERR_WW_VAULT_INTERRUPTED";
    error.operationId = operation.id;
    error.resumeOffset = operation.offset || 0;
    return error;
  }

  async function consumeStream(stream, operation, controls = {}) {
    const chunks = Array.isArray(operation.chunks) ? operation.chunks : [];
    let offset = Number(operation.offset) || 0;
    let pending = Buffer.alloc(0);
    const suppliedOffset = controls.offset;
    if (suppliedOffset !== undefined && Number(suppliedOffset) !== offset) {
      const error = new Error(`Vault stream offset ${suppliedOffset} does not match durable resume offset ${offset}.`);
      error.code = "ERR_WW_VAULT_OFFSET";
      error.expectedOffset = offset;
      throw error;
    }
    let skip = suppliedOffset === undefined ? offset : 0;
    const commit = async (buffer) => {
      if (controls.signal?.aborted) throw interruptionError("Vault ingest aborted.", operation);
      const stored = await storeObject(buffer);
      chunks.push({ hash: stored.hash, offset, size: buffer.length, ...(stored.zero ? { zero: true } : {}) });
      offset += buffer.length;
      operation.offset = offset;
      operation.chunks = chunks;
      operation.logicalBytes = offset;
      await saveOperation(operation);
      controls.onProgress?.({ operationId: operation.id, phase: "ingest", bytes: offset, resumedFrom: operation.resumedFrom || 0 });
      if (Number(controls.failAfterBytes) > 0 && offset >= Number(controls.failAfterBytes)) {
        throw interruptionError(`Injected vault ingest interruption at ${offset} bytes.`, operation);
      }
    };
    try {
      for await (const value of stream) {
        let buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (skip > 0) {
          const ignored = Math.min(skip, buffer.length);
          buffer = buffer.subarray(ignored);
          skip -= ignored;
          if (!buffer.length) continue;
        }
        pending = pending.length ? Buffer.concat([pending, buffer]) : buffer;
        while (pending.length >= chunkSize) {
          await commit(pending.subarray(0, chunkSize));
          pending = pending.subarray(chunkSize);
        }
      }
      if (skip > 0) throw new Error(`Resume source ended ${skip} bytes before durable offset.`);
      if (pending.length) await commit(pending);
      return { chunks, size: offset, hash: entryIdentity(chunks) };
    } catch (error) {
      operation.state = "incomplete";
      operation.lastError = { code: error.code || "ERR_WW_VAULT_INGEST", message: error.message, at: iso() };
      await saveOperation(operation);
      error.operationId ||= operation.id;
      error.resumeOffset ??= operation.offset || 0;
      throw error;
    }
  }

  async function saveManifest(input) {
    const base = jsonSafe(input, "snapshot manifest");
    const createdAt = iso(base.createdAt || Date.now());
    const id = String(base.id || stableId("snapshot", {
      createdAt, operationId: base.operationId, kind: base.kind, pinned: base.pinned,
      label: base.label, entries: base.entries, metadata: base.metadata,
    }, 40));
    const manifest = {
      schemaVersion: VAULT_SCHEMA_VERSION, ...base, id, createdAt, timestamp: createdAt,
      logicalBytes: (base.entries || []).filter((entry) => entry.type === "file")
        .reduce((total, entry) => total + Number(entry.size || entry.content?.size || 0), 0),
      entryCount: (base.entries || []).length,
    };
    const filename = manifestPath(id);
    try {
      const handle = await fs.open(filename, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readJson(filename);
      if (canonicalJson(existing) !== canonicalJson(manifest)) throw new Error(`Immutable snapshot manifest collision: ${id}`);
      return existing;
    }
    snapshots.set(id, manifest);
    return clone(manifest);
  }

  async function planPaths(sourcePaths) {
    const plan = [];
    const roots = sourcePaths.map((value) => path.resolve(String(value)));
    const used = new Set();
    for (const rootPath of roots) {
      const basename = path.basename(rootPath) || "root";
      let rootName = basename;
      let suffix = 2;
      while (used.has(rootName)) rootName = `${basename}-${suffix++}`;
      used.add(rootName);
      const visit = async (source, relative) => {
        const stats = await fs.lstat(source, { bigint: false });
        const metadata = metadataFromStats(stats);
        if (stats.isSymbolicLink()) {
          plan.push({ source, path: safeRelative(relative), type: "symlink", target: await fs.readlink(source), ...metadata });
          return;
        }
        if (stats.isDirectory()) {
          plan.push({ source, path: safeRelative(relative), type: "directory", ...metadata });
          const entries = await fs.readdir(source);
          entries.sort((left, right) => left.localeCompare(right));
          for (const name of entries) await visit(path.join(source, name), `${relative}/${name}`);
          return;
        }
        if (!stats.isFile() && !stats.isBlockDevice()) throw new TypeError(`Unsupported vault source type: ${source}`);
        plan.push({ source, path: safeRelative(relative), type: "file", blockDevice: stats.isBlockDevice(), ...metadata });
      };
      await visit(rootPath, rootName);
    }
    return plan;
  }

  async function snapshotPathsUnlocked(sourcePaths, snapshotOptions = {}) {
    assertOpen();
    if (!Array.isArray(sourcePaths) || !sourcePaths.length) throw new TypeError("snapshotPaths requires at least one path.");
    const requestedOperationId = snapshotOptions.operationId || snapshotOptions.resumeOperationId;
    let operation = requestedOperationId ? operations.get(String(requestedOperationId)) : null;
    if (requestedOperationId && !operation) throw new Error(`Vault operation ${requestedOperationId} was not found.`);
    if (!operation) {
      operation = {
        id: generatedId("ingest"), schemaVersion: VAULT_SCHEMA_VERSION, type: "snapshot-ingest", state: "running",
        createdAt: iso(), plan: await planPaths(sourcePaths), entries: [], currentIndex: 0, offset: 0, chunks: [],
        metadata: jsonSafe(snapshotOptions.metadata || {}),
      };
      await saveOperation(operation);
    } else {
      operation.state = "running";
      operation.resumedFrom = operation.offset || 0;
      await saveOperation(operation);
    }
    try {
      while (operation.currentIndex < operation.plan.length) {
        const item = operation.plan[operation.currentIndex];
        if (snapshotOptions.signal?.aborted) throw interruptionError("Vault snapshot ingest aborted.", operation);
        if (item.type !== "file") {
          operation.entries.push({ ...clone(item), source: undefined });
          operation.currentIndex += 1;
          await saveOperation(operation);
          continue;
        }
        if (operation.currentPath && operation.currentPath !== item.path) throw new Error("Vault ingest checkpoint path mismatch.");
        operation.currentPath = item.path;
        const sourceStats = await fs.stat(item.source);
        if (!item.blockDevice && sourceStats.size !== item.size) throw new Error(`Vault source changed during ingest: ${item.source}`);
        const stream = fsSync.createReadStream(item.source, { start: operation.offset || 0 });
        const content = await consumeStream(stream, operation, {
          offset: operation.offset || 0, signal: snapshotOptions.signal,
          failAfterBytes: snapshotOptions.failAfterBytes, onProgress: snapshotOptions.onProgress,
        });
        operation.entries.push({ ...clone(item), source: undefined, content, size: content.size });
        operation.currentIndex += 1;
        operation.currentPath = "";
        operation.offset = 0;
        operation.chunks = [];
        await saveOperation(operation);
      }
      const manifest = await saveManifest({
        operationId: operation.id,
        kind: snapshotOptions.kind || "paths",
        pinned: snapshotOptions.pinned === true,
        label: String(snapshotOptions.label || ""),
        metadata: { ...clone(operation.metadata), ...(snapshotOptions.metadata || {}) },
        entries: operation.entries,
        createdAt: operation.createdAt,
      });
      await finishOperation(operation.id);
      return manifest;
    } catch (error) {
      operation.state = "incomplete";
      operation.lastError = { code: error.code || "ERR_WW_VAULT_INGEST", message: error.message, at: iso() };
      await saveOperation(operation);
      error.operationId ||= operation.id;
      error.resumeOffset ??= operation.offset || 0;
      throw error;
    }
  }

  function snapshotPaths(sourcePaths, snapshotOptions = {}) {
    return enqueue(() => snapshotPathsUnlocked(sourcePaths, snapshotOptions));
  }

  function ingestFile(sourcePath, metadata = {}) {
    return snapshotPaths([sourcePath], { ...metadata, metadata, kind: metadata.kind || "file" });
  }

  function ingestArtifact(sourcePath, metadata = {}) {
    return snapshotPaths([sourcePath], { ...metadata, metadata, kind: "artifact" });
  }

  function ingestStream(stream, metadata = {}) {
    return enqueue(async () => {
      assertOpen();
      if (!stream || typeof stream[Symbol.asyncIterator] !== "function") throw new TypeError("ingestStream requires a readable stream.");
      const requestedOperationId = metadata.operationId || metadata.resumeOperationId;
      let operation = requestedOperationId ? operations.get(String(requestedOperationId)) : null;
      if (requestedOperationId && !operation) throw new Error(`Vault operation ${requestedOperationId} was not found.`);
      if (!operation) {
        operation = {
          id: generatedId("stream"), schemaVersion: VAULT_SCHEMA_VERSION, type: "stream-ingest", state: "running",
          createdAt: iso(), offset: 0, chunks: [], name: safeRelative(metadata.path || metadata.name || "stream.bin"),
          metadata: jsonSafe(metadata.metadata || {}),
        };
        await saveOperation(operation);
      } else {
        operation.state = "running";
        operation.resumedFrom = operation.offset || 0;
        await saveOperation(operation);
      }
      const content = await consumeStream(stream, operation, metadata);
      const entry = {
        path: operation.name, type: "file", size: content.size, content,
        mode: Number(metadata.mode ?? 0o100600), uid: metadata.uid ?? null, gid: metadata.gid ?? null,
        atime: iso(metadata.atime || operation.createdAt), mtime: iso(metadata.mtime || operation.createdAt),
        sparse: Boolean(content.chunks.some((chunk) => chunk.zero)),
      };
      const manifest = await saveManifest({
        operationId: operation.id, kind: metadata.kind || "stream", pinned: metadata.pinned === true,
        label: String(metadata.label || ""), metadata: operation.metadata, entries: [entry], createdAt: operation.createdAt,
      });
      await finishOperation(operation.id);
      return manifest;
    });
  }

  function listSnapshots(query = {}) {
    assertOpen();
    const text = String(typeof query === "string" ? query : query.text || query.query || "").toLocaleLowerCase();
    return [...snapshots.values()]
      .filter((record) => !query.kind || record.kind === query.kind)
      .filter((record) => query.pinned === undefined || record.pinned === query.pinned)
      .filter((record) => !text || canonicalJson(record).toLocaleLowerCase().includes(text))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .map(clone);
  }

  function getSnapshot(id) {
    assertOpen();
    const record = snapshots.get(String(id));
    return record ? clone(record) : null;
  }

  function diffSnapshots(leftId, rightId) {
    assertOpen();
    const left = snapshots.get(String(leftId));
    const right = snapshots.get(String(rightId));
    if (!left || !right) throw new Error(`Snapshot not found: ${!left ? leftId : rightId}`);
    const leftEntries = new Map(left.entries.map((entry) => [entry.path, entry]));
    const rightEntries = new Map(right.entries.map((entry) => [entry.path, entry]));
    const added = [];
    const removed = [];
    const changed = [];
    for (const [entryPath, entry] of rightEntries) {
      const previous = leftEntries.get(entryPath);
      if (!previous) added.push(clone(entry));
      else {
        const contentChanged = previous.content?.hash !== entry.content?.hash;
        const metadataChanged = canonicalJson({ ...previous, content: undefined }) !== canonicalJson({ ...entry, content: undefined });
        if (contentChanged || metadataChanged) changed.push({
          path: entryPath, contentChanged, metadataChanged, from: clone(previous), to: clone(entry),
        });
      }
    }
    for (const [entryPath, entry] of leftEntries) if (!rightEntries.has(entryPath)) removed.push(clone(entry));
    return {
      id: stableId("snapshotdiff", { leftId: left.id, rightId: right.id }), timestamp: iso(),
      leftId: left.id, rightId: right.id, added, removed, changed,
      identical: !added.length && !removed.length && !changed.length,
    };
  }

  async function readChunk(chunk) {
    if (chunk.zero) return Buffer.alloc(chunk.size);
    const buffer = await fs.readFile(objectPath(chunk.hash));
    const actual = createHash("sha256").update(buffer).digest("hex");
    if (actual !== normalizeHash(chunk.hash)) throw new Error(`Corrupt vault object ${chunk.hash}.`);
    return buffer;
  }

  async function fileMatchesEntry(filename, entry) {
    const stats = await fs.stat(filename).catch(() => null);
    if (!stats?.isFile() || stats.size !== entry.size) return false;
    const handle = await fs.open(filename, "r");
    try {
      for (const chunk of entry.content?.chunks || []) {
        const buffer = Buffer.alloc(chunk.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, chunk.offset);
        if (bytesRead !== buffer.length) return false;
        const actual = createHash("sha256").update(buffer).digest("hex");
        if (actual !== normalizeHash(chunk.hash)) return false;
      }
      return true;
    } finally {
      await handle.close();
    }
  }

  function selectedEntries(manifest, restoreOptions) {
    const selected = restoreOptions.path || restoreOptions.subtree;
    if (!selected) return manifest.entries;
    const relative = safeRelative(selected);
    const output = manifest.entries.filter((entry) => entry.path === relative || entry.path.startsWith(`${relative}/`));
    if (!output.length) throw new Error(`Snapshot path was not found: ${relative}`);
    return output;
  }

  async function restoreToWritable(entries, writable, restoreOptions) {
    const files = entries.filter((entry) => entry.type === "file");
    if (files.length !== 1) throw new TypeError("Stream restore requires exactly one selected file.");
    for (const chunk of files[0].content.chunks) {
      if (restoreOptions.signal?.aborted) throw new Error("Vault restore aborted.");
      const buffer = await readChunk(chunk);
      if (!writable.write(buffer)) await new Promise((resolve, reject) => {
        writable.once("drain", resolve);
        writable.once("error", reject);
      });
    }
    if (restoreOptions.end !== false) writable.end();
    return {
      id: stableId("restoreresult", { snapshotId: restoreOptions.snapshotId, streamed: true }),
      timestamp: iso(), snapshotId: restoreOptions.snapshotId, bytes: files[0].size, streamed: true, entries: 1,
    };
  }

  function restoreSnapshot(snapshotId, destination, restoreOptions = {}) {
    return enqueue(async () => {
      assertOpen();
      const manifest = snapshots.get(String(snapshotId));
      if (!manifest) throw new Error(`Snapshot not found: ${snapshotId}`);
      const entries = selectedEntries(manifest, restoreOptions);
      if (destination && typeof destination.write === "function") {
        return restoreToWritable(entries, destination, { ...restoreOptions, snapshotId: manifest.id });
      }
      const destinationRoot = path.resolve(String(destination || ""));
      if (!destination) throw new TypeError("restoreSnapshot requires a destination.");
      const operationId = String(restoreOptions.operationId || stableId("restore", {
        snapshotId: manifest.id, destination: destinationRoot, selected: restoreOptions.path || restoreOptions.subtree || "*",
      }));
      let operation = operations.get(operationId);
      if (!operation) {
        operation = {
          id: operationId, schemaVersion: VAULT_SCHEMA_VERSION, type: "restore", state: "running",
          createdAt: iso(), snapshotId: manifest.id, destination: destinationRoot,
          paths: entries.map((entry) => entry.path), currentIndex: 0, offset: 0, restoredBytes: 0,
        };
        await saveOperation(operation);
      } else {
        operation.state = "running";
        operation.resumedFrom = operation.restoredBytes || 0;
        await saveOperation(operation);
      }
      try {
        while (operation.currentIndex < entries.length) {
          const entry = entries[operation.currentIndex];
          const singleAsFile = restoreOptions.asFile === true && entries.filter((item) => item.type === "file").length === 1;
          const target = singleAsFile ? destinationRoot : path.join(destinationRoot, ...safeRelative(entry.path).split("/"));
          if (entry.type === "directory") {
            await fs.mkdir(target, { recursive: true, mode: entry.mode & 0o7777 });
          } else if (entry.type === "symlink") {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.rm(target, { force: true }).catch(() => {});
            await fs.symlink(entry.target, target);
          } else if (entry.type === "file") {
            await fs.mkdir(path.dirname(target), { recursive: true });
            const partial = `${target}.ww-vault-partial`;
            if (operation.offset > 0 && !await pathExists(partial)) {
              if (await fileMatchesEntry(target, entry)) {
                operation.currentIndex += 1;
                operation.offset = 0;
                await saveOperation(operation);
                continue;
              }
              operation.restoredBytes = Math.max(0, (operation.restoredBytes || 0) - operation.offset);
              operation.offset = 0;
            }
            const handle = await fs.open(partial, operation.offset ? "r+" : "w", entry.mode & 0o7777);
            try {
              const chunks = entry.content?.chunks || [];
              let chunkIndex = chunks.findIndex((chunk) => chunk.offset >= operation.offset);
              if (chunkIndex < 0) chunkIndex = chunks.length;
              for (; chunkIndex < chunks.length; chunkIndex += 1) {
                if (restoreOptions.signal?.aborted) throw interruptionError("Vault restore aborted.", operation);
                const chunk = chunks[chunkIndex];
                if (!chunk.zero) await writeFully(handle, await readChunk(chunk), chunk.offset);
                operation.offset = chunk.offset + chunk.size;
                operation.restoredBytes = (operation.restoredBytes || 0) + chunk.size;
                await saveOperation(operation);
                restoreOptions.onProgress?.({
                  operationId, phase: "restore", path: entry.path, bytes: operation.restoredBytes,
                  fileOffset: operation.offset, resumedFrom: operation.resumedFrom || 0,
                });
                if (Number(restoreOptions.failAfterBytes) > 0
                  && operation.restoredBytes >= Number(restoreOptions.failAfterBytes)) {
                  throw interruptionError(`Injected vault restore interruption at ${operation.restoredBytes} bytes.`, operation);
                }
              }
              await handle.truncate(entry.size);
              await handle.sync();
            } finally {
              await handle.close();
            }
            await fs.rename(partial, target);
            if (entry.mode !== undefined) await fs.chmod(target, entry.mode & 0o7777).catch(() => {});
            if (entry.uid !== null && entry.gid !== null) await fs.chown(target, entry.uid, entry.gid).catch(() => {});
            if (entry.atime && entry.mtime) await fs.utimes(target, new Date(entry.atime), new Date(entry.mtime)).catch(() => {});
          }
          operation.currentIndex += 1;
          operation.offset = 0;
          await saveOperation(operation);
        }
        for (const entry of entries.filter((item) => item.type === "directory").reverse()) {
          const target = path.join(destinationRoot, ...safeRelative(entry.path).split("/"));
          if (entry.mode !== undefined) await fs.chmod(target, entry.mode & 0o7777).catch(() => {});
          if (entry.uid !== null && entry.gid !== null) await fs.chown(target, entry.uid, entry.gid).catch(() => {});
          if (entry.atime && entry.mtime) await fs.utimes(target, new Date(entry.atime), new Date(entry.mtime)).catch(() => {});
        }
        const result = {
          id: stableId("restoreresult", { snapshotId: manifest.id, destination: destinationRoot, paths: operation.paths }),
          timestamp: iso(),
          snapshotId: manifest.id, destination: destinationRoot, entries: entries.length,
          bytes: operation.restoredBytes || 0, resumedFrom: operation.resumedFrom || 0, complete: true,
        };
        await finishOperation(operation.id);
        return result;
      } catch (error) {
        operation.state = "incomplete";
        operation.lastError = { code: error.code || "ERR_WW_VAULT_RESTORE", message: error.message, at: iso() };
        await saveOperation(operation);
        error.operationId ||= operation.id;
        error.resumeOffset ??= operation.offset || 0;
        throw error;
      }
    });
  }

  function openObject(hash) {
    assertOpen();
    return fsSync.createReadStream(objectPath(hash));
  }

  async function objectFiles() {
    const output = [];
    for (const prefix of await fs.readdir(paths.objects).catch(() => [])) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      for (const suffix of await fs.readdir(path.join(paths.objects, prefix)).catch(() => [])) {
        if (/^[a-f0-9]{62}$/.test(suffix)) output.push({ hash: `${prefix}${suffix}`, path: path.join(paths.objects, prefix, suffix) });
      }
    }
    return output;
  }

  function referencedObjects(manifests = snapshots.values(), includeOperations = true) {
    const references = new Map();
    for (const manifest of manifests) {
      for (const entry of manifest.entries || []) {
        for (const chunk of entry.content?.chunks || []) {
          if (chunk.zero) continue;
          const hash = normalizeHash(chunk.hash);
          const values = references.get(hash) || new Set();
          values.add(manifest.id);
          references.set(hash, values);
        }
      }
    }
    if (includeOperations) {
      for (const operation of operations.values()) {
        for (const chunk of operation.chunks || []) {
          if (chunk.zero) continue;
          const hash = normalizeHash(chunk.hash);
          const values = references.get(hash) || new Set();
          values.add(`operation:${operation.id}`);
          references.set(hash, values);
        }
      }
    }
    return references;
  }

  function scrub(scrubOptions = {}) {
    return enqueue(async () => {
      assertOpen();
      const startedAt = iso();
      const invalidManifests = [];
      const validManifests = [];
      for (const name of await fs.readdir(paths.manifests).catch(() => [])) {
        if (!name.endsWith(".json")) continue;
        try {
          const manifest = await readJson(path.join(paths.manifests, name));
          if (!manifest?.id || !Array.isArray(manifest.entries)) throw new Error("missing required manifest fields");
          if (manifest.schemaVersion !== VAULT_SCHEMA_VERSION) throw new Error(`unsupported manifest schema ${manifest.schemaVersion}`);
          const expectedId = stableId("snapshot", {
            createdAt: manifest.createdAt, operationId: manifest.operationId,
            kind: manifest.kind, pinned: manifest.pinned, label: manifest.label,
            entries: manifest.entries, metadata: manifest.metadata,
          }, 40);
          if (manifest.id !== expectedId) throw new Error(`manifest content identity mismatch; expected ${expectedId}`);
          const expectedLogicalBytes = manifest.entries.filter((entry) => entry.type === "file")
            .reduce((total, entry) => total + Number(entry.size || 0), 0);
          if (manifest.timestamp !== manifest.createdAt || manifest.entryCount !== manifest.entries.length
            || manifest.logicalBytes !== expectedLogicalBytes) throw new Error("manifest derived metadata mismatch");
          for (const entry of manifest.entries) {
            safeRelative(entry.path);
            if (!['file', 'directory', 'symlink'].includes(entry.type)) throw new Error(`invalid entry type ${entry.type}`);
            if (entry.type !== "file") continue;
            let offset = 0;
            for (const chunk of entry.content?.chunks || []) {
              normalizeHash(chunk.hash);
              if (chunk.offset !== offset || !Number.isSafeInteger(chunk.size) || chunk.size <= 0 || chunk.size > chunkSize) {
                throw new Error(`invalid chunk extent for ${entry.path} at ${offset}`);
              }
              offset += chunk.size;
            }
            if (offset !== entry.size || entry.content?.size !== entry.size || entry.content?.hash !== entryIdentity(entry.content?.chunks || [])) {
              throw new Error(`invalid content identity for ${entry.path}`);
            }
          }
          validManifests.push(manifest);
        } catch (error) {
          invalidManifests.push({ file: name, error: error.message });
        }
      }
      const references = referencedObjects(validManifests, true);
      const missingObjects = [];
      const corruptObjects = [];
      for (const [hash, owners] of references) {
        const filename = objectPath(hash);
        if (!await pathExists(filename)) {
          missingObjects.push({ hash: `sha256:${hash}`, referencedBy: [...owners].sort() });
          continue;
        }
        const actual = await hashFile(filename);
        if (actual !== hash) corruptObjects.push({ hash: `sha256:${hash}`, actualHash: `sha256:${actual}`, referencedBy: [...owners].sort() });
      }
      const files = await objectFiles();
      const orphanObjects = files.filter((item) => !references.has(item.hash)).map((item) => ({ hash: `sha256:${item.hash}` }));
      const result = {
        id: stableId("scrub", { root, startedAt }), timestamp: iso(),
        schemaVersion: VAULT_SCHEMA_VERSION, startedAt, completedAt: iso(), ok: !invalidManifests.length && !missingObjects.length && !corruptObjects.length,
        manifestsChecked: validManifests.length, objectsChecked: references.size,
        invalidManifests, missingObjects, corruptObjects, orphanObjects,
        repaired: false, options: jsonSafe(scrubOptions),
      };
      lastScrubResult = result;
      await atomicJson(paths.lastScrub, result);
      return clone(result);
    });
  }

  function prune(policy = {}) {
    return enqueue(async () => {
      assertOpen();
      const execute = policy.execute === true;
      const orderedSnapshots = [...snapshots.values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
      const keep = new Set(orderedSnapshots.filter((item) => item.pinned).map((item) => item.id));
      const keepLast = Math.max(0, Number(policy.keepLast ?? policy["keep-last"] ?? 0));
      for (const item of orderedSnapshots.slice(0, keepLast)) keep.add(item.id);
      for (const kind of ["hourly", "daily", "weekly"]) {
        const count = Math.max(0, Number(policy[kind] || 0));
        if (!count) continue;
        const buckets = new Set();
        for (const item of orderedSnapshots) {
          const key = bucketKey(item.createdAt, kind);
          if (!buckets.has(key) && buckets.size < count) {
            buckets.add(key);
            keep.add(item.id);
          }
        }
      }
      if (policy.before) {
        const before = iso(policy.before);
        for (const item of orderedSnapshots) if (item.createdAt >= before) keep.add(item.id);
      }
      const pruneSnapshots = orderedSnapshots.filter((item) => !keep.has(item.id));
      const retained = orderedSnapshots.filter((item) => keep.has(item.id));
      const reachable = referencedObjects(retained, true);
      const removableObjects = (await objectFiles()).filter((item) => !reachable.has(item.hash));
      const report = {
        id: stableId("prune", { policy, snapshotIds: orderedSnapshots.map((item) => item.id) }),
        schemaVersion: VAULT_SCHEMA_VERSION, timestamp: iso(), at: iso(), execute, policy: jsonSafe(policy),
        retainedSnapshots: retained.map((item) => item.id), pinnedSnapshots: retained.filter((item) => item.pinned).map((item) => item.id),
        prunedSnapshots: pruneSnapshots.map((item) => item.id), removedObjects: removableObjects.map((item) => `sha256:${item.hash}`),
        removedBytes: removableObjects.reduce((total, item) => total + (fsSync.statSync(item.path).size || 0), 0),
      };
      if (execute) {
        for (const item of pruneSnapshots) {
          await fs.rm(manifestPath(item.id), { force: true });
          snapshots.delete(item.id);
        }
        for (const item of removableObjects) await fs.rm(item.path, { force: true });
      }
      return report;
    });
  }

  async function getStats() {
    assertOpen();
    const objects = await objectFiles();
    let uniqueBytes = 0;
    for (const item of objects) uniqueBytes += (await fs.stat(item.path)).size;
    const logicalBytes = [...snapshots.values()].reduce((total, item) => total + Number(item.logicalBytes || 0), 0);
    const capacity = await fs.statfs(root).then((stat) => ({
      totalBytes: Number(stat.blocks) * Number(stat.bsize),
      availableBytes: Number(stat.bavail) * Number(stat.bsize),
      freeBytes: Number(stat.bfree) * Number(stat.bsize),
    }), () => ({ totalBytes: null, availableBytes: null, freeBytes: null }));
    return {
      id: stableId("vaultstats", { root }), timestamp: iso(),
      schemaVersion: VAULT_SCHEMA_VERSION, backend: "filesystem", root, chunkSize,
      ...capacity, uniqueBytes, logicalBytes,
      dedupRatio: uniqueBytes ? Number((logicalBytes / uniqueBytes).toFixed(4)) : logicalBytes ? null : 1,
      objectCount: objects.length, snapshotCount: snapshots.size, incompleteOperations: operations.size,
      incompleteOperationIds: [...operations.keys()], lastScrubResult: clone(lastScrubResult),
    };
  }

  const api = {
    init, close, ingestFile, ingestStream, snapshotPaths, ingestArtifact, listSnapshots, getSnapshot,
    diffSnapshots, restoreSnapshot, openObject, scrub, prune, getStats,
  };
  return api;
}

export { VAULT_SCHEMA_VERSION, DEFAULT_CHUNK_SIZE };
