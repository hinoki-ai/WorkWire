import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeOutputChunk } from "./ww-recovery-protocol.mjs";
import { loadRecoveryConfig, normalizeRecoveryConfig } from "./ww-recovery-config.mjs";
import { createRecoveryController } from "./ww-recovery-controller.mjs";
import { createRecoveryClient } from "./ww-recovery-client.mjs";
import { createRecoveryAgent, resolveRecoveryAgentOptions } from "./ww-recovery-agent.mjs";

const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "canceled", "interrupted", "abandoned"]);
const TERMINAL_FLEET_STATES = new Set(["succeeded", "partial", "failed", "canceled"]);
const BOOLEAN_FLAGS = new Set([
  "json", "online", "refresh", "raw", "force", "autonomous", "events", "foreground",
  "stdin", "wait", "reuse-rootfs", "all", "help", "detach", "override-limit", "launch",
]);

export const WW_RECOVERY_HELP_TEXT = `Usage:
  ww recovery controller start [--host H] [--port P] [--foreground]
  ww recovery controller status [--json]
  ww recovery controller stop
  ww recovery agent run --controller URL [--id ID] [--name NAME] [--mode installed|pxe]
  ww recovery agent install --controller URL [--token TOKEN]
  ww recovery agent status | uninstall
  ww recovery agents [--online] [--json]
  ww recovery inspect AGENT [--refresh] [--raw] [--json]
  ww recovery wait AGENT [--timeout MS]
  ww recovery case create AGENT --goal TEXT [--autonomous] [--json]
  ww recovery case list [--agent AGENT] [--json]
  ww recovery case show CASE [--events] [--json]
  ww recovery case run CASE | stop CASE | follow CASE
  ww recovery exec AGENT [--timeout MS] [--force] -- COMMAND ARG...
  ww recovery shell AGENT [--timeout MS] [--force] -- SCRIPT
  ww recovery shell AGENT --file SCRIPT_FILE | --stdin
  ww recovery cancel JOB | retry JOB | follow JOB
  ww recovery put AGENT LOCAL_PATH REMOTE_PATH
  ww recovery get AGENT REMOTE_PATH LOCAL_PATH
  ww recovery artifacts CASE [--json]
  ww recovery wake MAC [--broadcast ADDRESS] [--port 9]
  ww recovery pxe install|prepare|start|status|stop [--interface IFACE]
  ww recovery pxe arm|local MAC
  ww recovery image build|verify
  ww recovery playbook list | show ID | run ID AGENT --inputs JSON
  ww recovery group list | save --id ID --targets A,B [--query EXPR] | delete ID
  ww recovery query list | save --id ID --expression EXPR
  ww recovery schedule list | save --spec JSON | delete ID
  ww recovery health-rule list | save --spec JSON | delete ID
  ww recovery fleet run [--targets A,B|--group ID|--query-id ID|--query EXPR|--all] [--rollout MODE] [--concurrency N] -- COMMAND ARG...
  ww recovery fleet follow RUN | summary RUN | retry-failed RUN
  ww recovery session open AGENT [--cwd PATH] [--detach] | attach ID | list | terminate ID
  ww recovery tunnel open AGENT HOST PORT [--listen-port PORT] | list | close ID
  ww recovery console discover | open PROTOCOL TARGET [--adapter ID]
  ww recovery console open custom -- TRANSPORT ARG...
`;

export function parseRecoveryArgv(argv = []) {
  const args = [...argv];
  const separator = args.indexOf("--");
  const before = separator === -1 ? args : args.slice(0, separator);
  const passthrough = separator === -1 ? [] : args.slice(separator + 1);
  const command = String(before.shift() || "help");
  const subcommands = new Set(["controller", "agent", "case", "pxe", "image", "playbook", "group", "query", "schedule", "health-rule", "fleet", "session", "tunnel", "console"]);
  const subcommand = subcommands.has(command) ? String(before.shift() || "") : "";
  const flags = {};
  const positionals = [];
  while (before.length > 0) {
    const token = before.shift();
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equalIndex = token.indexOf("=");
    if (equalIndex !== -1) {
      flags[token.slice(2, equalIndex)] = token.slice(equalIndex + 1);
      continue;
    }
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key) || !before[0] || before[0].startsWith("--")) flags[key] = true;
    else flags[key] = before.shift();
  }
  return { command, subcommand, flags, positionals, passthrough };
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : fallback;
}

