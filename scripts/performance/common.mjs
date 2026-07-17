import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export function parseArgs(argv = process.argv.slice(2)) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const equalsAt = value.indexOf("=");
    if (equalsAt >= 0) {
      result[value.slice(2, equalsAt)] = value.slice(equalsAt + 1);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next != null && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

export function numberArg(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function listArg(value, fallback = []) {
  if (value == null || value === "") return [...fallback];
  return String(value)
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 0);
}

function quantile(sorted, percentile) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function summarize(values = []) {
  const finite = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) {
    return {
      samples: 0,
      min: null,
      median: null,
      p95: null,
      max: null,
      mean: null,
      standardDeviation: null,
      coefficientOfVariation: null,
    };
  }
  const mean = finite.reduce((total, value) => total + value, 0) / finite.length;
  const variance = finite.reduce((total, value) => total + ((value - mean) ** 2), 0) / finite.length;
  const standardDeviation = Math.sqrt(variance);
  const round = (value) => Number(value.toFixed(3));
  return {
    samples: finite.length,
    min: round(finite[0]),
    median: round(quantile(finite, 0.5)),
    p95: round(quantile(finite, 0.95)),
    max: round(finite.at(-1)),
    mean: round(mean),
    standardDeviation: round(standardDeviation),
    coefficientOfVariation: mean === 0 ? 0 : round(standardDeviation / mean),
  };
}

function delaySummary(histogram) {
  const toMilliseconds = (nanoseconds) => Number.isFinite(nanoseconds) && nanoseconds < 9e18
    ? Number((nanoseconds / 1e6).toFixed(3))
    : null;
  return {
    minMs: toMilliseconds(histogram.min),
    meanMs: toMilliseconds(histogram.mean),
    p50Ms: toMilliseconds(histogram.percentile(50)),
    p95Ms: toMilliseconds(histogram.percentile(95)),
    p99Ms: toMilliseconds(histogram.percentile(99)),
    maxMs: toMilliseconds(histogram.max),
  };
}

export async function measureSamples(operation, {
  repeats = 5,
  warmups = 1,
  sampleMemoryEveryMs = 5,
} = {}) {
  for (let index = 0; index < warmups; index += 1) {
    await operation({ warmup: true, index });
  }

  globalThis.gc?.();
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const utilizationStart = performance.eventLoopUtilization();
  const cpuStart = process.cpuUsage();
  const resourceStart = process.resourceUsage();
  const memoryStart = process.memoryUsage();
  let peakMemory = { ...memoryStart };
  const memoryTimer = setInterval(() => {
    const current = process.memoryUsage();
    for (const key of Object.keys(peakMemory)) {
      peakMemory[key] = Math.max(peakMemory[key], current[key]);
    }
  }, Math.max(1, sampleMemoryEveryMs));

  const durationsMs = [];
  const outputs = [];
  try {
    for (let index = 0; index < repeats; index += 1) {
      const startedAt = performance.now();
      outputs.push(await operation({ warmup: false, index }));
      durationsMs.push(performance.now() - startedAt);
      // Give the delay histogram a turn after synchronous renderer/search work
      // so a blocking sample is observed instead of disappearing between ticks.
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    clearInterval(memoryTimer);
    const current = process.memoryUsage();
    for (const key of Object.keys(peakMemory)) {
      peakMemory[key] = Math.max(peakMemory[key], current[key]);
    }
    histogram.disable();
  }

  const cpu = process.cpuUsage(cpuStart);
  const resourceEnd = process.resourceUsage();
  const utilization = performance.eventLoopUtilization(utilizationStart);
  const memoryEnd = process.memoryUsage();
  return {
    durationsMs,
    duration: summarize(durationsMs),
    outputs,
    resources: {
      memoryStartBytes: memoryStart,
      peakMemoryBytes: peakMemory,
      memoryEndBytes: memoryEnd,
      rssStartBytes: memoryStart.rss,
      peakRssBytes: peakMemory.rss,
      rssEndBytes: memoryEnd.rss,
      userCpuMs: Number((cpu.user / 1_000).toFixed(3)),
      systemCpuMs: Number((cpu.system / 1_000).toFixed(3)),
      maxRssDeltaKiB: Math.max(0, resourceEnd.maxRSS - resourceStart.maxRSS),
      voluntaryContextSwitches: resourceEnd.voluntaryContextSwitches - resourceStart.voluntaryContextSwitches,
      involuntaryContextSwitches: resourceEnd.involuntaryContextSwitches - resourceStart.involuntaryContextSwitches,
      eventLoopUtilization: Number(utilization.utilization.toFixed(6)),
      eventLoopDelay: delaySummary(histogram),
    },
  };
}

export function environmentRecord() {
  return {
    capturedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    cpuModel: os.cpus()[0]?.model || "unknown",
    logicalCpuCount: os.availableParallelism?.() ?? os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
}

export async function emitResult(result, { output = "" } = {}) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (output) {
    const targetPath = path.resolve(output);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, serialized, "utf8");
  }
  process.stdout.write(serialized);
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const values = Array.from(items);
  const output = new Array(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}
