# WorkWire fleet commander

The recovery commander is WorkWire's agent-driven, LAN-first control plane for many machines. It adds durable fleet rollouts, interactive terminals and tunnels, evidence-driven autonomous recovery, and optional continuity/sync/imaging/salvage lanes to the existing Files and Recovery workspaces. Raw argv, unrestricted shell, typed destructive actions, `force: true`, and direct takeover remain available.

Keep the controller and agent setup from [RECOVERY.md](./RECOVERY.md). Recovery ports belong on a private lab network, not an internet-facing interface.

## Fleet metadata and selection

Machines can carry an operator alias and arbitrary labels. Groups combine explicit agent IDs with an optional live query; saved queries are reusable selectors. Queries read dotted fields from the live agent record plus labels and optional continuity context. Supported comparisons are `=`, `!=`, `~=`, `has`, `in`, `>`, `>=`, `<`, and `<=`, joined by `and` or `or`.

```bash
ww recovery agents
ww recovery group save --id red-rack --name "Red rack" --targets wwra_a,wwra_b --query 'state=online and labels.rack=red'
ww recovery group list
ww recovery query save --id online-linux --name "Online Linux" --expression 'state=online and platform=linux'
ww recovery query list
```

The controller resolves a selector when each run starts. An explicit target that is offline remains an exact per-target record instead of silently disappearing.

## Fleet execution

Run exact argv against selected IDs, a group, a saved query, an inline query, or all known machines:

```bash
ww recovery fleet run --targets wwra_a,wwra_b --rollout all-at-once --wait -- uname -a
ww recovery fleet run --group red-rack --rollout bounded --concurrency 2 --wait -- lsblk --json
ww recovery fleet run --query-id online-linux --rollout canary --canary 1 --stop-on-failure --wait -- systemctl is-system-running
ww recovery fleet run --all --script 'printf "host=%s\n" "$(hostname)"' --force --wait

ww recovery fleet summary RUN_ID
ww recovery fleet follow RUN_ID
ww recovery fleet retry-failed RUN_ID --rollout bounded --concurrency 2 --wait
```

Rollout behavior:

- `all-at-once` starts every target together.
- `bounded` holds active targets to `--concurrency`.
- `canary` runs `--canary` targets first and stops before the rest if a canary fails.
- `--stop-on-failure` stops queuing further targets after any failure. JSON/API operations may instead use `stop.maxFailures`.

Each target retains its own case, job, attempt, start/end time, result, error, postcondition, and ordered stdout/stderr events. `summary` does not merge machine output. A retry creates a sourced run containing only failed targets.

The JSON operation surface also supports `command`, `shell`, inventory/health refresh, typed actions, reboot/power, playbook steps, artifacts, Wake-on-LAN, and optional image deployment, vault snapshot, sync, and salvage planning. For example:

```bash
ww recovery fleet run --group red-rack --operation '{"type":"health-refresh","lightweight":true}' --wait
ww recovery fleet run --targets wwra_a --operation '{"type":"filesystem.check","params":{"deviceId":"disk_fixture"},"postcondition":{"path":"job.state","operator":"=","value":"succeeded"}}' --wait
```

Unsupported native operations remain visible through the action capability matrix and can be performed with exact argv or unrestricted shell.

## Restart-safe schedules and health rules

Schedules accept one ISO timestamp (`at`) or an interval (`everyMs`). `missed` is `skip`, `run-once`, or `catch-up` (bounded to ten catch-up occurrences per scheduler tick). A maintenance window uses local `HH:MM` start/end times and may cross midnight. Offline targets stay queued by default.

```bash
ww recovery schedule save --spec '{
  "id":"nightly-inventory",
  "name":"Nightly inventory",
  "everyMs":86400000,
  "missed":"run-once",
  "maintenance":{"start":"01:00","end":"05:00"},
  "selection":{"groupId":"red-rack"},
  "operation":{"type":"health-refresh"},
  "rollout":{"mode":"bounded","concurrency":2}
}'
ww recovery schedule list
ww recovery schedule delete nightly-inventory
```

