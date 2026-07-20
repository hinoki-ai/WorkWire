# WorkWire Autonomous LAN Recovery Portal

## Execution TODO and autonomous-agent handoff

Status: implementation specification  
Prepared: 2026-07-17  
Workspace: /home/hinoki/WorkWire  
Host baseline: Fedora Linux 43, x86_64, Node 22.22.0, Podman 5.7.1, dnsmasq 2.91  
Existing test baseline: 106/106 passing with npm test  

This document is the controlling implementation handoff for the next coding agent. It turns WorkWire from a two-computer file desk into an unrestricted LAN recovery portal capable of booting, inspecting, controlling, and repairing other operator-owned computers.

## Handoff contract

The next agent should execute this document in order and keep going through every software-completable phase. Do not stop to ask the operator to choose names, frameworks, ports, state formats, UI layouts, or confirmation policies; those decisions are fixed below.

- Preserve all existing uncommitted work. The worktree already contains substantial user changes across the desktop, service, transfer, installer, tests, and documentation. Never reset, discard, check out, or overwrite them.
- Add recovery as a parallel subsystem. Do not destabilize the working file desk.
- Use Node.js 22, ESM, built-in Node APIs, the existing no-framework Electron renderer, and node:test.
- Add only one initial runtime dependency: ws, for controller/agent sockets. Do not introduce a frontend build system.
- Treat the wired LAN and all attached machines as operator-owned and trusted.
- Capability is the priority. Do not divert the implementation into RBAC, certificate infrastructure, cloud accounts, multi-tenant isolation, policy engines, or a general security-hardening project.
- The recovery agent runs as root. Arbitrary argv execution, arbitrary shell scripts, mounts, raw block-device access, chroot, reboot, poweroff, and bootloader work are required features.
- Do not add mandatory approval gates or artificial command refusals. The portal may display exactly what it is doing, but an unrestricted job must execute immediately.
- Typed disk operations exist for automation, progress reporting, and repeatability. They are not a restriction: raw root shell execution remains available at all times.
- force: true means bypass optional preflight failures and attempt the requested operation. It must not be silently ignored.
- Keep stable machine and disk identities, durable event journals, exact output, and reconnect behavior. These are operational correctness requirements.
- If physical target hardware is unavailable, finish the implementation and automated/QEMU coverage; record only the remaining physical validation items. Do not block software progress on an unplugged machine.
- Do not commit, publish, or deploy outside the workspace unless the operator explicitly asks. Local package installation required for builds and QEMU validation is within scope.

## Mission

From the WorkWire computer, the operator must be able to:

1. See every recovery agent currently alive on the wired LAN.
2. Wake machines that support Wake-on-LAN.
3. Network-boot a machine whose installed operating system no longer boots.
4. Receive a full hardware, disk, partition, filesystem, RAID, LVM, encryption, and boot inventory.
5. Open an unrestricted root command console on the target.
6. Upload and download files, disk-table backups, logs, images, and recovery artifacts.
7. Run structured diagnostics and repair operations with live output and progress.
8. Clone a failing device with ddrescue and resume from its mapfile.
9. Back up, rewrite, or restore GPT/MBR partition tables.
10. Check and repair ext, XFS, Btrfs, FAT, exFAT, and NTFS filesystems using the native tools present in the recovery image.
11. Mount installed systems, enter them with chroot/systemd-nspawn when possible, and repair bootloaders/initramfs.
12. Reboot, power off, or return a target to its local boot path.
13. Give an autonomous planner a recovery goal and allow it to inspect, execute, observe, revise, and continue without waiting for per-command confirmation.
14. Recover cleanly when the target loses power or the network connection during a case.
15. Retain the current WorkWire file synchronization and two-pane portal unchanged.

## Operating doctrine

This is a secluded prototype lab on a private wired network. The recovery system is intentionally operator-powerful.

- The controller trusts agents that connect from the lab LAN.
- A single optional lab token may be configured, but an empty token is a supported first-class configuration.
- There are no user roles. The local WorkWire operator is root-equivalent for recovery targets.
- There is no command allowlist for raw jobs.
- There is no path sandbox on recovery artifact or command operations beyond keeping controller state organized.
- Destructive typed operations expose their exact resolved device, arguments, and output; they do not require a second approval round trip.
- The autonomous mode may run destructive operations when they directly serve the case goal.
- Logs exist to resume work and understand failures, not for compliance.
- Do not expose the recovery ports through an internet router. This is an environmental assumption, not an application feature to build.

## Physical facts the implementation must represent honestly

- A machine with no electrical power cannot execute LAN commands. Wake-on-LAN works only when the NIC and motherboard retain standby power and support it.
- Generic consumer hardware usually needs one initial UEFI/BIOS change to allow PXE/network boot and may need Secure Boot disabled for unsigned iPXE. WorkWire cannot software-emulate firmware control that the hardware does not expose.
- Intel AMT, IPMI, Redfish, or another baseboard controller can later provide stronger power and boot control, but none is assumed for the first complete version.
- A physically failing drive is not repaired by changing partitions. The useful operation is to image/clone readable sectors to healthy storage, then repair the copy. WorkWire must still permit direct repair when the operator chooses it.

## Definition of done

The project is complete for this milestone only when all of the following are true:

- npm test passes, including new recovery unit and integration tests.
- npm run dist:linux still builds the existing WorkWire application.
- ww recovery controller starts a recovery controller on port 4852.
- ww recovery agent can run locally as root or under a test temp root and becomes visible to the controller.
- ww recovery agents lists multiple agents and their online/offline state.
- ww recovery inventory AGENT returns normalized JSON plus the raw command outputs.
- ww recovery exec AGENT -- COMMAND runs an arbitrary argv as root and streams stdout/stderr.
- ww recovery shell AGENT -- SCRIPT runs an arbitrary Bash script.
- ww recovery put/get transfers arbitrary artifacts.
- Jobs survive a controller restart and retain ordered events.
- An agent reconnects after controller restart without changing identity.
- Interrupted jobs are marked interrupted and may be retried or resumed.
- The Electron window has Files and Recovery workspaces.
- The Recovery workspace shows fleet, selected target, disks, case goal, jobs, logs, command input, and artifacts.
- A Fedora-hosted PXE service can chain BIOS and UEFI clients into iPXE without replacing the router DHCP service.
- The generated Debian recovery environment boots in QEMU, gets DHCP, starts the root agent automatically, and appears in WorkWire.
- A QEMU test disk can be partitioned, deliberately damaged, inspected, backed up, repaired, mounted, and read through WorkWire.
- The controller can send a Wake-on-LAN magic packet.
- An autonomous case loop can receive a goal, collect facts, submit actions, consume results, and terminate with a case summary.

## Current WorkWire assessment

Reuse these existing strengths:

- lib/ww-network.mjs already identifies useful IPv4 LAN interfaces, broadcasts, and same-subnet addresses.
- lib/ww-beacon.mjs already demonstrates UDP LAN discovery.
- lib/ww-service.mjs and lib/ww-client.mjs provide bounded HTTP request patterns and service lifecycle structure.
- lib/ww-config-store.mjs provides config locations, atomic updates, lock behavior, machine IDs, and host/port normalization.
- desktop/ww-main.mjs already owns privileged backend behavior behind narrow renderer IPC.
- desktop/ww-preload.cjs already exposes a small renderer API.
- desktop/ww/renderer.js, index.html, and styles.css provide a no-build Electron UI.
- ww.mjs already routes CLI and headless service modes.
- scripts/package-ww-linux.mjs and the LAN installer already package a self-contained Linux application.
- The current tests demonstrate the repository's preferred dependency injection and temp-directory style.

Do not force recovery through these existing assumptions:

- The file service is exactly two-peer oriented.
- Port 4851 and protocol version 1 belong to file synchronization.
- Existing bearer/pinned-peer authorization is designed for one paired peer.
- The remote filesystem endpoint intentionally cannot browse the whole target machine.
- The file mirror assumes one elected pair and matching WorkWire versions.

Recovery therefore gets its own protocol, state, controller, client, ports, and UI state. It may share utilities but must not weaken or overload the existing filesystem API.

## Fixed architecture

~~~text
                    WorkWire Electron Portal
                              |
                    privileged IPC in main
                              |
                 Recovery Controller :4852
                  /           |            \
          durable cases    WebSocket     artifacts
          jobs/events       sessions       HTTP
                  \           |            /
                   \          |           /
                    Root Recovery Agents
                 installed OS or PXE live OS
                       |             |
                arbitrary shell   typed tools
                       \             /
                    local block devices

    Boot plane:
    dnsmasq proxyDHCP/TFTP -> iPXE -> Boot HTTP :4853
                                      |
                    Debian live kernel/initrd/SquashFS

    Power plane:
    WorkWire -> UDP Wake-on-LAN
    Future adapters -> AMT / IPMI / Redfish
~~~

### Processes

1. Existing WorkWire service
   - Port 4851.
   - Continues file portal, pairing, mirror, and desktop launch behavior.

2. Recovery controller
   - Port 4852 by default.
   - Runs inside ww serve and inside the Electron main process when no compatible background service is attached.
   - Owns agents, cases, jobs, events, uploads, downloads, and live subscriptions.
   - Exposes HTTP JSON endpoints, Server-Sent Events for simple observers, and WebSocket connections for agents.

3. Boot artifact server
   - Port 4853 by default.
   - May run inside the recovery controller process.
   - Serves iPXE scripts, kernel, initrd, SquashFS, manifests, and checksums.

4. dnsmasq PXE helper
   - Runs as a system service or foreground root process.
   - Uses proxyDHCP so the existing router remains the DHCP address server.
   - Uses TFTP only to deliver undionly.kpxe or ipxe.efi; large artifacts use HTTP.

5. Recovery agent
   - Node 22 ESM process running as root.
   - Initiates the connection to the controller; no inbound target firewall work is required.
   - Runs either as a systemd service on an installed OS or automatically in the PXE recovery environment.

6. Autonomous case runner
   - Runs controller-side.
   - Talks to a planner through a provider-neutral JSONL subprocess protocol.
   - Has both typed recovery tools and raw shell as callable actions.

### Fixed ports

| Purpose | Default | Transport |
| --- | ---: | --- |
| Existing WorkWire file service | 4851 | HTTP |
| Recovery controller/API | 4852 | HTTP + WebSocket |
| Boot artifacts | 4853 | HTTP |
| Existing WorkWire beacons | existing values | UDP |
| PXE proxyDHCP | 67/4011 | UDP |
| PXE TFTP | 69 | UDP |
| Wake-on-LAN | 9, with 7 fallback | UDP broadcast |

Every high port is configurable. PXE low ports are rendered into dnsmasq configuration and owned by the root helper.

## Fixed state layout

Use resolveWwConfigDir() as the default base and add WW_RECOVERY_STATE_DIR as an override.

~~~text
~/.config/workwire/recovery/
  controller.json
  agents.json
  mac-addresses.json
  controller.log
  cases/
    CASE_ID/
      case.json
      facts.json
      summary.md
      events.jsonl
      jobs/
        JOB_ID/
          job.json
          events.jsonl
          stdout.log
          stderr.log
          result.json
          artifacts/
  agents/
    AGENT_ID/
      latest.json
      inventory.json
      sessions.jsonl
  boot/
    manifest.json
    ipxe/
      boot.ipxe
      menu.ipxe
      undionly.kpxe
      ipxe.efi
    live/
      vmlinuz
      initrd.img
      filesystem.squashfs
      SHA256SUMS
  pxe/
    dnsmasq.conf
    dnsmasq.pid
    dnsmasq.log
  uploads/
  downloads/
~~~

Writes to JSON snapshots must use temporary-file-plus-rename. Event streams are append-only JSONL. Serialize mutations through an in-process promise queue and a filesystem lock patterned after lib/ww-config-store.mjs. Never rewrite an events.jsonl file to update state.

## Proposed source layout

Create these files instead of growing lib/ww-service.mjs or desktop/ww-main.mjs into monoliths:

~~~text
lib/recovery/
  ww-recovery-config.mjs
  ww-recovery-protocol.mjs
  ww-recovery-store.mjs
  ww-recovery-controller.mjs
  ww-recovery-client.mjs
  ww-recovery-agent.mjs
  ww-recovery-agent-id.mjs
  ww-recovery-executor.mjs
  ww-recovery-inventory.mjs
  ww-recovery-actions.mjs
  ww-recovery-artifacts.mjs
  ww-recovery-boot.mjs
  ww-recovery-wol.mjs
  ww-recovery-autonomy.mjs
  ww-recovery-planner-process.mjs

scripts/
  build-ww-recovery-image.sh
  install-ww-recovery-host.sh
  install-ww-recovery-agent.sh
  run-ww-pxe.mjs

recovery/
  README.md
  image/
    Containerfile
    auto/
      config
      package-lists/workwire.list.chroot
      includes.chroot/etc/systemd/system/workwire-recovery-agent.service
      includes.chroot/usr/local/lib/workwire/
      hooks/live/010-workwire-agent.hook.chroot
  systemd/
    workwire-recovery-agent.service
    workwire-recovery-pxe.service
  dnsmasq/
    dnsmasq.conf.template
  ipxe/
    boot.ipxe.template

desktop/ww/
  recovery-renderer.js

