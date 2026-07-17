# WorkWire operations

## System model

Each computer runs one authenticated HTTP filesystem service and, when opened, one sandboxed Electron desk. UDP beacons advertise the current service address and port. A paired machine is accepted only when its bearer trust, pinned machine identity, protocol version, and exact WorkWire build agree.

The repository launcher uses the checkout itself as its portal root. A packaged installation uses `~/.local/opt/workwire/app` unless `WW_PORTAL_PATH` explicitly selects another root. Both computers must use the intended corresponding root.

The background mirror elects exactly one of the two machine IDs as the active synchronizer. This avoids two mirror engines racing over the same change. It refreshes its route from authenticated-compatible beacon data, so DHCP changes and fallback ports do not require a restart.

## Synchronization and conflicts

Ordinary files and directories are synchronized recursively, including deletions. Symbolic links are intentionally ignored and cannot be transferred through the service.

These root names are local-only and inaccessible through the WorkWire API:

- `.workwire/`
- `.codex/`
- `.git/`
- `dist/`
- `link/`
- `node_modules/`
- `runtime/`

Atomic upload artifacts are hidden at every depth. If both computers change the same path between mirror cycles, the newer modification wins; an exact-time tie is resolved by stable machine ID ordering. Before replacement, WorkWire preserves the losing content beside the original as `<name> (WW conflict <id>-<time>)<extension>` and then synchronizes that conflict copy too.

The desk also supports explicit copy or move operations with rename, overwrite, or skip behavior. Keyboard shortcuts are:

- `Tab`: switch pane
- `Ctrl/Cmd+A`: select visible items
- `Ctrl/Cmd+L`: retry linking
- `F5`: copy selection
- `F6`: move selection
- `F9`: refresh both panes
- `Escape`: clear selection or message

## Development installation

```bash
npm ci
npm test
npm run install
npm run autostart
```

The source launchers are `workwire` and `ww`. The user service is `workwire-ww.service`.

Useful checks:

```bash
systemctl --user status workwire-ww.service
journalctl --user -u workwire-ww.service -f
ww config
```

`ww config` redacts secrets unless the engineering-only `--show-secrets` flag is supplied.

## Production distribution

Build a self-contained Linux bundle:

```bash
npm run dist:linux
```

Or publish the LAN installer:

```bash
npm run ww:lan-installer
```

The published page provides an AppImage, stable and versioned archives, a manifest, and SHA-256 checksums. Install from the displayed address:

```bash
curl -fsSL http://<workwire-host>:8765/install.sh | bash
```

The installer verifies the selected archive, rejects unsafe archive paths and symlinks, stages updates atomically, and restores the previous installation if a later step fails. Install the exact same generated release on both computers before restarting either service.

Pairing profiles are applied with:

```bash
ww pair /path/to/workwire-pairing.json
```

Pairing replaces shared trust but preserves the local machine identity.

## Security boundary

- Config and mirror state directories are mode `0700`; files containing trust material are mode `0600`.
- Service tokens are not returned to the renderer or placed in automatic desktop-launch command arguments.
- Electron uses context isolation, sandboxing, no Node integration, denied permission requests, blocked navigation/new windows, a private app protocol, and a restrictive content security policy.
- Packaged builds disable Run-as-Node, Node option/inspector injection, and privileged `file:` behavior while enabling cookie encryption, ASAR-only loading, and embedded ASAR integrity validation.
- Filesystem paths are lexical- and realpath-checked against the portal root; symlink escapes and portal-root mutation are blocked.
- Requests require the shared bearer token and the pinned peer machine ID after pairing.
- JSON requests, headers, and transfers have bounded sizes or timeouts.
- WorkWire is intended for a trusted private LAN; the LAN publisher is HTTP, so use a trusted network and verify the displayed checksum when transporting artifacts outside that LAN.

## Release verification

Before deploying:

```bash
npm ci
npm test
npm audit
npm run dist:linux
```

Confirm both machines advertise the same `versions.app`, `versions.protocol`, and trust ID through `/v1/discover`. Then verify a create, edit, rename, deletion, and deliberate simultaneous-edit conflict in a disposable folder.

## Limits

- WorkWire does not follow or copy symbolic links.
- Mirror equality uses item kind, file size, and rounded modification time; it does not hash every file on every 1.5-second scan.
- The service is designed for two paired machines, not a multi-peer mesh or an untrusted internet.
