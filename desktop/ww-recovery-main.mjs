import path from "node:path";
import fs from "node:fs/promises";
import { loadRecoveryConfig } from "../lib/recovery/ww-recovery-config.mjs";
import { createRecoveryController } from "../lib/recovery/ww-recovery-controller.mjs";
import { createRecoveryClient } from "../lib/recovery/ww-recovery-client.mjs";
import { createRecoveryBootManager } from "../lib/recovery/ww-recovery-boot.mjs";

const MAX_VISIBLE_EVENTS = 1_000;
const REFRESH_INTERVAL_MS = 2_000;

function clone(value) {
  return structuredClone(value);
}

function errorRecord(error, fallback = "Recovery operation failed.") {
  if (!error) return null;
  return {
    code: String(error.code || "ERR_WW_RECOVERY_DESKTOP"),
    message: String(error.message || fallback),
    ...(error.details === undefined ? {} : { details: clone(error.details) }),
  };
}

function sortNewest(records = []) {
  return [...records].sort((left, right) => (
    String(right.updatedAt || right.createdAt || "")
      .localeCompare(String(left.updatedAt || left.createdAt || ""))
  ));
}

function eventKey(event = {}) {
  return [event.caseId || "", event.jobId || "", event.seq || "", event.type || "", event.at || ""].join(":");
}

function normalizeArgv(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Recovery exec requires a non-empty argv array.");
  }
  return value.map((part) => String(part));
}

/**
 * Owns the privileged recovery controller/client lifecycle for Electron.
 * Nothing returned by getState() contains the controller token.
 */
