import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDefaultWwConfig, deriveWwTrustId } from "../lib/ww-config-store.mjs";
import { WW_APP_VERSION } from "../lib/ww-compat.mjs";
import {
  buildWwDesktopLaunchArgsFromPeerRequest,
  buildWwDesktopServiceAttachArgs,
  buildWwDesktopLaunchSpec,
  launchWwDesktop,
  prepareWwDesktopLaunch,
  runServeCommand,
  runWwPairCommand,
  runWwCli,
  wantsWwHelp,
  WW_ENGINEERING_HELP_TEXT,
  WW_HELP_TEXT,
} from "../ww.mjs";

test("ww launcher builds the local electron desktop command", () => {
  const spec = buildWwDesktopLaunchSpec({
    baseDir: "/tmp/workwire",
    argv: ["--local", "/srv/projects"],
    nodePath: "/usr/bin/node",
    env: {
      DISPLAY: ":1",
    },
    platform: "linux",
  });

  assert.deepEqual(spec, {
    command: "/usr/bin/node",
    args: [
      "/tmp/workwire/node_modules/electron/cli.js",
      "/tmp/workwire/desktop/ww-main.cjs",
      "--local",
      "/srv/projects",
    ],
    options: {
      env: {
        CHROME_DESKTOP: "workwire.desktop",
        DISPLAY: ":1",
      },
      stdio: "inherit",
    },
  });
});

test("ww launcher uses the installed Windows desktop executable", () => {
  const spec = buildWwDesktopLaunchSpec({
    argv: ["--peer", "192.168.8.104:4851"],
    env: {
      LOCALAPPDATA: "C:\\Users\\Sakura\\AppData\\Local",
    },
    platform: "win32",
  });

  assert.deepEqual(spec, {
    command: "C:\\Users\\Sakura\\AppData\\Local\\WorkWire\\app\\WorkWire.exe",
    args: ["--peer", "192.168.8.104:4851"],
    options: {
      env: {
        LOCALAPPDATA: "C:\\Users\\Sakura\\AppData\\Local",
      },
      stdio: "ignore",
      detached: true,
    },
  });
});

test("ww launcher spawns the desktop app with inherited stdio", () => {
  let invocation = null;
  const child = { pid: 73 };

  const result = launchWwDesktop({
    baseDir: "/home/test/WorkWire",
    argv: ["--peer", "box:4851"],
    nodePath: "/usr/bin/node",
    env: {
      DISPLAY: ":1",
    },
    platform: "linux",
    existsImpl: () => true,
    prepareDesktopLaunchImpl: ({ baseDir, platform }) => {
      invocation = {
        ...invocation,
        prepared: { baseDir, platform },
      };
      return null;
    },
    spawnImpl: (command, args, options) => {
      invocation = {
        ...invocation,
        command,
        args,
        options,
      };
      return child;
    },
  });

  assert.equal(result, child);
  assert.deepEqual(invocation, {
    command: "/usr/bin/node",
    args: [
      "/home/test/WorkWire/node_modules/electron/cli.js",
      "/home/test/WorkWire/desktop/ww-main.cjs",
      "--peer",
      "box:4851",
    ],
    options: {
      env: {
        CHROME_DESKTOP: "workwire.desktop",
        DISPLAY: ":1",
      },
      stdio: "inherit",
    },
    prepared: {
      baseDir: "/home/test/WorkWire",
      platform: "linux",
    },
  });
});

test("ww launcher refreshes the Linux WorkWire desktop entry before launch", () => {
  let invocation = null;

  const result = prepareWwDesktopLaunch({
    baseDir: "/home/test/WorkWire",
    platform: "linux",
    ensureLinuxDesktopEntryImpl: ({ baseDir, platform }) => {
      invocation = { baseDir, platform };
      return "/home/test/.local/share/applications/workwire.desktop";
    },
  });

  assert.equal(result, "/home/test/.local/share/applications/workwire.desktop");
  assert.deepEqual(invocation, {
    baseDir: "/home/test/WorkWire",
    platform: "linux",
  });
});

test("ww launcher recognizes help flags", () => {
  assert.equal(wantsWwHelp([]), false);
  assert.equal(wantsWwHelp(["--help"]), true);
  assert.equal(wantsWwHelp(["-h"]), true);
  assert.equal(wantsWwHelp(["--help", "--engineering"]), true);
});

