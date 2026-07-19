# FINAL RECOVERY HANDOFF — take over the WorkWire LAN recovery subsystem

You are the agent taking over the **WorkWire Recovery** subsystem. A previous
session built the entire subsystem and drove it through the software validation
gates; the internet dropped mid-build and the work was resumed. This document is
the complete, self-contained state of that work. Read it, continue from the exact
point marked **RESUME HERE**, finish the remaining validation gates yourself,
verify each one, and report results directly to the user. Do not return another
plan or a second handoff.

Everything here is a statement of what is already true in the working tree, not a
proposal. The subsystem is implemented and its full test suite is green. What
remains is image/boot validation, not new feature work.

---

## Fixed facts

- Repo / portal root: `/home/hinoki/WorkWire`
- Branch: `main`  ·  HEAD at handoff time: `47a8a0a2df75`
- This machine: **HINOKI** `192.168.8.104`, machine id `t8K6zAc6chbIa3srdlFEeQ`
- Paired machine: **Sakura** `192.168.8.105`, machine id `RQn5hi_GTBHwvC6bQmmTYg`
- Same Linux user `hinoki` on both; single NIC each behind router `192.168.8.1`
- File desk (unchanged, separate plane): port `4851`
- **Recovery controller: port `4852`  ·  recovery boot/HTTP: port `4853`**
- Recovery protocol version: **1** (independently pinned; not the file protocol)
- Recovery live image: Debian **bookworm** via `live-build` in a Podman container,
  Node runtime pinned to **v22.22.0** (checksum-verified from nodejs.org)
- Recovery state root: `~/.config/workwire/recovery`
  (`boot/live/` = activated artifacts, `image-cache/` = build caches + Node archive)

The recovery plane deliberately does **not** reuse the file desk's peer trust or
filesystem boundary. It is a separate controller, identity set, durable store, and
protocol, and it is **root-equivalent on its targets by design**.

---

## What already exists (do not rebuild — it is all in the working tree)

All of the following is present and **uncommitted** (untracked or modified). Do not
commit or push it (see "Hard constraints").

**Core library — `lib/recovery/` (17 modules):**
`ww-recovery-config.mjs` (ports/protocol/env), `ww-recovery-protocol.mjs`
(v1 framing/validation), `ww-recovery-controller.mjs` (controller + HTTP/WS on
4852/4853), `ww-recovery-client.mjs`, `ww-recovery-agent.mjs`,
`ww-recovery-agent-id.mjs` (stable DMI/MAC identity across reboots),
`ww-recovery-inventory.mjs` (block/health/SMART/NVMe), `ww-recovery-actions.mjs`
(typed disk/filesystem/boot action catalog incl. `command.exec`/`shell.exec`),
`ww-recovery-executor.mjs`, `ww-recovery-store.mjs` (durable cases/jobs/events),
`ww-recovery-autonomy.mjs` (autonomous case loop), `ww-recovery-planner-process.mjs`,
`ww-recovery-playbooks.mjs`, `ww-recovery-artifacts.mjs` (resumable transfers),
`ww-recovery-boot.mjs` (PXE/dnsmasq/iPXE), `ww-recovery-wol.mjs` (Wake-on-LAN),
`ww-recovery-cli.mjs` (the `ww recovery …` command surface).

**CLI entry:** wired into `ww.mjs` (`ww recovery <command>`). Full help text lives
in `lib/recovery/ww-recovery-cli.mjs` (`WW_RECOVERY_HELP_TEXT`) and covers
controller/agent/agents/inspect/wait/case/exec/shell/cancel/put/get/artifacts/
wake/**pxe install|prepare|start|status|stop**/image/playbook.

**Image + boot assets — `recovery/`:**
`image/Containerfile` (pinned `debian:bookworm-slim` builder), `image/auto/config`,
`image/config/` (live-build package-lists, chroot hooks `005/010/020`, systemd
agent unit, `includes.chroot` runtime), `dnsmasq/dnsmasq.conf.template`,
`ipxe/boot.ipxe.template`, `systemd/workwire-recovery-agent.service`,
`systemd/workwire-recovery-pxe.service`, and 7 playbooks under `playbooks/`
(failing-disk-clone, linux-boot-repair, mdraid-lvm-luks, partition-table-recovery,
resize-migrate, uefi-grub-initramfs, windows-ntfs-access).

