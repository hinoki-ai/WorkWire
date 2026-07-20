import test from "node:test";
import assert from "node:assert/strict";

import {
  createWindowsFileServiceWatchdog,
  probeWindowsFileService,
  restartWindowsFileServiceTask,
} from "../lib/recovery/ww-recovery-file-service-watchdog.mjs";

test("Windows recovery agent validates the local WorkWire file identity", async () => {
  const result = await probeWindowsFileService({
    platform: "win32",
    async fetchImpl(url, options) {
      assert.equal(url, "http://127.0.0.1:4851/v1/discover");
      assert.ok(options.signal);
      return {
        ok: true,
        async json() {
          return { service: { machineId: "windows-file-id", versions: { protocol: 1, app: "0.1.0+test" } } };
        },
      };
    },
  });
  assert.deepEqual(result, {
    ok: true,
    action: "healthy",
    machineId: "windows-file-id",
    version: "0.1.0+test",
  });
});

test("Windows recovery agent restarts the exact file task after bounded probe failures", async () => {
  let probes = 0;
  let restarts = 0;
  const messages = [];
  const watchdog = createWindowsFileServiceWatchdog({
    platform: "win32",
    failureThreshold: 3,
    restartCooldownMs: 0,
    async maintenanceImpl() { return { active: false }; },
    async probeImpl() {
      probes += 1;
      throw new Error("port 4851 timed out");
    },
    async restartImpl() {
      restarts += 1;
      return { ok: true, action: "restarted", state: "Running" };
    },
    log(message) { messages.push(message); },
  });

  await watchdog.probeNow();
  await watchdog.probeNow();
  assert.equal(restarts, 0);
  await watchdog.probeNow();
  assert.equal(probes, 3);
  assert.equal(restarts, 1);
  assert.match(messages[0], /restarted.*unresponsive/i);
  assert.equal(watchdog.getStatus().consecutiveFailures, 0);
});

test("Windows file-service restart uses only the exact scheduled task", async () => {
  let invocation = null;
  const result = await restartWindowsFileServiceTask({
    platform: "win32",
    execFileImpl(file, args, options, callback) {
      invocation = { file, args, options };
      callback(null, '{"ok":true,"action":"restarted","state":"Running"}\r\n', "");
    },
  });
  assert.equal(result.action, "restarted");
  assert.equal(invocation.file, "powershell.exe");
  assert.match(invocation.args.at(-1), /Stop-ScheduledTask -TaskName 'WorkWire Serve'/);
  assert.match(invocation.args.at(-1), /Start-ScheduledTask -TaskName 'WorkWire Serve'/);
  assert.equal(invocation.options.windowsHide, true);
});
