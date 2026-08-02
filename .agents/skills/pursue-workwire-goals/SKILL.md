---
name: pursue-workwire-goals
description: Execute and orchestrate goals in /home/hinoki/WorkWire from read-only reconnaissance through implementation, recovery, verification, preservation, and concise handoff. Use for WorkWire requests to build, fix, diagnose-and-fix, research, optimize, finish, deploy, install, babysit, continue, or persist. Enforce one immediate clarification gate after the first evidence pass and before mutation, delegation, long-running work, or external effects; compose compound-workwire-edge for broad allocation and red-team-workwire-truth for adversarial assurance without starting another lifecycle.
---

# Pursue WorkWire Goals

Carry the operator's requested WorkWire outcome to verified completion. Treat
code, tests, live service state, and authoritative inventory as implementation
truth. Treat `AGENTS.md` and `docs/AGENT-OPERATIONS.md` as repository
authority. Never weaken an identity, credential, path-containment,
data-integrity, recovery, release, or destructive-scope gate.

## Run the one-way state machine

Use this sequence exactly once per task:

```text
BOOTSTRAP -> FIRST PASS -> EARLY GATE -> EXECUTE <-> VERIFY/RECOVER -> PRESERVE -> HANDOFF
```

Never return to `EARLY GATE` after `EXECUTE` begins. Never substitute a plan,
review, or progress report for an authorized implementation. Do not stop
because work is difficult, novel, large, slow, or imperfect. Stop only at
verified completion or a concrete hard stop named by repository authority.

## Compose specialists without multiplying control planes

Keep this skill as the sole lifecycle owner. Begin
`compound-workwire-edge` during `FIRST PASS` when several materially different
initiatives compete or allocation must be decided before implementation. Use
only existing local evidence during that pass. Use
`red-team-workwire-truth` as the verification lens for adversarial requests or
material security, identity, recovery, dependency, release, or parity claims.

For broad work that needs assurance, sequence:

```text
compound decision -> bounded execution -> adversarial proof -> repair/reproof
```

For ordinary bounded work, use only this skill. Share one requirement ledger,
one early gate, one execution state, and one final handoff across specialists.
Never create a master skill, second lifecycle, second gate, or parallel queue.

| Task shape | One-lifecycle composition |
|---|---|
| Bounded ordinary work | `pursue` |
| Broad decision only | `pursue -> compound packet -> pursue handoff` |
| Broad decision plus implementation | `pursue -> compound packet -> pursue execution` |
| Read-only adversarial review | `pursue -> red-team proof -> pursue handoff` |
| Attack-and-fix | `pursue -> red-team reproduction -> pursue repair -> red-team reproof` |
| Broad allocation, assurance, and repair | `pursue -> compound packet -> pursue execution -> red-team proof -> pursue repair -> red-team reproof` |

## Bootstrap from repository authority

Resolve the repository root as `/home/hinoki/WorkWire`. Read `AGENTS.md`
completely, then `docs/AGENT-OPERATIONS.md` completely. Read the smallest
relevant contract, affected code, tests, and documentation map. Run the
mandated pre-change status and relevant structure checks before mutation.
Record unrelated dirty state without exposing possible secrets. Preserve all
unrelated operator work.

If a request names Sakura, Sakura's disk, or a secondary disk on Sakura,
perform live remote inventory and prove the stable physical identity before
selecting any target. Never infer remote disk absence from HINOKI's `lsblk`.
Capture filesystem, label, UUID, size, model, serial, and mount state before
creating data there. Explicitly exclude Sakura's Windows partition when the
request names a non-Windows disk. Do not power Sakura off.

Use WorkWire's managed namespace for fleet evidence:

```bash
export WW_PORTAL_PATH=/home/hinoki/WorkWire
export WW_HOME_DIR=/home/hinoki/WorkWire/.workwire
export WW_CONFIG_DIR=/home/hinoki/WorkWire/.workwire/config
```

Never print, commit, pass in argv, or place pairing material, credentials, or
protected machine state in documentation. Preserve `WW conflict` copies as
recoverable evidence; never execute, stage, package, or ship them.

