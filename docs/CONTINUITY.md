# WorkWire Archon continuity and recovery vault

The Agentic Archon maintains one durable historical model of each governed
machine and a local, content-addressed recovery repository. Continuity and the
recovery vault are capabilities of WorkWire’s local-first authority, not a
separate recovery product. They are offline-first libraries: the
implementation does not require a database server, network service, cloud
account, or encryption key.

The public module is `lib/continuity/index.mjs`. It exports exactly:

```js
export const CONTINUITY_SCHEMA_VERSION;
export function createContinuityStore(options = {});
export function createMachineGraph(options = {});
export function createRecoveryVault(options = {});
export function createHealthIntelligence(options = {});
export function getContinuityCapabilities();
export async function runContinuityCli(argv, io = {});
```

`CONTINUITY_SCHEMA_VERSION` is `1`. Records returned across this contract are JSON-serializable, retain unknown input fields where applicable, and use stable content-derived IDs plus ISO timestamps. `getContinuityCapabilities()` is the runtime source of truth for entity types, implemented searches/diffs, the filesystem vault backend, health metrics and recommendations, and CLI commands.

## Integration contract

P3 can construct the components directly without importing any recovery-lane implementation:

```js
import {
  createContinuityStore,
  createHealthIntelligence,
  createMachineGraph,
  createRecoveryVault,
  runContinuityCli,
} from "./lib/continuity/index.mjs";

const graph = createMachineGraph();
const store = createContinuityStore({
  root: "/operator/media/workwire/history",
  machineGraph: graph,
});
const vault = createRecoveryVault({
  root: "/operator/media/workwire/vault",
});
const health = createHealthIntelligence();

await store.init();
await vault.init();
```

The intended ingestion bridge is:

```js
const event = await store.ingestInventory(agentId, inventory);
health.observe(event.machineId, inventory);

await store.ingestBoot({
  machineId: event.machineId,
  bootId,
  timestamp,
  mode,
});

await store.ingestCaseEvent({
  machineId: event.machineId,
  caseId,
  event: recoveryEvent,
});

const snapshot = await vault.snapshotPaths(sourcePaths, { pinned, label });
await store.ingestObservation({
  id: `vault:${snapshot.id}`,
  type: "snapshot.created",
  timestamp: snapshot.createdAt,
  machineId: event.machineId,
  entity: { id: snapshot.id, type: "snapshot", manifest: snapshot },
});
```

Health state is deliberately rebuildable rather than a second durable authority. Inventories are durable in `ContinuityStore`; replay inventory timeline records into `health.observe()` after process start. `runContinuityCli(... health ...)` performs that replay automatically.

All required object methods are implemented. `ContinuityStore` and `RecoveryVault` require `init()` before use and should be closed with `close()`. Machine graph and health methods are immediately usable. Store/vault mutations serialize within a process. A single state root should have one writer process at a time.

For direct P3 CLI wiring:

```js
const exitCode = await runContinuityCli(argv, {
  root: "/operator/media/workwire/continuity",
  stdout: process.stdout,
  stderr: process.stderr,
});
```

P3 may instead inject already initialized `store`, `vault`, and `health` objects through `io`. Injected objects are not closed by the CLI. Invalid commands and invalid prune JSON are validated before a mutating repository is opened. `io.throwOnError` is available to test or host code that wants exceptions in addition to the exit code.

## Machine continuity graph

The graph models physical machines, identity aliases, boot sessions, OS installations, agents, disks, partitions, volumes, filesystems, network interfaces, snapshots, cases, jobs, artifacts, file sets, and health observations. Edges retain the evidence relationship rather than flattening everything into a current machine record.

Identity evidence is intentionally asymmetric:

| Evidence | Confidence | Merge behavior |
| --- | ---: | --- |
| Stable machine ID or explicit operator alias | 1.00 | Strong |
| DMI/system UUID | 0.99 | Strong |
| System serial | 0.97 | Strong |
| WorkWire peer ID | 0.96 | Strong |
| Physical MAC | 0.90 | Strong |
| Stable disk ID | 0.72 | Strong |
| Hostname | 0.30 | Explanatory only |
| IP address | 0.20 | Explanatory only |
| Boot ID | 0.10 | Explanatory only |

