import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectLanInterfaceRecords } from "./ww-network.mjs";
import {
  WW_APP_VERSION,
  WW_ARTIFACT_VERSION,
  WW_BUILD_HASH,
  WW_PACKAGE_VERSION,
  sanitizeWwArtifactVersion,
} from "./ww-release.mjs";

const APP_BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WW_LAN_RELEASE_SCHEMA_VERSION = 3;

export const WW_LAN_INSTALLER_DEFAULT_HOST = "0.0.0.0";
export const WW_LAN_INSTALLER_DEFAULT_PORT = 8765;
export const WW_LAN_INSTALLER_DEFAULT_OUTPUT_DIR = path.join(APP_BASE_DIR, "dist", "ww-lan-installer");

function normalizeListenPort(value, fallback = WW_LAN_INSTALLER_DEFAULT_PORT) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return fallback;
  }
  const port = Number(raw);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    return port;
  }
  return fallback;
}

function mapBuildArch(value = process.arch) {
  switch (value) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      return value;
  }
}

function escapeHtml(value = "") {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function removePath(targetPath) {
  await fsp.rm(targetPath, {
    recursive: true,
    force: true,
  }).catch(() => {});
}

async function writeTextFile(filePath, contents) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, contents, "utf8");
}

async function runCommand(command, args = [], {
  cwd = undefined,
} = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${detail}.`));
    });
  });
}

function buildWwLanStableArtifactName(arch = mapBuildArch()) {
  return `ww-linux-${arch}.tar.gz`;
}

function mapAppImageArch(arch = mapBuildArch()) {
  switch (arch) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    default:
      return arch;
  }
}

function buildWwLanAppImageName(version = WW_ARTIFACT_VERSION, arch = mapBuildArch()) {
  return `WorkWire-${sanitizeWwArtifactVersion(version)}-linux-${mapAppImageArch(arch)}.AppImage`;
}

export function buildWwLanArtifactName(version = WW_ARTIFACT_VERSION, arch = mapBuildArch()) {
  return `WorkWire-${sanitizeWwArtifactVersion(version)}-linux-${arch}.tar.gz`;
}

export function buildWwLanManifest({
  version = WW_APP_VERSION,
  artifactVersion = WW_ARTIFACT_VERSION,
  packageVersion = WW_PACKAGE_VERSION,
  buildHash = WW_BUILD_HASH,
  arch = mapBuildArch(),
  generatedAt = new Date().toISOString(),
  stableSha256 = "",
  stableSize = 0,
  versionedSha256 = "",
  versionedSize = 0,
  appImageSha256 = "",
  appImageSize = 0,
} = {}) {
  const normalizedVersion = String(version || WW_APP_VERSION).trim() || WW_APP_VERSION;
  const normalizedArtifactVersion = sanitizeWwArtifactVersion(
    artifactVersion || normalizedVersion || WW_ARTIFACT_VERSION,
  );
  const stableArtifactName = buildWwLanStableArtifactName(arch);
  const versionedArtifactName = buildWwLanArtifactName(normalizedArtifactVersion, arch);
  const appImageName = buildWwLanAppImageName(normalizedArtifactVersion, arch);

  return {
    schemaVersion: WW_LAN_RELEASE_SCHEMA_VERSION,
    product: "WW",
    channel: "lan",
    version: normalizedVersion,
    artifactVersion: normalizedArtifactVersion,
    release: {
      packageVersion: String(packageVersion || WW_PACKAGE_VERSION).trim() || WW_PACKAGE_VERSION,
      version: normalizedVersion,
      artifactVersion: normalizedArtifactVersion,
      buildHash: String(buildHash || WW_BUILD_HASH).trim() || WW_BUILD_HASH,
    },
    arch,
    generatedAt,
    installPath: "/install.sh",
    manifestPath: "/manifest.json",
    checksumPath: "/SHA256SUMS",
    landingPagePath: "/",
    artifact: {
      version: normalizedArtifactVersion,
      name: stableArtifactName,
      path: `/${stableArtifactName}`,
      sha256: String(stableSha256 || "").trim(),
      size: Math.max(0, Number(stableSize) || 0),
      versionedName: versionedArtifactName,
      versionedPath: `/${versionedArtifactName}`,
      versionedSha256: String(versionedSha256 || "").trim(),
      versionedSize: Math.max(0, Number(versionedSize) || 0),
      appImageName,
      appImagePath: `/${appImageName}`,
      appImageSha256: String(appImageSha256 || "").trim(),
      appImageSize: Math.max(0, Number(appImageSize) || 0),
    },
  };
}

export function buildWwInstallCommand(baseUrl = "") {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  return `curl -fsSL ${normalizedBaseUrl}/install.sh | bash`;
}

export function renderWwLanLandingPage({
  manifest,
} = {}) {
  const version = escapeHtml(manifest?.version || "");
  const arch = escapeHtml(manifest?.arch || "");
  const stablePath = escapeHtml(manifest?.artifact?.path || "#");
  const stableName = escapeHtml(manifest?.artifact?.name || "");
  const versionedPath = escapeHtml(manifest?.artifact?.versionedPath || "#");
  const versionedName = escapeHtml(manifest?.artifact?.versionedName || "");
  const appImagePath = escapeHtml(manifest?.artifact?.appImagePath || "#");
  const appImageName = escapeHtml(manifest?.artifact?.appImageName || "");
  const checksumPath = escapeHtml(manifest?.checksumPath || "/SHA256SUMS");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WW LAN Installer</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe4;
        --ink: #1c241d;
        --muted: #566354;
        --card: rgba(255, 252, 246, 0.94);
        --line: rgba(28, 36, 29, 0.12);
        --accent: #1d6b53;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--ink);
        background: linear-gradient(180deg, #f8f3e8 0%, var(--bg) 100%);
      }

      main {
        width: min(920px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0 48px;
      }

      .panel {
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--card);
        padding: 24px;
        margin-bottom: 18px;
      }

      h1 {
        margin: 0 0 10px;
        font-size: clamp(2.2rem, 4vw, 3.4rem);
        line-height: 0.96;
      }

      p, li { line-height: 1.6; }
      code {
        display: block;
        padding: 14px 16px;
        border-radius: 16px;
        background: rgba(29, 107, 83, 0.08);
        color: var(--accent);
        overflow-x: auto;
      }

      a {
        color: var(--accent);
        text-decoration: none;
      }

      ul {
        margin: 0;
        padding-left: 18px;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <p><strong>WW LAN Installer</strong></p>
        <h1>Install or update WW from this machine.</h1>
        <p>Version ${version} for Linux ${arch}. This bundle already includes Electron and the WorkWire runtime, so the target PC does not need Node.js, npm, or a system Electron install.</p>
        <code id="install-command">curl -fsSL $ORIGIN/install.sh | bash</code>
      </section>
      <section class="panel">
        <p><strong>Downloads</strong></p>
        <ul>
          <li><a href="${stablePath}">${stableName}</a> for the LAN installer script</li>
          <li><a href="${versionedPath}">${versionedName}</a> as the versioned tarball</li>
          <li><a href="${appImagePath}">${appImageName}</a> as the direct AppImage</li>
          <li><a href="/manifest.json">Latest manifest</a></li>
          <li><a href="${checksumPath}">SHA256SUMS</a> for release verification</li>
        </ul>
      </section>
      <script>
        const command = \`curl -fsSL \${window.location.origin}/install.sh | bash\`;
        document.getElementById("install-command").textContent = command;
      </script>
    </main>
  </body>
</html>
`;
}

