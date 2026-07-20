import test from "node:test";
import assert from "node:assert/strict";
import {
  createWindowsRecoveryAgentCompanionWatchdog,
  probeWindowsRecoveryAgentCompanion,
} from "../lib/recovery/ww-recovery-companion-watchdog.mjs";

test("Windows file service companion probe starts the exact stopped recovery task", async () => {
  let invocation = null;
  const result = await probeWindowsRecoveryAgentCompanion({
    platform: "win32",
    execFileImpl(file, args, options, callback) {
      invocation = { file, args, options };
      callback(null, '{"ok":true,"action":"started","state":"Ready"}\r\n', "");
    },
  });
  assert.equal(result.action, "started");
  assert.equal(invocation.file, "powershell.exe");
  assert.match(invocation.args.at(-1), /WorkWire Recovery Agent/);
  assert.equal(invocation.options.windowsHide, true);
});

test("recovery companion watchdog probes immediately, prevents overlap, and stops cleanly", async () => {
  let probes = 0;
  let intervalCallback = null;
  let cleared = null;
  const messages = [];
  const watchdog = createWindowsRecoveryAgentCompanionWatchdog({
    platform: "win32",
    intervalMs: 5_000,
    async probeImpl() {
      probes += 1;
      return { ok: true, action: probes === 1 ? "started" : "running", state: "Running" };
    },
    setIntervalImpl(callback, delay) {
      intervalCallback = callback;
      assert.equal(delay, 5_000);
      return { unref() {} };
    },
    clearIntervalImpl(timer) { cleared = timer; },
    log(message) { messages.push(message); },
  });
  watchdog.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1);
  assert.match(messages[0], /restarted/i);
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 2);
  watchdog.stop();
  assert.ok(cleared);
  assert.equal(watchdog.getStatus().stopped, true);
});
