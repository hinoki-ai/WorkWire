import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import {
  atomicWriteJson,
  hashBuffer,
  isZeroBuffer,
  jsonRecord,
  makeId,
  mapLimit,
  pathExists,
  readJson,
  readRange,
  throwIfAborted,
  writeAll,
} from "../sync/primitives.mjs";

export const WW_IMAGING_VERSION = 2;

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
const COMPRESSION = new Set(["none", "gzip"]);

function nowIso() {
  return new Date().toISOString();
}

function serializeError(error) {
  return { code: String(error?.code || error?.name || "ERR_IMAGING"), message: String(error?.message || error) };
}

function normalizeCompression(value) {
  const compression = value === true ? "gzip" : String(value || "none").toLowerCase();
  if (!COMPRESSION.has(compression)) throw new Error(`Unsupported image compression: ${compression}`);
  return compression;
}

async function encodeObject(buffer, compression) {
  return compression === "gzip" ? gzip(buffer, { level: zlib.constants.Z_BEST_SPEED }) : buffer;
}

async function decodeObject(buffer, compression) {
  return compression === "gzip" ? gunzip(buffer) : buffer;
}

function publicImage(image) {
  return jsonRecord(image);
}

function sourcePathFrom(source) {
  if (typeof source === "string") return path.resolve(source);
  const candidate = source?.path || source?.filePath || source?.devicePath;
  return candidate ? path.resolve(String(candidate)) : "";
}

