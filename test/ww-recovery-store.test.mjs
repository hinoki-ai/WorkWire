import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createRecoveryStore } from "../lib/recovery/ww-recovery-store.mjs";

async function withStore(run) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-store-"));
  const store = createRecoveryStore({ stateDir });
  await store.init();
  try {
    return await run(store, stateDir);
  } finally {
    await store.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

test("recovery store persists agents, cases, jobs, inventory, and ordered events", async () => {
  await withStore(async (store, stateDir) => {
    await store.upsertAgent({ agentId: "wwra_alpha", hostname: "patient-01", bootId: "boot-a" });
    await store.writeInventory("wwra_alpha", { collectedAt: new Date().toISOString(), block: { devices: [] } });
    const caseRecord = await store.createCase({
      id: "wwc_storecase",
      targetAgentId: "wwra_alpha",
      goal: "Inspect disks",
    });
    const job = await store.createJob(caseRecord.id, {
      id: "wwj_storejob",
      steps: [{ id: "step_inventory", action: "inventory.collect" }],
    });
    await store.transitionJob(job.id, "leased", { leaseOwner: "session-a" });
    await store.transitionJob(job.id, "running");
    await Promise.all(Array.from({ length: 250 }, (_, index) => store.appendJobEvent(job.id, {
      type: "step.progress",
      stepId: "step_inventory",
      progress: index,
    })));
    await store.transitionJob(job.id, "succeeded", { result: { ok: true } });

    const events = await store.readCaseEvents(caseRecord.id);
    assert.deepEqual(events.map((event) => event.seq), Array.from({ length: events.length }, (_, index) => index + 1));
    assert.equal(store.getJob(job.id).state, "succeeded");
    assert.equal((await store.readInventory("wwra_alpha")).block.devices.length, 0);
    assert.equal(await fs.readFile(path.join(stateDir, "cases", caseRecord.id, "jobs", job.id, "result.json"), "utf8").then(JSON.parse).then((value) => value.ok), true);
  });
});

test("recovery store deduplicates replayed agent events and records exact output", async () => {
  await withStore(async (store, stateDir) => {
    await store.upsertAgent({ agentId: "wwra_alpha", hostname: "patient" });
    const caseRecord = await store.createCase({ id: "wwc_replaycase", targetAgentId: "wwra_alpha" });
    const job = await store.createJob(caseRecord.id, {
      id: "wwj_replayjob",
      steps: [{ id: "step_exec", action: "command.exec" }],
    });
    const event = {
      type: "step.output",
      stepId: "step_exec",
      stream: "stdout",
      data: "exact output\n",
      encoding: "utf8",
      agentId: "wwra_alpha",
      bootId: "boot-a",
      agentSeq: 7,
    };
    const first = await store.appendJobEvent(job.id, event);
    const duplicate = await store.appendJobEvent(job.id, event);
    assert.equal(first.seq, duplicate.seq);
    const matching = (await store.readCaseEvents(caseRecord.id)).filter((candidate) => candidate.agentSeq === 7);
    assert.equal(matching.length, 1);
    assert.equal(
      await fs.readFile(path.join(stateDir, "cases", caseRecord.id, "jobs", job.id, "stdout.log"), "utf8"),
      "exact output\n",
    );
  });
});

test("recovery store recovers running jobs and partial artifacts after restart", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-restart-"));
  let store = createRecoveryStore({ stateDir });
  await store.init();
  try {
    await store.upsertAgent({ agentId: "wwra_alpha", hostname: "patient" });
    const caseRecord = await store.createCase({ id: "wwc_restartcase", targetAgentId: "wwra_alpha" });
    const job = await store.createJob(caseRecord.id, {
      id: "wwj_restartjob",
      steps: [{ id: "step_shell", action: "shell.exec" }],
    });
    await store.transitionJob(job.id, "leased");
    await store.transitionJob(job.id, "running");
    const artifact = await store.createArtifact({
      id: "wwa_partialartifact",
      caseId: caseRecord.id,
      jobId: job.id,
      kind: "user-upload",
      filename: "partial.bin",
    });
    const writer = await store.openArtifactWrite(artifact.id);
    writer.stream.end(Buffer.from("partial"));
    await once(writer.stream, "close");
    await store.close();

    store = createRecoveryStore({ stateDir });
    await store.init();
    const recovered = await store.recoverInterruptedState();
    assert.equal(recovered.length, 1);
    assert.equal(store.getJob(job.id).state, "interrupted");
    assert.equal(store.getArtifact(artifact.id).complete, false);
    assert.equal((await fs.stat(store.resolveArtifactPath(artifact.id, { partial: true }))).size, 7);
  } finally {
    await store.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("recovery store rejects path traversal identifiers", async () => {
  await withStore(async (store) => {
    assert.throws(() => store.getAgent("../../etc/passwd"), /Invalid recovery agent id/);
    await assert.rejects(
      store.createCase({ id: "../outside", targetAgentId: "wwra_alpha" }),
      /Invalid recovery case id/,
    );
  });
});