Hostname, DHCP address, and boot ID never merge two physical machines by themselves. If strong signals resolve to different existing machines, `correlateIdentity()` creates an isolated entity and records all candidates under `explainIdentity().ambiguities`; it does not silently merge. An explicit operator alias can correlate an OS reinstall even when DMI, hostname, IP, boot ID, agent mode, OS installation ID, or disk path changed.

Inventory ingestion preserves every distinct version. Exact replay returns the prior event by stable ID. An inventory materializes OS, agent, boot, storage, filesystem, and network entities while the immutable source inventory remains in the journal. `diffMachine()` selects the latest inventory at each requested time and reports:

- devices added, removed, or changed;
- SMART/NVMe health changes;
- filesystem identity or metadata changes;
- boot/firmware changes;
- OS and software metadata changes;
- agent capability changes.

`getTimeline()` uses a timestamp-sorted per-machine index. `search()` intersects in-memory indexes for type, machine, entity, case, disk, health, and normalized text; time-only queries use binary bounds over the timestamp index. Queries do not scan journal files.

## History data layout and crash recovery

For a store rooted at `ROOT`:

```text
ROOT/
  events/
    continuity.jsonl       append-only canonical source events
    abrupt-tail.bin        quarantined bytes from an incomplete final record
  indexes/
    continuity-index.json  rebuildable checkpoint/statistics
    machine-graph.json     rebuildable graph checkpoint
```

Each journal write is one complete JSONL record. A process death can leave only the currently written record incomplete; initialization accepts all prior complete records, quarantines the incomplete final bytes, truncates to the last valid boundary, and rebuilds every index. Corruption before the final record fails initialization instead of hiding lost history.

The default durability mode waits for the kernel to accept each whole append. `durability: "fsync"` additionally calls `fsync` for every event when power-loss durability is required. `close()` synchronizes the journal. `compact()` writes and synchronizes a complete temporary journal, atomically renames it, writes graph/index checkpoints atomically, and reopens append mode. Death before the rename leaves the old journal; death after it leaves the complete compacted journal.

All paths derive from the explicit `root`; no absolute machine-specific path is embedded in an index. A store can therefore move with recovery media and rebuild at the new mount point.

## Recovery vault format

For a vault rooted at `ROOT`:

```text
ROOT/
  objects/sha256/HH/REST   immutable chunk bytes, named by SHA-256
  manifests/SNAPSHOT.json immutable snapshot manifests
  operations/OPERATION.json
                            durable incomplete ingest/restore checkpoints
  state/last-scrub.json    latest complete scrub evidence
```

Files and streams are split into deterministic fixed chunks (1 MiB by default; `chunkSize` is configurable at construction). Every stored chunk filename is its SHA-256. Equal chunks from any file, disk image, artifact, or snapshot reuse one object globally. A manifest file contains relative path, type, size, mode, UID/GID when the platform provides them, timestamps, sparse indication, content identity, and ordered chunk extents.

All-zero chunks are represented as verified zero extents and consume no object bytes. Restore seeks over them and truncates to the exact logical size, allowing the destination filesystem to retain holes. Non-zero chunk memory is bounded by the configured chunk size plus stream buffering; file-sized buffering is not used.

`ingestFile()` creates a one-path immutable snapshot. `snapshotPaths()` accepts files and directory trees. `ingestArtifact()` uses the same object pool, so importing an existing WorkWire artifact does not duplicate matching bytes. `ingestStream()` accepts arbitrary readable streams, including disk/image streams.

Restore forms are:

```js
await vault.restoreSnapshot(snapshotId, destinationDirectory);
await vault.restoreSnapshot(snapshotId, destinationDirectory, { subtree: "root/logs" });
await vault.restoreSnapshot(snapshotId, destinationDirectory, { path: "root/file" });
await vault.restoreSnapshot(snapshotId, destinationFile, { path: "image.raw", asFile: true });
await vault.restoreSnapshot(snapshotId, writableStream, { path: "image.raw" });
```

