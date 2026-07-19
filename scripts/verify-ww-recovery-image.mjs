#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

const directoryIndex = process.argv.indexOf("--directory");
const directory = path.resolve(directoryIndex === -1 ? process.env.WW_RECOVERY_STATE_DIR || path.join(process.env.HOME, ".config", "workwire", "recovery", "boot", "live") : process.argv[directoryIndex + 1]);
const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
for (const required of ["vmlinuz", "initrd.img", "filesystem.squashfs"]) {
  const expected = manifest.assets?.[required];
  if (!expected) throw new Error(`Recovery manifest is missing ${required}.`);
  const filename = path.join(directory, required);
  const stats = await fs.stat(filename);
  const actual = await hashFile(filename);
  if (stats.size !== expected.size || actual !== expected.sha256) throw new Error(`Recovery boot artifact ${required} failed verification.`);
}
if (manifest.recoveryProtocol !== 1) throw new Error(`Unsupported recovery image protocol ${manifest.recoveryProtocol}.`);
const sums = await fs.readFile(path.join(directory, "SHA256SUMS"), "utf8");
for (const required of ["vmlinuz", "initrd.img", "filesystem.squashfs"]) {
  const expectedLine = `${manifest.assets[required].sha256}  ${required}`;
  if (!sums.split("\n").includes(expectedLine)) throw new Error(`SHA256SUMS does not contain the verified ${required} digest.`);
}

let buildInfo;
try {
  const result = await execFileAsync("unsquashfs", ["-cat", path.join(directory, "filesystem.squashfs"), "etc/workwire-recovery-build.json"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  buildInfo = JSON.parse(result.stdout);
} catch (error) {
  throw new Error(`Unable to verify the recovery SquashFS build manifest with unsquashfs: ${error.message}`);
}
if (Number(buildInfo.recoveryProtocol) !== 1) throw new Error(`SquashFS recovery protocol ${buildInfo.recoveryProtocol} is unsupported.`);
if (!String(buildInfo.nodeVersion || "").startsWith("22.")) throw new Error(`SquashFS Node runtime is not pinned to Node 22: ${buildInfo.nodeVersion}.`);
for (const tool of ["bash", "ip", "curl", "sshd", "lsblk", "findmnt", "blkid", "sfdisk", "fdisk", "parted", "sgdisk", "ddrescue", "smartctl", "nvme", "mdadm", "pvs", "cryptsetup", "mount", "chroot", "e2fsck", "xfs_repair", "btrfs", "fsck.fat", "fsck.exfat", "ntfsfix", "grub-install", "efibootmgr"]) {
  if (!buildInfo.tools?.[tool]) throw new Error(`Recovery SquashFS is missing core tool ${tool}.`);
}
if (!Array.isArray(buildInfo.actions) || !buildInfo.actions.includes("command.exec") || !buildInfo.actions.includes("shell.exec")) {
  throw new Error("Recovery SquashFS action catalog is incomplete.");
}

let initrdListing = "";
let initrdTool = "";
for (const candidate of [["lsinitrd", [path.join(directory, "initrd.img")]], ["lsinitramfs", [path.join(directory, "initrd.img")]]]) {
  try {
    initrdListing = (await execFileAsync(candidate[0], candidate[1], { maxBuffer: 64 * 1024 * 1024 })).stdout;
    initrdTool = candidate[0];
    break;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Unable to inspect recovery initrd with ${candidate[0]}: ${error.message}`);
  }
}
if (!initrdTool) throw new Error("lsinitrd or lsinitramfs is required to verify the recovery initrd.");
if (!/(?:scripts\/live|live-boot)/.test(initrdListing)) throw new Error("Recovery initrd does not contain live-boot scripts.");
if (!/(?:ipconfig|dhclient|network)/i.test(initrdListing)) throw new Error("Recovery initrd does not contain recognizable network bootstrap support.");
process.stdout.write(`Verified WorkWire recovery image at ${directory}\n`);
process.stdout.write(`${JSON.stringify({
  protocol: manifest.recoveryProtocol,
  node: buildInfo.nodeVersion,
  initrdInspector: initrdTool,
  optionalMissing: buildInfo.optionalMissing,
  assets: manifest.assets,
}, null, 2)}\n`);
