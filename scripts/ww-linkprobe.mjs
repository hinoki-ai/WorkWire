#!/usr/bin/env node
// ww-linkprobe.mjs — classify and journal why the HINOKI<->peer WW link is (or
// is not) up, the instant it happens. See linkfail.md for the why.
//
// The desktop app and the mirror both collapse every distinct failure
// (stale token, version drift, node_modules crash, peer asleep, peer moved)
// into one generic "looking for the other PC" message and keep the real cause
// in memory for microseconds. This probe reproduces the mirror's own
// authenticated handshake, classifies the outcome into one actionable cause
// code, and appends a secret-redacted record to .workwire/linkfail.jsonl so a
// recurrence is a one-command glance instead of a cross-machine spelunk.
//
// Non-invasive by design: it reads the same config and talks the same protocol
// as `ww serve`, but never mutates fleet state. In-runtime instrumentation of
// the live swallow sites is a separate, approval-gated step (linkfail.md §5).
//
//   node scripts/ww-linkprobe.mjs            probe now, append, print verdict
//   node scripts/ww-linkprobe.mjs --summary  last-known-good + cause histogram
//   node scripts/ww-linkprobe.mjs --json     machine-readable (for a timer/hook)
//   flags: --timeout MS --config PATH --agents --no-append --quiet

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dgram from "node:dgram";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createRemoteWwClient } from "../lib/ww-client.mjs";
import { buildWwBuildInfo } from "../lib/ww-compat.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Managed namespace: default to the repo's .workwire (what workwire-ww.service
// uses), honoring the same env overrides the config store honors.
const wwHome = process.env.WW_HOME_DIR
  ? path.resolve(process.env.WW_HOME_DIR)
  : path.join(repoRoot, ".workwire");
const defaultConfigPath = process.env.WW_CONFIG_PATH
  ? path.resolve(process.env.WW_CONFIG_PATH)
  : path.join(process.env.WW_CONFIG_DIR ? path.resolve(process.env.WW_CONFIG_DIR) : path.join(wwHome, "config"), "ww-config.json");
const journalPath = path.join(wwHome, "linkfail.jsonl");

// --- ordered cause taxonomy (most fundamental first) -----------------------
const CAUSES = {
  CONFIG_INCOMPLETE: "peer config is missing host/token",
  CONFIG_CROSSWIRED: "peer.token equals own service.token (pairing bug)",
  PEER_UNREACHABLE: "peer not reachable on the LAN (asleep / off / moved IP)",
  SERVICE_DOWN: "peer reachable but WW service/port is dead (crash / node_modules drift)",
  VERSION_DRIFT: "peer runs a different WorkWire build (app/protocol/update)",
  TRUST_MISMATCH: "peer advertises a different trust id",
  PEER_IDENTITY_MISMATCH: "responder machineId != pinned peer machineId",
  AUTH_TOKEN_STALE: "peer rejected the stored bearer token (401)",
  ROOT_MISMATCH: "peer root path differs from the expected remote root",
  ROOT_MISSING: "peer did not advertise its root path",
  UNKNOWN_ERROR: "unclassified link error",
  LINK_OK: "authenticated mirror link is healthy",
};

function parseArgs(argv = process.argv.slice(2)) {
  const flags = { timeout: 6000 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--summary" || token === "--json" || token === "--agents"
      || token === "--no-append" || token === "--quiet") {
      flags[token.slice(2).replace(/-/g, "")] = true;
      continue;
    }
    if (token === "--timeout" || token === "--config") {
      const value = argv[i + 1];
      if (value === undefined) throw new TypeError(`${token} requires a value.`);
      flags[token.slice(2)] = token === "--timeout" ? Number(value) : String(value);
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") { flags.help = true; continue; }
    throw new TypeError(`Unexpected argument: ${token}`);
  }
  return flags;
}

function readConfig(configPath) {
  const raw = fs.readFileSync(configPath, "utf8").replace(/^﻿/, "");
  return JSON.parse(raw);
}

