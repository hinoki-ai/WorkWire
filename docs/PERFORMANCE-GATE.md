# WorkWire performance hardening gate

Status: complete — qualified pass  
Started: 2026-07-17T02:14:42-04:00  
Completed: 2026-07-17  
Scope: the implementation present before Phase 0 of `RECOVERY-PORTAL-TODO.md`

This is the engineering work log and final evidence report for the blocking
performance gate. Recovery Phase 0 must not begin until this document records a
supported gate classification.

## Executive benchmark scorecard

The implemented WorkWire Files path passed this gate. No critical or
high-severity performance defect remains confirmed in that scope. Recovery
Phase 0 has deliberately not been started.

| Area | Untouched baseline | Final measured result | Outcome |
| --- | ---: | ---: | --- |
| Pure 10,000-entry search, five-query CPU per repetition | 941.62 ms user CPU | 53.17 ms | **94.4% less CPU** |
| Real Electron 10,000-entry search | No browser baseline harness | worst median 19.5 ms; worst p95 19.58 ms | Below 50/100 ms budgets |
| Real Electron 10,000-entry rapid edit sequence | No browser baseline harness | median 12.8 ms; p95 20.36 ms | Budget met; isolated 52/61 ms outliers |
| ext4 listing, 50,000 entries | 4,452.12 ms median | 1,410.78 ms median | **68.3% faster** |
| listing event-loop delay, 50,000 entries | 2,717.91 ms max | 42.34 ms max | **98.4% lower** |
| 384 MiB local transfer | 817.52 MiB/s median | 1,721.29 MiB/s median | **110.6% faster** |
| 384 MiB loopback upload | 221.50 MiB/s median; 524.1 MiB peak RSS | 504.40 MiB/s; 138.3 MiB peak RSS | **127.7% faster; 73.6% less peak RSS** |
| 384 MiB loopback download | 229.44 MiB/s median; 415.9 MiB peak RSS | 429.92 MiB/s; 141.2 MiB peak RSS | **87.4% faster; 66.1% less peak RSS** |
| Four concurrent 100 MiB uploads | Not present | 533.30 MiB/s aggregate; 152.0 MiB peak RSS | Hash-exact; zero control failures |
| High-frequency renderer IPC payload | 17,997,086-byte full state | 277-byte incremental event | **64,971x smaller** |
| Active service lifecycle soak | Not present | 60.07 s; 21,438 cycles; 2.248 GB streamed | Heap plateau; handles and FDs restored |
| Full test suite | 110 passed | 127 passed | 0 failed/skipped/cancelled |
| Linux distribution build | Passed | Passed | AppImage and tar artifacts produced |

The classification is qualified, rather than unconditional, because hidden
Electron profiling is not a substitute for every compositor/GPU combination,
`perf`, `pidstat`, and `iostat` were unavailable, and recovery-only controller,
agent, event-store, SSE, inventory, command-output, and resumable-artifact
components do not exist before Phase 0. Those components are marked not
applicable, never represented by mocks or fabricated results.

## Preserved baseline

The recovery implementation phases have not begun. All Phase 0 checkboxes in
`docs/RECOVERY-PORTAL-TODO.md` were unchecked at gate start, and no
`lib/recovery` directory existed. The implemented scope is the current WorkWire
Files workspace, Electron main/renderer bridge, HTTP file service, local and
remote browsing, search, transfer engine, mirror, installation, and lifecycle
behavior. Recovery controller, WebSocket agent, SSE journal, recovery jobs,
inventory, and recovery artifacts are specified future work and are therefore
reported as not applicable rather than represented by production mocks.

Baseline revision and branch:

```text
1f8a958d9c2511ec6433edb27c0f513da6d0e164
main
```

Baseline `git status --short` (recorded before the first gate edit):

```text
 M README.md
 M desktop/linux-integration.mjs
 M desktop/ww-main.mjs
 M desktop/ww-preload.cjs
 M desktop/ww/index.html
 M desktop/ww/renderer.js
 M desktop/ww/styles.css
 M docs/WW.md
 M electron-builder.linux.json
 M lib/ww-client.mjs
 M lib/ww-config-store.mjs
 M lib/ww-endpoint.mjs
 M lib/ww-fs.mjs
 M lib/ww-service.mjs
 M lib/ww-transfer.mjs
 M scripts/install-ww-bundle.sh
 M scripts/launch-workwire.sh
 M test/ww-bundle-install.test.mjs
 M test/ww-config-store.test.mjs
 M test/ww-endpoint.test.mjs
 M test/ww-install.test.mjs
 M test/ww-launcher.test.mjs
 M test/ww-package-config.test.mjs
 M test/ww-service.test.mjs
 M test/ww-ui-contract.test.mjs
 M ww.mjs
?? Portal/
?? desktop/assets/
?? desktop/ww/assets/
?? docs/RECOVERY-PORTAL-TODO.md
?? test/ww-linux-integration.test.mjs
?? test/ww-trash.test.mjs
```

