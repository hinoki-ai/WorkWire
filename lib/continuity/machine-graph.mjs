import { clone, iso, stableId, jsonSafe } from "./util.mjs";

const ENTITY_TYPES = Object.freeze([
  "physical-machine", "identity-alias", "boot-session", "os-installation", "agent",
  "disk", "partition", "volume", "filesystem", "network-interface", "snapshot",
  "case", "job", "artifact", "file-set", "health-observation",
]);

const SIGNALS = Object.freeze({
  machineId: { confidence: 1, strong: true },
  stableMachineId: { confidence: 1, strong: true },
  dmiUuid: { confidence: 0.99, strong: true },
  systemUuid: { confidence: 0.99, strong: true },
  serial: { confidence: 0.97, strong: true },
  systemSerial: { confidence: 0.97, strong: true },
  peerId: { confidence: 0.96, strong: true },
  wwPeerId: { confidence: 0.96, strong: true },
  mac: { confidence: 0.9, strong: true },
  physicalMac: { confidence: 0.9, strong: true },
  diskId: { confidence: 0.72, strong: true },
  operatorAlias: { confidence: 1, strong: true, explicit: true },
  alias: { confidence: 1, strong: true, explicit: true },
  hostname: { confidence: 0.3, strong: false },
  ip: { confidence: 0.2, strong: false },
  bootId: { confidence: 0.1, strong: false },
});

function normalizedSignal(type, value) {
  let next = String(value ?? "").trim().toLocaleLowerCase();
  if (!next) return "";
  if (["mac", "physicalMac"].includes(type)) {
    const compact = next.replace(/[^0-9a-f]/g, "");
    if (!/^[0-9a-f]{12}$/.test(compact) || compact === "000000000000") return "";
    next = compact.match(/.{2}/g).join(":");
  }
  return next;
}

function signalPairs(observation = {}) {
  const identity = observation.identity && typeof observation.identity === "object" ? observation.identity : {};
  const pairs = [];
  const add = (type, value) => {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const normalized = normalizedSignal(type, item);
      if (normalized) pairs.push({ type, value: normalized, ...SIGNALS[type] });
    }
  };
  for (const type of Object.keys(SIGNALS)) add(type, observation[type] ?? identity[type]);
  for (const address of observation.addresses || identity.addresses || []) {
    add("physicalMac", address?.mac);
    add("ip", address?.address);
  }
  for (const network of observation.network?.interfaces || []) {
    add("physicalMac", network?.mac || network?.address);
    for (const address of network?.addr_info || network?.addresses || []) add("ip", address?.local || address?.address || address);
  }
  for (const disk of observation.disks || observation.block?.devices || []) {
    if (disk?.type === "disk" || !disk?.type) add("diskId", disk?.deviceId || disk?.wwn || disk?.serial);
  }
  return [...new Map(pairs.map((item) => [`${item.type}:${item.value}`, item])).values()];
}

