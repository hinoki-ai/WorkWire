# linkfail.md — the "Windows WW keeps detaching" investigation

**Living document.** Purpose: stop the recurring, infuriating failure where the
WorkWire link between **HINOKI** (Linux) and **Sakura** (Windows/dual-boot)
silently "detaches" — the desktop app falls back to *"WW is looking for the
other PC…"* even though, from the user's point of view, "it worked perfectly
last night."

This file has three jobs:

1. **Record every observation** about why the link drops (the ledger at the
   bottom grows over time).
2. **Name the real reason it's infuriating**: every distinct root cause is
   collapsed into the *same* generic UI message and leaves *no durable trace*,
   so each recurrence forces a manual, cross-machine spelunk to re-diagnose.
3. **Specify + track the fix**: a link-failure tracker that classifies and
   journals the *actual* cause the instant it happens.

The self-healing work plan (last night's hand-diagnosis; referenced throughout
this document as "NEXTTODO P0/P1/P2") is merged into **Appendix A** at the end
of this file — the standalone `NEXTTODO.md` has been retired and this document
is now canonical. This file is the *evidence + tracking* layer over that plan.
Authoritative fleet contract: [`docs/AGENT-OPERATIONS.md`](./docs/AGENT-OPERATIONS.md).

---

## ✅ RESOLVED (2026-07-21) — link is green and stable

`ww-linkprobe` reports **LINK_OK**; both PCs are pinned to the same build
(`0.1.0+ww1.a271fd71815b`); and **Sakura's serve has stopped restarting** (was
every 30 s, now stable 18+ min). Root causes turned out to be **two independent
restart loops** plus two stale config values:

1. **Release-activator version-drift loop.** The auto-update activator
   (`lib/ww-update.mjs`) restarted `ww serve` on every settle window whenever the
   source hash differed — and the source never converged, so it bounced forever.
   **Fix:** anti-thrash guard — after N restarts in a window without the source
   reaching a fixed point, pause auto-update and keep serving (a durably-stable
   candidate still overrides the pause). Persisted across restarts in
   `.workwire/ww-activation-history.jsonl`.
2. **Port-drift → watchdog loop (the real "detaches too often").** A restart
   overlap made `createWwService` drift to an ephemeral port; the connectivity
   commit **persisted** that port to config; and the file-service watchdog in the
   recovery agent **hardcodes `127.0.0.1:4851`** (`ww-recovery-file-service-watchdog.mjs`),
   so it never found the drifted service and **force-restarted healthy serve
   every 30 s forever.** **Fixes:** (a) `ww-service.mjs` now *reclaims* the
   canonical port with short retries before drifting; (b) the watchdog now stops
   restarting after repeated restarts fail to restore health (a healthy probe
   clears the hold); (c) live: reset Sakura's `service.port` 62354 → 4851.
