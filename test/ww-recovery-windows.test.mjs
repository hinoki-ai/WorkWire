import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recoveryPlatformDefaults } from "../lib/recovery/ww-recovery-platform.mjs";
import { resolveRecoveryAgentOptions } from "../lib/recovery/ww-recovery-agent.mjs";
import { createRecoveryExecutor } from "../lib/recovery/ww-recovery-executor.mjs";
import { createRecoveryActionRegistry } from "../lib/recovery/ww-recovery-actions.mjs";
import { createRecoveryInventoryCollector, parseWindowsDisks } from "../lib/recovery/ww-recovery-inventory.mjs";
import {
  collectInterfaceMacAddresses,
  resolveRecoveryAgentIdentity,
  resolveWindowsBootId,
} from "../lib/recovery/ww-recovery-agent-id.mjs";

test("recovery platform defaults route Windows state into ProgramData", () => {
  const windows = recoveryPlatformDefaults("win32", { ProgramData: "D:\\ProgramData" });
  assert.equal(windows.configPath, "D:\\ProgramData\\WorkWire\\recovery-agent.json");
  assert.equal(windows.installedIdPath, "D:\\ProgramData\\WorkWire\\agent-id");
  assert.equal(windows.installedStateDir, "D:\\ProgramData\\WorkWire\\recovery-state");
  assert.equal(windows.cmdlinePath, "");
  const posix = recoveryPlatformDefaults("linux", {});
  assert.equal(posix.configPath, "/etc/workwire/recovery-agent.json");
  assert.equal(posix.installedStateDir, "/var/lib/workwire-recovery");
  assert.equal(posix.cmdlinePath, "/proc/cmdline");
});

test("recovery agent options read the Windows config path and skip kernel cmdline", async () => {
  const reads = [];
  const fsImpl = {
    async readFile(filename) {
      reads.push(filename);
      if (filename === "C:\\ProgramData\\WorkWire\\recovery-agent.json") {
        return JSON.stringify({ controllerUrl: "http://192.168.8.104:4852", token: "secret", mode: "installed" });
      }
      throw new Error("ENOENT");
    },
  };
  const options = await resolveRecoveryAgentOptions({
    env: { ProgramData: "C:\\ProgramData" },
    fsImpl,
    platform: "win32",
  });
  assert.equal(options.controllerUrl, "http://192.168.8.104:4852");
  const bomOptions = await resolveRecoveryAgentOptions({
    env: { ProgramData: "C:\\ProgramData" },
    fsImpl: {
      async readFile(filename) {
        if (filename === "C:\\ProgramData\\WorkWire\\recovery-agent.json") {
          return `﻿${JSON.stringify({ controllerUrl: "http://192.168.8.104:4852" })}`;
        }
        throw new Error("ENOENT");
      },
    },
    platform: "win32",
  });
  assert.equal(bomOptions.controllerUrl, "http://192.168.8.104:4852");
  assert.equal(options.token, "secret");
  assert.equal(options.mode, "installed");
  assert.equal(reads.includes("/proc/cmdline"), false);
});