export function createImagingCatalog(options = {}) {
  const storagePath = path.resolve(String(options.storagePath || options.stateDir || path.join(process.cwd(), ".workwire-imaging")));
  const statePath = path.join(storagePath, "catalog.json");
  const objectsPath = path.join(storagePath, "objects");
  const executor = options.executor || null;
  const listeners = new Set();
  const runtimePeers = new Map();
  let initialized = false;
  let state = {
    version: WW_IMAGING_VERSION,
    images: {},
    objects: {},
    captures: {},
    restores: {},
    peers: {},
    updatedAt: nowIso(),
  };

  function requireInit() {
    if (!initialized) throw new Error("The imaging catalog is not initialized.");
  }

  function emit(type, detail = {}) {
    const event = jsonRecord({ type, at: nowIso(), ...detail });
    for (const listener of listeners) {
      try { listener(event); } catch {}
    }
    options.onEvent?.(event);
  }

  async function persist() {
    state.updatedAt = nowIso();
    await atomicWriteJson(statePath, state);
  }

  function objectId(hash, compression) {
    return `${hash}.${compression === "gzip" ? "gz" : "raw"}`;
  }

  function objectPath(id) {
    const hash = id.split(".")[0];
    return path.join(objectsPath, hash.slice(0, 2), id);
  }

  async function storeObject(buffer, compression, signal) {
    throwIfAborted(signal);
    const hash = hashBuffer(buffer);
    const id = objectId(hash, compression);
    const target = objectPath(id);
    if (!await pathExists(target)) {
      const encoded = await encodeObject(buffer, compression);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      try {
        await fsp.writeFile(temporary, encoded, { flag: "wx" });
        await fsp.rename(temporary, target);
        state.objects[id] = { id, hash, compression, logicalSize: buffer.length, storedSize: encoded.length, createdAt: nowIso(), verifiedAt: nowIso() };
      } finally {
        await fsp.rm(temporary, { force: true }).catch(() => {});
      }
    } else if (!state.objects[id]) {
      const stats = await fsp.stat(target);
      state.objects[id] = { id, hash, compression, logicalSize: buffer.length, storedSize: stats.size, createdAt: nowIso(), verifiedAt: null };
    }
    return state.objects[id];
  }

  async function readObject(id, { signal, allowPeers = true } = {}) {
    throwIfAborted(signal);
    let record = state.objects[id];
    let encoded;
    try {
      encoded = await fsp.readFile(objectPath(id));
    } catch (error) {
      if (error?.code !== "ENOENT" || !allowPeers) throw error;
      for (const [peerId, peer] of runtimePeers) {
        if (peer.online === false) continue;
        const protocol = peer.catalog?._imagingProtocol || peer.engine?._imagingProtocol;
        if (!protocol) continue;
        const remote = await protocol.getObject(id).catch(() => null);
        if (!remote) continue;
        const remoteBuffer = Buffer.isBuffer(remote) ? remote : Buffer.from(remote);
        const compression = id.endsWith(".gz") ? "gzip" : "none";
        const raw = await decodeObject(remoteBuffer, compression);
        if (hashBuffer(raw) !== id.split(".")[0]) continue;
        const target = objectPath(id);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, remoteBuffer);
        record = state.objects[id] = {
          id,
          hash: id.split(".")[0],
          compression,
          logicalSize: raw.length,
          storedSize: remoteBuffer.length,
          createdAt: nowIso(),
          verifiedAt: nowIso(),
          seededBy: peerId,
        };
        await persist();
        emit("chunk-seeded", { peerId, objectId: id, logicalSize: raw.length });
        encoded = remoteBuffer;
        break;
      }
      if (!encoded) throw Object.assign(new Error(`Image object is unavailable: ${id}`), { code: "ERR_WW_IMAGE_OBJECT_MISSING" });
    }
    const compression = record?.compression || (id.endsWith(".gz") ? "gzip" : "none");
    const raw = await decodeObject(encoded, compression);
    if (hashBuffer(raw) !== (record?.hash || id.split(".")[0])) {
      throw Object.assign(new Error(`Image object failed verification: ${id}`), { code: "ERR_WW_IMAGE_OBJECT_CORRUPT" });
    }
    return raw;
  }

  async function resolveSource(source, captureOptions) {
    const sourcePath = sourcePathFrom(source);
    if (sourcePath) {
      const stats = await fsp.stat(sourcePath);
      if (!stats.isFile() && !stats.isBlockDevice()) throw new Error(`Image source is not a file or block device: ${sourcePath}`);
      return {
        path: sourcePath,
        size: Number(captureOptions.logicalSize ?? source?.logicalSize ?? stats.size),
        identity: String(captureOptions.sourceIdentity || source?.identity || [sourcePath, stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":")),
        async read(offset, length) {
          const handle = await fsp.open(sourcePath, "r");
          try { return readRange(handle, offset, length); } finally { await handle.close(); }
        },
      };
    }
    if (executor?.resolveSource) {
      const resolved = await executor.resolveSource(source, captureOptions);
      if (!Number.isFinite(Number(resolved?.size))) throw new Error("The image executor did not resolve a source size.");
      return {
        ...resolved,
        size: Number(resolved.size),
        identity: String(captureOptions.sourceIdentity || resolved.identity || `${resolved.path || "executor"}:${resolved.size}`),
        read: resolved.read
          ? ((offset, length, signal) => resolved.read(offset, length, { signal }))
          : ((offset, length, signal) => executor.readSourceChunk(resolved, offset, length, { signal })),
      };
    }
    if (executor?.statSource && executor?.readSourceChunk) {
      const facts = await executor.statSource(source, captureOptions);
      return {
        ...facts,
        size: Number(facts.size),
        identity: String(captureOptions.sourceIdentity || facts.identity || `${facts.path || "executor"}:${facts.size}`),
        read: (offset, length, signal) => executor.readSourceChunk(source, offset, length, { signal }),
      };
    }
    throw new Error("An ordinary source path or an executor source adapter is required.");
  }

  async function resolveTarget(target, restoreOptions) {
    const targetPath = sourcePathFrom(target) || (typeof target === "string" ? path.resolve(target) : "");
    if (targetPath) {
      return {
        path: targetPath,
        async open() {
          await fsp.mkdir(path.dirname(targetPath), { recursive: true });
          return fsp.open(targetPath, await pathExists(targetPath) ? "r+" : "w+");
        },
      };
    }
    if (executor?.resolveTarget) return executor.resolveTarget(target, restoreOptions);
    throw new Error("Restore requires an explicitly resolved target path or executor target.");
  }

  const catalog = {
    async init() {
      if (initialized) return catalog;
      await fsp.mkdir(objectsPath, { recursive: true });
      state = { ...state, ...(await readJson(statePath, state)) };
      for (const key of ["images", "objects", "captures", "restores", "peers"]) state[key] ||= {};
      state.version = WW_IMAGING_VERSION;
      initialized = true;
      await persist();
      return catalog;
    },

    async close() {
      if (!initialized) return;
      await persist();
      initialized = false;
    },

    async capture(source, captureOptions = {}) {
      requireInit();
      const signal = captureOptions.signal;
      const onProgress = captureOptions.onProgress || (() => {});
      throwIfAborted(signal);
      const resolved = await resolveSource(source, captureOptions);
      const compression = normalizeCompression(captureOptions.compression);
      const chunkSize = Math.max(64 * 1024, Number(captureOptions.chunkSize) || DEFAULT_CHUNK_SIZE);
      const imageId = String(captureOptions.id || captureOptions.imageId || makeId("image"));
      const captureId = String(captureOptions.captureId || imageId);
      let checkpoint = state.captures[captureId];
      if (!checkpoint || checkpoint.sourceIdentity !== resolved.identity || checkpoint.chunkSize !== chunkSize || checkpoint.compression !== compression) {
        checkpoint = state.captures[captureId] = {
          id: captureId,
          imageId,
          sourceIdentity: resolved.identity,
          chunkSize,
          compression,
          chunks: [],
          completedBytes: 0,
          startedAt: nowIso(),
          updatedAt: nowIso(),
        };
        await persist();
      }
      try {
        for (let offset = checkpoint.chunks.length * chunkSize, index = checkpoint.chunks.length; offset < resolved.size; offset += chunkSize, index += 1) {
          throwIfAborted(signal);
          const length = Math.min(chunkSize, resolved.size - offset);
          const buffer = Buffer.from(await resolved.read(offset, length, signal));
          if (buffer.length !== length) throw Object.assign(new Error(`Short read at image offset ${offset}.`), { code: "ERR_WW_IMAGE_SHORT_READ" });
          const hash = hashBuffer(buffer);
          const zero = isZeroBuffer(buffer);
          const object = zero ? null : await storeObject(buffer, compression, signal);
          checkpoint.chunks.push({ index, offset, length, hash, zero, objectId: object?.id || null, storedSize: object?.storedSize || 0 });
          checkpoint.completedBytes = offset + length;
          checkpoint.updatedAt = nowIso();
          await persist();
          const progress = { stage: "capture", captureId, imageId, chunk: index, completedBytes: checkpoint.completedBytes, totalBytes: resolved.size };
          emit("progress", progress);
          onProgress(progress);
        }
      } catch (error) {
        checkpoint.error = serializeError(error);
        checkpoint.updatedAt = nowIso();
        await persist();
        throw error;
      }
      const treeHash = crypto.createHash("sha256");
      for (const chunk of checkpoint.chunks) treeHash.update(`${chunk.offset}:${chunk.length}:${chunk.hash}\n`);
      const chunks = checkpoint.chunks;
      const image = {
        id: imageId,
        version: WW_IMAGING_VERSION,
        label: String(captureOptions.label || path.basename(resolved.path || imageId)),
        sourceMachine: jsonRecord(captureOptions.sourceMachine || { id: os.hostname(), hostname: os.hostname() }),
        diskIdentity: jsonRecord(captureOptions.diskIdentity || source?.diskIdentity || { path: resolved.path || null }),
        geometry: jsonRecord(captureOptions.geometry || source?.geometry || { logicalSectorSize: 512, physicalSectorSize: 512, logicalSize: resolved.size }),
        partitionTable: jsonRecord(captureOptions.partitionTable || source?.partitionTable || { type: "unknown", partitions: [] }),
        filesystems: jsonRecord(captureOptions.filesystems || source?.filesystems || []),
        bootMode: String(captureOptions.bootMode || source?.bootMode || "unknown"),
        creationTool: String(captureOptions.creationTool || (resolved.path ? "workwire-node-stream" : "injected-executor")),
        compression,
        chunkSize,
        chunks,
        hashes: { algorithm: "sha256-tree-v1", content: treeHash.digest("hex") },
        logicalSize: resolved.size,
        storedSize: chunks.reduce((sum, chunk) => sum + chunk.storedSize, 0),
        createdAt: state.images[imageId]?.createdAt || nowIso(),
        updatedAt: nowIso(),
        labels: [...new Set([...(captureOptions.labels || []), ...(captureOptions.label ? [captureOptions.label] : [])].map(String))],
        pinned: Boolean(captureOptions.pinned),
        verification: { state: "verified", mode: "capture-chunks", verifiedAt: nowIso(), checkedChunks: chunks.length, failedChunks: 0 },
        metadata: jsonRecord(captureOptions.metadata || {}),
      };
      state.images[imageId] = image;
      delete state.captures[captureId];
      await persist();
      emit("capture-complete", { image });
      return publicImage(image);
    },

    captureImage(source, captureOptions) {
      return catalog.capture(source, captureOptions);
    },

    async restore(imageId, target, restoreOptions = {}) {
      requireInit();
      const image = state.images[String(imageId)];
      if (!image) throw Object.assign(new Error(`Unknown image: ${imageId}`), { code: "ERR_WW_IMAGE_NOT_FOUND" });
      const signal = restoreOptions.signal;
      const onProgress = restoreOptions.onProgress || (() => {});
      const resolved = await resolveTarget(target, restoreOptions);
      const restoreId = String(restoreOptions.restoreId || makeId("restore", image.id, resolved.path || JSON.stringify(target)));
      let checkpoint = state.restores[restoreId];
      if (!checkpoint || checkpoint.imageId !== image.id) {
        checkpoint = state.restores[restoreId] = { id: restoreId, imageId: image.id, target: resolved.path || jsonRecord(target), completedChunks: [], startedAt: nowIso(), updatedAt: nowIso() };
        await persist();
      }
      const completed = new Set(checkpoint.completedChunks);
      const handle = resolved.open ? await resolved.open() : null;
      if (!handle && !resolved.writeChunk) throw new Error("The resolved image target cannot write chunks.");
      try {
        if (handle) await handle.truncate(image.logicalSize);
        for (const chunk of image.chunks) {
          throwIfAborted(signal);
          if (completed.has(chunk.index) && handle) {
            const existing = await readRange(handle, chunk.offset, chunk.length);
            if (existing.length === chunk.length && hashBuffer(existing) === chunk.hash) continue;
            completed.delete(chunk.index);
            checkpoint.completedChunks = [...completed].sort((a, b) => a - b);
            await persist();
          } else if (completed.has(chunk.index) && resolved.verifyChunk) {
            if (await resolved.verifyChunk(chunk.offset, chunk.length, chunk.hash, { signal })) continue;
            completed.delete(chunk.index);
          } else if (completed.has(chunk.index)) {
            // An executor without readable verification cannot truthfully reuse
            // a prior write after process death, so rewrite that boundary.
            completed.delete(chunk.index);
          }
          const raw = chunk.zero ? Buffer.alloc(chunk.length) : await readObject(chunk.objectId, { signal });
          if (raw.length !== chunk.length || hashBuffer(raw) !== chunk.hash) throw Object.assign(new Error(`Image chunk ${chunk.index} failed verification.`), { code: "ERR_WW_IMAGE_CHUNK_CORRUPT" });
          if (!chunk.zero) {
            if (handle) await writeAll(handle, raw, chunk.offset);
            else await resolved.writeChunk(chunk.offset, raw, { signal });
          }
          completed.add(chunk.index);
          checkpoint.completedChunks = [...completed].sort((a, b) => a - b);
          checkpoint.updatedAt = nowIso();
          await handle?.sync();
          await persist();
          const progress = { stage: "restore", restoreId, imageId: image.id, chunk: chunk.index, completedBytes: chunk.offset + chunk.length, totalBytes: image.logicalSize };
          emit("progress", progress);
          onProgress(progress);
        }
      } catch (error) {
        checkpoint.error = serializeError(error);
        await persist();
        throw error;
      } finally {
        await handle?.close();
        await resolved.close?.();
      }
      const verify = await catalog.verifyRestore(image.id, target, { ...restoreOptions, signal });
      if (!verify.verified) throw Object.assign(new Error("Restored image failed verification."), { code: "ERR_WW_IMAGE_RESTORE_VERIFY", report: verify });
      delete state.restores[restoreId];
      await persist();
      const report = { id: makeId("image-report"), kind: "restore", imageId: image.id, target: resolved.path || jsonRecord(target), intended: { hash: image.hashes.content, logicalSize: image.logicalSize }, observed: verify, verified: true, completedAt: nowIso() };
      emit("restore-complete", report);
      return report;
    },

    restoreImage(imageId, target, restoreOptions) {
      return catalog.restore(imageId, target, restoreOptions);
    },

    async verifyRestore(imageId, target, verifyOptions = {}) {
      const image = state.images[String(imageId)];
      if (!image) throw new Error(`Unknown image: ${imageId}`);
      const mode = String(verifyOptions.verify || verifyOptions.mode || "samples");
      const resolvedPath = sourcePathFrom(target);
      if (!resolvedPath && executor?.verifyTarget) return executor.verifyTarget(image, target, verifyOptions);
      if (!resolvedPath) throw new Error("Verification requires a readable target path or executor.");
      const handle = await fsp.open(resolvedPath, "r");
      const indices = mode === "full"
        ? image.chunks.map((chunk) => chunk.index)
        : [...new Set([0, Math.floor((image.chunks.length - 1) / 2), image.chunks.length - 1])]
            .filter((index) => index >= 0 && index < image.chunks.length);
      const failures = [];
      try {
        for (const index of indices) {
          throwIfAborted(verifyOptions.signal);
          const chunk = image.chunks[index];
          const raw = await readRange(handle, chunk.offset, chunk.length);
          if (hashBuffer(raw) !== chunk.hash) failures.push({ index, offset: chunk.offset, expected: chunk.hash, observed: hashBuffer(raw) });
        }
      } finally {
        await handle.close();
      }
      return { verified: failures.length === 0, mode, checkedChunks: indices.length, failedChunks: failures.length, failures, observedAt: nowIso() };
    },

    async verify(imageId, verifyOptions = {}) {
      requireInit();
      const image = state.images[String(imageId)];
      if (!image) throw new Error(`Unknown image: ${imageId}`);
      const failures = [];
      for (const chunk of image.chunks) {
        throwIfAborted(verifyOptions.signal);
        if (chunk.zero) continue;
        try {
          const raw = await readObject(chunk.objectId, { signal: verifyOptions.signal, allowPeers: verifyOptions.allowPeers !== false });
          if (raw.length !== chunk.length || hashBuffer(raw) !== chunk.hash) failures.push({ index: chunk.index, objectId: chunk.objectId, reason: "hash-mismatch" });
        } catch (error) {
          failures.push({ index: chunk.index, objectId: chunk.objectId, reason: serializeError(error) });
        }
        verifyOptions.onProgress?.({ stage: "verify", imageId, chunk: chunk.index, checkedChunks: chunk.index + 1, totalChunks: image.chunks.length });
      }
      image.verification = { state: failures.length ? "failed" : "verified", verifiedAt: nowIso(), checkedChunks: image.chunks.length, failedChunks: failures.length, failures };
      await persist();
      return jsonRecord({ imageId, verified: failures.length === 0, ...image.verification });
    },

    verifyImage(imageId, verifyOptions) {
      return catalog.verify(imageId, verifyOptions);
    },

    async inspect(imageId, inspectOptions = {}) {
      requireInit();
      const image = state.images[String(imageId)];
      if (!image) throw new Error(`Unknown image: ${imageId}`);
      let native = null;
      if (executor?.inspectImage) native = await executor.inspectImage(publicImage(image), inspectOptions);
      else if (options.inspectExecutor) native = await options.inspectExecutor(publicImage(image), inspectOptions);
      return jsonRecord({
        imageId: image.id,
        manifest: image,
        partitionLayout: native?.partitionLayout || image.partitionTable,
        hashes: image.hashes,
        filesystems: native?.filesystems || image.filesystems,
        compatibility: {
          bootMode: image.bootMode,
          logicalSectorSize: image.geometry?.logicalSectorSize || null,
          minimumTargetBytes: image.logicalSize,
          nativeToolsUsed: native?.tools || [],
          ...(native?.compatibility || {}),
        },
      });
    },

    inspectImage(imageId, inspectOptions) {
      return catalog.inspect(imageId, inspectOptions);
    },

    listImages(query = {}) {
      requireInit();
      const search = String(query.search || query.q || "").toLowerCase();
      return Object.values(state.images).filter((image) => (!query.pinned || image.pinned)
        && (!query.label || image.labels.includes(query.label))
        && (!search || JSON.stringify([image.id, image.label, image.labels, image.sourceMachine, image.diskIdentity]).toLowerCase().includes(search)))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(publicImage);
    },

    search(query) {
      return catalog.listImages(typeof query === "string" ? { search: query } : query);
    },

    getImage(id) {
      requireInit();
      return state.images[String(id)] ? publicImage(state.images[String(id)]) : null;
    },

    async rename(id, label) {
      const image = state.images[String(id)];
      if (!image) throw new Error(`Unknown image: ${id}`);
      image.label = String(label || "").trim();
      image.updatedAt = nowIso();
      await persist();
      return publicImage(image);
    },

    renameImage(id, label) { return catalog.rename(id, label); },

    async pin(id, pinned = true) {
      const image = state.images[String(id)];
      if (!image) throw new Error(`Unknown image: ${id}`);
      image.pinned = Boolean(pinned);
      image.updatedAt = nowIso();
      await persist();
      return publicImage(image);
    },

    pinImage(id, pinned) { return catalog.pin(id, pinned); },

    async clone(id, cloneOptions = {}) {
      const source = state.images[String(id)];
      if (!source) throw new Error(`Unknown image: ${id}`);
      const cloneId = String(cloneOptions.id || makeId("image"));
      const image = structuredClone(source);
      Object.assign(image, { id: cloneId, label: String(cloneOptions.label || `${source.label} (clone)`), labels: cloneOptions.labels || [...source.labels], pinned: Boolean(cloneOptions.pinned), clonedFrom: source.id, createdAt: nowIso(), updatedAt: nowIso() });
      state.images[cloneId] = image;
      await persist();
      return publicImage(image);
    },

    cloneImage(id, cloneOptions) { return catalog.clone(id, cloneOptions); },

    async exportImage(id, destination, exportOptions = {}) {
      requireInit();
      const image = state.images[String(id)];
      if (!image) throw new Error(`Unknown image: ${id}`);
      const directory = path.resolve(String(destination));
      const exportObjects = path.join(directory, "objects");
      await fsp.mkdir(exportObjects, { recursive: true });
      let copiedBytes = 0;
      for (const chunk of image.chunks) {
        throwIfAborted(exportOptions.signal);
        if (!chunk.objectId) continue;
        await readObject(chunk.objectId, { signal: exportOptions.signal });
        const sourceObject = objectPath(chunk.objectId);
        const destinationObject = path.join(exportObjects, chunk.objectId);
        if (!await pathExists(destinationObject)) {
          await fsp.copyFile(sourceObject, destinationObject);
          copiedBytes += (await fsp.stat(destinationObject)).size;
        }
        exportOptions.onProgress?.({ stage: "export", imageId: id, objectId: chunk.objectId, copiedBytes });
      }
      await atomicWriteJson(path.join(directory, "manifest.json"), { format: "workwire-image-export-v1", exportedAt: nowIso(), image });
      return { imageId: id, destination: directory, copiedBytes, objectCount: image.chunks.filter((chunk) => chunk.objectId).length };
    },

    async importImage(source, importOptions = {}) {
      requireInit();
      const directory = path.resolve(String(source));
      const bundle = JSON.parse(await fsp.readFile(path.join(directory, "manifest.json"), "utf8"));
      if (bundle.format !== "workwire-image-export-v1" || !bundle.image?.id) throw new Error("Unsupported WorkWire image export.");
      const image = structuredClone(bundle.image);
      if (importOptions.id) image.id = String(importOptions.id);
      if (state.images[image.id] && !importOptions.overwrite) throw Object.assign(new Error(`Image already exists: ${image.id}`), { code: "ERR_WW_IMAGE_EXISTS" });
      for (const chunk of image.chunks) {
        throwIfAborted(importOptions.signal);
        if (!chunk.objectId) continue;
        const sourceObject = path.join(directory, "objects", chunk.objectId);
        const encoded = await fsp.readFile(sourceObject);
        const compression = chunk.objectId.endsWith(".gz") ? "gzip" : "none";
        const raw = await decodeObject(encoded, compression);
        if (raw.length !== chunk.length || hashBuffer(raw) !== chunk.hash) throw Object.assign(new Error(`Imported object is corrupt: ${chunk.objectId}`), { code: "ERR_WW_IMAGE_IMPORT_CORRUPT" });
        const target = objectPath(chunk.objectId);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        if (!await pathExists(target)) await fsp.copyFile(sourceObject, target);
        state.objects[chunk.objectId] = { id: chunk.objectId, hash: chunk.hash, compression, logicalSize: raw.length, storedSize: encoded.length, createdAt: nowIso(), verifiedAt: nowIso() };
      }
      image.importedAt = nowIso();
      image.updatedAt = nowIso();
      state.images[image.id] = image;
      await persist();
      return publicImage(image);
    },

    async deleteImage(id, deleteOptions = {}) {
      requireInit();
      const image = state.images[String(id)];
      if (!image) return false;
      if (image.pinned && !deleteOptions.force) throw Object.assign(new Error("Pinned images require force deletion."), { code: "ERR_WW_IMAGE_PINNED" });
      delete state.images[String(id)];
      if (deleteOptions.pruneObjects !== false) {
        const referenced = new Set(Object.values(state.images).flatMap((candidate) => candidate.chunks.map((chunk) => chunk.objectId).filter(Boolean)));
        for (const [objectId] of Object.entries(state.objects)) {
          if (referenced.has(objectId)) continue;
          await fsp.rm(objectPath(objectId), { force: true });
          delete state.objects[objectId];
        }
      }
      await persist();
      emit("image-deleted", { imageId: String(id) });
      return true;
    },

    async addPeer(config) {
      requireInit();
      const id = String(config?.id || config?.machineId || "").trim();
      if (!id) throw new Error("An imaging peer id is required.");
      state.peers[id] = { id, label: String(config.label || id), machineId: String(config.machineId || id), online: config.online !== false, addedAt: nowIso() };
      runtimePeers.set(id, config);
      await persist();
      return jsonRecord(state.peers[id]);
    },

    async updatePeer(id, patch) {
      if (!state.peers[id]) throw new Error(`Unknown imaging peer: ${id}`);
      state.peers[id] = { ...state.peers[id], ...jsonRecord(Object.fromEntries(Object.entries(patch).filter(([, value]) => typeof value !== "object" && typeof value !== "function"))), id };
      runtimePeers.set(id, { ...(runtimePeers.get(id) || {}), ...patch, id });
      await persist();
      return jsonRecord(state.peers[id]);
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getStats() {
      requireInit();
      const images = Object.values(state.images);
      return {
        images: images.length,
        objects: Object.keys(state.objects).length,
        logicalBytes: images.reduce((sum, image) => sum + image.logicalSize, 0),
        uniqueStoredBytes: Object.values(state.objects).reduce((sum, object) => sum + object.storedSize, 0),
        activeCaptures: Object.keys(state.captures).length,
        activeRestores: Object.keys(state.restores).length,
      };
    },

    _imagingProtocol: {
      version: WW_IMAGING_VERSION,
      async hasObject(id) { return pathExists(objectPath(id)); },
      async getObject(id) { return fsp.readFile(objectPath(id)); },
      listObjects() { return Object.keys(state.objects); },
    },
  };
  return catalog;
}

