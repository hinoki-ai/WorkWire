import {
  WW_APP_VERSION,
  WW_BUILD_HASH,
  WW_RELEASE_INFO,
  buildWwReleaseInfo,
} from "./ww-release.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WW_UPDATE_PROTOCOL_VERSION = 1;
export const WW_RELEASE_ACTIVATION_POLL_MS = 2_000;
export const WW_RELEASE_ACTIVATION_SETTLE_MS = 15_000;
export const WW_UPDATE_SOURCE_HASH_VERSION = "ww-update-source-v1";
const WW_UPDATE_BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WW_UPDATE_SOURCE_SPECS = Object.freeze([
  "package.json",
  "electron-builder.linux.json",
  "ww.mjs",
  "README.md",
  "desktop",
  "docs",
  "lib",
  "scripts",
]);

function normalizePositiveInteger(value, fallback = null) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

async function collectWwUpdateSourceFiles(baseDir = WW_UPDATE_BASE_DIR) {
  const files = [];

  function includeDirectoryEntry(relativeDirectory, entry) {
    const normalizedDirectory = relativeDirectory.split(path.sep).join("/");
    if (normalizedDirectory !== "lib") {
      return true;
    }
    if (entry.isDirectory()) {
      return entry.name === "recovery";
    }
    return entry.name === "electron-app-argv.mjs"
      || /^ww.*\.mjs$/u.test(entry.name);
  }

  async function append(relativePath) {
    const absolutePath = path.join(baseDir, relativePath);
    let stats;
    try {
      stats = await fs.stat(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (stats.isDirectory()) {
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (!includeDirectoryEntry(relativePath, entry)) {
          continue;
        }
        await append(path.join(relativePath, entry.name));
      }
      return;
    }
    if (stats.isFile()) {
      files.push(relativePath.split(path.sep).join("/"));
    }
  }

  for (const relativePath of WW_UPDATE_SOURCE_SPECS) {
    await append(relativePath);
  }
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

export async function buildWwUpdateSourceInfo({
  baseDir = WW_UPDATE_BASE_DIR,
} = {}) {
  const files = await collectWwUpdateSourceFiles(baseDir);
  const hash = createHash("sha256");
  hash.update(WW_UPDATE_SOURCE_HASH_VERSION);
  hash.update("\0");
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(path.join(baseDir, relativePath)));
    hash.update("\0");
  }
  return {
    hashVersion: WW_UPDATE_SOURCE_HASH_VERSION,
    hash: hash.digest("hex"),
    files,
  };
}

export const WW_UPDATE_SOURCE_INFO = Array.isArray(WW_RELEASE_INFO.files) && WW_RELEASE_INFO.files.length > 0
  ? await buildWwUpdateSourceInfo()
  : {
      hashVersion: WW_UPDATE_SOURCE_HASH_VERSION,
      hash: WW_BUILD_HASH,
      files: [],
    };

export function readWwUpdateProtocolVersion(source = {}, fallback = null) {
  const advertised = source?.capabilities?.updateProtocol
    ?? source?.versions?.update
    ?? source?.updateProtocol
    ?? source?.updateProtocolVersion;
  const normalized = normalizePositiveInteger(advertised, null);
  if (normalized != null) {
    return normalized;
  }

  // WorkWire protocol 1 already exposes the authenticated filesystem routes
  // used by the updater. This one-way fallback lets the permanent updater be
  // introduced without marooning the last pre-updater release.
  const legacyProtocol = normalizePositiveInteger(
    source?.versions?.protocol ?? source?.protocolVersion ?? source?.protocol,
    null,
  );
  return legacyProtocol === 1 ? 1 : fallback;
}

export function assessWwUpdateCompatibility({
  remote = {},
  peerLabel = "the other PC",
  localVersion = WW_UPDATE_PROTOCOL_VERSION,
} = {}) {
  const expectedVersion = normalizePositiveInteger(localVersion, WW_UPDATE_PROTOCOL_VERSION);
  const remoteVersion = readWwUpdateProtocolVersion(remote, null);
  const label = String(peerLabel || "the other PC").trim() || "the other PC";

  if (remoteVersion == null) {
    return {
      ok: false,
      code: "ERR_WW_UPDATE_PROTOCOL_UNKNOWN",
      message: `WorkWire cannot safely update ${label} because it does not advertise a compatible update channel.`,
      localVersion: expectedVersion,
      remoteVersion: null,
    };
  }

  if (remoteVersion !== expectedVersion) {
    return {
      ok: false,
      code: "ERR_WW_UPDATE_PROTOCOL_MISMATCH",
      message: `WorkWire cannot safely update ${label}: update protocol ${remoteVersion} does not match ${expectedVersion}.`,
      localVersion: expectedVersion,
      remoteVersion,
    };
  }

  return {
    ok: true,
    code: null,
    message: "",
    localVersion: expectedVersion,
    remoteVersion,
  };
}

