function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clampUnit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function getTransferProgress(operation = {}) {
  const totals = operation?.totals || {};
  const totalBytes = finiteNonNegative(totals.bytes);
  const totalFiles = finiteNonNegative(totals.files);
  const transferredBytes = finiteNonNegative(operation.transferredBytes);
  const transferredFiles = finiteNonNegative(operation.transferredFiles);
  const skippedFiles = finiteNonNegative(operation.skippedFiles);
  const processedBytes = Math.max(
    transferredBytes,
    finiteNonNegative(operation.processedBytes),
  );
  const processedFiles = Math.max(
    transferredFiles + skippedFiles,
    finiteNonNegative(operation.processedFiles),
  );
  const complete = operation.stage === "complete";

  let ratio = 0;
  let basis = "unknown";
  let determinate = false;

  if (complete) {
    ratio = 1;
    basis = totalBytes > 0 ? "bytes" : totalFiles > 0 ? "files" : "complete";
    determinate = true;
  } else if (totalBytes > 0) {
    ratio = processedBytes / totalBytes;
    basis = "bytes";
    determinate = true;
  } else if (totalFiles > 0) {
    ratio = processedFiles / totalFiles;
    basis = "files";
    determinate = true;
  }

  ratio = clampUnit(ratio);
  return {
    basis,
    complete,
    determinate,
    percent: ratio * 100,
    processedBytes,
    processedFiles,
    ratio,
    skippedFiles,
    totalBytes,
    totalFiles,
    transferredBytes,
    transferredFiles,
  };
}

export function formatTransferPercent(value, determinate = true) {
  if (!determinate) return "…";
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  if (percent > 0 && percent < 0.05) return "<0.1%";
  return `${Number(percent.toFixed(1))}%`;
}

export function formatSecondsRemaining(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return "";
  const seconds = Math.ceil(numeric);
  if (seconds <= 1) return "Almost done";
  if (seconds < 60) return `${seconds}s left`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `${hours}h ${remainingMinutes}m left`
    : `${hours}h left`;
}

export function formatTransferDuration(value) {
  const milliseconds = finiteNonNegative(value);
  if (milliseconds === 0) return "";
  if (milliseconds < 1_000) return "Done in <1s";

  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `Done in ${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0
    ? `Done in ${minutes}m ${remainingSeconds}s`
    : `Done in ${minutes}m`;
}
