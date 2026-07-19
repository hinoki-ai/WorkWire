import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  createRecoveryError,
  RECOVERY_ERROR_CODES,
} from "./ww-recovery-protocol.mjs";

function required(params, key) {
  const value = params?.[key];
  if (value === undefined || value === null || value === "") {
    throw createRecoveryError(RECOVERY_ERROR_CODES.BAD_REQUEST, `Recovery action requires ${key}.`);
  }
  return value;
}

function array(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function boolean(value) {
  return value === true;
}

function actionError(message, details) {
  return createRecoveryError(RECOVERY_ERROR_CODES.COMMAND_FAILED, message, details);
}

function emit(listener, event) {
  if (typeof listener !== "function") return;
  try {
    const result = listener(event);
    if (result?.catch) result.catch(() => {});
  } catch {}
}

export function parseDdrescueProgress(value = "") {
  const text = String(value || "");
  const find = (pattern) => text.match(pattern)?.[1] || "";
  return {
    rescued: find(/rescued:\s*([^,\n]+)/i),
    errorSize: find(/errsize:\s*([^,\n]+)/i),
    errors: Number(find(/errors:\s*(\d+)/i)) || 0,
    currentRate: find(/current rate:\s*([^,\n]+)/i),
    averageRate: find(/average rate:\s*([^,\n]+)/i),
    remaining: find(/remaining time:\s*([^,\n]+)/i),
    position: find(/(?:ipos|opos):\s*([^,\n]+)/i),
    pass: Number(find(/current pass:\s*(\d+)/i)) || null,
    raw: text,
  };
}

const FILESYSTEM_TOOLS = Object.freeze({
  ext2: { check: ["e2fsck", ["-f", "-n"]], repair: ["e2fsck", ["-f", "-y"]], create: "mkfs.ext2", resize: "resize2fs", label: "e2label", uuid: "tune2fs" },
  ext3: { check: ["e2fsck", ["-f", "-n"]], repair: ["e2fsck", ["-f", "-y"]], create: "mkfs.ext3", resize: "resize2fs", label: "e2label", uuid: "tune2fs" },
  ext4: { check: ["e2fsck", ["-f", "-n"]], repair: ["e2fsck", ["-f", "-y"]], create: "mkfs.ext4", resize: "resize2fs", label: "e2label", uuid: "tune2fs" },
  xfs: { check: ["xfs_repair", ["-n"]], repair: ["xfs_repair", []], create: "mkfs.xfs", createForce: "-f", resize: "xfs_growfs", label: "xfs_admin", uuid: "xfs_admin" },
  btrfs: { check: ["btrfs", ["check", "--readonly"]], repair: ["btrfs", ["check", "--repair"]], create: "mkfs.btrfs", createForce: "-f", resize: "btrfs", label: "btrfs", uuid: "btrfstune" },
  vfat: { check: ["fsck.fat", ["-n"]], repair: ["fsck.fat", ["-a"]], create: "mkfs.fat", createForce: null, createLabel: "-n", label: "fatlabel" },
  fat: { check: ["fsck.fat", ["-n"]], repair: ["fsck.fat", ["-a"]], create: "mkfs.fat", createForce: null, createLabel: "-n", label: "fatlabel" },
  exfat: { check: ["fsck.exfat", ["-n"]], repair: ["fsck.exfat", ["-p"]], create: "mkfs.exfat", createForce: null, label: "exfatlabel" },
  ntfs: { check: ["ntfsfix", ["-n"]], repair: ["ntfsfix", []], create: "mkfs.ntfs", createForce: "-F", resize: "ntfsresize", label: "ntfslabel" },
  swap: { check: ["swaplabel", []], repair: ["mkswap", []], create: "mkswap", createForce: "-f", label: "swaplabel" },
});

const COMPLETE_ACTION_NAMES = Object.freeze([
  "inventory.collect", "command.exec", "shell.exec", "artifact.download", "artifact.upload",
  "file.read", "file.write", "file.copy", "file.move", "file.remove", "directory.list",
  "mount.list", "mount.create", "mount.remove", "mount.bind", "swap.enable", "swap.disable",
  "process.list", "process.signal", "service.status", "service.start", "service.stop", "service.restart",
  "system.chroot", "system.nspawn", "power.reboot", "power.poweroff", "power.hibernate", "power.kexec",
  "disk.inventory", "disk.smart.read", "disk.smart.test", "disk.read.sample", "disk.badblocks.scan",
  "disk.table.backup", "disk.table.restore", "disk.table.write", "disk.table.create",
  "disk.partition.create", "disk.partition.delete", "disk.partition.resize", "disk.partition.set-type",
  "disk.partition.set-name", "disk.partition.set-flag", "disk.reread", "disk.clone",
  "disk.image.create", "disk.image.restore", "disk.wipe.signatures", "disk.wipe.ranges",
  "disk.wipe.full", "disk.hash", "raid.scan", "raid.assemble", "raid.stop", "raid.detail",
  "raid.create", "raid.add", "raid.remove", "raid.fail", "lvm.scan", "lvm.activate",
  "lvm.deactivate", "lvm.pv.create", "lvm.vg.create", "lvm.lv.create", "lvm.lv.resize",
  "lvm.remove", "luks.dump", "luks.open", "luks.close", "luks.header.backup",
  "luks.header.restore", "luks.format", "filesystem.identify", "filesystem.check",
  "filesystem.repair", "filesystem.create", "filesystem.resize", "filesystem.label",
  "filesystem.uuid", "filesystem.mount", "filesystem.unmount", "filesystem.scrub",
  "boot.detect", "boot.mount-system", "boot.mount-pseudo", "boot.chroot-command",
  "boot.grub.install-bios", "boot.grub.install-uefi", "boot.grub.regenerate-config",
  "boot.systemd-boot.install", "boot.efi.list", "boot.efi.create-entry", "boot.efi.delete-entry",
  "boot.initramfs.rebuild", "boot.fstab.inspect", "boot.fstab.rewrite", "boot.kernel.list",
  "boot.windows.bcd.inspect", "boot.cleanup-mounts",
]);

export function createRecoveryActionRegistry({
  executor,
  inventory,
  artifacts = null,
  platform = process.platform,
  randomBytesImpl = randomBytes,
} = {}) {
  if (!executor?.execArgv || !executor?.execShell) throw new TypeError("Recovery actions require an executor.");
  const descriptors = new Map();
  let mutationTail = Promise.resolve();

  function register({
    name,
    description,
    mutates = false,
    requiredTools = [],
    params = {},
    progress = null,
    resumable = false,
    resumeClass = mutates ? "explicit-retry" : "convergent",
    handler,
  }) {
    descriptors.set(name, {
      name,
      description,
      mutates,
      requiredTools: [...requiredTools],
      params: structuredClone(params),
      progress: progress ? String(progress) : null,
      resumable,
      resumeClass,
      handler,
    });
  }

  async function collectInventory(options = {}) {
    if (typeof inventory === "function") return inventory(options);
    if (typeof inventory?.collect === "function") return inventory.collect(options);
    throw createRecoveryError(RECOVERY_ERROR_CODES.TOOL_MISSING, "Inventory collector is unavailable.");
  }

  async function runCommand(file, args, params, context, options = {}) {
    const result = await executor.execArgv({
      file,
      args: array(args),
      cwd: options.cwd ?? params.cwd,
      env: options.env ?? params.env,
      stdin: options.stdin ?? params.stdin,
      timeoutMs: options.timeoutMs ?? params.timeoutMs ?? context.timeoutMs ?? 120_000,
      runAs: options.runAs ?? params.runAs,
      force: context.force === true || params.force === true,
      signal: context.signal,
      secretEnv: options.secretEnv,
      onEvent(event) {
        if (event.type === "command") {
          emit(context.onEvent, {
            type: "step.command",
            command: event,
            ...(context.resolvedDevice ? { device: structuredClone(context.resolvedDevice) } : {}),
          });
        } else if (event.type === "output") {
          emit(context.onEvent, { type: "step.output", stream: event.stream, data: event.data, encoding: event.encoding });
          if (options.progressParser) {
            emit(context.onEvent, { type: "step.progress", progress: options.progressParser(event.data) });
          }
        }
      },
    });
    return {
      ok: result.exitCode === 0,
      command: { file: result.file, args: result.args },
      result,
    };
  }

  async function runCommands(commands, params, context, { continueOnError = false } = {}) {
    const results = [];
    for (const command of commands) {
      const result = await runCommand(command.file, command.args, params, context, command.options || {});
      results.push(result);
      if (!result.ok && !continueOnError) break;
    }
    return { ok: results.every((result) => result.ok), commands: results };
  }

  async function resolveDevice(params, context, prefix = "") {
    const deviceIdKey = `${prefix}DeviceId`;
    const pathKey = `${prefix}Path`;
    const requestedDeviceId = String(params[deviceIdKey] || (prefix ? "" : params.deviceId) || "").trim();
    const explicitPath = String(params[pathKey] || (prefix ? "" : params.path) || "").trim();
    const snapshot = await collectInventory({ onProgress: (progress) => emit(context.onEvent, { type: "step.progress", progress }) });
    const candidates = snapshot?.block?.devices || [];
    const identityMatch = requestedDeviceId
      ? candidates.find((device) => device.deviceId === requestedDeviceId)
      : null;
    const pathMatch = explicitPath
      ? candidates.find((device) => [device.path, device.canonicalPath, ...(device.byId || [])].includes(explicitPath))
      : null;
    if (requestedDeviceId && !identityMatch && !explicitPath) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.DEVICE_NOT_FOUND,
        `Recovery device ${requestedDeviceId} is not present.`,
        { requestedDeviceId },
      );
    }
    if (requestedDeviceId && explicitPath && identityMatch && pathMatch && identityMatch.deviceId !== pathMatch.deviceId) {
      if (!(context.force === true || params.force === true)) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.DEVICE_CHANGED,
          `Recovery device identity ${requestedDeviceId} does not match ${explicitPath}.`,
          { identity: identityMatch, explicit: pathMatch },
        );
      }
    }
    const selected = (context.force === true || params.force === true) && explicitPath
      ? pathMatch || { canonicalPath: explicitPath, path: explicitPath, deviceId: requestedDeviceId }
      : identityMatch || pathMatch || (explicitPath ? { canonicalPath: explicitPath, path: explicitPath } : null);
    if (!selected?.canonicalPath && !selected?.path) {
      throw createRecoveryError(RECOVERY_ERROR_CODES.DEVICE_NOT_FOUND, "A deviceId or path is required.");
    }
    const resolved = {
      deviceId: selected.deviceId || requestedDeviceId,
      path: selected.canonicalPath || selected.path,
      stablePaths: selected.byId || [],
      model: selected.model || "",
      serial: selected.serial || "",
      size: selected.size || 0,
      type: selected.type || "",
      identityMismatchOverridden: Boolean(
        requestedDeviceId && explicitPath && identityMatch && pathMatch && identityMatch.deviceId !== pathMatch.deviceId,
      ),
    };
    context.resolvedDevice = resolved;
    emit(context.onEvent, { type: "step.device", device: resolved, force: context.force === true || params.force === true });
    return { resolved, inventory: snapshot };
  }

  function simpleCommand(name, description, build, options = {}) {
    register({
      name,
      description,
      mutates: options.mutates,
      requiredTools: options.requiredTools,
      params: options.params,
      resumable: options.resumable,
      resumeClass: options.resumeClass,
      handler: async (params, context) => {
        const command = await build(params, context);
        return runCommand(command.file, command.args, params, context, command.options || {});
      },
    });
  }

  register({
    name: "inventory.collect",
    description: "Collect normalized and raw recovery inventory.",
    resumable: true,
    handler: async (params, context) => ({
      ok: true,
      inventory: await collectInventory({
        lightweight: params.lightweight === true,
        onProgress: (progress) => emit(context.onEvent, { type: "step.progress", progress }),
      }),
    }),
  });

  register({
    name: "command.exec",
    description: "Execute unrestricted argv without a shell.",
    handler: async (params, context) => {
      const argv = Array.isArray(params.argv) ? params.argv.map(String) : [];
      const file = String(params.file || argv.shift() || "");
      if (!file) required(params, "file");
      return runCommand(file, params.args || argv, params, context);
    },
  });

  const defaultShell = platform === "win32" ? "powershell" : "/bin/bash";
  register({
    name: "shell.exec",
    description: "Execute an unrestricted shell script (Bash on POSIX, PowerShell on Windows).",
    handler: async (params, context) => {
      const result = await executor.execShell({
        script: String(required(params, "script")),
        shell: params.shell || defaultShell,
        cwd: params.cwd,
        env: params.env,
        stdin: params.stdin,
        timeoutMs: params.timeoutMs ?? context.timeoutMs ?? 120_000,
        force: context.force === true || params.force === true,
        signal: context.signal,
        onEvent(event) {
          if (event.type === "command") emit(context.onEvent, { type: "step.command", command: event });
          if (event.type === "output") emit(context.onEvent, { type: "step.output", stream: event.stream, data: event.data, encoding: event.encoding });
        },
      });
      return { ok: result.exitCode === 0, result };
    },
  });

  register({
    name: "artifact.download",
    description: "Download a controller artifact to a target path with resume.",
    mutates: true,
    resumable: true,
    resumeClass: "naturally-resumable",
    handler: async (params, context) => {
      if (!artifacts?.download) throw createRecoveryError(RECOVERY_ERROR_CODES.TOOL_MISSING, "Artifact download is unavailable.");
      return {
        ok: true,
        artifact: await artifacts.download({
          ...params,
          force: params.force === true || context.force === true,
          signal: context.signal,
          onProgress: (progress) => emit(context.onEvent, { type: "artifact.progress", ...progress }),
        }),
      };
    },
  });
  register({
    name: "artifact.upload",
    description: "Upload a target file or block range to the controller with resume.",
    resumable: true,
    resumeClass: "naturally-resumable",
    handler: async (params, context) => {
      if (!artifacts?.upload) throw createRecoveryError(RECOVERY_ERROR_CODES.TOOL_MISSING, "Artifact upload is unavailable.");
      return {
        ok: true,
        artifact: await artifacts.upload({
          ...params,
          caseId: params.caseId || context.caseId,
          jobId: params.jobId || context.jobId,
          stepId: params.stepId || context.stepId,
          agentId: params.agentId || context.agentId,
          signal: context.signal,
          onProgress: (progress) => emit(context.onEvent, { type: "artifact.progress", ...progress }),
        }),
      };
    },
  });

  simpleCommand("file.read", "Read an arbitrary file.", async (params) => ({ file: "cat", args: [String(required(params, "path"))] }), { requiredTools: ["cat"] });
  register({
    name: "file.write",
    description: "Write bytes to an arbitrary file.",
    mutates: true,
    requiredTools: ["tee"],
    handler: async (params, context) => runCommand("tee", [String(required(params, "path"))], params, context, {
      stdin: params.contents ?? params.stdin ?? "",
    }),
  });
  simpleCommand("file.copy", "Copy an arbitrary file or directory.", async (params) => ({ file: "cp", args: ["-a", ...(boolean(params.force) ? ["--force"] : []), String(required(params, "source")), String(required(params, "destination"))] }), { mutates: true, requiredTools: ["cp"] });
  simpleCommand("file.move", "Move an arbitrary path.", async (params) => ({ file: "mv", args: [...(boolean(params.force) ? ["--force"] : []), String(required(params, "source")), String(required(params, "destination"))] }), { mutates: true, requiredTools: ["mv"] });
  simpleCommand("file.remove", "Remove arbitrary paths.", async (params) => ({ file: "rm", args: [...(boolean(params.recursive) ? ["-rf"] : [boolean(params.force) ? "-f" : "-v"]), "--", ...array(params.paths || [required(params, "path")])] }), { mutates: true, requiredTools: ["rm"] });
  simpleCommand("directory.list", "List an arbitrary directory.", async (params) => ({ file: "ls", args: ["-la", "--quoting-style=shell", String(params.path || ".")] }), { requiredTools: ["ls"] });
  simpleCommand("mount.list", "List current mounts.", async () => ({ file: "findmnt", args: ["--json", "--real", "--bytes"] }), { requiredTools: ["findmnt"] });
  simpleCommand("mount.create", "Mount a filesystem.", async (params) => ({ file: "mount", args: [...(params.type ? ["-t", String(params.type)] : []), ...(params.options ? ["-o", String(params.options)] : []), String(required(params, "source")), String(required(params, "target"))] }), { mutates: true, requiredTools: ["mount"] });
  simpleCommand("mount.remove", "Unmount a filesystem.", async (params) => ({ file: "umount", args: [...(boolean(params.lazy) ? ["--lazy"] : []), ...(boolean(params.force) ? ["--force"] : []), String(required(params, "target"))] }), { mutates: true, requiredTools: ["umount"] });
  simpleCommand("mount.bind", "Bind mount one path at another.", async (params) => ({ file: "mount", args: [boolean(params.recursive) ? "--rbind" : "--bind", String(required(params, "source")), String(required(params, "target"))] }), { mutates: true, requiredTools: ["mount"] });
  simpleCommand("swap.enable", "Enable swap.", async (params) => ({ file: "swapon", args: [...(boolean(params.all) ? ["--all"] : [String(required(params, "path"))]), ...array(params.extraArgs)] }), { mutates: true, requiredTools: ["swapon"] });
  simpleCommand("swap.disable", "Disable swap.", async (params) => ({ file: "swapoff", args: [...(boolean(params.all) ? ["--all"] : [String(required(params, "path"))]), ...array(params.extraArgs)] }), { mutates: true, requiredTools: ["swapoff"] });
  simpleCommand("process.list", "List target processes.", async () => ({ file: "ps", args: ["-eo", "pid,ppid,user,stat,lstart,cmd", "--sort=pid"] }), { requiredTools: ["ps"] });
  simpleCommand("process.signal", "Send a signal to a process.", async (params) => ({ file: "kill", args: ["-s", String(params.signal || "TERM"), String(required(params, "pid"))] }), { mutates: true, requiredTools: ["kill"] });
  for (const verb of ["status", "start", "stop", "restart"]) {
    simpleCommand(`service.${verb}`, `${verb} a target service.`, async (params) => ({ file: "systemctl", args: [verb, String(required(params, "name"))] }), { mutates: verb !== "status", requiredTools: ["systemctl"] });
  }
  simpleCommand("system.chroot", "Run arbitrary argv in a chroot.", async (params) => ({ file: "chroot", args: [String(required(params, "root")), ...array(required(params, "argv"))] }), { mutates: true, requiredTools: ["chroot"] });
  simpleCommand("system.nspawn", "Run arbitrary argv in systemd-nspawn.", async (params) => ({ file: "systemd-nspawn", args: ["-D", String(required(params, "root")), "--", ...array(required(params, "argv"))] }), { mutates: true, requiredTools: ["systemd-nspawn"] });
  simpleCommand("power.reboot", "Reboot the target.", async (params) => params.method === "reboot" ? { file: "reboot", args: array(params.extraArgs) } : { file: "systemctl", args: ["reboot", ...array(params.extraArgs)] }, { mutates: true });
  simpleCommand("power.poweroff", "Power off the target.", async (params) => params.method === "poweroff" ? { file: "poweroff", args: array(params.extraArgs) } : { file: "systemctl", args: ["poweroff", ...array(params.extraArgs)] }, { mutates: true });
  simpleCommand("power.kexec", "Load or execute a kexec kernel.", async (params) => ({ file: "kexec", args: array(required(params, "args")) }), { mutates: true, requiredTools: ["kexec"] });

  register({
    name: "disk.inventory",
    description: "Refresh one device and its dependency graph.",
    handler: async (params, context) => {
      const resolution = await resolveDevice(params, context);
      return { ok: true, device: resolution.resolved, inventory: resolution.inventory };
    },
  });
  register({
    name: "disk.smart.read",
    description: "Read SMART or NVMe health and logs.",
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      const nvme = resolved.type === "nvme" || /nvme/.test(resolved.path);
      return runCommand(nvme ? "nvme" : "smartctl", nvme ? ["smart-log", "-o", "json", resolved.path] : ["--all", "--json=c", resolved.path], params, context);
    },
  });
  register({
    name: "disk.smart.test",
    description: "Start a SMART device self-test.",
    mutates: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      return runCommand("smartctl", ["--test", String(params.test || "short"), resolved.path], params, context);
    },
  });
  register({
    name: "disk.read.sample",
    description: "Read and hash requested device sector samples.",
    requiredTools: ["dd", "sha256sum", "rm"],
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      const blockSize = Number(params.blockSize) || 4096;
      const count = Number(params.count) || 16;
      const totalBlocks = Math.max(0, Math.floor(Number(resolved.size || 0) / blockSize));
      const defaultOffsets = [
        0,
        Math.max(0, Math.floor(totalBlocks / 2) - Math.floor(count / 2)),
        Math.max(0, totalBlocks - count),
      ];
      const offsets = [...new Set((Array.isArray(params.offsets) && params.offsets.length ? params.offsets : defaultOffsets)
        .map((offset) => Math.max(0, Math.floor(Number(offset) || 0))))];
      const samples = [];
      for (const offset of offsets) {
        const samplePath = path.join(
          String(params.temporaryDir || "/tmp"),
          `workwire-sample-${randomBytesImpl(10).toString("hex")}.bin`,
        );
        let readResult = null;
        let hashResult = null;
        try {
          readResult = await runCommand("dd", [
            `if=${resolved.path}`,
            `of=${samplePath}`,
            `bs=${blockSize}`,
            `skip=${offset}`,
            `count=${count}`,
            "status=none",
          ], params, context);
          if (readResult.ok) hashResult = await runCommand("sha256sum", [samplePath], params, context);
          const hash = String(hashResult?.result?.stdoutTail || "").match(/^([0-9a-f]{64})\b/i)?.[1]?.toLowerCase() || null;
          samples.push({
            offsetBlocks: offset,
            offsetBytes: offset * blockSize,
            requestedBytes: count * blockSize,
            hash: hash ? `sha256:${hash}` : null,
            ok: Boolean(readResult?.ok && hashResult?.ok && hash),
            error: !readResult?.ok
              ? readResult?.result?.stderrTail || "sample read failed"
              : !hashResult?.ok || !hash ? hashResult?.result?.stderrTail || "sample hash failed" : null,
          });
        } finally {
          await runCommand("rm", ["-f", samplePath], params, context).catch(() => {});
        }
      }
      return { ok: samples.every((sample) => sample.ok), device: resolved, samples };
    },
  });
  register({
    name: "disk.badblocks.scan",
    description: "Scan a block device for bad blocks.",
    mutates: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      const destructive = params.mode === "write";
      const args = [destructive ? "-wsv" : "-sv", ...array(params.extraArgs), resolved.path];
      return runCommand("badblocks", args, params, context);
    },
  });
  register({
    name: "disk.table.backup",
    description: "Capture partition tables, GPT binary metadata, and edge sectors.",
    resumable: true,
    handler: async (params, context) => {
      const { resolved, inventory: snapshot } = await resolveDevice(params, context);
      const outputDir = String(params.outputDir || context.caseArtifactDir || "/tmp");
      const base = path.join(outputDir, `${path.basename(resolved.path)}-${Date.now()}`);
      await runCommand("mkdir", ["-p", outputDir], params, context);
      const files = [];
      const commands = [];
      if (await executor.toolExists("sfdisk")) {
        files.push(`${base}.sfdisk`, `${base}.sfdisk.json`);
        commands.push(
          { file: "sh", args: ["-c", "sfdisk --dump \"$1\" > \"$2\"", "workwire", resolved.path, `${base}.sfdisk`] },
          { file: "sh", args: ["-c", "sfdisk --json \"$1\" > \"$2\"", "workwire", resolved.path, `${base}.sfdisk.json`] },
        );
      }
      if (await executor.toolExists("sgdisk")) {
        files.push(`${base}.gpt`);
        commands.push({ file: "sgdisk", args: [`--backup=${base}.gpt`, resolved.path] });
      }
      if (await executor.toolExists("dd")) {
        const edgeMiB = Math.max(1, Number(params.edgeMiB) || 4);
        const totalMiB = Math.max(0, Math.floor(Number(resolved.size || 0) / (1024 * 1024)));
        const tailSkip = Math.max(0, totalMiB - edgeMiB);
        files.push(`${base}.head.bin`, `${base}.tail.bin`);
        commands.push(
          { file: "dd", args: [`if=${resolved.path}`, `of=${base}.head.bin`, "bs=1M", `count=${edgeMiB}`, "status=progress"] },
          { file: "dd", args: [`if=${resolved.path}`, `of=${base}.tail.bin`, "bs=1M", `skip=${tailSkip}`, `count=${edgeMiB}`, "status=progress"] },
        );
      }
      const result = await runCommands(commands, params, context, { continueOnError: true });
      const uploaded = [];
      if (artifacts?.upload && params.upload !== false) {
        for (const filename of files) {
          const artifact = await artifacts.upload({
            path: filename,
            caseId: context.caseId,
            jobId: context.jobId,
            stepId: context.stepId,
            agentId: context.agentId,
            kind: "partition-table",
            filename: path.basename(filename),
            signal: context.signal,
            metadata: { device: resolved },
            onProgress: (progress) => emit(context.onEvent, { type: "artifact.progress", ...progress }),
          }).catch((error) => ({ error: { code: error.code, message: error.message }, filename }));
          uploaded.push(artifact);
        }
      }
      return {
        ...result,
        device: resolved,
        inventory: snapshot,
        outputBase: base,
        files,
        artifacts: uploaded,
        tools: {
          sfdisk: await executor.toolExists("sfdisk"),
          sgdisk: await executor.toolExists("sgdisk"),
          dd: await executor.toolExists("dd"),
        },
      };
    },
  });
  register({
    name: "disk.table.restore",
    description: "Restore an sfdisk or sgdisk partition-table backup.",
    mutates: true,
    resumeClass: "explicit-retry",
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      const backupPath = String(required(params, "backupPath"));
      const restore = (params.format === "sgdisk" || /\.gpt$/.test(backupPath))
        ? { file: "sgdisk", args: [`--load-backup=${backupPath}`, resolved.path] }
        : { file: "sfdisk", args: [resolved.path], options: { stdin: { path: backupPath } } };
      return runCommands([
        restore,
        { file: "partprobe", args: [resolved.path] },
        { file: "udevadm", args: ["settle"] },
      ], params, context, { continueOnError: boolean(params.force) });
    },
  });
  register({
    name: "disk.table.write",
    description: "Apply an exact sfdisk script or caller-provided partition argv.",
    mutates: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      if (params.argv) return runCommand(params.tool || "sfdisk", [...array(params.argv), resolved.path], params, context);
      return runCommand("sfdisk", [resolved.path], params, context, { stdin: String(required(params, "script")) });
    },
  });
  simpleCommand("disk.table.create", "Create a new disk label.", async (params, context) => {
    const { resolved } = await resolveDevice(params, context);
    return { file: "parted", args: ["-s", resolved.path, "mklabel", String(params.label || "gpt")] };
  }, { mutates: true });
  simpleCommand("disk.partition.create", "Create a partition.", async (params, context) => {
    const { resolved } = await resolveDevice(params, context);
    return { file: "parted", args: ["-s", resolved.path, "mkpart", String(params.name || "primary"), ...(params.filesystemType ? [String(params.filesystemType)] : []), String(required(params, "start")), String(required(params, "end"))] };
  }, { mutates: true });
  simpleCommand("disk.partition.delete", "Delete a partition.", async (params, context) => {
    const { resolved } = await resolveDevice(params, context);
    return { file: "parted", args: ["-s", resolved.path, "rm", String(required(params, "number"))] };
  }, { mutates: true });
  simpleCommand("disk.partition.resize", "Resize a partition boundary.", async (params, context) => {
    const { resolved } = await resolveDevice(params, context);
    return { file: "parted", args: ["-s", resolved.path, "resizepart", String(required(params, "number")), String(required(params, "end"))] };
  }, { mutates: true });
  simpleCommand("disk.partition.set-type", "Set a partition type GUID/code.", async (params, context) => {
    const { resolved } = await resolveDevice(params, context);
    return { file: "sgdisk", args: [`--typecode=${required(params, "number")}:${required(params, "type")}`, resolved.path] };
  }, { mutates: true });
  simpleCommand("disk.partition.set-name", "Set a GPT partition name.", async (params, context) => {
    const { resolved } = await resolveDevice(params, context);
    return { file: "sgdisk", args: [`--change-name=${required(params, "number")}:${required(params, "name")}`, resolved.path] };
  }, { mutates: true });
  simpleCommand("disk.partition.set-flag", "Set a partition flag.", async (params, context) => {
    const { resolved } = await resolveDevice(params, context);
    return { file: "parted", args: ["-s", resolved.path, "set", String(required(params, "number")), String(required(params, "flag")), params.enabled === false ? "off" : "on"] };
  }, { mutates: true });
  register({
    name: "disk.reread",
    description: "Reread a partition table and settle udev.",
    mutates: true,
    resumable: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      return runCommands([
        { file: "blockdev", args: ["--rereadpt", resolved.path] },
        { file: "partprobe", args: [resolved.path] },
        { file: "udevadm", args: ["settle"] },
      ], params, context, { continueOnError: true });
    },
  });
  register({
    name: "disk.clone",
    description: "Clone a failing device with resumable GNU ddrescue passes.",
    mutates: true,
    resumable: true,
    resumeClass: "naturally-resumable",
    progress: "ddrescue",
    handler: async (params, context) => {
      const source = await resolveDevice(params, context, "source");
      const destination = params.destinationDeviceId || params.destinationPath
        ? await resolveDevice(params, context, "destination")
        : null;
      const destinationPath = destination?.resolved.path || String(required(params, "destinationPath"));
      if (source.resolved.path === destinationPath && !(context.force || params.force)) {
        throw actionError("ddrescue source and destination are identical.", { source: source.resolved, destination: destinationPath });
      }
      const mapfile = String(params.mapfilePath || path.join(context.caseArtifactDir || "/tmp", `${path.basename(source.resolved.path)}.map`));
      const passes = Array.isArray(params.passes) && params.passes.length > 0
        ? params.passes
        : [{ args: ["--force", "--no-scrape"] }, { args: ["--force", "--direct", "--retry-passes=3"] }];
      const results = [];
      for (let index = 0; index < passes.length; index += 1) {
        const args = [...array(passes[index].args), source.resolved.path, destinationPath, mapfile];
        if (params.reverseFinalPass && index === passes.length - 1 && !args.includes("--reverse")) args.unshift("--reverse");
        emit(context.onEvent, { type: "step.progress", progress: { pass: index + 1, passes: passes.length, mapfile } });
        const result = await runCommand("ddrescue", args, params, context, { progressParser: parseDdrescueProgress });
        results.push(result);
        if (!result.ok && !params.force) break;
        if (artifacts?.upload && params.uploadMapfile !== false) {
          await artifacts.upload({
            path: mapfile,
            caseId: context.caseId,
            jobId: context.jobId,
            stepId: context.stepId,
            kind: "ddrescue-map",
            filename: path.basename(mapfile),
          }).catch(() => {});
        }
      }
      return { ok: results.every((result) => result.ok), source: source.resolved, destination: destination?.resolved || destinationPath, mapfile, passes: results };
    },
  });
  register({
    name: "disk.image.create",
    description: "Create a disk image with dd or ddrescue.",
    resumable: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context, "source");
      const destinationPath = String(required(params, "destinationPath"));
      if (params.method === "ddrescue" || params.mapfilePath) {
        return runCommand("ddrescue", [...array(params.extraArgs), resolved.path, destinationPath, String(params.mapfilePath || `${destinationPath}.map`)], params, context, { progressParser: parseDdrescueProgress });
      }
      return runCommand("dd", [`if=${resolved.path}`, `of=${destinationPath}`, "bs=4M", "status=progress", "conv=sync,noerror", ...array(params.extraArgs)], params, context);
    },
  });
  register({
    name: "disk.image.restore",
    description: "Restore an image into an explicit block device.",
    mutates: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context, "destination");
      return runCommand("dd", [`if=${required(params, "imagePath")}`, `of=${resolved.path}`, "bs=4M", "status=progress", "conv=fsync", ...array(params.extraArgs)], params, context);
    },
  });
  register({
    name: "disk.wipe.signatures",
    description: "Wipe selected or all filesystem signatures.",
    mutates: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      return runCommand("wipefs", [params.all === false ? "--types" : "--all", ...(params.all === false ? [String(required(params, "types"))] : []), ...(params.force ? ["--force"] : []), resolved.path], params, context);
    },
  });
  register({
    name: "disk.wipe.ranges",
    description: "Zero or discard explicit byte ranges.",
    mutates: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      const ranges = Array.isArray(params.ranges) ? params.ranges : [];
      if (ranges.length === 0) required(params, "ranges");
      const commands = ranges.map((range) => params.method === "discard"
        ? { file: "blkdiscard", args: ["--offset", String(range.offset || 0), "--length", String(required(range, "length")), resolved.path] }
        : { file: "dd", args: ["if=/dev/zero", `of=${resolved.path}`, "bs=1", `seek=${Number(range.offset) || 0}`, `count=${Number(required(range, "length"))}`, "conv=notrunc", "status=progress"] });
      return runCommands(commands, params, context, { continueOnError: boolean(params.force) });
    },
  });
  register({
    name: "disk.wipe.full",
    description: "Discard or overwrite a complete device.",
    mutates: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      return params.method === "zero"
        ? runCommand("dd", ["if=/dev/zero", `of=${resolved.path}`, "bs=16M", "status=progress", "conv=fsync"], params, context)
        : runCommand("blkdiscard", [...(params.force ? ["--force"] : []), resolved.path], params, context);
    },
  });
  register({
    name: "disk.hash",
    description: "Hash a complete device or explicit range.",
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      if (params.offset !== undefined || params.length !== undefined) {
        const script = `dd if="$1" bs=1 skip="$2" count="$3" status=none | "$4"`;
        return runCommand("bash", ["-c", script, "ww-hash", resolved.path, String(params.offset || 0), String(required(params, "length")), String(params.algorithm || "sha256sum")], params, context);
      }
      return runCommand(params.algorithm || "sha256sum", [resolved.path], params, context);
    },
  });

  const genericActions = [
    ["raid.scan", "mdadm", ["--assemble", "--scan"], true],
    ["raid.assemble", "mdadm", (p) => ["--assemble", String(required(p, "array")), ...array(required(p, "members")), ...array(p.extraArgs)], true],
    ["raid.stop", "mdadm", (p) => ["--stop", String(required(p, "array"))], true],
    ["raid.detail", "mdadm", (p) => ["--detail", String(required(p, "array"))], false],
    ["raid.create", "mdadm", (p) => ["--create", String(required(p, "array")), "--level", String(required(p, "level")), "--raid-devices", String(required(p, "raidDevices")), ...array(required(p, "members")), ...array(p.extraArgs)], true],
    ["raid.add", "mdadm", (p) => [String(required(p, "array")), "--add", String(required(p, "member"))], true],
    ["raid.remove", "mdadm", (p) => [String(required(p, "array")), "--remove", String(required(p, "member"))], true],
    ["raid.fail", "mdadm", (p) => [String(required(p, "array")), "--fail", String(required(p, "member"))], true],
    ["lvm.scan", "lvm", ["fullreport", "--reportformat", "json"], false],
    ["lvm.activate", "vgchange", (p) => ["-ay", ...(p.name ? [String(p.name)] : [])], true],
    ["lvm.deactivate", "vgchange", (p) => ["-an", ...(p.name ? [String(p.name)] : [])], true],
    ["lvm.pv.create", "pvcreate", (p) => [...(p.force ? ["--force", "--yes"] : []), ...array(p.extraArgs), String(required(p, "path"))], true],
    ["lvm.vg.create", "vgcreate", (p) => [String(required(p, "name")), ...array(required(p, "physicalVolumes")), ...array(p.extraArgs)], true],
    ["lvm.lv.create", "lvcreate", (p) => ["--name", String(required(p, "name")), "--size", String(required(p, "size")), String(required(p, "volumeGroup")), ...array(p.extraArgs)], true],
    ["lvm.lv.resize", "lvresize", (p) => ["--size", String(required(p, "size")), ...(p.resizeFilesystem ? ["--resizefs"] : []), String(required(p, "logicalVolume")), ...array(p.extraArgs)], true],
    ["lvm.remove", "lvremove", (p) => [...(p.force ? ["--force", "--yes"] : []), String(required(p, "logicalVolume"))], true],
    ["luks.dump", "cryptsetup", (p) => ["luksDump", String(required(p, "path"))], false],
    ["luks.close", "cryptsetup", (p) => ["close", String(required(p, "name"))], true],
    ["luks.header.backup", "cryptsetup", (p) => ["luksHeaderBackup", String(required(p, "path")), "--header-backup-file", String(required(p, "backupPath"))], false],
    ["luks.header.restore", "cryptsetup", (p) => ["luksHeaderRestore", String(required(p, "path")), "--header-backup-file", String(required(p, "backupPath")), ...(p.force ? ["--batch-mode"] : [])], true],
  ];
  for (const [name, tool, argsBuilder, mutates] of genericActions) {
    simpleCommand(name, `${name} recovery operation.`, async (params) => ({ file: tool, args: typeof argsBuilder === "function" ? argsBuilder(params) : argsBuilder }), { mutates, requiredTools: [tool] });
  }
  for (const name of ["luks.open", "luks.format"]) {
    register({
      name,
      description: `${name} using passphrase bytes through stdin.`,
      mutates: true,
      requiredTools: ["cryptsetup"],
      handler: async (params, context) => {
        const verb = name === "luks.open" ? "open" : "luksFormat";
        const args = [verb, String(required(params, "path")), ...(name === "luks.open" ? [String(required(params, "name"))] : []), "--key-file", "-", ...(params.force ? ["--batch-mode"] : []), ...array(params.extraArgs)];
        return runCommand("cryptsetup", args, params, context, { stdin: String(required(params, "passphrase")) });
      },
    });
  }

  register({
    name: "filesystem.identify",
    description: "Identify filesystem signatures.",
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      return runCommand("blkid", ["-p", "-o", "export", resolved.path], params, context);
    },
  });
  for (const operation of ["check", "repair"]) {
    register({
      name: `filesystem.${operation}`,
      description: `${operation} a filesystem using its native tool.`,
      mutates: operation === "repair",
      handler: async (params, context) => {
        const { resolved } = await resolveDevice(params, context);
        const type = String(required(params, "filesystemType")).toLowerCase();
        const recipe = FILESYSTEM_TOOLS[type]?.[operation];
        if (!recipe) throw createRecoveryError(RECOVERY_ERROR_CODES.TOOL_MISSING, `Unsupported filesystem ${type}.`);
        const [tool, baseArgs] = recipe;
        const args = [...baseArgs];
        if (type === "xfs" && operation === "repair" && params.clearLog) args.push("-L");
        args.push(...array(params.extraArgs), resolved.path);
        const result = await runCommand(tool, args, params, context);
        if (type === "ntfs") result.note = "ntfsfix is not a complete replacement for Windows chkdsk.";
        return result;
      },
    });
  }
  register({
    name: "filesystem.create",
    description: "Create a filesystem with its native mkfs tool.",
    mutates: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      const type = String(required(params, "filesystemType")).toLowerCase();
      const spec = FILESYSTEM_TOOLS[type] || {};
      const tool = spec.create || `mkfs.${type}`;
      // Force and label flags are not uniform across mkfs tools: mkfs.fat has no
      // force flag (-F selects the FAT size) and labels with -n; btrfs/xfs/swap
      // force with -f. Default to the ext-style -F/-L when a type is unspecified.
      const forceFlag = "createForce" in spec ? spec.createForce : "-F";
      const labelFlag = spec.createLabel || "-L";
      const args = [
        ...(params.force && forceFlag ? [forceFlag] : []),
        ...(params.label ? [labelFlag, String(params.label)] : []),
        ...array(params.extraArgs),
        resolved.path,
      ];
      return runCommand(tool, args, params, context);
    },
  });
  register({
    name: "filesystem.resize",
    description: "Resize a filesystem using its native tool.",
    mutates: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      const type = String(required(params, "filesystemType")).toLowerCase();
      const tool = FILESYSTEM_TOOLS[type]?.resize;
      if (!tool) throw createRecoveryError(RECOVERY_ERROR_CODES.TOOL_MISSING, `Filesystem ${type} has no registered resize tool.`);
      let args;
      if (type === "btrfs") args = ["filesystem", "resize", String(required(params, "size")), String(params.mountPath || resolved.path)];
      else if (type === "xfs") args = [...array(params.extraArgs), String(required(params, "mountPath"))];
      else args = [resolved.path, ...(params.size ? [String(params.size)] : []), ...array(params.extraArgs)];
      return runCommand(tool, args, params, context);
    },
  });
  register({
    name: "filesystem.label",
    description: "Set a filesystem label.",
    mutates: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      const type = String(required(params, "filesystemType")).toLowerCase();
      const tool = FILESYSTEM_TOOLS[type]?.label;
      if (!tool) throw createRecoveryError(RECOVERY_ERROR_CODES.TOOL_MISSING, `Filesystem ${type} has no registered label tool.`);
      const args = type === "xfs" ? ["-L", String(required(params, "label")), resolved.path]
        : type === "btrfs" ? ["filesystem", "label", resolved.path, String(required(params, "label"))]
          : [resolved.path, String(required(params, "label"))];
      return runCommand(tool, args, params, context);
    },
  });
  register({
    name: "filesystem.uuid",
    description: "Set or regenerate a filesystem UUID.",
    mutates: true,
    handler: async (params, context) => {
      const { resolved } = await resolveDevice(params, context);
      const type = String(required(params, "filesystemType")).toLowerCase();
      const tool = FILESYSTEM_TOOLS[type]?.uuid;
      if (!tool) throw createRecoveryError(RECOVERY_ERROR_CODES.TOOL_MISSING, `Filesystem ${type} has no registered UUID tool.`);
      const value = String(params.uuid || "random");
      const args = type.startsWith("ext") ? ["-U", value, resolved.path]
        : type === "xfs" ? ["-U", value, resolved.path]
          : ["-u", value, resolved.path];
      return runCommand(tool, args, params, context);
    },
  });
  simpleCommand("filesystem.mount", "Mount a filesystem.", async (params) => ({ file: "mount", args: [...(params.filesystemType ? ["-t", String(params.filesystemType)] : []), ...(params.options ? ["-o", String(params.options)] : []), String(required(params, "path")), String(required(params, "target"))] }), { mutates: true });
  simpleCommand("filesystem.unmount", "Unmount a filesystem.", async (params) => ({ file: "umount", args: [...(params.force ? ["--force"] : []), ...(params.lazy ? ["--lazy"] : []), String(required(params, "target"))] }), { mutates: true });
  register({
    name: "filesystem.scrub",
    description: "Start or inspect a filesystem scrub.",
    mutates: true,
    handler: async (params, context) => {
      const type = String(required(params, "filesystemType")).toLowerCase();
      if (type === "btrfs") return runCommand("btrfs", ["scrub", params.status ? "status" : "start", ...(params.readOnly ? ["-r"] : []), String(required(params, "mountPath"))], params, context);
      if (type === "xfs") return runCommand("xfs_scrub", [...array(params.extraArgs), String(required(params, "mountPath"))], params, context);
      throw createRecoveryError(RECOVERY_ERROR_CODES.TOOL_MISSING, `Filesystem ${type} does not expose a registered scrub command.`);
    },
  });

  register({
    name: "boot.detect",
    description: "Detect installed roots, distributions, and boot firmware.",
    handler: async (params, context) => ({ ok: true, inventory: await collectInventory({ onProgress: (progress) => emit(context.onEvent, { type: "step.progress", progress }) }) }),
  });
  register({
    name: "boot.mount-system",
    description: "Mount an installed root plus optional boot and EFI partitions.",
    mutates: true,
    handler: async (params, context) => {
      const target = String(params.target || `/mnt/workwire/${randomBytesImpl(6).toString("hex")}`);
      const commands = [
        { file: "mkdir", args: ["-p", target] },
        { file: "mount", args: [...(params.readOnly ? ["-o", "ro"] : []), String(required(params, "rootPath")), target] },
      ];
      if (params.bootPath) commands.push({ file: "mkdir", args: ["-p", path.join(target, "boot")] }, { file: "mount", args: [String(params.bootPath), path.join(target, "boot")] });
      if (params.efiPath) commands.push({ file: "mkdir", args: ["-p", path.join(target, "boot", "efi")] }, { file: "mount", args: [String(params.efiPath), path.join(target, "boot", "efi")] });
      const result = await runCommands(commands, params, context);
      return { ...result, target };
    },
  });
  register({
    name: "boot.mount-pseudo",
    description: "Bind dev/proc/sys/run into an installed root.",
    mutates: true,
    handler: async (params, context) => {
      const root = String(required(params, "root"));
      return runCommands(["dev", "proc", "sys", "run"].map((name) => ({
        file: "mount",
        args: ["--rbind", `/${name}`, path.join(root, name)],
      })), params, context);
    },
  });
  simpleCommand("boot.chroot-command", "Run arbitrary argv inside an installed system.", async (params) => ({ file: "chroot", args: [String(required(params, "root")), ...array(required(params, "argv"))] }), { mutates: true });
  simpleCommand("boot.grub.install-bios", "Install GRUB for BIOS boot.", async (params) => ({ file: "chroot", args: [String(required(params, "root")), params.command || "grub-install", ...array(params.extraArgs), String(required(params, "diskPath"))] }), { mutates: true });
  simpleCommand("boot.grub.install-uefi", "Install GRUB for UEFI boot.", async (params) => ({ file: "chroot", args: [String(required(params, "root")), params.command || "grub-install", "--target=x86_64-efi", `--efi-directory=${params.efiDirectory || "/boot/efi"}`, ...(params.bootloaderId ? [`--bootloader-id=${params.bootloaderId}`] : []), ...array(params.extraArgs)] }), { mutates: true });
  simpleCommand("boot.grub.regenerate-config", "Regenerate a GRUB configuration.", async (params) => ({ file: "chroot", args: [String(required(params, "root")), params.command || "grub-mkconfig", "-o", String(params.output || "/boot/grub/grub.cfg"), ...array(params.extraArgs)] }), { mutates: true });
  simpleCommand("boot.systemd-boot.install", "Install systemd-boot.", async (params) => ({ file: "bootctl", args: [`--root=${required(params, "root")}`, "install", ...array(params.extraArgs)] }), { mutates: true });
  simpleCommand("boot.efi.list", "List UEFI boot entries.", async () => ({ file: "efibootmgr", args: ["-v"] }));
  simpleCommand("boot.efi.create-entry", "Create a UEFI boot entry.", async (params) => ({ file: "efibootmgr", args: ["--create", "--disk", String(required(params, "diskPath")), "--part", String(required(params, "partition")), "--label", String(required(params, "label")), "--loader", String(required(params, "loader")), ...array(params.extraArgs)] }), { mutates: true });
  simpleCommand("boot.efi.delete-entry", "Delete a UEFI boot entry.", async (params) => ({ file: "efibootmgr", args: ["--bootnum", String(required(params, "bootnum")), "--delete-bootnum"] }), { mutates: true });
  register({
    name: "boot.initramfs.rebuild",
    description: "Rebuild initramfs using the installed distribution's native tool.",
    mutates: true,
    handler: async (params, context) => {
      const root = String(required(params, "root"));
      const distribution = String(params.distribution || "generic").toLowerCase();
      const command = params.command || (distribution.includes("fedora") || distribution.includes("rhel") ? "dracut" : distribution.includes("arch") ? "mkinitcpio" : "update-initramfs");
      const args = command === "dracut" ? ["--force"] : command === "mkinitcpio" ? ["-P"] : ["-u", "-k", "all"];
      return runCommand("chroot", [root, command, ...args, ...array(params.extraArgs)], params, context);
    },
  });
  simpleCommand("boot.fstab.inspect", "Read an installed system fstab.", async (params) => ({ file: "cat", args: [path.join(String(required(params, "root")), "etc", "fstab")] }));
  register({
    name: "boot.fstab.rewrite",
    description: "Atomically replace an installed system fstab.",
    mutates: true,
    handler: async (params, context) => {
      const destination = path.join(String(required(params, "root")), "etc", "fstab");
      return runCommand("tee", [destination], params, context, { stdin: String(required(params, "contents")) });
    },
  });
  simpleCommand("boot.kernel.list", "List kernels in an installed system.", async (params) => ({ file: "find", args: [path.join(String(required(params, "root")), "boot"), "-maxdepth", "2", "-type", "f", "(", "-name", "vmlinuz*", "-o", "-name", "initramfs*", "-o", "-name", "initrd*", ")", "-print"] }));
  simpleCommand("boot.windows.bcd.inspect", "Inspect a Windows BCD store with available native tools.", async (params) => ({ file: params.tool || "hivexregedit", args: array(params.args || ["--export", String(required(params, "bcdPath"))]) }));
  register({
    name: "boot.cleanup-mounts",
    description: "Unmount an installed system tree in reverse order.",
    mutates: true,
    handler: async (params, context) => runCommand("umount", ["--recursive", ...(params.lazy ? ["--lazy"] : []), String(required(params, "root"))], params, context),
  });

  simpleCommand("power.hibernate", "Hibernate the target (wake-on-LAN capable sleep).", async (params) => platform === "win32"
    ? { file: "shutdown", args: ["/h", ...array(params.extraArgs)] }
    : { file: "systemctl", args: ["hibernate", ...array(params.extraArgs)] }, { mutates: true });

  if (platform === "win32") {
    simpleCommand("power.reboot", "Reboot the target with shutdown.exe.", async (params) => ({ file: "shutdown", args: ["/r", "/t", String(params.delaySeconds ?? 0), ...array(params.extraArgs)] }), { mutates: true });
    simpleCommand("power.poweroff", "Hibernate by default (fleet prime directive); method \"shutdown\" forces a real S5 power-off.", async (params) => params.method === "shutdown"
      ? { file: "shutdown", args: ["/s", "/t", String(params.delaySeconds ?? 0), ...array(params.extraArgs)] }
      : { file: "shutdown", args: ["/h", ...array(params.extraArgs)] }, { mutates: true });
    simpleCommand("process.list", "List target processes.", async () => ({ file: "tasklist", args: ["/v", "/fo", "csv"] }), { requiredTools: ["tasklist"] });
    simpleCommand("process.signal", "Terminate a process tree.", async (params) => ({ file: "taskkill", args: ["/pid", String(required(params, "pid")), "/t", ...(boolean(params.force) ? ["/f"] : [])] }), { mutates: true, requiredTools: ["taskkill"] });
    simpleCommand("service.status", "status a target service.", async (params) => ({ file: "sc", args: ["query", String(required(params, "name"))] }), { requiredTools: ["sc"] });
    simpleCommand("service.start", "start a target service.", async (params) => ({ file: "sc", args: ["start", String(required(params, "name"))] }), { mutates: true, requiredTools: ["sc"] });
    simpleCommand("service.stop", "stop a target service.", async (params) => ({ file: "sc", args: ["stop", String(required(params, "name"))] }), { mutates: true, requiredTools: ["sc"] });
    simpleCommand("service.restart", "restart a target service.", async (params) => ({ file: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", "Restart-Service -Name $env:WW_SERVICE_NAME -Force"], options: { env: { WW_SERVICE_NAME: String(required(params, "name")) } } }), { mutates: true, requiredTools: ["powershell"] });
  }

  for (const name of COMPLETE_ACTION_NAMES) {
    if (!descriptors.has(name)) throw new Error(`Recovery action registry is missing ${name}.`);
  }

  async function run(name, params = {}, context = {}) {
    const descriptor = descriptors.get(String(name));
    if (!descriptor) {
      throw createRecoveryError(RECOVERY_ERROR_CODES.TOOL_MISSING, `Recovery action ${name} is not registered.`);
    }
    for (const tool of descriptor.requiredTools) {
      if (!(await executor.toolExists(tool))) {
        throw createRecoveryError(RECOVERY_ERROR_CODES.TOOL_MISSING, `Recovery action ${name} requires ${tool}.`, { action: name, tool });
      }
    }
    const execute = async () => {
      const actionContext = { ...context, force: context.force === true || params.force === true };
      emit(context.onEvent, { type: "step.action", action: name, params: structuredClone(params), mutates: descriptor.mutates, force: actionContext.force });
      let result;
      let inventoryAfter = null;
      try {
        result = await descriptor.handler(params, actionContext);
      } finally {
        if (descriptor.mutates) {
          inventoryAfter = await collectInventory({
            onProgress: (progress) => emit(context.onEvent, { type: "step.progress", progress }),
          }).catch((error) => ({
            collectedAt: new Date().toISOString(),
            block: { devices: [] },
            errors: [{ collector: "post-mutation-inventory", code: error.code, message: error.message }],
          }));
          emit(context.onEvent, {
            type: "step.inventory.refreshed",
            devices: inventoryAfter?.block?.devices?.length || 0,
            errors: inventoryAfter?.errors?.length || 0,
          });
        }
      }
      return {
        action: name,
        mutates: descriptor.mutates,
        force: actionContext.force,
        ...result,
        ...(inventoryAfter ? { inventoryAfter } : {}),
      };
    };
    if (!descriptor.mutates) return execute();
    const resultPromise = mutationTail.then(execute, execute);
    mutationTail = resultPromise.catch(() => {});
    return resultPromise;
  }

  return {
    list() {
      return [...descriptors.values()].map(({ handler, ...descriptor }) => structuredClone(descriptor));
    },
    describe(name) {
      const descriptor = descriptors.get(String(name));
      if (!descriptor) return null;
      const { handler, ...publicDescriptor } = descriptor;
      return structuredClone(publicDescriptor);
    },
    has(name) {
      return descriptors.has(String(name));
    },
    run,
  };
}

export { COMPLETE_ACTION_NAMES, FILESYSTEM_TOOLS };
