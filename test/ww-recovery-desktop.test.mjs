import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopRecoveryManager } from "../desktop/ww-recovery-main.mjs";
import { createRecoveryController } from "../lib/recovery/ww-recovery-controller.mjs";

function bootManagerStub() {
  return {
    async handleRequest() { return false; },
    async status() { return { running: false, pid: null, interface: "eno-test", configPath: "/tmp/test-dnsmasq.conf" }; },
    async prepare() { return { interface: { name: "eno-test" } }; },
    async start() { return { running: true, pid: 99 }; },
    async stop() { return { running: false, stopped: true }; },
    async arm() { return { next: "recovery", after: "local" }; },
    async local() { return { next: "local", after: "local" }; },
  };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for desktop recovery state.");
}

test("desktop recovery manager owns no renderer secret and reconnects after controller restart", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-desktop-"));
  const config = {
    stateDir,
    host: "127.0.0.1",
    port: 0,
    bootHost: "127.0.0.1",
    bootPort: 0,
    token: "desktop-secret-token",
    heartbeatMs: 100,
    staleAfterMs: 400,
    offlineAfterMs: 800,
    pxe: { enabled: false, interface: "eno-test" },
  };
  let firstController = null;
  const manager = createDesktopRecoveryManager({
    loadConfigImpl: async () => config,
    createControllerImpl(options) {
      firstController = createRecoveryController(options);
      return firstController;
    },
    createBootManagerImpl: bootManagerStub,
    refreshIntervalMs: 50,
  });
  let replacement = null;
  try {
    const online = await manager.start();
    assert.equal(online.controller.connected, true);
    assert.equal(online.controller.ownedByDesktop, true);
    assert.doesNotMatch(JSON.stringify(online), /desktop-secret-token/);
    const originalInfo = online.controller.info;

    await firstController.stop();
    await waitFor(() => manager.getState().controller.connected === false);

    replacement = createRecoveryController({
      config: {
        ...config,
        port: originalInfo.port,
        bootPort: originalInfo.boot.port,
      },
      bootManager: bootManagerStub(),
    });
    await replacement.start();
    await waitFor(() => manager.getState().controller.connected === true);
    assert.equal(manager.getState().controller.info.port, originalInfo.port);
  } finally {
    await manager.stop();
    await replacement?.stop().catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("desktop recovery manager preserves exact argv, shell, force, and selected case in submissions", async () => {
  const submitted = [];
  const baseState = {
    controller: { protocol: 1, port: 4852, boot: { port: 4853 } },
    agent: { agentId: "wwra_patient", hostname: "patient", state: "online" },
    case: { id: "wwc_patient", targetAgentId: "wwra_patient", goal: "Repair boot", state: "open" },
  };
  const client = {
    async connect() { return baseState.controller; },
    async getInfo() { return baseState.controller; },
    async listAgents() { return [baseState.agent]; },
    async getAgent() { return { agent: baseState.agent, inventory: { block: { devices: [] }, errors: [] } }; },
    async requestInventory() { return { block: { devices: [] }, errors: [] }; },
    async listCases() { return [baseState.case]; },
    async getCase() { return { case: baseState.case, jobs: [], artifacts: [] }; },
    async listEvents() { return []; },
    subscribeEvents() { return { abort() {}, done: new Promise(() => {}) }; },
    async listPlaybooks() { return []; },
    async createJob(input) { submitted.push(input); return { ...input, id: `wwj_${submitted.length}`, caseId: input.caseId }; },
  };
  const manager = createDesktopRecoveryManager({
    loadConfigImpl: async () => ({ port: 4852, token: "", pxe: {}, stateDir: "/tmp/recovery-test" }),
    createClientImpl: () => client,
    createControllerImpl: () => { throw new Error("controller should not start"); },
    createBootManagerImpl: bootManagerStub,
    refreshIntervalMs: 60_000,
  });
  try {
    await manager.start();
    await manager.selectAgent("wwra_patient");
    await manager.selectCase("wwc_patient");
    await manager.exec({ argv: ["printf", "%s", "a b", "$(literal)"], force: true, timeoutMs: 0 });
    await manager.shell({ script: "printf 'one\\ntwo\\n'", force: true });
    assert.deepEqual(submitted[0].steps[0].params.argv, ["printf", "%s", "a b", "$(literal)"]);
    assert.equal(submitted[0].steps[0].timeoutMs, 0);
    assert.equal(submitted[0].steps[0].force, true);
    assert.equal(submitted[0].caseId, "wwc_patient");
    assert.equal(submitted[1].steps[0].params.script, "printf 'one\\ntwo\\n'");
    assert.equal(submitted[1].force, true);
  } finally {
    await manager.stop();
  }
});
