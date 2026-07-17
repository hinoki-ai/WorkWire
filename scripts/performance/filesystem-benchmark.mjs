import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listDirectory } from "../../lib/ww-fs.mjs";
import {
  emitResult,
  environmentRecord,
  listArg,
  mapWithConcurrency,
  measureSamples,
  numberArg,
  parseArgs,
} from "./common.mjs";

const args = parseArgs();
const sizes = listArg(args.sizes, [100, 1_000, 10_000, 50_000]);
const repeats = numberArg(args.repeats, 5, { min: 2, max: 20 });
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-perf-list-"));
let created = 0;
const results = [];

function entryName(index) {
  const prefix = index % 17 === 0 ? "résumé 長い directory name" : "quarterly-report";
  return `${prefix}-${String(index).padStart(6, "0")}${index % 19 === 0 ? "" : ".dat"}`;
}

try {
  for (const size of sizes) {
    const indexes = Array.from({ length: Math.max(0, size - created) }, (_, offset) => created + offset);
    await mapWithConcurrency(indexes, 64, async (index) => {
      const target = path.join(root, entryName(index));
      if (index % 19 === 0) {
        await fs.mkdir(target);
      } else {
        const handle = await fs.open(target, "wx");
        await handle.close();
      }
    });
    created = size;

    globalThis.gc?.();
    const coldStartedAt = process.hrtime.bigint();
    const coldListing = await listDirectory(root, { includeHidden: true, rootPath: root, protectedBasenames: [] });
    const coldMs = Number(process.hrtime.bigint() - coldStartedAt) / 1e6;
    const warm = await measureSamples(async () => {
      const listing = await listDirectory(root, { includeHidden: true, rootPath: root, protectedBasenames: [] });
      if (listing.items.length !== size) {
        throw new Error(`Expected ${size} entries, received ${listing.items.length}.`);
      }
      return listing.items.length;
    }, { repeats, warmups: 1, sampleMemoryEveryMs: 5 });
    results.push({
      entryCount: size,
      coldDurationMs: Number(coldMs.toFixed(3)),
      coldCount: coldListing.items.length,
      warm,
    });
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

await emitResult({
  benchmark: "filesystem-directory-listing",
  implementation: "real ext4/tmp filesystem entries through lib/ww-fs.mjs listDirectory",
  conditions: { sizes, repeats, preparationConcurrency: 64, cacheState: "cold first read followed by warm repetitions" },
  environment: environmentRecord(),
  results,
}, { output: String(args.output || "") });
