# Product Spec — Deal Bot: Org-Sim (V1)

## User story
As a deal team member, I want to allocate an "army" of specialized personas (analysts/associate/partner) to a single deal so I can quickly get a defensible GO/NO-GO and the minimum next diligence required — without reading long generated content.

## Inputs
- Deal name
- Optional domain / website
- fund_config (dynamic; user-provided; free text or JSON)
- persona_config (dynamic; defines analyst specializations, partner strictness/thresholds)
- Node allocation: 1 Partner, 1 Associate, Analysts = 1..6

## Outputs (hard constrained)
- decision_gate.decision ∈ {KILL, PROCEED, PROCEED_IF}
- decision_gate.gating_questions: exactly 3 strings (short, testable)
- decision_gate.evidence_checklist: ≤ 15 items total, grouped under the 3 questions
- rubric scores + reasons (short bullets)
- event timeline (top events)

## Key constraints (anti-slop)
- No long memos. No narrative.
- Atomic artifacts only: facts, contradictions, unknowns, hypotheses.
- Every factual claim must cite evidence OR be labeled ASSUMPTION.
- Visual simulation is the feature: real-time node/edge activity.

## Personas (generic defaults — NOT stage/geo hardcoded)
- Generic Analyst (specialization-driven; research-heavy; outputs atomic evidence blocks)
- Generic Associate (synthesis; outputs hypotheses + unknowns + targeted follow-ups)
- Generic Partner (decision; outputs Decision Gate and rubric)

## Demo script (2 minutes)
1) Allocate nodes: 1 partner, 1 associate, 3 analysts
2) Paste sample deal + fund_config/persona_config; click Run
3) Watch nodes animate + messages flow; evidence drawer fills
4) Decision Gate resolves to PROCEED_IF with 3 gating questions + checklist
5) Export checklist (markdown/JSON) to "Slack-ready" copy
