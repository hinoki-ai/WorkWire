#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isWwMirrorConflictBasename } from "../lib/ww-fs.mjs";
import { buildWwReleaseInfo } from "../lib/ww-release.mjs";
import { buildWwUpdateSourceInfo } from "../lib/ww-update.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(repoRoot, "artifacts");
const archivePath = path.join(artifactsDir, "ww-source.tar.gz");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ww-source-build-"));
const stageDir = path.join(temporaryRoot, "source");
const temporaryArchivePath = path.join(temporaryRoot, "ww-source.tar.gz");
const nextArchivePath = path.join(artifactsDir, `.ww-source.tar.gz.${process.pid}.next`);
const manifestName = ".workwire-deploy-manifest.json";

function safeRelative(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new TypeError(`Unsafe source archive path: ${value}`);
  }
  return normalized;
}

async function listSourceFiles() {
  const { stdout } = await execFileAsync("git", [
    "ls-files", "-z", "--cached", "--others", "--exclude-standard",
  ], { cwd: repoRoot, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(stdout.toString("utf8").split("\0").filter(Boolean).map(safeRelative))]
    .filter((relative) => !relative.split("/").some(isWwMirrorConflictBasename))
    .sort((left, right) => left.localeCompare(right));
}

async function copyEntry(relative) {
  const source = path.join(repoRoot, relative);
  const destination = path.join(stageDir, relative);
  const stats = await fs.lstat(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (stats.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), destination);
    return;
  }
  if (!stats.isFile()) throw new TypeError(`Unsupported source entry: ${relative}`);
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stats.mode & 0o777);
}

async function sha256(filename) {
  const hash = createHash("sha256");
  const data = await fs.readFile(filename);
  hash.update(data);
  return hash.digest("hex");
}

await fs.mkdir(artifactsDir, { recursive: true });
await fs.mkdir(stageDir, { recursive: true });
try {
  const files = await listSourceFiles();
  await Promise.all(files.map(copyEntry));
  const [release, update] = await Promise.all([
    buildWwReleaseInfo({ baseDir: repoRoot }),
    buildWwUpdateSourceInfo({ baseDir: repoRoot }),
  ]);
  const manifest = {
    schema: "workwire-source-deployment/v1",
    createdAt: new Date().toISOString(),
    release: {
      version: release.version,
      hash: release.hash,
      hashVersion: release.hashVersion,
      updateHash: update.hash,
      updateHashVersion: update.hashVersion,
      files: release.files,
    },
    files,
  };
  await fs.writeFile(path.join(stageDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await execFileAsync("tar", ["-C", stageDir, "-czf", temporaryArchivePath, "."], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  const { stdout: archiveListing } = await execFileAsync("tar", ["-tzf", temporaryArchivePath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const conflict = archiveListing.split(/\r?\n/u)
    .find((entry) => entry.split("/").some(isWwMirrorConflictBasename));
  if (conflict) throw new Error(`Source deployment archive contains WW conflict artifact ${conflict}.`);
  await fs.copyFile(temporaryArchivePath, nextArchivePath);
  await fs.rename(nextArchivePath, archivePath);
  const stats = await fs.stat(archivePath);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    archivePath,
    bytes: stats.size,
    sha256: await sha256(archivePath),
    release: manifest.release,
    sourceFiles: files.length,
  })}\n`);
} finally {
  await fs.rm(nextArchivePath, { force: true }).catch(() => {});
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
