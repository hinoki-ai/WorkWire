import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as continuity from "../lib/continuity/index.mjs";

async function temporaryRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function healthInventory(timestamp, values = {}) {
  return {
    collectedAt: timestamp,
    dmiUuid: "health-machine-dmi",
    system: { hostname: "health-patient", platform: "linux" },
    agent: { state: values.reachable === false ? "offline" : "online", reachable: values.reachable ?? true },
    block: {
      devices: values.devices || [{ type: "disk", deviceId: "nvme-serial-1", path: "/dev/nvme0n1", size: 1_000_000 }],
      mounts: [{ source: "/dev/root", target: "/", size: 1_000, used: values.used ?? 700 }],
      raid: values.raid || [],
    },
    health: {
      smart: [{ deviceId: "sata-1", path: "/dev/sda", passed: true, pendingSectors: values.pending ?? 0, uncorrectableSectors: 0, temperatureCelsius: values.temperature ?? 40 }],
      nvme: [{ deviceId: "nvme-serial-1", path: "/dev/nvme0n1", criticalWarning: 0, percentageUsed: values.wear ?? 50, mediaErrors: values.mediaErrors ?? 0, unsafeShutdowns: values.unsafeShutdowns ?? 2 }],
      kernelWarnings: values.warnings || [],
      bootFailures: values.bootFailures ?? 0,
    },
    tools: { smartctl: { available: true }, nvme: { available: values.nvmeTool ?? true }, ddrescue: { available: values.ddrescue ?? true } },
  };
}

test("SMART/NVMe trends yield evidence-backed findings and powerful recommendations", () => {
  const health = continuity.createHealthIntelligence();
  health.observe("machine-health", healthInventory("2026-07-18T00:00:00Z"));
  health.observe("machine-health", healthInventory("2026-07-19T00:00:00Z", {
    used: 950, pending: 4, temperature: 74, wear: 94, mediaErrors: 3, unsafeShutdowns: 8,
    warnings: ["I/O error, dev nvme0n1"], bootFailures: 3,
  }));
  const assessment = health.evaluate("machine-health", { now: "2026-07-19T01:00:00Z" });
  assert.equal(assessment.status, "warning");
  const pending = assessment.findings.find((item) => item.metric === "smart.pendingSectors" && item.ruleId === "pending-sectors");
  assert.equal(pending.observedValue, 4);
  assert.equal(pending.affectedEntity, "sata-1");
  assert.equal(pending.evidence.path, "/dev/sda");
  assert.equal(pending.trend.delta, 4);
  assert.ok(assessment.findings.some((item) => item.metric === "nvme.mediaErrors" && item.trend.delta === 3));
  assert.ok(assessment.findings.some((item) => item.metric === "filesystem.usedPercent"));
  assert.ok(assessment.findings.some((item) => item.ruleId === "recurring-boot-failures"));
  const operations = new Set(health.recommendations("machine-health").map((item) => item.operation));
  for (const operation of ["snapshot-now", "run-long-SMART-test", "prepare-ddrescue", "verify-vault", "replace-disk"]) {
    assert.ok(operations.has(operation), `missing ${operation}`);
  }
  assert.equal(health.getSeries("machine-health", "nvme.mediaErrors").length, 2);
  assert.ok(health.compare("machine-health", "2026-07-18T00:00:00Z", "2026-07-19T00:00:00Z").changes.length > 0);
});

