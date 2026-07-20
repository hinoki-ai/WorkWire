import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createImagingCatalog } from "../../lib/imaging/index.mjs";

const MiB = 1024 * 1024;
const base = await fs.mkdtemp(path.join(os.tmpdir(), "ww-imaging-benchmark-"));
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function throughput(bytes, milliseconds) {
  return Number((bytes / MiB / (milliseconds / 1000)).toFixed(2));
}

const results = { benchmark: "imaging-powerhouse", at: new Date().toISOString() };
let catalog;
try {
  const source = path.join(base, "sparse.img");
  const logicalBytes = 64 * MiB;
  const handle = await fs.open(source, "w");
  const data = Buffer.alloc(4 * MiB, 0x5c);
  await handle.write(data, 0, data.length, 4 * MiB);
  await handle.write(data, 0, data.length, 40 * MiB);
  await handle.truncate(logicalBytes);
  await handle.close();
  catalog = createImagingCatalog({ storagePath: path.join(base, "catalog") });
  await catalog.init();
  let started = process.hrtime.bigint();
  const image = await catalog.captureImage(source, { id: "bench-image", chunkSize: 4 * MiB, compression: "gzip" });
  const captureMs = elapsedMs(started);
  const firstStats = catalog.getStats();
  results.capture = {
    logicalBytes,
    storedBytes: image.storedSize,
    sparseBytesAvoided: logicalBytes - image.storedSize,
    milliseconds: Number(captureMs.toFixed(2)),
    logicalThroughputMiBPerSecond: throughput(logicalBytes, captureMs),
  };

  started = process.hrtime.bigint();
  await catalog.captureImage(source, { id: "bench-image-duplicate", chunkSize: 4 * MiB, compression: "gzip" });
  const duplicateMs = elapsedMs(started);
  const secondStats = catalog.getStats();
  results.deduplication = {
    secondLogicalBytes: logicalBytes,
    additionalUniqueStoredBytes: secondStats.uniqueStoredBytes - firstStats.uniqueStoredBytes,
    dedupBenefitBytes: logicalBytes - (secondStats.uniqueStoredBytes - firstStats.uniqueStoredBytes),
    milliseconds: Number(duplicateMs.toFixed(2)),
  };

  const target = path.join(base, "restored.img");
  started = process.hrtime.bigint();
  const restore = await catalog.restoreImage(image.id, target, { verify: "full" });
  const restoreMs = elapsedMs(started);
  results.restore = { logicalBytes, milliseconds: Number(restoreMs.toFixed(2)), throughputMiBPerSecond: throughput(logicalBytes, restoreMs), verified: restore.verified };
} finally {
  clearInterval(sampler);
  await catalog?.close().catch(() => {});
  results.memory = { peakRssBytes: peakRss, peakRssMiB: Number((peakRss / MiB).toFixed(2)) };
  await fs.rm(base, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
