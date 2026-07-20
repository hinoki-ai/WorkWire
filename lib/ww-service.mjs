import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import os from "node:os";
import { URL } from "node:url";
import { pipeline } from "node:stream/promises";
import { serializeFsError } from "./ww-fs.mjs";
import {
  deriveWwTrustId,
  normalizePort,
  resolveWwPortalRoot,
  WW_PORTAL_DIRNAME,
} from "./ww-config-store.mjs";
import {
  assessWwCompatibility,
  buildWwBuildInfo,
  readWwBuildInfo,
} from "./ww-compat.mjs";
import { createLocalEndpoint, isWwMachineScope } from "./ww-endpoint.mjs";
import { startPerformanceSpan } from "./ww-performance.mjs";
import {
  collectLanInterfaceRecords,
  normalizeRemoteAddress,
  resolveAdvertisedHost,
} from "./ww-network.mjs";
import {
  WW_UPDATE_PROTOCOL_VERSION,
  buildWwUpdateStatus,
  readCurrentWwReleaseInfo,
} from "./ww-update.mjs";

function writeJson(response, statusCode, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function writeError(response, statusCode, error) {
  writeJson(response, statusCode, {
    ok: false,
    error: error && typeof error === "object"
      ? {
          code: String(error.code || "ERR_WW_REQUEST"),
          message: String(error.message || "Request failed."),
        }
      : {
          code: "ERR_WW_REQUEST",
          message: String(error || "Request failed."),
        },
  });
}

function writeCompatibilityError(response, statusCode, compatibility, service) {
  writeJson(response, statusCode, {
    ok: false,
    error: {
      code: String(compatibility?.code || "ERR_WW_COMPATIBILITY"),
      message: String(compatibility?.message || "WW compatibility negotiation failed."),
    },
    compatibility,
    service,
  });
}

async function readJsonBody(request, maxBytes = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Request body is too large.");
      error.code = "ERR_BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function requestIsAuthorized(request, token) {
  if (!token) {
    return true;
  }

  const authHeader = Buffer.from(String(request.headers.authorization || ""));
  const expectedHeader = Buffer.from(`Bearer ${token}`);
  return authHeader.length === expectedHeader.length
    && timingSafeEqual(authHeader, expectedHeader);
}

function normalizeMachineId(value = "") {
  return String(value || "").trim();
}

function getTrustedPeerMachineId(getTrustedPeerMachineId) {
  return typeof getTrustedPeerMachineId === "function"
    ? normalizeMachineId(getTrustedPeerMachineId())
    : "";
}

function getRequestPeerMachineId(request) {
  const headerValue = request?.headers?.["x-ww-machine-id"];
  return normalizeMachineId(Array.isArray(headerValue) ? headerValue[0] : headerValue);
}

function requestIsLocalServiceClient(request) {
  const headerValue = request?.headers?.["x-ww-local-service"];
  const normalizedHeader = String(Array.isArray(headerValue) ? headerValue[0] : headerValue || "").trim();
  if (normalizedHeader !== "1") {
    return false;
  }

  return normalizeRemoteAddress(request?.socket?.remoteAddress) === "127.0.0.1";
}

function getAuthorizationFailure(request, token, trustedPeerMachineId = "") {
  if (!requestIsAuthorized(request, token)) {
    return {
      statusCode: 401,
      error: {
        code: "ERR_UNAUTHORIZED",
        message: "A valid WW bearer token is required.",
      },
    };
  }

  if (!trustedPeerMachineId) {
    return null;
  }

  if (requestIsLocalServiceClient(request)) {
    return null;
  }

  const requesterMachineId = getRequestPeerMachineId(request);
  if (!requesterMachineId || requesterMachineId !== trustedPeerMachineId) {
    return {
      statusCode: 403,
      error: {
        code: "ERR_WW_PEER_PIN_MISMATCH",
        message: "This WW service only trusts its paired WW peer.",
      },
    };
  }

  return null;
}

function assertMachineScopeAuthorized(request, options, trustedPeerMachineId = "") {
  if (!isWwMachineScope(options?.scope)) {
    return;
  }
  if (
    requestIsLocalServiceClient(request)
    || (
      trustedPeerMachineId
      && getRequestPeerMachineId(request) === trustedPeerMachineId
    )
  ) {
    return;
  }
  const error = new Error("Whole-machine browsing is available only to the pinned WorkWire peer.");
  error.code = "ERR_WW_MACHINE_SCOPE_FORBIDDEN";
  throw error;
}

function collectAdvertisedAddresses(host, port) {
  const addresses = [];
  const add = (value) => {
    const next = String(value || "").trim();
    if (!next || addresses.includes(next)) {
      return;
    }
    addresses.push(next);
  };

  if (!host || host === "0.0.0.0" || host === "::") {
    add("127.0.0.1");
    add("localhost");
    for (const record of collectLanInterfaceRecords()) {
      add(record.address);
    }
  } else {
    add(normalizeRemoteAddress(host));
  }

  return addresses.map((address) => {
    const authority = address.includes(":") && !address.startsWith("[")
      ? `[${address}]`
      : address;
    return `http://${authority}:${port}`;
  });
}

function normalizeListenPort(value, fallback = 4851) {
  const raw = String(value ?? "").trim();
  if (raw === "0") {
    return 0;
  }
  return normalizePort(value, fallback);
}

function buildServiceInfo({
  host,
  port,
  machineId,
  token,
  name,
  launchedAt,
  rootPath,
  canLaunchDesktop = false,
  canDownloadUpdate = false,
} = {}) {
  return {
    name,
    bindHost: host,
    host: resolveAdvertisedHost(host),
    port,
    machineId: normalizeMachineId(machineId),
    trustId: deriveWwTrustId(token),
    hostname: os.hostname(),
    platform: process.platform,
    launchedAt,
    portalName: WW_PORTAL_DIRNAME,
    rootPath,
    ...buildWwBuildInfo(),
    urls: collectAdvertisedAddresses(host, port),
    capabilities: {
      launchDesktop: Boolean(canLaunchDesktop),
      machineBrowse: true,
      updateProtocol: WW_UPDATE_PROTOCOL_VERSION,
      downloadUpdate: Boolean(canDownloadUpdate),
    },
  };
}

function buildServiceInfoForRequest(serviceInfo = null, request = null) {
  if (!serviceInfo) {
    return null;
  }

  const localAddress = normalizeRemoteAddress(request?.socket?.localAddress);
  const { token: _token, ...publicServiceInfo } = serviceInfo;
  if (!localAddress) {
    return publicServiceInfo;
  }

  return {
    ...publicServiceInfo,
    host: localAddress,
    urls: collectAdvertisedAddresses(localAddress, publicServiceInfo.port),
  };
}

function buildDiscoveryServiceInfo(serviceInfo = {}) {
  return {
    name: String(serviceInfo?.name || "").trim(),
    host: String(serviceInfo?.host || "").trim(),
    port: normalizePort(serviceInfo?.port, 4851),
    machineId: normalizeMachineId(serviceInfo?.machineId),
    trustId: String(serviceInfo?.trustId || "").trim(),
    ...buildWwBuildInfo({
      protocolVersion: serviceInfo?.versions?.protocol,
      appVersion: serviceInfo?.versions?.app,
      installerUrl: serviceInfo?.installerUrl,
    }),
    capabilities: {
      launchDesktop: serviceInfo?.capabilities?.launchDesktop === true,
      updateProtocol: WW_UPDATE_PROTOCOL_VERSION,
      downloadUpdate: serviceInfo?.capabilities?.downloadUpdate === true,
    },
  };
}

function resolveUploadOptions(requestUrl) {
  return {
    path: requestUrl.searchParams.get("path") || "",
    overwrite: requestUrl.searchParams.get("overwrite") === "1",
    mtimeMs: requestUrl.searchParams.get("mtimeMs"),
  };
}

async function handleJsonOperation(request, response, handler) {
  try {
    const body = await readJsonBody(request);
    const result = await handler(body);
    writeJson(response, 200, {
      ok: true,
      ...result,
    });
  } catch (error) {
    writeError(
      response,
      error?.code === "ENOENT"
        ? 404
        : error?.code === "ERR_WW_MACHINE_SCOPE_FORBIDDEN" ? 403 : 400,
      serializeFsError(error),
    );
  }
}

export function createWwService({
  host = "0.0.0.0",
  port = 4851,
  machineId = "",
  token = "",
  name = os.hostname(),
  rootPath = resolveWwPortalRoot(),
  log = () => {},
  onLaunchDesktop = null,
  onPairPeer = null,
  getTrustedPeerMachineId = () => "",
  getMirrorStatus = () => null,
  recoverPortCollision = true,
  updateBundlePath = "",
} = {}) {
  let server = null;
  let serviceInfo = null;
  let launchedAt = null;
  let activeRequests = 0;
  let lastMutationAt = 0;
  let lastRequestCompletedAt = 0;
  const localEndpoint = createLocalEndpoint({
    name,
    rootPath,
    allowMachineScope: true,
  });

  function buildServer() {
    const nextServer = http.createServer((request, response) => {
      let route = "invalid";
      try {
        route = new URL(request.url, "http://ww.local").pathname;
      } catch {}
      const span = startPerformanceSpan("service.http", {
        method: String(request.method || ""),
        route,
      });
      let spanEnded = false;
      const endSpan = (completed) => {
        if (spanEnded) return;
        spanEnded = true;
        span?.end({
          completed,
          statusCode: Number(response.statusCode) || 0,
        });
      };
      response.once("finish", () => endSpan(true));
      response.once("close", () => endSpan(response.writableFinished));
      const mutatingRequest = (
        (request.method === "PUT" && route === "/v1/upload")
        || (request.method === "PUT" && route === "/v1/upload-batch")
        || (request.method === "POST" && [
          "/v1/mkdir",
          "/v1/create-file",
          "/v1/rename",
          "/v1/copy",
          "/v1/delete",
          "/v1/trash",
          "/v1/trash/restore",
        ].includes(route))
      );
      activeRequests += 1;
      requestHandler(request, response)
        .catch((error) => {
          log(`WW request failure: ${error.message}`);
          writeError(response, 500, serializeFsError(error));
        })
        .finally(() => {
          activeRequests = Math.max(0, activeRequests - 1);
          lastRequestCompletedAt = Date.now();
          if (mutatingRequest) lastMutationAt = lastRequestCompletedAt;
        });
    });
    nextServer.headersTimeout = 15_000;
    nextServer.requestTimeout = 30 * 60 * 1_000;
    nextServer.keepAliveTimeout = 5_000;
    return nextServer;
  }

  async function listen(targetServer, targetPort) {
    await new Promise((resolve, reject) => {
      const handleError = (error) => {
        targetServer.off("listening", handleListening);
        reject(error);
      };
      const handleListening = () => {
        targetServer.off("error", handleError);
        resolve();
      };

      targetServer.once("error", handleError);
      targetServer.once("listening", handleListening);
      targetServer.listen(targetPort, host);
    });
  }

  async function requestHandler(request, response) {
    const requestUrl = new URL(request.url, "http://ww.local");
    const requestServiceInfo = buildServiceInfoForRequest(serviceInfo, request);

    if (request.method === "GET" && requestUrl.pathname === "/v1/discover") {
      const requesterBuild = readWwBuildInfo({
        versions: {
          protocol: requestUrl.searchParams.get("protocolVersion"),
          app: requestUrl.searchParams.get("appVersion"),
        },
        installerUrl: requestUrl.searchParams.get("installerUrl"),
      });
      const compatibility = requesterBuild.protocolVersion == null && !requesterBuild.appVersion
        ? null
        : assessWwCompatibility({
            local: {
              versions: {
                protocol: requesterBuild.protocolVersion,
                app: requesterBuild.appVersion,
              },
              installerUrl: requesterBuild.installerUrl,
            },
            remote: requestServiceInfo,
            peerLabel: requestServiceInfo?.name || requestServiceInfo?.host || "the other PC",
          });
      writeJson(response, 200, {
        ok: true,
        service: buildDiscoveryServiceInfo(requestServiceInfo),
        ...(compatibility ? { compatibility } : {}),
      });
      return;
    }

    const trustedPeerMachineId = getTrustedPeerMachineId(getTrustedPeerMachineId);
    const authorizationFailure = getAuthorizationFailure(request, token, trustedPeerMachineId);
    if (authorizationFailure) {
      writeError(response, authorizationFailure.statusCode, authorizationFailure.error);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/v1/ping") {
      writeJson(response, 200, {
        ok: true,
        service: requestServiceInfo,
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/v1/info") {
      writeJson(response, 200, {
        ok: true,
        service: requestServiceInfo,
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/v1/update-status") {
      const releaseInfo = await readCurrentWwReleaseInfo();
      writeJson(response, 200, {
        ok: true,
        update: buildWwUpdateStatus(releaseInfo),
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/v1/mirror-status") {
      const mirror = typeof getMirrorStatus === "function"
        ? await Promise.resolve(getMirrorStatus())
        : null;
      writeJson(response, 200, {
        ok: true,
        mirror,
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/v1/update-bundle") {
      const bundlePath = String(updateBundlePath || "").trim();
      if (!bundlePath) {
        writeError(response, 404, {
          code: "ERR_WW_UPDATE_BUNDLE_UNAVAILABLE",
          message: "This WorkWire service does not have a staged update bundle.",
        });
        return;
      }
      try {
        const stats = await fsp.stat(bundlePath);
        if (!stats.isFile()) {
          throw new Error("The staged WorkWire update bundle is not a file.");
        }
        response.writeHead(200, {
          "content-type": "application/gzip",
          "content-length": stats.size,
          "content-disposition": "attachment; filename=ww-linux-x64.tar.gz",
          "cache-control": "no-store",
        });
        await pipeline(fs.createReadStream(bundlePath), response);
      } catch (error) {
        if (!response.headersSent) {
          writeError(response, error?.code === "ENOENT" ? 404 : 500, serializeFsError(error));
        } else {
          response.destroy(error);
        }
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/connect") {
      let body = null;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        writeError(response, 400, serializeFsError(error));
        return;
      }

      const requesterBuild = readWwBuildInfo(body?.client || body);
      if (requesterBuild.protocolVersion == null || !requesterBuild.appVersion) {
        writeError(response, 400, {
          code: "ERR_WW_CONNECT_VERSION_REQUIRED",
          message: "WW connect negotiation requires app and protocol version metadata.",
        });
        return;
      }

      const compatibility = assessWwCompatibility({
        local: {
          versions: {
            protocol: requesterBuild.protocolVersion,
            app: requesterBuild.appVersion,
          },
          installerUrl: requesterBuild.installerUrl,
        },
        remote: requestServiceInfo,
        peerLabel: requestServiceInfo?.name || normalizeRemoteAddress(request.socket?.remoteAddress) || "the other PC",
      });

      if (!compatibility.ok) {
        writeCompatibilityError(response, 409, compatibility, requestServiceInfo);
        return;
      }

      if (!trustedPeerMachineId && typeof onPairPeer === "function") {
        const requesterMachineId = getRequestPeerMachineId(request);
        if (
          requesterMachineId
          && requesterMachineId !== normalizeMachineId(machineId)
          && !requestIsLocalServiceClient(request)
        ) {
          await onPairPeer({
            machineId: requesterMachineId,
          });
        }
      }

      writeJson(response, 200, {
        ok: true,
        service: requestServiceInfo,
        compatibility,
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/list") {
      await handleJsonOperation(request, response, async (body) => {
        assertMachineScopeAuthorized(request, body, trustedPeerMachineId);
        return {
          listing: await localEndpoint.listDirectory(body),
        };
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/stat") {
      await handleJsonOperation(request, response, async (body) => {
        assertMachineScopeAuthorized(request, body, trustedPeerMachineId);
        return {
          record: await localEndpoint.stat(body),
        };
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/manifest") {
      await handleJsonOperation(request, response, async (body) => {
        assertMachineScopeAuthorized(request, body, trustedPeerMachineId);
        return {
          manifest: await localEndpoint.buildManifest(body),
        };
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/download-batch") {
      try {
        const body = await readJsonBody(request);
        assertMachineScopeAuthorized(request, body, trustedPeerMachineId);
        const batch = await localEndpoint.createSmallFileBatchStream(body);
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
        });
        await pipeline(batch.stream, response);
      } catch (error) {
        if (!response.headersSent) {
          writeError(
            response,
            error?.code === "ENOENT" ? 404 : error?.code === "ERR_WW_MACHINE_SCOPE_FORBIDDEN" ? 403 : 400,
            serializeFsError(error),
          );
        } else {
          response.destroy(error);
        }
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/mkdir") {
      await handleJsonOperation(request, response, async (body) => ({
        record: await localEndpoint.createDirectory(body),
      }));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/create-file") {
      await handleJsonOperation(request, response, async (body) => ({
        record: await localEndpoint.createFile(body),
      }));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/rename") {
      await handleJsonOperation(request, response, async (body) => ({
        record: await localEndpoint.rename(body),
      }));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/copy") {
      await handleJsonOperation(request, response, async (body) => ({
        record: await localEndpoint.copyPath(body),
      }));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/delete") {
      await handleJsonOperation(request, response, async (body) => ({
        results: await localEndpoint.deletePaths(body),
      }));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/trash") {
      await handleJsonOperation(request, response, async (body) => ({
        results: await localEndpoint.trashPaths(body),
      }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/v1/trash/list") {
      await handleJsonOperation(request, response, async () => ({
        items: await localEndpoint.listTrash(),
      }));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/trash/restore") {
      await handleJsonOperation(request, response, async (body) => ({
        item: await localEndpoint.restoreTrashItem(body),
      }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/v1/download") {
      try {
        const downloadOptions = {
          scope: requestUrl.searchParams.get("scope") || "",
        };
        assertMachineScopeAuthorized(request, downloadOptions, trustedPeerMachineId);
        const download = await localEndpoint.createDownloadStream(
          requestUrl.searchParams.get("path") || "",
          downloadOptions,
        );

        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "x-ww-item-name": encodeURIComponent(download.name),
          "x-ww-item-mtime-ms": String(download.mtimeMs),
          "cache-control": "no-store",
        });

        try {
          await pipeline(download.stream, response);
        } catch (error) {
          if (!response.headersSent) writeError(response, 500, serializeFsError(error));
          else response.destroy(error);
        }
      } catch (error) {
        writeError(
          response,
          error?.code === "ENOENT"
            ? 404
            : error?.code === "ERR_WW_MACHINE_SCOPE_FORBIDDEN" ? 403 : 400,
          serializeFsError(error),
        );
      }
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === "/v1/upload") {
      try {
        const upload = resolveUploadOptions(requestUrl);
        const record = await localEndpoint.uploadFileStream(upload.path, request, {
          overwrite: upload.overwrite,
          mtimeMs: upload.mtimeMs,
        });
        writeJson(response, 200, {
          ok: true,
          record,
        });
      } catch (error) {
        writeError(response, error?.code === "ENOENT" ? 404 : 400, serializeFsError(error));
      }
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === "/v1/upload-batch") {
      try {
        const batch = await localEndpoint.uploadSmallFileBatchStream(
          requestUrl.searchParams.get("root") || "",
          request,
          { conflictPolicy: requestUrl.searchParams.get("conflictPolicy") || "rename" },
        );
        writeJson(response, 200, { ok: true, batch });
      } catch (error) {
        writeError(response, error?.code === "ENOENT" ? 404 : 400, serializeFsError(error));
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/launch-desktop") {
      if (typeof onLaunchDesktop !== "function") {
        writeError(response, 501, {
          code: "ERR_WW_LAUNCH_UNAVAILABLE",
          message: "This WW service cannot launch the desktop app.",
        });
        return;
      }

      await handleJsonOperation(request, response, async (body) => ({
        launch: await onLaunchDesktop({
          ...body,
          requesterHostHint: normalizeRemoteAddress(request.socket?.remoteAddress),
          service: requestServiceInfo,
        }),
      }));
      return;
    }

    writeError(response, 404, {
      code: "ERR_NOT_FOUND",
      message: `No WW route matches ${request.method} ${requestUrl.pathname}.`,
    });
  }

  return {
    async start() {
      if (server) {
        return serviceInfo;
      }

      launchedAt = new Date().toISOString();
      const endpointInfo = await localEndpoint.getInfo();
      const requestedPort = normalizeListenPort(port, 4851);
      server = buildServer();

      try {
        await listen(server, requestedPort);
      } catch (error) {
        if (
          error?.code !== "EADDRINUSE"
          || requestedPort === 0
          || recoverPortCollision !== true
        ) {
          throw error;
        }

        try {
          server.close();
        } catch {}
        log(`WW service port ${requestedPort} is busy; retrying on an open port.`);
        server = buildServer();
        await listen(server, 0);
      }

      const address = server.address();
      const actualPort = typeof address === "object" && address
        ? normalizePort(address.port, requestedPort || 4851)
        : requestedPort || 4851;

      serviceInfo = buildServiceInfo({
        host,
        port: actualPort,
        machineId,
        token,
        name,
        launchedAt,
        rootPath: endpointInfo.rootPath,
        canLaunchDesktop: typeof onLaunchDesktop === "function",
        canDownloadUpdate: Boolean(
          String(updateBundlePath || "").trim()
          && fs.existsSync(String(updateBundlePath || "").trim()),
        ),
      });
      log(`WW service listening on ${serviceInfo.urls.join(", ")}`);
      return serviceInfo;
    },

    async stop() {
      if (!server) {
        return;
      }

      const currentServer = server;
      server = null;
      serviceInfo = null;
      await new Promise((resolve, reject) => {
        currentServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        currentServer.closeAllConnections?.();
      });
    },

    getInfo() {
      return serviceInfo;
    },

    getActivityStatus() {
      return {
        activeRequests,
        lastMutationAt,
        lastRequestCompletedAt,
      };
    },
  };
}
