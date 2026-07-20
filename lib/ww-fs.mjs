import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { startPerformanceSpan } from "./ww-performance.mjs";

export const WW_INTERNAL_PORTAL_BASENAMES = Object.freeze([
  ".workwire",
  ".codex",
  ".git",
  "dist",
  "link",
  "node_modules",
  "runtime",
]);

export const WW_TRASH_RETENTION_MS = 5 * 24 * 60 * 60 * 1_000;
const WW_TRASH_DIRECTORY_NAME = "trash";
const WW_TRASH_METADATA_NAME = "metadata.json";
const WW_TRASH_PAYLOAD_NAME = "payload";
const WW_DIRECTORY_STAT_CONCURRENCY = 32;
const WW_FILE_STREAM_HIGH_WATER_MARK = 1024 * 1024;
const WW_SMALL_FILE_BATCH_MAGIC = Buffer.from("WWB1");
const WW_SMALL_FILE_BATCH_HEADER_LIMIT = 4 * 1024 * 1024;
const WW_SMALL_FILE_BATCH_FILE_LIMIT = 256 * 1024;
const WW_SMALL_FILE_BATCH_TOTAL_LIMIT = 16 * 1024 * 1024;
const WW_SMALL_FILE_BATCH_ENTRY_LIMIT = 20_000;
let wwSmallFileBatchTemporarySequence = 0;
const DIRECTORY_ENTRY_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const COOPERATIVE_SORT_THRESHOLD = 20_000;
const COOPERATIVE_SORT_RUN_SIZE = 2_048;
const COOPERATIVE_SORT_YIELD_BUDGET_NS = 8_000_000n;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function isWwTemporaryBasename(name = "") {
  const value = String(name || "");
  return (
    value.startsWith(".ww-upload-")
    || value.startsWith(".ww-displaced-")
  ) && value.endsWith(".tmp");
}

export function isWwMirrorConflictBasename(name = "") {
  return /^(?:.+ \(WW conflict [a-f0-9]{8}-\d+\)|WW conflict [a-f0-9]{8}-[a-f0-9]{8}-\d+)(?:\.[^./\\]+)?$/u
    .test(String(name || ""));
}

function normalizeBatchRelativePath(value, { allowEmpty = false } = {}) {
  const raw = String(value ?? "").replaceAll("\\", "/");
  if (!raw && allowEmpty) return "";
  if (!raw || raw.startsWith("/") || raw.includes("\0")) {
    const error = new Error("WW small-file batch contains an unsafe relative path.");
    error.code = "ERR_WW_SMALL_BATCH_PATH";
    throw error;
  }
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || isWwMirrorConflictBasename(segment))) {
    const error = new Error("WW small-file batch contains an unsafe or conflict path.");
    error.code = "ERR_WW_SMALL_BATCH_PATH";
    throw error;
  }
  return segments.join("/");
}

function joinBatchPath(rootPath, relativePath) {
  const relative = normalizeBatchRelativePath(relativePath);
  const targetPath = path.join(rootPath, ...relative.split("/"));
  if (!isPathInsideRoot(targetPath, rootPath)) {
    const error = new Error("WW small-file batch escaped its destination root.");
    error.code = "ERR_WW_SMALL_BATCH_PATH";
    throw error;
  }
  return targetPath;
}

function replaceBatchPrefix(relativePath, mappings) {
  for (const mapping of mappings) {
    if (relativePath === mapping.original) return mapping.replacement;
    if (relativePath.startsWith(`${mapping.original}/`)) return `${mapping.replacement}${relativePath.slice(mapping.original.length)}`;
  }
  return relativePath;
}

function frameSmallFileBatch(header) {
  const body = Buffer.from(JSON.stringify(header));
  if (body.length > WW_SMALL_FILE_BATCH_HEADER_LIMIT) {
    const error = new Error("WW small-file batch header is too large.");
    error.code = "ERR_WW_SMALL_BATCH_HEADER";
    throw error;
  }
  const prefix = Buffer.allocUnsafe(8);
  WW_SMALL_FILE_BATCH_MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(body.length, 4);
  return [prefix, body];
}

class SmallFileBatchReader {
  constructor(readable) {
    this.iterator = readable[Symbol.asyncIterator]();
    this.remainder = Buffer.alloc(0);
  }

  async take(length) {
    if (!Number.isSafeInteger(length) || length < 0) {
      const error = new Error("WW small-file batch has an invalid length.");
      error.code = "ERR_WW_SMALL_BATCH_FORMAT";
      throw error;
    }
    if (length === 0) return Buffer.alloc(0);
    const chunks = [];
    let remaining = length;
    while (remaining > 0) {
      if (this.remainder.length === 0) {
        const next = await this.iterator.next();
        if (next.done) {
          const error = new Error("WW small-file batch ended before its declared payload.");
          error.code = "ERR_WW_SMALL_BATCH_TRUNCATED";
          throw error;
        }
        this.remainder = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      }
      const count = Math.min(remaining, this.remainder.length);
      chunks.push(this.remainder.subarray(0, count));
      this.remainder = this.remainder.subarray(count);
      remaining -= count;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
  }

  async assertEnd() {
    if (this.remainder.length > 0) {
      const error = new Error("WW small-file batch has trailing data.");
      error.code = "ERR_WW_SMALL_BATCH_FORMAT";
      throw error;
    }
    const next = await this.iterator.next();
    if (!next.done && Buffer.from(next.value).length > 0) {
      const error = new Error("WW small-file batch has trailing data.");
      error.code = "ERR_WW_SMALL_BATCH_FORMAT";
      throw error;
    }
  }
}

function isWindowsDrivePath(value = "") {
  return /^[a-zA-Z]:[\\/]/.test(String(value || ""));
}

export function normalizeUserPath(inputPath, {
  cwd = process.cwd(),
  homeDir = os.homedir(),
} = {}) {
  const rawValue = String(inputPath ?? "");
  if (!rawValue.trim()) {
    return path.resolve(homeDir);
  }
  const raw = rawValue;

  let candidate = raw;
  if (candidate === "~") {
    candidate = homeDir;
  } else if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    candidate = path.join(homeDir, candidate.slice(2));
  }

