import { canonicalJson, clone, iso, jsonSafe, stableId } from "./util.mjs";

const HEALTH_RULE_VERSION = 1;

const DEFAULT_RULES = Object.freeze([
  { id: "smart-failed", metric: "smart.passed", operator: "eq", value: false, severity: "critical", operation: "replace-disk", message: "Drive self-assessment reports failure." },
  { id: "pending-sectors", metric: "smart.pendingSectors", operator: "gt", value: 0, severity: "high", operation: "prepare-ddrescue", message: "Drive has pending unreadable sectors." },
  { id: "uncorrectable-sectors", metric: "smart.uncorrectableSectors", operator: "gt", value: 0, severity: "critical", operation: "prepare-ddrescue", message: "Drive reports uncorrectable sectors." },
  { id: "media-errors", metric: "nvme.mediaErrors", operator: "gt", value: 0, severity: "high", operation: "snapshot-now", message: "NVMe media errors are present." },
  { id: "nvme-warning", metric: "nvme.criticalWarning", operator: "gt", value: 0, severity: "critical", operation: "replace-disk", message: "NVMe critical warning is active." },
  { id: "wear-high", metric: "nvme.percentageUsed", operator: "gte", value: 90, severity: "high", operation: "replace-disk", message: "NVMe endurance consumption is high." },
  { id: "temperature-high", metric: "temperatureCelsius", operator: "gte", value: 70, severity: "high", operation: "collect-full-inventory", message: "Storage temperature is excessive." },
  { id: "filesystem-capacity", metric: "filesystem.usedPercent", operator: "gte", value: 90, severity: "high", operation: "snapshot-now", message: "Filesystem capacity is nearing exhaustion." },
  { id: "agent-unreachable", metric: "agent.reachable", operator: "eq", value: false, severity: "medium", operation: "collect-full-inventory", message: "Recovery agent is unreachable." },
  { id: "tool-coverage", metric: "agent.toolCoverage", operator: "lt", value: 0.5, severity: "medium", operation: "collect-full-inventory", message: "Recovery tool coverage is incomplete." },
]);

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function diskKey(item = {}) {
  return String(item.deviceId || item.serial || item.path || item.model || "unknown-disk");
}

function metricSample(machineId, timestamp, metric, value, details = {}) {
  return {
    id: stableId("health", { machineId, timestamp, metric, entityId: details.entityId || "", value }),
    machineId, timestamp, metric, value, unit: details.unit || null,
    entityId: details.entityId || machineId, source: details.source || "inventory",
    evidence: clone(details.evidence || null),
  };
}

function pushMetric(output, machineId, timestamp, metric, value, details) {
  if (value === undefined || value === null || (typeof value === "number" && !Number.isFinite(value))) return;
  output.push(metricSample(machineId, timestamp, metric, value, details));
}