test("health reports unknown optional metrics honestly and detects disappearance and stale observations", () => {
  const health = continuity.createHealthIntelligence({ staleAfterMs: 60_000 });
  health.observe("machine-unknown", { collectedAt: "2026-01-01T00:00:00Z", dmiUuid: "dmi-before", block: { devices: [{ deviceId: "disk-a" }, { deviceId: "disk-b" }] } });
  health.observe("machine-unknown", { collectedAt: "2026-01-01T00:01:00Z", dmiUuid: "dmi-after", block: { devices: [{ deviceId: "disk-a" }] } });
  const assessment = health.evaluate("machine-unknown", { now: "2026-01-01T00:10:00Z" });
  assert.ok(assessment.unknownMetrics.includes("smart.passed"));
  assert.ok(!assessment.findings.some((item) => item.ruleId === "smart-failed"));
  assert.ok(assessment.findings.some((item) => item.ruleId === "device-disappeared" && item.affectedEntity === "disk-b"));
  assert.ok(assessment.findings.some((item) => item.ruleId === "identity-drift"));
  assert.ok(assessment.findings.some((item) => item.ruleId === "observation-stale"));
});

test("headless CLI covers history, health, and vault surfaces with JSON output", async (t) => {
  const root = await temporaryRoot(t, "ww-continuity-cli-");
  const store = continuity.createContinuityStore({ root: path.join(root, "history") });
  await store.init();
  const inventory = healthInventory("2026-07-19T00:00:00Z", { pending: 1 });
  const record = await store.ingestInventory("agent-cli", inventory);
  await store.ingestInventory("agent-cli", healthInventory("2026-07-20T00:00:00Z", { pending: 2 }));
  const source = path.join(root, "cli.txt");
  await fs.writeFile(source, "cli vault\n");
  const vault = continuity.createRecoveryVault({ root: path.join(root, "vault"), chunkSize: 4096 });
  await vault.init();
  const snapshot = await vault.ingestFile(source, { pinned: true });

  async function invoke(argv) {
    let stdout = "";
    let stderr = "";
    const code = await continuity.runContinuityCli(argv, {
      store, vault, stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; },
    });
    return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) : null };
  }

  const machines = await invoke(["continuity", "machines", "--json"]);
  assert.equal(machines.code, 0);
  assert.equal(machines.json[0].id, record.machineId);
  assert.equal((await invoke(["timeline", record.machineId, "--json"])).json.length, 2);
  assert.equal((await invoke(["diff", record.machineId, "--from", "2026-07-19", "--to", "2026-07-20", "--json"])).json.available, true);
  assert.equal((await invoke(["search", "health-patient", "--json"])).json.length, 2);
  assert.ok((await invoke(["health", record.machineId, "--json"])).json.findings.length > 0);
  assert.equal((await invoke(["vault", "stats", "--json"])).json.snapshotCount, 1);
  assert.equal((await invoke(["vault", "snapshots", "--json"])).json[0].id, snapshot.id);
  assert.equal((await invoke(["vault", "scrub", "--json"])).json.ok, true);
  assert.equal((await invoke(["vault", "prune", "--policy", '{"keepLast":0}', "--json"])).json.execute, false);

  const destination = path.join(root, "cli-restored");
  assert.equal((await invoke(["vault", "restore", snapshot.id, destination, "--json"])).code, 0);
  assert.equal(await fs.readFile(path.join(destination, "cli.txt"), "utf8"), "cli vault\n");
  await store.close();
  await vault.close();
});

test("invalid CLI prune policy fails before creating or mutating a vault", async (t) => {
  const root = path.join(await temporaryRoot(t, "ww-continuity-invalid-cli-"), "does-not-exist-yet");
  let stderr = "";
  const code = await continuity.runContinuityCli(["vault", "prune", "--policy", "not-json", "--execute"], {
    root, stdout() {}, stderr: (value) => { stderr += value; },
  });
  assert.equal(code, 2);
  assert.match(stderr, /Invalid prune policy JSON/);
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
});

test("public continuity module exports only the frozen stable names", () => {
  assert.deepEqual(Object.keys(continuity).sort(), [
    "CONTINUITY_SCHEMA_VERSION", "createContinuityStore", "createHealthIntelligence",
    "createMachineGraph", "createRecoveryVault", "getContinuityCapabilities", "runContinuityCli",
  ].sort());
});