test/
  ww-recovery-config.test.mjs
  ww-recovery-protocol.test.mjs
  ww-recovery-store.test.mjs
  ww-recovery-controller.test.mjs
  ww-recovery-agent.test.mjs
  ww-recovery-executor.test.mjs
  ww-recovery-inventory.test.mjs
  ww-recovery-actions.test.mjs
  ww-recovery-artifacts.test.mjs
  ww-recovery-boot.test.mjs
  ww-recovery-wol.test.mjs
  ww-recovery-autonomy.test.mjs
  ww-recovery-cli.test.mjs
  ww-recovery-ui-contract.test.mjs
  ww-recovery-qemu.test.mjs
~~~

## Recovery protocol version 1

Keep WW_RECOVERY_PROTOCOL_VERSION separate from WW_PROTOCOL_VERSION.

### Stable identifiers

- agentId: persistent installed-agent ID, or deterministic recovery ID derived from DMI product UUID plus the lowest physical Ethernet MAC. Format wwra_ plus 24 base64url characters.
- bootId: /proc/sys/kernel/random/boot_id. Changes every target boot.
- sessionId: random ID per controller connection.
- caseId: wwc_ plus sortable timestamp plus random suffix.
- jobId: wwj_ plus sortable timestamp plus random suffix.
- stepId: caller-provided stable ID within a job.
- deviceId: prefer /dev/disk/by-id using NVMe EUI/WWN/serial; fall back to a hash of model, serial, size, and transport. Never use /dev/sdX alone as identity.
- filesystemId: UUID when present, otherwise deviceId plus byte offset.

### Agent hello

~~~json
{
  "type": "agent.hello",
  "protocol": 1,
  "agentId": "wwra_example",
  "bootId": "linux-boot-uuid",
  "hostname": "patient-01",
  "mode": "pxe",
  "version": "0.1.0",
  "startedAt": "2026-07-17T00:00:00.000Z",
  "controllerHint": "http://192.168.1.10:4852",
  "addresses": [{"name":"enp1s0","mac":"aa:bb:cc:dd:ee:ff","address":"192.168.1.40"}],
  "capabilities": {
    "root": true,
    "rawShell": true,
    "artifacts": true,
    "reboot": true,
    "poweroff": true,
    "tools": {}
  }
}
~~~

The controller replies with agent.welcome containing sessionId, heartbeatMs, current controller time, and any leased/resumable job.

### Job model

~~~json
{
  "id": "wwj_...",
  "caseId": "wwc_...",
  "targetAgentId": "wwra_...",
  "protocol": 1,
  "goal": "Recover the root filesystem and restore UEFI boot",
  "mode": "autonomous-unrestricted",
  "force": false,
  "createdAt": "2026-07-17T00:00:00.000Z",
  "createdBy": "operator-or-planner",
  "leaseMs": 30000,
  "steps": [
    {
      "id": "inventory-before",
      "action": "inventory.collect",
      "params": {"raw": true},
      "timeoutMs": 120000,
      "continueOnError": false
    }
  ]
}
~~~

Modes:

- typed: only the listed structured steps.
- unrestricted: typed steps plus command.exec and shell.exec.
- autonomous-unrestricted: planner may append further typed or raw steps while the case runs.

Job states:

- queued
- leased
- running
- succeeded
- failed
- canceled
- interrupted
- abandoned

Agents lease one job at a time by default. A future config may raise concurrency, but disk-mutating actions must take an agent-wide mutation lock so two jobs cannot rewrite the same machine simultaneously.

### Event model

~~~json
{
  "seq": 42,
  "at": "2026-07-17T00:00:00.000Z",
  "type": "step.output",
  "caseId": "wwc_...",
  "jobId": "wwj_...",
  "stepId": "inventory-before",
  "stream": "stdout",
  "data": "base64-or-utf8-chunk",
  "encoding": "utf8"
}
~~~

Required event types:

- case.created, case.goal.updated, case.completed, case.failed
- agent.connected, agent.heartbeat, agent.disconnected, agent.inventory
- job.created, job.queued, job.leased, job.started, job.interrupted
- job.succeeded, job.failed, job.canceled
- step.started, step.command, step.output, step.progress
- step.artifact, step.succeeded, step.failed
- planner.started, planner.thought-summary, planner.action, planner.observation
- planner.completed, planner.failed

Sequence numbers are allocated by the controller per case. Agent messages carry agentSeq for deduplication; the controller assigns canonical seq when persisting.

### WebSocket messages

Controller and agent exchange JSON text control messages. Large artifact bytes use HTTP, not WebSocket.

- agent.hello
- agent.heartbeat
- agent.inventory
- agent.job.accept
- agent.job.event
- agent.job.result
- agent.resume
- controller.welcome
- controller.inventory.request
- controller.job.offer
- controller.job.cancel
- controller.shutdown

Heartbeat every 5 seconds. Mark a session stale at 15 seconds and offline at 30 seconds. Reconnect delays: 1, 2, 5, 10, then 15 seconds indefinitely, reset after a stable connection.

### HTTP API

All responses use {ok:true,...} or {ok:false,error:{code,message}}.

~~~text
GET    /v1/recovery/info
GET    /v1/recovery/agents
GET    /v1/recovery/agents/:agentId
POST   /v1/recovery/agents/:agentId/inventory
GET    /v1/recovery/cases
POST   /v1/recovery/cases
GET    /v1/recovery/cases/:caseId
POST   /v1/recovery/cases/:caseId/goal
POST   /v1/recovery/cases/:caseId/run
POST   /v1/recovery/cases/:caseId/stop
GET    /v1/recovery/cases/:caseId/events
GET    /v1/recovery/cases/:caseId/events/stream
POST   /v1/recovery/jobs
GET    /v1/recovery/jobs/:jobId
POST   /v1/recovery/jobs/:jobId/cancel
POST   /v1/recovery/jobs/:jobId/retry
POST   /v1/recovery/artifacts
PUT    /v1/recovery/artifacts/:artifactId
GET    /v1/recovery/artifacts/:artifactId
GET    /v1/recovery/boot/:arch/boot.ipxe
GET    /v1/recovery/boot/live/:name
POST   /v1/recovery/wake
GET    /v1/recovery/socket
~~~

The socket route upgrades to WebSocket. An optional Authorization: Bearer header is checked only when recovery.token is non-empty.

## Implementation phases

The phase order is deliberate. Complete each phase's tests before advancing, but do not wait for operator approval between phases.

## Phase 0 — Preserve baseline and establish recovery configuration

### Repository hygiene

- [ ] Run git status --short and save the result in the work log for reference.
- [ ] Do not alter or revert the pre-existing modified files except where a recovery integration requires a careful additive edit.
- [ ] Run npm test before the first edit. Expected baseline on 2026-07-17: 106 passed, 0 failed.
- [ ] After each phase, run the focused new tests and then npm test.
- [ ] Install ws as a production dependency with npm install --save ws. Verify package-lock.json changes only as expected.
- [ ] Do not add Express, React, TypeScript, a bundler, an ORM, or a database dependency.

### Configuration module

Create lib/recovery/ww-recovery-config.mjs rather than immediately changing the existing top-level config schema. Recovery configuration should load from ~/.config/workwire/recovery/controller.json and environment overrides. This avoids a migration collision with the active changes in lib/ww-config-store.mjs.

Default controller configuration:

~~~json
{
  "version": 1,
  "enabled": true,
  "host": "0.0.0.0",
  "port": 4852,
  "bootHost": "0.0.0.0",
  "bootPort": 4853,
  "advertisedHost": "",
  "token": "",
  "stateDir": "",
  "heartbeatMs": 5000,
  "staleAfterMs": 15000,
  "offlineAfterMs": 30000,
  "jobLeaseMs": 30000,
  "maxJsonBytes": 4194304,
  "maxArtifactBytes": 0,
  "planner": {
    "enabled": false,
    "command": [],
    "maxIterations": 100,
    "iterationTimeoutMs": 1800000
  },
  "pxe": {
    "enabled": false,
    "interface": "",
    "proxyDhcp": true,
    "tftpRoot": "",
    "bootRoot": ""
  }
}
~~~

Environment overrides:

~~~text
WW_RECOVERY_ENABLED
WW_RECOVERY_HOST
WW_RECOVERY_PORT
WW_RECOVERY_BOOT_HOST
WW_RECOVERY_BOOT_PORT
WW_RECOVERY_ADVERTISED_HOST
WW_RECOVERY_TOKEN
WW_RECOVERY_STATE_DIR
WW_RECOVERY_CONTROLLER_URL
WW_RECOVERY_AGENT_ID
WW_RECOVERY_AGENT_NAME
WW_RECOVERY_AGENT_MODE
WW_RECOVERY_PLANNER_COMMAND
~~~

- [ ] Export constants for ports, protocol version, config version, and default timeouts.
- [ ] Implement resolveRecoveryStateDir(), resolveRecoveryConfigPath(), buildDefaultRecoveryConfig(), normalizeRecoveryConfig(), loadRecoveryConfig(), and saveRecoveryConfig().
- [ ] Reuse resolveWwConfigDir(), normalizePort(), and the existing atomic/lock style where practical.
- [ ] Support maxArtifactBytes: 0 as unlimited, because disk images may be very large.
- [ ] Preserve unknown config keys only under an extensions object; normalize all core keys.
- [ ] Add tests for defaults, every environment override, invalid values, an explicitly empty token, custom state roots, and concurrent saves.

### Phase 0 acceptance

- [ ] node can import the new config module on Fedora and in a clean temp HOME.
- [ ] An empty token survives save/load and is not auto-replaced.
- [ ] npm test passes.

## Phase 1 — Protocol types, validation, and state machines

Create lib/recovery/ww-recovery-protocol.mjs with no filesystem or network side effects.

### Constants and factories

- [ ] WW_RECOVERY_PROTOCOL_VERSION = 1.
- [ ] Enumerate job, case, step, and agent-session states.
- [ ] Export generateRecoveryId(prefix), using sortable UTC milliseconds plus random base64url.
- [ ] Export createCase(), createJob(), createStep(), createEvent(), and createArtifactRecord().
- [ ] Export normalizeAgentHello(), normalizeInventory(), normalizeCase(), normalizeJob(), and normalizeEvent().
- [ ] Export assertValidAgentHello(), assertValidJob(), assertValidStep(), and assertValidEvent().
- [ ] Export transitionJobState() and transitionCaseState() with explicit valid transition tables.

### Validation rules

- [ ] Reject missing protocol versions, IDs, targets, actions, and step IDs.
- [ ] Reject duplicate step IDs within one job.
- [ ] Reject invalid state transitions such as succeeded back to running.
- [ ] Accept arbitrary JSON-serializable params for raw execution and future tool extensions.
- [ ] Accept long timeouts, including 0 for no timeout.
- [ ] Preserve force and execution mode exactly.
- [ ] Keep individual WebSocket JSON messages below the configured JSON limit.
- [ ] Represent binary/stdout chunks using utf8 when valid and base64 otherwise.
- [ ] Normalize timestamps to ISO strings without trusting target clock ordering.
- [ ] Give each agent-originated event an agentSeq monotonically increasing per boot/session.

### State transitions

~~~text
queued -> leased -> running -> succeeded
                         \-> failed
                         \-> canceled
                         \-> interrupted
leased -> queued                 when a lease expires before start
interrupted -> queued            explicit retry/resume
failed -> queued                 explicit retry
queued/leased -> canceled
any nonterminal -> abandoned     operator discards a case
~~~

- [ ] Make terminal-state helpers explicit.
- [ ] Treat duplicate result/event delivery as idempotent using agentId, bootId, jobId, and agentSeq.
- [ ] Test valid and invalid factories, transitions, output encoding, event ordering, duplicates, and malformed inputs.

### Phase 1 acceptance

- [ ] Protocol tests cover every state edge.
- [ ] Fuzz-like tests feed nulls, arrays, oversized values, and unexpected object shapes without crashing the process.
- [ ] npm test passes.

## Phase 2 — Durable recovery store

Create lib/recovery/ww-recovery-store.mjs.

### Store API

Implement createRecoveryStore({stateDir, clock, randomBytesImpl, fsImpl}) returning:

~~~text
init()
close()
listAgents()
getAgent(agentId)
upsertAgent(agent)
markAgentOffline(agentId, reason)
createCase(input)
listCases(filters)
getCase(caseId)
updateCase(caseId, patch)
createJob(caseId, input)
getJob(jobId)
listJobs(caseId, filters)
transitionJob(jobId, nextState, patch)
appendCaseEvent(caseId, event)
appendJobEvent(jobId, event)
readCaseEvents(caseId, afterSeq)
readJobEvents(jobId, afterSeq)
writeInventory(agentId, inventory)
readInventory(agentId)
createArtifact(metadata)
openArtifactWrite(artifactId)
resolveArtifactPath(artifactId)
completeArtifact(artifactId, metadata)
listArtifacts(caseId, jobId)
recoverInterruptedState()
~~~

### Persistence behavior

