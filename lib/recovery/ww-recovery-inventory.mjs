import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { createHash } from "node:crypto";
import { createRecoveryExecutor } from "./ww-recovery-executor.mjs";
import { decodeOutputChunk, normalizeInventory } from "./ww-recovery-protocol.mjs";

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function parseKeyValueLines(value = "", separator = "=") {
  const result = {};
  for (const line of String(value).split("\n")) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let item = line.slice(index + separator.length).trim();
    if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))) {
      item = item.slice(1, -1);
    }
    result[key] = item.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  return result;
}

function stableDeviceId(device = {}) {
  const preferred = (device.byId || []).find((value) => !/\/by-id\/wwn-0x0+$/.test(value));
  if (preferred) return `by-id:${path.basename(preferred)}`;
  const strong = device.wwn || device.eui || device.serial;
  if (strong) {
    return `disk:${createHash("sha256").update([
      device.type, strong, device.model, device.size, device.transport,
    ].join("\0")).digest("base64url").slice(0, 28)}`;
  }
  return `disk:${createHash("sha256").update([
    device.type, device.model, device.size, device.transport, device.majorMinor,
  ].join("\0")).digest("base64url").slice(0, 28)}`;
}

function normalizeLsblkDevice(raw = {}, parent = null, output = { devices: [], edges: [] }) {
  const kernelName = String(raw.name || raw.kname || "");
  const canonicalPath = String(raw.path || (kernelName ? `/dev/${kernelName}` : ""));
  const mountpoints = Array.isArray(raw.mountpoints)
    ? raw.mountpoints.filter(Boolean)
    : raw.mountpoint ? [raw.mountpoint] : [];
  const device = {
    name: kernelName,
    kernelName: String(raw.kname || kernelName),
    path: canonicalPath,
    canonicalPath,
    type: String(raw.type || "unknown"),
    majorMinor: String(raw["maj:min"] || ""),
    size: Number(raw.size) || 0,
    minimumIoSize: Number(raw["min-io"]) || 0,
    optimalIoSize: Number(raw["opt-io"]) || 0,
    physicalSectorSize: Number(raw.physec) || 0,
    logicalSectorSize: Number(raw.logsec) || 0,
    transport: String(raw.tran || ""),
    removable: raw.rm === true || Number(raw.rm) === 1,
    rotational: raw.rota === true || Number(raw.rota) === 1,
    readOnly: raw.ro === true || Number(raw.ro) === 1,
    model: String(raw.model || "").trim(),
    serial: String(raw.serial || "").trim(),
    wwn: String(raw.wwn || "").trim(),
    eui: String(raw.eui || "").trim(),
    partitionTableType: String(raw.pttype || ""),
    partitionTableUuid: String(raw.ptuuid || ""),
    partitionType: String(raw.parttype || ""),
    partitionUuid: String(raw.partuuid || ""),
    partitionLabel: String(raw.partlabel || ""),
    filesystemType: String(raw.fstype || ""),
    filesystemUuid: String(raw.uuid || ""),
    filesystemLabel: String(raw.label || ""),
    mountpoints,
    mounted: mountpoints.length > 0,
    byId: [],
    parent: parent?.canonicalPath || "",
  };
  output.devices.push(device);
  if (parent) output.edges.push({ from: parent.canonicalPath, to: canonicalPath, relation: "contains" });
  for (const child of Array.isArray(raw.children) ? raw.children : []) {
    normalizeLsblkDevice(child, device, output);
  }
  return output;
}

export function parseLsblkJson(value = "") {
  const parsed = typeof value === "string" ? safeJson(value, {}) : value;
  const output = { devices: [], edges: [] };
  for (const device of Array.isArray(parsed?.blockdevices) ? parsed.blockdevices : []) {
    normalizeLsblkDevice(device, null, output);
  }
  return output;
}

