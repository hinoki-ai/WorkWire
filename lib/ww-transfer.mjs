import path from "node:path";
import { Transform, pipeline } from "node:stream";
import { normalizeConflictPolicy } from "./ww-config-store.mjs";

const WW_TRANSFER_PROGRESS_INTERVAL_MS = 100;
const WW_SMALL_FILE_PIPELINE = 32;
const WW_SMALL_FILE_PIPELINE_LIMIT = 256 * 1024;

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let next = 0;
  const workers = Math.min(Math.max(1, Number(limit) || 1), values.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await worker(values[index], index);
    }
  }));
  return results;
}

function createByteCountingStream(source, onBytes) {
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
  pipeline(source, counter, () => {});
  return counter;
}

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

  // Existing folders are containers, not all-or-nothing conflicts. Merge the
  // tree and apply the selected policy to each conflicting file so missing
  // children are always restored on a repeat transfer.
  if (manifest.root.kind === "directory" && existing.kind === "directory") {
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
  sourceScope = "",
  smallFileBatch = true,
  smallFileConcurrency = WW_SMALL_FILE_PIPELINE,
  onProgress = () => {},
} = {}) {
  if (!sourceEndpoint || !destinationEndpoint) {
    throw new Error("Both source and destination endpoints are required.");
  }

  const normalizedSourceScope = String(sourceScope || "").trim();
  if (move && normalizedSourceScope === "machine") {
    throw new Error("Machine explorer transfers are copy-only.");
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
    skippedLinks: 0,
  };

  for (const sourcePath of normalizedSourcePaths) {
    const manifest = await sourceEndpoint.buildManifest({
      path: sourcePath,
      ...(normalizedSourceScope ? { scope: normalizedSourceScope } : {}),
    });
    manifests.push(manifest);
    totals.files += manifest.totals.files;
    totals.directories += manifest.totals.directories;
    totals.bytes += manifest.totals.bytes;
    totals.skippedLinks += Number(manifest.totals.skippedLinks) || 0;
  }

  const result = {
    source: sourceInfo,
    destination: destinationInfo,
    moved: Boolean(move),
    totals,
    transferredFiles: 0,
    skippedFiles: 0,
    skippedLinks: 0,
    transferredBytes: 0,
    processedFiles: 0,
    processedBytes: 0,
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
    const manifestSkippedLinks = Array.isArray(manifest.skippedLinks)
      ? manifest.skippedLinks.length
      : Number(manifest.totals?.skippedLinks) || 0;
    let rootCompleted = manifestSkippedLinks === 0;

    if (manifest.root.kind === "symlink") {
      itemResult.skipped = true;
      itemResult.message = "Symbolic links are skipped for safety.";
      result.skippedLinks += Math.max(1, manifestSkippedLinks);
      result.items.push(itemResult);
      onProgress({
        stage: "skip-link",
        currentPath: manifest.root.path,
        currentName: manifest.root.name,
        item: itemResult,
        result,
      });
      continue;
    }

    result.skippedLinks += manifestSkippedLinks;

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
      result.processedFiles += manifest.totals.files;
      result.processedBytes += manifest.totals.bytes;
      onProgress({
        stage: "skip",
        currentPath: manifest.root.path,
        currentName: manifest.root.name,
        currentBytesTotal: manifest.totals.bytes,
        item: itemResult,
        result,
      });
      continue;
    }

    try {
      if (manifest.root.kind === "directory") {
        const useSmallFileBatch = (
          smallFileBatch
          && manifest.files.length >= 2
          && manifest.files.every((file) => file.size <= WW_SMALL_FILE_PIPELINE_LIMIT)
          && manifest.totals.bytes <= 16 * 1024 * 1024
          && typeof sourceEndpoint.createSmallFileBatchStream === "function"
          && typeof destinationEndpoint.uploadSmallFileBatchStream === "function"
        );

        if (useSmallFileBatch) {
          onProgress({
            stage: "transfer-batch",
            currentPath: manifest.root.path,
            currentName: manifest.root.name,
            currentBytesTotal: manifest.totals.bytes,
            targetPath: rootDestination.targetPath,
            result,
          });
          const batchSource = await sourceEndpoint.createSmallFileBatchStream({
            path: manifest.root.path,
            manifest,
            ...(normalizedSourceScope ? { scope: normalizedSourceScope } : {}),
          });
          const batch = await destinationEndpoint.uploadSmallFileBatchStream(
            rootDestination.targetPath,
            batchSource.stream,
            { conflictPolicy: normalizedConflictPolicy },
          );
          result.transferredFiles += batch.transferredFiles;
          result.skippedFiles += batch.skippedFiles;
          result.transferredBytes += batch.transferredBytes;
          result.processedFiles += batch.files;
          result.processedBytes += batch.processedBytes;
          rootCompleted &&= batch.rootCompleted;
          onProgress({
            stage: "batch-complete",
            currentPath: manifest.root.path,
            currentName: manifest.root.name,
            currentBytesTotal: manifest.totals.bytes,
            targetPath: rootDestination.targetPath,
            result,
          });
        } else {
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

          const plannedFiles = await mapLimit(
            manifest.files,
            smallFileConcurrency,
            async (file) => {
              if ([...skippedDirectoryPrefixes].some((prefix) => (
                file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`)
              ))) {
                return { file, skipped: true, reason: "directory" };
              }

              const fileTarget = await resolveFileTarget({
                destinationEndpoint,
                destinationPathApi,
                destinationRootPath: rootDestination.targetPath,
                relativePath: file.relativePath,
                prefixMappings,
                conflictPolicy: normalizedConflictPolicy,
              });

              return { file, ...fileTarget };
          },
          );

          for (const planned of plannedFiles.filter((item) => item.skipped)) {
            result.skippedFiles += 1;
            result.processedFiles += 1;
            result.processedBytes += planned.file.size;
            rootCompleted = false;
            onProgress({
              stage: "skip-file",
              currentPath: planned.file.path,
              currentName: planned.file.name,
              currentBytesTotal: planned.file.size,
              result,
            });
          }

          const transferFile = async ({ file, targetPath, overwrite }) => {

          onProgress({
            stage: "transfer-file",
            currentPath: file.path,
            currentName: file.name,
            currentBytesTotal: file.size,
            targetPath,
            result,
          });

          const download = await sourceEndpoint.createDownloadStream(
            file.path,
            normalizedSourceScope ? { scope: normalizedSourceScope } : {},
          );
          let bytesInFlight = 0;
          let lastProgressAt = 0;
          const countedStream = createByteCountingStream(download.stream, (delta) => {
            bytesInFlight += delta;
            const now = Date.now();
            if (lastProgressAt && now - lastProgressAt < WW_TRANSFER_PROGRESS_INTERVAL_MS) {
              return;
            }
            lastProgressAt = now;
            onProgress({
              stage: "transfer-progress",
              currentPath: file.path,
              currentName: file.name,
              currentBytesTotal: file.size,
              targetPath,
              bytesInFlight,
              result,
            });
          });
          await destinationEndpoint.uploadFileStream(targetPath, countedStream, {
            overwrite,
            mtimeMs: file.mtimeMs,
          });
          result.transferredFiles += 1;
          result.transferredBytes += bytesInFlight;
          result.processedFiles += 1;
          result.processedBytes += file.size;
          onProgress({
            stage: "file-complete",
            currentPath: file.path,
            currentName: file.name,
            currentBytesTotal: file.size,
            targetPath,
            result,
          });
          };

          const readyFiles = plannedFiles.filter((item) => !item.skipped);
          const smallFiles = readyFiles.filter(({ file }) => file.size <= WW_SMALL_FILE_PIPELINE_LIMIT);
          const largeFiles = readyFiles.filter(({ file }) => file.size > WW_SMALL_FILE_PIPELINE_LIMIT);
          await mapLimit(smallFiles, smallFileConcurrency, transferFile);
          for (const planned of largeFiles) await transferFile(planned);
        }
      } else {
        onProgress({
          stage: "transfer-file",
          currentPath: manifest.root.path,
          currentName: manifest.root.name,
          currentBytesTotal: manifest.root.size,
          targetPath: rootDestination.targetPath,
          result,
        });

        const download = await sourceEndpoint.createDownloadStream(
          manifest.root.path,
          normalizedSourceScope ? { scope: normalizedSourceScope } : {},
        );
        let bytesInFlight = 0;
        let lastProgressAt = 0;
        const countedStream = createByteCountingStream(download.stream, (delta) => {
          bytesInFlight += delta;
          const now = Date.now();
          if (lastProgressAt && now - lastProgressAt < WW_TRANSFER_PROGRESS_INTERVAL_MS) {
            return;
          }
          lastProgressAt = now;
          onProgress({
            stage: "transfer-progress",
            currentPath: manifest.root.path,
            currentName: manifest.root.name,
            currentBytesTotal: manifest.root.size,
            targetPath: rootDestination.targetPath,
            bytesInFlight,
            result,
          });
        });
        await destinationEndpoint.uploadFileStream(rootDestination.targetPath, countedStream, {
          overwrite: rootDestination.overwrite,
          mtimeMs: manifest.root.mtimeMs,
        });
        result.transferredFiles += 1;
        result.transferredBytes += bytesInFlight;
        result.processedFiles += 1;
        result.processedBytes += manifest.root.size;
        onProgress({
          stage: "file-complete",
          currentPath: manifest.root.path,
          currentName: manifest.root.name,
          currentBytesTotal: manifest.root.size,
          targetPath: rootDestination.targetPath,
          result,
        });
      }

      itemResult.ok = true;
      if (manifestSkippedLinks > 0) {
        itemResult.message = `${manifestSkippedLinks} symbolic link${manifestSkippedLinks === 1 ? " was" : "s were"} skipped for safety.`;
      }
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
