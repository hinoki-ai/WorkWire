import fs from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const WW_PORTAL_DIRNAME = "WorkWire";
export const WW_CONFIG_NAMESPACE = "workwire";
export const WW_DEFAULT_HOST = "0.0.0.0";
export const WW_DEFAULT_PORT = 4851;
export const WW_DEFAULT_CONFLICT_POLICY = "rename";
export const WW_CONFIG_VERSION = 3;
const MAX_RECENT_PEERS = 8;
const WW_CONFIG_LOCK_STALE_MS = 30_000;
const WW_CONFIG_LOCK_TIMEOUT_MS = 5_000;

function trimEnvPath(value = "") {
  const trimmed = String(value || "").trim();
  return trimmed ? path.resolve(trimmed) : "";
}

export function resolveWwHomeDir({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  return trimEnvPath(env.WW_HOME_DIR) || homeDir;
}

export function resolveWwConfigDir(homeDir = resolveWwHomeDir(), {
  env = process.env,
} = {}) {
  const explicitConfigDir = trimEnvPath(env.WW_CONFIG_DIR);
  if (explicitConfigDir) {
    return explicitConfigDir;
  }

  const configHome = trimEnvPath(env.XDG_CONFIG_HOME) || path.join(homeDir, ".config");
  return path.join(configHome, WW_CONFIG_NAMESPACE);
}

export function resolveWwConfigPath({
  homeDir = resolveWwHomeDir(),
  env = process.env,
} = {}) {
  const explicitConfigPath = trimEnvPath(env.WW_CONFIG_PATH);
  if (explicitConfigPath) {
    return explicitConfigPath;
  }

  return path.join(resolveWwConfigDir(homeDir, { env }), "ww-config.json");
}

const WW_HOME_DIR = resolveWwHomeDir();

export const WW_CONFIG_DIR = resolveWwConfigDir(WW_HOME_DIR);
export const WW_CONFIG_PATH = resolveWwConfigPath({
  homeDir: WW_HOME_DIR,
});

export function generateAuthToken(bytes = 24) {
  return randomBytes(Math.max(16, Number(bytes) || 24)).toString("base64url");
}

export function generateMachineId(bytes = 16) {
  return randomBytes(Math.max(12, Number(bytes) || 16)).toString("base64url");
}

export function deriveWwTrustId(token = "") {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) {
    return "";
  }

  return createHash("sha256")
    .update("ww-trust-v1\0")
    .update(normalizedToken)
    .digest("base64url")
    .slice(0, 32);
}

export function resolveWwPortalRoot(homeDir = WW_HOME_DIR, {
  env = process.env,
} = {}) {
  const explicitPortalPath = trimEnvPath(env.WW_PORTAL_PATH);
  if (explicitPortalPath) {
    return explicitPortalPath;
  }

  return path.join(homeDir, WW_PORTAL_DIRNAME);
}

export async function ensureWwPortalRoot(rootPath = resolveWwPortalRoot()) {
  await fs.mkdir(rootPath, { recursive: true });
  return rootPath;
}

export function normalizePort(value, fallback = WW_DEFAULT_PORT) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return fallback;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return fallback;
  }
  return port;
}

export function normalizeConflictPolicy(value, fallback = WW_DEFAULT_CONFLICT_POLICY) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "overwrite" || normalized === "skip" || normalized === "rename") {
    return normalized;
  }
  return fallback;
}

function trimOrFallback(value, fallback = "") {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
}

function normalizeMachineId(value, fallback = "") {
  return trimOrFallback(value, fallback);
}

function clone(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function buildDefaultWwConfig({
  homeDir = WW_HOME_DIR,
  hostName = os.hostname(),
} = {}) {
  const portalRoot = resolveWwPortalRoot(homeDir);
  return {
    version: WW_CONFIG_VERSION,
    ui: {
      localPath: portalRoot,
      remotePath: "",
      showHidden: false,
      conflictPolicy: WW_DEFAULT_CONFLICT_POLICY,
    },
    service: {
      host: WW_DEFAULT_HOST,
      port: WW_DEFAULT_PORT,
      machineId: generateMachineId(),
      token: generateAuthToken(),
      name: hostName,
      rootPath: portalRoot,
    },
    peer: {
      label: "",
      host: "",
      port: WW_DEFAULT_PORT,
      machineId: "",
      token: "",
      remotePath: "",
    },
    recentPeers: [],
  };
}

export function parsePeerSpec(spec = "", { defaultPort = WW_DEFAULT_PORT } = {}) {
  const raw = String(spec || "").trim();
  if (!raw) {
    return {
      host: "",
      port: defaultPort,
    };
  }

  const ipv6Match = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6Match) {
    return {
      host: ipv6Match[1],
      port: normalizePort(ipv6Match[2], defaultPort),
    };
  }

  const segments = raw.split(":");
  if (segments.length > 1 && /^\d+$/.test(segments.at(-1))) {
    return {
      host: segments.slice(0, -1).join(":").trim(),
      port: normalizePort(segments.at(-1), defaultPort),
    };
  }

  return {
    host: raw,
    port: defaultPort,
  };
}

