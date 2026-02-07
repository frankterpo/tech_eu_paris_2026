# Deal Bot: Org-Sim — Context Index (AUTHORITATIVE)

## North Star
Build a working V1 of a ChatGPT App (Skybridge) that simulates a mini investment org (Partner → Associate → Analysts) running on ONE deal.
Users allocate how many nodes. The simulation runs in real time with visible node/edge activity.
Each node has memory; each edge has interaction memory; the deal has canonical state.

Output is NOT a memo. Output is a single Decision Gate:
- Decision: KILL / PROCEED / PROCEED-IF
- Exactly 3 gating questions
- Evidence checklist ≤ 15 items total
- All claims must link to evidence OR be explicitly labeled ASSUMPTION and moved into Proceed-If conditions.

## Holy-shit moment
You see the org working in real time:
- Analysts run in parallel (nodes animate)
- Messages flow on edges
- Evidence drawer populates
- Associate synthesizes hypotheses
- Partner calls the shot
- Decision Gate updates live

## V1 Definition of Done
- UI: node graph + event timeline + decision gate panel updates live
- Orchestrator: sessions, memories, SSE event stream, deterministic run loop
- Integrations: Skybridge + Cala + Dify (Dify key added later; stub allowed until key obtained)
- "No slop" enforcement: strict JSON schemas, max lengths, evidence/assumption rules, 1 retry max
- Demo-ready: seeded sample deal button, completes <60s with 3 analysts
- README: run steps + partner tech used + demo steps

## Read order (agents MUST read in order)
1) ./context/01_PRODUCT_SPEC.md
2) ./context/02_ARCHITECTURE.md
3) ./context/03_CONFIG_AND_PERSONAS.md
4) ./context/04_DATA_MODELS_AND_EVENTS.md
5) ./context/05_ORCHESTRATION.md
6) ./context/06_VALIDATION_NO_SLOP.md
7) ./context/07_PARTNER_DOCS_AND_SETUP.md
8) ./context/08_DIFY_SETUP.md
9) ./context/09_CODEX_WORKFLOW.md
10) ./context/OPUS_4_6_BUILD_PROMPT.md
