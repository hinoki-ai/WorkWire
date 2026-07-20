# WorkWire — Canonical Product & Technology Profile

**WorkWire, the Agentic Archon.**

WorkWire is a local-first Agentic Archon: the sovereign authority over
operator-owned machines on a trusted LAN. Privileged agents expose the
capabilities required to inspect, move, reconstruct, repair, provision, and
operate those machines. WorkWire provides the machinery; the human or
autonomous operator decides what should happen.

The original file desk remains a real capability, but it is one capability
among many—not the product itself. Synchronization, continuity, imaging,
salvage, provisioning, shell execution, recovery, and fleet execution are
expressions of the same underlying authority.

It is built for the moment when ordinary remote access and cloud sync are not
enough: a workstation has drifted, a disk is failing, an OS needs repair, a
small fleet needs coordinated action, or important data must be recovered with
evidence. WorkWire keeps its control and data paths on an operator-owned LAN.

> **Canonical status — 19 July 2026.** This profile describes the code and
> verification evidence in this repository. The reference validation release was
> `0.1.0+ww1.2a95d730b96d`. It is not a claim of certifications, commercial
> availability, revenue, market traction, or universal hardware support.

## The investment thesis

Separate tools commonly divide file operations, imaging, inventory, shell
execution, and recovery. That division obscures the authority needed to act
on an owned machine. WorkWire presents those capabilities as one local-first
Archon:

- **Data continuity:** copy, synchronize, version, image, and recover data with
  hashes, checkpoints, and restart-safe state.
- **Machine continuity:** retain durable inventories, identity evidence, change
  history, health signals, and recovery artifacts.
- **Operational continuity:** coordinate privileged recovery work across
  operator-owned machines with exact output, per-target results, and explicit
  postconditions.

The current implementation includes a two-machine file desk and extends that
foundation into multi-machine recovery, provisioning, and fleet control. Core
continuity and vault services are offline-first: no cloud account, database
server, or external control plane is required.

## What is working today

| Capability | What WorkWire does | Evidence |
| --- | --- | --- |
| Paired file desk | Authenticated two-machine browsing, copy/move, upload/download, trash, conflict preservation, and background mirroring | Physical Linux↔Windows gate passed remote CRUD, bidirectional hash checks, move/delete, mirror convergence, simultaneous-edit conflict handling, and wrong-token rejection. |
| Advanced sync | Multi-folder/multi-peer sync with delta chunks, resume, policies, versions, conflicts, throttling, and sparse-file support | 18 dedicated sync/imaging/salvage tests passed; real byte-path benchmarks recorded. |
| Continuity & vault | Durable machine history, identity graph, health intelligence, content-addressed snapshots, restore, scrub, and retention | 100,100-record continuity benchmark; bounded-memory SHA-256 vault and focused tests. |
| Imaging & deployment | Capture, verify, restore, catalog, deduplicate, export/import, and roll out images or bundles | 64 MiB sparse capture/restore and duplicate-image deduplication benchmarked; concrete executor required for deployment. |
| Read-only salvage | Prioritized recovery from declining media with checkpoints, retries, reports, and multiple destinations | Restartable salvage benchmark and source-nonmutation contract. |
| Recovery & fleet | Root/SYSTEM agents, fleet rollouts, terminal sessions, artifacts, typed actions, playbooks, autonomy graphs, PXE, and Wake-on-LAN dispatch | Linux and Windows physical agents exercised; disposable QEMU recovery image passed all eight stages. |

## Archon capabilities

### 1. The historical file desk

The original WorkWire file desk is an Electron application backed by an authenticated HTTP
filesystem service. It gives operators a two-pane local/remote workspace while
keeping the user-facing view confined to `Portal/`; control, build, and runtime
trees remain backend-only.

- Shared bearer trust, pinned peer machine identity, protocol version, and exact
  build agreement protect pairing.
- UDP beacons update compatible peer routes after DHCP changes; the mirror
  elects one synchronizer so two mirror engines do not race.
