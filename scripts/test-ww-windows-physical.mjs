#!/usr/bin/env node
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
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

function assert(condition, message, code = "ERR_WW_WINDOWS_PHYSICAL_ASSERTION") {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function eventText(event = {}) {
  return event.encoding === "base64"
    ? Buffer.from(String(event.data || ""), "base64").toString("utf8")
    : String(event.data || "");
}

async function waitFor(check, {
  description = "native Windows condition",
  timeoutMs = 900_000,
  intervalMs = 500,
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
  error.code = "ERR_WW_WINDOWS_PHYSICAL_TIMEOUT";
  throw error;
}

async function runJob(client, {
  caseId,
  agentId,
  stepId,
  action = "command.exec",
  params,
  timeoutMs = 900_000,
} = {}) {
  const job = await client.createJob({
    caseId,
    targetAgentId: agentId,
    force: true,
    steps: [{ id: stepId, action, timeoutMs, params }],
  });
  const completed = await waitFor(async () => {
    const value = await client.getJob(job.id);
    return TERMINAL_JOB_STATES.has(value.job.state) ? value : null;
  }, { description: `native Windows job ${job.id}`, timeoutMs: timeoutMs + 60_000 });
  return {
    job: completed.job,
    jobId: job.id,
    stdout: completed.events
      .filter((event) => event.type === "step.output" && event.stream === "stdout")
      .map(eventText)
      .join(""),
    stderr: completed.events
      .filter((event) => event.type === "step.output" && event.stream === "stderr")
      .map(eventText)
      .join(""),
  };
}

function resolvePackageClosure(rootName) {
  const seen = new Map();
  const queue = [{ name: rootName, from: repoRoot }];
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    let manifestPath;
    const resolver = createRequire(path.join(from, "_ww_windows_test_resolver.cjs"));
    try {
      manifestPath = resolver.resolve(`${name}/package.json`);
    } catch {
      let entryPath;
      try { entryPath = resolver.resolve(name); } catch { continue; }
      let candidate = path.dirname(entryPath);
      while (candidate !== path.dirname(candidate)) {
        const possible = path.join(candidate, "package.json");
        if (fsSync.existsSync(possible)) {
          try {
            if (JSON.parse(fsSync.readFileSync(possible, "utf8")).name === name) {
              manifestPath = possible;
              break;
            }
          } catch {}
        }
        candidate = path.dirname(candidate);
      }
      if (!manifestPath) continue;
    }
    const directory = path.dirname(manifestPath);
    if (seen.has(directory)) continue;
    const manifest = JSON.parse(fsSync.readFileSync(manifestPath, "utf8"));
    seen.set(directory, manifest.name || name);
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.optionalDependencies || {}),
      ...Object.keys(manifest.peerDependencies || {}),
    ]);
    for (const dependency of dependencies) queue.push({ name: dependency, from: directory });
  }
  const packagePaths = [...seen.keys()]
    .map((directory) => path.relative(repoRoot, directory))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  return packagePaths
    .filter((entry, index, entries) => !entries.some((parent, parentIndex) => (
      parentIndex < index && entry.startsWith(`${parent}${path.sep}`)
    )))
    .sort();
}

function matchNumber(output, label) {
  const match = String(output).match(new RegExp(`^# ${label} (\\d+(?:\\.\\d+)?)\\s*$`, "mu"));
  return match ? Number(match[1]) : null;
}

function matchMarker(output, marker) {
  const match = String(output).match(new RegExp(`^${marker}:(.*)$`, "mu"));
  return match ? match[1].trim() : "";
}