test("recovery executor resolves Windows tools through PATHEXT and semicolon PATH", async () => {
  const present = new Set([
    "C:\\Windows\\System32\\shutdown.EXE",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE",
    "C:\\Tools\\run.CMD",
  ]);
  const fsImpl = {
    async access(candidate) {
      if (!present.has(candidate)) throw new Error("ENOENT");
    },
  };
  const executor = createRecoveryExecutor({
    platform: "win32",
    fsImpl,
    baseEnv: {
      PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Tools",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    },
  });
  assert.equal(await executor.resolveTool("shutdown"), "C:\\Windows\\System32\\shutdown.EXE");
  assert.equal(await executor.resolveTool("powershell"), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE");
  assert.equal(await executor.resolveTool("run"), "C:\\Tools\\run.CMD");
  assert.equal(await executor.resolveTool("missing"), "");
  assert.equal(await executor.resolveTool("C:\\Tools\\run.CMD"), "C:\\Tools\\run.CMD");
});

test("recovery executor maps shell scripts to powershell, cmd, and bash argument styles", async () => {
  const spawned = [];
  const spawnImpl = (file, args) => {
    spawned.push({ file, args });
    const noop = () => {};
    return {
      pid: 1234,
      exitCode: null,
      stdin: { end: noop, once: noop, destroy: noop },
      stdout: { on: noop },
      stderr: { on: noop },
      once(event, handler) {
        if (event === "close") setImmediate(() => handler(0, null));
      },
      kill: () => true,
    };
  };
  const anyTool = { async access() {} };
  const windowsExecutor = createRecoveryExecutor({
    platform: "win32",
    fsImpl: anyTool,
    spawnImpl,
    baseEnv: { PATH: "C:\\Windows\\System32", PATHEXT: ".EXE" },
  });
  await windowsExecutor.execShell({ script: "Get-Date" });
  assert.deepEqual(spawned[0].args, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "Get-Date"]);
  await windowsExecutor.execShell({ script: "dir", shell: "cmd" });
  assert.deepEqual(spawned[1].args, ["/d", "/s", "/c", "dir"]);
  const posixExecutor = createRecoveryExecutor({
    platform: "linux",
    fsImpl: anyTool,
    spawnImpl,
    baseEnv: { PATH: "/usr/bin" },
  });
  await posixExecutor.execShell({ script: "true" });
  assert.deepEqual(spawned[2].args, ["-lc", "true"]);
});

test("recovery identity falls back to runtime interface MACs and persists on Windows paths", async () => {
  const macs = collectInterfaceMacAddresses(() => ({
    "Ethernet": [
      { mac: "18:03:73:2E:3F:42", address: "192.168.8.107", family: "IPv4", internal: false },
    ],
    "Loopback Pseudo-Interface 1": [
      { mac: "00:00:00:00:00:00", address: "127.0.0.1", family: "IPv4", internal: true },
    ],
  }));
  assert.deepEqual(macs, [{ name: "Ethernet", mac: "18:03:73:2e:3f:42", physical: true }]);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-windows-"));
  const installedIdPath = path.join(root, "agent-id");
  const emptySys = path.join(root, "sys-class-net");
  await fs.mkdir(emptySys, { recursive: true });
  const first = await resolveRecoveryAgentIdentity({
    mode: "installed",
    installedIdPath,
    sysClassNet: emptySys,
    bootIdPath: path.join(root, "missing-boot-id"),
    productUuidPath: path.join(root, "missing-product-uuid"),
    machineIdPaths: [path.join(root, "missing-machine-id")],
  });
  const second = await resolveRecoveryAgentIdentity({
    mode: "installed",
    installedIdPath,
    sysClassNet: emptySys,
    bootIdPath: path.join(root, "missing-boot-id"),
    productUuidPath: path.join(root, "missing-product-uuid"),
    machineIdPaths: [path.join(root, "missing-machine-id")],
  });
  assert.equal(first.agentId, second.agentId);
  assert.equal(second.stability, "installed-persistent");
  await fs.rm(root, { recursive: true, force: true });
});

test("Windows recovery boot identity survives process restart and changes only with the OS boot counter", async () => {
  const calls = [];
  const registry = (value) => (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, `HKEY_LOCAL_MACHINE\\...\r\n    BootId    REG_DWORD    0x${value}\r\n`, "");
  };
  const first = await resolveWindowsBootId({ execFileImpl: registry("6") });
  const restarted = await resolveWindowsBootId({ execFileImpl: registry("6") });
  const rebooted = await resolveWindowsBootId({ execFileImpl: registry("7") });
  assert.equal(first, "win32-boot-00000006");
  assert.equal(restarted, first);
  assert.notEqual(rebooted, first);
  assert.equal(calls.every((call) => call.file === "reg.exe" && call.args.at(-1) === "BootId"), true);
});

