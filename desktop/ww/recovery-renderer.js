const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "canceled", "interrupted", "abandoned"]);

const ids = [
  "workspace-files", "workspace-recovery", "files-workspace", "recovery-workspace",
  "recovery-controller-status", "recovery-refresh", "recovery-agent-list", "recovery-agent-detail",
  "recovery-wake-mac", "recovery-wake-broadcast", "recovery-wake",
  "recovery-pxe-status", "recovery-pxe-interface", "recovery-pxe-controller", "recovery-pxe-artifacts",
  "recovery-pxe-start", "recovery-pxe-stop", "recovery-pxe-rebuild", "recovery-pxe-arm", "recovery-pxe-local",
  "recovery-inventory", "recovery-inventory-summary", "recovery-disk-list",
  "recovery-action-name", "recovery-action-params", "recovery-device-identity", "recovery-generated-command", "recovery-run-action",
  "recovery-case-select", "recovery-goal", "recovery-run-case", "recovery-resume-case", "recovery-stop-case",
  "recovery-playbook-select", "recovery-playbook-inputs", "recovery-playbook-plan", "recovery-playbook-run",
  "recovery-command-tab", "recovery-shell-tab", "recovery-force", "recovery-command-editor", "recovery-shell-editor",
  "recovery-command", "recovery-command-exact", "recovery-execute", "recovery-shell", "recovery-shell-execute", "recovery-message",
  "recovery-job-count", "recovery-job-list", "recovery-output-autoscroll", "recovery-output-copy", "recovery-output-save",
  "recovery-output-clear", "recovery-output", "recovery-event-filter", "recovery-event-list",
  "recovery-artifact-count", "recovery-artifact-list", "recovery-upload-path", "recovery-upload", "recovery-download-path",
  "recovery-command-palette-open", "recovery-command-palette", "recovery-command-palette-query", "recovery-command-palette-results", "recovery-command-palette-close",
  "recovery-fleet-targets", "recovery-fleet-group", "recovery-fleet-query", "recovery-fleet-rollout", "recovery-fleet-concurrency",
  "recovery-fleet-command", "recovery-fleet-execute", "recovery-fleet-inventory", "recovery-fleet-results", "recovery-schedule-spec", "recovery-schedule-save", "recovery-schedule-list",
  "recovery-session-open", "recovery-session-cwd", "recovery-session-tabs", "recovery-session-output", "recovery-session-input", "recovery-session-send",
  "recovery-session-interrupt", "recovery-session-detach", "recovery-session-reconnect", "recovery-session-terminate",
  "recovery-tunnel-host", "recovery-tunnel-port", "recovery-tunnel-open", "recovery-tunnel-list",
  "recovery-console-adapter", "recovery-console-target", "recovery-console-open", "recovery-manual-takeover", "recovery-plan-graph", "recovery-proof-summary", "recovery-next-stage-panels",
  "recovery-next-stage-input", "recovery-next-stage-output",
];

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function replaceChildren(target, ...children) {
  target.replaceChildren(...children);
}

function stringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function formatBytes(value = 0) {
  let bytes = Number(value) || 0;
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let unit = 0;
  while (Math.abs(bytes) >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit += 1;
  }
  return `${bytes.toFixed(unit === 0 || Math.abs(bytes) >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatAge(value) {
  const timestamp = new Date(value || 0).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function stateBadge(state = "unknown") {
  const normalized = String(state || "unknown").toLowerCase();
  return element("span", `recovery-state recovery-state-${normalized}`, normalized);
}

function parseArgv(source) {
  const value = String(source || "").trim();
  if (!value) return [];
  if (value.startsWith("[")) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("argv JSON must be a non-empty array.");
    return parsed.map((part) => String(part));
  }
  const result = [];
  let token = "";
  let quote = "";
  let escaping = false;
  let tokenStarted = false;
  for (const character of value) {
    if (escaping) {
      token += character;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        result.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (escaping) token += "\\";
  if (quote) throw new Error(`Unclosed ${quote} quote in argv.`);
  if (tokenStarted) result.push(token);
  return result;
}

function decodeOutput(event = {}) {
  const data = String(event.data || "");
  if (event.encoding !== "base64") return data;
  try {
    const binary = atob(data);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "[invalid base64 output]";
  }
}

function outputEvent(event) {
  return event?.type === "step.output" && (event.stream === "stdout" || event.stream === "stderr");
}

function eventSummary(event = {}) {
  if (event.reason) return String(event.reason);
  if (event.error?.message) return String(event.error.message);
  if (event.command?.file) return [event.command.file, ...(event.command.args || [])].join(" ");
  if (event.device?.path) return `${event.device.deviceId || "device"} → ${event.device.path}`;
  if (event.progress) return stringify(event.progress).slice(0, 240);
  if (event.jobId) return event.jobId;
  if (event.agentId) return event.agentId;
  return "";
}

function selectedMac(agent = {}) {
  return (agent.addresses || []).map((record) => record.mac).find(Boolean) || agent.mac || "";
}

function devicePath(device = {}) {
  return String(device?.canonicalPath || device?.path || "");
}

function generatedCommand(action, params, device) {
  const target = devicePath(device) || String(params.path || "DEVICE");
  const fileSystemType = String(params.filesystemType || device?.filesystemType || "TYPE");
  if (action === "disk.smart.read") {
    return /nvme/.test(target) ? `nvme smart-log -o json ${target}` : `smartctl --all --json=c ${target}`;
  }
  if (action === "disk.read.sample") {
    const blockSize = Number(params.blockSize) || 4096;
    const count = Number(params.count) || 16;
    return (params.offsets || ["HEAD", "MIDDLE", "TAIL"]).map((offset) => `dd if=${target} bs=${blockSize} skip=${offset} count=${count} status=none → sha256sum`).join("\n");
  }
  if (action === "disk.table.backup") {
    const output = params.outputDir || "CASE_ARTIFACT_DIR";
    return `sfdisk --dump ${target}\nsfdisk --json ${target}\nsgdisk --backup=${output}/DEVICE-TIMESTAMP.gpt ${target}\ndd if=${target} of=${output}/DEVICE-TIMESTAMP.head.bin bs=1M count=4 status=progress`;
  }
  if (action === "filesystem.identify") return `blkid -p -o export ${target}`;
  if (action === "filesystem.check" || action === "filesystem.repair") {
    return `${action === "filesystem.repair" ? "repair" : "check"} ${fileSystemType} on ${target} (native tool resolved by agent)`;
  }
  if (action === "filesystem.mount") return `mount ${target} ${params.target || "MOUNT_TARGET"}`;
  if (action === "boot.detect") return "collect inventory and detect installed roots / firmware";
  return `${action} ${stringify(params)}`;
}

export function createRecoveryRenderer({
  recoveryApi = () => window.wwApi?.recovery,
} = {}) {
  const refs = Object.fromEntries(ids.map((id) => [id.replace(/^recovery-/, "").replaceAll("-", "_"), document.getElementById(id)]));
  const filesWorkspace = document.getElementById("files-workspace");
  const recoveryWorkspace = document.getElementById("recovery-workspace");
  const filesSwitch = document.getElementById("workspace-files");
  const recoverySwitch = document.getElementById("workspace-recovery");
  let snapshot = null;
  let workspace = "files";
  let selectedDiskId = "";
  let selectedArtifactId = "";
  let consoleMode = "command";
  let outputClearThroughSeq = 0;
  let outputCaseId = "";
  let lastGoalCaseId = null;
  let lastAgentId = "";
  let bound = false;
  const downloadedArtifactPaths = new Map();
  const selectedFleetTargets = new Set();

  function api() {
    const value = recoveryApi();
    if (!value) throw new Error("Recovery IPC is unavailable.");
    return value;
  }

  function showMessage(message = "", level = "info") {
    const target = refs.message;
    if (!target) return;
    target.hidden = !message;
    target.textContent = String(message || "");
    target.className = `inline-message inline-message-${level}`;
  }

  async function perform(task, { refresh = true, success = "" } = {}) {
    showMessage("");
    try {
      const result = await task();
      if (refresh) setState(await api().refresh({ quiet: true }));
      if (success) showMessage(success, "success");
      return result;
    } catch (error) {
      showMessage(error?.message || "Recovery action failed.", "error");
      throw error;
    }
  }

  function switchWorkspace(next) {
    workspace = next === "recovery" ? "recovery" : "files";
    const recoveryActive = workspace === "recovery";
    filesWorkspace.hidden = recoveryActive;
    recoveryWorkspace.hidden = !recoveryActive;
    filesSwitch.classList.toggle("is-active", !recoveryActive);
    recoverySwitch.classList.toggle("is-active", recoveryActive);
    filesSwitch.setAttribute("aria-pressed", String(!recoveryActive));
    recoverySwitch.setAttribute("aria-pressed", String(recoveryActive));
    if (recoveryActive) void perform(() => api().refresh({ quiet: true }), { refresh: false }).then(setState).catch(() => {});
  }

  function renderController() {
    const controller = snapshot?.controller || {};
    refs.controller_status.dataset.state = controller.connected ? "online" : "offline";
    const info = controller.info;
    refs.controller_status.textContent = controller.connected
      ? `Recovery online · ${info?.agentsOnline || 0} live · :${info?.port || 4852}`
      : controller.error?.message || "Recovery offline";
  }

  function renderAgents() {
    const nodes = [];
    for (const agent of snapshot?.agents || []) {
      const row = element("button", `recovery-agent-row${agent.agentId === snapshot.selectedAgentId ? " is-selected" : ""}`);
      row.type = "button";
      row.dataset.agentId = agent.agentId;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(agent.agentId === snapshot.selectedAgentId));
      const title = element("span", "recovery-row-title");
      title.append(element("span", "", agent.hostname || agent.name || agent.agentId), stateBadge(agent.state || (agent.connected ? "online" : "offline")));
      const meta = element("span", "recovery-row-meta", `${String(agent.mode || "installed").toUpperCase()} · ${formatAge(agent.lastSeenAt)} · ${agent.addresses?.map((item) => item.address).filter(Boolean).join(", ") || "no IP"}`);
      const id = element("span", "recovery-row-path", agent.agentId);
      row.append(title, meta, id);
      nodes.push(row);
    }
    if (nodes.length === 0) nodes.push(element("p", "recovery-row-meta", "No recovery agents have checked in yet."));
    replaceChildren(refs.agent_list, ...nodes);
  }

  function renderAgentDetail() {
    const agent = snapshot?.selectedAgent;
    if (!agent) {
      replaceChildren(refs.agent_detail, element("p", "", "Select a recovery agent to inspect it."));
      return;
    }
    const tools = agent.capabilities?.tools || {};
    const toolEntries = Object.entries(tools);
    const availableTools = toolEntries.filter(([, value]) => value === true || value?.available === true || typeof value === "string").length;
    const addresses = (agent.addresses || []).map((record) => `${record.address || "?"} / ${record.mac || "?"}`).join(", ") || "unreported";
    const dl = element("dl", "recovery-detail-grid");
    const rows = [
      ["Agent", agent.agentId],
      ["Boot", agent.bootId || "unreported"],
      ["Network", addresses],
      ["Session", agent.sessionId || "offline"],
      ["Privilege", agent.capabilities?.root ? "root" : "not root"],
      ["Tools", `${availableTools}/${toolEntries.length || 0} reported`],
      ["Seen", formatAge(agent.lastSeenAt)],
    ];
    for (const [name, value] of rows) dl.append(element("dt", "", name), element("dd", "", String(value)));
    replaceChildren(refs.agent_detail, dl);
    if (agent.agentId !== lastAgentId) {
      lastAgentId = agent.agentId;
      refs.wake_mac.value = selectedMac(agent);
    }
  }

  function inventoryDevices() {
    return snapshot?.inventory?.block?.devices || [];
  }

  function selectedDisk() {
    return inventoryDevices().find((device) => device.deviceId === selectedDiskId) || null;
  }

  function defaultActionParams(device = selectedDisk()) {
    if (!device) return {};
    return {
      deviceId: device.deviceId,
      path: devicePath(device),
      ...(device.filesystemType ? { filesystemType: device.filesystemType } : {}),
    };
  }

  function updateActionPreview() {
    let params;
    try {
      params = JSON.parse(refs.action_params.value || "{}");
    } catch {
      refs.generated_command.textContent = "Parameters are not valid JSON.";
      return;
    }
    const device = selectedDisk();
    refs.device_identity.textContent = device
      ? `${device.deviceId} · ${devicePath(device)} · ${device.model || "unknown model"} ${device.serial || ""}`.trim()
      : "No device selected";
    refs.generated_command.textContent = generatedCommand(refs.action_name.value, params, device);
  }

  function selectDisk(deviceId) {
    selectedDiskId = String(deviceId || "");
    const params = defaultActionParams();
    if (refs.action_name.value === "filesystem.mount") params.target = "/mnt/workwire/target";
    refs.action_params.value = JSON.stringify(params, null, 2);
    renderDisks();
    updateActionPreview();
  }

  function renderDisks() {
    const inventory = snapshot?.inventory;
    const devices = inventoryDevices();
    const errors = inventory?.errors || [];
    const smartWarnings = (inventory?.health?.smart || []).filter((item) => item.passed === false || item.pendingSectors || item.uncorrectableSectors).length;
    const nvmeWarnings = (inventory?.health?.nvme || []).filter((item) => item.criticalWarning || item.mediaErrors).length;
    refs.inventory_summary.textContent = inventory
      ? `${devices.length} device node(s) · ${errors.length} collection gap(s) · ${smartWarnings + nvmeWarnings} health warning(s) · collected ${formatAge(inventory.collectedAt)}`
      : "No inventory collected. The first collection may take a minute while health tools inspect hardware.";
    if (selectedDiskId && !devices.some((device) => device.deviceId === selectedDiskId)) selectedDiskId = "";
    const nodes = devices.map((device) => {
      const row = element("button", `recovery-disk-row${device.deviceId === selectedDiskId ? " is-selected" : ""}`);
      row.type = "button";
      row.dataset.deviceId = device.deviceId;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(device.deviceId === selectedDiskId));
      const title = element("span", "recovery-row-title");
      title.append(element("span", "", `${device.model || device.name || devicePath(device) || "Device"}`), element("span", "", formatBytes(device.size)));
      const topology = [device.type, device.filesystemType, ...(device.mountpoints || [])].filter(Boolean).join(" · ") || "unformatted / unknown";
      const meta = element("span", "recovery-row-meta", `${topology}${device.serial ? ` · S/N ${device.serial}` : ""}`);
      const identity = element("span", "recovery-row-path", `${device.deviceId || "no stable id"} → ${devicePath(device)}`);
      row.append(title, meta, identity);
      return row;
    });
    if (nodes.length === 0) nodes.push(element("p", "recovery-row-meta", "Select an online agent and collect inventory."));
    replaceChildren(refs.disk_list, ...nodes);
    updateActionPreview();
  }

  function renderCases() {
    const selectedAgentId = snapshot?.selectedAgentId || "";
    const cases = (snapshot?.cases || []).filter((record) => !selectedAgentId || record.targetAgentId === selectedAgentId);
    const options = [element("option", "", "New case")];
    options[0].value = "";
    for (const record of cases) {
      const option = element("option", "", `${String(record.state || "open").toUpperCase()} · ${record.goal || record.id}`);
      option.value = record.id;
      options.push(option);
    }
    replaceChildren(refs.case_select, ...options);
    refs.case_select.value = snapshot?.selectedCaseId || snapshot?.selectedCase?.id || "";
    const caseId = snapshot?.selectedCase?.id || "";
    if (lastGoalCaseId !== caseId || document.activeElement !== refs.goal) {
      refs.goal.value = snapshot?.selectedCase?.goal || (caseId ? refs.goal.value : "");
      lastGoalCaseId = caseId;
    }
    const state = snapshot?.selectedCase?.state;
    refs.stop_case.disabled = !caseId || state !== "running";
    refs.resume_case.disabled = !caseId || state === "running" || ["completed", "abandoned"].includes(state);
  }

  function renderPlaybooks() {
    const selected = refs.playbook_select.value;
    const options = [element("option", "", "Select playbook")];
    options[0].value = "";
    for (const playbook of snapshot?.playbooks || []) {
      const option = element("option", "", playbook.title || playbook.id);
      option.value = playbook.id;
      options.push(option);
    }
    replaceChildren(refs.playbook_select, ...options);
    if ([...refs.playbook_select.options].some((option) => option.value === selected)) refs.playbook_select.value = selected;
    const plan = snapshot?.playbookPlan;
    refs.playbook_plan.textContent = plan
      ? `${plan.goal}\n${(plan.steps || []).map((step, index) => `${index + 1}. ${step.action} ${stringify(step.params || {})}`).join("\n")}`
      : "Expanded steps appear here before execution.";
  }

  function jobElapsed(job = {}) {
    const start = new Date(job.startedAt || job.leasedAt || job.createdAt || 0).getTime();
    const end = TERMINAL_JOB_STATES.has(job.state) ? new Date(job.completedAt || job.updatedAt || Date.now()).getTime() : Date.now();
    if (!Number.isFinite(start) || start <= 0) return "";
    const seconds = Math.max(0, Math.round((end - start) / 1_000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  function renderJobs() {
    const jobs = snapshot?.jobs || [];
    refs.job_count.textContent = String(jobs.length);
    const nodes = jobs.map((job) => {
      const row = element("article", "recovery-job-row");
      const title = element("div", "recovery-row-title");
      title.append(element("span", "", job.goal || job.steps?.[0]?.action || job.id), stateBadge(job.state));
      const current = (job.steps || []).find((step) => step.state === "running") || (job.steps || []).at(-1);
      row.append(title, element("div", "recovery-row-meta", `${jobElapsed(job)} · attempt ${job.attempt || 0}${current ? ` · ${current.action}` : ""}`), element("div", "recovery-row-path", job.id));
      const actions = element("div", "recovery-job-actions");
      if (!TERMINAL_JOB_STATES.has(job.state)) {
        const cancel = element("button", "", "Cancel");
        cancel.type = "button";
        cancel.dataset.cancelJob = job.id;
        actions.append(cancel);
      }
      if (["failed", "interrupted"].includes(job.state)) {
        const retry = element("button", "", "Retry");
        retry.type = "button";
        retry.dataset.retryJob = job.id;
        actions.append(retry);
      }
      if (actions.childElementCount) row.append(actions);
      return row;
    });
    if (nodes.length === 0) nodes.push(element("p", "recovery-row-meta", "No jobs in this case."));
    replaceChildren(refs.job_list, ...nodes);
  }

  function visibleOutputEvents() {
    const caseId = snapshot?.selectedCaseId || "";
    if (caseId !== outputCaseId) {
      outputCaseId = caseId;
      outputClearThroughSeq = 0;
    }
    return (snapshot?.events || []).filter((event) => outputEvent(event) && (Number(event.seq) || 0) > outputClearThroughSeq);
  }

  function outputText() {
    return visibleOutputEvents().map((event) => decodeOutput(event)).join("");
  }

  function renderOutput() {
    const nodes = visibleOutputEvents().map((event) => {
      const chunk = element("span", event.stream === "stderr" ? "recovery-output-stderr" : "", decodeOutput(event));
      chunk.dataset.stream = event.stream;
      return chunk;
    });
    replaceChildren(refs.output, ...nodes);
    if (refs.output_autoscroll.checked) refs.output.scrollTop = refs.output.scrollHeight;
  }

  function renderEvents() {
    const filter = refs.event_filter.value;
    const events = (snapshot?.events || []).filter((event) => !filter || String(event.type || "").includes(filter)).slice().reverse();
    const nodes = events.map((event) => {
      const row = element("article", "recovery-event-row");
      const at = new Date(event.at || 0);
      row.append(
        element("span", "recovery-event-time", Number.isNaN(at.getTime()) ? "--:--:--" : at.toLocaleTimeString()),
        element("span", "recovery-event-type", event.type || "event"),
        element("span", "recovery-event-detail", eventSummary(event)),
      );
      return row;
    });
    if (nodes.length === 0) nodes.push(element("p", "recovery-row-meta", "No matching events."));
    replaceChildren(refs.event_list, ...nodes);
  }

  function renderArtifacts() {
    const artifacts = snapshot?.artifacts || [];
    refs.artifact_count.textContent = String(artifacts.length);
    const nodes = artifacts.map((artifact) => {
      const row = element("article", `recovery-artifact-row${artifact.id === selectedArtifactId ? " is-selected" : ""}`);
      row.dataset.artifactId = artifact.id;
      const title = element("div", "recovery-row-title");
      title.append(element("span", "", artifact.filename || artifact.id), stateBadge(artifact.complete ? "completed" : "interrupted"));
      row.append(title, element("div", "recovery-row-meta", `${formatBytes(artifact.size)} · ${artifact.kind || "generic"}`), element("div", "recovery-row-path", artifact.hash || artifact.id));
      const actions = element("div", "recovery-artifact-actions");
      const download = element("button", "", "Download");
      download.type = "button";
      download.dataset.downloadArtifact = artifact.id;
      actions.append(download);
      if (downloadedArtifactPaths.has(artifact.id)) {
        const reveal = element("button", "", "Reveal");
        reveal.type = "button";
        reveal.dataset.revealArtifact = artifact.id;
        actions.append(reveal);
      }
      row.append(actions);
      return row;
    });
    if (nodes.length === 0) nodes.push(element("p", "recovery-row-meta", "No artifacts in this case."));
    replaceChildren(refs.artifact_list, ...nodes);
  }

  function renderPxe() {
    const pxe = snapshot?.pxe || {};
    refs.pxe_status.textContent = pxe.error?.message || (pxe.running ? `Running · PID ${pxe.pid || "?"}` : "Stopped");
    if (document.activeElement !== refs.pxe_interface && !refs.pxe_interface.value) refs.pxe_interface.value = pxe.interface || "";
    refs.pxe_controller.textContent = pxe.controllerUrl || pxe.bootUrl
      ? `controller ${pxe.controllerUrl || "unavailable"}\nboot ${pxe.bootUrl || "unavailable"}`
      : "Controller and boot URLs unavailable";
    refs.pxe_artifacts.textContent = pxe.bootArtifacts?.length
      ? pxe.bootArtifacts.map((artifact) => `${artifact.name} ${formatBytes(artifact.size)}`).join(" · ")
      : "No verified boot artifacts";
    refs.pxe_start.disabled = Boolean(pxe.running);
    refs.pxe_stop.disabled = !pxe.running;
  }

  function renderFleet() {
    const fleet = snapshot?.fleet || {};
    const machines = fleet.machines || snapshot?.agents || [];
    for (const id of [...selectedFleetTargets]) if (!machines.some((machine) => machine.agentId === id)) selectedFleetTargets.delete(id);
    const targets = machines.map((machine) => {
      const label = element("label", `recovery-fleet-target${selectedFleetTargets.has(machine.agentId) ? " is-selected" : ""}`);
      const input = element("input");
      input.type = "checkbox";
      input.checked = selectedFleetTargets.has(machine.agentId);
      input.dataset.fleetTarget = machine.agentId;
      const active = (snapshot?.jobs || []).filter((job) => job.targetAgentId === machine.agentId && !TERMINAL_JOB_STATES.has(job.state)).length;
      const health = Number(machine.healthFindings || machine.recommendations?.length || 0);
      label.append(input, element("span", "", machine.alias || machine.hostname || machine.agentId), stateBadge(machine.state), element("small", "", `${active} active · ${health} findings · boot ${machine.bootId || "unknown"}`));
      return label;
    });
    if (!targets.length) targets.push(element("p", "recovery-row-meta", "No fleet machines are known."));
    replaceChildren(refs.fleet_targets, ...targets);
    const selectedGroup = refs.fleet_group.value;
    const groupOptions = [element("option", "", "Selected machines")];
    groupOptions[0].value = "";
    for (const group of fleet.groups || []) {
      const option = element("option", "", group.name || group.id);
      option.value = group.id;
      groupOptions.push(option);
    }
    replaceChildren(refs.fleet_group, ...groupOptions);
    if ([...refs.fleet_group.options].some((option) => option.value === selectedGroup)) refs.fleet_group.value = selectedGroup;
    const runs = (fleet.runs || []).slice().sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 8);
    replaceChildren(refs.fleet_results, ...runs.map((run) => {
      const row = element("article", "recovery-event-row");
      const values = Object.values(run.targets || {});
      row.dataset.fleetRun = run.id;
      row.append(stateBadge(run.state), element("span", "recovery-event-detail", `${run.name || run.id} · ${values.filter((target) => target.state === "succeeded").length}/${values.length} succeeded${run.stopReason ? ` · ${run.stopReason}` : ""}`));
      if (["failed", "partial"].includes(run.state)) {
        const retry = element("button", "", "Retry failed");
        retry.type = "button";
        retry.dataset.retryFleet = run.id;
        row.append(retry);
      }
      return row;
    }));
    const schedules = (fleet.schedules || []).map((schedule) => element("article", "recovery-event-row", `${schedule.enabled ? "ON" : "OFF"} · ${schedule.name || schedule.id} · ${schedule.nextRunAt || "complete"}`));
    if (!schedules.length) schedules.push(element("p", "recovery-row-meta", "No saved schedules."));
    replaceChildren(refs.schedule_list, ...schedules);
  }

  function renderSessions() {
    const sessions = snapshot?.sessions || [];
    const selectedId = snapshot?.selectedSessionId || sessions[0]?.id || "";
    const tabs = sessions.map((session) => {
      const button = element("button", `recovery-tab${session.id === selectedId ? " is-active" : ""}`, `${session.title || session.agentId} · ${session.state}`);
      button.type = "button";
      button.dataset.sessionId = session.id;
      return button;
    });
    if (!tabs.length) tabs.push(element("span", "recovery-row-meta", "No terminal sessions."));
    replaceChildren(refs.session_tabs, ...tabs);
    const output = (snapshot?.sessionEvents || []).filter((event) => event.type === "session.output").map((event) => decodeOutput(event)).join("");
    refs.session_output.textContent = output || "Open a terminal on the selected machine. Output survives detach and reconnect within the advertised ring window.";
    refs.session_output.scrollTop = refs.session_output.scrollHeight;
    const disabled = !selectedId;
    for (const target of [refs.session_send, refs.session_interrupt, refs.session_detach, refs.session_reconnect, refs.session_terminate]) target.disabled = disabled;
    const tunnels = (snapshot?.tunnels || []).map((tunnel) => {
      const row = element("article", "recovery-event-row", `${tunnel.state} · 127.0.0.1:${tunnel.listenPort} → ${tunnel.targetHost}:${tunnel.targetPort}`);
      if (tunnel.state === "open") {
        const close = element("button", "", "Close");
        close.type = "button";
        close.dataset.closeTunnel = tunnel.id;
        row.append(close);
      }
      return row;
    });
    replaceChildren(refs.tunnel_list, ...tunnels);
    const selectedAdapter = refs.console_adapter.value;
    const adapters = (snapshot?.consoleAdapters || []).filter((adapter) => adapter.available);
    const adapterOptions = adapters.map((adapter) => {
      const option = element("option", "", `${adapter.protocol.toUpperCase()} · ${adapter.id}`);
      option.value = adapter.id;
      option.dataset.protocol = adapter.protocol;
      return option;
    });
    if (!adapterOptions.length) {
      const option = element("option", "", "No installed console adapter");
      option.value = "";
      adapterOptions.push(option);
    }
    replaceChildren(refs.console_adapter, ...adapterOptions);
    if ([...refs.console_adapter.options].some((option) => option.value === selectedAdapter)) refs.console_adapter.value = selectedAdapter;
  }

  function renderIntelligence() {
    const graph = snapshot?.planGraph;
    if (graph?.nodes?.length) {
      const nodes = graph.nodes.map((node) => {
        const row = element("article", `recovery-plan-node recovery-plan-${node.type || "fact"}`);
        row.append(element("strong", "", node.label || node.action || node.id), stateBadge(node.verified === true ? "succeeded" : node.state || "observed"), element("span", "recovery-row-meta", node.expectedObservation || node.summary || ""));
        return row;
      });
      replaceChildren(refs.plan_graph, ...nodes);
      const proofs = graph.nodes.filter((node) => node.type === "proof");
      refs.proof_summary.textContent = `${proofs.filter((node) => node.verified).length}/${proofs.length} proofs verified · current hypothesis ${graph.currentHypothesisId || "none"} · next action ${graph.nextActionId || "none"}`;
    } else {
      refs.plan_graph.textContent = "No autonomous plan graph has been recorded.";
      refs.proof_summary.textContent = "Final repair proof is required; exit zero alone is insufficient.";
    }
    const lanes = snapshot?.nextStage || {};
    const panels = [];
    const laneOperations = {
      continuity: [
        ["Machines", "store", "listMachines"], ["Timeline", "store", "getTimeline"], ["Inventory diff", "store", "diffMachine"], ["Health", "health", "recommendations"],
        ["Vault snapshots", "vault", "listSnapshots"], ["Vault diff", "vault", "diffSnapshots"], ["Vault scrub", "vault", "scrub"], ["Vault restore", "vault", "restoreSnapshot"], ["Vault capacity", "vault", "getStats"],
      ],
      sync: [
        ["Folder status", "engine", "getFolderStatus"], ["Peer status", "engine", "getPeerStatus"], ["Conflicts", "engine", "getConflicts"], ["Resolve conflict", "engine", "resolveConflict"],
        ["Versions", "engine", "getVersions"], ["Run sync", "engine", "sync"], ["Pause", "engine", "pause"], ["Resume", "engine", "resume"],
      ],
      imaging: [
        ["Image catalog", "catalog", "list"], ["Capture", "catalog", "capture"], ["Verify image", "catalog", "verify"], ["Inspect", "catalog", "inspect"],
        ["Deployment plan", "provisioning", "planDeployment"], ["Deploy plan", "provisioning", "deploy"],
      ],
      salvage: [
        ["Inventory", "engine", "inventory"], ["Capacity plan", "engine", "estimateCapacity"], ["Build plan", "engine", "plan"], ["Start", "engine", "start"], ["Resume", "engine", "resume"],
        ["Progress", "engine", "getProgress"], ["Preview", "engine", "preview"], ["Manifest", "engine", "getManifest"],
      ],
    };
    for (const [lane, adapter] of Object.entries(lanes)) {
      if (!adapter.available) continue;
      const panel = element("section", "recovery-utility-card");
      panel.append(element("strong", "", `${lane} · active`), element("span", "recovery-row-meta", stringify(adapter.capabilities || {})));
      const controls = element("div", "recovery-button-row");
      for (const [label, component, method] of laneOperations[lane] || []) {
        const button = element("button", "button button-small", label);
        button.type = "button";
        button.dataset.lane = lane;
        button.dataset.component = component;
        button.dataset.method = method;
        controls.append(button);
      }
      panel.append(controls);
      panels.push(panel);
    }
    if (!panels.length) panels.push(element("p", "recovery-row-meta", "Optional continuity, sync, imaging, and salvage lanes activate automatically when installed."));
    replaceChildren(refs.next_stage_panels, ...panels);
  }

  const paletteOperations = [
    ["fleet", "Execute fleet command", "fleet-command"], ["inventory", "Refresh machine health", "inventory"], ["terminal", "Open interactive terminal", "terminal"],
    ["tunnel", "Open TCP tunnel", "tunnel"], ["console", "Launch strongest console", "console"], ["autonomy", "Run autonomous case", "autonomy"],
    ["takeover", "Manual takeover", "takeover"], ["argv", "Execute raw argv", "argv"], ["shell", "Run unrestricted shell", "shell"],
    ["artifact", "Upload artifact", "artifact"], ["wake", "Send Wake-on-LAN", "wake"], ["pxe", "Start PXE plane", "pxe"],
    ["vault", "Browse continuity vault", "lane-continuity"], ["sync", "Inspect sync convergence", "lane-sync"], ["image", "Open image catalog", "lane-imaging"], ["salvage", "Open salvage planner", "lane-salvage"],
  ];

  function laneOperationArgs(lane, method, input = {}) {
    const selected = input.machineId || snapshot?.selectedAgentId || "";
    if (["listMachines", "getStats", "list"].includes(method)) return method === "listMachines" ? [input.query || {}] : method === "list" ? [input.query || {}] : [];
    if (method === "getTimeline") return [selected, input.query || {}];
    if (method === "diffMachine") return [selected, input.from, input.to];
    if (method === "recommendations") return [selected];
    if (method === "listSnapshots") return [input.query || {}];
    if (method === "diffSnapshots") return [input.left || input.leftSnapshotId, input.right || input.rightSnapshotId];
    if (method === "scrub") return [input.options || input];
    if (method === "restoreSnapshot") return [input.snapshotId, input.destination, input.options || {}];
    if (["getFolderStatus", "sync", "pause", "resume"].includes(method) && lane === "sync") return [input.folderId, input.options || {}];
    if (method === "getPeerStatus") return [input.peerId];
    if (method === "getConflicts") return [input.folderId, input.query || {}];
    if (method === "resolveConflict") return [input.conflictId, input.resolution];
    if (method === "getVersions") return [input.path || "", input.query || {}];
    if (method === "capture") return [input.source, input.options || {}];
    if (["verify", "inspect"].includes(method)) return [input.imageId, input.options || {}];
    if (method === "planDeployment") return [input.plan || input];
    if (method === "deploy") return [input.plan || input, input.options || {}];
    if (method === "inventory") return [input.source, input.options || {}];
    if (method === "estimateCapacity") return [input.inventory || input.inventoryId, input.destinations || [], input.options || {}];
    if (method === "plan") return [input.inventory || input.inventoryId, input.destinations || [], input.options || {}];
    if (["start", "resume"].includes(method) && lane === "salvage") return [input.job || input.jobId, input.options || {}];
    if (method === "getProgress") return [input.jobId];
    if (method === "preview") return [input.path, input.options || {}];
    if (method === "getManifest") return [input.jobId, input.options || {}];
    return Array.isArray(input.args) ? input.args : [];
  }

  function renderPalette() {
    const query = refs.command_palette_query.value.trim().toLowerCase();
    const matches = paletteOperations.filter((record) => !query || record.slice(0, 2).join(" ").toLowerCase().includes(query));
    replaceChildren(refs.command_palette_results, ...matches.map(([key, label, operation]) => {
      const button = element("button", "recovery-command-palette-item", label);
      button.type = "button";
      button.dataset.paletteOperation = operation;
      button.append(element("kbd", "", key));
      return button;
    }));
  }

  function togglePalette(open) {
    refs.command_palette.hidden = !open;
    if (open) {
      refs.command_palette_query.value = "";
      renderPalette();
      refs.command_palette_query.focus();
    }
  }

  function renderBusy() {
    const unavailable = !snapshot?.controller?.connected;
    const busy = Object.keys(snapshot?.busy || {}).length > 0;
    refs.refresh.disabled = busy;
    refs.inventory.disabled = unavailable || busy || !snapshot?.selectedAgentId;
    refs.run_action.disabled = unavailable || busy || !snapshot?.selectedAgentId || !selectedDiskId;
    refs.execute.disabled = unavailable || busy || !snapshot?.selectedAgentId;
    refs.shell_execute.disabled = unavailable || busy || !snapshot?.selectedAgentId;
    refs.run_case.disabled = unavailable || busy || !snapshot?.selectedAgentId;
    refs.playbook_run.disabled = unavailable || busy || !snapshot?.selectedAgentId || !refs.playbook_select.value;
    refs.resume_case.disabled = refs.resume_case.disabled || unavailable || busy;
    refs.stop_case.disabled = refs.stop_case.disabled || unavailable || busy;
    refs.upload.disabled = unavailable || busy;
    refs.wake.disabled = unavailable || busy || !refs.wake_mac.value.trim();
    refs.fleet_execute.disabled = unavailable || busy;
    refs.fleet_inventory.disabled = unavailable || busy;
    refs.session_open.disabled = unavailable || busy || !snapshot?.selectedAgentId;
    refs.tunnel_open.disabled = unavailable || busy || !snapshot?.selectedAgentId;
    refs.console_open.disabled = unavailable || busy || !refs.console_adapter.value;
  }

  function render() {
    renderController();
    renderAgents();
    renderAgentDetail();
    renderDisks();
    renderCases();
    renderPlaybooks();
    renderJobs();
    renderOutput();
    renderEvents();
    renderArtifacts();
    renderPxe();
    renderFleet();
    renderSessions();
    renderIntelligence();
    renderBusy();
  }

  function setState(nextState) {
    if (nextState !== undefined) snapshot = nextState;
    render();
  }

  function setConsoleMode(mode) {
    consoleMode = mode === "shell" ? "shell" : "command";
    const shell = consoleMode === "shell";
    refs.command_tab.classList.toggle("is-active", !shell);
    refs.shell_tab.classList.toggle("is-active", shell);
    refs.command_tab.setAttribute("aria-selected", String(!shell));
    refs.shell_tab.setAttribute("aria-selected", String(shell));
    refs.command_editor.hidden = shell;
    refs.shell_editor.hidden = !shell;
  }

  async function executeCommand() {
    const argv = parseArgv(refs.command.value);
    if (argv.length === 0) throw new Error("Enter an argv command first.");
    await perform(() => api().exec({
      agentId: snapshot?.selectedAgentId,
      caseId: snapshot?.selectedCaseId,
      argv,
      force: refs.force.checked,
    }), { success: `Submitted argv job: ${stringify(argv)}` });
  }

  async function executeShell() {
    const script = refs.shell.value;
    if (!script.trim()) throw new Error("Enter a Bash script first.");
    await perform(() => api().shell({
      agentId: snapshot?.selectedAgentId,
      caseId: snapshot?.selectedCaseId,
      script,
      force: refs.force.checked,
    }), { success: "Submitted unrestricted Bash job." });
  }

  async function runGoal() {
    const goal = refs.goal.value.trim();
    if (!goal) throw new Error("Enter a recovery goal first.");
    await perform(async () => {
      let caseId = snapshot?.selectedCaseId || "";
      if (!caseId) {
        const record = await api().createCase({ agentId: snapshot?.selectedAgentId, goal, autonomous: true });
        caseId = record.id;
      } else if (goal !== snapshot?.selectedCase?.goal) {
        await api().updateGoal({ caseId, goal });
      }
      return api().runCase(caseId);
    }, { success: "Autonomous recovery case is running." });
  }

  async function runTypedAction() {
    const params = JSON.parse(refs.action_params.value || "{}");
    const action = refs.action_name.value;
    await perform(() => api().submitJob({
      targetAgentId: snapshot?.selectedAgentId,
      caseId: snapshot?.selectedCaseId,
      goal: `${action} on ${devicePath(selectedDisk()) || snapshot?.selectedAgentId}`,
      force: refs.force.checked,
      steps: [{ id: "desktop_typed_action", action, params, force: refs.force.checked, timeoutMs: 30 * 60 * 1_000 }],
    }), { success: `Submitted ${action}.` });
  }

  function updateCommandPreview() {
    try {
      refs.command_exact.textContent = `argv: ${JSON.stringify(parseArgv(refs.command.value))}`;
    } catch (error) {
      refs.command_exact.textContent = error.message;
    }
  }

  function fleetRequest(operation) {
    return {
      targetIds: [...selectedFleetTargets],
      groupId: refs.fleet_group.value || "",
      query: refs.fleet_query.value.trim() || "",
      operation,
      rollout: {
        mode: refs.fleet_rollout.value,
        concurrency: Math.max(1, Number(refs.fleet_concurrency.value) || 1),
        canaryCount: 1,
        stop: refs.fleet_rollout.value === "canary" ? { onAnyFailure: true } : {},
      },
    };
  }

  async function executeFleetCommand() {
    const argv = parseArgv(refs.fleet_command.value);
    if (!argv.length) throw new Error("Enter exact fleet argv first.");
    return perform(() => api().executeFleet(fleetRequest({ type: "command", argv, force: refs.force.checked })), { success: `Fleet rollout submitted to ${selectedFleetTargets.size || refs.fleet_group.value || "query"}.` });
  }

  async function openTerminal() {
    if (!snapshot?.selectedAgentId) throw new Error("Select a recovery machine first.");
    return perform(() => api().openSession({ agentId: snapshot.selectedAgentId, caseId: snapshot.selectedCaseId || "", cwd: refs.session_cwd.value.trim() || "" }), { success: "Interactive terminal opened." });
  }

  function paletteOperation(operation) {
    togglePalette(false);
    if (operation === "fleet-command") { refs.fleet_command.focus(); return; }
    if (operation === "inventory") { refs.inventory.click(); return; }
    if (operation === "terminal") { refs.session_open.click(); return; }
    if (operation === "tunnel") { refs.tunnel_port.focus(); return; }
    if (operation === "console") { refs.console_target.focus(); return; }
    if (operation === "autonomy") { refs.run_case.click(); return; }
    if (operation === "takeover") { refs.manual_takeover.click(); return; }
    if (operation === "argv") { setConsoleMode("command"); refs.command.focus(); return; }
    if (operation === "shell") { setConsoleMode("shell"); refs.shell.focus(); return; }
    if (operation === "artifact") { refs.upload_path.focus(); return; }
    if (operation === "wake") { refs.wake_mac.focus(); return; }
    if (operation === "pxe") { refs.pxe_start.click(); return; }
    const lane = operation.replace(/^lane-/, "");
    refs.next_stage_panels.querySelector(`[data-lane="${lane}"]`)?.click();
  }

  function bind() {
    if (bound) return;
    bound = true;
    filesSwitch.addEventListener("click", () => switchWorkspace("files"));
    recoverySwitch.addEventListener("click", () => switchWorkspace("recovery"));
    refs.refresh.addEventListener("click", () => void perform(() => api().refresh(), { refresh: false }).then(setState).catch(() => {}));
    refs.agent_list.addEventListener("click", (event) => {
      const row = event.target.closest("[data-agent-id]");
      if (row) void perform(() => api().selectAgent(row.dataset.agentId)).then(setState).catch(() => {});
    });
    refs.inventory.addEventListener("click", () => void perform(() => api().requestInventory({ agentId: snapshot?.selectedAgentId })).catch(() => {}));
    refs.disk_list.addEventListener("click", (event) => {
      const row = event.target.closest("[data-device-id]");
      if (row) selectDisk(row.dataset.deviceId);
    });
    refs.action_name.addEventListener("change", () => {
      const params = defaultActionParams();
      if (refs.action_name.value === "filesystem.mount") params.target = "/mnt/workwire/target";
      refs.action_params.value = JSON.stringify(params, null, 2);
      updateActionPreview();
    });
    refs.action_params.addEventListener("input", updateActionPreview);
    refs.run_action.addEventListener("click", () => void runTypedAction().catch((error) => showMessage(error.message, "error")));
    refs.case_select.addEventListener("change", () => void perform(() => api().selectCase(refs.case_select.value), { refresh: false }).then(setState).catch(() => {}));
    refs.run_case.addEventListener("click", () => void runGoal().catch((error) => showMessage(error.message, "error")));
    refs.resume_case.addEventListener("click", () => void perform(() => api().runCase(snapshot?.selectedCaseId), { success: "Recovery case resumed." }).catch(() => {}));
    refs.stop_case.addEventListener("click", () => void perform(() => api().stopCase(snapshot?.selectedCaseId), { success: "Recovery case stopped." }).catch(() => {}));
    refs.playbook_select.addEventListener("change", () => {
      snapshot.playbookPlan = null;
      renderPlaybooks();
      renderBusy();
    });
    refs.playbook_run.addEventListener("click", () => void perform(() => api().runPlaybook({
      playbookId: refs.playbook_select.value,
      agentId: snapshot?.selectedAgentId,
      inputs: JSON.parse(refs.playbook_inputs.value || "{}"),
      force: refs.force.checked,
    }), { success: "Expanded playbook submitted as one recovery job." }).catch((error) => showMessage(error.message, "error")));
    refs.command_tab.addEventListener("click", () => setConsoleMode("command"));
    refs.shell_tab.addEventListener("click", () => setConsoleMode("shell"));
    refs.command.addEventListener("input", updateCommandPreview);
    refs.execute.addEventListener("click", () => void executeCommand().catch((error) => showMessage(error.message, "error")));
    refs.shell_execute.addEventListener("click", () => void executeShell().catch((error) => showMessage(error.message, "error")));
    refs.job_list.addEventListener("click", (event) => {
      const cancel = event.target.closest("[data-cancel-job]");
      const retry = event.target.closest("[data-retry-job]");
      if (cancel) void perform(() => api().cancelJob(cancel.dataset.cancelJob), { success: "Cancel requested." }).catch(() => {});
      if (retry) void perform(() => api().retryJob(retry.dataset.retryJob), { success: "Job queued for retry." }).catch(() => {});
    });
    refs.event_filter.addEventListener("change", renderEvents);
    refs.output_clear.addEventListener("click", () => {
      outputClearThroughSeq = (snapshot?.events || []).reduce((maximum, event) => outputEvent(event) ? Math.max(maximum, Number(event.seq) || 0) : maximum, outputClearThroughSeq);
      renderOutput();
    });
    refs.output_copy.addEventListener("click", () => void (api().copyText
      ? api().copyText(outputText())
      : navigator.clipboard.writeText(outputText())).then(() => showMessage("Output copied.", "success")).catch((error) => showMessage(error.message, "error")));
    refs.output_save.addEventListener("click", () => void (api().saveText
      ? api().saveText({ text: outputText(), suggestedName: `${snapshot?.selectedCaseId || "recovery"}-output.log` })
      : Promise.reject(new Error("Output save is unavailable."))).then((result) => {
      if (!result?.canceled) showMessage(`Saved output to ${result.path}.`, "success");
    }).catch((error) => showMessage(error.message, "error")));
    refs.artifact_list.addEventListener("click", (event) => {
      const row = event.target.closest("[data-artifact-id]");
      if (row) selectedArtifactId = row.dataset.artifactId;
      const button = event.target.closest("[data-download-artifact]");
      if (button) {
        const destinationPath = refs.download_path.value.trim();
        void perform(() => api().download({ artifactId: button.dataset.downloadArtifact, destinationPath }), { success: `Downloaded artifact to ${destinationPath}.` }).then((result) => {
          downloadedArtifactPaths.set(button.dataset.downloadArtifact, result.path || destinationPath);
          renderArtifacts();
        }).catch(() => {});
      }
      const reveal = event.target.closest("[data-reveal-artifact]");
      if (reveal) void api().revealPath(downloadedArtifactPaths.get(reveal.dataset.revealArtifact)).catch((error) => showMessage(error.message, "error"));
      renderArtifacts();
    });
    refs.upload.addEventListener("click", () => void perform(() => api().upload({
      sourcePath: refs.upload_path.value.trim(),
      caseId: snapshot?.selectedCaseId,
    }), { success: "Artifact uploaded and hash verified." }).catch(() => {}));
    refs.wake.addEventListener("click", () => void perform(() => api().wake({
      mac: refs.wake_mac.value.trim(),
      broadcast: refs.wake_broadcast.value.trim() || undefined,
      burst: 3,
    }), { success: "Wake packet burst sent; target check-in is shown separately." }).catch(() => {}));
    refs.pxe_start.addEventListener("click", () => void perform(() => api().pxeStart({ interfaceName: refs.pxe_interface.value.trim() }), { success: "PXE proxyDHCP/TFTP started." }).catch(() => {}));
    refs.pxe_stop.addEventListener("click", () => void perform(() => api().pxeStop(), { success: "PXE helper stopped." }).catch(() => {}));
    refs.pxe_rebuild.addEventListener("click", () => void perform(() => api().pxePrepare({ interfaceName: refs.pxe_interface.value.trim() }), { success: "PXE configuration and boot manifest rebuilt." }).catch(() => {}));
    refs.pxe_arm.addEventListener("click", () => void perform(() => api().setBootPolicy({
      mac: refs.wake_mac.value.trim(), next: "recovery", after: "local", name: snapshot?.selectedAgent?.hostname || "",
    }), { success: "Selected MAC is armed for one recovery boot, then local boot." }).catch(() => {}));
    refs.pxe_local.addEventListener("click", () => void perform(() => api().setBootPolicy({
      mac: refs.wake_mac.value.trim(), next: "local", after: "local", name: snapshot?.selectedAgent?.hostname || "",
    }), { success: "Selected MAC is set to local boot." }).catch(() => {}));
    refs.fleet_targets.addEventListener("change", (event) => {
      const input = event.target.closest("[data-fleet-target]");
      if (!input) return;
      if (input.checked) selectedFleetTargets.add(input.dataset.fleetTarget);
      else selectedFleetTargets.delete(input.dataset.fleetTarget);
      renderFleet();
    });
    refs.fleet_execute.addEventListener("click", () => void executeFleetCommand().catch((error) => showMessage(error.message, "error")));
    refs.fleet_inventory.addEventListener("click", () => void perform(() => api().executeFleet(fleetRequest({ type: "health-refresh" })), { success: "Fleet health refresh submitted." }).catch(() => {}));
    refs.fleet_results.addEventListener("click", (event) => {
      const retry = event.target.closest("[data-retry-fleet]");
      if (retry) void perform(() => api().retryFleetFailed(retry.dataset.retryFleet), { success: "Failed fleet targets queued again." }).catch(() => {});
    });
    refs.schedule_save.addEventListener("click", () => void perform(() => {
      const spec = JSON.parse(refs.schedule_spec.value || "{}");
      if (!spec.at && !spec.everyMs && !spec.timing?.everyMs) throw new Error("Schedule JSON requires at or everyMs.");
      return api().saveFleetSchedule({ ...spec, selection: fleetRequest({}).selection || { targetIds: [...selectedFleetTargets], groupId: refs.fleet_group.value, query: refs.fleet_query.value.trim() }, operation: spec.operation || { type: "command", argv: parseArgv(refs.fleet_command.value) }, rollout: spec.rollout || fleetRequest({}).rollout });
    }, { success: "Restart-safe fleet schedule saved." }).catch((error) => showMessage(error.message, "error")));
    refs.session_open.addEventListener("click", () => void openTerminal().catch((error) => showMessage(error.message, "error")));
    refs.session_tabs.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-session-id]");
      if (tab) void perform(() => api().selectSession(tab.dataset.sessionId), { refresh: false }).then(setState).catch(() => {});
    });
    refs.session_send.addEventListener("click", () => void perform(() => api().sessionInput({ sessionId: snapshot?.selectedSessionId, data: refs.session_input.value }), { success: "Terminal input sent." }).then(() => { refs.session_input.value = ""; }).catch(() => {}));
    refs.session_interrupt.addEventListener("click", () => void perform(() => api().sessionSignal({ sessionId: snapshot?.selectedSessionId, signal: "SIGINT" }), { success: "SIGINT delivered." }).catch(() => {}));
    refs.session_detach.addEventListener("click", () => void perform(() => api().sessionDetach(snapshot?.selectedSessionId), { success: "Terminal detached; process remains on the agent." }).catch(() => {}));
    refs.session_reconnect.addEventListener("click", () => void perform(() => api().sessionReconnect(snapshot?.selectedSessionId), { success: "Terminal output replayed from the last sequence." }).catch(() => {}));
    refs.session_terminate.addEventListener("click", () => void perform(() => api().sessionTerminate(snapshot?.selectedSessionId), { success: "Terminal termination requested." }).catch(() => {}));
    refs.tunnel_open.addEventListener("click", () => void perform(() => api().openTunnel({ agentId: snapshot?.selectedAgentId, targetHost: refs.tunnel_host.value.trim(), targetPort: Number(refs.tunnel_port.value), listenHost: "127.0.0.1" }), { success: "TCP tunnel opened through selected agent." }).catch(() => {}));
    refs.tunnel_list.addEventListener("click", (event) => {
      const close = event.target.closest("[data-close-tunnel]");
      if (close) void perform(() => api().closeTunnel(close.dataset.closeTunnel), { success: "Tunnel closed." }).catch(() => {});
    });
    refs.console_open.addEventListener("click", () => void perform(() => {
      const option = refs.console_adapter.selectedOptions[0];
      return api().launchConsole({ adapterId: refs.console_adapter.value, protocol: option?.dataset.protocol || "ssh", target: refs.console_target.value.trim() });
    }, { success: "Console adapter launched with exact configured argv." }).catch(() => {}));
    refs.manual_takeover.addEventListener("click", () => void perform(async () => {
      if (!snapshot?.selectedCaseId) throw new Error("Select an autonomous case first.");
      try { await api().submitCaseAction({ caseId: snapshot.selectedCaseId, action: { type: "planner.takeover", reason: "desktop-manual-takeover" } }); }
      catch { await api().stopCase(snapshot.selectedCaseId); }
    }, { success: "Autonomy stopped for unrestricted manual takeover." }).catch(() => {}));
    refs.next_stage_panels.addEventListener("click", (event) => {
      const button = event.target.closest("[data-lane][data-method]");
      if (!button) return;
      let input;
      try { input = JSON.parse(refs.next_stage_input.value.trim() || "{}"); }
      catch (error) { showMessage(`Lane operation JSON: ${error.message}`, "error"); return; }
      const args = laneOperationArgs(button.dataset.lane, button.dataset.method, input);
      void perform(() => api().invokeNextStage({ lane: button.dataset.lane, component: button.dataset.component, method: button.dataset.method, args }), { refresh: false }).then((result) => {
        refs.next_stage_output.textContent = stringify(result);
        showMessage(`${button.textContent} completed.`, "success");
      }).catch(() => {});
    });
    refs.command_palette_open.addEventListener("click", () => togglePalette(true));
    refs.command_palette_close.addEventListener("click", () => togglePalette(false));
    refs.command_palette_query.addEventListener("input", renderPalette);
    refs.command_palette_results.addEventListener("click", (event) => {
      const button = event.target.closest("[data-palette-operation]");
      if (button) paletteOperation(button.dataset.paletteOperation);
    });
    updateCommandPreview();
    setConsoleMode("command");
  }

  function handleKeydown(event) {
    const commandKey = event.ctrlKey || event.metaKey;
    if (commandKey && !event.altKey && event.key === "1") {
      event.preventDefault();
      switchWorkspace("files");
      return true;
    }
    if (commandKey && !event.altKey && event.key === "2") {
      event.preventDefault();
      switchWorkspace("recovery");
      return true;
    }
    if (commandKey && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      switchWorkspace("recovery");
      togglePalette(true);
      return true;
    }
    if (!refs.command_palette.hidden && event.key === "Escape") {
      event.preventDefault();
      togglePalette(false);
      return true;
    }
    if (workspace !== "recovery") return false;
    if (commandKey && event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) void runGoal().catch((error) => showMessage(error.message, "error"));
      else if (consoleMode === "shell") void executeShell().catch((error) => showMessage(error.message, "error"));
      else void executeCommand().catch((error) => showMessage(error.message, "error"));
      return true;
    }
    if (event.key === "Escape") {
      const target = event.target;
      if (target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable)) {
        event.preventDefault();
        target.blur();
        if (target === refs.goal) refs.goal.value = snapshot?.selectedCase?.goal || "";
        showMessage("");
        return true;
      }
    }
    return false;
  }

  return {
    bind,
    setState,
    switchWorkspace,
    handleKeydown,
    get workspace() { return workspace; },
  };
}
