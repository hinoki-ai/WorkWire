# WorkWire Archon recovery capability

For the live HINOKI/Sakura fleet topology, autonomous convergence, privilege
parity proofs, and shutdown gate, follow
[AGENT-OPERATIONS.md](./AGENT-OPERATIONS.md). This document defines the
recovery capability of the Agentic Archon.

WorkWire is the Agentic Archon: a local-first authority over operator-owned
machines on a private wired LAN. Recovery is one expression of that authority,
not a separate product. It is a root-capable control plane exercised through
privileged agents. The original paired file desk remains another capability:
file synchronization stays on port 4851, while recovery uses its own
controller, identities, durable state, and protocol on ports 4852 and 4853.

The recovery plane can discover installed or PXE-live agents, collect hardware and storage inventory, run unrestricted argv or Bash as the agent's actual user (normally root), execute typed disk/filesystem/boot actions, move resumable artifacts, wake machines, and drive an autonomous case loop. Do not expose these ports through an internet router.

## Quick start

Install dependencies and verify the software:

```bash
npm ci
npm test
```

Start the normal WorkWire background service. It starts the file and recovery controllers independently:

```bash
ww serve
ww recovery controller status
```

Run an agent on an operator-owned target as root, or install its root system service:

```bash
sudo ww recovery agent run --controller http://192.168.8.104:4852 --name patient-01
sudo npm run recovery:agent-install -- --controller http://192.168.8.104:4852
```

The installer is idempotent. `ww recovery agent status` reports the unit; `ww recovery agent uninstall` stops and removes the unit/runtime but preserves `/var/lib/workwire-recovery` by default.

## Desktop workspace

By default a desk uses its local embedded controller. Set
`WW_RECOVERY_CONTROLLER_URL`, or `extensions.clientUrl` in `controller.json`, to
attach it to a fleet controller. An explicit remote controller is authoritative:
if unavailable, the desk reports the failure and does not silently create a
local split-brain controller.

Open WorkWire and switch between Files and Recovery with the compact switch, or use:

- `Ctrl/Cmd+1`: Files.
- `Ctrl/Cmd+2`: Recovery.
- `Ctrl/Cmd+Enter`: execute the current argv or Bash editor.
- `Ctrl/Cmd+Shift+Enter`: create/update and run the current autonomous goal.
- `Escape`: leave/revert the active local editor; it never cancels a remote job.

Recovery shows the live/stale/offline fleet, target identity and tool coverage, disk topology and health, typed actions, unrestricted argv/Bash, force propagation, cases, jobs, exact stdout/stderr, planner events, artifacts, Wake-on-LAN, playbooks, and PXE state. Networking and tokens remain in Electron's privileged main process; the sandboxed renderer has no direct network access.

## CLI workflows

List and inspect targets:

```bash
ww recovery agents
ww recovery wait AGENT_ID --timeout 120000
ww recovery inspect AGENT_ID --refresh
ww recovery inspect AGENT_ID --raw --json
```

Run exact argv or unrestricted Bash. Everything after `--` is sent as argument/script data without local shell reinterpretation:

```bash
ww recovery exec AGENT_ID -- lsblk --json --bytes --output-all
ww recovery exec AGENT_ID --force --timeout 0 -- ddrescue --force /dev/source /mnt/healthy/disk.img /mnt/healthy/disk.map
ww recovery shell AGENT_ID -- $'set -euo pipefail\nmount /dev/mapper/root /mnt/workwire/root\nls -la /mnt/workwire/root'
ww recovery shell AGENT_ID --file ./repair.sh
```

Finite commands with `--json` emit one JSON result. `case follow` and `follow JOB` emit JSONL when `--json` is supplied. Remote exit codes 1–125 are propagated where possible; controller/transport failures use a separate nonzero CLI failure.

Cases, artifacts, and playbooks:

```bash
ww recovery case create AGENT_ID --goal "Inspect the disk and repair the Linux boot path" --autonomous
ww recovery case run CASE_ID
ww recovery case follow CASE_ID
ww recovery case stop CASE_ID
ww recovery retry JOB_ID

ww recovery put AGENT_ID ./local.bin /tmp/local.bin
ww recovery get AGENT_ID /var/log/boot.log ./boot.log
ww recovery artifacts CASE_ID

ww recovery playbook list
ww recovery playbook show linux-boot-repair
ww recovery playbook run linux-boot-repair AGENT_ID --inputs '{"rootPath":"/dev/mapper/vg-root"}'
```