  if (path.isAbsolute(candidate) || isWindowsDrivePath(candidate)) {
    return path.normalize(candidate);
  }

  return path.resolve(cwd, candidate);
}

export function isHiddenName(name = "") {
  return String(name || "").startsWith(".");
}

export function serializeFsError(error, fallbackMessage = "Filesystem operation failed.") {
  return {
    code: String(error?.code || "ERR_FS_OPERATION"),
    message: String(error?.message || fallbackMessage),
  };
}

export function isPathInsideRoot(targetPath, rootPath) {
  const normalizedTargetPath = normalizeUserPath(targetPath);
  const normalizedRootPath = normalizeUserPath(rootPath);
  const relativePath = path.relative(normalizedRootPath, normalizedTargetPath);
  return relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeProtectedBasenames(protectedBasenames = WW_INTERNAL_PORTAL_BASENAMES) {
  return new Set(
    (Array.isArray(protectedBasenames) ? protectedBasenames : [...protectedBasenames])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
}

function getRootRelativeSegments(targetPath, rootPath) {
  const normalizedTargetPath = normalizeUserPath(targetPath);
  const normalizedRootPath = normalizeUserPath(rootPath);
  const relativePath = path.relative(normalizedRootPath, normalizedTargetPath);
  if (!relativePath || relativePath === "." || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return [];
  }
  return relativePath.split(path.sep).filter(Boolean);
}

export function getProtectedPortalBasename(targetPath, {
  rootPath,
  protectedBasenames = WW_INTERNAL_PORTAL_BASENAMES,
} = {}) {
  if (!String(rootPath || "").trim()) {
    return "";
  }
  const relativeSegments = getRootRelativeSegments(targetPath, rootPath);
  if (relativeSegments.some((segment) => isWwTemporaryBasename(segment))) {
    return relativeSegments.find((segment) => isWwTemporaryBasename(segment)) || "";
  }
  const firstSegment = relativeSegments[0] || "";
  return normalizeProtectedBasenames(protectedBasenames).has(firstSegment)
    ? firstSegment
    : "";
}

export function assertPortalPathAllowed(targetPath, {
  rootPath,
  protectedBasenames = WW_INTERNAL_PORTAL_BASENAMES,
} = {}) {
  const normalizedTargetPath = normalizeUserPath(targetPath);
  const normalizedRootPath = normalizeUserPath(rootPath);
  const protectedBasename = getProtectedPortalBasename(normalizedTargetPath, {
    rootPath: normalizedRootPath,
    protectedBasenames,
  });
  if (!protectedBasename) {
    return normalizedTargetPath;
  }

  const error = new Error(`WW keeps ${protectedBasename}/ reserved for internal files inside ${normalizedRootPath}.`);
  error.code = "ERR_WW_INTERNAL_PORTAL_PATH";
  throw error;
}

export async function assertPortalPathResolvedInsideRoot(targetPath, {
  rootPath,
} = {}) {
  const normalizedTargetPath = normalizeUserPath(targetPath);
  const normalizedRootPath = normalizeUserPath(rootPath);
  const resolvedRootPath = await fsp.realpath(normalizedRootPath);
  let existingAncestor = normalizedTargetPath;

  while (true) {
    try {
      const resolvedAncestor = await fsp.realpath(existingAncestor);
      if (!isPathInsideRoot(resolvedAncestor, resolvedRootPath)) {
        const error = new Error(`WW blocked a path that resolves outside ${normalizedRootPath}.`);
        error.code = "ERR_WW_SYMLINK_OUTSIDE_PORTAL";
        throw error;
      }
      return normalizedTargetPath;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw error;
      }

      const parentPath = path.dirname(existingAncestor);
      if (parentPath === existingAncestor) {
        throw error;
      }
      existingAncestor = parentPath;
    }
  }
}

export function resolveSandboxedPath(requestedPath, {
  rootPath,
  defaultPath = rootPath,
} = {}) {
  const normalizedRootPath = normalizeUserPath(rootPath);
  const hasRequestedPath = String(requestedPath ?? "").trim().length > 0;
  const normalizedTargetPath = normalizeUserPath(
    hasRequestedPath ? requestedPath : defaultPath,
    {
      cwd: normalizedRootPath,
      homeDir: normalizedRootPath,
    },
  );

  if (!isPathInsideRoot(normalizedTargetPath, normalizedRootPath)) {
    const error = new Error(`WW is locked to ${normalizedRootPath}.`);
    error.code = "ERR_WW_OUTSIDE_PORTAL";
    throw error;
  }

  return normalizedTargetPath;
}

export async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function inferItemKind(stats) {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

function formatPathRecord(targetPath, stats, { name = path.basename(targetPath) } = {}) {
  return {
    path: targetPath,
    name,
    kind: inferItemKind(stats),
    size: stats.isFile() ? Number(stats.size) || 0 : 0,
    mtimeMs: Number(stats.mtimeMs) || 0,
  };
}

export async function getPathRecord(targetPath, {
  allowMissing = false,
} = {}) {
  const normalizedPath = normalizeUserPath(targetPath);
  try {
    const stats = await fsp.lstat(normalizedPath);
    return formatPathRecord(normalizedPath, stats);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function compareDirectoryEntries(left, right) {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return DIRECTORY_ENTRY_COLLATOR.compare(left.name, right.name);
}

async function mergeSortedRuns(source, destination, start, middle, end) {
  let left = start;
  let right = middle;
  let output = start;
  let yieldStartedAt = process.hrtime.bigint();
  while (left < middle && right < end) {
    if (compareDirectoryEntries(source[left], source[right]) <= 0) {
      destination[output] = source[left];
      left += 1;
    } else {
      destination[output] = source[right];
      right += 1;
    }
    output += 1;
    if ((output & 511) === 0 && process.hrtime.bigint() - yieldStartedAt >= COOPERATIVE_SORT_YIELD_BUDGET_NS) {
      await yieldToEventLoop();
      yieldStartedAt = process.hrtime.bigint();
    }
  }
  while (left < middle) {
    destination[output] = source[left];
    left += 1;
    output += 1;
  }
  while (right < end) {
    destination[output] = source[right];
    right += 1;
    output += 1;
  }
}

async function sortDirectoryEntries(items) {
  if (items.length < COOPERATIVE_SORT_THRESHOLD) {
    items.sort(compareDirectoryEntries);
    return items;
  }

  for (let start = 0; start < items.length; start += COOPERATIVE_SORT_RUN_SIZE) {
    items
      .slice(start, Math.min(items.length, start + COOPERATIVE_SORT_RUN_SIZE))
      .sort(compareDirectoryEntries)
      .forEach((entry, offset) => {
        items[start + offset] = entry;
      });
    await yieldToEventLoop();
  }

  let source = items;
  let destination = new Array(items.length);
  for (let width = COOPERATIVE_SORT_RUN_SIZE; width < items.length; width *= 2) {
    for (let start = 0; start < items.length; start += width * 2) {
      const middle = Math.min(start + width, items.length);
      const end = Math.min(start + (width * 2), items.length);
      await mergeSortedRuns(source, destination, start, middle, end);
      await yieldToEventLoop();
    }
    [source, destination] = [destination, source];
  }
  if (source !== items) {
    for (let index = 0; index < items.length; index += 1) {
      items[index] = source[index];
    }
  }
  return items;
}

export async function listDirectory(directoryPath, {
  includeHidden = false,
  filter = "",
  rootPath = directoryPath,
  protectedBasenames = WW_INTERNAL_PORTAL_BASENAMES,
} = {}) {
  const span = startPerformanceSpan("filesystem.list-directory", {
    includeHidden: Boolean(includeHidden),
    filtered: Boolean(String(filter || "").trim()),
  });
  try {
  const normalizedPath = normalizeUserPath(directoryPath);
  const normalizedRootPath = normalizeUserPath(rootPath);
  const stats = await fsp.stat(normalizedPath);
  if (!stats.isDirectory()) {
    throw new Error(`${normalizedPath} is not a directory.`);
  }

  const dirEntries = await fsp.readdir(normalizedPath, { withFileTypes: true });
  const normalizedFilter = String(filter || "").trim().toLowerCase();
  const protectedNameSet = normalizeProtectedBasenames(protectedBasenames);
  const hideProtectedChildren = normalizedPath === normalizedRootPath;
  const candidates = [];

  for (const dirent of dirEntries) {
    if (isWwTemporaryBasename(dirent.name)) {
      continue;
    }

    if (hideProtectedChildren && protectedNameSet.has(dirent.name)) {
      continue;
    }

    if (!includeHidden && isHiddenName(dirent.name)) {
      continue;
    }

    if (normalizedFilter && !dirent.name.toLowerCase().includes(normalizedFilter)) {
      continue;
    }

    candidates.push(dirent);
  }

  const items = new Array(candidates.length);
  let cursor = 0;
  const workerCount = Math.min(WW_DIRECTORY_STAT_CONCURRENCY, candidates.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const dirent = candidates[index];
      const entryPath = path.join(normalizedPath, dirent.name);
      try {
        const entryStats = await fsp.lstat(entryPath);
        items[index] = formatPathRecord(entryPath, entryStats, { name: dirent.name });
      } catch (error) {
        items[index] = {
          path: entryPath,
          name: dirent.name,
          kind: "error",
          size: 0,
          mtimeMs: 0,
          error: serializeFsError(error),
        };
      }
    }
  }));

  await sortDirectoryEntries(items);
  const parentPath = path.dirname(normalizedPath);

  const listing = {
    path: normalizedPath,
    parentPath: parentPath === normalizedPath ? null : parentPath,
    items,
  };
  span?.end({ ok: true, entryCount: items.length });
  return listing;
  } catch (error) {
    span?.end({ ok: false, errorCode: String(error?.code || "ERR_LIST_DIRECTORY") });
    throw error;
  }
}

export async function createDirectory(directoryPath) {
  const normalizedPath = normalizeUserPath(directoryPath);
  await fsp.mkdir(normalizedPath, { recursive: true });
  return getPathRecord(normalizedPath);
}

export async function createFile(filePath, {
  overwrite = false,
  contents = "",
} = {}) {
  const normalizedPath = normalizeUserPath(filePath);
  await fsp.mkdir(path.dirname(normalizedPath), { recursive: true });
  await fsp.writeFile(normalizedPath, contents, {
    encoding: "utf8",
    flag: overwrite ? "w" : "wx",
  });
  return getPathRecord(normalizedPath);
}

export function assertBasename(name = "", action = "rename") {
  const value = String(name ?? "");
  if (!value) {
    throw new Error(`A name is required to ${action}.`);
  }
  if (value === "." || value === "..") {
    throw new Error(`The name ${value} is not valid.`);
  }
  if (value.includes("\0")) {
    throw new Error("A name cannot contain a null byte.");
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`The name ${value} cannot contain path separators.`);
  }
  return value;
}

