import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveWwConfigDir } from "../ww-config-store.mjs";

export const WW_RECOVERY_CONFIG_VERSION = 1;
export const WW_RECOVERY_PROTOCOL_VERSION = 1;
export const WW_RECOVERY_DEFAULT_PORT = 4852;
export const WW_RECOVERY_DEFAULT_BOOT_PORT = 4853;
export const WW_RECOVERY_DEFAULT_HEARTBEAT_MS = 5_000;
export const WW_RECOVERY_DEFAULT_STALE_AFTER_MS = 15_000;
export const WW_RECOVERY_DEFAULT_OFFLINE_AFTER_MS = 30_000;
export const WW_RECOVERY_DEFAULT_JOB_LEASE_MS = 30_000;
export const WW_RECOVERY_DEFAULT_MAX_JSON_BYTES = 4 * 1024 * 1024;
export const WW_RECOVERY_CONFIG_LOCK_STALE_MS = 30_000;
export const WW_RECOVERY_CONFIG_LOCK_TIMEOUT_MS = 5_000;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function trim(value = "") {
  return String(value ?? "").trim();
}

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  const normalized = trim(value).toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function normalizeInteger(value, fallback, {
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
} = {}) {
  if (value === "" || value === null || value === undefined || typeof value === "boolean") {
    return fallback;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function normalizePort(value, fallback, { allowZero = false } = {}) {
  return normalizeInteger(value, fallback, {
    minimum: allowZero ? 0 : 1,
    maximum: 65_535,
  });
}

function normalizeString(value, fallback = "", { allowEmpty = false } = {}) {
  const normalized = trim(value);
  return normalized || (allowEmpty ? "" : fallback);
}

function parsePlannerCommand(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.map((part) => String(part)).filter((part) => part.length > 0);
  }
  const raw = trim(value);
  if (!raw) return clone(fallback);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((part) => String(part)).filter((part) => part.length > 0);
    }
  } catch {}

  const parts = [];
  const expression = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  for (const match of raw.matchAll(expression)) {
    parts.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\([\\"])/g, "$1"));
  }
  return parts.length > 0 ? parts : clone(fallback);
}

export function resolveRecoveryStateDir({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const explicit = trim(env.WW_RECOVERY_STATE_DIR);
  if (explicit) return path.resolve(explicit);
  return path.join(resolveWwConfigDir(homeDir, { env }), "recovery");
}

export function resolveRecoveryConfigPath(options = {}) {
  return path.join(resolveRecoveryStateDir(options), "controller.json");
}

export function buildDefaultRecoveryConfig({
  env = {},
  homeDir = os.homedir(),
} = {}) {
  const stateDir = resolveRecoveryStateDir({ env, homeDir });
  return {
    version: WW_RECOVERY_CONFIG_VERSION,
    enabled: true,
    host: "0.0.0.0",
    port: WW_RECOVERY_DEFAULT_PORT,
    bootHost: "0.0.0.0",
    bootPort: WW_RECOVERY_DEFAULT_BOOT_PORT,
    advertisedHost: "",
    token: "",
    stateDir,
    heartbeatMs: WW_RECOVERY_DEFAULT_HEARTBEAT_MS,
    staleAfterMs: WW_RECOVERY_DEFAULT_STALE_AFTER_MS,
    offlineAfterMs: WW_RECOVERY_DEFAULT_OFFLINE_AFTER_MS,
    jobLeaseMs: WW_RECOVERY_DEFAULT_JOB_LEASE_MS,
    maxJsonBytes: WW_RECOVERY_DEFAULT_MAX_JSON_BYTES,
    maxArtifactBytes: 0,
    planner: {
      enabled: false,
      command: [],
      maxIterations: 100,
      iterationTimeoutMs: 30 * 60 * 1_000,
    },
    pxe: {
      enabled: false,
      interface: "",
      proxyDhcp: true,
      tftpRoot: path.join(stateDir, "boot", "ipxe"),
      bootRoot: path.join(stateDir, "boot"),
    },
    extensions: {},
  };
}

export function normalizeRecoveryConfig(rawConfig = {}, defaults = buildDefaultRecoveryConfig(), {
  env = {},
} = {}) {
  const raw = isObject(rawConfig) ? rawConfig : {};
  const planner = isObject(raw.planner) ? raw.planner : {};
  const pxe = isObject(raw.pxe) ? raw.pxe : {};
  const environmentStateDir = trim(env.WW_RECOVERY_STATE_DIR);
  const stateDir = path.resolve(
    environmentStateDir
      || normalizeString(raw.stateDir, defaults.stateDir),
  );

  const normalized = {
    version: WW_RECOVERY_CONFIG_VERSION,
    enabled: normalizeBoolean(raw.enabled, defaults.enabled),
    host: normalizeString(raw.host, defaults.host),
    port: normalizePort(raw.port, defaults.port, { allowZero: true }),
    bootHost: normalizeString(raw.bootHost, defaults.bootHost),
    bootPort: normalizePort(raw.bootPort, defaults.bootPort, { allowZero: true }),
    advertisedHost: normalizeString(raw.advertisedHost, defaults.advertisedHost, { allowEmpty: true }),
    token: normalizeString(raw.token, defaults.token, { allowEmpty: true }),
    stateDir,
    heartbeatMs: normalizeInteger(raw.heartbeatMs, defaults.heartbeatMs, { minimum: 100 }),
    staleAfterMs: normalizeInteger(raw.staleAfterMs, defaults.staleAfterMs, { minimum: 100 }),
    offlineAfterMs: normalizeInteger(raw.offlineAfterMs, defaults.offlineAfterMs, { minimum: 100 }),
    jobLeaseMs: normalizeInteger(raw.jobLeaseMs, defaults.jobLeaseMs, { minimum: 100 }),
    maxJsonBytes: normalizeInteger(raw.maxJsonBytes, defaults.maxJsonBytes, { minimum: 1_024 }),
    maxArtifactBytes: normalizeInteger(raw.maxArtifactBytes, defaults.maxArtifactBytes, { minimum: 0 }),
    planner: {
      enabled: normalizeBoolean(planner.enabled, defaults.planner.enabled),
      command: parsePlannerCommand(planner.command, defaults.planner.command),
      maxIterations: normalizeInteger(planner.maxIterations, defaults.planner.maxIterations, { minimum: 0 }),
      iterationTimeoutMs: normalizeInteger(
        planner.iterationTimeoutMs,
        defaults.planner.iterationTimeoutMs,
        { minimum: 0 },
      ),
    },
    pxe: {
      enabled: normalizeBoolean(pxe.enabled, defaults.pxe.enabled),
      interface: normalizeString(pxe.interface, defaults.pxe.interface, { allowEmpty: true }),
      proxyDhcp: normalizeBoolean(pxe.proxyDhcp, defaults.pxe.proxyDhcp),
      tftpRoot: path.resolve(normalizeString(pxe.tftpRoot, path.join(stateDir, "boot", "ipxe"))),
      bootRoot: path.resolve(normalizeString(pxe.bootRoot, path.join(stateDir, "boot"))),
    },
    extensions: isObject(raw.extensions) ? clone(raw.extensions) : {},
  };

  if (normalized.offlineAfterMs < normalized.staleAfterMs) {
    normalized.offlineAfterMs = Math.max(defaults.offlineAfterMs, normalized.staleAfterMs);
  }

  const overrides = {
    enabled: env.WW_RECOVERY_ENABLED,
    host: env.WW_RECOVERY_HOST,
    port: env.WW_RECOVERY_PORT,
    bootHost: env.WW_RECOVERY_BOOT_HOST,
    bootPort: env.WW_RECOVERY_BOOT_PORT,
    advertisedHost: env.WW_RECOVERY_ADVERTISED_HOST,
    token: env.WW_RECOVERY_TOKEN,
  };
  if (overrides.enabled !== undefined) normalized.enabled = normalizeBoolean(overrides.enabled, normalized.enabled);
  if (overrides.host !== undefined) normalized.host = normalizeString(overrides.host, normalized.host);
  if (overrides.port !== undefined) normalized.port = normalizePort(overrides.port, normalized.port, { allowZero: true });
  if (overrides.bootHost !== undefined) normalized.bootHost = normalizeString(overrides.bootHost, normalized.bootHost);
  if (overrides.bootPort !== undefined) normalized.bootPort = normalizePort(overrides.bootPort, normalized.bootPort, { allowZero: true });
  if (overrides.advertisedHost !== undefined) normalized.advertisedHost = normalizeString(overrides.advertisedHost, "", { allowEmpty: true });
  if (overrides.token !== undefined) normalized.token = String(overrides.token ?? "");
  if (env.WW_RECOVERY_PLANNER_COMMAND !== undefined) {
    normalized.planner.command = parsePlannerCommand(env.WW_RECOVERY_PLANNER_COMMAND, []);
    normalized.planner.enabled = normalized.planner.command.length > 0;
  }
  return normalized;
}

async function readJson(configPath) {
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureParent(configPath) {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
}

async function wait(delayMs = 25) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function withConfigLock(configPath, task) {
  await ensureParent(configPath);
  const lockPath = `${configPath}.lock`;
  const started = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
      })}\n`, "utf8");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stats = await fs.stat(lockPath).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > WW_RECOVERY_CONFIG_LOCK_STALE_MS) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - started >= WW_RECOVERY_CONFIG_LOCK_TIMEOUT_MS) {
        const timeoutError = new Error(`Timed out waiting for recovery config lock ${lockPath}.`);
        timeoutError.code = "ERR_WW_RECOVERY_CONFIG_LOCK";
        throw timeoutError;
      }
      await wait();
    }
  }
  try {
    return await task();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function writeConfigUnlocked(config, { configPath, defaults, env }) {
  const normalized = normalizeRecoveryConfig(config, defaults, { env });
  await ensureParent(configPath);
  await fs.mkdir(normalized.stateDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${configPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const handle = await fs.open(temporaryPath, "r");
    await handle.sync();
    await handle.close();
    await fs.rename(temporaryPath, configPath);
    await fs.chmod(configPath, 0o600);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return normalized;
}

export async function loadRecoveryConfig({
  configPath,
  env = process.env,
  homeDir = os.homedir(),
  defaults,
  persistNormalized = true,
} = {}) {
  const resolvedPath = configPath || resolveRecoveryConfigPath({ env, homeDir });
  const resolvedDefaults = defaults || buildDefaultRecoveryConfig({ env, homeDir });
  const stored = await readJson(resolvedPath);
  const normalized = normalizeRecoveryConfig(stored || {}, resolvedDefaults, { env });
  await fs.mkdir(normalized.stateDir, { recursive: true, mode: 0o700 });
  if (persistNormalized && JSON.stringify(stored) !== JSON.stringify(normalized)) {
    await saveRecoveryConfig(normalized, {
      configPath: resolvedPath,
      env,
      homeDir,
      defaults: resolvedDefaults,
    });
  }
  return normalized;
}

export async function saveRecoveryConfig(config, {
  configPath,
  env = process.env,
  homeDir = os.homedir(),
  defaults,
} = {}) {
  const resolvedPath = configPath || resolveRecoveryConfigPath({ env, homeDir });
  const resolvedDefaults = defaults || buildDefaultRecoveryConfig({ env, homeDir });
  return withConfigLock(resolvedPath, () => writeConfigUnlocked(config, {
    configPath: resolvedPath,
    defaults: resolvedDefaults,
    env,
  }));
}

export { parsePlannerCommand };
