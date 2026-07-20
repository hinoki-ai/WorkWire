import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { generateRecoveryId, RECOVERY_ERROR_CODES } from "./ww-recovery-protocol.mjs";
import { renameRecoveryFile } from "./ww-recovery-atomic.mjs";

const ACTIVE_SESSION_STATES = new Set(["opening", "attached", "detached"]);
const SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL", "SIGSTOP", "SIGCONT", "SIGWINCH"]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function iso(clock = Date) {
  const value = typeof clock === "function" && !clock.now ? clock() : clock.now();
  return new Date(value).toISOString();
}

function sessionError(message, code = "ERR_WW_RECOVERY_SESSION", details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function validId(value, label = "session id") {
  const id = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,191}$/.test(id) || id.includes("..")) throw sessionError(`Invalid ${label}.`, RECOVERY_ERROR_CODES.BAD_REQUEST);
  return id;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function encodeBytes(buffer) {
  const value = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  const decoded = value.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(value)
    ? { data: decoded, encoding: "utf8" }
    : { data: value.toString("base64"), encoding: "base64" };
}

function decodeBytes(input = {}) {
  return Buffer.from(String(input.data || ""), input.encoding === "base64" ? "base64" : "utf8");
}

function killProcessTree(child, signal = "SIGTERM", platform = process.platform) {
  if (!child?.pid) return false;
  try {
    if (platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch {
    try { return child.kill(signal); } catch { return false; }
  }
}

export function createInteractiveAgentRuntime({
  send,
  executor,
  platform = process.platform,
  spawnImpl = spawn,
  fsImpl = fs,
  maxSessions = 4,
  ringBytes = 2 * 1024 * 1024,
  log = () => {},
} = {}) {
  if (typeof send !== "function") throw new TypeError("Interactive agent runtime requires send().");
  const sessions = new Map();
  const tunnels = new Map();

  function emit(session, event) {
    session.outputSeq += 1;
    const record = {
      ...clone(event),
      sessionId: session.id,
      agentId: session.agentId,
      outputSeq: session.outputSeq,
      at: event.at || new Date().toISOString(),
    };
    const bytes = Buffer.byteLength(JSON.stringify(record));
    session.ring.push(record);
    session.ringSize += bytes;
    while (session.ringSize > ringBytes && session.ring.length > 1) {
      session.ringSize -= Buffer.byteLength(JSON.stringify(session.ring.shift()));
    }
    send({ type: "agent.session.event", event: record });
    return record;
  }

  async function buildLaunch(request) {
    const cwd = path.resolve(String(request.cwd || (platform === "win32" ? process.env.USERPROFILE || process.cwd() : process.env.HOME || process.cwd())));
    const env = { ...process.env, TERM: String(request.term || "xterm-256color") };
    for (const [key, value] of Object.entries(request.env || {})) env[String(key)] = String(value);
    if (Array.isArray(request.transportArgv) && request.transportArgv.length > 0) {
      return { file: String(request.transportArgv[0]), args: request.transportArgv.slice(1).map(String), cwd, env, terminalMode: "custom-transport" };
    }
    if (platform === "win32") {
      const winpty = await executor?.resolveTool?.("winpty").catch?.(() => "") || "";
      const powershell = String(request.shell || await executor?.resolveTool?.("pwsh").catch?.(() => "") || await executor?.resolveTool?.("powershell").catch?.(() => "") || "powershell.exe");
      const shellArgs = Array.isArray(request.argv) && request.argv.length > 0
        ? request.argv.slice(1).map(String)
        : ["-NoLogo", "-NoExit"];
      return winpty
        ? { file: winpty, args: [powershell, ...shellArgs], cwd, env, terminalMode: "winpty-conpty" }
        : { file: powershell, args: shellArgs, cwd, env, terminalMode: "powershell-pipes" };
    }
    const script = await executor?.resolveTool?.("script").catch?.(() => "") || "";
    const argv = Array.isArray(request.argv) && request.argv.length > 0
      ? request.argv.map(String)
      : [String(request.shell || env.SHELL || "/bin/bash"), "-i"];
    if (script && request.pty !== false) {
      return {
        file: script,
        args: ["-qfec", argv.map(shellQuote).join(" "), "/dev/null"],
        cwd,
        env,
        terminalMode: "linux-pty-script",
      };
    }
    return { file: argv[0], args: argv.slice(1), cwd, env, terminalMode: "pipes" };
  }

  async function openSession(message) {
    const request = message.session || message;
    const id = validId(request.id || request.sessionId);
    const activeCount = [...sessions.values()].filter((session) => ACTIVE_SESSION_STATES.has(session.state)).length;
    if (activeCount >= maxSessions && request.overrideLimit !== true) {
      send({ type: "agent.session.event", event: { type: "session.error", sessionId: id, requestId: message.requestId, code: "ERR_WW_RECOVERY_SESSION_LIMIT", message: `Agent session limit ${maxSessions} reached.`, at: new Date().toISOString() } });
      return;
    }
    if (sessions.has(id)) {
      const existing = sessions.get(id);
      send({ type: "agent.session.event", event: { type: "session.created", sessionId: id, requestId: message.requestId, pid: existing.child?.pid || null, terminalMode: existing.terminalMode, cwd: existing.cwd, outputSeq: existing.outputSeq, at: new Date().toISOString() } });
      return;
    }
    let launch;
    try {
      launch = await buildLaunch(request);
    } catch (error) {
      send({ type: "agent.session.event", event: { type: "session.error", sessionId: id, requestId: message.requestId, code: error.code, message: error.message, at: new Date().toISOString() } });
      return;
    }
    const record = {
      id,
      agentId: String(request.agentId || ""),
      caseId: String(request.caseId || ""),
      cwd: launch.cwd,
      env: clone(request.env || {}),
      state: "opening",
      terminalMode: launch.terminalMode,
      outputSeq: 0,
      ring: [],
      ringSize: 0,
      child: null,
      rows: Number(request.rows) || 24,
      cols: Number(request.cols) || 80,
    };
    sessions.set(id, record);
    try {
      const child = spawnImpl(launch.file, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: platform !== "win32",
      });
      record.child = child;
      child.stdout?.on("data", (chunk) => emit(record, { type: "session.output", stream: launch.terminalMode.includes("pty") ? "pty" : "stdout", ...encodeBytes(chunk) }));
      child.stderr?.on("data", (chunk) => emit(record, { type: "session.output", stream: "stderr", ...encodeBytes(chunk) }));
      child.once("error", (error) => {
        record.state = "failed";
        emit(record, { type: "session.error", requestId: message.requestId, code: error.code, message: error.message });
      });
      child.once("close", (code, signal) => {
        record.state = "exited";
        emit(record, { type: "session.exited", exitCode: code, signal: signal || null });
      });
      record.state = "attached";
      emit(record, {
        type: "session.created",
        requestId: message.requestId,
        pid: child.pid,
        terminalMode: record.terminalMode,
        cwd: record.cwd,
        rows: record.rows,
        cols: record.cols,
      });
    } catch (error) {
      record.state = "failed";
      emit(record, { type: "session.error", requestId: message.requestId, code: error.code, message: error.message });
    }
  }

  function sessionFor(message) {
    const id = validId(message.sessionId);
    const record = sessions.get(id);
    if (!record) throw sessionError(`Interactive session ${id} is unavailable on this agent.`, RECOVERY_ERROR_CODES.NOT_FOUND);
    return record;
  }

  async function handleSession(message) {
    if (message.type === "controller.session.open") return openSession(message);
    const record = sessionFor(message);
    if (message.type === "controller.session.input") {
      if (!record.child?.stdin?.writable) throw sessionError(`Interactive session ${record.id} does not accept input.`);
      record.child.stdin.write(decodeBytes(message));
      emit(record, { type: "session.input.ack", requestId: message.requestId, bytes: decodeBytes(message).length });
      return;
    }
    if (message.type === "controller.session.resize") {
      record.rows = Math.max(1, Number(message.rows) || record.rows);
      record.cols = Math.max(1, Number(message.cols) || record.cols);
      if (platform !== "win32" && record.terminalMode === "linux-pty-script" && record.child?.stdin?.writable) {
        record.child.stdin.write(`stty rows ${record.rows} cols ${record.cols}\r`);
        killProcessTree(record.child, "SIGWINCH", platform);
      }
      emit(record, { type: "session.resized", requestId: message.requestId, rows: record.rows, cols: record.cols });
      return;
    }
    if (message.type === "controller.session.signal") {
      const signal = SIGNALS.has(String(message.signal)) ? String(message.signal) : "SIGINT";
      const delivered = killProcessTree(record.child, signal, platform);
      emit(record, { type: "session.signal", requestId: message.requestId, signal, delivered });
      return;
    }
    if (message.type === "controller.session.terminate") {
      const delivered = killProcessTree(record.child, "SIGTERM", platform);
      record.state = "terminating";
      emit(record, { type: "session.terminating", requestId: message.requestId, delivered });
      return;
    }
    if (message.type === "controller.session.detach") {
      record.state = "detached";
      emit(record, { type: "session.detached", requestId: message.requestId });
      return;
    }
    if (message.type === "controller.session.resume") {
      const requested = Math.max(0, Number(message.afterSeq) || 0);
      const earliest = record.ring[0]?.outputSeq || record.outputSeq + 1;
      if (requested + 1 < earliest) {
        send({ type: "agent.session.event", event: { type: "session.gap", sessionId: record.id, requestId: message.requestId, requestedAfter: requested, earliestAvailable: earliest, latest: record.outputSeq, at: new Date().toISOString() } });
      }
      for (const event of record.ring.filter((event) => event.outputSeq > requested)) send({ type: "agent.session.event", event });
      record.state = record.state === "detached" ? "attached" : record.state;
      send({ type: "agent.session.event", event: { type: "session.resumed", sessionId: record.id, requestId: message.requestId, throughSeq: record.outputSeq, state: record.state, at: new Date().toISOString() } });
      return;
    }
    if (message.type === "controller.session.file.put") {
      const relative = String(message.path || "");
      const destination = path.resolve(record.cwd, relative);
      await fsImpl.mkdir(path.dirname(destination), { recursive: true });
      await fsImpl.writeFile(destination, decodeBytes(message), { mode: Number(message.mode) || 0o600 });
      emit(record, { type: "session.file.put", requestId: message.requestId, path: destination, bytes: decodeBytes(message).length });
      return;
    }
    if (message.type === "controller.session.file.get") {
      const source = path.resolve(record.cwd, String(message.path || ""));
      const value = await fsImpl.readFile(source);
      emit(record, { type: "session.file.get", requestId: message.requestId, path: source, bytes: value.length, ...encodeBytes(value) });
    }
  }

  function handleTunnel(message) {
    if (message.type === "controller.tunnel.open") {
      const connectionId = validId(message.connectionId, "tunnel connection id");
      const socket = net.createConnection({ host: String(message.targetHost || "127.0.0.1"), port: Number(message.targetPort) });
      tunnels.set(connectionId, socket);
      socket.once("connect", () => send({ type: "agent.tunnel.opened", tunnelId: message.tunnelId, connectionId }));
      socket.on("data", (chunk) => send({ type: "agent.tunnel.data", tunnelId: message.tunnelId, connectionId, data: chunk.toString("base64"), encoding: "base64" }));
      socket.once("error", (error) => send({ type: "agent.tunnel.error", tunnelId: message.tunnelId, connectionId, error: { code: error.code, message: error.message } }));
      socket.once("close", () => {
        tunnels.delete(connectionId);
        send({ type: "agent.tunnel.close", tunnelId: message.tunnelId, connectionId });
      });
      return true;
    }
    if (message.type === "controller.tunnel.data") {
      tunnels.get(String(message.connectionId))?.write(decodeBytes(message));
      return true;
    }
    if (message.type === "controller.tunnel.close") {
      tunnels.get(String(message.connectionId))?.destroy();
      return true;
    }
    return false;
  }

  async function handle(message) {
    try {
      if (String(message.type || "").startsWith("controller.session.")) {
        await handleSession(message);
        return true;
      }
      return handleTunnel(message);
    } catch (error) {
      const sessionId = String(message.sessionId || "");
      send({ type: "agent.session.event", event: { type: "session.error", sessionId, requestId: message.requestId, code: error.code, message: error.message, at: new Date().toISOString() } });
      return true;
    }
  }

  async function stop() {
    for (const record of sessions.values()) killProcessTree(record.child, "SIGTERM", platform);
    for (const socket of tunnels.values()) socket.destroy();
    tunnels.clear();
  }

  function capabilities() {
    return {
      terminal: true,
      terminalMode: platform === "win32" ? "powershell-conpty-when-winpty-present" : "linux-pty-script-when-present",
      resize: true,
      signals: platform !== "win32",
      detachReconnect: true,
      ringBytes,
      maxSessions,
      sessionFiles: true,
      tcpTunnel: true,
    };
  }

  return { handle, stop, capabilities, getSession: (id) => sessions.get(String(id)) || null };
}

export function createRecoveryInteractiveController({
  stateDir,
  store,
  sendToAgent,
  isAgentOnline,
  clock = Date,
  fsImpl = fs,
  requestTimeoutMs = 15_000,
  log = () => {},
} = {}) {
  if (!stateDir || !store || typeof sendToAgent !== "function") throw new TypeError("Interactive controller requires stateDir, store, and sendToAgent().");
  const root = path.join(path.resolve(stateDir), "interactive");
  const statePath = path.join(root, "state.json");
  let state = { version: 1, sessions: {}, tunnels: {}, updatedAt: null };
  const pending = new Map();
  const localConnections = new Map();
  const tunnelServers = new Map();
  let mutationTail = Promise.resolve();

  function eventPath(sessionId) {
    return path.join(root, "sessions", validId(sessionId), "events.jsonl");
  }

  async function atomicJson(filename, value) {
    await fsImpl.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${process.pid}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await renameRecoveryFile(fsImpl, temporary, filename);
    } finally {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
    }
  }

  function mutate(task) {
    const run = mutationTail.then(task, task);
    mutationTail = run.catch(() => {});
    return run;
  }

  async function persist() {
    state.updatedAt = iso(clock);
    await atomicJson(statePath, state);
  }

  async function init() {
    await fsImpl.mkdir(path.join(root, "sessions"), { recursive: true, mode: 0o700 });
    try { state = { ...state, ...JSON.parse(await fsImpl.readFile(statePath, "utf8")) }; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    for (const session of Object.values(state.sessions)) {
      if (["opening", "attached"].includes(session.state)) session.state = "detached";
      if (!Number.isFinite(Number(session.lastEventSeq))) {
        const records = await fsImpl.readFile(eventPath(session.id), "utf8").catch(() => "");
        session.lastEventSeq = records.split("\n").filter(Boolean).length;
      }
    }
    for (const tunnel of Object.values(state.tunnels)) {
      if (tunnel.state === "open") await startTunnelServer(tunnel, { restoring: true }).catch((error) => {
        tunnel.state = "failed";
        tunnel.error = { code: error.code, message: error.message };
      });
    }
    await persist();
    return api;
  }

  function requireOnline(agentId) {
    if (isAgentOnline && !isAgentOnline(agentId)) throw sessionError(`Recovery agent ${agentId} is offline.`, RECOVERY_ERROR_CODES.AGENT_OFFLINE);
  }

  function send(agentId, message) {
    requireOnline(agentId);
    if (!sendToAgent(agentId, message)) throw sessionError(`Recovery agent ${agentId} is offline.`, RECOVERY_ERROR_CODES.AGENT_OFFLINE);
  }

  function waitFor(requestId, timeoutMs = requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(sessionError(`Interactive request ${requestId} timed out.`, RECOVERY_ERROR_CODES.TIMEOUT));
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
    });
  }

  async function appendEvent(event) {
    const sessionId = validId(event.sessionId);
    const session = state.sessions[sessionId];
    if (!session) return null;
    const duplicate = Number(event.outputSeq) <= Number(session.lastOutputSeq || 0)
      && event.type !== "session.gap" && event.type !== "session.resumed";
    if (duplicate) return null;
    await mutate(async () => {
      event.eventSeq = ++session.lastEventSeq;
      await fsImpl.mkdir(path.dirname(eventPath(sessionId)), { recursive: true, mode: 0o700 });
      await fsImpl.appendFile(eventPath(sessionId), `${JSON.stringify(event)}\n`, { mode: 0o600 });
      session.lastOutputSeq = Math.max(Number(session.lastOutputSeq) || 0, Number(event.outputSeq) || 0);
      session.updatedAt = event.at || iso(clock);
      if (event.type === "session.created") {
        session.state = "attached";
        session.pid = event.pid || null;
        session.terminalMode = event.terminalMode || session.terminalMode;
        session.cwd = event.cwd || session.cwd;
      } else if (event.type === "session.detached") session.state = "detached";
      else if (event.type === "session.resumed") session.state = event.state === "exited" ? "exited" : "attached";
      else if (event.type === "session.exited") {
        session.state = "exited";
        session.exitCode = event.exitCode;
        session.signal = event.signal || null;
        session.endedAt = event.at;
      } else if (event.type === "session.error" && session.state === "opening") {
        session.state = "failed";
        session.error = { code: event.code, message: event.message };
      } else if (event.type === "session.gap") {
        session.gaps = [...(session.gaps || []), { requestedAfter: event.requestedAfter, earliestAvailable: event.earliestAvailable, latest: event.latest, at: event.at }];
      }
      await persist();
    });
    if (event.caseId || session.caseId) {
      const caseId = event.caseId || session.caseId;
      if (store.getCase(caseId)) await store.appendCaseEvent(caseId, { ...clone(event), type: `interactive.${event.type}` }).catch(() => {});
    }
    const waiter = event.requestId ? pending.get(event.requestId) : null;
    if (waiter) {
      pending.delete(event.requestId);
      if (event.type === "session.error") waiter.reject(sessionError(event.message || "Interactive request failed.", event.code, event));
      else waiter.resolve(clone(event));
    }
    return event;
  }

  async function handleAgentMessage(agentId, message) {
    if (message.type === "agent.session.event") {
      const event = { ...clone(message.event || {}), agentId: String(agentId) };
      await appendEvent(event);
      return true;
    }
    const connectionId = String(message.connectionId || "");
    if (String(message.type || "").startsWith("agent.tunnel.")) {
      const connection = localConnections.get(connectionId);
      if (message.type === "agent.tunnel.opened") connection?.resume();
      else if (message.type === "agent.tunnel.data") connection?.write(decodeBytes(message));
      else if (message.type === "agent.tunnel.error") connection?.destroy(sessionError(message.error?.message || "Tunnel failed.", message.error?.code));
      else if (message.type === "agent.tunnel.close") connection?.end();
      return true;
    }
    return false;
  }

  async function openSession(input = {}) {
    const agentId = validId(input.agentId, "agent id");
    requireOnline(agentId);
    const id = validId(input.id || generateRecoveryId("wwterm", { clock }));
    const requestId = generateRecoveryId("wwreq", { clock });
    const record = {
      id,
      agentId,
      caseId: String(input.caseId || ""),
      title: String(input.title || input.shell || "Terminal"),
      state: "opening",
      cwd: String(input.cwd || ""),
      env: clone(input.env || {}),
      rows: Math.max(1, Number(input.rows) || 24),
      cols: Math.max(1, Number(input.cols) || 80),
      terminalMode: "negotiating",
      lastOutputSeq: 0,
      lastEventSeq: 0,
      gaps: [],
      createdAt: iso(clock),
      updatedAt: iso(clock),
    };
    await mutate(async () => { state.sessions[id] = record; await persist(); });
    const waiting = waitFor(requestId, input.timeoutMs);
    send(agentId, { type: "controller.session.open", requestId, session: { ...clone(input), ...clone(record), id } });
    await waiting;
    return clone(state.sessions[id]);
  }

  function getSession(sessionId) {
    const record = state.sessions[validId(sessionId)];
    return record ? clone(record) : null;
  }

  function requireSession(sessionId) {
    const record = state.sessions[validId(sessionId)];
    if (!record) throw sessionError(`Interactive session ${sessionId} was not found.`, RECOVERY_ERROR_CODES.NOT_FOUND);
    return record;
  }

  async function requestSession(sessionId, suffix, payload = {}, { wait = true, timeoutMs } = {}) {
    const session = requireSession(sessionId);
    const requestId = generateRecoveryId("wwreq", { clock });
    const waiting = wait ? waitFor(requestId, timeoutMs) : null;
    send(session.agentId, { type: `controller.session.${suffix}`, requestId, sessionId: session.id, ...clone(payload) });
    return waiting || { accepted: true, requestId };
  }

  async function input(sessionId, data, encoding = "utf8") {
    const payload = Buffer.isBuffer(data) ? encodeBytes(data) : { data: String(data ?? ""), encoding };
    return requestSession(sessionId, "input", payload);
  }

  async function resize(sessionId, rows, cols) {
    const session = requireSession(sessionId);
    session.rows = Math.max(1, Number(rows) || session.rows);
    session.cols = Math.max(1, Number(cols) || session.cols);
    const result = await requestSession(sessionId, "resize", { rows: session.rows, cols: session.cols });
    await persist();
    return result;
  }

  async function signal(sessionId, signalName = "SIGINT") {
    return requestSession(sessionId, "signal", { signal: String(signalName) });
  }

  async function detach(sessionId) {
    const session = requireSession(sessionId);
    session.state = "detached";
    await persist();
    return requestSession(sessionId, "detach", {});
  }

  async function reconnect(sessionId, { afterSeq } = {}) {
    const session = requireSession(sessionId);
    const event = await requestSession(sessionId, "resume", { afterSeq: Number(afterSeq ?? session.lastOutputSeq) || 0 }, { timeoutMs: 30_000 });
    return { session: getSession(sessionId), event };
  }

  async function terminate(sessionId) {
    return requestSession(sessionId, "terminate", {});
  }

  async function putFile(sessionId, remotePath, value, { mode = 0o600 } = {}) {
    const encoded = encodeBytes(value);
    return requestSession(sessionId, "file.put", { path: String(remotePath), mode, ...encoded }, { timeoutMs: 120_000 });
  }

  async function getFile(sessionId, remotePath) {
    const event = await requestSession(sessionId, "file.get", { path: String(remotePath) }, { timeoutMs: 120_000 });
    return { ...event, buffer: decodeBytes(event) };
  }

  async function readEvents(sessionId, afterSeq = 0) {
    requireSession(sessionId);
    let raw = "";
    try { raw = await fsImpl.readFile(eventPath(sessionId), "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    let legacySeq = 0;
    return raw.split("\n").filter(Boolean).map((line) => {
      const event = JSON.parse(line);
      legacySeq += 1;
      if (!Number(event.eventSeq)) event.eventSeq = legacySeq;
      return event;
    }).filter((event) => Number(event.eventSeq) > Number(afterSeq || 0));
  }

  async function reconnectAgent(agentId) {
    const results = [];
    for (const session of Object.values(state.sessions).filter((record) => record.agentId === agentId && ACTIVE_SESSION_STATES.has(record.state))) {
      results.push(await reconnect(session.id).catch((error) => ({ sessionId: session.id, error: { code: error.code, message: error.message } })));
    }
    return results;
  }

  async function listenServer(server, host, port) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolve(); });
    });
    return server.address();
  }

  async function startTunnelServer(record, { restoring = false } = {}) {
    requireOnline(record.agentId);
    const server = net.createServer((socket) => {
      const connectionId = generateRecoveryId("wwtc", { clock });
      localConnections.set(connectionId, socket);
      socket.pause();
      send(record.agentId, {
        type: "controller.tunnel.open",
        tunnelId: record.id,
        connectionId,
        targetHost: record.targetHost,
        targetPort: record.targetPort,
      });
      socket.on("data", (chunk) => send(record.agentId, { type: "controller.tunnel.data", tunnelId: record.id, connectionId, ...encodeBytes(chunk) }));
      socket.once("close", () => {
        localConnections.delete(connectionId);
        try { send(record.agentId, { type: "controller.tunnel.close", tunnelId: record.id, connectionId }); } catch {}
      });
      socket.on("error", () => {});
    });
    const address = await listenServer(server, record.listenHost, restoring ? record.listenPort : Number(record.listenPort) || 0);
    record.listenPort = address.port;
    record.state = "open";
    record.updatedAt = iso(clock);
    tunnelServers.set(record.id, server);
    return record;
  }

  async function openTunnel(input = {}) {
    const agentId = validId(input.agentId, "agent id");
    const id = validId(input.id || generateRecoveryId("wwtun", { clock }), "tunnel id");
    const targetPort = Number(input.targetPort);
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new TypeError("Tunnel targetPort must be 1-65535.");
    const record = {
      id,
      agentId,
      targetHost: String(input.targetHost || "127.0.0.1"),
      targetPort,
      listenHost: String(input.listenHost || "127.0.0.1"),
      listenPort: Number(input.listenPort) || 0,
      state: "opening",
      createdAt: iso(clock),
      updatedAt: iso(clock),
    };
    await startTunnelServer(record);
    state.tunnels[id] = record;
    await persist();
    return clone(record);
  }

  async function closeTunnel(tunnelId) {
    const id = validId(tunnelId, "tunnel id");
    const record = state.tunnels[id];
    if (!record) throw sessionError(`Tunnel ${id} was not found.`, RECOVERY_ERROR_CODES.NOT_FOUND);
    const server = tunnelServers.get(id);
    if (server) await new Promise((resolve) => server.close(resolve));
    tunnelServers.delete(id);
    record.state = "closed";
    record.updatedAt = iso(clock);
    await persist();
    return clone(record);
  }

  async function close() {
    for (const waiter of pending.values()) waiter.reject(sessionError("Interactive controller stopped.", RECOVERY_ERROR_CODES.INTERRUPTED));
    pending.clear();
    for (const socket of localConnections.values()) socket.destroy();
    localConnections.clear();
    await Promise.all([...tunnelServers.values()].map((server) => new Promise((resolve) => server.close(resolve))));
    tunnelServers.clear();
    await mutationTail.catch(() => {});
    await persist();
  }

  const api = {
    init,
    close,
    handleAgentMessage,
    reconnectAgent,
    openSession,
    listSessions: (filters = {}) => Object.values(state.sessions).filter((record) => !filters.agentId || record.agentId === filters.agentId).map(clone),
    getSession,
    readEvents,
    input,
    resize,
    signal,
    detach,
    reconnect,
    terminate,
    putFile,
    getFile,
    openTunnel,
    closeTunnel,
    listTunnels: () => Object.values(state.tunnels).map(clone),
  };
  return api;
}

export { decodeBytes, encodeBytes, shellQuote };
