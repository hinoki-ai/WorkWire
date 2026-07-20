import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  atomicWriteJson,
  hashBuffer,
  hashFile,
  isZeroBuffer,
  jsonRecord,
  makeId,
  normalizeRelative,
  pathExists,
  readJson,
  readRange,
  resolveInside,
  throwIfAborted,
  writeAll,
} from "../sync/primitives.mjs";

export const WW_SALVAGE_VERSION = 2;

const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const DOCUMENT_EXTENSIONS = new Set([".doc", ".docx", ".odt", ".pdf", ".rtf", ".txt", ".xls", ".xlsx", ".ods", ".ppt", ".pptx"]);
const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".json", ".jsx", ".kt", ".mjs", ".php", ".pl", ".ps1", ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml"]);
const CREDENTIAL_NAMES = /(?:^|[._-])(credential|secret|password|passwd|token|key|config|settings|profile|env|ssh|gnupg)(?:[._-]|$)/iu;
const MEDIA_EXTENSIONS = new Set([".3gp", ".avi", ".bmp", ".flac", ".gif", ".heic", ".jpeg", ".jpg", ".m4a", ".mkv", ".mov", ".mp3", ".mp4", ".png", ".raw", ".tif", ".tiff", ".wav", ".webm"]);

function nowIso() {
  return new Date().toISOString();
}

function serializeError(error) {
  return { code: String(error?.code || error?.name || "ERR_SALVAGE"), message: String(error?.message || error) };
}

function classify(entry, options = {}) {
  const relative = entry.path.toLowerCase();
  const basename = path.posix.basename(relative);
  const extension = path.posix.extname(basename);
  const explicit = (options.explicitPaths || options.paths || []).map(normalizeRelative);
  const explicitIndex = explicit.findIndex((candidate) => entry.path === candidate || entry.path.startsWith(`${candidate}/`));
  if (explicitIndex >= 0) return { priority: 0, level: "explicit", rank: explicitIndex };
  for (let index = 0; index < (options.rules || []).length; index += 1) {
    const rule = options.rules[index];
    const match = String(rule.path || rule.prefix || "");
    const extensionMatch = rule.extension && extension === String(rule.extension).toLowerCase();
    if ((match && (entry.path === normalizeRelative(match) || entry.path.startsWith(`${normalizeRelative(match)}/`))) || extensionMatch) {
      return { priority: Number(rule.priority ?? index), level: String(rule.label || "operator-rule"), rank: index };
    }
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) return { priority: 10, level: "documents", rank: 0 };
  if (SOURCE_EXTENSIONS.has(extension) || /(?:^|\/)(src|source|code|projects?|repos?)(?:\/|$)/u.test(relative)) return { priority: 20, level: "source-code", rank: 0 };
  if (CREDENTIAL_NAMES.test(relative) || [".pem", ".key", ".kdbx", ".p12", ".pfx"].includes(extension)) return { priority: 30, level: "credentials-config", rank: 0 };
  if (entry.size <= Math.max(1, Number(options.smallFileBytes) || 256 * 1024)) return { priority: 40, level: "small-files", rank: entry.size };
  if (MEDIA_EXTENSIONS.has(extension)) return { priority: 50, level: "photos-media", rank: 0 };
  return { priority: 60, level: "everything-else", rank: 0 };
}

function parseDdrescueMapfile(text = "") {
  const ranges = [];
  for (const rawLine of String(text || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/u);
    if (parts.length < 3) continue;
    const start = Number.parseInt(parts[0], 0);
    const size = Number.parseInt(parts[1], 0);
    const status = parts[2];
    if (!Number.isFinite(start) || !Number.isFinite(size) || size < 0 || !["+", "-", "?", "*", "/"].includes(status)) continue;
    ranges.push({ start, size, end: start + size, status, readable: status === "+" });
  }
  return {
    ranges,
    readableBytes: ranges.filter((range) => range.status === "+").reduce((sum, range) => sum + range.size, 0),
    badBytes: ranges.filter((range) => range.status === "-").reduce((sum, range) => sum + range.size, 0),
    pendingBytes: ranges.filter((range) => range.status !== "+" && range.status !== "-").reduce((sum, range) => sum + range.size, 0),
  };
}

