import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  net,
  protocol,
  session as electronSession,
  shell,
} from "electron";
import {
  APP_PROTOCOL_SCHEME,
  APP_WINDOW_URL,
  isTrustedAppUrl,
  registerAppProtocol,
} from "./app-protocol.mjs";
import {
  configureWwElectronAppIdentity,
  ensureLinuxWwDesktopEntry,
  WORKWIRE_APP_NAME,
} from "./linux-integration.mjs";
import { WW_BEACON_PORTS, createWwLanBeacon } from "../lib/ww-beacon.mjs";
import { buildWwBuildInfo } from "../lib/ww-compat.mjs";
import { discoverLanPeers } from "../lib/ww-discovery.mjs";
import {
  WW_MACHINE_ROOT_PATH,
  createLocalEndpoint,
  createRemoteEndpoint,
} from "../lib/ww-endpoint.mjs";
import {
  collectLanInterfaceRecords,
  selectReachableLanAddressForPeer,
} from "../lib/ww-network.mjs";
import { isPathInsideRoot } from "../lib/ww-fs.mjs";
import { transferSelections } from "../lib/ww-transfer.mjs";
import { createWwService } from "../lib/ww-service.mjs";
import { createWwMirror } from "../lib/ww-mirror.mjs";
import { createRemoteWwClient } from "../lib/ww-client.mjs";
import {
  WW_UPDATE_PROTOCOL_VERSION,
  createWwReleaseActivator,
} from "../lib/ww-update.mjs";
import {
  measurePerformance,
  performanceDiagnosticsEnabled,
  startPerformanceMonitor,
} from "../lib/ww-performance.mjs";
import {
  WW_CONFIG_PATH,
  buildDefaultWwConfig,
  deriveWwTrustId,
  loadWwConfig,
  normalizeConflictPolicy,
  normalizePort,
  parsePeerSpec,
  rememberPeer,
  resolveWwPortalEnvironmentRoot,
  resolveWwPortalRoot,
  updateWwConfig,
  WW_PORTAL_DIRNAME,
  WW_PORTAL_ENVIRONMENT_DIRNAME,
} from "../lib/ww-config-store.mjs";
import {
  buildPeerLaunchSuppression,
  buildWwLaunchIntent,
  parseWwDesktopFlags,
  peerLaunchSuppressionMatches,
} from "../lib/ww-launch-intent.mjs";
import { createDesktopRecoveryManager } from "./ww-recovery-main.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_BASE_DIR = path.resolve(__dirname, "..");
const WW_ASSET_DIR = path.join(APP_BASE_DIR, "desktop", "ww");
const WW_DESK_WINDOW_URL = APP_WINDOW_URL;
const WW_LOG_PATH = path.join(path.dirname(WW_CONFIG_PATH), "ww.log");
const REMOTE_SYNC_INTERVAL_MS = 1_500;
const LAN_SWEEP_COOLDOWN_MS = 20_000;
const BEACON_PEER_STALE_MS = 10_000;
const LOCAL_WATCH_REFRESH_DEBOUNCE_MS = 150;
const WINDOW_ICON_CANDIDATE_RELATIVE_PATHS = [
  path.join("desktop", "assets", "workwire", "icon.png"),
  path.join("desktop", "assets", "workwire", "icon.ico"),
];

// Establish the native desktop identity before Electron computes userData or
// acquires the singleton lock. In development Electron otherwise falls back to
// the generic "Electron" identity, which breaks GNOME/Wayland launcher
// grouping and can collide with unrelated Electron applications.
configureWwElectronAppIdentity(app);

const SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();

if (!SINGLE_INSTANCE_LOCK) {
  // A primary WorkWire process already owns the window. Exit immediately so a
  // duplicate launcher process never lingers as a ghost Dash instance.
  app.exit(0);
}

if (!app.isReady()) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

if (process.platform === "win32") {
  app.setAppUserModelId(WORKWIRE_APP_NAME);
}

let mainWindow = null;
let config = buildDefaultWwConfig();
let persistedConfig = null;
let configPersistence = Promise.resolve();
let serviceController = null;
let serviceInfo = null;
let serviceError = null;
let attachedServicePeer = null;
let remoteEndpoint = null;
let remoteInfo = null;
let remoteError = null;
let autoLinkPromise = null;
let autoLinkTimer = null;
let beaconController = null;
let mirrorController = null;
let releaseActivator = null;
let recoveryManager = null;
const beaconPeerCache = new Map();
let lastLanSweepAt = 0;
let localEndpoint = createLocalEndpoint({
  name: os.hostname(),
  rootPath: resolveWwPortalRoot(),
});
let operationState = {
  id: 0,
  active: false,
  stage: "idle",
  label: "",
  kind: "",
  fromSide: "",
  toSide: "",
  totals: null,
  transferredFiles: 0,
  transferredBytes: 0,
  processedFiles: 0,
  processedBytes: 0,
  skippedFiles: 0,
  skippedLinks: 0,
  currentName: "",
  currentFileBytes: 0,
  currentFileTotalBytes: 0,
  bytesPerSecond: 0,
  estimatedSecondsRemaining: null,
  startedAt: 0,
  updatedAt: 0,
  completedAt: 0,
  durationMs: 0,
  error: null,
};
let operationSequence = 0;
let notifications = [];
let activityFeed = [];
let peerLaunchSuppression = null;
let peerStateMutation = Promise.resolve();
let remoteSyncTimer = null;
let remoteSyncPromise = null;
const paneRefreshGeneration = {
  local: 0,
  remote: 0,
};
let launchIntentsReady = false;
const pendingLaunchArgv = [];
const mainPerformanceMonitor = startPerformanceMonitor({ scope: "electron-main" });
const paneWatchers = {
  local: null,
};
const paneRefreshDebounceTimers = {
  local: null,
};
const paneState = {
  local: {
    path: "",
    listing: null,
    error: null,
    loading: false,
  },
  remote: {
    path: "",
    listing: null,
    error: null,
    loading: false,
  },
};
const explorerState = {
  open: false,
  side: "local",
  homePath: os.homedir(),
  path: "",
  listing: null,
  error: null,
};

function formatErrorMessage(error, fallback = "WW failed.") {
  return String(error?.message || fallback);
}

function appendLogLine(message) {
  const line = `[${new Date().toISOString()}] ${String(message || "")}\n`;
  try {
    fs.mkdirSync(path.dirname(WW_LOG_PATH), { recursive: true });
    fs.appendFileSync(WW_LOG_PATH, line, "utf8");
  } catch {}
}

function logInfo(message) {
  console.log(message);
  appendLogLine(message);
}

function reportRuntimeError(error, fallback = "WW failed.") {
  const message = formatErrorMessage(error, fallback);
  console.error(`[WW] ${message}`, error);
  appendLogLine(`[WW] ERROR ${message}`);
  pushNotification(message, "error");
  pushActivity("Runtime error", message, {
    level: "error",
    category: "system",
  });
  sendEvent("error", { message });
}

function getPathApi(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function clone(value) {
  if (value == null) {
    return value;
  }

  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function pickPreferredString(primaryValue, fallbackValue = "") {
  const primary = String(primaryValue ?? "").trim();
  if (primary) {
    return primary;
  }
  return String(fallbackValue ?? "").trim();
}

function resolveAppIcon() {
  const iconPath = WINDOW_ICON_CANDIDATE_RELATIVE_PATHS
    .map((candidate) => path.join(APP_BASE_DIR, candidate))
    .find((candidate) => fs.existsSync(candidate)) || null;
  if (!iconPath) return null;

  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty() ? null : { image, path: iconPath };
}

function configureMainWindowSecurity(window) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url)) {
      event.preventDefault();
    }
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

function installAppSessionSecurity() {
  const defaultSession = electronSession.defaultSession;
  if (!defaultSession) {
    return;
  }

  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.setDevicePermissionHandler?.(() => false);
}

function assertTrustedIpcSender(event) {
  const trustedWindow = [mainWindow].some((window) => (
    window
    && !window.isDestroyed()
    && event.sender === window.webContents
  ));

  if (trustedWindow && isTrustedAppUrl(event?.senderFrame?.url)) {
    return;
  }

  throw new Error("Blocked IPC from an untrusted renderer.");
}

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event);
    return measurePerformance("electron.ipc", { channel }, () => handler(event, ...args));
  });
}

function queuePeerStateMutation(task) {
  const next = peerStateMutation.then(() => task(), () => task());
  peerStateMutation = next.catch(() => {});
  return next;
}

function applyLaunchIntentToConfig(intent = {}) {
  if (intent.showHidden) {
    config.ui.showHidden = true;
  }

  if (intent.service?.host) {
    attachedServicePeer = {
      host: String(intent.service.host || "").trim(),
      port: normalizePort(intent.service.port, config.service.port || 4851),
      token: pickPreferredString(intent.service.token, config.service.token || ""),
    };
  }

  if (intent.peer?.host) {
    const currentPeerHost = String(config.peer.host || "").trim();
    config.peer.host = intent.peer.host;
    config.peer.port = normalizePort(intent.peer.port, config.peer.port || 4851);
    if (intent.peer.machineId) {
      config.peer.machineId = intent.peer.machineId;
    } else if (currentPeerHost && currentPeerHost !== intent.peer.host) {
      config.peer.machineId = "";
    }
    if (intent.peer.token) {
      config.peer.token = intent.peer.token;
    }
    if (intent.peer.label) {
      config.peer.label = intent.peer.label;
    }
  }

  if (intent.localPath) {
    paneState.local.path = intent.localPath;
  } else if (!paneState.local.path) {
    paneState.local.path = getPaneEnvironmentRoot("local") || config.service.rootPath;
  }

  if (intent.remotePath) {
    paneState.remote.path = intent.remotePath;
  } else if (!paneState.remote.path) {
    paneState.remote.path = config.ui.remotePath || "";
  }

  const nextSuppression = buildPeerLaunchSuppression(intent);
  if (nextSuppression) {
    peerLaunchSuppression = nextSuppression;
  }
}

