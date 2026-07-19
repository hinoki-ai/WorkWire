# WINDOWS.md — The HINOKI ⇄ Sakura Fleet Operations Bible

Written 2026-07-19 after the full Windows/WoL/PXE campaign. This is the single
document a future agent needs to operate both machines autonomously. Read it all.
Companion history: `SAKURA-WINDOWS-AND-WOL-HANDOFF.md` (same dir, has the RESOLVED
banner with the war story).

---

## ⚡ PRIME DIRECTIVE — NEVER SHUT DOWN, ONLY HIBERNATE

**Sakura can ONLY be woken over LAN from HIBERNATE (S4), never from a full
shutdown (S5).** This is a permanent firmware cap of the Dell OptiPlex 990 —
verified on BIOS A24 (the final BIOS ever released): `/proc/acpi/wakeup` shows
`GLAN S4 *enabled`. No fix exists. Therefore:

- **Windows "off" = `shutdown /h`** (hibernate). NEVER `shutdown /s`, never the
  Shutdown menu item. The physical power button is configured to hibernate.
- **Fedora "off" = `systemctl hibernate`** (if invoked remotely, same rule).
- A regular shutdown makes Sakura unreachable until a human presses the button.
  If that happens, it is not a defeat — BIOS "AC Recovery = Power On" means a
  power-cord pull-and-replug (or any outage) boots it back up.
- Wake command, from HINOKI: `cd ~/WorkWire && node ww.mjs recovery wake 18:03:73:2e:3f:42`

**LED rule:** with Sakura off/hibernated, the Ethernet port LEDs must be LIT.
Dark LEDs = NIC unpowered = wake will fail. Cause: Deep Sleep re-engages after
any AC power loss or BIOS flash. Cure: the **AC-drain ritual** — unplug cord,
hold power button 10 s, replug — then one boot+shutdown cycle re-arms it.

---

## The fleet