Every path above is pre-existing user work and must be preserved.

## Hardware and environment

| Item | Baseline value |
| --- | --- |
| Host | bare-metal Fedora Linux 43 Workstation, x86_64 |
| Kernel | `6.18.5-200.fc43.x86_64` |
| CPU | Intel Core i7-3770 at 3.40 GHz; 4 cores / 8 threads |
| Memory | 33,553,924,096 bytes physical; 27,176,583,168 bytes available at capture |
| Swap | 8,589,930,496 bytes; unused at capture |
| Filesystem | ext4 on `/dev/sda4`, 193.3 GiB total, 62.7 GiB available, `relatime` |
| Virtualization | none (`systemd-detect-virt` returned `none`) |
| Node | 22.22.0 |
| npm | 10.9.4 |
| Electron | 43.1.1 |
| electron-builder | 26.15.3 |
| Measurement tools | GNU time, `ps`, `vmstat`, and `ss`; `pidstat`, `iostat`, and `perf` unavailable |

CPU frequency scaling and ordinary workstation background activity were left
enabled. Comparisons in this gate use the same host, checkout, filesystem,
runtime, and command shape. Each dedicated benchmark is run repeatedly in one
process where practical; reported summaries include minimum, median, maximum,
p95, and coefficient of variation or relative spread as appropriate. Build and
full-suite timings are correctness evidence, not microbenchmarks.

## Untouched correctness and build baseline

Exact test command:

```sh
env NODE_OPTIONS= /usr/bin/time -v npm test
```

Result: **110 passed, 0 failed, 0 skipped, 0 cancelled**. Node TAP duration was
3,314.371 ms; wall time was 3.77 s; aggregate CPU was 390%; user/system CPU was
13.44/1.29 s; peak RSS was 174,948 KiB; the command exited 0.

Exact distribution command:

```sh
env NODE_OPTIONS= /usr/bin/time -v npm run dist:linux
```

Result: succeeded and produced the versioned Linux tarball, `ww-linux-x64`
alias, and AppImage. Wall time was 40.25 s; aggregate CPU was 143%; user/system
CPU was 54.24/3.41 s; peak RSS was 423,216 KiB; the command exited 0.

## Work log

- 2026-07-17 02:14 - Captured the dirty worktree, phase boundary, host facts,
  full test baseline, and distribution build before changing
  performance-sensitive code.
- Added opt-in structured instrumentation and benchmark drivers before
  selecting optimizations.
- Captured V8 CPU profiles for the original search and directory listing paths
  and a large-upload external-memory profile.
- Applied one coherent correction at a time, running focused correctness and
  performance checks after each change. Intermediate raw files preserve those
  steps (`after-*`, `electron-*`, and `*-smoke` in `performance-results`).
- Ran the final real-Electron interaction benchmark, HTTP-client fleet and
  reconnect stress, transfer throughput suite, renderer reload audit, 60-second
  service/transfer soak, complete test suite, and distribution build.

## Methodology and repeatability

Latency uses `performance.now()`; CPU and resource counters use
`process.cpuUsage()`, `process.memoryUsage()`, `process.resourceUsage()`, event
loop utilization, and `monitorEventLoopDelay()`. Peak memory is sampled every
2–10 ms during measured work. Browser results use Chromium's Performance API,
forced layout at the visible-result boundary, `PerformanceObserver` long-task
records, precise heap metrics, and Electron process metrics. Large-transfer
verification is an incremental SHA-256 read, not a full-file buffer.

Dedicated samples have one warm-up where cache state matters and otherwise use
the repetition counts shown below. Each raw JSON result contains every sample
plus minimum, median, p95, maximum, mean, standard deviation, and coefficient
of variation. The tables below retain min/median/max/CV for the measurements
where variance materially affects interpretation.

Exact final commands:

```sh
node --expose-gc scripts/performance/portal-search-benchmark.mjs --repeats=7 --output=performance-results/final-portal-search.json
node scripts/performance/electron-portal-benchmark.mjs --repeats=5 --reloads=20 --soak-cycles=20 --output=performance-results/final-electron-portal.json
node scripts/performance/electron-portal-benchmark.mjs --sizes=100 --repeats=2 --reloads=30 --soak-cycles=0 --ipc-messages=10 --output=performance-results/final-reload-audit.json
node --expose-gc scripts/performance/filesystem-benchmark.mjs --repeats=5 --output=performance-results/final-filesystem.json
node --expose-gc scripts/performance/service-stress-benchmark.mjs --rounds=7 --storm-rounds=5 --restart-cycles=20 --output=performance-results/final-service-stress.json
node --expose-gc scripts/performance/transfer-benchmark.mjs --repeats=5 --sizes-mib=0,0.0625,100,384 --concurrent-transfers=4 --concurrent-size-mib=100 --output=performance-results/final-transfer.json
node --expose-gc scripts/performance/lifecycle-soak.mjs --duration-seconds=60 --iterations=100000 --output=performance-results/final-service-soak.json
node scripts/performance/recovery-scope-report.mjs --output=performance-results/recovery-scope.json
env NODE_OPTIONS= /usr/bin/time -v npm test
env NODE_OPTIONS= /usr/bin/time -v npm run dist:linux
```