export function resolveRenamedPath(targetPath, nextName) {
  const normalizedPath = normalizeUserPath(targetPath);
  return path.join(path.dirname(normalizedPath), assertBasename(nextName, "rename"));
}

export async function renamePath(targetPath, nextName) {
  const normalizedPath = normalizeUserPath(targetPath);
  const destinationPath = resolveRenamedPath(normalizedPath, nextName);
  if (destinationPath === normalizedPath) {
    return getPathRecord(normalizedPath);
  }

  await fsp.rename(normalizedPath, destinationPath);
  return getPathRecord(destinationPath);
}

export async function deletePaths(targetPaths = []) {
  const results = [];
  for (const targetPath of Array.isArray(targetPaths) ? targetPaths : []) {
    const normalizedPath = normalizeUserPath(targetPath);
    try {
      await fsp.rm(normalizedPath, {
        recursive: true,
        force: false,
        maxRetries: 2,
      });
      results.push({
        path: normalizedPath,
        ok: true,
      });
    } catch (error) {
      results.push({
        path: normalizedPath,
        ok: false,
        error: serializeFsError(error),
      });
    }
  }
  return results;
}

function resolveTrashRoot(rootPath) {
  return path.join(normalizeUserPath(rootPath), ".workwire", WW_TRASH_DIRECTORY_NAME);
}