**Scripts — `scripts/`:** `build-ww-recovery-image.sh`, `verify-ww-recovery-image.sh`
+ `.mjs`, `test-ww-recovery-qemu.mjs`, `run-ww-pxe.mjs`,
`install-ww-recovery-host.sh`, `install-ww-recovery-agent.sh`,
`write-ww-recovery-build-seed.mjs`, `write-ww-recovery-manifest.mjs`.

**Desktop:** `desktop/ww-recovery-main.mjs`, `desktop/ww/recovery-renderer.js`,
plus recovery assets; integrated with the existing Electron shell.

**Docs:** `docs/RECOVERY.md` (full operator guide) and a cross-reference block
added to `docs/WW.md` and `README.md`.

**Tests:** 14 files `test/ww-recovery-*.test.mjs` (actions, agent, autonomy, boot,
cli, config, controller, desktop, executor, inventory, protocol, store, ui, wol).

**npm scripts:**
`recovery:controller`, `recovery:agent`, `recovery:host-install`,
`recovery:agent-install`, `recovery:image-build`, `recovery:image-verify`,
`recovery:test:qemu`.

---

## The tarball and the permanent link

**The current bootstrap tarball already contains the recovery subsystem.**

- Release: `0.1.0+ww1.295fca8906a3` (supersedes fc1be60c7829/e0c7aa9971f9)
- `dist/ww/ww-linux-x64.tar.gz` (byte-identical alias of
  `WorkWire-0.1.0-ww1.295fca8906a3-linux-x64.tar.gz`)
- SHA-256: `03fb5ff970d5b0b72afb5cb90b39ba440583ae90ee1b42a16ce92ad1a51a7a14`
- Size: `126095267` bytes
- AppImage: `WorkWire-0.1.0-ww1.295fca8906a3-linux-x86_64.AppImage`
- Served by HINOKI at `GET /v1/update-bundle` (peer-pinned to Sakura only).
- Includes all fixes below plus the QEMU-gate fixes (harness boot-dir + mkfs
  flags). Rebuild + recompute SHA whenever any release-source file changes.

The version hash changes whenever release-source files change; it is deterministic
for a given tree. If you edit any of `package.json`, `electron-builder.linux.json`,
`ww.mjs`, `README.md`, `desktop`, `docs`, `lib`, or `scripts`, rebuild with
`npm run dist:linux` and recompute the SHA/size. Editing `handoff/` or `test/`
does **not** change the hash.

### The packaging bug that had to be fixed first

`npm run dist:linux` had never produced a release with the recovery config —
it failed the asar integrity check ("package.json was not found in this archive").
electron-builder excludes every `extraResources` `from` path from the asar to
avoid duplicating bytes. The old config mapped `from: "package.json"`,
`from: "lib"`, `from: "recovery"`, `from: "scripts"` into the resources tree,
which stripped `package.json` and `lib/**` out of the app's own asar. The desktop
recovery UI imports `lib/recovery` **in-process** (from the asar), so those files
must stay in the asar; the recovery agent/CLI/PXE scripts run as **subprocesses**,
so they also need to exist as unpacked files under `resources/recovery-runtime`.

Fix (files: `electron-builder.linux.json`, `scripts/package-ww-linux.mjs`,
`test/ww-package-config.test.mjs`): the `files` list keeps recovery in the asar;
`package-ww-linux.mjs:stageRecoveryRuntime()` stages a self-contained copy at
`dist/recovery-runtime` (a git-ignored, mirror-excluded path); `extraResources`
ships that single staged tree plus a dedicated `from: "node_modules/ws"` entry.
The asar's `node_modules` come from a separate matcher, so `ws` remains in both
the asar and `recovery-runtime`. Verified: the tarball's asar root has
`package.json/lib/recovery/scripts/desktop/ww.mjs/node_modules/ws`, and
`resources/recovery-runtime` is self-contained (lib, recovery, scripts,
package.json, node_modules/ws) so `install-ww-recovery-agent.sh` — which copies
`$repo_root/node_modules/ws` where `$repo_root` resolves to `recovery-runtime` —
works from the packaged app.

### Why the link stays intact "forever"

- Release/update source hash is computed **live from the working tree**;
  `lib/recovery` is in that set, `handoff/`+`test/` are not.
- The mirror syncs the whole portal root except
  `.workwire/.codex/.git/dist/link/node_modules/runtime`, so **all** recovery
  source (`lib/recovery`, `recovery/`, `scripts`, `desktop`, `docs`) reaches
  Sakura automatically.
- The subsystem adds **no new npm dependency** (only `ws`, already present), so
  the mirrored source runs on Sakura's existing `node_modules` — an
  already-bootstrapped Sakura needs no runtime change.
