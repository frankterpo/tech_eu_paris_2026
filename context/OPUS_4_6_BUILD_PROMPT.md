You are Opus 4.6 inside Cursor. Ship V1 today.

Read first:
- context/INDEX.md
- context/02_ARCHITECTURE.md
- context/05_ORCHESTRATION.md
- context/06_VALIDATION_NO_SLOP.md

If Dify key missing: implement stub mode and proceed.

Non-negotiables:
- Output is Decision Gate (decision + EXACTLY 3 gating questions + checklist <= 15). No memos.
- Real-time simulation: React Flow updates driven by SSE events.
- Node + edge + deal memory persisted per deal session on disk (JSON/JSONL).
- Strict JSON schema validation with 1 retry max.

Integrations:
- Skybridge: UI + tool triggers
- Cala: real evidence retrieval (keys exist)
- Dify: persona workflows (key missing; stub now; swap later)

Implementation order:
1. Scaffold: apps/skybridge-dealbot, server, integrations/cala, integrations/dify, data (gitignore)
2. Orchestrator endpoints: POST /api/deals, POST /api/deals/:id/run, GET /api/deals/:id/stream (SSE), GET /api/deals/:id/state
3. File persistence: events.jsonl + state.json + mem_node_*.json + mem_edge_*.json
4. Cala wrapper: search(query)->evidence[] normalized
5. Dify client: stub if key missing, else call workflows
6. Validators (zod): enforce max lengths, exact 3 gating questions, checklist <=15, evidence/assumption rules
7. UI: React Flow graph + SSE listener + decision panel + evidence drawer + timeline + export
8. README + demo script + partner tech used

Deliverable: working V1 locally end-to-end.
