import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

const APP_BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WW_RELEASE_HASH_VERSION = "ww-release-v6";
const WW_RELEASE_SOURCE_SPECS = Object.freeze([
  "package.json",
  "electron-builder.linux.json",
  "ww.mjs",
  "README.md",
  "desktop",
  "docs",
  "lib",
  "scripts",
]);

export const WW_PACKAGE_VERSION = String(packageJson.version || "0.0.0").trim() || "0.0.0";

function isWwMirrorConflictBasename(name = "") {
  return /^(?:.+ \(WW conflict [a-f0-9]{8}-\d+\)|WW conflict [a-f0-9]{8}-[a-f0-9]{8}-\d+)(?:\.[^./\\]+)?$/u
    .test(String(name || ""));
}

function toPosixRelativePath(value = "") {
  return String(value || "").split(path.sep).join("/");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function collectWwReleaseSourceFiles(baseDir = APP_BASE_DIR) {
  const files = [];

  function includeDirectoryEntry(relativeDirectory, entry) {
    const normalizedDirectory = toPosixRelativePath(relativeDirectory);
    if (normalizedDirectory !== "lib") {
      return true;
    }
    if (entry.isDirectory()) {
      return entry.name === "recovery";
    }
    return entry.name === "electron-app-argv.mjs"
      || /^ww.*\.mjs$/u.test(entry.name);
  }

  async function appendRelativePath(relativePath) {
    const absolutePath = path.join(baseDir, relativePath);
    if (!(await pathExists(absolutePath))) {
      return;
    }

    const stat = await fs.stat(absolutePath);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(absolutePath, {
        withFileTypes: true,
      });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (isWwMirrorConflictBasename(entry.name)) {
          continue;
        }
        if (!includeDirectoryEntry(relativePath, entry)) {
          continue;
        }
        await appendRelativePath(path.join(relativePath, entry.name));
      }
      return;
    }

    if (!stat.isFile()) {
      return;
    }

    files.push(toPosixRelativePath(relativePath));
  }

  for (const relativePath of WW_RELEASE_SOURCE_SPECS) {
    await appendRelativePath(relativePath);
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

export function sanitizeWwArtifactVersion(version = WW_PACKAGE_VERSION) {
  const normalizedVersion = String(version || WW_PACKAGE_VERSION).trim() || WW_PACKAGE_VERSION;
  return normalizedVersion.replaceAll("+", "-").replace(/[^\w.-]+/g, "-");
}

function buildReleaseInfoFromHash({
  hash,
  packageVersion = WW_PACKAGE_VERSION,
  files = [],
} = {}) {
  const normalizedPackageVersion = String(packageVersion || WW_PACKAGE_VERSION);
  const shortHash = hash.slice(0, 12);
  const version = `${normalizedPackageVersion}+ww1.${shortHash}`;

  return {
    hashVersion: WW_RELEASE_HASH_VERSION,
    packageVersion: normalizedPackageVersion,
    hash,
    shortHash,
    version,
    artifactVersion: sanitizeWwArtifactVersion(version),
    files,
  };
}

function readBakedReleaseInfo(packageMetadata = packageJson) {
  if (String(packageMetadata.workwireReleaseHashVersion || "") !== WW_RELEASE_HASH_VERSION) {
    return null;
  }

  const hash = String(packageMetadata.workwireBuildHash || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(hash)) {
    return null;
  }

  return buildReleaseInfoFromHash({
    hash,
    packageVersion: WW_PACKAGE_VERSION,
  });
}

export async function buildWwReleaseInfo({
  baseDir = APP_BASE_DIR,
  packageVersion = WW_PACKAGE_VERSION,
} = {}) {
  const files = await collectWwReleaseSourceFiles(baseDir);
  const hash = createHash("sha256");
  hash.update(WW_RELEASE_HASH_VERSION);
  hash.update("\0");
  hash.update(String(packageVersion || WW_PACKAGE_VERSION));
  hash.update("\0");

  for (const relativePath of files) {
    const absolutePath = path.join(baseDir, relativePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(absolutePath));
    hash.update("\0");
  }

  return buildReleaseInfoFromHash({
    hash: hash.digest("hex"),
    packageVersion,
    files,
  });
}

export const WW_RELEASE_INFO = readBakedReleaseInfo() || await buildWwReleaseInfo();
export const WW_BUILD_HASH = WW_RELEASE_INFO.hash;
export const WW_BUILD_HASH_SHORT = WW_RELEASE_INFO.shortHash;
export const WW_APP_VERSION = WW_RELEASE_INFO.version;
export const WW_ARTIFACT_VERSION = WW_RELEASE_INFO.artifactVersion;