- Convergence: Sakura mirrors the source → both compute `fc1be60c7829` → each
  side's auto-activator waits for the other to settle → both restart into the
  converged checkout. No manual two-PC activation step.
- The tarball is the **bootstrap** path (a clean install or the one-time Sakura
  Phase 2). An already-bootstrapped Sakura does not re-pull it.

**Do not rebuild the tarball or restart the HINOKI service to "push" recovery.**
The running HINOKI service already advertises `fc1be60c7829` as its live source
(the desktop/service reads it per request) and is correctly holding the staged
release until Sakura converges. Right now the config peer host is
`192.168.8.106` with `lastSeen: none` (memory recorded `.105`; DHCP likely moved
it), so HINOKI cannot see Sakura and the wait is expected. Bring Sakura up on the
wired LAN; discovery re-locates it and convergence completes on its own.

## Validation gates — the plan is a 3-stage software gate, then a hardware gate

### Gate 1 — repository software  ✅ COMPLETE
`npm test` → **187 / 187 pass** (full suite). Two test-only fixes this session,
no product-behavior change:
- `test/ww-recovery-cli.test.mjs`: the PXE help regex omitted the `prepare`
  subcommand the CLI actually prints; corrected to `install|prepare|start|status|stop`.
- `test/ww-package-config.test.mjs`: updated for the packaging fix below (+1 new
  test asserting the recovery-runtime staging).

Re-run `npm test` first to confirm green before proceeding.

### Gate 1b — release tarball (bootstrap for the other machine)  ✅ COMPLETE
See **The tarball and the permanent link** below. `npm run dist:linux` now
produces a working `0.1.0+ww1.<hash>` bundle; the previous config never built one
(a real asar bug, fixed this session).

### Gate 2 — Debian live image build + verify  ⛔ NEEDS ROOTFUL PODMAN  ← **RESUME HERE**
Requirements present on HINOKI: `podman` 5.7.1, `unsquashfs`, `lsinitrd`,
`/dev/kvm`. The Node v22.22.0 archive is downloaded and checksum-verified into
`~/.config/workwire/recovery/image-cache/` (the truncated `.partial` was resumed
and validated `OK`).

**Blocker discovered this session:** rootless podman cannot `mknod` device nodes
for debootstrap, so `lb build` dies with
`E: Cannot install into target '/work/chroot' mounted with noexec or nodev`.
`/home` is NOT nodev/noexec — the real cause is the unprivileged user namespace,
which the kernel forbids from creating device nodes even with `--privileged`.
Run the build under **rootful** podman (`sudo`), or on a host where podman can
create device nodes. That is why `boot/live` has never held artifacts — this gate
has not completed in this environment.

Build (rootfs cache reuse keeps live-build caches between iterations):
```bash
npm run recovery:image-build -- --reuse-rootfs   # under rootful podman
```
Then verify — this is the real image gate:
```bash
npm run recovery:image-verify
```
`verify-ww-recovery-image.mjs` checks: manifest hashes + sizes of
`vmlinuz`/`initrd.img`/`filesystem.squashfs`, the `SHA256SUMS` digests,
`recoveryProtocol === 1`, and it `unsquashfs`-extracts
`etc/workwire-recovery-build.json` to confirm Node is pinned to 22.x, that every
core tool is present (bash, ip, curl, sshd, lsblk, findmnt, blkid, sfdisk, fdisk,
parted, sgdisk, ddrescue, smartctl, nvme, mdadm, pvs, cryptsetup, mount, chroot,
e2fsck, xfs_repair, btrfs, fsck.fat, fsck.exfat, ntfsfix, grub-install,
efibootmgr), and that the action catalog includes `command.exec`/`shell.exec`.
It also lists the initrd via `lsinitrd`/`lsinitramfs`.

**If verify fails, do not activate or PXE-boot the image.** Read the verifier's
exact missing-artifact/tool/initrd line and fix the build input, then rebuild.

### Gate 3 — QEMU end-to-end destructive recovery  ◑ CORE PROVEN; final re-run pending
`scripts/test-ww-recovery-qemu.mjs` boots the built kernel/initrd with direct
`-kernel`/`-initrd` (q35, virtio, user networking — **no OVMF needed**), waits for
the agent to check in, then on a disposable qcow2 disk: partitions/formats/mounts,
writes+reads a marker, backs up → corrupts → restores the GPT, repairs ext4,
round-trips an artifact, reboots and confirms a stable agent id with a new boot id,
and powers off through WorkWire. `qemu` 10.1.5 is installed; `/dev/kvm` works.

