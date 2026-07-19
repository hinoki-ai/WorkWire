#!/usr/bin/env node

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRecoveryController } from "../lib/recovery/ww-recovery-controller.mjs";
import { createRecoveryClient } from "../lib/recovery/ww-recovery-client.mjs";

const execFileAsync = promisify(execFile);
const TERMINAL = new Set(["succeeded", "failed", "canceled", "interrupted", "abandoned"]);

function flags(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    result[item.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

function safeOutputDirectory(value) {
  const target = path.resolve(String(value));
  const workspace = path.resolve(process.cwd());
  if (target === workspace || !target.startsWith(`${workspace}${path.sep}`)) {
    throw new Error(`QEMU output must be a child of the workspace: ${target}`);
  }
  return target;
}

async function waitFor(task, { timeoutMs = 240_000, intervalMs = 250, label = "condition" } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await task();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}.${lastError ? ` Last error: ${lastError.message}` : ""}`);
}

async function runJob(client, input, { timeoutMs = 240_000, accept = ["succeeded"] } = {}) {
  const job = await client.createJob(input);
  const result = await waitFor(async () => {
    const value = await client.getJob(job.id);
    return TERMINAL.has(value.job.state) ? value : null;
  }, { timeoutMs, label: `job ${job.id}` });
  if (!accept.includes(result.job.state)) {
    throw new Error(`Recovery job ${job.id} ended ${result.job.state}: ${JSON.stringify(result.job.result)}`);
  }
  return result;
}

async function main() {
  const options = flags(process.argv.slice(2));
  const stateRoot = path.resolve(String(process.env.WW_RECOVERY_STATE_DIR || path.join(process.env.HOME || "/tmp", ".config", "workwire", "recovery")));
  const imageDir = path.resolve(String(options.image || path.join(stateRoot, "boot", "live")));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = safeOutputDirectory(options.output || path.join(process.cwd(), "artifacts", "recovery-qemu", stamp));
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const diskPath = path.join(outputDir, "patient.qcow2");
  if (path.dirname(diskPath) !== outputDir || !diskPath.endsWith("patient.qcow2")) throw new Error("Refusing an unresolved QEMU disk path.");
  for (const name of ["vmlinuz", "initrd.img", "filesystem.squashfs", "manifest.json"]) {
    const stats = await fs.stat(path.join(imageDir, name)).catch(() => null);
    if (!stats?.isFile()) throw new Error(`Verified recovery image artifact ${name} is missing from ${imageDir}.`);
  }
  await execFileAsync("qemu-img", ["create", "-f", "qcow2", diskPath, String(options["disk-size"] || "4G")]);
  const controllerState = path.join(outputDir, "controller-state");
  // The recovery boot server serves live artifacts from <stateDir>/boot/live.
  // The controller keeps its durable state in this isolated dir, so link the
  // verified image into it; otherwise the PXE fetch cannot find the squashfs
  // and the live system aborts with "Unable to find a live file system".
  const controllerBootLive = path.join(controllerState, "boot", "live");
  await fs.mkdir(controllerBootLive, { recursive: true });
  for (const name of ["vmlinuz", "initrd.img", "filesystem.squashfs", "SHA256SUMS", "manifest.json"]) {
    const source = path.join(imageDir, name);
    if (!fsSync.existsSync(source)) continue;
    const target = path.join(controllerBootLive, name);
    await fs.rm(target, { force: true });
    await fs.symlink(source, target).catch(async () => {
      await fs.copyFile(source, target);
    });
  }
  const controller = createRecoveryController({
    config: {
      stateDir: controllerState,
      host: "0.0.0.0",
      port: 0,
      bootHost: "0.0.0.0",
      bootPort: 0,
      heartbeatMs: 500,
      staleAfterMs: 1_500,
      offlineAfterMs: 3_000,
    },
    log: (message) => fs.appendFile(path.join(outputDir, "controller.log"), `${new Date().toISOString()} ${message}\n`).catch(() => {}),
  });
  const info = await controller.start();
  const client = createRecoveryClient({ url: `http://127.0.0.1:${info.port}`, timeoutMs: 10_000, transferTimeoutMs: 0 });
  const qemuLog = fsSync.createWriteStream(path.join(outputDir, "qemu-serial.log"), { flags: "a", mode: 0o600 });
  const qemuArgs = [
    "-machine", "q35",
    "-m", String(options.memory || "2048"),
    "-smp", "2",
    "-uuid", "12345678-1234-4abc-8def-1234567890ab",
    "-kernel", path.join(imageDir, "vmlinuz"),
    "-initrd", path.join(imageDir, "initrd.img"),
    "-append", `boot=live components ip=dhcp fetch=http://10.0.2.2:${info.boot.port}/v1/recovery/boot/live/filesystem.squashfs ww.controller=http://10.0.2.2:${info.port} ww.mode=pxe ww.agent-name=qemu-patient console=ttyS0,115200n8`,
    "-netdev", "user,id=lan",
    "-device", "virtio-net-pci,netdev=lan,mac=52:54:00:12:34:56",
    "-drive", `if=none,id=patient,file=${diskPath},format=qcow2,cache=unsafe`,
    "-device", "virtio-blk-pci,drive=patient,serial=WWQEMU001",
    "-display", "none",
    "-serial", "stdio",
  ];
  const kvm = await fs.access("/dev/kvm", fsSync.constants.R_OK | fsSync.constants.W_OK).then(() => true).catch(() => false);
  qemuArgs.unshift("-accel", kvm ? "kvm" : "tcg");
  const qemu = spawn("qemu-system-x86_64", qemuArgs, { stdio: ["ignore", "pipe", "pipe"] });
  qemu.stdout.pipe(qemuLog, { end: false });
  qemu.stderr.pipe(qemuLog, { end: false });
  let qemuExit = null;
  qemu.once("close", (exitCode, signal) => { qemuExit = { exitCode, signal }; });
  const stopQemu = () => {
    if (qemu.exitCode === null && qemu.signalCode === null) qemu.kill("SIGTERM");
  };
  process.once("SIGINT", stopQemu);
  process.once("SIGTERM", stopQemu);

  const summary = { outputDir, imageDir, controller: info, kvm, steps: [] };
  try {
    const agent = await waitFor(async () => {
      if (qemuExit) throw new Error(`QEMU exited before agent check-in: ${JSON.stringify(qemuExit)}`);
      return (await client.listAgents()).find((record) => record.state === "online" && record.mode === "pxe");
    }, { timeoutMs: 300_000, label: "PXE live recovery agent" });
    summary.agentId = agent.agentId;
    summary.initialBootId = agent.bootId;
    summary.steps.push("agent-online");

    const inventory = await client.requestInventory(agent.agentId, { wait: true, timeoutMs: 180_000 });
    const patientDisk = inventory.block.devices.find((device) => device.type === "disk" && device.canonicalPath === "/dev/vda")
      || inventory.block.devices.find((device) => device.type === "disk" && !device.recoveryBootMedium);
    if (!patientDisk) throw new Error("QEMU patient disk was not present in recovery inventory.");
    summary.patientDisk = { deviceId: patientDisk.deviceId, path: patientDisk.canonicalPath, size: patientDisk.size };
    const caseRecord = await client.createCase({ targetAgentId: agent.agentId, goal: "QEMU destructive recovery validation", mode: "unrestricted", createdBy: "qemu-harness" });
    const jobBase = { caseId: caseRecord.id, targetAgentId: agent.agentId, mode: "unrestricted", createdBy: "qemu-harness", force: true };
    const typed = (goal, action, params, timeoutMs = 240_000) => runJob(client, {
      ...jobBase,
      goal,
      steps: [{ id: `qemu_${summary.steps.length + 1}`, action, params, force: true, timeoutMs }],
    }, { timeoutMs: timeoutMs + 30_000 });

    await typed("Create GPT", "disk.table.create", { deviceId: patientDisk.deviceId, path: patientDisk.canonicalPath, label: "gpt", force: true });
    await typed("Create EFI partition", "disk.partition.create", { deviceId: patientDisk.deviceId, path: patientDisk.canonicalPath, name: "EFI", filesystemType: "fat32", start: "1MiB", end: "257MiB", force: true });
    await typed("Mark EFI partition", "disk.partition.set-type", { deviceId: patientDisk.deviceId, path: patientDisk.canonicalPath, number: 1, type: "EF00", force: true });
    await typed("Create root partition", "disk.partition.create", { deviceId: patientDisk.deviceId, path: patientDisk.canonicalPath, name: "root", filesystemType: "ext4", start: "257MiB", end: "100%", force: true });
    let refreshed = await client.requestInventory(agent.agentId, { wait: true, timeoutMs: 180_000 });
    const efi = refreshed.block.devices.find((device) => device.canonicalPath === "/dev/vda1");
    const root = refreshed.block.devices.find((device) => device.canonicalPath === "/dev/vda2");
    if (!efi || !root) throw new Error("QEMU partitions did not appear after GPT creation.");
    await typed("Format EFI", "filesystem.create", { deviceId: efi.deviceId, path: efi.canonicalPath, filesystemType: "vfat", label: "WW_EFI", force: true });
    await typed("Format root", "filesystem.create", { deviceId: root.deviceId, path: root.canonicalPath, filesystemType: "ext4", label: "WW_ROOT", force: true });
    summary.steps.push("partitioned-formatted");

    const markerPath = "/mnt/workwire/qemu-root/workwire-marker.txt";
    await runJob(client, {
      ...jobBase,
      goal: "Mount, write, and read marker",
      steps: [
        { id: "mkdir_mount", action: "command.exec", params: { argv: ["mkdir", "-p", "/mnt/workwire/qemu-root"] } },
        { id: "mount_root", action: "filesystem.mount", params: { path: root.canonicalPath, filesystemType: "ext4", target: "/mnt/workwire/qemu-root" } },
        { id: "write_marker", action: "file.write", params: { path: markerPath, contents: "WORKWIRE-QEMU-MARKER\n" } },
        { id: "read_marker", action: "file.read", params: { path: markerPath } },
        { id: "unmount_root", action: "filesystem.unmount", params: { target: "/mnt/workwire/qemu-root" } },
      ],
    });
    summary.steps.push("marker-written-read");

    const backup = await typed("Back up GPT and edge sectors", "disk.table.backup", { deviceId: patientDisk.deviceId, path: patientDisk.canonicalPath, upload: true, force: true }, 300_000);
    const backupResult = backup.job.result?.steps?.[0];
    const gptBackup = backupResult?.files?.find((filename) => filename.endsWith(".gpt"));
    if (!gptBackup) throw new Error(`GPT backup path missing from result: ${JSON.stringify(backupResult)}`);
    summary.steps.push("partition-table-backed-up");

    await runJob(client, {
      ...jobBase,
      goal: "Corrupt disposable GPT",
      steps: [{ id: "corrupt_gpt", action: "command.exec", params: { argv: ["dd", "if=/dev/zero", `of=${patientDisk.canonicalPath}`, "bs=512", "count=34", "conv=notrunc", "status=none"] } }],
    });
    await client.requestInventory(agent.agentId, { wait: true, timeoutMs: 180_000 });
    await typed("Restore GPT backup", "disk.table.restore", { deviceId: patientDisk.deviceId, path: patientDisk.canonicalPath, backupPath: gptBackup, format: "sgdisk", force: true });
    refreshed = await client.requestInventory(agent.agentId, { wait: true, timeoutMs: 180_000 });
    if (!refreshed.block.devices.some((device) => device.canonicalPath === "/dev/vda2")) throw new Error("Restored GPT did not restore the root partition.");
    await typed("Repair ext filesystem", "filesystem.repair", { path: "/dev/vda2", deviceId: root.deviceId, filesystemType: "ext4", force: true }, 300_000);
    summary.steps.push("gpt-corrupted-restored-ext-repaired");

    const hostPayload = path.join(outputDir, "host-to-guest.txt");
    await fs.writeFile(hostPayload, "HOST-TO-GUEST-ARTIFACT\n", { mode: 0o600 });
    const uploaded = await client.uploadArtifact({ caseId: caseRecord.id, kind: "user-upload", filename: "host-to-guest.txt" }, hostPayload);
    await runJob(client, {
      ...jobBase,
      goal: "Download controller artifact in guest and verify",
      steps: [
        { id: "artifact_download", action: "artifact.download", params: { artifactId: uploaded.id, path: "/tmp/host-to-guest.txt", hash: uploaded.hash, force: true } },
        { id: "artifact_verify", action: "file.read", params: { path: "/tmp/host-to-guest.txt" } },
      ],
    });
    const guestUpload = await runJob(client, {
      ...jobBase,
      goal: "Upload guest artifact",
      steps: [{ id: "artifact_upload", action: "artifact.upload", params: { path: "/tmp/host-to-guest.txt", kind: "user-upload" } }],
    });
    const guestArtifact = guestUpload.job.result?.steps?.[0]?.artifact;
    if (!guestArtifact?.id) throw new Error("Guest artifact upload did not return an artifact ID.");
    const roundtripPath = path.join(outputDir, "guest-to-host.txt");
    await client.downloadArtifact(guestArtifact.id, { destinationPath: roundtripPath });
    if ((await fs.readFile(roundtripPath, "utf8")) !== "HOST-TO-GUEST-ARTIFACT\n") throw new Error("Artifact round trip changed bytes.");
    summary.steps.push("artifact-roundtrip");

    await runJob(client, {
      ...jobBase,
      goal: "Reboot recovery guest",
      steps: [{ id: "reboot", action: "power.reboot", params: { method: "reboot" }, force: true }],
    }, { timeoutMs: 30_000, accept: ["interrupted", "failed"] }).catch(() => {});
    const rebooted = await waitFor(async () => {
      const record = (await client.listAgents()).find((item) => item.agentId === agent.agentId && item.state === "online");
      return record?.bootId && record.bootId !== agent.bootId ? record : null;
    }, { timeoutMs: 300_000, label: "same agent identity after QEMU reboot" });
    summary.rebootedBootId = rebooted.bootId;
    summary.steps.push("same-identity-new-boot");

    await runJob(client, {
      ...jobBase,
      goal: "Power off recovery guest",
      steps: [{ id: "poweroff", action: "power.poweroff", params: { method: "poweroff" }, force: true }],
    }, { timeoutMs: 30_000, accept: ["interrupted", "failed"] }).catch(() => {});
    await waitFor(() => qemuExit, { timeoutMs: 120_000, label: "QEMU poweroff" });
    summary.qemuExit = qemuExit;
    summary.steps.push("portal-poweroff");
    summary.ok = true;
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`WorkWire QEMU recovery validation passed. Logs: ${outputDir}\n`);
  } catch (error) {
    summary.ok = false;
    summary.error = { code: error.code, message: error.message, stack: error.stack };
    await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    throw error;
  } finally {
    stopQemu();
    await new Promise((resolve) => qemu.exitCode !== null || qemu.signalCode !== null ? resolve() : qemu.once("close", resolve));
    qemuLog.end();
    await controller.stop();
    process.off("SIGINT", stopQemu);
    process.off("SIGTERM", stopQemu);
    await fs.rm(diskPath, { force: true });
  }
}

await main();
