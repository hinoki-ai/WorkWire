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
