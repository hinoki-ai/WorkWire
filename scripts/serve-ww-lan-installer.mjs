#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  startWwLanInstallerServer,
  WW_LAN_INSTALLER_DEFAULT_HOST,
  WW_LAN_INSTALLER_DEFAULT_OUTPUT_DIR,
  WW_LAN_INSTALLER_DEFAULT_PORT,
} from "../lib/ww-lan-installer.mjs";

function parseArgv(argv = []) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const [key, inlineValue] = value.slice(2).split("=", 2);
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

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:
  node ./scripts/serve-ww-lan-installer.mjs [--host <host>] [--port <port>] [--output <dir>]

Defaults:
  --host   ${WW_LAN_INSTALLER_DEFAULT_HOST}
  --port   ${WW_LAN_INSTALLER_DEFAULT_PORT}
  --output ${WW_LAN_INSTALLER_DEFAULT_OUTPUT_DIR}
`);
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed.flags.help === true || parsed.positionals.includes("-h")) {
    printHelp();
    return;
  }

  const server = await startWwLanInstallerServer({
    host: String(parsed.flags.host || WW_LAN_INSTALLER_DEFAULT_HOST),
    port: parsed.flags.port == null ? WW_LAN_INSTALLER_DEFAULT_PORT : parsed.flags.port,
    outputDir: parsed.flags.output
      ? path.resolve(String(parsed.flags.output))
      : WW_LAN_INSTALLER_DEFAULT_OUTPUT_DIR,
    stdout: process.stdout,
  });

  const shutdown = async () => {
    await server.stop().catch(() => {});
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

await main();