For routine engineering use, `npm run perf:all` executes all benchmark classes
and writes a fresh result set under `performance-results/latest`; adding
`-- --quick` selects the short smoke configuration. Individual commands are
available as `perf:portal`, `perf:portal:electron`, `perf:filesystem`,
`perf:service`, `perf:reconnect`, `perf:transfer`, `perf:artifact`, `perf:soak`,
and `perf:scope`. Store, command-output, and inventory commands emit an explicit
scope record until those future modules exist.

Raw evidence:

- [baseline search](../performance-results/baseline-portal-search.json) and
  [final search](../performance-results/final-portal-search.json)
- [baseline filesystem](../performance-results/baseline-filesystem.json) and
  [final filesystem](../performance-results/final-filesystem.json)
- [baseline service](../performance-results/baseline-service-stress.json) and
  [final service](../performance-results/final-service-stress.json)
- [baseline transfer](../performance-results/baseline-transfer.json),
  [baseline upload memory profile](../performance-results/baseline-transfer-memory-profile.json),
  and [final transfer](../performance-results/final-transfer.json)
- [final Electron interaction](../performance-results/final-electron-portal.json),
  [reload audit](../performance-results/final-reload-audit.json), and
  [60-second soak](../performance-results/final-service-soak.json)
- [search CPU profile](../performance-results/baseline-search.cpuprofile) and
  [filesystem CPU profile](../performance-results/baseline-filesystem.cpuprofile)
- [current final verification record](../performance-results/final-current-verification.json);
  the [earlier full TAP transcript](../performance-results/final-test-suite.txt)
  and [earlier build transcript](../performance-results/final-build.txt) are
  retained as intermediate evidence from before the last observed workspace edits

The same bare-metal host, checkout, ext4 filesystem, Node version, and command
shape were used. Ordinary CPU scaling and workstation services were retained.
Some later final runs coincided with user-started WorkWire/background processes
that were not known to be active for the earliest baseline runs; the final
results therefore demonstrate budgets under at least as hostile a workstation
condition, while exact cross-run percentage comparisons retain that caveat.

## Search and renderer results

The pure benchmark invokes the production search module with synthetic long,
deep, Unicode, and accented names. Values below are median milliseconds; each
cell is single-character / common / rare-exact / multi-token / typo-tolerant.

| Entries per pane | Original ranking | Final indexed ranking | CPU change across all five queries |
| ---: | --- | --- | ---: |
| 100 | 1.07 / 1.77 / 3.37 / 3.17 / 2.11 | 0.34 / 0.50 / 0.56 / 0.17 / 0.50 | 38.19 → 12.51 ms (-67.2%) |
| 1,000 | 7.17 / 13.27 / 28.12 / 26.06 / 15.79 | 0.89 / 1.31 / 1.00 / 1.23 / 1.22 | 119.58 → 25.95 ms (-78.3%) |
| 10,000 | 74.64 / 113.46 / 293.06 / 256.69 / 154.63 | 3.05 / 4.79 / 6.93 / 8.50 / 10.54 | 941.62 → 53.17 ms (-94.4%) |
| 50,000 | 371.90 / 561.80 / 1,394.19 / 1,281.77 / 764.45 | 15.76 / 26.84 / 34.78 / 41.23 / 52.64 | 4,567.92 → 191.87 ms (-95.8%) |

The final 10,000-entry query minima were 2.87–9.47 ms, medians 3.05–10.54
ms, p95s 4.99–12.43 ms, maxima 5.40–12.96 ms, and CVs 0.102–0.239. At
50,000 entries they were 13.84–51.36 ms, 15.76–52.64 ms, 16.59–55.12 ms,
16.79–55.28 ms, and 0.021–0.059 respectively. Rapid eight-edit sequences
changed from 780.54 to 45.12 ms median at 10,000 and 3,952.09 to 212.90 ms at
50,000. Index construction is asynchronous and reusable: 46.53 ms median at
10,000 and 241.59 ms at 50,000.

Real hidden Electron/Chromium results include rendering and input dispatch:

| Entries per pane | Initial visible rows min / median / p95 / max | Worst query median / p95 | Rapid edits median / p95 | Key handler p95 | Workspace switch median | Long tasks |
| ---: | --- | --- | --- | ---: | ---: | --- |
| 100 | 14.1 / 15.0 / 31.8 / 35.8 ms | 9.1 / 17.0 ms | 8.4 / 9.4 ms | 0.2 ms | 0.8 ms | none |
| 1,000 | 19.2 / 19.6 / 20.7 / 20.8 ms | 12.7 / 13.0 ms | 9.7 / 12.1 ms | 0.2 ms | 0.8 ms | none |
| 10,000 | 18.6 / 20.8 / 28.8 / 30.1 ms | 19.5 / 19.6 ms | 12.8 / 20.4 ms | 0.2 ms | 0.6 ms | one 52 ms outlier |
| 50,000 | 17.1 / 18.4 / 47.0 / 53.5 ms | 52.6 / 55.6 ms | 11.5 / 33.1 ms | 0.2 ms | 0.8 ms | 10; 54–81 ms |

