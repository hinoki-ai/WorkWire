#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (["managed", "json"].includes(key)) {
      flags[key] = true;
      continue;
    }
    if (argv[index + 1] === undefined) throw new TypeError(`--${key} requires a value.`);
    flags[key] = String(argv[index + 1]);
    index += 1;
  }
  return flags;
}

function errorText(error) {
  return String(error?.code ? `${error.code}: ${error.message}` : error?.message || error || "unknown error");
}

async function capture(task) {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

function summarizeAgent(agent = {}) {
  return {
    agentId: String(agent.agentId || ""),
    hostname: String(agent.hostname || ""),
    state: String(agent.state || ""),
    mode: String(agent.mode || ""),
    platform: String(agent.inventory?.system?.platform || agent.capabilities?.platform || ""),
    root: agent.capabilities?.root === true,
    effectiveUid: agent.capabilities?.effectiveUid ?? null,
    rawShell: agent.capabilities?.rawShell === true,
    remoteAddress: String(agent.remoteAddress || ""),
  };
}

const flags = parseArgs();
if (flags.managed || (process.platform !== "win32" && !process.env.WW_CONFIG_DIR)) {
  process.env.WW_PORTAL_PATH = process.env.WW_PORTAL_PATH || repoRoot;
  process.env.WW_HOME_DIR = process.env.WW_HOME_DIR || path.join(repoRoot, ".workwire");
  process.env.WW_CONFIG_DIR = process.env.WW_CONFIG_DIR || path.join(repoRoot, ".workwire", "config");
}
if (flags["config-dir"]) process.env.WW_CONFIG_DIR = path.resolve(flags["config-dir"]);
if (flags.portal) process.env.WW_PORTAL_PATH = path.resolve(flags.portal);

const [
  configStore,
  compatibility,
  clientModule,
  releaseModule,
  updateModule,
  recoveryConfigModule,
  recoveryClientModule,
] = await Promise.all([
  import("../lib/ww-config-store.mjs"),
  import("../lib/ww-compat.mjs"),
  import("../lib/ww-client.mjs"),
  import("../lib/ww-release.mjs"),
  import("../lib/ww-update.mjs"),
  import("../lib/recovery/ww-recovery-config.mjs"),
  import("../lib/recovery/ww-recovery-client.mjs"),
]);

const config = await configStore.loadWwConfig();
const [sourceRelease, sourceUpdate, recoveryConfig] = await Promise.all([
  releaseModule.buildWwReleaseInfo({ baseDir: repoRoot }),
  updateModule.buildWwUpdateSourceInfo({ baseDir: repoRoot }),
  recoveryConfigModule.loadRecoveryConfig(),
]);
const localHost = ["0.0.0.0", "::", ""].includes(String(config.service.host || ""))
  ? "127.0.0.1"
  : config.service.host;
const controllerUrl = String(
  flags.controller
  || process.env.WW_RECOVERY_CONTROLLER_URL
  || recoveryConfig.extensions?.clientUrl
  || `http://127.0.0.1:${recoveryConfig.port}`,
).trim();

const localClient = clientModule.createRemoteWwClient({
  host: localHost,
  port: config.service.port,
  token: config.service.token,
  localMachineId: config.service.machineId,
  localService: true,
});
const remoteClient = clientModule.createRemoteWwClient({
  ...config.peer,
  localMachineId: config.service.machineId,
});
const recoveryClient = recoveryClientModule.createRecoveryClient({
  url: controllerUrl,
  token: recoveryConfig.token,
  timeoutMs: 5_000,
  transferTimeoutMs: 0,
});

const [localService, localUpdate, remoteService, remoteUpdate, remoteListing, agentsResult] = await Promise.all([
  capture(() => localClient.getInfo({ timeoutMs: 5_000 })),
  capture(() => localClient.getUpdateStatus({ timeoutMs: 5_000 })),
  capture(() => remoteClient.getInfo({ timeoutMs: 5_000 })),
  capture(() => remoteClient.getUpdateStatus({ timeoutMs: 5_000 })),
  capture(() => remoteClient.listDirectory({ path: "Portal", showHidden: false })),
  capture(() => recoveryClient.listAgents()),
]);

const agents = agentsResult.ok ? agentsResult.value : [];
const expectedRootAgentId = String(flags["expect-root-agent"] || process.env.WW_EXPECT_ROOT_AGENT_ID || "").trim();
const expectedSystemAgentId = String(flags["expect-system-agent"] || process.env.WW_EXPECT_SYSTEM_AGENT_ID || "").trim();
const expectedRootAgent = agents.find((agent) => agent.agentId === expectedRootAgentId);
const expectedSystemAgent = agents.find((agent) => agent.agentId === expectedSystemAgentId);
const localVersion = String(localService.value?.versions?.app || "");
const remoteVersion = String(remoteService.value?.versions?.app || "");
const checks = {
  pairingTokenPresent: Boolean(config.service.token && config.peer.token),
  pairingTokenConverged: Boolean(config.service.token && config.service.token === config.peer.token),
  peerIdentityPinned: Boolean(config.peer.machineId && remoteService.value?.machineId === config.peer.machineId),
  localFileServiceReachable: localService.ok,
  remoteFileServiceReachable: remoteService.ok,
  authenticatedRemoteListing: remoteListing.ok,
  localRunningCurrentSource: localService.ok && localVersion === sourceRelease.version,
  remoteRunningCurrentSource: remoteService.ok && remoteVersion === sourceRelease.version,
  runningVersionsEqual: Boolean(localVersion && localVersion === remoteVersion),
  localUpdateSourceCurrent: localUpdate.ok && localUpdate.value?.source?.hash === sourceUpdate.hash,
  remoteUpdateSourceCurrent: remoteUpdate.ok && remoteUpdate.value?.source?.hash === sourceUpdate.hash,
  recoveryControllerReachable: agentsResult.ok,
  rootAgentOnline: !expectedRootAgentId || Boolean(expectedRootAgent?.state === "online" && expectedRootAgent.capabilities?.root),
  systemAgentOnline: !expectedSystemAgentId || Boolean(expectedSystemAgent?.state === "online" && expectedSystemAgent.capabilities?.root),
};
const report = {
  ok: Object.values(checks).every(Boolean),
  checkedAt: new Date().toISOString(),
  platform: process.platform,
  configPath: configStore.resolveWwConfigPath(),
  portalRoot: config.service.rootPath,
  source: {
    version: sourceRelease.version,
    hash: sourceRelease.hash,
    updateHash: sourceUpdate.hash,
  },
  local: {
    endpoint: `http://${localHost}:${config.service.port}`,
    machineId: config.service.machineId,
    runningVersion: localVersion,
    error: localService.error || null,
    updateError: localUpdate.error || null,
  },
  remote: {
    endpoint: configStore.buildPeerBaseUrl(config.peer),
    machineId: config.peer.machineId,
    runningVersion: remoteVersion,
    error: remoteService.error || null,
    updateError: remoteUpdate.error || null,
    listingError: remoteListing.error || null,
  },
  recovery: {
    controllerUrl,
    error: agentsResult.error || null,
    expectedRootAgent: expectedRootAgent ? summarizeAgent(expectedRootAgent) : null,
    expectedSystemAgent: expectedSystemAgent ? summarizeAgent(expectedSystemAgent) : null,
    onlineAgents: agents.filter((agent) => agent.state === "online").map(summarizeAgent),
  },
  checks,
};

process.stdout.write(`${JSON.stringify(report, null, flags.json ? 0 : 2)}\n`);
if (!report.ok) process.exitCode = 1;
