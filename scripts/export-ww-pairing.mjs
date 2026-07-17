#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "..");

process.env.WW_HOME_DIR ||= path.join(repoDir, ".workwire");
process.env.WW_CONFIG_DIR ||= path.join(process.env.WW_HOME_DIR, "config");
process.env.WW_PORTAL_PATH ||= path.join(repoDir, "shared");

const { loadWwConfig } = await import("../lib/ww-config-store.mjs");

const outputPathValue = String(process.argv[2] || "").trim();
if (!outputPathValue) {
  process.stderr.write("Usage: node ./scripts/export-ww-pairing.mjs <output-file>\n");
  process.exitCode = 1;
} else {
  const outputPath = path.resolve(outputPathValue);
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  const config = await loadWwConfig();
  const profile = {
    kind: "workwire-pairing-v1",
    createdAt: new Date().toISOString(),
    sourceMachineId: config.service.machineId,
    port: config.service.port,
    token: config.service.token,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporaryPath, outputPath);
  await fs.chmod(outputPath, 0o600);
  process.stdout.write(`Exported WorkWire pairing profile to ${outputPath}\n`);
}
