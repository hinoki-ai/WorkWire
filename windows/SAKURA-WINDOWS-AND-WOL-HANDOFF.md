# Sakura — Windows repair + BIOS/Wake-on-LAN handoff

> **ARCHIVED EVIDENCE — NOT AN OPERATIONS RUNBOOK.** Addresses, credentials,
> bootstrap commands, and open missions below describe earlier experiments and
> may be stale. Agents must use
> [docs/AGENT-OPERATIONS.md](../docs/AGENT-OPERATIONS.md) and
> [windows/WINDOWS.md](./WINDOWS.md) for current state. Never copy a credential
> from this archive into a command or report.

> ## ✅ RESOLVED 2026-07-19 — read this before the rest
>
> The mission below is COMPLETE. Outcome and hard-won lessons:
>
> 1. **There was no Windows to repair.** Sakura's disks never held Windows; the "broken
>    Windows" lived on a 1TB SSD previously inside HINOKI (its NVRAM Win11 entry +
>    `EFI/Microsoft` on HINOKI's ESP proved it). Fresh Win10 22H2 was installed instead,
>    onto that 1TB moved into Sakura (400GB NTFS partition, MBR, legacy boot).
> 2. **Windows-install traps on this box:** legacy-booted setup refuses GPT disks; the
>    error "couldn't create a new partition or locate an existing one" persisted until the
>    OTHER internal disk (Fedora SSD) was physically unplugged during install. Boot-order
>    changes and diskpart alone did NOT clear it.
> 3. **USB media traps:** the noname "64GB" stick is counterfeit (240MB real — f3probe).
>    Ventoy black-boots on it and on this era of BIOS; what works reliably is a single
>    bootable NTFS partition + GRUB `ntldr /bootmgr` chainload. Verify any boot stick in
>    QEMU (`-snapshot -drive file=/dev/sdX,format=raw` + QMP screendump) before walking it
>    to the machine.
> 4. **LAN/PXE boot of the recovery image WORKS on Sakura** — but only via classic
>    PXELINUX over pure TFTP. iPXE (both undionly.kpxe and a native-driver build) cannot
>    receive unicast on the 82579LM's boot ROM (broadcast DHCP fine, ARP/TCP dead). BIOS
>    needs "Wake on LAN = LAN with PXE Boot" (the setting silently reverts after flashes/AC
>    loss — recheck it). Server-side fixes on HINOKI: dnsmasq `user=root`, `tag:!ipxe`
>    gating, firewalld dhcp/tftp services, canonical state dir
>    `~/WorkWire/.workwire/config/recovery`.
> 5. **A24 was flashed from the fresh Windows — and the S4 cap REMAINS.** `GLAN S4` on
>    A24 too: the OptiPlex 990 will never wake from S5. Final workflow, proven end-to-end:
>    **Windows `shutdown /h` (hibernate) → `node ww.mjs recovery wake 18:03:73:2e:3f:42`
>    → Sakura resumes Windows.** After ANY AC loss or BIOS flash, do the AC-drain ritual
>    (unplug cord, hold power 10s, replug) or Deep Sleep kills NIC standby power (dark
>    port LEDs when off = no wake).
>
> Remaining loose ends: replug Sakura's Fedora SSD SATA cable; add Windows to GRUB
> (os-prober) for a dual-boot menu; install Intel PROSet driver in Windows (fixes slow
> NIC + exposes proper WoL knobs); install AutoCAD LT 2013; recreate the 531GB
> SAKURA-DATA partition (wiped during diskpart clean); reconcile uncommitted
> `lib/recovery/ww-recovery-boot.mjs` changes with its tests.

---

Written 2026-07-18 by the prior agent. Read this fully before acting. It captures
a long troubleshooting session so the next agent does **not** repeat it.

---

## TL;DR — where we are

- **HINOKI fully controls Sakura as root over the LAN.** Proven. This works now.
- **HINOKI can power Sakura OFF** over the LAN. Proven.
- **HINOKI cannot power Sakura ON (Wake-on-LAN from full off)** yet. Root cause is
  the **2012 BIOS (A13)**, which only allows LAN wake from **S4 (hibernate)**, not
  **S5 (full off)**. Everything OS-side is correct; the firmware caps it.
- **The fix is BIOS update A13 → A24.** The verified A24 file is already downloaded
  and staged (see below). BUT it can only be flashed **from Windows** on this
  machine, and **Sakura's Windows is broken**.
- **Therefore the next job is: repair Sakura's Windows → flash BIOS A24 from it →
  Wake-on-LAN then works.** The BIOS flash is a one-time firmware change; after it,
  WoL works regardless of which OS boots (Linux included).

