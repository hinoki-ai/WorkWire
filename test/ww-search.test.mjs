import assert from "node:assert/strict";
import test from "node:test";
import {
  createSearchIndex,
  createSearchIndexAsync,
  normalizeSearch,
  rankSearchIndex,
  rankSearchIndexAsync,
} from "../desktop/ww/search.js";

function entry(name, kind = "file", prefix = "/portal") {
  return {
    name,
    kind,
    path: `${prefix}/${name}`,
    size: 0,
    mtimeMs: 0,
  };
}

test("ww search precomputes accent-insensitive names and paths", () => {
  const entries = [
    entry("Résumé Final.txt"),
    entry("report.txt", "file", "/portal/Project Alpha"),
  ];
  const index = createSearchIndex(entries);
  assert.equal(normalizeSearch("  RÉSUMÉ---Final  "), "resume final");
  assert.deepEqual(
    rankSearchIndex(index, "resume", 10).map((result) => result.entry.name),
    ["Résumé Final.txt"],
  );
  assert.deepEqual(
    rankSearchIndex(index, "project alpha", 10).map((result) => result.entry.name),
    ["report.txt"],
  );
});

test("ww search keeps exact, prefix, word-prefix, substring, path, and fuzzy ranking stable", () => {
  const entries = [
    entry("report"),
    entry("report final.txt"),
    entry("annual report.txt"),
    entry("old-report-copy.txt"),
    entry("notes.txt", "file", "/portal/report archive"),
    entry("repose.txt"),
  ];
  const index = createSearchIndex(entries);
  assert.deepEqual(
    rankSearchIndex(index, "report").map((result) => result.entry.name),
    ["report", "report final.txt", "annual report.txt", "old-report-copy.txt", "notes.txt", "repose.txt"],
  );
  assert.equal(rankSearchIndex(index, "reprot", 10)[0].entry.name, "report");
  assert.deepEqual(
    rankSearchIndex(index, "report", 2).map((result) => result.entry.name),
    ["report", "report final.txt"],
  );
});

test("ww search gives folders precedence only for otherwise equivalent relevance", () => {
  const entries = [
    entry("alpha", "file"),
    entry("alpha", "directory", "/other"),
    entry("alphabet", "directory"),
  ];
  const results = rankSearchIndex(createSearchIndex(entries), "alpha");
  assert.equal(results[0].entry.kind, "directory");
  assert.equal(results[0].entry.name, "alpha");
  assert.equal(results[1].entry.name, "alpha");
  assert.equal(results[2].entry.name, "alphabet");
});

test("ww search does not flood short queries with unrelated fuzzy matches", () => {
  const entries = [entry("xylophone.txt"), entry("report.txt"), entry("archive.txt")];
  const index = createSearchIndex(entries);
  assert.deepEqual(rankSearchIndex(index, "q", 10), []);
  assert.deepEqual(rankSearchIndex(index, "totally unrelated", 10), []);
});

test("ww asynchronous search preserves ranking and abandons stale generations", async () => {
  const entries = Array.from({ length: 5_000 }, (_, index) => (
    entry(index % 7 === 0 ? `report ${index}.txt` : `archive ${index}.txt`)
  ));
  const index = createSearchIndex(entries);
  const expected = rankSearchIndex(index, "report").map((result) => result.entry.path);
  let yields = 0;
  const actual = await rankSearchIndexAsync(index, "report", {
    batchSize: 250,
    runSize: 512,
    yieldTask: async () => { yields += 1; },
  });
  assert.deepEqual(actual.map((result) => result.entry.path), expected);
  assert.ok(yields > 1);

  let current = true;
  const stale = await rankSearchIndexAsync(index, "archive", {
    batchSize: 250,
    shouldContinue: () => current,
    yieldTask: async () => { current = false; },
  });
  assert.equal(stale, null);
});

test("ww asynchronous indexing normalizes once and releases stale listings", async () => {
  const entries = Array.from({ length: 2_500 }, (_, index) => entry(`Résumé ${index}.txt`));
  const index = await createSearchIndexAsync(entries, {
    batchSize: 200,
    yieldTask: async () => {},
  });
  assert.equal(index.records.length, entries.length);
  assert.equal(index.records[0].normalizedName, "resume 0 txt");
  assert.equal(index.byPath.get(entries.at(-1).path), entries.at(-1));

  let current = true;
  const stale = await createSearchIndexAsync(entries, {
    batchSize: 200,
    shouldContinue: () => current,
    yieldTask: async () => { current = false; },
  });
  assert.equal(stale, null);
});

test("ww 10,000-entry search has a generous catastrophic-regression guard", () => {
  const entries = Array.from({ length: 10_000 }, (_, index) => (
    entry(index % 11 === 0 ? `Quarterly résumé report ${index}.txt` : `Archive record ${index}.txt`)
  ));
  const startedAt = process.hrtime.bigint();
  const index = createSearchIndex(entries);
  for (const query of ["r", "quarterly report", "resume", "reprot"]) {
    assert.ok(rankSearchIndex(index, query, 10).length <= 10);
  }
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(durationMs < 2_000, `10,000-entry search took ${durationMs.toFixed(1)} ms`);
});
