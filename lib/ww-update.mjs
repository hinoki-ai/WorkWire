import {
  WW_APP_VERSION,
  WW_BUILD_HASH,
  WW_RELEASE_INFO,
  buildWwReleaseInfo,
  collectWwReleaseSourceFiles,
} from "./ww-release.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WW_UPDATE_PROTOCOL_VERSION = 1;
export const WW_RELEASE_ACTIVATION_POLL_MS = 2_000;
export const WW_RELEASE_ACTIVATION_SETTLE_MS = 15_000;
// Anti-thrash: if the source never reaches a fixed point (e.g. an actively
// edited or conflict-churning portal), the activator would otherwise restart
// `ww serve` on every settle window, forever (observed: Sakura bouncing every
// ~30 s — see linkfail.md). These bound how many restarts we tolerate inside a
// window before pausing auto-update, and how long a candidate must stay stable
// to override that pause so a genuinely converged update still lands.
export const WW_RELEASE_ACTIVATION_THRASH_WINDOW_MS = 10 * 60_000;
export const WW_RELEASE_ACTIVATION_THRASH_LIMIT = 3;
export const WW_RELEASE_ACTIVATION_THRASH_RECOVER_MS = 5 * 60_000;
export const WW_UPDATE_SOURCE_HASH_VERSION = "ww-update-source-v2";

function defaultLoadActivationHistory(historyPath) {
  if (!historyPath) return [];
  try {
    return readFileSync(historyPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function defaultRecordActivation(historyPath, entry) {
  if (!historyPath) return;
  try {
    mkdirSync(path.dirname(historyPath), { recursive: true });
    appendFileSync(historyPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Activation history is a best-effort thrash guard, never a hard dependency.
  }
}
const WW_UPDATE_BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function normalizePositiveInteger(value, fallback = null) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

export async function buildWwUpdateSourceInfo({
  baseDir = WW_UPDATE_BASE_DIR,
} = {}) {
  const files = await collectWwReleaseSourceFiles(baseDir);
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
  historyPath = null,
  thrashWindowMs = WW_RELEASE_ACTIVATION_THRASH_WINDOW_MS,
  thrashLimit = WW_RELEASE_ACTIVATION_THRASH_LIMIT,
  thrashRecoverMs = WW_RELEASE_ACTIVATION_THRASH_RECOVER_MS,
  loadActivationHistoryImpl = defaultLoadActivationHistory,
  recordActivationImpl = defaultRecordActivation,
} = {}) {
  const normalizedRunningHash = String(runningHash || "").trim();
  const normalizedPollIntervalMs = Math.max(250, Number(pollIntervalMs) || WW_RELEASE_ACTIVATION_POLL_MS);
  const normalizedSettleMs = Math.max(0, Number(settleMs) || 0);
  const normalizedThrashWindowMs = Math.max(0, Number(thrashWindowMs) || 0);
  const normalizedThrashLimit = Math.max(0, Number(thrashLimit) || 0);
  const normalizedThrashRecoverMs = Math.max(0, Number(thrashRecoverMs) || 0);
  let timer = null;
  let checking = false;
  let stopped = false;
  let activated = false;
  let candidate = null;
  let candidateSince = 0;
  let lastError = "";
  let holding = false;
  let holdHash = "";
  let recentActivations = 0;

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
        holding = false;
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

      // Anti-thrash gate. If we have already restarted `ww serve` for enough
      // ever-changing candidates inside the window, the source is not
      // converging (an actively edited / conflict-churning portal). Stop
      // bouncing and keep serving the running build so the machine stays
      // reachable — a genuinely settled candidate (stable far longer than the
      // normal settle window) still overrides the hold so a real update lands.
      const history = loadActivationHistoryImpl(historyPath);
      recentActivations = history.filter((entry) => (
        normalizedThrashWindowMs === 0 || (now - Number(entry?.ts || 0)) <= normalizedThrashWindowMs
      )).length;
      const settledLongEnough = normalizedThrashRecoverMs > 0
        && (now - candidateSince) >= normalizedThrashRecoverMs;
      if (normalizedThrashLimit > 0 && recentActivations >= normalizedThrashLimit && !settledLongEnough) {
        if (!holding || holdHash !== nextHash) {
          holding = true;
          holdHash = nextHash;
          lastError = `auto-update paused: source has not converged after ${recentActivations} restarts in ~${Math.round(normalizedThrashWindowMs / 60_000)} min`;
          log(`WorkWire ${lastError}. Staying on the running build; resolve the source drift between the paired PCs (see linkfail.md).`);
        }
        return false;
      }

      holding = false;
      activated = true;
      recordActivationImpl(historyPath, {
        ts: now,
        hash: nextHash,
        version: String(candidate?.version || ""),
        runningHash: normalizedRunningHash,
      });
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
        holding,
        recentActivations,
        error: lastError,
      };
    },
  };
}