Health rules consume continuity recommendations when that lane is present. A rule is explicitly one of `observe`, `recommend`, or `execute`; executing rules require a concrete `executionOperation`, so a recommendation string is never treated as executable input.

```bash
ww recovery health-rule save --spec '{
  "id":"refresh-critical-storage",
  "mode":"execute",
  "recommendation":"storage.health.refresh",
  "minimumSeverity":"critical",
  "selection":{"groupId":"red-rack"},
  "executionOperation":{"type":"health-refresh"},
  "rollout":{"mode":"bounded","concurrency":1}
}'
ww recovery health-rule list
```

Fleet state lives below `WW_RECOVERY_STATE_DIR/fleet/state.json` and is replaced atomically. Runs, schedules, next-run timestamps, event sequences, and health-rule dispositions reconcile after controller restart. A connected agent reuses the original in-flight job where possible, avoiding duplicate mutations.

Heartbeat receipt updates the live session and public agent record immediately;
the acknowledgement is not blocked by durable storage. Heartbeat/inventory/lease
checkpoints are rate-limited to a bounded interval derived from the configured
stale, offline, and lease windows (1–5 seconds in production bounds), while job
transitions retain exact durability. This keeps sub-second multi-agent fleets
responsive on Windows filesystems without weakening restart reconciliation.

## Interactive sessions

Jobs are for repeatable work; sessions are for exploration. A session carries real stdin/output, cwd, environment, rows/columns, signals, detach/reconnect state, an output sequence, and an honest ring-buffer gap flag.

```bash
ww recovery session open wwra_a --cwd /mnt/workwire/root
ww recovery session open wwra_a --detach -- /bin/bash --noprofile --norc -i
ww recovery session list --agent wwra_a
ww recovery session attach SESSION_ID
ww recovery session resize SESSION_ID --rows 50 --cols 160
ww recovery session signal SESSION_ID SIGINT
ww recovery session detach SESSION_ID
ww recovery session terminate SESSION_ID
```

Linux uses a real PTY through the installed `script` utility when available and reports its actual mode. Windows prefers an installed `winpty`/ConPTY bridge with PowerShell; if unavailable it exposes a truthful PowerShell pipe fallback, where resize and Unix-style signal semantics are not claimed. The controller preserves session records and ordered output. A live agent PTY can reattach after controller restart; a target process that no longer exists is reported lost rather than fabricated as resumed. Per-agent limits can be bypassed only with the explicit `--override-limit` operator flag.

Session-scoped file upload/download use the controller API and resolve relative paths against the session cwd. The Electron cockpit exposes these operations through the privileged main process; renderer code never receives the recovery token or opens a controller socket.

## TCP tunnels and installed consoles

Create a loopback listener on the controller that reaches a service from the target agent's network position:

```bash
ww recovery tunnel open wwra_a 127.0.0.1 5432 --listen-port 0
ww recovery tunnel list
ww recovery tunnel close TUNNEL_ID
```

The returned port is bound to `127.0.0.1` unless `--listen-host` is explicitly supplied. The bytes travel through the existing agent/controller channel.

WorkWire discovers installed RDP, VNC, SPICE, SSH, serial/SOL, and browser launchers and reports both available and unavailable alternatives:

```bash
ww recovery console discover
ww recovery console open ssh patient-01
ww recovery console open rdp 192.168.8.42 --user Administrator
ww recovery console open custom -- /path/to/lab-transport unusual-host --exact-argument
```

Custom transport argv is preserved exactly. WorkWire launches an existing client; it does not implement a remote-desktop codec.

## Autonomous plans and repair proof

An autonomous case maintains a durable plan graph. Nodes represent facts, hypotheses, actions, observations, protection points, alternatives, and proofs. Edges represent dependencies, expected observations, retries, alternate paths, and compensation. The graph records the current hypothesis and next action rather than reducing recovery to a chat transcript.

