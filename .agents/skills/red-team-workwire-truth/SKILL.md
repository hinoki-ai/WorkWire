---
name: red-team-workwire-truth
description: Adversarially falsify important WorkWire completion, security, reliability, identity, recovery, and contract claims inside the single pursue-workwire-goals lifecycle. Use for red-team, attack, break, prove, negative-path, failure-injection, race, replay, restart, recovery, idempotency, authentication, authorization, entitlement, credential, path-containment, device-identity, stale-data, duplicate or out-of-order command, migration, corruption, rollback, reconstruction, dependency provenance, install-hook, new endpoint, renderer IPC, release, watchdog, and Linux/Windows/Electron/API parity reviews. Keep review and diagnosis read-only by default; allow mutation only for explicit attack-and-fix work.
---

# Red-Team WorkWire Truth

Try to falsify material WorkWire assumptions before reality does. Prove both
permitted behavior and forbidden behavior without manufacturing a
vulnerability or damaging operator data.

## Stay inside the WorkWire lifecycle

Apply this skill as an assurance pass inside the single lifecycle established
by `pursue-workwire-goals`. Do not create a second bootstrap, first pass,
clarification gate, plan, queue, or handoff document. Read `AGENTS.md`, then
`docs/AGENT-OPERATIONS.md`, then the smallest relevant contract and affected
code/tests. Treat code, tests, live inventory, and authoritative service state
as implementation truth.

Keep review and diagnosis read-only by default. “Attack,” “break,” and “prove”
authorize isolated observation and reversible local experiments, not product,
remote-machine, disk, or production mutation. For explicit attack-and-fix
work, pair this skill with `pursue-workwire-goals`, preserve the finding first,
repair the verified root cause, and rerun the same adversarial proof.

Read [references/adversarial-proof-contract.md](references/adversarial-proof-contract.md)
before mapping a nontrivial attack surface, assigning a finding, or deciding
release disposition.

Keep one ephemeral coverage ledger nested under the shared requirement ledger.
For each claim, record the applicable WorkWire domain, invariant, highest-value
hypothesis, positive oracle, negative oracle, evidence class, result, and
remaining untested boundary. Do not persist it as a repository document.

## Run the falsification pass

1. State the exact completion, safety, identity, or recovery claim under attack.
2. Derive the smallest invariants that must hold.
3. Map only relevant entry points, trust boundaries, state transitions,
   effects, observers, and recovery paths.
4. Rank hypotheses by impact, reachability, truth risk, and proof cost.
5. Attempt the highest-value falsification first with an isolated fixture,
   temporary state, dry run, mock transport, or reversible local experiment.
6. Exercise the permitted success path and forbidden path against the same
   invariant.
7. Observe authoritative state, not only return codes, UI text, logs, mocks,
   or test names.
8. Classify each hypothesis as confirmed defect, supported risk, disproved, or
   untested surface.
9. Stop only when each material applicable invariant has decisive evidence or
   is named as residual untested scope. Never claim clearance while a required
   high-impact surface remains untested.

Cover only applicable failure classes:

- Invalid, missing, stale, duplicated, reordered, or replayed inputs.
- Concurrent commands, retries, partial writes, interrupted transactions,
  journal corruption, checksum failure, and idempotency loss.
- Restart, lease loss, checkpoint gaps, rollback, reconstruction, schema
  mismatch, and watchdog recovery.
- Authentication bypass, device mismatch, confused deputy behavior,
  cross-machine replay, revoked entitlement, and service-identity drift.
- Credential leakage through logs, clients, files, errors, IPC, telemetry,
  process arguments, or dependency behavior.
- Path traversal, symlink escape, unsafe shell argv, privilege confusion, and
  wrong-disk selection.
- Conflict-copy execution or packaging, stale source archives, mismatched
  release/update hashes, and installer rollback failure.
- Linux, Windows, Electron, recovery-agent, controller, and client parity
  drift in state, action, error, and recovery behavior.
- Dependency, install-hook, endpoint, listener, dynamic execution, opaque
  payload, and repository integrity boundary violations.
- Tests that pass while the owned state transition, rejection, side-effect
  absence, or recovery path remains unproved.

## Preserve safety and evidence

Never run destructive fault injection against an operator machine, valuable
disk, production path, or live fleet state. Use generated fixtures, disposable
directories, loop/QEMU media, temporary local copies, mock transports, and
explicit cleanup. If a request names Sakura or its disk, use only the live
identity and storage inventory required by the WorkWire contract; never guess
from HINOKI's local view and never select the Windows partition when excluded.

Record the command or procedure, fixture identity, pre-state, observed state,
post-state, authoritative oracle, and cleanup needed to reproduce a result.
Redact secret values while preserving the existence and location of any leak.
Do not infer absence from missing logs or a passing happy path.

Review behavior, not authorship or intimidating vocabulary. Use only the
severities `note`, `flag`, and `hard-flag` when the WorkWire contract defines
an acknowledgement gate. Assign no severity to a supported risk, disproved
hypothesis, untested surface, or benign reviewed behavior. Preserve and report
flagged evidence before any authorized repair. Do not apply, build, commit,
release, or install a flagged change.

## Report proof without inflation

Separate confirmed defects, supported risks, disproved hypotheses, and
untested surfaces. For every confirmed finding report:

- Exact file and line.
- Violated invariant.
- Reachable failure mechanism.
- Evidence and reproduction.
- Severity.
- Applicable WorkWire policy tripwire, or `none`.
- Likely benign explanation for a policy match.
- Likely impact.
- Narrowest root-cause repair.
- Positive regression proof.
- Negative proof.
- Remaining uncertainty.

Use “not observed,” “disproved,” and “unproved” precisely as defined in the
bundled contract. Do not claim a surface safe because no defect was found
outside the tested scope.

For attack-and-fix work, rerun the original reproduction, permitted path,
forbidden path, and affected contract/client-parity proof after repair. Inspect
the final change for secrets, conflict artifacts, new outbound destinations,
weakened safeguards, and scope drift. Resolve each confirmed finding as
`open`, `repaired and reproved`, or `contained but unresolved`.
