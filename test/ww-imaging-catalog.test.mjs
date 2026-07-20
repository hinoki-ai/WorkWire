import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createImagingCatalog,
  getImagingCapabilities,
  WW_IMAGING_VERSION,
} from "../lib/imaging/index.mjs";

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ww-imaging-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source.img");
  const handle = await fs.open(source, "w");
  await handle.write(Buffer.alloc(64 * 1024, 0x41), 0, 64 * 1024, 64 * 1024);
  await handle.write(Buffer.alloc(64 * 1024, 0x42), 0, 64 * 1024, 256 * 1024);
  await handle.truncate(512 * 1024);
  await handle.close();
  return { base, source };
}

test("sparse capture resumes, catalogs full metadata, restores, and verifies", async (t) => {
  const { base, source } = await fixture(t);
  const storagePath = path.join(base, "catalog");
  let catalog = createImagingCatalog({ storagePath });
  await catalog.init();
  const controller = new AbortController();
  await assert.rejects(catalog.captureImage(source, {
    id: "sparse-image",
    chunkSize: 64 * 1024,
    compression: "gzip",
    sourceMachine: { id: "machine-a", serial: "M-A" },
    diskIdentity: { serial: "DISK-1", model: "Generated" },
    geometry: { logicalSectorSize: 512, physicalSectorSize: 4096, logicalSize: 512 * 1024 },
    partitionTable: { type: "gpt", partitions: [{ start: 2048, size: 4096 }] },
    filesystems: [{ type: "ext4", label: "root" }],
    bootMode: "uefi",
    labels: ["golden", "lab"],
    onProgress(progress) {
      if (progress.chunk === 1) controller.abort();
    },
    signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(catalog.getStats().activeCaptures, 1);
  await catalog.close();

  catalog = createImagingCatalog({ storagePath });
  await catalog.init();
  t.after(() => catalog.close());
  const image = await catalog.captureImage(source, {
    id: "sparse-image",
    chunkSize: 64 * 1024,
    compression: "gzip",
    sourceMachine: { id: "machine-a", serial: "M-A" },
    diskIdentity: { serial: "DISK-1", model: "Generated" },
    geometry: { logicalSectorSize: 512, physicalSectorSize: 4096, logicalSize: 512 * 1024 },
    partitionTable: { type: "gpt", partitions: [{ start: 2048, size: 4096 }] },
    filesystems: [{ type: "ext4", label: "root" }],
    bootMode: "uefi",
    labels: ["golden", "lab"],
  });
  assert.equal(image.sourceMachine.id, "machine-a");
  assert.equal(image.diskIdentity.serial, "DISK-1");
  assert.equal(image.partitionTable.type, "gpt");
  assert.equal(image.filesystems[0].type, "ext4");
  assert.equal(image.bootMode, "uefi");
  assert.equal(image.chunks.length, 8);
  assert.ok(image.chunks.filter((chunk) => chunk.zero).length >= 5);
  assert.ok(image.storedSize < image.logicalSize);
  assert.equal((await catalog.verifyImage(image.id)).verified, true);

  const target = path.join(base, "restored.img");
  const restoreController = new AbortController();
  await assert.rejects(catalog.restoreImage(image.id, target, {
    signal: restoreController.signal,
    onProgress(progress) {
      if (progress.chunk === 1) restoreController.abort();
    },
  }), { name: "AbortError" });
  await catalog.close();
  catalog = createImagingCatalog({ storagePath });
  await catalog.init();
  const report = await catalog.restoreImage(image.id, target, { verify: "full" });
  assert.equal(report.verified, true);
  assert.deepEqual(await fs.readFile(target), await fs.readFile(source));
  if (process.platform !== "win32") {
    const restoredStats = await fs.stat(target);
    assert.ok(restoredStats.blocks * 512 < restoredStats.size, "zero chunks should remain sparse");
  }
  assert.equal(getImagingCapabilities().version, WW_IMAGING_VERSION);
});

test("catalog export/import, clone, rename, search, pin, inspect, and explicit delete", async (t) => {
  const { base, source } = await fixture(t);
  const first = createImagingCatalog({
    storagePath: path.join(base, "first"),
    executor: {
      async inspectImage() {
        return { tools: ["fake-partition-inspector"], compatibility: { architecture: "x86_64" } };
      },
    },
  });
  await first.init();
  t.after(() => first.close());
  await first.capture(source, { id: "original", label: "Golden workstation", labels: ["golden"], chunkSize: 64 * 1024 });
  await first.pinImage("original", true);
  await assert.rejects(first.deleteImage("original"), { code: "ERR_WW_IMAGE_PINNED" });
  await first.renameImage("original", "Renamed golden");
  const cloned = await first.cloneImage("original", { id: "clone", label: "Field clone" });
  assert.equal(cloned.clonedFrom, "original");
  assert.equal(first.search("field")[0].id, "clone");
  const inspection = await first.inspectImage("original");
  assert.deepEqual(inspection.compatibility.nativeToolsUsed, ["fake-partition-inspector"]);
  assert.equal(inspection.compatibility.architecture, "x86_64");

  const exported = path.join(base, "exported");
  const exportResult = await first.exportImage("original", exported);
  assert.ok(exportResult.objectCount > 0);
  const second = createImagingCatalog({ storagePath: path.join(base, "second") });
  await second.init();
  t.after(() => second.close());
  const imported = await second.importImage(exported, { id: "imported" });
  assert.equal(imported.id, "imported");
  assert.equal((await second.verify("imported")).verified, true);
  assert.equal(await first.deleteImage("clone"), true);
  assert.equal(first.getImage("clone"), null);
});

test("missing local image chunks are seeded by a verified LAN peer", async (t) => {
  const { base, source } = await fixture(t);
  const firstPath = path.join(base, "seed");
  const secondPath = path.join(base, "receiver");
  const exported = path.join(base, "bundle");
  const first = createImagingCatalog({ storagePath: firstPath });
  const second = createImagingCatalog({ storagePath: secondPath });
  await first.init();
  await second.init();
  t.after(() => first.close());
  t.after(() => second.close());
  const image = await first.capture(source, { id: "seed-image", chunkSize: 64 * 1024 });
  await first.exportImage(image.id, exported);
  const imported = await second.importImage(exported);
  for (const chunk of imported.chunks.filter((candidate) => candidate.objectId)) {
    await fs.rm(path.join(secondPath, "objects", chunk.objectId.slice(0, 2), chunk.objectId));
  }
  await second.addPeer({ id: "seed", catalog: first });
  assert.equal((await second.verifyImage(imported.id)).verified, true);
  const seeded = second.getStats();
  assert.ok(seeded.uniqueStoredBytes > 0);
});
