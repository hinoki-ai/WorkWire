import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRecoveryError, RECOVERY_ERROR_CODES } from "./ww-recovery-protocol.mjs";
import { renameRecoveryFile } from "./ww-recovery-atomic.mjs";

async function sha256File(filename, fsSyncImpl = fsSync) {
  const hash = createHash("sha256");
  for await (const chunk of fsSyncImpl.createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

export function createRecoveryArtifacts({
  client,
  fsImpl = fs,
  fsSyncImpl = fsSync,
} = {}) {
  if (!client) throw new TypeError("Recovery artifact transport requires a controller client.");

  async function upload({
    path: sourcePath,
    artifactId,
    filename,
    contentType = "application/octet-stream",
    kind = "generic",
    caseId = "",
    jobId = "",
    stepId = "",
    agentId = "",
    offset,
    size,
    complete = true,
    onProgress,
    signal,
    metadata = {},
  } = {}) {
    const resolvedSource = path.resolve(String(sourcePath || ""));
    const stats = await fsImpl.stat(resolvedSource);
    if (!stats.isFile() && !stats.isBlockDevice()) {
      throw createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, `Artifact source ${resolvedSource} is not a file or block device.`);
    }
    const explicitSize = Number(size);
    if (stats.isBlockDevice() && (!Number.isSafeInteger(explicitSize) || explicitSize <= 0)) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.BAD_REQUEST,
        `Block-device artifact upload requires an explicit positive size for ${resolvedSource}.`,
      );
    }
    const artifact = artifactId
      ? { id: artifactId }
      : await client.createArtifact({
        caseId,
        jobId,
        stepId,
        agentId,
        kind,
        filename: filename || path.basename(resolvedSource),
        contentType,
        metadata: {
          ...metadata,
          sourcePath: resolvedSource,
          sparseMayBeExpanded: stats.isFile() && Number(stats.blocks) * 512 < stats.size,
          sourceSize: stats.isBlockDevice() ? explicitSize : stats.size,
          sourceIsBlockDevice: stats.isBlockDevice(),
        },
      });
    return client.uploadArtifact(artifact, resolvedSource, {
      offset,
      ...(stats.isBlockDevice() ? { size: explicitSize } : size === undefined ? {} : { size: explicitSize }),
      complete,
      onProgress,
      signal,
      timeoutMs: 0,
    });
  }

  async function download({
    artifactId,
    path: destinationPath,
    hash,
    mode,
    mtime,
    resume = true,
    force = false,
    onProgress,
    signal,
  } = {}) {
    const id = String(artifactId || "");
    const destination = path.resolve(String(destinationPath || ""));
    const partial = `${destination}.partial`;
    await fsImpl.mkdir(path.dirname(destination), { recursive: true });
    const destinationStats = await fsImpl.stat(destination).catch(() => null);
    if (destinationStats?.isBlockDevice()) {
      if (force !== true) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.BAD_REQUEST,
          `Writing artifact ${id} directly to block device ${destination} requires force: true.`,
        );
      }
      const head = await client.headArtifact(id, { timeoutMs: 0, signal });
      const transport = await client.downloadArtifact(id, { timeoutMs: 0, signal });
      const digest = createHash("sha256");
      let bytes = 0;
      const hashingStream = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          digest.update(chunk);
          onProgress?.({ artifactId: id, direction: "download", bytes, total: head.size });
          callback(null, chunk);
        },
      });
      await pipeline(transport.stream, hashingStream, fsSyncImpl.createWriteStream(destination, { flags: "w" }));
      const actualHash = `sha256:${digest.digest("hex")}`;
      const expectedHash = hash || head.hash;
      if (expectedHash && actualHash !== expectedHash && actualHash.slice("sha256:".length) !== expectedHash) {
        const error = createRecoveryError(
          RECOVERY_ERROR_CODES.ARTIFACT_HASH,
          `Block-device artifact ${id} hash mismatch while writing ${destination}.`,
          { expectedHash, actualHash },
        );
        error.actualHash = actualHash;
        throw error;
      }
      return { artifactId: id, path: destination, bytes, hash: expectedHash || actualHash, complete: true, blockDevice: true };
    }
    let offset = 0;
    const partialStats = resume ? await fsImpl.stat(partial).catch(() => null) : null;
    if (partialStats) offset = partialStats.size;
    const head = await client.headArtifact(id, { timeoutMs: 0, signal });
    if (offset > head.size) {
      await fsImpl.truncate(partial, 0);
      offset = 0;
    }
    const expectedHash = hash || head.hash;
    if (partialStats && offset === head.size && expectedHash) {
      const existingHash = await sha256File(partial, fsSyncImpl);
      if (existingHash === expectedHash || existingHash.slice("sha256:".length) === expectedHash) {
        await renameRecoveryFile(fsImpl, partial, destination);
        return { artifactId: id, path: destination, bytes: offset, hash: expectedHash, complete: true, resumed: true };
      }
      await fsImpl.truncate(partial, 0);
      offset = 0;
    }
    const transport = await client.downloadArtifact(id, {
      destinationPath: destination,
      offset,
      timeoutMs: 0,
      signal,
      onProgress,
    });
    if (expectedHash) {
      const actualHash = await sha256File(destination, fsSyncImpl);
      if (actualHash !== expectedHash && actualHash.slice("sha256:".length) !== expectedHash) {
        await renameRecoveryFile(fsImpl, destination, partial).catch(() => {});
        const error = createRecoveryError(
          RECOVERY_ERROR_CODES.ARTIFACT_HASH,
          `Downloaded artifact ${id} hash mismatch.`,
          { expectedHash, actualHash },
        );
        error.actualHash = actualHash;
        throw error;
      }
    }
    if (mode !== undefined) await fsImpl.chmod(destination, Number(mode));
    if (mtime !== undefined) {
      const date = new Date(mtime);
      await fsImpl.utimes(destination, date, date);
    }
    return {
      ...transport,
      artifactId: id,
      path: destination,
      hash: expectedHash || null,
      complete: true,
    };
  }

  return { upload, download, sha256File: (filename) => sha256File(filename, fsSyncImpl) };
}

export { sha256File };
