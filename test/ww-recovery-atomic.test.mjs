import test from "node:test";
import assert from "node:assert/strict";
import { renameRecoveryFile } from "../lib/recovery/ww-recovery-atomic.mjs";

test("recovery atomic replacement retries transient Windows destination locks", async () => {
  const attempts = [];
  const delays = [];
  const fsImpl = {
    async rename(sourcePath, targetPath) {
      attempts.push([sourcePath, targetPath]);
      if (attempts.length < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
    },
  };

  await renameRecoveryFile(fsImpl, "state.tmp", "state.json", {
    platform: "win32",
    delayImpl: async (milliseconds) => delays.push(milliseconds),
  });

  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [5, 10]);
});

test("recovery atomic replacement does not hide non-transient failures", async () => {
  const failure = Object.assign(new Error("missing source"), { code: "ENOENT" });
  await assert.rejects(
    renameRecoveryFile({ rename: async () => { throw failure; } }, "missing", "target", {
      platform: "win32",
      delayImpl: async () => assert.fail("non-transient rename must not retry"),
    }),
    (error) => error === failure,
  );
});