export function parseFindmntJson(value = "") {
  const parsed = typeof value === "string" ? safeJson(value, {}) : value;
  const mounts = [];
  const visit = (record, parent = "") => {
    const mount = {
      source: String(record?.source || ""),
      target: String(record?.target || ""),
      filesystemType: String(record?.fstype || ""),
      options: String(record?.options || ""),
      size: Number(record?.size) || 0,
      available: Number(record?.avail) || 0,
      used: Number(record?.used) || 0,
      parent,
    };
    mounts.push(mount);
    for (const child of Array.isArray(record?.children) ? record.children : []) visit(child, mount.target);
  };
  for (const record of Array.isArray(parsed?.filesystems) ? parsed.filesystems : []) visit(record);
  return mounts;
}

export function parseSmartJson(value = "", devicePath = "") {
  const raw = typeof value === "string" ? safeJson(value, {}) : value || {};
  const attributes = Array.isArray(raw?.ata_smart_attributes?.table)
    ? raw.ata_smart_attributes.table
    : [];
  const attribute = (...names) => attributes.find((item) => names.includes(String(item?.name || "").toLowerCase()));
  const rawValue = (item) => Number(item?.raw?.value ?? item?.raw?.string?.match?.(/\d+/)?.[0]) || 0;
  return {
    path: devicePath || raw?.device?.name || "",
    model: raw?.model_name || raw?.model_family || "",
    serial: raw?.serial_number || "",
    passed: typeof raw?.smart_status?.passed === "boolean" ? raw.smart_status.passed : null,
    temperatureCelsius: Number(raw?.temperature?.current) || null,
    powerOnHours: Number(raw?.power_on_time?.hours) || rawValue(attribute("power_on_hours")) || null,
    reallocatedSectors: rawValue(attribute("reallocated_sector_ct", "reallocated_event_count")),
    pendingSectors: rawValue(attribute("current_pending_sector")),
    uncorrectableSectors: rawValue(attribute("offline_uncorrectable", "reported_uncorrect")),
    errorLogCount: Number(raw?.ata_smart_error_log?.summary?.count) || 0,
    raw,
  };
}

export function parseNvmeSmartJson(value = "", devicePath = "") {
  const raw = typeof value === "string" ? safeJson(value, {}) : value || {};
  return {
    path: devicePath,
    criticalWarning: Number(raw.critical_warning) || 0,
    temperatureCelsius: Number(raw.temperature) || null,
    availableSparePercent: Number(raw.avail_spare ?? raw.available_spare) || null,
    percentageUsed: Number(raw.percent_used ?? raw.percentage_used) || 0,
    mediaErrors: Number(raw.media_errors) || 0,
    errorLogEntries: Number(raw.num_err_log_entries) || 0,
    powerOnHours: Number(raw.power_on_hours) || null,
    raw,
  };
}

async function collectByIdLinks(fsImpl, root = "/dev/disk/by-id") {
  const links = new Map();
  const entries = await fsImpl.readdir(root).catch(() => []);
  for (const name of entries) {
    const filename = path.join(root, name);
    const resolved = await fsImpl.realpath(filename).catch(() => "");
    if (!resolved) continue;
    const values = links.get(resolved) || [];
    values.push(filename);
    links.set(resolved, values);
  }
  return links;
}

function parseEfiEntries(value = "") {
  const entries = [];
  for (const line of String(value).split("\n")) {
    const match = line.match(/^Boot([0-9A-Fa-f]{4})(\*)?\s+(.+)$/);
    if (match) entries.push({ id: match[1].toUpperCase(), active: Boolean(match[2]), description: match[3] });
  }
  return entries;
}

