# WorkWire Archon data capabilities

The Agentic Archon exposes data capabilities through three independent
engines: content-aware folder synchronization, managed disk
imaging/deployment, and priority-first filesystem salvage. They use ordinary
Node streams and filesystem primitives, keep their control records as
inspectable JSON, and accept injected adapters only where raw devices, native
inspection tools, remote machine execution, or the optional recovery vault are
involved. These are capabilities of WorkWire’s authority over operator-owned
machines, not separate product identities.

No engine selects a host disk implicitly. Imaging restore requires a concrete target path or a target returned by the injected executor. Salvage opens its source read-only and never renames, deletes, writes, or updates source metadata.

## Synchronization

Import `createWorkWireSyncEngine`, `compileSyncPolicy`, `getSyncCapabilities`, and `WW_SYNC_ENGINE_VERSION` from `lib/sync/index.mjs`. The stable engine surface is:

```text
init / close
addFolder / updateFolder / removeFolder
addPeer / updatePeer / removePeer
scan / sync / pause / resume
getFolderStatus / getPeerStatus
getConflicts / resolveConflict
getVersions / restoreVersion
onEvent
```

A folder owns a root, an explicit peer list, a mode (`send-receive`, `send-only`, `receive-only`, or `archive-only`), gitignore-style rules, a symlink policy, transfer concurrency, priority paths, a bandwidth ceiling, chunk size, and version retention. Rules are evaluated in order, support comments, `!` negation, anchored patterns, `*`, `**`, `?`, and directory suffixes, and expose `explain(path)` for an exact decision.

Scanning uses `lstat` and never follows a link by accident. `ignore` is the default. `preserve-link` transfers the link text. `follow-within-root` resolves the target and rejects a target outside the real folder root. A native watcher feeds a durable journal where the platform supports it. The journal only accelerates discovery: startup, watcher failure/overflow, and unsupported recursive watching always retain the full-tree correctness scan.

Files are identified by device, inode, size, mtime, and ctime before a cached SHA-256 may be reused. Size and mtime alone are never an equality decision. Fixed-size deterministic SHA-256 chunk manifests permit direct region reuse. A same-size/same-mtime test mutation changed one 64 KiB chunk in a 256 KiB file; WorkWire sent 65,536 bytes and reused 196,608 bytes.

Each active transfer has a JSON checkpoint and a private `.part` file below the engine state directory. A chunk is checkpointed only after it is written, synced, and hash checked. Restart rechecks completed temp chunks before skipping them. The prior destination is not renamed or removed until the entire temp file has the source content hash. Zero chunks are represented by a truncate plus omitted writes, preserving holes on filesystems that expose sparse allocation. Transfers run with bounded chunk buffers, configurable file concurrency, path priority, backpressure, pause/resume, and a bytes-per-second ceiling.

Before an overwrite or delete, the receiver records a version. Without a recovery vault, bytes go to a SHA-256 object beneath `versions/<prefix>/<hash>`. With an injected vault implementing `ingestFile` and `openObject`, the version points to the vault object and automatically shares its deduplicated storage. Conflicts store the last base observations, both machine identities, hashes, timestamps, and version IDs. Resolutions are `keep-left`, `keep-right`, `keep-both`, and operator-provided merged bytes or stream.

Direct engine peers negotiate a compatible protocol range rather than comparing application builds. A peer may instead name an ordinary local root, which is useful for mounted media, tests, and adapters. The existing `ww-mirror`, endpoint, client/service, explorer, copy/move, upload, trash, and download modules were not replaced or modified, so the original two-machine workflow remains available unchanged.

### Sync state format and recovery

`state.json` contains schema version, folders, serializable peer facts, last scans, per-peer baselines, statuses, journal entries, conflicts, versions, and transfer checkpoints. Unknown JSON fields survive ordinary reads because records are merged rather than exhaustively decoded.

After a crash:

1. Recreate the engine with the same `stateDir` and call `init()`.
2. Reattach runtime engine adapters with `updatePeer` if the peer was not configured by a durable `rootPath`.
3. Call `sync(folderId)`. Full scanning revalidates both sides and valid temp chunks are reused.
4. Inspect `getFolderStatus`, unresolved `getConflicts`, and `getVersions` before any manual cleanup.

Never delete the transfer directory to “fix” a stalled operation unless abandoning its verified resume progress is intended. The old destination remains the safe copy until final replacement.

## Imaging and deployment

Import `createImagingCatalog`, `createProvisioningEngine`, `getImagingCapabilities`, and `WW_IMAGING_VERSION` from `lib/imaging/index.mjs`.

The catalog supports `capture`/`captureImage`, `restore`/`restoreImage`, restore verification, catalog verification, inspection, listing/search, get, pin, clone, rename, export, import, explicit delete, peer registration, events, and statistics. Every image record includes:

- source machine and disk identity;
- geometry and logical size;
- partition table, contained filesystem facts, and boot mode;
- creation tool and creation time;
- compression and deterministic chunk manifest;
- per-chunk SHA-256 plus a SHA-256 tree hash;
- logical and stored sizes, labels, pin state, and verification state.

Capture reads one bounded chunk at a time from an ordinary/sparse file or an injected raw-source adapter. `none` and per-chunk `gzip` storage are available. All-zero chunks have a hash but no object. Nonzero objects use `objects/<prefix>/<hash>.<raw|gz>` and are automatically shared across images. Capture state records every completed verified boundary. Restore has an equivalent per-target chunk checkpoint, truncates to the image’s logical length, skips zero writes to preserve holes, fetches missing objects from registered LAN catalog peers, verifies every object before writing, and performs sample or full target verification.

