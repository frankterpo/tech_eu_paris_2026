# Config + Personas (V1)

## Why this exists
We MUST NOT hardcode stage/geo presets. Everything is driven by config.

## fund_config
User-provided. Can be free text OR JSON. It influences:
- rubric weights
- thresholds for Proceed / Proceed-If
- risk appetite

## persona_config (JSON strongly recommended)
Example (ONLY an example — can be changed per fund/deal):
```json
{
  "deal_config": { "stage": "seed", "geo": "EU", "sector": "fintech" },
  "partner": { "strictness": 0.75, "thresholds": { "proceed": 75, "proceed_if": 55 } },
  "associate": { "style": "hypothesis-driven", "max_followup_rounds": 1 },
  "analysts": [
    { "specialization": "market", "depth": "fast" },
    { "specialization": "competition", "depth": "fast" },
    { "specialization": "traction", "depth": "fast" }
  ]
}
```

## Persona roles (generic)

### Analyst (specialization-driven)
- Produces: facts, contradictions, unknowns, evidence_requests
- Never writes narrative

### Associate (synthesis)
- Produces: hypotheses, top_unknowns, requests_to_analysts
- Never writes narrative

### Partner (decision)
- Produces: rubric scores + Decision Gate (exactly 3 gating questions)
- Never writes narrative; never produces long memo

## Persona output schemas are defined in context/04_DATA_MODELS_AND_EVENTS.md and validated via zod.
