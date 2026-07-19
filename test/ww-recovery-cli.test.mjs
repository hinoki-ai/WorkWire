import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  parseRecoveryArgv,
  runRecoveryCli,
  WW_RECOVERY_HELP_TEXT,
} from "../lib/recovery/ww-recovery-cli.mjs";

function outputCapture() {
  const chunks = [];
  return {
    stream: { write(value) { chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value))); } },
    text() { return Buffer.concat(chunks).toString("utf8"); },
  };
}

const config = {
  version: 1,
  enabled: true,
  host: "127.0.0.1",
  port: 4852,
  bootHost: "127.0.0.1",
  bootPort: 4853,
  advertisedHost: "",
  token: "",
  stateDir: path.join(os.tmpdir(), "ww-recovery-cli-state"),
  heartbeatMs: 5000,
  staleAfterMs: 15000,
  offlineAfterMs: 30000,
  jobLeaseMs: 30000,
  maxJsonBytes: 4194304,
  maxArtifactBytes: 0,
  planner: { enabled: false, command: [], maxIterations: 100, iterationTimeoutMs: 0 },
  pxe: { enabled: false, interface: "", proxyDhcp: true, tftpRoot: "/tmp/tftp", bootRoot: "/tmp/boot" },
  extensions: {},
};

test("recovery CLI parser preserves every argv token after --", () => {
  const parsed = parseRecoveryArgv([
    "exec", "wwra_alpha", "--timeout", "0", "--force", "--",
    "printf", "%s", "one two", "$(literal)", "--not-a-local-flag",
  ]);
  assert.equal(parsed.command, "exec");
  assert.deepEqual(parsed.positionals, ["wwra_alpha"]);
  assert.equal(parsed.flags.timeout, "0");
  assert.equal(parsed.flags.force, true);
  assert.deepEqual(parsed.passthrough, ["printf", "%s", "one two", "$(literal)", "--not-a-local-flag"]);
});

test("recovery CLI exposes controller and complete engineering help", async () => {
  const stdout = outputCapture();
  await runRecoveryCli({
    argv: ["help"],
    stdout: stdout.stream,
    loadConfigImpl: async () => config,
  });
  assert.equal(stdout.text(), WW_RECOVERY_HELP_TEXT);
  assert.match(stdout.text(), /recovery exec AGENT/);
  assert.match(stdout.text(), /recovery pxe install\|prepare\|start\|status\|stop/);
});

test("recovery CLI agents and inspect produce human and JSON results", async () => {
  const stdout = outputCapture();
  const client = {
    async listAgents() { return [{ agentId: "wwra_alpha", hostname: "patient", state: "online", addresses: [] }]; },
    async requestInventory() { return { requested: true }; },
    async getAgent() {
      return {
        agent: { agentId: "wwra_alpha", hostname: "patient", state: "online" },
        inventory: {
          block: { devices: [{ deviceId: "disk_alpha", canonicalPath: "/dev/test", size: 1024, type: "disk", filesystemType: "ext4", mountpoints: ["/mnt"] }] },
          health: { smart: [], nvme: [] },
          errors: [],
        },
      };
    },
  };
  await runRecoveryCli({
    argv: ["agents"],
    stdout: stdout.stream,
    loadConfigImpl: async () => config,
    createClientImpl: () => client,
  });
  assert.match(stdout.text(), /ONLINE\s+patient/);

  const raw = outputCapture();
  await runRecoveryCli({
    argv: ["inspect", "wwra_alpha", "--refresh", "--json"],
    stdout: raw.stream,
    loadConfigImpl: async () => config,
    createClientImpl: () => client,
  });
  const value = JSON.parse(raw.text());
  assert.equal(value.agent.agentId, "wwra_alpha");
  assert.equal(value.inventory.block.devices[0].deviceId, "disk_alpha");
});

test("recovery CLI exec submits exact argv, force, and timeout then streams output", async () => {
  const stdout = outputCapture();
  const stderr = outputCapture();
  let submitted = null;
  const client = {
    async createJob(input) { submitted = input; return { id: "wwj_cli" }; },
    async getJob() {
      return {
        job: { id: "wwj_cli", state: "succeeded", result: { steps: [{ result: { exitCode: 0 } }] } },
        events: [{ seq: 1, type: "step.output", stream: "stdout", data: "exact-output", encoding: "utf8" }],
      };
    },
  };
  const processImpl = { exitCode: null, once() {}, off() {}, exit() {} };
  await runRecoveryCli({
    argv: ["exec", "wwra_alpha", "--timeout", "0", "--force", "--", "printf", "%s", "one two", "$(literal)"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    processImpl,
    loadConfigImpl: async () => config,
    createClientImpl: () => client,
  });
  assert.deepEqual(submitted.steps[0].params.argv, ["printf", "%s", "one two", "$(literal)"]);
  assert.equal(submitted.steps[0].timeoutMs, 0);
  assert.equal(submitted.steps[0].force, true);
  assert.equal(submitted.force, true);
  assert.equal(stdout.text(), "exact-output");
  assert.equal(processImpl.exitCode, 0);
});

test("recovery CLI finite --json commands emit one JSON result instead of event JSONL", async () => {
  const stdout = outputCapture();
  const stderr = outputCapture();
  const client = {
    async createJob() { return { id: "wwj_json" }; },
    async getJob() {
      return {
        job: { id: "wwj_json", state: "succeeded", result: { steps: [{ result: { exitCode: 0, stdoutTail: "json-output" } }] } },
        events: [{ seq: 1, type: "step.output", stream: "stdout", data: "json-output", encoding: "utf8" }],
      };
    },
  };
  await runRecoveryCli({
    argv: ["exec", "wwra_alpha", "--json", "--", "printf", "json-output"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    processImpl: { exitCode: null, once() {}, off() {}, exit() {} },
    loadConfigImpl: async () => config,
    createClientImpl: () => client,
  });
  const lines = stdout.text().trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).job.id, "wwj_json");
  assert.equal(stderr.text(), "");
});

test("recovery CLI controller start is injectable and returns a coordinated shutdown", async () => {
  const stdout = outputCapture();
  let stopped = 0;
  const result = await runRecoveryCli({
    argv: ["controller", "start", "--host", "127.0.0.1", "--port", "0"],
    stdout: stdout.stream,
    stderr: outputCapture().stream,
    keepAlive: false,
    processImpl: { pid: 123, once() {}, exit() {} },
    fsImpl: {
      async mkdir() {},
      async writeFile() {},
      async rm() {},
    },
    loadConfigImpl: async () => config,
    createControllerImpl({ config: received }) {
      assert.equal(received.host, "127.0.0.1");
      assert.equal(received.port, 0);
      return {
        async start() { return { url: "http://127.0.0.1:5000", boot: { url: "http://127.0.0.1:5001" } }; },
        async stop() { stopped += 1; },
      };
    },
  });
  assert.match(stdout.text(), /Recovery controller listening/);
  await result.shutdown();
  assert.equal(stopped, 1);
});
