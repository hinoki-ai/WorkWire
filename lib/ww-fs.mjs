import fs from "node:fs";
import fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export const WW_INTERNAL_PORTAL_BASENAMES = Object.freeze([
  ".workwire",
  ".codex",
  ".git",
  "dist",
  "link",
  "node_modules",
  "runtime",
]);

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
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export async function listDirectory(directoryPath, {
  includeHidden = false,
  filter = "",
  rootPath = directoryPath,
  protectedBasenames = WW_INTERNAL_PORTAL_BASENAMES,
} = {}) {
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
  const items = [];

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

    const entryPath = path.join(normalizedPath, dirent.name);
    try {
      const entryStats = await fsp.lstat(entryPath);
      items.push(formatPathRecord(entryPath, entryStats, { name: dirent.name }));
    } catch (error) {
      items.push({
        path: entryPath,
        name: dirent.name,
        kind: "error",
        size: 0,
        mtimeMs: 0,
        error: serializeFsError(error),
      });
    }
  }

  items.sort(compareDirectoryEntries);
  const parentPath = path.dirname(normalizedPath);

  return {
    path: normalizedPath,
    parentPath: parentPath === normalizedPath ? null : parentPath,
    items,
  };
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

  return fs.createReadStream(normalizedPath);
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