export function createMachineGraph(options = {}) {
  const entities = new Map();
  const edges = new Map();
  const signalIndex = new Map();
  const explanations = new Map();

  function hydrate(state = options.state) {
    if (!state) return;
    for (const entity of state.entities || []) entities.set(entity.id, clone(entity));
    for (const edge of state.edges || []) edges.set(edge.id, clone(edge));
    for (const machine of entities.values()) {
      if (machine.type !== "physical-machine") continue;
      for (const signal of machine.identitySignals || []) {
        const key = `${signal.type}:${signal.value}`;
        const values = signalIndex.get(key) || new Set();
        values.add(machine.id);
        signalIndex.set(key, values);
      }
      explanations.set(machine.id, clone(machine.identityExplanation || { evidence: [], ambiguities: [] }));
    }
  }

  function upsertEntity(input = {}) {
    const record = jsonSafe(input, "entity");
    if (!ENTITY_TYPES.includes(record.type)) throw new TypeError(`Unknown continuity entity type: ${record.type}`);
    const timestamp = iso(record.updatedAt || record.observedAt || record.createdAt || Date.now());
    const id = String(record.id || stableId(record.type.replaceAll("-", ""), {
      type: record.type,
      stableKey: record.stableKey || record.deviceId || record.uuid || record.serial || record.name || record,
    }));
    const previous = entities.get(id);
    const next = {
      ...(previous || {}),
      ...record,
      id,
      type: record.type,
      createdAt: previous?.createdAt || iso(record.createdAt || timestamp),
      updatedAt: timestamp,
    };
    entities.set(id, next);
    return clone(next);
  }

  function link(input = {}) {
    const from = String(input.from || input.source || "");
    const to = String(input.to || input.target || "");
    if (!from || !to) throw new TypeError("Continuity edge requires from and to IDs.");
    const relation = String(input.relation || "related-to");
    const timestamp = iso(input.timestamp || input.observedAt || input.createdAt || Date.now());
    const id = String(input.id || stableId("edge", { from, to, relation, evidence: input.evidence || null }));
    const previous = edges.get(id);
    const next = {
      ...(previous || {}), ...jsonSafe(input), id, from, to, relation,
      confidence: Math.max(0, Math.min(1, Number(input.confidence ?? previous?.confidence ?? 1))),
      createdAt: previous?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    edges.set(id, next);
    return clone(next);
  }

  function correlateIdentity(observation = {}) {
    const input = jsonSafe(observation, "identity observation");
    const timestamp = iso(input.timestamp || input.observedAt || input.collectedAt || Date.now());
    const signals = signalPairs(input);
    const strongCandidates = new Map();
    const weakCandidates = new Map();
    for (const signal of signals) {
      const matches = signalIndex.get(`${signal.type}:${signal.value}`) || new Set();
      for (const machineId of matches) {
        const scores = signal.strong ? strongCandidates : weakCandidates;
        const existing = scores.get(machineId) || { score: 0, signals: [] };
        existing.score = Math.max(existing.score, signal.confidence);
        existing.signals.push(signal);
        scores.set(machineId, existing);
      }
    }
    const strongIds = [...strongCandidates.keys()];
    let machineId = "";
    let ambiguous = false;
    if (strongIds.length === 1) machineId = strongIds[0];
    else if (strongIds.length > 1) ambiguous = true;
    // Weak DHCP/hostname/boot evidence is explanatory only and never silently merges machines.
    if (!machineId) {
      machineId = String(input.machineId || input.stableMachineId || "");
      const normalizedRequested = normalizedSignal("machineId", machineId);
      if (normalizedRequested) {
        const indexed = signalIndex.get(`machineId:${normalizedRequested}`);
        if (indexed?.size === 1 && !ambiguous) machineId = [...indexed][0];
      }
    }
    if (!machineId || (ambiguous && !input.operatorAlias && !input.alias)) {
      machineId = stableId("machine", {
        strongest: signals.filter((signal) => signal.strong).map(({ type, value }) => ({ type, value })),
        discriminator: input.observationId || input.eventId || input.agentId || input.hostname || timestamp,
      });
    }
    if (!signals.some((signal) => signal.type === "machineId" && signal.value === normalizedSignal("machineId", machineId))) {
      signals.push({ type: "machineId", value: normalizedSignal("machineId", machineId), ...SIGNALS.machineId });
    }

    const previous = entities.get(machineId);
    const evidence = signals.map((signal) => ({
      type: signal.type,
      value: signal.value,
      confidence: signal.confidence,
      observedAt: timestamp,
      matched: (signalIndex.get(`${signal.type}:${signal.value}`) || new Set()).has(machineId),
    }));
    const knownSignals = new Map((previous?.identitySignals || []).map((signal) => [`${signal.type}:${signal.value}`, signal]));
    for (const signal of signals) knownSignals.set(`${signal.type}:${signal.value}`, {
      type: signal.type, value: signal.value, confidence: signal.confidence,
      firstSeenAt: knownSignals.get(`${signal.type}:${signal.value}`)?.firstSeenAt || timestamp,
      lastSeenAt: timestamp,
      explicit: signal.explicit === true,
    });
    const explanation = {
      machineId,
      confidence: ambiguous ? 0 : Math.max(0, ...evidence.filter((item) => item.matched).map((item) => item.confidence)),
      evidence,
      ambiguities: ambiguous ? [{
        observedAt: timestamp,
        candidateMachineIds: strongIds,
        reason: "Strong identity signals refer to multiple physical machines; no merge was performed.",
      }] : [],
      weakCandidates: [...weakCandidates.keys()],
    };
    const machine = upsertEntity({
      ...(previous || {}),
      id: machineId,
      type: "physical-machine",
      name: input.hostname || input.name || previous?.name || machineId,
      identitySignals: [...knownSignals.values()],
      identityExplanation: explanation,
      firstSeenAt: previous?.firstSeenAt || timestamp,
      lastSeenAt: timestamp,
      updatedAt: timestamp,
    });
    explanations.set(machineId, explanation);
    for (const signal of signals) {
      const key = `${signal.type}:${signal.value}`;
      const matches = signalIndex.get(key) || new Set();
      // Ambiguous evidence is retained on the new isolated entity, not added to global lookup,
      // otherwise it would manufacture additional ambiguous merges on every replay.
      if (!ambiguous || signal.explicit) matches.add(machineId);
      signalIndex.set(key, matches);
      const alias = upsertEntity({
        id: stableId("alias", { machineId, type: signal.type, value: signal.value }),
        type: "identity-alias", aliasType: signal.type, value: signal.value,
        confidence: signal.confidence, firstSeenAt: timestamp, lastSeenAt: timestamp,
      });
      link({ from: machineId, to: alias.id, relation: "identified-by", confidence: signal.confidence, timestamp });
    }
    return { machineId, machine, confidence: explanation.confidence, ambiguous, evidence: clone(evidence) };
  }

  function getEntity(id) {
    const record = entities.get(String(id));
    return record ? clone(record) : null;
  }

  function neighbors(id, query = {}) {
    const key = String(id);
    const direction = query.direction || "both";
    const values = [];
    for (const edge of edges.values()) {
      if (query.relation && edge.relation !== query.relation) continue;
      if ((direction === "both" || direction === "out") && edge.from === key) {
        values.push({ edge: clone(edge), entity: getEntity(edge.to), direction: "out" });
      }
      if ((direction === "both" || direction === "in") && edge.to === key) {
        values.push({ edge: clone(edge), entity: getEntity(edge.from), direction: "in" });
      }
    }
    return query.type ? values.filter((item) => item.entity?.type === query.type) : values;
  }

  function resolveMachine(input) {
    if (typeof input === "string") {
      const direct = entities.get(input);
      if (direct?.type === "physical-machine") return clone(direct);
      const normalized = input.trim().toLocaleLowerCase();
      const matches = new Set();
      for (const type of Object.keys(SIGNALS)) {
        for (const id of signalIndex.get(`${type}:${normalizedSignal(type, normalized)}`) || []) matches.add(id);
      }
      return matches.size === 1 ? getEntity([...matches][0]) : null;
    }
    const signals = signalPairs(input || {});
    const matches = new Set();
    for (const signal of signals.filter((item) => item.strong)) {
      for (const id of signalIndex.get(`${signal.type}:${signal.value}`) || []) matches.add(id);
    }
    return matches.size === 1 ? getEntity([...matches][0]) : null;
  }

  function explainIdentity(machineId) {
    const machine = entities.get(String(machineId));
    if (!machine || machine.type !== "physical-machine") return null;
    return clone(explanations.get(machine.id) || machine.identityExplanation || {
      machineId: machine.id, confidence: 0, evidence: [], ambiguities: [], weakCandidates: [],
    });
  }

  function serialize() {
    return {
      entities: [...entities.values()].map(clone),
      edges: [...edges.values()].map(clone),
    };
  }

  hydrate();
  return {
    correlateIdentity, upsertEntity, link, getEntity, neighbors, resolveMachine, explainIdentity,
    serialize,
  };
}

export { ENTITY_TYPES };
