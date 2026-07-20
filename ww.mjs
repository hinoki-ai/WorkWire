#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WW_SYSTEMD_USER_UNIT_NAME } from "./lib/ww-autostart.mjs";
import {
  WW_CONFIG_PATH,
  WW_PORTAL_DIRNAME,
  buildDefaultWwConfig,
  deriveWwTrustId,
  loadWwConfig,
  normalizePort,
  parsePeerSpec,
  rememberPeer,
  resolveWwPortalEnvironmentRoot,
  resolveWwPortalRoot,
  saveWwConfig,
  updateWwConfig,
} from "./lib/ww-config-store.mjs";
import { WW_BEACON_PORTS, createWwLanBeacon } from "./lib/ww-beacon.mjs";
import { createRemoteWwClient } from "./lib/ww-client.mjs";
import { WW_APP_VERSION, buildWwBuildInfo } from "./lib/ww-compat.mjs";
import {
  WW_MIRROR_MUTATION_IDLE_MS,
  createWwMirror,
} from "./lib/ww-mirror.mjs";
import { createWwService } from "./lib/ww-service.mjs";
import { loadRecoveryConfig } from "./lib/recovery/ww-recovery-config.mjs";
import { createRecoveryController } from "./lib/recovery/ww-recovery-controller.mjs";
import { runRecoveryCli } from "./lib/recovery/ww-recovery-cli.mjs";
import { createWindowsRecoveryAgentCompanionWatchdog } from "./lib/recovery/ww-recovery-companion-watchdog.mjs";
import {
  WW_UPDATE_PROTOCOL_VERSION,
  createWwReleaseActivator,
} from "./lib/ww-update.mjs";
import {
  buildLinuxLaunchEnv,
  ensureLinuxWwDesktopEntry,
  LINUX_WW_DESKTOP_ENTRY_NAME,
} from "./desktop/linux-integration.mjs";

export const WW_PAIRING_PROFILE_KIND = "workwire-pairing-v1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WW_LOG_PATH = path.join(path.dirname(WW_CONFIG_PATH), "ww.log");
const WW_LOCAL_SERVICE_PROBE_TIMEOUT_MS = 350;
const WW_LOCAL_SERVICE_HOST_CANDIDATES = [
  "127.0.0.1",
  "localhost",
  "::1",
];

export const WW_HELP_TEXT = `Usage:
  ww
  ww serve
  ww pair <pairing-file>
  ww recovery --help
  ww --help
  ww --help --engineering

Quick Start:
  Run \`ww\` on both PCs and WorkWire will link the two ${WW_PORTAL_DIRNAME} folders automatically when both machines can reach each other.

Commands:
  ww                 Launch the WorkWire desktop app.
  ww serve           Run the WW background service for headless auto-linking.
  ww pair <file>      Pair this installation using a trusted WorkWire pairing file.
  ww recovery         Open the root-capable LAN recovery command surface.
  ww --help          Print the public WW help.
  ww --help --engineering
                     Print engineering-only WorkWire commands and flags.

Desktop options:
  --local <path>         Initial local subfolder inside ${WW_PORTAL_DIRNAME}.
  --hidden               Start with hidden files visible.
`;

export const WW_ENGINEERING_HELP_TEXT = `Usage:
  ww
  ww --local <path> --peer <host[:port]> --remote-path <path>
  ww --remote <host[:port]:path>
  ww serve [--host <host>] [--port <port>] [--token <token>] [--name <label>]
  ww connect <host[:port]> [--token <token>] [--name <label>] [--remote-path <path>]
  ww pair <pairing-file>
  ww config
  ww recovery <command>
  ww --help
  ww --help --engineering

Commands:
  ww                 Launch the WorkWire desktop app.
  ww serve           Run the WW LAN filesystem service without the desktop UI.
  ww connect         Save the default peer connection in ${WW_CONFIG_PATH}.
  ww pair            Apply a shared pairing profile without replacing this PC's machine identity.
  ww config          Print the active WW config and config path.
  ww recovery        Control recovery agents, jobs, disks, PXE, and artifacts.

Desktop options:
  --local <path>         Initial local subfolder inside ${WW_PORTAL_DIRNAME}.
  --peer <host[:port]>   Remote WW peer host or host:port.
  --remote-path <path>   Initial remote subfolder inside ${WW_PORTAL_DIRNAME}.
  --remote <peer:path>   Combined remote peer and portal subpath.
  --token <token>        Remote peer bearer token.
  --name <label>         Saved peer label.
  --hidden               Start with hidden files visible.
`;

