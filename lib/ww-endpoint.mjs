import os from "node:os";
import {
  assertPortalPathAllowed,
  assertPortalPathResolvedInsideRoot,
  buildTransferManifest,
  copyLocalPath,
  createDirectory,
  createFile,
  createReadStreamForFile,
  deletePaths,
  getPathRecord,
  isPathInsideRoot,
  listDirectory,
  normalizeUserPath,
  resolveSandboxedPath,
  writeReadableToFile,
  renamePath,
  resolveRenamedPath,
} from "./ww-fs.mjs";
import { createRemoteWwClient } from "./ww-client.mjs";
import {
  ensureWwPortalRoot,
  resolveWwPortalRoot,
  WW_PORTAL_DIRNAME,
} from "./ww-config-store.mjs";

export function createLocalEndpoint({
  name = os.hostname(),
  rootPath = resolveWwPortalRoot(),
} = {}) {
  const normalizedRootPath = normalizeUserPath(rootPath);

  async function ensureRoot() {
    await ensureWwPortalRoot(normalizedRootPath);
    return normalizedRootPath;
  }

  async function resolvePortalPath(requestedPath, fallbackPath = normalizedRootPath) {
    await ensureRoot();
    const resolvedPath = resolveSandboxedPath(requestedPath, {
      rootPath: normalizedRootPath,
      defaultPath: fallbackPath,
    });
    const allowedPath = assertPortalPathAllowed(resolvedPath, {
      rootPath: normalizedRootPath,
    });
    return assertPortalPathResolvedInsideRoot(allowedPath, {
      rootPath: normalizedRootPath,
    });
  }

  function assertMutableChildPath(targetPath, action) {
    if (targetPath === normalizedRootPath) {
      const error = new Error(`WW cannot ${action} the portal root.`);
      error.code = "ERR_WW_PORTAL_ROOT_MUTATION";
      throw error;
    }
    return targetPath;
  }

  return {
    type: "local",
    label: name,

    async getInfo() {
      await ensureRoot();
      return {
        name,
        hostname: os.hostname(),
        platform: process.platform,
        homeDir: os.homedir(),
        cwd: process.cwd(),
        port: null,
        urls: [],
        portalName: WW_PORTAL_DIRNAME,
        rootPath: normalizedRootPath,
      };
    },

    async listDirectory(options) {
      const targetPath = await resolvePortalPath(options.path);
      const listing = await listDirectory(targetPath, {
        ...options,
        rootPath: normalizedRootPath,
      });
      if (!listing.parentPath || !isPathInsideRoot(listing.parentPath, normalizedRootPath)) {
        listing.parentPath = null;
      } else if (listing.path === normalizedRootPath) {
        listing.parentPath = null;
      }
      listing.rootPath = normalizedRootPath;
      return listing;
    },

    async stat(options) {
      const targetPath = await resolvePortalPath(options.path);
      return getPathRecord(targetPath, options);
    },

    async buildManifest(options) {
      const targetPath = await resolvePortalPath(options.path);
      return buildTransferManifest(targetPath, {
        rootPath: normalizedRootPath,
      });
    },

    async createDirectory(options) {
      const targetPath = await resolvePortalPath(options.path);
      return createDirectory(targetPath);
    },

    async createFile(options) {
      const targetPath = await resolvePortalPath(options.path);
      return createFile(targetPath, options);
    },

    async rename(options) {
      const targetPath = await resolvePortalPath(options.path);
      assertMutableChildPath(targetPath, "rename");
      const destinationPath = await resolvePortalPath(resolveRenamedPath(targetPath, options.nextName));
      assertMutableChildPath(destinationPath, "rename to");
      return renamePath(targetPath, options.nextName);
    },

    async copyPath(options) {
      const sourcePath = await resolvePortalPath(options.sourcePath);
      const destinationPath = await resolvePortalPath(options.destinationPath);
      assertMutableChildPath(sourcePath, "copy");
      assertMutableChildPath(destinationPath, "copy to");
      return copyLocalPath(sourcePath, destinationPath, {
        overwrite: Boolean(options.overwrite),
      });
    },

    async deletePaths(options) {
      const targetPaths = await Promise.all(
        (Array.isArray(options.paths) ? options.paths : []).map((candidate) => resolvePortalPath(candidate)),
      );
      for (const targetPath of targetPaths) {
        assertMutableChildPath(targetPath, "delete");
      }
      return deletePaths(targetPaths);
    },

    async createDownloadStream(targetPath) {
      const safePath = await resolvePortalPath(targetPath);
      const record = await getPathRecord(safePath);
      return {
        stream: await createReadStreamForFile(safePath),
        mtimeMs: record.mtimeMs,
        name: record.name,
      };
    },

    async uploadFileStream(targetPath, readable, options = {}) {
      const safePath = await resolvePortalPath(targetPath);
      return writeReadableToFile(safePath, readable, options);
    },
  };
}

export function createRemoteEndpoint(peer = {}) {
  const client = createRemoteWwClient(peer);
  return {
    type: "remote",
    label: peer.label || peer.host || "remote",
    ...client,
  };
}
