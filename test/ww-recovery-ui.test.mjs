import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createRecoveryRenderer } from "../desktop/ww/recovery-renderer.js";

const html = await fs.readFile(new URL("../desktop/ww/index.html", import.meta.url), "utf8");
const preload = await fs.readFile(new URL("../desktop/ww-preload.cjs", import.meta.url), "utf8");
const main = await fs.readFile(new URL("../desktop/ww-main.mjs", import.meta.url), "utf8");
const recoveryRenderer = await fs.readFile(new URL("../desktop/ww/recovery-renderer.js", import.meta.url), "utf8");

test("Recovery workspace contract keeps networking in trusted IPC and exposes the complete vertical slice", () => {
  for (const id of [
    "workspace-files", "workspace-recovery", "recovery-agent-list", "recovery-disk-list", "recovery-goal",
    "recovery-job-list", "recovery-output", "recovery-event-list", "recovery-artifact-list", "recovery-command",
    "recovery-shell", "recovery-force", "recovery-wake", "recovery-pxe-start", "recovery-pxe-stop",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /connect-src 'none'/);
  assert.match(preload, /recovery:\s*Object\.freeze/);
  for (const method of ["exec", "shell", "runCase", "stopCase", "cancelJob", "retryJob", "upload", "download", "wake", "pxeStart", "pxeStop"]) {
    assert.match(preload, new RegExp(`${method}:`));
  }
  assert.match(main, /handleTrusted\("ww:recovery-exec"/);
  assert.match(main, /handleTrusted\("ww:recovery-shell"/);
  assert.match(main, /recoveryManager\?\.getState\(\)/);
  assert.doesNotMatch(recoveryRenderer, /innerHTML\s*=/);
  assert.doesNotMatch(recoveryRenderer, /fetch\s*\(/);
  assert.doesNotMatch(recoveryRenderer, /WebSocket/);
  assert.doesNotMatch(preload, /WW_RECOVERY_TOKEN|controllerToken/);
});

test("Recovery renderer handles empty/live/offline fleets, complex disks, output, and one-time workspace binding", async () => {
  const dom = new JSDOM(html, { url: "https://workwire.local/ww/index.html" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.HTMLElement = dom.window.HTMLElement;
  const calls = [];
  let currentState = null;
  const api = {
    async refresh() { calls.push(["refresh"]); return currentState; },
    async selectAgent(agentId) { calls.push(["selectAgent", agentId]); return currentState; },
    async requestInventory(payload) { calls.push(["inventory", payload]); return currentState.inventory; },
    async selectCase(caseId) { calls.push(["selectCase", caseId]); return currentState; },
    async updateGoal(payload) { calls.push(["goal", payload]); return currentState.selectedCase; },
    async runCase(caseId) { calls.push(["runCase", caseId]); return {}; },
    async stopCase(caseId) { calls.push(["stopCase", caseId]); return {}; },
    async submitJob(payload) { calls.push(["job", payload]); return { id: "wwj_new" }; },
    async exec(payload) { calls.push(["exec", payload]); return { id: "wwj_exec" }; },
    async shell(payload) { calls.push(["shell", payload]); return { id: "wwj_shell" }; },
    async cancelJob(jobId) { calls.push(["cancel", jobId]); return {}; },
    async retryJob(jobId) { calls.push(["retry", jobId]); return {}; },
    async upload(payload) { calls.push(["upload", payload]); return {}; },
    async download(payload) { calls.push(["download", payload]); return { path: payload.destinationPath }; },
    async wake(payload) { calls.push(["wake", payload]); return {}; },
    async pxeStart(payload) { calls.push(["pxeStart", payload]); return {}; },
    async pxeStop() { calls.push(["pxeStop"]); return {}; },
    async pxePrepare(payload) { calls.push(["pxePrepare", payload]); return {}; },
    async copyText(value) { calls.push(["copy", value]); },
    async saveText(payload) { calls.push(["save", payload]); return { canceled: true }; },
    async revealPath(targetPath) { calls.push(["reveal", targetPath]); },
  };
  try {
    const renderer = createRecoveryRenderer({ recoveryApi: () => api });
    renderer.bind();
    renderer.bind();
    currentState = {
      controller: { connected: false, info: null, error: { message: "Controller restarting" } },
      agents: [], selectedAgentId: "", selectedAgent: null, inventory: null, cases: [], selectedCaseId: "",
      selectedCase: null, jobs: [], events: [], artifacts: [], busy: {}, pxe: { running: false },
    };
    renderer.setState(currentState);
    assert.match(dom.window.document.getElementById("recovery-controller-status").textContent, /Controller restarting/);
    assert.match(dom.window.document.getElementById("recovery-agent-list").textContent, /No recovery agents/);

    currentState = {
      controller: { connected: true, info: { port: 4852, agentsOnline: 1 }, error: null },
      agents: [
        { agentId: "wwra_live", hostname: "patient-live", state: "online", mode: "pxe", lastSeenAt: new Date().toISOString(), addresses: [{ address: "192.168.8.50", mac: "00:11:22:33:44:55" }] },
        { agentId: "wwra_offline", hostname: "patient-offline", state: "offline", mode: "installed", lastSeenAt: "2026-07-16T00:00:00Z", addresses: [] },
      ],
      selectedAgentId: "wwra_live",
      selectedAgent: { agentId: "wwra_live", hostname: "patient-live", bootId: "boot-live", state: "online", mode: "pxe", lastSeenAt: new Date().toISOString(), addresses: [{ address: "192.168.8.50", mac: "00:11:22:33:44:55" }], capabilities: { root: true, tools: { lsblk: true, smartctl: true } } },
      inventory: {
        collectedAt: new Date().toISOString(),
        block: { devices: [
          { deviceId: "disk_nvme_serial", canonicalPath: "/dev/nvme0n1", type: "disk", model: "Test NVMe", serial: "SERIAL-1", size: 1_000_000_000_000, mountpoints: [] },
          { deviceId: "part_root_uuid", canonicalPath: "/dev/nvme0n1p2", type: "part", filesystemType: "ext4", size: 900_000_000_000, mountpoints: ["/mnt/root"] },
        ] },
        health: { smart: [{ passed: false, pendingSectors: 2 }], nvme: [] },
        errors: [{ collector: "mdadm", message: "not installed" }],
      },
      cases: [{ id: "wwc_case", targetAgentId: "wwra_live", goal: "Repair boot", state: "running" }],
      selectedCaseId: "wwc_case",
      selectedCase: { id: "wwc_case", targetAgentId: "wwra_live", goal: "Repair boot", state: "running" },
      jobs: [{ id: "wwj_job", goal: "Inspect disk", state: "running", attempt: 1, createdAt: new Date().toISOString(), steps: [{ action: "disk.inventory", state: "running" }] }],
      events: [
        { seq: 1, at: new Date().toISOString(), type: "step.output", stream: "stdout", data: "stdout line\n", encoding: "utf8", jobId: "wwj_job" },
        { seq: 2, at: new Date().toISOString(), type: "step.output", stream: "stderr", data: "stderr line\n", encoding: "utf8", jobId: "wwj_job" },
        { seq: 3, at: new Date().toISOString(), type: "planner.observation", jobId: "wwj_job" },
      ],
      artifacts: [{ id: "wwa_log", filename: "inventory.json", kind: "inventory", size: 1234, complete: true, hash: "sha256:abc" }],
      busy: {}, pxe: { running: false, interface: "eno1", pid: null },
    };
    renderer.setState(currentState);
    assert.match(dom.window.document.getElementById("recovery-agent-list").textContent, /patient-live/);
    assert.match(dom.window.document.getElementById("recovery-agent-list").textContent, /patient-offline/);
    assert.match(dom.window.document.getElementById("recovery-disk-list").textContent, /Test NVMe/);
    assert.match(dom.window.document.getElementById("recovery-inventory-summary").textContent, /1 health warning/);
    assert.match(dom.window.document.getElementById("recovery-output").textContent, /stdout line/);
    assert.match(dom.window.document.getElementById("recovery-output").textContent, /stderr line/);
    assert.equal(dom.window.document.querySelectorAll("#recovery-output .recovery-output-stderr").length, 1);
    assert.equal(dom.window.document.getElementById("recovery-job-count").textContent, "1");
    assert.equal(dom.window.document.getElementById("recovery-artifact-count").textContent, "1");

    dom.window.document.getElementById("workspace-recovery").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.filter(([name]) => name === "refresh").length, 1);
    assert.equal(dom.window.document.getElementById("files-workspace").hidden, true);

    const command = dom.window.document.getElementById("recovery-command");
    command.value = '["printf","%s","a b","$(literal)"]';
    dom.window.document.getElementById("recovery-force").checked = true;
    dom.window.document.getElementById("recovery-execute").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const exec = calls.find(([name]) => name === "exec");
    assert.deepEqual(exec[1].argv, ["printf", "%s", "a b", "$(literal)"]);
    assert.equal(exec[1].force, true);

    renderer.handleKeydown(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some(([name, caseId]) => name === "runCase" && caseId === "wwc_case"));
  } finally {
    dom.window.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    if (previous.navigatorDescriptor) Object.defineProperty(globalThis, "navigator", previous.navigatorDescriptor);
    else delete globalThis.navigator;
    globalThis.HTMLElement = previous.HTMLElement;
  }
});
