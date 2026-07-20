# Fleet final — stable release and physical two-machine proof

Completed 2026-07-19 (America/Santiago). This is the authoritative final record
referenced by `p3-final.md` and `docs/AGENT-OPERATIONS.md`. All evidence below
was produced against the exact shipped release with both physical machines
(HINOKI Linux, Sakura Windows) live on the LAN.

## Final release identity

Release: `0.1.0+ww1.2a95d730b96d`, hash scheme `ww-release-v6`, release hash
`2a95d730b96d860704d79ea1485892b09e48f5effd01d036136776ed182a141e`, update
source hash `14eed1bef8ff8c955e86e6de8935c0b0942157fca5804dd105204afa9d4b881f`
(`ww-update-source-v2`, 278 source files).

Two earlier same-day candidates existed: `298e056bfd73` passed the identical
gate battery, after which recording its evidence into the hashed `docs/` tree
changed the source hash. The source was then frozen, rebuilt as
`2a95d730b96d`, reconverged onto Sakura, and every gate re-executed against
the shipped bits below. (The first `298e056bfd73` evidence capture was also
lost to a desktop mirror reconciliation; the gate scripts report on stdout
only — `--output` is not a supported flag.)

Linux distributables (`dist/ww/`):

- `WorkWire-0.1.0-ww1.2a95d730b96d-linux-x64.tar.gz`, 126,331,787 bytes,
  `ab93cccfcabf9d5c8e6e697c6d80db390cb75fe4a6f3a0b253c9f37f1828bea9`
- `ww-linux-x64.tar.gz`, byte-identical alias, same size and SHA-256.
- `WorkWire-0.1.0-ww1.2a95d730b96d-linux-x86_64.AppImage`, 128,076,912 bytes,
  `47cd7a861ccd33ea91cdb6efa137eb0cf457ec0c03b99ce10b00cc27a3b4dd55`
- Source archive `artifacts/ww-source.tar.gz`, 1,922,829 bytes,
  `0c94214fd0fd923935a2ecd9fb188bad62b11966c082f2eeb8fa7386ade5321a`

Package audit: `app.asar`
`0f734c55c2e626d08a04235e24642ab5d7a62d63b0263e9e568dfca9e2c999d6` is
byte-identical between the archive and the AppImage; 154 asar entries include
every required recovery module (fleet, interactive, console, autonomy-next,
capabilities, next-stage adapters, atomic) and all four optional lanes
(continuity, sync, imaging, salvage); the embedded `package.json` reports
version `0.1.0` with `ww-release-v6`; `resources/recovery-runtime` (139
entries) carries the optional lanes and the physical gate scripts; zero
`WW conflict` basenames anywhere in either package.

## Active recovery image

`/home/hinoki/.config/workwire/recovery/boot/live`, rebuilt 2026-07-19 with the
final recovery runtime; `sha256sum -c SHA256SUMS` passes for all four artifacts:

- `filesystem.squashfs`, 745,324,544 bytes,
  `888968e7c39f5a18ecbfc67168b41626a3c0fbb5f22eac29720ce940c8d4b3f7`
- `initrd.img`, 66,348,111 bytes,
  `97b806aa6a0a22940f67ae89b386540961799532cf01202cf2b3b517f2c13cdf`
- `vmlinuz`, 8,222,656 bytes,
  `6a25a32d27db1782ac2ca74d714115150aca1923e11485c60b3fadd59c3ece14`
- `workwire-recovery.iso`, 839,909,376 bytes,
  `0f56dc5af722a1dd5793c0fa7511df10e058b148012915156b3c074295134b7b`

The image manifest declares 124 typed recovery actions. The disposable KVM
harness result for this image line is
`artifacts/recovery-qemu/fleet-final-clean-image/summary.json` (`ok: true`, all
eight stages, stable agent identity across reboot, WorkWire-issued poweroff).

## Fleet convergence