function normalizeInventoryMetrics(machineId, inventory = {}) {
  const timestamp = iso(inventory.collectedAt || inventory.timestamp || inventory.observedAt || Date.now());
  const output = [];
  const strongIdentity = {
    dmiUuid: inventory.dmiUuid || inventory.system?.dmiUuid || inventory.system?.uuid || null,
    systemSerial: inventory.systemSerial || inventory.system?.serial || null,
    peerId: inventory.wwPeerId || inventory.agent?.peerId || null,
  };
  if (Object.values(strongIdentity).some(Boolean)) {
    pushMetric(output, machineId, timestamp, "identity.fingerprint", stableId("identity", strongIdentity), { evidence: strongIdentity });
  }
  const devices = inventory.block?.devices || inventory.disks || [];
  pushMetric(output, machineId, timestamp, "storage.deviceSet", devices.map(diskKey).sort(), {
    evidence: devices.map((item) => ({ id: diskKey(item), path: item.path, model: item.model })),
  });
  for (const device of devices) {
    const entityId = diskKey(device);
    pushMetric(output, machineId, timestamp, "disk.capacityBytes", numeric(device.size || device.capacity), { entityId, unit: "bytes", evidence: device });
  }
  for (const item of inventory.health?.smart || []) {
    const entityId = diskKey(item);
    pushMetric(output, machineId, timestamp, "smart.passed", item.passed, { entityId, evidence: item });
    for (const [field, metric] of [
      ["temperatureCelsius", "temperatureCelsius"], ["reallocatedSectors", "smart.reallocatedSectors"],
      ["pendingSectors", "smart.pendingSectors"], ["uncorrectableSectors", "smart.uncorrectableSectors"],
      ["errorLogCount", "smart.errorLogCount"], ["unsafeShutdowns", "storage.unsafeShutdowns"],
      ["powerOnHours", "storage.powerOnHours"],
    ]) pushMetric(output, machineId, timestamp, metric, numeric(item[field]), { entityId, evidence: item });
  }
  for (const item of inventory.health?.nvme || []) {
    const entityId = diskKey(item);
    for (const [field, metric] of [
      ["criticalWarning", "nvme.criticalWarning"], ["temperatureCelsius", "temperatureCelsius"],
      ["percentageUsed", "nvme.percentageUsed"], ["mediaErrors", "nvme.mediaErrors"],
      ["errorLogEntries", "nvme.errorLogEntries"], ["unsafeShutdowns", "storage.unsafeShutdowns"],
      ["availableSparePercent", "nvme.availableSparePercent"], ["powerOnHours", "storage.powerOnHours"],
    ]) pushMetric(output, machineId, timestamp, metric, numeric(item[field]), { entityId, evidence: item });
  }
  const mounts = inventory.block?.mounts || inventory.filesystems || [];
  for (const item of mounts) {
    const size = numeric(item.size || item.totalBytes);
    const used = numeric(item.used ?? item.usedBytes);
    const available = numeric(item.available ?? item.availableBytes);
    const usedPercent = size > 0 ? ((used ?? (size - (available || 0))) / size) * 100 : numeric(item.usedPercent);
    pushMetric(output, machineId, timestamp, "filesystem.usedPercent", usedPercent, {
      entityId: String(item.uuid || item.source || item.target || item.path || "filesystem"), unit: "percent", evidence: item,
    });
  }
  const raid = inventory.block?.raid ?? inventory.raid;
  if (Array.isArray(raid)) {
    for (const item of raid) pushMetric(output, machineId, timestamp, "raid.state", item.state || item.status || "unknown", {
      entityId: String(item.uuid || item.name || "raid"), evidence: item,
    });
  } else if (raid && typeof raid === "object") {
    pushMetric(output, machineId, timestamp, "raid.state", raid.state || raid.status || "unknown", { evidence: raid });
  }
  const warnings = inventory.health?.kernelWarnings;
  if (Array.isArray(warnings)) pushMetric(output, machineId, timestamp, "kernel.storageWarnings", warnings.length, { evidence: warnings });
  const bootIdentity = inventory.bootIdentity || inventory.bootId || inventory.agent?.bootId;
  if (bootIdentity) pushMetric(output, machineId, timestamp, "boot.identity", bootIdentity, { evidence: inventory.firmware || null });
  const bootFailures = numeric(inventory.bootFailures ?? inventory.health?.bootFailures);
  pushMetric(output, machineId, timestamp, "boot.failures", bootFailures, { evidence: inventory.boot || null });
  const reachable = inventory.agent?.reachable ?? (inventory.agent?.state ? inventory.agent.state === "online" : undefined);
  pushMetric(output, machineId, timestamp, "agent.reachable", reachable, { evidence: inventory.agent || null });
  const tools = inventory.tools && typeof inventory.tools === "object" ? Object.values(inventory.tools) : [];
  if (tools.length) {
    const available = tools.filter((item) => item === true || item?.available === true).length;
    pushMetric(output, machineId, timestamp, "agent.toolCoverage", available / tools.length, {
      unit: "ratio", evidence: { available, total: tools.length },
    });
  }
  return { timestamp, samples: output };
}

