#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WW_RECOVERY_PROTOCOL_VERSION } from "../lib/recovery/ww-recovery-config.mjs";

const flags = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = String(process.argv[index] || "").replace(/^--/, "");
  if (key) flags[key] = process.argv[index + 1];
}
if (!flags.output) throw new Error("--output is required.");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const record = {
  kind: "workwire-recovery-live-v1",
  appVersion: packageMetadata.version,
  recoveryProtocol: WW_RECOVERY_PROTOCOL_VERSION,
  gitRevision: flags["git-revision"] || null,
  builtAt: new Date().toISOString(),
  distribution: "Debian bookworm",
  credential: "root password comes from WW_RECOVERY_ROOT_PASSWORD; prototype default is workwire",
};
const output = path.resolve(flags.output);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
