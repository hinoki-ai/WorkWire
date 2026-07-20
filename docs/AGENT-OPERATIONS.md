# WorkWire agent operations contract

WorkWire is the Agentic Archon: a local-first authority over operator-owned
machines, exercised through trusted privileged agents. This contract governs
the agent capabilities and evidence used to exercise that authority.

This is an agent-to-agent execution contract, not a human tutorial. Autonomous
agents consume it directly from the live repository and emit machine-readable
evidence. Do not substitute remembered IP addresses, browser downloads,
interactive installers, undocumented credentials, or approval pauses.
Historical handoffs are evidence only and cannot override this contract.

## Desired fleet state

| Property | HINOKI Linux | Sakura Windows |
|---|---|---|
| Stable file-service ID | `t8K6zAc6chbIa3srdlFEeQ` | `RQn5hi_GTBHwvC6bQmmTYg` |
| Stable recovery-agent ID | `wwra_AQwelJu3cxhVk0h1GXvmbaCf` | `wwra_xCR5XgqeHAd2RkAzsp81bWPo` |
| Recovery privilege | root, effective UID 0 | LocalSystem |
| Source root | `/home/hinoki/WorkWire` | `C:\Users\Sakura\WorkWire` |
| File config | `.workwire/config/ww-config.json` | `C:\Users\Sakura\.config\workwire\ww-config.json` |
| File service | TCP 4851 | TCP 4851 |
| Recovery role | only fleet controller, TCP 4852/4853 | external-controller client and SYSTEM agent |

HINOKI's current wired address is discovered from the interface carrying the
default route. Sakura's address is discovered from the recovery agent's live
inventory or router/L2 state. At the 2026-07-19 convergence they were
`192.168.8.104` and `192.168.8.100`; those values are observations, not durable
identity. ICMP is not an availability gate because Windows blocks it. Recovery
agent state and authenticated HTTP discovery are the gates.

The recovery controller is intentionally centralized on HINOKI. Both Electron
desks attach to it. Sakura must not start an embedded recovery controller when
the configured external controller is unavailable; failure is explicit so the
fleet never splits into two control planes.

Agent socket receipt is the live liveness authority: a valid heartbeat updates
the session/public record to `online` immediately and is acknowledged without
waiting for storage. Durable heartbeat, inventory, and lease checkpoints are
coalesced to a bounded 1–5 second interval derived from stale/offline/lease
limits. Job state transitions remain individually durable. This prevents a
fleet of sub-second Windows agents from building an NTFS `fsync` queue while
preserving restart-safe state.

JSONL journal readers distinguish an in-progress append from corruption. Only
a malformed final record whose snapshot lacks its terminating newline is
retried, for at most 20 reads over roughly 100 ms. A malformed completed record
or a persistently truncated tail still raises `ERR_WW_RECOVERY_JOURNAL`; agents
must never discard or silently skip it. This makes command following safe while
an agent is emitting events without weakening durable corruption detection.

## Invariants

- Both file services run the exact current source release, protocol, update
  source hash, shared trust token, and mutually pinned service identities.
- HINOKI can execute unrestricted argv/shell as LocalSystem on Sakura.
- Sakura can execute unrestricted argv/shell as root on HINOKI through the same
  controller. Recovery exposes raw capability; it adds no RBAC or approval
  layer. Existing device-identity, path-containment, integrity, and explicit
  `force` semantics remain intact.
- Pairing and recovery secrets live only in mode-restricted files or protected
  machine state. Never print them, put them in argv, commit them, or reproduce
  them in documentation.
- Sakura's OptiPlex firmware wakes from S4 hibernate, not S5 shutdown. Never
  power Sakura off. Leave it running or use `shutdown /h`.
- Only HINOKI may be powered off at fleet completion, and only after the remote
  commit is verified and every proof below is green.

## Managed Linux namespace

All HINOKI service, doctor, convergence, and release commands use one namespace:

```bash
export WW_PORTAL_PATH=/home/hinoki/WorkWire
export WW_HOME_DIR=/home/hinoki/WorkWire/.workwire
export WW_CONFIG_DIR=/home/hinoki/WorkWire/.workwire/config
```