function normalizeRollout(input = {}) {
  const mode = String(input.mode || input.rolloutMode || "bounded-parallel");
  if (!["all-at-once", "bounded-parallel", "canary-then-rest", "stop-on-first-failure"].includes(mode)) throw new Error(`Unsupported rollout mode: ${mode}`);
  return {
    mode,
    concurrency: mode === "all-at-once" ? Infinity : Math.max(1, Number(input.concurrency) || 2),
    canaryCount: Math.max(1, Number(input.canaryCount) || 1),
    stopOnFirstFailure: mode === "stop-on-first-failure" || input.stopOnFirstFailure === true,
  };
}

export function createProvisioningEngine(options = {}) {
  const catalog = options.catalog || options.imagingCatalog;
  const defaultExecutor = options.executor || null;
  const listeners = new Set();

  function emit(type, detail = {}) {
    const event = jsonRecord({ type, at: nowIso(), ...detail });
    for (const listener of listeners) {
      try { listener(event); } catch {}
    }
    options.onEvent?.(event);
  }

  async function executeMachine(machinePlan, plan, executor, executionOptions) {
    const startedAt = nowIso();
    const stepResults = [];
    try {
      if (executor?.executeMachine) {
        const observed = await executor.executeMachine(jsonRecord(machinePlan), { plan: jsonRecord(plan), signal: executionOptions.signal, onProgress: executionOptions.onProgress });
        return { machineId: machinePlan.machineId, ok: observed?.ok !== false, status: observed?.ok === false ? "failed" : "complete", intended: machinePlan, observed: jsonRecord(observed || {}), steps: observed?.steps || [], startedAt, completedAt: nowIso() };
      }
      for (const step of machinePlan.steps) {
        throwIfAborted(executionOptions.signal);
        emit("deployment-step", { planId: plan.id, machineId: machinePlan.machineId, step });
        let observed;
        if (step.type === "restore-image" && catalog?.restoreImage && machinePlan.target.path && !executor?.runStep) {
          observed = await catalog.restoreImage(plan.imageId, machinePlan.target.path, { signal: executionOptions.signal, verify: plan.verification });
        } else if (executor?.runStep) {
          observed = await executor.runStep(jsonRecord(step), jsonRecord(machinePlan), { signal: executionOptions.signal });
        } else {
          throw Object.assign(new Error(`No provisioning executor is available for ${step.type}.`), { code: "ERR_WW_DEPLOY_EXECUTOR" });
        }
        const result = { stepId: step.id, type: step.type, ok: observed?.ok !== false, observed: jsonRecord(observed || {}), completedAt: nowIso() };
        stepResults.push(result);
        executionOptions.onProgress?.({ stage: "deployment-step", planId: plan.id, machineId: machinePlan.machineId, result });
        if (!result.ok) throw Object.assign(new Error(observed?.message || `Deployment step failed: ${step.type}`), { code: observed?.code || "ERR_WW_DEPLOY_STEP" });
      }
      return { machineId: machinePlan.machineId, ok: true, status: "complete", intended: machinePlan, observed: { stepsCompleted: stepResults.length }, steps: stepResults, startedAt, completedAt: nowIso() };
    } catch (error) {
      return { machineId: machinePlan.machineId, ok: false, status: "failed", intended: machinePlan, observed: { error: serializeError(error) }, steps: stepResults, startedAt, completedAt: nowIso(), error: serializeError(error) };
    }
  }

  const engine = {
    buildDeploymentPlan(input = {}) {
      const imageId = String(input.imageId || input.sourceImageId || input.image?.id || "").trim();
      if (!imageId) throw new Error("A source image id is required for deployment.");
      const machines = (input.machines || input.targets || []).map((machine, index) => {
        const machineId = String(machine.id || machine.machineId || `machine-${index + 1}`);
        const target = jsonRecord(machine.target || machine.targetDisk || { selector: machine.targetDiskSelector || "largest-non-removable" });
        const preflight = [
          { id: `${machineId}:online`, type: "machine-online", expected: true },
          { id: `${machineId}:target`, type: "target-disk-resolved", selector: target },
          { id: `${machineId}:capacity`, type: "target-capacity", minimumBytes: Number(input.logicalSize || input.image?.logicalSize || 0) },
          ...(machine.preflight || []),
        ];
        const steps = [
          { id: `${machineId}:preflight`, type: "preflight", facts: preflight },
          { id: `${machineId}:restore`, type: "restore-image", imageId, target },
          ...(input.unattendedBundle ? [{ id: `${machineId}:unattended`, type: "apply-bundle", bundle: engine.normalizeBundle(input.unattendedBundle) }] : []),
          ...(input.postImageBundle ? [{ id: `${machineId}:post-image`, type: "apply-bundle", bundle: engine.normalizeBundle(input.postImageBundle) }] : []),
          ...(machine.postRestoreOperations || input.postRestoreOperations || []).map((operation, operationIndex) => ({ id: `${machineId}:post-${operationIndex}`, type: operation.type || "command", ...jsonRecord(operation) })),
          { id: `${machineId}:verify`, type: "verify", mode: input.verification || "samples" },
        ];
        return { machineId, label: String(machine.label || machineId), target, facts: jsonRecord(machine.facts || {}), preflight, steps };
      });
      if (!machines.length) throw new Error("At least one deployment machine is required.");
      return jsonRecord({
        id: String(input.id || makeId("deployment")),
        version: WW_IMAGING_VERSION,
        imageId,
        image: input.image ? jsonRecord(input.image) : catalog?.getImage?.(imageId) || null,
        machines,
        rollout: normalizeRollout(input.rollout || input),
        verification: String(input.verification || "samples"),
        createdAt: nowIso(),
      });
    },

    createDeploymentPlan(input) { return engine.buildDeploymentPlan(input); },

    normalizeBundle(bundle = {}) {
      const items = Array.isArray(bundle) ? bundle : bundle.items || bundle.steps || [];
      return {
        version: 1,
        label: String(bundle.label || "deployment bundle"),
        items: items.map((item, index) => {
          const type = String(item.type || (item.command ? "command" : "file"));
          if (!/[\w-]+/u.test(type) || !["file", "command"].includes(type)) throw new Error(`Unsupported deployment bundle item: ${type}`);
          return { order: index, type, ...(type === "file" ? { source: String(item.source || ""), destination: String(item.destination || ""), mode: item.mode || null } : { command: Array.isArray(item.command) ? item.command.map(String) : String(item.command || ""), cwd: item.cwd || null, env: jsonRecord(item.env || {}) }) };
        }),
      };
    },

    async executeDeploymentPlan(planInput, executionOptions = {}) {
      const plan = planInput?.machines ? jsonRecord(planInput) : engine.buildDeploymentPlan(planInput);
      const rollout = normalizeRollout(plan.rollout);
      const executor = executionOptions.executor || defaultExecutor;
      const results = [];
      let stopped = false;
      const runBatch = async (batch, concurrency) => {
        let failed = false;
        const batchResults = await mapLimit(batch, Math.min(batch.length, Number.isFinite(concurrency) ? concurrency : batch.length), async (machine) => {
          if (stopped || (failed && rollout.stopOnFirstFailure)) return { machineId: machine.machineId, ok: false, status: "skipped", intended: machine, observed: { reason: "rollout-stopped" } };
          const result = await executeMachine(machine, plan, executor, executionOptions);
          if (!result.ok) failed = true;
          emit("deployment-machine-complete", { planId: plan.id, result });
          return result;
        });
        results.push(...batchResults);
        if (failed && rollout.stopOnFirstFailure) stopped = true;
        return !failed;
      };
      if (rollout.mode === "canary-then-rest") {
        const canaries = plan.machines.slice(0, rollout.canaryCount);
        const canaryPassed = await runBatch(canaries, Math.min(canaries.length, rollout.concurrency));
        if (canaryPassed) await runBatch(plan.machines.slice(canaries.length), rollout.concurrency);
        else {
          stopped = true;
          results.push(...plan.machines.slice(canaries.length).map((machine) => ({ machineId: machine.machineId, ok: false, status: "skipped", intended: machine, observed: { reason: "canary-failed" } })));
        }
      } else if (rollout.mode === "stop-on-first-failure") {
        for (const machine of plan.machines) {
          if (stopped) {
            results.push({ machineId: machine.machineId, ok: false, status: "skipped", intended: machine, observed: { reason: "rollout-stopped" } });
            continue;
          }
          const result = await executeMachine(machine, plan, executor, executionOptions);
          results.push(result);
          if (!result.ok) stopped = true;
        }
      } else {
        await runBatch(plan.machines, rollout.mode === "all-at-once" ? plan.machines.length : rollout.concurrency);
      }
      const report = engine.aggregateResults(plan, results);
      emit("deployment-complete", { report });
      return report;
    },

    execute(plan, executionOptions) { return engine.executeDeploymentPlan(plan, executionOptions); },

    aggregateResults(plan, results) {
      const complete = results.filter((result) => result.status === "complete").length;
      const failed = results.filter((result) => result.status === "failed").length;
      const skipped = results.filter((result) => result.status === "skipped").length;
      return jsonRecord({
        id: makeId("deployment-report"),
        planId: plan.id,
        imageId: plan.imageId,
        intended: { machines: plan.machines.length, rollout: plan.rollout, verification: plan.verification },
        observed: { complete, failed, skipped },
        ok: failed === 0 && skipped === 0,
        stopped: skipped > 0,
        results,
        completedAt: nowIso(),
      });
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return engine;
}

export function getImagingCapabilities() {
  return {
    version: WW_IMAGING_VERSION,
    sources: ["ordinary-file", "sparse-file", "raw-device-via-executor"],
    compression: [...COMPRESSION],
    catalog: ["capture", "resume", "restore", "inspect", "pin", "clone", "rename", "search", "export", "import", "verify", "delete"],
    storage: ["sha256-chunks", "zero-chunk-sparse", "cross-image-deduplication", "peer-assisted-seeding"],
    rolloutModes: ["all-at-once", "bounded-parallel", "canary-then-rest", "stop-on-first-failure"],
    bundles: ["ordered-files-and-commands", "unattended-install", "post-image"],
    verification: ["samples", "full"],
  };
}
