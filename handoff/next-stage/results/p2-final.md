# P2 final — data movement, imaging, and salvage

Completed: 2026-07-19

## Exact capabilities

### Synchronization

- Stable public exports: `WW_SYNC_ENGINE_VERSION`, `createWorkWireSyncEngine`, `compileSyncPolicy`, and `getSyncCapabilities`.
- Multiple folders and explicitly selected multiple peers; send-receive, send-only, receive-only, and archive-only modes.
- Ordered explainable include/exclude rules with comments, negation, anchoring, globstars, and directory rules.
- Native filesystem observation where supported, durable change journal, and correctness-first full scan fallback.
- SHA-256 identity cache that requires device/inode/size/mtime/ctime evidence; same-size/same-mtime changes are content checked.
- Deterministic fixed-size chunk manifests; missing-chunk-only transfer with exact transferred/reused byte counters.
- Durable verified chunk checkpoints, private temp files, restart validation, final full-content hash, and atomic destination replacement.
- Bounded chunk buffers, configurable concurrency, priorities, backpressure, pause/resume, and bandwidth ceilings.
- Versioning before overwrite/delete with SHA-256 filesystem objects or automatically deduplicated injected RecoveryVault snapshots.
- Conflict records preserve base observations, both machine identities/timestamps/hashes/version references, and resolution state; keep-left, keep-right, keep-both, and merged content work.
- Sparse zero ranges, explicit ignore/preserve-link/follow-within-root symlink behavior, structured events, and convergence statuses.
- Compatible sync-protocol negotiation is independent of identical application bytes.
- Existing mirror, endpoint, explorer, copy/move, upload/download, and trash behavior remains intact.

### Imaging and deployment

- Stable public exports: `WW_IMAGING_VERSION`, `createImagingCatalog`, `createProvisioningEngine`, and `getImagingCapabilities`.
- Image catalog includes source machine, disk identity, geometry, partitions, filesystems, boot mode, tool, compression, chunks, hashes, sizes, time, labels/pin, and verification.
- Bounded sparse/file/raw-adapter capture through uncompressed or gzip SHA-256 objects; capture source identity and every resume boundary are durable.
- Restore revalidates previously completed target chunks, reconstructs sparse holes, hydrates missing verified objects from catalog peers, and supports sample/full verification.
- Inspect, pin, clone, rename, search, export, import, verify, and explicit delete operate on real catalog data.
- Deterministic multi-machine plans contain target selectors/resolution facts, preflights, ordered operations, editable file/command bundles, and intended-versus-observed reports.
- All-at-once, bounded-parallel, canary-then-rest, and stop-on-first-failure rollouts execute through concrete injected executors; missing execution capability is an error.

### Salvage

- Stable public exports: `WW_SALVAGE_VERSION`, `createSalvageEngine`, and `getSalvageCapabilities`.
- Read-only metadata discovery does not open every file and never follows source symlinks.
- Required priority order: explicit, documents, source/code, credentials/config, small files, photos/media, everything else, plus operator rules.
- Cumulative capacity estimates and deterministic spill across multiple healthy destinations.
- Durable per-file offsets and per-chunk hashes, temp-prefix revalidation, bounded reads, retries, exact mappings/errors, and no recopy of completed verified files.
- Deterministic recovered/missing/partial/corrupt reports, SHA-256 manifests, bounded preview streams, verified deduplication, sparse zero writes, and optional ddrescue mapfile hints.
- Source files are only opened read-only and source metadata is unchanged.

## P2 files created

- `lib/sync/index.mjs`
- `lib/sync/primitives.mjs`
- `lib/imaging/index.mjs`
- `lib/salvage/index.mjs`
- `test/ww-sync-next-engine.test.mjs`
- `test/ww-sync-next-convergence.test.mjs`
- `test/ww-imaging-catalog.test.mjs`
- `test/ww-imaging-deployment.test.mjs`
- `test/ww-salvage-engine.test.mjs`
- `scripts/performance/sync-next-powerhouse.mjs`
- `scripts/performance/imaging-powerhouse.mjs`
- `docs/POWERHOUSE.md`
- `handoff/next-stage/results/p2-progress.md`
- `handoff/next-stage/results/p2-final.md`

No existing manual-transfer or mirror source file was modified by P2.

## Test evidence

- Required command: `node --test test/ww-sync-next-*.test.mjs test/ww-imaging-*.test.mjs test/ww-salvage-*.test.mjs`
  - 18 tests, 18 passed, 0 failed, 0 skipped.
- Existing two-machine compatibility focus: compatibility, endpoint, mirror, service, transfer/progress, and trash tests.
  - 44 tests, 44 passed, 0 failed, 0 skipped.
- Full `npm test` run:
  - 245 tests, 243 passed, 2 failed.
  - Both isolated failures are outside P2 ownership and reproduce without a P2 path: `ww-recovery-actions.test.mjs` expects 101 registry actions but the concurrent recovery implementation exposes 109; `ww-recovery-windows.test.mjs` expects zero collector errors but the concurrent Windows inventory reports five probe errors.
  - Every P2 test and existing mirror/endpoint/service/transfer/trash compatibility test passed in that full run. No regression is attributable to P2.
- Public export audit matches the three frozen contracts exactly.
- Stub/TODO/fake-success audit found no incomplete P2 production operation.

## Final benchmark evidence

Generated local temporary files, 2026-07-19:

- Initial 16 MiB sync: 374.25 ms, 42.75 MiB/s.
- 1 MiB change in 16 MiB: 1 MiB transferred, 15 MiB reused/avoided (93.75%), 454.51 ms.
- Interrupted large sync: 4 MiB checkpoint; reconstruction sent the remaining 12 MiB; restart cost 423.29 ms.
- 500 × 1 KiB: 8,662.37 ms, 57.72 files/s.
- Three-peer seed/convergence: 15,061.91 ms, converged.
- Salvage restart: resumed an 8 MiB file at a verified 2 MiB boundary; 95.57 ms restart cost; recovered.
- 64 MiB sparse gzip capture: 505.05 ms, 126.72 logical MiB/s, 8,198 stored bytes.
- Duplicate 64 MiB image: zero additional unique stored bytes, 64 MiB dedup benefit.
- Full-verified 64 MiB restore: 526.56 ms, 121.54 MiB/s.
- Peak RSS: 347.34 MiB for combined sync/salvage workloads; 141.38 MiB for imaging with 4 MiB chunks/gzip.

Reproduction commands and interpretation are recorded in `docs/POWERHOUSE.md`.

## Remaining physical-hardware validation only

- Raw SATA/NVMe/USB capture and restore across real controllers and native sector geometries.
- BIOS/UEFI bootability and native partition/filesystem inspection across representative machines.
- Physical LAN throughput, loss/reconnect behavior, and peer seeding on operator switches.
- Filesystem-specific sparse/reflink allocation outside the tested host filesystem.
- Read/retry behavior and optimal priority under genuinely failing media.
