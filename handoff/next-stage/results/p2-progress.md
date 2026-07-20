# P2 progress

Updated: 2026-07-19

## Completed evidence

- Synchronization engine implemented in `lib/sync/**`: multi-folder/peer configuration, four modes, explainable ignore policy, native watch plus durable journal/full-scan fallback, identity-safe SHA-256 cache, deterministic chunks, resumable delta transfer, atomic verified replacement, concurrency/priority/bandwidth/pause, sparse zero ranges, symlink policies, version history, conflicts and four resolutions, direct compatible-version peer protocol.
- Three-peer create/edit/rename/delete/offline/reconnect/conflict convergence passes.
- Same-size/same-mtime mutation transfers exactly one changed 64 KiB chunk of a 256 KiB file and reuses 192 KiB.
- Interrupted 320 KiB transfer leaves the old destination intact and resumes after engine reconstruction.
- Imaging catalog and provisioning implemented in `lib/imaging/**`: sparse/compressed resumable capture, content objects, metadata catalog, inspect/verify/restore, export/import, catalog lifecycle operations, peer seeding, editable bundles, deterministic rollout plans/reports.
- Interrupted sparse capture and restore resume after catalog reconstruction; full restored content verifies.
- Canary, bounded-parallel, and stop-on-first-failure fake-executor deployments pass.
- Salvage implemented in `lib/salvage/**`: unopened-file inventory, required priority tiers, capacity estimates, deterministic destination spill, per-file resume, bounded reads/previews, retries and exact partial outcomes, checksums, deduplication, ddrescue hints, source read-only operation.
- Focused test results: sync 6/6, imaging 6/6, salvage 6/6.

## Completion

All P2 software gates are complete. The final combined P2 command passes 18/18 tests, the focused legacy two-machine compatibility gate passes 44/44 tests, both benchmark programs pass, and `docs/POWERHOUSE.md` records architecture, formats, integration surfaces, recovery procedures, and measured results. Remaining P2 validation is physical hardware only; exact final evidence is in `p2-final.md`.
