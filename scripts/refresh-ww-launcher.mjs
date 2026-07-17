#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLinuxWwDesktopEntry } from "../desktop/linux-integration.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const baseDir = path.resolve(path.dirname(scriptPath), "..");

const desktopEntryPath = ensureLinuxWwDesktopEntry({
  baseDir,
});

if (desktopEntryPath) {
  process.stdout.write(`Installed WorkWire launcher at ${desktopEntryPath}\n`);
}
