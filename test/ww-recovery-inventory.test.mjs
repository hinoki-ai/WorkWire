import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseFindmntJson,
  parseLsblkJson,
  parseNvmeSmartJson,
  parseSmartJson,
  stableDeviceId,
} from "../lib/recovery/ww-recovery-inventory.mjs";
import {
  collectPhysicalMacAddresses,
  resolveRecoveryAgentIdentity,
} from "../lib/recovery/ww-recovery-agent-id.mjs";

test("recovery inventory flattens disk topology while preserving graph edges", () => {
  const parsed = parseLsblkJson({
    blockdevices: [{
      name: "nvme0n1",
      path: "/dev/nvme0n1",
      type: "disk",
      size: 1_000_000,
      serial: "SERIAL-1",
      tran: "nvme",
      children: [{
        name: "nvme0n1p1",
        path: "/dev/nvme0n1p1",
        type: "part",
        size: 500_000,
        fstype: "ext4",
        uuid: "fs-uuid",
        mountpoints: ["/"],
      }],
    }],
  });
  assert.equal(parsed.devices.length, 2);
  assert.equal(parsed.devices[1].parent, "/dev/nvme0n1");
  assert.deepEqual(parsed.edges[0], {
    from: "/dev/nvme0n1",
    to: "/dev/nvme0n1p1",
    relation: "contains",
  });
  assert.match(stableDeviceId(parsed.devices[0]), /^disk:/);
});

test("recovery inventory parses mounts and health indicators", () => {
  const mounts = parseFindmntJson({
    filesystems: [{ source: "/dev/root", target: "/", fstype: "ext4", children: [
      { source: "/dev/boot", target: "/boot", fstype: "vfat" },
    ] }],
  });
  assert.equal(mounts[1].parent, "/");

  const smart = parseSmartJson({
    smart_status: { passed: false },
    temperature: { current: 54 },
    ata_smart_attributes: { table: [
      { name: "Reallocated_Sector_Ct", raw: { value: 12 } },
      { name: "Current_Pending_Sector", raw: { value: 3 } },
    ] },
  }, "/dev/sda");
  assert.equal(smart.passed, false);
  assert.equal(smart.reallocatedSectors, 12);
  assert.equal(smart.pendingSectors, 3);

  const nvme = parseNvmeSmartJson({ critical_warning: 1, percent_used: 87, media_errors: 4 }, "/dev/nvme0");
  assert.equal(nvme.criticalWarning, 1);
  assert.equal(nvme.percentageUsed, 87);
  assert.equal(nvme.mediaErrors, 4);
});

test("PXE recovery identity is deterministic from DMI UUID and lowest physical MAC", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-id-"));
  const sysClassNet = path.join(root, "sys", "class", "net");
  const productUuidPath = path.join(root, "product_uuid");
  const bootIdPath = path.join(root, "boot_id");
  try {
    for (const [name, mac] of [["eno2", "aa:bb:cc:dd:ee:ff"], ["eno1", "00:11:22:33:44:55"], ["lo", "00:00:00:00:00:00"]]) {
      const interfacePath = path.join(sysClassNet, name);
      await fs.mkdir(path.join(interfacePath, "device"), { recursive: true });
      await fs.writeFile(path.join(interfacePath, "address"), `${mac}\n`);
      await fs.writeFile(path.join(interfacePath, "type"), "1\n");
    }
    await fs.writeFile(productUuidPath, "ABCDEF-1234\n");
    await fs.writeFile(bootIdPath, "boot-one\n");
    const macs = await collectPhysicalMacAddresses({ fsImpl: fs, sysClassNet });
    assert.equal(macs[0].mac, "00:11:22:33:44:55");
    const first = await resolveRecoveryAgentIdentity({
      mode: "pxe",
      fsImpl: fs,
      sysClassNet,
      productUuidPath,
      bootIdPath,
      machineIdPaths: [],
    });
    const second = await resolveRecoveryAgentIdentity({
      mode: "pxe",
      fsImpl: fs,
      sysClassNet,
      productUuidPath,
      bootIdPath,
      machineIdPaths: [],
    });
    assert.equal(first.agentId, second.agentId);
    assert.match(first.agentId, /^wwra_[A-Za-z0-9_-]{24}$/);
    assert.equal(first.stability, "hardware-stable");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