The seven included playbooks cover Linux boot repair, partition recovery, failing-disk cloning, UEFI/GRUB, Windows/NTFS, mdraid/LVM/LUKS, and resize/migration. Expanded steps are visible before a single execute action, and custom steps or raw shell remain available.

## Durable state and recovery semantics

The default state root is `~/.config/workwire/recovery`; set `WW_RECOVERY_STATE_DIR` to relocate it. Controller snapshots use atomic rename, journals are append-only JSONL, stdout/stderr are exact binary-safe logs, and artifacts use `.partial` files plus explicit offsets and SHA-256 completion hashes.

Important behavior:

- Agent identity is stable across reconnects. Installed agents persist an ID; PXE agents derive one from DMI UUID plus physical MAC when available.
- The agent initiates the WebSocket connection, so no inbound target firewall rule is required.
- A controller blackout does not stop a running target tool. The agent buffers ordered events, reconnects, replays them, and reconciles a durable completed result.
- A target/agent process restart marks the in-flight command interrupted; it is never reported as succeeded without a completed result.
- Retrying retains the logical job ID, attempt history, and previous events.
- Disk actions resolve a stable `deviceId` to the current kernel path. A `deviceId`/path mismatch fails unless `force: true`, in which case the explicit path and override are recorded.
- `force: true` is passed through. There is no mandatory per-command approval gate.

The optional recovery token is configured with `WW_RECOVERY_TOKEN` or `controller.json`; an explicitly empty token is supported. It protects the recovery API, artifacts, SSE, and agent socket. PXE boot artifacts remain fetchable by firmware/iPXE, which cannot reliably add the bearer header. This is why the recovery network must remain private.

## Wake-on-LAN

```bash
ww recovery wake 00:11:22:33:44:55
ww recovery wake 00-11-22-33-44-55 --broadcast 192.168.8.255 --port 9
ww recovery wait AGENT_ID --timeout 120000
```

WorkWire sends the exact magic packet in a configurable burst and records known machine/MAC mappings. “Packet sent” is not a claim that hardware powered on: the target needs standby power and firmware/NIC Wake-on-LAN support. Agent check-in is the online proof.

## Windows agent

The recovery agent is pure Node + `ws` and runs natively on Windows. On `win32` the agent stores config, agent-id, and state under `%ProgramData%\WorkWire\` (`recovery-agent.json`, `agent-id`, `recovery-state\`), resolves tools through `PATHEXT`, defaults `shell.exec` to PowerShell (`cmd` and `bash` scripts are also mapped correctly by shell name), derives identity MACs from `os.networkInterfaces()`, and collects inventory via `systeminfo`/`ipconfig`/PowerShell `Get-Disk`/`Get-Partition`/`Get-Volume`/`Get-NetAdapter`. Platform-specific actions: `power.poweroff` **hibernates by default** (`shutdown /h`; pass `method: "shutdown"` for a real S5), `power.reboot` uses `shutdown /r /t 0`, `power.hibernate` exists on every platform (`systemctl hibernate` on Linux), and `process.*`/`service.*` map to `tasklist`/`taskkill`/`sc`/PowerShell.

```bash
npm run recovery:agent-windows-bundle -- --download-node   # artifacts/ww-recovery-agent-windows.zip (self-contained, embeds node.exe)
```

Bootstrap a new target through any operator-controlled transport. Once a target
agent is online, all upgrades use `recovery put` plus `recovery exec`; no browser,
interactive elevation, or human-local console is required. Build the bundle,
upload it to a named staging directory, validate the PowerShell parser result,
and invoke the installer through the existing root/SYSTEM agent:

```powershell
powershell -ExecutionPolicy Bypass -File install-ww-recovery-agent-windows.ps1 install -Controller http://192.168.8.104:4852
powershell -ExecutionPolicy Bypass -File install-ww-recovery-agent-windows.ps1 status
powershell -ExecutionPolicy Bypass -File install-ww-recovery-agent-windows.ps1 uninstall
```

The installer fully stages a new runtime, then delegates the live swap to the
separate `WorkWire Recovery Agent Update` SYSTEM task. Stopping the agent task
would terminate its child processes, so the independent updater is required for
a truthful self-update. It preserves the previous runtime, rolls back and
restarts it on failure, and records a redacted JSON result under
`%ProgramData%\WorkWire`. The installed `WorkWire Recovery Agent` task runs as
SYSTEM with startup, restart-on-failure, and repeated one-minute triggers. The
Windows file service also watches that exact companion task and starts it when
the process is absent. Hibernate/resume keeps the process alive; the agent's
reconnect loop restores the socket. Uninstall preserves config, agent-id, and
state.

## Fedora PXE host

PXE uses dnsmasq proxyDHCP plus TFTP for iPXE only; the router remains the DHCP address server. Kernel, initrd, and SquashFS are served over HTTP.

```bash
sudo npm run recovery:host-install -- --interface eno1
sudo /usr/local/sbin/workwire-recovery-pxe prepare
sudo /usr/local/sbin/workwire-recovery-pxe start
sudo /usr/local/sbin/workwire-recovery-pxe status