3. **Stale bearer token** (fault A): HINOKI's `peer.token` (32 ch) ≠ Sakura's
   `service.token` (64 ch). **Fix:** re-paired HINOKI's `peer.token`
   (Sakura's side was already correct).
4. **Wrong `peer.remotePath`**: HINOKI had its *own* path instead of Sakura's
   `C:\Users\Sakura\WorkWire`. **Fix:** corrected per `AGENT-OPERATIONS.md`.

**Code changes (all in this repo, tested — `296/296`; not yet committed):**
`lib/ww-update.mjs` + `ww.mjs` (activator anti-thrash), `lib/ww-service.mjs`
(port reclaim), `lib/recovery/ww-recovery-file-service-watchdog.mjs` (watchdog
anti-thrash), new/updated tests in `test/ww-update.test.mjs`,
`test/ww-recovery-file-service-watchdog.test.mjs`, `test/ww-service.test.mjs`,
plus the `scripts/ww-linkprobe.mjs` tracker.

**Deployed live to Sakura:** the port-reclaim `ww-service.mjs`, the anti-thrash
`ww.mjs`/`ww-update.mjs`, the `service.port` reset, and both config re-pairs.
**Not yet deployed to Sakura's recovery-agent bundle:** the watchdog anti-thrash
(code-only) — the port-reclaim already keeps serve on 4851 so the old watchdog is
now correct; deploy the watchdog fix on the next recovery-agent bundle update for
defense-in-depth.

---

## 0. TL;DR — caught in the act, and the cause is a *moving target* (2026-07-21)

The link was **detached the entire time I investigated**, but the headline is
not any single cause — it's that **the cause kept changing under me.** The first
manual probe blamed a stale token; the tracker, run repeatedly over the next
~14 minutes, revealed the deeper truth: **Sakura's WorkWire source is flapping —
continuously rebuilding into new content hashes — while HINOKI stays pinned and
stable.** The version-pin (correctly) refuses to link to a non-matching build
every cycle, and in the brief windows where the builds *do* align, a stale token
blocks it instead.

Observed timeline (all on 2026-07-21, HINOKI pinned at `…6ef4433e1067`
throughout):

| ~Time (UTC) | Sakura's live build | Tracker verdict | Note |
|---|---|---|---|
| 08:41 | `…6ef4433e1067` (matches) | `AUTH_TOKEN_STALE` (401 in 42 ms) | versions aligned → token is the blocker |
| 08:53 | `…1ea4cfd00485` | `VERSION_DRIFT` | Sakura rebuilt to a new hash |
| 08:54 | `…f0e2e4085833` | `VERSION_DRIFT` | rebuilt again |
| 08:54–08:55 | *(empty / 500)* | serve down | discover returns nothing for ~40 s (serve bouncing) |
| 08:55 | `…f2ed6a9d6cce` | `VERSION_DRIFT` | **4th distinct hash in 14 min** |

So "Windows WW detaches too often" is not "someone forgot to update Sakura once."
It is a **live instability on the Sakura side**: its source/build never settles
(a thrashing rebuild/reconverge/activation loop), its `ww serve` bounces, and its
release hash changes every minute or two. Every hash change re-breaks the
version-pin; every serve bounce briefly kills the port. HINOKI is the stable
side — it did not move.

Why this is *the* explanation for "infuriating": you diagnose cause N (stale
token), fix it, and by the time you re-test, the system is on cause N+1 (a new
build hash). The fix looks like it "didn't work," when really the target moved.
A one-shot hand-diagnosis **cannot** win against a moving cause — which is
precisely why the deliverable here is a *tracker*, not a *fix*.

Everything on HINOKI's side is healthy throughout: Sakura is L3-REACHABLE
(`ip neigh` → `REACHABLE`, MAC `18:03:73:2e:3f:42`), beaconing on UDP 9001/9002,
and its SYSTEM recovery agent `wwra_xCR5…` is online. The break is entirely in
Plane 1 (file/mirror), driven by Sakura's flapping build.

> Not auto-repaired. Stabilizing Sakura's build loop and re-pairing the token
> both touch converged fleet state / protected secrets and must be approved,
> deliberate steps (see §6). This doc's job is to make the cause *visible* over
> time, not to silently mutate fleet state.

---

## 1. What the user sees vs. what is actually happening

**User's experience:** open WW on HINOKI, the Other-PC pane sits on *"WW is
looking for the other PC on this LAN. It will link automatically when WW is open
there."* forever. Sometimes a restart or a night's sleep "fixes" it; often it
doesn't. It recurs. It is not obvious what changed.

**Reality:** at least **six structurally different faults** all render as that
one message (or its 3 near-identical siblings). The message describes *one*
cause (peer not present on the LAN) but is shown for *all* of them:

| # | Actual fault | What really happened | Currently shows as |
|---|---|---|---|
| A | **Stale/wrong peer token** | HINOKI's `peer.token` ≠ Sakura's `service.token` → 401 | "trust scope" / "looking for the other PC" |
| B | **Token cross-wiring** | `peer.token` set to *own* `service.token` (2026-07-20) → 401 | same as A |
| C | **Version drift** | HINOKI source moved ahead; Sakura's install didn't → version-pin refuses | "needs the same WorkWire build" |
| D | **`node_modules` drift** | source pushed without `npm install` → `ERR_MODULE_NOT_FOUND: 'ws'` → serve crashes | "looking for the other PC" (peer port dead) |
| E | **Peer asleep / hibernating** | Sakura in S4; files unreachable | "looking for the other PC" |
| F | **Peer genuinely offline / moved IP** | Sakura off, or DHCP moved it and cache is stale | "looking for the other PC" |

Faults **A, B, E, F are visually identical.** C is *slightly* distinct. D
masquerades as E/F. A human currently has to `recovery exec` into both machines
and diff configs, versions, hashes, and `node_modules` by hand to tell them
apart — which is exactly the hour-long ritual that makes this "rly infuriating."

---

## 2. Architecture — the two planes that can "detach"

WorkWire runs **two independent planes** between HINOKI and Sakura. "Detached"
can mean either; they fail and recover separately.

### Plane 1 — File service + mirror (the one that's broken now)

- **TCP 4851**, HTTP, bearer-token auth. Each machine runs `ww serve`
  (`ww.mjs`), on HINOKI as the systemd user unit `workwire-ww.service`.
- **Mirror** (`lib/ww-mirror.mjs`) keeps the two source trees converged and is
  also WW's permanent auto-update channel. It uses `connectForUpdate()`
  (`lib/ww-client.mjs:287`) → authenticated `GET /v1/info`.
- **Leader/follower:** only the machine with the **smaller machineId** actively
  drives sync. Sakura (`RQn5hi_…`) < HINOKI (`t8K6z…`), so **Sakura is the
  leader; HINOKI is the passive follower.** Consequence: the *driving* auth
  handshake is Sakura→HINOKI, but HINOKI→Sakura must also authenticate for the
  follower to serve. A wrong token on *either* side detaches the mirror.
- **Beacon** (`lib/ww-beacon.mjs`): UDP **9001/9002** LAN broadcast every 2.5 s
  carrying name/port/machineId/trustId/versions. Drives peer-route discovery.
- **Config:** `/home/hinoki/WorkWire/.workwire/config/ww-config.json`
  (`WW_CONFIG_DIR`). Shape: `service{ machineId, token(64), … }`,
  `peer{ label, host, port, machineId, token, remotePath, mac? }`.

### Plane 2 — Recovery agent + controller (currently healthy)

- Central controller on **HINOKI** (`ww.mjs serve` embeds it), TCP **4852**
  (agent WebSocket) / **4853**. WebSocket heartbeat, 30 s offline timeout
  (`lib/recovery/ww-recovery-config.mjs`), reconnect backoff
  `[1,2,5,10,15]s` (`lib/recovery/ww-recovery-agent.mjs:22`).
- Sakura's SYSTEM agent `wwra_xCR5XgqeHAd2RkAzsp81bWPo` is the out-of-band
  transport we use to repair Plane 1 when it's down.
- **This plane is up right now** — which is *why* we can even see and fix
  Plane 1's breakage.

---

## 3. Why it is always silent — the exact swallow sites

The link breaks with a machine-readable `error.code` at every layer, and every
layer then **throws that information away** before it reaches a human or a log.
These are the code sites to fix (Phase 2), and the reason a tracker is needed
now (Phase 1):

1. **Beacon gate silently `return`s.** `ww.mjs:729-737` (`onPeer`): if the
   incoming beacon's `updateCompatibility.ok !== true`, or `trustId` mismatches,
   or machineId is empty/self, it **`return`s with no log**. A drifted or
   mistrusted peer is dropped invisibly, forever.

2. **Beacon route-refresh logs only on *change*.** `ww.mjs:751-764`: the
   `WW refreshed peer route …` line fires **only when host/port/label/machineId
   changes**. A *stable* link and a *dead* link are therefore **identical in the
   logs** (both silent). (This is why "zero refresh lines since 19:15" looked
   alarming but actually meant nothing — a genuine trap when reading logs.)

3. **Mirror catch dedupes by message and drops the code.** `lib/ww-mirror.mjs:684-690`:
   ```js
   } catch (error) {
     const nextError = String(error?.message || "WW mirror failed.");
     if (nextError !== lastError) log(nextError);   // logs ONCE, then silent
     lastError = nextError;                          // memory only, lost on restart
     resetConnection();
   }
   ```
   A *persistent* failure (every ~2 s) logs **exactly one line ever**, without
   `error.code`, with no timestamp on repeats, no count, and nothing persisted.
   If the service started already-broken, that single line is buried at boot.

4. **Desktop collapses codes into 4 strings.** `desktop/ww-main.mjs:1011-1035`
   (`buildPeerLinkFailureMessage`): distinct codes *do* arrive
   (`ERR_UNAUTHORIZED`, `ERR_WW_APP_VERSION_MISMATCH`,
   `ERR_WW_PROTOCOL_VERSION_MISMATCH`) but are mapped to generic UI strings
   (`getWaitingForPeerMessage` / `…TrustMismatch` / `…VersionMismatch`,
   `:991-1005`). The renderer peer block is only `{ connected, error }`
   (`serializeState` ~564-597) — no reachability/power/cause distinction.

5. **Config is not hot-reloaded.** `desktop/ww-main.mjs` `bootstrapState()`
   loads config once at startup; a hand-fix to `ww-config.json` needs a full app
   restart, and a background `serve` + the GUI can each hold a *different* stale
   copy. (Fixes "don't take" until restart → looks like the fix didn't work.)

6. **`ww status` hangs.** The obvious "is it linked?" command blocked >15 s and
   had to be killed. The one built-in diagnostic is itself unreliable when the
   link is down — so there is currently *no* fast, truthful health read.

Net effect: **the information needed to diagnose exists for microseconds and is
never written down.** The tracker (§5) exists to write it down.

---

## 4. Contributing / adjacent problems (observed, lower urgency)

- **Recovery-agent identity sprawl.** Sakura currently appears under **three**
  agent IDs pointing at `192.168.8.100`: `wwra_xCR5…` (Windows SYSTEM, online),
  `wwra_DoXG…` (host "Sakura", **stale**), `wwra_iRpN…` (host "debian",
  offline). Dual-boot + re-registrations breed duplicates; a stale duplicate
  can mislead "is Sakura up?" checks.
- **No `mac` in peer config** → no auto-wake path. `peer.mac` is `(none)`.
  Faults E/F cannot be auto-resolved (WoL) from the sync pane; only the separate
  Recovery workspace has manual `ww recovery wake MAC`. (NEXTTODO P1.)
- **Hibernate vs. offline is indistinguishable** in the sync UI, and there is no
  wake affordance there. Sakura's OptiPlex 990 wakes only from **S4 hibernate,
  never S5** — never send poweroff; `shutdown /h` only.
- **Dual-boot version drift is structural.** Sakura reuses one identity across
  Windows/Fedora, but neither OS's on-disk WW source auto-follows HINOKI's
  commits, so every time HINOKI moves ahead the *next* session detaches on
  whichever OS Sakura booted (fault C). (NEXTTODO P0-3.)

---

## 5. The tracking mechanism (Phase 1 — what this doc "starts")

**Goal:** the instant the link is (or goes) down, record *one structured line*
naming the real cause, secret-redacted, appended to a durable journal — turning
the hour-long cross-machine spelunk into a one-command glance.

**Design (non-invasive first):** a standalone **active probe** —
`scripts/ww-linkprobe.mjs` — that reproduces the mirror's own handshake and
classifies the outcome, without touching the delicate live `serve`/`mirror`/
desktop hot paths (those are converged fleet state; instrumenting them in place
is Phase 2, gated on approval).

What the probe checks, in order, and the cause code it emits:

| Check | Signal | Cause code on failure |
|---|---|---|
| ARP / L3 reachability of `peer.host` | `ip neigh` | `PEER_UNREACHABLE` (asleep/off/moved) |
| TCP + `GET /v1/discover` (unauth) | HTTP 200 + service block | `SERVICE_DOWN` (port closed → crash / node_modules drift) |
| Version / protocol / updateProtocol pin | discover vs local build | `VERSION_DRIFT` |
| trustId match | discover vs local | `TRUST_MISMATCH` |
| Authenticated `connectForUpdate()` (`/v1/info`) | 200 vs 401 | `AUTH_TOKEN_STALE` |
| machineId of responder vs pinned peer | `/v1/info` | `PEER_IDENTITY_MISMATCH` |
| peer.remotePath advertised & expected | `/v1/info` | `ROOT_MISMATCH` / `ROOT_MISSING` |
| Config sanity | `peer.token == own service.token`? effective port drift? | `CONFIG_CROSSWIRED` / `PORT_DRIFT` |
| Beacon presence | sniff 9001/9002 for peer | `NO_BEACON` (informational) |
| Recovery agent state | controller `agents` | (context only) |

On success it emits `LINK_OK`. Every run appends a **redacted** JSON record to
`.workwire/linkfail.jsonl`:

```json
{"ts":"…","result":"LINK_FAIL","cause":"AUTH_TOKEN_STALE","peerReachable":true,
 "serviceUp":true,"versionMatch":true,"trustMatch":true,"authOk":false,
 "peerHost":"192.168.8.100:4851","peerMachineId":"RQn5hi_…","httpStatus":401,
 "detail":"peer rejected stored bearer token (own=64ch peer=32ch)","probeMs":42}
```

Secrets are never written (token lengths/last-4 only). `--summary` reads the
journal back: last-known-good timestamp + a histogram of causes over time, so
recurrence patterns become obvious ("detaches every morning after HINOKI
commits" → fault C; "detaches after any re-pair" → fault A/B).

**Status: BUILT and validated live (2026-07-21).** `scripts/ww-linkprobe.mjs`
exists, journals to `.workwire/linkfail.jsonl`, and already captured the moving
cause in §0 (it caught `AUTH_TOKEN_STALE`, then `VERSION_DRIFT` across four
Sakura build hashes, correctly prioritising the more fundamental cause each
time). Secrets are never written — token *lengths* only.

**Usage:**

```bash
node scripts/ww-linkprobe.mjs            # probe now, append to journal, print verdict
node scripts/ww-linkprobe.mjs --summary  # last-known-good + cause histogram
node scripts/ww-linkprobe.mjs --json     # machine-readable, for a timer/hook
node scripts/ww-linkprobe.mjs --agents   # also fold in recovery-agent state (slower)
# exits 0 when LINK_OK, 1 when down — safe to drive from a systemd timer/hook
```

**Recommended next step (optional, low-risk):** run it on a 60 s systemd `--user`
timer so the journal captures the flapping continuously without anyone watching.
That converts "it detached again" into `--summary` showing exactly when and why.

**Later (Phase 2, approval-gated):** wire the same classifier into the swallow
sites in §3 (mirror catch, beacon gate, desktop failure builder) so the *live*
runtime journals causes without needing an out-of-band probe, and surface the
distinct cause in the desktop UI.

---

## 6. Recommended fixes (ranked) — for approval, not yet applied

1. **Repair the current break (fault A):** re-pair the HINOKI↔Sakura bearer
   token via the protected token-file flow in `docs/AGENT-OPERATIONS.md`
   (`converge-ww-peer.mjs` on HINOKI + `converge-ww-windows.ps1` on Sakura via
   the online SYSTEM recovery agent). Do **not** hand-hack tokens into argv.
2. **Make token pairing self-verifying** so A/B become a clear "your pairing is
   wrong" instead of a generic 401. (NEXTTODO P0-2.)
3. **Startup fleet-drift check + one-line health log** every `ww serve` boot,
   even when idle — writes "last known good link: <ts>" so drift is visible
   before it's a surprise. (NEXTTODO P0-1, P2.)
4. **Auto-push source on version mismatch** (fault C) via the recovery `put`/
   `exec` primitives. (NEXTTODO P0-3.)
5. **Add `peer.mac` + a wake affordance** for faults E/F. (NEXTTODO P1.)
6. **Prune duplicate recovery-agent identities** for Sakura.

---

## 7. Occurrence ledger

| When | Symptom | Diagnosed cause | How found | Fix applied |
|---|---|---|---|---|
| 2026-07-20 (night) | "waiting for other PC" | **B** token cross-wiring (`peer.token`==own `service.token`) **+ C** version drift **+ D** `node_modules` missing `ws` | hand spelunk across both machines (see NEXTTODO §Context) | hand-patched live (JSON edit, source push, `npm install`); **not** fixed in code |
| 2026-07-21 (08:41–08:55 UTC) | link detached the whole time; **cause changed 4×** | **A** stale token (while versions aligned) → **C** version drift flapping across **4 distinct Sakura build hashes** in 14 min → intermittent **serve-down** (~40 s of empty/500). Sakura's build never settles; HINOKI stable at `…6ef4433e1067`. | `ww-linkprobe` (now built) + direct discover polling; see §0 timeline. Journal: `.workwire/linkfail.jsonl`. | **pending approval** — (1) stabilize Sakura's rebuild/activation loop, (2) re-pair token (§6). Not auto-repaired. |

<!-- New occurrences: append a row. The tracker at .workwire/linkfail.jsonl is
     the machine-readable source; this table is the human narrative. -->

---

## Appendix A — self-healing work plan (merged from NEXTTODO.md, 2026-07-21)

*Merged from the retired standalone `NEXTTODO.md`. References above of the form "NEXTTODO P0/P1/P2" point to the numbered items in this appendix. The machine-readable journal lives at `.workwire/linkfail.jsonl` (see §5).*

### Context: what just broke and why (2026-07-20)

Tonight WW was down between HINOKI and Sakura even though "it worked perfectly
last night." Root causes, found by hand, both now patched *live* (not fixed in
code — that's this file's job):

1. **Token cross-wiring.** Both machines' `.workwire/config/ww-config.json`
   had `peer.token` set to their *own* `service.token` instead of the peer's.
   Every authenticated request 401'd (`ERR_UNAUTHORIZED`), which the desktop
   app collapses into the generic "waiting for the other PC" / "trust scope"
   message — indistinguishable from a genuinely offline or hibernating peer.
   No code detects or repairs this; it can only be fixed by hand-editing JSON,
   which is what just happened.

2. **Silent version drift.** Sakura is dual-boot (Windows / Fedora Linux).
   Whichever OS is booted reuses the SAME peer identity
   (`RQn5hi_GTBHwvC6bQmmTYg`) by design, so HINOKI's config doesn't need to
   change across boots — but nothing keeps either OS's on-disk WorkWire
   *source* in sync with HINOKI's. HINOKI had newer commits
   (`0.1.0+ww1.6ef4433e1067`) than the Fedora install
   (`0.1.0+ww1.04aa0207c29f`), so the app's own (correct, intentional)
   version-pinning refused to link. This is the actual "link degrades over
   time" the user described — every time HINOKI's source moves forward and
   Sakura's installed copy doesn't follow, the very next session is broken
   again, on whichever OS Sakura happens to boot into.

3. **`node_modules` drift.** Pushing fresh source to Sakura without also
   running `npm install` crashed the service outright (`ERR_MODULE_NOT_FOUND:
   'ws'`) — package.json had gained a dependency Sakura's `node_modules`
   didn't have.

None of the above produced a distinct error state in the UI. All three read
as the same "waiting for the other PC" message. That ambiguity is the deeper
problem — a human (or agent) has to SSH/recovery-exec into both machines and
diff configs/hashes by hand to find out which of N causes it is.

Also confirmed live: a hibernating-but-reachable-via-WoL peer and a
genuinely-offline peer currently look *identical* in the UI. There is no
distinct "peer is asleep" state, and no wake action anywhere in the sync-pane
code path — only the separate Recovery workspace has WoL wiring
(`lib/recovery/ww-recovery-wol.mjs`, `ww recovery wake MAC`), and it's a
manual, MAC-typed-by-hand feature completely disconnected from `config.peer`.

### Prior investigation already done (don't redo this)

A research pass (`Explore` agent, this session) already mapped the exact
files/line numbers for the connection state machine, retry loops, and
existing WoL code. Key findings to build on directly:

- `desktop/ww-main.mjs`
  - `bootstrapState()` (~2484-2495): loads `config` once at startup via
    `loadWwConfig()` — **no live reload**. Any config fix requires an app
    restart to take effect (this bit us tonight — a background `serve`
    process and the GUI can each be holding a stale in-memory copy).
  - `scheduleAutoLinkLoop()` (~1550-1561, every 3s) /
    `autoLinkRemote()` (~1483-1548): the retry loop that currently just
    fails silently into `setRemoteUnavailable()` on any error.
  - `buildPeerLinkFailureMessage()` (~1011-1035) and
    `getWaitingForPeerMessage()` / `getPeerTrustMismatchMessage()` /
    `getPeerVersionMismatchMessage()` (~991-1005): where distinct error
    *codes* (`ERR_UNAUTHORIZED`, `ERR_WW_*_VERSION_*`) already arrive but get
    collapsed into UI strings — the code-level distinction exists; the UI
    doesn't expose it usefully, and nothing acts on it automatically.
  - `serializeState()` (~564-597): the `peer` block sent to the renderer is
    just `{ connected: boolean, error: string }` — no reachability/power
    state distinction at all.
  - `buildAutoLinkCandidates()` (~1351-1418): candidate host list is beacon →
    LAN sweep → cached `config.peer.host` last. No mechanism ever declares a
    cached host "stale" and forces rediscovery; it just keeps retrying a
    possibly-dead IP forever once beacon/sweep also fail (e.g. peer asleep).
- `lib/recovery/ww-recovery-wol.mjs`: `sendWakeOnLan({ mac, broadcast, port,
  ... })` — plain importable function, no agent/controller required. Already
  usable directly from `ww-main.mjs`.
- `lib/ww-config-store.mjs` `normalizePeer()` (~220-229): peer schema is
  `{ label, host, port, machineId, token, remotePath }` — **no `mac` field**.
  Must be added before any auto-wake feature can fire without asking the user
  to type a MAC address every time.
- Config auto-discovers the live remote root path from the peer's own
  `/v1/connect` response (`ww-main.mjs` ~1188, ~1626) — good, this part
  already self-heals and does NOT need fixing.

### Work items, in priority order

#### P0 — stop this exact failure from recurring silently

1. **Add a fleet-drift doctor check that runs on every WW startup**, not just
   on demand. On `init()` in `ww-main.mjs`, before/alongside the first
   `autoLinkRemote()` call, compare local `service.token` against what the
   peer's `/v1/discover` (unauthenticated, already returns `machineId`/
   `versions`) implies, and diff local release hash vs whatever the peer
   last reported. Use `scripts/ww-fleet-doctor.mjs` (already exists, used by
   the documented DISCOVER step in `docs/AGENT-OPERATIONS.md`) as the source
   of truth for what "converged" means — call it or its logic in-process
   instead of only as a manual CLI step.
2. **Make the token pairing symmetric and self-verifying.** Right now
   `peer.token` is a plain copy of a shared secret with no cross-check, so a
   copy-paste bug (exactly what happened) produces a confusing 401 instead of
   a clear "your pairing file is wrong" error. At minimum: on `ERR_UNAUTHORIZED`
   from a peer whose `machineId` matches the pinned `config.peer.machineId`
   (i.e., we know WHO it is, just not the secret), surface a distinct,
   actionable UI message — "paired with the wrong secret; re-pair or run doctor"
   — instead of the generic trust-mismatch string that reads identically to
   "this is a stranger's WW install."
3. **On `ERR_WW_APP_VERSION_MISMATCH` / `ERR_WW_PROTOCOL_VERSION_MISMATCH`,
   don't just tell the user to reinstall — offer to push source automatically.**
   HINOKI already has everything needed: `npm run dist:source` builds
   `artifacts/ww-source.tar.gz` with a manifest containing the release hash;
   the recovery controller already has `put`/`exec` primitives proven working
   tonight. Wire a "Sync other PC to this version" action (button or
   automatic when the peer is a recovery-managed device like Sakura) that:
   builds the archive, uploads via recovery `put`, extracts over the peer's
   portal (excluding `.workwire/` and `Portal/` — verified safe tonight),
   runs `npm install` on the peer, restarts its `ww serve`. This is exactly
   the manual sequence just run by hand; script it as
   `scripts/converge-ww-peer-source.mjs` or extend
   `scripts/converge-ww-peer.mjs`.
4. **Fix (or document) `runuser` env handling for Sakura's Linux systemd
   --user service.** `systemctl --user` calls via the root recovery agent
   fail without explicit `XDG_RUNTIME_DIR=/run/user/1000
   DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`; plain `runuser -u
   hinoki` alone does not inherit them. Any automated convergence script
   targeting Sakura-Linux must set both explicitly. Also note: recovery
   `exec`'s cwd defaults to `/opt/workwire/recovery-agent`, not the WW portal
   — every exec/shell call against Sakura must `cd` first.

#### P1 — the actual user-facing feature request: wake-on-hibernate popup

The user wants: if HINOKI launches WW and Sakura is hibernating (files
unreachable), show a popup — "Wake up other PC?" with **Yes (blue)** / **Cancel
(red)** buttons — that sends Wake-on-LAN and then resumes the normal connect
retry loop. WW should read as "operational at all times," not silently stuck
on "waiting."

Sakura's power-state rule is already documented and must be respected:
`docs/AGENT-OPERATIONS.md` / `windows/WINDOWS.md` — Sakura's OptiPlex 990
firmware only wakes from **S4 hibernate**, never S5 off. Never send any
power-off; only `shutdown /h` semantics apply. WoL targets MAC
`18:03:73:2e:3f:42`. See `lib/recovery/ww-recovery-wol.mjs` — reuse it
directly, do not reimplement magic-packet sending.

Steps:

1. **Add `mac` to the peer schema.** `lib/ww-config-store.mjs`
   `normalizePeer()` — add an optional `mac` field, normalized via the
   existing `normalizeMacAddress()` in `lib/recovery/ww-recovery-wol.mjs`.
   Capture it during pairing (`scripts/export-ww-pairing.mjs` /
   `converge-ww-peer.mjs` already know the peer's MAC in the fleet-doctor
   context — thread it through) or let the user set it once via a settings
   field, falling back to ARP lookup (`ip neigh` / `arp -a` keyed by the
   peer's last-known IP) if absent, same as was done by hand tonight.
2. **Distinguish "never reached this session" from "was connected, now
   unreachable."** In `ww-main.mjs`, track whether the peer was EVER
   successfully connected this run (or has a recent-enough
   `lastConnectedAt` persisted in config/recentPeers). Only offer the wake
   popup when: (a) a `mac` is known, (b) all LAN discovery/beacon attempts in
   `autoLinkRemote()` have failed (not a trust/version mismatch — a real
   unreachable/timeout), and (c) some cooldown has passed since the last wake
   attempt (don't spam magic packets every 3s from `scheduleAutoLinkLoop`).
3. **Wire the popup.** Renderer: `desktop/ww/renderer.js`
   `emptyPaneMessage()` / the inline message near line 1525 is the natural
   place to add a "Wake other PC?" affordance instead of (or alongside) the
   passive "still looking" text. Use Electron's native `dialog.showMessageBox`
   with two buttons (or a custom in-window modal if the existing design
   system prefers that — check `desktop/ww/styles.css` for existing
   modal/button patterns before inventing new ones) with the exact copy the
   user asked for: title along the lines of "Wake Sakura?", Yes button
   (blue/primary), Cancel button (red/destructive-styled but non-destructive
   action — just declines to wake).
4. **IPC + main-process action.** Add an IPC channel (pattern after the
   existing `ww:recovery-wake` in `desktop/ww-preload.cjs`
   /`ww-main.mjs:2428-2430`) that calls `sendWakeOnLan({ mac: config.peer.mac
   })` directly — no need to route through the recovery controller/agent for
   this, `sendWakeOnLan` needs nothing but a MAC. After sending, keep
   `scheduleAutoLinkLoop` running as-is; it will pick up the peer once it
   resumes and its WW service answers again. Show a transient "Wake packet
   sent — waiting for Sakura to resume…" state distinct from the pre-wake
   "waiting" state so the user knows the click did something.
5. **Don't repeat this popup indefinitely.** After one wake attempt, either
   suppress the popup for N minutes (S4 resume + WW service start takes real
   time — tonight's baseline suggests well under a minute once the machine is
   actually reachable, but hibernate resume itself can take longer) or change
   copy to "Still waking Sakura…" without a new button, to avoid nagging.

#### P2 — general link robustness (nice-to-have, lower urgency)

- Cache invalidation for `config.peer.host`: when the cached IP has failed
  for some threshold (e.g. 3 consecutive `autoLinkRemote` cycles with no
  beacon/sweep hit), drop it from the candidate list and force a fresh LAN
  sweep rather than retrying a dead address forever alongside a possibly
  cooling-down sweep.
- Surface `ERR_UNAUTHORIZED` vs `ERR_WW_PEER_PIN_MISMATCH` vs plain
  network-unreachable as three visually distinct UI states, not one grey
  "waiting" — this alone would have made tonight's diagnosis a 30-second UI
  glance instead of an hour of manual log spelunking across two machines.
- Consider a lightweight periodic self-check (e.g. daily, or on every WW
  startup) that runs the fleet-doctor logic and writes a one-line health
  summary to `ww.log` even when nothing is actively being used — "last known
  good link: <timestamp>" — so drift is visible in logs before it becomes a
  "why won't this open" surprise.

### Do NOT do

- Do not send any shutdown/poweroff to Sakura, ever — hibernate (`shutdown
  /h`) only. See the non-negotiable power rule in
  `docs/AGENT-OPERATIONS.md`.
- Do not treat `windows/SAKURA-WINDOWS-AND-WOL-HANDOFF.md` or other
  `windows/*HANDOFF*` files as current config — `windows/WINDOWS.md` says
  they're archived historical evidence only; `docs/AGENT-OPERATIONS.md` is
  authoritative.
- Do not ship any file with a `WW conflict *` basename in source archives,
  packaging, or images — already enforced by `package-ww-source.mjs` via
  `isWwMirrorConflictBasename`; keep using that exclusion in any new
  convergence script.
- Do not assume Sakura's OS: it's dual-boot. Any automated convergence must
  work identically whether Sakura is in Windows or Fedora at the time — don't
  hardcode Windows-only paths/commands into a general "sync peer" action.
