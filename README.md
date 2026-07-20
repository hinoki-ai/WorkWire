# WorkWire

WorkWire keeps Linux and Windows roots synchronized over a trusted LAN and provides a two-pane Electron desk, durable continuity/vault services, high-performance sync and imaging engines, and a root/SYSTEM recovery command plane.

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

The supported commands are `workwire` and `ww`. Autonomous fleet agents start with [docs/AGENT-OPERATIONS.md](./docs/AGENT-OPERATIONS.md). See [docs/WW.md](./docs/WW.md) for file-desk architecture and [docs/RECOVERY.md](./docs/RECOVERY.md) for the root/SYSTEM recovery plane. [docs/CONTINUITY.md](./docs/CONTINUITY.md), [docs/POWERHOUSE.md](./docs/POWERHOUSE.md), and [docs/COMMANDER.md](./docs/COMMANDER.md) specify the P1–P3 capability surfaces.

Recovery quick check:

```bash
ww recovery controller status
ww recovery agents
```
