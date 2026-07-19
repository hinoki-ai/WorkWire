# FINAL SAKURA PHASE — activate the permanent HINOKI ↔ Sakura link

You are operating **Sakura**. This is phase 2 of exactly two phases. HINOKI's
phase is complete. Execute everything below yourself in this one run, verify the
result, and report the result directly to the user. Do not return another plan,
prompt, or handoff.

This procedure installs one authenticated bootstrap release, lets WorkWire
mirror the complete current checkout, and then binds Sakura to that checkout.
Afterward, ordinary source changes continue crossing the existing authenticated
link even while the two running app versions briefly differ. Both services wait
for the same stable source fingerprint and restart into it automatically. There
is no future two-PC manual activation step.

## Fixed facts

- Sakura checkout/portal root: `/home/hinoki/WorkWire`
- Sakura machine ID: `RQn5hi_GTBHwvC6bQmmTYg`
- HINOKI URL: `http://192.168.8.104:4851`
- HINOKI machine ID: `t8K6zAc6chbIa3srdlFEeQ`
- Bootstrap release: `0.1.0+ww1.e162d87d1b3d`
- Update protocol: `1`
- Bootstrap archive SHA-256:
  `fe991aff3c9f3b0f89d87d1e30288ded822cad0eaa40c440cc6e4ed1c0bc557e`

The current mirrored source may have a version newer than the bootstrap. That
is expected. Never require the source version to equal the bootstrap version;
require Sakura and HINOKI to converge on the same live source hash.

Do not re-pair, replace either identity, print/copy a token, weaken compatibility,
copy the repo with Git/SSH/USB, rebuild a release, commit, or push. Preserve all
existing source, config, `.workwire` state, Portal contents, and user changes.

## 1. Prove this is Sakura without exposing secrets

Run from `/home/hinoki/WorkWire`:

```bash
cd "$HOME/WorkWire"
node --input-type=module <<'NODE'
import fs from "node:fs/promises";
const config = JSON.parse(await fs.readFile(".workwire/config/ww-config.json", "utf8"));
const expected = {
  local: "RQn5hi_GTBHwvC6bQmmTYg",
  peer: "t8K6zAc6chbIa3srdlFEeQ",
};
if (config.service?.machineId !== expected.local) {
  throw new Error(`Wrong PC: expected Sakura ${expected.local}, got ${config.service?.machineId || "missing"}`);
}
if (config.peer?.machineId !== expected.peer) {
  throw new Error(`Wrong paired identity: expected HINOKI ${expected.peer}, got ${config.peer?.machineId || "missing"}`);
}
if (!(config.peer?.token || config.service?.token)) {
  throw new Error("Sakura's existing paired token is missing.");
}
console.log(JSON.stringify({ pc: "Sakura", machineId: expected.local, peerMachineId: expected.peer }, null, 2));
NODE
```

Stop on any mismatch. Do not repair it by pairing again.

## 2. Download and install the authenticated bootstrap once

Fetch the fixed bundle from HINOKI with Sakura's existing credentials. The
token stays inside the Node process and must not be printed or placed in shell
arguments.

```bash
set -euo pipefail
cd "$HOME/WorkWire"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
export WW_SAKURA_BUNDLE="$stage/ww-linux-x64.tar.gz"

node --input-type=module <<'NODE'
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const config = JSON.parse(await fsp.readFile(".workwire/config/ww-config.json", "utf8"));
const token = String(config.peer?.token || config.service?.token || "");
const response = await fetch("http://192.168.8.104:4851/v1/update-bundle", {
  headers: {
    authorization: `Bearer ${token}`,
    "x-ww-machine-id": String(config.service.machineId || ""),
  },
});
if (!response.ok || !response.body) {
  throw new Error(`HINOKI update download failed: HTTP ${response.status}`);
}
await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(process.env.WW_SAKURA_BUNDLE));
console.log(`Downloaded ${response.headers.get("content-length") || "unknown"} bytes from HINOKI.`);
NODE

actual_sha="$(sha256sum "$WW_SAKURA_BUNDLE" | awk '{print $1}')"
expected_sha="fe991aff3c9f3b0f89d87d1e30288ded822cad0eaa40c440cc6e4ed1c0bc557e"
test "$actual_sha" = "$expected_sha"

tar -xzf "$WW_SAKURA_BUNDLE" -C "$stage"
WW_HOME_DIR="$HOME/WorkWire/.workwire" \
WW_CONFIG_DIR="$HOME/WorkWire/.workwire/config" \
WW_PORTAL_PATH="$HOME/WorkWire" \
  "$stage/ww/install-ww.sh"

systemctl --user is-active --quiet workwire-ww.service
curl -fsS http://127.0.0.1:4851/v1/discover | python3 -m json.tool
```