function assertTrashItemId(id) {
  const normalizedId = String(id || "").trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(normalizedId)) {
    const error = new Error("The deleted item identifier is invalid.");
    error.code = "ERR_WW_TRASH_ID";
    throw error;
  }
  return normalizedId;
}

async function readTrashItem(entryPath) {
  const metadataPath = path.join(entryPath, WW_TRASH_METADATA_NAME);
  const payloadPath = path.join(entryPath, WW_TRASH_PAYLOAD_NAME);
  const metadata = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
  const stats = await fsp.lstat(payloadPath);
  return {
    id: path.basename(entryPath),
    name: String(metadata.name || path.basename(metadata.originalPath || "")),
    originalPath: normalizeUserPath(metadata.originalPath),
    kind: String(metadata.kind || inferItemKind(stats)),
    size: Number(metadata.size) || 0,
    mtimeMs: Number(metadata.mtimeMs) || 0,
    deletedAt: Number(metadata.deletedAt) || 0,
    expiresAt: Number(metadata.expiresAt) || 0,
  };
}

export async function purgeExpiredTrash(rootPath, {
  now = Date.now(),
} = {}) {
  const trashRoot = resolveTrashRoot(rootPath);
  let entries;
  try {
    entries = await fsp.readdir(trashRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  let purged = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(trashRoot, entry.name);
    try {
      const item = await readTrashItem(entryPath);
      if (item.expiresAt > Number(now)) continue;
      await fsp.rm(entryPath, { recursive: true, force: true });
      purged += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // Incomplete entries are kept for manual recovery instead of being destroyed.
      }
    }
  }
  return purged;
}

export async function listTrash(rootPath, options = {}) {
  const normalizedRootPath = normalizeUserPath(rootPath);
  const now = Number(options.now) || Date.now();
  await purgeExpiredTrash(normalizedRootPath, { now });
  const trashRoot = resolveTrashRoot(normalizedRootPath);
  let entries;
  try {
    entries = await fsp.readdir(trashRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const item = await readTrashItem(path.join(trashRoot, entry.name));
      if (!isPathInsideRoot(item.originalPath, normalizedRootPath) || item.originalPath === normalizedRootPath) {
        continue;
      }
      items.push(item);
    } catch {
      // Ignore an entry that was interrupted while it was being written.
    }
  }
  return items.sort((left, right) => right.deletedAt - left.deletedAt || left.name.localeCompare(right.name));
}

