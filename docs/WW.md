# WorkWire operations

## System model

Each computer runs one authenticated HTTP filesystem service and, when opened, one sandboxed Electron desk. UDP beacons advertise the current service address and port. A paired machine is accepted only when its bearer trust, pinned machine identity, protocol version, and exact WorkWire build agree.

WorkWire also contains a separate LAN recovery subsystem on ports 4852/4853. It does not reuse the file service's peer trust or filesystem boundary. Its root agents, durable cases, PXE live environment, and operational safety model are documented in [RECOVERY.md](./RECOVERY.md).

The repository launcher uses the checkout itself as its portal root. A packaged installation uses `~/.local/opt/workwire/app` unless `WW_PORTAL_PATH` explicitly selects another root. Both computers must use the intended corresponding root.

The desktop desk browses only the portal environment, the `Portal/` directory inside the portal root. It is created automatically on both machines, both panes are clamped to it (navigation, launch intents, and saved paths that fall outside it snap back to `Portal/`), and everything else in the root stays backend-only: reachable by the service, the mirror, and the CLI, but never shown in the frontend. User files exchanged through the desk therefore live under `Portal/` and are mirrored like any other portal content.

`Explore This PC` and `Explore Other PC` open copy-only file browsers outside the corresponding portal. Select files or folders and choose `Bring into Portal`; WorkWire copies them into the currently open folder on This PC's `Portal/` pane. The source is never moved or deleted, and normal portal synchronization can then carry the imported content to the paired PC. Remote machine scope exposes only list, stat, manifest, and download operations, and the service accepts it only from the bearer-authenticated, pinned peer machine ID. The `Disks` action reaches filesystem roots (and Windows drive roots).

The background mirror elects exactly one of the two machine IDs as the active synchronizer. This avoids two mirror engines racing over the same change. It refreshes its route from authenticated-compatible beacon data, so DHCP changes and fallback ports do not require a restart.

## Synchronization and conflicts

Ordinary files and directories are synchronized recursively, including deletions. Symbolic links are intentionally ignored and cannot be transferred through the service.

These root names are excluded from the portal-scope API and background mirror:

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
- Whole-machine scope is read-only (list, stat, manifest, and download), requires the bearer token plus the pinned peer machine ID, and is never accepted before pairing.
- Requests require the shared bearer token and the pinned peer machine ID after pairing.
- JSON requests, headers, and transfers have bounded sizes or timeouts.
- WorkWire is intended for a trusted private LAN; the LAN publisher is HTTP, so use a trusted network and verify the displayed checksum when transporting artifacts outside that LAN.
- The optional Recovery workspace is intentionally root-equivalent on its targets. Keep recovery ports on the operator-owned wired lab LAN and consult [RECOVERY.md](./RECOVERY.md) before enabling PXE or destructive actions.

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
