import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createRecoveryError, RECOVERY_ERROR_CODES } from "./ww-recovery-protocol.mjs";

const PLANNER_OUTPUT_TYPES = new Set([
  "planner.note", "planner.action", "planner.actions", "planner.inventory",
  "planner.complete", "planner.fail", "planner.wait",
]);

function validatePlannerMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !PLANNER_OUTPUT_TYPES.has(value.type)) {
    throw createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_PROTOCOL, `Invalid planner message type ${value?.type || "<missing>"}.`);
  }
  if (value.type === "planner.action" && !String(value.action || "").trim()) {
    throw createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_PROTOCOL, "planner.action requires action.");
  }
  if (value.type === "planner.actions" && (!Array.isArray(value.actions) || value.actions.length === 0)) {
    throw createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_PROTOCOL, "planner.actions requires a non-empty actions array.");
  }
  return value;
}

export function createPlannerProcess({
  command,
  spawnImpl = spawn,
  cwd,
  env = process.env,
  log = () => {},
} = {}) {
  const argv = Array.isArray(command) ? command.map(String) : [];
  if (argv.length === 0) throw new TypeError("Planner command argv is required.");
  const emitter = new EventEmitter();
  const queue = [];
  const waiters = [];
  let child = null;
  let exited = null;
  let buffer = "";

  function deliver(value) {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value);
    else queue.push(value);
    emitter.emit("message", value);
  }

  function failWaiters(error) {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  }

  function parseLines(chunk) {
    buffer += String(chunk);
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        deliver(validatePlannerMessage(JSON.parse(line)));
      } catch (error) {
        failWaiters(error);
        emitter.emit("protocolError", error);
      }
    }
  }

  async function start() {
    if (child) return api;
    child = spawnImpl(argv[0], argv.slice(1), {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
      env,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", parseLines);
    child.stderr.on("data", (value) => log(String(value).trimEnd()));
    child.once("error", (cause) => {
      const error = createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_EXIT, `Planner failed to start: ${cause.message}`);
      exited = { error };
      failWaiters(error);
    });
    child.once("close", (exitCode, signal) => {
      exited = { exitCode, signal };
      const error = createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_EXIT, `Planner exited with ${exitCode ?? signal}.`, exited);
      failWaiters(error);
      emitter.emit("exit", exited);
    });
    await once(child, "spawn");
    return api;
  }

  async function send(message) {
    if (!child || exited) throw createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_EXIT, "Planner is not running.");
    const line = `${JSON.stringify(message)}\n`;
    if (!child.stdin.write(line)) await once(child.stdin, "drain");
  }

  function next({ timeoutMs = 0, signal } = {}) {
    if (queue.length) return Promise.resolve(queue.shift());
    if (exited) return Promise.reject(createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_EXIT, "Planner has exited.", exited));
    return new Promise((resolve, reject) => {
      let timer = null;
      const abort = () => {
        cleanup();
        reject(signal.reason || createRecoveryError(RECOVERY_ERROR_CODES.CANCELED, "Planner wait canceled."));
      };
      const waiter = {
        resolve(value) { cleanup(); resolve(value); },
        reject(error) { cleanup(); reject(error); },
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
      };
      waiters.push(waiter);
      if (Number(timeoutMs) > 0) {
        timer = setTimeout(() => waiter.reject(createRecoveryError(RECOVERY_ERROR_CODES.TIMEOUT, `Planner iteration timed out after ${timeoutMs}ms.`)), Number(timeoutMs));
        timer.unref?.();
      }
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async function stop(message = null) {
    if (!child) return;
    if (message && !exited) await send(message).catch(() => {});
    child.stdin.end();
    if (!exited) child.kill("SIGTERM");
  }

  const api = {
    type: "command-jsonl",
    start,
    send,
    next,
    stop,
    on: emitter.on.bind(emitter),
    getProcess: () => child,
  };
  return api;
}

export function createDeterministicPlanner(messages = []) {
  const queue = messages.map((message) => structuredClone(message));
  const observations = [];
  return {
    type: "deterministic-test",
    async start() { return this; },
    async send(message) { observations.push(structuredClone(message)); },
    async next() {
      if (queue.length === 0) throw createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_EXIT, "Deterministic planner fixture is exhausted.");
      return queue.shift();
    },
    async stop() {},
    getObservations: () => structuredClone(observations),
  };
}

export function createOperatorPlanner() {
  const messages = [];
  const waiters = [];
  const context = [];
  return {
    type: "operator",
    async start() { return this; },
    async send(message) { context.push(structuredClone(message)); },
    next({ signal } = {}) {
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason || new Error("Operator planner stopped."));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        waiters.push((message) => {
          signal?.removeEventListener("abort", abort);
          resolve(message);
        });
      });
    },
    submit(message) {
      const normalized = validatePlannerMessage(message);
      const waiter = waiters.shift();
      if (waiter) waiter(normalized);
      else messages.push(normalized);
    },
    async stop() {},
    getContext: () => structuredClone(context),
  };
}

export { validatePlannerMessage };
