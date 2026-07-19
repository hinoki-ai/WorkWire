#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import fsSync from "node:fs";
import { WW_RECOVERY_PROTOCOL_VERSION } from "../lib/recovery/ww-recovery-config.mjs";
import { COMPLETE_ACTION_NAMES } from "../lib/recovery/ww-recovery-actions.mjs";

const flags = {};
for (let index = 2; index < process.argv.length; index += 2) flags[process.argv[index].slice(2)] = process.argv[index + 1];
const directory = path.resolve(flags.directory);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
const assets = {};
for (const name of await fs.readdir(directory)) {
  if (["manifest.json", "SHA256SUMS"].includes(name)) continue;
  const filename = path.join(directory, name);
  const stats = await fs.stat(filename);
  if (!stats.isFile()) continue;
  const hash = await hashFile(filename);
  assets[name] = { size: stats.size, sha256: hash };
}
const manifest = {
  kind: "workwire-recovery-image-v1",
  appVersion: JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version,
  recoveryProtocol: WW_RECOVERY_PROTOCOL_VERSION,
  actionCatalogVersion: 1,
  actions: COMPLETE_ACTION_NAMES,
  architecture: "x86_64",
  distribution: "Debian bookworm",
  nodeVersion: flags["node-version"],
  builderImage: flags["builder-image"],
  builderDigest: flags["builder-digest"] || null,
  gitRevision: flags["git-revision"] || null,
  builtAt: new Date().toISOString(),
  recoveryCredential: "root password is set by WW_RECOVERY_ROOT_PASSWORD; prototype default is workwire",
  assets,
};
await fs.writeFile(path.resolve(flags.output), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