**This gate has already proven the hard parts** (VM boots over the network via the
controller boot server, the recovery agent starts, the controller drives jobs on
it). Getting there required fixing three real defects that no prior run had ever
exercised:
- **asar packaging** (`package.json` excluded from the app) — dist:linux now builds.
- **harness boot-dir** — the controller's `stateDir` was a fresh empty
  `controller-state/`, but the boot server serves the squashfs from
  `stateDir/boot/live`, so the PXE fetch 404'd and the live system aborted with
  "Unable to find a live file system on the network". Fixed by symlinking the
  verified image into `controller-state/boot/live` before `controller.start()`.
- **mkfs flags** — `filesystem.create` emitted `mkfs.fat -F -L` (invalid: `-F`
  is FAT size, label is `-n`). Fixed to per-tool force/label flags + regression test.

The mkfs fix lives in the agent baked into the squashfs, so the image is being
**rebuilt** to validate the full cycle. After the rebuild:
```bash
npm run recovery:test:qemu
# optional: -- --image /path/to/boot/live --disk-size 6G --memory 3072
```

### Gate 4 — physical lab  📋 FUTURE (needs hardware, cannot be automated here)
Documented in `docs/RECOVERY.md` → "Physical facts and remaining lab validation".
Summary: connect controller + a **disposable** target over wired LAN; enable
PXE/network boot + Wake-on-LAN once in UEFI/BIOS (disable Secure Boot only if
unsigned iPXE is rejected); test BIOS and UEFI PXE against a throwaway disk;
confirm stable DMI/MAC identity, destructive backup/corrupt/restore, network/power
interruption recovery, WoL, and the local-boot exit path. A physically failing
disk must be `ddrescue`-imaged to healthy storage (persistent mapfile) before any
repair — rewriting partitions does not fix bad sectors.

---

## Operational + safety model (must be preserved)

- Recovery is **root-equivalent on targets**. Keep ports 4852/4853 on the
  operator-owned wired lab LAN. **Never** expose them through an internet router.
- The live system **never** auto-mounts patient filesystems or enables patient
  swap; mdraid/LVM/LUKS activation is always an explicit job or shell command.
- Destructive typed actions require `--force`; the planner/operator retains
  unrestricted argv/Bash as the agent's real user (normally root).
- PXE selects one unambiguous wired IPv4 interface or requires `--interface`;
  generated dnsmasq config is validated before launch; stop/status match both the
  saved PID and the exact WorkWire config path so an unrelated dnsmasq is never
  killed.
- The prototype live console is root-capable; build-time
  `WW_RECOVERY_ROOT_PASSWORD` sets its root password (documented prototype default
  `workwire` — change it for anything past the isolated lab).
- Generated multi-GB image artifacts live under the recovery state dir and are
  excluded from the normal Electron package.

---

## Hard constraints — do NOT

- **Do not commit or push** this work unless the user explicitly asks. Pairing
  requires an exact app-version match (`0.1.0+ww1.<source-hash>`); any committed
  source change forces a new release to be installed on **both** HINOKI and Sakura
  back-to-back or the file link/mirror pauses. A stray commit here can pause the
  two-machine link. The recovery subsystem is intentionally sitting in the working
  tree.
- Do not run destructive recovery actions against any disk you care about — use a
  disposable device only.
- Do not weaken the version/compatibility gates, re-pair, or print/copy tokens.
- Do not delete the recovery state dir, the cached Node archive, or the built
  image artifacts.

---

## Definition of done for this handoff — current status

1. `npm test` → **188/188 green**. ✅ DONE
2. `npm run dist:linux` tarball builds with recovery in the asar + recovery-runtime.
   ✅ DONE (release `0.1.0+ww1.295fca8906a3`).
3. Recovery image builds (rootful podman) + `recovery:image-verify` passes.
   ✅ DONE once; being rebuilt to bake the mkfs fix (network-flaky — retry with
   `--reuse-rootfs` to keep the package cache across retries).
4. `npm run recovery:test:qemu` full destructive cycle. ◑ Core PROVEN (VM boots
   over the network, agent starts, controller drives jobs). Three defects found +
   fixed (asar packaging, harness boot-dir, mkfs flags). Re-run after the image
   rebuild to confirm the full partition→format→corrupt→restore→reboot cycle.
5. Gate 4 (physical hardware) remains open by design.

Remaining work for the next agent: finish the (network-flaky) image rebuild, then
run `npm run recovery:test:qemu` once more and confirm it powers off through
WorkWire. Everything else is done. Do not re-open the tarball/link work.