At this point Sakura must advertise bootstrap app
`0.1.0+ww1.e162d87d1b3d`, protocol `1`, update protocol `1`, and service name
`Sakura`. Keep the packaged service running for the next step.

## 3. Let WorkWire itself converge the complete source

Do not manually copy files. Wait for the new updater file to arrive through the
existing mirror, then require Sakura's checkout hash to equal HINOKI's staged
source hash continuously for 20 seconds:

```bash
cd "$HOME/WorkWire"
for attempt in $(seq 1 300); do
  test -f lib/ww-update.mjs && break
  sleep 1
done
test -f lib/ww-update.mjs

node --input-type=module <<'NODE'
import fs from "node:fs/promises";
import { buildWwUpdateSourceInfo } from "./lib/ww-update.mjs";

const config = JSON.parse(await fs.readFile(".workwire/config/ww-config.json", "utf8"));
const token = String(config.peer?.token || config.service?.token || "");
const headers = {
  authorization: `Bearer ${token}`,
  "x-ww-machine-id": String(config.service.machineId || ""),
};
const deadline = Date.now() + 10 * 60_000;
let candidate = "";
let stableSince = 0;

while (Date.now() < deadline) {
  try {
    const local = await buildWwUpdateSourceInfo({ baseDir: process.cwd() });
    const response = await fetch("http://192.168.8.104:4851/v1/update-status", { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const remote = (await response.json()).update?.source;
    if (local.hash === remote?.hash) {
      if (candidate !== local.hash) {
        candidate = local.hash;
        stableSince = Date.now();
      }
      if (Date.now() - stableSince >= 20_000) {
        console.log(JSON.stringify({ convergedSourceHash: local.hash, hinokiSourceVersion: remote.appVersion }, null, 2));
        process.exit(0);
      }
    } else {
      candidate = "";
      stableSince = 0;
    }
  } catch (error) {
    candidate = "";
    stableSince = 0;
    console.error(`Waiting for source convergence: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
throw new Error("Sakura and HINOKI did not reach one stable source hash within 10 minutes.");
NODE
```

If convergence fails, leave the packaged service running and report the exact
error. Do not use an alternate copy method.

## 4. Verify the mirrored checkout, then bind Sakura to it

Install only dependencies already declared by the mirrored package/lockfile,
run the complete test suite, switch both launcher names to the checkout, and
restart the managed service once:

```bash
cd "$HOME/WorkWire"
npm install --ignore-scripts --no-audit --no-fund
npm test

ln -sfn "$HOME/WorkWire/scripts/launch-workwire.sh" "$HOME/.local/bin/ww"
ln -sfn "$HOME/WorkWire/scripts/launch-workwire.sh" "$HOME/.local/bin/workwire"
systemctl --user daemon-reload
systemctl --user restart workwire-ww.service

test "$(readlink -f "$HOME/.local/bin/ww")" = "$HOME/WorkWire/scripts/launch-workwire.sh"
test "$(readlink -f "$HOME/.local/bin/workwire")" = "$HOME/WorkWire/scripts/launch-workwire.sh"
systemctl --user is-active --quiet workwire-ww.service
```

Do not continue after a test failure.

## 5. Prove coordinated activation completed on both PCs

The source may advance while this procedure is running. Wait until both
services report the same running hash, each running hash equals its own current
source hash, and that state stays unchanged for 20 seconds:

```bash
cd "$HOME/WorkWire"
node --input-type=module <<'NODE'
import fs from "node:fs/promises";

const config = JSON.parse(await fs.readFile(".workwire/config/ww-config.json", "utf8"));
const localToken = String(config.service?.token || "");
const remoteToken = String(config.peer?.token || config.service?.token || "");
const localHeaders = {
  authorization: `Bearer ${localToken}`,
  "x-ww-local-service": "1",
};
const remoteHeaders = {
  authorization: `Bearer ${remoteToken}`,
  "x-ww-machine-id": String(config.service.machineId || ""),
};
const deadline = Date.now() + 10 * 60_000;
let candidate = "";
let stableSince = 0;

