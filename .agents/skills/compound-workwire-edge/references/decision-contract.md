# WorkWire decision contract

Use this contract to compare viable WorkWire initiatives without hiding
uncertainty behind a single score.

## Evidence classes

| Class | Meaning | Permitted claim |
|---|---|---|
| E0 | Intuition or untested hypothesis | Candidate only |
| E1 | Repository, operator, contract, or provenance-bearing signal | Plausible mechanism |
| E2 | Deterministic local proof on a narrow fixture or representative artifact | Behavior works in the proved scope |
| E3 | Fresh integrated test, managed-fleet observation, or representative measurement | Expected behavior is supported for the measured regime |
| E4 | Repeated production-valid observation with intact identity, auth, and recovery boundaries | Durable behavior is supported for the observed regimes |

Never upgrade an evidence class because a narrative is persuasive. Do not call
simulated, stale, cached, mock, or indirect evidence live fleet truth.

## Comparison fields

Record these fields for every viable candidate:

| Field | Question |
|---|---|
| Outcome | What operator or fleet state changes if this succeeds? |
| Mechanism | Why should the candidate cause that outcome? |
| Evidence | What evidence class supports the mechanism? |
| Impact range | What bounded improvement matters to the operator? |
| Strategic fit | Does it advance WorkWire's requested mission now? |
| Compounding | Which later capabilities or decisions become better or cheaper? |
| Cost of delay | What remains blocked while this waits? |
| Time to evidence | How quickly can the central uncertainty be resolved? |
| Implementation cost | What engineering, test, deployment, and maintenance load is added? |
| Reversibility | Can the change be contained, rolled back, or abandoned safely? |
| Downside | What data, security, reliability, device, or opportunity loss is possible? |
| Truth risk | Could success be falsely reported through stale, biased, indirect, or non-authoritative evidence? |
| Dependencies | Which machine, service, runtime, contract, or access assumptions must hold? |
| Proof | What observation accepts or rejects the candidate? |

Use ranges for uncertain magnitude, cost, and timing. Keep units explicit. Do
not sum unlike units into a decorative score.

## Decision sequence

1. Remove hard-gated candidates.
2. Remove candidates that cannot affect the terminal outcome.
3. Prefer the candidate that removes the binding constraint.
4. Compare risk-adjusted impact and cost of delay.
5. Compare durability and downstream compounding.
6. Compare time to decisive evidence and implementation cost.
7. Prefer reversibility and lower truth risk when the result is close.
8. Stress the winner by weakening its least certain important assumption.
9. Choose a discriminating experiment when no candidate survives decisively.

Treat sunk work as evidence and recovery context, not as a reason to continue
a dominated initiative. Treat maintenance burden and coordination cost as real
costs. Treat removal of contradictory paths as value only after parity is
proved.

## Proof contract

Define this contract before execution:

```text
decision:
  target: <single bounded operator or fleet outcome>
  baseline: <current measured or implemented state>
  mechanism: <causal reason the move should work>
  evidence_class: <E0-E4>
  expected_change: <observable range and horizon>
  invariants: <identity, auth, data, recovery, privilege, and client parity truths>
  positive_proof: <narrow command or authoritative observation>
  negative_proof: <failure or forbidden behavior that must remain absent>
  kill_or_pivot: <evidence that invalidates the move>
  rollback: <safe restoration path when applicable>
  first_action: <smallest reversible step that reduces the main uncertainty>
```

Do not persist this template as a new repository document. Keep it in the
response, an authorized canonical file, or ephemeral task state.

## Decisive language

- **Commit** when one candidate dominates under reasonable sensitivity.
- **Experiment** when a cheap reversible proof can distinguish leaders.
- **Repair** when a binding integrity or reliability defect blocks other value.
- **Finish** when an almost-complete capability dominates starting another path.
- **Kill** when the mechanism fails, the opportunity is dominated, or the maintenance burden destroys expected value.
- **Hold** only when a concrete dependency or hard gate prevents a safe decisive experiment.

Never use `Hold` for difficulty, discomfort, novelty, or lack of perfect
information.
