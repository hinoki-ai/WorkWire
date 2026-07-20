import test from "node:test";
import assert from "node:assert/strict";
import { createRecoveryExecutor } from "../lib/recovery/ww-recovery-executor.mjs";
import { decodeOutputChunk } from "../lib/recovery/ww-recovery-protocol.mjs";

test("recovery executor preserves argv, force, output streams, and nonzero status", async () => {
  const executor = createRecoveryExecutor();
  const events = [];
  const result = await executor.execArgv({
    file: process.execPath,
    args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"],
    force: true,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.force, true);
  assert.equal(result.stdoutTail, "out");
  assert.equal(result.stderrTail, "err");
  assert.equal(events[0].type, "command");
  assert.deepEqual(events[0].args, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"]);
  assert.equal(events.filter((event) => event.type === "output" && event.stream === "stdout").map(decodeOutputChunk).join(""), "out");
});

test("recovery executor supports unrestricted multiline native shell and binary stdout", async () => {
  const executor = createRecoveryExecutor();
  const chunks = [];
  const result = await executor.execShell({
    script: process.platform === "win32"
      ? "$b=[byte[]](108,105,110,101,32,111,110,101,10,255,0);[Console]::OpenStandardOutput().Write($b,0,$b.Length)"
      : "printf 'line one\\n'; printf '\\377\\000'",
    timeoutMs: 0,
    onEvent(event) {
      if (event.type === "output" && event.stream === "stdout") chunks.push(decodeOutputChunk(event));
    },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.from("line one\n"), Buffer.from([0xff, 0x00])]));
});

test("recovery executor enforces timeout and cancels a process group", async () => {
  const executor = createRecoveryExecutor({ cancelGraceMs: 50 });
  const result = await executor.execArgv({
    file: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 40,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.signal, null);

  let executionId = "";
  const running = executor.execArgv({
    file: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 0,
    onEvent(event) {
      if (event.type === "command") executionId = event.executionId;
    },
  });
  while (!executionId) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.cancelExecution(executionId, "test-cancel"), true);
  const canceled = await running;
  assert.equal(canceled.canceled, true);
  assert.equal(canceled.cancelReason, "test-cancel");
});

test("recovery executor reports missing tools without shell interpretation", async () => {
  const executor = createRecoveryExecutor();
  await assert.rejects(
    executor.execArgv({ file: "definitely-not-a-real-workwire-tool", args: ["$(touch nope)"] }),
    (error) => error.code === "ERR_WW_RECOVERY_TOOL_MISSING",
  );
});