Export is a transparent directory containing `manifest.json` plus encoded objects. Import verifies decoded length and SHA-256 before admitting each object. Inspection always returns manifest, partitions, hashes, filesystems, and minimum-target compatibility; an executor may add facts from native partition/filesystem tools without making those tools mandatory.

The optional source executor may implement either `resolveSource` with a bounded `read(offset, length)` function, or `statSource` plus `readSourceChunk`. A target executor implements `resolveTarget` and returns a bounded writer. Native image inspection uses `inspectImage`.

Provisioning plans are deterministic JSON: source image, each machine’s resolved/selected target, preflight facts, ordered steps, verification, and rollout. Ordered deployment bundles contain only editable `file` and `command` entries; there is no package-manager abstraction. Rollouts support all-at-once, bounded parallel, canary-then-rest, and sequential stop-on-first-failure. Execution requires a real injected `executeMachine`/`runStep` adapter (or a concrete catalog restore where applicable); absence is an error, never simulated success. Reports place intended and observed facts beside each other for every machine and aggregate complete, failed, and skipped counts.

### Imaging recovery

Reopen the catalog with the same `storagePath`, call `init()`, and repeat capture with the same `id`/`captureId` or restore to the same target with the same `restoreId`. Only completed chunk boundaries are skipped. Run `verifyImage(id)` before deployment and full restore verification when the target is suspect. A missing object can be reseeded by `addPeer({ id, catalog })`; it is decoded and hash checked before entering local storage. Export a pinned known-good image before explicitly deleting its last local catalog copy.

## Priority salvage

Import `createSalvageEngine`, `getSalvageCapabilities`, and `WW_SALVAGE_VERSION` from `lib/salvage/index.mjs`.

`inventory` walks directory metadata with `readdir`/`lstat`; it does not open every discovered file. Symlinks are recorded as ignored and never followed. Operator rules and explicit paths are assigned before the built-in order:

1. explicit paths;
2. documents;
3. source/code;
4. credentials/configuration;
5. small files;
6. photos/media;
7. everything else.

`estimateCapacity` reports cumulative fit at every priority level. `buildPlan` assigns the sorted queue across healthy destinations with deterministic round-robin spill while honoring each destination’s available bytes and reserve. Unassigned files are reported missing rather than silently displaced.

`run`/`recover`/`resume` copies fixed bounded chunks into a private destination-side part file. Offset, retry count, read errors, partial state, bytes written, source mapping, and exact destination mapping are persisted after each synced chunk. Restart hashes the healthy temp prefix, continues at the durable offset, and never recopies a previously completed file whose full destination SHA-256 still verifies. Exhausted reads yield `partial` when any prefix was recovered and `corrupt` when nothing was readable; lower-priority files continue unless configured otherwise.

Verified duplicate content is hard-linked when the destination filesystem permits it, with a clone/copy fallback when it does not. The final report distinguishes recovered, missing, partial, and corrupt files, includes every read error and retry, reports deduplicated bytes, and carries a machine-readable checksum manifest. `getChecksumManifest(..., { format: "sha256sum" })` provides the conventional text form. `preview` returns metadata plus a stream capped at 1 MiB; it never buffers a large file.

An optional ddrescue mapfile is parsed into readable, bad, and pending ranges. If the operator supplies a file-to-device-range mapper, inventory annotates files intersecting known bad ranges. Ordinary filesystem salvage does not require ddrescue.

### Salvage recovery

Keep the source mounted read-only, recreate the engine with the same `stateDir`, call `init()`, and call `resume(jobId)`. Do not rename destination `.part` files: they contain the verified prefix. Use `getReport(jobId)` to identify partial offsets and exact EIO ranges, and regenerate the checksum manifest after any later retry. If source health is declining, start a new plan only when the operator intentionally wants a different priority or destination allocation; otherwise resuming avoids redundant reads.

## Measured performance

Measured 2026-07-19 with generated files in the local temporary filesystem. These numbers validate the byte paths and are not claims about physical disk or LAN limits.

| Workload | Result |
| --- | ---: |
| 16 MiB initial sync | 42.75 MiB/s; 374.25 ms |
| 1 MiB change inside 16 MiB | 1 MiB sent; 15 MiB / 93.75% avoided; 454.51 ms |
| Interrupted 16 MiB sync | 4 MiB checkpointed; 12 MiB sent after reconstruction; 423.29 ms restart cost |
| 500 × 1 KiB sync | 57.72 files/s; 8,662.37 ms |
| Three-peer convergence | 15,061.91 ms including a new peer’s full 16 MiB seed; converged |
| Salvage 8 MiB restart | resumed from 2 MiB checkpoint; 95.57 ms restart cost; recovered |
| 64 MiB sparse image capture | 126.72 logical MiB/s; 8,198 stored bytes; 64 MiB logical holes/data avoided by storage |
| Duplicate 64 MiB image capture | 0 additional unique stored bytes; 64 MiB dedup benefit |
| 64 MiB full-verified image restore | 121.54 MiB/s; 526.56 ms |
| Sync/salvage benchmark peak RSS | 347.34 MiB while hashing/scheduling the combined workloads |
| Imaging benchmark peak RSS | 141.38 MiB with 4 MiB chunks and gzip |

Reproduce with:

```sh
node scripts/performance/sync-next-powerhouse.mjs
node scripts/performance/imaging-powerhouse.mjs
```

## Remaining physical validation

Software gates use real files, sparse allocation, durable process reconstruction, injected deterministic executors, and direct loopback peers. Remaining lab validation is physical only: raw-device behavior across actual SATA/NVMe/USB controllers, native partition inspectors on varied tables, bootability on BIOS/UEFI hardware, LAN throughput and packet loss on operator switches, filesystem-specific sparse/reflink behavior, and salvage read behavior on genuinely failing media.
