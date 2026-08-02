# WorkWire adversarial proof contract

Use this contract to turn a WorkWire completion, safety, identity, or recovery
claim into bounded falsification evidence. Keep experiments isolated,
reversible, and local unless the request explicitly authorizes the exact
managed-fleet proof.

## Contents

- [Evidence classes](#evidence-classes)
- [Attack-surface map](#attack-surface-map)
- [Domain matrices](#domain-matrices)
- [Hypothesis and falsification record](#hypothesis-and-falsification-record)
- [Policy mapping and severity](#policy-mapping-and-severity)
- [Positive and negative proof](#positive-and-negative-proof)
- [Finding contract](#finding-contract)
- [Finding lifecycle](#finding-lifecycle)
- [Decide disposition](#decide-disposition)
- [Use precise observation language](#use-precise-observation-language)

## Evidence classes

| Class | Evidence | Permitted claim |
|---|---|---|
| E0 | Untested hypothesis or intuition | Candidate attack only |
| E1 | Static code path, contract conflict, or provenance-bearing observation | Reachable or supported risk; not a confirmed defect |
| E2 | Deterministic isolated reproduction with authoritative pre-state and post-state | Confirmed behavior in the proved fixture |
| E3 | Representative integrated failure injection across the owning boundary | Confirmed behavior in the proved integrated regime |
| E4 | Repeated production-valid observation obtained without induced harm | Observed behavior for the recorded regimes |

Never upgrade evidence because a test name, mock, UI, log, or narrative implies
success. Never induce E4 evidence through destructive testing, credential use
outside scope, or unapproved remote mutation.

## Attack-surface map

Map the minimum causal chain needed to test the claim:

```text
actor/input -> entry point -> identity/auth/path validation -> trust boundary
-> ordering/validation -> durable state transition -> external effect
-> authoritative observer -> restart/recovery/reconciliation
```

For each included node, record its owning file or contract, accepted identity,
freshness or ordering rule, durable key, side effects, failure signal, and
recovery owner. Exclude unrelated surfaces. Expand one dependency layer only
when the hypothesis crosses it.

Rank a hypothesis higher when impact, reachability, or truth risk rises, or
when decisive proof is cheap. Prefer one discriminating experiment over many
shallow checks.

## Domain matrices

| Domain | Invariant | High-value attacks | Decisive observation |
|---|---|---|---|
| Identity | HINOKI and Sakura are selected by stable physical/service/agent identity | Hostname or cached-IP substitution, wrong agent, stale service pin | Live inventory and authenticated discovery match expected stable identity |
| Storage | Only the intended device/path is mutated and committed data is attributable and reconstructable | Wrong disk, Windows-partition selection, traversal, symlink escape, partial write, corruption | Device metadata, path containment, durable state, and hashes match before/after |
| Authentication | Protected actions require the expected token, device binding, privilege, and entitlement | Missing/changed token, cross-device replay, confused deputy, revoked peer | Forbidden request produces no protected read, write, or durable side effect |
| Recovery | Restart reconstructs only committed truth and exposes gaps | Kill between phases, lease loss, stale checkpoint, duplicate replay, missing journal | Reconstructed state matches durable events or fails closed with a visible gap |
| Fleet | Controller, file services, and agents preserve pinned IDs, versions, hashes, and roles | Split controller, stale release, watchdog drift, privilege confusion | Authenticated doctor and agent observation agree on release and role |
| Files | File operations preserve bytes, names, conflicts, and mirror semantics | Binary/Unicode edge, rename race, duplicate move, conflict overwrite | SHA-256, authoritative listing, conflict copy, and cleanup prove the result |
| Command | Shell/session/tunnel capabilities preserve scope, I/O, cwd, signal, and identity | Arg injection, replay, detach loss, stale session, cross-target tunnel | Exact target identity and authoritative command output match; forbidden scope is rejected |
| Release | Packaging and install preserve the exact source, hashes, safeguards, and recoverable rollback | Conflict artifact shipping, stale archive, install hook, failed activation | Archive/image/app audit finds required modules, exact hashes, and zero conflict artifacts |
| Dependency | Dependencies and install paths preserve known provenance and behavior | Typosquat/fork, unreviewed hook, new endpoint, opaque payload, dynamic load | Provenance, lock, hook, and runtime behavior match the established stack |
| Client parity | API, Linux/Electron, Windows, and recovery clients expose the same contract | Missing field/action/error, stale cache, optimistic UI, auth/recovery drift | Equivalent fixture yields equivalent state, action availability, rejection, and recovery |

## Hypothesis and falsification record

Use this compact record in task state or the final report; do not create a
repository queue or handoff file.

```text
claim: <behavior asserted complete or safe>
invariant: <truth that must always hold>
hypothesis: <reachable mechanism that would violate it>
surface: <entry -> boundary -> state/effect -> observer/recovery>
rank: <impact range; reachability; truth risk; proof cost>
fixture: <isolated inputs and authoritative starting state>
action: <bounded failure injection or adversarial input>
oracle: <authoritative positive and negative observations>
result: <confirmed defect | supported risk | disproved | untested surface>
evidence_class: <E0-E4>
cleanup: <temporary-state removal or none>
uncertainty: <what the proof does not cover>
```

A hypothesis is confirmed only when authoritative state violates the
invariant. Classify a reachable path without decisive execution evidence as a
supported risk. Classify a hypothesis as disproved only when its preconditions
were exercised and the authoritative oracle contradicted the predicted
failure. Classify inaccessible or unevaluated scope as an untested surface.

## Policy mapping and severity

Read the current WorkWire `AGENTS.md` and `docs/AGENT-OPERATIONS.md` before
classification. Use exact repository tripwires when present; common concrete
matches include:

| ID | Cue |
|---|---|
| W1 | Wrong physical machine or disk inferred or selected |
| W2 | Credential or pairing boundary violated, leaked, or weakened |
| W3 | Unauthenticated listener, unsafe dynamic execution, or arbitrary renderer IPC |
| W4 | False identity, privilege, hash, recovery, or fleet-health truth |
| W5 | Runtime-decoded opaque behavior, conflict artifact, or unproved payload |
| W6 | Unreviewed dependency, install hook, endpoint, or publisher change |
| W7 | Weakened test, lock, integrity, structure, ignore, or parity mechanism |
| W8 | Out-of-scope operator data, profile, session, disk, or machine access |

Use `note` for a confirmed non-policy defect. Use `flag` only for a concrete
policy tripwire. Use `hard-flag` only when current repository authority or
explicit operator disposition makes the confirmed finding acknowledgement-
gated before release or install. Never infer severity from alarming language,
impact speculation, or an unconfirmed path.

## Positive and negative proof

Define both before executing the attack:

```text
positive_proof:
  precondition: <valid identity, state, ordering, and freshness>
  action: <permitted operation>
  oracle: <authoritative transition and intended side effect>

negative_proof:
  precondition: <invalid, missing, stale, duplicate, replayed, reordered, or unauthorized condition>
  action: <same boundary under attack>
  oracle: <explicit rejection or fail-closed result plus absence of forbidden side effect>
```

Prove absence with an observable boundary: transport spy, durable-state
snapshot, unique idempotency key, ledger count, audit event, artifact audit,
device inventory, or recovery reconstruction. Do not use silence, missing
logs, UI text, or a passing happy path as negative proof. Recheck both proofs
after repair.

## Finding contract

Report every confirmed finding with:

```text
location: <exact file:line>
invariant: <violated truth>
mechanism: <reachable causal sequence>
evidence: <class, fixture, command/procedure, observed oracle>
severity: <note | flag | hard-flag>
policy: <none | exact W1-W8 or repository tripwire>
likely_benign: <required for a policy match; otherwise none>
status: <open | repaired and reproved | contained but unresolved>
impact: <identity, storage, auth, recovery, fleet, files, command, release, dependency, or parity consequence>
repair: <narrowest root-cause change>
repair_evidence: <patch or containment identity; none while open>
positive_regression: <permitted behavior proof>
negative_proof: <forbidden behavior rejection and side-effect absence>
uncertainty: <remaining untested boundary>
```

Keep supported risks separate from confirmed findings. Include every required
field adjacent to its finding. Do not manufacture line precision.

## Finding lifecycle

Use this one-way flow:

```text
hypothesis -> supported risk or decisive experiment -> confirmed defect
-> evidence preserved -> open or contained -> authorized repair -> reproved resolution
```

Keep the original finding immutable in meaning after confirmation. Call a
finding `repaired and reproved` only when the original reproduction no longer
violates the invariant, the permitted path still succeeds, the forbidden path
has no prohibited side effect, and affected integration or client parity
passes. Call it `contained but unresolved` when exposure is closed but the
root cause or required proof remains incomplete.

## Decide disposition

| Decision | Use when | Required action |
|---|---|---|
| Kill | The mechanism inherently violates an invariant or cannot be made truthful | Stop that branch and preserve the evidence |
| Contain | A reachable defect could cross an identity, credential, data, recovery, or external boundary | Isolate only under explicit repair authority; keep the unsafe path unreleased |
| Repair | The root cause is verified and attack-and-fix was requested | Make the narrowest repair through `pursue-workwire-goals`; rerun original, positive, and negative proofs |
| Release-block | Required proof fails, a flag remains, or a hard flag lacks acknowledgement | Do not build, commit, release, or install the flagged change |
| Clear | Applicable highest-value hypotheses are disproved and no required surface remains untested | State the bounded proved scope and residual uncertainty |

## Use precise observation language

- **Not observed:** The behavior did not appear during the recorded observation. Make no claim outside that window or oracle.
- **Disproved:** A valid discriminating experiment exercised the hypothesis preconditions and authoritative evidence contradicted the predicted failure.
- **Unproved:** Required evidence is missing, inaccessible, non-representative, or unable to observe the authoritative boundary.

Use `not observed` for a bounded empirical absence, `disproved` only for a
hypothesis, and `unproved` when the oracle, fixture, reachability, or
client/contract coverage is inadequate. Never treat `unproved` as safe or
defective.
