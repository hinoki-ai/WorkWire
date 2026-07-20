import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRecoveryController } from "../lib/recovery/ww-recovery-controller.mjs";
import { createRecoveryClient } from "../lib/recovery/ww-recovery-client.mjs";
import {
  createNextStageRuntime,
  discoverNextStageAdapters,
  loadNextStageLane,
  resetNextStageAdapterCache,
} from "../lib/recovery/ww-next-stage-adapters.mjs";

const contracts = {
  continuity: {
    CONTINUITY_SCHEMA_VERSION: 1,
    createContinuityStore: () => ({}), createMachineGraph: () => ({}), createRecoveryVault: () => ({}), createHealthIntelligence: () => ({}),
    getContinuityCapabilities: () => ({ schemaVersion: 1, history: true, vault: true }), runContinuityCli: async () => ({}),
  },
  sync: {
    WW_SYNC_ENGINE_VERSION: 1, createWorkWireSyncEngine: () => ({}), compileSyncPolicy: (value) => value,
    getSyncCapabilities: () => ({ convergence: true }),
  },
  imaging: {
    WW_IMAGING_VERSION: 1, createImagingCatalog: () => ({}), createProvisioningEngine: () => ({}),
    getImagingCapabilities: () => ({ sparseImages: true }),
  },
  salvage: {
    WW_SALVAGE_VERSION: 1, createSalvageEngine: () => ({}), getSalvageCapabilities: () => ({ prioritized: true }),
  },
};

function laneFromUrl(url) {
  if (url.includes("/continuity/")) return "continuity";
  if (url.includes("/sync/")) return "sync";
  if (url.includes("/imaging/")) return "imaging";
  return "salvage";
}

test("frozen lane discovery treats only true absence as unavailable and validates every named export", async () => {
  resetNextStageAdapterCache();
  const missing = await loadNextStageLane("continuity", {
    refresh: true,
    importImpl: async (url) => { const error = new Error(`Cannot find module '${url}'`); error.code = "ERR_MODULE_NOT_FOUND"; error.url = url; throw error; },
  });
  assert.equal(missing.available, false);

  await assert.rejects(loadNextStageLane("sync", {
    refresh: true,
    importImpl: async () => { throw Object.assign(new SyntaxError("broken optional module"), { code: "ERR_TEST" }); },
  }), /broken optional module/);

  await assert.rejects(loadNextStageLane("imaging", {
    refresh: true,
    importImpl: async () => ({ WW_IMAGING_VERSION: 1 }),
  }), (error) => error.code === "ERR_WW_NEXT_STAGE_CONTRACT" && error.missing.includes("createImagingCatalog"));

  resetNextStageAdapterCache();
  const discovered = await discoverNextStageAdapters({ refresh: true, importImpl: async (url) => contracts[laneFromUrl(url)] });
  assert.deepEqual(Object.fromEntries(Object.entries(discovered).map(([lane, value]) => [lane, value.available])), { continuity: true, sync: true, imaging: true, salvage: true });
  assert.equal(discovered.continuity.capabilities.vault, true);
});

test("controller starts absent and activates all frozen lane contracts without renderer networking", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-next-stage-controller-"));
  const invocations = [];
  const component = (name, methods) => ({
    async init() { invocations.push([name, "init"]); },
    async close() { invocations.push([name, "close"]); },
    ...methods,
  });
  const instances = {
    continuity: {
      store: component("continuity.store", { async getTimeline(machineId) { return [{ id: "timeline-1", machineId, at: new Date().toISOString() }]; } }),
      vault: component("continuity.vault", { async listSnapshots() { return [{ id: "snapshot-1", at: new Date().toISOString() }]; }, async getStats() { return { bytes: 10 }; } }),
      health: component("continuity.health", { async recommendations(machineId) { return [{ id: "health-1", machineId }]; } }),
    },
    sync: { engine: component("sync.engine", { async getConflicts(folderId) { return [{ id: "conflict-1", folderId }]; } }) },
    imaging: { catalog: component("imaging.catalog", { async list() { return [{ id: "image-1" }]; } }), provisioning: component("imaging.provisioning", { async planDeployment(input) { return { id: "deploy-1", input }; } }) },
    salvage: { engine: component("salvage.engine", { async getCapacityPlan() { return { required: 100, available: 200 }; } }) },
  };
  const adapters = Object.fromEntries(Object.entries(contracts).map(([lane, module]) => [lane, { lane, available: true, module, capabilities: module[Object.keys(module).find((key) => key.startsWith("get") && key.endsWith("Capabilities"))](), source: `test:${lane}` }]));
  const controller = createRecoveryController({
    config: { stateDir: root, host: "127.0.0.1", port: 0, bootHost: "127.0.0.1", bootPort: 0 },
    discoverNextStageAdaptersImpl: async () => adapters,
    nextStageInstances: instances,
  });
  const info = await controller.start();
  const client = createRecoveryClient({ url: info.localUrl });
  try {
    const lanes = await client.getNextStage();
    assert.equal(Object.values(lanes).every((lane) => lane.available), true);
    assert.equal((await client.invokeNextStage("continuity", "store", "getTimeline", ["machine-a"]))[0].machineId, "machine-a");
    assert.equal((await client.invokeNextStage("continuity", "vault", "listSnapshots", [{}]))[0].id, "snapshot-1");
    assert.equal((await client.invokeNextStage("sync", "engine", "getConflicts", ["folder-a"]))[0].id, "conflict-1");
    assert.equal((await client.invokeNextStage("imaging", "catalog", "list", []))[0].id, "image-1");
    assert.equal((await client.invokeNextStage("salvage", "engine", "getCapacityPlan", [])).available, 200);
    await assert.rejects(client.invokeNextStage("sync", "engine", "arbitraryMethod", []), (error) => error.code === "ERR_WW_NEXT_STAGE_CONTRACT");
  } finally {
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
  assert.ok(invocations.some(([name, action]) => name === "continuity.store" && action === "init"));
  assert.ok(invocations.some(([, action]) => action === "close"));
});

