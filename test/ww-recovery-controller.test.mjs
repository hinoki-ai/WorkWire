import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createRecoveryController } from "../lib/recovery/ww-recovery-controller.mjs";
import { createRecoveryClient } from "../lib/recovery/ww-recovery-client.mjs";
import { createRecoveryArtifacts } from "../lib/recovery/ww-recovery-artifacts.mjs";

async function withController(run, overrides = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-controller-"));
  const controller = createRecoveryController({
    config: {
      stateDir,
      host: "127.0.0.1",
      port: 0,
      bootHost: "127.0.0.1",
      bootPort: 0,
      heartbeatMs: 100,
      staleAfterMs: 500,
      offlineAfterMs: 1000,
      ...overrides,
    },
  });
  const info = await controller.start();
  try {
    return await run(controller, info, stateDir);
  } finally {
    await controller.stop();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function connectAgent(info, agentId, { token = "", bootId = `${agentId}-boot` } = {}) {
  const url = `ws://127.0.0.1:${info.port}/v1/recovery/socket`;
  const socket = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  await once(socket, "open");
  const queue = [];
  const waiters = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index !== -1) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
    } else queue.push(message);
  });
  const next = (predicate = () => true, timeoutMs = 10_000) => {
    const index = queue.findIndex(predicate);
    if (index !== -1) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for agent message; queued ${JSON.stringify(queue)}.`)), timeoutMs);
      const waiter = {
        predicate,
        resolve(message) { clearTimeout(timer); resolve(message); },
      };
      waiters.push(waiter);
    });
  };
  socket.send(JSON.stringify({
    type: "agent.hello",
    protocol: 1,
    agentId,
    bootId,
    hostname: agentId,
    mode: "test",
    version: "0.1.0",
    startedAt: new Date().toISOString(),
    addresses: [{ name: "eth0", mac: "00:11:22:33:44:55", address: "127.0.0.1" }],
    capabilities: { root: true, rawShell: true, tools: {} },
  }));
  const welcome = await next((message) => message.type === "controller.welcome");
  return { socket, next, welcome, queue };
}

test("recovery controller stop drains active HTTP connections", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-shutdown-"));
  const controller = createRecoveryController({
    config: {
      stateDir,
      host: "127.0.0.1",
      port: 0,
      bootHost: "127.0.0.1",
      bootPort: 0,
      heartbeatMs: 100,
      staleAfterMs: 500,
      offlineAfterMs: 1_000,
    },
  });
  const info = await controller.start();
  const socket = net.createConnection({ host: "127.0.0.1", port: info.port });
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write("GET /v1/recovery/events HTTP/1.1\r\nHost: 127.0.0.1\r\n");

  const stopPromise = controller.stop();
  let timeout;
  try {
    await Promise.race([
      stopPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Recovery controller stop timed out.")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    socket.destroy();
    await stopPromise;
    await fs.rm(stateDir, { recursive: true, force: true });
  }

  assert.equal(socket.destroyed, true);
});

test("recovery controller routes separate durable jobs to two agents", async () => {
  await withController(async (controller, info) => {
    const client = createRecoveryClient({ url: `http://127.0.0.1:${info.port}` });
    assert.equal((await client.connect()).protocol, 1);
    const alpha = await connectAgent(info, "wwra_alpha");
    const beta = await connectAgent(info, "wwra_beta");
    assert.notEqual(alpha.welcome.sessionId, beta.welcome.sessionId);

    const alphaCase = await client.createCase({ targetAgentId: "wwra_alpha", goal: "Alpha command" });
    const betaCase = await client.createCase({ targetAgentId: "wwra_beta", goal: "Beta command" });
    const alphaJob = await client.createJob({
      caseId: alphaCase.id,
      targetAgentId: "wwra_alpha",
      steps: [{ id: "step_alpha", action: "command.exec", params: { argv: ["printf", "alpha"] } }],
    });
    const betaJob = await client.createJob({
      caseId: betaCase.id,
      targetAgentId: "wwra_beta",
      steps: [{ id: "step_beta", action: "command.exec", params: { argv: ["printf", "beta"] } }],
    });
    const alphaOffer = await alpha.next((message) => message.type === "controller.job.offer");
    const betaOffer = await beta.next((message) => message.type === "controller.job.offer");
    assert.equal(alphaOffer.job.id, alphaJob.id);
    assert.equal(betaOffer.job.id, betaJob.id);

    alpha.socket.send(JSON.stringify({ type: "agent.job.accept", jobId: alphaJob.id }));
    beta.socket.send(JSON.stringify({ type: "agent.job.accept", jobId: betaJob.id }));
    alpha.socket.send(JSON.stringify({
      type: "agent.job.event",
      jobId: alphaJob.id,
      agentSeq: 1,
      event: { type: "step.output", stepId: "step_alpha", stream: "stdout", data: "alpha", encoding: "utf8" },
    }));
    beta.socket.send(JSON.stringify({
      type: "agent.job.event",
      jobId: betaJob.id,
      agentSeq: 1,
      event: { type: "step.output", stepId: "step_beta", stream: "stderr", data: "beta", encoding: "utf8" },
    }));
    await alpha.next((message) => message.type === "controller.event.ack");
    await beta.next((message) => message.type === "controller.event.ack");
    alpha.socket.send(JSON.stringify({ type: "agent.job.result", jobId: alphaJob.id, agentSeq: 2, result: { ok: true, exitCode: 0 } }));
    beta.socket.send(JSON.stringify({ type: "agent.job.result", jobId: betaJob.id, agentSeq: 2, result: { ok: false, exitCode: 3 } }));
    await alpha.next((message) => message.type === "controller.result.ack");
    await beta.next((message) => message.type === "controller.result.ack");

    assert.equal((await client.getJob(alphaJob.id)).job.state, "succeeded");
    assert.equal((await client.getJob(betaJob.id)).job.state, "failed");
    const alphaEvents = await client.listEvents(alphaCase.id);
    assert.ok(alphaEvents.some((event) => event.type === "step.output" && event.data === "alpha"));
    const agents = await client.listAgents();
    assert.equal(agents.filter((agent) => agent.state === "online").length, 2);
    const machines = await client.listMacAddresses();
    assert.equal(machines.length, 1);
    assert.equal(machines[0].mac, "00:11:22:33:44:55");
    alpha.socket.close();
    beta.socket.close();
  }, { staleAfterMs: 15_000, offlineAfterMs: 30_000 });
});