async function applyLaunchIntent(intent = {}) {
  applyLaunchIntentToConfig(intent);
  await persistConfig();

  if (intent.service?.host && !serviceController && !serviceInfo) {
    await attachToExistingLocalService(intent.service);
  }

  await queuePeerStateMutation(async () => {
    if (intent.localPath || intent.showHidden) {
      try {
        await refreshPane("local", paneState.local.path || config.service.rootPath);
      } catch {
        await refreshPane("local", config.service.rootPath).catch(() => {});
      }
    }

    if (intent.peer?.host) {
      await connectRemoteNow({
        host: intent.peer.host,
        port: intent.peer.port,
        machineId: intent.peer.machineId || config.peer.machineId || "",
        token: intent.peer.token ?? config.peer.token,
        label: intent.peer.label || config.peer.label || intent.peer.host,
        remotePath: intent.remotePath || paneState.remote.path || config.ui.remotePath || "",
      }, {
        explicit: true,
      });
      if (buildPeerLaunchSuppression(intent)) {
        peerLaunchSuppression = null;
      }
      return;
    }

    if ((intent.remotePath || intent.showHidden) && remoteEndpoint) {
      const targetPath = intent.remotePath || paneState.remote.path || remoteInfo?.rootPath || config.ui.remotePath || "";
      try {
        await refreshPane("remote", targetPath);
      } catch {
        if (targetPath !== remoteInfo?.rootPath && remoteInfo?.rootPath) {
          await refreshPane("remote", remoteInfo.rootPath).catch(() => {});
        }
      }
    }
  });
}

function queueLaunchArgs(argv = []) {
  const nextArgv = Array.isArray(argv) ? [...argv] : [];
  if (!launchIntentsReady) {
    pendingLaunchArgv.push(nextArgv);
    return Promise.resolve();
  }

  const intent = buildWwLaunchIntent(parseWwDesktopFlags(nextArgv));
  return applyLaunchIntent(intent);
}

async function flushPendingLaunchArgs() {
  if (!launchIntentsReady || pendingLaunchArgv.length === 0) {
    return;
  }

  const queuedArgv = pendingLaunchArgv.splice(0, pendingLaunchArgv.length);
  for (const argv of queuedArgv) {
    await queueLaunchArgs(argv);
  }
}

function normalizePeerLaunchRequest(request = {}) {
  const requesterInput = request?.requester && typeof request.requester === "object"
    ? request.requester
    : {};
  const requesterHost = String(requesterInput.host || request.requesterHostHint || "").trim();
  return {
    requester: {
      host: requesterHost,
      port: normalizePort(requesterInput.port, 4851),
      machineId: String(requesterInput.machineId || requesterInput.installationId || "").trim(),
      token: String(requesterInput.token || "").trim(),
      name: String(requesterInput.name || requesterInput.label || requesterHost).trim(),
    },
    localPath: String(request.localPath || "").trim(),
    remotePath: String(request.remotePath || requesterInput.rootPath || "").trim(),
  };
}

function getRequesterHostForPeerLaunch(info = serviceInfo, peerHost = "") {
  const bindHost = String(info?.bindHost || "").trim();
  if (bindHost && bindHost !== "0.0.0.0" && bindHost !== "::") {
    return bindHost;
  }

  return selectReachableLanAddressForPeer(peerHost, {
    networkInterfaces: os.networkInterfaces(),
  });
}

function getLiveWindows() {
  return [mainWindow].filter((window) => window && !window.isDestroyed());
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function pushNotification(message, level = "info") {
  notifications = [
    {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      level,
      message: String(message || ""),
      at: new Date().toISOString(),
    },
    ...notifications,
  ].slice(0, 8);
}

function pushActivity(title, detail = "", {
  level = "info",
  category = "system",
} = {}) {
  activityFeed = [
    {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: String(title || ""),
      detail: String(detail || ""),
      level,
      category,
      at: new Date().toISOString(),
    },
    ...activityFeed,
  ].slice(0, 24);
}

function describeSide(side) {
  if (side === "machine") {
    return "This PC files";
  }
  if (side === "remote-machine") {
    return "Other PC files";
  }
  return side === "local" ? "This PC" : "Other PC";
}

function summarizePaths(paths = [], maxItems = 3) {
  const normalized = Array.isArray(paths)
    ? paths.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (normalized.length === 0) {
    return "";
  }

  const summary = normalized.slice(0, maxItems).join(", ");
  if (normalized.length <= maxItems) {
    return summary;
  }

  return `${summary}, +${normalized.length - maxItems} more`;
}

function serializePeer(peer = {}) {
  const { token: _token, ...safePeer } = clone(peer);
  return safePeer;
}

function serializeEndpointInfoForUi(info, side) {
  if (!info) {
    return clone(info);
  }

  const environmentRoot = getPaneEnvironmentRoot(side);
  return {
    ...clone(info),
    ...(environmentRoot ? { rootPath: environmentRoot } : {}),
  };
}

function serializeState() {
  return {
    configPath: WW_CONFIG_PATH,
    logPath: WW_LOG_PATH,
    service: {
      info: serializeEndpointInfoForUi(serviceInfo, "local"),
      error: serviceError,
    },
    peer: {
      saved: serializePeer(config.peer),
      recent: config.recentPeers.map((peer) => serializePeer(peer)),
      info: serializeEndpointInfoForUi(remoteInfo, "remote"),
      connected: Boolean(remoteEndpoint && remoteInfo),
      error: remoteError,
    },
    panes: clone(paneState),
    explorer: clone(explorerState),
    ui: {
      showHidden: Boolean(config.ui.showHidden),
      conflictPolicy: normalizeConflictPolicy(config.ui.conflictPolicy),
      portalName: WW_PORTAL_DIRNAME,
      portalEnvironmentName: WW_PORTAL_ENVIRONMENT_DIRNAME,
    },
    operation: clone(operationState),
    notifications: clone(notifications),
    activity: clone(activityFeed),
    recovery: recoveryManager?.getState() || null,
    app: {
      windows: {
        main: Boolean(mainWindow && !mainWindow.isDestroyed()),
      },
    },
  };
}

function serializeEventState(type, payload) {
  if (type === "recovery") {
    return { recovery: recoveryManager?.getState() || null };
  }
  if (type === "operation") {
    return {
      operation: clone(operationState),
      notifications: clone(notifications),
      activity: clone(activityFeed),
    };
  }
  if (type === "explorer") {
    return { explorer: clone(explorerState) };
  }
  if (type === "loading" && paneState[payload?.side]) {
    const pane = paneState[payload.side];
    return {
      panes: {
        [payload.side]: {
          path: pane.path,
          error: pane.error,
          loading: pane.loading,
        },
      },
    };
  }
  if ((type === "listing" || type === "error" || type === "loading") && paneState[payload?.side]) {
    return { panes: { [payload.side]: clone(paneState[payload.side]) } };
  }
  return serializeState();
}

function sendEvent(type, payload = {}) {
  const windows = getLiveWindows();
  if (windows.length === 0) {
    return;
  }

  const eventPayload = {
    type,
    payload,
    state: serializeEventState(type, payload),
    partial: type === "operation"
      || type === "recovery"
      || type === "explorer"
      || type === "listing"
      || type === "loading"
      || (type === "error" && Boolean(paneState[payload?.side])),
  };

  if (performanceDiagnosticsEnabled()) {
    const encodedBytes = Buffer.byteLength(JSON.stringify(eventPayload));
    process.stderr.write(`[ww:performance] ${JSON.stringify({
      kind: "electron-event",
      type,
      encodedBytes,
      recipients: windows.length,
      timestamp: new Date().toISOString(),
    })}\n`);
  }

  for (const window of windows) {
    window.webContents.send("ww:event", eventPayload);
  }
}

function getRecoveryManager() {
  if (!recoveryManager) {
    recoveryManager = createDesktopRecoveryManager({
      log: logInfo,
      onState(_state, reason) {
        sendEvent("recovery", { reason });
      },
    });
  }
  return recoveryManager;
}

async function startRecoverySubsystem() {
  try {
    await getRecoveryManager().start();
    logInfo("[WW] Recovery workspace connected.");
  } catch (error) {
    // Recovery is deliberately parallel to the file desk. A controller or PXE
    // failure must remain visible without taking down file transfer.
    logInfo(`[WW] Recovery workspace unavailable: ${formatErrorMessage(error)}`);
    sendEvent("recovery", { reason: "startup-error" });
  }
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeConfigChanges(current, previous, desired) {
  if (valuesEqual(previous, desired)) {
    return clone(current);
  }
  if (isPlainObject(previous) && isPlainObject(desired) && isPlainObject(current)) {
    const merged = clone(current);
    for (const key of Object.keys(desired)) {
      merged[key] = mergeConfigChanges(current[key], previous[key], desired[key]);
    }
    for (const key of Object.keys(previous)) {
      if (!Object.hasOwn(desired, key)) {
        delete merged[key];
      }
    }
    return merged;
  }
  return clone(desired);
}

async function persistConfig() {
  const desiredConfig = clone(config);
  const previousConfig = clone(persistedConfig || config);
  const saveTask = configPersistence.then(async () => {
    const savedConfig = await updateWwConfig((current) => (
      mergeConfigChanges(current, previousConfig, desiredConfig)
    ));
    const pendingConfig = mergeConfigChanges(savedConfig, desiredConfig, config);
    persistedConfig = clone(savedConfig);
    config = pendingConfig;
    return config;
  });
  configPersistence = saveTask.catch(() => {});
  return saveTask;
}

function wait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function stopPaneWatcher(side) {
  if (!paneRefreshDebounceTimers[side]) {
    // no-op
  } else {
    clearTimeout(paneRefreshDebounceTimers[side]);
    paneRefreshDebounceTimers[side] = null;
  }

  if (!paneWatchers[side]) {
    return;
  }

  try {
    paneWatchers[side].close();
  } catch {}
  paneWatchers[side] = null;
}

function scheduleWatchedPaneRefresh(side, delayMs = LOCAL_WATCH_REFRESH_DEBOUNCE_MS) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (paneRefreshDebounceTimers[side]) {
    clearTimeout(paneRefreshDebounceTimers[side]);
  }

  paneRefreshDebounceTimers[side] = setTimeout(() => {
    paneRefreshDebounceTimers[side] = null;
    void refreshPane(side).catch((error) => {
      appendLogLine(`[WW] ${side} pane auto-refresh failed: ${formatErrorMessage(error)}`);
    });
  }, Math.max(40, Number(delayMs) || LOCAL_WATCH_REFRESH_DEBOUNCE_MS));
}

function ensureLocalPaneWatcher() {
  stopPaneWatcher("local");

  const watchPath = String(paneState.local.listing?.path || paneState.local.path || "").trim();
  if (!watchPath) {
    return;
  }

  try {
    const watcher = fs.watch(watchPath, { persistent: false }, () => {
      scheduleWatchedPaneRefresh("local");
    });
    watcher.on("error", (error) => {
      appendLogLine(`[WW] Local pane watch failed: ${formatErrorMessage(error)}`);
      scheduleWatchedPaneRefresh("local", 500);
    });
    paneWatchers.local = watcher;
  } catch (error) {
    appendLogLine(`[WW] Unable to watch local pane ${watchPath}: ${formatErrorMessage(error)}`);
  }
}

function getPaneEnvironmentRoot(side) {
  if (side === "local") {
    return resolveWwPortalEnvironmentRoot(config.service.rootPath || resolveWwPortalRoot());
  }

  const remoteRootPath = String(remoteInfo?.rootPath || "").trim();
  if (!remoteRootPath) {
    return "";
  }
  return resolveWwPortalEnvironmentRoot(remoteRootPath, {
    pathApi: getPathApi(remoteInfo?.platform),
  });
}

function clampPaneTargetPath(side, requestedPath = "") {
  const environmentRoot = getPaneEnvironmentRoot(side);
  const raw = String(requestedPath || "").trim();
  if (!environmentRoot) {
    return raw;
  }
  if (!raw) {
    return environmentRoot;
  }

  const pathApi = getPathApi(side === "remote" ? remoteInfo?.platform : process.platform);
  const resolved = pathApi.isAbsolute(raw)
    ? pathApi.normalize(raw)
    : pathApi.resolve(environmentRoot, raw);
  const relativePath = pathApi.relative(environmentRoot, resolved);
  if (relativePath === "") {
    return environmentRoot;
  }
  if (relativePath.startsWith("..") || pathApi.isAbsolute(relativePath)) {
    return environmentRoot;
  }
  return resolved;
}

function clampListingToEnvironment(listing, environmentRoot) {
  if (!listing || !environmentRoot) {
    return listing;
  }

  listing.rootPath = environmentRoot;
  if (
    listing.path === environmentRoot
    || !listing.parentPath
    || !isPathInsideRoot(listing.parentPath, environmentRoot)
  ) {
    listing.parentPath = null;
  }
  return listing;
}

function isMissingPathError(error) {
  return error?.code === "ENOENT"
    || error?.status === 404
    || /ENOENT|no such file/i.test(String(error?.message || ""));
}

function disconnectRemoteForRefreshError(error) {
  return queuePeerStateMutation(async () => {
    setRemoteUnavailable(buildPeerLinkFailureMessage(error, {
      foundPeer: true,
    }));
    sendEvent("state");
  });
}

function listingsEqual(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.path !== right.path
    || left.parentPath !== right.parentPath
    || left.rootPath !== right.rootPath
  ) return false;
  const leftItems = Array.isArray(left.items) ? left.items : [];
  const rightItems = Array.isArray(right.items) ? right.items : [];
  if (leftItems.length !== rightItems.length) return false;
  for (let index = 0; index < leftItems.length; index += 1) {
    const leftItem = leftItems[index];
    const rightItem = rightItems[index];
    if (
      leftItem.path !== rightItem.path
      || leftItem.name !== rightItem.name
      || leftItem.kind !== rightItem.kind
      || Number(leftItem.size) !== Number(rightItem.size)
      || Number(leftItem.mtimeMs) !== Number(rightItem.mtimeMs)
      || leftItem.error?.code !== rightItem.error?.code
      || leftItem.error?.message !== rightItem.error?.message
    ) return false;
  }
  return true;
}

