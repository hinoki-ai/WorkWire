#!/usr/bin/env node
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TERMINAL_FLEET_STATES = new Set(["succeeded", "partial", "failed"]);
const TERMINAL_CASE_STATES = new Set(["completed", "failed", "stopped"]);

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (["managed", "json"].includes(key)) {
      flags[key] = true;
      continue;
    }
    if (argv[index + 1] === undefined) throw new TypeError(`--${key} requires a value.`);
    flags[key] = String(argv[index + 1]);
    index += 1;
  }
  return flags;
}

function assert(condition, message, code = "ERR_WW_RECOVERY_PHYSICAL_ASSERTION") {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check, {
  description = "physical recovery condition",
  timeoutMs = 60_000,
  intervalMs = 200,
} = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const error = new Error(`${description} did not complete within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : "."}`);
  error.code = "ERR_WW_RECOVERY_PHYSICAL_TIMEOUT";
  throw error;
}

function eventText(event = {}) {
  return event.encoding === "base64"
    ? Buffer.from(String(event.data || ""), "base64").toString("utf8")
    : String(event.data || "");
}

async function waitForSessionText(client, sessionId, expected, description) {
  return waitFor(async () => {
    const events = await client.listSessionEvents(sessionId);
    const output = events.filter((event) => event.type === "session.output").map(eventText).join("");
    return output.toLowerCase().includes(String(expected).toLowerCase()) ? { events, output } : null;
  }, { description, timeoutMs: 45_000 });
}

async function waitForSessionExit(client, sessionId) {
  return waitFor(async () => {
    const session = await client.getSession(sessionId);
    return ["exited", "failed"].includes(session.state) ? session : null;
  }, { description: `session ${sessionId} exit`, timeoutMs: 30_000 });
}

async function requestThroughTunnel(port) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Physical TCP tunnel response timed out."));
    }, 15_000);
    socket.once("connect", () => {
      socket.write("GET /v1/discover HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function parseHttpJson(response) {
  const separator = response.indexOf("\r\n\r\n");
  assert(separator >= 0, "Tunneled HTTP response did not contain a header boundary.");
  try {
    return JSON.parse(response.slice(separator + 4));
  } catch (error) {
    const failure = new Error(`Tunneled HTTP response was not valid JSON: ${error.message}`);
    failure.code = "ERR_WW_RECOVERY_PHYSICAL_TUNNEL_JSON";
    throw failure;
  }
}

async function runAutonomousProof(client, {
  agentId,
  label,
  argv,
  expectedOutput,
  onCaseCreated = () => {},
} = {}) {
  const caseRecord = await client.createCase({
    targetAgentId: agentId,
    goal: `Physically prove ${label} unrestricted identity`,
    mode: "autonomous-unrestricted",
    createdBy: "fleet-physical-acceptance",
  });
  onCaseCreated(caseRecord.id);
  await client.runCase(caseRecord.id);
  await waitFor(async () => (
    (await client.listEvents(caseRecord.id)).some((event) => event.type === "planner.started")
  ), { description: `${label} autonomous planner start` });
  await client.submitCaseAction(caseRecord.id, {
    type: "planner.hypothesis",
    hypothesisId: `physical_${label}_identity`,
    summary: `${label} agent should expose its unrestricted installed identity.`,
    state: "current",
  });
  const requestId = `physical_${label}_whoami`;
  await client.submitCaseAction(caseRecord.id, {
    type: "planner.action",
    requestId,
    action: "command.exec",
    params: { argv },
    expectedObservation: `${label} exact identity output contains ${expectedOutput}`,
    postconditions: [{ type: "stdout", operator: "contains", value: expectedOutput }],
  });
  await waitFor(async () => (
    (await client.listEvents(caseRecord.id)).some((event) => (
      event.type === "planner.observation"
      && event.requestId === requestId
      && event.state === "succeeded"
    ))
  ), { description: `${label} autonomous action proof`, timeoutMs: 90_000 });
  await client.submitCaseAction(caseRecord.id, {
    type: "planner.complete",
    requestId: `physical_${label}_complete`,
    outcome: `${label} unrestricted identity physically proved.`,
    verification: [`stdout contains ${expectedOutput}`],
  });
  const completed = await waitFor(async () => {
    const value = await client.getCase(caseRecord.id);
    return TERMINAL_CASE_STATES.has(value.case.state) ? value : null;
  }, { description: `${label} autonomous completion`, timeoutMs: 60_000 });
  assert(completed.case.state === "completed", `${label} autonomy ended in ${completed.case.state}.`);
  const events = await client.listEvents(caseRecord.id);
  assert(events.some((event) => event.type === "planner.procedure.exported"), `${label} autonomy did not export a sourced procedure.`);
  return {
    caseId: caseRecord.id,
    state: completed.case.state,
    actionProved: true,
    procedureExported: true,
  };
}

const flags = parseArgs();
if (flags.managed || (process.platform !== "win32" && !process.env.WW_CONFIG_DIR)) {
  process.env.WW_PORTAL_PATH = process.env.WW_PORTAL_PATH || repoRoot;
  process.env.WW_HOME_DIR = process.env.WW_HOME_DIR || path.join(repoRoot, ".workwire");
  process.env.WW_CONFIG_DIR = process.env.WW_CONFIG_DIR || path.join(repoRoot, ".workwire", "config");
}

const [{ loadRecoveryConfig }, { createRecoveryClient }] = await Promise.all([
  import("../lib/recovery/ww-recovery-config.mjs"),
  import("../lib/recovery/ww-recovery-client.mjs"),
]);

const config = await loadRecoveryConfig();
const client = createRecoveryClient({
  url: flags.controller || `http://127.0.0.1:${config.port}`,
  token: config.token,
  timeoutMs: 15_000,
  transferTimeoutMs: 0,
});
const rootAgentId = flags["root-agent"] || "wwra_AQwelJu3cxhVk0h1GXvmbaCf";
const systemAgentId = flags["system-agent"] || "wwra_xCR5XgqeHAd2RkAzsp81bWPo";
const systemFileMachineId = flags["system-file-machine"] || "RQn5hi_GTBHwvC6bQmmTYg";
const runTag = crypto.randomBytes(6).toString("hex");
const sessionFixture = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255]);
const sessions = [];
const cases = [];
let tunnel = null;
let failure = null;
let stage = "connect";
const checks = {};
const evidence = {};
const startedAt = Date.now();