export async function trashPaths(targetPaths = [], {
  rootPath,
  retentionMs = WW_TRASH_RETENTION_MS,
  now = Date.now(),
} = {}) {
  const normalizedRootPath = normalizeUserPath(rootPath);
  const trashRoot = resolveTrashRoot(normalizedRootPath);
  await purgeExpiredTrash(normalizedRootPath, { now });
  await fsp.mkdir(trashRoot, { recursive: true });

  const results = [];
  for (const targetPath of Array.isArray(targetPaths) ? targetPaths : []) {
    const normalizedPath = normalizeUserPath(targetPath);
    const id = `${Number(now).toString(36)}-${randomBytes(8).toString("hex")}`;
    const entryPath = path.join(trashRoot, id);
    const payloadPath = path.join(entryPath, WW_TRASH_PAYLOAD_NAME);
    try {
      if (
        normalizedPath === normalizedRootPath
        || !isPathInsideRoot(normalizedPath, normalizedRootPath)
        || getProtectedPortalBasename(normalizedPath, { rootPath: normalizedRootPath })
      ) {
        const error = new Error("Only user items inside the WorkWire folder can be deleted.");
        error.code = "ERR_WW_TRASH_PATH";
        throw error;
      }
      await assertPortalPathResolvedInsideRoot(normalizedPath, { rootPath: normalizedRootPath });
      const record = await getPathRecord(normalizedPath);
      const item = {
        id,
        name: record.name,
        originalPath: normalizedPath,
        kind: record.kind,
        size: record.size,
        mtimeMs: record.mtimeMs,
        deletedAt: Number(now),
        expiresAt: Number(now) + Math.max(0, Number(retentionMs) || 0),
      };
      await fsp.mkdir(entryPath, { recursive: false });
      await fsp.writeFile(
        path.join(entryPath, WW_TRASH_METADATA_NAME),
        `${JSON.stringify(item, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await fsp.rename(normalizedPath, payloadPath);
      results.push({ ...item, ok: true });
    } catch (error) {
      await fsp.rm(entryPath, { recursive: true, force: true }).catch(() => {});
      results.push({
        path: normalizedPath,
        ok: false,
        error: serializeFsError(error),
      });
    }
  }
  return results;
}

export async function restoreTrashItem(rootPath, id, {
  now = Date.now(),
} = {}) {
  const normalizedRootPath = normalizeUserPath(rootPath);
  const normalizedId = assertTrashItemId(id);
  await purgeExpiredTrash(normalizedRootPath, { now });
  const entryPath = path.join(resolveTrashRoot(normalizedRootPath), normalizedId);
  const item = await readTrashItem(entryPath);

  if (
    !isPathInsideRoot(item.originalPath, normalizedRootPath)
    || item.originalPath === normalizedRootPath
    || getProtectedPortalBasename(item.originalPath, { rootPath: normalizedRootPath })
  ) {
    const error = new Error("The deleted item cannot be restored outside the WorkWire folder.");
    error.code = "ERR_WW_RESTORE_PATH";
    throw error;
  }
  await assertPortalPathResolvedInsideRoot(item.originalPath, { rootPath: normalizedRootPath });
  if (await pathExists(item.originalPath)) {
    const error = new Error(`${item.name} cannot be restored because an item already exists in its original location.`);
    error.code = "ERR_WW_RESTORE_CONFLICT";
    throw error;
  }

  await fsp.mkdir(path.dirname(item.originalPath), { recursive: true });
  await fsp.rename(path.join(entryPath, WW_TRASH_PAYLOAD_NAME), item.originalPath);
  await fsp.rm(entryPath, { recursive: true, force: true });
  return {
    ...item,
    record: await getPathRecord(item.originalPath),
  };
}

export async function moveLocalPath(sourcePath, destinationPath, {
  overwrite = false,
} = {}) {
  const normalizedSourcePath = normalizeUserPath(sourcePath);
  const normalizedDestinationPath = normalizeUserPath(destinationPath);
  if (!overwrite && await pathExists(normalizedDestinationPath)) {
    throw new Error(`Destination already exists: ${normalizedDestinationPath}`);
  }

  await fsp.mkdir(path.dirname(normalizedDestinationPath), { recursive: true });
  try {
    await fsp.rename(normalizedSourcePath, normalizedDestinationPath);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }

    await copyLocalPath(normalizedSourcePath, normalizedDestinationPath, { overwrite });
    await fsp.rm(normalizedSourcePath, { recursive: true, force: false });
  }

  return getPathRecord(normalizedDestinationPath);
}

export async function copyLocalPath(sourcePath, destinationPath, {
  overwrite = false,
} = {}) {
  const normalizedSourcePath = normalizeUserPath(sourcePath);
  const normalizedDestinationPath = normalizeUserPath(destinationPath);
  const sourceStats = await fsp.lstat(normalizedSourcePath);

  await fsp.mkdir(path.dirname(normalizedDestinationPath), { recursive: true });
  if (sourceStats.isDirectory()) {
    await fsp.cp(normalizedSourcePath, normalizedDestinationPath, {
      recursive: true,
      errorOnExist: !overwrite,
      force: overwrite,
    });
  } else {
    await fsp.copyFile(
      normalizedSourcePath,
      normalizedDestinationPath,
      overwrite ? 0 : fs.constants.COPYFILE_EXCL,
    );
  }

  return getPathRecord(normalizedDestinationPath);
}

export async function buildTransferManifest(targetPath, {
  rootPath = targetPath,
  protectedBasenames = WW_INTERNAL_PORTAL_BASENAMES,
} = {}) {
  const normalizedTargetPath = normalizeUserPath(targetPath);
  const normalizedRootPath = normalizeUserPath(rootPath);
  const protectedNameSet = normalizeProtectedBasenames(protectedBasenames);
  assertPortalPathAllowed(normalizedTargetPath, {
    rootPath: normalizedRootPath,
    protectedBasenames: protectedNameSet,
  });

  const rootRecord = await getPathRecord(normalizedTargetPath);

  if (!rootRecord) {
    throw new Error(`Transfer source not found: ${normalizedTargetPath}`);
  }
  if (rootRecord.kind !== "directory" && rootRecord.kind !== "file" && rootRecord.kind !== "symlink") {
    throw new Error(`Unsupported transfer source: ${normalizedTargetPath}`);
  }
  if (isWwMirrorConflictBasename(rootRecord.name)) {
    const error = new Error("WW conflict copies are recovery evidence and cannot be transferred.");
    error.code = "ERR_WW_CONFLICT_ARTIFACT";
    throw error;
  }

  const manifest = {
    root: rootRecord,
    directories: [],
    files: [],
    skippedLinks: [],
    totals: {
      files: 0,
      directories: 0,
      bytes: 0,
      skippedLinks: 0,
    },
  };

  // Links are deliberately not followed or recreated: following them can
  // escape the selected tree, and recreating them is not portable across the
  // two machines. Treat them as safe, visible skips so one link cannot abort
  // an otherwise valid folder transfer.
  if (rootRecord.kind === "symlink") {
    manifest.skippedLinks.push({
      ...rootRecord,
      relativePath: "",
    });
    manifest.totals.skippedLinks = 1;
    return manifest;
  }

  if (rootRecord.kind === "file") {
    manifest.files.push({
      ...rootRecord,
      relativePath: "",
    });
    manifest.totals.files = 1;
    manifest.totals.bytes = rootRecord.size;
    return manifest;
  }

  const queue = [{
    absolutePath: normalizedTargetPath,
    relativePath: "",
  }];

  while (queue.length > 0) {
    const current = queue.shift();
    manifest.directories.push({
      path: current.absolutePath,
      relativePath: current.relativePath,
    });

    const entries = fs.readdirSync(current.absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }));

    for (const entry of entries) {
      if (isWwTemporaryBasename(entry.name) || isWwMirrorConflictBasename(entry.name)) {
        continue;
      }

      const absolutePath = path.join(current.absolutePath, entry.name);
      if (
        current.absolutePath === normalizedRootPath
        && protectedNameSet.has(entry.name)
      ) {
        continue;
      }

      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name;
      const record = formatPathRecord(absolutePath, fs.lstatSync(absolutePath), { name: entry.name });

      if (record.kind === "symlink") {
        manifest.skippedLinks.push({
          ...record,
          relativePath,
        });
        manifest.totals.skippedLinks += 1;
        continue;
      }

      if (record.kind === "directory") {
        queue.push({
          absolutePath,
          relativePath,
        });
        continue;
      }

      if (record.kind !== "file") {
        continue;
      }

      manifest.files.push({
        ...record,
        relativePath,
      });
      manifest.totals.files += 1;
      manifest.totals.bytes += record.size;
    }
  }

  manifest.totals.directories = manifest.directories.length;
  return manifest;
}

export async function createSmallFileBatchStream(targetPath, {
  rootPath = targetPath,
  protectedBasenames = WW_INTERNAL_PORTAL_BASENAMES,
  manifest: suppliedManifest = null,
} = {}) {
  const normalizedTargetPath = normalizeUserPath(targetPath);
  const manifest = suppliedManifest || await buildTransferManifest(normalizedTargetPath, { rootPath, protectedBasenames });
  if (
    manifest.root.kind !== "directory"
    || manifest.files.length < 2
    || manifest.files.length > WW_SMALL_FILE_BATCH_ENTRY_LIMIT
    || manifest.totals.bytes > WW_SMALL_FILE_BATCH_TOTAL_LIMIT
    || manifest.files.some((file) => file.size > WW_SMALL_FILE_BATCH_FILE_LIMIT)
  ) {
    const error = new Error("WW source is not eligible for a small-file batch.");
    error.code = "ERR_WW_SMALL_BATCH_UNSUPPORTED";
    throw error;
  }

  const payloads = manifest.files.map((file) => {
    const relativePath = normalizeBatchRelativePath(file.relativePath);
    const sourcePath = joinBatchPath(normalizedTargetPath, relativePath);
    const bytes = fs.readFileSync(sourcePath);
    if (bytes.length !== file.size) {
      const error = new Error(`WW source changed while batching ${file.relativePath}.`);
      error.code = "ERR_WW_SMALL_BATCH_SOURCE_CHANGED";
      throw error;
    }
    return bytes;
  });
  const header = {
    format: "ww-small-file-batch-v1",
    directories: manifest.directories.map((directory) => ({
      relativePath: normalizeBatchRelativePath(directory.relativePath, { allowEmpty: true }),
    })),
    files: manifest.files.map((file, index) => ({
      relativePath: normalizeBatchRelativePath(file.relativePath),
      size: file.size,
      mtimeMs: file.mtimeMs,
      hash: createHash("sha256").update(payloads[index]).digest("hex"),
    })),
  };
  const prefix = frameSmallFileBatch(header);
  return {
    manifest,
    stream: Readable.from([...prefix, ...payloads]),
  };
}

function writeSmallFileBuffer(targetPath, bytes, {
  overwrite = false,
  mtimeMs = null,
} = {}) {
  const normalizedPath = normalizeUserPath(targetPath);
  if (!overwrite) {
    // New files have no prior bytes to preserve. One exclusive write removes
    // the temp/link/unlink triplet that dominates NTFS tiny-file throughput;
    // a torn batch is re-sent in full on the next convergent pass.
    fs.writeFileSync(normalizedPath, bytes, { flag: "wx" });
    if (Number.isFinite(Number(mtimeMs))) {
      const timestamp = Number(mtimeMs) / 1000;
      try { fs.utimesSync(normalizedPath, timestamp, timestamp); } catch {}
    }
    return normalizedPath;
  }
  wwSmallFileBatchTemporarySequence += 1;
  const temporaryPath = path.join(
    path.dirname(normalizedPath),
    `.ww-upload-${process.pid}-${wwSmallFileBatchTemporarySequence.toString(36)}.tmp`,
  );
  let committed = false;
  let displacedPath = "";
  try {
    fs.writeFileSync(temporaryPath, bytes, { flag: "wx" });
    if (Number.isFinite(Number(mtimeMs))) {
      const timestamp = Number(mtimeMs) / 1000;
      try { fs.utimesSync(temporaryPath, timestamp, timestamp); } catch {}
    }
    let existing = null;
    try { existing = fs.lstatSync(normalizedPath); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (existing?.isFile() && process.platform !== "win32") {
      fs.chmodSync(temporaryPath, existing.mode & 0o777);
    }
    if (existing?.isDirectory()) {
      wwSmallFileBatchTemporarySequence += 1;
      displacedPath = path.join(
        path.dirname(normalizedPath),
        `.ww-displaced-${process.pid}-${wwSmallFileBatchTemporarySequence.toString(36)}.tmp`,
      );
      fs.renameSync(normalizedPath, displacedPath);
    }
    fs.renameSync(temporaryPath, normalizedPath);
    committed = true;
    if (displacedPath) {
      fs.rmSync(displacedPath, { recursive: true, force: true });
      displacedPath = "";
    }
  } finally {
    if (!committed) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch {}
      if (displacedPath && !fs.existsSync(normalizedPath)) {
        try { fs.renameSync(displacedPath, normalizedPath); } catch {}
      }
    }
  }
  return normalizedPath;
}

async function writeSmallFileBufferAsync(targetPath, bytes, {
  mtimeMs = null,
} = {}) {
  await fsp.writeFile(normalizeUserPath(targetPath), bytes, { flag: "wx" });
  if (Number.isFinite(Number(mtimeMs))) {
    const timestamp = Number(mtimeMs) / 1000;
    await fsp.utimes(normalizeUserPath(targetPath), timestamp, timestamp).catch(() => {});
  }
}

export async function writeSmallFileBatch(targetRootPath, readable, {
  conflictPolicy = "rename",
} = {}) {
  const rootPath = normalizeUserPath(targetRootPath);
  const reader = new SmallFileBatchReader(readable);
  const magic = await reader.take(4);
  if (!magic.equals(WW_SMALL_FILE_BATCH_MAGIC)) {
    const error = new Error("WW small-file batch magic is invalid.");
    error.code = "ERR_WW_SMALL_BATCH_FORMAT";
    throw error;
  }
  const headerLength = (await reader.take(4)).readUInt32BE(0);
  if (headerLength > WW_SMALL_FILE_BATCH_HEADER_LIMIT) {
    const error = new Error("WW small-file batch header is too large.");
    error.code = "ERR_WW_SMALL_BATCH_HEADER";
    throw error;
  }
  let header;
  try {
    header = JSON.parse((await reader.take(headerLength)).toString("utf8"));
  } catch (error) {
    error.code = "ERR_WW_SMALL_BATCH_FORMAT";
    throw error;
  }
  const files = Array.isArray(header?.files) ? header.files : [];
  const directories = Array.isArray(header?.directories) ? header.directories : [];
  if (
    header?.format !== "ww-small-file-batch-v1"
    || files.length < 1
    || files.length > WW_SMALL_FILE_BATCH_ENTRY_LIMIT
    || directories.length > WW_SMALL_FILE_BATCH_ENTRY_LIMIT
  ) {
    const error = new Error("WW small-file batch header is invalid.");
    error.code = "ERR_WW_SMALL_BATCH_FORMAT";
    throw error;
  }

  const normalizedFiles = [];
  let totalBytes = 0;
  for (const file of files) {
    const size = Number(file?.size);
    const relativePath = normalizeBatchRelativePath(file?.relativePath);
    const hash = String(file?.hash || "");
    if (!Number.isSafeInteger(size) || size < 0 || size > WW_SMALL_FILE_BATCH_FILE_LIMIT || !/^[a-f0-9]{64}$/u.test(hash)) {
      const error = new Error("WW small-file batch file metadata is invalid.");
      error.code = "ERR_WW_SMALL_BATCH_FORMAT";
      throw error;
    }
    totalBytes += size;
    if (totalBytes > WW_SMALL_FILE_BATCH_TOTAL_LIMIT) {
      const error = new Error("WW small-file batch payload is too large.");
      error.code = "ERR_WW_SMALL_BATCH_LIMIT";
      throw error;
    }
    normalizedFiles.push({ relativePath, size, hash, mtimeMs: Number(file?.mtimeMs) || 0 });
  }

  const payloads = [];
  for (const file of normalizedFiles) {
    const bytes = await reader.take(file.size);
    if (createHash("sha256").update(bytes).digest("hex") !== file.hash) {
      const error = new Error(`WW small-file batch hash mismatch for ${file.relativePath}.`);
      error.code = "ERR_WW_SMALL_BATCH_VERIFY";
      throw error;
    }
    payloads.push({ ...file, bytes });
  }
  await reader.assertEnd();

  await createDirectory(rootPath);
  const prefixMappings = [];
  const skippedPrefixes = new Set();
  for (const directory of directories) {
    const original = normalizeBatchRelativePath(directory?.relativePath, { allowEmpty: true });
    if (!original) continue;
    const mapped = replaceBatchPrefix(original, prefixMappings);
    let destination = joinBatchPath(rootPath, mapped);
    const existing = await getPathRecord(destination, { allowMissing: true });
    if (!existing) {
      await createDirectory(destination);
      continue;
    }
    if (existing.kind === "directory") continue;
    if (conflictPolicy === "skip") {
      skippedPrefixes.add(original);
      continue;
    }
    if (conflictPolicy === "rename") {
      destination = await ensureUniqueCopyPath(destination);
      const replacement = path.relative(rootPath, destination).split(path.sep).join("/");
      prefixMappings.unshift({ original, replacement });
      await createDirectory(destination);
      continue;
    }
    await fsp.rm(destination, { recursive: true, force: true });
    await createDirectory(destination);
  }

  const planned = payloads.map((file) => {
    if ([...skippedPrefixes].some((prefix) => file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`))) {
      return { ...file, skipped: true };
    }
    const mapped = replaceBatchPrefix(file.relativePath, prefixMappings);
    return { ...file, targetPath: joinBatchPath(rootPath, mapped), skipped: false };
  });
  const ready = planned.map((file) => {
    if (file.skipped) return file;
    // The normal convergent path is overwrite.  Do not spend a separate NTFS
    // round trip probing every fresh target: exclusive creation below is both
    // the no-clobber operation and the existence probe.  A concurrent or
    // pre-existing target falls back to the atomic replacement path on EEXIST.
    if (conflictPolicy === "overwrite") {
      return { ...file, overwrite: false, optimisticOverwrite: true };
    }
    let existing = null;
    try { existing = formatPathRecord(file.targetPath, fs.lstatSync(file.targetPath)); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!existing) return { ...file, overwrite: false };
    if (conflictPolicy === "skip") return { ...file, skipped: true };
    if (conflictPolicy === "rename") {
      let targetPath = file.targetPath;
      const parsed = path.parse(targetPath);
      let attempt = 1;
      do {
        const suffix = attempt === 1 ? " (copy)" : ` (copy ${attempt})`;
        targetPath = path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
        attempt += 1;
      } while (fs.existsSync(targetPath));
      return { ...file, targetPath, overwrite: false };
    }
    return { ...file, overwrite: true };
  });
  const commits = [...ready];
  const fresh = ready.filter((file) => !file.skipped && !file.overwrite);
  const replacements = ready.filter((file) => !file.skipped && file.overwrite);
  if (process.platform === "win32") {
    // NTFS serial create latency is the physical bottleneck. Keep 64 paths in
    // flight so Node's fs workers and the drive queue overlap opens/writes;
    // wx retains no-clobber semantics for a concurrent creator.
    for (let index = 0; index < fresh.length; index += 64) {
      await Promise.all(fresh.slice(index, index + 64).map(async (file) => {
        try {
          await writeSmallFileBufferAsync(file.targetPath, file.bytes, {
            mtimeMs: file.mtimeMs,
          });
        } catch (error) {
          if (!file.optimisticOverwrite || error?.code !== "EEXIST") throw error;
          writeSmallFileBuffer(file.targetPath, file.bytes, {
            overwrite: true,
            mtimeMs: file.mtimeMs,
          });
        }
      }));
    }
  } else {
    for (const file of fresh) {
      try {
        writeSmallFileBuffer(file.targetPath, file.bytes, { mtimeMs: file.mtimeMs });
      } catch (error) {
        if (!file.optimisticOverwrite || error?.code !== "EEXIST") throw error;
        writeSmallFileBuffer(file.targetPath, file.bytes, {
          overwrite: true,
          mtimeMs: file.mtimeMs,
        });
      }
      if ((commits.indexOf(file) & 63) === 0) await yieldToEventLoop();
    }
  }
  for (const file of replacements) {
    writeSmallFileBuffer(file.targetPath, file.bytes, {
      overwrite: true,
      mtimeMs: file.mtimeMs,
    });
    if ((commits.indexOf(file) & 63) === 0) await yieldToEventLoop();
  }
  const skipped = commits.filter((file) => file.skipped);
  const transferred = commits.filter((file) => !file.skipped);
  return {
    files: normalizedFiles.length,
    transferredFiles: transferred.length,
    skippedFiles: skipped.length,
    transferredBytes: transferred.reduce((total, file) => total + file.size, 0),
    processedBytes: normalizedFiles.reduce((total, file) => total + file.size, 0),
    rootCompleted: skipped.length === 0,
  };
}