async function refreshPane(side, targetPath = null) {
  const pane = paneState[side];
  const endpoint = side === "local" ? localEndpoint : remoteEndpoint;
  const generation = ++paneRefreshGeneration[side];
  if (!endpoint) {
    pane.error = side === "remote" ? getWaitingForPeerMessage() : "Local endpoint unavailable.";
    pane.listing = null;
    pane.loading = false;
    sendEvent("error", { side, message: pane.error });
    return null;
  }

  const environmentRoot = getPaneEnvironmentRoot(side);
  const requestedPath = clampPaneTargetPath(side, String(targetPath || pane.path || "").trim());
  const showLoading = targetPath != null && requestedPath !== pane.path;
  if (showLoading) {
    pane.loading = true;
    pane.error = null;
    sendEvent("loading", { side });
  }

  try {
    let listing;
    try {
      listing = await endpoint.listDirectory({
        path: requestedPath,
        includeHidden: Boolean(config.ui.showHidden),
      });
    } catch (error) {
      if (!environmentRoot || requestedPath !== environmentRoot || !isMissingPathError(error)) {
        throw error;
      }
      await endpoint.createDirectory({ path: environmentRoot });
      listing = await endpoint.listDirectory({
        path: requestedPath,
        includeHidden: Boolean(config.ui.showHidden),
      });
    }
    const currentEndpoint = side === "local" ? localEndpoint : remoteEndpoint;
    if (generation !== paneRefreshGeneration[side] || endpoint !== currentEndpoint) {
      return null;
    }
    clampListingToEnvironment(listing, environmentRoot);
    const listingChanged = !listingsEqual(pane.listing, listing);
    pane.path = listing.path;
    if (listingChanged) pane.listing = listing;
    pane.error = null;
    pane.loading = false;
    if (side === "local") {
      ensureLocalPaneWatcher();
    }
    if (listingChanged || showLoading) sendEvent("listing", { side });
    return pane.listing;
  } catch (error) {
    const currentEndpoint = side === "local" ? localEndpoint : remoteEndpoint;
    if (generation !== paneRefreshGeneration[side] || endpoint !== currentEndpoint) {
      return null;
    }
    pane.error = String(error?.message || "Unable to load directory.");
    pane.listing = null;
    pane.loading = false;
    if (side === "local") {
      ensureLocalPaneWatcher();
    }
    sendEvent("error", {
      side,
      message: pane.error,
    });
    throw error;
  }
}

function scheduleRemoteSyncLoop() {
  if (remoteSyncTimer) {
    return;
  }

  remoteSyncTimer = setInterval(() => {
    if (!remoteEndpoint || !remoteInfo || operationState.active || remoteSyncPromise) {
      return;
    }

    remoteSyncPromise = refreshPane("remote").catch((error) => {
      appendLogLine(`[WW] Remote pane refresh failed: ${formatErrorMessage(error)}`);
      return disconnectRemoteForRefreshError(error);
    }).finally(() => {
      remoteSyncPromise = null;
    });
  }, REMOTE_SYNC_INTERVAL_MS);
}

function stopRemoteSyncLoop() {
  if (!remoteSyncTimer) {
    return;
  }
  clearInterval(remoteSyncTimer);
  remoteSyncTimer = null;
  remoteSyncPromise = null;
}

function getWaitingForPeerMessage() {
  return "WW is looking for the other PC on this LAN. It will link automatically when WW is open there.";
}

function getPeerNotReadyMessage() {
  return "WW found the other PC, but it is not ready yet. Keep WW open on both PCs and it will finish linking automatically.";
}

function getPeerVersionMismatchMessage() {
  return "WW found the other PC, but it needs the same WorkWire build. Reinstall or update WW from the LAN installer and it will relink automatically.";
}

function getPeerTrustMismatchMessage() {
  return "WW found another WorkWire install on this LAN, but it is not the paired Other PC.";
}

function getFriendlyPeerName(peer = config.peer, info = remoteInfo) {
  return String(info?.name || peer?.label || "").trim() || "the other PC";
}

function buildPeerLinkFailureMessage(error, {
  foundPeer = false,
} = {}) {
  const errorCode = String(error?.code || "").trim();
  if (
    errorCode === "ERR_WW_PROTOCOL_VERSION_UNKNOWN"
    || errorCode === "ERR_WW_PROTOCOL_VERSION_MISMATCH"
    || errorCode === "ERR_WW_APP_VERSION_UNKNOWN"
    || errorCode === "ERR_WW_APP_VERSION_MISMATCH"
  ) {
    appendLogLine(`[WW] Peer link blocked by build mismatch: ${formatErrorMessage(error, getPeerVersionMismatchMessage())}`);
    return getPeerVersionMismatchMessage();
  }

  if (errorCode === "ERR_UNAUTHORIZED") {
    appendLogLine(`[WW] Peer link blocked by trust scope: ${formatErrorMessage(error, getPeerTrustMismatchMessage())}`);
    return getPeerTrustMismatchMessage();
  }

  if (foundPeer) {
    return getPeerNotReadyMessage();
  }

  return getWaitingForPeerMessage();
}

function setRemoteUnavailable(message = getWaitingForPeerMessage()) {
  paneRefreshGeneration.remote += 1;
  remoteEndpoint = null;
  remoteInfo = null;
  remoteError = message;
  paneState.remote.listing = null;
  paneState.remote.error = message;
  paneState.remote.loading = false;
}

function getAttachedServicePeer() {
  if (!attachedServicePeer?.host) {
    return null;
  }

  return {
    host: String(attachedServicePeer.host || "").trim(),
    port: normalizePort(attachedServicePeer.port, config.service.port || 4851),
    token: pickPreferredString(attachedServicePeer.token, config.service.token || ""),
  };
}