export function parseWwArgv(argv = []) {
  const args = [...argv];
  const command = ["serve", "connect", "pair", "config", "recovery"].includes(args[0]) ? args.shift() : "desktop";
  const flags = {};
  const positionals = [];

  while (args.length > 0) {
    const current = args.shift();
    if (!current.startsWith("--")) {
      positionals.push(current);
      continue;
    }

    const key = current.slice(2);
    const next = args[0];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = args.shift();
  }

  return {
    command,
    flags,
    positionals,
  };
}

function parseCombinedRemoteSpec(spec = "") {
  const raw = String(spec || "").trim();
  if (!raw) {
    return {
      peer: null,
      remotePath: "",
    };
  }

  const ipv6Match = raw.match(/^\[([^\]]+)\](?::(\d+))?:(.+)$/);
  if (ipv6Match) {
    return {
      peer: {
        host: ipv6Match[1],
        port: normalizePort(ipv6Match[2]),
      },
      remotePath: ipv6Match[3],
    };
  }

  const parts = raw.split(":");
  if (parts.length >= 3 && /^\d+$/.test(parts[1])) {
    return {
      peer: {
        host: parts[0],
        port: normalizePort(parts[1]),
      },
      remotePath: parts.slice(2).join(":"),
    };
  }

  if (parts.length >= 2) {
    return {
      peer: {
        host: parts[0],
        port: buildDefaultWwConfig().peer.port,
      },
      remotePath: parts.slice(1).join(":"),
    };
  }

  return {
    peer: null,
    remotePath: "",
  };
}

function formatPeerArgument(host = "", port = buildDefaultWwConfig().peer.port) {
  const normalizedHost = String(host || "").trim();
  if (!normalizedHost) {
    return "";
  }

  const authority = normalizedHost.includes(":") && !normalizedHost.startsWith("[")
    ? `[${normalizedHost}]`
    : normalizedHost;
  return `${authority}:${normalizePort(port)}`;
}

function appendWwLogLine(message = "") {
  const line = `[${new Date().toISOString()}] ${String(message || "")}\n`;
  try {
    fs.mkdirSync(path.dirname(WW_LOG_PATH), { recursive: true });
    fs.appendFileSync(WW_LOG_PATH, line, "utf8");
  } catch {}
}

function writeWwLog(output, message = "") {
  const line = String(message || "");
  output.write(`${line}\n`);
  appendWwLogLine(line);
}

function resolveLocalWwServiceHost(host = "") {
  const normalizedHost = String(host || "").trim();
  if (!normalizedHost || normalizedHost === "0.0.0.0" || normalizedHost === "::") {
    return "127.0.0.1";
  }
  return normalizedHost;
}

function readWwServiceAppVersion(info = {}) {
  return String(info?.versions?.app || info?.appVersion || "").trim();
}

function readWwServiceRootPath(info = {}) {
  const rootPath = String(info?.rootPath || "").trim();
  return rootPath ? path.resolve(rootPath) : "";
}

function resolveExpectedWwServiceRootPath(config = null) {
  const configuredRootPath = String(config?.service?.rootPath || "").trim();
  return path.resolve(configuredRootPath || resolveWwPortalRoot());
}

function buildStaleLocalWwServiceMessage(localService = null) {
  const runningVersion = readWwServiceAppVersion(localService?.info);
  const runningRootPath = readWwServiceRootPath(localService?.info);
  const expectedRootPath = localService?.expectedRootPath
    ? path.resolve(localService.expectedRootPath)
    : "";

  if (runningRootPath && expectedRootPath && runningRootPath !== expectedRootPath) {
    return `WW found a local background service using ${runningRootPath}, but this launcher expects ${expectedRootPath}. Restart ${WW_SYSTEMD_USER_UNIT_NAME} or stop the old 'ww serve' process, then relaunch WW.`;
  }

  if (runningVersion) {
    return `WW found a local background service running WW ${runningVersion}, but this launcher is WW ${WW_APP_VERSION}. Restart ${WW_SYSTEMD_USER_UNIT_NAME} or stop the old 'ww serve' process, then relaunch WW.`;
  }

  return `WW found a local background service that does not match this launcher. This launcher is WW ${WW_APP_VERSION}. Restart ${WW_SYSTEMD_USER_UNIT_NAME} or stop the old 'ww serve' process, then relaunch WW.`;
}

