# Data Models & Event Contracts (V1)

## Canonical deal_state

- deal_input: { name, domain?, fund_config, persona_config }
- evidence[]: { evidence_id, title?, snippet, source, url?, retrieved_at }
- hypotheses[]: { id, text, support_evidence_ids[], risks[] }
- rubric: market/moat/why_now/execution/deal_fit each score 0..100 + reasons[]
- decision_gate:
  - decision: KILL | PROCEED | PROCEED_IF
  - gating_questions: EXACTLY 3
  - evidence_checklist: <= 15 items TOTAL, each item references q index + evidence/assumption

## Node memory

- facts[], contradictions[], unknowns[], hypotheses[], evidence_ids[]

## Edge memory

- messages[]: {ts, from, to, type, payload{text, refs[]}}
- shared_artifacts: { evidence_refs[], hypotheses_refs[] }

## Event schema (SSE payload)

`{ ts, deal_id, type, payload }`

Types:
- NODE_STARTED { node_id, role, specialization? }
- MSG_SENT { from, to, summary, refs? }
- NODE_DONE { node_id, output_summary }
- EVIDENCE_ADDED { evidence_items_count, last_evidence_id }
- STATE_PATCH { patch_summary }
- DECISION_UPDATED { decision, gating_questions }
- ERROR { where, message }

## Persona schemas (STRICT JSON only)

### AnalystOutput
```json
{
  "facts": [{"text": "...", "evidence_ids": ["..."]}],
  "contradictions": [{"text": "...", "evidence_ids": ["..."]}],
  "unknowns": [{"question": "...", "why": "..."}],
  "evidence_requests": [{"query": "...", "reason": "..."}]
}
```

### AssociateOutput
```json
{
  "hypotheses": [{"id": "h1", "text": "...", "support_evidence_ids": ["..."], "risks": ["..."]}],
  "top_unknowns": [{"question": "...", "why_it_matters": "..."}],
  "requests_to_analysts": [{"specialization": "market|competition|traction|team|regulatory|risks|other", "question": "..."}]
}
```

### PartnerOutput
```json
{
  "rubric": {
    "market": {"score": 0, "reasons": ["..."]},
    "moat": {"score": 0, "reasons": ["..."]},
    "why_now": {"score": 0, "reasons": ["..."]},
    "execution": {"score": 0, "reasons": ["..."]},
    "deal_fit": {"score": 0, "reasons": ["..."]}
  },
  "decision_gate": {
    "decision": "KILL|PROCEED|PROCEED_IF",
    "gating_questions": ["Q1", "Q2", "Q3"],
    "evidence_checklist": [{"q": 1, "item": "...", "type": "EVIDENCE|ASSUMPTION", "evidence_ids": ["..."]}]
  }
}
```