async function attachToExistingLocalService(peer = getAttachedServicePeer(), {
  timeoutMs = 2_000,
  reportFailure = true,
} = {}) {
  if (!peer?.host) {
    return null;
  }

  serviceController = null;
  const endpoint = createRemoteEndpoint({
    host: peer.host,
    port: peer.port,
    token: peer.token,
    localService: true,
    label: "This PC",
    localMachineId: pickPreferredString(config.service.machineId, serviceInfo?.machineId || ""),
  });

  try {
    serviceInfo = typeof endpoint.connect === "function"
      ? await endpoint.connect({
        timeoutMs,
      })
      : await endpoint.getInfo({
        timeoutMs,
      });
    serviceError = null;
    config.service.machineId = pickPreferredString(serviceInfo.machineId, config.service.machineId || "");
    config.service.port = normalizePort(serviceInfo.port, config.service.port || 4851);
    config.service.name = pickPreferredString(serviceInfo.name, config.service.name || os.hostname());
    config.service.rootPath = pickPreferredString(serviceInfo.rootPath, config.service.rootPath || resolveWwPortalRoot());
    config.ui.localPath = config.service.rootPath;
    localEndpoint = createLocalEndpoint({
      name: config.service.name,
      rootPath: config.service.rootPath,
    });
    await persistConfig();
    pushActivity(
      "Attached to background service",
      `${peer.host}:${config.service.port} · ${config.service.rootPath}`,
      {
        level: "success",
        category: "service",
      },
    );
    return serviceInfo;
  } catch (error) {
    serviceInfo = null;
    serviceError = `WW background service is unavailable: ${formatErrorMessage(
      error,
      "Unable to reach the local WorkWire service.",
    )}`;
    if (reportFailure) {
      pushNotification(serviceError, "error");
      pushActivity("Background service unavailable", serviceError, {
        level: "error",
        category: "service",
      });
      sendEvent("state");
    }
    return null;
  }
}

async function attachToRequestedLocalServiceWithRetry(peer, {
  attempts = 16,
  delayMs = 250,
} = {}) {
  const totalAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const attached = await attachToExistingLocalService(peer, {
      timeoutMs: 350,
      reportFailure: false,
    });
    if (attached) {
      return attached;
    }
    if (attempt + 1 < totalAttempts) {
      await wait(delayMs);
    }
  }
  return null;
}

async function startLocalService() {
  attachedServicePeer = null;
  serviceError = null;
  serviceController = createWwService({
    host: String(config.service.host || "0.0.0.0"),
    port: normalizePort(config.service.port, 4851),
    machineId: String(config.service.machineId || ""),
    token: String(config.service.token || ""),
    name: String(config.service.name || os.hostname()),
    rootPath: String(config.service.rootPath || resolveWwPortalRoot()),
    log: (line) => pushNotification(line, "info"),
    onLaunchDesktop: handlePeerDesktopLaunchRequest,
    onPairPeer: rememberIncomingPeerIdentity,
    getTrustedPeerMachineId: () => String(config.peer.machineId || "").trim(),
    recoverPortCollision: false,
    updateBundlePath: path.join(APP_BASE_DIR, "dist", "ww", `ww-linux-${process.arch}.tar.gz`),
  });

  try {
    serviceInfo = await serviceController.start();
    serviceError = null;
    logInfo(
      `[WW] Local service ready on ${serviceInfo.urls.join(", ")} using ${serviceInfo.rootPath}`,
    );
    pushActivity("Local service online", serviceInfo.urls.join(" · "), {
      level: "success",
      category: "service",
    });
    config.service.machineId = serviceInfo.machineId || config.service.machineId;
    config.service.port = serviceInfo.port;
    config.service.name = serviceInfo.name;
    config.service.rootPath = serviceInfo.rootPath;
    config.ui.localPath = serviceInfo.rootPath;
    localEndpoint = createLocalEndpoint({
      name: serviceInfo.name,
      rootPath: serviceInfo.rootPath,
    });
    await persistConfig();
    await startLanBeacon();
    mirrorController = createWwMirror({
      rootPath: serviceInfo.rootPath,
      statePath: path.join(path.dirname(WW_CONFIG_PATH), "ww-mirror-state.json"),
      peer: config.peer,
      getPeer: () => config.peer,
      machineId: config.service.machineId,
      expectedRemoteRootPath: serviceInfo.rootPath,
      log: appendLogLine,
    });
    mirrorController.start();
  } catch (error) {
    serviceInfo = null;
    serviceError = String(error?.message || "Unable to start the WW service.");
    pushNotification(`WW local service failed to start: ${error.message}`, "error");
    pushActivity("Local service failed", String(error?.message || "Unable to start the WW service."), {
      level: "error",
      category: "service",
    });
  }
}

function getLocalDiscoveryAddresses() {
  const addresses = new Set();
  const add = (value) => {
    const next = String(value || "").trim();
    if (!next) {
      return;
    }
    addresses.add(next);
  };

  add(serviceInfo?.host);
  add(serviceInfo?.bindHost);

  for (const record of collectLanInterfaceRecords({
    networkInterfaces: os.networkInterfaces(),
  })) {
    add(record.address);
  }

  add("127.0.0.1");
  add("localhost");
  return [...addresses];
}

function getLocalDeploymentTrustId() {
  return deriveWwTrustId(config.service.token);
}

function getPinnedPeerMachineId() {
  return String(config.peer.machineId || "").trim();
}

function getConfiguredPeerTrustId() {
  return deriveWwTrustId(config.peer.token || config.service.token);
}

async function rememberIncomingPeerIdentity(peer = {}) {
  const machineId = String(peer.machineId || "").trim();
  if (!machineId || getPinnedPeerMachineId() === machineId) {
    return;
  }

  if (getPinnedPeerMachineId()) {
    return;
  }

  config = rememberPeer(config, {
    ...config.peer,
    machineId,
  });
  await persistConfig();
}

function buildBeaconAnnouncement() {
  if (!serviceInfo) {
    return null;
  }

  const buildInfo = buildWwBuildInfo({
    protocolVersion: serviceInfo?.versions?.protocol,
    appVersion: serviceInfo?.versions?.app,
    installerUrl: serviceInfo?.installerUrl,
  });
  return {
    name: serviceInfo.name,
    port: serviceInfo.port,
    servicePort: serviceInfo.port,
    machineId: String(config.service.machineId || serviceInfo.machineId || "").trim(),
    trustId: getLocalDeploymentTrustId(),
    versions: buildInfo.versions,
    installerUrl: buildInfo.installerUrl,
    canLaunchDesktop: true,
    updateProtocol: WW_UPDATE_PROTOCOL_VERSION,
  };
}

function pruneBeaconPeerCache(now = Date.now()) {
  for (const [key, entry] of beaconPeerCache.entries()) {
    const ageMs = now - Number(entry?.lastSeenMs || 0);
    if (!Number.isFinite(ageMs) || ageMs > BEACON_PEER_STALE_MS) {
      beaconPeerCache.delete(key);
    }
  }
}

function isSelfBeaconPeer(peer = {}) {
  const host = String(peer.host || "").trim();
  const machineId = String(peer.machineId || peer.info?.machineId || "").trim();
  if (machineId && machineId === String(serviceInfo?.machineId || config.service.machineId || "").trim()) {
    return true;
  }

  return Boolean(host) && getLocalDiscoveryAddresses().includes(host);
}

function listBeaconPeers() {
  pruneBeaconPeerCache();
  return [...beaconPeerCache.values()]
    .sort((left, right) => (
      Number(right.lastSeenMs || 0) - Number(left.lastSeenMs || 0)
      || String(left.peer?.host || "").localeCompare(String(right.peer?.host || ""))
    ))
    .map((entry) => entry.peer);
}

function rememberBeaconPeer(peer = {}) {
  if (!peer.host || isSelfBeaconPeer(peer)) {
    return;
  }

  const machineId = String(peer.machineId || peer.info?.machineId || "").trim();
  const trustId = String(peer.trustId || peer.info?.trustId || "").trim();
  const key = machineId || trustId || `${peer.host}:${peer.port}`;
  const lastSeenMs = Date.now();
  beaconPeerCache.set(key, {
    peer,
    lastSeenMs,
    lastSeenAt: new Date(lastSeenMs).toISOString(),
  });
  if (!remoteEndpoint || !remoteInfo) {
    void autoLinkRemote();
  }
}

async function startLanBeacon() {
  if (beaconController) {
    return;
  }

  beaconController = createWwLanBeacon({
    ports: WW_BEACON_PORTS,
    getAnnouncement: buildBeaconAnnouncement,
    onPeer: rememberBeaconPeer,
    log: appendLogLine,
  });
  await beaconController.start();
}

async function stopLanBeacon() {
  if (!beaconController) {
    return;
  }

  const controller = beaconController;
  beaconController = null;
  await controller.stop();
}

