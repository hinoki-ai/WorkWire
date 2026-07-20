import os from "node:os";
import path from "node:path";

export const WW_SYSTEMD_USER_UNIT_NAME = "workwire-ww.service";
export const WW_FALLBACK_AUTOSTART_ENTRY_NAME = "workwire-ww-background.desktop";
export const WW_FALLBACK_SUPERVISOR_NAME = "ww-background-supervisor.sh";
export const WW_AUTOSTART_NAMESPACE = "workwire";

function quoteDesktopExecArg(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")}"`;
}

export function resolveWwSystemdUserUnitPath({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.posix.join(homeDir, ".config");
  return path.posix.join(configHome, "systemd", "user", WW_SYSTEMD_USER_UNIT_NAME);
}

export function resolveWwFallbackAutostartEntryPath({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.posix.join(homeDir, ".config");
  return path.posix.join(configHome, "autostart", WW_FALLBACK_AUTOSTART_ENTRY_NAME);
}

export function resolveWwFallbackSupervisorPath({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const dataHome = env.XDG_DATA_HOME?.trim() || path.posix.join(homeDir, ".local", "share");
  return path.posix.join(dataHome, WW_AUTOSTART_NAMESPACE, WW_FALLBACK_SUPERVISOR_NAME);
}

export function resolveWwLogPath({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.posix.join(homeDir, ".config");
  return path.posix.join(configHome, WW_AUTOSTART_NAMESPACE, "ww.log");
}

export function buildWwSystemdUserUnit({
  wwBinPath = "%h/.local/bin/ww",
} = {}) {
  return [
    "[Unit]",
    "Description=WorkWire background service",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${wwBinPath} serve`,
    "Environment=UV_THREADPOOL_SIZE=32",
    "UMask=0077",
    "Restart=on-failure",
    "RestartSec=2",
    "StandardOutput=journal",
    "StandardError=journal",
    "SyslogIdentifier=workwire-ww",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function buildWwFallbackSupervisorScript({
  wwBinPath = path.join(os.homedir(), ".local", "bin", "ww"),
  logPath = resolveWwLogPath(),
} = {}) {
  return [
    "#!/usr/bin/env bash",
    "",
    "set -u",
    "",
    "umask 077",
    "",
    `WW_BIN_PATH=${quoteDesktopExecArg(wwBinPath)}`,
    `LOG_PATH=${quoteDesktopExecArg(logPath)}`,
    "",
    "mkdir -p -- \"$(dirname -- \"$LOG_PATH\")\"",
    "",
    "while true; do",
    "  \"$WW_BIN_PATH\" serve >>\"$LOG_PATH\" 2>&1",
    "  sleep 2",
    "done",
    "",
  ].join("\n");
}

export function buildWwFallbackAutostartEntry({
  launcherPath,
} = {}) {
  return [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    "Name=WorkWire Background Service",
    "Comment=Start the persistent WorkWire background service on login.",
    `Exec=${quoteDesktopExecArg(launcherPath)}`,
    `TryExec=${quoteDesktopExecArg(launcherPath)}`,
    "Terminal=false",
    "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}
