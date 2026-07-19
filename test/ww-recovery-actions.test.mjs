import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPLETE_ACTION_NAMES,
  createRecoveryActionRegistry,
  parseDdrescueProgress,
} from "../lib/recovery/ww-recovery-actions.mjs";

function setup() {
  const calls = [];
  const executor = {
    async toolExists() { return true; },
    async resolveTool(tool) { return `/usr/bin/${tool}`; },
    async execArgv(input) {
      calls.push(input);
      input.onEvent?.({
        type: "command",
        file: `/usr/bin/${input.file}`,
        args: input.args,
        force: input.force,
      });
      return {
        exitCode: 0,
        signal: null,
        file: `/usr/bin/${input.file}`,
        args: input.args,
        stdoutTail: input.file === "sha256sum" ? `${"a".repeat(64)}  sample.bin\n` : "",
        stderrTail: "",
      };
    },
    async execShell(input) {
      calls.push(input);
      return { exitCode: 0, signal: null };
    },
  };
  const snapshot = {
    block: {
      devices: [
        { deviceId: "disk_alpha", canonicalPath: "/dev/test-a", path: "/dev/test-a", model: "Alpha", serial: "A", size: 1000, type: "disk", byId: ["/dev/disk/by-id/alpha"] },
        { deviceId: "disk_beta", canonicalPath: "/dev/test-b", path: "/dev/test-b", model: "Beta", serial: "B", size: 2000, type: "disk", byId: ["/dev/disk/by-id/beta"] },
      ],
    },
  };
  const registry = createRecoveryActionRegistry({
    executor,
    inventory: async () => structuredClone(snapshot),
  });
  return { calls, registry };
}

test("recovery action registry exposes the complete machine-readable catalog", () => {
  const { registry } = setup();
  assert.equal(registry.list().length, COMPLETE_ACTION_NAMES.length);
  for (const name of COMPLETE_ACTION_NAMES) {
    assert.equal(registry.has(name), true, name);
    const descriptor = registry.describe(name);
    assert.equal(descriptor.name, name);
    assert.equal(typeof descriptor.mutates, "boolean");
    assert.ok(Array.isArray(descriptor.requiredTools));
  }
  assert.equal(registry.describe("missing"), null);
});

test("recovery actions preserve exact raw argv and unrestricted shell", async () => {
  const { calls, registry } = setup();
  await registry.run("command.exec", {
    argv: ["printf", "%s", "one two", "$(not-interpreted)"],
    timeoutMs: 0,
    force: true,
  });
  assert.equal(calls[0].file, "printf");
  assert.deepEqual(calls[0].args, ["%s", "one two", "$(not-interpreted)"]);
  assert.equal(calls[0].timeoutMs, 0);
  assert.equal(calls[0].force, true);

  await registry.run("shell.exec", { script: "printf one\nprintf two", force: true });
  assert.equal(calls[1].script, "printf one\nprintf two");
  assert.equal(calls[1].force, true);
});

test("recovery disk identity mismatch fails normally and explicit force overrides it", async () => {
  const { calls, registry } = setup();
  await assert.rejects(
    registry.run("disk.table.create", {
      deviceId: "disk_alpha",
      path: "/dev/test-b",
      label: "gpt",
    }),
    (error) => error.code === "ERR_WW_RECOVERY_DEVICE_CHANGED",
  );
  const result = await registry.run("disk.table.create", {
    deviceId: "disk_alpha",
    path: "/dev/test-b",
    label: "gpt",
    force: true,
  });
  assert.equal(result.force, true);
  assert.deepEqual(calls.at(-1).args, ["-s", "/dev/test-b", "mklabel", "gpt"]);
});

test("recovery filesystem recipes and destructive force reach exact native argv", async () => {
  const { calls, registry } = setup();
  const result = await registry.run("filesystem.repair", {
    deviceId: "disk_alpha",
    filesystemType: "ext4",
    force: true,
    extraArgs: ["-C", "0"],
  });
  assert.equal(result.mutates, true);
  assert.equal(calls.at(-1).file, "e2fsck");
  assert.deepEqual(calls.at(-1).args, ["-f", "-y", "-C", "0", "/dev/test-a"]);
  assert.equal(calls.at(-1).force, true);
});

test("recovery disk sampling hashes unique head, middle, and tail regions with resolved identity", async () => {
  const { calls, registry } = setup();
  const events = [];
  const result = await registry.run("disk.read.sample", {
    deviceId: "disk_alpha",
    blockSize: 100,
    count: 1,
  }, { onEvent: (event) => events.push(event) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.samples.map((sample) => sample.offsetBlocks), [0, 5, 9]);
  assert.ok(result.samples.every((sample) => sample.hash === `sha256:${"a".repeat(64)}`));
  assert.deepEqual(calls.filter((call) => call.file === "dd").map((call) => call.args.find((arg) => arg.startsWith("skip="))), ["skip=0", "skip=5", "skip=9"]);
  const command = events.find((event) => event.type === "step.command" && event.command.file.endsWith("/dd"));
  assert.equal(command.device.deviceId, "disk_alpha");
  assert.equal(command.device.path, "/dev/test-a");
});

test("partition-table backup captures text, JSON, GPT, and both disk edges", async () => {
  const { calls, registry } = setup();
  const result = await registry.run("disk.table.backup", {
    deviceId: "disk_beta",
    outputDir: "/tmp/workwire-backup-test",
    upload: false,
  });
  assert.equal(result.ok, true);
  assert.ok(result.files.some((filename) => filename.endsWith(".sfdisk")));
  assert.ok(result.files.some((filename) => filename.endsWith(".sfdisk.json")));
  assert.ok(result.files.some((filename) => filename.endsWith(".gpt")));
  assert.ok(result.files.some((filename) => filename.endsWith(".head.bin")));
  assert.ok(result.files.some((filename) => filename.endsWith(".tail.bin")));
  const ddCalls = calls.filter((call) => call.file === "dd");
  assert.equal(ddCalls.length, 2);
  assert.ok(ddCalls[1].args.some((argument) => argument.startsWith("skip=")));
});

test("ddrescue status parser preserves progress and errors", () => {
  const parsed = parseDdrescueProgress(`
ipos: 1048 MB, non-trimmed: 0 B, current rate: 20 MB/s
opos: 1048 MB, non-scraped: 0 B, average rate: 18 MB/s
rescued: 999 MB, errsize: 4096 B, errors: 2
remaining time: 12s, current pass: 2
`);
  assert.equal(parsed.rescued, "999 MB");
  assert.equal(parsed.errorSize, "4096 B");
  assert.equal(parsed.errors, 2);
  assert.equal(parsed.pass, 2);
});

test("filesystem.create uses per-tool force and label flags", async () => {
  const { calls, registry } = setup();
  await registry.run("filesystem.create", {
    path: "/dev/test-a", filesystemType: "vfat", label: "WW_EFI", force: true,
  });
  assert.equal(calls[0].file, "mkfs.fat");
  // mkfs.fat has no force flag (-F selects FAT size) and labels with -n.
  assert.deepEqual(calls[0].args, ["-n", "WW_EFI", "/dev/test-a"]);

  await registry.run("filesystem.create", {
    path: "/dev/test-b", filesystemType: "ext4", label: "root", force: true,
  });
  assert.equal(calls[1].file, "mkfs.ext4");
  assert.deepEqual(calls[1].args, ["-F", "-L", "root", "/dev/test-b"]);
});
