import path from "node:path";
import { createContinuityStore as createStore } from "./store.mjs";
import { createMachineGraph as createGraph, ENTITY_TYPES } from "./machine-graph.mjs";
import { createRecoveryVault as createVault } from "./vault.mjs";
import { createHealthIntelligence as createHealth } from "./health.mjs";

export const CONTINUITY_SCHEMA_VERSION = 1;

export function createContinuityStore(options = {}) {
  return createStore(options);
}

export function createMachineGraph(options = {}) {
  return createGraph(options);
}

export function createRecoveryVault(options = {}) {
  return createVault(options);
}

export function createHealthIntelligence(options = {}) {
  return createHealth(options);
}

export function getContinuityCapabilities() {
  return {
    schemaVersion: CONTINUITY_SCHEMA_VERSION,
    entityTypes: [...ENTITY_TYPES],
    store: {
      backend: "append-only-jsonl",
      durableIndexes: true,
      relocatable: true,
      searches: ["time-range", "entity", "machine", "case", "disk", "text", "health"],
      semanticDiffs: ["hardware", "disk-health", "filesystem", "boot", "software-os", "agent-capability"],
    },
    vault: {
      backends: ["filesystem"],
      objectHash: "sha256",
      deterministicChunking: "fixed-size",
      resume: ["ingest", "restore"],
      operations: ["snapshot", "restore", "diff", "scrub", "prune", "artifact-import", "stream-ingest"],
    },
    health: {
      ruleVersion: 1,
      metrics: [
        "SMART health", "NVMe health", "temperature", "media errors", "wear", "unsafe shutdowns",
        "disk capacity", "filesystem usage", "RAID state", "boot identity", "kernel storage warnings",
        "agent reachability", "tool coverage", "observation freshness",
      ],
      recommendations: [
        "snapshot-now", "collect-full-inventory", "run-long-SMART-test", "prepare-ddrescue",
        "verify-vault", "replace-disk",
      ],
    },
    cliCommands: [
      "machines", "show", "timeline", "diff", "search", "health", "vault stats",
      "vault snapshots", "vault snapshot", "vault restore", "vault diff", "vault scrub", "vault prune",
    ],
  };
}