The user unit `workwire-ww.service` uses this namespace. A command that silently
loads `~/.config/workwire/ww-config.json` is inspecting a different development
profile and is invalid fleet evidence.

## Autonomous state machine

Run `DISCOVER -> BUILD -> CONVERGE -> PROVE -> RELEASE -> COMMIT -> POWER_OFF`.
On any failed assertion, diagnose, repair, and resume at the earliest invalidated
state. A nonzero result is work to perform, not a reason to publish a partial
handoff.

### DISCOVER

1. Confirm the repository, branch, dirty state, and the current P1/P2/P3 final
   evidence without discarding any shared work.
2. Resolve HINOKI's live IPv4 address from the default-route interface.
3. Query the central controller and identify Sakura by stable agent ID and MAC
   `18:03:73:2e:3f:42`; use its reported address for file-service convergence.
4. Capture a redacted baseline:

```bash
node scripts/ww-fleet-doctor.mjs --managed --json \
  --expect-root-agent wwra_AQwelJu3cxhVk0h1GXvmbaCf \
  --expect-system-agent wwra_xCR5XgqeHAd2RkAzsp81bWPo
```

### BUILD

Finish all source and documentation edits first, then create the exact source
deployment archive and self-contained Windows agent bundle:

```bash
npm test
npm run dist:source
npm run recovery:agent-windows-bundle -- --download-node
```

`scripts/package-ww-source.mjs` emits `artifacts/ww-source.tar.gz` with a
manifest containing the canonical release and update hashes. Rebuild it after
every source edit. Transport pairing material as a protected token file, never
as a command-line value.

WW mirror conflict copies are recoverable convergence evidence, never runtime
inputs. Source archives, Electron packaging, Windows/Linux recovery staging,
and recovery-image staging must exclude both supported conflict basename forms.
The image verifier must enumerate the SquashFS and report
`conflictArtifacts: 0`. After the final runtime edit, rebuild and verify:

```bash
npm run recovery:image-build -- --reuse-rootfs
npm run recovery:image-verify
```

### CONVERGE

Use the online Sakura SYSTEM recovery agent to upload the source archive,
token file, Windows convergence script, and Windows recovery-agent bundle into
an explicit `%ProgramData%\WorkWire\staging` path. Parse the PowerShell script
with `System.Management.Automation.Language.Parser` before execution.

Run `scripts/converge-ww-windows.ps1` as SYSTEM with:

- the uploaded source archive and token-file paths;
- the central controller URL built from HINOKI's live address and port 4852;
- HINOKI's live file-service address, stable service ID, and source root;
- Sakura's expected service ID;
- an ISO-8601 UTC reference from HINOKI and `-RepairClock`.

The script atomically overlays only manifest files, moves release extras into a
recoverable backup, verifies both hashes, converges pairing, repairs the live
desktop junction/shortcuts, configures the external recovery controller, fixes
Windows UTC/time-zone state, installs a persistent one-minute service watchdog,
starts the file service, and consumes the uploaded token file.

Converge HINOKI with the same protected token file:

```bash
node scripts/converge-ww-peer.mjs \
  --config-dir /home/hinoki/WorkWire/.workwire/config \
  --portal /home/hinoki/WorkWire \
  --token-file /path/to/protected/pairing.token \
  --expect-service-id t8K6zAc6chbIa3srdlFEeQ \
  --service-name HINOKI --peer-label Sakura \
  --peer-host SAKURA_LIVE_IPV4 --peer-port 4851 \
  --peer-id RQn5hi_GTBHwvC6bQmmTYg \
  --peer-root 'C:\Users\Sakura\WorkWire' --consume-token-file
```

Update Sakura's installed recovery runtime with the uploaded bundle and
`scripts/install-ww-recovery-agent-windows.ps1`. The installer stages everything
before registering a separate `WorkWire Recovery Agent Update` SYSTEM task. That
task survives stopping the agent task that invoked it, performs the atomic swap,
rolls back and restarts the previous runtime on failure, and writes the redacted
postcondition to `%ProgramData%\WorkWire\last-recovery-agent-update.json`.
Completion means this result says `ok: true` and the same stable agent ID
reconnects online as SYSTEM. Backups remain recoverable under
`%ProgramData%\WorkWire`.

