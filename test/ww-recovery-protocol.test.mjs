import test from "node:test";
import assert from "node:assert/strict";
import {
  assertValidAgentHello,
  assertValidJob,
  createCase,
  createEvent,
  createJob,
  decodeOutputChunk,
  encodeOutputChunk,
  isTerminalJobState,
  transitionCaseState,
  transitionJobState,
} from "../lib/recovery/ww-recovery-protocol.mjs";

function sampleJob() {
  return createJob({
    id: "wwj_testjob",
    caseId: "wwc_testcase",
    targetAgentId: "wwra_testagent",
    steps: [{ id: "step_inventory", action: "inventory.collect", timeoutMs: 0 }],
    force: true,
  });
}

test("recovery protocol preserves force, unlimited timeout, and arbitrary JSON params", () => {
  const job = createJob({
    caseId: "wwc_testcase",
    targetAgentId: "wwra_testagent",
    force: true,
    mode: "autonomous-unrestricted",
    steps: [{
      id: "step_shell",
      action: "shell.exec",
      timeoutMs: 0,
      force: true,
      params: { script: "printf '%s' hello", future: [null, { any: true }] },
    }],
  });
  assert.equal(job.force, true);
  assert.equal(job.steps[0].force, true);
  assert.equal(job.steps[0].timeoutMs, 0);
  assert.deepEqual(job.steps[0].params.future, [null, { any: true }]);
});

test("recovery protocol validates agent hello and rejects malformed shapes", () => {
  const hello = assertValidAgentHello({
    type: "agent.hello",
    protocol: 1,
    agentId: "wwra_testagent",
    bootId: "boot-uuid",
    hostname: "patient",
    capabilities: { root: true },
  });
  assert.equal(hello.agentId, "wwra_testagent");
  assert.throws(() => assertValidAgentHello(null), /protocol/i);
  assert.throws(() => assertValidAgentHello({ protocol: 1, agentId: "../bad", bootId: "x" }), /Invalid/);
  assert.throws(() => assertValidJob([]), /object/);
  assert.throws(() => createJob({
    caseId: "wwc_testcase",
    targetAgentId: "wwra_testagent",
    steps: [
      { id: "same_step", action: "inventory.collect" },
      { id: "same_step", action: "inventory.collect" },
    ],
  }), /Duplicate/);
});

test("recovery job and case state transitions enforce every terminal edge", () => {
  let job = sampleJob();
  job = transitionJobState(job, "leased");
  job = transitionJobState(job, "running");
  job = transitionJobState(job, "succeeded");
  assert.equal(isTerminalJobState(job.state), true);
  assert.throws(() => transitionJobState(job, "running"), /Invalid recovery job transition/);

  let retry = transitionJobState(
    transitionJobState(transitionJobState(sampleJob(), "leased"), "interrupted"),
    "queued",
  );
  assert.equal(retry.state, "queued");
  retry = transitionJobState(retry, "canceled");
  assert.throws(() => transitionJobState(retry, "queued"), /Invalid/);

  let caseRecord = createCase({ id: "wwc_caseflow", targetAgentId: "wwra_testagent" });
  caseRecord = transitionCaseState(caseRecord, "running");
  caseRecord = transitionCaseState(caseRecord, "stopped");
  caseRecord = transitionCaseState(caseRecord, "running");
  caseRecord = transitionCaseState(caseRecord, "completed");
  assert.throws(() => transitionCaseState(caseRecord, "running"), /Invalid/);
});

test("recovery output encoding round-trips UTF-8 and binary bytes", () => {
  const utf8 = encodeOutputChunk(Buffer.from("Sakura ↔ HINOKI\n"));
  assert.equal(utf8.encoding, "utf8");
  assert.equal(decodeOutputChunk(utf8).toString("utf8"), "Sakura ↔ HINOKI\n");
  const binaryInput = Buffer.from([0xff, 0x00, 0xc3, 0x28]);
  const binary = encodeOutputChunk(binaryInput);
  assert.equal(binary.encoding, "base64");
  assert.deepEqual(decodeOutputChunk(binary), binaryInput);
  assert.equal(createEvent({ type: "step.output", data: binary.data, encoding: binary.encoding }).type, "step.output");
});