function matches(rule, value) {
  if (rule.operator === "eq") return value === rule.value;
  if (typeof value !== "number") return false;
  if (rule.operator === "gt") return value > rule.value;
  if (rule.operator === "gte") return value >= rule.value;
  if (rule.operator === "lt") return value < rule.value;
  if (rule.operator === "lte") return value <= rule.value;
  return false;
}

export function createHealthIntelligence(options = {}) {
  const observations = new Map();
  const observationIds = new Set();
  const series = new Map();
  const rules = (options.rules || DEFAULT_RULES).map((rule) => jsonSafe(rule, "health rule"));

  function observe(machineId, inventory = {}) {
    const id = String(machineId || "");
    if (!id) throw new TypeError("Health observation requires a machine ID.");
    const safe = jsonSafe(inventory, "health inventory");
    const observationId = stableId("healthobs", { machineId: id, inventory: safe });
    if (observationIds.has(observationId)) return clone((observations.get(id) || []).find((item) => item.id === observationId));
    const normalized = normalizeInventoryMetrics(id, safe);
    const record = { id: observationId, machineId: id, timestamp: normalized.timestamp, inventory: safe, samples: normalized.samples };
    const machineObservations = observations.get(id) || [];
    machineObservations.push(record);
    machineObservations.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    observations.set(id, machineObservations);
    observationIds.add(observationId);
    for (const sample of record.samples) {
      const key = `${id}\0${sample.metric}`;
      const values = series.get(key) || [];
      values.push(sample);
      values.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      series.set(key, values);
    }
    return clone(record);
  }

  function latestSamples(machineId, at = "") {
    const latest = new Map();
    for (const [key, values] of series) {
      if (!key.startsWith(`${machineId}\0`)) continue;
      const eligible = at ? values.filter((item) => item.timestamp <= at) : values;
      const byEntity = new Map();
      for (const sample of eligible) byEntity.set(sample.entityId, sample);
      if (byEntity.size) latest.set(values[0].metric, [...byEntity.values()]);
    }
    return latest;
  }

  function trendFor(sample) {
    const values = series.get(`${sample.machineId}\0${sample.metric}`) || [];
    const sameEntity = values.filter((item) => item.entityId === sample.entityId && item.timestamp <= sample.timestamp);
    const previous = sameEntity.at(-2);
    if (!previous || typeof sample.value !== "number" || typeof previous.value !== "number") return null;
    const delta = sample.value - previous.value;
    return { from: previous.value, to: sample.value, delta, direction: delta > 0 ? "worsening-or-rising" : delta < 0 ? "falling" : "stable", since: previous.timestamp };
  }

  function finding(machineId, rule, sample, extra = {}) {
    const trend = trendFor(sample);
    return {
      id: stableId("finding", { machineId, rule: rule.id, entityId: sample.entityId, timestamp: sample.timestamp, value: sample.value }),
      machineId, ruleId: rule.id, ruleVersion: HEALTH_RULE_VERSION, severity: rule.severity,
      observedAt: sample.timestamp, affectedEntity: sample.entityId, metric: sample.metric,
      observedValue: clone(sample.value), threshold: rule.value ?? null, trend,
      evidence: clone(sample.evidence), message: rule.message,
      recommendation: { operation: rule.operation, reason: rule.message, affectedEntity: sample.entityId },
      ...extra,
    };
  }

  function evaluate(machineId, context = {}) {
    const id = String(machineId || "");
    const machineObservations = observations.get(id) || [];
    const now = iso(context.now || Date.now());
    const samples = latestSamples(id, context.at ? iso(context.at) : "");
    const findings = [];
    const unknownMetrics = [];
    for (const rule of rules) {
      const matchingSamples = samples.get(rule.metric);
      if (!matchingSamples?.length) {
        unknownMetrics.push(rule.metric);
        continue;
      }
      for (const sample of matchingSamples) if (matches(rule, sample.value)) findings.push(finding(id, rule, sample));
    }

    const latestObservation = machineObservations.at(-1);
    const previousObservation = machineObservations.at(-2);
    const latestDevices = latestObservation?.samples.find((item) => item.metric === "storage.deviceSet");
    const previousDevices = previousObservation?.samples.find((item) => item.metric === "storage.deviceSet");
    if (latestDevices && previousDevices) {
      const missing = previousDevices.value.filter((item) => !latestDevices.value.includes(item));
      for (const entityId of missing) findings.push(finding(id, {
        id: "device-disappeared", severity: "high", value: null, operation: "collect-full-inventory",
        message: "A previously observed storage device disappeared.",
      }, { ...latestDevices, entityId, value: "missing", evidence: { previous: previousDevices.value, current: latestDevices.value } }));
    }
    const latestIdentity = latestObservation?.samples.find((item) => item.metric === "identity.fingerprint");
    const previousIdentity = previousObservation?.samples.find((item) => item.metric === "identity.fingerprint");
    if (latestIdentity && previousIdentity && latestIdentity.value !== previousIdentity.value) findings.push(finding(id, {
      id: "identity-drift", severity: "high", value: null, operation: "collect-full-inventory",
      message: "Strong machine identity evidence changed between observations.",
    }, { ...latestIdentity, evidence: { previous: previousIdentity.evidence, current: latestIdentity.evidence } }));
    for (const [key, values] of series) {
      if (!key.startsWith(`${id}\0`)) continue;
      const latest = values.at(-1);
      const trend = trendFor(latest);
      if (!trend || trend.delta <= 0) continue;
      if (["smart.pendingSectors", "smart.uncorrectableSectors", "nvme.mediaErrors", "storage.unsafeShutdowns"].includes(latest.metric)) {
        findings.push(finding(id, {
          id: `${latest.metric}-worsening`, severity: "high", value: null, operation: "prepare-ddrescue",
          message: `${latest.metric} worsened between observations.`,
        }, latest));
      }
    }
    const lastAt = latestObservation?.timestamp;
    const staleAfterMs = Number(context.staleAfterMs ?? options.staleAfterMs ?? 24 * 60 * 60 * 1000);
    if (lastAt && new Date(now).getTime() - new Date(lastAt).getTime() > staleAfterMs) {
      const sample = metricSample(id, lastAt, "observation.stale", true, { evidence: { lastObservedAt: lastAt, evaluatedAt: now, staleAfterMs } });
      findings.push(finding(id, {
        id: "observation-stale", severity: "medium", value: true, operation: "collect-full-inventory",
        message: "Machine health observation is stale.",
      }, sample));
    }
    const bootFailures = samples.get("boot.failures")?.at(-1);
    if (bootFailures && bootFailures.value >= 2) findings.push(finding(id, {
      id: "recurring-boot-failures", severity: "high", value: 2, operation: "snapshot-now",
      message: "Boot failures are recurring.",
    }, bootFailures));
    const raidSamples = samples.get("raid.state") || [];
    for (const sample of raidSamples) if (/degrad|fail|inactive|recover/i.test(String(sample.value))) findings.push(finding(id, {
      id: "raid-degraded", severity: "critical", value: null, operation: "snapshot-now", message: "RAID state is degraded or failed.",
    }, sample));
    const warnings = samples.get("kernel.storageWarnings")?.at(-1);
    if (warnings?.value > 0) findings.push(finding(id, {
      id: "kernel-storage-warnings", severity: "medium", value: 0, operation: "collect-full-inventory",
      message: "Kernel storage warnings were observed.",
    }, warnings));
    findings.sort((left, right) => (
      ({ critical: 0, high: 1, medium: 2, low: 3 }[left.severity] ?? 4)
      - ({ critical: 0, high: 1, medium: 2, low: 3 }[right.severity] ?? 4)
    ));
    return {
      id: stableId("assessment", { machineId: id, evaluatedAt: now, lastObservedAt: lastAt || null }),
      timestamp: now, machineId: id, evaluatedAt: now, ruleVersion: HEALTH_RULE_VERSION,
      observationCount: machineObservations.length, lastObservedAt: lastAt || null,
      status: !machineObservations.length ? "unknown" : findings.some((item) => item.severity === "critical") ? "critical"
        : findings.some((item) => item.severity === "high") ? "warning" : findings.length ? "attention" : "healthy",
      findings, unknownMetrics: [...new Set(unknownMetrics)],
    };
  }

  function compare(machineId, from, to) {
    const id = String(machineId || "");
    const leftAt = iso(from);
    const rightAt = iso(to);
    const left = latestSamples(id, leftAt);
    const right = latestSamples(id, rightAt);
    const changes = [];
    for (const metric of new Set([...left.keys(), ...right.keys()])) {
      const leftByEntity = new Map((left.get(metric) || []).map((item) => [item.entityId, item]));
      const rightByEntity = new Map((right.get(metric) || []).map((item) => [item.entityId, item]));
      for (const entityId of new Set([...leftByEntity.keys(), ...rightByEntity.keys()])) {
        const previous = leftByEntity.get(entityId);
        const current = rightByEntity.get(entityId);
        if (canonicalJson(previous?.value) !== canonicalJson(current?.value)) changes.push({
          metric, entityId, from: clone(previous?.value ?? null), to: clone(current?.value ?? null),
          delta: typeof previous?.value === "number" && typeof current?.value === "number" ? current.value - previous.value : null,
          evidence: { from: clone(previous?.evidence || null), to: clone(current?.evidence || null) },
        });
      }
    }
    return {
      id: stableId("healthdiff", { machineId: id, from: leftAt, to: rightAt }), timestamp: iso(),
      machineId: id, from: leftAt, to: rightAt, changes,
    };
  }

  function recommendations(machineId) {
    const assessment = evaluate(machineId);
    const unique = new Map();
    for (const item of assessment.findings) {
      const operation = item.recommendation.operation;
      if (!unique.has(operation)) unique.set(operation, {
        id: stableId("recommendation", { machineId, operation, findingId: item.id }),
        machineId: String(machineId), createdAt: assessment.evaluatedAt, operation,
        severity: item.severity, reason: item.message, evidence: [item.id], affectedEntities: [item.affectedEntity],
      });
      else {
        unique.get(operation).evidence.push(item.id);
        unique.get(operation).affectedEntities.push(item.affectedEntity);
      }
    }
    if (assessment.findings.length && !unique.has("verify-vault")) unique.set("verify-vault", {
      id: stableId("recommendation", { machineId, operation: "verify-vault", at: assessment.lastObservedAt }),
      machineId: String(machineId), createdAt: assessment.evaluatedAt, operation: "verify-vault",
      severity: "medium", reason: "Verify that recovery content remains readable before machine risk increases.",
      evidence: assessment.findings.map((item) => item.id), affectedEntities: [],
    });
    const pending = assessment.findings.some((item) => item.metric === "smart.pendingSectors");
    if (pending && !unique.has("run-long-SMART-test")) unique.set("run-long-SMART-test", {
      id: stableId("recommendation", { machineId, operation: "run-long-SMART-test", at: assessment.lastObservedAt }),
      machineId: String(machineId), createdAt: assessment.evaluatedAt, operation: "run-long-SMART-test",
      severity: "high", reason: "Confirm the extent of reported SMART sector instability after securing recoverable data.",
      evidence: assessment.findings.filter((item) => item.metric.startsWith("smart.")).map((item) => item.id), affectedEntities: [],
    });
    return [...unique.values()].map((item) => ({ ...item, affectedEntities: [...new Set(item.affectedEntities)] }));
  }

  function getSeries(machineId, metric, query = {}) {
    const values = series.get(`${machineId}\0${metric}`) || [];
    const from = query.from ? iso(query.from) : "";
    const to = query.to ? iso(query.to) : "";
    let output = values.filter((item) => (!from || item.timestamp >= from) && (!to || item.timestamp <= to));
    if (query.entityId) output = output.filter((item) => item.entityId === query.entityId);
    if (Number(query.limit) > 0) output = output.slice(-Number(query.limit));
    return output.map(clone);
  }

  for (const item of options.observations || []) observe(item.machineId, item.inventory || item);
  return { observe, evaluate, compare, recommendations, getSeries };
}

export { DEFAULT_RULES, HEALTH_RULE_VERSION };