- Recursive files/directories and deletions synchronize. Simultaneous edits
  preserve the loser as a visible `WW conflict` copy rather than silently
  discarding it.
- Machine-wide exploration is read-only and requires the paired identity in
  addition to bearer trust.
- Atomic uploads, sandboxed/realpath-checked portal paths, hidden internal
  trees, bounded request sizes, and timeouts are built into the service.

The paired desk is for **two machines**, not an untrusted internet service or a
general multi-peer mesh. Symbolic links are not transferred by its legacy
desk/mirror; the advanced Sync Engine has separate link policies.

### 2. WorkWire Sync Engine (v3)

The advanced data engine supports selected folders and peers with
`send-receive`, `send-only`, `receive-only`, and `archive-only` modes.

- Ordered, explainable gitignore-style include/exclude policies: negation,
  anchoring, globstars, directory rules, and comments.
- Native change watching where available, a durable journal, and correctness
  scans when watching is unavailable or unreliable.
- SHA-256 identity cache guarded by device/inode/size/mtime/ctime facts;
  same-size/same-mtime changes are content-checked.
- Fixed-size deterministic chunk manifests transfer only missing chunks, with
  bounded buffers, configurable parallelism, priority, backpressure,
  pause/resume, bandwidth ceilings, and a small-file fast path.
- Verified durable per-chunk checkpoints, private part files, final full-file
  SHA-256 validation, atomic replacement, and sparse zero-range preservation.
- Versions stored in a SHA-256 filesystem object store or an injected Recovery
  Vault. Conflicts retain base observations and both hashes/identities;
  resolutions are keep-left, keep-right, keep-both, or merged content.
- Compatible protocol range: versions 2–3, independent of identical app bits.

### 3. Continuity history, recovery vault, and health

WorkWire Continuity makes a durable, inspectable record of a machine over time.
Its append-only JSONL store is relocatable, maintains rebuildable indexes,
quarantines an incomplete final journal record after a crash, and can use
per-event `fsync` for stronger power-loss durability.

The machine graph records physical machines, aliases, boot sessions, OS
installations, agents, disks, partitions, volumes, filesystems, network
interfaces, snapshots, cases, jobs, artifacts, file sets, and health
observations. Strong evidence (stable ID, DMI UUID, serial, peer ID, MAC) is
kept distinct from weak explanatory evidence (hostname, IP, boot ID), avoiding
silent merges after DHCP changes or reinstalls.

The filesystem Recovery Vault provides immutable SHA-256 objects and
content-derived manifests; deterministic fixed-size chunks (1 MiB default);
global deduplication; sparse zero extents; bounded-memory streams; file, tree,
artifact, and stream ingestion; exact durable ingest/restore checkpoints;
hash verification before atomic finalization; integrity scrub; and
explicit/pinned retention pruning.

Health intelligence evaluates SMART/NVMe state, temperature, media errors,
wear, unsafe shutdowns, capacity, RAID, boot identity, storage warnings, tool
coverage, reachability, and staleness. Its recommendations include snapshot,
inventory, long SMART test, ddrescue preparation, vault verification, and disk
replacement; a recommendation is never silently converted into a destructive
command.

### 4. Imaging, deployment, and data salvage

**Imaging** stores disk/file images in a catalog with source identity, geometry,
partitions, filesystems, boot mode, compression, chunk hashes, verification
facts, labels, pin state, and timestamps. Capture accepts ordinary files,
sparse files, or a raw-device adapter. Catalog storage supports uncompressed or
gzip SHA-256 chunks, zero-range sparsity, cross-image deduplication, resume,
peer-assisted seeding, sample/full verification, and explicit deletion.

Provisioning produces deterministic plans with resolved targets, preflights,
ordered steps, verification, editable file/command bundles, and
intended-versus-observed reports. Rollouts support all-at-once, bounded
parallel, canary-then-rest, and stop-on-first-failure. A real executor or
catalog restore is required—there is no simulated deployment success.

