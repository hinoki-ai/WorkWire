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
