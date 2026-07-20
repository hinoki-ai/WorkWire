# WorkWire — the Agentic Archon

WorkWire is the Agentic Archon: a local-first authority for operator-owned
machines, exercised through trusted privileged agents on the LAN. It exposes
the capabilities needed to act on those machines—filesystem access, file
operations, synchronization, continuity, imaging, provisioning, salvage,
shell execution, recovery, and fleet control—from one system.

The historical file desk was the capability WorkWire grew from. It remains
useful, but it is not the product identity.

For the investor-facing, evidence-grounded product and technology profile, see
[workwire.md](./workwire.md).

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