try {
  const controller = await client.connect();
  assert(controller.capabilities?.fleet === true, "Controller fleet capability is unavailable.");
  assert(controller.capabilities?.interactive === true, "Controller interactive capability is unavailable.");
  assert(controller.capabilities?.tcpTunnel === true, "Controller tunnel capability is unavailable.");
  const agents = await client.listAgents({ online: true });
  const rootAgent = agents.find((agent) => agent.agentId === rootAgentId);
  const systemAgent = agents.find((agent) => agent.agentId === systemAgentId);
  assert(rootAgent?.state === "online", "Pinned HINOKI root agent is not online.");
  assert(systemAgent?.state === "online", "Pinned Sakura SYSTEM agent is not online.");
  assert(rootAgent.capabilities?.root === true && rootAgent.capabilities?.rawShell === true, "HINOKI agent lacks root/raw-shell capability.");
  assert(systemAgent.capabilities?.root === true && systemAgent.capabilities?.rawShell === true, "Sakura agent lacks SYSTEM/raw-shell capability.");
  checks.controllerAndPinnedAgents = true;
  evidence.controller = {
    fleet: true,
    interactive: true,
    tcpTunnel: true,
  };

  stage = "linux-interactive";
  const linuxSession = await client.openSession({
    agentId: rootAgentId,
    cwd: "/var/tmp",
    argv: ["/bin/bash", "--noprofile", "--norc", "-i"],
    env: { WW_PHYSICAL_MARKER: "hinoki-root" },
    rows: 24,
    cols: 80,
  });
  sessions.push(linuxSession.id);
  assert(["linux-pty-script", "pipes"].includes(linuxSession.terminalMode), `Unexpected Linux terminal mode ${linuxSession.terminalMode}.`);
  await client.sessionInput(linuxSession.id, "printf 'LINUX_PHYSICAL:%s:%s:%s\\n' \"$WW_PHYSICAL_MARKER\" \"$(id -u)\" \"$PWD\"\n");
  const linuxOutput = await waitForSessionText(client, linuxSession.id, "LINUX_PHYSICAL:hinoki-root:0:/var/tmp", "Linux root PTY output");
  assert(linuxOutput.output.includes("/var/tmp"), "Linux interactive cwd was not preserved.");
  const linuxFilename = `ww-physical-${runTag}.bin`;
  await client.putSessionFile(linuxSession.id, linuxFilename, sessionFixture);
  const linuxFile = await client.getSessionFile(linuxSession.id, linuxFilename);
  assert(linuxFile.buffer.equals(sessionFixture), "Linux session file round trip changed bytes.");
  await client.sessionResize(linuxSession.id, 43, 137);
  const signal = await client.sessionSignal(linuxSession.id, "SIGWINCH");
  assert(signal.result?.delivered === true, "Linux session signal was not delivered.");
  await client.detachSession(linuxSession.id);
  assert((await client.getSession(linuxSession.id)).state === "detached", "Linux session did not detach.");
  await client.reconnectSession(linuxSession.id, { afterSeq: 0 });
  assert((await client.getSession(linuxSession.id)).state === "attached", "Linux session did not reconnect.");
  await client.sessionInput(linuxSession.id, `rm -f -- '${linuxFilename}'; printf 'LINUX_RECONNECTED\\n'\n`);
  await waitForSessionText(client, linuxSession.id, "LINUX_RECONNECTED", "Linux reconnect output");
  await client.terminateSession(linuxSession.id);
  await waitForSessionExit(client, linuxSession.id);
  sessions.splice(sessions.indexOf(linuxSession.id), 1);
  checks.linuxInteractive = true;
  evidence.linuxInteractive = {
    terminalMode: linuxSession.terminalMode,
    rootUid: 0,
    cwd: "/var/tmp",
    environment: true,
    resize: true,
    signal: "SIGWINCH",
    detachReconnect: true,
    sessionFileBytes: sessionFixture.length,
  };

  stage = "windows-interactive";
  const windowsSession = await client.openSession({
    agentId: systemAgentId,
    cwd: "C:\\ProgramData\\WorkWire\\staging",
    argv: ["powershell", "-NoLogo", "-NoProfile", "-NoExit"],
    env: { WW_PHYSICAL_MARKER: "sakura-system" },
    rows: 24,
    cols: 80,
  });
  sessions.push(windowsSession.id);
  assert(["winpty-conpty", "powershell-pipes"].includes(windowsSession.terminalMode), `Unexpected Windows terminal mode ${windowsSession.terminalMode}.`);
  await client.sessionInput(windowsSession.id, "Write-Output (\"WINDOWS_PHYSICAL:{0}:{1}:{2}\" -f $env:WW_PHYSICAL_MARKER, (whoami), (Get-Location).Path)\r\n");
  const windowsOutput = await waitForSessionText(client, windowsSession.id, "windows_physical:sakura-system:nt authority\\system:c:\\programdata\\workwire\\staging", "Windows SYSTEM session output");
  assert(windowsOutput.output.toLowerCase().includes("c:\\programdata\\workwire\\staging"), "Windows interactive cwd was not preserved.");
  const windowsFilename = `ww-physical-${runTag}.bin`;
  await client.putSessionFile(windowsSession.id, windowsFilename, sessionFixture);
  const windowsFile = await client.getSessionFile(windowsSession.id, windowsFilename);
  assert(windowsFile.buffer.equals(sessionFixture), "Windows session file round trip changed bytes.");
  await client.detachSession(windowsSession.id);
  assert((await client.getSession(windowsSession.id)).state === "detached", "Windows session did not detach.");
  await client.reconnectSession(windowsSession.id, { afterSeq: 0 });
  assert((await client.getSession(windowsSession.id)).state === "attached", "Windows session did not reconnect.");
  await client.sessionInput(windowsSession.id, `Remove-Item -LiteralPath '.\\${windowsFilename}' -Force -ErrorAction SilentlyContinue; Write-Output 'WINDOWS_RECONNECTED'\r\n`);
  await waitForSessionText(client, windowsSession.id, "WINDOWS_RECONNECTED", "Windows reconnect output");
  await client.terminateSession(windowsSession.id);
  await waitForSessionExit(client, windowsSession.id);
  sessions.splice(sessions.indexOf(windowsSession.id), 1);
  checks.windowsInteractive = true;
  evidence.windowsInteractive = {
    terminalMode: windowsSession.terminalMode,
    identity: "NT AUTHORITY\\SYSTEM",
    cwd: "C:\\ProgramData\\WorkWire\\staging",
    environment: true,
    resize: windowsSession.terminalMode === "winpty-conpty",
    signals: false,
    detachReconnect: true,
    sessionFileBytes: sessionFixture.length,
  };

  stage = "sakura-tunnel";
  tunnel = await client.openTunnel({
    agentId: systemAgentId,
    targetHost: "127.0.0.1",
    targetPort: 4851,
    listenHost: "127.0.0.1",
    listenPort: 0,
  });
  const tunnelResponse = await requestThroughTunnel(tunnel.listenPort);
  assert(/^HTTP\/1\.1 200/u.test(tunnelResponse), "Sakura-local file service tunnel did not return HTTP 200.");
  const tunnelDiscovery = parseHttpJson(tunnelResponse);
  assert(tunnelDiscovery.ok === true, "Sakura-local discovery did not report success.");
  assert(tunnelDiscovery.service?.machineId === systemFileMachineId, "Tunnel reached a service other than the pinned Sakura WorkWire instance.");
  await client.closeTunnel(tunnel.id);
  tunnel = null;
  checks.sakuraLocalTunnel = true;
  evidence.tunnel = {
    target: "127.0.0.1:4851",
    httpStatus: 200,
    serviceName: tunnelDiscovery.service?.name || "",
    machineId: tunnelDiscovery.service.machineId,
    appVersion: tunnelDiscovery.service?.versions?.app || "",
  };

  stage = "fleet-whoami";
  const fleet = await client.executeFleet({
    name: "Physical unrestricted identity proof",
    targetIds: [rootAgentId, systemAgentId],
    operation: { type: "command", argv: ["whoami"], goal: "Print exact installed identity" },
    rollout: { mode: "all-at-once" },
  });
  const fleetDone = await waitFor(async () => {
    const run = await client.getFleetRun(fleet.id);
    return TERMINAL_FLEET_STATES.has(run.state) ? run : null;
  }, { description: "two-agent fleet whoami", timeoutMs: 90_000 });
  assert(fleetDone.state === "succeeded", `Fleet whoami ended in ${fleetDone.state}.`);
  const summary = await client.getFleetSummary(fleet.id);
  assert(summary.counts.succeeded === 2, "Fleet whoami did not succeed on both agents.");
  const rootOutput = summary.targets.find((target) => target.agentId === rootAgentId)?.stdout.map(eventText).join("").trim().toLowerCase();
  const systemOutput = summary.targets.find((target) => target.agentId === systemAgentId)?.stdout.map(eventText).join("").trim().toLowerCase();
  assert(rootOutput === "root", `HINOKI fleet identity was ${rootOutput || "empty"}.`);
  assert(systemOutput === "nt authority\\system", `Sakura fleet identity was ${systemOutput || "empty"}.`);
  checks.fleetUnrestrictedIdentity = true;
  evidence.fleet = { runId: fleet.id, state: fleetDone.state, hinoki: "root", sakura: "NT AUTHORITY\\SYSTEM" };

  stage = "autonomy-root";
  const rootAutonomy = await runAutonomousProof(client, {
    agentId: rootAgentId,
    label: "hinoki",
    argv: ["/usr/bin/whoami"],
    expectedOutput: "root",
    onCaseCreated: (caseId) => cases.push(caseId),
  });
  stage = "autonomy-system";
  const systemAutonomy = await runAutonomousProof(client, {
    agentId: systemAgentId,
    label: "sakura",
    argv: ["C:\\Windows\\System32\\whoami.exe"],
    expectedOutput: "nt authority\\system",
    onCaseCreated: (caseId) => cases.push(caseId),
  });
  checks.autonomousProofs = true;
  evidence.autonomy = { hinoki: rootAutonomy, sakura: systemAutonomy };
} catch (error) {
  failure = error;
} finally {
  if (tunnel?.id) await client.closeTunnel(tunnel.id).catch(() => {});
  for (const sessionId of sessions) await client.terminateSession(sessionId).catch(() => {});
  for (const caseId of cases) {
    const current = await client.getCase(caseId).catch(() => null);
    if (current?.case?.state === "running") await client.stopCase(caseId).catch(() => {});
  }
}

const report = {
  ok: !failure && Object.values(checks).every(Boolean),
  checkedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  rootAgentId,
  systemAgentId,
  checks,
  evidence,
  error: failure ? {
    stage,
    code: String(failure?.code || "ERR_WW_RECOVERY_PHYSICAL"),
    message: String(failure?.message || failure),
    causeCode: String(failure?.cause?.code || ""),
  } : null,
};

process.stdout.write(`${JSON.stringify(report, null, flags.json ? 0 : 2)}\n`);
if (!report.ok) process.exitCode = 1;
