import { execFile } from "node:child_process";
import process from "node:process";

const WINDOWS_RECOVERY_TASK_NAME = "WorkWire Recovery Agent";
const POWERSHELL_PROBE = String.raw`
$task = Get-ScheduledTask -TaskName 'WorkWire Recovery Agent' -ErrorAction SilentlyContinue
if (-not $task) {
  [ordered]@{ ok = $true; action = 'absent'; state = 'absent' } | ConvertTo-Json -Compress
  exit 0
}
$agent = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*ww-recovery-agent.mjs*' })
if ($agent.Count -eq 0) {
  Start-ScheduledTask -TaskName 'WorkWire Recovery Agent'
  [ordered]@{ ok = $true; action = 'started'; state = [string]$task.State } | ConvertTo-Json -Compress
} else {
  [ordered]@{ ok = $true; action = 'running'; state = [string]$task.State; processCount = $agent.Count } | ConvertTo-Json -Compress
}
`;

function executeFile(execFileImpl, file, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout = "", stderr = "") => {
      if (error) {
        error.stderr = String(stderr || "").trim();
        reject(error);
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

export async function probeWindowsRecoveryAgentCompanion({
  platform = process.platform,
  execFileImpl = execFile,
} = {}) {
  if (platform !== "win32") return { ok: true, action: "unsupported", state: "unsupported" };
  const stdout = await executeFile(execFileImpl, "powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    POWERSHELL_PROBE,
  ], {
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) || "";
  const result = JSON.parse(line);
  if (result?.ok !== true) throw new Error(`Windows recovery companion probe failed for ${WINDOWS_RECOVERY_TASK_NAME}.`);
  return result;
}

export function createWindowsRecoveryAgentCompanionWatchdog({
  platform = process.platform,
  intervalMs = 60_000,
  probeImpl = probeWindowsRecoveryAgentCompanion,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  log = () => {},
} = {}) {
  let timer = null;
  let running = false;
  let stopped = false;
  let lastError = "";
  let lastResult = null;

  async function probeNow() {
    if (stopped || running || platform !== "win32") return lastResult;
    running = true;
    try {
      const result = await probeImpl({ platform });
      lastResult = result;
      lastError = "";
      if (result.action === "started") log("WorkWire restarted the Windows recovery companion task.");
      return result;
    } catch (error) {
      const message = String(error?.message || error || "Windows recovery companion probe failed.");
      if (message !== lastError) log(`Windows recovery companion unavailable: ${message}`);
      lastError = message;
      return null;
    } finally {
      running = false;
    }
  }

  return {
    start() {
      stopped = false;
      if (platform !== "win32" || timer) return;
      void probeNow();
      timer = setIntervalImpl(() => void probeNow(), Math.max(5_000, Number(intervalMs) || 60_000));
      timer?.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearIntervalImpl(timer);
      timer = null;
    },
    probeNow,
    getStatus() {
      return { running, stopped, lastError, lastResult };
    },
  };
}