test("Windows recovery boot identity falls back to stable CIM last-boot time", async () => {
  const execFileImpl = (file, args, options, callback) => {
    if (file === "reg.exe") {
      const error = new Error("missing registry value");
      error.code = 1;
      callback(error, "", "missing");
      return;
    }
    assert.equal(file, "powershell.exe");
    callback(null, "2026-07-19T05:39:56.6323620Z\r\n", "");
  };
  const first = await resolveWindowsBootId({ execFileImpl, hostnameImpl: () => "SAKURA" });
  const restarted = await resolveWindowsBootId({ execFileImpl, hostnameImpl: () => "SAKURA" });
  assert.match(first, /^win32-cim-[0-9a-f]{24}$/u);
  assert.equal(restarted, first);
});

test("recovery actions on win32 hibernate by default and translate process and service verbs", async () => {
  const calls = [];
  const executor = {
    async toolExists() { return true; },
    async resolveTool(tool) { return `C:\\Windows\\System32\\${tool}.exe`; },
    async execArgv(input) {
      calls.push(input);
      return { exitCode: 0, signal: null, file: input.file, args: input.args, stdoutTail: "", stderrTail: "" };
    },
    async execShell(input) {
      calls.push(input);
      return { exitCode: 0, signal: null };
    },
  };
  const registry = createRecoveryActionRegistry({
    executor,
    inventory: async () => ({ block: { devices: [] } }),
    platform: "win32",
  });
  await registry.run("power.poweroff", {});
  assert.equal(calls.at(-1).file, "shutdown");
  assert.deepEqual(calls.at(-1).args, ["/h"]);
  await registry.run("power.poweroff", { method: "shutdown" });
  assert.deepEqual(calls.at(-1).args, ["/s", "/t", "0"]);
  await registry.run("power.reboot", {});
  assert.deepEqual(calls.at(-1).args, ["/r", "/t", "0"]);
  await registry.run("power.hibernate", {});
  assert.equal(calls.at(-1).file, "shutdown");
  assert.deepEqual(calls.at(-1).args, ["/h"]);
  await registry.run("process.signal", { pid: 4242, force: true });
  assert.equal(calls.at(-1).file, "taskkill");
  assert.deepEqual(calls.at(-1).args, ["/pid", "4242", "/t", "/f"]);
  await registry.run("service.status", { name: "Spooler" });
  assert.equal(calls.at(-1).file, "sc");
  assert.deepEqual(calls.at(-1).args, ["query", "Spooler"]);
  await registry.run("service.restart", { name: "Spooler" });
  assert.equal(calls.at(-1).file, "powershell");
  assert.equal(calls.at(-1).env.WW_SERVICE_NAME, "Spooler");
});

test("recovery shell.exec defaults to PowerShell on win32 and bash on linux", async () => {
  const shells = [];
  const executor = {
    async toolExists() { return true; },
    async resolveTool(tool) { return tool; },
    async execArgv() { return { exitCode: 0 }; },
    async execShell(input) { shells.push(input.shell); return { exitCode: 0, signal: null }; },
  };
  const windows = createRecoveryActionRegistry({ executor, inventory: async () => ({ block: { devices: [] } }), platform: "win32" });
  await windows.run("shell.exec", { script: "Get-Date" });
  assert.equal(shells.at(-1), "powershell");
  const linux = createRecoveryActionRegistry({ executor, inventory: async () => ({ block: { devices: [] } }), platform: "linux" });
  await linux.run("shell.exec", { script: "date" });
  assert.equal(shells.at(-1), "/bin/bash");
});

test("recovery actions on linux still hibernate through systemctl", async () => {
  const calls = [];
  const executor = {
    async toolExists() { return true; },
    async resolveTool(tool) { return `/usr/bin/${tool}`; },
    async execArgv(input) {
      calls.push(input);
      return { exitCode: 0, signal: null, file: input.file, args: input.args, stdoutTail: "", stderrTail: "" };
    },
    async execShell() { return { exitCode: 0, signal: null }; },
  };
  const registry = createRecoveryActionRegistry({
    executor,
    inventory: async () => ({ block: { devices: [] } }),
    platform: "linux",
  });
  await registry.run("power.hibernate", {});
  assert.equal(calls.at(-1).file, "systemctl");
  assert.deepEqual(calls.at(-1).args, ["hibernate"]);
});