**Salvage** begins with metadata-only, read-only discovery and never follows
source symlinks. It prioritizes explicit selections, documents, source code,
credentials/configuration, small files, photos/media, then remaining files.
Capacity planning can spill deterministically across healthy destinations.
Transfers use durable per-file offsets, chunk retry, atomic destinations,
SHA-256 verification, sparse ranges, and clear `recovered`, `missing`,
`partial`, or `corrupt` outcomes. Verified duplicate content can hard-link
where possible, with reflink/copy fallback.

### 5. Recovery and fleet command

Recovery is a separate privileged plane for operator-owned machines on a
private wired LAN. Its controller and agents use different identities and ports
from the file desk: controller `4852`, agent service `4853`, file service
`4851` by default. Agents initiate their WebSocket connection, avoiding an
inbound firewall rule on targets.

- Stable Linux root and Windows SYSTEM agent identities, inventory collection,
  reconnect/replay behavior, durable cases/jobs/events, binary-safe output,
  resumable artifacts, and target-local TCP tunnels.
- Exact argv and unrestricted shell execution; interactive Linux PTYs and
  Windows PowerShell/winpty selection with an honest pipe fallback when native
  terminal semantics are unavailable.
- 124 typed actions covering inventory, storage, partitions, RAID/LVM/LUKS,
  filesystems, boot repair, processes/services, artifacts, power, and
  platform-specific Linux/Windows work. Each action advertises required native
  tools; unavailable actions remain visible with shell fallback.
- Fleet aliases, labels, groups, saved live queries, recurring schedules,
  maintenance windows, retry-failed runs, offline queues, and exact per-target
  state/output retention.
- All-at-once, bounded-concurrency, and canary rollouts; stop-on-first-failure;
  restart reconciliation that avoids replaying completed mutations.
- Interactive sessions with stdin, output sequence, resize, signal,
  detach/reconnect, bounded buffers, and explicit gap indication.
- Seven playbooks: Linux boot repair, partition recovery, failing-disk cloning,
  UEFI/GRUB, Windows/NTFS, mdraid/LVM/LUKS, and resize/migration.
- Evidence-driven autonomous plan graphs with facts, hypotheses, dependencies,
  recovery points, postconditions, proofs, alternatives, compensation, and
  manual takeover. A zero process exit code alone is not repair proof.
- Fedora PXE host support and a Debian live recovery image; Wake-on-LAN packet
  dispatch records delivery intent, while agent check-in proves a hardware wake.

The Electron cockpit exposes Files and Recovery workspaces through a narrow
preload IPC bridge. Renderer code holds neither direct network access nor
service tokens.

## Technical architecture

```text
                       Operator-owned private LAN

   WorkWire File Desk  ── authenticated HTTP / UDP discovery ──  Paired Desk
        (Electron)                  port 4851                   (Electron)
             │                                                    │
             └──── Portal files / legacy mirror / Sync Engine ───┘

   Continuity Store ──► Machine Graph + Health ──► Recovery Vault
       JSONL/indexes       identity and diffs       SHA-256 objects

   Recovery Cockpit/CLI ── Controller :4852 ── WebSocket ── Root/SYSTEM agents
                                  │                         agent service :4853
                                  ├── fleet / terminals / artifacts / PXE
                                  └── Sync, Imaging, Salvage, Continuity lanes
```

Implementation is primarily Node.js 22 with `ws`; the desktop uses Electron
43. The packaged Linux release includes the recovery runtime and optional
continuity, sync, imaging, and salvage module trees. The current release ships
a Linux x64 archive and AppImage, a source archive, a Windows recovery-agent
bundle, and a recovery-image build path. Windows is physically validated; ARM64
metadata/capability handling exists, but ARM64 installation and recovery-image
boot remain pending physical validation.

## Measured engineering evidence

All performance numbers identify their context; they are not network or
hardware SLAs.

