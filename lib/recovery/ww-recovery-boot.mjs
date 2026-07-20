import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { collectLanInterfaceRecords, intToIp, resolveAdvertisedHost } from "../ww-network.mjs";
import { normalizeMacAddress } from "./ww-recovery-wol.mjs";
import { createRecoveryError, RECOVERY_ERROR_CODES } from "./ww-recovery-protocol.mjs";
import { renameRecoveryFile } from "./ww-recovery-atomic.mjs";

const BIOS_ARCHITECTURES = new Set([0]);
const UEFI_X64_ARCHITECTURES = new Set([7, 9]);

function netmaskFromPrefix(prefix) {
  const bits = Math.max(0, Math.min(32, Number(prefix) || 0));
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return intToIp(mask);
}

function safeInterface(value = "") {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9_.:-]+$/.test(name)) {
    throw createRecoveryError(RECOVERY_ERROR_CODES.PXE_CONFIG, `Invalid PXE interface ${value}.`);
  }
  return name;
}

export function selectPxeInterface({
  interfaceName = "",
  networkInterfaces,
  records = collectLanInterfaceRecords({ networkInterfaces }),
} = {}) {
  if (interfaceName) {
    const selected = records.find((record) => record.name === interfaceName);
    if (!selected) throw createRecoveryError(RECOVERY_ERROR_CODES.PXE_CONFIG, `PXE interface ${interfaceName} has no usable IPv4 address.`);
    return selected;
  }
  const wired = records.filter((record) => /^(en|eth)/i.test(record.name));
  const candidates = wired.length ? wired : records;
  if (candidates.length === 0) throw createRecoveryError(RECOVERY_ERROR_CODES.PXE_CONFIG, "No usable LAN interface was found for PXE.");
  if (candidates.length > 1) {
    const first = candidates[0];
    const second = candidates[1];
    if (/^(en|eth)/i.test(first.name) === /^(en|eth)/i.test(second.name) && first.prefix === second.prefix) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.PXE_CONFIG,
        `Multiple plausible PXE interfaces were found (${candidates.map((record) => record.name).join(", ")}); pass --interface.`,
      );
    }
  }
  return candidates[0];
}

export function selectPxeBootTarget({ architecture = 0, userClass = "" } = {}) {
  if (String(userClass).toLowerCase().includes("ipxe")) return "boot.ipxe";
  const arch = Number(architecture);
  if (BIOS_ARCHITECTURES.has(arch)) return "ipxe.pxe";
  if (UEFI_X64_ARCHITECTURES.has(arch)) return "ipxe.efi";
  return "ipxe.efi";
}

export function renderDnsmasqConfig({
  interfaceRecord,
  tftpRoot,
  logPath,
  bootUrl,
  bindDynamic = true,
} = {}) {
  if (!interfaceRecord) throw createRecoveryError(RECOVERY_ERROR_CODES.PXE_CONFIG, "PXE interface record is required.");
  const interfaceName = safeInterface(interfaceRecord.name);
  const network = intToIp(interfaceRecord.network);
  const netmask = interfaceRecord.netmask || netmaskFromPrefix(interfaceRecord.prefix);
  return [
    "port=0",
    "user=root",
    "group=root",
    `interface=${interfaceName}`,
    bindDynamic ? "bind-dynamic" : "bind-interfaces",
    "log-dhcp",
    `log-facility=${path.resolve(logPath)}`,
    `dhcp-range=${network},proxy,${netmask}`,
    "enable-tftp",
    `tftp-root=${path.resolve(tftpRoot)}`,
    "dhcp-match=set:bios,option:client-arch,0",
    "dhcp-match=set:efi-x64,option:client-arch,7",
    "dhcp-match=set:efi-x64,option:client-arch,9",
    "dhcp-userclass=set:ipxe,iPXE",
    "dhcp-boot=tag:bios,tag:!ipxe,pxelinux.0",
    "dhcp-boot=tag:efi-x64,tag:!ipxe,ipxe.efi",
    `dhcp-boot=tag:ipxe,${bootUrl}?mac=\${net0/mac}`,
    "pxe-service=tag:bios,tag:!ipxe,x86PC,WorkWire Recovery BIOS,pxelinux.0",
    "pxe-service=tag:efi-x64,tag:!ipxe,X86-64_EFI,WorkWire Recovery UEFI,ipxe.efi",
    "dhcp-no-override",
    "",
  ].join("\n");
}

