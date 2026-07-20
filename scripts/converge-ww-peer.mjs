#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}

function validIdentity(value, label) {
  const normalized = required(value, label);
  if (!/^[A-Za-z0-9_-]{12,}$/u.test(normalized)) {
    throw new TypeError(`${label} is not a valid WorkWire identity.`);
  }
  return normalized;
}

export function parseConvergeArgs(argv = []) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "consume-token-file") {
      flags[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith("--")) {
      throw new TypeError(`--${key} requires a value.`);
    }
    flags[key] = String(value);
    index += 1;
  }
  return flags;
}

export function buildConvergedPeerConfig(current, {
  token,
  expectedServiceId,
  serviceName,
  peerLabel,
  peerHost,
  peerPort = 4851,
  peerMachineId,
  peerRoot,
} = {}) {
  const pairingToken = required(token, "Pairing token");
  if (!/^[A-Za-z0-9_-]{20,}$/u.test(pairingToken)) {
    throw new TypeError("Pairing token must be at least 20 base64url characters.");
  }
  const expectedId = validIdentity(expectedServiceId, "Expected service identity");
  const actualId = validIdentity(current?.service?.machineId, "Configured service identity");
  if (actualId !== expectedId) {
    const error = new Error(`Refusing the wrong WorkWire config namespace: expected ${expectedId}, found ${actualId}.`);
    error.code = "ERR_WW_WRONG_CONFIG_NAMESPACE";
    throw error;
  }

  const remoteId = validIdentity(peerMachineId, "Peer machine identity");
  if (remoteId === actualId) throw new TypeError("Peer identity must differ from this service identity.");
  const normalizedPort = Number(peerPort);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535) {
    throw new TypeError("Peer port must be an integer from 1 through 65535.");
  }

  const next = structuredClone(current);
  next.service = {
    ...next.service,
    name: required(serviceName || next.service?.name, "Service name"),
    token: pairingToken,
  };
  next.ui = {
    ...next.ui,
    remotePath: required(peerRoot, "Peer root"),
  };
  const peer = {
    label: required(peerLabel, "Peer label"),
    host: required(peerHost, "Peer host"),
    port: normalizedPort,
    machineId: remoteId,
    token: pairingToken,
    remotePath: required(peerRoot, "Peer root"),
  };
  next.peer = peer;
  next.recentPeers = [
    peer,
    ...(Array.isArray(next.recentPeers) ? next.recentPeers : []).filter((candidate) => (
      String(candidate?.machineId || "") !== remoteId
      && !(String(candidate?.host || "") === peer.host && Number(candidate?.port) === peer.port)
    )),
  ].slice(0, 8);
  return next;
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseConvergeArgs(argv);
  const tokenFile = path.resolve(required(flags["token-file"], "--token-file"));
  const token = (await fs.readFile(tokenFile, "utf8")).trim();

  if (flags["config-dir"]) process.env.WW_CONFIG_DIR = path.resolve(flags["config-dir"]);
  if (flags.portal) process.env.WW_PORTAL_PATH = path.resolve(flags.portal);
  if (flags["home-dir"]) process.env.WW_HOME_DIR = path.resolve(flags["home-dir"]);

  const {
    resolveWwConfigPath,
    updateWwConfig,
  } = await import("../lib/ww-config-store.mjs");
  const configPath = resolveWwConfigPath();
  const saved = await updateWwConfig((current) => buildConvergedPeerConfig(current, {
    token,
    expectedServiceId: flags["expect-service-id"],
    serviceName: flags["service-name"],
    peerLabel: flags["peer-label"],
    peerHost: flags["peer-host"],
    peerPort: flags["peer-port"] || 4851,
    peerMachineId: flags["peer-id"],
    peerRoot: flags["peer-root"],
  }));

  if (flags["consume-token-file"]) await fs.rm(tokenFile, { force: true });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    configPath,
    service: {
      name: saved.service.name,
      machineId: saved.service.machineId,
      rootPath: saved.service.rootPath,
    },
    peer: {
      label: saved.peer.label,
      host: saved.peer.host,
      port: saved.peer.port,
      machineId: saved.peer.machineId,
      remotePath: saved.peer.remotePath,
    },
  })}\n`);
}

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}
