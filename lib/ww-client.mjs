import { Readable } from "node:stream";
import { buildPeerBaseUrl } from "./ww-config-store.mjs";
import {
  buildWwBuildInfo,
  createWwCompatibilityError,
} from "./ww-compat.mjs";

async function parseErrorResponse(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {}

  const error = new Error(
    payload?.error?.message
      || `WW request failed with ${response.status} ${response.statusText}.`,
  );
  error.code = payload?.error?.code || `ERR_HTTP_${response.status}`;
  error.status = response.status;
  error.compatibility = payload?.compatibility || null;
  throw error;
}

function createTimeoutSignal(timeoutMs) {
  const normalizedTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    return {
      signal: undefined,
      cleanup() {},
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
    },
  };
}

function createPeerTimeoutError(baseUrl, timeoutMs) {
  const error = new Error(`WW peer ${baseUrl} timed out after ${timeoutMs}ms.`);
  error.code = "ERR_WW_TIMEOUT";
  return error;
}

function isTimeoutError(error, signal) {
  return signal?.aborted || error?.name === "AbortError" || error?.name === "TimeoutError";
}

function decodeHeaderComponent(value = "") {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

export function createRemoteWwClient(peer = {}) {
  const baseUrl = buildPeerBaseUrl(peer);
  const token = String(peer.token || "").trim();
  const localMachineId = String(peer.localMachineId || peer.requesterMachineId || "").trim();
  const localService = peer.localService === true;
  const transferTimeoutMs = Number.isFinite(Number(peer.transferTimeoutMs))
    ? Number(peer.transferTimeoutMs)
    : 30 * 60 * 1_000;

  if (!baseUrl) {
    throw new Error("A peer host is required to create a WW client.");
  }

  function buildRequestHeaders(extraHeaders = {}) {
    return {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(localMachineId ? { "x-ww-machine-id": localMachineId } : {}),
      ...(localService ? { "x-ww-local-service": "1" } : {}),
      ...extraHeaders,
    };
  }

  async function requestJson(pathname, {
    method = "GET",
    body = undefined,
    timeoutMs = 8_000,
  } = {}) {
    const { signal, cleanup } = createTimeoutSignal(timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: buildRequestHeaders(
          body === undefined ? {} : { "content-type": "application/json" },
        ),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        await parseErrorResponse(response);
      }
      return await response.json();
    } catch (error) {
      if (isTimeoutError(error, signal)) {
        throw createPeerTimeoutError(baseUrl, timeoutMs);
      }
      throw error;
    } finally {
      cleanup();
    }
  }

  return {
    peer: {
      ...peer,
      baseUrl,
    },

    async connect({
      timeoutMs = 8_000,
    } = {}) {
      try {
        const payload = await requestJson("/v1/connect", {
          method: "POST",
          body: {
            client: buildWwBuildInfo(),
          },
          timeoutMs,
        });
        return payload.service;
      } catch (error) {
        if (error?.status !== 404 && error?.code !== "ERR_NOT_FOUND") {
          throw error;
        }
      }

      const payload = await requestJson("/v1/info", {
        timeoutMs,
      });
      const compatibilityError = createWwCompatibilityError({
        remote: payload.service,
        peerLabel: peer.label || peer.host || baseUrl,
      });
      if (compatibilityError) {
        throw compatibilityError;
      }
      return payload.service;
    },

    async ping({
      timeoutMs = 8_000,
    } = {}) {
      const payload = await requestJson("/v1/ping", {
        timeoutMs,
      });
      return payload.service;
    },

    async getInfo({
      timeoutMs = 8_000,
    } = {}) {
      const payload = await requestJson("/v1/info", {
        timeoutMs,
      });
      return payload.service;
    },

    async listDirectory(options) {
      const payload = await requestJson("/v1/list", {
        method: "POST",
        body: options,
      });
      return payload.listing;
    },

    async stat(options) {
      const payload = await requestJson("/v1/stat", {
        method: "POST",
        body: options,
      });
      return payload.record;
    },

    async buildManifest(options) {
      const payload = await requestJson("/v1/manifest", {
        method: "POST",
        body: options,
      });
      return payload.manifest;
    },

    async createDirectory(options) {
      const payload = await requestJson("/v1/mkdir", {
        method: "POST",
        body: options,
      });
      return payload.record;
    },

    async createFile(options) {
      const payload = await requestJson("/v1/create-file", {
        method: "POST",
        body: options,
      });
      return payload.record;
    },

    async rename(options) {
      const payload = await requestJson("/v1/rename", {
        method: "POST",
        body: options,
      });
      return payload.record;
    },

    async copyPath(options) {
      const payload = await requestJson("/v1/copy", {
        method: "POST",
        body: options,
      });
      return payload.record;
    },

    async deletePaths(options) {
      const payload = await requestJson("/v1/delete", {
        method: "POST",
        body: options,
      });
      return payload.results;
    },

    async launchDesktop(options) {
      const payload = await requestJson("/v1/launch-desktop", {
        method: "POST",
        body: options,
        timeoutMs: 15_000,
      });
      return payload.launch;
    },

    async createDownloadStream(targetPath, {
      timeoutMs = transferTimeoutMs,
    } = {}) {
      const encodedPath = encodeURIComponent(targetPath);
      const { signal, cleanup } = createTimeoutSignal(timeoutMs);
      try {
        const response = await fetch(`${baseUrl}/v1/download?path=${encodedPath}`, {
          headers: buildRequestHeaders(),
          ...(signal ? { signal } : {}),
        });

        if (!response.ok) {
          await parseErrorResponse(response);
        }

        if (!response.body) {
          throw new Error("WW download response did not include a body.");
        }

        const stream = Readable.fromWeb(response.body);
        stream.once("end", cleanup);
        stream.once("close", cleanup);
        return {
          stream,
          mtimeMs: Number(response.headers.get("x-ww-item-mtime-ms")) || 0,
          name: decodeHeaderComponent(response.headers.get("x-ww-item-name") || ""),
        };
      } catch (error) {
        cleanup();
        if (isTimeoutError(error, signal)) {
          throw createPeerTimeoutError(baseUrl, timeoutMs);
        }
        throw error;
      }
    },

    async uploadFileStream(targetPath, readable, {
      overwrite = false,
      mtimeMs = null,
      timeoutMs = transferTimeoutMs,
    } = {}) {
      const url = new URL(`${baseUrl}/v1/upload`);
      url.searchParams.set("path", targetPath);
      if (overwrite) {
        url.searchParams.set("overwrite", "1");
      }
      if (Number.isFinite(Number(mtimeMs))) {
        url.searchParams.set("mtimeMs", String(Number(mtimeMs)));
      }

      const { signal, cleanup } = createTimeoutSignal(timeoutMs);
      try {
        const response = await fetch(url, {
          method: "PUT",
          headers: buildRequestHeaders(),
          body: Readable.toWeb(readable),
          duplex: "half",
          ...(signal ? { signal } : {}),
        });

        if (!response.ok) {
          await parseErrorResponse(response);
        }

        const payload = await response.json();
        return payload.record;
      } catch (error) {
        if (isTimeoutError(error, signal)) {
          throw createPeerTimeoutError(baseUrl, timeoutMs);
        }
        throw error;
      } finally {
        cleanup();
      }
    },
  };
}