Only approximately 34 visible rows per pane are constructed. Initial feedback
therefore remains immediate while index/comparison preparation continues in
cooperative slices (median 246 ms at 10,000 and 1,196 ms at 50,000). Every
10,000-entry query met the 50 ms median/100 ms p95 budget and the direct
interaction series recorded one non-recurring 52 ms outlier. The 20-cycle soak
recorded one non-recurring 61 ms outlier across 1,000 searches. The optional
50,000-entry hostile case has ten bounded long tasks and a worst query p95 of
55.6 ms; that is recorded as a non-blocking extreme-case
limitation, not hidden.

Working renderer heap after the measured datasets was 2.4, 8.3, 54.3, and
78.9 MiB at 100, 1,000, 10,000, and 50,000 entries per pane. The listing/index
working set grows with the active listing, then is released on navigation;
post-GC soak and reload measurements below remain flat.

Search correctness tests cover accent-insensitive normalization, name and path
tokens, exact/prefix/word-prefix/substring precedence, typo tolerance, stable
ordering, folder-only tie precedence, safe short-query rejection, asynchronous
cancellation, and stale index release. Filenames render through `textContent`,
the two panel indexes are independent, and the dropdown is capped at ten nodes.

## Filesystem listing results

The benchmark creates real files on the same ext4 filesystem and invokes the
production `listDirectory`. Latencies are min / median / p95 / max; CV is
standard deviation divided by mean.

| Entries | Baseline latency (ms), CV | Final latency (ms), CV | User CPU | Peak RSS | Event-loop max |
| ---: | --- | --- | --- | --- | --- |
| 100 | 10.50 / 11.70 / 12.35 / 12.41, 0.070 | 3.52 / 4.06 / 4.90 / 4.93, 0.123 | 56.40 → 27.39 ms | 65.9 → 64.4 MiB | 12.59 → 9.68 ms |
| 1,000 | 89.16 / 98.29 / 106.10 / 106.64, 0.061 | 26.04 / 28.22 / 36.25 / 38.13, 0.148 | 521.89 → 198.02 ms | 77.9 → 71.1 MiB | 69.99 → 11.19 ms |
| 10,000 | 793.81 / 822.76 / 841.41 / 844.37, 0.024 | 254.89 / 259.73 / 288.49 / 290.81, 0.051 | 4,065.30 → 1,512.34 ms | 153.7 → 108.9 MiB | 501.48 → 27.41 ms |
| 50,000 | 4,301.18 / 4,452.12 / 4,479.42 / 4,483.73, 0.015 | 1,336.13 / 1,410.78 / 1,493.01 / 1,507.15, 0.040 | 21,728.13 → 7,948.85 ms | 271.9 → 147.6 MiB | 2,717.91 → 42.34 ms |

The result count was exact in every repetition. The final path bounds metadata
concurrency at 32, reuses one `Intl.Collator`, and cooperatively merge-sorts
large results with an 8 ms slice budget. It does not cache potentially stale
directory contents.

## Active HTTP service and reconnect results

This is the current WorkWire Files HTTP service, not the future Phase 3
recovery controller. Simulated clients perform real authenticated loopback
connect negotiation. Final request latency is min / median / p95 / max in ms.

| Concurrent clients | Initial connect latency, CV | Restart/reconnect storm latency, CV | Batch completion median |
| ---: | --- | --- | ---: |
| 1 | 4.23 / 5.46 / 41.64 / 56.31, 1.384 | 1.49 / 1.75 / 2.17 / 2.23, 0.150 | 5.47 / 1.76 ms |
| 10 | 8.67 / 11.33 / 29.96 / 32.80, 0.445 | 6.16 / 8.39 / 10.45 / 11.15, 0.159 | 14.41 / 11.73 ms |
| 50 | 32.60 / 43.64 / 67.10 / 95.29, 0.253 | 23.31 / 40.88 / 55.17 / 61.61, 0.220 | 58.84 / 62.16 ms |
| 100 | 51.03 / 70.56 / 105.78 / 124.20, 0.190 | 47.94 / 78.58 / 113.08 / 126.39, 0.231 | 97.92 / 119.19 ms |

Loopback ping was 0.523/0.633/1.367/2.099 ms (min/median/p95/max). Listing
1,000 real entries was 26.89/32.59/44.40/52.18 ms, down from a 54.20 ms
baseline median. Twenty stop/start/connect cycles took 2.28/2.99/4.65/20.89
ms. The stress-run event-loop delay was 14.35 ms mean, 33.75 ms p95, 62.78
ms p99, and 67.70 ms max during 100-client bursts; the sole active `Socket`
handle was the same before and after shutdown.

