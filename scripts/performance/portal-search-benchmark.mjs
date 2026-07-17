import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import {
  emitResult,
  environmentRecord,
  listArg,
  measureSamples,
  numberArg,
  parseArgs,
} from "./common.mjs";

const args = parseArgs();
const sizes = listArg(args.sizes, [100, 1_000, 10_000, 50_000]);
const renderSizes = new Set(listArg(args["render-sizes"], [100, 1_000]));
const repeats = numberArg(args.repeats, 5, { min: 2, max: 30 });
const maxSize = Math.max(...sizes, 0);

function makeEntry(index) {
  const directory = index % 9 === 0;
  const category = index % 5 === 0 ? "Project Alpha" : "Quarterly Report";
  const special = index % 97 === 0 ? "résumé" : "records";
  const rare = index === maxSize - 1 ? " needle-exact-final" : "";
  const name = `${directory ? "Folder" : "File"} ${category} ${special} ${String(index).padStart(6, "0")}${rare}${index % 113 === 0 ? " — 長い Unicode filename with spaces" : ""}${directory ? "" : ".txt"}`;
  return {
    path: `/portal/deep/path/${Math.floor(index / 1_000)}/${name}`,
    name,
    kind: directory ? "directory" : "file",
    size: directory ? 0 : (index * 7919) % 50_000_000,
    mtimeMs: 1_700_000_000_000 + index,
  };
}

function emptySnapshot() {
  const listing = (side) => ({
    path: `/portal/${side}`,
    parentPath: null,
    rootPath: `/portal/${side}`,
    items: [],
  });
  return {
    service: { info: {}, error: null },
    peer: { saved: {}, recent: [], info: {}, connected: true, error: null },
    panes: {
      local: { path: "/portal/local", listing: listing("local"), error: null },
      remote: { path: "/portal/remote", listing: listing("remote"), error: null },
    },
    explorer: { open: false, listing: null, path: "", error: null },
    ui: { showHidden: false, conflictPolicy: "rename" },
    operation: { active: false, stage: "idle" },
    notifications: [],
    activity: [],
    app: { windows: { main: true } },
  };
}

const htmlPath = path.resolve("desktop/ww/index.html");
const html = await fs.readFile(htmlPath, "utf8");
const dom = new JSDOM(html, {
  url: pathToFileURL(htmlPath).href,
  pretendToBeVisual: true,
  runScripts: "outside-only",
});

const previousGlobals = {};
for (const key of ["window", "document", "HTMLElement", "Node", "Event", "KeyboardEvent", "MouseEvent"]) {
  previousGlobals[key] = globalThis[key];
  globalThis[key] = dom.window[key];
}

dom.window.wwApi = {
  diagnosticsEnabled: true,
  getState: async () => emptySnapshot(),
  onEvent: () => () => {},
};

const rendererUrl = `${pathToFileURL(path.resolve("desktop/ww/renderer.js")).href}?perf=${Date.now()}`;
await import(rendererUrl);
const diagnostics = dom.window.__wwPerformance;
if (!diagnostics) {
  throw new Error("Renderer performance diagnostics were not installed.");
}

const allEntries = Array.from({ length: maxSize }, (_, index) => makeEntry(index));
const queries = [
  { name: "single-character", value: "r" },
  { name: "common", value: "quarterly report" },
  { name: "rare-exact", value: "needle-exact-final" },
  { name: "multi-token", value: "project alpha resume" },
  { name: "typo-tolerant", value: "reprot" },
];

const results = [];
for (const size of sizes) {
  const entries = allEntries.slice(0, size);
  let searchIndex = null;
  const indexBuild = typeof diagnostics.createSearchIndex === "function"
    ? await measureSamples(() => {
        searchIndex = diagnostics.createSearchIndex(entries);
        return searchIndex.records.length;
      }, { repeats, warmups: 1 })
    : null;
  const queryResults = [];
  for (const query of queries) {
    let matched = 0;
    const measurement = await measureSamples(() => {
      const ranked = searchIndex && typeof diagnostics.rankSearchIndex === "function"
        ? diagnostics.rankSearchIndex(searchIndex, query.value, 10)
        : diagnostics.rankSearchEntries(entries, query.value, 10);
      matched = ranked.length;
      return matched;
    }, { repeats, warmups: 1 });
    queryResults.push({
      query: query.name,
      value: query.value,
      matchedTopResults: matched,
      ...measurement,
    });
  }

  const rapidEdits = await measureSamples(() => {
    let checksum = 0;
    for (const query of ["r", "re", "rep", "repo", "repor", "report", "reprot", "report", ""]) {
      checksum += searchIndex && typeof diagnostics.rankSearchIndex === "function"
        ? diagnostics.rankSearchIndex(searchIndex, query, 10).length
        : diagnostics.rankSearchEntries(entries, query, 10).length;
    }
    return checksum;
  }, { repeats, warmups: 1 });

  let fullRender = null;
  if (renderSizes.has(size)) {
    const snapshot = emptySnapshot();
    snapshot.panes.local.listing.items = entries;
    snapshot.panes.remote.listing.items = entries.map((entry) => ({ ...entry, path: entry.path.replace("/portal/", "/remote/") }));
    fullRender = await measureSamples(() => {
      diagnostics.replaceSnapshot(snapshot);
      return {
        localRows: dom.window.document.querySelectorAll("#local-list .file-row").length,
        remoteRows: dom.window.document.querySelectorAll("#remote-list .file-row").length,
      };
    }, { repeats: Math.min(3, repeats), warmups: 0, sampleMemoryEveryMs: 10 });
  }

  results.push({
    entriesPerPane: size,
    indexBuild,
    queries: queryResults,
    rapidEdits,
    fullTwoPaneRender: fullRender,
  });
}

const result = {
  benchmark: "portal-search",
  implementation: "actual renderer ranking functions in jsdom; optional full two-pane DOM render",
  conditions: {
    repeats,
    sizes,
    renderSizes: [...renderSizes],
    dropdownLimit: 10,
    cacheState: "warm after one explicit warmup",
  },
  environment: environmentRecord(),
  results,
};

await emitResult(result, { output: String(args.output || "") });
dom.window.close();
for (const [key, value] of Object.entries(previousGlobals)) {
  if (value === undefined) delete globalThis[key];
  else globalThis[key] = value;
}
