# Orchestration Algorithm (V1)

## Deterministic run loop

1. Create deal session & allocate graph:
   Partner (1), Associate (1), Analysts (N)

2. Evidence seed:
   Query Cala using deal name/domain + fund_config + persona_config.deal_config.
   Add top K evidence items to deal_state (K ~ 8–15).

3. Analysts (parallel):
   Use persona_config.analysts[] to define specializations.
   Each analyst receives:
   - deal_input
   - evidence[] subset (or full, if small)
   - role instructions + STRICT JSON schema
   Validate outputs.

4. Associate:
   Consume analyst outputs → produce:
   - hypotheses (atomic)
   - top unknowns (testable)
   - requests_to_analysts (optional; max one follow-up round)
   Validate outputs.

5. Optional follow-up (max one round):
   Analysts answer associate requests (parallel).
   Validate.

6. Partner:
   Consume canonical state → compute rubric → emit Decision Gate:
   - decision ∈ {KILL, PROCEED, PROCEED_IF}
   - EXACTLY 3 gating questions
   - checklist ≤ 15 items
   Evidence rule: uncited => ASSUMPTION; must appear in checklist and can force PROCEED_IF.

## Error policy

- Any node output fails schema validation → retry once with validator errors embedded.
- Fails again → emit ERROR event; continue degraded but ALWAYS produce a decision gate.
