# NEXTTODO — make WW self-healing (for an autonomous agent)

## Context: what just broke and why (2026-07-20)

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

## Prior investigation already done (don't redo this)

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

## Work items, in priority order

### P0 — stop this exact failure from recurring silently

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

### P1 — the actual user-facing feature request: wake-on-hibernate popup

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

### P2 — general link robustness (nice-to-have, lower urgency)

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

## Do NOT do

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