const BASE_COLLECTORS = [
  ["uname", "uname", ["-a"]],
  ["osRelease", "cat", ["/etc/os-release"]],
  ["hostnamectl", "hostnamectl", ["--json=short"]],
  ["ipAddress", "ip", ["-json", "address"]],
  ["ipRoute", "ip", ["-json", "route"]],
  ["lsblk", "lsblk", ["--json", "--bytes", "--output-all"]],
  ["findmnt", "findmnt", ["--json", "--real", "--bytes"]],
  ["fdisk", "fdisk", ["-l"]],
  ["smartScan", "smartctl", ["--scan-open"]],
  ["nvmeList", "nvme", ["list", "-o", "json"]],
  ["mdstat", "cat", ["/proc/mdstat"]],
  ["mdadmScan", "mdadm", ["--detail", "--scan"]],
  ["pvs", "pvs", ["--reportformat", "json"]],
  ["vgs", "vgs", ["--reportformat", "json"]],
  ["lvs", "lvs", ["--all", "--reportformat", "json"]],
  ["dmsetup", "dmsetup", ["ls", "--tree"]],
  ["efibootmgr", "efibootmgr", ["-v"]],
  ["cmdline", "cat", ["/proc/cmdline"]],
  ["dmesg", "dmesg", ["--level=emerg,alert,crit,err,warn"]],
];

const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

const WINDOWS_COLLECTORS = [
  ["systeminfo", "systeminfo", ["/fo", "csv"]],
  ["ipconfig", "ipconfig", ["/all"]],
  ["getDisk", "powershell", [...POWERSHELL_ARGS, "Get-Disk | Select-Object Number,FriendlyName,SerialNumber,Size,PartitionStyle,BusType,IsBoot,IsSystem,OperationalStatus | ConvertTo-Json -Depth 3"]],
  ["getPartition", "powershell", [...POWERSHELL_ARGS, "Get-Partition | Select-Object DiskNumber,PartitionNumber,DriveLetter,Size,Offset,Type,IsActive,IsBoot,IsSystem | ConvertTo-Json -Depth 3"]],
  ["getVolume", "powershell", [...POWERSHELL_ARGS, "Get-Volume | Select-Object DriveLetter,FileSystemLabel,FileSystem,Size,SizeRemaining,HealthStatus,DriveType | ConvertTo-Json -Depth 3"]],
  ["getNetAdapter", "powershell", [...POWERSHELL_ARGS, "Get-NetAdapter | Select-Object Name,MacAddress,Status,LinkSpeed,InterfaceDescription | ConvertTo-Json -Depth 3"]],
  ["firmwareType", "powershell", [...POWERSHELL_ARGS, "$env:firmware_type"]],
];

function asArray(value) {
  return Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
}

export function parseWindowsDisks(getDiskJson = "", getPartitionJson = "", getVolumeJson = "") {
  const disks = asArray(safeJson(getDiskJson, []));
  const partitions = asArray(safeJson(getPartitionJson, []));
  const volumes = asArray(safeJson(getVolumeJson, []));
  const output = { devices: [], edges: [] };
  for (const disk of disks) {
    const diskPath = `\\\\.\\PHYSICALDRIVE${disk.Number}`;
    const device = {
      name: `PHYSICALDRIVE${disk.Number}`,
      kernelName: `PHYSICALDRIVE${disk.Number}`,
      path: diskPath,
      canonicalPath: diskPath,
      type: "disk",
      majorMinor: "",
      size: Number(disk.Size) || 0,
      transport: String(disk.BusType || "").toLowerCase(),
      removable: false,
      rotational: false,
      readOnly: false,
      model: String(disk.FriendlyName || "").trim(),
      serial: String(disk.SerialNumber || "").trim(),
      wwn: "",
      eui: "",
      partitionTableType: String(disk.PartitionStyle || "").toLowerCase(),
      filesystemType: "",
      filesystemLabel: "",
      mountpoints: [],
      mounted: false,
      byId: [],
      parent: "",
    };
    device.deviceId = stableDeviceId(device);
    output.devices.push(device);
    for (const partition of partitions.filter((candidate) => candidate.DiskNumber === disk.Number)) {
      const letter = String(partition.DriveLetter || "").trim();
      const volume = letter ? volumes.find((candidate) => String(candidate.DriveLetter || "").trim() === letter) : null;
      const partitionPath = letter ? `${letter}:` : `${diskPath}#${partition.PartitionNumber}`;
      const child = {
        name: partitionPath,
        kernelName: partitionPath,
        path: partitionPath,
        canonicalPath: partitionPath,
        type: "part",
        majorMinor: "",
        size: Number(partition.Size) || 0,
        transport: device.transport,
        removable: false,
        rotational: false,
        readOnly: false,
        model: device.model,
        serial: device.serial,
        partitionType: String(partition.Type || ""),
        filesystemType: String(volume?.FileSystem || "").toLowerCase(),
        filesystemLabel: String(volume?.FileSystemLabel || ""),
        mountpoints: letter ? [`${letter}:\\`] : [],
        mounted: Boolean(letter),
        byId: [],
        parent: diskPath,
      };
      child.deviceId = stableDeviceId(child);
      output.devices.push(child);
      output.edges.push({ from: diskPath, to: partitionPath, relation: "contains" });
    }
  }
  return output;
}