```bash
ww recovery case create wwra_a --goal "Protect the disk, repair boot, and prove the machine is bootable" --autonomous
ww recovery case run CASE_ID
ww recovery case follow CASE_ID
ww recovery case stop CASE_ID
```

Planner adapters include deterministic fixtures, operator/manual control, arbitrary JSONL commands, `codex exec --json --full-auto` when Codex is installed, and a configured local-model HTTP or command endpoint. Planner context includes live inventory, mounts/processes/storage, action capabilities, exact recent failures, playbooks, optional machine history/diffs, prior similar cases, and optional vault/image/salvage facilities.

An action returning exit code zero is weak evidence, not repair proof. Completion requires at least one successful machine-verifiable postcondition, such as exact output, an inventory fact, stable device identity, a hash, mount/service/listener state, a filesystem observation, or a boot result. Mutations trigger the minimum relevant fact refresh. Identity changes, disappearing devices, contradictory observations, repeated failures, and planner loops become explicit planner evidence.

When configured or requested, destructive work first records the strongest available recovery point: continuity vault snapshot, partition backup, disposable image, or explicit artifact. If an appropriate clone and QEMU are available, shadow execution applies and verifies the proposed actions on that disposable image before the same plan is sent to the physical executor. Unrestricted mode can explicitly bypass shadowing; the bypass is recorded.

A successful case writes a hash-addressed, parameterized procedure that keeps its source case ID, prerequisites, exact steps, `force` flags, postconditions, and proofs. Replay substitutes `${input.name}` or `${parameter.name}`, executes in order, and stops at the first failed result or proof. The final case report states the initial failure, evidence, exact changes, protected data, verification, residual uncertainty, and next action.

Manual takeover stops the autonomous loop without narrowing operator power. The same raw argv, shell, typed actions, terminal, and plan evidence remain visible. Stable planner request IDs make planner crash, blackout, and agent-reboot recovery idempotent: completed mutations are observed and reused rather than submitted again.

## Cockpit

Open the existing WorkWire desktop and select Recovery (`Ctrl/Cmd+2`). The high-density cockpit provides:

- Machine switcher with connectivity, health, active work, last boot, labels, and selected-target inventory.
- Multi-select fleet commander with group/live-query selection, rollout/concurrency, exact argv, live per-target state, retry, health refresh, and schedules.
- Jobs, exact output, canonical event timeline, artifacts, typed actions, playbooks, unrestricted argv/Bash, Wake-on-LAN, and PXE controls from the existing Recovery workspace.
- Terminal tabs with stdin, interrupt, detach, reconnect, terminate, target-local tunnels, and strongest-installed console launch.
- Autonomous plan graph, current hypothesis/action, proofs, alternatives, raw evidence, stop/resume, and unrestricted manual takeover.
- Capability panels for continuity history/health/vault, sync convergence/conflicts/versions, image catalog/deployment/verification, and salvage priority/capacity/progress/manifest when their frozen modules are installed.
- `Ctrl/Cmd+K` command palette for every real operation. Missing optional lanes and missing native console tools are shown as unavailable; there are no inert future buttons.

Files remains available with `Ctrl/Cmd+1`. Renderer operations cross the narrow preload IPC bridge to Electron main, which owns network access and secrets.

## Optional lane integration

`lib/recovery/ww-next-stage-adapters.mjs` is the only discovery point. It dynamically imports the frozen continuity, sync, imaging, and salvage entry points. Genuine absence hides that capability without preventing startup. Syntax errors, runtime failures, missing named exports, invalid manifests, unapproved adapter methods, and non-serializable results surface as contract errors. Successful imports are cached; an explicit refresh activates modules that arrive later.

When all lanes are present the cockpit and fleet/autonomy context use their real factories and methods:

- Continuity: machine history/diffs, identity graph, health recommendations/trends, vault snapshots/diff/scrub/restore/capacity, and cross-case memory.
- Sync: folders, peers, scans, convergence status, conflicts, versions, resolution, and restore.
- Imaging: catalog/search/inspect, capture, deployment planning/execution, verification, import/export, and lifecycle actions.
- Salvage: inventory, capacity estimation, plans, bounded previews, jobs/progress, reports, and checksum manifests.

No production fallback fabricates lane data. Linux packages contain the four optional module trees so installed builds activate the same contracts as the source tree.

## Performance and verification

Run the real three-agent benchmark:

```bash
npm run perf:commander -- --output handoff/next-stage/results/p3-commander-benchmark.json
```

The final 2026-07-19 Linux x64 / Node 22.22.0 reference run registered three loopback agents in 712.167 ms. Six end-to-end fleet runs produced these two-sample ranges: all-at-once 265.500–336.522 ms, bounded/concurrency-two 263.480–297.068 ms, and canary 288.734–508.247 ms. Terminal open took 19.563 ms and input-to-observed-output 15.568 ms. All 18 target results and 18 exact output events were retained, with zero loss and no terminal sequence gap. Treat these as one-host lab evidence, not a network SLA.

Core verification commands:

```bash
node --test test/ww-fleet-*.test.mjs test/ww-interactive-*.test.mjs test/ww-autonomy-next-*.test.mjs test/ww-next-stage-integration-*.test.mjs
npm test
npm run dist:linux
npm run recovery:image-verify
npm run recovery:test:qemu -- --output artifacts/recovery-qemu/fleet-final-clean-image --disk-size 4G
npm run test:fleet-recovery
npm run test:fleet-watchdogs
npm run test:fleet-windows
```

The image verifier enumerates the SquashFS, rejects both WorkWire conflict-copy
basename forms, and asserts the Node, systemd agent, agent entry point, and atomic
write runtime surfaces. The final clean image contained 31,771 entries and zero
conflict artifacts. The QEMU shadow helper uses the installed QEMU/KVM process.
The full recovery-image harness boots the generated Debian live kernel/initrd,
operates only on a named disposable 4 GiB qcow2, performs
partition/filesystem/GPT backup-corrupt-restore and artifact round trips,
verifies stable agent identity with a changed boot ID after reboot, and powers
off through WorkWire. The final eight-stage proof is
`artifacts/recovery-qemu/fleet-final-clean-image/summary.json`.

## Physical-only validation

Software and disposable QEMU fixtures cover the complete command nerve, but these claims still require their named physical environments:

- Native Windows SYSTEM execution is covered by the full 292-test Sakura run
  (281 passed and 11 intentional platform skips, with zero failures).
  Remaining Windows hardware-only checks are native ConPTY resize/signal on a
  host with the bridge installed, elevated boot/BCD/WinRE/event-log/storage/
  BitLocker mutation against disposable targets, and full OS reboot/install
  survival. The current Sakura runtime truthfully reports PowerShell pipes, so
  it does not claim ConPTY-only semantics.
- An ARM64 Linux host for installing and launching the ARM64 package and for ARM64 recovery-image boot. Metadata and runtime capability reporting are architecture-aware; the generated Debian live image in the x64 build gate remains amd64.
- Installed RDP/VNC/SPICE/serial/SOL clients and real target endpoints for visual/firmware-console interoperability. Discovery, exact argv, missing alternatives, custom transports, and agent TCP tunneling are software-tested.
- Disposable physical storage for controller/agent power loss during destructive disk repair, real firmware/UEFI variations, SMART/NVMe failure behavior, BitLocker recovery, PXE BIOS/UEFI boot, and post-repair physical boot.
- Wake-on-LAN hardware with standby power and firmware/NIC support. Packet creation and dispatch are software-verifiable; agent check-in after a powered-off state is the physical proof.

Never choose a valuable disk for those checks. Clone first, keep stable device identity in view, and record a recovery point before destructive work.