test("next-stage runtime initializes one durable component under concurrent first use", async () => {
  let initCount = 0;
  let closeCount = 0;
  const store = {
    async init() {
      initCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    listMachines() { return []; },
    async close() { closeCount += 1; },
  };
  const runtime = createNextStageRuntime({
    instances: { continuity: { store } },
  });
  const results = await Promise.all(Array.from({ length: 32 }, () => (
    runtime.invoke("continuity", "store", "listMachines", [])
  )));
  assert.equal(results.length, 32);
  assert.equal(results.every((value) => Array.isArray(value) && value.length === 0), true);
  assert.equal(initCount, 1);
  await runtime.close();
  assert.equal(closeCount, 1);
});

test("controller starts with every lane genuinely absent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-next-stage-absent-"));
  const unavailable = Object.fromEntries(Object.keys(contracts).map((lane) => [lane, { lane, available: false, capabilities: null, reason: "module-absent", source: `absent:${lane}` }]));
  const controller = createRecoveryController({
    config: { stateDir: root, host: "127.0.0.1", port: 0, bootHost: "127.0.0.1", bootPort: 0 },
    discoverNextStageAdaptersImpl: async () => unavailable,
  });
  try {
    const info = await controller.start();
    const client = createRecoveryClient({ url: info.localUrl });
    assert.equal(Object.values(await client.getNextStage()).every((lane) => lane.available === false), true);
    await assert.rejects(client.invokeNextStage("continuity", "store", "listMachines", []), (error) => error.code === "ERR_WW_NEXT_STAGE_UNAVAILABLE");
  } finally {
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("landed P1 and P2 modules execute through their real durable adapters", async () => {
  resetNextStageAdapterCache();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-next-stage-live-"));
  const controller = createRecoveryController({ config: { stateDir: root, host: "127.0.0.1", port: 0, bootHost: "127.0.0.1", bootPort: 0 } });
  try {
    const info = await controller.start();
    const client = createRecoveryClient({ url: info.localUrl });
    assert.equal(Object.values(await client.getNextStage()).every((lane) => lane.available === true), true);
    assert.deepEqual(await client.invokeNextStage("continuity", "store", "listMachines", []), []);
    assert.deepEqual(await client.invokeNextStage("imaging", "catalog", "list", []), []);
    const deployment = await client.invokeNextStage("imaging", "provisioning", "planDeployment", [{ imageId: "image-fixture", machines: [{ id: "patient-1", target: { path: "/dev/fixture" } }] }]);
    assert.equal(deployment.imageId, "image-fixture");
    const source = path.join(root, "salvage-source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "document.txt"), "real-lane");
    const inventory = await client.invokeNextStage("salvage", "engine", "inventory", [source, {}]);
    assert.equal(inventory.totals.files, 1);
    const syncRoot = path.join(root, "sync-root");
    const folder = await client.invokeNextStage("sync", "engine", "addFolder", [{ id: "folder-live", rootPath: syncRoot, mode: "send-only" }]);
    assert.equal(folder.id, "folder-live");
    assert.equal((await client.invokeNextStage("sync", "engine", "getFolderStatus", [folder.id])).folderId, folder.id);
  } finally {
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Electron cockpit exposes real fleet, terminal, autonomy, and optional-lane IPC without renderer secrets", async () => {
  const [html, preload, main, renderer] = await Promise.all([
    fs.readFile(new URL("../desktop/ww/index.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../desktop/ww-preload.cjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../desktop/ww-main.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../desktop/ww/recovery-renderer.js", import.meta.url), "utf8"),
  ]);
  for (const id of ["recovery-fleet-targets", "recovery-fleet-command", "recovery-fleet-results", "recovery-session-tabs", "recovery-session-output", "recovery-plan-graph", "recovery-next-stage-panels", "recovery-next-stage-input", "recovery-next-stage-output", "recovery-command-palette"]) assert.match(html, new RegExp(`id=["']${id}["']`));
  for (const method of ["executeFleet", "openSession", "sessionInput", "openTunnel", "launchConsole", "invokeNextStage"]) assert.match(preload, new RegExp(`${method}:`));
  for (const channel of ["ww:recovery-fleet-execute", "ww:recovery-session-open", "ww:recovery-tunnel-open", "ww:recovery-next-stage"]) assert.match(main, new RegExp(channel));
  assert.doesNotMatch(renderer, /fetch\s*\(|new\s+WebSocket/);
  assert.doesNotMatch(preload, /WW_RECOVERY_TOKEN|controllerToken/);
});
