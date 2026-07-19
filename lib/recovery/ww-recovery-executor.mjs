import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  createRecoveryError,
  encodeOutputChunk,
  RECOVERY_ERROR_CODES,
} from "./ww-recovery-protocol.mjs";

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_CANCEL_GRACE_MS = 2_000;

function clockMilliseconds(clock) {
  return typeof clock === "function" && !clock.now ? Number(clock()) : Number(clock.now());
}

function iso(clock) {
  return new Date(clockMilliseconds(clock)).toISOString();
}

function appendTail(current, chunk, maximumBytes) {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= maximumBytes ? combined : combined.subarray(combined.length - maximumBytes);
}

function notify(listener, event) {
  if (typeof listener !== "function") return;
  try {
    const result = listener(event);
    if (result?.catch) result.catch(() => {});
  } catch {}
}

function buildExecutionId(randomBytesImpl) {
  return `wwx_${Date.now().toString(36)}${randomBytesImpl(8).toString("base64url")}`;
}

async function commandExists(candidate, fsImpl = fsPromises) {
  try {
    await fsImpl.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function createRecoveryExecutor({
  spawnImpl = nodeSpawn,
  fsImpl = fsPromises,
  fsSyncImpl = fs,
  clock = Date,
  randomBytesImpl = randomBytes,
  platform = process.platform,
  baseEnv = process.env,
  maxChunkBytes = DEFAULT_CHUNK_BYTES,
  maxTailBytes = DEFAULT_TAIL_BYTES,
  cancelGraceMs = DEFAULT_CANCEL_GRACE_MS,
} = {}) {
  const active = new Map();
  const pathImpl = platform === "win32" ? path.win32 : path;

  function executableCandidates(value, env) {
    if (platform !== "win32") return [value];
    const extensions = String(env.PATHEXT || baseEnv.PATHEXT || DEFAULT_WINDOWS_PATHEXT)
      .split(";")
      .map((extension) => extension.trim())
      .filter(Boolean);
    const hasExtension = extensions.some((extension) => value.toLowerCase().endsWith(extension.toLowerCase()));
    return hasExtension ? [value] : [value, ...extensions.map((extension) => `${value}${extension}`)];
  }

  async function resolveTool(name, { env = {} } = {}) {
    const value = String(name || "").trim();
    if (!value || value.includes("\0")) return "";
    if (value.includes("/") || (platform === "win32" && (value.includes("\\") || pathImpl.isAbsolute(value)))) {
      const absolute = pathImpl.resolve(value);
      for (const candidate of executableCandidates(absolute, env)) {
        if (await commandExists(candidate, fsImpl)) return candidate;
      }
      return "";
    }
    const searchPath = String(env.PATH || baseEnv.PATH || (platform === "win32" ? "" : DEFAULT_PATH));
    for (const directory of searchPath.split(pathImpl.delimiter).filter(Boolean)) {
      for (const candidate of executableCandidates(pathImpl.join(directory, value), env)) {
        if (await commandExists(candidate, fsImpl)) return candidate;
      }
    }
    return "";
  }

  async function toolExists(name, options = {}) {
    return Boolean(await resolveTool(name, options));
  }

  function signalProcessGroup(record, signal) {
    if (!record?.child || record.child.exitCode !== null) return false;
    try {
      if (platform !== "win32" && Number.isInteger(record.child.pid)) {
        process.kill(-record.child.pid, signal);
      } else {
        record.child.kill(signal);
      }
      return true;
    } catch {
      try {
        return record.child.kill(signal);
      } catch {
        return false;
      }
    }
  }

  function cancelExecution(executionId, reason = "operator-canceled") {
    const record = active.get(String(executionId || ""));
    if (!record) return false;
    record.canceled = true;
    record.cancelReason = String(reason || "operator-canceled");
    signalProcessGroup(record, "SIGTERM");
    clearTimeout(record.killTimer);
    record.killTimer = setTimeout(() => signalProcessGroup(record, "SIGKILL"), cancelGraceMs);
    record.killTimer.unref?.();
    return true;
  }

  async function pipeStdin(child, stdin) {
    if (stdin === undefined || stdin === null) {
      child.stdin.end();
      return;
    }
    if (typeof stdin === "string" || Buffer.isBuffer(stdin) || ArrayBuffer.isView(stdin)) {
      child.stdin.end(stdin);
      return;
    }
    if (stdin?.path) {
      await new Promise((resolve, reject) => {
        const source = fsSyncImpl.createReadStream(path.resolve(String(stdin.path)));
        source.once("error", reject);
        child.stdin.once("error", reject);
        child.stdin.once("finish", resolve);
        source.pipe(child.stdin);
      });
      return;
    }
    if (stdin instanceof Readable || typeof stdin?.pipe === "function") {
      await new Promise((resolve, reject) => {
        stdin.once?.("error", reject);
        child.stdin.once("error", reject);
        child.stdin.once("finish", resolve);
        stdin.pipe(child.stdin);
      });
      return;
    }
    child.stdin.end(Buffer.from(stdin));
  }

  async function execArgv({
    file,
    args = [],
    cwd,
    env = {},
    stdin,
    timeoutMs = 120_000,
    runAs,
    force = false,
    onEvent,
    signal,
    secretEnv = [],
  } = {}) {
    const requestedFile = String(file || "").trim();
    if (!requestedFile) {
      throw createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, "Command file is required.");
    }
    const requestedArgs = Array.isArray(args) ? args.map((argument) => String(argument)) : [];
    const combinedEnv = {
      ...baseEnv,
      PATH: String(baseEnv.PATH || DEFAULT_PATH),
      ...Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, String(value)])),
    };
    const executable = await resolveTool(requestedFile, { env: combinedEnv });
    if (!executable) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.TOOL_MISSING,
        `Recovery executable ${requestedFile} was not found in PATH.`,
        { file: requestedFile },
      );
    }

    let spawnFile = executable;
    let spawnArgs = requestedArgs;
    if (runAs !== undefined && runAs !== null && String(runAs).trim()) {
      const runuser = await resolveTool("runuser", { env: combinedEnv });
      if (!runuser) {
        throw createRecoveryError(RECOVERY_ERROR_CODES.TOOL_MISSING, "runuser is required for runAs.");
      }
      spawnFile = runuser;
      spawnArgs = ["-u", String(runAs), "--", executable, ...requestedArgs];
    }

    const executionId = buildExecutionId(randomBytesImpl);
    const startedMilliseconds = clockMilliseconds(clock);
    const startedAt = new Date(startedMilliseconds).toISOString();
    const redactedKeys = new Set((Array.isArray(secretEnv) ? secretEnv : []).map(String));
    notify(onEvent, {
      type: "command",
      executionId,
      file: executable,
      args: requestedArgs,
      spawnFile,
      spawnArgs,
      cwd: cwd ? path.resolve(String(cwd)) : process.cwd(),
      env: Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [
        key,
        redactedKeys.has(key) ? "[REDACTED]" : String(value),
      ])),
      force: force === true,
      effectiveUid: typeof process.geteuid === "function" ? process.geteuid() : null,
      root: typeof process.geteuid === "function" ? process.geteuid() === 0 : false,
      at: startedAt,
    });

    let child;
    try {
      child = spawnImpl(spawnFile, spawnArgs, {
        cwd: cwd ? path.resolve(String(cwd)) : undefined,
        env: combinedEnv,
        shell: false,
        detached: platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.COMMAND_START,
        `Unable to start ${executable}: ${cause.message}`,
        { cause: cause.message },
      );
    }

    const record = {
      child,
      canceled: false,
      cancelReason: "",
      timedOut: false,
      killTimer: null,
    };
    active.set(executionId, record);
    let stdoutTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const handleOutput = (stream) => (value) => {
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (stream === "stdout") {
        stdoutBytes += buffer.length;
        stdoutTail = appendTail(stdoutTail, buffer, maxTailBytes);
      } else {
        stderrBytes += buffer.length;
        stderrTail = appendTail(stderrTail, buffer, maxTailBytes);
      }
      for (let offset = 0; offset < buffer.length; offset += maxChunkBytes) {
        notify(onEvent, {
          type: "output",
          executionId,
          stream,
          ...encodeOutputChunk(buffer.subarray(offset, Math.min(buffer.length, offset + maxChunkBytes))),
          at: iso(clock),
        });
      }
    };
    child.stdout.on("data", handleOutput("stdout"));
    child.stderr.on("data", handleOutput("stderr"));

    let timeoutTimer = null;
    const timeout = Number(timeoutMs);
    if (Number.isFinite(timeout) && timeout > 0) {
      timeoutTimer = setTimeout(() => {
        record.timedOut = true;
        record.cancelReason = `timeout-${timeout}`;
        signalProcessGroup(record, "SIGTERM");
        record.killTimer = setTimeout(() => signalProcessGroup(record, "SIGKILL"), cancelGraceMs);
        record.killTimer.unref?.();
      }, timeout);
      timeoutTimer.unref?.();
    }
    const abort = () => cancelExecution(executionId, signal?.reason?.message || "aborted");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    const startErrorPromise = new Promise((_, reject) => {
      child.once("error", (cause) => reject(createRecoveryError(
        RECOVERY_ERROR_CODES.COMMAND_START,
        `Unable to start ${executable}: ${cause.message}`,
        { cause: cause.message },
      )));
    });
    const closePromise = new Promise((resolve) => {
      child.once("close", (exitCode, exitSignal) => resolve({ exitCode, signal: exitSignal }));
    });
    void pipeStdin(child, stdin).catch((cause) => child.stdin.destroy(cause));

    try {
      const closed = await Promise.race([closePromise, startErrorPromise]);
      const endedMilliseconds = clockMilliseconds(clock);
      const result = {
        executionId,
        file: executable,
        args: requestedArgs,
        force: force === true,
        exitCode: closed.exitCode,
        signal: closed.signal,
        startedAt,
        endedAt: new Date(endedMilliseconds).toISOString(),
        durationMs: Math.max(0, endedMilliseconds - startedMilliseconds),
        stdoutBytes,
        stderrBytes,
        stdoutTail: stdoutTail.toString("utf8"),
        stderrTail: stderrTail.toString("utf8"),
        timedOut: record.timedOut,
        canceled: record.canceled,
        cancelReason: record.cancelReason || null,
        effectiveUid: typeof process.geteuid === "function" ? process.geteuid() : null,
        root: typeof process.geteuid === "function" ? process.geteuid() === 0 : false,
      };
      notify(onEvent, { type: "result", ...result });
      return result;
    } finally {
      clearTimeout(timeoutTimer);
      clearTimeout(record.killTimer);
      signal?.removeEventListener("abort", abort);
      active.delete(executionId);
    }
  }

  function shellArguments(shell, script) {
    if (/(^|[\\/])cmd(\.exe)?$/i.test(shell)) return ["/d", "/s", "/c", script];
    if (/(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(shell)) {
      return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script];
    }
    return ["-lc", script];
  }

  async function execShell({
    script,
    shell = platform === "win32" ? "powershell" : "/bin/bash",
    ...options
  } = {}) {
    return execArgv({
      ...options,
      file: shell,
      args: shellArguments(String(shell), String(script ?? "")),
    });
  }

  return {
    execArgv,
    execShell,
    cancelExecution,
    toolExists,
    resolveTool,
    listActiveExecutions() {
      return [...active.keys()];
    },
  };
}

const defaultExecutor = createRecoveryExecutor();
export const execArgv = defaultExecutor.execArgv;
export const execShell = defaultExecutor.execShell;
export const cancelExecution = defaultExecutor.cancelExecution;
export const toolExists = defaultExecutor.toolExists;
export const resolveTool = defaultExecutor.resolveTool;