async function resolveDestinations(destinations = []) {
  const resolved = [];
  for (let index = 0; index < destinations.length; index += 1) {
    const input = typeof destinations[index] === "string" ? { path: destinations[index] } : destinations[index];
    const rootPath = path.resolve(String(input.path || input.rootPath || ""));
    if (!String(input.path || input.rootPath || "").trim()) throw new Error("Every salvage destination requires a path.");
    await fsp.mkdir(rootPath, { recursive: true });
    let availableBytes = Number(input.availableBytes ?? input.capacityBytes);
    if (!Number.isFinite(availableBytes)) {
      try {
        const facts = await fsp.statfs(rootPath);
        availableBytes = Number(facts.bavail) * Number(facts.bsize);
      } catch {
        availableBytes = Number.MAX_SAFE_INTEGER;
      }
    }
    resolved.push({ id: String(input.id || `destination-${index + 1}`), path: rootPath, availableBytes: Math.max(0, availableBytes), reserveBytes: Math.max(0, Number(input.reserveBytes) || 0), order: index });
  }
  return resolved;
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => left.priority - right.priority
    || left.priorityRank - right.priorityRank
    || left.size - right.size
    || left.path.localeCompare(right.path));
}

export function createSalvageEngine(options = {}) {
  const stateDir = path.resolve(String(options.stateDir || options.storagePath || path.join(process.cwd(), ".workwire-salvage")));
  const statePath = path.join(stateDir, "state.json");
  const executor = options.executor || null;
  const listeners = new Set();
  let initialized = false;
  let state = {
    version: WW_SALVAGE_VERSION,
    inventories: {},
    jobs: {},
    content: {},
    updatedAt: nowIso(),
  };

  function requireInit() {
    if (!initialized) throw new Error("The salvage engine is not initialized.");
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

  async function readSourceChunk(sourcePath, offset, length, attempt, runOptions) {
    throwIfAborted(runOptions.signal);
    if (runOptions.readChunk) return Buffer.from(await runOptions.readChunk(sourcePath, offset, length, { attempt, signal: runOptions.signal }));
    if (executor?.readFileChunk) return Buffer.from(await executor.readFileChunk(sourcePath, offset, length, { attempt, signal: runOptions.signal }));
    const handle = await fsp.open(sourcePath, "r");
    try { return readRange(handle, offset, length); } finally { await handle.close(); }
  }

  function inventoryBy(value) {
    if (typeof value === "string") return state.inventories[value] || null;
    return value?.entries ? value : null;
  }

  function jobBy(value) {
    if (typeof value === "string") return state.jobs[value] || null;
    return value?.files ? value : null;
  }

  async function verifyRecoveredFile(file) {
    if (!file.destinationPath || !file.hash || !await pathExists(file.destinationPath)) return false;
    const stats = await fsp.stat(file.destinationPath);
    if (stats.size !== file.size) return false;
    return await hashFile(file.destinationPath) === file.hash;
  }

  const engine = {
    async init() {
      if (initialized) return engine;
      await fsp.mkdir(stateDir, { recursive: true });
      state = { ...state, ...(await readJson(statePath, state)) };
      for (const key of ["inventories", "jobs", "content"]) state[key] ||= {};
      state.version = WW_SALVAGE_VERSION;
      initialized = true;
      await persist();
      return engine;
    },

    async close() {
      if (!initialized) return;
      await persist();
      initialized = false;
    },

    async inventory(source, inventoryOptions = {}) {
      requireInit();
      const rootPath = path.resolve(String(source?.path || source?.rootPath || source || ""));
      if (!String(source?.path || source?.rootPath || source || "").trim()) throw new Error("A salvage source directory is required.");
      const stats = await fsp.stat(rootPath);
      if (!stats.isDirectory()) throw new Error(`Salvage source is not a readable directory: ${rootPath}`);
      const entries = [];
      const errors = [];
      const queue = [{ absolute: rootPath, relative: "" }];
      let ddrescue = null;
      if (inventoryOptions.ddrescueMapfile) {
        const text = String(inventoryOptions.ddrescueMapfile).includes("\n")
          ? inventoryOptions.ddrescueMapfile
          : await fsp.readFile(inventoryOptions.ddrescueMapfile, "utf8");
        ddrescue = parseDdrescueMapfile(text);
      }
      while (queue.length) {
        throwIfAborted(inventoryOptions.signal);
        const current = queue.shift();
        let dirents;
        try {
          dirents = await fsp.readdir(current.absolute, { withFileTypes: true });
        } catch (error) {
          errors.push({ path: current.relative, operation: "readdir", error: serializeError(error) });
          continue;
        }
        dirents.sort((left, right) => left.name.localeCompare(right.name));
        for (const dirent of dirents) {
          throwIfAborted(inventoryOptions.signal);
          const relative = normalizeRelative(current.relative ? `${current.relative}/${dirent.name}` : dirent.name);
          const absolute = resolveInside(rootPath, relative);
          let itemStats;
          try {
            itemStats = await fsp.lstat(absolute);
          } catch (error) {
            errors.push({ path: relative, operation: "lstat", error: serializeError(error) });
            continue;
          }
          if (itemStats.isSymbolicLink()) {
            entries.push({ path: relative, sourcePath: absolute, kind: "symlink", size: 0, mtimeMs: Number(itemStats.mtimeMs), ignored: true, reason: "source symlink is never followed in salvage mode" });
          } else if (itemStats.isDirectory()) {
            queue.push({ absolute, relative });
          } else if (itemStats.isFile()) {
            const entry = { path: relative, sourcePath: absolute, kind: "file", size: Number(itemStats.size), mtimeMs: Number(itemStats.mtimeMs), mode: Number(itemStats.mode), discoveredAt: nowIso() };
            Object.assign(entry, classify(entry, inventoryOptions));
            if (ddrescue && inventoryOptions.mapPathToRanges) {
              const ranges = await inventoryOptions.mapPathToRanges(absolute, itemStats);
              const bad = ranges.some((range) => ddrescue.ranges.some((map) => map.status === "-" && range.start < map.end && range.start + range.length > map.start));
              entry.readabilityHint = bad ? "known-bad-range" : "no-known-bad-range";
            }
            entries.push(entry);
            inventoryOptions.onProgress?.({ stage: "inventory", path: relative, files: entries.length });
          }
        }
      }
      const id = String(inventoryOptions.id || makeId("inventory"));
      const inventory = {
        id,
        version: WW_SALVAGE_VERSION,
        rootPath,
        source: jsonRecord(typeof source === "object" ? source : { path: rootPath }),
        entries: sortEntries(entries.filter((entry) => entry.kind === "file")),
        ignored: entries.filter((entry) => entry.ignored),
        errors,
        ddrescue,
        totals: { files: entries.filter((entry) => entry.kind === "file").length, bytes: entries.filter((entry) => entry.kind === "file").reduce((sum, entry) => sum + entry.size, 0), discoveryErrors: errors.length },
        createdAt: nowIso(),
      };
      state.inventories[id] = inventory;
      await persist();
      emit("inventory-complete", { inventoryId: id, totals: inventory.totals });
      return jsonRecord(inventory);
    },

    createInventory(source, inventoryOptions) { return engine.inventory(source, inventoryOptions); },
    inventoryTree(source, inventoryOptions) { return engine.inventory(source, inventoryOptions); },

    async estimateCapacity(inventoryInput, destinationsInput = [], estimateOptions = {}) {
      requireInit();
      const inventory = inventoryBy(inventoryInput);
      if (!inventory) throw new Error("A valid salvage inventory is required.");
      const destinations = await resolveDestinations(destinationsInput);
      const availableBytes = destinations.reduce((sum, destination) => sum + Math.max(0, destination.availableBytes - destination.reserveBytes), 0);
      let cumulativeBytes = 0;
      const levels = [];
      for (const level of [...new Set(sortEntries(inventory.entries).map((entry) => entry.level))]) {
        throwIfAborted(estimateOptions.signal);
        const entries = inventory.entries.filter((entry) => entry.level === level);
        const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
        cumulativeBytes += bytes;
        levels.push({ level, files: entries.length, bytes, cumulativeBytes, fits: cumulativeBytes <= availableBytes, bytesOver: Math.max(0, cumulativeBytes - availableBytes) });
      }
      return jsonRecord({ inventoryId: inventory.id, destinations, availableBytes, requiredBytes: inventory.totals.bytes, allFit: inventory.totals.bytes <= availableBytes, levels });
    },

    async buildPlan(inventoryInput, destinationsInput = [], planOptions = {}) {
      requireInit();
      const inventory = inventoryBy(inventoryInput);
      if (!inventory) throw new Error("A valid salvage inventory is required.");
      const destinations = await resolveDestinations(destinationsInput);
      if (!destinations.length) throw new Error("At least one healthy salvage destination is required.");
      const remaining = new Map(destinations.map((destination) => [destination.id, Math.max(0, destination.availableBytes - destination.reserveBytes)]));
      const files = [];
      let destinationCursor = 0;
      for (const entry of sortEntries(inventory.entries)) {
        throwIfAborted(planOptions.signal);
        let selected = null;
        for (let attempt = 0; attempt < destinations.length; attempt += 1) {
          const candidate = destinations[(destinationCursor + attempt) % destinations.length];
          if ((remaining.get(candidate.id) || 0) >= entry.size) {
            selected = candidate;
            destinationCursor = (destinations.indexOf(candidate) + 1) % destinations.length;
            break;
          }
        }
        if (selected) remaining.set(selected.id, remaining.get(selected.id) - entry.size);
        files.push({
          id: makeId("salvage-file", inventory.id, entry.path),
          path: entry.path,
          sourcePath: entry.sourcePath,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          mode: entry.mode,
          priority: entry.priority,
          level: entry.level,
          destinationId: selected?.id || null,
          destinationPath: selected ? resolveInside(selected.path, planOptions.subdirectory ? `${normalizeRelative(planOptions.subdirectory)}/${entry.path}` : entry.path) : null,
          status: selected ? "pending" : "missing",
          offset: 0,
          retries: 0,
          readErrors: [],
          chunks: [],
          hash: null,
          bytesWritten: 0,
        });
      }
      const id = String(planOptions.id || planOptions.jobId || makeId("salvage"));
      const job = {
        id,
        version: WW_SALVAGE_VERSION,
        inventoryId: inventory.id,
        sourceRoot: inventory.rootPath,
        destinations,
        files,
        options: {
          chunkSize: Math.max(64 * 1024, Number(planOptions.chunkSize) || DEFAULT_CHUNK_SIZE),
          retries: Math.max(0, Number(planOptions.retries ?? 2)),
          deduplicate: planOptions.deduplicate !== false,
          continueOnReadError: planOptions.continueOnReadError !== false,
        },
        status: "planned",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.jobs[id] = job;
      await persist();
      emit("salvage-planned", { jobId: id, files: files.length, assigned: files.filter((file) => file.destinationId).length });
      return jsonRecord(job);
    },

    plan(inventoryInput, destinations, planOptions) { return engine.buildPlan(inventoryInput, destinations, planOptions); },

    async createJob(source, destinations, jobOptions = {}) {
      const inventory = await engine.inventory(source, jobOptions);
      return engine.buildPlan(inventory, destinations, jobOptions);
    },

    async run(jobInput, runOptions = {}) {
      requireInit();
      const job = jobBy(jobInput);
      if (!job || !state.jobs[job.id]) throw new Error("A valid persisted salvage job is required.");
      const persistedJob = state.jobs[job.id];
      persistedJob.status = "running";
      persistedJob.startedAt ||= nowIso();
      await persist();
      for (const file of persistedJob.files) {
        throwIfAborted(runOptions.signal);
        if (!file.destinationPath || file.status === "missing" || file.status === "corrupt") continue;
        if (file.status === "recovered" && await verifyRecoveredFile(file)) {
          file.resumedVerified = true;
          continue;
        }
        const temporary = `${file.destinationPath}.ww-salvage-${persistedJob.id}.part`;
        file.temporaryPath = temporary;
        await fsp.mkdir(path.dirname(file.destinationPath), { recursive: true });
        let tempStats = await fsp.stat(temporary).catch(() => null);
        file.chunks ||= [];
        if (!tempStats) {
          file.offset = 0;
          file.chunks = [];
        } else {
          const verifyHandle = await fsp.open(temporary, "r");
          let verifiedOffset = 0;
          const verifiedChunks = [];
          try {
            for (const chunk of file.chunks.sort((left, right) => left.offset - right.offset)) {
              if (chunk.offset !== verifiedOffset || chunk.offset + chunk.length > tempStats.size) break;
              const bytes = await readRange(verifyHandle, chunk.offset, chunk.length);
              if (bytes.length !== chunk.length || hashBuffer(bytes) !== chunk.hash) break;
              verifiedChunks.push(chunk);
              verifiedOffset += chunk.length;
            }
          } finally {
            await verifyHandle.close();
          }
          file.offset = verifiedOffset;
          file.chunks = verifiedChunks;
          if (tempStats.size !== verifiedOffset) await fsp.truncate(temporary, verifiedOffset);
          tempStats = await fsp.stat(temporary);
        }
        const handle = await fsp.open(temporary, tempStats ? "r+" : "w+");
        const hasher = crypto.createHash("sha256");
        if (file.offset > 0) {
          const prefixStream = fs.createReadStream(temporary, { start: 0, end: file.offset - 1, highWaterMark: persistedJob.options.chunkSize });
          for await (const chunk of prefixStream) hasher.update(chunk);
        }
        file.status = "copying";
        let failed = false;
        try {
          while (file.offset < file.size) {
            throwIfAborted(runOptions.signal);
            const length = Math.min(persistedJob.options.chunkSize, file.size - file.offset);
            let buffer = null;
            let lastError = null;
            for (let attempt = 0; attempt <= persistedJob.options.retries; attempt += 1) {
              try {
                buffer = await readSourceChunk(file.sourcePath, file.offset, length, attempt, runOptions);
                if (buffer.length !== length) throw Object.assign(new Error(`Short read: expected ${length}, received ${buffer.length}.`), { code: "ERR_WW_SALVAGE_SHORT_READ" });
                break;
              } catch (error) {
                lastError = error;
                file.retries += 1;
                file.readErrors.push({ offset: file.offset, length, attempt, at: nowIso(), error: serializeError(error) });
                await persist();
              }
            }
            if (!buffer) {
              file.status = file.offset > 0 ? "partial" : "corrupt";
              file.error = serializeError(lastError);
              failed = true;
              break;
            }
            if (!isZeroBuffer(buffer)) await writeAll(handle, buffer, file.offset);
            hasher.update(buffer);
            file.chunks.push({ offset: file.offset, length: buffer.length, hash: hashBuffer(buffer) });
            file.offset += buffer.length;
            file.bytesWritten += buffer.length;
            await handle.truncate(file.size);
            await handle.sync();
            file.updatedAt = nowIso();
            await persist();
            const progress = { stage: "salvage-copy", jobId: persistedJob.id, fileId: file.id, path: file.path, offset: file.offset, size: file.size, priority: file.priority, level: file.level };
            emit("progress", progress);
            runOptions.onProgress?.(progress);
          }
        } catch (error) {
          file.status = file.offset > 0 ? "partial" : "pending";
          file.error = serializeError(error);
          await persist();
          throw error;
        } finally {
          await handle.close();
        }
        if (failed) {
          if (!persistedJob.options.continueOnReadError) break;
          continue;
        }
        const hash = hasher.digest("hex");
        file.hash = hash;
        const duplicate = persistedJob.options.deduplicate ? state.content[hash] : null;
        if (duplicate?.path && await pathExists(duplicate.path) && duplicate.path !== file.destinationPath) {
          await fsp.rm(temporary, { force: true });
          await fsp.rm(file.destinationPath, { force: true }).catch(() => {});
          try {
            await fsp.link(duplicate.path, file.destinationPath);
            file.deduplicated = true;
            file.duplicateOf = duplicate.fileId;
            file.deduplicatedBytes = file.size;
          } catch {
            await fsp.copyFile(duplicate.path, file.destinationPath, fs.constants.COPYFILE_FICLONE);
            file.deduplicated = false;
            file.duplicateOf = duplicate.fileId;
          }
        } else {
          await fsp.rename(temporary, file.destinationPath);
        }
        await fsp.chmod(file.destinationPath, file.mode & 0o777).catch(() => {});
        const timestamp = file.mtimeMs / 1000;
        await fsp.utimes(file.destinationPath, timestamp, timestamp).catch(() => {});
        if (await hashFile(file.destinationPath) !== hash) {
          file.status = "corrupt";
          file.error = { code: "ERR_WW_SALVAGE_VERIFY", message: "Destination checksum differs from recovered content." };
        } else {
          file.status = "recovered";
          file.verifiedAt = nowIso();
          state.content[hash] ||= { hash, path: file.destinationPath, fileId: file.id, size: file.size, createdAt: nowIso() };
        }
        delete file.temporaryPath;
        await persist();
      }
      const report = engine.getReport(persistedJob.id);
      persistedJob.status = report.partial || report.corrupt || report.missing ? "completed-with-errors" : "complete";
      persistedJob.completedAt = nowIso();
      persistedJob.report = report;
      await persist();
      emit("salvage-complete", { jobId: persistedJob.id, report });
      return jsonRecord(report);
    },

    recover(jobInput, runOptions) { return engine.run(jobInput, runOptions); },
    salvage(jobInput, runOptions) { return engine.run(jobInput, runOptions); },
    resume(jobId, runOptions) { return engine.run(jobId, runOptions); },
    execute(jobInput, runOptions) { return engine.run(jobInput, runOptions); },

    getJob(jobId) {
      requireInit();
      return state.jobs[String(jobId)] ? jsonRecord(state.jobs[String(jobId)]) : null;
    },

    getReport(jobId) {
      requireInit();
      const job = state.jobs[String(jobId)];
      if (!job) return null;
      const counts = { recovered: 0, missing: 0, partial: 0, corrupt: 0, pending: 0, copying: 0 };
      for (const file of job.files) counts[file.status] = (counts[file.status] || 0) + 1;
      const recoveredBytes = job.files.filter((file) => file.status === "recovered").reduce((sum, file) => sum + file.size, 0);
      const partialBytes = job.files.filter((file) => file.status === "partial").reduce((sum, file) => sum + file.offset, 0);
      return jsonRecord({
        id: makeId("salvage-report", job.id),
        jobId: job.id,
        sourceRoot: job.sourceRoot,
        destinations: job.destinations,
        ...counts,
        total: job.files.length,
        recoveredBytes,
        partialBytes,
        deduplicatedBytes: job.files.reduce((sum, file) => sum + (file.deduplicatedBytes || 0), 0),
        retries: job.files.reduce((sum, file) => sum + file.retries, 0),
        readErrors: job.files.flatMap((file) => file.readErrors.map((error) => ({ fileId: file.id, path: file.path, ...error }))),
        files: job.files,
        checksumManifest: job.files.filter((file) => file.status === "recovered").map((file) => ({ algorithm: "sha256", hash: file.hash, path: file.path, destinationId: file.destinationId, destinationPath: file.destinationPath, size: file.size })),
        completedAt: job.completedAt || nowIso(),
      });
    },

    getChecksumManifest(jobId, manifestOptions = {}) {
      const report = engine.getReport(jobId);
      if (!report) return manifestOptions.format === "text" ? "" : [];
      if (manifestOptions.format === "text" || manifestOptions.format === "sha256sum") {
        return `${report.checksumManifest.map((entry) => `${entry.hash}  ${entry.path}`).join("\n")}${report.checksumManifest.length ? "\n" : ""}`;
      }
      return report.checksumManifest;
    },

    async preview(sourcePath, previewOptions = {}) {
      requireInit();
      const target = path.resolve(String(sourcePath));
      const stats = await fsp.lstat(target);
      const maxBytes = Math.max(0, Math.min(Number(previewOptions.maxBytes) || 64 * 1024, 1024 * 1024));
      return {
        metadata: { path: target, name: path.basename(target), kind: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other", size: Number(stats.size), mtimeMs: Number(stats.mtimeMs), mode: Number(stats.mode), previewBytes: stats.isFile() ? Math.min(maxBytes, stats.size) : 0, truncated: stats.isFile() && stats.size > maxBytes },
        stream: stats.isFile() && stats.size > 0 && maxBytes > 0 ? fs.createReadStream(target, { start: 0, end: Math.min(stats.size, maxBytes) - 1, highWaterMark: 64 * 1024 }) : Readable.from([]),
      };
    },

    openPreviewStream(sourcePath, previewOptions) { return engine.preview(sourcePath, previewOptions); },
    parseDdrescueMapfile,

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return engine;
}

export function getSalvageCapabilities() {
  return {
    version: WW_SALVAGE_VERSION,
    inventory: ["metadata-only-discovery", "directory-trees", "ddrescue-mapfile-hints", "streamed-preview"],
    priorities: ["explicit", "documents", "source-code", "credentials-config", "small-files", "photos-media", "everything-else"],
    transfer: ["durable-per-file-checkpoints", "chunk-retry", "atomic-destination", "multiple-destination-spill", "sparse-zero-ranges", "sha256-verification"],
    outcomes: ["recovered", "missing", "partial", "corrupt"],
    deduplication: ["verified-content-hash", "hardlink-when-possible", "reflink-fallback"],
    sourceMutation: false,
  };
}