- [ ] init() creates the full state hierarchy.
- [ ] All directory and file names derive from validated IDs, never unchecked request strings.
- [ ] agents.json stores the latest known record for each agent.
- [ ] latest.json stores a single agent's convenient snapshot.
- [ ] Job JSON stores current state and lease metadata; events remain append-only.
- [ ] Case sequence allocation occurs inside the store mutation queue.
- [ ] Every state mutation appends its corresponding event before returning success.
- [ ] Artifact writers write to ARTIFACT_ID.partial, fsync/close, then rename to the final name.
- [ ] On startup, partial artifacts remain visible as incomplete records and can be resumed or deleted explicitly.
- [ ] recoverInterruptedState() changes jobs left leased/running by a dead controller to interrupted and records why.
- [ ] Controller restart must never erase stdout.log, stderr.log, results, or planner history.
- [ ] UI list operations read compact snapshots rather than replaying all logs every refresh.
- [ ] Streaming subscribers receive events after persistence, not before.

### Mutation locking

- [ ] Use one in-process serialized mutation queue per store.
- [ ] Add a .store.lock directory/file with stale-owner recovery patterned after ww-config-store.
- [ ] Include PID, hostname, and acquisition time in lock metadata.
- [ ] Never hold the lock while running a target command or waiting on the network.
- [ ] Keep event append operations small and ordered.

### Tests

- [ ] Fresh initialization.
- [ ] Agent upsert and reconnect.
- [ ] Two cases and several jobs.
- [ ] Concurrent event append preserving unique contiguous seq.
- [ ] Controller restart from running state.
- [ ] Partial artifact recovery.
- [ ] Duplicate agent events.
- [ ] A killed/stale lock.
- [ ] Paths containing malicious separators rejected as invalid IDs.
- [ ] Large log streams append without being held wholly in memory.

### Phase 2 acceptance

- [ ] A test can create a case, append 10,000 events concurrently, reopen the store, and read them in canonical order.
- [ ] A simulated crash leaves recoverable state.
- [ ] npm test passes.

## Phase 3 — Recovery controller and client

Create lib/recovery/ww-recovery-controller.mjs and lib/recovery/ww-recovery-client.mjs.

### Controller lifecycle

createRecoveryController() must expose:

~~~text
start()
stop()
getInfo()
getStore()
onEvent(listener)
publishEvent(event)
getConnectedAgent(agentId)
~~~

- [ ] Use node:http for HTTP and ws with noServer: true for upgrades.
- [ ] Bind to 0.0.0.0:4852 by default.
- [ ] Support port 0 in tests.
- [ ] Advertise reachable LAN URLs using lib/ww-network.mjs.
- [ ] Return public controller info from /v1/recovery/info.
- [ ] Apply the optional recovery token consistently to API, artifact, SSE, and WebSocket paths only when configured.
- [ ] Keep existing WorkWire token/pinned-peer logic completely separate.
- [ ] Bound JSON request bodies; do not impose a default limit on streamed artifacts.
- [ ] Set no-store headers on JSON and event responses.
- [ ] Map errors to stable ERR_WW_RECOVERY_* codes.
- [ ] Handle EADDRINUSE clearly; the caller then probes/attaches to the existing controller.

### Agent session registry

- [ ] Validate agent.hello before registering a socket.
- [ ] Allow a new session for the same agentId to supersede a stale socket.
- [ ] Record bootId changes as reboot events.
- [ ] Persist connect, disconnect, heartbeat, address, capability, and inventory changes.
- [ ] Maintain lastSeenAt based on controller time.
- [ ] Sweep stale/offline sessions on a timer with unref().
- [ ] On reconnect, offer the interrupted/leased job associated with that agent when resumable.
- [ ] If the agent reports the job already completed, accept the idempotent result.
- [ ] Never lose an output event merely because the UI is closed.

### Job dispatch

- [ ] POST /jobs validates and persists before offering.
- [ ] Dispatch only to the requested agent.
- [ ] If offline, keep the job queued.
- [ ] When the agent connects, offer the oldest queued job first.
- [ ] Store lease owner, session, start, expiry, and attempt count.
- [ ] Extend a running job lease on heartbeat/event activity.
- [ ] Cancellation sends controller.job.cancel and persists requestedAt immediately.
- [ ] If an agent vanishes, mark a running job interrupted after offlineAfterMs.
- [ ] retry creates a new attempt record while retaining the same logical job ID and previous events.

### SSE

- [ ] Implement case event streaming with Last-Event-ID and after query support.
- [ ] Send periodic comment heartbeats so proxies and Electron clients detect dead streams.
- [ ] Close listeners on request abort.
- [ ] Do not accumulate listeners after a renderer reload.

### Recovery client

Implement a client parallel to createRemoteWwClient:

~~~text
connect()
getInfo()
listAgents()
getAgent()
requestInventory()
createCase()
listCases()
getCase()
updateGoal()
runCase()
stopCase()
createJob()
getJob()
cancelJob()
retryJob()
listEvents()
subscribeEvents()
uploadArtifact()
downloadArtifact()
wake()
~~~

- [ ] Add request timeouts for JSON operations and unlimited/explicitly configurable timeouts for images and ddrescue artifacts.
- [ ] Preserve stream backpressure.
- [ ] Parse stable controller errors.
- [ ] Test controller/client over loopback with two fake WebSocket agents.

### Integrate lifecycle

- [ ] Add recovery configuration loading to ww.mjs.
- [ ] Extend ww serve to start the file service and recovery controller independently.
- [ ] A recovery-controller failure must be logged but must not crash an otherwise working file service unless the explicit command is ww recovery controller.
- [ ] Stop the controller during normal signal shutdown.
- [ ] In desktop/ww-main.mjs, probe localhost recovery port during init.
- [ ] Attach to the existing background controller if compatible.
- [ ] Start an embedded controller only when no background controller is reachable.
- [ ] If the port races, attach after EADDRINUSE.
- [ ] Keep controller objects and recovery tokens out of renderer state.

### Phase 3 acceptance

- [ ] Two fake agents connect, receive separate jobs, stream interleaved output, disconnect, and reconnect.
- [ ] Restarting the controller converts a running job to interrupted without data loss.
- [ ] Empty-token and configured-token modes both have tests.
- [ ] Existing file-service tests are unchanged and pass.
- [ ] npm test passes.

## Phase 4 — Root executor and complete inventory

Create lib/recovery/ww-recovery-executor.mjs and lib/recovery/ww-recovery-inventory.mjs.

### Executor primitives

Implement:

~~~text
execArgv({file,args,cwd,env,stdin,timeoutMs,runAs,force,onEvent,signal})
execShell({script,shell,cwd,env,stdin,timeoutMs,force,onEvent,signal})
cancelExecution(executionId, reason)
toolExists(name)
resolveTool(name)
~~~

- [ ] execArgv uses child_process.spawn with shell: false.
- [ ] execShell uses /bin/bash -lc by default and accepts arbitrary multiline text.
- [ ] Preserve the recovery environment PATH plus caller additions.
- [ ] Support binary stdin from a file or artifact stream.
- [ ] Emit the exact resolved executable and argv before spawning.
- [ ] Emit stdout and stderr as they arrive; append both to durable job logs controller-side.
- [ ] Split messages into bounded transport chunks without truncating the underlying log.
- [ ] Use detached process groups on Linux. Cancellation sends SIGTERM to the group, waits a configurable grace period, then sends SIGKILL.
- [ ] A timeout of 0 means unlimited.
- [ ] Return exitCode, signal, startedAt, endedAt, durationMs, and the tail of each stream for summaries.
- [ ] Do not treat nonzero exit status as a process crash; record the command result and let action semantics decide.
- [ ] Record whether effective UID is 0. Do not refuse raw execution when non-root; let the OS return its real error.
- [ ] Preserve force in the emitted command record.

### Agent identity

Create lib/recovery/ww-recovery-agent-id.mjs.

- [ ] Installed agent: read /etc/workwire/agent-id; create a random stable ID if absent.
- [ ] PXE agent: read /sys/class/dmi/id/product_uuid and physical Ethernet MACs.
- [ ] Ignore loopback, virtual bridges, tunnels, and all-zero MACs.
- [ ] Hash normalized DMI UUID plus lowest physical MAC into wwra_ ID.
- [ ] Fall back to machine-id plus MAC, then boot-only random ID.
- [ ] Report the inputs and stability level in identity metadata.
- [ ] Read bootId from /proc/sys/kernel/random/boot_id.

### Inventory collection

Inventory must include normalized results plus raw outputs and per-command errors. A missing tool is data, not a fatal inventory failure.

Run or parse:

~~~text
uname -a
cat /etc/os-release
hostnamectl --json=short                       when supported
ip -json address
ip -json route
lsblk --json --bytes --output-all
findmnt --json --real --bytes
blkid -o export                               for each block node
sfdisk --json DEVICE                          for each whole disk
fdisk -l                                      raw fallback
readlink -f /dev/disk/by-id/*
udevadm info --query=property --name DEVICE
smartctl --scan-open
smartctl --all --json=c DEVICE
nvme list -o json
nvme smart-log -o json DEVICE
cat /proc/mdstat
mdadm --detail --scan
mdadm --detail DEVICE                         for each array
pvs --reportformat json
vgs --reportformat json
lvs --all --reportformat json
dmsetup ls --tree
cryptsetup status MAPPER                      for active mappings
efibootmgr -v
cat /proc/cmdline
dmesg --level=emerg,alert,crit,err,warn
~~~

Normalized top-level inventory:

~~~json
{
  "collectedAt": "",
  "agent": {},
  "system": {},
  "network": {"interfaces":[],"routes":[]},
  "firmware": {"uefi":true,"secureBoot":null,"entries":[]},
  "tools": {},
  "block": {
    "devices": [],
    "filesystems": [],
    "mounts": [],
    "raid": [],
    "lvm": {},
    "crypt": [],
    "graph": {"nodes":[],"edges":[]}
  },
  "health": {"smart":[],"nvme":[],"kernelWarnings":[]},
  "raw": {},
  "errors": []
}
~~~

- [ ] Flatten lsblk children while preserving parent/child graph edges.
- [ ] Distinguish whole disks, partitions, md arrays, device-mapper nodes, LVs, loop devices, and optical media.
- [ ] Include name, canonical path, by-id paths, major/minor, size, sector sizes, transport, removable/rotational flags, model, serial, WWN/EUI, partition table type, partition UUID/type, filesystem UUID/type/label, mount state, and read-only state.
- [ ] Resolve stable deviceId and current kernel path separately.
- [ ] Detect which device backs the currently running recovery root and annotate it.
- [ ] Never hide the controller/agent's own boot medium; annotate it so the operator knows what it is.
- [ ] Parse SMART overall health, reallocated/pending/uncorrectable sectors, temperature, power-on hours, error log count, NVMe critical warnings, percentage used, and media errors.
- [ ] Preserve unparsed raw JSON/text for future analysis.
- [ ] Inventory refresh emits progress after each collector.
- [ ] Unit-test parsers using fixtures for SATA GPT, NVMe, MBR, mdraid, LVM, LUKS, multipath-like graphs, malformed tool output, and absent tools.

### Phase 4 acceptance

- [ ] Running inventory locally returns a stable identity and all accessible block devices without mutation.
- [ ] Raw shell can run printf, a long-output command, a failing command, a timeout, cancellation, and binary stdout tests.
- [ ] npm test passes.

## Phase 5 — Recovery agent daemon

Create lib/recovery/ww-recovery-agent.mjs as both an importable component and executable entry point.

### Lifecycle

- [ ] Load controller URL from CLI, environment, /etc/workwire/recovery-agent.json, or kernel command line ww.controller= in that priority order.
- [ ] Load optional token similarly.
- [ ] Determine installed or pxe mode.
- [ ] Build identity and initial capability map.
- [ ] Connect outbound by WebSocket.
- [ ] Send hello and a lightweight inventory immediately.
- [ ] Run the full inventory when requested or after initial connection in PXE mode.
- [ ] Send heartbeats independently of command output.
- [ ] Accept one job, persist local execution state under /run/workwire-recovery for PXE or /var/lib/workwire-recovery for installed mode, and acknowledge the lease.
- [ ] Execute steps sequentially unless a future step explicitly declares parallel: true.
- [ ] Stream events with monotonically increasing agentSeq.
- [ ] Persist unacknowledged outbound events to JSONL and replay them after reconnect.
- [ ] Handle controller cancellation.
- [ ] On SIGTERM, stop accepting jobs, report interruption if connected, terminate the active process group, flush events, and exit.
- [ ] On reconnect, report active/completed job state before accepting another job.
- [ ] Exponential reconnect forever; never exit merely because the controller is temporarily absent.

### Capability discovery

Report:

- effective UID/root
- shell path
- architecture and kernel
- installed tools and versions
- firmware mode
- systemd/chroot/nspawn availability
- filesystems supported by /proc/filesystems
- network interfaces
- artifact upload/download
- reboot and poweroff commands
- ddrescue, SMART, NVMe, mdraid, LVM, LUKS, partition, filesystem, and bootloader tool groups

### Installed-agent entry point

- [ ] Add a ww recovery agent CLI path.
- [ ] Add recovery/systemd/workwire-recovery-agent.service.
- [ ] Service runs as root, Restart=always, RestartSec=2, After=network-online.target.
- [ ] Do not add systemd sandbox directives that block /dev, mounts, namespaces, chroot, raw sockets, or reboot.
- [ ] scripts/install-ww-recovery-agent.sh copies the packaged runtime/config, creates state directories, enables, and starts the system service.
- [ ] Installer accepts controller URL and optional token noninteractively.
- [ ] Provide uninstall and status commands without removing case data by default.

### Phase 5 acceptance

- [ ] Start controller and two local agents with distinct temp identities.
- [ ] Stop/restart controller and verify both reconnect.
- [ ] Kill one agent during a long job, restart it, and observe interrupted/replayed state.
- [ ] Verify raw execution uses the agent's actual privileges.
- [ ] npm test passes.

## Phase 6 — Complete recovery CLI

Extend ww.mjs parsing without changing existing public desktop behavior. recovery is a top-level command with its own subcommand parser. Preserve every token after -- for target execution.

### Command surface

~~~text
ww recovery controller start [--host H] [--port P] [--foreground]
ww recovery controller status [--json]
ww recovery controller stop

ww recovery agent run --controller URL [--id ID] [--name NAME] [--mode installed|pxe]
ww recovery agent install --controller URL [--token TOKEN]
ww recovery agent status
ww recovery agent uninstall

ww recovery agents [--online] [--json]
ww recovery inspect AGENT [--refresh] [--raw] [--json]
ww recovery wait AGENT [--timeout MS]

ww recovery case create AGENT --goal TEXT [--autonomous] [--json]
ww recovery case list [--agent AGENT] [--json]
ww recovery case show CASE [--events] [--json]
ww recovery case run CASE
ww recovery case stop CASE
ww recovery case follow CASE

ww recovery exec AGENT [--timeout MS] [--force] -- COMMAND ARG...
ww recovery shell AGENT [--timeout MS] [--force] -- SCRIPT
ww recovery shell AGENT --file SCRIPT_FILE
ww recovery shell AGENT --stdin
ww recovery cancel JOB
ww recovery retry JOB
ww recovery follow JOB

ww recovery put AGENT LOCAL_PATH REMOTE_PATH
ww recovery get AGENT REMOTE_PATH LOCAL_PATH
ww recovery artifacts CASE [--json]

ww recovery wake MAC [--broadcast ADDRESS] [--port 9]
ww recovery pxe install [--interface IFACE]
ww recovery pxe start [--interface IFACE]
ww recovery pxe status
ww recovery pxe stop
ww recovery image build
ww recovery image verify
~~~

### CLI behavior

- [ ] Human output is concise and continuously streamed.
- [ ] --json emits a single JSON result for finite commands.
- [ ] follow commands emit JSONL when --json is supplied.
- [ ] exec prints the exact agent, executable, and args, then live output, then exit status.
- [ ] shell does not reinterpret the script locally.
- [ ] Ctrl-C sends job cancellation once; a second Ctrl-C exits immediately.
- [ ] Commands return the remote exit code where it fits 0–125; controller/transport failures use a documented nonzero code.
- [ ] inspect prints a useful disk table followed by health warnings and topology; --raw returns the full inventory.
- [ ] wait exits when the requested agent is online, useful for PXE scripts and tests.
- [ ] Implement command handlers as exported functions with injected stdin/stdout/stderr/controller client for testing.
- [ ] Add all recovery commands to engineering help first. Add a short Recovery entry to public help once the vertical slice works.

### CLI vertical-slice demonstration

The next agent must run this sequence against loopback before starting the UI:

~~~bash
ww recovery controller start --host 127.0.0.1 --port 4852
sudo ww recovery agent run --controller http://127.0.0.1:4852 --id wwra_localtest
ww recovery agents
ww recovery inspect wwra_localtest --refresh
ww recovery exec wwra_localtest -- id
ww recovery shell wwra_localtest -- 'lsblk -o NAME,SIZE,TYPE,FSTYPE; uname -a'
~~~

### Phase 6 acceptance

- [ ] Every command has parser and handler tests.
- [ ] Arguments after -- are byte-for-byte equivalent strings when received by the remote executor.
- [ ] Existing ww, ww serve, ww pair, ww connect, and help tests pass.
- [ ] npm test passes.

## Phase 7 — Typed recovery action registry

Create lib/recovery/ww-recovery-actions.mjs. The registry translates structured actions into exact commands, streams progress, collects artifacts, and returns normalized results. It must also expose command.exec and shell.exec without restriction.

### Registry API

~~~text
createRecoveryActionRegistry({executor, inventory, artifacts, platform})
registry.list()
registry.describe(actionName)
registry.has(actionName)
registry.run(actionName, params, context)
~~~

Each action descriptor contains name, description, mutates, requiredTools, parameter schema, progress parser, resumable flag, and handler. This metadata is sent to the controller/planner as the agent's live tool catalog.

### Core actions

- [ ] inventory.collect
- [ ] command.exec
- [ ] shell.exec
- [ ] artifact.download
- [ ] artifact.upload
- [ ] file.read
- [ ] file.write
- [ ] file.copy
- [ ] file.move
- [ ] file.remove
- [ ] directory.list
- [ ] mount.list
- [ ] mount.create
- [ ] mount.remove
- [ ] mount.bind
- [ ] swap.enable
- [ ] swap.disable
- [ ] process.list
- [ ] process.signal
- [ ] service.status
- [ ] service.start
- [ ] service.stop
- [ ] service.restart
- [ ] system.chroot
- [ ] system.nspawn
- [ ] power.reboot
- [ ] power.poweroff
- [ ] power.kexec

### Disk identity resolution

Every typed disk action accepts deviceId and may also accept path. Resolution order:

1. Refresh inventory.
2. Resolve deviceId to a current canonical kernel path and stable by-id link.
3. If both deviceId and path are given, report mismatch.
4. If force is false, fail a mismatch as ERR_WW_RECOVERY_DEVICE_CHANGED.
5. If force is true, prefer the explicit path and record that the identity mismatch was overridden.
6. Emit a step.command event containing resolved path, stable IDs, model, serial, size, and exact argv.

This identity logic prevents an operation intended for one disk from following /dev/sdX renumbering. It does not block an explicit forced path.

### Disk and media actions

- [ ] disk.inventory — refresh one device and its dependency graph.
- [ ] disk.smart.read — smartctl/NVMe health and logs.
- [ ] disk.smart.test — start short, long, conveyance, or vendor test and report estimated completion.
- [ ] disk.read.sample — read configurable head/middle/tail sector samples and return hashes/errors.
- [ ] disk.badblocks.scan — read-only by default; permit destructive write mode when requested.
- [ ] disk.table.backup — generate all applicable backups:
  - sfdisk --dump text.
  - sfdisk --json.
  - sgdisk --backup for GPT.
  - dd copies of first and last partition-table regions.
  - current lsblk/blkid/udev inventory.
- [ ] disk.table.restore — restore sfdisk or sgdisk backup, then partprobe/udevadm settle and refresh inventory.
- [ ] disk.table.write — apply a supplied sfdisk script or parted/sfdisk argv exactly.
- [ ] disk.table.create — create gpt, dos, bsd, or another supported label.
- [ ] disk.partition.create.
- [ ] disk.partition.delete.
- [ ] disk.partition.resize.
- [ ] disk.partition.set-type.
- [ ] disk.partition.set-name.
- [ ] disk.partition.set-flag.
- [ ] disk.reread — blockdev --rereadpt, partprobe, udevadm settle.
- [ ] disk.clone — ddrescue source to destination with persistent mapfile and selectable passes.
- [ ] disk.image.create — dd or ddrescue device to regular file.
- [ ] disk.image.restore — image file/stream to device.
- [ ] disk.wipe.signatures — wipefs selected or all signatures.
- [ ] disk.wipe.ranges — zero/discard requested byte ranges.
- [ ] disk.wipe.full — blkdiscard when supported or streamed zero/random data.
- [ ] disk.hash — stream whole/ranges through sha256sum or another requested hash.

### ddrescue orchestration

disk.clone and disk.image.create must support:

~~~json
{
  "sourceDeviceId": "",
  "destinationDeviceId": "",
  "destinationPath": "",
  "mapfilePath": "",
  "passes": [
    {"args":["--force","--no-scrape"]},
    {"args":["--force","--direct","--retry-passes=3"]}
  ],
  "reverseFinalPass": false,
  "force": true
}
~~~

- [ ] Default mapfile lives in the case artifact directory, not only on the unstable target.
- [ ] Upload a copy of the mapfile after every meaningful update.
- [ ] Parse ddrescue status output into bytes rescued, errors, error size, read rate, remaining estimate, pass, and current position.
- [ ] Resume when the same source/destination fingerprints and mapfile are supplied.
- [ ] Refuse accidental source-equals-destination unless force is true; when forced, execute exactly as requested.
- [ ] Record source and destination inventories before and after.
- [ ] Support clone to another block device or local mounted file.
- [ ] Do not fake random-access ddrescue directly into a sequential HTTP upload. Use an attached/mounted destination, then upload the completed image if desired.

### RAID, device mapper, LVM, and encryption

- [ ] raid.scan
- [ ] raid.assemble
- [ ] raid.stop
- [ ] raid.detail
- [ ] raid.create
- [ ] raid.add
- [ ] raid.remove
- [ ] raid.fail
- [ ] lvm.scan
- [ ] lvm.activate
- [ ] lvm.deactivate
- [ ] lvm.pv.create
- [ ] lvm.vg.create
- [ ] lvm.lv.create
- [ ] lvm.lv.resize
- [ ] lvm.remove
- [ ] luks.dump
- [ ] luks.open
- [ ] luks.close
- [ ] luks.header.backup
- [ ] luks.header.restore
- [ ] luks.format

Secrets such as LUKS passphrases are delivered in the job step, written to the child through stdin or an inherited file descriptor, and omitted from normal event rendering. The unrestricted shell still permits any operator-chosen secret handling.

### Filesystem actions

- [ ] filesystem.identify
- [ ] filesystem.check
- [ ] filesystem.repair
- [ ] filesystem.create
- [ ] filesystem.resize
- [ ] filesystem.label
- [ ] filesystem.uuid
- [ ] filesystem.mount
- [ ] filesystem.unmount
- [ ] filesystem.scrub

Map check/repair by type:

| Filesystem | Non-mutating/check command | Repair command |
| --- | --- | --- |
| ext2/3/4 | e2fsck -f -n | e2fsck -f -y, with caller extra args |
| XFS | xfs_repair -n | xfs_repair, optional -L when requested |
| Btrfs | btrfs check --readonly; scrub for mounted FS | btrfs check --repair only when requested |
| FAT | fsck.fat -n | fsck.fat -a or -r |
| exFAT | fsck.exfat -n when supported | fsck.exfat -p or requested args |
| NTFS | ntfsfix -n | ntfsfix; report that full chkdsk requires Windows |
| swap | swaplabel/read signature | mkswap when requested |

- [ ] Unmount or reject busy filesystems based on params, not hidden policy.
- [ ] force may pass tool-specific force flags and proceed on mounted devices.
- [ ] Preserve full native tool output.
- [ ] Parse progress when tools expose it, but do not wrap or suppress interactive output.
- [ ] Refresh block inventory after every mutating operation.

### Boot and installed-system actions

- [ ] boot.detect — determine mounted installed roots and firmware mode.
- [ ] boot.mount-system — mount root plus discovered boot/EFI partitions under /mnt/workwire/TARGET.
- [ ] boot.mount-pseudo — bind /dev, /proc, /sys, /run and copy resolver state.
- [ ] boot.chroot-command — arbitrary command in the installed system.
- [ ] boot.grub.install-bios.
- [ ] boot.grub.install-uefi.
- [ ] boot.grub.regenerate-config.
- [ ] boot.systemd-boot.install.
- [ ] boot.efi.list.
- [ ] boot.efi.create-entry.
- [ ] boot.efi.delete-entry.
- [ ] boot.initramfs.rebuild — detect dracut, update-initramfs, or mkinitcpio.
- [ ] boot.fstab.inspect.
- [ ] boot.fstab.rewrite.
- [ ] boot.kernel.list.
- [ ] boot.windows.bcd.inspect — use available tools or raw shell; preserve unsupported status.
- [ ] boot.cleanup-mounts.

Do not pretend a single boot repair recipe fits every distribution. Detect Fedora/RHEL, Debian/Ubuntu, Arch-like, and generic layouts, emit the selected recipe, and allow arbitrary overrides.

### Action tests

- [ ] Test command generation without root by injecting an executor spy.
- [ ] Test every action's required parameters and force propagation.
- [ ] Use loop devices only in opt-in integration tests.
- [ ] Create small filesystem image fixtures for ext4, XFS, Btrfs, FAT, and NTFS when tools are installed.
- [ ] Verify partition backups are collected before table mutations in composite playbooks.
- [ ] Verify raw execution remains available even if a typed action reports unsupported.

### Phase 7 acceptance

- [ ] registry.list() reports a complete machine-readable tool catalog.
- [ ] A loopback agent can create a file-backed disk, partition it, format it, mount it, write/read a marker, unmount it, and collect all artifacts.
- [ ] npm test passes.

## Phase 8 — Artifact and bulk-transfer plane

Create lib/recovery/ww-recovery-artifacts.mjs and finish the HTTP artifact routes.

### Required operations

- [ ] Create artifact metadata before bytes are sent.
- [ ] Stream upload to .partial without buffering the body.
- [ ] Stream download with backpressure.
- [ ] Support HEAD to return length, completeness, hash, content type, and metadata.
- [ ] Support Range downloads.
- [ ] Support resumable append uploads with an explicit expected offset.
- [ ] Reject an offset mismatch with the actual current offset so the client can resume.
- [ ] Compute SHA-256 incrementally for completed artifacts; permit hash: null for in-progress multi-gigabyte data.
- [ ] Preserve original filename as metadata while using artifactId as the storage filename.
- [ ] Associate artifacts with caseId, jobId, stepId, agentId, and semantic kind.
- [ ] Kinds include inventory, partition-table, ddrescue-map, disk-image, command-log, filesystem-report, boot-report, user-upload, and generic.
- [ ] Allow maxArtifactBytes: 0 for unlimited.
- [ ] Expose free-space information for the controller artifact volume.
- [ ] Emit progress events for both directions.
- [ ] Continue partial uploads after agent reconnect.

### Agent-side actions

artifact.download:

- Fetch controller artifact, resume into PATH.partial, verify optional hash, rename into place, preserve optional mode/mtime, and return the final path.

artifact.upload:

- Open source without loading it into memory, resume from controller offset, stream until EOF, finalize, and return artifact metadata.

- [ ] Permit block-device upload as a sequential artifact using an explicit size/range.
- [ ] Permit artifact download directly to a block device only through an explicit action with force propagation.
- [ ] Preserve sparse files when copying locally; HTTP transfer may de-sparsify and must report that fact.
- [ ] Add CLI progress with bytes, rate, and ETA.

### Large recovery storage

Add a scratch-path convention under recovery state and document these practical strategies:

- Clone failing disk to another locally attached healthy disk.
- Clone to a file on an NFS/CIFS/SSHFS mount created from raw shell.
- Clone to a local file, then upload it as an artifact.
- Sequentially stream a disk to the controller when resume/random access is not needed.

Do not build a fake ddrescue-over-HTTP abstraction in the first version. Native mounted storage plus raw shell is the unrestricted escape hatch.

### Phase 8 acceptance

- [ ] Transfer empty, small, binary, sparse, interrupted, resumed, and multi-hundred-megabyte generated files in tests.
- [ ] Hash mismatch and offset mismatch are observable and recoverable.
- [ ] Memory remains bounded during a large transfer.
- [ ] npm test passes.

## Phase 9 — Electron Recovery workspace

Keep the renderer sandbox and IPC architecture. Unrestricted power lives in the privileged main process and target agent, not by exposing Node directly to the DOM.

### Main-process recovery state

Add a separate recovery state object in desktop/ww-main.mjs, or preferably a new imported desktop/ww-recovery-main.mjs module to limit conflicts:

~~~json
{
  "controller": {"connected":true,"info":{},"error":null},
  "agents": [],
  "selectedAgentId": "",
  "inventory": null,
  "cases": [],
  "selectedCase": null,
  "jobs": [],
  "events": [],
  "artifacts": [],
  "busy": {},
  "error": null
}
~~~

- [ ] Main process owns the recovery client and optional token.
- [ ] Renderer receives no token.
- [ ] Subscribe to controller events once and forward compact recovery events through ww:event.
- [ ] Reconnect controller subscriptions after restart.
- [ ] Bound the in-memory UI event tail while leaving durable logs unbounded.

### Preload API

Add a nested recovery object or consistently prefixed methods:

~~~text
recoveryGetState()
recoveryRefresh()
recoverySelectAgent(agentId)
recoveryRequestInventory(agentId)
recoveryCreateCase(payload)
recoveryRunCase(caseId)
recoveryStopCase(caseId)
recoverySubmitJob(payload)
recoveryExec(payload)
recoveryShell(payload)
recoveryCancelJob(jobId)
recoveryRetryJob(jobId)
recoveryListArtifacts(caseId)
recoveryUpload(payload)
recoveryDownload(payload)
recoveryWake(payload)
recoveryPxeStatus()
recoveryPxeAction(payload)
~~~

Validate the sender using the existing handleTrusted pattern.

### Workspace layout

Add a compact Files / Recovery workspace switch in the existing custom window chrome without reintroducing the old topbar removed by current user changes.

Recovery view:

~~~text
+--------------------------------------------------------------------------+
| Files | RECOVERY                                      controller ONLINE   |
+------------------+--------------------------+----------------------------+
| MACHINES         | TARGET / DISKS           | CASE / CONTROL             |
| patient-01 LIVE  | NVMe Samsung 1 TB        | Goal                       |
| patient-02 OFF   |  EFI 512M FAT            | [multiline goal          ] |
| unknown PXE LIVE |  root 930G ext4 !         | [RUN AUTONOMOUS] [STOP]    |
|                  | SMART / RAID / LVM        |                            |
| [Wake] [PXE]     | [Inventory] [Actions]    | Command / Shell            |
|                  |                          | [input                    ] |
|                  |                          | [EXECUTE]                   |
+------------------+--------------------------+----------------------------+
| JOBS / LIVE OUTPUT / EVENT TIMELINE / ARTIFACTS                          |
+--------------------------------------------------------------------------+
~~~

### Required UI behavior

- [ ] Fleet list updates live and visibly distinguishes online, stale, offline, installed, and PXE sessions.
- [ ] Show hostname, agent ID, boot ID, IP/MAC, connection age, root capability, and tool coverage.
- [ ] Disk view shows stable ID, current path, model/serial, size, topology, partitions, filesystems, mounts, and health.
- [ ] Selecting a disk pre-populates structured action forms.
- [ ] Always show exact device identity and generated command before/during a typed operation.
- [ ] Provide raw argv command input and multiline Bash input.
- [ ] One Execute action submits immediately; do not add a mandatory second confirmation modal.
- [ ] Provide force toggle that is passed unchanged.
- [ ] Goal editor can create/run an autonomous case.
- [ ] Job list shows queue/running/terminal state, elapsed time, current step, and retry/cancel.
- [ ] Output view preserves stdout/stderr distinction, autoscroll toggle, copy, save, and clear-view-only.
- [ ] Event timeline can filter agent/job/planner/artifact events.
- [ ] Artifact list supports upload, download, reveal, and metadata.
- [ ] Wake button accepts saved or edited MAC and broadcast address.
- [ ] PXE pane shows selected interface, controller URL, dnsmasq status, boot artifacts, and start/stop/rebuild actions.
- [ ] Keyboard shortcuts:
  - Ctrl/Cmd+1 Files.
  - Ctrl/Cmd+2 Recovery.
  - Ctrl/Cmd+Enter execute current command.
  - Ctrl/Cmd+Shift+Enter run current goal autonomously.
  - Escape cancels the active local editor state, not the remote job.
- [ ] Preserve the existing file UI DOM and behavior when Files is selected.
- [ ] No CDN assets and no connect-src access from the renderer; all networking remains IPC-mediated.

### UI tests

- [ ] Extend ww-ui-contract without deleting existing assertions.
- [ ] Assert workspace switch and recovery regions exist.
- [ ] Assert raw exec, shell, force, autonomous run, stop, Wake, and PXE controls are wired to preload APIs.
- [ ] Test rendering with no controller, no agents, one live agent, an offline agent, complex disk topology, live output, and failures.
- [ ] Test recovery events do not mutate file-pane selections.
- [ ] Test switching workspaces does not reconnect or duplicate listeners.

### Phase 9 acceptance

- [ ] The operator can complete the entire CLI vertical slice from the Electron UI.
- [ ] Existing two-pane workflow remains visually and functionally intact.
- [ ] npm test passes.

## Phase 10 — Wake-on-LAN and power state

Create lib/recovery/ww-recovery-wol.mjs.

### Wake implementation

- [ ] Parse colon, dash, dotted, and plain 12-hex MAC formats.
- [ ] Build the magic packet: six 0xFF bytes plus the MAC repeated 16 times.
- [ ] Send through UDP broadcast to the requested address/port.
- [ ] Default to every broadcast address returned by collectLanBroadcastTargets(), port 9, then optional port 7 fallback.
- [ ] Allow explicit interface/address selection.
- [ ] Send a configurable burst, default three packets spaced about 100 ms without a long blocking sleep.
- [ ] Record wake attempts in the selected agent/case event stream when associated.
- [ ] Store friendly machine-to-MAC mappings in mac-addresses.json.
- [ ] Learn physical MACs from agent hello and inventory.

### Power observation

- [ ] After Wake, optionally wait for beacon/agent connection and report elapsed time.
- [ ] Distinguish packet sent from machine online; never claim the hardware powered on solely because send succeeded.
- [ ] Agent power.reboot supports reboot, systemctl reboot, shutdown -r now, and kexec through typed params/raw shell.
- [ ] Agent power.poweroff supports systemctl poweroff and poweroff.

### Future adapter boundary

Define but do not block the milestone on a createPowerAdapter() interface:

~~~text
getStatus()
powerOn()
powerOff()
reset()
setNextBoot(source)
openConsole()
~~~

Reserve adapter names wol, ipmi, redfish, amt, and custom-command. Implement wol and custom-command now. custom-command runs operator-configured local controller commands without filtering.

### Phase 10 acceptance

- [ ] Unit-test exact magic packet bytes and all MAC formats.
- [ ] Integration-test UDP receipt on loopback.
- [ ] UI and CLI can send and then wait for an agent.
- [ ] npm test passes.

## Phase 11 — PXE/iPXE boot plane on Fedora

Create lib/recovery/ww-recovery-boot.mjs, scripts/run-ww-pxe.mjs, recovery/dnsmasq/dnsmasq.conf.template, and recovery/ipxe/boot.ipxe.template.

### Host dependency setup

The current host already has dnsmasq, Podman, curl, jq, Node, sfdisk, fdisk, parted, and NVMe tools. It does not currently expose smartctl, ddrescue, QEMU, or live-build on the host.

- [ ] scripts/install-ww-recovery-host.sh detects Fedora and installs required packages noninteractively with dnf:
  - ipxe-bootimgs or the Fedora package providing BIOS and UEFI iPXE binaries.
  - smartmontools.
  - ddrescue.
  - gdisk.
  - testdisk.
  - qemu-kvm and qemu-system-x86-core/x86 as named by Fedora.
  - edk2-ovmf.
  - xorriso.
  - nfs-utils and cifs-utils as optional storage helpers.
- [ ] Detect already installed tools and do not fail merely because an optional package name differs; locate the providing package with dnf repoquery or continue with a clear missing-tool list.
- [ ] Use a Debian container for live-build rather than attempting to install Debian live-build directly on Fedora.

### PXE assets

- [ ] Locate or copy BIOS undionly.kpxe.
- [ ] Locate or copy x86_64 UEFI ipxe.efi.
- [ ] Optionally include arm64 UEFI only after x86_64 works.
- [ ] Compute and write SHA-256 for every asset.
- [ ] Serve assets from the fixed recovery boot state directory.
- [ ] Generate an iPXE script dynamically with the controller's address reachable from the requesting client.

### iPXE script

The generated boot script must:

- Detect that it is already inside iPXE and avoid a chain loop.
- Set controller and boot HTTP base URLs.
- Expose a simple menu: WorkWire Recovery, local boot/exit, iPXE shell, reboot.
- Default to WorkWire Recovery after a short timeout.
- Load vmlinuz and initrd.img over HTTP.
- Pass boot=live, components, ip=dhcp, fetch=HTTP_FILESYSTEM_SQUASHFS, ww.controller=HTTP_CONTROLLER, ww.mode=pxe, and identifying MAC/UUID values.
- Preserve console output and use nomodeset only as an alternate menu entry, not the only boot path.
- Exit back to firmware for local boot.

### dnsmasq proxyDHCP configuration

Render a dedicated config with:

- port=0 so it does not become a DNS server.
- interface set to the selected wired interface.
- bind-dynamic or bind-interfaces as supported.
- log-dhcp and explicit log file.
- dhcp-range for proxy mode on the detected subnet.
- enable-tftp and the WorkWire TFTP root.
- iPXE user-class detection.
- BIOS architecture to undionly.kpxe.
- UEFI x86_64 architecture codes to ipxe.efi.
- Already-iPXE clients chained to the HTTP boot.ipxe URL.
- No authoritative DHCP address pool.

- [ ] Detect interface, IPv4, prefix, network, broadcast, and advertised controller address using lib/ww-network.mjs.
- [ ] Require an explicit interface only when more than one equally plausible wired interface exists; otherwise select the best scored interface automatically.
- [ ] Validate the rendered config with dnsmasq --test.
- [ ] Detect another process already owning PXE ports and report its PID/command.
- [ ] Start dnsmasq in foreground under the managed process or through workwire-recovery-pxe.service.
- [ ] Write PID and logs to the recovery state directory.
- [ ] Stop only the dnsmasq instance whose PID/config belongs to WorkWire.
- [ ] Never kill the router's DHCP or unrelated dnsmasq process.

### PXE boot policy

Maintain a simple boot-policy JSON keyed by MAC:

~~~json
{
  "default": "recovery",
  "machines": {
    "aa:bb:cc:dd:ee:ff": {
      "next": "recovery",
      "after": "local",
      "name": "patient-01"
    }
  }
}
~~~

- [ ] ww recovery pxe arm MAC sets next=recovery.
- [ ] ww recovery pxe local MAC sets next=local.
- [ ] When after=local, consume the one-shot recovery choice after the agent successfully connects.
- [ ] Dynamic boot.ipxe selects recovery/local/shell from MAC policy.
- [ ] Default recovery remains configurable and is the prototype default.

### systemd root helper

- [ ] recovery/systemd/workwire-recovery-pxe.service runs dnsmasq with the generated config.
- [ ] scripts/install-ww-recovery-host.sh installs the unit and grants the normal WorkWire user control through a narrowly named sudoers drop-in or a root-owned helper command.
- [ ] The helper accepts start, stop, status, and reload for WorkWire PXE only.
- [ ] Do not sandbox away DHCP/TFTP raw network access.

### Phase 11 acceptance

- [ ] dnsmasq --test accepts generated config for the actual Fedora interface.
- [ ] A synthetic DHCP architecture matrix selects BIOS, UEFI, and already-iPXE targets correctly.
- [ ] HTTP boot script contains the correct same-LAN controller address.
- [ ] Start/status/stop are idempotent and do not affect unrelated processes.
- [ ] npm test passes.

## Phase 12 — Build the PXE recovery operating system

Build a Debian live environment in a privileged Podman build container so the Fedora host remains clean and repeatable.

### Build container

Create recovery/image/Containerfile based on a fixed Debian release and install:

- live-build
- debootstrap
- xorriso
- squashfs-tools
- curl
- ca-certificates
- xz-utils
- zstd
- git
- make
- file
- jq

Record the selected base image and digest in the build manifest. A later refresh is allowed, but a given WorkWire release must be reproducible from its manifest.

### Live package list

Include at minimum:

~~~text
systemd-sysv
live-boot
live-config
linux-image-amd64
firmware-linux
firmware-linux-nonfree when repository policy permits
firmware-iwlwifi
firmware-realtek
firmware-atheros
iproute2
isc-dhcp-client
network-manager
ethtool
curl
wget
jq
openssh-server
tmux
screen
less
vim-tiny
nano
busybox
bash
coreutils
util-linux
udev
pciutils
usbutils
lshw
dmidecode
hdparm
sdparm
smartmontools
nvme-cli
parted
fdisk
gdisk
testdisk
gddrescue
wipefs through util-linux
e2fsprogs
xfsprogs
btrfs-progs
dosfstools
exfatprogs
ntfs-3g
f2fs-tools
mdadm
lvm2
thin-provisioning-tools
cryptsetup
dmsetup
multipath-tools
grub-pc-bin
grub-efi-amd64-bin
grub2-common
efibootmgr
systemd-boot when available
dracut
initramfs-tools
rsync
tar
gzip
bzip2
xz-utils
zstd
nfs-common
cifs-utils
sshfs
socat
netcat-openbsd
tcpdump
dnsutils
iputils-ping
traceroute
python3
strace
lsof
psmisc
procps
chntpw
cabextract
qemu-utils
debootstrap
systemd-container
~~~

- [ ] Resolve package-name differences during the image build and write unavailable optional tools into manifest.json instead of failing after the core disk/network tools are installed.
- [ ] Include broad Ethernet, storage, USB, NVMe, AHCI, RAID, virtio, Hyper-V, and VMware kernel modules/firmware.
- [ ] Keep the SquashFS read-only and use tmpfs overlay for runtime changes.
- [ ] Reserve /mnt/workwire for mounted patient systems and /run/workwire-recovery for agent state.

### Node and agent payload

- [ ] Bundle a pinned official Node 22 x86_64 runtime inside /opt/workwire/node.
- [ ] Bundle the recovery agent modules and ws dependency inside /opt/workwire/agent.
- [ ] Do not bundle Electron into the live image.
- [ ] Add /usr/local/bin/ww-recovery-agent wrapper.
- [ ] Add a build-time self-test that imports all agent modules using the bundled Node.
- [ ] Write WorkWire app version, recovery protocol version, git revision when available, build time, Node version, package list, and checksums into /etc/workwire-recovery-build.json.

### Boot initialization

- [ ] Parse ww.controller, ww.token, ww.mode, ww.agent-id, ww.agent-name, and ww.debug from /proc/cmdline.
- [ ] Wait for network-online but also retry forever if network-online.target is inaccurate.
- [ ] Start workwire-recovery-agent.service as root.
- [ ] Start sshd as a fallback access path.
- [ ] Permit root console login and document the prototype recovery credential set by the build. Make it changeable through build variables.
- [ ] Print controller URL, assigned addresses, agent ID, and service status on the local console.
- [ ] Add a local helper command ww-recovery-status that shows network, controller reachability, agent journal, and disks.
- [ ] Configure getty/autologin or provide the documented recovery credential so a physically attached console is never locked out.
- [ ] Never mount patient filesystems automatically.
- [ ] Do not activate swap on patient disks automatically.
- [ ] mdadm/LVM discovery may run, but assembly/activation must be an explicit job or shell command so topology remains observable.

### Build script

scripts/build-ww-recovery-image.sh must:

1. Resolve repository root and output state directory.
2. Build/reuse the Podman builder image.
3. Copy the current recovery-agent payload into a clean staging directory.
4. Download/cache and verify the pinned Node archive.
5. Run live-build in a privileged container with only staging/output mounts.
6. Extract/copy vmlinuz, initrd.img, filesystem.squashfs, and optional ISO.
7. Generate SHA256SUMS and manifest.json.
8. Atomically replace the active boot artifact set only after all outputs verify.
9. Leave the previous good artifact set intact on build failure.
10. Print artifact paths, sizes, hashes, and the boot URL.

- [ ] Add npm run recovery:image-build and recovery:image-verify.
- [ ] Add a fast --reuse-rootfs or cache path for iteration.
- [ ] Verify the initrd contains the necessary live-boot and network pieces.
- [ ] Verify SquashFS contains Node, agent, service unit, and each core disk tool.

### Phase 12 acceptance

- [ ] Image build completes on the Fedora host through Podman.
- [ ] manifest and checksums verify.
- [ ] Direct kernel/initrd QEMU boot reaches multi-user recovery mode.
- [ ] Agent connects to the controller without manual guest input.
- [ ] npm test passes.

## Phase 13 — Autonomous recovery case engine

Create lib/recovery/ww-recovery-autonomy.mjs and lib/recovery/ww-recovery-planner-process.mjs.

The autonomy engine is an execution loop, not a chat decoration. It must be able to inspect facts, choose an action, execute it on the selected agent, observe exact results, update the case, and continue.

### Planner subprocess protocol

The configured planner is any local executable speaking newline-delimited JSON on stdin/stdout. Start it with child_process.spawn and no shell unless the configuration explicitly names a shell wrapper.

Controller to planner messages:

- planner.init — protocol, case, target, tool catalog, operating doctrine, inventory summary.
- planner.observation — completed action result, stdout/stderr tails, artifacts, inventory changes, error.
- planner.event — agent connect/disconnect, timeout, or operator note.
- planner.resume — full case checkpoint after controller restart.
- planner.stop — operator stopped the case.

Planner to controller messages:

- planner.note — concise reasoning/working note stored in the case.
- planner.action — one typed action or raw command/shell request.
- planner.actions — an ordered batch to create as one job.
- planner.inventory — request a refreshed inventory.
- planner.complete — outcome and verification summary.
- planner.fail — definitive reason it cannot proceed.
- planner.wait — wait for agent reconnect, SMART test completion, reboot, or a specified duration.

Example action:

~~~json
{
  "type": "planner.action",
  "requestId": "plan-17",
  "action": "filesystem.repair",
  "params": {
    "deviceId": "disk-by-id-and-partition",
    "filesystemType": "ext4",
    "force": true
  },
  "expectedObservation": "e2fsck reaches a clean exit and the filesystem mounts"
}
~~~

### Engine loop

1. Lock one active planner run per case.
2. Ensure target agent record exists; wait if offline.
3. Refresh inventory unless a sufficiently recent one is present.
4. Send init/resume context.
5. Validate only message shape and target/case consistency.
6. Convert action(s) directly into a job.
7. Execute and stream all events.
8. Send normalized result plus exact output tails/artifact references back to planner.
9. Refresh inventory after mutating steps.
10. Continue until complete, fail, stopped, process exit, or configured iteration ceiling.
11. Persist a checkpoint after every planner exchange.
12. Generate summary.md with goal, initial facts, actions, artifacts, final facts, and planner conclusion.

### Capability-first autonomy behavior

- [ ] Provide the full live action catalog, including command.exec and shell.exec.
- [ ] Do not remove mutating actions from the planner catalog.
- [ ] Do not insert per-action operator approval waits.
- [ ] Pass planner force values unchanged.
- [ ] If a typed operation is unavailable, return the tool error and keep raw shell available for the next iteration.
- [ ] Treat repeated identical failing actions as an observation; warn the planner after three exact repeats but do not silently terminate the case.
- [ ] maxIterations defaults to 100 and accepts 0 for unlimited.
- [ ] Allow planner-requested target reboot; wait for the same agentId with a new bootId and continue.
- [ ] Allow manual commands during a case and feed their results back as operator observations.
- [ ] Allow the operator to stop, edit the goal, add notes, and resume.
- [ ] If the planner process dies, mark the planner run failed but preserve the case and allow restart from checkpoint.

### Planner adapters

Implement:

1. command-jsonl
   - Production adapter for any configured external AI/agent executable.
   - Exact argv configured in controller.json or WW_RECOVERY_PLANNER_COMMAND.

2. deterministic-test
   - Test adapter that follows a fixture sequence.
   - Used to prove inventory -> action -> observation -> verify -> complete.

3. operator
   - No AI process. UI/CLI submits the next planner action manually while retaining the same case/event/checkpoint machinery.

Do not hardcode a single cloud vendor into the core. A concrete Codex/local-model wrapper may be added as a small script once the core JSONL contract passes tests.

### Planner context

Supply:

- Lab doctrine and unrestricted authority.
- Exact target identity, boot/session state, and current addresses.
- Complete normalized inventory with artifact link to raw inventory.
- Disk identity rules.
- Current goal and operator notes.
- Typed action descriptions and parameter shapes.
- Raw exec/shell availability.
- Recent event/history window plus references to older logs.
- Previous failures and exit codes.
- Current mounts/processes relevant to the case.
- Available controller free space and target storage.

Do not supply hidden renderer state or existing WorkWire file-service secrets.

### Tests

- [ ] Deterministic planner completes a read-only inspection case.
- [ ] Planner runs raw shell, receives nonzero status, revises, and succeeds.
- [ ] Planner performs a typed mutation on a file-backed fake disk, verifies, and completes.
- [ ] Controller restarts after an action; planner resumes from checkpoint without repeating a completed step.
- [ ] Agent reboots; planner waits and continues on new bootId.
- [ ] Planner process crash preserves the case and can restart.
- [ ] Iteration ceiling and unlimited mode.
- [ ] Operator stop and resume.

### Phase 13 acceptance

- [ ] ww recovery case create/run/follow completes an actual deterministic autonomous loop.
- [ ] Electron goal field can launch, observe, stop, and resume it.
- [ ] npm test passes.

## Phase 14 — Recovery playbooks and autonomous case templates

Create data-driven playbook templates under recovery/playbooks/. They provide strong starting sequences but never remove raw access or prevent the planner from deviating.

### Common opening sequence

Every disk case template begins by collecting:

1. Full inventory.
2. Kernel storage warnings.
3. SMART/NVMe health.
4. Existing mounts and processes using target devices.
5. Partition-table dumps.
6. First/last sector-region backups when readable.
7. Exact target stable identities.

When force is true, an unreadable backup does not block the requested next operation.

### Template: unbootable Linux root filesystem

- [ ] Identify root candidates from fstab, labels, UUIDs, bootloader config, and filesystem content.
- [ ] Assemble mdraid/LVM/LUKS layers as needed.
- [ ] Run filesystem-specific non-mutating check.
- [ ] Run repair when goal requests recovery.
- [ ] Mount root read-only first for diagnosis, then read-write when needed.
- [ ] Mount boot/EFI and pseudo filesystems.
- [ ] Inspect fstab, crypttab, kernel/initramfs, boot entries, and grub/systemd-boot config.
- [ ] Repair UUID references, rebuild initramfs, reinstall/regenerate bootloader.
- [ ] Unmount cleanly and rerun filesystem check.
- [ ] Verify key files and boot configuration.

### Template: missing or corrupt GPT/MBR

- [ ] Capture current primary/backup GPT reads, sfdisk/fdisk output, and sector samples.
- [ ] Check whether backup GPT is intact.
- [ ] Search for filesystem signatures and likely partition boundaries with testdisk, blkid, file, and targeted scans.
- [ ] Generate a candidate table artifact before applying.
- [ ] Apply with sgdisk/sfdisk/parted or TestDisk as selected.
- [ ] Reread table, refresh inventory, and mount discovered filesystems.
- [ ] Verify file samples and partition alignment.
- [ ] Store before/after table artifacts.

### Template: physically failing source disk

- [ ] Capture SMART/NVMe health without launching unnecessary long tests first.
- [ ] Identify a destination at least as large as source or a mounted image path with enough free space.
- [ ] Create and persist ddrescue mapfile.
- [ ] Run fast no-scrape pass.
- [ ] Run direct/retry passes as goal and source condition justify.
- [ ] Permit reverse pass and custom ddrescue args.
- [ ] Periodically upload mapfile and status.
- [ ] Work on clone/image for partition and filesystem repair unless the explicit goal chooses source.
- [ ] Verify recovered files or hashes.

### Template: UEFI/GRUB/initramfs repair

- [ ] Detect firmware mode and EFI System Partition.
- [ ] Detect installed distribution and boot stack.
- [ ] Mount root, boot, EFI, dev/proc/sys/run.
- [ ] Validate fstab/crypttab UUIDs and root kernel argument.
- [ ] Chroot and rebuild initramfs with native distribution tool.
- [ ] Reinstall GRUB or systemd-boot as detected/requested.
- [ ] Regenerate configuration.
- [ ] Inspect/create efibootmgr entry.
- [ ] Save commands and output as boot-report artifact.

### Template: Windows/NTFS partition access

- [ ] Locate Microsoft basic-data and EFI/MSR partitions.
- [ ] Read NTFS metadata and ntfsfix status.
- [ ] Mount read-only and copy priority data when requested.
- [ ] Run ntfsfix when requested.
- [ ] Inspect EFI/Microsoft/Boot files and BCD availability.
- [ ] Preserve explicit note that Linux ntfsfix is not full Windows chkdsk while still permitting raw work.
- [ ] Allow attaching a Windows PE image or chainloading a WinPE recovery environment as a future boot menu entry.

### Template: mdraid/LVM/LUKS stack

- [ ] Collect mdadm metadata from every member.
- [ ] Assemble with explicit UUID/member selection.
- [ ] Scan and activate VGs/LVs.
- [ ] Open LUKS mappings using provided key material.
- [ ] Build and show the dependency graph.
- [ ] Run filesystem actions only on the resolved top-level logical device.
- [ ] Close/deactivate in reverse order when complete.

### Template: resize/migrate

- [ ] Inventory current and proposed boundaries.
- [ ] Resize in correct layer order: filesystem, LV/partition, PV/container as applicable.
- [ ] Support grow and shrink only where native tools support them.
- [ ] Permit raw custom sequences for unsupported layouts.
- [ ] Refresh inventory and filesystem check after each layer.

### Playbook format

Use JSON or ESM data with:

~~~json
{
  "id": "linux-boot-repair-v1",
  "title": "Linux root and boot repair",
  "matches": {},
  "inputs": [],
  "steps": [],
  "verification": [],
  "plannerHints": []
}
~~~

- [ ] Expose playbooks through CLI, UI, and planner context.
- [ ] Playbook steps may contain conditional expressions evaluated against normalized inventory.
- [ ] Render the expanded plan before execution for visibility, but execute with one action.
- [ ] Allow force, extra args, skipped steps, inserted steps, and conversion to raw shell.

### Phase 14 acceptance

- [ ] Each template expands correctly against at least two fixtures.
- [ ] File-backed/loop integration covers GPT restore, ext repair, and a simple LVM stack when tools are installed.
- [ ] npm test passes.

## Phase 15 — Blackout, disconnect, and resume engineering

Power loss is expected behavior, not an exceptional edge case.

### Controller durability

- [ ] Persist job/case transition before sending the corresponding remote instruction.
- [ ] Flush event lines promptly; do not wait for job completion.
- [ ] Reconstruct compact snapshots from JSON/events after abrupt controller termination.
- [ ] SSE/UI reconnect resumes from last canonical seq.
- [ ] Controller restart never creates duplicate completed steps.

### Agent durability

- [ ] Installed mode persists current job and unacknowledged events under /var/lib/workwire-recovery.
- [ ] PXE mode persists only in /run, so the controller remains the authority across a target reboot.
- [ ] Each step result has deterministic attempt identity.
- [ ] Agent resend is idempotent.
- [ ] A command that was running when the target died becomes interrupted, never falsely succeeded.

### Action resume semantics

Classify each action:

- naturally resumable: artifact transfer, ddrescue with mapfile, long SMART test observation.
- safe to re-run for convergence: inventory, mount discovery, partprobe, boot config generation.
- requires explicit retry/new attempt: table write, filesystem repair, wipe, image restore.
- external-state dependent: reboot, poweroff, wait for human cable/destination.

This classification controls automatic resume behavior, not permission. The operator/planner can always submit a new forced attempt.

### Reboot continuation

- [ ] Before planned reboot, checkpoint case and expected next boot behavior.
- [ ] Mark job step waiting-for-reboot.
- [ ] Match reconnect by stable agentId, not IP.
- [ ] Require a changed bootId to confirm reboot actually occurred.
- [ ] Resume the planner with new lightweight/full inventory.
- [ ] If PXE policy is one-shot, switch it to local only after the recovery agent has checked in and the case requests local boot.

### Network interruption

- [ ] Keep running local disk tools if controller connection drops unless the job explicitly sets cancelOnDisconnect.
- [ ] Buffer events locally within disk limits.
- [ ] Reconnect and replay.
- [ ] Controller shows stale connection but preserves running state until offline threshold.
- [ ] Long job lease extends from agent event/heartbeat replay.

### Phase 15 acceptance

- [ ] Automated tests kill controller mid-output, kill agent mid-command, sever sockets, duplicate messages, and restart both sides.
- [ ] ddrescue fixture resumes from a mapfile.
- [ ] No test reports success for an interrupted mutation.
- [ ] npm test passes.

## Phase 16 — QEMU, loop-device, and physical LAN validation

### Test levels

1. Default unit tests
   - No root, no real devices, fast, always run with npm test.

2. Loopback integration
   - Real controller, fake/local agents, temp state, regular files.
   - Also part of npm test when unprivileged.

3. Privileged file-backed block tests
   - Enabled with WW_RUN_PRIVILEGED_TESTS=1.
   - Use only newly created temp image files and loop devices.
   - Record every loop device and detach in finally cleanup.

4. QEMU direct-boot recovery test
   - Enabled with WW_RUN_QEMU_TESTS=1.
   - Uses generated kernel/initrd/SquashFS and a disposable qcow2 data disk.

5. Full PXE QEMU test
   - Uses an isolated tap/bridge or network namespace and the WorkWire dnsmasq config.
   - Validates architecture selection, iPXE chain, HTTP live boot, and agent check-in.

### QEMU direct-boot scenario

- [ ] Start controller/boot server on a guest-reachable host address.
- [ ] Create a disposable 4–8 GiB qcow2 data disk.
- [ ] Boot recovery kernel/initrd with virtio-net and controller 10.0.2.2 URL under user networking.
- [ ] Wait for guest agent through controller API.
- [ ] Run inventory and confirm virtio disk identity.
- [ ] Create GPT and EFI/ext4 partitions through typed jobs.
- [ ] Format, mount, write a marker, and unmount.
- [ ] Back up partition table.
- [ ] Corrupt the disposable table region.
- [ ] Confirm partitions disappear or inventory reports corruption.
- [ ] Restore table backup and confirm marker is readable.
- [ ] Mark ext filesystem for check or introduce controlled image-only damage.
- [ ] Run filesystem repair and verify clean result.
- [ ] Exercise artifact upload/download.
- [ ] Reboot guest and verify same agentId/new bootId continuation.
- [ ] Power off through the portal and verify job/event closure.

### QEMU firmware coverage

- [ ] BIOS direct/PXE boot.
- [ ] UEFI with OVMF direct/PXE boot.
- [ ] Virtio block and NVMe emulation where supported.
- [ ] A second virtual agent simultaneously connected.
- [ ] Optional simulated network drop.

### Test isolation correctness

- [ ] Privileged tests enumerate the chosen loop/QEMU path and assert it resides in the test temp directory before mutations.
- [ ] Never choose a host disk by “first disk.”
- [ ] Cleanup functions run after failure and print manual cleanup commands if detachment fails.
- [ ] Full command/event logs remain under test output for diagnosis.

### Physical validation checklist

Do this after software/QEMU completion using a spare target and disposable disk:

- [ ] Connect controller and target by wired LAN.
- [ ] Confirm controller interface/subnet and router DHCP.
- [ ] Enable target PXE/network boot once in UEFI/BIOS; disable Secure Boot if unsigned iPXE is rejected.
- [ ] Start WorkWire controller, boot server, and PXE helper.
- [ ] Boot target through BIOS PXE and confirm agent.
- [ ] Boot target through UEFI PXE and confirm agent.
- [ ] Confirm NIC/MAC/hostname/DMI identity remains stable across reboot.
- [ ] Run full inventory.
- [ ] Use a disposable USB/SATA/NVMe device for first destructive validation.
- [ ] Complete partition-create/format/mount/write/read/backup/wipe/restore flow.
- [ ] Pull power or disconnect network during a long disposable operation and verify recovery state.
- [ ] Test Wake-on-LAN after enabling it in firmware/OS.
- [ ] Verify local-boot exit path after recovery.

### Phase 16 acceptance

- [ ] Default, privileged, QEMU direct, and full PXE test commands are documented and independently runnable.
- [ ] QEMU direct scenario is automated end to end.
- [ ] Full PXE is automated as far as host privilege/network namespace permits.
- [ ] Physical-only unchecked items are clearly separated from software failures.
- [ ] npm test passes.

## Phase 17 — Packaging, installation, documentation, and final verification

### Package contents

- [ ] Add lib/recovery/**/*, recovery/**/*, and relevant scripts to package.json files/package configuration.
- [ ] Ensure ws is available in packaged Electron and CLI runtime.
- [ ] Package boot templates and systemd units.
- [ ] Keep generated multi-gigabyte live artifacts out of the normal Electron ASAR unless explicitly requested.
- [ ] LAN installer may publish recovery manifest and boot artifacts alongside the application as separate downloads.
- [ ] Recovery image version must match recovery protocol compatibility rules, not necessarily exact file-desk app equality.

