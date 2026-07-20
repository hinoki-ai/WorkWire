import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";

const WINDOWS_BOOT_REGISTRY_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters";

const IGNORED_INTERFACE_PATTERNS = [
  /^lo$/, /^br/i, /^docker/i, /^veth/i, /^virbr/i, /^tun/i, /^tap/i, /^wg/i,
  /^tailscale/i, /^zt/i, /^bond/i, /^dummy/i,
];

function normalize(value = "") {
  return String(value || "").trim().toLowerCase();
}

function validMac(value = "") {
  return /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(value) && value !== "00:00:00:00:00:00";
}

function randomAgentId(randomBytesImpl = randomBytes) {
  return `wwra_${randomBytesImpl(18).toString("base64url")}`;
}

function deterministicAgentId(...parts) {
  return `wwra_${createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 24)}`;
}

async function readTrimmed(fsImpl, filename) {
  try {
    return String(await fsImpl.readFile(filename, "utf8")).trim();
  } catch {
    return "";
  }
}

function executeFile(execFileImpl, file, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout = "", stderr = "") => {
      if (error) {
        error.stderr = String(stderr || "").trim();
        reject(error);
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function hashedBootMarker(prefix, ...parts) {
  return `${prefix}-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

export async function resolveWindowsBootId({
  execFileImpl = execFile,
  hostnameImpl = os.hostname,
  uptimeImpl = os.uptime,
  nowImpl = Date.now,
} = {}) {
  try {
    const stdout = await executeFile(execFileImpl, "reg.exe", [
      "query",
      WINDOWS_BOOT_REGISTRY_KEY,
      "/v",
      "BootId",
    ], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
    const match = stdout.match(/^\s*BootId\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/imu);
    if (match) return `win32-boot-${match[1].toLowerCase().padStart(8, "0")}`;
  } catch {}

  try {
    const stdout = await executeFile(execFileImpl, "powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
    ], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    });
    const lastBoot = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) || "";
    if (lastBoot) return hashedBootMarker("win32-cim", hostnameImpl(), lastBoot);
  } catch {}

  // LastBootUpTime and the kernel boot counter are the authoritative paths.
  // This arithmetic marker preserves restart stability if both probes are
  // unavailable; minute rounding absorbs scheduler and uptime sampling jitter.
  const bootEpochMinute = Math.round((Number(nowImpl()) - (Number(uptimeImpl()) * 1_000)) / 60_000);
  return hashedBootMarker("win32-uptime", hostnameImpl(), String(bootEpochMinute));
}

export async function resolveRecoveryBootId({
  platform = process.platform,
  fsImpl = fs,
  bootIdPath = "/proc/sys/kernel/random/boot_id",
  randomBytesImpl = randomBytes,
  execFileImpl = execFile,
  hostnameImpl = os.hostname,
  uptimeImpl = os.uptime,
  nowImpl = Date.now,
} = {}) {
  if (platform === "win32") {
    return resolveWindowsBootId({ execFileImpl, hostnameImpl, uptimeImpl, nowImpl });
  }
  return await readTrimmed(fsImpl, bootIdPath) || randomBytesImpl(16).toString("hex");
}

export async function collectPhysicalMacAddresses({
  fsImpl = fs,
  sysClassNet = "/sys/class/net",
} = {}) {
  const entries = await fsImpl.readdir(sysClassNet, { withFileTypes: true }).catch(() => []);
  const results = [];
  for (const entry of entries) {
    const name = entry.name;
    if (IGNORED_INTERFACE_PATTERNS.some((pattern) => pattern.test(name))) continue;
    const interfacePath = path.join(sysClassNet, name);
    const mac = normalize(await readTrimmed(fsImpl, path.join(interfacePath, "address")));
    if (!validMac(mac)) continue;
    const type = await readTrimmed(fsImpl, path.join(interfacePath, "type"));
    if (type && type !== "1") continue;
    const deviceLink = await fsImpl.readlink(path.join(interfacePath, "device")).catch(() => "");
    if (!deviceLink && /^(docker|veth|br|vir|tun|tap)/i.test(name)) continue;
    results.push({ name, mac, physical: Boolean(deviceLink) });
  }
  return results.sort((left, right) => left.mac.localeCompare(right.mac));
}

export function collectInterfaceMacAddresses(networkInterfacesImpl = os.networkInterfaces) {
  const seen = new Map();
  for (const [name, records] of Object.entries(networkInterfacesImpl() || {})) {
    if (IGNORED_INTERFACE_PATTERNS.some((pattern) => pattern.test(name))) continue;
    for (const record of records || []) {
      if (record.internal) continue;
      const mac = normalize(record.mac);
      if (!validMac(mac) || seen.has(mac)) continue;
      seen.set(mac, { name, mac, physical: true });
    }
  }
  return [...seen.values()].sort((left, right) => left.mac.localeCompare(right.mac));
}

export async function resolveRecoveryAgentIdentity({
  mode = "installed",
  explicitId = "",
  platform = process.platform,
  fsImpl = fs,
  randomBytesImpl = randomBytes,
  execFileImpl = execFile,
  hostnameImpl = os.hostname,
  uptimeImpl = os.uptime,
  nowImpl = Date.now,
  installedIdPath = "/etc/workwire/agent-id",
  productUuidPath = "/sys/class/dmi/id/product_uuid",
  machineIdPaths = ["/etc/machine-id", "/var/lib/dbus/machine-id"],
  bootIdPath = "/proc/sys/kernel/random/boot_id",
  sysClassNet = "/sys/class/net",
  networkInterfacesImpl = os.networkInterfaces,
} = {}) {
  const bootId = await resolveRecoveryBootId({
    platform,
    fsImpl,
    bootIdPath,
    randomBytesImpl,
    execFileImpl,
    hostnameImpl,
    uptimeImpl,
    nowImpl,
  });
  if (String(explicitId || "").trim()) {
    return {
      agentId: String(explicitId).trim(),
      bootId,
      stability: "explicit",
      inputs: { explicit: true },
    };
  }

  if (mode !== "pxe") {
    const existing = await readTrimmed(fsImpl, installedIdPath);
    if (existing) {
      return {
        agentId: existing,
        bootId,
        stability: "installed-persistent",
        inputs: { installedIdPath },
      };
    }
    const generated = randomAgentId(randomBytesImpl);
    try {
      await fsImpl.mkdir(path.dirname(installedIdPath), { recursive: true, mode: 0o700 });
      await fsImpl.writeFile(installedIdPath, `${generated}\n`, { flag: "wx", mode: 0o600 });
      return {
        agentId: generated,
        bootId,
        stability: "installed-persistent-created",
        inputs: { installedIdPath },
      };
    } catch (error) {
      if (error?.code === "EEXIST") {
        const raced = await readTrimmed(fsImpl, installedIdPath);
        if (raced) return {
          agentId: raced,
          bootId,
          stability: "installed-persistent",
          inputs: { installedIdPath },
        };
      }
    }
  }

  const sysfsMacs = await collectPhysicalMacAddresses({ fsImpl, sysClassNet });
  const macs = sysfsMacs.length > 0 ? sysfsMacs : collectInterfaceMacAddresses(networkInterfacesImpl);
  const lowestMac = macs[0]?.mac || "";
  const productUuid = normalize(await readTrimmed(fsImpl, productUuidPath));
  if (productUuid && lowestMac) {
    return {
      agentId: deterministicAgentId("dmi-mac-v1", productUuid, lowestMac),
      bootId,
      stability: "hardware-stable",
      inputs: { productUuid, mac: lowestMac, interfaces: macs },
    };
  }

  let machineId = "";
  for (const candidate of machineIdPaths) {
    machineId = normalize(await readTrimmed(fsImpl, candidate));
    if (machineId) break;
  }
  if (machineId && lowestMac) {
    return {
      agentId: deterministicAgentId("machine-mac-v1", machineId, lowestMac),
      bootId,
      stability: "machine-stable",
      inputs: { machineId, mac: lowestMac, interfaces: macs },
    };
  }

  return {
    agentId: randomAgentId(randomBytesImpl),
    bootId,
    stability: "boot-only",
    inputs: { productUuid, machineId, mac: lowestMac, interfaces: macs },
  };
}

export { deterministicAgentId, randomAgentId };
