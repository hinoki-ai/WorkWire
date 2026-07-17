import test from "node:test";
import assert from "node:assert/strict";
import {
  formatSecondsRemaining,
  formatTransferDuration,
  formatTransferPercent,
  getTransferProgress,
} from "../desktop/ww/transfer-progress.js";

test("transfer progress uses live byte telemetry when a file is still in flight", () => {
  const progress = getTransferProgress({
    active: true,
    stage: "transfer-progress",
    totals: { files: 2, bytes: 1_000 },
    transferredFiles: 0,
    transferredBytes: 375,
    processedFiles: 0,
    processedBytes: 375,
  });

  assert.equal(progress.basis, "bytes");
  assert.equal(progress.determinate, true);
  assert.equal(progress.ratio, 0.375);
  assert.equal(progress.percent, 37.5);
  assert.equal(formatTransferPercent(progress.percent), "37.5%");
});

test("transfer progress distinguishes handled work from bytes actually sent", () => {
  const progress = getTransferProgress({
    active: true,
    stage: "skip-file",
    totals: { files: 3, bytes: 3_000 },
    transferredFiles: 1,
    transferredBytes: 1_000,
    skippedFiles: 2,
    processedFiles: 3,
    processedBytes: 3_000,
  });

  assert.equal(progress.percent, 100);
  assert.equal(progress.processedBytes, 3_000);
  assert.equal(progress.transferredBytes, 1_000);
  assert.equal(progress.processedFiles, 3);
  assert.equal(progress.skippedFiles, 2);
});

test("zero-byte transfers fall back to completed file count and terminal state reaches 100%", () => {
  const active = getTransferProgress({
    active: true,
    stage: "file-complete",
    totals: { files: 4, bytes: 0 },
    processedFiles: 2,
  });
  assert.equal(active.basis, "files");
  assert.equal(active.percent, 50);

  const complete = getTransferProgress({ stage: "complete", totals: null });
  assert.equal(complete.determinate, true);
  assert.equal(complete.percent, 100);
});

test("transfer progress clamps malformed telemetry and formats human timing", () => {
  const progress = getTransferProgress({
    stage: "transfer-progress",
    totals: { files: 1, bytes: 10 },
    transferredBytes: 50,
    processedBytes: Number.NaN,
  });

  assert.equal(progress.percent, 100);
  assert.equal(formatTransferPercent(0.001), "<0.1%");
  assert.equal(formatSecondsRemaining(0.2), "Almost done");
  assert.equal(formatSecondsRemaining(61), "2m left");
  assert.equal(formatSecondsRemaining(3_661), "1h 2m left");
  assert.equal(formatTransferDuration(920), "Done in <1s");
  assert.equal(formatTransferDuration(62_000), "Done in 1m 2s");
});
