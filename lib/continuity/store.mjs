import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createMachineGraph } from "./machine-graph.mjs";
import {
  atomicJson, canonicalJson, clone, compareTime, iso, jsonSafe, pickTimestamp, stableId, tokenize,
} from "./util.mjs";

const SCHEMA_VERSION = 1;

function addIndex(index, key, value) {
  if (key === undefined || key === null || key === "") return;
  const normalized = String(key);
  const values = index.get(normalized) || new Set();
  values.add(value);
  index.set(normalized, values);
}

function lowerBound(records, timestamp) {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (records[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function latestAt(records, timestamp, predicate = () => true) {
  if (!records?.length) return null;
  let index = timestamp ? lowerBound(records, timestamp) : records.length;
  if (timestamp && index < records.length && records[index].timestamp <= timestamp) index += 1;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (predicate(records[cursor])) return records[cursor];
  }
  return null;
}

function objectMap(values, keyOf) {
  return new Map((Array.isArray(values) ? values : []).map((value) => [String(keyOf(value)), value]));
}

function mapDiff(left, right) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, value] of right) {
    if (!left.has(key)) added.push(clone(value));
    else if (canonicalJson(left.get(key)) !== canonicalJson(value)) {
      changed.push({ id: key, from: clone(left.get(key)), to: clone(value) });
    }
  }
  for (const [key, value] of left) if (!right.has(key)) removed.push(clone(value));
  return { added, removed, changed };
}

function inventoryIdentity(agentId, inventory = {}) {
  const system = inventory.system || {};
  const agent = inventory.agent || {};
  const addresses = [];
  for (const item of inventory.network?.interfaces || []) {
    addresses.push({
      name: item.ifname || item.name || "",
      mac: item.mac || item.address || "",
      address: item.local || item.ip || "",
    });
  }
  return {
    machineId: inventory.machineId || agent.machineId || "",
    stableMachineId: inventory.stableMachineId || "",
    dmiUuid: inventory.dmiUuid || system.dmiUuid || system.uuid || agent.dmiUuid || "",
    systemSerial: inventory.systemSerial || system.serial || agent.systemSerial || "",
    wwPeerId: inventory.wwPeerId || agent.peerId || "",
    operatorAlias: inventory.operatorAlias || agent.operatorAlias || "",
    hostname: system.hostname || inventory.hostname || agent.hostname || "",
    ip: inventory.ip || "",
    bootId: inventory.bootId || agent.bootId || "",
    addresses,
    disks: inventory.block?.devices || inventory.disks || [],
    agentId,
  };
}

function inventoryText(agentId, inventory = {}) {
  const parts = [
    agentId, inventory.system?.hostname, inventory.system?.platform, inventory.system?.release,
    inventory.system?.osRelease?.NAME, inventory.system?.osRelease?.PRETTY_NAME,
  ];
  for (const device of inventory.block?.devices || []) {
    parts.push(device.deviceId, device.path, device.model, device.serial, device.wwn, device.filesystemType, device.filesystemLabel);
  }
  for (const warning of inventory.health?.kernelWarnings || []) parts.push(warning);
  return parts.filter(Boolean).join(" ");
}

function eventIdentity(input = {}) {
  return {
    machineId: input.machineId || "",
    stableMachineId: input.stableMachineId || "",
    dmiUuid: input.dmiUuid || input.identity?.dmiUuid || "",
    systemSerial: input.systemSerial || input.identity?.systemSerial || "",
    wwPeerId: input.wwPeerId || input.peerId || input.identity?.peerId || "",
    operatorAlias: input.operatorAlias || input.alias || "",
    hostname: input.hostname || input.identity?.hostname || "",
    ip: input.ip || "",
    bootId: input.bootId || "",
    addresses: input.addresses || [],
    disks: input.disks || [],
    agentId: input.agentId || "",
  };
}

