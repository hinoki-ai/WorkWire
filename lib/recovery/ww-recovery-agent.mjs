import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createRecoveryExecutor } from "./ww-recovery-executor.mjs";
import { createRecoveryInventoryCollector } from "./ww-recovery-inventory.mjs";
import { resolveRecoveryAgentIdentity } from "./ww-recovery-agent-id.mjs";
import { createRecoveryActionRegistry } from "./ww-recovery-actions.mjs";
import { createRecoveryClient } from "./ww-recovery-client.mjs";
import { createRecoveryArtifacts } from "./ww-recovery-artifacts.mjs";
import { WW_RECOVERY_PROTOCOL_VERSION } from "./ww-recovery-config.mjs";
import { recoveryPlatformDefaults, WINDOWS_CAPABILITY_TOOLS } from "./ww-recovery-platform.mjs";
import { createInteractiveAgentRuntime } from "./ww-recovery-interactive.mjs";
import { buildPlatformActionCapabilityMatrix } from "./ww-recovery-capabilities.mjs";
import { createWindowsFileServiceWatchdog } from "./ww-recovery-file-service-watchdog.mjs";
import { renameRecoveryFile } from "./ww-recovery-atomic.mjs";

const AGENT_VERSION = "0.1.0";
const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 15_000];

function iso() {
  return new Date().toISOString();
}

function parseKernelCommandLine(value = "") {
  const result = {};
  for (const token of String(value || "").trim().split(/\s+/)) {
    const index = token.indexOf("=");
    if (index === -1) continue;
    result[token.slice(0, index)] = token.slice(index + 1);
  }
  return result;
}

async function readJson(fsImpl, filename) {
  // Windows PowerShell 5 writes UTF-8 config files with a BOM, which JSON.parse rejects.
  try { return JSON.parse(String(await fsImpl.readFile(filename, "utf8")).replace(/^\uFEFF/u, "")); } catch { return {}; }
}

async function readText(fsImpl, filename) {
  try { return String(await fsImpl.readFile(filename, "utf8")); } catch { return ""; }
}

export async function resolveRecoveryAgentOptions({
  cli = {},
  env = process.env,
  fsImpl = fs,
  platform = process.platform,
  configPath,
  cmdlinePath,
} = {}) {
  const platformDefaults = recoveryPlatformDefaults(platform, env);
  const resolvedConfigPath = configPath ?? platformDefaults.configPath;
  const resolvedCmdlinePath = cmdlinePath ?? platformDefaults.cmdlinePath;
  const fileConfig = await readJson(fsImpl, resolvedConfigPath);
  const kernel = resolvedCmdlinePath ? parseKernelCommandLine(await readText(fsImpl, resolvedCmdlinePath)) : {};
  const controllerUrl = String(
    cli.controllerUrl || cli.controller
    || env.WW_RECOVERY_CONTROLLER_URL
    || fileConfig.controllerUrl || fileConfig.controller
    || kernel["ww.controller"]
    || "",
  ).trim();
  const token = String(
    cli.token !== undefined ? cli.token
      : env.WW_RECOVERY_TOKEN !== undefined ? env.WW_RECOVERY_TOKEN
        : fileConfig.token !== undefined ? fileConfig.token
          : kernel["ww.token"] || "",
  );
  const mode = String(
    cli.mode || env.WW_RECOVERY_AGENT_MODE || fileConfig.mode || kernel["ww.mode"] || "installed",
  ).toLowerCase();
  return {
    controllerUrl,
    token,
    id: String(cli.id || env.WW_RECOVERY_AGENT_ID || fileConfig.id || kernel["ww.agent-id"] || "").trim(),
    name: String(cli.name || env.WW_RECOVERY_AGENT_NAME || fileConfig.name || kernel["ww.agent-name"] || os.hostname()).trim(),
    mode: mode === "pxe" ? "pxe" : "installed",
    debug: cli.debug === true || env.WW_RECOVERY_DEBUG === "1" || kernel["ww.debug"] === "1",
    stateDir: String(cli.stateDir || env.WW_RECOVERY_AGENT_STATE_DIR || fileConfig.stateDir || "").trim(),
  };
}