async function readUpdate(url, headers) {
  const response = await fetch(`${url}/v1/update-status`, { headers });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return (await response.json()).update;
}

while (Date.now() < deadline) {
  try {
    const [sakura, hinoki] = await Promise.all([
      readUpdate("http://127.0.0.1:4851", localHeaders),
      readUpdate("http://192.168.8.104:4851", remoteHeaders),
    ]);
    const hash = String(sakura.running?.hash || "");
    const complete = Boolean(hash)
      && hash === sakura.source?.hash
      && hash === hinoki.running?.hash
      && hash === hinoki.source?.hash
      && sakura.running?.appVersion === hinoki.running?.appVersion;
    if (complete) {
      if (candidate !== hash) {
        candidate = hash;
        stableSince = Date.now();
      }
      if (Date.now() - stableSince >= 20_000) {
        console.log(JSON.stringify({
          appVersion: sakura.running.appVersion,
          updateHash: hash,
          updateProtocol: sakura.protocol,
          sakuraSource: sakura.source.appVersion,
          hinokiSource: hinoki.source.appVersion,
        }, null, 2));
        process.exit(0);
      }
    } else {
      candidate = "";
      stableSince = 0;
    }
  } catch (error) {
    candidate = "";
    stableSince = 0;
    console.error(`Waiting for coordinated activation: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
throw new Error("Both PCs did not reach one stable running/source hash within 10 minutes.");
NODE
```

Also verify both public discovery responses show service port `4851`, update
protocol `1`, and the same app version:

```bash
curl -fsS http://127.0.0.1:4851/v1/discover | python3 -m json.tool
curl -fsS http://192.168.8.104:4851/v1/discover | python3 -m json.tool
systemctl --user status workwire-ww.service --no-pager -n 30
```

## 6. Prove real create/content/delete mirroring

Use one disposable file only. This check writes on Sakura, verifies the exact
content through HINOKI's authenticated API, deletes on Sakura, and verifies the
deletion reached HINOKI:

```bash
cd "$HOME/WorkWire"
node --input-type=module <<'NODE'
import fs from "node:fs/promises";
import path from "node:path";
import { createRemoteWwClient } from "./lib/ww-client.mjs";

const config = JSON.parse(await fs.readFile(".workwire/config/ww-config.json", "utf8"));
const client = createRemoteWwClient({
  ...config.peer,
  localMachineId: config.service.machineId,
});
await client.connect();

const name = "WW-SAKURA-LINK-CHECK.txt";
const localPath = path.join(process.cwd(), "Portal", name);
const remotePath = `/home/hinoki/WorkWire/Portal/${name}`;
const content = `WorkWire permanent link verified ${new Date().toISOString()}\n`;
const deadline = () => Date.now() + 120_000;

async function waitFor(predicate, message) {
  const end = deadline();
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(message);
}

try {
  await fs.writeFile(localPath, content, { flag: "wx" });
  await waitFor(async () => {
    try {
      const download = await client.createDownloadStream(remotePath, { timeoutMs: 5_000 });
      const chunks = [];
      for await (const chunk of download.stream) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8") === content;
    } catch {
      return false;
    }
  }, "The disposable file/content did not reach HINOKI.");

  await fs.rm(localPath);
  await waitFor(async () => {
    try {
      await client.stat({ path: remotePath });
      return false;
    } catch (error) {
      return error?.status === 404 || error?.code === "ERR_NOT_FOUND";
    }
  }, "The disposable deletion did not reach HINOKI.");
  console.log("Disposable create/content/delete mirror: PASS");
} finally {
  await fs.rm(localPath, { force: true });
  try { await client.deletePaths({ paths: [remotePath] }); } catch {}
}
NODE
```

Finally launch the ordinary desktop once with `ww`. Verify it opens without a
pairing/version warning and the desk reaches its linked state. Do not add a
temporary service override.

## 7. Report the finished phase directly

Report all of the following in the same response to the user:

1. bootstrap SHA-256;
2. final shared app version and update hash (dynamic, from step 5);
3. Sakura and HINOKI service states/ports;
4. both Sakura launcher targets;
5. full `npm test` pass/fail count;
6. disposable create/content/delete result;
7. ordinary desktop launch/link result;
8. any exact failure if completion stopped.

Do not create another handoff. Do not ask HINOKI to run another activation.
Once step 5 passes, future linked source updates are automatic on both PCs.
