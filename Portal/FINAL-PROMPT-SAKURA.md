# FINAL PROMPT — restore the permanent HINOKI ↔ Sakura WorkWire link

You are operating **Sakura**. Execute this prompt from top to bottom in one go.

HINOKI has prepared and tested the canonical WorkWire release
`0.1.0+ww1.896a3f63e397`. Sakura is reachable, but its old runtime cannot link
because WorkWire correctly requires an exact build match. The canonical archive
has already been staged at:

`/home/hinoki/WorkWire/dist/ww/ww-linux-x64.tar.gz`

Do not rebuild, edit source, change pairing, create a new identity, or modify any
feature/TODO Markdown. Install the staged bytes, verify the link, and report.

## 1. Confirm this is Sakura and verify the staged archive

```bash
hostname
sha256sum "$HOME/WorkWire/dist/ww/ww-linux-x64.tar.gz"
```

The SHA-256 must be exactly:

`7eaf3e8acec4130bab1c4fa68acd0be16d879025ae6fe55ac2b58d71c55a462e`

If the file is missing or the hash differs, stop and report the exact result.
Do not install a different archive and do not rebuild locally.

## 2. Install the canonical packaged runtime

Keep Sakura's existing machine identity, trust, config, portal, and user files.
The portal root is `~/WorkWire`; runtime state is `~/WorkWire/.workwire`; the
visible user workspace is `~/WorkWire/Portal`.

```bash
(
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  tar -xzf "$HOME/WorkWire/dist/ww/ww-linux-x64.tar.gz" -C "$tmp"
  WW_HOME_DIR="$HOME/WorkWire/.workwire" \
  WW_CONFIG_DIR="$HOME/WorkWire/.workwire/config" \
  WW_PORTAL_PATH="$HOME/WorkWire" \
    "$tmp/ww/install-ww.sh"
)
```

Do not run `ww pair`; the existing HINOKI/Sakura trust must be preserved.

## 3. Verify Sakura is running the canonical runtime

```bash
systemctl --user is-active workwire-ww.service
curl -fsS "http://127.0.0.1:4851/v1/discover" | python3 -m json.tool
tail -40 "$HOME/WorkWire/.workwire/config/ww.log"
```

Required results:

- service state is `active`;
- service name is `Sakura`;
- app version is exactly `0.1.0+ww1.896a3f63e397`;
- portal is `/home/hinoki/WorkWire`;
- portal environment is `/home/hinoki/WorkWire/Portal`.

If port 4851 is occupied by a stale manually started WorkWire process, stop only
that stale process, restart `workwire-ww.service`, and repeat this verification.
Do not kill unrelated Electron or Node processes.

## 4. Let the matched services restore the shared source tree

HINOKI is `192.168.8.104`. Once both services advertise the exact same app and
protocol versions, the authenticated mirror resumes automatically. First verify
HINOKI's advertised build:

```bash
curl -fsS "http://192.168.8.104:4851/v1/discover" | python3 -m json.tool
```

It must also report `0.1.0+ww1.896a3f63e397`. Then wait for WorkWire to finish
reconciling the checkout. Do not copy the repository by SSH, Git, USB, or an
ad-hoc command. Watch the WorkWire log instead:

```bash
tail -f "$HOME/WorkWire/.workwire/config/ww.log"
```

Stop following the log after it reports the mirror linked with HINOKI and file
copy activity has settled. Then verify Sakura's checkout computes the same
runtime identity:

```bash
cd "$HOME/WorkWire"
node --input-type=module -e 'import { WW_APP_VERSION } from "./lib/ww-compat.mjs"; console.log(WW_APP_VERSION)'
```

The output must be exactly `0.1.0+ww1.896a3f63e397`. If it is not, leave the
packaged service running, do not switch launchers, and report the mismatch.

## 5. Bind Sakura's development launchers to the mirrored checkout

Only after Step 4 reports the exact source version, point both launch names at
the checkout launcher and restart the service once:

```bash
ln -sfn "$HOME/WorkWire/scripts/launch-workwire.sh" "$HOME/.local/bin/ww"
ln -sfn "$HOME/WorkWire/scripts/launch-workwire.sh" "$HOME/.local/bin/workwire"
systemctl --user daemon-reload
systemctl --user restart workwire-ww.service
```

Verify the permanent development wiring:

```bash
readlink -f "$HOME/.local/bin/ww"
readlink -f "$HOME/.local/bin/workwire"
systemctl --user is-active workwire-ww.service
curl -fsS "http://127.0.0.1:4851/v1/discover" | python3 -m json.tool
```

Both launchers must resolve to
`/home/hinoki/WorkWire/scripts/launch-workwire.sh`, the service must remain
active, and Sakura must still advertise `0.1.0+ww1.896a3f63e397`.

## 6. Prove real transfer and mirroring work

Open WorkWire once with `ww`. Confirm the two panes link without a version or
pairing warning. In `Portal/`, create a small disposable file named
`WW-SAKURA-LINK-CHECK.txt`, confirm it appears on HINOKI, then delete it through
WorkWire and confirm that deletion propagates. Do not use a feature document as
the test file.

Normal source edits under `~/WorkWire` should now mirror between both checkouts
while the two services remain version-compatible. If a future runtime change is
activated on only one PC, exact-version protection will pause the link again;
activate the same tested release on both PCs together. Never solve that guard by
weakening compatibility checks, sharing machine identities, exposing remote
shell execution, or copying secrets.

## 7. Report only the verified outcome

Report:

1. staged archive SHA-256;
2. installed Sakura app version;
3. HINOKI app version;
4. computed Sakura source version;
5. both launcher targets;
6. service state and canonical port;
7. whether the disposable create/delete transfer passed;
8. any exact failure, if one occurred.

Do not commit, push, rebuild, re-pair, or change feature documentation.
