#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ensureLinuxDesktopShortcut,
  ensureLinuxWwDesktopEntry,
  LINUX_WW_DESKTOP_ENTRY_NAME,
  WORKWIRE_LAUNCHER_RELATIVE_PATH,
} from "../desktop/linux-integration.mjs";
import {
  WW_SYSTEMD_USER_UNIT_NAME,
  resolveWwSystemdUserUnitPath,
} from "../lib/ww-autostart.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE_DIR = path.resolve(__dirname, "..");
const COMMAND_LINK_NAMES = Object.freeze([
  "workwire",
  "ww",
]);

export const WW_INSTALL_HELP_TEXT = `Usage:
  node ./scripts/install-ww.mjs [--desktop-shortcut] [--base-dir <path>] [--launch-script-path <path>] [--help]

Installs the WorkWire launcher, Linux applications menu entry, and an optional desktop shortcut.`;

function parseArgv(argv = []) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = String(argv[index] || "");
    if (!current.startsWith("--")) {
      positionals.push(current);
      continue;
    }

    const [key, inlineValue] = current.slice(2).split("=", 2);
    if (inlineValue != null) {
      flags[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || String(next).startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return {
    flags,
    positionals,
  };
}

function isTruthyFlag(value) {
  if (value === true) {
    return true;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function pathIncludesDir(pathValue = "", candidateDir = "") {
  const normalizedCandidate = path.resolve(candidateDir);
  return String(pathValue || "")
    .split(path.delimiter)
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === normalizedCandidate);
}

async function replaceLauncherLink(linkPath, targetPath) {
  try {
    const current = await fsp.lstat(linkPath);
    if (current.isDirectory() && !current.isSymbolicLink()) {
      throw new Error(`Refusing to replace directory ${linkPath}.`);
    }
    await fsp.unlink(linkPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await fsp.symlink(targetPath, linkPath);
  return linkPath;
}

function restartSystemdUserService(unitName = WW_SYSTEMD_USER_UNIT_NAME) {
  if (process.platform !== "linux") {
    return false;
  }

  try {
    execFileSync("systemctl", ["--user", "restart", unitName], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function parseWwInstallArgv(argv = []) {
  const parsed = parseArgv(argv);
  const help = parsed.flags.help === true || parsed.positionals.includes("-h") || argv.includes("-h");
  const baseDir = path.resolve(String(parsed.flags["base-dir"] || DEFAULT_BASE_DIR));
  const launchScriptPath = path.resolve(
    String(parsed.flags["launch-script-path"] || path.join(baseDir, WORKWIRE_LAUNCHER_RELATIVE_PATH)),
  );

  return {
    help,
    baseDir,
    launchScriptPath,
    createDesktopShortcut: parsed.flags["no-desktop-shortcut"]
      ? false
      : isTruthyFlag(parsed.flags["desktop-shortcut"]),
  };
}

export function printWwInstallHelp(stdout = process.stdout) {
  stdout.write(`${WW_INSTALL_HELP_TEXT}\n`);
}

export async function installWwDesktopIntegration({
  baseDir = DEFAULT_BASE_DIR,
  launchScriptPath = path.join(baseDir, WORKWIRE_LAUNCHER_RELATIVE_PATH),
  createDesktopShortcut = false,
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  stdout = process.stdout,
} = {}) {
  const resolvedBaseDir = path.resolve(baseDir);
  const resolvedLaunchScriptPath = path.resolve(launchScriptPath);

  if (!fs.existsSync(resolvedLaunchScriptPath)) {
    throw new Error(`WorkWire launcher not found at ${resolvedLaunchScriptPath}.`);
  }

  await fsp.chmod(resolvedLaunchScriptPath, 0o755).catch(() => {});

  const portalPath = resolvedBaseDir;
  await fsp.mkdir(portalPath, { recursive: true });
  stdout.write(`Ensured WorkWire portal at ${portalPath}\n`);

  const commandLinks = [];
  for (const targetDir of [path.join(homeDir, ".local", "bin"), path.join(homeDir, "bin")]) {
    await fsp.mkdir(targetDir, { recursive: true });

    for (const linkName of COMMAND_LINK_NAMES) {
      const linkPath = path.join(targetDir, linkName);
      await replaceLauncherLink(linkPath, resolvedLaunchScriptPath);
      commandLinks.push(linkPath);
      stdout.write(
        `${linkName === "workwire"
          ? "Installed WorkWire launcher"
          : "Installed WW launcher"} at ${linkPath}\n`,
      );
    }

    if (!pathIncludesDir(env.PATH, targetDir)) {
      stdout.write(`Warning: ${targetDir} is not currently on PATH in this shell.\n`);
    }
  }

  let desktopEntryPath = null;
  let desktopShortcutPath = null;
  if (platform === "linux") {
    desktopEntryPath = ensureLinuxWwDesktopEntry({
      baseDir: resolvedBaseDir,
      launchScriptPath: resolvedLaunchScriptPath,
      platform,
      env,
      homeDir,
    });
    if (desktopEntryPath) {
      stdout.write(`Installed WorkWire applications menu entry at ${desktopEntryPath}\n`);
    }

    desktopShortcutPath = ensureLinuxDesktopShortcut({
      desktopEntryPath,
      platform,
      env,
      homeDir,
      enabled: createDesktopShortcut,
      desktopEntryName: LINUX_WW_DESKTOP_ENTRY_NAME,
    });
    if (desktopShortcutPath) {
      stdout.write(`Installed WorkWire desktop shortcut at ${desktopShortcutPath}\n`);
    }

    const serviceUnitPath = resolveWwSystemdUserUnitPath({ env, homeDir });
    if (fs.existsSync(serviceUnitPath) && restartSystemdUserService()) {
      stdout.write(`Restarted ${WW_SYSTEMD_USER_UNIT_NAME} so the background WW service uses the latest launcher.\n`);
    }
  }

  return {
    portalPath,
    launchScriptPath: resolvedLaunchScriptPath,
    commandLinks,
    desktopEntryPath,
    desktopShortcutPath,
  };
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution()) {
  const options = parseWwInstallArgv(process.argv.slice(2));
  if (options.help) {
    printWwInstallHelp();
  } else {
    installWwDesktopIntegration(options).catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