async function ensurePackagedArtifacts({
  appBaseDir = APP_BASE_DIR,
} = {}) {
  await runCommand(process.execPath, [
    path.join(appBaseDir, "scripts", "package-ww-linux.mjs"),
  ], {
    cwd: appBaseDir,
  });
}

function contentTypeForPath(filePath = "") {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".sh")) return "text/x-shellscript; charset=utf-8";
  if (lower.endsWith("sha256sums")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".appimage")) return "application/octet-stream";
  if (lower.endsWith(".gz")) return "application/gzip";
  return "application/octet-stream";
}

function cacheControlForPath(filePath = "") {
  if (
    filePath.endsWith("manifest.json")
    || filePath.endsWith("index.html")
    || filePath.endsWith("SHA256SUMS")
  ) {
    return "no-store";
  }
  return "public, max-age=300";
}

function collectAdvertisedAddresses(host, port) {
  if (host && host !== "0.0.0.0" && host !== "::") {
    return [`http://${host}:${port}`];
  }

  const addresses = new Set([`http://127.0.0.1:${port}`]);
  for (const entry of collectLanInterfaceRecords()) {
    if (entry.address) {
      addresses.add(`http://${entry.address}:${port}`);
    }
  }
  return [...addresses];
}

async function hashFileSha256(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function describeArtifactFile(filePath) {
  const stat = await fsp.stat(filePath);
  return {
    size: stat.size,
    sha256: await hashFileSha256(filePath),
  };
}

export function renderWwLanChecksums(manifest = {}) {
  const lines = [];
  const append = (sha256, name) => {
    const normalizedSha256 = String(sha256 || "").trim();
    const normalizedName = String(name || "").trim();
    if (!normalizedSha256 || !normalizedName) {
      return;
    }
    lines.push(`${normalizedSha256}  ${normalizedName}`);
  };

  append(manifest?.artifact?.sha256, manifest?.artifact?.name);
  append(manifest?.artifact?.versionedSha256, manifest?.artifact?.versionedName);
  append(manifest?.artifact?.appImageSha256, manifest?.artifact?.appImageName);

  return `${lines.join("\n")}\n`;
}

function resolveRequestBaseUrl(request, fallbackBaseUrl = "") {
  const hostHeader = String(request.headers.host || "").trim();
  if (hostHeader) {
    return `http://${hostHeader}`;
  }
  return fallbackBaseUrl;
}

function resolveStaticFilePath(outputDir, pathname = "/") {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const resolvedOutputDir = path.resolve(outputDir);
  const candidatePath = path.resolve(outputDir, `.${normalizedPath}`);
  if (candidatePath !== resolvedOutputDir && !candidatePath.startsWith(`${resolvedOutputDir}${path.sep}`)) {
    return null;
  }
  return candidatePath;
}

async function streamStaticFile(response, filePath, {
  headOnly = false,
} = {}) {
  const stat = await fsp.stat(filePath);
  response.writeHead(200, {
    "content-type": contentTypeForPath(filePath),
    "content-length": String(stat.size),
    "cache-control": cacheControlForPath(filePath),
  });

  if (headOnly) {
    response.end();
    return;
  }

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    response.on("error", reject);
    response.on("finish", resolve);
    stream.pipe(response);
  });
}

