import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSalvageEngine,
  getSalvageCapabilities,
  WW_SALVAGE_VERSION,
} from "../lib/salvage/index.mjs";

async function setup(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ww-salvage-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  await fs.mkdir(path.join(source, "docs"), { recursive: true });
  await fs.mkdir(path.join(source, "src"), { recursive: true });
  return { base, source, destinationA: path.join(base, "destination-a"), destinationB: path.join(base, "destination-b") };
}

test("metadata-only inventory prioritizes rules and estimates per-level capacity", async (t) => {
  const paths = await setup(t);
  await fs.writeFile(path.join(paths.source, "urgent.bin"), Buffer.alloc(90_000, 1));
  await fs.writeFile(path.join(paths.source, "docs", "contract.pdf"), Buffer.alloc(40_000, 2));
  await fs.writeFile(path.join(paths.source, "src", "app.js"), Buffer.alloc(30_000, 3));
  await fs.writeFile(path.join(paths.source, ".env"), Buffer.alloc(20_000, 4));
  await fs.writeFile(path.join(paths.source, "tiny.dat"), Buffer.alloc(10_000, 5));
  await fs.writeFile(path.join(paths.source, "photo.jpg"), Buffer.alloc(300_000, 6));
  await fs.writeFile(path.join(paths.source, "archive.bin"), Buffer.alloc(400_000, 7));
  const engine = createSalvageEngine({ stateDir: path.join(paths.base, "state") });
  await engine.init();
  t.after(() => engine.close());
  const inventory = await engine.createInventory(paths.source, { explicitPaths: ["urgent.bin"], smallFileBytes: 16_000 });
  assert.deepEqual(inventory.entries.map((entry) => entry.level), [
    "explicit", "documents", "source-code", "credentials-config", "small-files", "photos-media", "everything-else",
  ]);
  assert.equal(inventory.totals.files, 7);
  assert.equal(inventory.entries.every((entry) => entry.hash === undefined), true, "inventory must not open every file to hash it");
  const estimate = await engine.estimateCapacity(inventory, [
    { path: paths.destinationA, capacityBytes: 250_000 },
    { path: paths.destinationB, capacityBytes: 250_000 },
  ]);
  assert.equal(estimate.levels.find((level) => level.level === "photos-media").fits, true);
  assert.equal(estimate.levels.find((level) => level.level === "everything-else").fits, false);
  assert.equal(getSalvageCapabilities().version, WW_SALVAGE_VERSION);
});

test("priority recovery spills deterministically across destinations and emits checksums", async (t) => {
  const paths = await setup(t);
  await fs.writeFile(path.join(paths.source, "first.txt"), Buffer.alloc(80_000, 1));
  await fs.writeFile(path.join(paths.source, "second.js"), Buffer.alloc(70_000, 2));
  await fs.writeFile(path.join(paths.source, "third.jpg"), Buffer.alloc(60_000, 3));
  const engine = createSalvageEngine({ stateDir: path.join(paths.base, "state") });
  await engine.init();
  t.after(() => engine.close());
  const inventory = await engine.inventory(paths.source, { explicitPaths: ["first.txt"] });
  const job = await engine.buildPlan(inventory, [
    { id: "a", path: paths.destinationA, capacityBytes: 140_000 },
    { id: "b", path: paths.destinationB, capacityBytes: 70_000 },
  ], { id: "spill", chunkSize: 64 * 1024 });
  assert.deepEqual(job.files.map((file) => file.destinationId), ["a", "b", "a"]);
  const report = await engine.run(job.id);
  assert.equal(report.recovered, 3);
  assert.equal(report.missing, 0);
  assert.equal(report.checksumManifest.length, 3);
  assert.match(engine.getChecksumManifest(job.id, { format: "sha256sum" }), /^[a-f0-9]{64}  /u);
  for (const file of report.files) assert.deepEqual(await fs.readFile(file.destinationPath), await fs.readFile(file.sourcePath));
});