function outputJson(stdout, value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function outputResult(stdout, value, json, human) {
  if (json) outputJson(stdout, value);
  else if (human) stdout.write(`${human}\n`);
  return value;
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let amount = bytes;
  let index = -1;
  do { amount /= 1024; index += 1; } while (amount >= 1024 && index < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[index]}`;
}

function printInventory(stdout, agent, inventory) {
  stdout.write(`${agent.hostname || agent.agentId} (${agent.agentId}) ${agent.state || "unknown"}\n`);
  stdout.write("DEVICE                         SIZE       TYPE   FILESYSTEM  MOUNT\n");
  for (const device of inventory?.block?.devices || []) {
    stdout.write(`${String(device.canonicalPath || device.path || "").padEnd(30)} ${formatBytes(device.size).padEnd(10)} ${String(device.type || "").padEnd(6)} ${String(device.filesystemType || "-").padEnd(11)} ${(device.mountpoints || []).join(",") || "-"}\n`);
    stdout.write(`  id ${device.deviceId || "unavailable"}${device.model || device.serial ? ` · ${device.model || ""} ${device.serial || ""}`.trimEnd() : ""}\n`);
  }
  const warnings = [
    ...(inventory?.health?.smart || []).filter((item) => item.passed === false || item.pendingSectors || item.uncorrectableSectors),
    ...(inventory?.health?.nvme || []).filter((item) => item.criticalWarning || item.mediaErrors),
  ];
  if (warnings.length) stdout.write(`Health warnings: ${JSON.stringify(warnings)}\n`);
  if (inventory?.errors?.length) stdout.write(`Inventory gaps: ${inventory.errors.length}\n`);
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function defaultControllerUrl(config, env = process.env) {
  return String(env.WW_RECOVERY_CONTROLLER_URL || `http://127.0.0.1:${config.port}`);
}

async function waitForAgent(client, agentId, timeoutMs) {
  const started = Date.now();
  while (timeoutMs === 0 || Date.now() - started < timeoutMs) {
    const agent = (await client.listAgents()).find((candidate) => candidate.agentId === agentId);
    if (agent?.state === "online" && agent.connected !== false) return agent;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const error = new Error(`Timed out waiting for recovery agent ${agentId}.`);
  error.code = "ERR_WW_RECOVERY_TIMEOUT";
  throw error;
}

async function followJob(client, jobId, {
  stdout,
  stderr,
  json = false,
  streamOutput = true,
  pollMs = 100,
  signal,
  processImpl = process,
} = {}) {
  let after = 0;
  const emitted = new Set();
  while (true) {
    if (signal?.aborted) {
      await client.cancelJob(jobId).catch(() => {});
      processImpl.exitCode = 130;
      throw signal.reason || new Error("Interrupted.");
    }
    const payload = await client.getJob(jobId, { after });
    for (const event of payload.events || []) {
      if (emitted.has(event.seq)) continue;
      emitted.add(event.seq);
      after = Math.max(after, Number(event.seq) || 0);
      if (json) outputJson(stdout, event);
      else if (event.type === "step.output" && streamOutput) {
        const destination = event.stream === "stderr" ? stderr : stdout;
        destination.write(decodeOutputChunk(event));
      } else if (["step.started", "step.failed", "job.failed", "job.interrupted"].includes(event.type)) {
        stderr.write(`[${event.type}] ${event.stepId || event.reason || ""}\n`);
      }
    }
    if (TERMINAL_JOB_STATES.has(payload.job.state)) {
      const remoteExitCode = payload.job.result?.steps?.at(-1)?.result?.exitCode
        ?? payload.job.result?.steps?.at(-1)?.result?.result?.exitCode
        ?? payload.job.result?.exitCode;
      if (payload.job.state === "succeeded") processImpl.exitCode = 0;
      else if (Number.isInteger(remoteExitCode) && remoteExitCode > 0 && remoteExitCode <= 125) processImpl.exitCode = remoteExitCode;
      else processImpl.exitCode = 5;
      return payload.job;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function followFleetRun(client, runId, { stdout, stderr, json = false, pollMs = 100, processImpl = process } = {}) {
  while (true) {
    const run = await client.getFleetRun(runId);
    if (TERMINAL_FLEET_STATES.has(run.state)) {
      const summary = await client.getFleetSummary(runId);
      if (json) outputJson(stdout, { ok: run.state === "succeeded", run, summary });
      else {
        for (const target of summary.targets) {
          stdout.write(`${String(target.state).toUpperCase().padEnd(9)} ${target.hostname || target.agentId} attempt ${target.attempt}\n`);
          for (const event of target.stdout || []) stdout.write(decodeOutputChunk(event));
          for (const event of target.stderr || []) stderr.write(decodeOutputChunk(event));
        }
        stdout.write(`Fleet run ${run.id}: ${run.state}${run.stopReason ? ` (${run.stopReason})` : ""}\n`);
      }
      processImpl.exitCode = run.state === "succeeded" ? 0 : 5;
      return { run, summary };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function followSession(client, sessionId, { stdin, stdout, stderr, processImpl = process, pollMs = 50 } = {}) {
  let after = 0;
  const onInput = (chunk) => void client.sessionInput(sessionId, chunk).catch((error) => stderr.write(`${error.message}\n`));
  stdin?.on?.("data", onInput);
  try {
    while (true) {
      const events = await client.listSessionEvents(sessionId, { after });
      for (const event of events) {
        after = Math.max(after, Number(event.eventSeq) || 0);
        if (event.type === "session.output") (event.stream === "stderr" ? stderr : stdout).write(decodeOutputChunk(event));
      }
      const session = await client.getSession(sessionId);
      if (["exited", "failed", "lost"].includes(session.state)) {
        processImpl.exitCode = Number.isInteger(session.exitCode) ? session.exitCode : session.state === "exited" ? 0 : 5;
        return session;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    stdin?.off?.("data", onInput);
  }
}

async function runInstallerScript(scriptName, args, { baseDir, spawnImpl, stdout, stderr }) {
  const filename = path.join(baseDir, "scripts", scriptName);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(filename, args, { stdio: ["inherit", "pipe", "pipe"] });
    child.stdout?.pipe(stdout);
    child.stderr?.pipe(stderr);
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ ok: true, exitCode: 0 }) : reject(Object.assign(new Error(`${scriptName} exited ${code}.`), { exitCode: code })));
  });
}

export async function runRecoveryCli({
  argv = [],
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  env = process.env,
  processImpl = process,
  fsImpl = fs,
  spawnImpl = spawn,
  loadConfigImpl = loadRecoveryConfig,
  createClientImpl = createRecoveryClient,
  createControllerImpl = createRecoveryController,
  createAgentImpl = createRecoveryAgent,
  resolveAgentOptionsImpl = resolveRecoveryAgentOptions,
  baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
  keepAlive = true,
} = {}) {
  const parsed = parseRecoveryArgv(argv);
  if (parsed.command === "help" || parsed.flags.help) {
    stdout.write(WW_RECOVERY_HELP_TEXT);
    return { ok: true };
  }
  const config = await loadConfigImpl();
  const controllerUrl = String(parsed.flags.controller || defaultControllerUrl(config, env));
  const client = createClientImpl({ url: controllerUrl, token: parsed.flags.token ?? config.token });
  const json = parsed.flags.json === true;

  if (parsed.command === "controller") {
    if (parsed.subcommand === "start") {
      const activeConfig = normalizeRecoveryConfig({
        ...config,
        host: parsed.flags.host || config.host,
        port: parsed.flags.port === undefined ? config.port : number(parsed.flags.port, config.port),
        bootHost: parsed.flags["boot-host"] || config.bootHost,
        bootPort: parsed.flags["boot-port"] === undefined ? config.bootPort : number(parsed.flags["boot-port"], config.bootPort),
      }, config, { env: {} });
      const controller = createControllerImpl({ config: activeConfig, log: (message) => stderr.write(`${message}\n`) });
      const info = await controller.start();
      await fsImpl.mkdir(activeConfig.stateDir, { recursive: true });
      await fsImpl.writeFile(path.join(activeConfig.stateDir, "controller.pid"), `${processImpl.pid || process.pid}\n`, { mode: 0o600 });
      outputResult(stdout, { ok: true, controller: info }, json, `Recovery controller listening at ${info.url} (boot ${info.boot.url})`);
      const shutdown = async () => {
        await controller.stop();
        await fsImpl.rm(path.join(activeConfig.stateDir, "controller.pid"), { force: true });
      };
      if (!keepAlive) return { controller, info, shutdown };
      processImpl.once?.("SIGINT", async () => { await shutdown(); processImpl.exit?.(0); });
      processImpl.once?.("SIGTERM", async () => { await shutdown(); processImpl.exit?.(0); });
      return new Promise(() => {});
    }
    if (parsed.subcommand === "status") {
      const info = await client.getInfo();
      return outputResult(stdout, { ok: true, controller: info }, json, `Recovery controller ONLINE at ${info.url}; ${info.agentsOnline} agent(s)`);
    }
    if (parsed.subcommand === "stop") {
      const pidPath = path.join(config.stateDir, "controller.pid");
      const pid = Number(String(await fsImpl.readFile(pidPath, "utf8")).trim());
      if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Invalid recovery controller PID in ${pidPath}.`);
      process.kill(pid, "SIGTERM");
      return outputResult(stdout, { ok: true, pid }, json, `Stopping recovery controller PID ${pid}`);
    }
  }

  if (parsed.command === "agent") {
    if (parsed.subcommand === "run") {
      const options = await resolveAgentOptionsImpl({
        cli: {
          controller: parsed.flags.controller,
          token: parsed.flags.token,
          id: parsed.flags.id,
          name: parsed.flags.name,
          mode: parsed.flags.mode,
          stateDir: parsed.flags["state-dir"],
        },
        env,
        fsImpl,
      });
      if (!options.controllerUrl) throw new Error("Recovery agent --controller URL is required.");
      const agent = createAgentImpl(options);
      if (!keepAlive) return { agent, connection: await agent.start() };
      processImpl.once?.("SIGINT", async () => { await agent.stop("signal"); processImpl.exit?.(0); });
      processImpl.once?.("SIGTERM", async () => { await agent.stop("signal"); processImpl.exit?.(0); });
      return agent.run();
    }
    if (parsed.subcommand === "install") {
      return runInstallerScript("install-ww-recovery-agent.sh", ["install", "--controller", String(parsed.flags.controller || ""), ...(parsed.flags.token !== undefined ? ["--token", String(parsed.flags.token)] : [])], { baseDir, spawnImpl, stdout, stderr });
    }
    if (["status", "uninstall"].includes(parsed.subcommand)) {
      return runInstallerScript("install-ww-recovery-agent.sh", [parsed.subcommand], { baseDir, spawnImpl, stdout, stderr });
    }
  }

  if (parsed.command === "group") {
    if (parsed.subcommand === "list") {
      const groups = await client.listFleetGroups();
      if (json) outputJson(stdout, { ok: true, groups });
      else for (const group of groups) stdout.write(`${group.id}\t${group.name}\t${(group.targetIds || []).join(",")}${group.query ? `\t${typeof group.query === "string" ? group.query : JSON.stringify(group.query)}` : ""}\n`);
      return groups;
    }
    if (parsed.subcommand === "save") {
      const group = await client.saveFleetGroup({
        id: parsed.flags.id,
        name: parsed.flags.name,
        targetIds: String(parsed.flags.targets || "").split(",").map((value) => value.trim()).filter(Boolean),
        query: parsed.flags.query || "",
      });
      return outputResult(stdout, { ok: true, group }, json, `${group.id}: ${group.name}`);
    }
    if (parsed.subcommand === "delete") {
      const id = String(parsed.positionals[0] || "");
      if (!id) throw new Error("Recovery group delete requires ID.");
      const result = await client.deleteFleetGroup(id);
      return outputResult(stdout, result, json, `${id}: deleted`);
    }
  }

  if (parsed.command === "query") {
    if (parsed.subcommand === "list") {
      const queries = await client.listFleetQueries();
      if (json) outputJson(stdout, { ok: true, queries });
      else for (const query of queries) stdout.write(`${query.id}\t${query.name}\t${typeof query.expression === "string" ? query.expression : JSON.stringify(query.expression)}\n`);
      return queries;
    }
    if (parsed.subcommand === "save") {
      const query = await client.saveFleetQuery({ id: parsed.flags.id, name: parsed.flags.name, expression: parsed.flags.expression || parsed.flags.query || "*" });
      return outputResult(stdout, { ok: true, query }, json, `${query.id}: ${query.expression}`);
    }
  }

  if (parsed.command === "schedule") {
    if (parsed.subcommand === "list") {
      const schedules = await client.listFleetSchedules();
      if (json) outputJson(stdout, { ok: true, schedules });
      else for (const schedule of schedules) stdout.write(`${schedule.enabled ? "ENABLED " : "DISABLED"} ${schedule.id} ${schedule.nextRunAt || "-"} ${schedule.name}\n`);
      return schedules;
    }
    if (parsed.subcommand === "save") {
      if (!parsed.flags.spec) throw new Error("Recovery schedule save requires --spec JSON.");
      const schedule = await client.saveFleetSchedule(JSON.parse(String(parsed.flags.spec)));
      return outputResult(stdout, { ok: true, schedule }, json, `${schedule.id}: next ${schedule.nextRunAt || "disabled"}`);
    }
    if (parsed.subcommand === "delete") {
      const id = String(parsed.positionals[0] || "");
      if (!id) throw new Error("Recovery schedule delete requires ID.");
      const result = await client.deleteFleetSchedule(id);
      return outputResult(stdout, result, json, `${id}: deleted`);
    }
  }

  if (parsed.command === "health-rule") {
    if (parsed.subcommand === "list") {
      const result = await client.listFleetHealthRules();
      if (json) outputJson(stdout, { ok: true, ...result });
      else for (const rule of result.rules) stdout.write(`${rule.enabled ? "ENABLED " : "DISABLED"} ${rule.id} ${rule.mode} ${rule.recommendation} ${rule.name}\n`);
      return result;
    }
    if (parsed.subcommand === "save") {
      if (!parsed.flags.spec) throw new Error("Recovery health-rule save requires --spec JSON.");
      const rule = await client.saveFleetHealthRule(JSON.parse(String(parsed.flags.spec)));
      return outputResult(stdout, { ok: true, rule }, json, `${rule.id}: ${rule.mode} ${rule.recommendation}`);
    }
    if (parsed.subcommand === "delete") {
      const id = String(parsed.positionals[0] || "");
      if (!id) throw new Error("Recovery health-rule delete requires ID.");
      const result = await client.deleteFleetHealthRule(id);
      return outputResult(stdout, result, json, `${id}: deleted`);
    }
  }

  if (parsed.command === "fleet") {
    const runId = String(parsed.positionals[0] || "");
    if (parsed.subcommand === "follow") {
      if (!runId) throw new Error("Recovery fleet follow requires RUN.");
      return followFleetRun(client, runId, { stdout, stderr, json, processImpl });
    }
    if (parsed.subcommand === "summary") {
      if (!runId) throw new Error("Recovery fleet summary requires RUN.");
      const summary = await client.getFleetSummary(runId);
      if (json) outputJson(stdout, { ok: true, summary });
      else for (const target of summary.targets) stdout.write(`${String(target.state).toUpperCase().padEnd(9)} ${target.hostname || target.agentId} attempt ${target.attempt} ${target.error?.message || ""}\n`);
      return summary;
    }
    if (parsed.subcommand === "retry-failed") {
      if (!runId) throw new Error("Recovery fleet retry-failed requires RUN.");
      const run = await client.retryFleetFailed(runId, { rollout: { mode: parsed.flags.rollout || "bounded", concurrency: number(parsed.flags.concurrency, 4) } });
      if (parsed.flags.wait) return followFleetRun(client, run.id, { stdout, stderr, json, processImpl });
      return outputResult(stdout, { ok: true, run }, json, `${run.id}: retry queued`);
    }
    if (parsed.subcommand === "run") {
      let operation;
      if (parsed.flags.operation) operation = JSON.parse(String(parsed.flags.operation));
      else if (parsed.flags.script !== undefined) operation = { type: "shell", script: String(parsed.flags.script), force: parsed.flags.force === true, timeoutMs: number(parsed.flags.timeout, 120_000) };
      else {
        if (parsed.passthrough.length === 0) throw new Error("Recovery fleet run requires -- COMMAND ARG... or --operation JSON.");
        operation = { type: "command", argv: parsed.passthrough, force: parsed.flags.force === true, timeoutMs: number(parsed.flags.timeout, 120_000) };
      }
      const run = await client.executeFleet({
        targetIds: String(parsed.flags.targets || "").split(",").map((value) => value.trim()).filter(Boolean),
        groupId: parsed.flags.group,
        queryId: parsed.flags["query-id"],
        query: parsed.flags.query,
        all: parsed.flags.all === true,
        operation,
        rollout: {
          mode: parsed.flags.rollout || "bounded",
          concurrency: number(parsed.flags.concurrency, 4),
          canaryCount: number(parsed.flags.canary, 1),
          stop: parsed.flags["stop-on-failure"] ? { onAnyFailure: true } : {},
        },
      });
      if (parsed.flags.wait) return followFleetRun(client, run.id, { stdout, stderr, json, processImpl });
      return outputResult(stdout, { ok: true, run }, json, `${run.id}: ${Object.keys(run.targets || {}).length} target(s) queued`);
    }
  }

  if (parsed.command === "session") {
    if (parsed.subcommand === "list") {
      const sessions = await client.listSessions({ agentId: parsed.flags.agent || "" });
      if (json) outputJson(stdout, { ok: true, sessions });
      else for (const session of sessions) stdout.write(`${String(session.state).toUpperCase().padEnd(9)} ${session.id} ${session.agentId} ${session.cwd || ""}\n`);
      return sessions;
    }
    if (parsed.subcommand === "open") {
      const agentId = String(parsed.positionals[0] || "");
      if (!agentId) throw new Error("Recovery session open requires AGENT.");
      const session = await client.openSession({
        agentId,
        caseId: parsed.flags.case || "",
        cwd: parsed.flags.cwd || "",
        rows: number(parsed.flags.rows, processImpl.stdout?.rows || 24),
        cols: number(parsed.flags.cols, processImpl.stdout?.columns || 80),
        argv: parsed.passthrough.length ? parsed.passthrough : undefined,
        shell: parsed.flags.shell,
        overrideLimit: parsed.flags["override-limit"] === true,
      });
      if (json) outputJson(stdout, { ok: true, session });
      else stderr.write(`Interactive session ${session.id} (${session.terminalMode})\n`);
      if (parsed.flags.detach || !keepAlive) return session;
      return followSession(client, session.id, { stdin, stdout, stderr, processImpl });
    }
    const sessionId = String(parsed.positionals[0] || "");
    if (!sessionId) throw new Error(`Recovery session ${parsed.subcommand} requires ID.`);
    if (parsed.subcommand === "attach") {
      await client.reconnectSession(sessionId);
      return keepAlive ? followSession(client, sessionId, { stdin, stdout, stderr, processImpl }) : client.getSession(sessionId);
    }
    if (parsed.subcommand === "detach") return outputResult(stdout, await client.detachSession(sessionId), json, `${sessionId}: detached`);
    if (parsed.subcommand === "terminate") return outputResult(stdout, await client.terminateSession(sessionId), json, `${sessionId}: terminating`);
    if (parsed.subcommand === "signal") return outputResult(stdout, await client.sessionSignal(sessionId, parsed.flags.signal || parsed.positionals[1] || "SIGINT"), json, `${sessionId}: signal sent`);
    if (parsed.subcommand === "resize") return outputResult(stdout, await client.sessionResize(sessionId, number(parsed.flags.rows, 24), number(parsed.flags.cols, 80)), json, `${sessionId}: resized`);
  }

  if (parsed.command === "tunnel") {
    if (parsed.subcommand === "list") {
      const tunnels = await client.listTunnels();
      if (json) outputJson(stdout, { ok: true, tunnels });
      else for (const tunnel of tunnels) stdout.write(`${String(tunnel.state).toUpperCase().padEnd(7)} ${tunnel.id} 127.0.0.1:${tunnel.listenPort} -> ${tunnel.agentId}:${tunnel.targetHost}:${tunnel.targetPort}\n`);
      return tunnels;
    }
    if (parsed.subcommand === "open") {
      const [agentId, targetHost, targetPort] = parsed.positionals;
      if (!agentId || !targetHost || !targetPort) throw new Error("Recovery tunnel open requires AGENT HOST PORT.");
      const tunnel = await client.openTunnel({ agentId, targetHost, targetPort: number(targetPort), listenHost: parsed.flags["listen-host"] || "127.0.0.1", listenPort: number(parsed.flags["listen-port"], 0) });
      return outputResult(stdout, { ok: true, tunnel }, json, `${tunnel.id}: ${tunnel.listenHost}:${tunnel.listenPort} -> ${targetHost}:${targetPort}`);
    }
    if (parsed.subcommand === "close") {
      const id = String(parsed.positionals[0] || "");
      if (!id) throw new Error("Recovery tunnel close requires ID.");
      const tunnel = await client.closeTunnel(id);
      return outputResult(stdout, { ok: true, tunnel }, json, `${id}: closed`);
    }
  }

  if (parsed.command === "console") {
    if (parsed.subcommand === "discover") {
      const adapters = await client.discoverConsoles();
      if (json) outputJson(stdout, { ok: true, adapters });
      else for (const adapter of adapters) stdout.write(`${adapter.available ? "READY  " : "MISSING"} ${adapter.protocol.padEnd(8)} ${adapter.id} ${adapter.tool || adapter.unavailableReason}\n`);
      return adapters;
    }
    if (parsed.subcommand === "open") {
      const [protocol, target] = parsed.positionals;
      if (!protocol || (String(protocol).toLowerCase() !== "custom" && !target)) throw new Error("Recovery console open requires PROTOCOL TARGET, or custom -- TRANSPORT ARG....");
      if (String(protocol).toLowerCase() === "custom" && parsed.passthrough.length === 0) throw new Error("Recovery custom console requires exact transport argv after --.");
      const input = String(protocol).toLowerCase() === "custom"
        ? { protocol: "custom", transportArgv: parsed.passthrough }
        : { protocol, target, adapterId: parsed.flags.adapter, user: parsed.flags.user, port: parsed.flags.port, extraArgs: parsed.passthrough };
      const result = parsed.flags.launch === false ? await client.resolveConsole(input) : await client.launchConsole(input);
      return outputResult(stdout, { ok: result.available, console: result }, json, result.available ? `${result.id}: ${JSON.stringify(result.argv)}` : result.unavailableReason);
    }
  }

  if (parsed.command === "agents") {
    const agents = await client.listAgents({ online: parsed.flags.online === true });
    if (json) outputJson(stdout, { ok: true, agents });
    else {
      for (const agent of agents) stdout.write(`${String(agent.state || "offline").toUpperCase().padEnd(7)} ${String(agent.hostname || agent.agentId).padEnd(24)} ${agent.agentId} ${agent.addresses?.map((item) => item.address).filter(Boolean).join(",") || ""}\n`);
    }
    return agents;
  }

  if (parsed.command === "inspect") {
    const agentId = String(parsed.positionals[0] || "");
    if (!agentId) throw new Error("Recovery inspect requires AGENT.");
    if (parsed.flags.refresh) await client.requestInventory(agentId, { wait: true, timeoutMs: number(parsed.flags.timeout, 120_000) });
    const result = await client.getAgent(agentId);
    if (json || parsed.flags.raw) outputJson(stdout, { ok: true, ...result });
    else printInventory(stdout, result.agent, result.inventory);
    return result;
  }

  if (parsed.command === "wait") {
    const agentId = String(parsed.positionals[0] || "");
    if (!agentId) throw new Error("Recovery wait requires AGENT.");
    const agent = await waitForAgent(client, agentId, number(parsed.flags.timeout, 30_000));
    return outputResult(stdout, { ok: true, agent }, json, `${agent.hostname || agent.agentId} is online`);
  }

  if (parsed.command === "case") {
    if (parsed.subcommand === "create") {
      const agentId = String(parsed.positionals[0] || "");
      const goal = String(parsed.flags.goal || "");
      if (!agentId || !goal) throw new Error("Recovery case create requires AGENT and --goal TEXT.");
      const caseRecord = await client.createCase({
        targetAgentId: agentId,
        goal,
        autonomous: parsed.flags.autonomous === true,
        mode: parsed.flags.autonomous ? "autonomous-unrestricted" : "unrestricted",
      });
      return outputResult(stdout, { ok: true, case: caseRecord }, json, `${caseRecord.id} · ${caseRecord.goal}`);
    }
    if (parsed.subcommand === "list") {
      const cases = await client.listCases({ agentId: parsed.flags.agent || "" });
      if (json) outputJson(stdout, { ok: true, cases });
      else for (const item of cases) stdout.write(`${item.state.padEnd(10)} ${item.id} ${item.targetAgentId} ${item.goal}\n`);
      return cases;
    }
    const caseId = String(parsed.positionals[0] || "");
    if (!caseId) throw new Error(`Recovery case ${parsed.subcommand} requires CASE.`);
    if (parsed.subcommand === "show") {
      const result = await client.getCase(caseId);
      if (parsed.flags.events) result.events = await client.listEvents(caseId);
      if (json) outputJson(stdout, { ok: true, ...result });
      else stdout.write(`${result.case.id}\nState: ${result.case.state}\nTarget: ${result.case.targetAgentId}\nGoal: ${result.case.goal}\nJobs: ${result.jobs.length}\nArtifacts: ${result.artifacts.length}\n`);
      return result;
    }
    if (parsed.subcommand === "run") {
      const result = await client.runCase(caseId);
      return outputResult(stdout, result, json, `Recovery case ${caseId} started`);
    }
    if (parsed.subcommand === "stop") {
      const result = await client.stopCase(caseId);
      return outputResult(stdout, result, json, `Recovery case ${caseId} stopped`);
    }
    if (parsed.subcommand === "follow") {
      const existing = await client.listEvents(caseId);
      for (const event of existing) json ? outputJson(stdout, event) : stdout.write(`[${event.seq}] ${event.type}\n`);
      const subscription = client.subscribeEvents(caseId, {
        after: existing.at(-1)?.seq || 0,
        onEvent(event) { json ? outputJson(stdout, event) : stdout.write(`[${event.seq}] ${event.type}\n`); },
        onError(error) { stderr.write(`${error.message}\n`); },
      });
      return keepAlive ? subscription.done : subscription;
    }
  }

  if (["exec", "shell"].includes(parsed.command)) {
    const agentId = String(parsed.positionals[0] || "");
    if (!agentId) throw new Error(`Recovery ${parsed.command} requires AGENT.`);
    let action;
    let params;
    if (parsed.command === "exec") {
      if (parsed.passthrough.length === 0) throw new Error("Recovery exec requires -- COMMAND ARG...");
      action = "command.exec";
      params = { argv: [...parsed.passthrough] };
      if (!json) stderr.write(`Recovery exec ${agentId}: ${JSON.stringify(parsed.passthrough)}\n`);
    } else {
      action = "shell.exec";
      let script = parsed.passthrough.join(" ");
      if (parsed.flags.file) script = await fsImpl.readFile(path.resolve(String(parsed.flags.file)), "utf8");
      if (parsed.flags.stdin) script = await readAll(stdin);
      if (!script) throw new Error("Recovery shell requires -- SCRIPT, --file, or --stdin.");
      params = { script };
      if (!json) stderr.write(`Recovery shell ${agentId}: ${script.length} bytes\n`);
    }
    const job = await client.createJob({
      targetAgentId: agentId,
      goal: `${parsed.command} on ${agentId}`,
      mode: "unrestricted",
      force: parsed.flags.force === true,
      steps: [{
        id: `${parsed.command}_1`,
        action,
        params,
        timeoutMs: number(parsed.flags.timeout, 120_000),
        force: parsed.flags.force === true,
      }],
    });
    const abortController = new AbortController();
    let interrupted = false;
    const interrupt = () => {
      if (interrupted) processImpl.exit?.(130);
      interrupted = true;
      abortController.abort(new Error("Interrupted."));
    };
    processImpl.once?.("SIGINT", interrupt);
    try {
      const result = await followJob(client, job.id, {
        stdout,
        stderr,
        json: false,
        streamOutput: !json,
        signal: abortController.signal,
        processImpl,
      });
      if (json) outputJson(stdout, { ok: result.state === "succeeded", job: result });
      else stderr.write(`\nRecovery job ${result.id}: ${result.state}\n`);
      return result;
    } finally {
      processImpl.off?.("SIGINT", interrupt);
    }
  }

  if (["cancel", "retry", "follow"].includes(parsed.command)) {
    const jobId = String(parsed.positionals[0] || "");
    if (!jobId) throw new Error(`Recovery ${parsed.command} requires JOB.`);
    if (parsed.command === "cancel") {
      const job = await client.cancelJob(jobId);
      return outputResult(stdout, { ok: true, job }, json, `${job.id}: ${job.state}`);
    }
    if (parsed.command === "retry") {
      const job = await client.retryJob(jobId);
      return outputResult(stdout, { ok: true, job }, json, `${job.id}: queued attempt ${job.attempt + 1}`);
    }
    return followJob(client, jobId, { stdout, stderr, json, processImpl });
  }

  if (parsed.command === "put") {
    const [agentId, localPath, remotePath] = parsed.positionals;
    if (!agentId || !localPath || !remotePath) throw new Error("Recovery put requires AGENT LOCAL_PATH REMOTE_PATH.");
    const artifact = await client.uploadArtifact({ kind: "user-upload", filename: path.basename(localPath) }, path.resolve(localPath));
    const job = await client.createJob({
      targetAgentId: agentId,
      goal: `Put ${localPath} at ${remotePath}`,
      steps: [{ id: "put_1", action: "artifact.download", params: { artifactId: artifact.id, path: remotePath } }],
    });
    const completed = await followJob(client, job.id, { stdout, stderr, json: false, streamOutput: !json, processImpl });
    if (json) outputJson(stdout, { ok: completed.state === "succeeded", job: completed });
    return completed;
  }

  if (parsed.command === "get") {
    const [agentId, remotePath, localPath] = parsed.positionals;
    if (!agentId || !remotePath || !localPath) throw new Error("Recovery get requires AGENT REMOTE_PATH LOCAL_PATH.");
    const job = await client.createJob({
      targetAgentId: agentId,
      goal: `Get ${remotePath}`,
      steps: [{ id: "get_1", action: "artifact.upload", params: { path: remotePath, kind: "user-upload" } }],
    });
    const completed = await followJob(client, job.id, { stdout, stderr, json: false, streamOutput: !json, processImpl });
    const artifact = completed.result?.steps?.[0]?.artifact || completed.result?.steps?.[0]?.result?.artifact;
    if (!artifact?.id) throw new Error("Recovery get job did not return an artifact.");
    const downloaded = await client.downloadArtifact(artifact.id, { destinationPath: path.resolve(localPath) });
    if (json) outputJson(stdout, { ok: true, job: completed, artifact, download: downloaded });
    return downloaded;
  }

  if (parsed.command === "artifacts") {
    const caseId = String(parsed.positionals[0] || "");
    if (!caseId) throw new Error("Recovery artifacts requires CASE.");
    const result = await client.listArtifacts({ caseId });
    if (json) outputJson(stdout, result);
    else for (const artifact of result.artifacts) stdout.write(`${artifact.complete ? "COMPLETE" : "PARTIAL ".trim()} ${artifact.id} ${formatBytes(artifact.size)} ${artifact.kind} ${artifact.filename}\n`);
    return result;
  }

  if (parsed.command === "wake") {
    const mac = String(parsed.positionals[0] || "");
    if (!mac) throw new Error("Recovery wake requires MAC.");
    const result = await client.wake({ mac, broadcast: parsed.flags.broadcast, port: number(parsed.flags.port, 9), burst: number(parsed.flags.burst, 3) });
    return outputResult(stdout, { ok: true, wake: result }, json, result.packetSent ? `Wake packets sent to ${result.mac}; waiting for agent check-in is separate.` : `No Wake packet could be sent to ${result.mac}.`);
  }

  if (parsed.command === "pxe") {
    if (parsed.subcommand === "install") return runInstallerScript("install-ww-recovery-host.sh", ["install", ...(parsed.flags.interface ? ["--interface", String(parsed.flags.interface)] : [])], { baseDir, spawnImpl, stdout, stderr });
    const script = path.join(baseDir, "scripts", "run-ww-pxe.mjs");
    const policyArgs = ["arm", "local"].includes(parsed.subcommand)
      ? [String(parsed.positionals[0] || "")]
      : [];
    if (["arm", "local"].includes(parsed.subcommand) && !policyArgs[0]) {
      throw new Error(`Recovery PXE ${parsed.subcommand} requires MAC.`);
    }
    return new Promise((resolve, reject) => {
      const child = spawnImpl(process.execPath, [script, parsed.subcommand, ...policyArgs, ...(parsed.flags.interface ? ["--interface", String(parsed.flags.interface)] : [])], { stdio: ["inherit", "pipe", "pipe"] });
      child.stdout?.pipe(stdout);
      child.stderr?.pipe(stderr);
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve({ ok: true }) : reject(new Error(`PXE ${parsed.subcommand} exited ${code}.`)));
    });
  }

  if (parsed.command === "image") {
    const script = parsed.subcommand === "build" ? "build-ww-recovery-image.sh" : "verify-ww-recovery-image.sh";
    return runInstallerScript(script, parsed.flags["reuse-rootfs"] ? ["--reuse-rootfs"] : [], { baseDir, spawnImpl, stdout, stderr });
  }

  if (parsed.command === "playbook") {
    const playbooks = await client.listPlaybooks();
    if (parsed.subcommand === "list") {
      if (json) outputJson(stdout, { ok: true, playbooks });
      else for (const playbook of playbooks) stdout.write(`${playbook.id}\t${playbook.title}\n`);
      return playbooks;
    }
    const playbookId = String(parsed.positionals[0] || "");
    const playbook = playbooks.find((candidate) => candidate.id === playbookId);
    if (!playbook) throw new Error(`Recovery playbook ${playbookId || "<missing>"} was not found.`);
    if (parsed.subcommand === "show") return outputResult(stdout, { ok: true, playbook }, json, JSON.stringify(playbook, null, 2));
    if (parsed.subcommand === "run") {
      const agentId = String(parsed.positionals[1] || "");
      if (!agentId) throw new Error("Recovery playbook run requires ID and AGENT.");
      let inputs = {};
      if (parsed.flags.inputs) inputs = JSON.parse(String(parsed.flags.inputs));
      const agent = await client.getAgent(agentId);
      const plan = await client.expandPlaybook(playbookId, {
        inventory: agent.inventory || {},
        inputs,
        force: parsed.flags.force === true,
      });
      if (!json) stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      const caseRecord = await client.createCase({ targetAgentId: agentId, goal: plan.goal, mode: "unrestricted" });
      const job = await client.createJob({
        caseId: caseRecord.id,
        targetAgentId: agentId,
        goal: plan.goal,
        force: parsed.flags.force === true,
        steps: plan.steps,
      });
      const result = await followJob(client, job.id, { stdout, stderr, json: false, streamOutput: !json, processImpl });
      const completed = { case: caseRecord, plan, job: result };
      if (json) outputJson(stdout, { ok: result.state === "succeeded", ...completed });
      return completed;
    }
  }

  stderr.write(`Unknown recovery command.\n${WW_RECOVERY_HELP_TEXT}`);
  processImpl.exitCode = 2;
  return null;
}

export { followJob, printInventory, waitForAgent };