export function renderIpxeScript({
  controllerUrl,
  bootUrl,
  policy = "recovery",
  timeoutMs = 4_000,
} = {}) {
  const chosen = ["recovery", "local", "shell"].includes(policy) ? policy : "recovery";
  return `#!ipxe
set controller ${controllerUrl}
set boot ${bootUrl}
isset \${platform} || set platform unknown
menu WorkWire Recovery
item --gap -- ---------------- operator-owned LAN recovery ----------------
item recovery WorkWire Recovery
item recovery_nomodeset WorkWire Recovery (nomodeset)
item local Local boot / return to firmware
item shell iPXE shell
item reboot Reboot
choose --default ${chosen} --timeout ${Number(timeoutMs) || 4000} target || goto local
goto \${target}

:recovery
kernel \${boot}/v1/recovery/boot/live/vmlinuz boot=live components ip=dhcp fetch=\${boot}/v1/recovery/boot/live/filesystem.squashfs ww.controller=\${controller} ww.mode=pxe ww.mac=\${net0/mac} ww.uuid=\${uuid}
initrd \${boot}/v1/recovery/boot/live/initrd.img
boot || goto failed

:recovery_nomodeset
kernel \${boot}/v1/recovery/boot/live/vmlinuz boot=live components ip=dhcp nomodeset fetch=\${boot}/v1/recovery/boot/live/filesystem.squashfs ww.controller=\${controller} ww.mode=pxe ww.mac=\${net0/mac} ww.uuid=\${uuid}
initrd \${boot}/v1/recovery/boot/live/initrd.img
boot || goto failed

:shell
shell
goto start

:reboot
reboot

:local
exit

:failed
echo WorkWire recovery boot failed
prompt --key 0x197e --timeout 10000 Press F12 for shell... && shell
exit
`;
}

