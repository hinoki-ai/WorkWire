import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const probe = `
  const { startPerformanceSpan } = await import("./lib/ww-performance.mjs");
  const span = startPerformanceSpan("test.operation", {
    route: "/v1/ping",
    token: "diagnostic-secret-value",
    command: "sensitive command contents",
  });
  span?.end({ ok: true });
`;

test("ww performance diagnostics are disabled by default", async () => {
  const { stderr } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: process.cwd(),
    env: { ...process.env, WW_PERF_DIAGNOSTICS: "0" },
  });
  assert.equal(stderr, "");
});

test("ww performance diagnostics are structured and redact sensitive fields", async () => {
  const { stderr } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: process.cwd(),
    env: { ...process.env, WW_PERF_DIAGNOSTICS: "1" },
  });
  assert.match(stderr, /^\[ww:performance\] /);
  assert.match(stderr, /"route":"\/v1\/ping"/);
  assert.match(stderr, /"token":"\[redacted\]"/);
  assert.match(stderr, /"command":"\[redacted\]"/);
  assert.doesNotMatch(stderr, /diagnostic-secret-value|sensitive command contents/);
});