export function createContinuityStore(options = {}) {
  const root = path.resolve(options.root || options.stateDir || path.join(process.cwd(), ".workwire", "continuity"));
  const paths = {
    root,
    events: path.join(root, "events", "continuity.jsonl"),
    index: path.join(root, "indexes", "continuity-index.json"),
    graph: path.join(root, "indexes", "machine-graph.json"),
    quarantine: path.join(root, "events", "abrupt-tail.bin"),
  };
  let graph = options.machineGraph || createMachineGraph();
  const events = new Map();
  const ordered = [];
  const machineTimelines = new Map();
  const machines = new Set();
  const indexes = {
    type: new Map(), machine: new Map(), entity: new Map(), case: new Map(), disk: new Map(), health: new Map(), text: new Map(),
  };
  let initialized = false;
  let closed = false;
  let appendHandle = null;
  let tail = Promise.resolve();
  let recoveredTailBytes = 0;

  function assertOpen() {
    if (!initialized) throw new Error("Continuity store is not initialized.");
    if (closed) throw new Error("Continuity store is closed.");
  }

  function indexEvent(record) {
    if (events.has(record.id)) return false;
    events.set(record.id, record);
    if (!ordered.length || compareTime(ordered.at(-1), record) <= 0) ordered.push(record);
    else ordered.splice(lowerBound(ordered, record.timestamp), 0, record);
    if (record.machineId) {
      machines.add(record.machineId);
      const timeline = machineTimelines.get(record.machineId) || [];
      const at = lowerBound(timeline, record.timestamp);
      timeline.splice(at, 0, record);
      machineTimelines.set(record.machineId, timeline);
    }
    addIndex(indexes.type, record.type, record.id);
    addIndex(indexes.machine, record.machineId, record.id);
    addIndex(indexes.entity, record.entityId, record.id);
    addIndex(indexes.case, record.caseId, record.id);
    for (const diskId of record.diskIds || []) addIndex(indexes.disk, diskId, record.id);
    if (record.health === true || record.type === "inventory" || record.type === "health.observation") {
      addIndex(indexes.health, "true", record.id);
    }
    for (const token of tokenize([
      record.type, record.machineId, record.entityId, record.caseId, ...(record.diskIds || []), record.text,
    ].filter(Boolean).join(" "))) addIndex(indexes.text, token, record.id);
    return true;
  }

  function upsertInventoryEntities(machineId, agentId, inventory, timestamp) {
    const machine = graph.getEntity(machineId);
    if (agentId) {
      const agent = graph.upsertEntity({
        id: stableId("agent", { agentId }), type: "agent", agentId,
        mode: inventory.agent?.mode || inventory.mode || "", capabilities: inventory.agent?.capabilities || inventory.capabilities || {},
        observedAt: timestamp,
      });
      graph.link({ from: machineId, to: agent.id, relation: "has-agent", timestamp });
    }
    const system = inventory.system || {};
    const installationKey = inventory.osInstallationId || system.machineId || system.installationId
      || inventory.rootFilesystemUuid || inventory.block?.filesystems?.find((item) => item.mountpoints?.includes("/"))?.uuid;
    if (installationKey || system.osRelease || system.platform) {
      const installation = graph.upsertEntity({
        id: stableId("os", { machineId, installationKey: installationKey || canonicalJson(system.osRelease || system) }),
        type: "os-installation", machineId, installationKey: installationKey || null,
        hostname: system.hostname || "", platform: system.platform || "", release: system.release || "",
        osRelease: system.osRelease || {}, observedAt: timestamp,
      });
      graph.link({ from: machineId, to: installation.id, relation: "runs-os-installation", timestamp });
    }
    const bootId = inventory.bootId || inventory.agent?.bootId;
    if (bootId) {
      const boot = graph.upsertEntity({
        id: stableId("boot", { machineId, bootId }), type: "boot-session", machineId, bootId,
        identity: inventory.bootIdentity || inventory.firmware || {}, observedAt: timestamp,
      });
      graph.link({ from: machineId, to: boot.id, relation: "booted-as", timestamp });
    }
    const deviceEntities = new Map();
    for (const device of inventory.block?.devices || []) {
      const deviceKey = device.deviceId || device.wwn || device.serial || device.partitionUuid || device.filesystemUuid || device.path;
      if (!deviceKey) continue;
      const type = device.type === "disk" ? "disk" : device.type === "part" || device.type === "partition" ? "partition" : "volume";
      const entity = graph.upsertEntity({
        ...clone(device), id: stableId(type, { machineId, deviceKey }), type, machineId, deviceKey, observedAt: timestamp,
      });
      deviceEntities.set(device.path || device.canonicalPath || deviceKey, entity);
      graph.link({ from: machineId, to: entity.id, relation: type === "disk" ? "has-disk" : "has-storage", timestamp });
      if (device.parent && deviceEntities.has(device.parent)) {
        graph.link({ from: deviceEntities.get(device.parent).id, to: entity.id, relation: "contains", timestamp });
      }
    }
    for (const filesystem of inventory.block?.filesystems || []) {
      const key = filesystem.uuid || filesystem.deviceId || filesystem.path || `${filesystem.type}:${filesystem.label}`;
      if (!key) continue;
      const entity = graph.upsertEntity({
        ...clone(filesystem), id: stableId("filesystem", { machineId, key }), type: "filesystem", machineId, observedAt: timestamp,
      });
      graph.link({ from: machineId, to: entity.id, relation: "has-filesystem", timestamp });
    }
    for (const network of inventory.network?.interfaces || []) {
      const key = network.mac || network.address || network.ifindex || network.ifname || network.name;
      if (!key) continue;
      const entity = graph.upsertEntity({
        ...clone(network), id: stableId("network", { machineId, key }), type: "network-interface", machineId, observedAt: timestamp,
      });
      graph.link({ from: machineId, to: entity.id, relation: "has-network-interface", timestamp });
    }
    return machine;
  }

  function rebuildGraphForEvent(record, { skipIdentity = false } = {}) {
    const payload = record.payload || {};
    const identity = record.type === "inventory"
      ? inventoryIdentity(payload.agentId || record.agentId, payload.inventory || {})
      : eventIdentity(payload);
    if (record.machineId && !skipIdentity) graph.correlateIdentity({ ...identity, machineId: record.machineId, timestamp: record.timestamp });
    if (record.type === "inventory") {
      upsertInventoryEntities(record.machineId, payload.agentId || record.agentId, payload.inventory || {}, record.timestamp);
    } else if (record.type === "boot") {
      const boot = graph.upsertEntity({
        ...clone(payload), id: stableId("boot", { machineId: record.machineId, bootId: payload.bootId || record.id }),
        type: "boot-session", machineId: record.machineId, observedAt: record.timestamp,
      });
      graph.link({ from: record.machineId, to: boot.id, relation: "booted-as", timestamp: record.timestamp });
    } else if (record.type === "case.event" && record.caseId) {
      const caseEntity = graph.upsertEntity({
        id: stableId("case", { caseId: record.caseId }), type: "case", caseId: record.caseId,
        state: payload.state || payload.event?.state || "", observedAt: record.timestamp,
      });
      graph.link({ from: record.machineId, to: caseEntity.id, relation: "has-recovery-case", timestamp: record.timestamp });
      const jobId = payload.jobId || payload.event?.jobId;
      if (jobId) {
        const job = graph.upsertEntity({ id: stableId("job", { jobId }), type: "job", jobId, observedAt: record.timestamp });
        graph.link({ from: caseEntity.id, to: job.id, relation: "contains-job", timestamp: record.timestamp });
      }
    } else {
      const explicitEntity = payload.entity && typeof payload.entity === "object" ? payload.entity : null;
      const normalizedType = explicitEntity?.type || ({
        snapshot: "snapshot", "snapshot.created": "snapshot",
        artifact: "artifact", "artifact.created": "artifact",
        job: "job", "job.created": "job",
        "file-set": "file-set", "fileset.created": "file-set",
        "health.observation": "health-observation",
      }[record.type]);
      if (normalizedType) {
        const entity = graph.upsertEntity({
          ...(explicitEntity || clone(payload)),
          id: explicitEntity?.id || record.entityId || stableId(normalizedType.replaceAll("-", ""), {
            machineId: record.machineId, eventId: record.id,
          }),
          type: normalizedType,
          machineId: record.machineId,
          observedAt: record.timestamp,
        });
        graph.link({ from: record.machineId, to: entity.id, relation: `has-${normalizedType}`, timestamp: record.timestamp });
      }
    }
  }

  async function loadJournal() {
    let bytes;
    try {
      bytes = await fs.readFile(paths.events);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const text = bytes.toString("utf8");
    const lines = text.split("\n");
    let validBytes = 0;
    let lastValidEnd = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const encodedLength = Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0);
      if (!line.trim()) {
        validBytes += encodedLength;
        lastValidEnd = validBytes;
        continue;
      }
      try {
        const record = JSON.parse(line);
        if (!record?.id || !record?.timestamp || !record?.type) throw new Error("missing event fields");
        const safe = jsonSafe(record);
        indexEvent(safe);
        rebuildGraphForEvent(safe);
        validBytes += encodedLength;
        lastValidEnd = validBytes;
      } catch (cause) {
        const remainingNonEmpty = lines.slice(index + 1).some((candidate) => candidate.trim());
        if (remainingNonEmpty) {
          const error = new Error(`Corrupt continuity journal before final record at line ${index + 1}: ${cause.message}`);
          error.code = "ERR_WW_CONTINUITY_JOURNAL";
          throw error;
        }
        recoveredTailBytes = bytes.length - lastValidEnd;
        if (recoveredTailBytes > 0) {
          await fs.mkdir(path.dirname(paths.quarantine), { recursive: true });
          await fs.writeFile(paths.quarantine, bytes.subarray(lastValidEnd), { flag: "a", mode: 0o600 });
          await fs.truncate(paths.events, lastValidEnd);
        }
        break;
      }
    }
  }

  async function init() {
    if (initialized && !closed) return api;
    await fs.mkdir(path.dirname(paths.events), { recursive: true });
    await fs.mkdir(path.dirname(paths.index), { recursive: true });
    await loadJournal();
    appendHandle = await fs.open(paths.events, "a", 0o600);
    initialized = true;
    closed = false;
    return api;
  }

  function enqueue(operation) {
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  }

  async function append(record) {
    assertOpen();
    if (events.has(record.id)) return clone(events.get(record.id));
    await appendHandle.write(`${JSON.stringify(record)}\n`);
    if (options.durability === "fsync") await appendHandle.sync();
    indexEvent(record);
    return clone(record);
  }

  function observationRecord(kind, input, machineId, extra = {}) {
    const source = jsonSafe(input, `${kind} observation`);
    const timestamp = pickTimestamp(source);
    const id = String(source.id || source.eventId || source.observationId || stableId("event", { kind, source }));
    return {
      id, schemaVersion: SCHEMA_VERSION, timestamp, type: kind, machineId,
      agentId: String(extra.agentId || source.agentId || ""),
      entityId: String(extra.entityId || source.entityId || ""),
      caseId: String(extra.caseId || source.caseId || ""),
      diskIds: [...new Set((extra.diskIds || source.diskIds || []).filter(Boolean).map(String))],
      health: extra.health === true || source.health === true,
      text: String(extra.text || source.text || source.message || source.hostname || ""),
      payload: source,
      ingestedAt: iso(),
    };
  }

  function sourceEventId(kind, input) {
    return String(input?.id || input?.eventId || input?.observationId || stableId("event", {
      kind, source: jsonSafe(input, `${kind} observation`),
    }));
  }

  function ingestObservation(input = {}) {
    return enqueue(async () => {
      assertOpen();
      const kind = String(input.type || "observation");
      const existing = events.get(sourceEventId(kind, input));
      if (existing) return clone(existing);
      const identity = graph.correlateIdentity(eventIdentity(input));
      const record = observationRecord(kind, input, identity.machineId, {
        text: [input.text, input.message, input.hostname, input.name].filter(Boolean).join(" "),
        diskIds: input.diskIds || input.disks?.map((item) => item.deviceId || item.id),
        health: input.health === true || Boolean(input.metrics),
      });
      const result = await append(record);
      rebuildGraphForEvent(record, { skipIdentity: true });
      return result;
    });
  }

  function ingestInventory(agentId, inventory = {}) {
    return enqueue(async () => {
      assertOpen();
      const safeInventory = jsonSafe(inventory, "inventory");
      const source = { agentId: String(agentId), inventory: safeInventory, timestamp: safeInventory.collectedAt || safeInventory.timestamp };
      const existing = events.get(sourceEventId("inventory", source));
      if (existing) return clone(existing);
      const identity = graph.correlateIdentity({
        ...inventoryIdentity(agentId, safeInventory), timestamp: safeInventory.collectedAt || safeInventory.timestamp,
      });
      upsertInventoryEntities(identity.machineId, agentId, safeInventory, pickTimestamp(safeInventory));
      const diskIds = (safeInventory.block?.devices || []).map((item) => item.deviceId || item.wwn || item.serial).filter(Boolean);
      const record = observationRecord("inventory", source, identity.machineId, {
        agentId, diskIds, health: true, text: inventoryText(agentId, safeInventory),
      });
      return append(record);
    });
  }

  function ingestBoot(input = {}) {
    return enqueue(async () => {
      assertOpen();
      const existing = events.get(sourceEventId("boot", input));
      if (existing) return clone(existing);
      const identity = graph.correlateIdentity(eventIdentity(input));
      const record = observationRecord("boot", input, identity.machineId, {
        text: [input.bootId, input.hostname, input.mode, input.kernel].filter(Boolean).join(" "),
      });
      const result = await append(record);
      rebuildGraphForEvent(record, { skipIdentity: true });
      return result;
    });
  }

  function ingestCaseEvent(input = {}) {
    return enqueue(async () => {
      assertOpen();
      const existing = events.get(sourceEventId("case.event", input));
      if (existing) return clone(existing);
      const resolved = input.machineId ? graph.resolveMachine(input.machineId) : graph.resolveMachine(input);
      const identity = resolved ? { machineId: resolved.id } : graph.correlateIdentity(eventIdentity(input));
      const event = input.event && typeof input.event === "object" ? input.event : input;
      const caseId = String(input.caseId || event.caseId || "");
      if (!caseId) throw new TypeError("Case event requires caseId.");
      const record = observationRecord("case.event", input, identity.machineId, {
        caseId, text: [event.type, event.message, event.goal, event.jobId].filter(Boolean).join(" "),
      });
      const result = await append(record);
      rebuildGraphForEvent(record, { skipIdentity: true });
      return result;
    });
  }

  function listMachines(query = {}) {
    assertOpen();
    const text = String(typeof query === "string" ? query : query.text || query.query || "").toLocaleLowerCase();
    const output = [...machines].map((machineId) => getMachine(machineId)).filter(Boolean);
    return output.filter((machine) => !text || canonicalJson(machine).toLocaleLowerCase().includes(text))
      .sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)));
  }

  function getMachine(machineId) {
    assertOpen();
    const entity = graph.getEntity(String(machineId));
    if (!entity || entity.type !== "physical-machine") return null;
    const timeline = machineTimelines.get(entity.id) || [];
    const latestInventory = latestAt(timeline, "", (record) => record.type === "inventory");
    return {
      ...entity,
      id: entity.id,
      firstSeenAt: timeline[0]?.timestamp || entity.firstSeenAt || entity.createdAt,
      lastSeenAt: timeline.at(-1)?.timestamp || entity.lastSeenAt || entity.updatedAt,
      eventCount: timeline.length,
      latestInventory: latestInventory?.payload?.inventory || null,
      identity: graph.explainIdentity(entity.id),
    };
  }

  function getTimeline(machineId, query = {}) {
    assertOpen();
    const resolved = graph.resolveMachine(machineId);
    if (!resolved) return [];
    const timeline = machineTimelines.get(resolved.id) || [];
    const from = query.from ? iso(query.from) : "";
    const to = query.to ? iso(query.to) : "";
    let output = timeline.slice(from ? lowerBound(timeline, from) : 0);
    if (to) output = output.slice(0, lowerBound(output, `${to}\uffff`));
    output = output
      .filter((record) => !query.type || record.type === query.type)
      .filter((record) => !query.caseId || record.caseId === query.caseId)
      .filter((record) => !query.diskId || record.diskIds.includes(query.diskId));
    if (query.reverse) output.reverse();
    if (Number(query.limit) > 0) output = output.slice(0, Number(query.limit));
    return output.map(clone);
  }

  function diffMachine(machineId, from, to) {
    assertOpen();
    const resolved = graph.resolveMachine(machineId);
    if (!resolved) return null;
    const timeline = machineTimelines.get(resolved.id) || [];
    const leftEvent = latestAt(timeline, from ? iso(from) : "", (record) => record.type === "inventory");
    const rightEvent = latestAt(timeline, to ? iso(to) : "", (record) => record.type === "inventory");
    if (!leftEvent || !rightEvent) return {
      id: stableId("machinediff", { machineId: resolved.id, from: from || null, to: to || null }),
      timestamp: iso(), machineId: resolved.id, from: leftEvent?.timestamp || null, to: rightEvent?.timestamp || null,
      available: false, reason: "Two inventory versions are required for a semantic diff.",
    };
    const left = leftEvent.payload.inventory || {};
    const right = rightEvent.payload.inventory || {};
    const deviceKey = (item) => item.deviceId || item.wwn || item.serial || item.partitionUuid || item.path;
    const fsKey = (item) => item.uuid || item.deviceId || item.path || `${item.type}:${item.label}`;
    const healthKey = (item) => item.deviceId || item.serial || item.path || item.model || "unknown";
    const hardware = mapDiff(
      objectMap(left.block?.devices, deviceKey), objectMap(right.block?.devices, deviceKey),
    );
    const filesystems = mapDiff(
      objectMap(left.block?.filesystems, fsKey), objectMap(right.block?.filesystems, fsKey),
    );
    const diskHealth = mapDiff(
      objectMap([...(left.health?.smart || []), ...(left.health?.nvme || [])], healthKey),
      objectMap([...(right.health?.smart || []), ...(right.health?.nvme || [])], healthKey),
    );
    const bootLeft = { bootId: left.bootId || left.agent?.bootId || null, firmware: left.firmware || null };
    const bootRight = { bootId: right.bootId || right.agent?.bootId || null, firmware: right.firmware || null };
    const softwareLeft = { system: left.system || {}, osInstallationId: left.osInstallationId || null };
    const softwareRight = { system: right.system || {}, osInstallationId: right.osInstallationId || null };
    const capabilitiesLeft = left.agent?.capabilities || left.capabilities || left.tools || {};
    const capabilitiesRight = right.agent?.capabilities || right.capabilities || right.tools || {};
    return {
      id: stableId("machinediff", { machineId: resolved.id, from: leftEvent.timestamp, to: rightEvent.timestamp }),
      timestamp: iso(), machineId: resolved.id, from: leftEvent.timestamp, to: rightEvent.timestamp, available: true,
      hardware,
      diskHealth,
      filesystems,
      boot: canonicalJson(bootLeft) === canonicalJson(bootRight) ? null : { from: bootLeft, to: bootRight },
      software: canonicalJson(softwareLeft) === canonicalJson(softwareRight) ? null : { from: softwareLeft, to: softwareRight },
      agentCapabilities: canonicalJson(capabilitiesLeft) === canonicalJson(capabilitiesRight)
        ? null : { from: clone(capabilitiesLeft), to: clone(capabilitiesRight) },
      changed: Boolean(hardware.added.length || hardware.removed.length || hardware.changed.length
        || diskHealth.added.length || diskHealth.removed.length || diskHealth.changed.length
        || filesystems.added.length || filesystems.removed.length || filesystems.changed.length
        || canonicalJson(bootLeft) !== canonicalJson(bootRight)
        || canonicalJson(softwareLeft) !== canonicalJson(softwareRight)
        || canonicalJson(capabilitiesLeft) !== canonicalJson(capabilitiesRight)),
    };
  }

  function intersect(sets) {
    if (!sets.length) return null;
    const orderedSets = sets.slice().sort((left, right) => left.size - right.size);
    return new Set([...orderedSets[0]].filter((id) => orderedSets.slice(1).every((set) => set.has(id))));
  }

  function search(query = {}) {
    assertOpen();
    const filters = typeof query === "string" ? { text: query } : query || {};
    const sets = [];
    const use = (index, value) => {
      if (value !== undefined && value !== null && value !== "") sets.push(index.get(String(value)) || new Set());
    };
    use(indexes.type, filters.type);
    use(indexes.machine, filters.machineId || filters.machine);
    use(indexes.entity, filters.entityId || filters.entity);
    use(indexes.case, filters.caseId || filters.case);
    use(indexes.disk, filters.diskId || filters.disk);
    if (filters.health === true) use(indexes.health, "true");
    for (const token of tokenize(filters.text || filters.query || "")) use(indexes.text, token);
    const candidates = intersect(sets);
    const from = filters.from ? iso(filters.from) : "";
    const to = filters.to ? iso(filters.to) : "";
    let output;
    if (candidates) {
      output = [...candidates].map((id) => events.get(id)).filter(Boolean)
        .filter((record) => !from || record.timestamp >= from)
        .filter((record) => !to || record.timestamp <= to)
        .sort(compareTime);
    } else {
      const start = from ? lowerBound(ordered, from) : 0;
      const end = to ? lowerBound(ordered, `${to}\uffff`) : ordered.length;
      output = ordered.slice(start, end);
    }
    if (filters.reverse) output.reverse();
    if (Number(filters.limit) > 0) output = output.slice(0, Number(filters.limit));
    return output.map(clone);
  }

  async function compact() {
    return enqueue(async () => {
      assertOpen();
      await appendHandle.sync();
      await appendHandle.close();
      appendHandle = null;
      const temporary = `${paths.events}.${process.pid}.compact`;
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        for (const record of ordered) await handle.write(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, paths.events);
      await atomicJson(paths.graph, { schemaVersion: SCHEMA_VERSION, compactedAt: iso(), ...graph.serialize() });
      await atomicJson(paths.index, {
        schemaVersion: SCHEMA_VERSION, compactedAt: iso(), eventCount: events.size,
        journalBytes: (await fs.stat(paths.events)).size, machineCount: machines.size,
      });
      appendHandle = await fs.open(paths.events, "a", 0o600);
      return getStats();
    });
  }

  function getStats() {
    assertOpen();
    return {
      id: stableId("storestats", { root }), timestamp: iso(),
      schemaVersion: SCHEMA_VERSION, root, eventCount: events.size, machineCount: machines.size,
      entityCount: graph.serialize().entities.length, indexTerms: indexes.text.size,
      recoveredTailBytes, initialized, closed,
    };
  }

  async function close() {
    if (!initialized || closed) return;
    await tail.catch(() => {});
    if (appendHandle) {
      await appendHandle.sync();
      await appendHandle.close();
      appendHandle = null;
    }
    await atomicJson(paths.index, {
      schemaVersion: SCHEMA_VERSION, closedAt: iso(), eventCount: events.size,
      journalBytes: await fs.stat(paths.events).then((stat) => stat.size, () => 0), machineCount: machines.size,
    });
    await atomicJson(paths.graph, { schemaVersion: SCHEMA_VERSION, savedAt: iso(), ...graph.serialize() });
    closed = true;
  }

  const api = {
    init, close, ingestObservation, ingestInventory, ingestBoot, ingestCaseEvent,
    listMachines, getMachine, getTimeline, diffMachine, search, compact, getStats,
  };
  return api;
}

export { SCHEMA_VERSION as CONTINUITY_STORE_SCHEMA_VERSION };