export async function publishWwLanRelease({
  outputDir = WW_LAN_INSTALLER_DEFAULT_OUTPUT_DIR,
  appBaseDir = APP_BASE_DIR,
  stdout = process.stdout,
} = {}) {
  await ensurePackagedArtifacts({ appBaseDir });

  const arch = mapBuildArch();
  const manifest = buildWwLanManifest({
    version: WW_APP_VERSION,
    artifactVersion: WW_ARTIFACT_VERSION,
    packageVersion: WW_PACKAGE_VERSION,
    buildHash: WW_BUILD_HASH,
    arch,
    generatedAt: new Date().toISOString(),
  });
  const resolvedOutputDir = path.resolve(outputDir);
  const sourceDir = path.join(appBaseDir, "dist", "ww");
  const defaultOutputDir = path.resolve(WW_LAN_INSTALLER_DEFAULT_OUTPUT_DIR);
  const outputMarkerName = ".workwire-lan-release-root";
  if (
    resolvedOutputDir === path.parse(resolvedOutputDir).root
    || resolvedOutputDir === path.resolve(appBaseDir)
    || sourceDir === resolvedOutputDir
    || sourceDir.startsWith(`${resolvedOutputDir}${path.sep}`)
  ) {
    throw new Error(`Refusing unsafe WW LAN output directory: ${resolvedOutputDir}`);
  }
  if (
    resolvedOutputDir !== defaultOutputDir
    && await pathExists(resolvedOutputDir)
    && !await pathExists(path.join(resolvedOutputDir, outputMarkerName))
  ) {
    throw new Error(`Refusing to replace unmarked WW LAN output directory: ${resolvedOutputDir}`);
  }
  const versionedArchivePath = path.join(sourceDir, manifest.artifact.versionedName);
  const stableArchivePath = path.join(sourceDir, manifest.artifact.name);
  const appImagePath = path.join(sourceDir, manifest.artifact.appImageName);

  for (const requiredPath of [versionedArchivePath, stableArchivePath, appImagePath]) {
    if (!(await pathExists(requiredPath))) {
      throw new Error(`WW LAN artifact is missing: ${requiredPath}`);
    }
  }

  const stableArtifact = await describeArtifactFile(stableArchivePath);
  const versionedArtifact = await describeArtifactFile(versionedArchivePath);
  const appImageArtifact = await describeArtifactFile(appImagePath);
  const hydratedManifest = buildWwLanManifest({
    version: manifest.version,
    artifactVersion: manifest.artifactVersion,
    packageVersion: manifest.release.packageVersion,
    buildHash: manifest.release.buildHash,
    arch,
    generatedAt: manifest.generatedAt,
    stableSha256: stableArtifact.sha256,
    stableSize: stableArtifact.size,
    versionedSha256: versionedArtifact.sha256,
    versionedSize: versionedArtifact.size,
    appImageSha256: appImageArtifact.sha256,
    appImageSize: appImageArtifact.size,
  });

  await fsp.mkdir(path.dirname(resolvedOutputDir), { recursive: true });
  const transactionDir = await fsp.mkdtemp(path.join(path.dirname(resolvedOutputDir), ".workwire-lan-publish-"));
  const stagedOutputDir = path.join(transactionDir, "next");
  const backupOutputDir = path.join(transactionDir, "previous");
  let outputMoved = false;
  try {
    await fsp.mkdir(stagedOutputDir);
    await fsp.copyFile(versionedArchivePath, path.join(stagedOutputDir, hydratedManifest.artifact.versionedName));
    await fsp.copyFile(stableArchivePath, path.join(stagedOutputDir, hydratedManifest.artifact.name));
    await fsp.copyFile(appImagePath, path.join(stagedOutputDir, hydratedManifest.artifact.appImageName));
    await writeTextFile(
      path.join(stagedOutputDir, "manifest.json"),
      `${JSON.stringify(hydratedManifest, null, 2)}\n`,
    );
    await writeTextFile(
      path.join(stagedOutputDir, "index.html"),
      renderWwLanLandingPage({ manifest: hydratedManifest }),
    );
    await writeTextFile(
      path.join(stagedOutputDir, "SHA256SUMS"),
      renderWwLanChecksums(hydratedManifest),
    );
    await writeTextFile(path.join(stagedOutputDir, outputMarkerName), "WorkWire LAN release output.\n");

    if (await pathExists(resolvedOutputDir)) {
      await fsp.rename(resolvedOutputDir, backupOutputDir);
      outputMoved = true;
    }
    await fsp.rename(stagedOutputDir, resolvedOutputDir);
    await removePath(backupOutputDir);
  } catch (error) {
    if (outputMoved && !await pathExists(resolvedOutputDir) && await pathExists(backupOutputDir)) {
      await fsp.rename(backupOutputDir, resolvedOutputDir).catch(() => {});
    }
    throw error;
  } finally {
    await removePath(transactionDir);
  }

  stdout.write(`WW LAN installer site ready at ${resolvedOutputDir}\n`);
  return {
    outputDir: resolvedOutputDir,
    manifest: hydratedManifest,
  };
}