const flags = parseArgs();
const selectedTestFiles = String(flags.files || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
for (const filename of selectedTestFiles) {
  assert(/^[A-Za-z0-9_.-]+\.test\.mjs$/u.test(filename), `Unsafe native Windows test filename ${filename}.`);
}
if (flags.managed || (process.platform !== "win32" && !process.env.WW_CONFIG_DIR)) {
  process.env.WW_PORTAL_PATH = process.env.WW_PORTAL_PATH || repoRoot;
  process.env.WW_HOME_DIR = process.env.WW_HOME_DIR || path.join(repoRoot, ".workwire");
  process.env.WW_CONFIG_DIR = process.env.WW_CONFIG_DIR || path.join(repoRoot, ".workwire", "config");
}

const [{ loadRecoveryConfig }, { createRecoveryClient }] = await Promise.all([
  import("../lib/recovery/ww-recovery-config.mjs"),
  import("../lib/recovery/ww-recovery-client.mjs"),
]);
const recoveryConfig = await loadRecoveryConfig();
const client = createRecoveryClient({
  url: flags.controller || `http://127.0.0.1:${recoveryConfig.port}`,
  token: recoveryConfig.token,
  timeoutMs: 15_000,
  transferTimeoutMs: 0,
});
const systemAgentId = flags["system-agent"] || "wwra_xCR5XgqeHAd2RkAzsp81bWPo";
const portalRoot = flags.portal || "C:\\Users\\Sakura\\WorkWire";
const nodePath = flags.node || "C:\\ProgramData\\WorkWire\\recovery-agent\\node.exe";
const runTag = crypto.randomBytes(5).toString("hex");
const remoteArchive = `C:\\ProgramData\\WorkWire\\staging\\windows-test-deps-${runTag}.tar.gz`;
const cleanupManifest = `C:\\ProgramData\\WorkWire\\staging\\windows-test-deps-${runTag}.json`;
const dependencyPaths = resolvePackageClosure("jsdom");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ww-windows-physical-"));
const dependencyArchive = path.join(temporaryRoot, "windows-test-deps.tar.gz");
const checks = {};
const evidence = {};
let caseId = null;
let failure = null;
let stage = "preflight";
const startedAt = Date.now();

try {
  assert(dependencyPaths.some((entry) => entry.replaceAll("\\", "/") === "node_modules/jsdom"), "The native Windows dependency closure does not include jsdom.");
  await execFileAsync("tar", ["-czf", dependencyArchive, ...dependencyPaths], {
    cwd: repoRoot,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  const archiveStats = await fs.stat(dependencyArchive);
  const agent = (await client.listAgents({ online: true })).find((entry) => entry.agentId === systemAgentId);
  assert(agent?.state === "online", "Pinned Sakura SYSTEM agent is offline.");
  assert(agent.capabilities?.root === true && agent.capabilities?.rawShell === true, "Pinned Sakura agent is not unrestricted.");
  const caseRecord = await client.createCase({
    targetAgentId: systemAgentId,
    goal: "Run the complete WorkWire suite in native Windows as SYSTEM",
    mode: "operator-driven",
    createdBy: "fleet-windows-physical-acceptance",
  });
  caseId = caseRecord.id;
  const artifact = await client.createArtifact({
    caseId,
    agentId: systemAgentId,
    kind: "native-windows-test-dependencies",
    filename: path.basename(dependencyArchive),
    metadata: { packageCount: dependencyPaths.length, disposable: true },
  });
  const uploaded = await client.uploadArtifact(artifact, dependencyArchive, { complete: true, timeoutMs: 0 });
  checks.preflight = true;
  evidence.preflight = {
    agentId: agent.agentId,
    identity: "NT AUTHORITY\\SYSTEM",
    bootId: agent.bootId,
    dependencyPackages: dependencyPaths.length,
    dependencyArchiveBytes: archiveStats.size,
    dependencyArtifactId: artifact.id,
    dependencyArtifactHash: uploaded.hash,
  };

  stage = "dependency-download";
  const download = await runJob(client, {
    caseId,
    agentId: systemAgentId,
    stepId: `download_deps_${runTag}`,
    action: "artifact.download",
    params: { artifactId: artifact.id, path: remoteArchive, hash: uploaded.hash, resume: true },
    timeoutMs: 180_000,
  });
  assert(download.job.state === "succeeded", `Native Windows dependency download ended ${download.job.state}.`);
  checks.dependenciesTransferred = true;
  evidence.dependencyDownloadJobId = download.jobId;

  stage = "native-windows-suite";
  const packageArray = dependencyPaths
    .map((entry) => quotePowerShellLiteral(entry.replaceAll("/", "\\")))
    .join(",");
  const testFileArray = selectedTestFiles.map(quotePowerShellLiteral).join(",");
  const suiteScript = String.raw`
$ErrorActionPreference = 'Stop'
$portal = ${quotePowerShellLiteral(portalRoot)}
$node = ${quotePowerShellLiteral(nodePath)}
$archive = ${quotePowerShellLiteral(remoteArchive)}
$manifest = ${quotePowerShellLiteral(cleanupManifest)}
$packages = @(${packageArray})
$requestedTests = @(${testFileArray})
$added = @($packages | Where-Object { -not (Test-Path -LiteralPath (Join-Path $portal $_)) })
[System.IO.File]::WriteAllText($manifest, ($added | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
$testExit = 1
$cleanupOk = $false
try {
  $env:Path = (Split-Path -Parent $node) + ';' + $env:Path
  & tar.exe -xzf $archive -C $portal
  if ($LASTEXITCODE -ne 0) { throw "tar.exe exited $LASTEXITCODE while staging native Windows test dependencies." }
  if ($requestedTests.Count -gt 0) {
    $files = @($requestedTests | ForEach-Object {
      $candidate = Join-Path (Join-Path $portal 'test') ([string]$_)
      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Requested native Windows test file does not exist: $candidate" }
      $candidate
    })
  } else {
    $files = @(Get-ChildItem -LiteralPath (Join-Path $portal 'test') -Filter '*.test.mjs' -File | Sort-Object FullName | ForEach-Object { $_.FullName })
  }
  Write-Output ('WW_WINDOWS_IDENTITY:' + [Security.Principal.WindowsIdentity]::GetCurrent().Name)
  Write-Output ('WW_WINDOWS_NODE:' + (& $node --version))
  Write-Output ('WW_WINDOWS_PLATFORM:' + (& $node -p 'process.platform'))
  Write-Output ('WW_WINDOWS_TEST_FILES:' + $files.Count)
  Push-Location $portal
  try {
    & $node --test --test-concurrency=4 @files 2>&1 | ForEach-Object { Write-Output ([string]$_) }
    $testExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  foreach ($relative in $added) { Remove-Item -LiteralPath (Join-Path $portal $relative) -Recurse -Force -ErrorAction SilentlyContinue }
  foreach ($scope in @('@asamuzakjp', '@csstools')) {
    $scopePath = Join-Path (Join-Path $portal 'node_modules') $scope
    if ((Test-Path -LiteralPath $scopePath) -and @(Get-ChildItem -LiteralPath $scopePath -Force).Count -eq 0) {
      Remove-Item -LiteralPath $scopePath -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $manifest -Force -ErrorAction SilentlyContinue
  $cleanupOk = (-not (Test-Path -LiteralPath $archive)) -and (-not (Test-Path -LiteralPath $manifest))
  Write-Output ('WW_WINDOWS_CLEANUP:' + $cleanupOk)
}
exit $testExit
`;
  const suite = await runJob(client, {
    caseId,
    agentId: systemAgentId,
    stepId: `native_suite_${runTag}`,
    params: {
      argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", suiteScript],
    },
    timeoutMs: Number(flags.timeout || 900_000),
  });
  const combinedOutput = `${suite.stdout}\n${suite.stderr}`;
  const summary = {
    tests: matchNumber(combinedOutput, "tests"),
    suites: matchNumber(combinedOutput, "suites"),
    pass: matchNumber(combinedOutput, "pass"),
    fail: matchNumber(combinedOutput, "fail"),
    cancelled: matchNumber(combinedOutput, "cancelled"),
    skipped: matchNumber(combinedOutput, "skipped"),
    todo: matchNumber(combinedOutput, "todo"),
    durationMs: matchNumber(combinedOutput, "duration_ms"),
  };
  const identity = matchMarker(combinedOutput, "WW_WINDOWS_IDENTITY");
  const platform = matchMarker(combinedOutput, "WW_WINDOWS_PLATFORM");
  const nodeVersion = matchMarker(combinedOutput, "WW_WINDOWS_NODE");
  const testFiles = Number(matchMarker(combinedOutput, "WW_WINDOWS_TEST_FILES"));
  const cleanup = matchMarker(combinedOutput, "WW_WINDOWS_CLEANUP").toLowerCase() === "true";
  evidence.nativeSuite = {
    jobId: suite.jobId,
    identity,
    platform,
    nodeVersion,
    testFiles,
    selectedTestFiles,
    ...summary,
  };
  assert(suite.job.state === "succeeded", `Native Windows suite ended ${suite.job.state}. Output tail: ${combinedOutput.trim().split(/\r?\n/u).slice(-40).join(" | ")}`);
  assert(identity.toLowerCase() === "nt authority\\system", `Native Windows suite ran as ${identity || "unknown"}.`);
  assert(platform === "win32", `Native Windows suite reported platform ${platform || "unknown"}.`);
  assert(
    summary.tests > 0
    && summary.pass + summary.skipped === summary.tests
    && summary.fail === 0
    && summary.cancelled === 0,
    "Native Windows TAP summary is incomplete or not fully green.",
  );
  assert(cleanup, "Native Windows dependency fixtures were not cleaned.");
  checks.nativeSuite = true;
  checks.cleanup = true;
} catch (error) {
  failure = error;
} finally {
  if (caseId) {
    const cleanupScript = String.raw`
$portal = ${quotePowerShellLiteral(portalRoot)}
$manifest = ${quotePowerShellLiteral(cleanupManifest)}
if (Test-Path -LiteralPath $manifest) {
  $added = @(Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json)
  foreach ($relative in $added) { Remove-Item -LiteralPath (Join-Path $portal ([string]$relative)) -Recurse -Force -ErrorAction SilentlyContinue }
}
Remove-Item -LiteralPath ${quotePowerShellLiteral(remoteArchive)} -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $manifest -Force -ErrorAction SilentlyContinue
exit 0
`;
    await runJob(client, {
      caseId,
      agentId: systemAgentId,
      stepId: `final_cleanup_${runTag}`,
      params: { argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cleanupScript] },
      timeoutMs: 30_000,
    }).catch(() => {});
  }
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

const report = {
  ok: !failure && Object.values(checks).every(Boolean),
  checkedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  systemAgentId,
  checks,
  evidence,
  error: failure ? {
    stage,
    code: String(failure?.code || "ERR_WW_WINDOWS_PHYSICAL"),
    message: String(failure?.message || failure),
    causeCode: String(failure?.cause?.code || ""),
  } : null,
};

process.stdout.write(`${JSON.stringify(report, null, flags.json ? 0 : 2)}\n`);
if (!report.ok) process.exitCode = 1;