The Windows file service runs an independent companion watchdog. If the exact
`WorkWire Recovery Agent` task exists but its process is absent, the file plane
starts it. The recovery-agent task also has startup, restart-on-failure, and
one-minute repeated triggers. This cross-plane recovery is an acceptance gate:
stopping the agent task must cause the stable SYSTEM agent to return without a
human or machine reboot.

Before installing HINOKI's root agent, restore its stable ID to
`/etc/workwire/agent-id`, then run the Linux installer against
`http://127.0.0.1:4852`. Load sudo material only from the protected local
environment file and pass it on stdin; never echo it. The Linux installer fully
stages beside the live runtime, atomically activates it, restarts and verifies
the root unit, and restores the previous runtime if the postcondition fails.
Restart `workwire-ww.service` after source and pairing convergence.

### PROVE

All checks below are required live evidence, not documentation claims:

1. Run the fleet doctor on HINOKI and on Sakura. Every check must be true: exact
   source hashes, equal running versions, authenticated remote listing, pinned
   peer IDs, central controller, root agent online, and SYSTEM agent online.
2. From HINOKI, execute `whoami.exe` through Sakura's recovery agent and assert
   the normalized output is `nt authority\system`.
3. Through Sakura's SYSTEM agent, invoke Sakura's current WorkWire CLI against
   the central controller, execute `id -u` on HINOKI's agent, and assert `0`.
4. In a unique disposable `Portal/.ww-e2e-*` directory, exercise empty, binary,
   Unicode/nested, and large files in both directions. Verify SHA-256 identity,
   create/edit/rename/delete, mirror convergence, conflict preservation, and
   cleanup. Never use valuable paths. `npm run test:fleet-e2e` is the canonical
   deterministic implementation of this gate and emits a redacted JSON report.
   `npm run test:fleet-4g` additionally round-trips a sparse 4 GiB zero fixture
   HINOKI → Sakura → HINOKI, verifies SHA-256 and source deletion after each
   move, records per-direction throughput plus responsiveness/memory telemetry,
   and removes both fixture roots. `--one-way` exists only for targeted diagnosis;
   final fleet acceptance requires the default bidirectional run.
   The 16 MiB lane is intentionally a broad semantic workload: it covers many
   file types, CRUD, mirror generations, conflict preservation, authentication,
   and cleanup cheaply. It is not the heavy-load claim. The bidirectional 4 GiB
   lane is the heavy streaming/backpressure/responsiveness/RSS claim. Both are
   mandatory because neither substitutes for the other.
5. Round-trip a generated artifact through each recovery agent and verify exact
   SHA-256.
6. Exercise interactive session open/input/cwd/env/detach/reconnect/signal,
   target-local TCP tunnel, fleet command, and autonomous execution against safe
   fixtures. Capability reports must match observed platform tools.
   `npm run test:fleet-recovery` is the canonical physical implementation: it
   proves HINOKI root and Sakura SYSTEM identities, Linux PTY signal delivery,
   truthful Windows terminal mode, session-scoped binary I/O, detach/reconnect,
   a tunnel to Sakura's loopback file service, an all-at-once fleet command, and
   machine-verifiable autonomous proof graphs on both installed agents.
7. Run `npm run test:fleet-watchdogs` to inject recoverable faults into only
   Sakura's exact file-service and recovery-agent processes. Acceptance requires
   an observed file-service interruption followed by the same service ID and
   exact release, then a changed recovery-agent connection epoch with the same
   stable agent ID, SYSTEM identity, unchanged boot ID, and clean fault-fixture
   removal. The scheduled-task restart policy and independent cross-plane
   watchdogs are redundant; the physical gate proves the combined installed
   recovery contract while focused tests prove each watchdog implementation.
   Windows `bootId` comes from the kernel boot counter with CIM last-boot time
   fallback; an agent-only restart must preserve it, while a real reboot must
   change it.
