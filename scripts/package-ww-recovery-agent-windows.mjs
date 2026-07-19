#!/usr/bin/env node
// Stage the Windows recovery-agent bundle: lib/recovery + ws + installer, zipped
// for transfer to a Windows target (USB, SMB, or the Fedora side of a dual-boot).
//   node scripts/package-ww-recovery-agent-windows.mjs [--download-node]
// --download-node fetches the official win-x64 node.exe (latest v22) into the
// bundle so the target needs no internet and no preinstalled Node.
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(repoRoot, "artifacts");
const stageDir = path.join(artifactsDir, "ww-recovery-agent-windows");
const zipPath = path.join(artifactsDir, "ww-recovery-agent-windows.zip");
const nodeUrl = "https://nodejs.org/dist/latest-v22.x/win-x64/node.exe";

async function run(file, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`)));
  });
}

await fs.rm(stageDir, { recursive: true, force: true });
await fs.mkdir(path.join(stageDir, "node_modules"), { recursive: true });
// Ship the whole lib/ tree like the Linux installer: lib/recovery imports
// sibling modules from lib/ (ww-config-store, ww-network), so cherry-picking
// lib/recovery alone produces ERR_MODULE_NOT_FOUND on the target.
await fs.cp(path.join(repoRoot, "lib"), path.join(stageDir, "lib"), { recursive: true });
await fs.cp(path.join(repoRoot, "node_modules", "ws"), path.join(stageDir, "node_modules", "ws"), { recursive: true });
await fs.copyFile(path.join(repoRoot, "package.json"), path.join(stageDir, "package.json"));
await fs.copyFile(
  path.join(repoRoot, "scripts", "install-ww-recovery-agent-windows.ps1"),
  path.join(stageDir, "install-ww-recovery-agent-windows.ps1"),
);

const cachedNode = path.join(artifactsDir, "node-win-x64.exe");
if (process.argv.includes("--download-node")) {
  const haveCache = await fs.stat(cachedNode).then(() => true).catch(() => false);
  if (!haveCache) {
    process.stdout.write(`Downloading ${nodeUrl} ...\n`);
    const response = await fetch(nodeUrl);
    if (!response.ok) throw new Error(`node.exe download failed: HTTP ${response.status}`);
    await fs.writeFile(cachedNode, Buffer.from(await response.arrayBuffer()));
  }
  await fs.copyFile(cachedNode, path.join(stageDir, "node.exe"));
} else {
  process.stdout.write("Skipping node.exe (pass --download-node to embed it; otherwise the target needs Node 22+).\n");
}

await fs.rm(zipPath, { force: true });
await run("python3", ["-m", "zipfile", "-c", zipPath, stageDir]);
const stats = await fs.stat(zipPath);
process.stdout.write(`Staged ${stageDir}\nWrote ${zipPath} (${(stats.size / 1024 / 1024).toFixed(1)} MiB)\n`);
process.stdout.write("On the Windows target (elevated PowerShell, inside the unpacked folder):\n");
process.stdout.write("  powershell -ExecutionPolicy Bypass -File install-ww-recovery-agent-windows.ps1 install -Controller http://192.168.8.104:4852\n");