async function fetchDiscover(host, port, timeoutMs) {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${authority}:${port}/v1/discover`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const status = res.status;
    let body = null;
    try { body = await res.json(); } catch { /* ignore */ }
    return { ok: res.ok, status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: normalizeNetError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeNetError(error) {
  const code = String(error?.cause?.code || error?.code || "").trim();
  if (code) return code;
  if (error?.name === "AbortError") return "ETIMEDOUT";
  return String(error?.message || error || "error");
}

function execFileAsync(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function checkL3(host, timeoutMs) {
  // Linux ARP/neigh state. Best-effort; TCP discover is the real reachability
  // gate, this only distinguishes "port dead" from "host absent".
  if (process.platform !== "linux") return "unknown";
  const { error, stdout } = await execFileAsync("ip", ["neigh", "show", host], timeoutMs);
  if (error) return "unknown";
  const line = stdout.trim();
  if (!line) return "absent";
  const m = line.match(/\b(REACHABLE|STALE|DELAY|PROBE|PERMANENT|FAILED|INCOMPLETE)\b/);
  return m ? m[1].toLowerCase() : "unknown";
}

async function sniffBeacon(host, machineId, timeoutMs) {
  // Co-bind the beacon ports (serve uses reuseAddr) and look for one datagram
  // from the peer. EADDRINUSE / failure -> unknown (not a failure signal).
  return await new Promise((resolve) => {
    const sockets = [];
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
      resolve(value);
    };
    const timer = setTimeout(() => finish(sockets.length ? false : null), timeoutMs);
    timer.unref?.();
    for (const port of [9001, 9002]) {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      socket.on("error", () => { try { socket.close(); } catch { /* ignore */ } });
      socket.on("message", (msg, rinfo) => {
        if (rinfo.address !== host) return;
        try {
          const payload = JSON.parse(msg.toString("utf8"));
          if (!machineId || String(payload.machineId || "") === machineId) finish(true);
        } catch { /* ignore */ }
      });
      try { socket.bind(port, "0.0.0.0"); sockets.push(socket); } catch { /* ignore */ }
    }
    if (sockets.length === 0) finish(null);
  });
}

async function queryAgents(host, timeoutMs) {
  const { error, stdout } = await execFileAsync(
    process.execPath, [path.join(repoRoot, "ww.mjs"), "recovery", "agents", "--json"], timeoutMs,
  );
  if (error) return null;
  try {
    const parsed = JSON.parse(stdout);
    const agents = Array.isArray(parsed) ? parsed : (parsed.agents || []);
    return agents
      .filter((a) => (a.addresses || []).some((x) => x.address === host))
      .map((a) => ({ id: a.agentId, host: a.hostname, state: a.state, lastSeen: a.lastSeenAt || a.offlineAt }));
  } catch {
    return null;
  }
}

function classifyAuthError(error) {
  const code = String(error?.code || "").trim();
  if (code === "ERR_UNAUTHORIZED") return { code, cause: "AUTH_TOKEN_STALE" };
  if (/APP_VERSION|PROTOCOL_VERSION/.test(code)) return { code, cause: "VERSION_DRIFT" };
  if (code === "ERR_WW_MIRROR_PEER_MISMATCH") return { code, cause: "PEER_IDENTITY_MISMATCH" };
  const net = normalizeNetError(error);
  if (/ECONNREFUSED/.test(net)) return { code: net, cause: "SERVICE_DOWN" };
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EWALLTIMEOUT|ECONNRESET|EAI_AGAIN/.test(net)) {
    return { code: net, cause: "PEER_UNREACHABLE" };
  }
  return { code: code || net, cause: "UNKNOWN_ERROR" };
}

async function probe(flags) {
  const startedAt = Date.now();
  const configPath = flags.config ? path.resolve(flags.config) : defaultConfigPath;
  const record = {
    ts: new Date().toISOString(),
    result: "LINK_FAIL",
    cause: "UNKNOWN_ERROR",
    configPath,
  };

  let config;
  try {
    config = readConfig(configPath);
  } catch (error) {
    record.cause = "CONFIG_INCOMPLETE";
    record.detail = `cannot read config: ${String(error?.message || error)}`;
    record.probeMs = Date.now() - startedAt;
    return record;
  }

  const service = config.service || {};
  const peer = config.peer || {};
  const localMachineId = String(service.machineId || "").trim();
  const localPort = Number(service.port) || 4851;
  const peerHost = String(peer.host || "").trim();
  const peerPort = Number(peer.port) || 4851;
  const ownTokenLen = String(service.token || "").length;
  const peerTokenLen = String(peer.token || "").length;
  const crosswired = Boolean(peer.token && service.token && peer.token === service.token);

  Object.assign(record, {
    peerLabel: String(peer.label || "").trim() || "(peer)",
    peerHost, peerPort,
    peerMachineId: String(peer.machineId || "").trim() || null,
    ownTokenLen, peerTokenLen, crosswired,
  });

  if (!peerHost || !peer.token) {
    record.cause = crosswired ? "CONFIG_CROSSWIRED" : "CONFIG_INCOMPLETE";
    record.detail = !peerHost ? "peer.host is empty" : "peer.token is empty";
    record.probeMs = Date.now() - startedAt;
    return record;
  }

  // Parallel signal gathering that doesn't depend on the auth result.
  const [l3, localDisc, peerDisc, beacon, agents] = await Promise.all([
    checkL3(peerHost, Math.min(flags.timeout, 2500)),
    fetchDiscover("127.0.0.1", localPort, Math.min(flags.timeout, 3000)),
    fetchDiscover(peerHost, peerPort, flags.timeout),
    sniffBeacon(peerHost, String(peer.machineId || ""), 2600),
    flags.agents ? queryAgents(peerHost, 12000) : Promise.resolve(undefined),
  ]);

  record.l3 = l3;
  record.beacon = beacon;
  if (agents !== undefined) record.peerAgents = agents;

  // Local baseline for version/trust comparison (fall back to build info).
  const localSvc = localDisc.body?.service || {};
  const localBuild = buildWwBuildInfo();
  const localApp = String(localSvc.versions?.app || localBuild.versions.app || "").trim();
  const localProto = Number(localSvc.versions?.protocol ?? localBuild.versions.protocol);
  const localTrust = String(localSvc.trustId || localSvc.deploymentId || "").trim();
  record.localServiceUp = Boolean(localDisc.ok);

  const peerSvc = peerDisc.body?.service || {};
  const serviceUp = Boolean(peerDisc.ok && peerSvc);
  record.serviceUp = serviceUp;
  record.httpStatus = peerDisc.status || 0;

  if (serviceUp) {
    const peerApp = String(peerSvc.versions?.app || "").trim();
    const peerProto = Number(peerSvc.versions?.protocol);
    const peerTrust = String(peerSvc.trustId || peerSvc.deploymentId || "").trim();
    const respondedMachineId = String(peerSvc.machineId || "").trim();
    record.peerApp = peerApp || null;
    record.localApp = localApp || null;
    record.versionMatch = Boolean(localApp) && peerApp === localApp && peerProto === localProto;
    record.trustMatch = localTrust ? peerTrust === localTrust : null;
    record.identityMatch = record.peerMachineId ? respondedMachineId === record.peerMachineId : null;
    record.respondedMachineId = respondedMachineId || null;
  }

  // The definitive gate: the mirror's own authenticated /v1/info handshake.
  let authOk = false;
  let authErr = null;
  try {
    const client = createRemoteWwClient({ ...peer, localMachineId, localService: false });
    const info = await Promise.race([
      client.connectForUpdate({ timeoutMs: flags.timeout }),
      new Promise((_, rej) => setTimeout(
        () => rej(Object.assign(new Error("probe wall-timeout"), { code: "EWALLTIMEOUT" })),
        flags.timeout + 2000,
      )),
    ]);
    authOk = true;
    record.respondedMachineId = String(info?.machineId || record.respondedMachineId || "").trim() || null;
    const peerRoot = String(info?.rootPath || "").trim();
    const expectedRoot = String(peer.remotePath || "").trim();
    record.peerRootPath = peerRoot || null;
    record.expectedRootPath = expectedRoot || null;
    record.rootMatch = expectedRoot ? peerRoot === expectedRoot : (peerRoot ? true : null);
    record.peerApp = record.peerApp || String(info?.versions?.app || "").trim() || null;
  } catch (error) {
    authErr = classifyAuthError(error);
    record.authErrorCode = authErr.code || null;
  }
  record.authOk = authOk;

  // --- decide the single most actionable cause ------------------------------
  if (authOk) {
    if (record.rootMatch === false) {
      record.cause = record.peerRootPath ? "ROOT_MISMATCH" : "ROOT_MISSING";
      record.result = "LINK_FAIL";
      record.detail = `peer root ${record.peerRootPath || "(none)"} != expected ${record.expectedRootPath}`;
    } else {
      record.cause = "LINK_OK";
      record.result = "LINK_OK";
      record.detail = `authenticated link healthy to ${peerHost}:${peerPort}`;
    }
  } else if (crosswired) {
    record.cause = "CONFIG_CROSSWIRED";
    record.detail = "peer.token equals own service.token; every auth request will 401";
  } else if (!serviceUp && (l3 === "absent" || l3 === "failed" || l3 === "incomplete" || /UNREACH|ETIMEDOUT/.test(String(record.authErrorCode)))) {
    record.cause = "PEER_UNREACHABLE";
    record.detail = `no discover response; L3=${l3}; auth=${record.authErrorCode || "n/a"}`;
  } else if (!serviceUp) {
    record.cause = "SERVICE_DOWN";
    record.detail = `L3=${l3} but /v1/discover failed (${peerDisc.error || record.httpStatus}); port ${peerPort} likely dead`;
  } else if (record.versionMatch === false) {
    record.cause = "VERSION_DRIFT";
    record.detail = `peer app ${record.peerApp} != local ${record.localApp}`;
  } else if (record.trustMatch === false) {
    record.cause = "TRUST_MISMATCH";
    record.detail = "peer advertises a different trust id";
  } else if (record.identityMatch === false) {
    record.cause = "PEER_IDENTITY_MISMATCH";
    record.detail = `responder ${record.respondedMachineId} != pinned ${record.peerMachineId}`;
  } else if (authErr?.cause === "AUTH_TOKEN_STALE" || record.authErrorCode === "ERR_UNAUTHORIZED") {
    record.cause = "AUTH_TOKEN_STALE";
    record.detail = `peer 401 with stored token (own=${ownTokenLen}ch peer=${peerTokenLen}ch); re-pair required`;
  } else {
    record.cause = authErr?.cause || "UNKNOWN_ERROR";
    record.detail = `auth failed: ${record.authErrorCode || "unknown"}`;
  }

  record.probeMs = Date.now() - startedAt;
  return record;
}

function appendJournal(record) {
  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.appendFileSync(journalPath, `${JSON.stringify(record)}\n`);
    return true;
  } catch (error) {
    process.stderr.write(`ww-linkprobe: could not write journal: ${String(error?.message || error)}\n`);
    return false;
  }
}

function readJournal() {
  try {
    return fs.readFileSync(journalPath, "utf8")
      .split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function humanAge(fromIso) {
  const ms = Date.now() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function printVerdict(record, out = process.stdout) {
  const mark = record.result === "LINK_OK" ? "OK  " : "FAIL";
  out.write(`[${mark}] ${record.cause} — ${record.detail || CAUSES[record.cause] || ""}\n`);
  out.write(`       peer ${record.peerLabel} ${record.peerHost}:${record.peerPort}`
    + ` | L3=${record.l3} service=${record.serviceUp ? "up" : "down"}`
    + ` version=${fmtBool(record.versionMatch)} trust=${fmtBool(record.trustMatch)}`
    + ` auth=${record.authOk ? "ok" : "no"} beacon=${fmtBool(record.beacon)} | ${record.probeMs}ms\n`);
}

function fmtBool(v) {
  if (v === true) return "ok";
  if (v === false) return "MISMATCH";
  return "?";
}

function printSummary(out = process.stdout) {
  const records = readJournal();
  if (records.length === 0) {
    out.write(`No link probes journaled yet at ${journalPath}\n`);
    out.write(`Run: node scripts/ww-linkprobe.mjs\n`);
    return;
  }
  const first = records[0];
  const last = records[records.length - 1];
  const lastOk = [...records].reverse().find((r) => r.result === "LINK_OK");
  let failStreak = 0;
  for (let i = records.length - 1; i >= 0 && records[i].result !== "LINK_OK"; i -= 1) failStreak += 1;

  const hist = new Map();
  for (const r of records) hist.set(r.cause, (hist.get(r.cause) || 0) + 1);
  const rows = [...hist.entries()].sort((a, b) => b[1] - a[1]);

  out.write(`WW link-failure journal — ${records.length} probes, ${first.ts} .. ${last.ts}\n`);
  out.write(`  Last known good : ${lastOk ? `${lastOk.ts} (${humanAge(lastOk.ts)})` : "NEVER in journal"}\n`);
  out.write(`  Current state   : ${last.result === "LINK_OK" ? "LINK_OK" : `DOWN — ${last.cause}`} (${humanAge(last.ts)})\n`);
  if (failStreak > 0 && last.result !== "LINK_OK") out.write(`  Failure streak  : ${failStreak} consecutive\n`);
  out.write(`  Cause histogram :\n`);
  for (const [cause, count] of rows) {
    out.write(`    ${String(count).padStart(4)}  ${cause.padEnd(22)} ${CAUSES[cause] || ""}\n`);
  }
  out.write(`  Most recent     : [${last.result}] ${last.cause} — ${last.detail || ""}\n`);
}

async function main() {
  let flags;
  try {
    flags = parseArgs();
  } catch (error) {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exit(2);
  }
  if (flags.help) {
    process.stdout.write("Usage: ww-linkprobe.mjs [--summary] [--json] [--agents] [--no-append] [--quiet] [--timeout MS] [--config PATH]\n");
    return;
  }
  if (flags.summary) {
    printSummary();
    return;
  }

  const record = await probe(flags);
  if (!flags.noappend) record.journaled = appendJournal(record);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } else if (!flags.quiet) {
    printVerdict(record);
  }
  // Exit non-zero on a down link so timers/hooks can alert.
  process.exit(record.result === "LINK_OK" ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`ww-linkprobe crashed: ${String(error?.stack || error)}\n`);
  process.exit(3);
});