export function buildPeerBaseUrl(peer = {}) {
  const host = trimOrFallback(peer.host);
  if (!host) {
    return "";
  }

  const port = normalizePort(peer.port);
  const authority = host.includes(":") && !host.startsWith("[")
    ? `[${host}]`
    : host;
  return `http://${authority}:${port}`;
}

function normalizePeer(peer = {}, fallback = {}) {
  return {
    label: trimOrFallback(peer.label, fallback.label || ""),
    host: trimOrFallback(peer.host, fallback.host || ""),
    port: normalizePort(peer.port, fallback.port || WW_DEFAULT_PORT),
    machineId: normalizeMachineId(peer.machineId, fallback.machineId || ""),
    token: trimOrFallback(peer.token, fallback.token || ""),
    remotePath: trimOrFallback(peer.remotePath, fallback.remotePath || ""),
  };
}

function buildPeerIdentityKey(peer = {}) {
  const normalizedPeer = normalizePeer(peer);
  if (normalizedPeer.machineId) {
    return `machine:${normalizedPeer.machineId}`;
  }

  if (!normalizedPeer.host) {
    return "";
  }

  return `network:${normalizedPeer.host}:${normalizedPeer.port}:${normalizedPeer.token}:${normalizedPeer.remotePath}`;
}

function peersMatch(leftPeer = {}, rightPeer = {}) {
  const left = normalizePeer(leftPeer);
  const right = normalizePeer(rightPeer);

  if (left.machineId && right.machineId) {
    return left.machineId === right.machineId;
  }

  return buildPeerIdentityKey(left) === buildPeerIdentityKey(right);
}

function normalizeRecentPeers(peers = [], fallback = []) {
  const seen = new Set();
  const normalized = [];
  for (const peer of Array.isArray(peers) ? peers : []) {
    const next = normalizePeer(peer);
    if (!next.host) {
      continue;
    }

    const key = buildPeerIdentityKey(next);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(next);
    if (normalized.length >= MAX_RECENT_PEERS) {
      break;
    }
  }

  if (normalized.length > 0) {
    return normalized;
  }

  return Array.isArray(fallback) ? clone(fallback) : [];
}

function normalizeStoredWwConfig(rawConfig = {}, defaults = buildDefaultWwConfig()) {
  const next = {
    version: WW_CONFIG_VERSION,
    ui: {
      remotePath: defaults.ui.remotePath,
      showHidden: defaults.ui.showHidden,
      conflictPolicy: defaults.ui.conflictPolicy,
    },
    service: {
      host: defaults.service.host,
      port: defaults.service.port,
      machineId: defaults.service.machineId,
      token: defaults.service.token,
      name: defaults.service.name,
    },
    peer: clone(defaults.peer),
    recentPeers: clone(defaults.recentPeers),
  };
  const raw = rawConfig && typeof rawConfig === "object" ? rawConfig : {};

  next.version = WW_CONFIG_VERSION;
  next.ui.remotePath = trimOrFallback(raw?.ui?.remotePath, defaults.ui.remotePath);
  next.ui.showHidden = Boolean(raw?.ui?.showHidden ?? defaults.ui.showHidden);
  next.ui.conflictPolicy = normalizeConflictPolicy(
    raw?.ui?.conflictPolicy,
    defaults.ui.conflictPolicy,
  );

  next.service.host = trimOrFallback(raw?.service?.host, defaults.service.host);
  next.service.port = normalizePort(raw?.service?.port, defaults.service.port);
  next.service.machineId = normalizeMachineId(
    raw?.service?.machineId,
    defaults.service.machineId || generateMachineId(),
  );
  next.service.token = trimOrFallback(raw?.service?.token, defaults.service.token || generateAuthToken());
  next.service.name = trimOrFallback(raw?.service?.name, defaults.service.name);

  next.peer = normalizePeer(raw?.peer, defaults.peer);
  next.recentPeers = normalizeRecentPeers(raw?.recentPeers, defaults.recentPeers);

  return next;
}

export function buildPersistedWwConfig(config = {}, defaults = buildDefaultWwConfig()) {
  const normalized = normalizeStoredWwConfig(config, defaults);
  return {
    version: WW_CONFIG_VERSION,
    ui: {
      remotePath: normalized.ui.remotePath,
      showHidden: normalized.ui.showHidden,
      conflictPolicy: normalized.ui.conflictPolicy,
    },
    service: {
      host: normalized.service.host,
      port: normalized.service.port,
      machineId: normalized.service.machineId,
      token: normalized.service.token,
      name: normalized.service.name,
    },
    peer: clone(normalized.peer),
    recentPeers: clone(normalized.recentPeers),
  };
}

