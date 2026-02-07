# Validation + "No Slop" Contract (V1)

## Validators

Implement with zod (recommended).
Enforce max sizes:
- facts <= 12
- contradictions <= 8
- unknowns <= 8
- hypotheses <= 6
- gating_questions EXACTLY 3
- checklist <= 15 items TOTAL
- reasons <= 4 per rubric dimension

## Evidence rule (critical)

If an item asserts a fact and has no evidence_ids:
- convert to type=ASSUMPTION
- ensure it appears in decision_gate.evidence_checklist
- if too many assumptions, partner decision must shift to PROCEED_IF or KILL

## Retry policy

- On validator failure: re-prompt ONCE including validator errors + schema again
- Second failure: emit ERROR event; continue degraded

## Determinism

- Partner must always emit Decision Gate, even in degraded mode.
- Never hallucinate evidence. Missing evidence becomes ASSUMPTION.