The 100-client initial-connect median moved from 66.54 to 70.56 ms while the
workstation had additional background activity. That 6.0% difference is below
the run's 19.0% CV and is not treated as a confirmed regression. No sustained
latency growth, reconnect failure, or leaked handle occurred.

## Transfer speed, throughput, and bounded memory

Transfer speed is a primary benchmark and acceptance criterion. The suite uses
the real local endpoint, HTTP service, remote client, transfer planner, atomic
destination semantics, and stream pipeline. It covers empty files, 64 KiB,
100 MiB, 384 MiB, and four concurrent 100 MiB uploads. Each repetition checks
the exact byte count and an incremental SHA-256 digest.

For 384 MiB, throughput is min / median / p95 / max in MiB/s:

| Mode | Baseline throughput, CV | Final throughput, CV | Median gain | Peak RSS |
| --- | --- | --- | ---: | ---: |
| Local | 776.12 / 817.52 / 860.53 / 865.31, 0.044 | 1,662.36 / 1,721.29 / 1,785.48 / 1,791.51, 0.027 | +110.6% | 174.4 → 141.5 MiB |
| Loopback upload | 207.10 / 221.50 / 227.58 / 228.25, 0.040 | 487.77 / 504.40 / 514.41 / 514.58, 0.022 | +127.7% | 524.1 → 138.3 MiB |
| Loopback download | 225.18 / 229.44 / 235.04 / 235.66, 0.019 | 411.39 / 429.92 / 434.34 / 435.10, 0.020 | +87.4% | 415.9 → 141.2 MiB |

The final 100 MiB medians were 1,521.37 MiB/s local, 410.25 MiB/s upload,
and 355.10 MiB/s download. Peak RSS only changed from 126.5 to 141.5 MiB
local, 128.8 to 138.3 MiB upload, and 132.0 to 141.2 MiB download when file
size grew from 100 to 384 MiB. That is bounded stream memory rather than
file-sized growth. The original 384 MiB upload retained approximately 438 MB
of `ArrayBuffer` data and reached 524.1 MiB RSS; the final native HTTP stream
does neither.

Four simultaneous 100 MiB uploads completed in 747.24/750.05/802.89 ms
(min/median/max), delivering 498.20/533.30/535.30 MiB/s aggregate with CV
0.027, 152.0 MiB peak RSS, p95 control-ping latency 8.72 ms, zero control
failures, and four exact hashes.

CPU resources are totals normalized per large-file repetition:

| Mode | Baseline user/system CPU | Final user/system CPU | Final event-loop max |
| --- | ---: | ---: | ---: |
| Local | 2,170.56 / 345.76 ms | 1,866.57 / 360.86 ms | 15.25 ms |
| Upload | 3,949.63 / 776.92 ms | 2,617.03 / 615.71 ms | 14.97 ms |
| Download | 4,078.24 / 662.07 ms | 2,902.12 / 632.45 ms | 14.81 ms |

Intermediate progress callbacks are rate-limited to 100 ms while initial and
terminal events are always retained. The 384 MiB callback count fell from
roughly 6,148 per transfer to 7 local, 12 upload, and 13.2 download. Control
ping p95 remained below 6.2 ms for single transfers with zero failures.

Correctness and adverse-condition coverage includes a real 24 MiB throttled
HTTP receiver (producer lead stayed below 12 MiB), an aborted 16 MiB download
followed by a successful control ping, 4 KiB output chunks with exact final
bytes and coalesced progress, failed incoming streams preserving the old
destination, atomic file/directory overwrite, empty and binary files, and
concurrent transfer hashes. `pipeline()` now destroys the source on an abrupt
HTTP close and propagates backpressure end to end.

This is same-host ext4/HTTP loopback, so it measures application overhead and
an upper-bound local transfer rate rather than WAN or physical-NIC capacity.
Sparse deterministic source files have binary head/tail blocks and are verified
after materialization. Recovery artifact ranges, persisted resume offsets, and
`.partial` recovery belong to future Phase 8 and are not claimed here.

## IPC and serialization

The prior high-frequency path sent the complete renderer state after every
small operation. With 50,000 synthetic entries per pane that snapshot was
17,997,086 bytes. An incremental operation event is 277 bytes, a 64,971.43x
reduction. A real Electron burst delivered 1,000 such events end to end in
61.59 ms (16,236 messages/s); main-process send time was 31.11 ms.

Operation, explorer, listing, and loading changes now use explicit incremental
payloads. Complete snapshots remain available for initial load/reconstruction.
Unchanged directory polls are suppressed. Refresh generations reject late
local/remote results, and one overlap guard prevents duplicate remote sync.
The renderer patches only the affected state, virtualizes rows, updates search
highlight nodes without a table rebuild, bounds visible activity, and removes
its one IPC listener during unload. Payload diagnostics record byte counts but
redact sensitive fields.

## Lifecycle and leak evidence

The Node soak ran for 60.070 seconds and completed 21,438 ping/list/transfer
iterations, 214 service stop/start/reconnect cycles, and 2,247,622,656 streamed
bytes. In the latter two-thirds of 573 samples:

- live heap changed by 366,592 bytes with a 24.04-byte/iteration slope;
- RSS changed by 9,125,888 bytes with a 611.67-byte/iteration slope while live
  heap remained flat, consistent with allocator/page-cache retention rather
  than objects retained per operation;
- event-loop delay was 20.48 ms mean, 24.12 ms p95, 27.00 ms p99, and 37.09 ms
  maximum;
- active handles returned from one `Socket` to one `Socket`, file descriptors
  returned from 22 to 22, and no warning or `MaxListenersExceededWarning`
  occurred.

The Electron soak performed 20 cycles with 10,000 entries in each pane and
1,000 total searches. The warm plateau changed by -83,270 live-heap bytes with
a -1,304-byte/cycle slope; working set changed by 392 KiB with a
-6.18-KiB/cycle least-squares slope. One non-recurring 61 ms long task occurred.

A separate 30-reload audit forced a garbage-collection opportunity after every
renderer reload. In the latter half, live heap changed by -112 bytes
(5.89 bytes/reload least-squares slope) and working set changed by -17,340 KiB
(-1,986.67 KiB/reload). Chromium's committed tab working set grew during early
warm-up before fluctuating around roughly 400–430 MiB; reachable JS heap stayed
at approximately 1.38 MiB. This is a plateau, not proportional reachable-heap
growth, but the Chromium committed-memory behavior remains documented for
future visible-window testing.

## Profiling evidence and optimization records

### 1. Search ranking and rendering

- **Observed bottleneck:** every keystroke renormalized every filename/path,
  applied dynamic-programming edit distance too broadly, sorted all matches,
  rebuilt full tables, and calculated comparisons with repeated scans.
- **Evidence:** the baseline V8 profile is dominated by `normalizeSearch` and
  `fuzzyDistance`; 10,000-entry rare and multi-token medians were 293.06 and
  256.69 ms. Baseline two-pane jsdom work was 1,583.93 ms at 1,000 entries.
- **Correction:** reusable per-listing normalized/token indexes, cheap strong
  match tiers, early rejection, bit-parallel distance for short queries,
  bounded stable top-K ranking, asynchronous generation checks, O(n)
  comparison maps, row virtualization, and batched/targeted DOM updates.
- **Behavioral risk:** altered ranking, stale results, unsafe names, or folder
  over-prioritization. The rank contract and safe DOM construction are explicit
  and tested.
- **Before/after:** five-query user CPU fell 94.4% at 10,000 and 95.8% at
  50,000; actual 10,000-entry Electron p95 stayed below 24 ms.
- **Guard:** semantic search tests, cancellation tests, static UI contracts,
  and a generous 2-second catastrophic threshold for a 10,000-entry query.

### 2. Directory listing

- **Observed bottleneck:** sequential `lstat`, a newly constructed
  locale-aware comparator per comparison, and a blocking native sort.
- **Evidence:** the filesystem CPU profile identifies `localeCompare` through
  `compareDirectoryEntries`; 50,000 entries consumed 21.73 CPU seconds and
  blocked the event loop for 2.72 seconds.
- **Correction:** concurrency-limited metadata reads, one stable
  `Intl.Collator`, and cooperative stable merge sort above 20,000 entries.
- **Behavioral risk:** ordering drift, descriptor pressure, or nondeterminism.
  Concurrency is capped at 32 and the same directory/folder/numeric ordering is
  retained.
- **Before/after:** 50,000 median 4,452.12 → 1,410.78 ms, peak RSS
  271.9 → 147.6 MiB, and event-loop max 2,717.91 → 42.34 ms.
- **Guard:** real-filesystem repeated benchmark and complete-count assertions.

### 3. HTTP upload/download and file-copy chunking

- **Observed bottleneck:** Fetch/Web-stream adaptation retained a complete
  large upload in external `ArrayBuffer` memory; 64 KiB disk chunks imposed
  avoidable per-chunk overhead.
- **Evidence:** the baseline memory profile reached 524.1 MiB RSS and about
  438 MB `ArrayBuffer` for a 384 MiB upload. Throughput was only 221.50 MiB/s.
- **Correction:** native `node:http`/`node:https` streaming with explicit
  response limits, timeout/abort propagation, and bounded 1 MiB file stream
  chunks.
- **Behavioral risk:** changed error, abort, auth, response, or overwrite
  behavior. Status parsing, bounded JSON errors, signals, and existing atomic
  destination behavior remain intact.
- **Before/after:** upload rose to 504.40 MiB/s and peak RSS fell 73.6%;
  local/download speed also rose 110.6%/87.4%.
- **Guard:** exact SHA-256 throughput harness, slow-receiver test, abort/control
  test, atomic overwrite tests, and all pre-existing service tests.

### 4. Backpressure and progress frequency

- **Observed bottleneck:** a progress callback per small chunk caused thousands
  of UI/IPC updates; manual response piping could leave a source alive after a
  client disconnected.