### Installation

- [ ] Existing npm run install remains unprivileged and functional.
- [ ] npm run recovery:host-install performs explicit root host setup for PXE/tooling.
- [ ] npm run recovery:agent-install installs the root target service.
- [ ] Installation is idempotent.
- [ ] Uninstall removes units/binaries only after stopping them and preserves recovery cases/artifacts by default.
- [ ] Print exact commands to fully purge state when wanted.

### Documentation

Add docs/RECOVERY.md with:

- Architecture and ports.
- Trusted isolated-lab operating model.
- Host installation on Fedora.
- Building/verifying the live image.
- Starting controller/PXE.
- One-time target firmware setup.
- Installed-agent deployment.
- CLI reference.
- Electron Recovery workspace guide.
- Disk identity model.
- Every typed action and raw shell.
- Playbooks.
- Artifact and storage strategy.
- Blackout/reconnect behavior.
- QEMU test commands.
- Physical validation procedure.
- Troubleshooting for DHCP conflicts, iPXE loops, missing firmware, Secure Boot rejection, no agent check-in, tool absence, and stale jobs.
- Explicit recovery-root credential/change procedure.

Carefully add only a short link/section to the currently modified README.md and docs/WW.md after the recovery implementation works. Preserve the existing prose and user changes.

### Final commands