export function renderServedWwInstallScript({
  baseUrl,
  template,
  manifest,
} = {}) {
  const body = String(template || "").replace(/^#![^\n]*\n/, "");
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const envLines = [
    `WW_LAN_BASE_URL=${JSON.stringify(base)}`,
    `WW_LAN_MANIFEST_URL=${JSON.stringify(`${base}${manifest?.manifestPath || "/manifest.json"}`)}`,
    `WW_LAN_CHECKSUM_URL=${JSON.stringify(`${base}${manifest?.checksumPath || "/SHA256SUMS"}`)}`,
    `WW_LAN_RELEASE_VERSION=${JSON.stringify(String(manifest?.version || "").trim())}`,
    `WW_LAN_ARTIFACT_NAME=${JSON.stringify(String(manifest?.artifact?.name || "").trim())}`,
    `WW_LAN_ARTIFACT_SHA256=${JSON.stringify(String(manifest?.artifact?.sha256 || "").trim())}`,
  ];
  return `#!/usr/bin/env bash
${envLines.join("\n")}
export WW_LAN_BASE_URL WW_LAN_MANIFEST_URL WW_LAN_CHECKSUM_URL WW_LAN_RELEASE_VERSION WW_LAN_ARTIFACT_NAME WW_LAN_ARTIFACT_SHA256

${body}`;
}

export async function startWwLanInstallerServer({
  host = WW_LAN_INSTALLER_DEFAULT_HOST,
  port = WW_LAN_INSTALLER_DEFAULT_PORT,
  outputDir = WW_LAN_INSTALLER_DEFAULT_OUTPUT_DIR,
  appBaseDir = APP_BASE_DIR,
  stdout = process.stdout,
} = {}) {
  const publication = await publishWwLanRelease({
    outputDir,
    appBaseDir,
    stdout,
  });
  const installScriptTemplate = await fsp.readFile(
    path.join(appBaseDir, "scripts", "install-ww-from-lan.sh"),
    "utf8",
  );

  let server = null;
  let info = null;

  const requestHandler = async (request, response) => {
    if (!request.url) {
      response.writeHead(400, { "cache-control": "no-store" });
      response.end("Missing request URL.\n");
      return;
    }

    const requestUrl = new URL(request.url, "http://ww-installer.local");
    if (!["GET", "HEAD"].includes(request.method || "")) {
      response.writeHead(405, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("Method not allowed.\n");
      return;
    }

    if (requestUrl.pathname === "/install.sh") {
      const baseUrl = resolveRequestBaseUrl(request, info?.urls?.[0] || "");
      const body = renderServedWwInstallScript({
        baseUrl,
        template: installScriptTemplate,
        manifest: publication.manifest,
      });
      response.writeHead(200, {
        "content-type": "text/x-shellscript; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
        "cache-control": "no-store",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      response.end(body);
      return;
    }

    const filePath = resolveStaticFilePath(publication.outputDir, requestUrl.pathname);
    if (!filePath || !(await pathExists(filePath))) {
      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("Not found.\n");
      return;
    }

    await streamStaticFile(response, filePath, {
      headOnly: request.method === "HEAD",
    });
  };

  server = http.createServer((request, response) => {
    requestHandler(request, response).catch((error) => {
      response.writeHead(500, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(`${error.message}\n`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(normalizeListenPort(port), host, resolve);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address
    ? normalizeListenPort(address.port, WW_LAN_INSTALLER_DEFAULT_PORT)
    : normalizeListenPort(port, WW_LAN_INSTALLER_DEFAULT_PORT);

  info = {
    host,
    port: actualPort,
    urls: collectAdvertisedAddresses(host, actualPort),
    manifest: publication.manifest,
    outputDir: publication.outputDir,
  };

  stdout.write(`WW LAN installer ready for WW ${publication.manifest.version}\n`);
  stdout.write(`Artifact: ${publication.manifest.artifact.name}\n`);
  stdout.write(`SHA256: ${publication.manifest.artifact.sha256}\n`);
  stdout.write(`Output: ${publication.outputDir}\n`);
  stdout.write(`Manifest: ${path.join(publication.outputDir, "manifest.json")}\n`);
  stdout.write(`Checksums: ${path.join(publication.outputDir, "SHA256SUMS")}\n`);
  stdout.write(`Install:\n`);
  for (const url of info.urls) {
    stdout.write(`- ${buildWwInstallCommand(url)}\n`);
  }

  return {
    async stop() {
      if (!server) {
        return;
      }
      const currentServer = server;
      server = null;
      await new Promise((resolve, reject) => {
        currentServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },

    getInfo() {
      return info;
    },
  };
}
