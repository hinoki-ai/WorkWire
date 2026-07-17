import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const WORKWIRE_APP_NAME = "WorkWire";
export const WORKWIRE_WINDOW_CLASS = WORKWIRE_APP_NAME;
export const WORKWIRE_APP_COMMENT = "Local two-machine file desk for the WorkWire portal.";
export const LINUX_WW_DESKTOP_ENTRY_NAME = "workwire.desktop";
export const LINUX_WW_SERVICE_UNIT_NAME = "workwire-ww.service";
export const WORKWIRE_LAUNCHER_RELATIVE_PATH = path.join("scripts", "launch-workwire.sh");

const WORKWIRE_ICON_CANDIDATE_RELATIVE_PATHS = [
  path.join("desktop", "assets", "workwire", "icon.png"),
  path.join("desktop", "assets", "workwire", "icon.ico"),
];

function quoteDesktopExecArg(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")}"`;
}

function quoteShellSingleArg(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function resolveIconPath(baseDir, candidates, { existsImpl = fs.existsSync } = {}) {
  return candidates
    .map((candidate) => path.join(baseDir, candidate))
    .find((candidate) => existsImpl(candidate)) || null;
}

export function resolveWwIconPath(baseDir, { existsImpl = fs.existsSync } = {}) {
  return resolveIconPath(baseDir, WORKWIRE_ICON_CANDIDATE_RELATIVE_PATHS, { existsImpl });
}

function trimShellQuotedValue(value = "") {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function expandHomeDir(candidate = "", homeDir = os.homedir()) {
  const normalized = trimShellQuotedValue(candidate)
    .replaceAll("${HOME}", homeDir)
    .replaceAll("$HOME", homeDir);
  if (!normalized) {
    return "";
  }
  return path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.join(homeDir, normalized);
}

export function resolveLinuxDesktopEntryPath({
  env = process.env,
  homeDir = os.homedir(),
  desktopEntryName = LINUX_WW_DESKTOP_ENTRY_NAME,
} = {}) {
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(homeDir, ".local", "share");
  return path.join(dataHome, "applications", desktopEntryName);
}

export function resolveLinuxDesktopDir({
  env = process.env,
  homeDir = os.homedir(),
  existsImpl = fs.existsSync,
  readFileImpl = fs.readFileSync,
} = {}) {
  const envDesktopDir = expandHomeDir(env.XDG_DESKTOP_DIR || "", homeDir);
  if (envDesktopDir) {
    return envDesktopDir;
  }

  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
  const userDirsPath = path.join(configHome, "user-dirs.dirs");
  if (existsImpl(userDirsPath)) {
    try {
      const userDirs = String(readFileImpl(userDirsPath, "utf8") || "");
      const match = userDirs.match(/^\s*XDG_DESKTOP_DIR\s*=\s*(.+?)\s*$/m);
      const desktopDir = expandHomeDir(match?.[1] || "", homeDir);
      if (desktopDir) {
        return desktopDir;
      }
    } catch {}
  }

  return path.join(homeDir, "Desktop");
}

export function resolveLinuxDesktopShortcutPath({
  env = process.env,
  homeDir = os.homedir(),
  desktopEntryName = LINUX_WW_DESKTOP_ENTRY_NAME,
  existsImpl = fs.existsSync,
  readFileImpl = fs.readFileSync,
} = {}) {
  return path.join(
    resolveLinuxDesktopDir({
      env,
      homeDir,
      existsImpl,
      readFileImpl,
    }),
    desktopEntryName,
  );
}

export function resolveLinuxUserServiceUnitPath({
  env = process.env,
  homeDir = os.homedir(),
  unitName = LINUX_WW_SERVICE_UNIT_NAME,
} = {}) {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
  return path.join(configHome, "systemd", "user", unitName);
}

export function buildLinuxLaunchEnv(
  env = process.env,
  platform = process.platform,
  desktopEntryName = LINUX_WW_DESKTOP_ENTRY_NAME,
) {
  if (platform !== "linux" || env.CHROME_DESKTOP) {
    return env;
  }

  return {
    ...env,
    CHROME_DESKTOP: desktopEntryName,
  };
}

function buildLinuxDesktopEntryTemplate({
  baseDir,
  launchScriptPath,
  iconPath = resolveWwIconPath(baseDir),
  appName,
  comment,
  startupWmClass = appName,
  categories = ["Game", "Utility"],
} = {}) {
  const normalizedCategories = Array.isArray(categories)
    ? categories.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  return [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    `Name=${appName}`,
    `Comment=${comment}`,
    `Exec=${quoteDesktopExecArg(launchScriptPath)} %U`,
    `TryExec=${launchScriptPath}`,
    `Path=${baseDir}`,
    ...(iconPath ? [`Icon=${iconPath}`] : []),
    "Terminal=false",
    "StartupNotify=true",
    ...(normalizedCategories.length > 0
      ? [`Categories=${normalizedCategories.join(";")};`]
      : []),
    `StartupWMClass=${startupWmClass}`,
    `X-GNOME-WMClass=${startupWmClass}`,
    "",
  ].join("\n");
}

export function buildLinuxWwDesktopEntry({
  baseDir,
  launchScriptPath = path.join(baseDir, WORKWIRE_LAUNCHER_RELATIVE_PATH),
  iconPath = resolveWwIconPath(baseDir),
  appName = WORKWIRE_APP_NAME,
  comment = WORKWIRE_APP_COMMENT,
  startupWmClass = WORKWIRE_WINDOW_CLASS,
  categories = ["Utility", "FileTools", "Network"],
} = {}) {
  return buildLinuxDesktopEntryTemplate({
    baseDir,
    launchScriptPath,
    iconPath,
    appName,
    comment,
    startupWmClass,
    categories,
  });
}

export function buildLinuxWwServiceUnit({
  baseDir,
  launchCommandPath = path.join(baseDir, "scripts", "ww"),
  description = "WorkWire peer service",
} = {}) {
  const launchCommand = `exec ${quoteDesktopExecArg(launchCommandPath)} serve`;

  return [
    "[Unit]",
    `Description=${description}`,
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${baseDir}`,
    `ExecStart=/usr/bin/env bash -lc ${quoteShellSingleArg(launchCommand)}`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function ensureLinuxDesktopEntryFile({
  baseDir,
  desktopEntryName,
  buildDesktopEntryImpl,
  resolveIconPathImpl = resolveWwIconPath,
  launchScriptPath,
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  existsImpl = fs.existsSync,
  mkdirImpl = fs.mkdirSync,
  readFileImpl = fs.readFileSync,
  writeFileImpl = fs.writeFileSync,
} = {}) {
  if (platform !== "linux") {
    return null;
  }

  if (!existsImpl(launchScriptPath)) {
    return null;
  }

  const iconPath = resolveIconPathImpl(baseDir, { existsImpl });
  const desktopEntryPath = resolveLinuxDesktopEntryPath({
    env,
    homeDir,
    desktopEntryName,
  });
  const nextContents = buildDesktopEntryImpl({
    baseDir,
    launchScriptPath,
    iconPath,
  });

  let currentContents = null;
  if (existsImpl(desktopEntryPath)) {
    try {
      currentContents = readFileImpl(desktopEntryPath, "utf8");
    } catch {}
  }

  if (currentContents !== nextContents) {
    mkdirImpl(path.dirname(desktopEntryPath), { recursive: true });
    writeFileImpl(desktopEntryPath, nextContents, "utf8");
  }

  return desktopEntryPath;
}

export function ensureLinuxWwDesktopEntry({
  baseDir,
  launchScriptPath = path.join(baseDir, WORKWIRE_LAUNCHER_RELATIVE_PATH),
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  existsImpl = fs.existsSync,
  mkdirImpl = fs.mkdirSync,
  readFileImpl = fs.readFileSync,
  writeFileImpl = fs.writeFileSync,
} = {}) {
  return ensureLinuxDesktopEntryFile({
    baseDir,
    desktopEntryName: LINUX_WW_DESKTOP_ENTRY_NAME,
    buildDesktopEntryImpl: buildLinuxWwDesktopEntry,
    resolveIconPathImpl: resolveWwIconPath,
    launchScriptPath,
    platform,
    env,
    homeDir,
    existsImpl,
    mkdirImpl,
    readFileImpl,
    writeFileImpl,
  });
}

export function ensureLinuxDesktopShortcut({
  desktopEntryPath,
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  enabled = false,
  desktopEntryName = LINUX_WW_DESKTOP_ENTRY_NAME,
  existsImpl = fs.existsSync,
  mkdirImpl = fs.mkdirSync,
  readFileImpl = fs.readFileSync,
  writeFileImpl = fs.writeFileSync,
  chmodImpl = fs.chmodSync,
} = {}) {
  if (
    platform !== "linux"
    || !enabled
    || !desktopEntryPath
    || !existsImpl(desktopEntryPath)
  ) {
    return null;
  }

  const shortcutPath = resolveLinuxDesktopShortcutPath({
    env,
    homeDir,
    desktopEntryName,
    existsImpl,
    readFileImpl,
  });
  const nextContents = readFileImpl(desktopEntryPath, "utf8");

  let currentContents = null;
  if (existsImpl(shortcutPath)) {
    try {
      currentContents = readFileImpl(shortcutPath, "utf8");
    } catch {}
  }

  if (currentContents !== nextContents) {
    mkdirImpl(path.dirname(shortcutPath), { recursive: true });
    writeFileImpl(shortcutPath, nextContents, "utf8");
  }

  try {
    chmodImpl(shortcutPath, 0o755);
  } catch {}

  return shortcutPath;
}