Run and record:

~~~bash
npm ci
npm test
npm run dist:linux
npm run recovery:image-build
npm run recovery:image-verify
WW_RUN_PRIVILEGED_TESTS=1 npm test
WW_RUN_QEMU_TESTS=1 npm test
~~~

Where a privileged or hardware command is impossible in the current session, record the exact command, prerequisite, and already-completed lower-level evidence. Do not substitute a claim of success.

### Final demonstration

Capture a concise transcript proving:

1. Controller start.
2. Two agents online.
3. Inventory.
4. Raw root exec and shell.
5. Typed partition/filesystem workflow on disposable media.
6. Artifact transfer.
7. Autonomous goal execution.
8. Target reconnect after controller restart.
9. Target reboot continuation.
10. PXE recovery agent boot in QEMU.
11. Existing Files workspace still transfers between two WorkWire peers.

### Phase 17 acceptance

- [ ] All software definition-of-done items are met.
- [ ] All tests/builds executed are reported with exact pass/fail totals.
- [ ] Remaining physical lab actions, if any, are a short explicit list.
- [ ] git diff contains no unrelated formatting churn or lost pre-existing changes.

## Mandatory implementation checkpoints

These checkpoints provide usable power early while the full portal is still being built.

### Checkpoint A — Remote root nerve