Restored files are written to `.ww-vault-partial`, synchronized, verified chunk by chunk while reading, and atomically renamed. File and directory modes, ownership where permitted, and timestamps are applied. A selected stream restore requires exactly one file.

## Interruption and exact resume

Ingest checkpoints are committed after each complete chunk. They contain the exact next source offset and the hashes/extents already made durable. If an object was written but the process died before its checkpoint, it is merely an orphan or a deduplicated retry; no manifest references incomplete data.

File/tree resume:

```js
let checkpoint;
try {
  await vault.snapshotPaths(paths, { signal });
} catch (error) {
  checkpoint = { operationId: error.operationId, offset: error.resumeOffset };
}

const snapshot = await vault.snapshotPaths(paths, {
  operationId: checkpoint.operationId,
});
```

The resumed file stream opens at the durable offset rather than reading completed chunks again. For an arbitrary stream, pass a stream positioned at the reported offset and declare it:

```js
await vault.ingestStream(streamStartingAtOffset, {
  operationId: error.operationId,
  offset: error.resumeOffset,
});
```

If `offset` is omitted, a full replacement stream is also accepted and its already durable prefix is discarded; passing `offset` proves that the producer resumed at the exact checkpoint.

Restore derives a stable operation ID from snapshot, destination, and selection. Calling the same restore again automatically resumes its partial file at the saved chunk boundary. A crash after the final rename but before the next operation checkpoint is handled by verifying the completed target against every manifest chunk and advancing without rewriting it.

`getStats().incompleteOperationIds` exposes all durable checkpoints. Successful operations remove their checkpoint; no background cleanup deletes them.

## Scrub and retention

`scrub()` verifies:

- manifest JSON, schema version, content-derived manifest ID, safe paths, entry types, contiguous extents, sizes, and content identity;
- every reachable object exists and its bytes match the SHA-256 name;
- references from complete manifests and incomplete ingest operations;
- unreferenced/orphan objects.

The result lists invalid manifests, missing objects, corrupt objects with actual hashes, exact referring snapshot/operation IDs, and orphan objects. The latest result is durable and included in `getStats()`.

Pruning is always explicit and dry-run by default:

```js
await vault.prune({ keepLast: 10, hourly: 24, daily: 30, weekly: 12 });
await vault.prune({ keepLast: 10, hourly: 24, daily: 30, weekly: 12, execute: true });
```

`keepLast` (or `keep-last`) retains the newest count. `hourly`, `daily`, and `weekly` retain the newest manifest in each of that many UTC buckets. `before` additionally retains snapshots at or newer than that timestamp. Pinned snapshots are always retained. The dry report names every retained/pruned snapshot and removable object. Execution removes selected manifests first and then only objects unreachable from retained manifests or incomplete operations. There is no automatic retention timer.

Repository statistics include filesystem capacity/available/free bytes, unique object bytes, logical snapshot bytes, dedup ratio, object count, snapshot count, incomplete operations, and the last scrub result.

## Health intelligence

Health rules are a versioned array of ordinary JSON-compatible records (`ruleVersion: 1`) and can be replaced with `createHealthIntelligence({ rules })`. There is no policy language.

When facts exist, `observe()` normalizes series for:

- SMART assessment, pending/reallocated/uncorrectable sectors, errors, temperature, and power-on hours;
- NVMe warnings, media errors, error log entries, wear, available spare, unsafe shutdowns, and temperature;
- disk capacity, device presence, filesystem used percent, and RAID state;
- strong identity fingerprint, boot identity/failure count, kernel storage warnings, agent reachability, and tool coverage.

`evaluate()` detects thresholds, worsening counters, sudden device disappearance, strong identity drift, recurring boot failures, RAID degradation, capacity exhaustion, excessive temperature/wear, stale observation, and unavailable agents/tools. Findings contain a stable ID, severity, observed value, threshold when relevant, trend/delta, affected entity, source evidence, and recommended operation. Missing optional data is reported in `unknownMetrics` and never converted into a failure.