export function createWwUpdateCompatibilityError(options = {}) {
  const compatibility = assessWwUpdateCompatibility(options);
  if (compatibility.ok) {
    return null;
  }
  const error = new Error(compatibility.message);
  error.code = compatibility.code;
  error.status = 409;
  error.compatibility = compatibility;
  return error;
}

export async function readCurrentWwReleaseInfo({
  buildReleaseInfoImpl = buildWwReleaseInfo,
  buildUpdateSourceInfoImpl = buildWwUpdateSourceInfo,
} = {}) {
  if (!Array.isArray(WW_RELEASE_INFO.files) || WW_RELEASE_INFO.files.length === 0) {
    return {
      ...WW_RELEASE_INFO,
      updateHash: WW_UPDATE_SOURCE_INFO.hash,
      updateHashVersion: WW_UPDATE_SOURCE_INFO.hashVersion,
    };
  }
  const [releaseInfo, updateSourceInfo] = await Promise.all([
    buildReleaseInfoImpl(),
    buildUpdateSourceInfoImpl(),
  ]);
  return {
    ...releaseInfo,
    updateHash: updateSourceInfo.hash,
    updateHashVersion: updateSourceInfo.hashVersion,
  };
}

export function buildWwUpdateStatus(releaseInfo = WW_RELEASE_INFO) {
  return {
    protocol: WW_UPDATE_PROTOCOL_VERSION,
    running: {
      appVersion: WW_APP_VERSION,
      releaseHash: WW_BUILD_HASH,
      hash: WW_UPDATE_SOURCE_INFO.hash,
      hashVersion: WW_UPDATE_SOURCE_INFO.hashVersion,
    },
    source: {
      appVersion: String(releaseInfo?.version || WW_APP_VERSION),
      releaseHash: String(releaseInfo?.hash || WW_BUILD_HASH),
      hash: String(releaseInfo?.updateHash || releaseInfo?.hash || WW_UPDATE_SOURCE_INFO.hash),
      hashVersion: String(releaseInfo?.updateHashVersion || WW_UPDATE_SOURCE_INFO.hashVersion),
    },
  };
}

export function createWwReleaseActivator({
  runningHash = WW_BUILD_HASH,
  pollIntervalMs = WW_RELEASE_ACTIVATION_POLL_MS,
  settleMs = WW_RELEASE_ACTIVATION_SETTLE_MS,
  readReleaseInfoImpl = readCurrentWwReleaseInfo,
  isReadyToActivate = async () => true,
  onActivationRequired = async () => {},
  nowImpl = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  log = () => {},
} = {}) {
  const normalizedRunningHash = String(runningHash || "").trim();
  const normalizedPollIntervalMs = Math.max(250, Number(pollIntervalMs) || WW_RELEASE_ACTIVATION_POLL_MS);
  const normalizedSettleMs = Math.max(0, Number(settleMs) || 0);
  let timer = null;
  let checking = false;
  let stopped = false;
  let activated = false;
  let candidate = null;
  let candidateSince = 0;
  let lastError = "";

  function resetCandidate() {
    candidate = null;
    candidateSince = 0;
  }

  async function checkNow() {
    if (stopped || checking || activated) {
      return false;
    }
    checking = true;
    try {
      const releaseInfo = await readReleaseInfoImpl();
      const nextHash = String(releaseInfo?.hash || "").trim();
      if (!nextHash || nextHash === normalizedRunningHash) {
        resetCandidate();
        lastError = "";
        return false;
      }

      const now = Number(nowImpl()) || Date.now();
      if (!candidate || candidate.hash !== nextHash) {
        candidate = releaseInfo;
        candidateSince = now;
        lastError = "";
        log(`WorkWire staged source ${String(releaseInfo?.version || nextHash)}; waiting for both PCs to settle.`);
        return false;
      }

      if (now - candidateSince < normalizedSettleMs) {
        return false;
      }

      const ready = await isReadyToActivate(candidate);
      if (!ready) {
        return false;
      }

      activated = true;
      await onActivationRequired(candidate);
      return true;
    } catch (error) {
      const message = String(error?.message || "Unable to check the staged WorkWire release.");
      if (message !== lastError) {
        log(`WorkWire auto-update is waiting: ${message}`);
        lastError = message;
      }
      return false;
    } finally {
      checking = false;
    }
  }

  return {
    start() {
      stopped = false;
      if (!timer && !activated) {
        timer = setIntervalImpl(() => {
          void checkNow();
        }, normalizedPollIntervalMs);
        timer?.unref?.();
        void checkNow();
      }
      return this;
    },
    stop() {
      stopped = true;
      if (timer) {
        clearIntervalImpl(timer);
        timer = null;
      }
    },
    checkNow,
    getStatus() {
      return {
        runningHash: normalizedRunningHash,
        candidateHash: String(candidate?.hash || ""),
        candidateVersion: String(candidate?.version || ""),
        candidateSince,
        activated,
        error: lastError,
      };
    },
  };
}