export function createDesktopRecoveryManager({
  loadConfigImpl = loadRecoveryConfig,
  createControllerImpl = createRecoveryController,
  createClientImpl = createRecoveryClient,
  createBootManagerImpl = createRecoveryBootManager,
  onState = () => {},
  log = () => {},
  refreshIntervalMs = REFRESH_INTERVAL_MS,
} = {}) {
  let config = null;
  let client = null;
  let controller = null;
  let bootManager = null;
  let ownsController = false;
  let started = false;
  let stopping = false;
  let refreshTimer = null;
  let refreshPromise = null;
  let eventSubscription = null;
  let controllerUnsubscribe = null;
  let refreshQueued = false;
  let pxeStartedHere = false;
  let clientUrl = "";

  const state = {
    controller: {
      connected: false,
      ownedByDesktop: false,
      info: null,
      error: null,
    },
    agents: [],
    macAddresses: [],
    selectedAgentId: "",
    selectedAgent: null,
    inventory: null,
    cases: [],
    selectedCaseId: "",
    selectedCase: null,
    jobs: [],
    events: [],
    artifacts: [],
    playbooks: [],
    playbookPlan: null,
    pxe: {
      configured: false,
      running: false,
      interface: "",
      pid: null,
      error: null,
    },
    busy: {},
    lastUpdatedAt: null,
    error: null,
  };

  function getState() {
    return clone(state);
  }

  function emit(reason = "state") {
    onState(getState(), reason);
  }

  function setBusy(key, value) {
    if (value) state.busy[key] = true;
    else delete state.busy[key];
    emit("busy");
  }

  function appendEvent(event) {
    if (!event || typeof event !== "object") return;
    const key = eventKey(event);
    const existing = state.events.findIndex((candidate) => eventKey(candidate) === key);
    if (existing !== -1) state.events.splice(existing, 1);
    state.events.push(clone(event));
    if (state.events.length > MAX_VISIBLE_EVENTS) {
      state.events.splice(0, state.events.length - MAX_VISIBLE_EVENTS);
    }
  }

  function requireClient() {
    if (!client) {
      const error = new Error("The recovery controller is not connected.");
      error.code = "ERR_WW_RECOVERY_CONTROLLER_OFFLINE";
      throw error;
    }
    return client;
  }

  function requireAgentId(agentId = state.selectedAgentId) {
    const selected = String(agentId || "").trim();
    if (!selected) throw new Error("Select a recovery target first.");
    return selected;
  }

  function requireCaseId(caseId = state.selectedCaseId) {
    const selected = String(caseId || "").trim();
    if (!selected) throw new Error("Select or create a recovery case first.");
    return selected;
  }

  function scheduleRefresh() {
    if (refreshQueued || stopping) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      void refresh({ quiet: true }).catch(() => {});
    });
  }

  function subscribeToCase(caseId) {
    eventSubscription?.abort();
    eventSubscription = null;
    if (!caseId || !client) return;
    const after = state.events
      .filter((event) => event.caseId === caseId)
      .reduce((maximum, event) => Math.max(maximum, Number(event.seq) || 0), 0);
    const subscription = client.subscribeEvents(caseId, {
      after,
      onEvent(event) {
        appendEvent(event);
        emit("event");
        scheduleRefresh();
      },
      onError(error) {
        if (stopping) return;
        state.error = errorRecord(error, "Recovery event stream disconnected.");
        emit("event-error");
      },
    });
    eventSubscription = subscription;
    void subscription.done.finally(() => {
      if (eventSubscription === subscription) {
        eventSubscription = null;
        if (!stopping && state.controller.connected && state.selectedCaseId === caseId) {
          setTimeout(() => subscribeToCase(caseId), 500).unref?.();
        }
      }
    });
  }

  async function attachClient(url = clientUrl || `http://127.0.0.1:${config.port}`) {
    clientUrl = url;
    client = createClientImpl({
      url,
      token: config.token,
      timeoutMs: 2_000,
    });
    const info = await client.connect({ timeoutMs: 1_000 });
    state.controller.connected = true;
    state.controller.info = info;
    state.controller.error = null;
    state.controller.ownedByDesktop = ownsController;
    return info;
  }

  async function startEmbeddedController() {
    let liveController = null;
    bootManager = createBootManagerImpl({
      config,
      controllerInfo: () => liveController?.getInfo(),
      log: (message) => log(`[Recovery PXE] ${message}`),
    });
    liveController = createControllerImpl({
      config,
      bootManager,
      log: (message) => log(`[Recovery] ${message}`),
    });
    const info = await liveController.start();
    controller = liveController;
    ownsController = true;
    controllerUnsubscribe = controller.onEvent((event) => {
      appendEvent(event);
      emit("event");
      scheduleRefresh();
    });
    return info;
  }

  function ensureBootManager() {
    if (bootManager) return bootManager;
    bootManager = createBootManagerImpl({
      config,
      controllerInfo: () => state.controller.info,
      log: (message) => log(`[Recovery PXE] ${message}`),
    });
    return bootManager;
  }

  async function refreshPxeStatus() {
    if (!bootManager) {
      state.pxe = {
        configured: Boolean(config?.pxe),
        running: false,
        interface: String(config?.pxe?.interface || ""),
        pid: null,
        error: null,
      };
      return state.pxe;
    }
    try {
      const status = await bootManager.status();
      const bootPaths = bootManager.getPaths?.() || {};
      const bootArtifacts = [];
      for (const name of ["vmlinuz", "initrd.img", "filesystem.squashfs", "SHA256SUMS", "manifest.json"]) {
        const filename = bootPaths.bootRoot ? path.join(bootPaths.bootRoot, "live", name) : "";
        const stats = filename ? await fs.stat(filename).catch(() => null) : null;
        if (stats?.isFile()) bootArtifacts.push({ name, size: stats.size });
      }
      state.pxe = {
        configured: true,
        running: Boolean(status.running),
        interface: String(status.interface?.name || status.interface || config?.pxe?.interface || ""),
        pid: status.pid || null,
        configPath: status.configPath || "",
        controllerUrl: state.controller.info?.url || "",
        bootUrl: state.controller.info?.boot?.url || "",
        bootArtifacts,
        error: null,
      };
    } catch (error) {
      state.pxe.error = errorRecord(error);
    }
    return state.pxe;
  }

  async function refresh({ quiet = false } = {}) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      if (!quiet) setBusy("refresh", true);
      try {
        const activeClient = requireClient();
        const [info, agents, cases, playbooks, macAddresses] = await Promise.all([
          activeClient.getInfo(),
          activeClient.listAgents(),
          activeClient.listCases(),
          activeClient.listPlaybooks().catch(() => state.playbooks),
          typeof activeClient.listMacAddresses === "function"
            ? activeClient.listMacAddresses().catch(() => state.macAddresses)
            : Promise.resolve(state.macAddresses),
        ]);
        state.controller.info = info;
        state.controller.connected = true;
        state.controller.error = null;
        state.agents = sortNewest(agents);
        state.cases = sortNewest(cases);
        state.playbooks = Array.isArray(playbooks) ? playbooks : [];
        state.macAddresses = Array.isArray(macAddresses) ? macAddresses : [];
        if (state.selectedCaseId && !eventSubscription) subscribeToCase(state.selectedCaseId);

        if (state.selectedAgentId && !state.agents.some((agent) => agent.agentId === state.selectedAgentId)) {
          state.selectedAgent = null;
          state.inventory = null;
        } else if (state.selectedAgentId) {
          const detail = await activeClient.getAgent(state.selectedAgentId).catch(() => null);
          if (detail) {
            state.selectedAgent = detail.agent;
            state.inventory = detail.inventory;
          }
        }

        if (state.selectedCaseId) {
          const detail = await activeClient.getCase(state.selectedCaseId).catch(() => null);
          if (detail) {
            state.selectedCase = detail.case;
            state.jobs = sortNewest(detail.jobs);
            state.artifacts = sortNewest(detail.artifacts);
          }
        }
        await refreshPxeStatus();
        state.lastUpdatedAt = new Date().toISOString();
        state.error = null;
      } catch (error) {
        state.controller.connected = false;
        state.controller.error = errorRecord(error, "Unable to reach the recovery controller.");
        state.error = state.controller.error;
        throw error;
      } finally {
        if (!quiet) setBusy("refresh", false);
        emit("refresh");
      }
      return getState();
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function start() {
    if (started) return getState();
    started = true;
    stopping = false;
    setBusy("startup", true);
    try {
      config = await loadConfigImpl();
      try {
        await attachClient();
      } catch (attachError) {
        try {
          const info = await startEmbeddedController();
          clientUrl = info.localUrl || `http://127.0.0.1:${info.port}`;
        } catch (startError) {
          if (startError?.code !== "EADDRINUSE") throw startError;
          log("[Recovery] Another controller won the startup race; attaching to it.");
        }
        await attachClient();
      }
      ensureBootManager();
      await refresh();
      refreshTimer = setInterval(() => void refresh({ quiet: true }).catch(() => {}), refreshIntervalMs);
      refreshTimer.unref?.();
      if (config.pxe?.enabled && bootManager) {
        await pxeStart({ interfaceName: config.pxe.interface }).catch((error) => {
          state.pxe.error = errorRecord(error);
          emit("pxe-error");
        });
      }
      return getState();
    } catch (error) {
      state.controller.connected = false;
      state.controller.error = errorRecord(error, "Recovery desktop startup failed.");
      state.error = state.controller.error;
      emit("startup-error");
      throw error;
    } finally {
      setBusy("startup", false);
    }
  }

  async function selectAgent(agentId, { refreshInventory = false } = {}) {
    const id = requireAgentId(agentId);
    setBusy("agent", true);
    try {
      state.selectedAgentId = id;
      if (refreshInventory) {
        await requireClient().requestInventory(id, { wait: true, timeoutMs: 120_000 });
      }
      const [detail, cases] = await Promise.all([
        requireClient().getAgent(id),
        requireClient().listCases({ agentId: id }),
      ]);
      state.selectedAgent = detail.agent;
      state.inventory = detail.inventory;
      state.cases = sortNewest(cases);
      const retainedCase = state.cases.find((record) => record.id === state.selectedCaseId);
      if (!retainedCase) await selectCase(state.cases[0]?.id || "");
      emit("agent-selected");
      return getState();
    } finally {
      setBusy("agent", false);
    }
  }

  async function requestInventory({ agentId = state.selectedAgentId, lightweight = false } = {}) {
    const id = requireAgentId(agentId);
    setBusy("inventory", true);
    try {
      state.inventory = await requireClient().requestInventory(id, {
        wait: true,
        timeoutMs: 120_000,
        lightweight,
      });
      state.selectedAgent = (await requireClient().getAgent(id)).agent;
      emit("inventory");
      return clone(state.inventory);
    } finally {
      setBusy("inventory", false);
    }
  }

  async function selectCase(caseId) {
    const id = String(caseId || "").trim();
    eventSubscription?.abort();
    eventSubscription = null;
    state.selectedCaseId = id;
    state.selectedCase = null;
    state.jobs = [];
    state.artifacts = [];
    state.events = [];
    if (!id) {
      emit("case-cleared");
      return getState();
    }
    setBusy("case", true);
    try {
      const [detail, events] = await Promise.all([
        requireClient().getCase(id),
        requireClient().listEvents(id),
      ]);
      state.selectedCase = detail.case;
      state.selectedCaseId = detail.case.id;
      state.selectedAgentId = detail.case.targetAgentId;
      state.jobs = sortNewest(detail.jobs);
      state.artifacts = sortNewest(detail.artifacts);
      for (const event of events.slice(-MAX_VISIBLE_EVENTS)) appendEvent(event);
      subscribeToCase(id);
      emit("case-selected");
      return getState();
    } finally {
      setBusy("case", false);
    }
  }

  async function createCase({
    agentId = state.selectedAgentId,
    goal = "",
    autonomous = false,
  } = {}) {
    const id = requireAgentId(agentId);
    const normalizedGoal = String(goal || "").trim();
    if (!normalizedGoal) throw new Error("A recovery goal is required.");
    setBusy("case-create", true);
    try {
      const record = await requireClient().createCase({
        targetAgentId: id,
        goal: normalizedGoal,
        autonomous,
        mode: autonomous ? "autonomous-unrestricted" : "unrestricted",
        createdBy: "desktop-operator",
      });
      state.cases = sortNewest([record, ...state.cases.filter((item) => item.id !== record.id)]);
      await selectCase(record.id);
      return record;
    } finally {
      setBusy("case-create", false);
    }
  }

  async function updateGoal({ caseId = state.selectedCaseId, goal = "" } = {}) {
    const id = requireCaseId(caseId);
    const record = await requireClient().updateGoal(id, String(goal ?? ""));
    state.selectedCase = record;
    state.cases = state.cases.map((item) => item.id === id ? record : item);
    emit("goal");
    return record;
  }

  async function runCase(caseId = state.selectedCaseId) {
    const id = requireCaseId(caseId);
    const result = await requireClient().runCase(id);
    await selectCase(id);
    return result;
  }

  async function stopCase(caseId = state.selectedCaseId) {
    const id = requireCaseId(caseId);
    const result = await requireClient().stopCase(id);
    await selectCase(id);
    return result;
  }

  async function submitCaseAction({ caseId = state.selectedCaseId, action } = {}) {
    const id = requireCaseId(caseId);
    const result = await requireClient().submitCaseAction(id, action || {});
    scheduleRefresh();
    return result;
  }

  async function expandPlaybook({
    playbookId,
    inputs = {},
    force = false,
  } = {}) {
    if (!playbookId) throw new Error("Select a recovery playbook first.");
    const plan = await requireClient().expandPlaybook(String(playbookId), {
      inventory: state.inventory || {},
      inputs: inputs || {},
      force: force === true,
    });
    state.playbookPlan = plan;
    emit("playbook-expanded");
    return plan;
  }

  async function runPlaybook({
    playbookId,
    agentId = state.selectedAgentId,
    inputs = {},
    force = false,
  } = {}) {
    const targetAgentId = requireAgentId(agentId);
    const plan = await expandPlaybook({ playbookId, inputs, force });
    const caseRecord = await createCase({ agentId: targetAgentId, goal: plan.goal, autonomous: false });
    const job = await submitJob({
      caseId: caseRecord.id,
      targetAgentId,
      goal: plan.goal,
      force: force === true,
      steps: plan.steps,
    });
    return { case: caseRecord, plan, job };
  }

  async function submitJob(input = {}) {
    const agentId = requireAgentId(input.targetAgentId || input.agentId);
    const requestedCaseId = String(input.caseId || state.selectedCaseId || "");
    if (
      requestedCaseId
      && state.selectedCase?.id === requestedCaseId
      && state.selectedCase?.state === "running"
      && state.selectedCase?.mode === "autonomous-unrestricted"
      && input.createdBy !== "planner"
    ) {
      const requestId = `desktop_${Date.now().toString(36)}`;
      const result = await requireClient().submitCaseAction(requestedCaseId, {
        type: "planner.actions",
        requestId,
        actions: (input.steps || []).map((step) => ({
          ...clone(step),
          force: step.force === true || input.force === true,
        })),
        expectedObservation: input.goal || "Operator recovery action",
        force: input.force === true,
      });
      scheduleRefresh();
      return { accepted: true, caseId: requestedCaseId, requestId, planner: result };
    }
    const job = await requireClient().createJob({
      ...clone(input),
      targetAgentId: agentId,
      caseId: requestedCaseId,
      mode: input.mode || "unrestricted",
      createdBy: input.createdBy || "desktop-operator",
    });
    if (job.caseId && job.caseId !== state.selectedCaseId) await selectCase(job.caseId);
    else scheduleRefresh();
    return job;
  }

  async function exec({
    agentId = state.selectedAgentId,
    caseId = state.selectedCaseId,
    argv,
    timeoutMs = 120_000,
    force = false,
  } = {}) {
    const normalizedArgv = normalizeArgv(argv);
    return submitJob({
      targetAgentId: requireAgentId(agentId),
      caseId,
      goal: `Execute ${normalizedArgv[0]}`,
      force,
      steps: [{ id: "desktop_exec", action: "command.exec", params: { argv: normalizedArgv }, timeoutMs, force }],
    });
  }

  async function shell({
    agentId = state.selectedAgentId,
    caseId = state.selectedCaseId,
    script = "",
    timeoutMs = 120_000,
    force = false,
  } = {}) {
    const normalizedScript = String(script || "");
    if (!normalizedScript.trim()) throw new Error("Recovery shell requires a script.");
    return submitJob({
      targetAgentId: requireAgentId(agentId),
      caseId,
      goal: "Run unrestricted recovery shell",
      force,
      steps: [{ id: "desktop_shell", action: "shell.exec", params: { script: normalizedScript }, timeoutMs, force }],
    });
  }

  async function cancelJob(jobId) {
    const result = await requireClient().cancelJob(String(jobId || ""));
    scheduleRefresh();
    return result;
  }

  async function retryJob(jobId) {
    const result = await requireClient().retryJob(String(jobId || ""));
    scheduleRefresh();
    return result;
  }

  async function uploadArtifact({
    sourcePath,
    caseId = state.selectedCaseId,
    jobId = "",
    kind = "user-upload",
    filename = "",
  } = {}) {
    const source = path.resolve(String(sourcePath || ""));
    if (!sourcePath) throw new Error("Choose a local artifact path to upload.");
    setBusy("artifact", true);
    try {
      const artifact = await requireClient().uploadArtifact({
        caseId: String(caseId || ""),
        jobId: String(jobId || ""),
        kind,
        filename: filename || path.basename(source),
      }, source);
      scheduleRefresh();
      return artifact;
    } finally {
      setBusy("artifact", false);
    }
  }

  async function downloadArtifact({ artifactId, destinationPath, offset = 0 } = {}) {
    if (!artifactId || !destinationPath) throw new Error("Artifact and destination paths are required.");
    setBusy("artifact", true);
    try {
      return await requireClient().downloadArtifact(String(artifactId), {
        destinationPath: path.resolve(String(destinationPath)),
        offset: Number(offset) || 0,
      });
    } finally {
      setBusy("artifact", false);
    }
  }

  async function wake(input = {}) {
    const result = await requireClient().wake({
      ...clone(input),
      agentId: input.agentId || state.selectedAgentId || "",
      name: input.name || state.selectedAgent?.hostname || "",
      caseId: input.caseId || state.selectedCaseId || "",
    });
    appendEvent({ type: "power.wake", at: new Date().toISOString(), result });
    emit("wake");
    return result;
  }

  async function pxeStatus() {
    await refreshPxeStatus();
    emit("pxe");
    return clone(state.pxe);
  }

  async function pxePrepare({ interfaceName = "" } = {}) {
    if (!bootManager) throw new Error("PXE management is available only from the embedded recovery controller.");
    const result = await bootManager.prepare({ interfaceName: interfaceName || config.pxe?.interface || "" });
    await refreshPxeStatus();
    emit("pxe");
    return result;
  }

  async function pxeStart({ interfaceName = "" } = {}) {
    if (!bootManager) throw new Error("PXE management is available only from the embedded recovery controller.");
    const result = await bootManager.start({ interfaceName: interfaceName || config.pxe?.interface || "" });
    pxeStartedHere = true;
    await refreshPxeStatus();
    emit("pxe");
    return result;
  }

  async function pxeStop() {
    if (!bootManager) throw new Error("PXE management is available only from the embedded recovery controller.");
    const result = await bootManager.stop();
    pxeStartedHere = false;
    await refreshPxeStatus();
    emit("pxe");
    return result;
  }

  async function setBootPolicy({ mac, next = "recovery", after = "local", name = "" } = {}) {
    if (!bootManager) throw new Error("PXE boot policy is available only from the embedded recovery controller.");
    const result = next === "local"
      ? await bootManager.local(mac, { after, name })
      : await bootManager.arm(mac, { after, name });
    emit("pxe-policy");
    return result;
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(refreshTimer);
    refreshTimer = null;
    eventSubscription?.abort();
    eventSubscription = null;
    controllerUnsubscribe?.();
    controllerUnsubscribe = null;
    if (pxeStartedHere && bootManager) await bootManager.stop().catch(() => {});
    if (ownsController && controller) await controller.stop().catch(() => {});
    client = null;
    controller = null;
    bootManager = null;
    ownsController = false;
    state.controller.connected = false;
    state.controller.ownedByDesktop = false;
    started = false;
  }

  return {
    getState,
    start,
    stop,
    refresh,
    selectAgent,
    requestInventory,
    selectCase,
    createCase,
    updateGoal,
    runCase,
    stopCase,
    submitCaseAction,
    expandPlaybook,
    runPlaybook,
    submitJob,
    exec,
    shell,
    cancelJob,
    retryJob,
    uploadArtifact,
    downloadArtifact,
    wake,
    pxeStatus,
    pxePrepare,
    pxeStart,
    pxeStop,
    setBootPolicy,
  };
}