test("ww public help hides manual peer and token workflows", () => {
  assert.doesNotMatch(WW_HELP_TEXT, /\bww connect\b/);
  assert.doesNotMatch(WW_HELP_TEXT, /--peer\b/);
  assert.doesNotMatch(WW_HELP_TEXT, /--token\b/);
  assert.doesNotMatch(WW_HELP_TEXT, /\bww config\b/);
  assert.match(WW_HELP_TEXT, /\bww pair\b/);
  assert.match(WW_ENGINEERING_HELP_TEXT, /\bww connect\b/);
  assert.match(WW_ENGINEERING_HELP_TEXT, /--peer\b/);
  assert.match(WW_ENGINEERING_HELP_TEXT, /--token\b/);
});

test("ww pairing profile replaces shared trust without replacing this PC identity", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-pairing-"));
  const pairingPath = path.join(tempDir, "pairing.json");
  await fs.writeFile(pairingPath, JSON.stringify({
    kind: "workwire-pairing-v1",
    token: "shared_pairing_token_1234567890",
    port: 4851,
  }), "utf8");

  let savedConfig = null;
  let output = "";
  try {
    const result = await runWwPairCommand({
      positionals: [pairingPath],
      stdout: {
        write(chunk) {
          output += chunk;
        },
      },
      stderr: {
        write() {},
      },
      loadConfigImpl: async () => ({
        service: {
          machineId: "this-pc-machine",
          token: "old-token",
          port: 4851,
        },
        peer: {
          label: "Old peer",
          host: "192.168.8.99",
          port: 4851,
          machineId: "wrong-machine",
          token: "old-token",
          remotePath: "/old",
        },
        recentPeers: [{
          host: "192.168.8.99",
          token: "old-token",
        }],
      }),
      saveConfigImpl: async (config) => {
        savedConfig = structuredClone(config);
        return config;
      },
    });

    assert.equal(result.service.machineId, "this-pc-machine");
    assert.equal(savedConfig.service.token, "shared_pairing_token_1234567890");
    assert.equal(savedConfig.peer.token, "shared_pairing_token_1234567890");
    assert.equal(savedConfig.peer.machineId, "");
    assert.equal(savedConfig.peer.host, "");
    assert.deepEqual(savedConfig.recentPeers, []);
    assert.doesNotMatch(output, /shared_pairing_token/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ww launcher prints help without launching Electron", async () => {
  let launched = false;
  let output = "";

  const result = await runWwCli({
    argv: ["--help"],
    stdout: {
      write(chunk) {
        output += chunk;
      },
    },
    launchDesktopImpl: () => {
      launched = true;
      return null;
    },
  });

  assert.equal(result, null);
  assert.equal(launched, false);
  assert.equal(output, `${WW_HELP_TEXT}\n`);
});

test("ww launcher prints engineering help only when explicitly requested", async () => {
  let launched = false;
  let output = "";

  const result = await runWwCli({
    argv: ["--help", "--engineering"],
    stdout: {
      write(chunk) {
        output += chunk;
      },
    },
    launchDesktopImpl: () => {
      launched = true;
      return null;
    },
  });

  assert.equal(result, null);
  assert.equal(launched, false);
  assert.equal(output, `${WW_ENGINEERING_HELP_TEXT}\n`);
});

test("ww launcher expands --remote into peer and remote path arguments", async () => {
  let launchedWith = null;
  const child = {
    on() {},
  };

  await runWwCli({
    argv: ["--remote", "fileserver:5120:/srv/shared"],
    resolveLocalServiceImpl: async () => null,
    launchDesktopImpl: ({ argv }) => {
      launchedWith = argv;
      return child;
    },
  });

  assert.deepEqual(launchedWith, [
    "--remote",
    "fileserver:5120:/srv/shared",
    "--peer",
    "fileserver:5120",
    "--remote-path",
    "/srv/shared",
  ]);
});

test("ww launcher attaches to the local background service when it is already running", async () => {
  let launchedWith = null;
  const child = {
    on() {},
  };

  await runWwCli({
    argv: ["--peer", "fileserver:5120"],
    resolveLocalServiceImpl: async () => ({
      peer: {
        host: "127.0.0.1",
        port: 4851,
        token: "local-token",
      },
    }),
    launchDesktopImpl: ({ argv }) => {
      launchedWith = argv;
      return child;
    },
  });

  assert.deepEqual(launchedWith, [
    "--service-host",
    "127.0.0.1",
    "--service-port",
    "4851",
    "--peer",
    "fileserver:5120",
  ]);
});

test("ww launcher accepts a synchronous background-service restart before attaching", async () => {
  let launchedWith = null;
  let resolveCalls = 0;
  let restartCalls = 0;
  let stderrOutput = "";
  const child = {
    on() {},
  };

  await runWwCli({
    argv: ["--peer", "fileserver:5120"],
    stderr: {
      write(chunk) {
        stderrOutput += chunk;
      },
    },
    resolveLocalServiceImpl: async ({ requireCompatibility } = {}) => {
      resolveCalls += 1;
      assert.equal(requireCompatibility, true);
      if (resolveCalls === 1) {
        return {
          peer: {
            host: "127.0.0.1",
            port: 4851,
            token: "stale-token",
          },
          info: {
            versions: {
              app: "0.0.1",
            },
          },
          compatible: false,
        };
      }

      return {
        peer: {
          host: "127.0.0.1",
          port: 4851,
          token: "local-token",
        },
        info: {
          versions: {
            app: WW_APP_VERSION,
          },
        },
        compatible: true,
      };
    },
    restartLocalServiceImpl: () => {
      restartCalls += 1;
      return true;
    },
    launchDesktopImpl: ({ argv }) => {
      launchedWith = argv;
      return child;
    },
  });

  assert.equal(restartCalls, 1);
  assert.match(stderrOutput, /Restarted workwire-ww\.service/i);
  assert.deepEqual(launchedWith, [
    "--service-host",
    "127.0.0.1",
    "--service-port",
    "4851",
    "--peer",
    "fileserver:5120",
  ]);
});

test("ww launcher refuses to attach to a stale local background service when restart is unavailable", async () => {
  let launched = false;
  let stderrOutput = "";
  const previousExitCode = process.exitCode;

  try {
    const result = await runWwCli({
      argv: ["--peer", "fileserver:5120"],
      stderr: {
        write(chunk) {
          stderrOutput += chunk;
        },
      },
      resolveLocalServiceImpl: async ({ requireCompatibility } = {}) => {
        assert.equal(requireCompatibility, true);
        return {
          peer: {
            host: "127.0.0.1",
            port: 4851,
            token: "stale-token",
          },
          info: {
            versions: {
              app: "0.0.1",
            },
          },
          compatible: false,
        };
      },
      restartLocalServiceImpl: async () => false,
      launchDesktopImpl: () => {
        launched = true;
        return {
          on() {},
        };
      },
    });

    assert.equal(result, null);
    assert.equal(launched, false);
    assert.match(stderrOutput, /local background service running WW 0\.0\.1/i);
    assert.ok(stderrOutput.includes(WW_APP_VERSION));
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("ww launcher refuses to attach to a local background service on the wrong portal path", async () => {
  let launched = false;
  let stderrOutput = "";
  const previousExitCode = process.exitCode;

  try {
    const result = await runWwCli({
      argv: ["--peer", "fileserver:5120"],
      stderr: {
        write(chunk) {
          stderrOutput += chunk;
        },
      },
      resolveLocalServiceImpl: async ({ requireCompatibility } = {}) => {
        assert.equal(requireCompatibility, true);
        return {
          peer: {
            host: "127.0.0.1",
            port: 4851,
            token: "stale-token",
          },
          info: {
            rootPath: "/srv/old-root",
          },
          expectedRootPath: "/srv/workwire/app",
          compatible: false,
        };
      },
      restartLocalServiceImpl: async () => false,
      launchDesktopImpl: () => {
        launched = true;
        return {
          on() {},
        };
      },
    });

    assert.equal(result, null);
    assert.equal(launched, false);
    assert.match(stderrOutput, /using \/srv\/old-root/i);
    assert.match(stderrOutput, /expects \/srv\/workwire\/app/i);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("ww launcher builds local background-service attach args", () => {
  assert.deepEqual(buildWwDesktopServiceAttachArgs({
    host: "0.0.0.0",
    port: 4851,
    token: "local-token",
  }), [
    "--service-host",
    "127.0.0.1",
    "--service-port",
    "4851",
  ]);
});

test("ww launcher builds peer desktop args from a launch request", () => {
  const args = buildWwDesktopLaunchArgsFromPeerRequest({
    requester: {
      port: 5120,
      machineId: "peer-machine",
      token: "peer-token",
      name: "Fileserver",
      rootPath: "/srv/local",
    },
    requesterHostHint: "192.168.1.24",
    localPath: "/srv/remote",
  }, {
    service: {
      host: "0.0.0.0",
      port: 4851,
      token: "local-token",
    },
  });

  assert.deepEqual(args, [
    "--service-host",
    "127.0.0.1",
    "--service-port",
    "4851",
    "--skip-peer-launch",
    "--local",
    "/srv/remote",
    "--peer",
    "192.168.1.24:5120",
    "--peer-machine-id",
    "peer-machine",
    "--name",
    "Fileserver",
    "--remote-path",
    "/srv/local",
  ]);
});

test("ww serve keeps the background service running while it opens the desktop app", async () => {
  let capturedLaunchRequest = null;
  let beaconAnnouncement = null;
  let scheduledLaunch = null;
  let scheduledDelay = 0;
  let beaconStopped = 0;
  let serviceStopped = 0;
  let launchedWith = null;
  let childUnrefCount = 0;
  let mirrorOptions = null;
  const config = buildDefaultWwConfig({ homeDir: "/tmp/ww-home", hostName: "desk-box" });
  config.peer.remotePath = "C:\\Users\\Sakura\\WorkWire";

  const result = await runServeCommand({
    flags: {
      token: "desk-token",
      name: "Desk Box",
    },
    stdout: {
      write() {},
    },
    stderr: {
      write() {},
    },
    keepAlive: false,
    loadWwConfigImpl: async () => config,
    setTimeoutImpl(callback, delay) {
      scheduledLaunch = callback;
      scheduledDelay = delay;
      return 1;
    },
    createWwServiceImpl(options) {
      capturedLaunchRequest = options.onLaunchDesktop;
      return {
        async start() {
          return {
            name: "Desk Box",
            port: 4851,
            rootPath: "/srv/WorkWire",
            urls: ["http://127.0.0.1:4851"],
            trustId: "desk-trust",
            versions: {
              protocol: 1,
              app: "0.1.0",
            },
            installerUrl: "http://192.168.8.50:8765/",
          };
        },
        async stop() {
          serviceStopped += 1;
        },
      };
    },
    createWwLanBeaconImpl(options) {
      beaconAnnouncement = options.getAnnouncement();
      return {
        async start() {},
        async stop() {
          beaconStopped += 1;
        },
      };
    },
    createWwMirrorImpl(options) {
      mirrorOptions = options;
      return {
        start() {},
        async stop() {},
      };
    },
    launchDesktopImpl({ argv }) {
      launchedWith = argv;
      return {
        unref() {
          childUnrefCount += 1;
        },
      };
    },
    processImpl: {
      exit() {},
      once() {},
      exitCode: 0,
    },
  });

  assert.equal(result?.serviceInfo?.name, "Desk Box");
  assert.equal(mirrorOptions?.expectedRemoteRootPath, "C:\\Users\\Sakura\\WorkWire");
  assert.equal(typeof capturedLaunchRequest, "function");
  assert.equal(beaconAnnouncement?.name, "Desk Box");
  assert.equal(beaconAnnouncement?.port, 4851);
  assert.equal(beaconAnnouncement?.servicePort, 4851);
  assert.equal(beaconAnnouncement?.trustId, deriveWwTrustId("desk-token"));
  assert.equal(typeof beaconAnnouncement?.machineId, "string");
  assert.equal(Boolean(beaconAnnouncement?.machineId), true);
  assert.equal(beaconAnnouncement?.versions?.protocol, 1);
  assert.equal(beaconAnnouncement?.versions?.app, "0.1.0");
  assert.equal(typeof beaconAnnouncement?.installerUrl, "string");
  assert.equal(Boolean(beaconAnnouncement?.installerUrl), true);
  assert.equal(beaconAnnouncement?.canLaunchDesktop, true);
  assert.equal(beaconAnnouncement?.updateProtocol, 1);
  assert.equal(Object.hasOwn(beaconAnnouncement, "token"), false);
  assert.equal(Object.hasOwn(beaconAnnouncement, "rootPath"), false);

  const launchResult = await capturedLaunchRequest({
    requester: {
      host: "192.168.1.24",
      port: 5120,
      token: "peer-token",
      name: "Fileserver",
      rootPath: "/srv/local",
    },
    localPath: "/srv/remote",
  });

  assert.deepEqual(launchResult, {
    action: "spawning",
  });
  assert.equal(scheduledDelay, 75);

  await scheduledLaunch();

  assert.equal(beaconStopped, 0);
  assert.equal(serviceStopped, 0);
  assert.equal(childUnrefCount, 1);
  assert.deepEqual(launchedWith, [
    "--service-host",
    "127.0.0.1",
    "--service-port",
    "4851",
    "--skip-peer-launch",
    "--local",
    "/srv/remote",
    "--peer",
    "192.168.1.24:5120",
    "--name",
    "Fileserver",
    "--remote-path",
    "/srv/local",
  ]);
});

test("ww serve exits for supervisor restart only after coordinated release activation", async () => {
  let activatorOptions = null;
  let activatorStarted = 0;
  let activatorStopped = 0;
  let mirrorStopped = 0;
  let beaconStopped = 0;
  let serviceStopped = 0;
  let exitCode = null;

  await runServeCommand({
    stdout: { write() {} },
    stderr: { write() {} },
    keepAlive: false,
    createWwServiceImpl() {
      return {
        async start() {
          return {
            name: "Update Box",
            port: 4851,
            rootPath: "/srv/WorkWire",
            urls: ["http://127.0.0.1:4851"],
            versions: { protocol: 1, app: "old" },
          };
        },
        async stop() { serviceStopped += 1; },
      };
    },
    createWwLanBeaconImpl() {
      return {
        async start() {},
        async stop() { beaconStopped += 1; },
      };
    },
    createWwMirrorImpl() {
      return {
        start() {},
        async stop() { mirrorStopped += 1; },
      };
    },
    createWwReleaseActivatorImpl(options) {
      activatorOptions = options;
      return {
        start() { activatorStarted += 1; },
        stop() { activatorStopped += 1; },
      };
    },
    processImpl: {
      exit(code) { exitCode = code; },
      once() {},
      exitCode: 0,
    },
  });

  assert.equal(activatorStarted, 1);
  await activatorOptions.onActivationRequired({
    hash: "finished-hash",
    version: "0.1.0+ww1.finished",
  });
  assert.equal(exitCode, 75);
  assert.equal(activatorStopped, 1);
  assert.equal(mirrorStopped, 1);
  assert.equal(beaconStopped, 1);
  assert.equal(serviceStopped, 1);
});

test("ww serve keeps duplicate peer launch requests pending while one handoff is already scheduled", async () => {
  let capturedLaunchRequest = null;
  let scheduledCount = 0;

  await runServeCommand({
    flags: {
      token: "desk-token",
    },
    stdout: {
      write() {},
    },
    stderr: {
      write() {},
    },
    keepAlive: false,
    setTimeoutImpl() {
      scheduledCount += 1;
      return 1;
    },
    createWwServiceImpl(options) {
      capturedLaunchRequest = options.onLaunchDesktop;
      return {
        async start() {
          return {
            name: "Desk Box",
            port: 4851,
            rootPath: "/srv/WorkWire",
            urls: ["http://127.0.0.1:4851"],
            trustId: "desk-trust",
            versions: {
              protocol: 1,
              app: "0.1.0",
            },
            installerUrl: "http://192.168.8.50:8765/",
          };
        },
        async stop() {},
      };
    },
    createWwLanBeaconImpl() {
      return {
        async start() {},
        async stop() {},
      };
    },
    createWwMirrorImpl() {
      return {
        start() {},
        async stop() {},
      };
    },
    processImpl: {
      exit() {},
      once() {},
      exitCode: 0,
    },
  });

  const request = {
    requester: {
      host: "192.168.1.24",
      port: 5120,
    },
  };

  assert.deepEqual(await capturedLaunchRequest(request), {
    action: "spawning",
  });
  assert.deepEqual(await capturedLaunchRequest(request), {
    action: "pending",
  });
  assert.equal(scheduledCount, 1);
});