- Convergence used only the agent transport: source archive, bare pairing
  token file, and `converge-ww-windows.ps1` uploaded via `recovery put`, the
  archive SHA-256 verified on the Windows side before execution, then run as
  SYSTEM. No browser download, interactive elevation, or plaintext credential
  outside protected state was used. Replaced material was preserved under
  `C:\ProgramData\WorkWire\backups\source-20260719-211012-696497df`.
- HINOKI service identity `t8K6zAc6chbIa3srdlFEeQ`; Sakura file-service
  identity `RQn5hi_GTBHwvC6bQmmTYg`; Sakura SYSTEM recovery agent
  `wwra_xCR5XgqeHAd2RkAzsp81bWPo`; HINOKI root recovery agent
  `wwra_AQwelJu3cxhVk0h1GXvmbaCf`; central controller
  `http://192.168.8.104:4852`.
- `scripts/ww-fleet-doctor.mjs` after packaging: all 13 checks true, including
  pairing-token convergence, pinned peer identity, both file services
  reachable and authenticated, both sides running the current source with
  equal versions, current update source on both, controller reachable, and
  both agents online.

## Physical gate evidence (final release `2a95d730b96d`)

Canonical machine-readable evidence, all `ok: true`, both sides reporting
`0.1.0+ww1.2a95d730b96d` where the gate records versions:

- `fleet-e2e.json` (2026-07-20T01:11Z, 25.8 s): 11/11 checks, 17,039,360
  bytes per direction, bidirectional exact hashes, remote CRUD,
  move-deletes-source, rename conflict policy, mirror convergence and
  generation barrier, simultaneous-conflict preservation, wrong-token
  rejection, fixture cleanup.
- `fleet-recovery-physical.json` (2026-07-20T01:12Z, 46.0 s): HINOKI root PTY
  (`id -u` = 0) and Sakura `NT AUTHORITY\SYSTEM` PowerShell, binary session
  files, detach/reconnect, target-local tunnel, all-at-once fleet identity,
  and completed autonomy cases with proved actions and exported procedures on
  both agents.
- `fleet-4g-roundtrip.json` (2026-07-20T01:16Z): 4 GiB each direction,
  8,589,934,592 bytes total, 57.39 MiB/s HINOKI→Sakura and 63.86 MiB/s back
  (run concurrently with the desktop fleet workload), matching SHA-256 both
  ways, both move sources deleted, 49/49 pings during load with 291.20 ms
  worst round trip, 142,454,784-byte peak RSS, full cleanup.
- `fleet-watchdogs-physical.json` (2026-07-20T01:18Z, 97.0 s): forced kills of
  Sakura's file service and SYSTEM recovery agent; the same file-service
  machine ID and release returned via the watchdog, and the same stable agent
  ID returned with a changed connection epoch and unchanged OS boot ID.
- `fleet-windows-physical.json` (2026-07-20T01:20Z, 109.4 s): native Windows
  suite executed as SYSTEM with Node v22.23.1 on Sakura — 58 files, 292 tests,
  281 passed, 11 intentional platform skips, 0 failed/cancelled/todo, staged
  fixtures cleaned up.

## Software test totals (final source)

- Full Linux suite: 292 passed, 0 failed, 0 skipped.
- P3 required command nerve: ten consecutive full repetitions, 230/230, zero
  failures or retries.
- Commander benchmark (`p3-commander-benchmark.json`): registration to
  all-online 833.07 ms; all-at-once fleet run 253.93–415.66 ms; bounded
  288.09–353.92 ms; canary 274.39–397.58 ms.

The dated proof-baseline bullets in `docs/AGENT-OPERATIONS.md` are an index
recorded before this final rebuild; where numbers differ, the canonical
evidence files listed above are authoritative.

## Doctrine

Both machines remain running; Sakura is never S5-powered-off per
`windows/WINDOWS.md`. Operating procedure, acceptance, and recovery rules live
in `docs/AGENT-OPERATIONS.md`. No secret appears in this record; protected
local state is the only credential source.
