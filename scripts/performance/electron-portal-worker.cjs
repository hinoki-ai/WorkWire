const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("enable-precise-memory-info");
app.commandLine.appendSwitch("js-flags", "--expose-gc");

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function summarize(samples) {
  const sorted = samples.filter(Number.isFinite).sort((left, right) => left - right);
  const quantile = (value) => {
    if (!sorted.length) return 0;
    const position = (sorted.length - 1) * value;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
  };
  const mean = sorted.reduce((total, value) => total + value, 0) / Math.max(1, sorted.length);
  return {
    samples: sorted.length,
    min: Number((sorted[0] || 0).toFixed(3)),
    median: Number(quantile(0.5).toFixed(3)),
    p95: Number(quantile(0.95).toFixed(3)),
    max: Number((sorted.at(-1) || 0).toFixed(3)),
    mean: Number(mean.toFixed(3)),
  };
}

function slope(samples, field) {
  if (samples.length < 2) return 0;
  const meanX = samples.reduce((total, sample) => total + sample.cycle, 0) / samples.length;
  const meanY = samples.reduce((total, sample) => total + sample[field], 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    numerator += (sample.cycle - meanX) * (sample[field] - meanY);
    denominator += (sample.cycle - meanX) ** 2;
  }
  return denominator ? numerator / denominator : 0;
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
      local: { path: "/portal/local", listing: listing("local"), error: null, loading: false },
      remote: { path: "/portal/remote", listing: listing("remote"), error: null, loading: false },
    },
    explorer: { open: false, listing: null, path: "", error: null },
    ui: { showHidden: false, conflictPolicy: "rename" },
    operation: { active: false, stage: "idle" },
    notifications: [],
    activity: [],
    app: { windows: { main: true } },
  };
}

function waitForLoad(window) {
  return new Promise((resolve, reject) => {
    window.webContents.once("did-finish-load", resolve);
    window.webContents.once("did-fail-load", (_event, code, description) => {
      reject(new Error(`Renderer load failed (${code}): ${description}`));
    });
  });
}

async function evaluate(window, source) {
  return window.webContents.executeJavaScript(source, true);
}

