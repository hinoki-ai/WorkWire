# WorkWire

[![CI](https://github.com/hinoki-ai/WorkWire/actions/workflows/ci.yml/badge.svg)](https://github.com/hinoki-ai/WorkWire/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

WorkWire is a local-first desktop and command-line tool for managing your own
machines over a LAN. It combines file transfer and synchronization with
privileged recovery agents for shell access, imaging, provisioning, and recovery.

**Early public preview.** Start with disposable files and independent backups.
The recovery agents run with root or LocalSystem authority. Use trusted machines
on a trusted LAN; do not expose the services directly to the internet.

- [Download source previews](https://github.com/hinoki-ai/WorkWire/releases)
- [Report a bug or request a feature](https://github.com/hinoki-ai/WorkWire/issues/new/choose)
- [Contribute](CONTRIBUTING.md) · [Security](SECURITY.md)

## Try from source

Use Linux with Git, Node.js 22 or newer, and npm. Windows recovery-agent
instructions are in [docs/RECOVERY.md](docs/RECOVERY.md). Desktop use requires
a graphical session and Electron's operating-system libraries.

```sh
git clone https://github.com/hinoki-ai/WorkWire.git
cd WorkWire
npm ci --ignore-scripts
node ww.mjs --help
```

The install command skips hooks so it does not install launchers or start a
persistent service. To download Electron and open the desktop:

```sh
node node_modules/electron/install.js
npm start
```

Use a separate clone and disposable data on each machine. See
[the file-desk guide](docs/WW.md) for pairing and synchronization. Operational
documents contain the maintainer's fleet-specific examples; substitute your own
configuration rather than running those commands verbatim.

The repository root is the development portal. WorkWire mirrors ordinary files and source changes while reserving local control/build trees such as `.workwire/`, `.git/`, `link/`, `dist/`, `runtime/`, and `node_modules/`. The desktop desk shows only the portal environment (`Portal/` inside the root); the rest of the root is backend-only and never appears in the frontend.

## Optional local installation

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

## Verification and performance

For a managed Linux/Windows fleet, run the redacted health gate after a
deployment:

```bash
npm run doctor:fleet -- --json
```

The physical acceptance lanes are available separately when both paired
machines are online: `npm run test:fleet-e2e`, `npm run test:fleet-4g`,
`npm run test:fleet-recovery`, `npm run test:fleet-watchdogs`, and
`npm run test:fleet-windows`. Their required environment, ordering, and
evidence rules are defined in [docs/AGENT-OPERATIONS.md](./docs/AGENT-OPERATIONS.md).

Run the local performance gate with:

```bash
npm run perf:all
# short smoke run
npm run perf:all -- --quick
```

It writes fresh measurements under `performance-results/latest`. The qualified
baseline, budgets, and interpretation notes are in
[docs/PERFORMANCE-GATE.md](./docs/PERFORMANCE-GATE.md).

## License

WorkWire is open source under the [MIT License](./LICENSE). Third-party
dependencies retain their own licenses.