test("socket receipt restores agent liveness before durable heartbeat work drains", async () => {
  await withController(async (controller, info) => {
    const client = createRecoveryClient({ url: `http://127.0.0.1:${info.port}` });
    const agent = await connectAgent(info, "wwra_receipt_liveness");
    let session = null;
    for (let attempt = 0; attempt < 100 && !session; attempt += 1) {
      session = controller.getConnectedAgent("wwra_receipt_liveness");
      if (!session) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(session);
    let releaseDurability;
    session.messageTail = new Promise((resolve) => { releaseDurability = resolve; });
    session.state = "stale";
    const previousSeenAt = session.lastSeenAt;
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      agent.socket.send(JSON.stringify({ type: "agent.heartbeat", agentSeq: 1, at: new Date().toISOString() }));
      for (let attempt = 0; attempt < 100 && session.lastSeenAt === previousSeenAt; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.notEqual(session.lastSeenAt, previousSeenAt);
      assert.equal(controller.getConnectedAgent("wwra_receipt_liveness"), session);
      assert.equal((await client.listAgents({ online: true })).some((record) => record.agentId === "wwra_receipt_liveness"), true);
    } finally {
      releaseDurability();
      await agent.next((message) => message.type === "controller.heartbeat.ack").catch(() => {});
      agent.socket.close();
    }
  });
});

test("recovery controller reconciles an interrupted result after it already marked the lease interrupted", async () => {
  await withController(async (controller, info) => {
    const client = createRecoveryClient({ url: `http://127.0.0.1:${info.port}` });
    const agent = await connectAgent(info, "wwra_interrupted_result");
    const caseRecord = await client.createCase({ targetAgentId: "wwra_interrupted_result", goal: "Interrupted command" });
    const job = await client.createJob({
      caseId: caseRecord.id,
      targetAgentId: "wwra_interrupted_result",
      steps: [{ id: "step_interrupt", action: "command.exec", params: { argv: ["sleep", "30"] } }],
    });
    await agent.next((message) => message.type === "controller.job.offer");
    agent.socket.send(JSON.stringify({ type: "agent.job.accept", jobId: job.id }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await controller.getStore().transitionJob(job.id, "interrupted", {
      reason: "socket-lost",
      interruptedAt: new Date().toISOString(),
    });

    agent.socket.send(JSON.stringify({
      type: "agent.resume",
      throughAgentSeq: 7,
      result: {
        jobId: job.id,
        agentSeq: 7,
        result: {
          ok: false,
          interrupted: true,
          code: "ERR_WW_RECOVERY_INTERRUPTED",
          message: "agent restarted",
        },
      },
    }));
    await agent.next((message) => message.type === "controller.result.ack" && message.jobId === job.id);
    await agent.next((message) => message.type === "controller.resume.ack");
    const reconciled = await client.getJob(job.id);
    assert.equal(reconciled.job.state, "interrupted");
    assert.equal(reconciled.job.result.code, "ERR_WW_RECOVERY_INTERRUPTED");
    assert.ok(reconciled.job.endedAt);
    agent.socket.close();
  });
});

test("recovery controller requests and persists inventory", async () => {
  await withController(async (controller, info) => {
    const client = createRecoveryClient({ url: `http://127.0.0.1:${info.port}` });
    const agent = await connectAgent(info, "wwra_inventory");
    const request = client.requestInventory("wwra_inventory", { wait: true, timeoutMs: 2_000 });
    await agent.next((message) => message.type === "controller.inventory.request");
    const inventory = {
      collectedAt: new Date().toISOString(),
      block: { devices: [{ deviceId: "disk_test", path: "/dev/test" }] },
      errors: [],
    };
    agent.socket.send(JSON.stringify({ type: "agent.inventory", agentSeq: 1, inventory }));
    const result = await request;
    assert.equal(result.block.devices[0].deviceId, "disk_test");
    assert.equal((await client.getAgent("wwra_inventory")).inventory.block.devices.length, 1);
    agent.socket.close();
  });
});

test("recovery controller enforces configured token for HTTP and WebSocket", async () => {
  await withController(async (controller, info) => {
    const untrusted = createRecoveryClient({ url: `http://127.0.0.1:${info.port}` });
    await assert.rejects(untrusted.getInfo(), (error) => error.status === 401);
    const trusted = createRecoveryClient({ url: `http://127.0.0.1:${info.port}`, token: "lab-token" });
    assert.equal((await trusted.getInfo()).tokenRequired, true);
    const bootScript = await fetch(`http://127.0.0.1:${info.boot.port}/v1/recovery/boot/x86_64/boot.ipxe`);
    assert.equal(bootScript.status, 200);
    assert.match(await bootScript.text(), /^#!ipxe/);
    const agent = await connectAgent(info, "wwra_token", { token: "lab-token" });
    assert.ok(agent.welcome.sessionId);
    agent.socket.close();
  }, { token: "lab-token" });
});

test("recovery artifacts stream, resume, range-download, and hash", async () => {
  await withController(async (controller, info, stateDir) => {
    const client = createRecoveryClient({ url: `http://127.0.0.1:${info.port}` });
    const artifact = await client.createArtifact({ kind: "user-upload", filename: "binary.dat" });
    await client.uploadArtifact(artifact, Buffer.from([0, 1, 2]), { complete: false, offset: 0 });
    assert.equal((await client.headArtifact(artifact.id)).size, 3);
    const completed = await client.uploadArtifact(artifact, Buffer.from([3, 4, 5]), { complete: true, offset: 3 });
    assert.equal(completed.size, 6);
    assert.match(completed.hash, /^sha256:/);
    const { stream } = await client.downloadArtifact(artifact.id, { offset: 2 });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([2, 3, 4, 5]));

    const transport = createRecoveryArtifacts({ client });
    const destination = path.join(stateDir, "downloaded.dat");
    await assert.rejects(
      transport.download({ artifactId: artifact.id, path: destination, hash: `sha256:${"0".repeat(64)}` }),
      (error) => error.code === "ERR_WW_RECOVERY_ARTIFACT_HASH",
    );
    assert.equal((await fs.stat(`${destination}.partial`)).size, 6);
    const recovered = await transport.download({ artifactId: artifact.id, path: destination });
    assert.equal(recovered.resumed, true);
    assert.deepEqual(await fs.readFile(destination), Buffer.from([0, 1, 2, 3, 4, 5]));
  });
});

test("recovery controller never marks a short artifact upload complete", async () => {
  await withController(async (_controller, info) => {
    const baseUrl = `http://127.0.0.1:${info.port}`;
    const client = createRecoveryClient({ url: baseUrl });
    const artifact = await client.createArtifact({ kind: "user-upload", filename: "short.dat" });
    const shortResponse = await fetch(`${baseUrl}/v1/recovery/artifacts/${artifact.id}`, {
      method: "PUT",
      headers: {
        "content-length": "3",
        "x-ww-artifact-offset": "0",
        "x-ww-artifact-complete": "true",
        "x-ww-artifact-final-size": "6",
      },
      body: Buffer.from("abc"),
      duplex: "half",
    });
    assert.equal(shortResponse.status, 409);
    const shortError = await shortResponse.json();
    assert.equal(shortError.error.code, "ERR_WW_RECOVERY_ARTIFACT_OFFSET");
    assert.equal(shortError.error.actualOffset, 3);
    assert.deepEqual(await client.headArtifact(artifact.id), {
      id: artifact.id,
      size: 3,
      complete: false,
      hash: null,
      contentType: "application/octet-stream",
    });

    const complete = await client.uploadArtifact(artifact, Buffer.from("def"), {
      offset: 3,
      complete: true,
    });
    assert.equal(complete.size, 6);
    assert.equal(complete.complete, true);
  });
});

test("recovery artifact uploads resume after a transient transport reset", async () => {
  let partialSize = 0;
  let complete = false;
  const uploads = [];
  const client = createRecoveryClient({
    url: "http://recovery.test",
    fetchImpl: async (_url, options = {}) => {
      if (options.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "x-ww-artifact-size": String(partialSize),
            "x-ww-artifact-complete": String(complete),
          },
        });
      }
      assert.equal(options.method, "PUT");
      const chunks = [];
      for await (const chunk of options.body) {
        chunks.push(typeof chunk === "number" ? Buffer.from([chunk]) : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      uploads.push(body);
      if (uploads.length === 1) {
        partialSize = 3;
        const error = new TypeError("fetch failed");
        error.cause = { code: "ECONNRESET" };
        throw error;
      }
      partialSize += body.length;
      complete = true;
      return new Response(JSON.stringify({
        artifact: {
          id: "wwa_resume_test",
          size: partialSize,
          complete,
          hash: "sha256:fixture",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const artifact = await client.uploadArtifact(
    { id: "wwa_resume_test" },
    Buffer.from("abcdef"),
  );
  assert.deepEqual(uploads, [Buffer.from("abcdef"), Buffer.from("def")]);
  assert.equal(artifact.size, 6);
  assert.equal(artifact.complete, true);
});