- **Evidence:** 6,148 callbacks per 384 MiB transfer and the targeted throttled
  receiver reproduction.
- **Correction:** 100 ms intermediate-progress coalescing and
  `stream/promises.pipeline()` for HTTP downloads.
- **Behavioral risk:** losing terminal/error state or byte fidelity. First and
  final events remain unconditional and durable file bytes are unchanged.
- **Before/after:** 384 MiB progress fell to 7–15 callbacks while control
  p95 stayed below 6.2 ms; slow-client producer lead is bounded.
- **Guard:** tiny-chunk exactness, slow receiver, download abort, and terminal
  progress assertions.

### 5. Renderer state and stale work

- **Observed bottleneck:** full snapshots and full rerenders followed small
  changes; late navigation/search responses could replace newer state.
- **Evidence:** a 17.997 MB snapshot for a 277-byte operation and baseline full
  table construction; refresh paths had no generation fence.
- **Correction:** compact incremental events, equality suppression, independent
  pane generations/indexes, stale cancellation, visible-row virtualization,
  cached formatting, and listener cleanup.
- **Behavioral risk:** stale UI or missed terminal state. Initial snapshots,
  explicit event schemas, terminal events, and generation tests preserve state.
- **Before/after:** 64,971x smaller hot-path IPC; 10,000-entry initial visible
  rows render in 20.8 ms median and workspace switches in 0.6 ms.
- **Guard:** Electron IPC burst, renderer reload audit, stale-response contract
  tests, and 1,000-query renderer soak.

### 6. Lifecycle ownership

- **Observed bottleneck:** timers/listeners/subscriptions needed explicit
  ownership proof across refresh, reload, restart, and shutdown.
- **Evidence:** handle, FD, heap, working-set, listener-warning, and reload
  samples were captured rather than inferred from code inspection.
- **Correction:** guarded singleton timers, remote-sync overlap prevention,
  unload unsubscribe, stopped diagnostic monitors, and clean stream teardown.
- **Behavioral risk:** missed poll/subscription after reload. Initial-state
  reconstruction and repeated restart/reload paths verify reconstruction.
- **Before/after:** new soak evidence shows heap plateau, unchanged final handle
  and FD counts, and no listener warning.
- **Guard:** 60-second Node soak, 20-cycle renderer soak, and 30 reloads.

## Diagnostic instrumentation

`WW_PERF_DIAGNOSTICS=1` enables structured process spans. Diagnostics are off
by default and do not start the event-loop monitor or logging timer when
disabled. Meaningful boundaries cover main-process IPC handlers, filesystem
listing, HTTP routes, upload/download, and renderer state/search work. Records
include duration, CPU, memory, event-loop delay/utilization, counts, and payload
sizes. Keys containing token, password, passphrase, secret, authorization,
command, content, or path are redacted. Tests prove both default-off behavior
and redaction.

## Current and future-scope benchmark matrix

| Requested benchmark | Status in this gate | Evidence |
| --- | --- | --- |
| Portal search and real Electron responsiveness | Completed | 100/1k/10k/50k, rapid edits, keyboard, switches, IPC, reload/soak |
| Large local/remote browsing | Completed | real ext4 listing and loopback service listing |
| Active HTTP service at 1/10/50/100 clients | Completed | connect, restart/reconnect, ping, list, shutdown |
| Active Files transfer speed/memory/backpressure | Completed | empty/64 KiB/100 MiB/384 MiB/concurrent/slow/abort/hash |
| Recovery WebSocket agents and controller | Not applicable before Phase 3 | no production module exists; HTTP clients are not relabelled as agents |
| Durable recovery store and JSONL journal | Not applicable before Phase 2 | no store or journal exists; no invented 10k/100k event result |
| Recovery command-output streaming/replay | Not applicable before Phases 3–7 | no recovery command protocol or executor exists |
| Recovery artifact range/resume/partial plane | Not applicable before Phase 8 | active Files stream path measured separately |
| Inventory collectors and normalization | Not applicable before Phase 4 | no collectors exist |
| SSE subscribers and durable event publication | Not applicable before Phase 3 | no SSE/event journal exists |

[The machine-readable scope report](../performance-results/recovery-scope.json)
confirms that all Phase 0–17 recovery checkboxes were still unchecked and every
recovery module probe was absent. As each future component is implemented, its
component-specific load and durability gate remains mandatory; this report is
not advance credit for code that does not exist.

## Failure and endurance coverage

Completed active-scope adverse tests include slow receiver, abrupt download
abort, failed upload stream, atomic replacement, binary/empty/large files,
four concurrent transfers, high-frequency tiny chunks, control requests during
transfer, stale response after a newer navigation/search generation, repeated
service death/restart, reconnect storm, repeated Electron refresh/reload,
thousands of queries, repeated subscription reconstruction, invalid/missing
peer behavior, and final shutdown cleanup. Errors remain surfaced and previous
destinations remain intact on interrupted overwrite.

