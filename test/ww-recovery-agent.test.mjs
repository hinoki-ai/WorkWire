import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRecoveryController } from "../lib/recovery/ww-recovery-controller.mjs";
import { createRecoveryClient } from "../lib/recovery/ww-recovery-client.mjs";
import { createRecoveryAgent } from "../lib/recovery/ww-recovery-agent.mjs";
import { createRecoveryExecutor } from "../lib/recovery/ww-recovery-executor.mjs";
import { createRecoveryActionRegistry } from "../lib/recovery/ww-recovery-actions.mjs";

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function fakeInventory(identity = {}) {
  return {
    collectedAt: new Date().toISOString(),
    agent: identity,
    system: { hostname: "local-patient" },
    network: { interfaces: [], routes: [] },
    firmware: { uefi: false, secureBoot: null, entries: [] },
    tools: {},
    block: { devices: [], filesystems: [], mounts: [], raid: [], lvm: {}, crypt: [], graph: { nodes: [], edges: [] } },
    health: { smart: [], nvme: [], kernelWarnings: [] },
    raw: {},
    errors: [],
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for recovery condition.");
}

test("recovery root nerve executes argv and Bash with streamed durable output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-agent-"));
  const controllerState = path.join(root, "controller");
  const agentState = path.join(root, "agent");
  const port = await unusedPort();
  const controller = createRecoveryController({
    config: { stateDir: controllerState, host: "127.0.0.1", port, bootHost: "127.0.0.1", bootPort: 0, heartbeatMs: 100, staleAfterMs: 500, offlineAfterMs: 1_000 },
  });
  const info = await controller.start();
  const client = createRecoveryClient({ url: `http://127.0.0.1:${port}` });
  const executor = createRecoveryExecutor();
  const inventory = { collect: async ({ identity } = {}) => fakeInventory(identity) };
  const registry = createRecoveryActionRegistry({ executor, inventory });
  const agent = createRecoveryAgent({
    controllerUrl: `http://127.0.0.1:${port}`,
    id: "wwra_localtest",
    name: "local-patient",
    mode: "installed",
    stateDir: agentState,
    installedIdPath: path.join(root, "agent-id"),
    executor,
    inventory,
    registry,
    reconnectDelays: [50, 100],
  });
  try {
    await agent.start();
    await waitFor(async () => (await client.listAgents()).some((item) => item.agentId === "wwra_localtest" && item.state === "online"));
    const caseRecord = await client.createCase({ targetAgentId: "wwra_localtest", goal: "Prove unrestricted execution" });
    const execJob = await client.createJob({
      caseId: caseRecord.id,
      targetAgentId: "wwra_localtest",
      force: true,
      steps: [{
        id: "step_exec",
        action: "command.exec",
        timeoutMs: 5_000,
        params: { argv: ["node", "-e", "process.stdout.write('argv-out'); process.stderr.write('argv-err')"] },
      }],
    });
    const completedExec = await waitFor(async () => {
      const value = await client.getJob(execJob.id);
      return value.job.state === "succeeded" ? value : null;
    });
    assert.ok(completedExec.events.some((event) => event.type === "step.output" && event.stream === "stdout" && event.data === "argv-out"));
    assert.ok(completedExec.events.some((event) => event.type === "step.output" && event.stream === "stderr" && event.data === "argv-err"));

    const shellJob = await client.createJob({
      caseId: caseRecord.id,
      targetAgentId: "wwra_localtest",
      steps: [{ id: "step_shell", action: "shell.exec", params: { script: "printf 'shell-one\\n'; printf 'shell-two\\n'" } }],
    });
    const completedShell = await waitFor(async () => {
      const value = await client.getJob(shellJob.id);
      return value.job.state === "succeeded" ? value : null;
    });
    assert.ok(completedShell.events.some((event) => event.type === "step.output" && event.data.includes("shell-one")));
    assert.equal(agent.getState().identity.agentId, "wwra_localtest");
    assert.equal(agent.getState().connected, true);
  } finally {
    await agent.stop();
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recovery agent keeps identity and reconnects after controller restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-reconnect-"));
  const port = await unusedPort();
  const config = { stateDir: path.join(root, "controller"), host: "127.0.0.1", port, bootHost: "127.0.0.1", bootPort: 0, heartbeatMs: 100, staleAfterMs: 500, offlineAfterMs: 1_000 };
  let controller = createRecoveryController({ config });
  await controller.start();
  const inventory = { collect: async ({ identity } = {}) => fakeInventory(identity) };
  const executor = createRecoveryExecutor();
  const agent = createRecoveryAgent({
    controllerUrl: `http://127.0.0.1:${port}`,
    id: "wwra_reconnect",
    stateDir: path.join(root, "agent"),
    installedIdPath: path.join(root, "agent-id"),
    executor,
    inventory,
    registry: createRecoveryActionRegistry({ executor, inventory }),
    reconnectDelays: [50, 100],
  });
  try {
    await agent.start();
    const firstSession = agent.getState().sessionId;
    await controller.stop();
    await waitFor(() => !agent.getState().connected);
    controller = createRecoveryController({ config });
    await controller.start();
    await waitFor(() => agent.getState().connected && agent.getState().sessionId !== firstSession, 5_000);
    assert.equal(agent.getState().identity.agentId, "wwra_reconnect");
    assert.notEqual(agent.getState().sessionId, firstSession);
    const client = createRecoveryClient({ url: `http://127.0.0.1:${port}` });
    assert.equal((await client.listAgents())[0].agentId, "wwra_reconnect");
  } finally {
    await agent.stop();
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("running agent work survives controller blackout and reconciles its durable result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-blackout-"));
  const port = await unusedPort();
  const config = { stateDir: path.join(root, "controller"), host: "127.0.0.1", port, bootHost: "127.0.0.1", bootPort: 0, heartbeatMs: 100, staleAfterMs: 400, offlineAfterMs: 800 };
  let controller = createRecoveryController({ config });
  await controller.start();
  const inventory = { collect: async ({ identity } = {}) => fakeInventory(identity) };
  const executor = createRecoveryExecutor();
  const agent = createRecoveryAgent({
    controllerUrl: `http://127.0.0.1:${port}`,
    id: "wwra_blackout",
    stateDir: path.join(root, "agent"),
    installedIdPath: path.join(root, "agent-id"),
    executor,
    inventory,
    registry: createRecoveryActionRegistry({ executor, inventory }),
    reconnectDelays: [25, 50],
  });
  try {
    await agent.start();
    let client = createRecoveryClient({ url: `http://127.0.0.1:${port}` });
    const caseRecord = await client.createCase({ targetAgentId: "wwra_blackout", goal: "Continue through controller blackout" });
    const job = await client.createJob({
      caseId: caseRecord.id,
      targetAgentId: "wwra_blackout",
      steps: [{
        id: "step_blackout",
        action: "command.exec",
        timeoutMs: 5_000,
        params: { argv: ["node", "-e", "setTimeout(() => process.stdout.write('blackout-complete'), 700)"] },
      }],
    });
    await waitFor(async () => (await client.getJob(job.id)).job.state === "running");
    await controller.stop();
    await waitFor(() => agent.getState().connected === false);

    controller = createRecoveryController({ config });
    await controller.start();
    client = createRecoveryClient({ url: `http://127.0.0.1:${port}` });
    const completed = await waitFor(async () => {
      const value = await client.getJob(job.id);
      return value.job.state === "succeeded" ? value : null;
    }, 6_000);
    assert.equal(completed.job.reconciledAfterReconnect, true);
    assert.ok(completed.events.some((event) => event.type === "step.output" && event.data === "blackout-complete"));
    assert.equal(agent.getState().identity.agentId, "wwra_blackout");
  } finally {
    await agent.stop();
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