export function normalizeWwConfig(rawConfig = {}, defaults = buildDefaultWwConfig()) {
  const next = clone(defaults);
  const stored = normalizeStoredWwConfig(rawConfig, defaults);

  next.version = WW_CONFIG_VERSION;
  next.ui.localPath = defaults.ui.localPath;
  next.ui.remotePath = stored.ui.remotePath;
  next.ui.showHidden = stored.ui.showHidden;
  next.ui.conflictPolicy = stored.ui.conflictPolicy;

  next.service.host = stored.service.host;
  next.service.port = stored.service.port;
  next.service.machineId = stored.service.machineId;
  next.service.token = stored.service.token;
  next.service.name = stored.service.name;
  next.service.rootPath = defaults.service.rootPath;

  next.peer = clone(stored.peer);
  next.recentPeers = clone(stored.recentPeers);

  return next;
}

async function ensureConfigDirectory(configPath = WW_CONFIG_PATH) {
  const configDirectory = path.dirname(configPath);
  await fs.mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(configDirectory, 0o700);
}

async function hardenConfigFile(configPath = WW_CONFIG_PATH) {
  try {
    await fs.chmod(configPath, 0o600);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function waitForConfigLock(delayMs = 25) {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function withConfigLock(configPath, task) {
  await ensureConfigDirectory(configPath);
  const lockPath = `${configPath}.lock`;
  const startedAt = Date.now();
  let lockHandle = null;

  while (!lockHandle) {
    try {
      lockHandle = await fs.open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(`${process.pid}\n`, "utf8");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const lockStats = await fs.stat(lockPath).catch(() => null);
      if (lockStats && Date.now() - lockStats.mtimeMs > WW_CONFIG_LOCK_STALE_MS) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt >= WW_CONFIG_LOCK_TIMEOUT_MS) {
        const timeoutError = new Error(`Timed out waiting to update ${configPath}.`);
        timeoutError.code = "ERR_WW_CONFIG_LOCK_TIMEOUT";
        throw timeoutError;
      }
      await waitForConfigLock();
    }
  }

  try {
    return await task();
  } finally {
    await lockHandle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function readJson(configPath = WW_CONFIG_PATH) {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    return null;
  }
}

async function writeWwConfigUnlocked(config, {
  configPath = WW_CONFIG_PATH,
  defaults = buildDefaultWwConfig(),
} = {}) {
  const normalized = normalizeWwConfig(config, defaults);
  const persisted = buildPersistedWwConfig(normalized, defaults);
  await ensureConfigDirectory(configPath);
  await ensureWwPortalRoot(normalized.service.rootPath);
  const temporaryPath = `${configPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporaryPath, configPath);
    await hardenConfigFile(configPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return normalized;
}

export async function saveWwConfig(config, options = {}) {
  const configPath = options.configPath || WW_CONFIG_PATH;
  return withConfigLock(configPath, () => writeWwConfigUnlocked(config, options));
}

export async function loadWwConfig({
  configPath = WW_CONFIG_PATH,
  defaults = buildDefaultWwConfig(),
  persistNormalized = true,
} = {}) {
  const stored = await readJson(configPath);
  const normalized = normalizeWwConfig(stored, defaults);
  const persisted = buildPersistedWwConfig(normalized, defaults);
  await ensureWwPortalRoot(normalized.service.rootPath);
  await ensureConfigDirectory(configPath);
  if (persistNormalized) {
    const currentSerialized = stored == null ? null : JSON.stringify(stored);
    const persistedSerialized = JSON.stringify(persisted);
    if (currentSerialized !== persistedSerialized) {
      await saveWwConfig(normalized, { configPath, defaults });
    }
  }
  await hardenConfigFile(configPath);
  return normalized;
}

export async function updateWwConfig(mutator, options = {}) {
  const configPath = options.configPath || WW_CONFIG_PATH;
  return withConfigLock(configPath, async () => {
    const current = await loadWwConfig({
      ...options,
      configPath,
      persistNormalized: false,
    });
    const next = await mutator(clone(current));
    return writeWwConfigUnlocked(next ?? current, {
      ...options,
      configPath,
    });
  });
}

export function rememberPeer(config, peer) {
  const normalizedConfig = normalizeWwConfig(config);
  const normalizedPeer = normalizePeer(peer, normalizedConfig.peer);
  if (!normalizedPeer.host && !normalizedPeer.machineId) {
    return normalizedConfig;
  }

  normalizedConfig.peer = normalizedPeer;
  if (normalizedPeer.host) {
    normalizedConfig.recentPeers = [
      normalizedPeer,
      ...normalizedConfig.recentPeers.filter((candidate) => !peersMatch(candidate, normalizedPeer)),
    ].slice(0, MAX_RECENT_PEERS);
  }
  return normalizedConfig;
}