function websocketUrl(controllerUrl) {
  const url = new URL(controllerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/recovery/socket";
  url.search = "";
  return url.toString();
}

function addresses() {
  const results = [];
  for (const [name, records] of Object.entries(os.networkInterfaces())) {
    for (const record of records || []) {
      if (record.internal) continue;
      results.push({
        name,
        mac: String(record.mac || "").toLowerCase(),
        address: String(record.address || ""),
        family: String(record.family || ""),
      });
    }
  }
  return results;
}

async function atomicJson(fsImpl, filename, value, platform = process.platform) {
  await fsImpl.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filename}.${process.pid}.tmp`;
  try {
    await fsImpl.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await renameRecoveryFile(fsImpl, temporaryPath, filename, { platform });
  } finally {
    await fsImpl.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export function createRecoveryAgent({
  controllerUrl,
  token = "",
  id = "",
  name = os.hostname(),
  mode = "installed",
  stateDir = "",
  identity: providedIdentity = null,
  executor = createRecoveryExecutor(),
  inventory: providedInventory = null,
  registry: providedRegistry = null,
  artifacts: providedArtifacts = null,
  WebSocketImpl = WebSocket,
  fsImpl = fs,
  log = () => {},
  reconnectDelays = RECONNECT_DELAYS,
  heartbeatMs = 5_000,
  installedIdPath,
  platform = process.platform,
} = {}) {
  if (!controllerUrl) throw new TypeError("Recovery agent requires a controller URL.");
  const platformDefaults = recoveryPlatformDefaults(platform);
  const resolvedStateDir = path.resolve(stateDir || (mode === "pxe" ? platformDefaults.pxeStateDir : platformDefaults.installedStateDir));
  const outboundPath = path.join(resolvedStateDir, "outbound-events.jsonl");
  const currentJobPath = path.join(resolvedStateDir, "current-job.json");
  const completedJobPath = path.join(resolvedStateDir, "completed-job.json");
  const controllerClient = createRecoveryClient({ url: controllerUrl, token, transferTimeoutMs: 0 });
  const artifacts = providedArtifacts || createRecoveryArtifacts({ client: controllerClient, fsImpl });
  const inventoryCollector = providedInventory || createRecoveryInventoryCollector({ executor, fsImpl });
  const registry = providedRegistry || createRecoveryActionRegistry({ executor, inventory: inventoryCollector, artifacts });
  let identity = providedIdentity;
  let socket = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let stopping = false;
  let shutdownInterruptionReason = "";
  let connected = false;
  let welcomed = false;
  let sessionId = "";
  let currentJob = null;
  let currentAbortController = null;
  let activeExecutionPromise = null;
  let completedJob = null;
  let agentSeq = 0;
  let eventTail = Promise.resolve();
  let messageTail = Promise.resolve();
  let interactiveRuntime = null;
  let initialResolve;
  let initialReject;
  const initialConnection = new Promise((resolve, reject) => {
    initialResolve = resolve;
    initialReject = reject;
  });

  function send(message) {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  async function readOutbound() {
    const raw = await readText(fsImpl, outboundPath);
    const events = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        events.push(value);
        agentSeq = Math.max(agentSeq, Number(value.agentSeq) || 0);
      } catch {}
    }
    return events;
  }

  function compactOutbound(throughAgentSeq) {
    // An acknowledgement can arrive while the next output chunk is still
    // being appended. Put compaction on the same journal queue so an ack never
    // rewrites the file over a newer unacknowledged event.
    const task = async () => {
      const remaining = (await readOutbound()).filter((record) => Number(record.agentSeq) > Number(throughAgentSeq));
      const temporaryPath = `${outboundPath}.${process.pid}.tmp`;
      try {
        await fsImpl.writeFile(temporaryPath, remaining.map((record) => JSON.stringify(record)).join("\n") + (remaining.length ? "\n" : ""), { mode: 0o600 });
        await renameRecoveryFile(fsImpl, temporaryPath, outboundPath, { platform });
      } finally {
        await fsImpl.rm(temporaryPath, { force: true }).catch(() => {});
      }
    };
    const promise = eventTail.then(task, task);
    eventTail = promise.catch(() => {});
    return promise;
  }

  function queueJobEvent(jobId, event) {
    const task = async () => {
      agentSeq += 1;
      const record = {
        type: "agent.job.event",
        jobId,
        agentSeq,
        event: {
          ...event,
          jobId,
          agentSeq,
          at: event.at || iso(),
        },
      };
      await fsImpl.appendFile(outboundPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      send(record);
      return record;
    };
    const promise = eventTail.then(task, task);
    eventTail = promise.catch(() => {});
    return promise;
  }

  async function sendInventory({ lightweight = false } = {}) {
    const value = await inventoryCollector.collect({
      identity,
      lightweight,
      onProgress(progress) {
        if (currentJob) void queueJobEvent(currentJob.id, {
          type: "step.progress",
          stepId: currentJob.steps?.find((step) => step.state === "running")?.id,
          progress,
        });
      },
    });
    agentSeq += 1;
    send({ type: "agent.inventory", agentSeq, inventory: value });
    return value;
  }

  async function detectWindowsAdministrator() {
    try {
      const result = await executor.execArgv({ file: "net", args: ["session"], timeoutMs: 10_000 });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async function discoverCapabilities() {
    if (platform === "win32") {
      const tools = {};
      await Promise.all(WINDOWS_CAPABILITY_TOOLS.map(async (tool) => {
        const resolved = await executor.resolveTool(tool);
        tools[tool] = { available: Boolean(resolved), path: resolved || "" };
      }));
      return {
        root: await detectWindowsAdministrator(),
        effectiveUid: null,
        rawShell: true,
        artifacts: true,
        reboot: true,
        poweroff: true,
        shell: await executor.resolveTool("powershell") || "powershell",
        architecture: os.arch(),
        kernel: os.release(),
        firmware: "unknown",
        filesystems: ["ntfs", "exfat", "vfat"],
        addresses: addresses(),
        tools,
        actions: registry.list(),
        actionMatrix: buildPlatformActionCapabilityMatrix({ platform, architecture: os.arch(), tools, actions: registry.list() }),
        interactive: interactiveRuntime?.capabilities() || null,
      };
    }
    const toolNames = [
      "bash", "lsblk", "findmnt", "blkid", "sfdisk", "fdisk", "parted", "sgdisk", "ddrescue",
      "smartctl", "nvme", "mdadm", "pvs", "vgs", "lvs", "cryptsetup", "dmsetup", "mount",
      "chroot", "systemd-nspawn", "e2fsck", "xfs_repair", "btrfs", "fsck.fat", "fsck.exfat",
      "ntfsfix", "grub-install", "efibootmgr", "dracut", "update-initramfs", "mkinitcpio", "kexec",
      "script", "systemctl", "journalctl", "ps", "ss", "ip", "ethtool", "fwupdmgr", "dmidecode",
      "apt-get", "dnf", "yum", "pacman", "zypper", "apk", "rpm", "dpkg", "snap", "flatpak",
    ];
    const tools = {};
    await Promise.all(toolNames.map(async (tool) => {
      const resolved = await executor.resolveTool(tool);
      tools[tool] = { available: Boolean(resolved), path: resolved || "" };
    }));
    const filesystems = (await readText(fsImpl, "/proc/filesystems"))
      .split("\n")
      .map((line) => line.trim().split(/\s+/).at(-1))
      .filter(Boolean);
    return {
      root: typeof process.geteuid === "function" ? process.geteuid() === 0 : false,
      effectiveUid: typeof process.geteuid === "function" ? process.geteuid() : null,
      rawShell: true,
      artifacts: true,
      reboot: true,
      poweroff: true,
      shell: await executor.resolveTool("bash") || "/bin/bash",
      architecture: os.arch(),
      kernel: os.release(),
      firmware: await fsImpl.stat("/sys/firmware/efi").then(() => "uefi").catch(() => "bios"),
      filesystems,
      addresses: addresses(),
      tools,
      actions: registry.list(),
      actionMatrix: buildPlatformActionCapabilityMatrix({ platform, architecture: os.arch(), tools, actions: registry.list() }),
      interactive: interactiveRuntime?.capabilities() || null,
    };
  }

  async function persistCurrentJob() {
    if (currentJob) await atomicJson(fsImpl, currentJobPath, currentJob, platform);
    else await fsImpl.rm(currentJobPath, { force: true });
  }

  async function persistCompletedJob(record) {
    completedJob = record;
    await atomicJson(fsImpl, completedJobPath, record, platform);
  }

  async function executeJob(job) {
    if (currentJob && currentJob.id !== job.id) return;
    currentJob = structuredClone(job);
    currentAbortController = new AbortController();
    currentJob.localState = "running";
    currentJob.acceptedAt = iso();
    await persistCurrentJob();
    const caseArtifactDir = path.join(resolvedStateDir, "cases", job.caseId, "jobs", job.id, "artifacts");
    await fsImpl.mkdir(caseArtifactDir, { recursive: true, mode: 0o700 });
    send({ type: "agent.job.accept", jobId: job.id, sessionId });
    const stepResults = [];
    let ok = true;
    for (let index = 0; index < currentJob.steps.length; index += 1) {
      const step = currentJob.steps[index];
      if (currentAbortController.signal.aborted) {
        ok = false;
        stepResults.push({ stepId: step.id, ok: false, canceled: true });
        break;
      }
      step.state = "running";
      step.startedAt = iso();
      await persistCurrentJob();
      await queueJobEvent(job.id, {
        type: "step.started",
        stepId: step.id,
        action: step.action,
        params: step.params,
        force: step.force === true || job.force === true,
      });
      try {
        const result = await registry.run(step.action, step.params || {}, {
          caseId: job.caseId,
          jobId: job.id,
          stepId: step.id,
          agentId: identity.agentId,
          caseArtifactDir,
          timeoutMs: step.timeoutMs,
          force: step.force === true || job.force === true,
          signal: currentAbortController.signal,
          onEvent(event) {
            void queueJobEvent(job.id, {
              ...event,
              stepId: event.stepId || step.id,
            });
          },
        });
        await eventTail;
        const stepOk = result.ok !== false;
        step.state = stepOk ? "succeeded" : "failed";
        step.endedAt = iso();
        step.result = result;
        stepResults.push({ stepId: step.id, ...result });
        await queueJobEvent(job.id, {
          type: stepOk ? "step.succeeded" : "step.failed",
          stepId: step.id,
          result,
        });
        if (!stepOk && !step.continueOnError) {
          ok = false;
          break;
        }
      } catch (error) {
        step.state = currentAbortController.signal.aborted ? "canceled" : "failed";
        step.endedAt = iso();
        const failure = {
          ok: false,
          code: error.code || "ERR_WW_RECOVERY_COMMAND_FAILED",
          message: error.message,
          details: error.details,
          canceled: currentAbortController.signal.aborted,
        };
        step.result = failure;
        stepResults.push({ stepId: step.id, ...failure });
        await queueJobEvent(job.id, { type: "step.failed", stepId: step.id, error: failure });
        if (!step.continueOnError) {
          ok = false;
          break;
        }
      }
      await persistCurrentJob();
    }
    await eventTail;
    const resultRecord = {
      jobId: job.id,
      agentSeq: ++agentSeq,
      result: {
        ok,
        canceled: currentAbortController.signal.aborted && !shutdownInterruptionReason,
        interrupted: Boolean(shutdownInterruptionReason),
        ...(shutdownInterruptionReason ? { message: shutdownInterruptionReason } : {}),
        steps: stepResults,
        endedAt: iso(),
      },
    };
    await persistCompletedJob(resultRecord);
    send({ type: "agent.job.result", ...resultRecord });
    currentJob = null;
    currentAbortController = null;
    await persistCurrentJob();
    return resultRecord.result;
  }

  async function replayState(resumableJob = null) {
    const outbound = await readOutbound();
    if (outbound.length > 0 || completedJob || currentJob || resumableJob) {
      send({
        type: "agent.resume",
        jobId: currentJob?.id || completedJob?.jobId || "",
        events: outbound.map((record) => record.event),
        result: completedJob,
        throughAgentSeq: agentSeq,
        active: currentJob ? { jobId: currentJob.id, state: currentJob.localState } : null,
        unavailableJobId: !currentJob && !completedJob ? resumableJob?.id || "" : "",
      });
    }
  }

  async function handleMessage(message) {
    if (String(message.type || "").startsWith("controller.session.") || String(message.type || "").startsWith("controller.tunnel.")) {
      await interactiveRuntime?.handle(message);
      return;
    }
    if (message.type === "controller.welcome") {
      welcomed = true;
      connected = true;
      sessionId = message.sessionId;
      reconnectAttempt = 0;
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        agentSeq += 1;
        send({ type: "agent.heartbeat", agentSeq, at: iso(), activeJobId: currentJob?.id || "" });
      }, Number(message.heartbeatMs) || heartbeatMs);
      heartbeatTimer.unref?.();
      await replayState(message.resumableJob);
      void sendInventory({ lightweight: mode !== "pxe" }).catch((error) => log(`Recovery inventory failed: ${error.message}`));
      initialResolve({ identity, sessionId, controllerUrl });
      return;
    }
    if (message.type === "controller.inventory.request") {
      await sendInventory({ lightweight: message.lightweight === true });
      return;
    }
    if (message.type === "controller.job.offer") {
      if (currentJob && currentJob.id !== message.job?.id) return;
      activeExecutionPromise = executeJob(message.job).catch((error) => log(`Recovery job failed: ${error.message}`));
      return;
    }
    if (message.type === "controller.job.cancel") {
      if (currentJob?.id === message.jobId) currentAbortController?.abort(new Error("controller canceled job"));
      return;
    }
    if (message.type === "controller.event.ack") {
      await compactOutbound(message.agentSeq);
      return;
    }
    if (message.type === "controller.result.ack") {
      if (completedJob?.jobId === message.jobId) {
        completedJob = null;
        await fsImpl.rm(completedJobPath, { force: true });
      }
      return;
    }
    if (message.type === "controller.resume.ack") {
      await compactOutbound(message.throughAgentSeq || 0);
      return;
    }
    if (message.type === "controller.shutdown") {
      try { socket.close(1000, "controller shutdown"); } catch {}
      return;
    }
    if (message.type === "controller.error") log(`Recovery controller: ${message.error?.code || "error"}: ${message.error?.message || "unknown"}`);
  }

  function scheduleReconnect() {
    if (stopping || reconnectTimer) return;
    const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] || 15_000;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopping) return;
    const target = websocketUrl(controllerUrl);
    welcomed = false;
    socket = new WebSocketImpl(target, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
    socket.on("open", async () => {
      try {
        const capabilities = await discoverCapabilities();
        send({
          type: "agent.hello",
          protocol: WW_RECOVERY_PROTOCOL_VERSION,
          agentId: identity.agentId,
          bootId: identity.bootId,
          hostname: name,
          mode,
          version: AGENT_VERSION,
          startedAt: iso(),
          controllerHint: controllerUrl,
          addresses: addresses(),
          capabilities,
          identity,
        });
      } catch (error) {
        initialReject(error);
        socket.close();
      }
    });
    socket.on("message", (data) => {
      let message;
      try { message = JSON.parse(data.toString("utf8")); } catch { return; }
      messageTail = messageTail.then(() => handleMessage(message), () => handleMessage(message)).catch((error) => log(`Recovery agent message failed: ${error.message}`));
    });
    socket.on("close", () => {
      connected = false;
      welcomed = false;
      sessionId = "";
      clearInterval(heartbeatTimer);
      scheduleReconnect();
    });
    socket.on("error", (error) => {
      log(`Recovery agent connection failed: ${error.message}`);
    });
  }

  async function initialize() {
    await fsImpl.mkdir(resolvedStateDir, { recursive: true, mode: 0o700 });
    await fsImpl.writeFile(outboundPath, "", { flag: "a", mode: 0o600 });
    identity = identity || await resolveRecoveryAgentIdentity({
      mode,
      explicitId: id,
      platform,
      fsImpl,
      installedIdPath: installedIdPath || platformDefaults.installedIdPath,
    });
    interactiveRuntime = createInteractiveAgentRuntime({
      send,
      executor,
      platform,
      fsImpl,
      log,
    });
    // Recover the durable sequence before allocating a restart/interruption
    // result. Otherwise the first post-restart event can collide with an
    // unacknowledged event already present in outbound-events.jsonl.
    await readOutbound();
    completedJob = await readJson(fsImpl, completedJobPath);
    if (!completedJob?.jobId) completedJob = null;
    else agentSeq = Math.max(agentSeq, Number(completedJob.agentSeq) || 0);
    const abandoned = await readJson(fsImpl, currentJobPath);
    if (abandoned?.id) {
      completedJob = {
        jobId: abandoned.id,
        agentSeq: ++agentSeq,
        result: {
          ok: false,
          interrupted: true,
          canceled: false,
          code: "ERR_WW_RECOVERY_INTERRUPTED",
          message: "Recovery agent restarted while this job was running.",
          endedAt: iso(),
        },
      };
      await persistCompletedJob(completedJob);
      await fsImpl.rm(currentJobPath, { force: true });
    }
  }

  async function start() {
    await initialize();
    connect();
    return initialConnection;
  }

  async function run() {
    await start();
    return new Promise(() => {});
  }

  async function stop(reason = "agent-stopped") {
    if (stopping) return;
    stopping = true;
    shutdownInterruptionReason = currentJob ? String(reason || "agent-stopped") : "";
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    currentAbortController?.abort(new Error(reason));
    await activeExecutionPromise?.catch(() => {});
    await eventTail.catch(() => {});
    await interactiveRuntime?.stop().catch(() => {});
    if (socket?.readyState === 1) {
      if (currentJob) {
        await queueJobEvent(currentJob.id, { type: "job.interrupted", reason });
      }
      socket.close(1000, reason);
      await Promise.race([onceClose(socket), new Promise((resolve) => setTimeout(resolve, 500))]);
    }
  }

  function getState() {
    return {
      identity: identity ? structuredClone(identity) : null,
      controllerUrl,
      mode,
      name,
      connected,
      welcomed,
      sessionId,
      currentJobId: currentJob?.id || "",
      stateDir: resolvedStateDir,
      agentSeq,
    };
  }

  return { start, run, stop, getState, sendInventory, registry };
}

function onceClose(socket) {
  return new Promise((resolve) => socket.once("close", resolve));
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try { return fsSync.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isDirectExecution()) {
  const flags = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    flags[key] = process.argv[index + 1] && !process.argv[index + 1].startsWith("--") ? process.argv[++index] : true;
  }
  const options = await resolveRecoveryAgentOptions({
    cli: {
      controller: flags.controller,
      token: flags.token,
      id: flags.id,
      name: flags.name,
      mode: flags.mode,
      stateDir: flags["state-dir"],
    },
  });
  if (!options.controllerUrl) {
    process.stderr.write("Recovery agent controller URL is required.\n");
    process.exit(2);
  }
  const agent = createRecoveryAgent(options);
  const fileServiceWatchdog = createWindowsFileServiceWatchdog({
    platform: process.platform,
    log: (message) => process.stderr.write(`[WW] ${message}\n`),
  });
  fileServiceWatchdog.start();
  const shutdown = async () => {
    fileServiceWatchdog.stop();
    await agent.stop("signal");
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await agent.run();
  } finally {
    fileServiceWatchdog.stop();
  }
}

export { AGENT_VERSION, parseKernelCommandLine, websocketUrl };