test("recovery inventory parses Windows disk, partition, and volume JSON", () => {
  const parsed = parseWindowsDisks(
    JSON.stringify([{ Number: 0, FriendlyName: "SSD 1TB", SerialNumber: "S1", Size: 1000204886016, PartitionStyle: "MBR", BusType: "SATA" }]),
    JSON.stringify([
      { DiskNumber: 0, PartitionNumber: 1, DriveLetter: "C", Size: 429496729600, Offset: 1048576, Type: "IFS" },
      { DiskNumber: 0, PartitionNumber: 2, DriveLetter: "", Size: 500, Offset: 0, Type: "Unknown" },
    ]),
    JSON.stringify({ DriveLetter: "C", FileSystemLabel: "WINDOWS", FileSystem: "NTFS", Size: 429496729600, SizeRemaining: 100, HealthStatus: "Healthy" }),
  );
  const disk = parsed.devices.find((device) => device.type === "disk");
  assert.equal(disk.path, "\\\\.\\PHYSICALDRIVE0");
  assert.equal(disk.model, "SSD 1TB");
  assert.equal(disk.partitionTableType, "mbr");
  assert.ok(disk.deviceId.startsWith("disk:"));
  const partition = parsed.devices.find((device) => device.path === "C:");
  assert.equal(partition.filesystemType, "ntfs");
  assert.equal(partition.filesystemLabel, "WINDOWS");
  assert.deepEqual(partition.mountpoints, ["C:\\"]);
  assert.equal(partition.parent, "\\\\.\\PHYSICALDRIVE0");
  assert.equal(parsed.edges.length, 2);
});

test("recovery inventory collector produces a normalized Windows snapshot", async () => {
  const outputs = {
    systeminfo: "\"Host Name\",\"OS Name\"\n\"SAKURA\",\"Microsoft Windows 10 Pro\"\n",
    ipconfig: "Windows IP Configuration\n",
    powershell: "",
  };
  const powershellOutputs = [
    JSON.stringify([{ Number: 0, FriendlyName: "SSD 1TB", SerialNumber: "S1", Size: 1000, PartitionStyle: "MBR", BusType: "SATA" }]),
    JSON.stringify([{ DiskNumber: 0, PartitionNumber: 1, DriveLetter: "C", Size: 400, Offset: 1, Type: "IFS" }]),
    JSON.stringify([{ DriveLetter: "C", FileSystemLabel: "WINDOWS", FileSystem: "NTFS", Size: 400 }]),
    JSON.stringify([{ Name: "Ethernet", MacAddress: "18-03-73-2E-3F-42", Status: "Up" }]),
    "Legacy\n",
  ];
  let powershellCall = 0;
  const executor = {
    async toolExists() { return true; },
    async resolveTool(tool) { return `C:\\Windows\\System32\\${tool}.exe`; },
    async execArgv({ file, onEvent }) {
      const stdout = file === "powershell" ? powershellOutputs[powershellCall++] : outputs[file] || "";
      onEvent?.({ type: "output", stream: "stdout", data: Buffer.from(stdout).toString("base64"), encoding: "base64" });
      return { exitCode: 0, signal: null };
    },
  };
  const collector = createRecoveryInventoryCollector({ executor, platform: "win32" });
  const inventory = await collector.collect({ identity: { agentId: "wwra_windows" } });
  assert.equal(inventory.system.platform, "win32");
  assert.equal(inventory.firmware.uefi, false);
  assert.equal(inventory.block.devices.length, 2);
  assert.equal(inventory.block.filesystems[0].label, "WINDOWS");
  assert.equal(inventory.block.mounts[0].target, "C:\\");
  assert.equal(inventory.network.interfaces[0].MacAddress, "18-03-73-2E-3F-42");
  assert.equal(inventory.errors.length, 0);
});