function parseArguments(argv) {
  const values = [...argv].map(String);
  if (values[0] === "continuity") values.shift();
  const positional = [];
  const flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals > 2) {
      flags[value.slice(2, equals)] = value.slice(equals + 1);
      continue;
    }
    const key = value.slice(2);
    if (["json", "execute", "force", "pinned"].includes(key)) flags[key] = true;
    else {
      const next = values[index + 1];
      if (next === undefined || next.startsWith("--")) throw new TypeError(`--${key} requires a value.`);
      flags[key] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

function outputWriter(target, fallback) {
  if (typeof target === "function") return target;
  if (target && typeof target.write === "function") return (value) => target.write(value);
  return (value) => fallback.write(value);
}

function machineByInput(store, input) {
  return store.getMachine(input) || store.listMachines().find((item) => (
    item.name === input
    || item.identity?.evidence?.some((evidence) => evidence.value === String(input).toLocaleLowerCase())
  )) || null;
}

function human(value) {
  if (Array.isArray(value)) {
    if (!value.length) return "No records.\n";
    return `${value.map((item) => {
      if (item && typeof item === "object") {
        return [item.id || item.snapshotId || item.timestamp || "", item.name || item.type || item.kind || item.status || "", item.message || item.label || ""]
          .filter(Boolean).join("\t");
      }
      return String(item);
    }).join("\n")}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function runContinuityCli(argv, io = {}) {
  const write = outputWriter(io.stdout || io.write, process.stdout);
  const writeError = outputWriter(io.stderr || io.writeError, process.stderr);
  let parsed;
  try {
    parsed = parseArguments(Array.isArray(argv) ? argv : []);
  } catch (error) {
    writeError(`continuity: ${error.message}\n`);
    return 2;
  }
  const { positional, flags } = parsed;
  const [command, ...args] = positional;
  if (!command) {
    writeError("continuity: a command is required.\n");
    return 2;
  }
  const root = path.resolve(io.root || process.env.WW_CONTINUITY_ROOT || path.join(process.cwd(), ".workwire", "continuity"));
  let store = io.store;
  let vault = io.vault;
  let health = io.health;
  let ownStore = false;
  let ownVault = false;
  const emit = (value) => write(flags.json ? `${JSON.stringify(value)}\n` : human(value));

  async function requireStore() {
    if (!store) {
      store = createStore({ root: path.join(root, "history") });
      ownStore = true;
    }
    await store.init();
    return store;
  }

  async function requireVault() {
    if (!vault) {
      vault = createVault({ root: path.join(root, "vault") });
      ownVault = true;
    }
    await vault.init();
    return vault;
  }

  function requireCount(values, count, usage) {
    if (values.length < count) throw new TypeError(`Usage: continuity ${usage}`);
  }

  function requireExact(values, count, usage) {
    if (values.length !== count) throw new TypeError(`Usage: continuity ${usage}`);
  }

  try {
    if (command === "machines") {
      if (args.length) throw new TypeError("Usage: continuity machines [--json]");
      emit((await requireStore()).listMachines());
    } else if (command === "show") {
      requireExact(args, 1, "show MACHINE");
      const value = machineByInput(await requireStore(), args[0]);
      if (!value) throw new Error(`Machine not found: ${args[0]}`);
      emit(value);
    } else if (command === "timeline") {
      requireExact(args, 1, "timeline MACHINE");
      const currentStore = await requireStore();
      const machine = machineByInput(currentStore, args[0]);
      if (!machine) throw new Error(`Machine not found: ${args[0]}`);
      emit(currentStore.getTimeline(machine.id, { from: flags.from, to: flags.to, type: flags.type, limit: flags.limit }));
    } else if (command === "diff") {
      requireExact(args, 1, "diff MACHINE --from TIME --to TIME");
      if (!flags.from || !flags.to) throw new TypeError("continuity diff requires --from and --to.");
      const currentStore = await requireStore();
      const machine = machineByInput(currentStore, args[0]);
      if (!machine) throw new Error(`Machine not found: ${args[0]}`);
      emit(currentStore.diffMachine(machine.id, flags.from, flags.to));
    } else if (command === "search") {
      requireCount(args, 1, "search QUERY");
      emit((await requireStore()).search({ text: args.join(" "), from: flags.from, to: flags.to, limit: flags.limit }));
    } else if (command === "health") {
      requireExact(args, 1, "health MACHINE");
      const currentStore = await requireStore();
      const machine = machineByInput(currentStore, args[0]);
      if (!machine) throw new Error(`Machine not found: ${args[0]}`);
      health ||= createHealth();
      for (const event of currentStore.getTimeline(machine.id, { type: "inventory" })) {
        health.observe(machine.id, event.payload.inventory);
      }
      emit({ ...health.evaluate(machine.id), recommendations: health.recommendations(machine.id) });
    } else if (command === "vault") {
      const [subcommand, ...vaultArgs] = args;
      if (!subcommand) throw new TypeError("Usage: continuity vault COMMAND");
      // Validate all destructive/mutating command input before initializing the repository.
      let policy = null;
      if (subcommand === "prune") {
        if (!flags.policy) throw new TypeError("continuity vault prune requires --policy JSON.");
        try { policy = JSON.parse(flags.policy); } catch (error) { throw new TypeError(`Invalid prune policy JSON: ${error.message}`); }
        if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError("Prune policy must be a JSON object.");
      }
      if (subcommand === "snapshot" && !vaultArgs.length) throw new TypeError("Usage: continuity vault snapshot PATH...");
      if (subcommand === "restore") requireExact(vaultArgs, 2, "vault restore SNAPSHOT DESTINATION");
      if (subcommand === "diff") requireExact(vaultArgs, 2, "vault diff LEFT RIGHT");
      if (["stats", "snapshots", "scrub", "prune"].includes(subcommand) && vaultArgs.length) {
        throw new TypeError(`Usage: continuity vault ${subcommand}`);
      }
      if (!["stats", "snapshots", "snapshot", "restore", "diff", "scrub", "prune"].includes(subcommand)) {
        throw new TypeError(`Unknown continuity vault command: ${subcommand}`);
      }
      const currentVault = await requireVault();
      if (subcommand === "stats") emit(await currentVault.getStats());
      else if (subcommand === "snapshots") emit(currentVault.listSnapshots({ kind: flags.kind, pinned: flags.pinned || undefined }));
      else if (subcommand === "snapshot") emit(await currentVault.snapshotPaths(vaultArgs, { pinned: flags.pinned, label: flags.label }));
      else if (subcommand === "restore") emit(await currentVault.restoreSnapshot(vaultArgs[0], vaultArgs[1], {
        path: flags.path, subtree: flags.subtree, force: flags.force,
      }));
      else if (subcommand === "diff") emit(currentVault.diffSnapshots(vaultArgs[0], vaultArgs[1]));
      else if (subcommand === "scrub") emit(await currentVault.scrub());
      else if (subcommand === "prune") emit(await currentVault.prune({ ...policy, execute: flags.execute === true }));
    } else {
      throw new TypeError(`Unknown continuity command: ${command}`);
    }
    return 0;
  } catch (error) {
    writeError(`continuity: ${error.message}\n`);
    if (io.throwOnError) throw error;
    return error instanceof TypeError ? 2 : 1;
  } finally {
    if (ownStore) await store.close().catch(() => {});
    if (ownVault) await vault.close().catch(() => {});
  }
}
