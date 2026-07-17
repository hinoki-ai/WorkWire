import { extractElectronAppArgv } from "./electron-app-argv.mjs";
import { normalizePort, parsePeerSpec } from "./ww-config-store.mjs";

export function parseWwDesktopFlags(argv = extractElectronAppArgv(process.argv)) {
  const flags = {};
  const args = Array.isArray(argv) ? [...argv] : [];
  while (args.length > 0) {
    const current = args.shift();
    if (typeof current !== "string" || !current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const next = args[0];
    if (!next || (typeof next === "string" && next.startsWith("--"))) {
      flags[key] = true;
      continue;
    }

    flags[key] = args.shift();
  }

  return flags;
}

export function buildWwLaunchIntent(flags = {}) {
  const peerValue = typeof flags.peer === "string"
    ? String(flags.peer).trim()
    : "";
  const peerSpec = peerValue ? parsePeerSpec(peerValue) : null;
  const serviceHost = typeof flags["service-host"] === "string"
    ? String(flags["service-host"]).trim()
    : "";
  return {
    showHidden: flags.hidden === true,
    skipPeerLaunch: flags["skip-peer-launch"] === true,
    localPath: typeof flags.local === "string"
      ? String(flags.local).trim()
      : "",
    remotePath: typeof flags["remote-path"] === "string"
      ? String(flags["remote-path"]).trim()
      : "",
    service: serviceHost
      ? {
          host: serviceHost,
          port: normalizePort(flags["service-port"]),
          token: typeof flags["service-token"] === "string"
            ? String(flags["service-token"]).trim()
            : "",
        }
      : null,
    peer: peerSpec && peerSpec.host
      ? {
          host: peerSpec.host,
          port: peerSpec.port,
          machineId: typeof flags["peer-machine-id"] === "string"
            ? String(flags["peer-machine-id"]).trim()
            : "",
          token: typeof flags.token === "string" ? String(flags.token).trim() : "",
          label: typeof flags.name === "string" ? String(flags.name).trim() : "",
        }
      : null,
  };
}

export function buildPeerLaunchSuppression(intent = {}) {
  if (!intent?.skipPeerLaunch || !intent?.peer?.host) {
    return null;
  }

  return {
    host: String(intent.peer.host).trim(),
    port: Number(intent.peer.port),
    token: String(intent.peer.token || "").trim(),
  };
}

export function peerLaunchSuppressionMatches(suppression = null, peer = {}) {
  if (!suppression?.host) {
    return false;
  }

  const candidateHost = String(peer.host || "").trim();
  if (!candidateHost || suppression.host !== candidateHost) {
    return false;
  }

  if (Number(suppression.port) !== Number(peer.port)) {
    return false;
  }

  const suppressionToken = String(suppression.token || "").trim();
  if (!suppressionToken) {
    return true;
  }

  return suppressionToken === String(peer.token || "").trim();
}
