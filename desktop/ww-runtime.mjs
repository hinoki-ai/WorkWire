import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { extractElectronAppArgv } from "../lib/electron-app-argv.mjs";
import {
  buildLinuxLaunchEnv,
  LINUX_WW_DESKTOP_ENTRY_NAME,
} from "./linux-integration.mjs";
import {
  normalizeWwDesktopArgv,
  parseWwArgv,
  printWwHelp,
  runServeCommand,
  runWwConfigCommand,
  runWwConnectCommand,
  runWwPairCommand,
  wantsWwEngineeringHelp,
} from "../ww.mjs";
import { runRecoveryCli } from "../lib/recovery/ww-recovery-cli.mjs";

export function buildPackagedWwDesktopLaunchSpec({
  argv = [],
  execPath = process.execPath,
  env = process.env,
  platform = process.platform,
} = {}) {
  const launchEnv = buildLinuxLaunchEnv(env, platform, LINUX_WW_DESKTOP_ENTRY_NAME);

  return {
    command: execPath,
    args: normalizeWwDesktopArgv(argv),
    options: {
      env: launchEnv,
      stdio: "inherit",
    },
  };
}

export function launchPackagedWwDesktop({
  argv = extractElectronAppArgv(process.argv),
  execPath = process.execPath,
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  const spec = buildPackagedWwDesktopLaunchSpec({
    argv,
    execPath,
    env,
    platform,
  });

  return spawnImpl(spec.command, spec.args, spec.options);
}

export function resolvePackagedWwRuntimeMode(argv = extractElectronAppArgv(process.argv)) {
  const parsed = parseWwArgv(argv);
  if (parsed.flags.help === true || parsed.positionals.includes("-h") || argv.includes("-h")) {
    return {
      kind: "help",
      argv,
      parsed,
    };
  }

  if (["serve", "connect", "pair", "config", "recovery"].includes(parsed.command)) {
    return {
      kind: "command",
      argv,
      parsed,
    };
  }

  return {
    kind: "desktop",
    argv: normalizeWwDesktopArgv(argv),
    parsed,
  };
}

export async function runPackagedWwRuntime({
  argv = extractElectronAppArgv(process.argv),
  stdout = process.stdout,
  stderr = process.stderr,
  execPath = process.execPath,
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  const mode = resolvePackagedWwRuntimeMode(argv);

  if (mode.kind === "help") {
    printWwHelp(stdout, {
      engineering: wantsWwEngineeringHelp(argv),
    });
    return "exit";
  }

  if (mode.kind === "command") {
    const { command, flags, positionals } = mode.parsed;
    if (command === "serve") {
      return runServeCommand({
        flags,
        stdout,
        stderr,
        launchDesktopImpl: ({ argv: desktopArgv = [] } = {}) => launchPackagedWwDesktop({
          argv: desktopArgv,
          execPath,
          env,
          platform,
          spawnImpl,
        }),
      });
    }

    if (command === "connect") {
      await runWwConnectCommand({
        flags,
        positionals,
        stdout,
        stderr,
      });
      return "exit";
    }

    if (command === "pair") {
      await runWwPairCommand({
        flags,
        positionals,
        stdout,
        stderr,
      });
      return "exit";
    }

    if (command === "recovery") {
      await runRecoveryCli({
        argv: argv.slice(1),
        stdout,
        stderr,
        env,
        baseDir: process.resourcesPath
          ? path.join(process.resourcesPath, "recovery-runtime")
          : process.cwd(),
      });
      return "exit";
    }

    await runWwConfigCommand({
      stdout,
      flags,
    });
    return "exit";
  }

  await import("./ww-main.mjs");
  return "desktop";
}
