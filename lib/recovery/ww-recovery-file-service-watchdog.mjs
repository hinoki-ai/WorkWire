import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const WINDOWS_FILE_TASK_NAME = "WorkWire Serve";
const DEFAULT_PROBE_URL = "http://127.0.0.1:4851/v1/discover";
const MAINTENANCE_MAX_AGE_MS = 30 * 60 * 1_000;
const POWERSHELL_RESTART = String.raw`
$task = Get-ScheduledTask -TaskName 'WorkWire Serve' -ErrorAction SilentlyContinue
if (-not $task) {
  [ordered]@{ ok = $true; action = 'absent'; state = 'absent' } | ConvertTo-Json -Compress
  exit 0
}
Stop-ScheduledTask -TaskName 'WorkWire Serve' -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 750
Start-ScheduledTask -TaskName 'WorkWire Serve'
[ordered]@{ ok = $true; action = 'restarted'; state = [string]$task.State } | ConvertTo-Json -Compress
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

function maintenancePath(env = process.env) {
  const programData = String(env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData");
  return path.win32.join(programData, "WorkWire", "file-service-maintenance.lock");
}

export async function inspectWindowsFileServiceMaintenance({
  platform = process.platform,
  env = process.env,
  fsImpl = fs,
  now = Date.now(),
} = {}) {
  if (platform !== "win32") return { active: false, path: "" };
  const markerPath = maintenancePath(env);
  const stats = await fsImpl.stat(markerPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stats) return { active: false, path: markerPath };
  const ageMs = Math.max(0, Number(now) - Number(stats.mtimeMs || 0));
  if (ageMs <= MAINTENANCE_MAX_AGE_MS) return { active: true, path: markerPath, ageMs };
  await fsImpl.rm(markerPath, { force: true });
  return { active: false, path: markerPath, ageMs, removedStale: true };
}

export async function probeWindowsFileService({
  platform = process.platform,
  fetchImpl = fetch,
  url = DEFAULT_PROBE_URL,
  timeoutMs = 3_000,
} = {}) {
  if (platform !== "win32") return { ok: true, action: "unsupported", machineId: "" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || 3_000));
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Local WorkWire file service returned HTTP ${response.status}.`);
    const payload = await response.json();
    const machineId = String(payload?.service?.machineId || "").trim();
    if (!machineId || Number(payload?.service?.versions?.protocol) !== 1) {
      throw new Error("Local port 4851 did not return a valid WorkWire service identity.");
    }
    return {
      ok: true,
      action: "healthy",
      machineId,
      version: String(payload?.service?.versions?.app || ""),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function restartWindowsFileServiceTask({
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
    POWERSHELL_RESTART,
  ], {
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 256 * 1024,
  });
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) || "";
  const result = JSON.parse(line);
  if (result?.ok !== true) throw new Error(`Windows file-service restart failed for ${WINDOWS_FILE_TASK_NAME}.`);
  return result;
}

export function createWindowsFileServiceWatchdog({
  platform = process.platform,
  intervalMs = 10_000,
  failureThreshold = 3,
  restartCooldownMs = 30_000,
  probeImpl = probeWindowsFileService,
  restartImpl = restartWindowsFileServiceTask,
  maintenanceImpl = inspectWindowsFileServiceMaintenance,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  nowImpl = Date.now,
  log = () => {},
} = {}) {
  let timer = null;
  let running = false;
  let stopped = false;
  let consecutiveFailures = 0;
  let lastRestartAt = 0;
  let lastError = "";
  let lastResult = null;

  async function probeNow() {
    if (stopped || running || platform !== "win32") return lastResult;
    running = true;
    try {
      const maintenance = await maintenanceImpl({ platform });
      if (maintenance?.active) {
        consecutiveFailures = 0;
        lastError = "";
        lastResult = { ok: true, action: "maintenance" };
        return lastResult;
      }
      try {
        lastResult = await probeImpl({ platform });
        consecutiveFailures = 0;
        lastError = "";
        return lastResult;
      } catch (error) {
        consecutiveFailures += 1;
        lastError = String(error?.message || error || "Windows file-service probe failed.");
        const now = Number(nowImpl()) || Date.now();
        if (
          consecutiveFailures >= Math.max(1, Number(failureThreshold) || 3)
          && now - lastRestartAt >= Math.max(0, Number(restartCooldownMs) || 0)
        ) {
          const restart = await restartImpl({ platform });
          lastRestartAt = now;
          consecutiveFailures = 0;
          lastResult = restart;
          log("WorkWire recovery agent restarted the unresponsive Windows file-service task.");
          return restart;
        }
        return null;
      }
    } catch (error) {
      lastError = String(error?.message || error || "Windows file-service watchdog failed.");
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
      timer = setIntervalImpl(() => void probeNow(), Math.max(2_000, Number(intervalMs) || 10_000));
      timer?.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearIntervalImpl(timer);
      timer = null;
    },
    probeNow,
    getStatus() {
      return {
        running,
        stopped,
        consecutiveFailures,
        lastRestartAt,
        lastError,
        lastResult,
      };
    },
  };
}
