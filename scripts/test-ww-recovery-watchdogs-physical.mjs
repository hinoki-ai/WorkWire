#!/usr/bin/env node
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "canceled", "interrupted", "abandoned"]);

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

function assert(condition, message, code = "ERR_WW_WATCHDOG_PHYSICAL_ASSERTION") {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function eventText(event = {}) {
  return event.encoding === "base64"
    ? Buffer.from(String(event.data || ""), "base64").toString("utf8")
    : String(event.data || "");
}

function parseLastJson(output, label) {
  const lines = String(output || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }
  const error = new Error(`${label} did not return a JSON result.`);
  error.code = "ERR_WW_WATCHDOG_PHYSICAL_RESULT";
  throw error;
}

function asArray(value) {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function waitFor(check, {
  description = "physical watchdog condition",
  timeoutMs = 120_000,
  intervalMs = 250,
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
  error.code = "ERR_WW_WATCHDOG_PHYSICAL_TIMEOUT";
  throw error;
}

async function runCommand(client, {
  caseId,
  agentId,
  stepId,
  argv,
  timeoutMs = 60_000,
} = {}) {
  const job = await client.createJob({
    caseId,
    targetAgentId: agentId,
    force: true,
    steps: [{
      id: stepId,
      action: "command.exec",
      timeoutMs,
      params: { argv },
    }],
  });
  const completed = await waitFor(async () => {
    const value = await client.getJob(job.id);
    return TERMINAL_JOB_STATES.has(value.job.state) ? value : null;
  }, { description: `recovery job ${job.id}`, timeoutMs: timeoutMs + 30_000 });
  const stdout = completed.events
    .filter((event) => event.type === "step.output" && event.stream === "stdout")
    .map(eventText)
    .join("");
  const stderr = completed.events
    .filter((event) => event.type === "step.output" && event.stream === "stderr")
    .map(eventText)
    .join("");
  assert(completed.job.state === "succeeded", `Recovery job ${job.id} ended ${completed.job.state}: ${stderr || stdout || "no output"}`);
  return { jobId: job.id, stdout, stderr };
}

async function discoverFileService({ host, expectedMachineId, timeoutMs = 1_500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`http://${host}:4851/v1/discover`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload?.service?.machineId !== expectedMachineId) return null;
    return payload.service;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function observeFileServiceRestart({ host, expectedMachineId, expectedVersion } = {}) {
  const startedAt = Date.now();
  let downAt = 0;
  let failedSamples = 0;
  let healthySamples = 0;
  while (Date.now() - startedAt < 90_000) {
    const service = await discoverFileService({ host, expectedMachineId });
    if (!service) {
      failedSamples += 1;
      if (!downAt) downAt = Date.now();
    } else {
      healthySamples += 1;
      if (downAt) {
        assert(service.versions?.app === expectedVersion, `Recovered Sakura file service is stale: ${service.versions?.app || "unknown"}.`);
        return {
          interruptionObserved: true,
          downAt: new Date(downAt).toISOString(),
          recoveredAt: new Date().toISOString(),
          downtimeMs: Date.now() - downAt,
          failedSamples,
          healthySamples,
          machineId: service.machineId,
          appVersion: service.versions.app,
        };
      }
    }
    await delay(200);
  }
  const error = new Error(downAt
    ? "Sakura file service was interrupted but did not recover within 90 seconds."
    : "Sakura file-service interruption was never observed.");
  error.code = "ERR_WW_WATCHDOG_FILE_SERVICE";
  throw error;
}

const flags = parseArgs();
if (flags.managed || (process.platform !== "win32" && !process.env.WW_CONFIG_DIR)) {
  process.env.WW_PORTAL_PATH = process.env.WW_PORTAL_PATH || repoRoot;
  process.env.WW_HOME_DIR = process.env.WW_HOME_DIR || path.join(repoRoot, ".workwire");
  process.env.WW_CONFIG_DIR = process.env.WW_CONFIG_DIR || path.join(repoRoot, ".workwire", "config");
}

const [{ loadWwConfig }, { buildWwReleaseInfo }, { loadRecoveryConfig }, { createRecoveryClient }] = await Promise.all([
  import("../lib/ww-config-store.mjs"),
  import("../lib/ww-release.mjs"),
  import("../lib/recovery/ww-recovery-config.mjs"),
  import("../lib/recovery/ww-recovery-client.mjs"),
]);

const [fileConfig, sourceRelease, recoveryConfig] = await Promise.all([
  loadWwConfig(),
  buildWwReleaseInfo({ baseDir: repoRoot }),
  loadRecoveryConfig(),
]);
const client = createRecoveryClient({
  url: flags.controller || `http://127.0.0.1:${recoveryConfig.port}`,
  token: recoveryConfig.token,
  timeoutMs: 15_000,
  transferTimeoutMs: 0,
});
const systemAgentId = flags["system-agent"] || "wwra_xCR5XgqeHAd2RkAzsp81bWPo";
const systemFileMachineId = flags["system-file-machine"] || "RQn5hi_GTBHwvC6bQmmTYg";
const systemPortalRoot = flags["system-portal"] || "C:\\Users\\Sakura\\WorkWire";
const systemHost = flags["system-host"] || fileConfig.peer.host;
const runTag = crypto.randomBytes(5).toString("hex");
const killerTaskName = `WorkWire Recovery Physical ${runTag}`;
const proofPath = `C:\\ProgramData\\WorkWire\\watchdog-physical-${runTag}.json`;
const checks = {};
const evidence = {};
let caseId = null;
let failure = null;
let stage = "preflight";
const startedAt = Date.now();

try {
  assert(systemHost, "Sakura live address is unavailable from pinned configuration.");
  const initialService = await discoverFileService({ host: systemHost, expectedMachineId: systemFileMachineId });
  assert(initialService?.versions?.app === sourceRelease.version, "Sakura file service is not running the exact current source before fault injection.");
  const initialAgent = (await client.listAgents({ online: true })).find((agent) => agent.agentId === systemAgentId);
  assert(initialAgent?.state === "online", "Pinned Sakura recovery agent is not online before fault injection.");
  assert(initialAgent.capabilities?.root === true && initialAgent.capabilities?.rawShell === true, "Pinned Sakura agent is not unrestricted.");
  const caseRecord = await client.createCase({
    targetAgentId: systemAgentId,
    goal: "Physically prove reciprocal Windows watchdog recovery",
    mode: "operator-driven",
    createdBy: "fleet-watchdog-physical-acceptance",
  });
  caseId = caseRecord.id;
  checks.preflight = true;
  evidence.preflight = {
    systemHost,
    serviceMachineId: initialService.machineId,
    appVersion: initialService.versions.app,
    agentId: initialAgent.agentId,
    agentConnectedAt: initialAgent.connectedAt,
    agentIdentity: "NT AUTHORITY\\SYSTEM",
  };

  stage = "file-service-fault";
  const portalLiteral = quotePowerShellLiteral(systemPortalRoot);
  const stopFileServiceScript = String.raw`
$ErrorActionPreference = 'Stop'
$portal = ${portalLiteral}
$entry = Join-Path $portal 'ww.mjs'
$targets = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like ('*' + $entry + '* serve*') })
$beforePids = @($targets | ForEach-Object { [int]$_.ProcessId })
Stop-ScheduledTask -TaskName 'WorkWire Serve' -ErrorAction SilentlyContinue
foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
$remaining = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $beforePids -contains [int]$_.ProcessId })
[ordered]@{
  ok = $true
  identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  stoppedPids = $beforePids
  originalPidsRemaining = @($remaining).Count
  faultAt = [DateTimeOffset]::UtcNow.ToString('o')
} | ConvertTo-Json -Compress
`;
  const fileObserver = observeFileServiceRestart({
    host: systemHost,
    expectedMachineId: systemFileMachineId,
    expectedVersion: sourceRelease.version,
  });
  const fileFaultJob = await runCommand(client, {
    caseId,
    agentId: systemAgentId,
    stepId: `stop_file_${runTag}`,
    argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", stopFileServiceScript],
    timeoutMs: 30_000,
  });
  const fileFault = parseLastJson(fileFaultJob.stdout, "Sakura file-service fault injection");
  assert(String(fileFault.identity || "").toLowerCase() === "nt authority\\system", "File-service fault injection did not run as SYSTEM.");
  assert(asArray(fileFault.stoppedPids).length >= 1, "No exact Sakura file-service process was found to stop.");
  assert(Number(fileFault.originalPidsRemaining) === 0, "The original Sakura file-service process survived fault injection.");
  const fileRecovery = await fileObserver;
  checks.fileServiceRecovery = true;
  evidence.fileService = {
    faultJobId: fileFaultJob.jobId,
    faultAt: fileFault.faultAt,
    stoppedProcessCount: asArray(fileFault.stoppedPids).length,
    originalPidsRemaining: Number(fileFault.originalPidsRemaining),
    recovery: fileRecovery,
  };

  stage = "recovery-agent-fault";
  const beforeAgent = (await client.listAgents()).find((agent) => agent.agentId === systemAgentId);
  assert(beforeAgent?.state === "online" && beforeAgent.connectedAt, "Sakura agent connection epoch is unavailable before its fault injection.");
  const killerScript = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Start-Sleep -Seconds 5
$targets = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*ww-recovery-agent.mjs*' })
$proof = [ordered]@{
  ok = $true
  identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  faultAt = [DateTimeOffset]::UtcNow.ToString('o')
  stoppedPids = @($targets | ForEach-Object { [int]$_.ProcessId })
}
[System.IO.File]::WriteAllText(${quotePowerShellLiteral(proofPath)}, ($proof | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
Stop-ScheduledTask -TaskName 'WorkWire Recovery Agent' -ErrorAction SilentlyContinue
foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  const encodedKiller = Buffer.from(killerScript, "utf16le").toString("base64");
  const registerKillerScript = String.raw`
$ErrorActionPreference = 'Stop'
$taskName = ${quotePowerShellLiteral(killerTaskName)}
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quotePowerShellLiteral(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedKiller}`)}
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName
[ordered]@{
  ok = $true
  identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  taskName = $taskName
  armedAt = [DateTimeOffset]::UtcNow.ToString('o')
} | ConvertTo-Json -Compress
`;
  const killerJob = await runCommand(client, {
    caseId,
    agentId: systemAgentId,
    stepId: `arm_agent_fault_${runTag}`,
    argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", registerKillerScript],
    timeoutMs: 30_000,
  });
  const armed = parseLastJson(killerJob.stdout, "Sakura recovery-agent fault arming");
  assert(armed.ok === true && armed.taskName === killerTaskName, "Independent SYSTEM fault task was not armed.");
  assert(String(armed.identity || "").toLowerCase() === "nt authority\\system", "Recovery-agent fault task was not armed as SYSTEM.");

  const stateSamples = [];
  const reconnected = await waitFor(async () => {
    const current = (await client.listAgents()).find((agent) => agent.agentId === systemAgentId);
    if (current && stateSamples.at(-1) !== current.state) stateSamples.push(current.state);
    return current?.state === "online" && current.connectedAt && current.connectedAt !== beforeAgent.connectedAt
      ? current
      : null;
  }, { description: "same Sakura SYSTEM agent reconnect", timeoutMs: 150_000, intervalMs: 500 });

  const cleanupScript = String.raw`
$ErrorActionPreference = 'Stop'
$proofPath = ${quotePowerShellLiteral(proofPath)}
$proof = Get-Content -LiteralPath $proofPath -Raw | ConvertFrom-Json
$agent = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*ww-recovery-agent.mjs*' })
$task = Get-ScheduledTask -TaskName 'WorkWire Recovery Agent' -ErrorAction Stop
$result = [ordered]@{
  ok = $true
  identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  proofIdentity = [string]$proof.identity
  faultAt = [string]$proof.faultAt
  stoppedPids = @($proof.stoppedPids)
  recoveryTaskState = [string]$task.State
  recoveryProcessCount = @($agent).Count
}
Unregister-ScheduledTask -TaskName ${quotePowerShellLiteral(killerTaskName)} -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $proofPath -Force -ErrorAction SilentlyContinue
$result | ConvertTo-Json -Compress
`;
  const cleanupJob = await runCommand(client, {
    caseId,
    agentId: systemAgentId,
    stepId: `verify_agent_recovery_${runTag}`,
    argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cleanupScript],
    timeoutMs: 30_000,
  });
  const recoveredProof = parseLastJson(cleanupJob.stdout, "Sakura recovery-agent recovery verification");
  assert(String(recoveredProof.identity || "").toLowerCase() === "nt authority\\system", "Recovered Sakura agent is not SYSTEM.");
  assert(String(recoveredProof.proofIdentity || "").toLowerCase() === "nt authority\\system", "Independent fault task did not run as SYSTEM.");
  assert(asArray(recoveredProof.stoppedPids).length >= 1, "Independent fault task did not find the Sakura recovery-agent process.");
  assert(Number(recoveredProof.recoveryProcessCount) >= 1, "Sakura recovery-agent process is absent after recovery.");
  checks.recoveryAgentRecovery = true;
  evidence.recoveryAgent = {
    armJobId: killerJob.jobId,
    verifyJobId: cleanupJob.jobId,
    taskName: "WorkWire Recovery Agent",
    faultIdentity: recoveredProof.proofIdentity,
    faultAt: recoveredProof.faultAt,
    stoppedProcessCount: asArray(recoveredProof.stoppedPids).length,
    stableAgentId: reconnected.agentId,
    connectionEpochBefore: beforeAgent.connectedAt,
    connectionEpochAfter: reconnected.connectedAt,
    connectionEpochChanged: true,
    bootIdUnchanged: beforeAgent.bootId === reconnected.bootId,
    stateSamples,
    recoveryTaskState: recoveredProof.recoveryTaskState,
    recoveryProcessCount: Number(recoveredProof.recoveryProcessCount),
    identity: recoveredProof.identity,
  };
  assert(evidence.recoveryAgent.bootIdUnchanged === true, "Agent-only restart incorrectly changed the Windows machine boot identity.");

  stage = "postflight";
  const finalService = await discoverFileService({ host: systemHost, expectedMachineId: systemFileMachineId });
  const finalAgent = (await client.listAgents({ online: true })).find((agent) => agent.agentId === systemAgentId);
  assert(finalService?.versions?.app === sourceRelease.version, "Sakura file service is not exact/current after fault injection.");
  assert(finalAgent?.state === "online" && finalAgent.capabilities?.root === true, "Sakura SYSTEM agent is not healthy after fault injection.");
  checks.postflight = true;
  evidence.postflight = {
    serviceMachineId: finalService.machineId,
    appVersion: finalService.versions.app,
    agentId: finalAgent.agentId,
    agentState: finalAgent.state,
    unrestricted: finalAgent.capabilities.root === true && finalAgent.capabilities.rawShell === true,
  };
} catch (error) {
  failure = error;
} finally {
  if (caseId && failure) {
    const agent = await client.getAgent(systemAgentId).catch(() => null);
    if (agent?.state === "online") {
      const cleanup = String.raw`
Unregister-ScheduledTask -TaskName ${quotePowerShellLiteral(killerTaskName)} -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -LiteralPath ${quotePowerShellLiteral(proofPath)} -Force -ErrorAction SilentlyContinue
`;
      await runCommand(client, {
        caseId,
        agentId: systemAgentId,
        stepId: `cleanup_${runTag}`,
        argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cleanup],
        timeoutMs: 20_000,
      }).catch(() => {});
    }
  }
}

const report = {
  ok: !failure && Object.values(checks).every(Boolean),
  checkedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  systemAgentId,
  systemFileMachineId,
  checks,
  evidence,
  error: failure ? {
    stage,
    code: String(failure?.code || "ERR_WW_WATCHDOG_PHYSICAL"),
    message: String(failure?.message || failure),
    causeCode: String(failure?.cause?.code || ""),
  } : null,
};

process.stdout.write(`${JSON.stringify(report, null, flags.json ? 0 : 2)}\n`);
if (!report.ok) process.exitCode = 1;
