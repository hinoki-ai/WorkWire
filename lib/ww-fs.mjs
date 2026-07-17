import fs from "node:fs";
import fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
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
  if (rootRecord.kind === "symlink") {
    throw new Error(`Symlink transfers are not supported: ${normalizedTargetPath}`);
  }
  if (rootRecord.kind !== "directory" && rootRecord.kind !== "file") {
    throw new Error(`Unsupported transfer source: ${normalizedTargetPath}`);
  }

  const manifest = {
    root: rootRecord,
    directories: [],
    files: [],
    totals: {
      files: 0,
      directories: 0,
      bytes: 0,
    },
  };

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

    const entries = await fsp.readdir(current.absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }));

    for (const entry of entries) {
      if (isWwTemporaryBasename(entry.name)) {
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
      const record = await getPathRecord(absolutePath);

      if (record.kind === "symlink") {
        throw new Error(`Symlink transfers are not supported: ${absolutePath}`);
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