8. Run `npm run test:fleet-windows` to stage only the disposable pure-JavaScript
   dependencies required by the test harness, execute every `test/*.test.mjs`
   file with the installed Windows Node runtime as SYSTEM, parse the native TAP
   summary, and remove the staged dependency/archive fixtures. This is the
   canonical native-Windows regression gate; a Linux-hosted test that merely
   selects `platform: win32` is not equivalent evidence.
9. Run focused cross-platform tests, the complete test suite, package checks,
   image verification, commander benchmark, secret scan, placeholder/stub scan,
   and repository diff audit. Repeat the exact P3 required command ten times;
   each run must have the same pass count and zero failures/skips. Extract the
   Linux archive/AppImage and audit both `app.asar` and
   `resources/recovery-runtime` for every required recovery module and all four
   optional lanes. Confirm no WW conflict basename shipped anywhere.

Record exact commands, versions, hashes, counts, and artifact locations in
`handoff/next-stage/results/fleet-final.md`. Redact secrets and do not label a
simulation as physical proof.

### 2026-07-19 proof baseline

This baseline is an index into canonical evidence, not a substitute for reruns
after source or installed-runtime changes:

- Broad physical file lane: 11/11 checks, 17,039,360 bytes per direction, exact
  bidirectional hashes and fixture cleanup (`fleet-e2e.json`).
- Heavy physical file lane: 4 GiB each direction, 8 GiB total, 108.15 and
  104.50 MiB/s, zero failures across 31 ping samples, 329.69 ms worst sampled
  response, 137,519,104-byte peak RSS, exact SHA-256 and cleanup
  (`fleet-4g-roundtrip.json`).
- Installed recovery lane: root on HINOKI, SYSTEM on Sakura, Linux PTY,
  truthful Windows PowerShell pipes, binary session I/O, detach/reconnect,
  target-local tunnel, simultaneous fleet run, and proof-bearing autonomy on
  both agents (`fleet-recovery-physical.json`).
- Watchdog fault injection: same Windows file-service ID/release returned after
  a real process kill; the same SYSTEM recovery-agent ID returned with a new
  connection epoch and unchanged OS boot ID (`fleet-watchdogs-physical.json`).
- Native Windows SYSTEM suite: 292 tests accounted, 281 passed, 11 intentional
  platform skips, zero failures/cancellations/todos, and staging cleanup
  (`fleet-windows-physical.json`).
- Linux suite: 292/292. P3 required stress: ten runs, 230/230. The clean recovery
  image verifier reported 31,771 SquashFS entries and zero conflict artifacts;
  the exact image then passed all eight disposable KVM stages at
  `artifacts/recovery-qemu/fleet-final-clean-image/summary.json`.

### RELEASE, COMMIT, AND POWER_OFF

Build the final Linux release only after the source stops changing. Re-run the
doctor after packaging. Commit the complete P1/P2/P3/fleet work, push the active
branch to its configured upstream, and verify the remote commit ID equals local
`HEAD`.

Then and only then schedule HINOKI's shutdown with a short delay so the final
result can be emitted. Never send S5 shutdown to Sakura. If any gate is not
green, do not power off either machine.

## Recovery rules

- All convergence is idempotent. Preserve or move replaced material into named
  backups; do not reset the repository or delete unknown user data.
- Retry controller calls interrupted by a planned service/recovery-agent restart
  only after checking live state. Never infer success from transport loss.
- Exact stable IDs, authenticated discovery, process privilege, hashes, and
  postconditions outrank hostnames, cached IPs, ping, task registration, or exit
  code alone.
- Preserve unknown conflict copies on disk unless their provenance and canonical
  merge are proved. Irrespective of retention, never commit, execute, stage, or
  ship a `WW conflict` basename. Packaging and image verification must enforce
  this independently of `.gitignore`.
- Destructive storage tests use generated files, sparse images, loop/QEMU disks,
  or an explicitly disposable device. Raw root/SYSTEM access remains available
  for caller-authorized hardware; the proof suite must not gamble with valuable
  disks.