A real nearly-full mounted filesystem was not induced because the workstation
has no disposable fault-injection mount and consuming the user's remaining
volume would be unsafe. Existing stream-failure tests exercise the same atomic
replacement invariant. A slow HTTP consumer was used for backpressure; no
kernel-level slow block-device injector was available. Recovery-only controller
death, agent death, active command output, journal replay, and artifact resume
are not executable before their phases.

## Files changed by this gate

Gate-owned changes are limited to the active paths and engineering evidence:

- `desktop/ww-main.mjs`, `desktop/ww-preload.cjs`,
  `desktop/ww/renderer.js`, and `desktop/ww/search.js`
- `lib/ww-client.mjs`, `lib/ww-fs.mjs`, `lib/ww-service.mjs`,
  `lib/ww-transfer.mjs`, and `lib/ww-performance.mjs`
- `scripts/performance/*.mjs`, `scripts/performance/electron-portal-worker.cjs`,
  `package.json`, and `performance-results/*`
- `test/ww-performance.test.mjs`, `test/ww-search.test.mjs`, plus scoped
  additions to `test/ww-service.test.mjs` and `test/ww-ui-contract.test.mjs`
- this report

Many of those tracked files already contained user modifications at baseline.
The gate preserved and built on them. All other dirty/untracked baseline paths
remain user work; nothing was reset, discarded, or overwritten.

During report finalization, additional transfer-panel/telemetry work appeared
in `desktop/ww-main.mjs`, `desktop/ww/renderer.js`, `desktop/ww/index.html`,
`desktop/ww/styles.css`, `desktop/ww/transfer-progress.js`,
`test/ww-transfer-progress.test.mjs`, `test/ww-service.test.mjs`, and a preview
script. Ownership was not assumed and those edits were preserved. The final
Electron, transfer, 30-reload, 127-test, and distribution runs were repeated
after the last observed write so this gate reflects the resulting current tree.

## Final verification

Focused performance/correctness command:

```sh
node --test test/ww-search.test.mjs test/ww-performance.test.mjs test/ww-service.test.mjs test/ww-ui-contract.test.mjs
```

Result: **34 passed, 0 failed**.

Final full command:

```sh
env NODE_OPTIONS= /usr/bin/time -v npm test
```

Result: **127 passed, 0 failed, 0 skipped, 0 cancelled**. TAP duration was
4,177.009 ms, wall time 4.66 s, aggregate CPU 378%, user/system CPU
16.02/1.60 s, and peak RSS 175,728 KiB. The untouched baseline had 110 tests,
3,314.371 ms TAP duration, 3.77 s wall time, and 174,948 KiB peak RSS; the final
suite adds 17 tests with peak memory effectively unchanged (+0.4%).

Final distribution command:

```sh
env NODE_OPTIONS= /usr/bin/time -v npm run dist:linux
```

Result: succeeded, producing the versioned AppImage, Linux tarball, and
`ww-linux-x64` alias for release `0.1.0+ww1.253bc6f2b49e`. Wall time was
44.97 s, aggregate CPU 136%, user/system CPU 57.50/3.82 s, and peak RSS
438,172 KiB. Baseline was 40.25 s and
423,216 KiB; the workstation background differed and build peak memory was
3.5% higher. `git diff --check` and syntax checks for changed
JavaScript completed cleanly.

## Acceptance assessment

- Existing and new tests pass; the distribution build succeeds.
- Required 10,000-entry search medians and p95s are comfortably inside budget,
  keyboard/workspace interaction is frame-scale, and no ordinary 10,000-entry
  long task recurs.
- Large listing event-loop stalls, full-table rendering, stale result races,
  and full-snapshot hot-path IPC were corrected and guarded.
- Large and concurrent active transfers are hash-exact, approximately
  size-independent in memory, backpressure-aware, materially faster, and keep
  control traffic responsive.
- Active service connect/reconnect/shutdown remains responsive through 100
  clients and repeated restart.
- Node heap, renderer heap, listeners, handles, sockets, and FDs plateau or
  return to baseline after warm-up; no confirmed leak remains.
- No validation, error reporting, output fidelity, atomic replacement, or
  required behavior was removed for a benchmark result.
- No critical or high-severity defect remains confirmed in implemented scope.

Remaining limitations are the unavailable OS profilers/fault injectors,
hidden-window rather than compositor-visible Electron measurement, isolated
52/61 ms 10,000-entry outliers and bounded 54–81 ms tasks in the optional
50,000-entry hostile case, early Chromium committed-memory warm-up, loopback rather than physical
network throughput, and all explicitly future recovery subsystems. These do
not invalidate the active-scope evidence but prevent an unconditional label.

## Phase boundary and gate classification

Completed recovery phase: **none**. The current implementation predates the
recovery plan. The next permitted phase after this gate is **Phase 0 — Preserve
baseline and establish recovery configuration**. This gate did not begin it or
check any requirement in `RECOVERY-PORTAL-TODO.md`.

`PERFORMANCE GATE PASSED WITH DOCUMENTED ENVIRONMENT LIMITS`