| Test | Result | Conditions |
| --- | ---: | --- |
| Physical 4 GiB transfer, Linux → Windows | 57.39 MiB/s | Concurrent desktop workload; SHA-256 matched; final physical gate |
| Physical 4 GiB transfer, Windows → Linux | 63.86 MiB/s | Same gate; total 8 GiB round-trip; SHA-256 matched |
| Control responsiveness under 8 GiB load | 49/49 pings; 291.20 ms worst round trip | Physical two-machine LAN gate |
| Sync, initial 16 MiB | 42.75 MiB/s; 374.25 ms | Generated files on local temporary filesystem |
| Sync, 1 MiB changed in 16 MiB | 1 MiB sent; 15 MiB / 93.75% reused | Chunk-delta benchmark |
| Sparse 64 MiB image capture | 126.72 logical MiB/s; 8,198 bytes stored | Gzip + sparse generated source |
| Full-verified 64 MiB image restore | 121.54 MiB/s; 526.56 ms | Generated local storage benchmark |
| Continuity history ingest | 2,107.8 records/s | 100,100 records; Node 22.22.0, Linux/ext4, Intel i7-3770 |
| Continuity text search | 18.509 ms median; 38.870 ms p95 | 1,000 results from benchmark corpus |
| Continuity semantic diff | 0.307 ms median; 1.197 ms p95 | Same benchmark corpus |
| Fleet controller registration | 833.07 ms | Final three-loopback-agent benchmark |
| Fleet rollout | 253.93–415.66 ms all-at-once | Final three-loopback-agent benchmark |

The released physical gate passed 11/11 two-machine end-to-end checks,
including 17,039,360 bytes in each direction, remote CRUD, move semantics,
conflict preservation, build/identity agreement, and unauthenticated-request
rejection. The final source suite recorded **292 passed, 0 failed, 0 skipped**
on Linux; a native Windows SYSTEM run recorded **281 passed, 11 intentional
platform skips, 0 failed**.

## Trust, safety, and real limits

The Archon is designed for a trusted private LAN, not public internet exposure.

- Peer identity is pinned and the paired filesystem service authenticates every
  request. Secrets do not reach the Electron renderer.
- Electron uses context isolation, sandboxing, no Node integration, restrictive
  navigation/permission controls, CSP, and packaged integrity controls.
- Portal boundaries use lexical and realpath validation to block root mutation
  and symlink escapes. Continuity uses local, inspectable state plus hashes,
  atomic writes, checkpoints, and replayable journals.
- Destructive recovery power is explicit. `force: true`, arbitrary argv, and
  unrestricted shell are available to the operator; safe operation still
  requires careful device selection and backups.
- Recovery/PXE ports belong on an operator-owned wired lab network. Firmware
  needs unauthenticated boot artifacts, so PXE must never be internet exposed.

WorkWire has software, disposable-QEMU, and two-machine Linux/Windows evidence.
The following remain physical-validation work, not completed claims:

- Windows ConPTY behavior and elevated boot/BCD/WinRE, BitLocker, storage, and
  reboot/install survival on disposable hardware.
- ARM64 package installation and recovery-image boot on physical ARM64 hosts.
- Real RDP/VNC/SPICE/serial/SOL endpoint interoperability.
- Wake-on-LAN check-in from powered-off hardware with verified firmware/NIC
  standby support.
- Raw SATA/NVMe/USB capture/restore across controller variants, broad BIOS/UEFI
  PXE validation, physical failing-media behavior, and destructive power-loss
  recovery on disposable disks.
- Multi-peer internet synchronization: the legacy paired mirror is deliberately
  a two-machine trusted-LAN product.

## Release and diligence references

- [Authoritative final release and two-machine proof](handoff/next-stage/results/fleet-final.md)
- [File desk architecture, security, and operating limits](docs/WW.md)
- [Continuity/vault technical contract](docs/CONTINUITY.md)
- [Sync, imaging, and salvage specifications](docs/POWERHOUSE.md)
- [Archon command specification](docs/COMMANDER.md)
- [Recovery architecture and operational safety model](docs/RECOVERY.md)
- [Performance-gate methodology](docs/PERFORMANCE-GATE.md)

Investor diligence can reproduce these claims from the repository's test suite,
benchmark scripts, release artifacts, and linked physical-gate records. Hardware
and network results should be re-tested in the buyer's environment before use
for capacity or SLA decisions.
