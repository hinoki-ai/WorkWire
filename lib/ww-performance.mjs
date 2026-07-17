import {
  monitorEventLoopDelay,
  performance,
} from "node:perf_hooks";

const PERFORMANCE_DIAGNOSTICS_ENABLED = process.env.WW_PERF_DIAGNOSTICS === "1";
const REDACTED_FIELD = /(?:authorization|command|content|passphrase|password|path|secret|token)/i;
const DEFAULT_MONITOR_INTERVAL_MS = 10_000;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value, digits = 3) {
  const multiplier = 10 ** digits;
  return Math.round(finiteNumber(value) * multiplier) / multiplier;
}

function sanitizeFields(fields = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (REDACTED_FIELD.test(key)) {
      safe[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string") {
      safe[key] = value.slice(0, 128);
    } else if (typeof value === "number" || typeof value === "boolean" || value == null) {
      safe[key] = value;
    }
  }
  return safe;
}

function writeDiagnostic(record) {
  process.stderr.write(`[ww:performance] ${JSON.stringify(record)}\n`);
}

export function performanceDiagnosticsEnabled() {
  return PERFORMANCE_DIAGNOSTICS_ENABLED;
}

export function startPerformanceSpan(name, fields = {}) {
  if (!PERFORMANCE_DIAGNOSTICS_ENABLED) return null;
  const startedAt = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  const memoryStart = process.memoryUsage();
  let ended = false;

  return {
    end(extraFields = {}) {
      if (ended) return;
      ended = true;
      const memoryEnd = process.memoryUsage();
      const cpu = process.cpuUsage(cpuStart);
      writeDiagnostic({
        kind: "span",
        name: String(name || "operation").slice(0, 96),
        timestamp: new Date().toISOString(),
        durationMs: round(Number(process.hrtime.bigint() - startedAt) / 1e6),
        cpuUserMs: round(cpu.user / 1_000),
        cpuSystemMs: round(cpu.system / 1_000),
        heapDeltaBytes: memoryEnd.heapUsed - memoryStart.heapUsed,
        externalDeltaBytes: memoryEnd.external - memoryStart.external,
        ...sanitizeFields(fields),
        ...sanitizeFields(extraFields),
      });
    },
  };
}

export async function measurePerformance(name, fields, operation) {
  if (!PERFORMANCE_DIAGNOSTICS_ENABLED) return operation();
  const span = startPerformanceSpan(name, fields);
  try {
    const result = await operation();
    span.end({ ok: true });
    return result;
  } catch (error) {
    span.end({
      ok: false,
      errorCode: String(error?.code || error?.status || "ERR_OPERATION"),
    });
    throw error;
  }
}

export function startPerformanceMonitor({
  scope = "workwire",
  intervalMs = DEFAULT_MONITOR_INTERVAL_MS,
} = {}) {
  if (!PERFORMANCE_DIAGNOSTICS_ENABLED) {
    return { stop() {} };
  }

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let previousUtilization = performance.eventLoopUtilization();
  let previousResourceUsage = process.resourceUsage();
  const timer = setInterval(() => {
    const utilization = performance.eventLoopUtilization(previousUtilization);
    previousUtilization = performance.eventLoopUtilization();
    const resourceUsage = process.resourceUsage();
    const memory = process.memoryUsage();
    writeDiagnostic({
      kind: "process-sample",
      scope: String(scope || "workwire").slice(0, 64),
      timestamp: new Date().toISOString(),
      eventLoopUtilization: round(utilization.utilization, 5),
      eventLoopDelayMeanMs: round(histogram.mean / 1e6),
      eventLoopDelayP95Ms: round(histogram.percentile(95) / 1e6),
      eventLoopDelayMaxMs: round(histogram.max / 1e6),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      userCpuMicros: resourceUsage.userCPUTime - previousResourceUsage.userCPUTime,
      systemCpuMicros: resourceUsage.systemCPUTime - previousResourceUsage.systemCPUTime,
      voluntaryContextSwitches: resourceUsage.voluntaryContextSwitches
        - previousResourceUsage.voluntaryContextSwitches,
      involuntaryContextSwitches: resourceUsage.involuntaryContextSwitches
        - previousResourceUsage.involuntaryContextSwitches,
    });
    previousResourceUsage = resourceUsage;
    histogram.reset();
  }, Math.max(1_000, finiteNumber(intervalMs) || DEFAULT_MONITOR_INTERVAL_MS));
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      histogram.disable();
    },
  };
}