Complete Phases 0–6 far enough to demonstrate:

- Controller starts and persists state.
- Root agent connects and survives controller restart.
- Fleet list works.
- Full inventory works.
- Raw argv and Bash jobs stream output.
- Cancellation and reconnect work.

Do not begin visual polish or PXE before this end-to-end nerve works. This is the foundation for every later recovery operation.

### Checkpoint B — Disk hands

Complete Phases 7–8 far enough to demonstrate on a disposable image:

- Stable device resolution.
- Partition-table backup/restore.
- Filesystem create/check/repair.
- Mount/read/write.
- ddrescue map/progress.
- Artifact upload/download/resume.

At this point an installed-agent machine can already be operated remotely with full root power.

### Checkpoint C — Portal cockpit

Complete Phases 9–10:

- Recovery workspace mirrors every working CLI capability.
- Live events, output, disks, jobs, and artifacts are usable without a terminal on the controller.
- Wake-on-LAN is wired.

Do not hide missing backend capability behind disabled UI. If a button is present, it must execute a real controller operation and display the actual result.

### Checkpoint D — Dead-OS access

Complete Phases 11–12 and direct/full PXE validation:

- Fedora host runs proxyDHCP/TFTP and HTTP boot server.
- BIOS/UEFI iPXE selection is correct.
- Live recovery OS boots and agent checks in.

This checkpoint is what changes WorkWire from remote administration into true failed-boot recovery.