**Do NOT** try to flash the BIOS from Linux/DOS. Confirmed impossible on this box:
A24 is a Windows-only PE32 (won't run in DOS, no extractable payload), A13 has no
F12 "BIOS Flash Update", the board boots legacy (no UEFI capsule / ESRT), and the
`dell_rbu` kernel module isn't present. `flashrom` exists but would risk an
unrecoverable brick — **do not use it.**

---

## The two machines

- **HINOKI** (this machine): `192.168.8.104`, eno1 MAC `34:17:eb:af:a8:99`, Fedora 43.
  Runs the WorkWire service + the recovery **controller** on port **4852**
  (`0.0.0.0:4852`, reachable on the LAN, confirmed 200). Repo at `/home/hinoki/WorkWire`.
- **Sakura**: `192.168.8.106`, hostname `Sakura`, Dell **OptiPlex 990**, Fedora 43
  (kernel 6.19.x), wired NIC **eno1**, MAC **`18:03:73:2e:3f:42`** (Intel 82579LM,
  e1000e). BIOS **A13** (2012). Dual-boots Fedora (works) + Windows (**broken**).

Prototype sudo material is stored only in HINOKI's protected recovery
environment file. Load it without printing and pass it on stdin; no credential
is canonical documentation.

---

## How to control Sakura from HINOKI (the recovery link)

A **root** recovery agent runs on Sakura as a systemd service and connects to
HINOKI's controller. It **auto-reconnects after every reboot** — no action needed.

- Agent id: `wwra_DoXG4t0yKhZTervalUWlML7R` (host `Sakura`, uid 0).
- Installed at `/opt/workwire/recovery-agent`, unit `workwire-recovery-agent.service`
  (enabled), config `/etc/workwire/recovery-agent.json` → controller
  `http://192.168.8.104:4852`.

From HINOKI (`cd /home/hinoki/WorkWire`):
```bash
A=wwra_DoXG4t0yKhZTervalUWlML7R
node ww.mjs recovery agents --json                 # see Sakura online/root
node ww.mjs recovery exec  "$A" -- <argv...>        # run a command on Sakura (root)
node ww.mjs recovery shell "$A" -- '<bash script>'  # run a bash script on Sakura (root)
node ww.mjs recovery wake  18:03:73:2e:3f:42        # send Wake-on-LAN (works, but see WoL note)
```
Note: recovery jobs that mutate (write/format/etc.) may need `--force`.

**If the agent ever isn't connected** (e.g. a fresh reinstall), on Sakura run the
staged one-command re-link: `cd ~/WorkWire && sh go.sh` (idempotent; it embeds the
sudo password and reinstalls the root agent pointed at HINOKI). Files `go.sh` and
`wwra.tgz` are already in Sakura's `~/WorkWire/`.

**File transfer HINOKI→Sakura** still works over the file desk (port 4851) even
though the desktop *app* link is version-mismatch-blocked (see "known issues").
Use `scratchpad/sakura.mjs` on HINOKI: `node sakura.mjs list|stat|mkdir|put`.

---

## Sakura disk layout (from `lsblk` while running Fedora)

```
sda   465.8G  TOSHIBA MK5055GSX (HDD)
└─sda1 465.8G  -> mounted /home/hinoki/Storage        (data; filesystem type unconfirmed)
sdb   111.8G  KINGSTON SA400S37120G (SSD) = the OS disk
├─sdb1   1M
├─sdb2   1G    -> /boot
├─sdb3 110.3G  -> / (root is sdb3[/root]) and /home
└─sdb4 549M    -> /boot/efi   (an ESP exists, but Fedora is booting LEGACY)
sdc    28.9G  KINGSTON DataTraveler 3.0 (USB) = the BIOS-flash stick (FAT32, label WWBIOS)
```

**Where is Windows?** Not obvious in the above (no NTFS partition mounted while in
Fedora). It shows in the F12 **UEFI Boot** menu as "Windows", so a Windows install
exists somewhere (possibly on `sda`, or an unmounted partition). **First step of the
Windows repair: locate it** — from HINOKI: `node ww.mjs recovery shell "$A" -- 'lsblk
-f; blkid; ls /sys/firmware/efi/efivars 2>/dev/null; efibootmgr -v 2>/dev/null'`.
The machine has both a legacy Fedora and UEFI entries — mind the boot-mode mismatch.

---

## BIOS / Wake-on-LAN — what's done and what's staged

**Root cause (certain):** `/proc/acpi/wakeup` shows `GLAN  S4  *enabled  pci:0000:00:19.0`
— the NIC is armed as a wake source but the firmware only supports it up to **S4**,
not **S5**. Proven that HINOKI's magic packet is perfect and **reaches Sakura's NIC**
(captured on Sakura), and the NIC has standby power in S5 (link LEDs blink when off).
The board just won't wake from full-off on A13.

**OS-side WoL config already applied on Sakura (persistent, survives reboot):**
- EEE (Energy-Efficient Ethernet) **disabled** on eno1.
- NetworkManager `802-3-ethernet.wake-on-lan = magic` on "Wired connection 1".
- `ethtool -s eno1 wol g` armed.
- systemd unit `ww-wol.service` re-arms (EEE off + wol g) at **boot and shutdown**
  via `/usr/local/sbin/ww-wol-arm.sh`.
- BIOS (set by user): **Deep Sleep Control = Disabled**, **Wake on LAN/WLAN = LAN Only**.
  (An AC-power drain was needed for Deep Sleep to actually engage NIC standby power.)

**The BIOS update file (verified genuine):**
- `O990-A24.exe`, 5,875,088 bytes, **SHA-256
  `73828299c42b02fb741c6e992973b9412935f72e3a2bc2b86d9aee020e91ec42`** (matches
  Dell's published checksum). Source:
  `https://dl.dell.com/FOLDER05078495M/1/O990-A24.exe` (needs a browser User-Agent;
  bare curl gets 403).
- Staged on **HINOKI**: `scratchpad/O990-A24.exe`.
- Staged on **Sakura**: `~/WorkWire/O990-A24.exe` (checksum re-verified there).
- Staged on the **USB** (`/dev/sdc`, FAT32, label `WWBIOS`): `O990-A24.exe` (checksum
  re-verified there).

**To flash (once Windows boots):** in Windows, double-click `O990-A24.exe` (from the
USB or copy it in), approve A13→A24, let it reboot/flash (~5 min, don't cut power).
After flashing, re-check BIOS: Deep Sleep = Disabled, Wake on LAN = LAN Only. Then
from HINOKI power Sakura off and run `node ww.mjs recovery wake 18:03:73:2e:3f:42`.

**Caveat:** A24 is the best and only shot to lift the S4 cap, but it is not
guaranteed to add S5 WoL on this 2011 unit. If A24 still caps at S4, this machine
simply won't cold-wake over LAN; use a newer target for that, or accept S4/hibernate.

---

## The Windows repair task (the actual next job)

Goal: get Sakura's Windows to boot enough to run one `.exe`. Use the recovery link —
HINOKI has root + full disk access to Sakura, which is exactly what this tooling is for.

Suggested approach:
1. Locate the Windows partition(s): `lsblk -f`, `blkid`, look for NTFS.
2. Determine boot mode of that Windows (UEFI vs legacy) and whether its boot files
   (BCD/EFI) or the NTFS filesystem are the problem.
3. Typical repairs (all runnable via the recovery agent as root on Sakura, or from
   the recovery live image): `ntfsfix`/chkdsk-equivalent, rebuild BCD, fix the EFI
   boot entry (`efibootmgr`), or repair the bootloader. The recovery action catalog
   includes `boot.windows.bcd.inspect`, `filesystem.repair` (ntfs), `boot.efi.*`,
   `mount.*`, `disk.*`.
4. Once Windows boots, flash the BIOS (above), then test WoL.

Be careful: this is a real machine with real data on `sda`/`sdb`. **Image/back up
before any destructive partition/boot repair.** Never auto-mount or modify patient
filesystems without an explicit, considered step.

---

## Known issues / gotchas (don't re-discover these)

- **Desktop app link is version-mismatch-blocked.** Sakura runs old WW
  `0.1.0+ww1.896a3f63e397` (pre-updater, no `/v1/update-status`); HINOKI source is
  newer (`…295fca8906a3`+). `/v1/connect` returns 409 `ERR_WW_APP_VERSION_MISMATCH`,
  so the *GUI* file link shows "waiting for other PC." Authenticated file endpoints
  (list/stat/put/…) still work. Fixing the GUI link = update Sakura's WW app to
  match HINOKI (deferred; not needed for the Windows/BIOS work).
- `pkill -f 'qemu-system-x86_64'` or `pgrep -f '<string in your own cmdline>'` will
  match and kill your own shell — exclude `$$` or use exact PIDs.
- dl.dell.com needs a browser `User-Agent` or returns 403.

---

## What is proven working (don't second-guess these)

- HINOKI ↔ Sakura root command/shell execution over LAN (`uname`, `id`→uid=0, etc.).
- HINOKI powering Sakura off (`systemctl poweroff` via agent).
- Agent auto-reconnect after Sakura reboots.
- Magic packet leaves HINOKI correctly and arrives at Sakura's NIC.
- The BIOS A24 file is genuine and staged in three places.

The ONLY open item is: **repair Windows → flash A24 → confirm cold-off WoL.**
