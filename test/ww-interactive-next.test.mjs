import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRecoveryController } from "../lib/recovery/ww-recovery-controller.mjs";
import { createRecoveryClient } from "../lib/recovery/ww-recovery-client.mjs";
import { createRecoveryAgent } from "../lib/recovery/ww-recovery-agent.mjs";
import { createRecoveryExecutor } from "../lib/recovery/ww-recovery-executor.mjs";
import { createRecoveryActionRegistry } from "../lib/recovery/ww-recovery-actions.mjs";
import { createRecoveryConsoleLauncher } from "../lib/recovery/ww-recovery-console.mjs";
import { createInteractiveAgentRuntime } from "../lib/recovery/ww-recovery-interactive.mjs";
import { runRecoveryCli } from "../lib/recovery/ww-recovery-cli.mjs";

async function waitFor(task, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await task();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for interactive condition.");
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test("interactive Linux terminal proves PTY input, output, resize, signal, detach, reconnect, files, and exit", {
  skip: process.platform === "win32" ? "Linux PTY coverage runs on the Linux host; the Windows adapter has a native fixture below." : false,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-interactive-next-"));
  const controller = createRecoveryController({
    config: { stateDir: path.join(root, "controller"), host: "127.0.0.1", port: 0, bootHost: "127.0.0.1", bootPort: 0, heartbeatMs: 100, staleAfterMs: 500, offlineAfterMs: 1_000 },
  });
  const info = await controller.start();
  const executor = createRecoveryExecutor();
  const inventory = { collect: async ({ identity } = {}) => ({ collectedAt: new Date().toISOString(), agent: identity, system: { platform: "linux" }, block: { devices: [], mounts: [] }, errors: [] }) };
  const agent = createRecoveryAgent({
    controllerUrl: info.localUrl,
    id: "wwra_terminal",
    name: "terminal-fixture",
    stateDir: path.join(root, "agent"),
    installedIdPath: path.join(root, "agent-id"),
    executor,
    inventory,
    registry: createRecoveryActionRegistry({ executor, inventory }),
    reconnectDelays: [25],
  });
  const client = createRecoveryClient({ url: info.localUrl });
  try {
    await agent.start();
    const terminalRoot = path.join(root, "terminal-root");
    await fs.mkdir(terminalRoot);
    const session = await client.openSession({ agentId: "wwra_terminal", cwd: terminalRoot, argv: ["/bin/bash", "--noprofile", "--norc", "-i"], rows: 20, cols: 70 });
    assert.match(session.terminalMode, /pty|pipes/);
    await client.sessionInput(session.id, "printf 'INTERACTIVE_MARKER\\n'; pwd\n");
    const events = await waitFor(async () => {
      const values = await client.listSessionEvents(session.id);
      const combined = values.filter((event) => event.type === "session.output").map((event) => String(event.data)).join("");
      return combined.includes("INTERACTIVE_MARKER") && combined.includes(terminalRoot) ? values : null;
    });
    assert.ok(events.some((event) => event.type === "session.output" && String(event.data).includes(terminalRoot)));
    await client.sessionResize(session.id, 41, 132);
    await client.sessionSignal(session.id, "SIGWINCH");
    await client.detachSession(session.id);
    assert.equal((await client.getSession(session.id)).state, "detached");
    const beforeReconnect = (await client.getSession(session.id)).lastOutputSeq;
    await client.reconnectSession(session.id, { afterSeq: Math.max(0, beforeReconnect - 2) });
    assert.equal((await client.getSession(session.id)).state, "attached");

    await client.putSessionFile(session.id, "from-controller.bin", Buffer.from([0, 1, 2, 255]));
    const downloaded = await client.getSessionFile(session.id, "from-controller.bin");
    assert.deepEqual(downloaded.buffer, Buffer.from([0, 1, 2, 255]));

    await client.terminateSession(session.id);
    await waitFor(async () => (await client.getSession(session.id)).state === "exited");
    assert.equal((await client.getSession(session.id)).state, "exited");
  } finally {
    await agent.stop();
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("TCP tunnel reaches a loopback service through an agent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-tunnel-next-"));
  const service = net.createServer((socket) => socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("through-agent:"), chunk]))));
  const targetPort = await listen(service);
  const controller = createRecoveryController({
    config: { stateDir: path.join(root, "controller"), host: "127.0.0.1", port: 0, bootHost: "127.0.0.1", bootPort: 0, heartbeatMs: 100, staleAfterMs: 500, offlineAfterMs: 1_000 },
  });
  const info = await controller.start();
  const executor = createRecoveryExecutor();
  const inventory = { collect: async () => ({ collectedAt: new Date().toISOString(), block: { devices: [] }, errors: [] }) };
  const agent = createRecoveryAgent({ controllerUrl: info.localUrl, id: "wwra_tunnel", stateDir: path.join(root, "agent"), installedIdPath: path.join(root, "agent-id"), executor, inventory, registry: createRecoveryActionRegistry({ executor, inventory }), reconnectDelays: [25] });
  const client = createRecoveryClient({ url: info.localUrl });
  try {
    await agent.start();
    const tunnel = await client.openTunnel({ agentId: "wwra_tunnel", targetHost: "127.0.0.1", targetPort, listenHost: "127.0.0.1", listenPort: 0 });
    const local = net.createConnection({ host: "127.0.0.1", port: tunnel.listenPort });
    await once(local, "connect");
    local.write("hello");
    const [data] = await once(local, "data");
    assert.equal(data.toString(), "through-agent:hello");
    local.destroy();
    assert.equal((await client.closeTunnel(tunnel.id)).state, "closed");
  } finally {
    await agent.stop();
    await controller.stop();
    service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("console discovery resolves exact custom argv and reports unavailable alternatives", async () => {
  const launcher = createRecoveryConsoleLauncher();
  const customArgv = [process.execPath, "-e", "", "custom-link", "$(literal)"];
  const custom = await launcher.resolve({ transportArgv: customArgv });
  assert.equal(custom.available, true);
  assert.deepEqual(custom.argv, customArgv);
  const missing = await launcher.resolve({ protocol: "rdp", adapterId: "adapter-that-does-not-exist", target: "127.0.0.1" });
  assert.equal(missing.available, false);
  assert.ok(Array.isArray(missing.alternatives));
});

test("console CLI preserves exact custom transport argv", async () => {
  let received;
  const transportArgv = [process.execPath, "-e", "", "custom-link", "$(literal)", "--unfiltered"];
  await runRecoveryCli({
    argv: ["console", "open", "custom", "--", ...transportArgv],
    keepAlive: false,
    stdout: { write() {} },
    loadConfigImpl: async () => ({ port: 4852, token: "" }),
    createClientImpl: () => ({
      async launchConsole(input) {
        received = input;
        return { id: "custom", available: true, argv: input.transportArgv };
      },
    }),
  });
  assert.deepEqual(received, { protocol: "custom", transportArgv });
});

test("controller restart preserves the durable terminal and reattaches to the live agent PTY", {
  skip: process.platform === "win32" ? "Linux PTY restart coverage runs on the Linux host; physical Windows detach/reconnect is a separate gate." : false,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-interactive-restart-"));
  const stateDir = path.join(root, "controller");
  let controller = createRecoveryController({ config: { stateDir, host: "127.0.0.1", port: 0, bootHost: "127.0.0.1", bootPort: 0, heartbeatMs: 100, staleAfterMs: 500, offlineAfterMs: 1_000 } });
  const firstInfo = await controller.start();
  const executor = createRecoveryExecutor();
  const inventory = { collect: async () => ({ collectedAt: new Date().toISOString(), system: { platform: "linux" }, block: { devices: [] }, errors: [] }) };
  const agent = createRecoveryAgent({ controllerUrl: firstInfo.localUrl, id: "wwra_terminal_restart", stateDir: path.join(root, "agent"), installedIdPath: path.join(root, "agent-id"), executor, inventory, registry: createRecoveryActionRegistry({ executor, inventory }), reconnectDelays: [25, 50] });
  try {
    await agent.start();
    let client = createRecoveryClient({ url: firstInfo.localUrl });
    const session = await client.openSession({ agentId: "wwra_terminal_restart", cwd: root, argv: ["/bin/bash", "--noprofile", "--norc", "-i"] });
    await client.sessionInput(session.id, "printf 'BEFORE_RESTART\\n'\n");
    await waitFor(async () => (await client.listSessionEvents(session.id)).some((event) => String(event.data).includes("BEFORE_RESTART")));
    const sequenceBefore = (await client.getSession(session.id)).lastOutputSeq;

    await controller.stop();
    controller = createRecoveryController({ config: { stateDir, host: "127.0.0.1", port: firstInfo.port, bootHost: "127.0.0.1", bootPort: firstInfo.boot.port, heartbeatMs: 100, staleAfterMs: 500, offlineAfterMs: 1_000 } });
    const secondInfo = await controller.start();
    client = createRecoveryClient({ url: secondInfo.localUrl });
    await waitFor(async () => (await client.getAgent("wwra_terminal_restart")).agent?.connected === true);
    await waitFor(async () => {
      const restored = await client.getSession(session.id);
      const records = await client.listSessionEvents(session.id);
      return restored.state === "attached" && records.some((event) => event.type === "session.resumed");
    });
    await client.sessionInput(session.id, "printf 'AFTER_RESTART\\n'\n");
    const events = await waitFor(async () => {
      const records = await client.listSessionEvents(session.id);
      return records.some((event) => String(event.data).includes("AFTER_RESTART")) ? records : null;
    });
    assert.ok(events.some((event) => event.type === "session.resumed"));
    const restored = await client.getSession(session.id);
    assert.equal(restored.state, "attached");
    assert.ok(restored.lastOutputSeq > sequenceBefore);
    await client.terminateSession(session.id);
  } finally {
    await agent.stop();
    await controller.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Windows interactive adapter selects exact winpty/PowerShell argv and exposes truthful pipe fallback", async () => {
  function fakeChild() {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    return child;
  }
  const launches = [];
  const events = [];
  const runtime = createInteractiveAgentRuntime({
    platform: "win32",
    send: (message) => events.push(message),
    executor: { async resolveTool(name) { return name === "winpty" ? "C:\\tools\\winpty.exe" : name === "pwsh" ? "C:\\Program Files\\PowerShell\\pwsh.exe" : ""; } },
    spawnImpl(file, args, options) { launches.push({ file, args, options }); return fakeChild(); },
  });
  await runtime.handle({ type: "controller.session.open", requestId: "req-win", session: { id: "wwterm_windows", agentId: "wwra_windows", cwd: "C:\\", argv: ["pwsh", "-NoLogo"] } });
  assert.equal(launches[0].file, "C:\\tools\\winpty.exe");
  assert.deepEqual(launches[0].args, ["C:\\Program Files\\PowerShell\\pwsh.exe", "-NoLogo"]);
  assert.equal(events.find((message) => message.event?.type === "session.created").event.terminalMode, "winpty-conpty");
  assert.equal(runtime.capabilities().signals, false);
  await runtime.stop();

  const fallbackLaunches = [];
  const fallback = createInteractiveAgentRuntime({
    platform: "win32",
    send() {},
    executor: { async resolveTool(name) { return name === "powershell" ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : ""; } },
    spawnImpl(file, args) { fallbackLaunches.push({ file, args }); return fakeChild(); },
  });
  await fallback.handle({ type: "controller.session.open", requestId: "req-pipe", session: { id: "wwterm_windows_pipe", agentId: "wwra_windows", cwd: "C:\\" } });
  assert.equal(fallbackLaunches[0].file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(fallbackLaunches[0].args, ["-NoLogo", "-NoExit"]);
  await fallback.stop();
});
