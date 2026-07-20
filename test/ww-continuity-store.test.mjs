import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createContinuityStore, createMachineGraph, getContinuityCapabilities,
} from "../lib/continuity/index.mjs";

async function temporaryRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function inventory(index, overrides = {}) {
  return {
    collectedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    operatorAlias: "operator:continuity-fixture",
    dmiUuid: index < 50 ? "DMI-ORIGINAL" : "DMI-REINSTALLED",
    bootId: `boot-${Math.floor(index / 10)}`,
    system: {
      hostname: index < 50 ? "patient-old" : "patient-new",
      platform: "linux",
      release: index < 50 ? "6.12" : "6.13",
      osRelease: { NAME: "Fedora", VERSION_ID: index < 50 ? "42" : "43" },
      machineId: index < 50 ? "os-install-a" : "os-install-b",
    },
    agent: { mode: index < 50 ? "installed" : "pxe", bootId: `boot-${Math.floor(index / 10)}`, capabilities: { shell: true, smart: index >= 50 } },
    network: { interfaces: [{ ifname: "eno1", address: index < 50 ? "00:11:22:33:44:55" : "00:11:22:33:44:66", ip: `192.168.8.${10 + (index % 50)}` }] },
    block: {
      devices: [{ type: "disk", deviceId: "disk-stable", path: index < 50 ? "/dev/sda" : "/dev/nvme0n1", size: index < 100 ? 1_000 : 2_000 }],
      filesystems: [{ deviceId: "disk-stable", uuid: "root-fs", type: index < 75 ? "ext4" : "xfs", mountpoints: ["/"] }],
      mounts: [{ source: "/dev/root", target: "/", size: 1_000, used: 500 + index }],
    },
    health: { smart: [{ deviceId: "disk-stable", passed: true, temperatureCelsius: 35 + Math.floor(index / 25), pendingSectors: index >= 100 ? 2 : 0 }], nvme: [], kernelWarnings: [] },
    tools: { smartctl: { available: index >= 50 } },
    ...overrides,
  };
}

test("machine continuity survives DHCP, hostname, boot, mode, and explicitly correlated reinstall changes", async (t) => {
  const root = await temporaryRoot(t, "ww-continuity-store-");
  let store = createContinuityStore({ root });
  await store.init();
  const records = [];
  for (let index = 0; index <= 100; index += 1) records.push(await store.ingestInventory(`agent-${index < 50 ? "installed" : "pxe"}`, inventory(index)));
  assert.equal(store.getStats().eventCount, 101);
  assert.equal(store.listMachines().length, 1);
  const machineId = records[0].machineId;
  assert.ok(records.every((record) => record.machineId === machineId));
  assert.equal(store.getTimeline(machineId, { type: "inventory" }).length, 101);
  const difference = store.diffMachine(machineId, inventory(0).collectedAt, inventory(100).collectedAt);
  assert.equal(difference.available, true);
  assert.equal(difference.changed, true);
  assert.equal(difference.hardware.changed[0].id, "disk-stable");
  assert.equal(difference.filesystems.changed[0].from.type, "ext4");
  assert.equal(difference.filesystems.changed[0].to.type, "xfs");
  assert.equal(difference.boot.to.bootId, "boot-10");
  assert.equal(difference.agentCapabilities.to.smart, true);

  const replay = await store.ingestInventory("agent-installed", inventory(0));
  assert.equal(replay.id, records[0].id);
  assert.equal(store.getStats().eventCount, 101);
  await store.close();

  store = createContinuityStore({ root });
  await store.init();
  assert.equal(store.getStats().eventCount, 101);
  assert.equal(store.listMachines().length, 1);
  assert.equal(store.getTimeline(machineId, { from: inventory(90).collectedAt }).length, 11);
  assert.ok(store.search({ machineId, diskId: "disk-stable", health: true, text: "patient-new" }).length >= 50);
  await store.compact();
  await store.close();

  store = createContinuityStore({ root });
  await store.init();
  assert.equal(store.diffMachine(machineId, inventory(0).collectedAt, inventory(100).collectedAt).changed, true);
  await store.close();
});

test("duplicate observations are idempotent and an abrupt final write is quarantined while indexes rebuild", async (t) => {
  const root = await temporaryRoot(t, "ww-continuity-abrupt-");
  let store = createContinuityStore({ root });
  await store.init();
  const event = { id: "event-stable", type: "health.observation", timestamp: "2026-03-01T00:00:00Z", dmiUuid: "DMI-1", diskIds: ["disk-1"], health: true, text: "media warning" };
  await store.ingestObservation(event);
  await store.ingestObservation(structuredClone(event));
  assert.equal(store.getStats().eventCount, 1);
  await store.close();
  const journal = path.join(root, "events", "continuity.jsonl");
  await fs.appendFile(journal, '{"id":"torn","timestamp":"2026-03');

  store = createContinuityStore({ root });
  await store.init();
  assert.equal(store.getStats().eventCount, 1);
  assert.ok(store.getStats().recoveredTailBytes > 0);
  assert.equal(store.search({ diskId: "disk-1", health: true, text: "media" }).length, 1);
  assert.match(await fs.readFile(path.join(root, "events", "abrupt-tail.bin"), "utf8"), /torn/);
  await store.close();
});

test("identity graph records conflicting strong evidence without silently merging", () => {
  const graph = createMachineGraph();
  const first = graph.correlateIdentity({ dmiUuid: "dmi-a", physicalMac: "00:00:00:00:00:0a", timestamp: "2026-01-01" });
  const second = graph.correlateIdentity({ dmiUuid: "dmi-b", physicalMac: "00:00:00:00:00:0b", timestamp: "2026-01-01" });
  const conflict = graph.correlateIdentity({ dmiUuid: "dmi-a", physicalMac: "00:00:00:00:00:0b", timestamp: "2026-01-02" });
  assert.equal(conflict.ambiguous, true);
  assert.notEqual(conflict.machineId, first.machineId);
  assert.notEqual(conflict.machineId, second.machineId);
  assert.deepEqual(new Set(graph.explainIdentity(conflict.machineId).ambiguities[0].candidateMachineIds), new Set([first.machineId, second.machineId]));
  assert.equal(graph.resolveMachine({ hostname: "shared-dhcp-name" }), null);
});

test("capability report advertises only concrete continuity surfaces", () => {
  const capabilities = getContinuityCapabilities();
  assert.equal(capabilities.schemaVersion, 1);
  for (const type of ["physical-machine", "boot-session", "os-installation", "disk", "partition", "filesystem", "snapshot", "case", "job", "artifact", "file-set"]) {
    assert.ok(capabilities.entityTypes.includes(type));
  }
  assert.deepEqual(capabilities.vault.backends, ["filesystem"]);
  assert.ok(!canonicalString(capabilities).includes("cloud"));
});

function canonicalString(value) {
  return JSON.stringify(value).toLocaleLowerCase();
}
