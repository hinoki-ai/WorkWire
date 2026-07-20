import test from "node:test";
import assert from "node:assert/strict";
import { createRecoveryActionRegistry, PLATFORM_ACTION_NAMES } from "../lib/recovery/ww-recovery-actions.mjs";
import { buildPlatformActionCapabilityMatrix } from "../lib/recovery/ww-recovery-capabilities.mjs";
import { WINDOWS_CAPABILITY_TOOLS } from "../lib/recovery/ww-recovery-platform.mjs";

function registryFor(platform) {
  const calls = [];
  const executor = {
    async toolExists() { return true; },
    async resolveTool(tool) { return tool; },
    async execArgv(input) { calls.push(input); return { exitCode: 0, file: input.file, args: input.args, stdoutTail: "", stderrTail: "" }; },
    async execShell(input) { calls.push(input); return { exitCode: 0 }; },
  };
  const inventory = async () => ({ collectedAt: new Date().toISOString(), block: { devices: [] }, errors: [] });
  return { calls, registry: createRecoveryActionRegistry({ executor, inventory, platform }) };
}

test("Windows recovery adapters preserve native BCD, event, BitLocker, DISM, service, storage, and network argv", async () => {
  const { calls, registry } = registryFor("win32");
  for (const name of PLATFORM_ACTION_NAMES.filter((name) => name.startsWith("windows."))) assert.equal(registry.has(name), true, name);
  await registry.run("windows.boot.bcd.list", { scope: "all" });
  await registry.run("windows.eventlog.query", { log: "System", count: 25, query: "*[System/Level=2]" });
  await registry.run("windows.bitlocker.status", { volume: "C:" });
  await registry.run("windows.repair.dism", { scan: true, source: "D:\\sources\\install.wim" });
  assert.deepEqual(calls[0].args, ["/enum", "all", "/v"]);
  assert.ok(calls[1].args.includes("/q:*[System/Level=2]"));
  assert.deepEqual(calls[2].args, ["-status", "C:"]);
  assert.ok(calls[3].args.includes("/ScanHealth"));
  assert.ok(WINDOWS_CAPABILITY_TOOLS.includes("wevtutil"));
  assert.ok(WINDOWS_CAPABILITY_TOOLS.includes("manage-bde"));
  assert.ok(WINDOWS_CAPABILITY_TOOLS.includes("dism"));
});

test("Linux repair facts/actions and generated ARM64 matrix expose truthful native availability plus shell fallback", async () => {
  const { calls, registry } = registryFor("linux");
  for (const name of PLATFORM_ACTION_NAMES.filter((name) => name.startsWith("linux."))) assert.equal(registry.has(name), true, name);
  await registry.run("linux.logs.query", { unit: "fixture.service", priority: "warning", lines: 50 });
  await registry.run("linux.boot.status", {});
  assert.deepEqual(calls[0].args, ["--no-pager", "--output", "short-iso-precise", "--unit", "fixture.service", "--priority", "warning", "--lines", "50"]);
  assert.equal(calls[1].file, "/bin/bash");

  const tools = { bash: { available: true }, journalctl: { available: true }, ip: { available: false } };
  const matrix = buildPlatformActionCapabilityMatrix({ platform: "linux", architecture: "arm64", tools, actions: registry.list() });
  assert.equal(matrix.arm64, true);
  assert.equal(matrix.actions["linux.logs.query"].available, true);
  assert.equal(matrix.actions["linux.network.status"].available, false);
  assert.equal(matrix.actions["linux.network.status"].fallback.action, "shell.exec");
  assert.equal(matrix.actions["windows.repair.dism"].available, false);
  assert.match(matrix.actions["windows.repair.dism"].fallback.reason, /platform:win32/);
});

test("GPT restore accepts sgdisk pre-state exit 2 only after a clean machine verification", async () => {
  const calls = [];
  const executor = {
    async toolExists() { return true; },
    async resolveTool(tool) { return tool; },
    async execArgv(input) {
      calls.push(input);
      const restoring = input.file === "sgdisk" && input.args[0].startsWith("--load-backup=");
      return {
        exitCode: restoring ? 2 : 0,
        file: input.file,
        args: input.args,
        stdoutTail: restoring ? "The operation has completed successfully.\n" : "",
        stderrTail: "",
      };
    },
    async execShell(input) { calls.push(input); return { exitCode: 0 }; },
  };
  const inventory = async () => ({
    collectedAt: new Date().toISOString(),
    block: {
      devices: [{
        deviceId: "disk-fixture",
        path: "/dev/fixture",
        canonicalPath: "/dev/fixture",
        byId: ["/dev/disk/by-id/fixture"],
        model: "fixture",
        serial: "fixture-serial",
        size: 4 * 1024 ** 3,
        type: "disk",
      }],
    },
    errors: [],
  });
  const registry = createRecoveryActionRegistry({ executor, inventory, platform: "linux" });
  const result = await registry.run("disk.table.restore", {
    deviceId: "disk-fixture",
    backupPath: "/tmp/fixture.gpt",
    format: "sgdisk",
    force: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.commands[0].acceptedNonzero, {
    exitCode: 2,
    reason: "sgdisk restored the backup and the resulting GPT passed sgdisk --verify",
  });
  assert.deepEqual(calls.map(({ file, args }) => [file, args]), [
    ["sgdisk", ["--load-backup=/tmp/fixture.gpt", "/dev/fixture"]],
    ["sgdisk", ["--verify", "/dev/fixture"]],
    ["partprobe", ["/dev/fixture"]],
    ["udevadm", ["settle"]],
  ]);
});
