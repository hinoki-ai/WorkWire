import { fileURLToPath } from "node:url";
import path from "node:path";

const LANE_SPECS = Object.freeze({
  continuity: Object.freeze({
    url: new URL("../continuity/index.mjs", import.meta.url),
    exports: Object.freeze([
      "CONTINUITY_SCHEMA_VERSION",
      "createContinuityStore",
      "createMachineGraph",
      "createRecoveryVault",
      "createHealthIntelligence",
      "getContinuityCapabilities",
      "runContinuityCli",
    ]),
    capabilityExport: "getContinuityCapabilities",
  }),
  sync: Object.freeze({
    url: new URL("../sync/index.mjs", import.meta.url),
    exports: Object.freeze([
      "WW_SYNC_ENGINE_VERSION",
      "createWorkWireSyncEngine",
      "compileSyncPolicy",
      "getSyncCapabilities",
    ]),
    capabilityExport: "getSyncCapabilities",
  }),
  imaging: Object.freeze({
    url: new URL("../imaging/index.mjs", import.meta.url),
    exports: Object.freeze([
      "WW_IMAGING_VERSION",
      "createImagingCatalog",
      "createProvisioningEngine",
      "getImagingCapabilities",
    ]),
    capabilityExport: "getImagingCapabilities",
  }),
  salvage: Object.freeze({
    url: new URL("../salvage/index.mjs", import.meta.url),
    exports: Object.freeze([
      "WW_SALVAGE_VERSION",
      "createSalvageEngine",
      "getSalvageCapabilities",
    ]),
    capabilityExport: "getSalvageCapabilities",
  }),
});

const successfulLoads = new Map();

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function modulePath(url) {
  try { return fileURLToPath(url); } catch { return String(url); }
}

function isGenuineModuleAbsence(error, expectedUrl) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") return false;
  const expectedPath = modulePath(expectedUrl);
  const message = String(error?.message || "");
  const missing = String(error?.url || "");
  return missing === expectedUrl.href
    || missing === expectedPath
    || message.includes(expectedUrl.href)
    || message.includes(expectedPath);
}

