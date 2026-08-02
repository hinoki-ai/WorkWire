import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { buildPeerBaseUrl } from "./ww-config-store.mjs";
import { startPerformanceSpan } from "./ww-performance.mjs";
import {
  buildWwBuildInfo,
  createWwCompatibilityError,
} from "./ww-compat.mjs";
import { createWwUpdateCompatibilityError } from "./ww-update.mjs";

function createResponseError(status, statusText, payload = null) {
  const error = new Error(
    payload?.error?.message
      || `WW request failed with ${status} ${statusText}.`,
  );
  error.code = payload?.error?.code || `ERR_HTTP_${status}`;
  error.status = status;
  error.compatibility = payload?.compatibility || null;
  return error;
}

async function parseErrorResponse(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  throw createResponseError(response.status, response.statusText, payload);
}

async function readNodeJsonResponse(response, maxBytes = 1_000_000) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      const error = new Error("WW response body is too large.");
      error.code = "ERR_WW_RESPONSE_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
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

  function uploadNodeStream(url, readable, { signal } = {}) {
    const transport = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      let settled = false;
      let request;
      const finish = (error, payload) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(payload);
      };

      request = transport.request(url, {
        method: "PUT",
        headers: buildRequestHeaders(),
        ...(signal ? { signal } : {}),
      }, (response) => {
        void readNodeJsonResponse(response).then((payload) => {
          const status = Number(response.statusCode) || 0;
          if (status < 200 || status >= 300) {
            finish(createResponseError(status, response.statusMessage || "Request failed", payload));
            return;
          }
          finish(null, payload);
        }, (error) => {
          finish(error);
        });
      });

      request.once("error", (error) => {
        finish(error);
      });
      void pipeline(readable, request).catch((error) => {
        request.destroy(error);
        finish(error);
      });
    });
  }

  function downloadNodeStream(url, { signal } = {}) {
    const transport = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(url, {
        method: "GET",
        headers: buildRequestHeaders(),
        ...(signal ? { signal } : {}),
      }, (response) => {
        const status = Number(response.statusCode) || 0;
        if (status >= 200 && status < 300) {
          resolve(response);
          return;
        }
        void readNodeJsonResponse(response).then((payload) => {
          reject(createResponseError(status, response.statusMessage || "Request failed", payload));
        }, reject);
      });
      request.once("error", reject);
      request.end();
    });
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

    async connectForUpdate({
      timeoutMs = 8_000,
    } = {}) {
      const payload = await requestJson("/v1/info", {
        timeoutMs,
      });
      const compatibilityError = createWwUpdateCompatibilityError({
        remote: payload.service,
        peerLabel: peer.label || peer.host || baseUrl,
      });
      if (compatibilityError) {
        throw compatibilityError;
      }
      return payload.service;
    },

    async getUpdateStatus({
      timeoutMs = 8_000,
    } = {}) {
      const payload = await requestJson("/v1/update-status", {
        timeoutMs,
      });
      return payload.update;
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

    async trashPaths(options) {
      const payload = await requestJson("/v1/trash", {
        method: "POST",
        body: options,
      });
      return payload.results;
    },

    async listTrash() {
      const payload = await requestJson("/v1/trash/list");
      return payload.items;
    },

    async restoreTrashItem(options) {
      const payload = await requestJson("/v1/trash/restore", {
        method: "POST",
        body: options,
      });
      return payload.item;
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
      scope = "",
    } = {}) {
      const encodedPath = encodeURIComponent(targetPath);
      const normalizedScope = String(scope || "").trim();
      const scopeQuery = normalizedScope ? `&scope=${encodeURIComponent(normalizedScope)}` : "";
      const { signal, cleanup } = createTimeoutSignal(timeoutMs);
      const span = startPerformanceSpan("client.download", { transport: "http" });
      try {
        const response = await downloadNodeStream(
          new URL(`${baseUrl}/v1/download?path=${encodedPath}${scopeQuery}`),
          { signal },
        );
        const stream = response;
        let spanEnded = false;
        const finishStream = (ok) => {
          cleanup();
          if (spanEnded) return;
          spanEnded = true;
          span?.end({ ok });
        };
        stream.once("end", () => finishStream(true));
        stream.once("close", () => finishStream(!stream.destroyed || stream.readableEnded));
        stream.once("error", () => finishStream(false));
        return {
          stream,
          mtimeMs: Number(response.headers["x-ww-item-mtime-ms"]) || 0,
          name: decodeHeaderComponent(response.headers["x-ww-item-name"] || ""),
        };
      } catch (error) {
        cleanup();
        span?.end({ ok: false, errorCode: String(error?.code || "ERR_DOWNLOAD") });
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
      const span = startPerformanceSpan("client.upload", { transport: "http" });
      try {
        const payload = await uploadNodeStream(url, readable, { signal });
        span?.end({ ok: true });
        return payload.record;
      } catch (error) {
        span?.end({ ok: false, errorCode: String(error?.code || "ERR_UPLOAD") });
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
