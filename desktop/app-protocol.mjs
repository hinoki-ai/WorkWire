import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const APP_PROTOCOL_SCHEME = "app";
export const APP_PROTOCOL_HOST = "-";

export function buildAppWindowUrl(requestPath = "/index.html") {
  const normalizedPath = String(requestPath || "/index.html");
  const pathname = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  return `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}${pathname}`;
}

export const APP_WINDOW_URL = buildAppWindowUrl("/index.html");

function extractRawTrustedAppPath(requestUrl) {
  const value = String(requestUrl || "");
  const prefix = `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}`;
  if (!value.startsWith(prefix)) {
    return null;
  }

  const remainder = value.slice(prefix.length);
  if (!remainder || remainder.startsWith("?") || remainder.startsWith("#")) {
    return "/";
  }

  if (!remainder.startsWith("/")) {
    return null;
  }

  const delimiterIndex = remainder.search(/[?#]/);
  return delimiterIndex === -1 ? remainder : remainder.slice(0, delimiterIndex);
}

function normalizeAppRequestPath(pathname = "/") {
  try {
    const decoded = decodeURIComponent(pathname || "/");
    if (decoded.includes("\0") || decoded.includes("\\")) {
      return null;
    }

    const segments = decoded.split("/");
    if (segments.some((segment) => segment === "..")) {
      return null;
    }

    const normalized = path.posix.normalize(decoded || "/");
    if (!normalized.startsWith("/")) {
      return null;
    }

    return normalized === "/" ? "/index.html" : normalized;
  } catch {
    return null;
  }
}

export function isTrustedAppUrl(value) {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(String(value));
    return url.protocol === `${APP_PROTOCOL_SCHEME}:` && url.host === APP_PROTOCOL_HOST;
  } catch {
    return false;
  }
}

export function resolveAppAssetFilePath(requestUrl, { assetDir } = {}) {
  if (!assetDir || !isTrustedAppUrl(requestUrl)) {
    return null;
  }

  const rawPath = extractRawTrustedAppPath(requestUrl);
  const requestPath = normalizeAppRequestPath(rawPath);
  if (!requestPath) {
    return null;
  }

  const assetRoot = path.resolve(assetDir);
  const filePath = path.resolve(assetRoot, `.${requestPath}`);
  if (filePath === assetRoot || !filePath.startsWith(`${assetRoot}${path.sep}`)) {
    return null;
  }

  return filePath;
}

export function registerAppProtocol({
  protocol,
  net,
  assetDir,
  existsImpl = fs.existsSync,
} = {}) {
  protocol.handle(APP_PROTOCOL_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const filePath = resolveAppAssetFilePath(request.url, { assetDir });
    if (!filePath || !existsImpl(filePath)) {
      return new Response("Not Found", { status: 404 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}
