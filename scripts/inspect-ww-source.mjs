#!/usr/bin/env node
import { buildWwReleaseInfo } from "../lib/ww-release.mjs";
import { buildWwUpdateSourceInfo } from "../lib/ww-update.mjs";

const [release, update] = await Promise.all([
  buildWwReleaseInfo(),
  buildWwUpdateSourceInfo(),
]);
process.stdout.write(`${JSON.stringify({
  ok: true,
  version: release.version,
  hash: release.hash,
  hashVersion: release.hashVersion,
  updateHash: update.hash,
  updateHashVersion: update.hashVersion,
  files: release.files,
})}\n`);