### Checkpoint E — Autonomous surgeon

Complete Phases 13–15:

- Goal-driven planner loop sees facts/tools/results.
- It may use typed operations or unrestricted shell.
- It resumes after controller/target interruption.
- Case summary and artifacts are complete.

### Checkpoint F — Ship it

Complete Phases 16–17:

- QEMU evidence.
- Physical checklist where available.
- Packaging and installation.
- Documentation and final regression.

## Error code catalog

Use stable codes so CLI, UI, planner, and tests can reason without string matching:

| Code | Meaning |
| --- | --- |
| ERR_WW_RECOVERY_BAD_REQUEST | Malformed API or protocol input |
| ERR_WW_RECOVERY_PROTOCOL | Controller/agent protocol mismatch |
| ERR_WW_RECOVERY_NOT_FOUND | Agent, case, job, step, or artifact absent |
| ERR_WW_RECOVERY_AGENT_OFFLINE | Target has no usable live session |
| ERR_WW_RECOVERY_AGENT_REPLACED | Job referenced a superseded agent session |
| ERR_WW_RECOVERY_DEVICE_NOT_FOUND | Stable block identity cannot resolve |
| ERR_WW_RECOVERY_DEVICE_CHANGED | Stable identity and explicit path disagree |
| ERR_WW_RECOVERY_TOOL_MISSING | Typed action lacks a required native tool |
| ERR_WW_RECOVERY_COMMAND_START | Child could not be spawned |
| ERR_WW_RECOVERY_COMMAND_FAILED | Typed action considers command result failed |
| ERR_WW_RECOVERY_TIMEOUT | Operation exceeded its configured timeout |
| ERR_WW_RECOVERY_CANCELED | Operator/controller canceled operation |
| ERR_WW_RECOVERY_INTERRUPTED | Agent/controller/power loss interrupted operation |
| ERR_WW_RECOVERY_INVALID_TRANSITION | State-machine transition is impossible |
| ERR_WW_RECOVERY_LEASE | Job lease is stale or owned by another session |
| ERR_WW_RECOVERY_EVENT_SEQUENCE | Agent event sequence conflict |
| ERR_WW_RECOVERY_ARTIFACT_OFFSET | Resume offset mismatch |
| ERR_WW_RECOVERY_ARTIFACT_HASH | Completed artifact failed verification |
| ERR_WW_RECOVERY_ARTIFACT_SPACE | Controller/target lacks requested storage |
| ERR_WW_RECOVERY_PXE_CONFIG | PXE configuration/render/validation failure |
| ERR_WW_RECOVERY_PXE_PROCESS | Managed dnsmasq failure |
| ERR_WW_RECOVERY_BOOT_ARTIFACT | Missing or invalid boot image component |
| ERR_WW_RECOVERY_PLANNER_PROTOCOL | Invalid planner JSONL message |
| ERR_WW_RECOVERY_PLANNER_EXIT | Planner process exited unexpectedly |
| ERR_WW_RECOVERY_PLANNER_LIMIT | Configured iteration ceiling reached |

Error payloads may include details, command result, target identity, current offset, or native stderr. Never replace native diagnostics with a generic friendly string in engineering CLI/output.

## CLI exit codes

| Exit | Meaning |
| ---: | --- |
| 0 | Requested operation succeeded |
| 1 | Remote command/action completed unsuccessfully |
| 2 | CLI usage or validation error |
| 3 | Controller unavailable/incompatible |
| 4 | Target agent offline/not found |
| 5 | Job/case failed or was interrupted |
| 6 | Build/PXE host operation failed |
| 130 | Interrupted by Ctrl-C |

When raw remote exit code is between 1 and 125, exec/shell may return it directly. JSON output always includes the full remote result regardless of local exit mapping.

## Compatibility rules

- Existing file protocol remains WW_PROTOCOL_VERSION = 1 until its own behavior changes.
- Recovery protocol begins at WW_RECOVERY_PROTOCOL_VERSION = 1.
- Controller rejects an unsupported recovery protocol with its supported version/range.
- App version mismatch alone does not reject a recovery agent when protocol and required capabilities are compatible.
- Jobs include required action/capability names; controller leaves unsupported jobs queued/failed with a precise capability error rather than pretending an app-version mismatch.
- A recovery image manifest records protocol and action catalog versions.
- Planner protocol is independently versioned, beginning at 1.
- State/config migrations are explicit functions with fixture tests.

## Test fixture plan

Add test/fixtures/recovery/:

~~~text
agent-hello/
  installed.json
  pxe.json
inventory/
  sata-gpt-lsblk.json
  nvme-gpt-lsblk.json
  mdraid-lvm-luks.json
  smart-sata.json
  smart-failing.json
  nvme-smart.json
  fdisk-mbr.txt
  sfdisk-gpt.json
  blkid-export.txt
  malformed.json
planner/
  inspect-complete.jsonl
  fail-revise-complete.jsonl
  reboot-resume.jsonl
pxe/
  bios-discover.bin-or-json
  uefi-x64-discover.bin-or-json
  ipxe-discover.bin-or-json
actions/
  ddrescue-progress.txt
  e2fsck-clean.txt
  e2fsck-repaired.txt
  xfs-repair.txt
  btrfs-check.txt
  ntfsfix.txt
~~~

- Keep fixtures synthetic or collected from disposable virtual devices.
- Store raw native output exactly where parser fidelity matters.
- Test unknown future fields are preserved/ignored appropriately.
- Avoid snapshots that make meaningful protocol changes invisible; assert critical fields explicitly.

## Coding patterns the next agent should follow

- Use dependency injection for clock, random IDs, fs, spawn, network interfaces, and sockets where tests need determinism.
- Keep side-effect-free parsing separate from command execution.
- Use execFile/spawn argument arrays for typed actions.
- Use Bash only for the explicitly unrestricted shell action or an operator-supplied custom power command.
- Stream data; do not read disk images or unlimited output into Buffer/string wholesale.
- Use AbortSignal for cancellation across controller client, executor, inventory collectors, and artifact transfer.
- Use timers with unref() so tests/process shutdown do not hang.
- Attach and remove socket/request listeners deliberately.
- Treat EPIPE/ECONNRESET during event upload as reconnect conditions.
- Persist before announcing state.
- Generate commands from one source of truth shared by CLI/UI/planner action metadata.
- Never make UI text the only representation of a machine/device identity.
- Keep human-friendly names alongside stable IDs.
- Keep stdout and stderr separate in storage and transport.
- Preserve exact command/argv/environment overrides in events, excluding only deliberately marked secret values.
- Use bounded tails in JSON snapshots and unbounded append logs on disk.
- Keep all default tests safe and unprivileged; isolate privileged mutation tests behind explicit environment flags and disposable paths.

## Decisions that are closed

Do not reopen these unless a concrete implementation failure proves them impossible:

- Controller and first agent are Node 22 ESM.
- ws is the only initial new runtime dependency.
- Recovery controller uses port 4852 and boot HTTP uses 4853.
- PXE uses dnsmasq proxyDHCP plus iPXE, not replacement DHCP.
- Live image is built in a Debian live-build Podman container on Fedora.
- The agent initiates the controller connection.
- Recovery state is filesystem JSON/JSONL/artifacts, not SQLite.
- Existing file service remains separate on port 4851.
- Electron renderer remains sandboxed/no Node and uses IPC.
- Raw root argv and Bash execution are permanent core features.
- Typed actions do not remove raw access.
- force bypass exists.
- No mandatory per-step approval workflow.
- No RBAC/PKI/cloud/security-hardening detour for this prototype.
- QEMU is the repeatable validation target before patient hardware.

## Known current workspace state

At handoff creation, these pre-existing paths were modified or untracked before this TODO was added:

~~~text
README.md
desktop/ww-main.mjs
desktop/ww-preload.cjs
desktop/ww/index.html
desktop/ww/renderer.js
desktop/ww/styles.css
docs/WW.md
lib/ww-client.mjs
lib/ww-config-store.mjs
lib/ww-endpoint.mjs
lib/ww-service.mjs
lib/ww-transfer.mjs
scripts/install-ww-bundle.sh
scripts/launch-workwire.sh
test/ww-bundle-install.test.mjs
test/ww-config-store.test.mjs
test/ww-endpoint.test.mjs
test/ww-service.test.mjs
test/ww-ui-contract.test.mjs
ww.mjs
desktop/assets/
desktop/ww/assets/
Portal/
~~~

They belong to the operator/current project evolution. Integrate additively and inspect each relevant diff before editing it.

Host facts observed at handoff:

~~~text
Fedora Linux 43 Workstation
Linux x86_64 kernel 6.18.5
Node 22.22.0
Podman 5.7.1
dnsmasq 2.91
nvme-cli 2.16
util-linux 2.41
parted 3.6
curl and jq installed
smartctl, ddrescue, QEMU, xorriso, and live-build not found in PATH
~~~

Package detection must be repeated before installation because the machine can change.

## Autonomous execution algorithm for the next coding agent

Use this work loop:

1. Read this entire document and the relevant existing files.
2. Inspect overlapping uncommitted diffs before patching.
3. Select the first unchecked phase item whose dependencies are complete.
4. Implement the smallest complete vertical behavior, not disconnected stubs.
5. Add focused tests in the same change.
6. Run the focused test.
7. Run npm test.
8. Fix all regressions before expanding scope.
9. Update this document's checkbox and append one short evidence line under the phase.
10. Continue immediately to the next item.

When an implementation detail differs on the real host:

- Inspect native tool --help/version and adapt capability detection.
- Prefer runtime discovery over hardcoded distro assumptions.
- Preserve the fixed external behavior.
- Add a fixture/test for the discovered variant.
- Continue; do not stop for a naming choice.

When a dependency is absent:

- Install it if installation is local and noninteractive.
- If the package name differs, query the package manager.
- If network/package installation is temporarily impossible, finish code with injected test doubles and proceed to every phase not dependent on the binary.
- Record the exact remaining install/validation command.

When physical hardware is absent:

- Complete unit, integration, loop, and QEMU paths.
- Leave only the physical checklist unchecked.
- Do not mark controller, agent, action, UI, image, or autonomy code blocked.

When a test exposes a conflict with existing WorkWire behavior:

- Preserve the existing file-desk contract.
- Move recovery into a separate module/state/API rather than weakening old assertions.
- Update an old test only when the intended user-visible behavior genuinely expanded, never merely to hide a regression.

## Minimum evidence to leave after each checkpoint

Record beneath the checkpoint:

- Date/time.
- Files added/changed.
- Focused test command and result.
- Full npm test pass/fail count.
- One manual or automated end-to-end command transcript.
- Known limitations that are genuinely not yet scheduled in a later phase.

Do not use “should work,” “not tested,” or “probably” when a local test can answer it.

## Completion report template

The final agent response should use this compact structure:

~~~text
Outcome
- What is now operational.

Proof
- Test/build totals.
- QEMU/PXE demonstration result.
- Key CLI/UI demonstration.

Files
- Major new modules and docs.

Physical lab follow-up
- Only steps requiring an actual second machine/firmware/cable, if any.

Existing work preservation
- Confirmation that pre-existing changes were retained.
~~~

## Final principle

## Future raw-control multipliers

Proposed 2026-07-20. These are ranked by reach removed per implementation day.
They are not approved implementation work yet.

- [ ] **1. Auto-discovery and auto-enroll** — 4–6 days; reach 10/10. Sweep
  mDNS/ARP/DHCP observations, wake eligible hosts, offer PXE recovery, install
  the recovery agent, then pin the resulting stable identity. Keep the
  token-plus-peer-identity convergence contract; never turn discovery into
  anonymous enrollment.
- [ ] **2. Bare-metal clone and deploy** — 2–4 days; reach 9/10. Turn the
  existing imaging lane into one source image → canary → bounded fleet rollout
  with hash proof, named backups, and rollback source retention.
- [ ] **3. Live discovered-machine fleet exec** — 2 days; reach 8/10. Extend
  fleet execution from registered agents to the live discovery inventory, with
  an explicit bootstrap/enroll action for machines that have no agent yet.
- [ ] **4. Persistent roaming reverse tunnels** — 2–3 days; reach 8/10. Let
  laptops maintain an outbound recovery route to HINOKI while retaining stable
  agent identity and controller proof.
- [ ] **5. One-command remote console launch** — 1–2 days; reach 7/10. Launch
  the discovered RDP/VNC/SPICE route from the cockpit without manual client
  selection or address copying.
- [ ] **6. GPU, sensor, and power continuity entities** — 2–3 days; reach
  6/10. Add telemetry as queryable machine-graph entities, preserving unknown
  readings as unknown rather than inventing health.
- [ ] **7. Fleet panic macro** — 1 day; reach 6/10. One HINOKI command for
  bounded hibernate/wake/reimage/rollback-source actions. Sakura's power path
  is hibernate only (`shutdown /h`); never S5-shutdown it.

Selection rule: implement only one ranked item at a time after operator
approval, using recovery-agent transport, verify-before-execute archives, and
postcondition proof.

WorkWire Recovery is a root-capable laboratory instrument. Its job is to give the operator and autonomous planner complete reach into owned machines over the LAN, including the ability to make irreversible changes. Engineer it for exact identity, observable commands, durable state, interruption recovery, and unrestricted escape hatches. Do not reduce its capability to make it resemble a consumer help wizard.