Define completion from the user's requested outcome, repository contracts, and
required proof. Keep an ephemeral requirement ledger in task state. For every
deliverable, invariant, named artifact, command, and proof obligation, record
its owner, decisive evidence, and state as `missing`, `contradicted`, `weak`,
or `proved`. Do not persist that ledger as a new repository document.

## Complete one bounded first pass

Inspect existing implementations, call sites, tests, configuration, recent
relevant history, and the first dependency layer. Search local code and
documentation before external research. Resolve paths, commands, conventions,
and likely intent from evidence.

Classify uncertainty:

- Resolve discoverable uncertainty with tools.
- Choose a reversible repository-consistent default for implementation detail.
- Reserve a question for a choice that changes authority, machine or disk
  target, destructive scope, credential access, entitlement, licensing, or
  another hard boundary.

Do not mutate code, start long-running processes, delegate, or open browser
sessions during this pass. Do not ask a question before the pass is complete.

## Close the only clarification gate immediately

Evaluate all remaining authority-changing uncertainties together immediately
after `FIRST PASS`. Ask no preference question, no question already resolved
by a clear imperative, and no question merely to reduce effort. If a concrete
hard boundary is genuinely blocked, state the exact decision and the
materially different consequences, then wait. Otherwise enter `EXECUTE`
immediately.

## Execute autonomously

Implement the full in-scope result with the smallest coherent changes. Follow
repository patterns unless evidence proves them inadequate. Run narrow proofs
after risky increments. Diagnose the first failure, change method after a
repeated failure, and repair causes rather than symptoms. Keep safe independent
work moving when one branch is blocked.

Remote, privileged, destructive, release, or external actions require exact
scope from the request and live authoritative targeting. Do not expand into
unrelated machines, disks, paths, services, accounts, or data. Never expose
credentials. Never bypass path containment, device identity, service auth,
release hashes, recovery semantics, or explicit `force` rules.

## Keep delegated work autonomous

Delegate only bounded independent work after the early gate. Give the delegate
the exact objective, allowed scope, owning files, constraints, and proof.
Require local resolution of ordinary ambiguity and immediate escalation of a
true hard gate. Integrate and inspect delegated output yourself. A completion
claim is never terminal truth.

## Recover without reopening the question gate

After `EXECUTE` begins, resolve late ambiguity from code, tests, contracts,
history, or the safest reversible assumption. Contain a concrete hard stop,
exhaust safe local alternatives, and complete every independent in-scope
branch. Do not leave work idle on a stale question or claim completion while
required proof fails.

For planned service or agent restarts, check live state before retrying. Do
not infer success from transport loss. For convergence, preserve replaced
material in recoverable backups and verify postconditions from the stable
service or agent identity, exact release, privilege, hash, and authoritative
state.

## Verify the requested truth

Run the narrowest meaningful test for each changed behavior. For WorkWire code,
normally run the focused test file first, then `npm test` when changes cross
shared behavior. For packaging or release work, run the required source/image
package checks and conflict-artifact audit from `docs/AGENT-OPERATIONS.md`.
For managed fleet work, use `npm run doctor:fleet -- --json` and only the
physical acceptance lanes required by the changed claim.

Verify both desktop/client surfaces when a user-visible contract changes.
Inspect the final diff for secret candidates, conflict basenames, unpinned
identities, accidental endpoints, weakened tests, and scope drift. Run
`git diff --check`. Reconcile the final implementation against the
requirement ledger item by item. Treat indirect, stale, incomplete, or
scope-mismatched evidence as `weak`, not `proved`.

Enter `PRESERVE` only when every required item is proved and no required work
remains. If a required physical or release proof is unavailable, report the
exact unproved gate rather than relabeling a simulation as physical evidence.

## Preserve and hand off once

Preserve user work and recoverable backups. Do not commit, push, install,
release, or power off a machine unless the request and repository contract
authorize that action. Do not delete unknown user data or discard conflict
copies.

Return one self-contained handoff. Lead with the achieved outcome. Name
changed files, decisive proof, and one exact remaining hard stop if present.
State which evidence is local, managed-fleet, or physical. Do not offer a
speculative queue when the goal is complete.