test("process-style restart resumes without recopying verified bytes and never mutates source", async (t) => {
  const paths = await setup(t);
  const sourcePath = path.join(paths.source, "critical.bin");
  await fs.writeFile(sourcePath, Buffer.alloc(320 * 1024, 0x5a));
  const sourceBefore = await fs.stat(sourcePath);
  const stateDir = path.join(paths.base, "state");
  let engine = createSalvageEngine({ stateDir });
  await engine.init();
  const inventory = await engine.inventory(paths.source, { explicitPaths: ["critical.bin"] });
  await engine.buildPlan(inventory, [{ path: paths.destinationA, capacityBytes: 400 * 1024 }], { id: "restart", chunkSize: 64 * 1024 });
  const controller = new AbortController();
  await assert.rejects(engine.run("restart", {
    signal: controller.signal,
    onProgress(progress) {
      if (progress.offset >= 64 * 1024) controller.abort();
    },
  }), { name: "AbortError" });
  const checkpoint = engine.getJob("restart").files[0];
  assert.equal(checkpoint.offset, 64 * 1024);
  await engine.close();

  engine = createSalvageEngine({ stateDir });
  await engine.init();
  t.after(() => engine.close());
  const offsets = [];
  const report = await engine.resume("restart", { onProgress: (progress) => offsets.push(progress.offset) });
  assert.equal(report.recovered, 1);
  assert.ok(offsets[0] > 64 * 1024, "resume should continue after the durable checkpoint");
  assert.deepEqual(await fs.readFile(report.files[0].destinationPath), await fs.readFile(sourcePath));
  const sourceAfter = await fs.stat(sourcePath);
  assert.equal(sourceAfter.size, sourceBefore.size);
  assert.equal(sourceAfter.mtimeMs, sourceBefore.mtimeMs);
});

test("read faults produce exact partial/corrupt outcomes while later priorities continue", async (t) => {
  const paths = await setup(t);
  const damaged = path.join(paths.source, "damaged.bin");
  const healthy = path.join(paths.source, "healthy.bin");
  await fs.writeFile(damaged, Buffer.alloc(192 * 1024, 0x64));
  await fs.writeFile(healthy, Buffer.alloc(64 * 1024, 0x68));
  const engine = createSalvageEngine({ stateDir: path.join(paths.base, "state") });
  await engine.init();
  t.after(() => engine.close());
  const inventory = await engine.inventory(paths.source, { explicitPaths: ["damaged.bin", "healthy.bin"] });
  await engine.buildPlan(inventory, [{ path: paths.destinationA, capacityBytes: 512 * 1024 }], { id: "faults", chunkSize: 64 * 1024, retries: 2 });
  const report = await engine.run("faults", {
    async readChunk(sourcePath, offset, length) {
      if (sourcePath === damaged && offset >= 64 * 1024) throw Object.assign(new Error("injected unreadable sector"), { code: "EIO" });
      const handle = await fs.open(sourcePath, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  });
  assert.equal(report.partial, 1);
  assert.equal(report.recovered, 1);
  assert.equal(report.readErrors.length, 3);
  const damagedReport = report.files.find((file) => file.path === "damaged.bin");
  assert.equal(damagedReport.status, "partial");
  assert.equal(damagedReport.offset, 64 * 1024);
  assert.equal(damagedReport.error.code, "EIO");
});

test("verified duplicate content uses one destination allocation and previews stay bounded", async (t) => {
  const paths = await setup(t);
  const content = Buffer.alloc(128 * 1024, 0x77);
  await fs.writeFile(path.join(paths.source, "copy-a.bin"), content);
  await fs.writeFile(path.join(paths.source, "copy-b.bin"), content);
  const engine = createSalvageEngine({ stateDir: path.join(paths.base, "state") });
  await engine.init();
  t.after(() => engine.close());
  const inventory = await engine.inventory(paths.source);
  await engine.buildPlan(inventory, [{ path: paths.destinationA, capacityBytes: 300 * 1024 }], { id: "dedup", chunkSize: 64 * 1024, deduplicate: true });
  const report = await engine.recover("dedup");
  assert.equal(report.recovered, 2);
  assert.equal(report.deduplicatedBytes, content.length);
  if (process.platform !== "win32") {
    const [first, second] = await Promise.all(report.files.map((file) => fs.stat(file.destinationPath)));
    assert.equal(first.ino, second.ino);
  }
  const preview = await engine.preview(path.join(paths.source, "copy-a.bin"), { maxBytes: 1024 });
  const chunks = [];
  for await (const chunk of preview.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).length, 1024);
  assert.equal(preview.metadata.truncated, true);
});

test("ddrescue mapfile hints are parsed without becoming a salvage dependency", () => {
  const map = createSalvageEngine().parseDdrescueMapfile(`\n# current_pos current_status\n0x00000000 0x00001000 +\n0x00001000 0x00000200 -\n0x00001200 0x00000100 ?\n`);
  assert.equal(map.readableBytes, 4096);
  assert.equal(map.badBytes, 512);
  assert.equal(map.pendingBytes, 256);
});
