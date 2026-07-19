# WorkWire

WorkWire keeps two Linux WorkWire roots synchronized over a trusted LAN and provides a two-pane Electron desk for browsing and manual transfers.

The repository root is the development portal. WorkWire mirrors ordinary files and source changes while reserving local control/build trees such as `.workwire/`, `.git/`, `link/`, `dist/`, `runtime/`, and `node_modules/`. The desktop desk shows only the portal environment (`Portal/` inside the root); the rest of the root is backend-only and never appears in the frontend.

## Start

```bash
npm ci
npm test
npm run ww
```

Install the launchers and persistent user service:

```bash
npm run install
npm run autostart
```

Build or publish the self-contained Linux release:

```bash
npm run dist:linux
npm run ww:lan-installer
```

The supported commands are `workwire` and `ww`. See [docs/WW.md](./docs/WW.md) for file-desk architecture, installation, security, conflict behavior, and operations. See [docs/RECOVERY.md](./docs/RECOVERY.md) for the separate root-capable LAN recovery controller, agents, Electron workspace, PXE live environment, autonomy, and QEMU validation.

Recovery quick check:

```bash
ww recovery controller status
ww recovery agents
```