export function restartManagedLocalWwBackgroundService({
  unitName = WW_SYSTEMD_USER_UNIT_NAME,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform !== "linux") {
    return false;
  }

  try {
    execFileSyncImpl("systemctl", ["--user", "restart", unitName], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function waitFor(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function buildWwDesktopServiceAttachArgs(service = {}) {
  const host = resolveLocalWwServiceHost(service.host);
  if (!host) {
    return [];
  }

  const launchArgs = [
    "--service-host",
    host,
    "--service-port",
    String(normalizePort(service.port, buildDefaultWwConfig().service.port)),
  ];
  return launchArgs;
}

export function buildWwDesktopLaunchArgsFromPeerRequest(request = {}, {
  service = null,
} = {}) {
  const requester = request?.requester && typeof request.requester === "object"
    ? request.requester
    : {};
  const requesterHost = String(requester.host || request.requesterHostHint || "").trim();
  const requesterPort = normalizePort(requester.port, buildDefaultWwConfig().peer.port);
  const requesterMachineId = String(requester.machineId || requester.installationId || "").trim();
  const requesterName = String(requester.name || requester.label || requesterHost).trim();
  const localPath = String(request.localPath || "").trim();
  const remotePath = String(request.remotePath || requester.rootPath || "").trim();
  const launchArgs = [
    ...buildWwDesktopServiceAttachArgs(service || {}),
    "--skip-peer-launch",
  ];
  const peerArgument = formatPeerArgument(requesterHost, requesterPort);

  if (localPath) {
    launchArgs.push("--local", localPath);
  }
  if (peerArgument) {
    launchArgs.push("--peer", peerArgument);
  }
  if (requesterMachineId) {
    launchArgs.push("--peer-machine-id", requesterMachineId);
  }
  if (requesterName) {
    launchArgs.push("--name", requesterName);
  }
  if (remotePath) {
    launchArgs.push("--remote-path", remotePath);
  }

  return launchArgs;
}

export async function resolveLocalWwBackgroundService({
  config = null,
  createRemoteWwClientImpl = createRemoteWwClient,
  timeoutMs = WW_LOCAL_SERVICE_PROBE_TIMEOUT_MS,
  requireCompatibility = false,
} = {}) {
  const activeConfig = config || await loadWwConfig();
  const expectedRootPath = resolveExpectedWwServiceRootPath(activeConfig);
  const configuredHost = String(activeConfig?.service?.host || "").trim();
  const port = normalizePort(activeConfig?.service?.port, buildDefaultWwConfig().service.port);
  const token = String(activeConfig?.service?.token || "").trim();
  const hosts = [];
  const appendHost = (value = "") => {
    const normalizedHost = resolveLocalWwServiceHost(value);
    if (!normalizedHost || hosts.includes(normalizedHost)) {
      return;
    }
    hosts.push(normalizedHost);
  };

  appendHost(configuredHost);
  for (const candidate of WW_LOCAL_SERVICE_HOST_CANDIDATES) {
    appendHost(candidate);
  }

  for (const host of hosts) {
    const peer = {
      host,
      port,
      token,
      localService: true,
    };

    try {
      const client = createRemoteWwClientImpl(peer);
      const info = requireCompatibility
        ? await client.connect({
          timeoutMs,
        })
        : await client.getInfo({
          timeoutMs,
        });
      const infoRootPath = readWwServiceRootPath(info);
      if (infoRootPath && infoRootPath !== expectedRootPath) {
        return {
          peer,
          info,
          compatible: false,
          expectedRootPath,
          error: new Error(`Expected ${expectedRootPath}, received ${infoRootPath}.`),
        };
      }
      return {
        peer,
        info,
        compatible: true,
        expectedRootPath,
      };
    } catch (error) {
      if (!requireCompatibility) {
        continue;
      }

      try {
        const client = createRemoteWwClientImpl(peer);
        const info = await client.getInfo({
          timeoutMs,
        });
        return {
          peer,
          info,
          compatible: false,
          expectedRootPath,
          error,
        };
      } catch {}
    }
  }

  return null;
}

export function buildWwDesktopLaunchSpec({
  baseDir = __dirname,
  argv = [],
  nodePath = process.execPath,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (platform === "win32") {
    const userProfile = String(env.USERPROFILE || "").trim();
    const localAppData = String(env.LOCALAPPDATA || "").trim()
      || (userProfile ? path.win32.join(userProfile, "AppData", "Local") : "");
    const executable = String(env.WW_DESKTOP_EXECUTABLE || "").trim()
      || path.win32.join(localAppData, "WorkWire", "app", "WorkWire.exe");
    return {
      command: executable,
      args: [...argv],
      options: {
        env,
        stdio: "ignore",
        detached: true,
      },
    };
  }

  const electronCliPath = path.posix.join(baseDir, "node_modules", "electron", "cli.js");
  const launchEnv = buildLinuxLaunchEnv(env, platform, LINUX_WW_DESKTOP_ENTRY_NAME);
  const desktopEntryPath = path.posix.join(baseDir, "desktop", "ww-main.cjs");
  return {
    command: nodePath,
    args: [electronCliPath, desktopEntryPath, ...argv],
    options: {
      env: launchEnv,
      stdio: "inherit",
    },
  };
}

export function wantsWwHelp(argv = process.argv.slice(2)) {
  const parsed = parseWwArgv(argv);
  return parsed.flags.help === true || parsed.positionals.includes("-h") || argv.includes("-h");
}

export function wantsWwEngineeringHelp(argv = process.argv.slice(2)) {
  if (!wantsWwHelp(argv)) {
    return false;
  }
  const parsed = parseWwArgv(argv);
  return parsed.flags.engineering === true || parsed.flags.advanced === true;
}

export function printWwHelp(stdout = process.stdout, {
  engineering = false,
} = {}) {
  stdout.write(`${engineering ? WW_ENGINEERING_HELP_TEXT : WW_HELP_TEXT}\n`);
}

export function prepareWwDesktopLaunch({
  baseDir = __dirname,
  stderr = process.stderr,
  platform = process.platform,
  ensureLinuxDesktopEntryImpl = ensureLinuxWwDesktopEntry,
} = {}) {
  if (platform !== "linux") {
    return null;
  }

  try {
    return ensureLinuxDesktopEntryImpl({ baseDir, platform });
  } catch (error) {
    stderr.write(`Unable to refresh WorkWire desktop entry: ${error.message}\n`);
    return null;
  }
}

export function launchWwDesktop({
  baseDir = __dirname,
  argv = process.argv.slice(2),
  nodePath = process.execPath,
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  existsImpl = fs.existsSync,
  stderr = process.stderr,
  prepareDesktopLaunchImpl = prepareWwDesktopLaunch,
} = {}) {
  prepareDesktopLaunchImpl({
    baseDir,
    stderr,
    platform,
  });

  const spec = buildWwDesktopLaunchSpec({
    baseDir,
    argv,
    nodePath,
    env,
    platform,
  });

  if (platform === "win32" && !existsImpl(spec.command)) {
    throw new Error(`WorkWire desktop executable not found at ${spec.command}.`);
  }

  if (platform !== "win32" && !existsImpl(spec.args[0])) {
    throw new Error(`Electron CLI not found at ${spec.args[0]}. Run npm install first.`);
  }

  if (platform !== "win32" && !existsImpl(spec.args[1])) {
    throw new Error(`WorkWire desktop entry not found at ${spec.args[1]}.`);
  }

  return spawnImpl(spec.command, spec.args, spec.options);
}

export async function runServeCommand({
  flags = {},
  stdout = process.stdout,
  stderr = process.stderr,
  launchDesktopImpl = launchWwDesktop,
  createWwServiceImpl = createWwService,
  createWwLanBeaconImpl = createWwLanBeacon,
  createWwMirrorImpl = createWwMirror,
  createWwReleaseActivatorImpl = createWwReleaseActivator,
  loadWwConfigImpl = loadWwConfig,
  loadRecoveryConfigImpl = loadRecoveryConfig,
  createRecoveryControllerImpl = createRecoveryController,
  createRecoveryCompanionWatchdogImpl = createWindowsRecoveryAgentCompanionWatchdog,
  enableRecovery = createWwServiceImpl === createWwService,
  setTimeoutImpl = setTimeout,
  processImpl = process,
  keepAlive = true,
} = {}) {
  let config = await loadWwConfigImpl();
  let desktopLaunchPending = false;
  let service = null;
  let mirror = null;
  let beaconController = null;
  let releaseActivator = null;
  let recoveryController = null;
  let recoveryInfo = null;
  let recoveryCompanionWatchdog = null;
  let shutdownPromise = null;
  let peerUpdatePromise = Promise.resolve();
  const serviceLog = (message = "") => writeWwLog(stdout, message);
  const peerHasStagedRelease = async (releaseInfo = {}) => {
    const peerMachineId = String(config.peer.machineId || "").trim();
    const peerHost = String(config.peer.host || "").trim();
    if (!peerMachineId) {
      return true;
    }
    if (!peerHost) {
      return false;
    }

    const client = createRemoteWwClient({
      ...config.peer,
      localMachineId: String(config.service.machineId || serviceInfo?.machineId || "").trim(),
    });
    const update = await client.getUpdateStatus({ timeoutMs: 3_000 });
    if (Number(update?.protocol) !== WW_UPDATE_PROTOCOL_VERSION) {
      const error = new Error(`The paired PC does not support WorkWire update protocol ${WW_UPDATE_PROTOCOL_VERSION}.`);
      error.code = "ERR_WW_UPDATE_PROTOCOL_MISMATCH";
      throw error;
    }
    return String(update?.source?.hash || "").trim() === String(releaseInfo?.updateHash || "").trim();
  };
  const rememberIncomingPeerIdentity = async (peer = {}) => {
    const machineId = String(peer.machineId || "").trim();
    if (!machineId || String(config.peer.machineId || "").trim()) {
      return;
    }

    config = await updateWwConfig((current) => rememberPeer(current, {
      ...current.peer,
      machineId,
    }));
  };
  const queueDesktopLaunch = async (request = {}) => {
    const launchArgs = buildWwDesktopLaunchArgsFromPeerRequest(request, {
      service: {
        host: serviceInfo?.bindHost || serviceInfo?.host || config.service.host,
        port: serviceInfo?.port || config.service.port,
        token: serviceToken,
      },
    });
    const peerValueIndex = launchArgs.indexOf("--peer");
    const peerValue = peerValueIndex === -1 ? "" : String(launchArgs[peerValueIndex + 1] || "").trim();

    if (!peerValue) {
      const error = new Error("WW peer launch request did not include a reachable requester host.");
      error.code = "ERR_WW_LAUNCH_REQUEST";
      throw error;
    }

    if (desktopLaunchPending) {
      return {
        action: "pending",
      };
    }

    desktopLaunchPending = true;
    setTimeoutImpl(async () => {
      try {
        const child = launchDesktopImpl({
          argv: launchArgs,
        });
        child?.unref?.();
        appendWwLogLine(`[WW] Requested local WorkWire desk launch for ${peerValue}`);
      } catch (error) {
        writeWwLog(stderr, `Unable to launch WorkWire desktop: ${error.message}`);
        processImpl.exitCode = 1;
      } finally {
        setTimeoutImpl(() => {
          desktopLaunchPending = false;
        }, 1_000);
      }
    }, 75);

    return {
      action: "spawning",
    };
  };

  const serviceToken = String(flags.token || config.service.token || "");
  const serviceTrustId = deriveWwTrustId(serviceToken);

  service = createWwServiceImpl({
    host: String(flags.host || config.service.host || "0.0.0.0"),
    port: normalizePort(flags.port, config.service.port),
    machineId: String(config.service.machineId || ""),
    token: serviceToken,
    name: String(flags.name || config.service.name || config.service.name),
    rootPath: String(config.service.rootPath || resolveWwPortalRoot()),
    log: serviceLog,
    onLaunchDesktop: queueDesktopLaunch,
    onPairPeer: rememberIncomingPeerIdentity,
    getTrustedPeerMachineId: () => String(config.peer.machineId || "").trim(),
    getMirrorStatus: () => mirror?.getStatus?.() || null,
    updateBundlePath: path.join(__dirname, "dist", "ww", `ww-linux-${process.arch}.tar.gz`),
  });

  let serviceInfo;
  try {
    serviceInfo = await service.start();
  } catch (error) {
    writeWwLog(stderr, error.message);
    processImpl.exitCode = 1;
    return null;
  }

  if (serviceInfo?.machineId && serviceInfo.machineId !== config.service.machineId) {
    config = await updateWwConfig((current) => {
      current.service.machineId = serviceInfo.machineId;
      return current;
    });
  }

  recoveryCompanionWatchdog = createRecoveryCompanionWatchdogImpl({
    platform: processImpl.platform || process.platform,
    log: serviceLog,
  });
  recoveryCompanionWatchdog?.start?.();

  if (enableRecovery) {
    try {
      const recoveryConfig = await loadRecoveryConfigImpl();
      if (recoveryConfig.enabled) {
        recoveryController = createRecoveryControllerImpl({
          config: recoveryConfig,
          log: serviceLog,
        });
        recoveryInfo = await recoveryController.start();
        serviceLog(`Recovery controller: ${recoveryInfo.url}`);
        serviceLog(`Recovery boot server: ${recoveryInfo.boot.url}`);
      }
    } catch (error) {
      writeWwLog(stderr, `Recovery controller unavailable: ${error.message}`);
      recoveryController = null;
    }
  }

  beaconController = createWwLanBeaconImpl({
    ports: WW_BEACON_PORTS,
    getAnnouncement: () => {
      const buildInfo = buildWwBuildInfo({
        protocolVersion: serviceInfo?.versions?.protocol,
        appVersion: serviceInfo?.versions?.app,
        installerUrl: serviceInfo?.installerUrl,
      });
      return {
        name: serviceInfo.name,
        port: serviceInfo.port,
        servicePort: serviceInfo.port,
        machineId: String(serviceInfo.machineId || config.service.machineId || ""),
        trustId: serviceTrustId,
        versions: buildInfo.versions,
        installerUrl: buildInfo.installerUrl,
        canLaunchDesktop: true,
        updateProtocol: WW_UPDATE_PROTOCOL_VERSION,
      };
    },
    onPeer: (peer = {}) => {
      peerUpdatePromise = peerUpdatePromise.then(async () => {
        const peerMachineId = String(peer.machineId || "").trim();
        if (
          !peerMachineId
          || peerMachineId === String(config.service.machineId || "").trim()
          || peer.updateCompatibility?.ok !== true
          || !peer.trustId
          || peer.trustId !== serviceTrustId
        ) {
          return;
        }
        let refreshedPeer = null;
        config = await updateWwConfig((current) => {
          const configuredMachineId = String(current.peer.machineId || "").trim();
          if (configuredMachineId && configuredMachineId !== peerMachineId) {
            return current;
          }
          const nextPeer = {
            ...current.peer,
            label: String(peer.label || current.peer.label || peer.host),
            host: String(peer.host || current.peer.host || ""),
            port: normalizePort(peer.port, current.peer.port),
            machineId: peerMachineId,
          };
          if (
            nextPeer.label === current.peer.label
            && nextPeer.host === current.peer.host
            && nextPeer.port === current.peer.port
            && nextPeer.machineId === current.peer.machineId
          ) {
            return current;
          }
          refreshedPeer = nextPeer;
          return rememberPeer(current, nextPeer);
        });
        if (refreshedPeer) {
          serviceLog(`WW refreshed peer route for ${refreshedPeer.label} at ${refreshedPeer.host}:${refreshedPeer.port}`);
        }
      });
      return peerUpdatePromise;
    },
    log: serviceLog,
  });
  await beaconController.start();

  mirror = createWwMirrorImpl({
    rootPath: serviceInfo.rootPath,
    statePath: path.join(path.dirname(WW_CONFIG_PATH), "ww-mirror-state.json"),
    peer: config.peer,
    getPeer: () => config.peer,
    machineId: config.service.machineId,
    expectedRemoteRootPath: String(config.peer.remotePath || "").trim() || serviceInfo.rootPath,
    isReadyToSync: () => {
      const activity = service?.getActivityStatus?.();
      if (!activity) return true;
      return Number(activity.activeRequests) === 0
        && Date.now() - Number(activity.lastMutationAt || 0) >= WW_MIRROR_MUTATION_IDLE_MS;
    },
    log: serviceLog,
  });
  mirror.start();

  serviceLog(`WW service ready for ${serviceInfo.name}`);
  serviceLog(`Config: ${WW_CONFIG_PATH}`);
  serviceLog(`Portal: ${serviceInfo.rootPath}`);
  serviceLog(`Portal environment: ${resolveWwPortalEnvironmentRoot(serviceInfo.rootPath)}`);
  serviceLog("URLs:");
  for (const url of serviceInfo.urls) {
    serviceLog(`- ${url}`);
  }

  const shutdown = async (exitCode = 0) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      releaseActivator?.stop();
      await peerUpdatePromise.catch(() => {});
      await mirror?.stop().catch(() => {});
      await beaconController?.stop().catch(() => {});
      recoveryCompanionWatchdog?.stop?.();
      await recoveryController?.stop().catch(() => {});
      await service.stop().catch(() => {});
      processImpl.exit(Number(exitCode) || 0);
    })();
    return shutdownPromise;
  };

  releaseActivator = createWwReleaseActivatorImpl({
    log: serviceLog,
    isReadyToActivate: peerHasStagedRelease,
    onActivationRequired: async (releaseInfo) => {
      serviceLog(`WorkWire activating ${releaseInfo.version} on this paired PC.`);
      await shutdown(75);
    },
  });
  releaseActivator.start();

  if (!keepAlive) {
    return {
      serviceInfo,
      recoveryInfo,
      releaseActivator,
      shutdown,
    };
  }

  processImpl.once("SIGINT", () => void shutdown(0));
  processImpl.once("SIGTERM", () => void shutdown(0));
  return new Promise(() => {});
}

export async function runWwConnectCommand({
  flags = {},
  positionals = [],
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const peerSpecValue = String(positionals[0] || flags.peer || "").trim();
  if (!peerSpecValue) {
    stderr.write("A peer host or host:port is required.\n");
    process.exitCode = 1;
    return null;
  }

  const peerSpec = parsePeerSpec(peerSpecValue);
  const config = await loadWwConfig();
  const nextPeer = {
    label: String(flags.name || config.peer.label || peerSpec.host),
    host: peerSpec.host,
    port: normalizePort(flags.port, peerSpec.port),
    token: String(flags.token || config.peer.token || ""),
    remotePath: String(flags["remote-path"] || config.peer.remotePath || config.ui.remotePath || ""),
  };

  const nextConfig = rememberPeer(config, nextPeer);
  await saveWwConfig(nextConfig);

  stdout.write(`Saved WW peer ${nextPeer.host}:${nextPeer.port}\n`);
  stdout.write(`Config: ${WW_CONFIG_PATH}\n`);
  return nextConfig;
}

export async function runWwPairCommand({
  flags = {},
  positionals = [],
  stdout = process.stdout,
  stderr = process.stderr,
  loadConfigImpl = loadWwConfig,
  saveConfigImpl = saveWwConfig,
} = {}) {
  const pairingPathValue = String(positionals[0] || flags.file || "").trim();
  if (!pairingPathValue) {
    stderr.write("A WorkWire pairing file is required.\n");
    process.exitCode = 1;
    return null;
  }

  const pairingPath = path.resolve(pairingPathValue);
  let profile;
  try {
    profile = JSON.parse(await fs.promises.readFile(pairingPath, "utf8"));
  } catch (error) {
    stderr.write(`Unable to read WorkWire pairing file: ${error.message}\n`);
    process.exitCode = 1;
    return null;
  }

  if (profile?.kind !== WW_PAIRING_PROFILE_KIND) {
    stderr.write(`Unsupported WorkWire pairing file. Expected kind ${WW_PAIRING_PROFILE_KIND}.\n`);
    process.exitCode = 1;
    return null;
  }

  const token = String(profile.token || "").trim();
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) {
    stderr.write("The WorkWire pairing file does not contain a valid shared token.\n");
    process.exitCode = 1;
    return null;
  }

  const config = await loadConfigImpl();
  config.service.token = token;
  config.peer = {
    ...config.peer,
    label: "",
    host: "",
    port: normalizePort(profile.port, config.peer.port || config.service.port),
    machineId: "",
    token,
    remotePath: "",
  };
  config.recentPeers = [];
  const nextConfig = await saveConfigImpl(config);

  stdout.write(`Applied WorkWire pairing profile from ${pairingPath}\n`);
  stdout.write(`Preserved this PC's machine identity: ${nextConfig.service.machineId}\n`);
  stdout.write(`Restart ${WW_SYSTEMD_USER_UNIT_NAME} or relaunch WorkWire to activate the new pairing.\n`);
  return nextConfig;
}

export async function runWwConfigCommand({
  stdout = process.stdout,
  flags = {},
} = {}) {
  const config = await loadWwConfig();
  const printableConfig = structuredClone(config);
  if (flags["show-secrets"] !== true) {
    if (printableConfig.service?.token) {
      printableConfig.service.token = "[REDACTED]";
    }
    if (printableConfig.peer?.token) {
      printableConfig.peer.token = "[REDACTED]";
    }
    for (const peer of printableConfig.recentPeers || []) {
      if (peer.token) {
        peer.token = "[REDACTED]";
      }
    }
  }
  stdout.write(`WW config path: ${WW_CONFIG_PATH}\n`);
  stdout.write(`WW log path: ${path.join(path.dirname(WW_CONFIG_PATH), "ww.log")}\n`);
  stdout.write(`${JSON.stringify(printableConfig, null, 2)}\n`);
  return config;
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return fs.realpathSync(process.argv[1]) === __filename;
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

export async function runWwCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  launchDesktopImpl = launchWwDesktop,
  resolveLocalServiceImpl = resolveLocalWwBackgroundService,
  restartLocalServiceImpl = restartManagedLocalWwBackgroundService,
} = {}) {
  if (argv[0] === "recovery") {
    return runRecoveryCli({
      argv: argv.slice(1),
      stdout,
      stderr,
      processImpl: process,
    });
  }

  if (wantsWwHelp(argv)) {
    printWwHelp(stdout, {
      engineering: wantsWwEngineeringHelp(argv),
    });
    return null;
  }

  const parsed = parseWwArgv(argv);
  if (parsed.command === "serve") {
    return runServeCommand({
      flags: parsed.flags,
      stdout,
      stderr,
      launchDesktopImpl,
    });
  }

  if (parsed.command === "connect") {
    return runWwConnectCommand({
      flags: parsed.flags,
      positionals: parsed.positionals,
      stdout,
      stderr,
    });
  }

  if (parsed.command === "pair") {
    return runWwPairCommand({
      flags: parsed.flags,
      positionals: parsed.positionals,
      stdout,
      stderr,
    });
  }

  if (parsed.command === "config") {
    return runWwConfigCommand({
      stdout,
      flags: parsed.flags,
    });
  }

  const normalizedArgv = normalizeWwDesktopArgv(argv);
  let launchArgv = normalizedArgv;
  if (!normalizedArgv.includes("--service-host")) {
    let localService = await resolveLocalServiceImpl({
      requireCompatibility: true,
    }).catch(() => null);
    if (localService?.peer?.host && localService.compatible === false) {
      let restarted = false;
      try {
        restarted = await restartLocalServiceImpl({
          localService,
          stderr,
        });
      } catch {}
      if (restarted) {
        stderr.write(`Restarted ${WW_SYSTEMD_USER_UNIT_NAME} to load WW ${WW_APP_VERSION}.\n`);
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await waitFor(250);
          localService = await resolveLocalServiceImpl({
            requireCompatibility: true,
          }).catch(() => null);
          if (!localService?.peer?.host || localService.compatible !== false) {
            break;
          }
        }
      }

      if (localService?.peer?.host && localService.compatible === false) {
        stderr.write(`${buildStaleLocalWwServiceMessage(localService)}\n`);
        process.exitCode = 1;
        return null;
      }
    }

    if (localService?.peer?.host) {
      launchArgv = [
        ...buildWwDesktopServiceAttachArgs(localService.peer),
        ...normalizedArgv,
      ];
    }
  }

  let child;
  try {
    child = launchDesktopImpl({
      argv: launchArgv,
      stderr,
    });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return null;
  }

  child.on("error", (error) => {
    stderr.write(`Unable to launch WorkWire: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  return child;
}

if (isDirectExecution()) {
  await runWwCli();
}

export function normalizeWwDesktopArgv(argv = []) {
  const parsed = parseWwArgv(argv);
  const combinedRemote = parseCombinedRemoteSpec(parsed.flags.remote);
  const normalizedArgv = [...argv];

  if (combinedRemote.peer) {
    if (!parsed.flags.peer) {
      normalizedArgv.push("--peer", `${combinedRemote.peer.host}:${combinedRemote.peer.port}`);
    }
    if (!parsed.flags["remote-path"] && combinedRemote.remotePath) {
      normalizedArgv.push("--remote-path", combinedRemote.remotePath);
    }
  }

  return normalizedArgv;
}
