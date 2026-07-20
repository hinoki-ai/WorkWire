import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const ADAPTERS = Object.freeze([
  { id: "rdp-xfreerdp", protocol: "rdp", tools: ["xfreerdp3", "xfreerdp"], build: (tool, target, options) => [tool, `/v:${target}`, ...(options.user ? [`/u:${options.user}`] : []), ...args(options)] },
  { id: "rdp-remmina", protocol: "rdp", tools: ["remmina"], build: (tool, target, options) => [tool, "-c", `rdp://${target}`, ...args(options)] },
  { id: "vnc-viewer", protocol: "vnc", tools: ["vncviewer", "tigervncviewer"], build: (tool, target, options) => [tool, target, ...args(options)] },
  { id: "vnc-remmina", protocol: "vnc", tools: ["remmina"], build: (tool, target, options) => [tool, "-c", `vnc://${target}`, ...args(options)] },
  { id: "spice-viewer", protocol: "spice", tools: ["remote-viewer", "virt-viewer"], build: (tool, target, options) => [tool, target.includes("://") ? target : `spice://${target}`, ...args(options)] },
  { id: "ssh", protocol: "ssh", tools: ["ssh"], build: (tool, target, options) => [tool, ...(options.port ? ["-p", String(options.port)] : []), ...(options.identity ? ["-i", String(options.identity)] : []), target, ...args(options)] },
  { id: "serial-picocom", protocol: "serial", tools: ["picocom"], build: (tool, target, options) => [tool, ...(options.baud ? ["--baud", String(options.baud)] : []), target, ...args(options)] },
  { id: "serial-screen", protocol: "serial", tools: ["screen"], build: (tool, target, options) => [tool, target, String(options.baud || 115200), ...args(options)] },
  { id: "sol-ipmitool", protocol: "sol", tools: ["ipmitool"], build: (tool, target, options) => [tool, "-H", target, ...(options.user ? ["-U", String(options.user)] : []), "sol", "activate", ...args(options)] },
  { id: "browser", protocol: "browser", tools: ["xdg-open", "open"], build: (tool, target, options) => [tool, target, ...args(options)] },
]);

function args(options = {}) {
  return Array.isArray(options.extraArgs) ? options.extraArgs.map(String) : [];
}

async function executable(filename, { env = process.env, platform = process.platform, fsImpl = fs } = {}) {
  const value = String(filename || "");
  if (!value) return "";
  if (value.includes(path.sep) || (platform === "win32" && /[\\/]/.test(value))) {
    try { await fsImpl.access(value); return value; } catch { return ""; }
  }
  const delimiter = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const directory of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, platform === "win32" && !path.extname(value) ? `${value}${extension}` : value);
      try { await fsImpl.access(candidate); return candidate; } catch {}
    }
  }
  return "";
}

export async function discoverRecoveryConsoleAdapters({ env = process.env, platform = process.platform, fsImpl = fs } = {}) {
  const results = [];
  for (const adapter of ADAPTERS) {
    let resolved = "";
    for (const tool of adapter.tools) {
      resolved = await executable(tool, { env, platform, fsImpl });
      if (resolved) break;
    }
    results.push({
      id: adapter.id,
      protocol: adapter.protocol,
      available: Boolean(resolved),
      tool: resolved,
      alternatives: [...adapter.tools],
      unavailableReason: resolved ? "" : `None of ${adapter.tools.join(", ")} is installed or on PATH.`,
    });
  }
  return results;
}

export function createRecoveryConsoleLauncher({
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  spawnImpl = spawn,
} = {}) {
  async function discover() {
    return discoverRecoveryConsoleAdapters({ env, platform, fsImpl });
  }

  async function resolve(input = {}) {
    if (Array.isArray(input.transportArgv) && input.transportArgv.length > 0) {
      const argv = input.transportArgv.map(String);
      const tool = await executable(argv[0], { env, platform, fsImpl });
      return {
        id: "custom",
        protocol: "custom",
        available: Boolean(tool),
        tool: tool || argv[0],
        argv: [tool || argv[0], ...argv.slice(1)],
        alternatives: [],
        unavailableReason: tool ? "" : `${argv[0]} is not installed or executable.`,
      };
    }
    const requestedProtocol = String(input.protocol || "ssh").toLowerCase();
    const discovered = await discover();
    const candidates = discovered.filter((adapter) => adapter.protocol === requestedProtocol);
    const selected = input.adapterId
      ? candidates.find((adapter) => adapter.id === input.adapterId)
      : candidates.find((adapter) => adapter.available);
    if (!selected) return { available: false, protocol: requestedProtocol, alternatives: candidates, unavailableReason: `No ${requestedProtocol} console adapter is registered.` };
    if (!selected.available) return { ...selected, alternatives: candidates };
    const descriptor = ADAPTERS.find((adapter) => adapter.id === selected.id);
    return {
      ...selected,
      argv: descriptor.build(selected.tool, String(input.target || ""), input),
      alternatives: candidates,
    };
  }

  async function launch(input = {}) {
    const selected = await resolve(input);
    if (!selected.available) {
      const error = new Error(selected.unavailableReason || `No ${selected.protocol} console adapter is installed.`);
      error.code = "ERR_WW_RECOVERY_CONSOLE_UNAVAILABLE";
      error.details = { alternatives: selected.alternatives };
      throw error;
    }
    if (!selected.argv?.length) throw new TypeError("Console adapter produced no argv.");
    const child = spawnImpl(selected.argv[0], selected.argv.slice(1), {
      cwd: input.cwd ? path.resolve(String(input.cwd)) : undefined,
      env: { ...env, ...(input.env || {}) },
      detached: input.detached !== false,
      stdio: input.detached === false ? "pipe" : "ignore",
      windowsHide: false,
    });
    if (input.detached !== false) child.unref?.();
    return { ...selected, pid: child.pid || null, launchedAt: new Date().toISOString() };
  }

  return { discover, resolve, launch };
}

export { ADAPTERS as RECOVERY_CONSOLE_ADAPTERS, executable as resolveConsoleExecutable };