async function waitFor(window, expression, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(window, expression)) return Date.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for renderer condition: ${expression}`);
}

async function run() {
  const sizes = String(argValue("sizes", "100,1000,10000,50000"))
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const repeats = Math.max(2, Number(argValue("repeats", "5")) || 5);
  const reloads = Math.max(0, Number(argValue("reloads", "5")) || 0);
  const soakCycles = Math.max(0, Number(argValue("soak-cycles", "10")) || 0);
  const soakEntries = Math.max(100, Number(argValue("soak-entries", "10000")) || 10_000);
  const queriesPerCycle = Math.max(1, Number(argValue("queries-per-cycle", "50")) || 50);
  const ipcMessages = Math.max(10, Number(argValue("ipc-messages", "1000")) || 1_000);

  ipcMain.handle("ww:get-state", () => emptySnapshot());
  const window = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: 1440,
    height: 980,
    webPreferences: {
      preload: path.resolve("desktop/ww-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  await Promise.all([
    waitForLoad(window),
    window.loadFile(path.resolve("desktop/ww/index.html")),
  ]);
  await waitFor(window, "Boolean(window.__wwPerformance)");
  await evaluate(window, `
    window.__wwLongTasks = [];
    if (typeof PerformanceObserver === "function") {
      window.__wwLongTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__wwLongTasks.push(entry.duration);
      });
      try { window.__wwLongTaskObserver.observe({ type: "longtask", buffered: true }); } catch {}
    }
    true;
  `);

  const results = [];
  const allLongTasks = [];
  let generation = 0;
  for (const size of sizes) {
    await evaluate(window, "window.__wwLongTasks = []; true");
    const constructionMs = [];
    const renderMs = [];
    const indexReadyMs = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      generation += 1;
      const snapshotResult = await evaluate(
        window,
        `window.__wwPerformance.replaceSyntheticSnapshot(${size}, ${generation})`,
      );
      constructionMs.push(snapshotResult.constructionDurationMs);
      renderMs.push(snapshotResult.renderDurationMs);
      indexReadyMs.push(await waitFor(
        window,
        "!window.__wwPerformance.searchStatus('local').indexing && !window.__wwPerformance.searchStatus('remote').indexing && window.__wwPerformance.comparisonStatus().ready",
        20_000,
      ));
    }

    const queryResults = [];
    for (const [name, query] of [
      ["single-character", "r"],
      ["common", "quarterly report"],
      ["rare-exact", "needle-exact-final"],
      ["multi-token", "project alpha resume"],
      ["typo-tolerant", "reprot"],
    ]) {
      const samples = [];
      let visibleResults = 0;
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const sample = await evaluate(window, `(async () => {
          const input = document.getElementById("local-filter");
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await Promise.resolve();
          input.value = ${JSON.stringify(query)};
          const startedAt = performance.now();
          input.dispatchEvent(new Event("input", { bubbles: true }));
          document.getElementById("local-search-results").getBoundingClientRect();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return {
            durationMs: performance.now() - startedAt,
            visibleResults: document.querySelectorAll("#local-search-results .search-result").length,
          };
        })()`);
        samples.push(sample.durationMs);
        visibleResults = sample.visibleResults;
      }
      queryResults.push({ name, query, latencyMs: summarize(samples), visibleResults });
    }

    const rapidEditSamples = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      rapidEditSamples.push(await evaluate(window, `(async () => {
        const input = document.getElementById("local-filter");
        const startedAt = performance.now();
        for (const query of ["r", "re", "rep", "repo", "repor", "report", "reprot", "report"]) {
          input.value = query;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        document.getElementById("local-search-results").getBoundingClientRect();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return performance.now() - startedAt;
      })()`));
      await waitFor(window, "window.__wwPerformance.searchStatus('local').query === 'report' && !window.__wwPerformance.searchStatus('local').indexing");
    }

    const keyboardSamples = await evaluate(window, `(() => {
      const input = document.getElementById("local-filter");
      const samples = [];
      for (let index = 0; index < 100; index += 1) {
        const startedAt = performance.now();
        input.dispatchEvent(new KeyboardEvent(index % 2 ? "keydown" : "keydown", {
          key: index % 2 ? "ArrowUp" : "ArrowDown",
          bubbles: true,
          cancelable: true,
        }));
        samples.push(performance.now() - startedAt);
      }
      return samples;
    })()`);

    const workspaceSwitchSamples = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      workspaceSwitchSamples.push(await evaluate(window, `(async () => {
        const pane = document.getElementById(${repeat % 2 ? '"local-pane"' : '"remote-pane"'});
        const startedAt = performance.now();
        pane.click();
        pane.getBoundingClientRect();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return performance.now() - startedAt;
      })()`));
    }

    const heap = await evaluate(window, `({
      usedBytes: performance.memory?.usedJSHeapSize || 0,
      totalBytes: performance.memory?.totalJSHeapSize || 0,
      localRows: document.querySelectorAll("#local-list .file-row").length,
      remoteRows: document.querySelectorAll("#remote-list .file-row").length,
      query: window.__wwPerformance.searchStatus("local").query,
    })`);
    const sizeLongTasks = await evaluate(window, "window.__wwLongTasks || []");
    allLongTasks.push(...sizeLongTasks);
    results.push({
      entriesPerPane: size,
      constructionMs: summarize(constructionMs),
      initialRenderMs: summarize(renderMs),
      asynchronousIndexReadyMs: summarize(indexReadyMs),
      queries: queryResults,
      rapidEditsMs: summarize(rapidEditSamples),
      keyboardNavigationHandlerMs: summarize(keyboardSamples),
      workspaceSwitchMs: summarize(workspaceSwitchSamples),
      rendererHeap: heap,
      longTasks: {
        count: sizeLongTasks.length,
        durationMs: summarize(sizeLongTasks),
      },
    });
  }

  const fullSnapshotBytes = await evaluate(window, `
    new TextEncoder().encode(JSON.stringify(window.__wwPerformance.snapshot())).byteLength
  `);
  const ipcTemplate = {
    type: "operation",
    payload: {},
    partial: true,
    state: {
      operation: {
        active: true,
        stage: "transfer-progress",
        label: "IPC 0",
        totals: { files: 1, bytes: 1_000_000 },
        transferredFiles: 0,
        transferredBytes: 500_000,
        skippedFiles: 0,
        error: null,
      },
      notifications: [],
      activity: [],
    },
  };
  const operationPayloadBytes = Buffer.byteLength(JSON.stringify(ipcTemplate));
  const ipcStartedAt = performance.now();
  for (let index = 0; index < ipcMessages; index += 1) {
    const event = structuredClone(ipcTemplate);
    event.state.operation.label = `IPC ${index}`;
    window.webContents.send("ww:event", event);
  }
  const ipcSendDurationMs = performance.now() - ipcStartedAt;
  await waitFor(
    window,
    `document.getElementById("operation-label").textContent === "IPC ${ipcMessages - 1}"`,
    30_000,
  );
  const ipcEndToEndDurationMs = performance.now() - ipcStartedAt;
  const ipcBurst = {
    messages: ipcMessages,
    operationPayloadBytes,
    fullSnapshotBytes,
    fullToIncrementalSizeRatio: Number((fullSnapshotBytes / operationPayloadBytes).toFixed(3)),
    mainSendDurationMs: Number(ipcSendDurationMs.toFixed(3)),
    endToEndDurationMs: Number(ipcEndToEndDurationMs.toFixed(3)),
    messagesPerSecond: Number((ipcMessages / (ipcEndToEndDurationMs / 1_000)).toFixed(3)),
  };

  await evaluate(window, "window.__wwLongTasks = []; true");
  const soakSamples = [];
  let soakGeneration = 100_000;
  for (let cycle = 0; cycle < soakCycles; cycle += 1) {
    soakGeneration += 1;
    await evaluate(window, `window.__wwPerformance.replaceSyntheticSnapshot(${soakEntries}, ${soakGeneration})`);
    await waitFor(
      window,
      "!window.__wwPerformance.searchStatus('local').indexing && !window.__wwPerformance.searchStatus('remote').indexing && window.__wwPerformance.comparisonStatus().ready",
      30_000,
    );
    await evaluate(window, `(async () => {
      const input = document.getElementById("local-filter");
      const queries = ["r", "re", "report", "reprot", "résumé", "project alpha", "needle-exact-final", ""];
      for (let index = 0; index < ${queriesPerCycle}; index += 1) {
        input.value = queries[index % queries.length];
        input.dispatchEvent(new Event("input", { bubbles: true }));
        if (index % 10 === 9) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      input.dispatchEvent(new Event("focus", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      document.getElementById(${cycle % 2 ? '"local-pane"' : '"remote-pane"'}).click();
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      globalThis.gc?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return true;
    })()`);
    const rendererMemory = await evaluate(window, `({
      usedHeapBytes: performance.memory?.usedJSHeapSize || 0,
      totalHeapBytes: performance.memory?.totalJSHeapSize || 0,
      rows: document.querySelectorAll(".file-row").length,
    })`);
    const tabMetric = app.getAppMetrics().find((metric) => metric.type === "Tab");
    soakSamples.push({
      cycle,
      ...rendererMemory,
      workingSetKiB: tabMetric?.memory?.workingSetSize || 0,
    });
  }
  const soakLongTasks = await evaluate(window, "window.__wwLongTasks || []");
  const plateauSamples = soakSamples.slice(Math.floor(soakSamples.length / 3));
  const soak = {
    cycles: soakCycles,
    entriesPerPane: soakEntries,
    searchQueries: soakCycles * queriesPerCycle,
    samples: soakSamples,
    plateau: {
      usedHeapSlopeBytesPerCycle: Number(slope(plateauSamples, "usedHeapBytes").toFixed(3)),
      workingSetSlopeKiBPerCycle: Number(slope(plateauSamples, "workingSetKiB").toFixed(3)),
      usedHeapChangeBytes: (plateauSamples.at(-1)?.usedHeapBytes || 0) - (plateauSamples[0]?.usedHeapBytes || 0),
      workingSetChangeKiB: (plateauSamples.at(-1)?.workingSetKiB || 0) - (plateauSamples[0]?.workingSetKiB || 0),
    },
    longTasks: { count: soakLongTasks.length, durationMs: summarize(soakLongTasks) },
  };

  await evaluate(window, `
    window.__wwPerformance.replaceSyntheticSnapshot(0, ${soakGeneration + 1});
    globalThis.gc?.();
    true;
  `);
  await new Promise((resolve) => setTimeout(resolve, 100));

  await evaluate(window, "globalThis.gc?.(); true");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const beforeReloadHeap = await evaluate(window, `({
    usedHeapBytes: performance.memory?.usedJSHeapSize || 0,
    totalHeapBytes: performance.memory?.totalJSHeapSize || 0,
  })`);
  const beforeReloadMetrics = app.getAppMetrics().map((metric) => ({
    type: metric.type,
    pid: metric.pid,
    memoryWorkingSetKiB: metric.memory?.workingSetSize || 0,
  }));
  const reloadSamples = [];
  for (let reload = 0; reload < reloads; reload += 1) {
    const loaded = waitForLoad(window);
    window.reload();
    await loaded;
    await waitFor(window, "Boolean(window.__wwPerformance)");
    await evaluate(window, "globalThis.gc?.(); true");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const heap = await evaluate(window, `({
      usedHeapBytes: performance.memory?.usedJSHeapSize || 0,
      totalHeapBytes: performance.memory?.totalJSHeapSize || 0,
    })`);
    const tabMetric = app.getAppMetrics().find((metric) => metric.type === "Tab");
    reloadSamples.push({
      reload: reload + 1,
      ...heap,
      workingSetKiB: tabMetric?.memory?.workingSetSize || 0,
    });
  }
  const afterReloadMetrics = app.getAppMetrics().map((metric) => ({
    type: metric.type,
    pid: metric.pid,
    memoryWorkingSetKiB: metric.memory?.workingSetSize || 0,
  }));
  const reloadPlateauSamples = reloadSamples.slice(Math.floor(reloadSamples.length / 2));
  window.destroy();
  ipcMain.removeHandler("ww:get-state");

  return {
    benchmark: "electron-portal-interaction",
    conditions: {
      sizes,
      repeats,
      reloads,
      soakCycles,
      soakEntries,
      queriesPerCycle,
      ipcMessages,
      window: "hidden 1440x980 Chromium renderer, background throttling disabled",
      syntheticData: "renderer-local construction to exclude IPC payload generation",
    },
    versions: process.versions,
    results,
    ipcBurst,
    soak,
    longTasks: {
      count: allLongTasks.length,
      durationMs: summarize(allLongTasks),
    },
    reloadLifecycle: {
      beforeReloadHeap,
      beforeReloadMetrics,
      samples: reloadSamples,
      plateau: {
        usedHeapSlopeBytesPerReload: Number(slope(
          reloadPlateauSamples.map((sample) => ({ ...sample, cycle: sample.reload })),
          "usedHeapBytes",
        ).toFixed(3)),
        workingSetSlopeKiBPerReload: Number(slope(
          reloadPlateauSamples.map((sample) => ({ ...sample, cycle: sample.reload })),
          "workingSetKiB",
        ).toFixed(3)),
        usedHeapChangeBytes: (reloadPlateauSamples.at(-1)?.usedHeapBytes || 0)
          - (reloadPlateauSamples[0]?.usedHeapBytes || 0),
        workingSetChangeKiB: (reloadPlateauSamples.at(-1)?.workingSetKiB || 0)
          - (reloadPlateauSamples[0]?.workingSetKiB || 0),
      },
      afterReloadMetrics,
    },
  };
}

app.whenReady().then(async () => {
  try {
    const result = await run();
    process.stdout.write(`WW_PERF_RESULT:${JSON.stringify(result)}\n`);
    app.quit();
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    app.exit(1);
  }
});
