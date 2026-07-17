import path from "node:path";
import { normalizeConflictPolicy } from "./ww-config-store.mjs";

function getPathApi(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function splitRelativePath(relativePath = "") {
  return String(relativePath || "")
    .split("/")
    .filter((segment) => segment.length > 0);
}

function joinRelativePath(...segments) {
  return segments
    .flatMap((segment) => splitRelativePath(segment))
    .join("/");
}

function replaceRelativePrefix(relativePath = "", mappings = []) {
  const normalized = String(relativePath || "");
  for (const mapping of mappings) {
    if (normalized === mapping.original) {
      return mapping.replacement;
    }
    if (normalized.startsWith(`${mapping.original}/`)) {
      return `${mapping.replacement}${normalized.slice(mapping.original.length)}`;
    }
  }
  return normalized;
}

function joinDestinationPath(pathApi, basePath, relativePath = "") {
  const segments = splitRelativePath(relativePath);
  if (segments.length === 0) {
    return basePath;
  }
  return pathApi.join(basePath, ...segments);
}

async function statIfExists(endpoint, targetPath) {
  return endpoint.stat({
    path: targetPath,
    allowMissing: true,
  });
}

async function ensureUniqueTargetPath(endpoint, pathApi, targetPath) {
  const parsed = pathApi.parse(targetPath);
  let attempt = 1;
  while (attempt < 10_000) {
    const suffix = attempt === 1 ? " (copy)" : ` (copy ${attempt})`;
    const candidate = pathApi.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
    const existing = await statIfExists(endpoint, candidate);
    if (!existing) {
      return candidate;
    }
    attempt += 1;
  }
  throw new Error(`Unable to create a unique destination for ${targetPath}`);
}

async function resolveRootDestination({
  manifest,
  destinationEndpoint,
  destinationDir,
  destinationPathApi,
  conflictPolicy,
}) {
  const sourceName = manifest.root.name;
  const initialPath = joinDestinationPath(destinationPathApi, destinationDir, sourceName);
  const existing = await statIfExists(destinationEndpoint, initialPath);
  if (!existing) {
    return {
      action: "copy",
      targetPath: initialPath,
      overwrite: false,
    };
  }

  if (conflictPolicy === "skip") {
    return {
      action: "skip",
      targetPath: initialPath,
      reason: `${sourceName} already exists on the destination.`,
    };
  }

  if (conflictPolicy === "rename") {
    return {
      action: "copy",
      targetPath: await ensureUniqueTargetPath(destinationEndpoint, destinationPathApi, initialPath),
      overwrite: false,
    };
  }

  if (manifest.root.kind === "directory" && existing.kind === "directory") {
    return {
      action: "copy",
      targetPath: initialPath,
      overwrite: false,
    };
  }

  if (manifest.root.kind === "file" && existing.kind === "file") {
    return {
      action: "copy",
      targetPath: initialPath,
      overwrite: true,
    };
  }

  await destinationEndpoint.deletePaths({
    paths: [initialPath],
  });
  return {
    action: "copy",
    targetPath: initialPath,
    overwrite: false,
  };
}

async function ensureDirectoryTarget({
  destinationEndpoint,
  destinationPathApi,
  destinationRootPath,
  originalRelativePath,
  prefixMappings,
  conflictPolicy,
}) {
  const mappedParentRelative = replaceRelativePrefix(
    destinationPathApi.dirname(originalRelativePath).replaceAll("\\", "/") === "."
      ? ""
      : destinationPathApi.dirname(originalRelativePath).replaceAll("\\", "/"),
    prefixMappings,
  );
  const originalName = splitRelativePath(originalRelativePath).at(-1) || "";
  const mappedRelativePath = joinRelativePath(mappedParentRelative, originalName);
  let targetPath = joinDestinationPath(destinationPathApi, destinationRootPath, mappedRelativePath);
  const existing = await statIfExists(destinationEndpoint, targetPath);

  if (!existing) {
    await destinationEndpoint.createDirectory({ path: targetPath });
    return {
      skipped: false,
      finalRelativePath: mappedRelativePath,
      targetPath,
    };
  }

  if (existing.kind === "directory") {
    return {
      skipped: false,
      finalRelativePath: mappedRelativePath,
      targetPath,
    };
  }

  if (conflictPolicy === "skip") {
    return {
      skipped: true,
      finalRelativePath: mappedRelativePath,
      targetPath,
    };
  }

  if (conflictPolicy === "rename") {
    targetPath = await ensureUniqueTargetPath(destinationEndpoint, destinationPathApi, targetPath);
    await destinationEndpoint.createDirectory({ path: targetPath });
    const renamedRelativePath = joinRelativePath(
      mappedParentRelative,
      destinationPathApi.basename(targetPath).replaceAll("\\", "/"),
    );
    prefixMappings.unshift({
      original: originalRelativePath,
      replacement: renamedRelativePath,
    });
    return {
      skipped: false,
      finalRelativePath: renamedRelativePath,
      targetPath,
    };
  }

  await destinationEndpoint.deletePaths({
    paths: [targetPath],
  });
  await destinationEndpoint.createDirectory({ path: targetPath });
  return {
    skipped: false,
    finalRelativePath: mappedRelativePath,
    targetPath,
  };
}

async function resolveFileTarget({
  destinationEndpoint,
  destinationPathApi,
  destinationRootPath,
  relativePath,
  prefixMappings,
  conflictPolicy,
}) {
  const mappedRelativePath = replaceRelativePrefix(relativePath, prefixMappings);
  let targetPath = joinDestinationPath(destinationPathApi, destinationRootPath, mappedRelativePath);
  const existing = await statIfExists(destinationEndpoint, targetPath);
  if (!existing) {
    return {
      skipped: false,
      targetPath,
      overwrite: false,
    };
  }

  if (conflictPolicy === "skip") {
    return {
      skipped: true,
      targetPath,
    };
  }

  if (conflictPolicy === "rename") {
    return {
      skipped: false,
      targetPath: await ensureUniqueTargetPath(destinationEndpoint, destinationPathApi, targetPath),
      overwrite: false,
    };
  }

  if (existing.kind === "file") {
    return {
      skipped: false,
      targetPath,
      overwrite: true,
    };
  }

  await destinationEndpoint.deletePaths({
    paths: [targetPath],
  });
  return {
    skipped: false,
    targetPath,
    overwrite: false,
  };
}

export async function transferSelections({
  sourceEndpoint,
  destinationEndpoint,
  sourcePaths = [],
  destinationDir,
  conflictPolicy = "rename",
  move = false,
  onProgress = () => {},
} = {}) {
  if (!sourceEndpoint || !destinationEndpoint) {
    throw new Error("Both source and destination endpoints are required.");
  }

  const normalizedConflictPolicy = normalizeConflictPolicy(conflictPolicy);
  const normalizedSourcePaths = Array.isArray(sourcePaths)
    ? sourcePaths.map((value) => String(value ?? "")).filter((value) => value.length > 0)
    : [];
  if (normalizedSourcePaths.length === 0) {
    throw new Error("Select at least one item to transfer.");
  }
  if (!String(destinationDir || "").trim()) {
    throw new Error("A destination directory is required.");
  }

  const [sourceInfo, destinationInfo] = await Promise.all([
    sourceEndpoint.getInfo(),
    destinationEndpoint.getInfo(),
  ]);
  const destinationPathApi = getPathApi(destinationInfo?.platform);

  const manifests = [];
  const totals = {
    files: 0,
    directories: 0,
    bytes: 0,
  };

  for (const sourcePath of normalizedSourcePaths) {
    const manifest = await sourceEndpoint.buildManifest({ path: sourcePath });
    manifests.push(manifest);
    totals.files += manifest.totals.files;
    totals.directories += manifest.totals.directories;
    totals.bytes += manifest.totals.bytes;
  }

  const result = {
    source: sourceInfo,
    destination: destinationInfo,
    moved: Boolean(move),
    totals,
    transferredFiles: 0,
    skippedFiles: 0,
    transferredBytes: 0,
    items: [],
  };

  onProgress({
    stage: "planning",
    totals,
    result,
  });

  for (const manifest of manifests) {
    const itemResult = {
      sourcePath: manifest.root.path,
      kind: manifest.root.kind,
      targetPath: "",
      ok: false,
      skipped: false,
      deletedSource: false,
      message: "",
    };
    const prefixMappings = [];
    let rootCompleted = true;

    const rootDestination = await resolveRootDestination({
      manifest,
      destinationEndpoint,
      destinationDir,
      destinationPathApi,
      conflictPolicy: normalizedConflictPolicy,
    });

    itemResult.targetPath = rootDestination.targetPath;
    if (rootDestination.action === "skip") {
      itemResult.skipped = true;
      itemResult.message = rootDestination.reason;
      result.items.push(itemResult);
      result.skippedFiles += manifest.totals.files;
      onProgress({
        stage: "skip",
        item: itemResult,
        result,
      });
      continue;
    }

    try {
      if (manifest.root.kind === "directory") {
        await destinationEndpoint.createDirectory({
          path: rootDestination.targetPath,
        });

        const skippedDirectoryPrefixes = new Set();
        for (const directory of manifest.directories.filter((entry) => entry.relativePath)) {
          const directoryResult = await ensureDirectoryTarget({
            destinationEndpoint,
            destinationPathApi,
            destinationRootPath: rootDestination.targetPath,
            originalRelativePath: directory.relativePath,
            prefixMappings,
            conflictPolicy: normalizedConflictPolicy,
          });
          if (directoryResult.skipped) {
            skippedDirectoryPrefixes.add(directory.relativePath);
            rootCompleted = false;
          }
        }

        for (const file of manifest.files) {
          if ([...skippedDirectoryPrefixes].some((prefix) => (
            file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`)
          ))) {
            result.skippedFiles += 1;
            rootCompleted = false;
            continue;
          }

          const fileTarget = await resolveFileTarget({
            destinationEndpoint,
            destinationPathApi,
            destinationRootPath: rootDestination.targetPath,
            relativePath: file.relativePath,
            prefixMappings,
            conflictPolicy: normalizedConflictPolicy,
          });

          if (fileTarget.skipped) {
            result.skippedFiles += 1;
            rootCompleted = false;
            continue;
          }

          onProgress({
            stage: "transfer-file",
            currentPath: file.path,
            targetPath: fileTarget.targetPath,
            result,
          });

          const download = await sourceEndpoint.createDownloadStream(file.path);
          await destinationEndpoint.uploadFileStream(fileTarget.targetPath, download.stream, {
            overwrite: fileTarget.overwrite,
            mtimeMs: file.mtimeMs,
          });
          result.transferredFiles += 1;
          result.transferredBytes += file.size;
          onProgress({
            stage: "file-complete",
            currentPath: file.path,
            targetPath: fileTarget.targetPath,
            result,
          });
        }
      } else {
        onProgress({
          stage: "transfer-file",
          currentPath: manifest.root.path,
          targetPath: rootDestination.targetPath,
          result,
        });

        const download = await sourceEndpoint.createDownloadStream(manifest.root.path);
        await destinationEndpoint.uploadFileStream(rootDestination.targetPath, download.stream, {
          overwrite: rootDestination.overwrite,
          mtimeMs: manifest.root.mtimeMs,
        });
        result.transferredFiles += 1;
        result.transferredBytes += manifest.root.size;
        onProgress({
          stage: "file-complete",
          currentPath: manifest.root.path,
          targetPath: rootDestination.targetPath,
          result,
        });
      }

      itemResult.ok = true;
      if (move && rootCompleted) {
        const deleteResults = await sourceEndpoint.deletePaths({
          paths: [manifest.root.path],
        });
        itemResult.deletedSource = deleteResults.every((entry) => entry.ok);
        if (!itemResult.deletedSource) {
          const failedDelete = deleteResults.find((entry) => !entry.ok);
          const error = new Error(
            failedDelete?.error?.message
              || `The copy completed, but WW could not delete ${manifest.root.path} from the source.`,
          );
          error.code = "ERR_WW_MOVE_SOURCE_DELETE";
          throw error;
        }
      }
      result.items.push(itemResult);
    } catch (error) {
      itemResult.ok = false;
      itemResult.message = String(error?.message || "Transfer failed.");
      result.items.push(itemResult);
      onProgress({
        stage: "error",
        item: itemResult,
        error,
        result,
      });
      throw error;
    }
  }

  onProgress({
    stage: "complete",
    result,
  });
  return result;
}
