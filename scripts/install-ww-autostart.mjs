#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  WW_FALLBACK_AUTOSTART_ENTRY_NAME,
  WW_FALLBACK_SUPERVISOR_NAME,
  WW_SYSTEMD_USER_UNIT_NAME,
  buildWwFallbackAutostartEntry,
  buildWwFallbackSupervisorScript,
  buildWwSystemdUserUnit,
  resolveWwFallbackAutostartEntryPath,
  resolveWwFallbackSupervisorPath,
  resolveWwLogPath,
  resolveWwSystemdUserUnitPath,
} from "../lib/ww-autostart.mjs";
import { resolveLocalWwBackgroundService } from "../ww.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, "..");
const WW_BIN_PATH = path.join(os.homedir(), ".local", "bin", "ww");

function log(message = "") {
  process.stdout.write(`${String(message || "")}\n`);
}

function runCommand(command, args = []) {
  execFileSync(command, args, {
    cwd: REPO_DIR,
    stdio: "inherit",
  });
}

function canUseSystemdUser() {
  if (process.platform !== "linux") {
    return false;
  }

  try {
    execFileSync("systemctl", ["--user", "--version"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function installSystemdUserUnit() {
  const unitPath = resolveWwSystemdUserUnitPath();
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(unitPath, buildWwSystemdUserUnit(), "utf8");
  runCommand("systemctl", ["--user", "daemon-reload"]);
  runCommand("systemctl", ["--user", "enable", "--now", WW_SYSTEMD_USER_UNIT_NAME]);
  return unitPath;
}

async function installFallbackAutostart() {
  const launcherPath = resolveWwFallbackSupervisorPath();
  const autostartEntryPath = resolveWwFallbackAutostartEntryPath();
  const logPath = resolveWwLogPath();

  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  await fs.writeFile(launcherPath, buildWwFallbackSupervisorScript({
    wwBinPath: WW_BIN_PATH,
    logPath,
  }), "utf8");
  await fs.chmod(launcherPath, 0o755);

  await fs.mkdir(path.dirname(autostartEntryPath), { recursive: true });
  await fs.writeFile(autostartEntryPath, buildWwFallbackAutostartEntry({
    launcherPath,
  }), "utf8");

  const runningService = await resolveLocalWwBackgroundService().catch(() => null);
  if (!runningService) {
    const child = spawn(launcherPath, [], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  return {
    launcherPath,
    autostartEntryPath,
    logPath,
  };
}

async function main() {
  if (process.platform !== "linux") {
    throw new Error("WW autostart installation currently supports Linux user sessions only.");
  }

  runCommand("bash", [path.join(REPO_DIR, "scripts", "install-ww.sh")]);

  if (canUseSystemdUser()) {
    try {
      const unitPath = await installSystemdUserUnit();
      log(`Installed WW autostart unit at ${unitPath}`);
      log(`Manage it with: systemctl --user status ${WW_SYSTEMD_USER_UNIT_NAME}`);
      log(`Tail logs with: journalctl --user -u ${WW_SYSTEMD_USER_UNIT_NAME} -f`);
      log(`Shared WW log file: ${resolveWwLogPath()}`);
      return;
    } catch (error) {
      log(`systemd --user install failed: ${error.message}`);
      log(`Falling back to ${WW_FALLBACK_AUTOSTART_ENTRY_NAME} and ${WW_FALLBACK_SUPERVISOR_NAME}.`);
    }
  }

  const fallback = await installFallbackAutostart();
  log(`Installed fallback autostart entry at ${fallback.autostartEntryPath}`);
  log(`Installed fallback supervisor at ${fallback.launcherPath}`);
  log(`Shared WW log file: ${fallback.logPath}`);
}

await main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
