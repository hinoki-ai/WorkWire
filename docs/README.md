# WorkWire documentation map

This is the canonical index of every WorkWire document: the reading order, the
authority hierarchy, and the status of each file. When two documents disagree,
the authority order below decides.

## Authority hierarchy

1. **[AGENT-OPERATIONS.md](./AGENT-OPERATIONS.md)** — the authoritative
   agent-to-agent operations contract: live fleet state, convergence, required
   proofs, and the power/shutdown gate. Remembered addresses and historical
   handoffs never override it.
2. **The capability specifications below** — the current design and behavior of
   each subsystem.
3. **Historical handoffs and archived evidence** — how the system was built and
   proven. Reference only; never current configuration.

## Start here

| Document | Purpose |
| --- | --- |
| [../README.md](../README.md) | Repository entry point: install, run, verify. |
| [../workwire.md](../workwire.md) | Canonical product & technology profile (investor-facing) with measured evidence. |
| [AGENT-OPERATIONS.md](./AGENT-OPERATIONS.md) | **Authoritative** autonomous fleet runbook: `DISCOVER → BUILD → CONVERGE → PROVE → RELEASE → COMMIT → POWER_OFF`. |

## Capability specifications

| Document | Subsystem |
| --- | --- |
| [WW.md](./WW.md) | Paired file desk: Archon system model, sync/conflict semantics, security boundary, limits. |
| [RECOVERY.md](./RECOVERY.md) | Root/SYSTEM recovery plane: agents, durable cases, PXE live environment, Wake-on-LAN, safety model. |
| [CONTINUITY.md](./CONTINUITY.md) | Continuity history + content-addressed recovery vault (P1). |
| [POWERHOUSE.md](./POWERHOUSE.md) | Sync Engine, imaging/deployment, and priority-first salvage data engines (P2). |
| [COMMANDER.md](./COMMANDER.md) | Fleet command: rollouts, interactive terminals, tunnels, evidence-driven autonomy (P3). |
| [PERFORMANCE-GATE.md](./PERFORMANCE-GATE.md) | Performance baseline, budgets, and interpretation (status: complete — qualified pass). |

## Windows / Sakura fleet

| Document | Purpose |
| --- | --- |
| [../windows/WINDOWS.md](../windows/WINDOWS.md) | HINOKI → Sakura Windows fleet contract and entry point. Defers to AGENT-OPERATIONS.md. |
| [../windows/SAKURA-WINDOWS-AND-WOL-HANDOFF.md](../windows/SAKURA-WINDOWS-AND-WOL-HANDOFF.md) | **Archived evidence.** Earlier Windows/BIOS/Wake-on-LAN experiments; not current configuration. |

## Live operational log

[`linkfail.md`](../linkfail.md) is the canonical living document for the
recurring HINOKI ↔ Sakura link failure: both planes' architecture, why every
root cause collapses into one silent UI message, the classifier/probe design,
ranked fixes, an occurrence ledger, and the merged self-healing work plan
(Appendix A, formerly `NEXTTODO.md`).

| Document | Purpose |
| --- | --- |
| [../linkfail.md](../linkfail.md) | Canonical link-failure investigation, live occurrence ledger, and self-healing work plan. |

## Historical handoffs & evidence (reference only)

The recovery subsystem's original implementation handoff/spec
(`RECOVERY-PORTAL-TODO.md`) has been retired now that the work shipped; its
living successor is [RECOVERY.md](./RECOVERY.md), and the full text remains in
git history.

| Document | Purpose |
| --- | --- |
| [../handoff/next-stage/p1.md](../handoff/next-stage/p1.md) | P1 mission prompt (continuity/vault). Result: [CONTINUITY.md](./CONTINUITY.md). |
| [../handoff/next-stage/p2.md](../handoff/next-stage/p2.md) | P2 mission prompt (sync/imaging/salvage). Result: [POWERHOUSE.md](./POWERHOUSE.md). |
| [../handoff/next-stage/p3.md](../handoff/next-stage/p3.md) | P3 mission prompt (fleet command). Result: [COMMANDER.md](./COMMANDER.md). |
| [../handoff/next-stage/results/fleet-final.md](../handoff/next-stage/results/fleet-final.md) | **Authoritative** final release + physical two-machine proof. |
| [../handoff/next-stage/results/](../handoff/next-stage/results/) | Per-phase progress/final records and benchmark JSON evidence. |
| [../handoff/recovery-subsystem/FINAL-PROMPT-RECOVERY.md](../handoff/recovery-subsystem/FINAL-PROMPT-RECOVERY.md) | Completed recovery-subsystem takeover handoff. |
| [../handoff/sakura-link/FINAL-PROMPT-SAKURA.md](../handoff/sakura-link/FINAL-PROMPT-SAKURA.md) | Completed Sakura-link activation handoff. |

## Conventions

- **Physical names identify machines.** This workspace is on HINOKI; Sakura is
  the separate Dell OptiPlex 990 reached over LAN. A Sakura disk request is a
  remote operation and must follow the live identity and disk-proof rules in
  `AGENT-OPERATIONS.md`; local mount-point names are not identity evidence.
- **Secrets never appear in documentation.** Tokens, passwords, and pairing
  material live only in mode-restricted local files or protected machine state.
- **`WW conflict` copies are disposable.** The background mirror preserves the
  losing side of a simultaneous edit as `<name> (WW conflict <id>-<time>)<ext>`.
  These are gitignored local convergence evidence, never source inputs;
  packaging and image verification reject them independently of `.gitignore`.
- **Live addresses are observations, not identity.** Resolve HINOKI/Sakura
  addresses from the default route and live recovery/L2 state; never hardcode a
  remembered IP. ICMP is not an availability gate.
- **Historical documents carry a status banner** and point to their current
  successor. Do not read a banner-marked handoff as pending work.