function assertJsonRecord(value, lane) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${lane} capability manifest must be an object.`);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (cause) {
    throw new TypeError(`${lane} capability manifest must be JSON-serializable: ${cause.message}`);
  }
}

async function validateLaneModule(lane, namespace) {
  const spec = LANE_SPECS[lane];
  const missing = spec.exports.filter((name) => !(name in namespace));
  if (missing.length > 0) {
    const error = new Error(`Optional ${lane} lane violates its frozen contract; missing ${missing.join(", ")}.`);
    error.code = "ERR_WW_NEXT_STAGE_CONTRACT";
    error.lane = lane;
    error.missing = missing;
    throw error;
  }
  for (const name of spec.exports.filter((candidate) => candidate.startsWith("create") || candidate.startsWith("get") || candidate.startsWith("run") || candidate.startsWith("compile"))) {
    if (typeof namespace[name] !== "function") {
      const error = new TypeError(`Optional ${lane} export ${name} must be a function.`);
      error.code = "ERR_WW_NEXT_STAGE_CONTRACT";
      error.lane = lane;
      throw error;
    }
  }
  const capabilities = assertJsonRecord(await namespace[spec.capabilityExport](), lane);
  return Object.freeze({
    lane,
    available: true,
    module: namespace,
    capabilities: Object.freeze(capabilities),
    loadedAt: new Date().toISOString(),
    source: modulePath(spec.url),
  });
}

export async function loadNextStageLane(lane, { refresh = false, importImpl = (url) => import(url) } = {}) {
  const name = String(lane || "");
  const spec = LANE_SPECS[name];
  if (!spec) throw new TypeError(`Unknown WorkWire next-stage lane ${name || "<missing>"}.`);
  if (refresh) successfulLoads.delete(name);
  if (successfulLoads.has(name)) return successfulLoads.get(name);
  let namespace;
  try {
    namespace = await importImpl(spec.url.href);
  } catch (error) {
    if (!isGenuineModuleAbsence(error, spec.url)) throw error;
    return Object.freeze({
      lane: name,
      available: false,
      capabilities: null,
      loadedAt: null,
      source: modulePath(spec.url),
      reason: "module-absent",
    });
  }
  const result = await validateLaneModule(name, namespace);
  successfulLoads.set(name, result);
  return result;
}

export async function discoverNextStageAdapters({ refresh = false, importImpl } = {}) {
  const entries = await Promise.all(Object.keys(LANE_SPECS).map(async (lane) => [
    lane,
    await loadNextStageLane(lane, { refresh, ...(importImpl ? { importImpl } : {}) }),
  ]));
  return Object.freeze(Object.fromEntries(entries));
}

export function getNextStageAdapterSnapshot() {
  return Object.freeze(Object.fromEntries(Object.keys(LANE_SPECS).map((lane) => {
    const loaded = successfulLoads.get(lane);
    return [lane, loaded ? {
      lane,
      available: true,
      capabilities: clone(loaded.capabilities),
      loadedAt: loaded.loadedAt,
      source: loaded.source,
    } : {
      lane,
      available: false,
      capabilities: null,
      loadedAt: null,
      source: modulePath(LANE_SPECS[lane].url),
      reason: "not-loaded",
    }];
  })));
}

export function resetNextStageAdapterCache() {
  successfulLoads.clear();
}

const COMPONENT_FACTORIES = Object.freeze({
  continuity: Object.freeze({ store: "createContinuityStore", graph: "createMachineGraph", vault: "createRecoveryVault", health: "createHealthIntelligence" }),
  sync: Object.freeze({ engine: "createWorkWireSyncEngine" }),
  imaging: Object.freeze({ catalog: "createImagingCatalog", provisioning: "createProvisioningEngine" }),
  salvage: Object.freeze({ engine: "createSalvageEngine" }),
});

const ALLOWED_METHODS = Object.freeze({
  continuity: new Set([
    "ingestObservation", "ingestInventory", "ingestBoot", "ingestCaseEvent", "listMachines", "getMachine", "getTimeline", "diffMachine", "search", "getStats",
    "correlateIdentity", "upsertEntity", "link", "getEntity", "neighbors", "resolveMachine", "explainIdentity",
    "ingestFile", "snapshotPaths", "ingestArtifact", "listSnapshots", "getSnapshot", "diffSnapshots", "restoreSnapshot", "scrub", "prune",
    "observe", "evaluate", "compare", "recommendations", "getSeries",
  ]),
  sync: new Set(["addFolder", "updateFolder", "removeFolder", "addPeer", "updatePeer", "removePeer", "scan", "sync", "pause", "resume", "getFolderStatus", "getPeerStatus", "getConflicts", "resolveConflict", "getVersions", "restoreVersion"]),
  imaging: new Set([
    "list", "listImages", "search", "get", "getImage", "capture", "restore", "planDeployment", "buildDeploymentPlan",
    "deploy", "executeDeploymentPlan", "verify", "inspect", "export", "import", "pin", "clone", "rename", "delete", "getStats",
  ]),
  salvage: new Set([
    "inventory", "estimateCapacity", "getCapacityPlan", "plan", "buildPlan", "preview", "start", "run", "resume", "get", "getJob", "getProgress",
    "getReport", "getManifest", "getChecksumManifest",
  ]),
});

const METHOD_ALIASES = Object.freeze({
  "imaging:catalog:list": "listImages",
  "imaging:catalog:get": "getImage",
  "imaging:provisioning:planDeployment": "buildDeploymentPlan",
  "imaging:provisioning:deploy": "executeDeploymentPlan",
  "salvage:engine:start": "run",
  "salvage:engine:get": "getJob",
  "salvage:engine:getProgress": "getJob",
  "salvage:engine:getManifest": "getChecksumManifest",
  "salvage:engine:getCapacityPlan": "estimateCapacity",
});

export function createNextStageRuntime({ adapters = {}, stateDir, instances = {} } = {}) {
  const created = new Map();
  const creating = new Map();

  async function component(lane, name) {
    const key = `${lane}:${name}`;
    if (created.has(key)) return created.get(key);
    if (creating.has(key)) return creating.get(key);
    const pending = (async () => {
      const supplied = instances?.[lane]?.[name];
      if (supplied) {
        await supplied.init?.();
        created.set(key, supplied);
        return supplied;
      }
      const adapter = adapters[lane];
      if (!adapter?.available) {
        const error = new Error(`Optional ${lane} lane is unavailable.`);
        error.code = "ERR_WW_NEXT_STAGE_UNAVAILABLE";
        throw error;
      }
      const factoryName = COMPONENT_FACTORIES[lane]?.[name];
      if (!factoryName || typeof adapter.module?.[factoryName] !== "function") {
        const error = new Error(`Optional ${lane} component ${name} is unavailable.`);
        error.code = "ERR_WW_NEXT_STAGE_UNAVAILABLE";
        throw error;
      }
      const componentStateDir = stateDir ? path.join(stateDir, "next-stage", lane, name) : undefined;
      const factoryOptions = { stateDir: componentStateDir };
      if (lane === "imaging" && name === "provisioning") {
        factoryOptions.catalog = await component("imaging", "catalog");
      }
      const instance = await adapter.module[factoryName](factoryOptions);
      await instance?.init?.();
      created.set(key, instance);
      return instance;
    })();
    creating.set(key, pending);
    try {
      return await pending;
    } finally {
      if (creating.get(key) === pending) creating.delete(key);
    }
  }

  async function invoke(lane, componentName, method, args = []) {
    const laneName = String(lane || "");
    const methodName = String(method || "");
    if (!ALLOWED_METHODS[laneName]?.has(methodName)) {
      const error = new Error(`Optional lane method ${laneName}.${methodName} is not part of the WorkWire adapter surface.`);
      error.code = "ERR_WW_NEXT_STAGE_CONTRACT";
      throw error;
    }
    const normalizedComponent = String(componentName || "");
    const instance = await component(laneName, normalizedComponent);
    const implementationName = typeof instance?.[methodName] === "function"
      ? methodName
      : METHOD_ALIASES[`${laneName}:${normalizedComponent}:${methodName}`] || methodName;
    if (typeof instance?.[implementationName] !== "function") {
      const error = new Error(`Optional ${laneName} component ${componentName} does not implement ${methodName}.`);
      error.code = "ERR_WW_NEXT_STAGE_UNAVAILABLE";
      throw error;
    }
    const result = await instance[implementationName](...(Array.isArray(args) ? args : []));
    const normalized = laneName === "salvage" && methodName === "preview" && result?.stream
      ? await materializePreview(result)
      : result;
    assertJsonSerializableResult(normalized, `${laneName}.${methodName}`);
    return normalized;
  }

  async function close() {
    await Promise.allSettled([...creating.values()]);
    for (const instance of [...created.values()].reverse()) {
      try { await instance?.close?.(); } catch {}
    }
    creating.clear();
    created.clear();
  }

  return { component, invoke, close };
}

async function materializePreview(result) {
  const chunks = [];
  let bytes = 0;
  const maximum = Math.min(1024 * 1024, Math.max(0, Number(result?.metadata?.previewBytes) || 64 * 1024));
  for await (const chunk of result.stream) {
    const value = Buffer.from(chunk);
    const remaining = maximum - bytes;
    if (remaining <= 0) break;
    chunks.push(value.subarray(0, remaining));
    bytes += Math.min(value.length, remaining);
  }
  return {
    metadata: clone(result.metadata || {}),
    data: Buffer.concat(chunks).toString("base64"),
    encoding: "base64",
    bytes,
  };
}

function assertJsonSerializableResult(value, label) {
  if (value === undefined) return;
  try { JSON.stringify(value); }
  catch (cause) {
    const error = new TypeError(`${label} returned a non-serializable result: ${cause.message}`);
    error.code = "ERR_WW_NEXT_STAGE_CONTRACT";
    throw error;
  }
}

export const NEXT_STAGE_LANE_CONTRACTS = Object.freeze(Object.fromEntries(
  Object.entries(LANE_SPECS).map(([lane, spec]) => [lane, Object.freeze({
    source: modulePath(spec.url),
    exports: spec.exports,
    capabilityExport: spec.capabilityExport,
  })]),
));

export { isGenuineModuleAbsence };
