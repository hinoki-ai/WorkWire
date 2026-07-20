#!/usr/bin/env node
// Stage the Windows recovery-agent bundle: lib/recovery + ws + installer, zipped
// for transfer to a Windows target (USB, SMB, or the Fedora side of a dual-boot).
//   node scripts/package-ww-recovery-agent-windows.mjs [--download-node]
// --download-node fetches the official win-x64 node.exe (latest v22) into the
// bundle so the target needs no internet and no preinstalled Node.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isWwMirrorConflictBasename } from "../lib/ww-fs.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(repoRoot, "artifacts");
const zipPath = path.join(artifactsDir, "ww-recovery-agent-windows.zip");
const nodeUrl = "https://nodejs.org/dist/latest-v22.x/win-x64/node.exe";
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-agent-windows-build-"));
const stageDir = path.join(temporaryRoot, "ww-recovery-agent-windows");
const temporaryZipPath = path.join(temporaryRoot, "ww-recovery-agent-windows.zip");
const nextZipPath = path.join(artifactsDir, `.ww-recovery-agent-windows.zip.${process.pid}.next`);

async function run(file, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`)));
  });
}

async function sha256(filename) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filename));
  return hash.digest("hex");
}

async function assertNoConflictArtifacts(root) {
  const entries = await fs.readdir(root, { recursive: true });
  const conflict = entries.find((entry) => String(entry).split(/[\\/]/u).some(isWwMirrorConflictBasename));
  if (conflict) throw new Error(`Windows recovery bundle contains WW conflict artifact ${conflict}.`);
}

await fs.mkdir(artifactsDir, { recursive: true });
try {
  await fs.mkdir(path.join(stageDir, "node_modules"), { recursive: true });
  // Ship the whole lib/ tree like the Linux installer: lib/recovery imports
  // sibling modules from lib/ (ww-config-store, ww-network), so cherry-picking
  // lib/recovery alone produces ERR_MODULE_NOT_FOUND on the target.
  await fs.cp(path.join(repoRoot, "lib"), path.join(stageDir, "lib"), {
    recursive: true,
    filter: (source) => !isWwMirrorConflictBasename(path.basename(source)),
  });
  await fs.cp(path.join(repoRoot, "node_modules", "ws"), path.join(stageDir, "node_modules", "ws"), {
    recursive: true,
    filter: (source) => !isWwMirrorConflictBasename(path.basename(source)),
  });
  await fs.copyFile(path.join(repoRoot, "package.json"), path.join(stageDir, "package.json"));
  await fs.copyFile(
    path.join(repoRoot, "scripts", "install-ww-recovery-agent-windows.ps1"),
    path.join(stageDir, "install-ww-recovery-agent-windows.ps1"),
  );
  await fs.copyFile(
    path.join(repoRoot, "scripts", "complete-ww-recovery-agent-update-windows.ps1"),
    path.join(stageDir, "complete-ww-recovery-agent-update-windows.ps1"),
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

  await assertNoConflictArtifacts(stageDir);
  await run("python3", ["-m", "zipfile", "-c", temporaryZipPath, stageDir]);
  const listing = await new Promise((resolve, reject) => {
    let output = "";
    const child = spawn("python3", ["-m", "zipfile", "-l", temporaryZipPath], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`python3 exited ${code}`)));
  });
  if (listing.includes("WW conflict")) throw new Error("Windows recovery ZIP contains a WW conflict artifact.");
  await fs.copyFile(temporaryZipPath, nextZipPath);
  await fs.rename(nextZipPath, zipPath);
  const stats = await fs.stat(zipPath);
  process.stdout.write(`Staged privately outside the mirrored workspace.\nWrote ${zipPath} (${(stats.size / 1024 / 1024).toFixed(1)} MiB, sha256 ${await sha256(zipPath)})\n`);
} finally {
  await fs.rm(nextZipPath, { force: true }).catch(() => {});
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
process.stdout.write("On the Windows target (elevated PowerShell, inside the unpacked folder):\n");
process.stdout.write("  powershell -ExecutionPolicy Bypass -File install-ww-recovery-agent-windows.ps1 install -Controller http://192.168.8.104:4852\n");
