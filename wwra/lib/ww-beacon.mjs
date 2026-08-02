import dgram from "node:dgram";
import os from "node:os";
import { normalizePort } from "./ww-config-store.mjs";
import {
  assessWwCompatibility,
  buildWwBuildInfo,
  readWwBuildInfo,
} from "./ww-compat.mjs";
import { collectLanBroadcastTargets, normalizeRemoteAddress } from "./ww-network.mjs";
import {
  WW_UPDATE_PROTOCOL_VERSION,
  assessWwUpdateCompatibility,
  readWwUpdateProtocolVersion,
} from "./ww-update.mjs";

export const WW_BEACON_PORTS = [9001, 9002];
export const WW_BEACON_VERSION = 1;

export function collectLanBeaconTargets({
  networkInterfaces = os.networkInterfaces(),
} = {}) {
  return collectLanBroadcastTargets({
    networkInterfaces,
  });
}

export function normalizeLanBeaconPayload(payload = {}, rinfo = {}) {
  const version = Number(payload.version);
  if (Number.isFinite(version) && Math.trunc(version) !== WW_BEACON_VERSION) {
    return null;
  }

  const host = String(
    payload.host
      || payload.address
      || payload.ip
      || normalizeRemoteAddress(rinfo.address)
      || "",
  ).trim();
  if (!host) {
    return null;
  }

  const port = normalizePort(
    payload.servicePort
      || payload.port
      || payload.httpPort
      || payload.wwPort,
    4851,
  );
  const label = String(payload.name || payload.label || payload.hostname || host).trim();
  const machineId = String(payload.machineId || payload.installationId || "").trim();
  const trustId = String(payload.trustId || payload.deploymentId || "").trim();
  const canLaunchDesktop = payload.canLaunchDesktop === true || payload.launchDesktop === true;
  const remoteBuild = readWwBuildInfo(payload);
  const compatibility = assessWwCompatibility({
    remote: payload,
    peerLabel: label || host,
  });
  const updateCompatibility = assessWwUpdateCompatibility({
    remote: payload,
    peerLabel: label || host,
  });
  const updateProtocol = readWwUpdateProtocolVersion(payload, WW_UPDATE_PROTOCOL_VERSION);

  return {
    host,
    port,
    label,
    machineId,
    trustId,
    compatibility,
    updateCompatibility,
    info: {
      name: label,
      host,
      port,
      machineId,
      trustId,
      versions: {
        protocol: remoteBuild.protocolVersion,
        app: remoteBuild.appVersion,
      },
      installerUrl: remoteBuild.installerUrl,
      version: Number.isFinite(version) ? Math.trunc(version) : WW_BEACON_VERSION,
      capabilities: {
        launchDesktop: canLaunchDesktop,
        updateProtocol,
      },
      compatibility,
      updateCompatibility,
      source: "beacon",
      receivedAt: new Date().toISOString(),
    },
  };
}

function parseLanBeaconMessage(message, rinfo) {
  let payload = null;
  try {
    payload = JSON.parse(Buffer.isBuffer(message) ? message.toString("utf8") : String(message || ""));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const kind = String(payload.kind || payload.type || "").trim().toLowerCase();
  if (kind && kind !== "ww-beacon") {
    return null;
  }

  return normalizeLanBeaconPayload(payload, rinfo);
}

export function createWwLanBeacon({
  ports = WW_BEACON_PORTS,
  intervalMs = 2_500,
  getAnnouncement = () => null,
  onPeer = () => {},
  log = () => {},
  networkInterfaces = os.networkInterfaces,
  socketFactory = (options) => dgram.createSocket(options),
} = {}) {
  const sockets = [];
  let timer = null;

  async function bindSocket(port) {
    const socket = socketFactory({
      type: "udp4",
      reuseAddr: true,
    });

    socket.on("error", (error) => {
      log(`WW beacon socket error on UDP ${port}: ${String(error?.message || error)}`);
    });
    socket.on("message", (message, rinfo) => {
      const peer = parseLanBeaconMessage(message, rinfo);
      if (peer) {
        Promise.resolve(onPeer(peer)).catch((error) => {
          log(`WW beacon peer handler failed: ${String(error?.message || error)}`);
        });
      }
    });

    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(port, "0.0.0.0", () => {
        socket.off("error", reject);
        resolve();
      });
    });

    socket.setBroadcast(true);
    sockets.push({
      port,
      socket,
    });
  }

  function announce() {
    const payload = getAnnouncement();
    if (!payload) {
      return;
    }

    const body = Buffer.from(JSON.stringify({
      kind: "ww-beacon",
      version: WW_BEACON_VERSION,
      at: new Date().toISOString(),
      ...payload,
    }));
    const targets = collectLanBeaconTargets({
      networkInterfaces: networkInterfaces(),
    });

    for (const entry of sockets) {
      for (const target of targets) {
        entry.socket.send(body, entry.port, target, () => {});
      }
    }
  }

  return {
    async start() {
      if (sockets.length > 0) {
        return;
      }

      for (const port of [...new Set(ports.map((value) => normalizePort(value, 9001)))]) {
        await bindSocket(port);
      }

      announce();
      timer = setInterval(announce, Math.max(1_000, Number(intervalMs) || 2_500));
    },

    announce,

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      await Promise.all(
        sockets.splice(0, sockets.length).map((entry) => new Promise((resolve) => {
          entry.socket.close(() => resolve());
        })),
      );
    },
  };
}