| | HINOKI (this repo's home) | Sakura |
|---|---|---|
| IP / MAC | 192.168.8.104 / `34:17:eb:af:a8:99` (eno1) | 192.168.8.106 / `18:03:73:2e:3f:42` (eno1, Intel 82579LM) |
| Model | i7-3770, 32GB, HD 4000 | Dell OptiPlex 990, i7-2600, 32GB, **GeForce GT 1030** |
| BIOS | (untested WoL — newer gen, may support S5) | **A24** (final), Wake on LAN = LAN with PXE Boot, Deep Sleep = Disabled, AC Recovery = Power On |
| OS | Fedora 43 (240GB Crucial SSD) | Dual: **Windows 10 Pro 22H2** on 1TB SSD (400GB "WINDOWS" partition) + Fedora 43 on 111GB Kingston SSD |
| Roles | WW service :4851, recovery controller :4852, boot :4853, PXE host | WW peer, recovery agent (Fedora), Windows workstation (AutoCAD target) |
| Spare | — | 465GB Toshiba HDD on the shelf (empty, healthy — destined for HINOKI round 2) |

Same username `hinoki` both machines. **Sakura-Windows login password: `59163476`**
(needed at boot/resume until auto-login is enabled — see mission 10).
Sudo password for both: `59163476`
(also at `~/.config/workwire/recovery/prototype-sudo.env`, load with
`set -a; . <file>; set +a`). Sakura rejects SSH — all remote control goes
through the WorkWire recovery plane.

## Access paths (from HINOKI, `cd ~/WorkWire`)

- `node ww.mjs recovery agents --json` — who's online.
- **Sakura-Fedora agent** (installed, root, auto-reconnects every Fedora boot):
  `wwra_DoXG4t0yKhZTervalUWlML7R`. Use `recovery exec|shell <id> -- …`.
  If ever lost: on Sakura run `cd ~/WorkWire && sh go.sh` (staged, idempotent).
- **PXE live agent** (when Sakura is LAN-booted into recovery): appears as
  hostname `debian`, mode `pxe`, new id each boot. Full root + all disks.
- **Sakura-Windows agent: INSTALLED + VERIFIED 2026-07-19**:
  `wwra_xCR5XgqeHAd2RkAzsp81bWPo` (hostname DESKTOP-MMLPL5U, SYSTEM scheduled
  task, auto-start at boot). exec/put/get all proven. Full autonomy over
  Sakura-Windows. If ever lost: elevated PowerShell →
  `irm http://192.168.8.104:8800/win.ps1 | iex` (diagnostic:
  `irm http://192.168.8.104:8800/winstat.ps1 | iex`, posts report to HINOKI).
  Trap fixed en route: Windows PowerShell 5 `Set-Content -Encoding UTF8` writes
  a BOM that broke the agent's config JSON.parse — installer now writes BOM-less,
  agent readJson strips BOM. A failed `recovery get` right after agent (re)start
  may be transient — retry once before debugging.
- Mutating recovery jobs may need `--force`.
- **WW desktop app on Sakura-Windows: LIVE 2026-07-19.** Runs FROM SOURCE like
  Linux: portal `C:\Users\Sakura\WorkWire` (mirror-synced), config
  `C:\Users\Sakura\.config\workwire\ww-config.json` (Sakura identity
  `RQn5hi_GTBHwvC6bQmmTYg`, shared token), service = scheduled task
  "WorkWire Serve" (logon, direct auto-restarting node.exe ww.mjs serve;
  node.exe borrowed from the recovery agent install), GUI = desktop shortcut →
  `%LOCALAPPDATA%\WorkWire\app\WorkWire.exe` (vanilla Electron 43.1.1;
  `resources\app` is an NTFS junction to the portal, so GUI runs live source
  too; old asar kept as app.asar.bak). Desktop and Start-menu `WorkWire.lnk`
  launch the live app and use the dedicated `WorkWire.ico`; phase 2 also repairs
  matching pinned-taskbar shortcuts (including a stale `Electron.lnk`) so they
  never fall back to Electron's icon or SYSTEM-profile target.
  Reinstall one-liners on HINOKI:8800:
  winapp.ps1 (phase 1) + winapp2.ps1 (phase 2). Windows firewall allows 4851.
  `node_modules\ws` is staged at portal root (root node_modules is
  mirror-excluded, stays local).
- **Auto-update now proven end-to-end**: mirror syncs source cross-version via
  the update protocol; each side's release activator restarts its service when
  both PCs stage the same source hash. Cross-platform mirror path fix
  2026-07-19 (`remotePathFor`/`normalizeRemoteRootPath` in lib/ww-mirror.mjs +
  `expectedRemoteRootPath` from peer.remotePath in ww.mjs) — without it the
  mirror pauses on root-path mismatch between OSes.
- **Linked desktop + disk browsing:** opening WorkWire on either paired PC opens
  or focuses it on the other PC too, including repeat icon launches. The action
  rail exposes `Explore This PC` and `Explore Other PC`; `Disks` reaches Windows
  drive roots and selected files can be brought into the local Portal. Machine
  scope is read-only and accepted only from the pinned paired machine ID.
- **Update shutdown fix 2026-07-19:** the file service and recovery controller
  force-drain active HTTP/SSE connections during release activation, preventing
  `server.close()` from hanging while the supervisor waits to restart and
  allowing ports 4851–4853 to be reclaimed promptly.
- **Gotchas**: HINOKI's recovery controller (4852) runs INSIDE workwire-ww
  serve — every auto-update activation bounces it (agents auto-reconnect;
  in-flight recovery CLI calls die with fetch failed/ECONNRESET — just retry).
  Seeding a portal with tar truncates mtimes to seconds → first sync creates
  "(WW conflict …)" duplicates; delete them on HINOKI, deletions propagate.

## LAN boot (PXE) — Sakura, works, use PXELINUX only

- User-side: F12 → Onboard NIC. Server-side on HINOKI must be running:
  `sudo /usr/local/sbin/workwire-recovery-pxe start|status`
  (systemd unit `workwire-recovery-pxe.service`, state dir pinned via drop-in to
  `/home/hinoki/WorkWire/.workwire/config/recovery` — the ONLY canonical state dir).
- **Never use iPXE for Sakura's BIOS boot**: the 82579LM boot ROM cannot RX
  unicast under iPXE (both undionly.kpxe and native builds — proven by packet
  capture). The working chain is BIOS ROM → TFTP → **pxelinux.0** → vmlinuz +
  initrd over TFTP → squashfs over HTTP. Files live in
  `<stateDir>/boot/ipxe/` (pxelinux.0, ldlinux.c32, pxelinux.cfg/default,
  vmlinuz, initrd.img copies) and `<stateDir>/boot/live/`.
- firewalld on HINOKI has dhcp + tftp + 4011/udp open permanently.
- After changing `lib/recovery/ww-recovery-boot.mjs`, sync the installed copy:
  `sudo cp lib/recovery/ww-recovery-boot.mjs /usr/local/lib/workwire/lib/recovery/`
  then `stop` → `prepare --interface eno1` → `start`.

## Boot media doctrine

- **Verify every boot stick in QEMU before handing it to the user:**
  `sudo qemu-system-x86_64 -enable-kvm -m 3072 -snapshot -drive file=/dev/sdX,format=raw -display none -vga std -qmp unix:…` → QMP `screendump` (png) → look at it.
  Windows installer shows black screen for 2–3 min before the logo — wait.
- The working Win-installer format for 2011-era Dell BIOS: MBR, single bootable
  NTFS partition, `grub2-install --target=i386-pc`, grub.cfg with
  `insmod ntfs; insmod ntldr; search --set=root -f /bootmgr; ntldr /bootmgr`.
  Ventoy black-screens on this BIOS. The Kingston 29GB stick ("WININSTALL")
  carries this + `O990-A24.exe`.
- **Counterfeit USB warning:** the noname "64GB" stick had 240MB real flash
  (f3probe). It's trash. Test unknown sticks with `f3probe --destructive`.

## Windows-install traps (for HINOKI round 2)

1. Legacy-booted setup refuses GPT target disks → target must be MBR.
2. "We couldn't create a new partition or locate an existing one" → **unplug all
   other internal disks during install.** Boot-order changes and diskpart do NOT
   clear it; single-disk install does. Replug after.
3. Skip product key during install; check case for a COA sticker.
4. Fast startup lies: only `shutdown /h` (hibernate) and `shutdown /s` from cmd
   behave predictably. GUI Shutdown ≠ clean S5 either way — irrelevant since we
   never shut down (Prime Directive).

## Sakura dual-boot state (GRUB on the Kingston, boots first)

- BIOS boot order: **Kingston (GRUB) first**, 1TB second. F12 for one-offs.
- GRUB: `GRUB_DEFAULT=saved`, os-prober enabled, menu shows Fedora entries +
  "Windows 10 (on /dev/sda1)". Default set via
  `grub2-set-default "<exact title>"` + verify `grub2-editenv list`.
- **DONE 2026-07-19:** default = Fedora (saved_entry), timeout = 3 s, junk USB
  entry removed (stick unplugged + regen), 30_uefi-firmware disabled. Menu is
  exactly: Fedora entries + "Windows 10 (on /dev/sda1)".
  Trade-off (user accepted): unattended wake while Windows hibernated boots
  Fedora after 3 s; the hibernated Windows stays frozen safely and resumes when
  picked from the menu.
- Windows power UX (done): Hibernate in Start power menu, physical power button
  = Hibernate, `shutdown /h` shortcut on taskbar. Wake proven from BOTH S3
  sleep (blinking power LED) and S4 hibernate (LED dark, port LEDs lit).

## Backups & staged artifacts (HINOKI)

- `~/Backups/WINBACKUP-usb-2026-07-18/` — full user-profile backup of the old
  broken Win11 (user `agust`, 3 564 files). Irreplaceable.
- `~/Backups/O990-A24.exe` — Dell BIOS A24, sha256 `73828299…91ec42`.
- `~/Downloads/Win10_22H2_English_x64v1.iso` — official MS ISO, sha256
  `a6f470ca…852e`. Do NOT use the "Eagle123 20in1" warez ISO on Sakura's Fedora.
- Old Win11 leftovers on HINOKI: NVRAM entry "Windows 11" + `EFI/Microsoft` on
  the ESP — harmless; clean up during HINOKI round 2.

## Open missions (the autonomous work queue)

1. ~~GRUB default → Fedora~~ **DONE 2026-07-19** (also timeout 3 s, menu cleaned).
2. ~~Recreate data partition~~ **DONE 2026-07-19 (final form: SHARED NTFS):**
   sda2 = 531GB **NTFS** "SAKURA-DATA" = Windows **D:** AND Fedora
   `/home/hinoki/Storage` (fstab ntfs3, uid/gid=1000, nofail, UUID
   774F65EB38415CF1). Windows environment itself is capped at its 400GB C:.
   Caveat: Linux refuses to mount it while Windows hibernated with the volume
   dirty (by design, nofail keeps boot clean).
3. **AutoCAD LT 2013 on Sakura-Windows** — the entire point of the campaign.
   User's electrician work. (Wine attempt abandoned: `~/Desktop/setup_autocad_wine.sh`.)
4. ~~WW agent for Windows~~ **DONE 2026-07-19 — installed + verified** (agent
   `wwra_xCR5XgqeHAd2RkAzsp81bWPo`; see Access paths). History below:
   Port complete (win32 paths/PATHEXT/PowerShell shell/identity/inventory;
   `power.poweroff` defaults to `shutdown /h` per Prime Directive; new
   `power.hibernate` action both platforms; tests 197/197 green, docs in
   `docs/RECOVERY.md` § Windows agent). Self-contained bundle with embedded
   node.exe: `artifacts/ww-recovery-agent-windows.zip` (rebuild:
   `npm run recovery:agent-windows-bundle -- --download-node`).
   **Remaining (user, once, inside Sakura-Windows), elevated PowerShell:**
   `irm http://192.168.8.104:8800/win.ps1 | iex`
   (2026-07-19: permanent artifact server on HINOKI:8800 — systemd user unit
   `ww-bootstrap-http.service` serving `~/WorkWire/artifacts/`; win.ps1
   downloads the zip, unpacks, and runs the installer with
   `-Controller http://192.168.8.104:4852`. Fedora-side WW convergence
   one-liner also hosted there: `curl -s http://192.168.8.104:8800/sakura.sh | sh`.)
   (no token — Sakura's Fedora agent runs tokenless). Installs a SYSTEM
   scheduled task, auto-start at boot, auto-restart, reconnects after resume.
   Unlocks full autonomy over Sakura-Windows (missions 2, 3, 6).
5. **HINOKI round 2**: Toshiba 465GB into HINOKI's free bay. **Layout (user
   decided 2026-07-19): ~215GB Windows + 250GB Linux-secondary storage.**
   Suggested: MBR table, p1 = ~215GB NTFS bootable (Windows target), p2 = 250GB
   for Fedora storage. Traps: unplug the Crucial during the Windows install
   (trap #2); the WININSTALL stick is LEGACY-boot only, so Windows installs
   legacy/MBR on the Toshiba while Fedora stays UEFI on the Crucial — boot
   selection via F12 or GRUB os-prober chainload. Then: HINOKI BIOS → AC
   Recovery = Power On + enable WoL, and test HINOKI's own wake caps (newer
   board, S5 may genuinely work) → Sakura⇄HINOKI symmetric wake.
6. ~~Intel PROSet driver~~ **DO NOT CHASE — dead end (verified 2026-07-19).**
   PROSet's only relevant feature is "Wake on Magic Packet from power-off (S5),"
   which is FIRMWARE-CAPPED on this OptiPlex 990 (GLAN arms S4 only; BIOS A24 is
   final) — no driver can override it. S4 hibernate-wake already works on the
   inbox driver. PROSet buys nothing here; don't swap the NIC driver (it's the
   only remote lifeline) for a firmware-blocked feature.
