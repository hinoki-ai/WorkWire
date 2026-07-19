import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  listTrash,
  listDirectory,
  normalizeUserPath,
  purgeExpiredTrash,
  resolveSandboxedPath,
  writeReadableToFile,
  renamePath,
  resolveRenamedPath,
  restoreTrashItem,
  trashPaths,
} from "./ww-fs.mjs";
import { createRemoteWwClient } from "./ww-client.mjs";
import {
  ensureWwPortalRoot,
  resolveWwPortalRoot,
  WW_PORTAL_DIRNAME,
} from "./ww-config-store.mjs";

export const WW_MACHINE_SCOPE = "machine";
export const WW_MACHINE_ROOT_PATH = "ww://machine-roots";

export function isWwMachineScope(scope) {
  return String(scope || "").trim() === WW_MACHINE_SCOPE;
}

export function createLocalEndpoint({
  name = os.hostname(),
  rootPath = resolveWwPortalRoot(),
  allowMachineScope = true,
} = {}) {
  const normalizedRootPath = normalizeUserPath(rootPath);
  let lastTrashPurgeAt = 0;

  async function listMachineRoots(options = {}) {
    if (process.platform !== "win32") {
      const rootPath = path.parse(os.homedir()).root || "/";
      const listing = await listDirectory(rootPath, {
        ...options,
        rootPath,
        protectedBasenames: [],
      });
      listing.rootPath = "";
      listing.scope = WW_MACHINE_SCOPE;
      return listing;
    }

    const roots = await Promise.all(
      Array.from({ length: 24 }, (_, index) => `${String.fromCharCode(67 + index)}:\\`)
        .map(async (drivePath) => {
          const stats = await fs.stat(drivePath).catch(() => null);
          if (!stats?.isDirectory()) {
            return null;
          }
          return {
            path: drivePath,
            name: drivePath.slice(0, 2),
            kind: "directory",
            size: 0,
            mtimeMs: Number(stats.mtimeMs) || 0,
          };
        }),
    );
    return {
      path: WW_MACHINE_ROOT_PATH,
      parentPath: null,
      rootPath: WW_MACHINE_ROOT_PATH,
      scope: WW_MACHINE_SCOPE,
      items: roots.filter(Boolean),
    };
  }

  function resolveMachinePath(requestedPath) {
    if (!allowMachineScope) {
      const error = new Error("Whole-machine browsing is not available over the WorkWire service.");
      error.code = "ERR_WW_MACHINE_SCOPE_UNAVAILABLE";
      throw error;
    }
    const raw = String(requestedPath ?? "").trim();
    return normalizeUserPath(raw || os.homedir());
  }

  async function ensureRoot() {
    await ensureWwPortalRoot(normalizedRootPath);
    const now = Date.now();
    if (now - lastTrashPurgeAt >= 60 * 60 * 1_000) {
      lastTrashPurgeAt = now;
      await purgeExpiredTrash(normalizedRootPath, { now }).catch(() => {});
    }
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
      if (isWwMachineScope(options?.scope)) {
        if (String(options?.path || "").trim() === WW_MACHINE_ROOT_PATH) {
          return listMachineRoots(options);
        }
        const machinePath = resolveMachinePath(options.path);
        const machineListing = await listDirectory(machinePath, {
          ...options,
          rootPath: machinePath,
          protectedBasenames: [],
        });
        machineListing.rootPath = "";
        machineListing.scope = WW_MACHINE_SCOPE;
        if (process.platform === "win32" && path.win32.dirname(machinePath) === machinePath) {
          machineListing.parentPath = WW_MACHINE_ROOT_PATH;
        }
        return machineListing;
      }

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
      if (isWwMachineScope(options?.scope)) {
        return getPathRecord(resolveMachinePath(options.path), options);
      }
      const targetPath = await resolvePortalPath(options.path);
      return getPathRecord(targetPath, options);
    },

    async buildManifest(options) {
      if (isWwMachineScope(options?.scope)) {
        const machinePath = resolveMachinePath(options.path);
        return buildTransferManifest(machinePath, {
          rootPath: machinePath,
          protectedBasenames: [],
        });
      }
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

    async trashPaths(options) {
      const targetPaths = await Promise.all(
        (Array.isArray(options.paths) ? options.paths : []).map((candidate) => resolvePortalPath(candidate)),
      );
      for (const targetPath of targetPaths) {
        assertMutableChildPath(targetPath, "delete");
      }
      return trashPaths(targetPaths, {
        rootPath: normalizedRootPath,
      });
    },

    async listTrash() {
      await ensureRoot();
      return listTrash(normalizedRootPath);
    },

    async restoreTrashItem(options) {
      await ensureRoot();
      return restoreTrashItem(normalizedRootPath, options?.id);
    },

    async createDownloadStream(targetPath, options = {}) {
      const safePath = isWwMachineScope(options?.scope)
        ? resolveMachinePath(targetPath)
        : await resolvePortalPath(targetPath);
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