async function atomicJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporaryPath = `${filename}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await renameRecoveryFile(fs, temporaryPath, filename);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export function createRecoveryBootManager({
  config,
  controllerInfo = null,
  spawnImpl = spawn,
  fsImpl = fs,
  networkInterfaces,
  log = () => {},
} = {}) {
  if (!config?.stateDir) throw new TypeError("Recovery boot manager requires recovery configuration.");
  const stateDir = path.resolve(config.stateDir);
  const bootRoot = path.resolve(config.pxe?.bootRoot || path.join(stateDir, "boot"));
  const tftpRoot = path.resolve(config.pxe?.tftpRoot || path.join(bootRoot, "ipxe"));
  const pxeRoot = path.join(stateDir, "pxe");
  const configPath = path.join(pxeRoot, "dnsmasq.conf");
  const pidPath = path.join(pxeRoot, "dnsmasq.pid");
  const logPath = path.join(pxeRoot, "dnsmasq.log");
  const policyPath = path.join(pxeRoot, "boot-policy.json");
  let child = null;
  let selectedInterface = null;

  function info() {
    return typeof controllerInfo === "function" ? controllerInfo() : controllerInfo || {
      url: `http://${resolveAdvertisedHost(config.advertisedHost || config.host, { networkInterfaces })}:${config.port}`,
      boot: { url: `http://${resolveAdvertisedHost(config.advertisedHost || config.bootHost, { networkInterfaces })}:${config.bootPort}` },
    };
  }

  async function loadPolicy() {
    try {
      const value = JSON.parse(await fsImpl.readFile(policyPath, "utf8"));
      return {
        default: ["recovery", "local", "shell"].includes(value.default) ? value.default : "recovery",
        machines: value.machines && typeof value.machines === "object" ? value.machines : {},
      };
    } catch {
      return { default: "recovery", machines: {} };
    }
  }

  async function savePolicy(policy) {
    await atomicJson(policyPath, policy);
    return policy;
  }

  async function setMachinePolicy(mac, next, { after = "local", name = "" } = {}) {
    const normalized = normalizeMacAddress(mac);
    const policy = await loadPolicy();
    policy.machines[normalized] = { next, after, name };
    await savePolicy(policy);
    return policy.machines[normalized];
  }

  async function consumeMachinePolicy(mac) {
    const normalized = normalizeMacAddress(mac);
    const policy = await loadPolicy();
    const record = policy.machines[normalized];
    const consumed = record ? { ...record } : null;
    if (record?.after) record.next = record.after;
    await savePolicy(policy);
    return consumed;
  }

  async function policyFor(mac = "") {
    const policy = await loadPolicy();
    if (!mac) return policy.default;
    try { return policy.machines[normalizeMacAddress(mac)]?.next || policy.default; } catch { return policy.default; }
  }

  async function locateIpxeBinary(names) {
    const candidates = [
      ...names.map((name) => path.join("/usr/share/ipxe", name)),
      ...names.map((name) => path.join("/usr/share/ipxe/boot", name)),
      ...names.map((name) => path.join("/usr/lib/ipxe", name)),
      ...names.map((name) => path.join("/usr/share/syslinux", name)),
    ];
    for (const candidate of candidates) {
      const stats = await fsImpl.stat(candidate).catch(() => null);
      if (stats?.isFile()) return candidate;
    }
    return "";
  }

  async function prepare({ interfaceName = config.pxe?.interface || "", validate = true } = {}) {
    selectedInterface = selectPxeInterface({ interfaceName, networkInterfaces });
    await Promise.all([
      fsImpl.mkdir(pxeRoot, { recursive: true, mode: 0o700 }),
      fsImpl.mkdir(tftpRoot, { recursive: true, mode: 0o755 }),
      fsImpl.mkdir(path.join(bootRoot, "live"), { recursive: true, mode: 0o755 }),
    ]);
    const controller = info();
    const dnsmasqConfig = renderDnsmasqConfig({
      interfaceRecord: selectedInterface,
      tftpRoot,
      logPath,
      bootUrl: `${controller.boot.url}/v1/recovery/boot/x86_64/boot.ipxe`,
    });
    await fsImpl.writeFile(configPath, dnsmasqConfig, { mode: 0o600 });
    const ipxeScript = `#!ipxe\ndhcp ||\nchain --autofree ${controller.boot.url}/v1/recovery/boot/x86_64/boot.ipxe?mac=\${net0/mac} || shell\n`;
    await fsImpl.writeFile(path.join(tftpRoot, "boot.ipxe"), ipxeScript, { mode: 0o644 });
    const binaries = [
      ["ipxe.pxe", ["ipxe.pxe"]],
      ["undionly.kpxe", ["undionly.kpxe"]],
      ["ipxe.efi", ["ipxe-x86_64.efi", "ipxe.efi"]],
    ];
    const manifest = { generatedAt: new Date().toISOString(), interface: selectedInterface, assets: {}, missing: [] };
    for (const [destinationName, sourceNames] of binaries) {
      const destination = path.join(tftpRoot, destinationName);
      if (!(await fsImpl.stat(destination).catch(() => null))) {
        const source = await locateIpxeBinary(sourceNames);
        if (source) await fsImpl.copyFile(source, destination);
      }
      const stats = await fsImpl.stat(destination).catch(() => null);
      if (stats?.isFile()) manifest.assets[destinationName] = { size: stats.size, sha256: await hashFile(destination) };
      else manifest.missing.push(destinationName);
    }
    await atomicJson(path.join(bootRoot, "manifest.json"), manifest);
    if (validate) await validateConfig();
    return { configPath, logPath, pidPath, interface: selectedInterface, manifest };
  }

  async function runDnsmasq(args) {
    return new Promise((resolve, reject) => {
      const processHandle = spawnImpl("dnsmasq", args, { stdio: ["ignore", "pipe", "pipe"] });
      const stdout = [];
      const stderr = [];
      processHandle.stdout?.on("data", (chunk) => stdout.push(chunk));
      processHandle.stderr?.on("data", (chunk) => stderr.push(chunk));
      processHandle.once("error", reject);
      processHandle.once("close", (exitCode, signal) => resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
  }

  async function validateConfig() {
    const result = await runDnsmasq(["--test", `--conf-file=${configPath}`]);
    if (result.exitCode !== 0) {
      throw createRecoveryError(RECOVERY_ERROR_CODES.PXE_CONFIG, result.stderr || result.stdout || "dnsmasq configuration failed validation.", result);
    }
    return result;
  }

  async function status() {
    const pid = Number(String(await fsImpl.readFile(pidPath, "utf8").catch(() => "")).trim());
    let running = false;
    let command = "";
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 0);
        running = true;
        command = String(await fsImpl.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).replaceAll("\0", " ");
        if (!command.includes(configPath)) running = false;
      } catch {}
    }
    return { running, pid: running ? pid : null, command, configPath, interface: selectedInterface };
  }

  async function start(options = {}) {
    const existing = await status();
    if (existing.running) return existing;
    await prepare(options);
    child = spawnImpl("dnsmasq", ["--keep-in-foreground", `--conf-file=${configPath}`], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      let settled = false;
      child.once("error", reject);
      child.once("spawn", () => {
        settled = true;
        resolve();
      });
      child.once("close", (exitCode) => {
        if (!settled) reject(createRecoveryError(RECOVERY_ERROR_CODES.PXE_PROCESS, `dnsmasq exited ${exitCode} before startup.`));
      });
    });
    child.stdout?.on("data", (chunk) => log(String(chunk).trimEnd()));
    child.stderr?.on("data", (chunk) => log(String(chunk).trimEnd()));
    await fsImpl.writeFile(pidPath, `${child.pid}\n`, { mode: 0o600 });
    child.once("close", () => void fsImpl.rm(pidPath, { force: true }));
    return { running: true, pid: child.pid, configPath, interface: selectedInterface };
  }

  async function stop() {
    const current = await status();
    if (!current.running) {
      await fsImpl.rm(pidPath, { force: true });
      return { running: false, stopped: false };
    }
    if (!current.command.includes(configPath)) {
      throw createRecoveryError(RECOVERY_ERROR_CODES.PXE_PROCESS, `PID ${current.pid} is not the WorkWire dnsmasq instance.`);
    }
    process.kill(current.pid, "SIGTERM");
    const started = Date.now();
    while (Date.now() - started < 3_000) {
      try { process.kill(current.pid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await fsImpl.rm(pidPath, { force: true });
    return { running: false, stopped: true, pid: current.pid };
  }

  async function handleRequest(request, response, url, liveControllerInfo) {
    const match = url.pathname.match(/^\/v1\/recovery\/boot\/([^/]+)\/boot\.ipxe$/);
    if (!match) return false;
    const mac = url.searchParams.get("mac") || request.headers["x-ww-client-mac"] || "";
    const selectedPolicy = await policyFor(mac);
    const controller = liveControllerInfo || info();
    const script = renderIpxeScript({ controllerUrl: controller.url, bootUrl: controller.boot.url, policy: selectedPolicy });
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(script);
    return true;
  }

  return {
    prepare,
    validateConfig,
    start,
    stop,
    status,
    handleRequest,
    loadPolicy,
    setMachinePolicy,
    arm: (mac, options) => setMachinePolicy(mac, "recovery", options),
    local: (mac, options) => setMachinePolicy(mac, "local", options),
    consumeMachinePolicy,
    policyFor,
    getPaths: () => ({ stateDir, bootRoot, tftpRoot, pxeRoot, configPath, pidPath, logPath, policyPath }),
  };
}
