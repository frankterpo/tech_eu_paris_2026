# Architecture (V1)

## Components
1) Skybridge ChatGPT App (React UI)
   - React Flow graph
   - Right panel: Decision Gate + Evidence Drawer + Event Timeline
   - Controls: allocate nodes, set fund/persona config, run/reset/export

2) Orchestrator API (Node/TypeScript)
   - Creates deal sessions (deal_id)
   - Maintains:
     - per-node memory JSON
     - per-edge memory JSON (message history + shared artifacts)
     - canonical deal state JSON (facts, evidence, hypotheses, rubric, decision gate)
   - Runs deterministic orchestration (parallel analysts → associate → optional one follow-up → partner)
   - Emits SSE events for UI animations

3) Integrations
   - Cala: evidence retrieval (search; optional entity drill)
   - Dify: node execution workflows (analyst/associate/partner)
     - NOTE: DIFY API key not available yet; must support stub mode until key is added.

## Event-driven simulation
- Orchestrator emits events in real time:
  NODE_STARTED, MSG_SENT, NODE_DONE, EVIDENCE_ADDED, STATE_PATCH, DECISION_UPDATED, ERROR
- UI listens via SSE and updates node statuses, edge message counts, timeline, and decision panel.

## Persistence (V1)
File-based write-through:
- data/deals/{deal_id}/events.jsonl
- data/deals/{deal_id}/state.json
- data/deals/{deal_id}/mem_node_{node_id}.json
- data/deals/{deal_id}/mem_edge_{from}_{to}.json