function buildAutoLinkCandidates(discoveredPeers = [], {
  includeSavedPeer = true,
} = {}) {
  const candidates = [];
  const seen = new Set();
  const pinnedMachineId = getPinnedPeerMachineId();
  const configuredPeerTrustId = pinnedMachineId ? "" : getConfiguredPeerTrustId();

  const append = (peer = {}, {
    discovered = false,
  } = {}) => {
    const host = String(peer.host || "").trim();
    if (!host) {
      return;
    }

    const peerMachineId = String(peer.machineId || peer.info?.machineId || "").trim();
    const peerTrustId = String(peer.trustId || peer.info?.trustId || "").trim();
    if (pinnedMachineId) {
      if (!peerMachineId || peerMachineId !== pinnedMachineId) {
        return;
      }
    } else if (discovered && configuredPeerTrustId) {
      if (!peerTrustId || peerTrustId !== configuredPeerTrustId) {
        return;
      }
    } else if (discovered && !peerTrustId && !config.peer.token) {
      return;
    }

    const normalized = {
      label: String(peer.label || peer.name || host).trim(),
      host,
      port: normalizePort(peer.port, config.peer.port || 4851),
      machineId: peerMachineId,
      trustId: peerTrustId,
      token: pickPreferredString(peer.token, ""),
      remotePath: String(peer.remotePath || "").trim(),
      compatibility: peer.compatibility && typeof peer.compatibility === "object"
        ? clone(peer.compatibility)
        : null,
    };
    const key = normalized.machineId
      ? `machine:${normalized.machineId}`
      : normalized.trustId
        ? `trust:${normalized.trustId}`
        : `${normalized.host}:${normalized.port}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(normalized);
  };

  for (const peer of listBeaconPeers()) {
    append(peer, { discovered: true });
  }

  for (const peer of discoveredPeers) {
    append(peer, { discovered: true });
  }

  if (includeSavedPeer && (config.peer.host || config.peer.machineId)) {
    append(config.peer);
  }

  return candidates;
}

function getAutoLinkCandidateKey(candidate = {}) {
  const machineId = String(candidate.machineId || "").trim();
  const trustId = String(candidate.trustId || "").trim();
  if (machineId) {
    return `machine:${machineId}`;
  }
  if (trustId) {
    return `trust:${trustId}`;
  }
  return `${String(candidate.host || "").trim()}:${normalizePort(candidate.port, 4851)}`;
}

function shouldRunLanSweep({
  interactive = false,
} = {}) {
  const now = Date.now();
  if (interactive || (now - lastLanSweepAt) >= LAN_SWEEP_COOLDOWN_MS) {
    lastLanSweepAt = now;
    return true;
  }
  return false;
}

async function tryAutoLinkCandidates(candidates = [], attempted = new Set()) {
  let lastError = null;
  let foundPeer = false;

  for (const candidate of candidates) {
    const candidateKey = getAutoLinkCandidateKey(candidate);
    if (attempted.has(candidateKey)) {
      continue;
    }
    attempted.add(candidateKey);
    foundPeer = true;

    if (candidate.compatibility?.ok === false) {
      lastError = new Error(candidate.compatibility.message);
      lastError.code = candidate.compatibility.code;
      continue;
    }

    try {
      const result = await connectRemote(candidate);
      if (remoteInfo?.capabilities?.launchDesktop) {
        void requestPeerDesktopLaunch();
      }
      return {
        result,
        foundPeer,
        lastError,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    result: null,
    foundPeer,
    lastError,
  };
}

async function autoLinkRemote({
  interactive = false,
  includeSavedPeer = true,
} = {}) {
  if (remoteEndpoint && remoteInfo) {
    return {
      peer: serializePeer(config.peer),
      info: serializeEndpointInfoForUi(remoteInfo, "remote"),
    };
  }

  if (autoLinkPromise) {
    return autoLinkPromise;
  }

  autoLinkPromise = (async () => {
    let lastError = null;
    let foundPeer = false;
    const attempted = new Set();

    const primaryCandidates = buildAutoLinkCandidates([], {
      includeSavedPeer,
    });
    const primaryAttempt = await tryAutoLinkCandidates(primaryCandidates, attempted);
    if (primaryAttempt.result) {
      return primaryAttempt.result;
    }
    foundPeer = primaryAttempt.foundPeer;
    lastError = primaryAttempt.lastError;

    if (shouldRunLanSweep({ interactive })) {
      try {
        const discoveredPeers = await discoverLanPeers({
          port: normalizePort(config.peer.port || config.service.port, 4851),
          localAddresses: getLocalDiscoveryAddresses(),
        });
        const fallbackAttempt = await tryAutoLinkCandidates(
          buildAutoLinkCandidates(discoveredPeers, {
            includeSavedPeer: false,
          }),
          attempted,
        );
        if (fallbackAttempt.result) {
          return fallbackAttempt.result;
        }
        foundPeer = foundPeer || fallbackAttempt.foundPeer;
        lastError = fallbackAttempt.lastError || lastError;
      } catch (error) {
        lastError = error;
      }
    }

    setRemoteUnavailable(buildPeerLinkFailureMessage(lastError, {
      foundPeer,
    }));
    sendEvent("state");
    if (interactive) {
      pushNotification(remoteError, "info");
    }
    return null;
  })().finally(() => {
    autoLinkPromise = null;
  });

  return autoLinkPromise;
}

function scheduleAutoLinkLoop() {
  if (autoLinkTimer) {
    return;
  }

  autoLinkTimer = setInterval(() => {
    if (remoteEndpoint && remoteInfo) {
      return;
    }
    void autoLinkRemote();
  }, 3_000);
}

function stopAutoLinkLoop() {
  if (!autoLinkTimer) {
    return;
  }
  clearInterval(autoLinkTimer);
  autoLinkTimer = null;
}

async function disconnectRemoteNow() {
  setRemoteUnavailable(getWaitingForPeerMessage());
  pushActivity("Peer disconnected", "Remote pane will relink automatically when the other PC is available.", {
    level: "info",
    category: "peer",
  });
  sendEvent("state");
}

async function disconnectRemote() {
  return queuePeerStateMutation(() => disconnectRemoteNow());
}

async function connectRemoteNow(overrides = {}, {
  explicit = false,
} = {}) {
  const nextPeer = {
    label: pickPreferredString(overrides.label, config.peer.label || overrides.host || ""),
    host: pickPreferredString(overrides.host, config.peer.host || ""),
    port: normalizePort(overrides.port, config.peer.port || 4851),
    machineId: pickPreferredString(overrides.machineId, config.peer.machineId || ""),
    token: pickPreferredString(overrides.token, pickPreferredString(config.peer.token, config.service.token)),
    remotePath: pickPreferredString(overrides.remotePath, ""),
  };

  if (!nextPeer.host) {
    throw new Error("A remote peer host is required.");
  }

  const endpoint = createRemoteEndpoint({
    ...nextPeer,
    localMachineId: pickPreferredString(config.service.machineId, serviceInfo?.machineId || ""),
  });
  const info = typeof endpoint.connect === "function"
    ? await endpoint.connect()
    : await endpoint.getInfo();
  const connectedMachineId = pickPreferredString(info.machineId, nextPeer.machineId);
  const pinnedMachineId = getPinnedPeerMachineId();
  if (!explicit && pinnedMachineId) {
    if (!connectedMachineId) {
      throw new Error("WW peer did not provide a stable machine ID.");
    }
    if (connectedMachineId !== pinnedMachineId) {
      throw new Error("Discovered WW peer did not match the paired machine.");
    }
  }

  remoteEndpoint = endpoint;
  remoteInfo = info;
  remoteError = null;
  config = rememberPeer(config, {
    ...nextPeer,
    machineId: connectedMachineId,
    remotePath: info.rootPath || nextPeer.remotePath || "",
  });
  config.ui.remotePath = info.rootPath || "";
  await persistConfig();

  const preferredPath = nextPeer.remotePath || paneState.remote.path || info.rootPath;
  try {
    await refreshPane("remote", preferredPath);
  } catch {
    if (preferredPath !== info.rootPath && info.rootPath) {
      await refreshPane("remote", info.rootPath);
    }
  }

  const peerName = getFriendlyPeerName(nextPeer, info);
  pushNotification(`WorkWire linked with ${peerName}`, "success");
  logInfo(`[WW] Connected to peer ${nextPeer.host}:${nextPeer.port}`);
  pushActivity("Peer connected", `${peerName} · ${info.rootPath || ""}`, {
    level: "success",
    category: "peer",
  });
  sendEvent("connected");
  return {
    peer: serializePeer(config.peer),
    info: serializeEndpointInfoForUi(info, "remote"),
  };
}

async function connectRemote(overrides = {}, options = {}) {
  return queuePeerStateMutation(() => connectRemoteNow(overrides, options));
}

async function reconnectPeerAfterDesktopLaunch({
  attempts = 12,
  delayMs = 750,
} = {}) {
  for (let index = 0; index < attempts; index += 1) {
    await wait(delayMs);
    try {
      await connectRemote({
        ...config.peer,
        remotePath: paneState.remote.path || config.ui.remotePath || "",
      });
      return true;
    } catch (error) {
      if (index >= attempts - 1) {
        setRemoteUnavailable(buildPeerLinkFailureMessage(error, {
          foundPeer: true,
        }));
        sendEvent("state");
        pushNotification(remoteError, "info");
        appendLogLine(`[WW] Peer reconnect failed: ${formatErrorMessage(error)}`);
        return false;
      }
    }
  }

  return false;
}

async function requestPeerDesktopLaunch() {
  if (
    !remoteEndpoint
    || !remoteInfo?.capabilities?.launchDesktop
    || !serviceInfo
  ) {
    return null;
  }

  if (peerLaunchSuppressionMatches(peerLaunchSuppression, config.peer)) {
    appendLogLine(`[WW] Skipping peer desktop launch bounce-back for ${config.peer.host}:${config.peer.port}`);
    peerLaunchSuppression = null;
    return {
      action: "suppressed",
    };
  }

  const requesterHost = getRequesterHostForPeerLaunch(
    serviceInfo,
    config.peer.host || remoteEndpoint?.peer?.host || "",
  );

  const launchPayload = {
    requester: {
      ...(requesterHost ? { host: requesterHost } : {}),
      port: serviceInfo.port,
      machineId: pickPreferredString(config.service.machineId, serviceInfo.machineId || ""),
      token: String(config.service.token || ""),
      name: serviceInfo.name,
      rootPath: serviceInfo.rootPath,
    },
    localPath: paneState.remote.path || remoteInfo?.rootPath || "",
    remotePath: paneState.local.path || serviceInfo.rootPath || "",
  };

  try {
    const launch = await remoteEndpoint.launchDesktop(launchPayload);
    const action = String(launch?.action || "requested");
    logInfo(`[WW] Requested peer desktop launch on ${config.peer.host}:${config.peer.port} (${action})`);
    pushActivity("Requested peer window", `${config.peer.host}:${config.peer.port} · ${action}`, {
      level: "info",
      category: "peer",
    });
    if (action === "spawning") {
      pushNotification(`Opening WorkWire on ${getFriendlyPeerName(config.peer, remoteInfo)}...`, "info");
      void reconnectPeerAfterDesktopLaunch();
    }
    return launch;
  } catch (error) {
    const message = String(error?.message || "Unable to launch the peer WW desktop.");
    pushNotification(`Peer desktop launch failed: ${message}`, "error");
    appendLogLine(`[WW] Peer desktop launch failed: ${message}`);
    pushActivity("Peer window request failed", message, {
      level: "error",
      category: "peer",
    });
    return null;
  }
}

async function handlePeerDesktopLaunchRequest(request = {}) {
  const launchRequest = normalizePeerLaunchRequest(request);
  if (!launchRequest.requester.host) {
    throw new Error("WW peer launch request did not include a reachable requester host.");
  }

  await queuePeerStateMutation(async () => {
    if (launchRequest.localPath) {
      try {
        await refreshPane("local", launchRequest.localPath);
      } catch {
        await refreshPane("local", config.service.rootPath).catch(() => {});
      }
    }

    await connectRemoteNow({
      host: launchRequest.requester.host,
      port: launchRequest.requester.port,
      machineId: launchRequest.requester.machineId,
      token: launchRequest.requester.token,
      label: launchRequest.requester.name,
      remotePath: launchRequest.remotePath,
    }, {
      explicit: true,
    });

    focusMainWindow();
    const requesterName = String(launchRequest.requester.name || "").trim() || "the other PC";
    pushNotification(`WW linked with ${requesterName}`, "success");
    pushActivity("Linked from peer launch", requesterName, {
      level: "success",
      category: "peer",
    });
  });
  return {
    action: "focused",
  };
}

function joinPaneChildPath(side, name) {
  const pane = paneState[side];
  const platform = side === "remote" ? remoteInfo?.platform : process.platform;
  const pathApi = getPathApi(platform);
  return pathApi.join(pane.path, name);
}

async function createItem(side, {
  name,
  kind,
  contents = "",
} = {}) {
  const endpoint = side === "local" ? localEndpoint : remoteEndpoint;
  if (!endpoint) {
    throw new Error(`${side} endpoint is unavailable.`);
  }

  const targetPath = joinPaneChildPath(side, name);
  if (kind === "directory") {
    await endpoint.createDirectory({ path: targetPath });
  } else {
    await endpoint.createFile({
      path: targetPath,
      contents,
      overwrite: false,
    });
  }

  await refreshPane(side);
  pushActivity(kind === "directory" ? "Created folder" : "Created file", `${describeSide(side)} · ${targetPath}`, {
    level: "success",
    category: "crud",
  });
}

async function renameItem(side, { targetPath, nextName } = {}) {
  const endpoint = side === "local" ? localEndpoint : remoteEndpoint;
  if (!endpoint) {
    throw new Error(`${side} endpoint is unavailable.`);
  }
  await endpoint.rename({
    path: targetPath,
    nextName,
  });
  await refreshPane(side);
  pushActivity("Renamed item", `${describeSide(side)} · ${targetPath} -> ${nextName}`, {
    level: "success",
    category: "crud",
  });
}

async function deleteItems(side, { targetPaths = [] } = {}) {
  const endpoint = side === "local" ? localEndpoint : remoteEndpoint;
  if (!endpoint) {
    throw new Error(`${side} endpoint is unavailable.`);
  }

  const results = await endpoint.trashPaths({
    paths: targetPaths,
  });
  const failures = results.filter((entry) => !entry.ok);
  if (failures.length > 0) {
    throw new Error(failures[0].error?.message || "Delete failed.");
  }

  await refreshPane(side);
  pushActivity("Moved to Recently Deleted", `${describeSide(side)} · ${targetPaths.length} item(s) · ${summarizePaths(targetPaths)}`, {
    level: "success",
    category: "crud",
  });
  return results;
}

async function listDeletedItems(side) {
  const endpoint = side === "local" ? localEndpoint : remoteEndpoint;
  if (!endpoint) {
    throw new Error(`${side} endpoint is unavailable.`);
  }
  return endpoint.listTrash();
}

async function restoreDeletedItem(side, { id } = {}) {
  const endpoint = side === "local" ? localEndpoint : remoteEndpoint;
  if (!endpoint) {
    throw new Error(`${side} endpoint is unavailable.`);
  }
  const restored = await endpoint.restoreTrashItem({ id });
  await refreshPane(side);
  pushActivity("Restored item", `${describeSide(side)} · ${restored.originalPath}`, {
    level: "success",
    category: "crud",
  });
  return restored;
}

async function runTransfer({
  fromSide,
  targetPaths,
  move = false,
  conflictPolicy = config.ui.conflictPolicy,
  sourceScope = "",
} = {}) {
  if (operationState.active) {
    const error = new Error("A file transfer is already in progress.");
    error.code = "ERR_WW_TRANSFER_BUSY";
    throw error;
  }

  const localMachineImport = fromSide === "machine";
  const remoteMachineImport = fromSide === "remote-machine";
  const machineImport = localMachineImport || remoteMachineImport;
  const sourceEndpoint = localMachineImport || fromSide === "local" ? localEndpoint : remoteEndpoint;
  const destinationEndpoint = machineImport
    ? localEndpoint
    : fromSide === "local" ? remoteEndpoint : localEndpoint;
  const destinationSide = machineImport || fromSide === "remote" ? "local" : "remote";
  const destinationPane = paneState[destinationSide];

  if (!sourceEndpoint || !destinationEndpoint) {
    throw new Error("Both panes must be available before transferring.");
  }

  const startedAt = Date.now();
  operationState = {
    id: ++operationSequence,
    active: true,
    stage: "starting",
    label: move ? "Moving items" : "Copying items",
    kind: move ? "move" : "copy",
    fromSide,
    toSide: destinationSide,
    totals: null,
    transferredFiles: 0,
    transferredBytes: 0,
    processedFiles: 0,
    processedBytes: 0,
    skippedFiles: 0,
    skippedLinks: 0,
    currentName: "",
    currentFileBytes: 0,
    currentFileTotalBytes: 0,
    bytesPerSecond: 0,
    estimatedSecondsRemaining: null,
    startedAt,
    updatedAt: startedAt,
    completedAt: 0,
    durationMs: 0,
    error: null,
  };
  config.ui.conflictPolicy = normalizeConflictPolicy(conflictPolicy);
  sendEvent("operation");

  try {
    await persistConfig();
    pushActivity(move ? "Move started" : "Copy started", `${describeSide(fromSide)} -> ${describeSide(destinationSide)} · ${summarizePaths(targetPaths)}`, {
      level: "info",
      category: "transfer",
    });
    let lastRateSampleAt = startedAt;
    let lastRateSampleBytes = 0;
    let smoothedBytesPerSecond = 0;
    const result = await transferSelections({
      sourceEndpoint,
      destinationEndpoint,
      sourcePaths: targetPaths,
      destinationDir: destinationPane.path,
      conflictPolicy: config.ui.conflictPolicy,
      move,
      sourceScope,
      onProgress(progress) {
        const now = Date.now();
        const totals = clone(progress.result?.totals || operationState.totals);
        const committedTransferredBytes = Number(progress.result?.transferredBytes) || 0;
        const bytesInFlight = Number(progress.bytesInFlight) || 0;
        const reportedTransferredBytes = committedTransferredBytes + bytesInFlight;
        const transferredBytes = progress.stage === "error"
          ? Math.max(Number(operationState.transferredBytes) || 0, reportedTransferredBytes)
          : reportedTransferredBytes;
        const reportedCurrentFileTotalBytes = Number(progress.currentBytesTotal);
        const currentFileTotalBytes = progress.currentBytesTotal != null
          && Number.isFinite(reportedCurrentFileTotalBytes)
          ? Math.max(0, reportedCurrentFileTotalBytes)
          : Number(operationState.currentFileTotalBytes) || 0;
        const currentFileBytes = progress.stage === "file-complete"
          || progress.stage === "skip"
          || progress.stage === "skip-file"
          ? currentFileTotalBytes
          : progress.stage === "complete" || progress.stage === "error"
            ? Number(operationState.currentFileBytes) || 0
            : bytesInFlight;
        const reportedProcessedBytes = (Number(progress.result?.processedBytes) || 0)
          + Math.min(bytesInFlight, currentFileTotalBytes || bytesInFlight);
        const processedBytes = progress.stage === "error"
          ? Math.max(Number(operationState.processedBytes) || 0, reportedProcessedBytes)
          : reportedProcessedBytes;
        const elapsedSinceRateSample = now - lastRateSampleAt;

        if (
          transferredBytes > lastRateSampleBytes
          && elapsedSinceRateSample >= 100
        ) {
          const sampleRate = ((transferredBytes - lastRateSampleBytes) * 1_000)
            / elapsedSinceRateSample;
          smoothedBytesPerSecond = smoothedBytesPerSecond > 0
            ? (smoothedBytesPerSecond * 0.72) + (sampleRate * 0.28)
            : sampleRate;
          lastRateSampleAt = now;
          lastRateSampleBytes = transferredBytes;
        }

        const remainingBytes = Math.max(0, (Number(totals?.bytes) || 0) - processedBytes);
        const transferFinished = progress.stage === "complete";
        operationState = {
          ...operationState,
          active: progress.stage !== "complete" && progress.stage !== "error",
          stage: progress.stage,
          totals,
          transferredFiles: Number(progress.result?.transferredFiles) || 0,
          transferredBytes,
          processedFiles: Number(progress.result?.processedFiles) || 0,
          processedBytes,
          skippedFiles: Number(progress.result?.skippedFiles) || 0,
          skippedLinks: Number(progress.result?.skippedLinks) || 0,
          currentName: String(progress.currentName || operationState.currentName || ""),
          currentFileBytes,
          currentFileTotalBytes,
          bytesPerSecond: smoothedBytesPerSecond,
          estimatedSecondsRemaining: smoothedBytesPerSecond > 0 && remainingBytes > 0
            ? remainingBytes / smoothedBytesPerSecond
            : transferFinished ? 0 : null,
          updatedAt: now,
          completedAt: transferFinished ? now : 0,
          durationMs: now - startedAt,
          error: progress.error ? String(progress.error.message || progress.error) : null,
        };
        sendEvent("operation");
      },
    });

    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;
    operationState = {
      ...operationState,
      active: false,
      stage: "complete",
      totals: clone(result.totals),
      transferredFiles: result.transferredFiles,
      transferredBytes: result.transferredBytes,
      processedFiles: result.processedFiles,
      processedBytes: result.processedBytes,
      skippedFiles: result.skippedFiles,
      skippedLinks: result.skippedLinks,
      currentFileBytes: operationState.currentFileTotalBytes,
      bytesPerSecond: durationMs > 0
        ? (result.transferredBytes * 1_000) / durationMs
        : operationState.bytesPerSecond,
      estimatedSecondsRemaining: 0,
      updatedAt: completedAt,
      completedAt,
      durationMs,
      error: null,
    };

    await Promise.all(
      (machineImport ? [destinationSide] : [fromSide, destinationSide])
        .map((side) => refreshPane(side)),
    );
    const skippedLinkNotice = result.skippedLinks > 0
      ? ` ${result.skippedLinks} symbolic link${result.skippedLinks === 1 ? " was" : "s were"} skipped for safety.`
      : "";
    pushNotification(
      `${move ? "Moved" : "Copied"} ${result.transferredFiles} file${result.transferredFiles === 1 ? "" : "s"}.${skippedLinkNotice}`,
      result.skippedLinks > 0 ? "info" : "success",
    );
    pushActivity(move ? "Move complete" : "Copy complete", `${result.transferredFiles} file(s) into ${destinationPane.path}`, {
      level: "success",
      category: "transfer",
    });
    sendEvent("operation");
    return result;
  } catch (error) {
    const completedAt = Date.now();
    operationState = {
      ...operationState,
      active: false,
      stage: "error",
      estimatedSecondsRemaining: null,
      updatedAt: completedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      error: String(error?.message || "Transfer failed."),
    };
    pushNotification(operationState.error, "error");
    pushActivity(move ? "Move failed" : "Copy failed", operationState.error, {
      level: "error",
      category: "transfer",
    });
    sendEvent("operation");
    throw error;
  }
}

async function openMachineExplorer(targetPath = "", side = explorerState.side || "local") {
  const sourceSide = side === "remote" ? "remote" : "local";
  const endpoint = sourceSide === "remote" ? remoteEndpoint : localEndpoint;
  if (!endpoint) {
    throw new Error(sourceSide === "remote" ? "The other PC is not connected." : "This PC is unavailable.");
  }
  if (sourceSide === "remote" && remoteInfo?.capabilities?.machineBrowse !== true) {
    throw new Error("The other PC needs the current WorkWire build for disk browsing.");
  }
  const changedSide = explorerState.side !== sourceSide;
  const requestedPath = String(
    targetPath
      || (changedSide ? "" : explorerState.path)
      || (changedSide ? "" : explorerState.homePath),
  ).trim();

  try {
    const listing = await endpoint.listDirectory({
      path: requestedPath,
      scope: "machine",
      includeHidden: Boolean(config.ui.showHidden),
    });
    explorerState.open = true;
    explorerState.side = sourceSide;
    explorerState.homePath = changedSide || !explorerState.homePath
      ? listing.path
      : explorerState.homePath;
    explorerState.path = listing.path;
    explorerState.listing = listing;
    explorerState.error = null;
    sendEvent("explorer");
    return clone(explorerState);
  } catch (error) {
    explorerState.open = true;
    explorerState.side = sourceSide;
    explorerState.error = String(error?.message || `Unable to browse the ${sourceSide === "remote" ? "other" : "local"} PC.`);
    sendEvent("explorer");
    throw error;
  }
}

function closeMachineExplorer() {
  explorerState.open = false;
  explorerState.listing = null;
  explorerState.error = null;
  sendEvent("explorer");
}

async function fetchFromMachineExplorer({ targetPaths = [] } = {}) {
  const result = await runTransfer({
    fromSide: explorerState.side === "remote" ? "remote-machine" : "machine",
    targetPaths,
    move: false,
    sourceScope: "machine",
  });
  pushActivity(
    `Imported ${explorerState.side === "remote" ? "other PC" : "local"} files into Portal`,
    `${summarizePaths(targetPaths)} -> ${paneState.local.path}`,
    {
      level: "success",
      category: "transfer",
    },
  );
  return result;
}

function attachWindowDiagnostics(window, label) {
  configureMainWindowSecurity(window);
  window.webContents.on("did-finish-load", () => {
    sendEvent("ready", { window: label });
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    reportRuntimeError(
      new Error(`${label} failed to load (${errorCode}) ${errorDescription} at ${validatedUrl}`),
      `${label} failed to load.`,
    );
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    reportRuntimeError(
      new Error(`${label} exited unexpectedly (${details.reason || "unknown"}).`),
      `${label} exited unexpectedly.`,
    );
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[${label}] ${sourceId}:${line} ${message}`);
    }
  });
  window.on("unresponsive", () => {
    reportRuntimeError(new Error(`${label} became unresponsive.`), `${label} became unresponsive.`);
  });
}