7. ~~Reconcile uncommitted code~~ **DONE 2026-07-19**: tests updated to the new
   config (pxelinux.0, user=root, tag:!ipxe, rule ordering); full suite 188/188
   green. Still uncommitted — do not commit/push without the user's OK.
8. **CMOS battery watch** (Sakura): BIOS settings survived recent cycles, but if
   they revert again with correct save procedure → replace CR2032.
9. ~~Regenerate grub.cfg after stick unplug~~ **DONE 2026-07-19.** The
   WININSTALL stick is stored safely offline — it's the only bootable Windows
   installer (+ carries O990-A24.exe).
10. ~~Disable Sakura-Windows login password at boot~~ **DONE 2026-07-19 via agent:**
   Winlogon AutoAdminLogon=1, DefaultUserName=`Sakura`, DefaultPassword set,
   DefaultDomainName=DESKTOP-MMLPL5U; wake password off via
   `powercfg /SET{AC,DC}VALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 0`.
   Verified AutoAdminLogon=1/User=Sakura/HasPw=True. **Not yet reboot-tested**
   (can't unattended — GRUB default is Fedora, nobody at keyboard to pick
   Windows). The real Windows login user is **`Sakura`**, not `hinoki`.
11. **AutoCAD (mission 3) is now UNBLOCKED** — agent live, can drive install
    remotely; still needs the user's install media/license on the box.
12. **RESOLVED — Windows uses ONE partition for everything (user 2026-07-19):**
    no D: wanted on the Windows side. C: WINDOWS is the whole Windows environment;
    the 531GB sda2 shared-NTFS stays Fedora-only (`/home/hinoki/Storage`). Do not
    create a Windows D:. AutoCAD + all Windows data live on C:.

## Session-start checklist for a future agent

```bash
cd ~/WorkWire
node ww.mjs recovery agents --json | head -50   # who's alive?
ping -c1 192.168.8.106                          # Sakura up at all?
sudo /usr/local/sbin/workwire-recovery-pxe status
systemctl --user status workwire-ww.service | head -5
```
- Sakura answers as Fedora-agent → full root control.
- Sakura up but no agent → it's in Windows (no reach yet; ask the user or wait).
- Sakura down → `node ww.mjs recovery wake 18:03:73:2e:3f:42` (works ONLY if it
  was hibernated and port LEDs are lit).
- Never flashrom. Never assume a stick/disk is what its label says — look first.
- Full machine pair details: memory notes + `docs/RECOVERY.md` + this file.
