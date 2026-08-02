import test from "node:test";
import assert from "node:assert/strict";

import {
  WW_UPDATE_PROTOCOL_VERSION,
  WW_UPDATE_SOURCE_INFO,
  assessWwUpdateCompatibility,
  buildWwUpdateStatus,
  createWwReleaseActivator,
} from "../lib/ww-update.mjs";

test("ww update source excludes preserved mirror conflicts", () => {
  assert.equal(WW_UPDATE_SOURCE_INFO.files.some((file) => file.includes("(WW conflict ")), false);
});

test("ww update compatibility survives ordinary app mismatches but remains protocol-pinned", () => {
  const compatible = assessWwUpdateCompatibility({
    remote: {
      versions: {
        protocol: 999,
        app: "different-app-build",
      },
      capabilities: {
        updateProtocol: WW_UPDATE_PROTOCOL_VERSION,
      },
    },
    peerLabel: "Sakura",
  });
  assert.equal(compatible.ok, true);

  const legacy = assessWwUpdateCompatibility({
    remote: {
      versions: {
        protocol: 1,
        app: "last-pre-updater-build",
      },
    },
  });
  assert.equal(legacy.ok, true);

  const incompatible = assessWwUpdateCompatibility({
    remote: {
      versions: {
        protocol: 2,
        app: "unknown-build",
      },
    },
    peerLabel: "Sakura",
  });
  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.code, "ERR_WW_UPDATE_PROTOCOL_UNKNOWN");
});

test("ww release activation waits for a stable source and exact peer convergence", async () => {
  let now = 1_000;
  let sourceHash = "running";
  let peerReady = false;
  const activations = [];
  const activator = createWwReleaseActivator({
    runningHash: "running",
    settleMs: 500,
    nowImpl: () => now,
    readReleaseInfoImpl: async () => ({
      hash: sourceHash,
      version: `0.1.0+ww1.${sourceHash}`,
    }),
    isReadyToActivate: async () => peerReady,
    onActivationRequired: async (release) => activations.push(release.hash),
  });

  assert.equal(await activator.checkNow(), false);
  sourceHash = "candidate-a";
  assert.equal(await activator.checkNow(), false);
  now += 600;
  assert.equal(await activator.checkNow(), false);
  assert.deepEqual(activations, []);

  sourceHash = "candidate-b";
  assert.equal(await activator.checkNow(), false);
  now += 600;
  peerReady = true;
  assert.equal(await activator.checkNow(), true);
  assert.deepEqual(activations, ["candidate-b"]);
  assert.equal(activator.getStatus().activated, true);
});

test("ww release activation stops thrashing when the source never converges", async () => {
  let now = 1_000;
  const history = [];       // stands in for the persisted activation-history file
  const activations = [];
  const settleMs = 500;
  // Each real activation restarts the process, so model each restart as a fresh
  // activator instance that shares the persisted history.
  function spawnLifetime(counter) {
    return createWwReleaseActivator({
      runningHash: "running",
      settleMs,
      thrashLimit: 3,
      thrashWindowMs: 10 * 60_000,
      thrashRecoverMs: 5 * 60_000,
      nowImpl: () => now,
      // Every lifetime sees a brand-new candidate hash: a churning source.
      readReleaseInfoImpl: async () => ({ hash: `candidate-${counter}`, version: `0.1.0+ww1.candidate-${counter}` }),
      isReadyToActivate: async () => true,
      onActivationRequired: async (release) => activations.push(release.hash),
      loadActivationHistoryImpl: () => history.slice(),
      recordActivationImpl: (_path, entry) => history.push(entry),
    });
  }

  let holdObserved = false;
  for (let i = 0; i < 6; i += 1) {
    const activator = spawnLifetime(i);
    await activator.checkNow();       // observe the new candidate
    now += settleMs + 1;             // let it settle past settleMs
    await activator.checkNow();       // attempt activation (or hold)
    if (activator.getStatus().holding) holdObserved = true;
    now += 1_000;                    // wall time passes before the next restart
  }

  assert.equal(activations.length, 3, "activator must stop after the thrash limit");
  assert.equal(holdObserved, true, "activator must enter the hold state");
});

test("ww release activation resumes once a churning source finally settles", async () => {
  let now = 1_000;
  const history = [
    { ts: 0, hash: "a" }, { ts: 10, hash: "b" }, { ts: 20, hash: "c" },
  ]; // already at the thrash limit within the window
  const activations = [];
  const settleMs = 500;
  const recoverMs = 5 * 60_000;
  const activator = createWwReleaseActivator({
    runningHash: "running",
    settleMs,
    thrashLimit: 3,
    thrashWindowMs: 10 * 60_000,
    thrashRecoverMs: recoverMs,
    nowImpl: () => now,
    readReleaseInfoImpl: async () => ({ hash: "settled", version: "0.1.0+ww1.settled" }),
    isReadyToActivate: async () => true,
    onActivationRequired: async (release) => activations.push(release.hash),
    loadActivationHistoryImpl: () => history.slice(),
    recordActivationImpl: (_path, entry) => history.push(entry),
  });

  await activator.checkNow();            // register "settled" candidate
  now += settleMs + 1;
  assert.equal(await activator.checkNow(), false, "still held right after settle");
  assert.equal(activator.getStatus().holding, true);

  now += recoverMs;                      // candidate stays stable long enough
  assert.equal(await activator.checkNow(), true, "a durably stable source overrides the hold");
  assert.deepEqual(activations, ["settled"]);
});

test("ww update status distinguishes the running release from staged source bytes", () => {
  const status = buildWwUpdateStatus({
    hash: "staged-hash",
    version: "0.1.0+ww1.staged",
  });
  assert.equal(status.protocol, WW_UPDATE_PROTOCOL_VERSION);
  assert.equal(status.source.hash, "staged-hash");
  assert.equal(status.source.appVersion, "0.1.0+ww1.staged");
  assert.notEqual(status.running.hash, "");
});
