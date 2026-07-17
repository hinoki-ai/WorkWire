#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  WW_APP_VERSION,
  WW_ARTIFACT_VERSION,
  WW_BUILD_HASH,
  WW_RELEASE_INFO,
} from "../lib/ww-release.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_BASE_DIR = path.resolve(__dirname, "..");
const BUILD_CONFIG_PATH = path.join(APP_BASE_DIR, "electron-builder.linux.json");
const ELECTRON_BUILDER_CLI_PATH = path.join(APP_BASE_DIR, "node_modules", "electron-builder", "cli.js");
const DIST_DIR = path.join(APP_BASE_DIR, "dist", "ww");
const LINUX_UNPACKED_DIR = path.join(DIST_DIR, "linux-unpacked");
const BUNDLE_DIR = path.join(DIST_DIR, "ww");
const BUNDLE_INSTALLER_SOURCE = path.join(APP_BASE_DIR, "scripts", "install-ww-bundle.sh");
const ICON_SOURCE_PATH = path.join(APP_BASE_DIR, "desktop", "assets", "workwire", "icon.png");

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

function mapAppImageArch(value = process.arch) {
  switch (mapBuildArch(value)) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    default:
      return mapBuildArch(value);
  }
}

function runNodeCli(scriptPath, args = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: APP_BASE_DIR,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Build command failed with exit code ${result.status ?? 1}.`);
  }
}

function runTar(args = []) {
  const result = spawnSync("tar", args, {
    cwd: DIST_DIR,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`tar failed with exit code ${result.status ?? 1}.`);
  }
}

function buildElectronArgs(target) {
  return [
    "--config",
    BUILD_CONFIG_PATH,
    `--config.extraMetadata.workwireBuildHash=${WW_BUILD_HASH}`,
    `--config.extraMetadata.workwireReleaseHashVersion=${WW_RELEASE_INFO.hashVersion}`,
    "--linux",
    target,
  ];
}

function ensureBundleContents() {
  fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
  fs.cpSync(LINUX_UNPACKED_DIR, BUNDLE_DIR, { recursive: true });
  fs.copyFileSync(BUNDLE_INSTALLER_SOURCE, path.join(BUNDLE_DIR, "install-ww.sh"));
  fs.copyFileSync(ICON_SOURCE_PATH, path.join(BUNDLE_DIR, "icon.png"));
  fs.chmodSync(path.join(BUNDLE_DIR, "install-ww.sh"), 0o755);
  fs.chmodSync(path.join(BUNDLE_DIR, "ww"), 0o755);
}

function removeBuildIntermediates() {
  fs.rmSync(LINUX_UNPACKED_DIR, { recursive: true, force: true });
  fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });

  for (const entry of fs.readdirSync(DIST_DIR)) {
    if (/^builder-(?:debug|effective-config)\.(?:ya?ml)$/u.test(entry)) {
      fs.rmSync(path.join(DIST_DIR, entry), { force: true });
    }
  }
}

function main() {
  if (!fs.existsSync(ELECTRON_BUILDER_CLI_PATH)) {
    throw new Error(`electron-builder CLI not found at ${ELECTRON_BUILDER_CLI_PATH}. Run npm install first.`);
  }

  const arch = mapBuildArch();
  const versionedArchiveName = `WorkWire-${WW_ARTIFACT_VERSION}-linux-${arch}.tar.gz`;
  const stableArchiveName = `ww-linux-${arch}.tar.gz`;
  const versionedAppImageName = `WorkWire-${WW_ARTIFACT_VERSION}-linux-${mapAppImageArch(arch)}.AppImage`;
  const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "workwire-linux-artifacts-"));
  const restoreVersionedArchivePath = path.join(restoreDir, versionedArchiveName);
  const restoreStableArchivePath = path.join(restoreDir, stableArchiveName);
  let succeeded = false;

  try {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    fs.mkdirSync(DIST_DIR, { recursive: true });

    runNodeCli(ELECTRON_BUILDER_CLI_PATH, buildElectronArgs("dir"));

    ensureBundleContents();
    runTar(["-czf", versionedArchiveName, "ww"]);
    fs.copyFileSync(
      path.join(DIST_DIR, versionedArchiveName),
      path.join(DIST_DIR, stableArchiveName),
    );
    fs.copyFileSync(path.join(DIST_DIR, versionedArchiveName), restoreVersionedArchivePath);
    fs.copyFileSync(path.join(DIST_DIR, stableArchiveName), restoreStableArchivePath);

    runNodeCli(ELECTRON_BUILDER_CLI_PATH, buildElectronArgs("AppImage"));

    fs.copyFileSync(restoreVersionedArchivePath, path.join(DIST_DIR, versionedArchiveName));
    fs.copyFileSync(restoreStableArchivePath, path.join(DIST_DIR, stableArchiveName));
    const appImagePath = fs.readdirSync(DIST_DIR)
      .map((entry) => path.join(DIST_DIR, entry))
      .find((entry) => entry.endsWith(".AppImage"));
    let versionedAppImagePath = null;
    if (appImagePath) {
      versionedAppImagePath = path.join(DIST_DIR, versionedAppImageName);
      if (appImagePath !== versionedAppImagePath) {
        fs.renameSync(appImagePath, versionedAppImagePath);
      }
    }

    removeBuildIntermediates();
    succeeded = true;

    process.stdout.write(`WorkWire release: ${WW_APP_VERSION}\n`);
    process.stdout.write(`WorkWire Linux bundle: ${path.join(DIST_DIR, versionedArchiveName)}\n`);
    process.stdout.write(`WorkWire Linux alias: ${path.join(DIST_DIR, stableArchiveName)}\n`);
    if (versionedAppImagePath) {
      process.stdout.write(`WorkWire AppImage: ${versionedAppImagePath}\n`);
    }
  } finally {
    fs.rmSync(restoreDir, { recursive: true, force: true });
    if (!succeeded) {
      fs.rmSync(DIST_DIR, { recursive: true, force: true });
    }
  }
}

main();
