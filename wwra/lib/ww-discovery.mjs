import os from "node:os";
import { normalizePort } from "./ww-config-store.mjs";
import {
  assessWwCompatibility,
  buildWwBuildInfo,
} from "./ww-compat.mjs";
import {
  collectLanDiscoveryHosts,
  normalizeRemoteAddress,
} from "./ww-network.mjs";
import {
  assessWwUpdateCompatibility,
  readWwUpdateProtocolVersion,
} from "./ww-update.mjs";

function createTimeoutSignal(timeoutMs) {
  const normalizedTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    return {
      signal: undefined,
      cleanup() {},
    };
  }

  if (typeof AbortSignal?.timeout === "function") {
    return {
      signal: AbortSignal.timeout(normalizedTimeoutMs),
      cleanup() {},
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
    },
  };
}

export function enumerateLanDiscoveryHosts({
  networkInterfaces = os.networkInterfaces(),
  localAddresses = [],
} = {}) {
  return collectLanDiscoveryHosts({
    networkInterfaces,
    localAddresses,
  });
}

async function fetchDiscoveryRecord(host, {
  port = 4851,
  timeoutMs = 400,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("WW discovery requires fetch support.");
  }

  const authority = host.includes(":") && !host.startsWith("[")
    ? `[${host}]`
    : host;
  const localBuild = buildWwBuildInfo();
  const discoveryUrl = new URL(`http://${authority}:${normalizePort(port)}/v1/discover`);
  discoveryUrl.searchParams.set("protocolVersion", String(localBuild.versions.protocol));
  discoveryUrl.searchParams.set("appVersion", localBuild.versions.app);
  discoveryUrl.searchParams.set("installerUrl", localBuild.installerUrl);
  const { signal, cleanup } = createTimeoutSignal(timeoutMs);
  let response = null;

  try {
    response = await fetchImpl(discoveryUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    cleanup();
    if (error?.name === "AbortError") {
      return null;
    }
    return null;
  }
  cleanup();

  if (!response?.ok) {
    return null;
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  const service = payload?.service;
  if (!service || typeof service !== "object") {
    return null;
  }

  const discoveredPort = normalizePort(service.port, port);
  const discoveredHost = normalizeRemoteAddress(service.host) || host;
  const label = String(service.name || service.hostname || host).trim();
  const machineId = String(service.machineId || service.installationId || "").trim();
  const trustId = String(service.trustId || service.deploymentId || "").trim();
  const compatibility = payload?.compatibility && typeof payload.compatibility === "object"
    ? payload.compatibility
    : assessWwCompatibility({
        remote: service,
        peerLabel: label || host,
      });
  const updateCompatibility = assessWwUpdateCompatibility({
    remote: service,
    peerLabel: label || host,
  });
  return {
    host: discoveredHost,
    port: discoveredPort,
    label,
    machineId,
    trustId,
    compatibility,
    updateCompatibility,
    info: {
      name: label,
      host: discoveredHost,
      port: discoveredPort,
      machineId,
      trustId,
      versions: service?.versions && typeof service.versions === "object"
        ? {
            protocol: service.versions.protocol,
            app: service.versions.app,
          }
        : undefined,
      installerUrl: String(service?.installerUrl || "").trim(),
      capabilities: {
        launchDesktop: service?.capabilities?.launchDesktop === true,
        updateProtocol: readWwUpdateProtocolVersion(service, null),
        downloadUpdate: service?.capabilities?.downloadUpdate === true,
      },
      compatibility,
      updateCompatibility,
      source: "discover",
    },
  };
}

export async function discoverLanPeers({
  port = 4851,
  localAddresses = [],
  networkInterfaces = os.networkInterfaces(),
  timeoutMs = 400,
  concurrency = 32,
  fetchImpl = globalThis.fetch,
} = {}) {
  const candidates = enumerateLanDiscoveryHosts({
    networkInterfaces,
    localAddresses,
  });
  if (candidates.length === 0) {
    return [];
  }

  const results = [];
  const seen = new Set();
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, candidates.length));

  async function worker() {
    while (cursor < candidates.length) {
      const host = candidates[cursor];
      cursor += 1;

      const record = await fetchDiscoveryRecord(host, {
        port,
        timeoutMs,
        fetchImpl,
      });
      if (!record) {
        continue;
      }

      const key = record.machineId
        ? `machine:${record.machineId}`
        : `${record.host}:${record.port}:${record.trustId || ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(record);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