export async function ensureParentDirectory(targetPath) {
  const normalizedPath = normalizeUserPath(targetPath);
  await fsp.mkdir(path.dirname(normalizedPath), { recursive: true });
}

export async function ensureUniqueCopyPath(targetPath) {
  const normalizedPath = normalizeUserPath(targetPath);
  if (!await pathExists(normalizedPath)) {
    return normalizedPath;
  }

  const parsed = path.parse(normalizedPath);
  let attempt = 1;
  while (attempt < 10_000) {
    const suffix = attempt === 1 ? " (copy)" : ` (copy ${attempt})`;
    const candidate = path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
    if (!await pathExists(candidate)) {
      return candidate;
    }
    attempt += 1;
  }

  throw new Error(`Unable to create a unique destination for ${normalizedPath}`);
}

export async function createReadStreamForFile(targetPath) {
  const normalizedPath = normalizeUserPath(targetPath);
  const record = await getPathRecord(normalizedPath);
  if (record.kind !== "file") {
    throw new Error(`${normalizedPath} is not a file.`);
  }

  return fs.createReadStream(normalizedPath, {
    highWaterMark: WW_FILE_STREAM_HIGH_WATER_MARK,
  });
}

export async function writeReadableToFile(targetPath, readable, {
  overwrite = false,
  mtimeMs = null,
} = {}) {
  const normalizedPath = normalizeUserPath(targetPath);
  await ensureParentDirectory(normalizedPath);
  if (!overwrite && await pathExists(normalizedPath)) {
    const error = new Error(`Destination already exists: ${normalizedPath}`);
    error.code = "EEXIST";
    throw error;
  }

  const temporaryPath = path.join(
    path.dirname(normalizedPath),
    `.ww-upload-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );
  let committed = false;
  let displacedPath = "";

  try {
    const writable = fs.createWriteStream(temporaryPath, {
      flags: "wx",
      highWaterMark: WW_FILE_STREAM_HIGH_WATER_MARK,
    });
    await pipeline(readable, writable);

    if (Number.isFinite(Number(mtimeMs))) {
      const timestamp = Number(mtimeMs) / 1000;
      await fsp.utimes(temporaryPath, timestamp, timestamp).catch(() => {});
    }

    if (overwrite) {
      const existing = await fsp.lstat(normalizedPath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (existing?.isFile() && process.platform !== "win32") {
        // Atomic replacement must not silently remove executable bits from an
        // existing POSIX file when its bytes arrive from a Windows peer.
        await fsp.chmod(temporaryPath, existing.mode & 0o777);
      }
      if (existing?.isDirectory()) {
        displacedPath = path.join(
          path.dirname(normalizedPath),
          `.ww-displaced-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
        );
        await fsp.rename(normalizedPath, displacedPath);
      }
      await fsp.rename(temporaryPath, normalizedPath);
    } else {
      await fsp.link(temporaryPath, normalizedPath);
      await fsp.unlink(temporaryPath);
    }
    committed = true;
    if (displacedPath) {
      await fsp.rm(displacedPath, { recursive: true, force: true });
      displacedPath = "";
    }
  } finally {
    if (!committed) {
      await fsp.rm(temporaryPath, { force: true }).catch(() => {});
      if (displacedPath) {
        const destinationExists = await pathExists(normalizedPath);
        if (!destinationExists) {
          await fsp.rename(displacedPath, normalizedPath).catch(() => {});
        }
      }
    }
  }

  return getPathRecord(normalizedPath);
}