function createManagedWindow({
  title,
  url,
  width,
  height,
  minWidth,
  minHeight,
  backgroundColor,
} = {}) {
  const icon = resolveAppIcon();
  const window = new BrowserWindow({
    show: false,
    useContentSize: true,
    width,
    height,
    minWidth,
    minHeight,
    title,
    backgroundColor,
    frame: false,
    transparent: true,
    roundedCorners: true,
    autoHideMenuBar: true,
    ...(icon ? { icon: icon.path } : {}),
    webPreferences: {
      preload: path.join(__dirname, "ww-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  if (icon) {
    window.setIcon(icon.image);
  }
  if (icon && process.platform === "darwin" && app.dock) {
    app.dock.setIcon(icon.image);
  }

  window.loadURL(url);
  return window;
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }

  mainWindow = createManagedWindow({
    title: WORKWIRE_APP_NAME,
    url: WW_DESK_WINDOW_URL,
    width: 1580,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#00000000",
  });
  attachWindowDiagnostics(mainWindow, "WorkWire desk");
  mainWindow.once("ready-to-show", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    logInfo("[WW] Desk window ready.");
    mainWindow.show();
    mainWindow.focus();
    sendEvent("state");
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

function registerIpc() {
  handleTrusted("ww:get-state", async () => serializeState());
  handleTrusted("ww:close-window", async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    senderWindow?.close();
    return true;
  });
  handleTrusted("ww:focus-window", async () => {
    createWindow();
    focusMainWindow();
    return true;
  });
  handleTrusted("ww:auto-link", async () => {
    await autoLinkRemote({
      interactive: true,
    });
    return serializeState();
  });
  handleTrusted("ww:open-path", async (_event, side, targetPath) => {
    await refreshPane(side, targetPath);
    return paneState[side];
  });
  handleTrusted("ww:refresh", async (_event, side = null) => {
    if (side === "local" || side === "remote") {
      await refreshPane(side);
      return serializeState();
    }
    await Promise.allSettled([
      refreshPane("local"),
      remoteEndpoint ? refreshPane("remote") : Promise.resolve(),
    ]);
    return serializeState();
  });
  handleTrusted("ww:set-hidden", async (_event, value) => {
    config.ui.showHidden = Boolean(value);
    await persistConfig();
    await Promise.allSettled([
      refreshPane("local"),
      remoteEndpoint ? refreshPane("remote") : Promise.resolve(),
    ]);
    return serializeState();
  });
  handleTrusted("ww:connect", async (_event, peerInput = {}) => {
    const remoteSpec = String(peerInput.remote || "").trim();
    let peer = { ...peerInput };
    if (remoteSpec && !peerInput.host) {
      const combined = remoteSpec.includes(":")
        ? remoteSpec
        : "";
      if (combined) {
        const firstColon = combined.indexOf(":");
        if (firstColon !== -1) {
          const peerSpec = parsePeerSpec(combined.slice(0, firstColon));
          peer = {
            ...peer,
            host: peerSpec.host,
            port: peerSpec.port,
            remotePath: combined.slice(firstColon + 1),
          };
        }
      }
    }
    return connectRemote(peer, {
      explicit: true,
    });
  });
  handleTrusted("ww:disconnect", async () => {
    await disconnectRemote();
    return true;
  });
  handleTrusted("ww:create-item", async (_event, side, payload) => {
    await createItem(side, payload);
    return serializeState();
  });
  handleTrusted("ww:rename-item", async (_event, side, payload) => {
    await renameItem(side, payload);
    return serializeState();
  });
  handleTrusted("ww:delete-items", async (_event, side, payload) => {
    const result = await deleteItems(side, payload);
    return {
      state: serializeState(),
      result,
    };
  });
  handleTrusted("ww:list-deleted-items", async (_event, side) => listDeletedItems(side));
  handleTrusted("ww:restore-deleted-item", async (_event, side, payload) => {
    const restored = await restoreDeletedItem(side, payload);
    return {
      state: serializeState(),
      restored,
      items: await listDeletedItems(side),
    };
  });
  handleTrusted("ww:transfer", async (_event, payload) => {
    const result = await runTransfer(payload);
    return {
      state: serializeState(),
      result,
    };
  });
  handleTrusted("ww:explorer-open", async (_event, targetPath = "", side = "local") => {
    await openMachineExplorer(targetPath, side);
    return serializeState();
  });
  handleTrusted("ww:explorer-open-roots", async (_event, side = "local") => {
    await openMachineExplorer(WW_MACHINE_ROOT_PATH, side);
    return serializeState();
  });
  handleTrusted("ww:explorer-close", async () => {
    closeMachineExplorer();
    return serializeState();
  });
  handleTrusted("ww:explorer-fetch", async (_event, payload = {}) => {
    const result = await fetchFromMachineExplorer(payload);
    return {
      state: serializeState(),
      result,
    };
  });
  handleTrusted("ww:recovery-refresh", async (_event, options = {}) => getRecoveryManager().refresh(options));
  handleTrusted("ww:recovery-select-agent", async (_event, agentId, options = {}) => (
    getRecoveryManager().selectAgent(agentId, options)
  ));
  handleTrusted("ww:recovery-inventory", async (_event, payload = {}) => (
    getRecoveryManager().requestInventory(payload)
  ));
  handleTrusted("ww:recovery-select-case", async (_event, caseId) => (
    getRecoveryManager().selectCase(caseId)
  ));
  handleTrusted("ww:recovery-case-create", async (_event, payload = {}) => (
    getRecoveryManager().createCase(payload)
  ));
  handleTrusted("ww:recovery-goal", async (_event, payload = {}) => (
    getRecoveryManager().updateGoal(payload)
  ));
  handleTrusted("ww:recovery-case-run", async (_event, caseId = "") => (
    getRecoveryManager().runCase(caseId)
  ));
  handleTrusted("ww:recovery-case-stop", async (_event, caseId = "") => (
    getRecoveryManager().stopCase(caseId)
  ));
  handleTrusted("ww:recovery-case-action", async (_event, payload = {}) => (
    getRecoveryManager().submitCaseAction(payload)
  ));
  handleTrusted("ww:recovery-playbook-expand", async (_event, payload = {}) => (
    getRecoveryManager().expandPlaybook(payload)
  ));
  handleTrusted("ww:recovery-playbook-run", async (_event, payload = {}) => (
    getRecoveryManager().runPlaybook(payload)
  ));
  handleTrusted("ww:recovery-job-submit", async (_event, payload = {}) => (
    getRecoveryManager().submitJob(payload)
  ));
  handleTrusted("ww:recovery-exec", async (_event, payload = {}) => (
    getRecoveryManager().exec(payload)
  ));
  handleTrusted("ww:recovery-shell", async (_event, payload = {}) => (
    getRecoveryManager().shell(payload)
  ));
  handleTrusted("ww:recovery-job-cancel", async (_event, jobId) => (
    getRecoveryManager().cancelJob(jobId)
  ));
  handleTrusted("ww:recovery-job-retry", async (_event, jobId) => (
    getRecoveryManager().retryJob(jobId)
  ));
  handleTrusted("ww:recovery-artifact-upload", async (_event, payload = {}) => (
    getRecoveryManager().uploadArtifact(payload)
  ));
  handleTrusted("ww:recovery-artifact-download", async (_event, payload = {}) => (
    getRecoveryManager().downloadArtifact(payload)
  ));
  handleTrusted("ww:recovery-wake", async (_event, payload = {}) => (
    getRecoveryManager().wake(payload)
  ));
  handleTrusted("ww:recovery-fleet-machine", async (_event, payload = {}) => getRecoveryManager().setFleetMachine(payload));
  handleTrusted("ww:recovery-fleet-group", async (_event, payload = {}) => getRecoveryManager().saveFleetGroup(payload));
  handleTrusted("ww:recovery-fleet-query", async (_event, payload = {}) => getRecoveryManager().saveFleetQuery(payload));
  handleTrusted("ww:recovery-fleet-execute", async (_event, payload = {}) => getRecoveryManager().executeFleet(payload));
  handleTrusted("ww:recovery-fleet-retry", async (_event, runId, payload = {}) => getRecoveryManager().retryFleetFailed(runId, payload));
  handleTrusted("ww:recovery-fleet-summary", async (_event, runId) => getRecoveryManager().fleetSummary(runId));
  handleTrusted("ww:recovery-fleet-schedule", async (_event, payload = {}) => getRecoveryManager().saveFleetSchedule(payload));
  handleTrusted("ww:recovery-session-open", async (_event, payload = {}) => getRecoveryManager().openSession(payload));
  handleTrusted("ww:recovery-session-select", async (_event, sessionId = "") => getRecoveryManager().selectSession(sessionId));
  handleTrusted("ww:recovery-session-input", async (_event, payload = {}) => getRecoveryManager().sessionInput(payload));
  handleTrusted("ww:recovery-session-resize", async (_event, payload = {}) => getRecoveryManager().sessionResize(payload));
  handleTrusted("ww:recovery-session-signal", async (_event, payload = {}) => getRecoveryManager().sessionSignal(payload));
  handleTrusted("ww:recovery-session-detach", async (_event, sessionId = "") => getRecoveryManager().sessionDetach(sessionId));
  handleTrusted("ww:recovery-session-reconnect", async (_event, sessionId = "") => getRecoveryManager().sessionReconnect(sessionId));
  handleTrusted("ww:recovery-session-terminate", async (_event, sessionId = "") => getRecoveryManager().sessionTerminate(sessionId));
  handleTrusted("ww:recovery-tunnel-open", async (_event, payload = {}) => getRecoveryManager().openTunnel(payload));
  handleTrusted("ww:recovery-tunnel-close", async (_event, tunnelId = "") => getRecoveryManager().closeTunnel(tunnelId));
  handleTrusted("ww:recovery-console-launch", async (_event, payload = {}) => getRecoveryManager().launchConsole(payload));
  handleTrusted("ww:recovery-next-stage", async (_event, payload = {}) => getRecoveryManager().invokeNextStage(payload));
  handleTrusted("ww:recovery-pxe-status", async () => getRecoveryManager().pxeStatus());
  handleTrusted("ww:recovery-pxe-prepare", async (_event, payload = {}) => (
    getRecoveryManager().pxePrepare(payload)
  ));
  handleTrusted("ww:recovery-pxe-start", async (_event, payload = {}) => (
    getRecoveryManager().pxeStart(payload)
  ));
  handleTrusted("ww:recovery-pxe-stop", async () => getRecoveryManager().pxeStop());
  handleTrusted("ww:recovery-boot-policy", async (_event, payload = {}) => (
    getRecoveryManager().setBootPolicy(payload)
  ));
  handleTrusted("ww:recovery-copy-text", async (_event, value = "") => {
    clipboard.writeText(String(value ?? ""));
    return true;
  });
  handleTrusted("ww:recovery-save-text", async (event, payload = {}) => {
    const suggestedName = path.basename(String(payload.suggestedName || "recovery-output.log"));
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const choice = await dialog.showSaveDialog(senderWindow, {
      title: "Save recovery output",
      defaultPath: suggestedName,
      filters: [{ name: "Log files", extensions: ["log", "txt"] }, { name: "All files", extensions: ["*"] }],
    });
    if (choice.canceled || !choice.filePath) return { canceled: true, path: "" };
    await fs.promises.writeFile(choice.filePath, String(payload.text ?? ""), { mode: 0o600 });
    return { canceled: false, path: choice.filePath };
  });
  handleTrusted("ww:recovery-reveal-path", async (_event, targetPath = "") => {
    const resolved = path.resolve(String(targetPath || ""));
    shell.showItemInFolder(resolved);
    return resolved;
  });
}

async function bootstrapState() {
  config = await loadWwConfig();
  persistedConfig = clone(config);
  const startupIntent = buildWwLaunchIntent(parseWwDesktopFlags(process.argv.slice(2)));
  applyLaunchIntentToConfig(startupIntent);
  if (!valuesEqual(config, persistedConfig)) {
    await persistConfig();
  }

  paneState.remote.error = getWaitingForPeerMessage();
  launchIntentsReady = true;
}

async function init() {
  const recoveryStartup = startRecoverySubsystem();
  scheduleAutoLinkLoop();
  scheduleRemoteSyncLoop();
  const requestedServicePeer = getAttachedServicePeer();
  const attached = requestedServicePeer
    ? await attachToRequestedLocalServiceWithRetry(requestedServicePeer)
    : await attachToExistingLocalService({
        host: "127.0.0.1",
        port: normalizePort(config.service.port, 4851),
        token: config.service.token,
      }, {
        timeoutMs: 350,
        reportFailure: false,
      });
  if (!attached) {
    await startLocalService();
  }

  try {
    await refreshPane("local", paneState.local.path || config.service.rootPath);
  } catch (error) {
    pushNotification(`Unable to open local directory: ${error.message}`, "error");
    pushActivity("Local open failed", String(error?.message || "Unable to open the local pane."), {
      level: "error",
      category: "service",
    });
    await refreshPane("local", config.service.rootPath).catch(() => {});
  }

  const linked = await autoLinkRemote({
    includeSavedPeer: true,
  });
  if (!linked && config.peer.host) {
    const message = String(remoteError || "Unable to connect.");
    appendLogLine(`[WW] Remote connect failed: ${message}`);
    pushActivity("Peer connect failed", message, {
      level: "error",
      category: "peer",
    });
  }
  await recoveryStartup;
}

async function peerHasStagedDesktopRelease(releaseInfo = {}) {
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
    throw new Error(`The paired PC does not support WorkWire update protocol ${WW_UPDATE_PROTOCOL_VERSION}.`);
  }
  return String(update?.source?.hash || "").trim() === String(releaseInfo?.updateHash || "").trim();
}

function startDesktopReleaseActivator() {
  if (releaseActivator) {
    return;
  }
  releaseActivator = createWwReleaseActivator({
    log: appendLogLine,
    isReadyToActivate: peerHasStagedDesktopRelease,
    onActivationRequired: async (releaseInfo) => {
      appendLogLine(`[WW] Activating ${releaseInfo.version} in the desktop.`);
      releaseActivator?.stop();
      app.relaunch({ args: process.argv.slice(1) });
      app.exit(75);
    },
  });
  releaseActivator.start();
}

app.on("second-instance", (_event, commandLine = []) => {
  void app.whenReady().then(async () => {
    createWindow();
    focusMainWindow();
    await queueLaunchArgs(commandLine);
    await requestPeerDesktopLaunch();
  }).catch((error) => {
    appendLogLine(`[WW] Unable to handle second-instance launch: ${formatErrorMessage(error)}`);
  });
});

app.on("activate", () => {
  createWindow();
});

let shutdownStarted = false;
function beginShutdown() {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  stopAutoLinkLoop();
  stopRemoteSyncLoop();
  mainPerformanceMonitor.stop();
  releaseActivator?.stop();
  stopPaneWatcher("local");
  stopLanBeacon().catch(() => {});
  mirrorController?.stop().catch(() => {});
  serviceController?.stop().catch(() => {});
  recoveryManager?.stop().catch(() => {});
}

app.on("window-all-closed", () => {
  beginShutdown();
  // Releasing the singleton lock immediately makes close-then-reopen reliable.
  app.exit(0);
});

app.on("before-quit", () => {
  beginShutdown();
});

process.on("uncaughtException", (error) => {
  reportRuntimeError(error, "WW hit an uncaught exception.");
});

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason || "Unknown rejection"));
  reportRuntimeError(error, "WW hit an unhandled rejection.");
});

await app.whenReady();
if (!app.isPackaged) {
  try {
    ensureLinuxWwDesktopEntry({ baseDir: APP_BASE_DIR });
  } catch {}
}
registerAppProtocol({
  protocol,
  net,
  assetDir: WW_ASSET_DIR,
});
installAppSessionSecurity();
await bootstrapState();
await flushPendingLaunchArgs();
registerIpc();
createWindow();
init().then(() => {
  startDesktopReleaseActivator();
}).catch((error) => {
  reportRuntimeError(error, "WW startup failed.");
});