export function createRecoveryInventoryCollector({
  executor = createRecoveryExecutor(),
  fsImpl = fs,
  clock = Date,
  byIdRoot = "/dev/disk/by-id",
  sysFirmwareEfi = "/sys/firmware/efi",
  platform = process.platform,
} = {}) {
  async function capture(name, file, args, onProgress) {
    const stdout = [];
    const stderr = [];
    let result;
    try {
      result = await executor.execArgv({
        file,
        args,
        timeoutMs: 120_000,
        onEvent(event) {
          if (event.type !== "output") return;
          (event.stream === "stderr" ? stderr : stdout).push(decodeOutputChunk(event));
        },
      });
    } catch (error) {
      result = {
        exitCode: null,
        error: { code: error.code || "ERR_WW_RECOVERY_COMMAND_START", message: error.message },
      };
    }
    const record = {
      command: { file, args },
      exitCode: result.exitCode,
      signal: result.signal || null,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      ...(result.error ? { error: result.error } : {}),
    };
    onProgress?.({ collector: name, command: record.command, ok: record.exitCode === 0 });
    return record;
  }

  async function collectWindows({ identity = {}, lightweight = false, onProgress } = {}) {
    const raw = {};
    const errors = [];
    const tools = {};
    const collectors = lightweight ? WINDOWS_COLLECTORS.slice(2) : WINDOWS_COLLECTORS;
    for (const [name, file, args] of collectors) {
      tools[file] = tools[file] || {
        available: await executor.toolExists(file),
        path: await executor.resolveTool(file),
      };
      if (!tools[file].available) {
        raw[name] = { command: { file, args }, error: { code: "ERR_WW_RECOVERY_TOOL_MISSING", message: `${file} is unavailable.` } };
        errors.push({ collector: name, ...raw[name].error });
        onProgress?.({ collector: name, ok: false, missing: true });
        continue;
      }
      raw[name] = await capture(name, file, args, onProgress);
      if (raw[name].exitCode !== 0) {
        errors.push({
          collector: name,
          code: raw[name].error?.code || "ERR_WW_RECOVERY_COMMAND_FAILED",
          message: raw[name].stderr || `${file} exited ${raw[name].exitCode}`,
        });
      }
    }
    const disks = parseWindowsDisks(raw.getDisk?.stdout || "", raw.getPartition?.stdout || "", raw.getVolume?.stdout || "");
    const firmwareType = String(raw.firmwareType?.stdout || "").trim().toLowerCase();
    const inventory = normalizeInventory({
      collectedAt: new Date(typeof clock === "function" && !clock.now ? clock() : clock.now()).toISOString(),
      agent: cloneIdentity(identity),
      system: {
        hostname: os.hostname(),
        architecture: os.arch(),
        platform: "win32",
        release: os.release(),
        uname: "",
        osRelease: {},
      },
      network: { interfaces: asArray(safeJson(raw.getNetAdapter?.stdout, [])), routes: [] },
      firmware: { uefi: firmwareType === "uefi", secureBoot: null, entries: [] },
      tools,
      block: {
        devices: disks.devices,
        filesystems: disks.devices.filter((device) => device.filesystemType).map((device) => ({
          deviceId: device.deviceId,
          path: device.canonicalPath,
          type: device.filesystemType,
          uuid: "",
          label: device.filesystemLabel,
          mountpoints: device.mountpoints,
        })),
        mounts: disks.devices.filter((device) => device.mounted).map((device) => ({
          source: device.canonicalPath,
          target: device.mountpoints[0] || "",
          filesystemType: device.filesystemType,
          options: "",
          size: device.size,
          available: 0,
          used: 0,
          parent: "",
        })),
        raid: [],
        lvm: {},
        crypt: [],
        graph: {
          nodes: disks.devices.map((device) => ({ id: device.deviceId, path: device.canonicalPath, type: device.type })),
          edges: disks.edges,
        },
      },
      health: { smart: [], nvme: [], kernelWarnings: [] },
      raw,
      errors,
    });
    onProgress?.({ collector: "complete", ok: true, devices: inventory.block.devices.length });
    return inventory;
  }

  async function collect({ identity = {}, lightweight = false, onProgress } = {}) {
    if (platform === "win32") return collectWindows({ identity, lightweight, onProgress });
    const raw = {};
    const errors = [];
    const tools = {};
    const collectors = lightweight ? BASE_COLLECTORS.slice(0, 7) : BASE_COLLECTORS;
    for (const [name, file, args] of collectors) {
      tools[file] = tools[file] || {
        available: await executor.toolExists(file),
        path: await executor.resolveTool(file),
      };
      if (!tools[file].available) {
        raw[name] = { command: { file, args }, error: { code: "ERR_WW_RECOVERY_TOOL_MISSING", message: `${file} is unavailable.` } };
        errors.push({ collector: name, ...raw[name].error });
        onProgress?.({ collector: name, ok: false, missing: true });
        continue;
      }
      raw[name] = await capture(name, file, args, onProgress);
      if (raw[name].exitCode !== 0) {
        errors.push({
          collector: name,
          code: raw[name].error?.code || "ERR_WW_RECOVERY_COMMAND_FAILED",
          message: raw[name].stderr || `${file} exited ${raw[name].exitCode}`,
        });
      }
    }

    const lsblk = parseLsblkJson(raw.lsblk?.stdout || "");
    const byIdLinks = await collectByIdLinks(fsImpl, byIdRoot);
    for (const device of lsblk.devices) {
      const resolved = await fsImpl.realpath(device.canonicalPath).catch(() => device.canonicalPath);
      device.byId = byIdLinks.get(resolved) || [];
      device.deviceId = stableDeviceId(device);
    }
    const mounts = parseFindmntJson(raw.findmnt?.stdout || "");
    const rootMount = mounts.find((mount) => mount.target === "/");
    for (const device of lsblk.devices) {
      device.recoveryRoot = Boolean(rootMount?.source && (
        rootMount.source === device.canonicalPath
        || rootMount.source === device.path
        || device.mountpoints.includes("/")
      ));
      device.recoveryBootMedium = device.recoveryRoot;
    }

    if (!lightweight) {
      for (const device of lsblk.devices.filter((candidate) => candidate.type === "disk")) {
        const suffix = createHash("sha1").update(device.canonicalPath).digest("hex").slice(0, 10);
        if (tools.smartctl?.available) {
          raw[`smart_${suffix}`] = await capture(
            `smart:${device.canonicalPath}`,
            "smartctl",
            ["--all", "--json=c", device.canonicalPath],
            onProgress,
          );
        }
        if (tools.nvme?.available && (device.transport === "nvme" || /nvme/.test(device.name))) {
          raw[`nvmeSmart_${suffix}`] = await capture(
            `nvme:${device.canonicalPath}`,
            "nvme",
            ["smart-log", "-o", "json", device.canonicalPath],
            onProgress,
          );
        }
        if (tools.sfdisk === undefined) {
          tools.sfdisk = {
            available: await executor.toolExists("sfdisk"),
            path: await executor.resolveTool("sfdisk"),
          };
        }
        if (tools.sfdisk.available) {
          raw[`sfdisk_${suffix}`] = await capture(
            `sfdisk:${device.canonicalPath}`,
            "sfdisk",
            ["--json", device.canonicalPath],
            onProgress,
          );
        }
        if (tools.udevadm === undefined) {
          tools.udevadm = {
            available: await executor.toolExists("udevadm"),
            path: await executor.resolveTool("udevadm"),
          };
        }
        if (tools.udevadm.available) {
          raw[`udev_${suffix}`] = await capture(
            `udev:${device.canonicalPath}`,
            "udevadm",
            ["info", "--query=property", "--name", device.canonicalPath],
            onProgress,
          );
        }
      }
    }

    const smart = [];
    const nvme = [];
    for (const [name, record] of Object.entries(raw)) {
      if (name.startsWith("smart_") && record.stdout) smart.push(parseSmartJson(record.stdout));
      if (name.startsWith("nvmeSmart_") && record.stdout) nvme.push(parseNvmeSmartJson(record.stdout));
    }
    const osRelease = parseKeyValueLines(raw.osRelease?.stdout || "");
    const hostnamectl = safeJson(raw.hostnamectl?.stdout, {});
    const interfaces = safeJson(raw.ipAddress?.stdout, []);
    const routes = safeJson(raw.ipRoute?.stdout, []);
    const uefi = await fsImpl.stat(sysFirmwareEfi).then((stats) => stats.isDirectory()).catch(() => false);
    const inventory = normalizeInventory({
      collectedAt: new Date(typeof clock === "function" && !clock.now ? clock() : clock.now()).toISOString(),
      agent: cloneIdentity(identity),
      system: {
        hostname: hostnamectl?.StaticHostname || hostnamectl?.Hostname || os.hostname(),
        architecture: os.arch(),
        platform: os.platform(),
        release: os.release(),
        uname: raw.uname?.stdout?.trim() || "",
        osRelease,
      },
      network: { interfaces, routes },
      firmware: {
        uefi,
        secureBoot: null,
        entries: parseEfiEntries(raw.efibootmgr?.stdout),
      },
      tools,
      block: {
        devices: lsblk.devices,
        filesystems: lsblk.devices.filter((device) => device.filesystemType).map((device) => ({
          deviceId: device.deviceId,
          path: device.canonicalPath,
          type: device.filesystemType,
          uuid: device.filesystemUuid,
          label: device.filesystemLabel,
          mountpoints: device.mountpoints,
        })),
        mounts,
        raid: safeJson(raw.mdstat?.stdout, null) || [],
        lvm: {
          pvs: safeJson(raw.pvs?.stdout, {}),
          vgs: safeJson(raw.vgs?.stdout, {}),
          lvs: safeJson(raw.lvs?.stdout, {}),
        },
        crypt: [],
        graph: {
          nodes: lsblk.devices.map((device) => ({ id: device.deviceId, path: device.canonicalPath, type: device.type })),
          edges: lsblk.edges,
        },
      },
      health: {
        smart,
        nvme,
        kernelWarnings: String(raw.dmesg?.stdout || "").split("\n").filter(Boolean),
      },
      raw,
      errors,
    });
    onProgress?.({ collector: "complete", ok: true, devices: inventory.block.devices.length });
    return inventory;
  }

  return { collect, capture };
}

function cloneIdentity(identity) {
  return identity && typeof identity === "object" ? structuredClone(identity) : {};
}

const defaultCollector = createRecoveryInventoryCollector();
export const collectRecoveryInventory = defaultCollector.collect;
export { parseKeyValueLines, stableDeviceId };