Recommendations are deduplicated actions for P3 to decide and execute: `snapshot-now`, `collect-full-inventory`, `run-long-SMART-test`, `prepare-ddrescue`, `verify-vault`, and `replace-disk`.

## Headless CLI

The library implements the complete surface below. Add `--json` anywhere for one JSON value; otherwise output is human-readable text. The CLI returns `0` for success, `2` for invalid input, and `1` for an operational failure.

```text
continuity machines
continuity show MACHINE
continuity timeline MACHINE [--from TIME] [--to TIME] [--type TYPE]
continuity diff MACHINE --from TIME --to TIME
continuity search QUERY [--from TIME] [--to TIME]
continuity health MACHINE
continuity vault stats
continuity vault snapshots
continuity vault snapshot PATH... [--pinned] [--label LABEL]
continuity vault restore SNAPSHOT DESTINATION [--path PATH | --subtree PATH]
continuity vault diff LEFT RIGHT
continuity vault scrub
continuity vault prune --policy JSON [--execute]
```

When instances are not injected, the CLI uses `io.root`, then `WW_CONTINUITY_ROOT`, then `<cwd>/.workwire/continuity`. History and vault data are separated under `history/` and `vault/`.

## Correctness and performance evidence

Focused verification:

```sh
node --test test/ww-continuity-*.test.mjs
```

Result on 2026-07-19: **15 passed, 0 failed**. The tests cover a 101-version explicitly correlated reinstall, reload and semantic diff, replay idempotency, abrupt-tail quarantine/index rebuild, ambiguity isolation, chunk-level dedup, interrupted ingest/restore offsets, file/subtree/tree/stream exact hashes, sparse extents, missing/corrupt scrub injection, artifact reuse, hourly retention, pinned reachability, realistic SMART/NVMe trends, identity/device drift, honest unknowns, CLI behavior, and the exact export list.

The reproducible history benchmark is:

```sh
node scripts/performance/continuity-history-benchmark.mjs \
  --events=100000 --inventories=100 --repeats=9 \
  --output=handoff/next-stage/results/p1-continuity-benchmark.json
```

Measured on Node 22.22.0, Linux 6.18.5, Intel i7-3770, ext4, with 100,000 generated events plus 100 inventory versions:

| Operation | Result |
| --- | ---: |
| Durable ingest | 47,490.297 ms; 2,107.8 records/s |
| Full journal reload and index/graph rebuild | 34,690.375 ms |
| Text search, 1,000 results | 18.509 ms median; 38.870 ms p95 |
| Machine+disk+case+health+time intersection, 2,000 results | 39.222 ms median; 47.118 ms p95 |
| Time-bounded timeline, 3,601 results | 65.088 ms median; 76.482 ms p95 |
| Semantic inventory diff | 0.307 ms median; 1.197 ms p95 |

The benchmark asserted 100,100 records before and after reload and one correlated physical machine. The measured query paths return cloned JSON records, not counts-only shortcuts. The 34.7-second full rebuild is an offline recovery path; ordinary startups can later consume a validated checkpoint without changing the canonical journal contract, but this implementation currently rebuilds from the journal for maximum recovery simplicity.

The final repository-wide `npm test` run executed 248 tests: 246 passed and two failed in concurrently changing recovery-lane files outside P1 ownership. The isolated failures were an action catalog count mismatch (`109 !== 101`) and a Windows inventory fixture error count (`5 !== 0`). Every continuity test passed in that same run, and the two failures reproduce when only those recovery tests are executed. No P1 regression was observed.

## Scope and physical validation

Encryption is out of scope. Hashes provide identity and corruption detection, not confidentiality or authenticity against a hostile writer. The filesystem backend is suitable for local disks, mounted NAS paths, and mounted removable media; no cloud adapter is included or advertised.

All destructive validation in tests uses temporary directories, generated byte corpora, sparse regular files, and injected interruption/corruption. No valuable disk or raw device was opened. Remaining physical-only validation is limited to exercising the same filesystem backend on the operator's actual NAS/removable mount, observing a real power cut with the optional per-record `fsync` mode, and restoring a disposable real block-device image. Those physical facts do not leave an unimplemented software path.
