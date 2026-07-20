# HINOKI to Sakura Windows fleet contract

This file is an agent entry point. The authoritative, executable runbook is
[docs/AGENT-OPERATIONS.md](../docs/AGENT-OPERATIONS.md). Read it completely
before operating the fleet. The adjacent long-form Windows/WoL handoff is
archived historical evidence and must not be used as current configuration.

## Stable Sakura facts

- File-service identity: `RQn5hi_GTBHwvC6bQmmTYg`.
- SYSTEM recovery identity: `wwra_xCR5XgqeHAd2RkAzsp81bWPo`.
- NIC MAC: `18:03:73:2e:3f:42`.
- Source: `C:\Users\Sakura\WorkWire`.
- File config: `C:\Users\Sakura\.config\workwire\ww-config.json`.
- GUI: `C:\Users\Sakura\AppData\Local\WorkWire\app\WorkWire.exe`; its
  `resources\app` junction targets the source root.
- File service: scheduled task `WorkWire Serve`, TCP 4851.
- Recovery agent: scheduled task `WorkWire Recovery Agent`, LocalSystem.
- Recovery desk: external HINOKI controller, never a Sakura-local controller.

Sakura's address is DHCP-derived. Discover it from the online stable recovery
agent or current network state; never reuse `.106`. ICMP is blocked and cannot
prove Sakura is down.

## Non-negotiable power rule

The Dell OptiPlex 990 firmware/NIC combination wakes over LAN from S4 hibernate,
not S5. Never issue `shutdown /s`, `Stop-Computer`, or recovery
`power.poweroff` with an explicit shutdown method. Use `shutdown /h` or leave
Windows running. A wake attempt is successful only when the stable recovery
agent checks in again.

## Autonomous repair path

Do not use browser downloads, interactive elevation, plaintext passwords,
`winapp.ps1`, or copied one-liners. The already-online SYSTEM recovery agent is
the bootstrap transport and executor. Build and upload the canonical source
archive and self-contained recovery-agent bundle, validate PowerShell syntax,
then run `scripts/converge-ww-windows.ps1` as specified in the canonical
runbook. The script verifies hashes before registering the persistent service.
Recovery runtime replacement is delegated to a separate SYSTEM updater task;
never stop the active recovery task from an updater child inside that same task.
The file service's companion watchdog is the independent repair path if the
recovery task is stopped.

If the Windows recovery agent is offline, first use Wake-on-LAN and wait for its
stable ID. If S4 wake is physically unavailable, software cannot create standby
power; record that exact physical condition without replacing stable state or
weakening validation.

## Acceptance

Sakura is converged only when all of these are simultaneously true:

- `/v1/discover` is authenticated and reports the exact current WorkWire build;
- the current update-source hash equals HINOKI's;
- its peer is pinned to HINOKI's stable service ID and current address;
- the file task survives a forced process stop through its watchdog;
- the recovery task survives a forced stop through its repeated trigger and
  file-plane companion watchdog;
- the GUI junction and both shortcuts target the canonical install;
- the desktop attaches to HINOKI's central recovery controller;
- LocalSystem execution is proven with `whoami.exe`;
- Sakura drives HINOKI's root agent and observes `id -u` equal to `0`;
- bidirectional file, mirror, conflict, artifact, session, tunnel, fleet, and
  autonomy proofs pass from disposable fixtures;
- Sakura remains running or hibernated, never S5-powered-off.

No secret belongs in this document. Protected local state is the only credential
source.