ww recovery pxe arm 00:11:22:33:44:55
ww recovery pxe local 00:11:22:33:44:55
```

The host installer targets Fedora, installs/locates dnsmasq, iPXE, QEMU/OVMF, image, disk, and network tools, installs a narrowly named root helper/unit, and uses the invoking WorkWire user's recovery state. Uninstall stops/removes only WorkWire's unit/helper/runtime and preserves recovery state.

WorkWire selects an unambiguous wired IPv4 interface or requires `--interface`. Generated dnsmasq configuration is validated before launch. Stop/status check both the saved PID and exact WorkWire config path, so an unrelated dnsmasq is never killed.

## Build and verify the Debian live environment

```bash
npm run recovery:image-build
npm run recovery:image-build -- --reuse-rootfs
npm run recovery:image-verify
```

The Fedora host builds through a pinned Debian bookworm live-build container. It downloads and checksum-verifies the pinned official Node 22 runtime, bundles the agent and `ws`, runs an in-image module import self-test, records packages/tools/protocol/build metadata, and atomically activates verified `vmlinuz`, `initrd.img`, `filesystem.squashfs`, checksums, and manifest under the recovery state root.

`--reuse-rootfs` retains live-build caches between iterations. Generated multi-gigabyte artifacts live in the recovery state directory and are excluded from the normal Electron package.

The prototype live console is root-capable and starts SSH as a fallback. The
build-time `WW_RECOVERY_ROOT_PASSWORD` supplies its console credential; inject it
from protected state and never record the value in source, argv, logs, or
documentation. The live system never auto-mounts patient filesystems or enables
patient swap; mdraid/LVM/LUKS activation remains an explicit job or shell
command.

## QEMU validation

After image verification:

```bash
npm run recovery:test:qemu
# Optional:
npm run recovery:test:qemu -- --image /path/to/boot/live --disk-size 6G --memory 3072
```

The harness creates only a named qcow2 inside a timestamped workspace output directory, boots the live kernel/initrd with user networking, waits for the agent, partitions/formats/mounts a disposable virtio disk, writes and reads a marker, backs up and deliberately corrupts/restores GPT, repairs ext4, round-trips artifacts, verifies stable agent ID with a new boot ID after reboot, and powers off through WorkWire. It retains controller/serial/summary logs but removes the disposable qcow2. KVM is used when accessible; otherwise QEMU TCG is used.

## Physical validation contract

Software cannot power a machine whose NIC/motherboard has no standby power, and it cannot change generic firmware settings that the firmware does not expose. An autonomous agent must distinguish that external physical condition from software failure and continue every software/QEMU/disposable-fixture gate. Before the first physical target test:

1. Connect controller and disposable target by wired LAN and confirm the subnet/router DHCP.
2. Enable PXE/network boot and Wake-on-LAN once in UEFI/BIOS; disable Secure Boot only if unsigned iPXE is rejected.
3. Test BIOS PXE and UEFI PXE with a disposable USB/SATA/NVMe device—not a valuable host disk.
4. Confirm stable DMI/MAC agent identity, destructive backup/corrupt/restore, network/power interruption recovery, Wake-on-LAN, and the local-boot exit path.

A physically failing disk is not repaired by rewriting partitions. Image/clone readable sectors to healthy storage with a persistent ddrescue mapfile first, then repair the clone unless the explicit recovery goal chooses direct work.

## Troubleshooting

```bash
ww recovery controller status --json
ww recovery agents --json
systemctl status workwire-recovery-agent.service
journalctl -u workwire-recovery-agent.service -f
sudo /usr/local/sbin/workwire-recovery-pxe status
dnsmasq --test --conf-file="$WW_RECOVERY_STATE_DIR/pxe/dnsmasq.conf"
```

If an image verification fails, do not activate or PXE-boot it; inspect the verifier's exact missing artifact/tool/initrd report. If PXE has more than one plausible wired interface, pass the intended interface explicitly. If an action reports a missing native tool, the planner and operator still retain unrestricted argv/Bash.
