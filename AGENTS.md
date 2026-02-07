# Project Rules (Codex — gpt-5.3-codex high)

## Your role: REVIEWER / QA / ITERATOR
You review code written by Cursor (Gemini 3 Flash). You do NOT write features from scratch.
Your job: find bugs, enforce contracts, verify schemas, ensure the codebase matches the spec.

## Workflow
1. Read the required context files below before any task.
2. Review the code changes for the current slice.
3. Only check items that are IN SCOPE for the current slice (see per-slice checklist below).
4. If issues found: describe them precisely, suggest a fix, and optionally apply it.
5. If no issues: confirm the slice is complete and ready for the next one.

## Always read first
- context/INDEX.md
- context/02_ARCHITECTURE.md
- context/04_DATA_MODELS_AND_EVENTS.md
- context/05_ORCHESTRATION.md
- context/06_VALIDATION_NO_SLOP.md

## Per-slice review scope

### Slice 1 — Server skeleton
- [ ] Endpoints exist: POST /api/deals, POST /api/deals/:id/run, GET /api/deals/:id/stream (SSE), GET /api/deals/:id/state
- [ ] SSE events emitted for every orchestration step (NODE_STARTED, MSG_SENT, NODE_DONE, EVIDENCE_ADDED, DECISION_UPDATED)
- [ ] SSE event payloads match spec in context/04_DATA_MODELS_AND_EVENTS.md
- [ ] File persistence: events.jsonl + state.json written per deal session
- [ ] Node/edge memory: mem_node_*.json + mem_edge_*.json writers called during orchestration
- [ ] Deal existence validated before /run
- [ ] Every NODE_DONE has a matching NODE_STARTED
- [ ] Reducer correctly updates canonical state from events
- [ ] No hardcoded stage/geo/sector defaults
- [ ] Compiles clean (npm run build)

### Slice 2 — Validators + retry
- [ ] Zod schemas for AnalystOutput, AssociateOutput, PartnerOutput
- [ ] Max sizes enforced (facts<=12, contradictions<=8, unknowns<=8, hypotheses<=6, gating_questions===3, checklist<=15, reasons<=4)
- [ ] Retry-once on validation failure with errors embedded in re-prompt
- [ ] Second failure: ERROR event + continue degraded
- [ ] Decision Gate always produced, even in degraded mode

### Slice 3 — Cala wrapper
- [ ] integrations/cala/client.ts: search(query)->evidence[] normalized
- [ ] Evidence items match spec: {evidence_id, snippet, source, url?, retrieved_at}
- [ ] Wired into orchestration step 2 (evidence seed)
- [ ] Uses CALA_API_KEY from .env

### Slice 4 — Dify client
- [ ] integrations/dify/client.ts exists
- [ ] Stub returns valid JSON per persona schema when DIFY_API_KEY missing
- [ ] Real mode calls Dify workflow API when key present
- [ ] Auto-switches based on env var presence

### Slice 4.5 — End-to-end integration verification
- [ ] Server starts clean, listens on configured port
- [ ] POST /api/deals creates deal; POST /api/deals/:id/run triggers simulation
- [ ] Cala returns real evidence (non-empty evidence array in state.json)
- [ ] Each analyst receives `prior_analyses` from predecessors — no duplicate facts across analyst outputs
- [ ] Analyst specializations (market, competition, traction) produce distinct, non-overlapping analysis
- [ ] Dify workflows (analyst, associate, partner) all return valid=true when published
- [ ] Zod validation passes for all 3 persona output schemas
- [ ] Associate produces hypotheses referencing real evidence_ids from state
- [ ] Partner produces rubric scores + decision_gate with gating_questions===3
- [ ] Decision gate always produced, even in degraded mode
- [ ] events.jsonl contains complete event chain: NODE_STARTED→MSG_SENT→NODE_DONE for each persona
- [ ] state.json fully hydrated: evidence[], hypotheses[], rubric{}, decision_gate{}
- [ ] 9 memory files exist: mem_node_analyst_{1,2,3}, mem_node_associate, mem_node_partner, mem_edge_analyst_{1,2,3}_associate, mem_edge_associate_partner
- [ ] Reducer can replay events.jsonl to reconstruct state.json identically
- [ ] Graceful degradation: missing Dify key → stub mode, Cala timeout → empty evidence, validation failure → ERROR event + continue

### Slice 4.6 — Specter enrichment
- [ ] `integrations/specter/client.ts` exists with `enrichByDomain(domain)` method
- [ ] Uses `SPECTER_API_KEY` from .env, `X-API-Key` header
- [ ] Returns `{ profile: CompanyProfile | null, evidence: Evidence[] }`
- [ ] CompanyProfile type defined in types.ts with all key fields (funding, employees, growth_stage, traction, investors, etc.)
- [ ] DealState has `company_profile: CompanyProfile | null` field
- [ ] Reducer handles `COMPANY_PROFILE_ADDED` event
- [ ] Orchestrator runs Specter + Cala in parallel via `Promise.all`
- [ ] Specter evidence items have `source: 'specter'` and evidence_ids prefixed `specter-`
- [ ] Specter evidence merged BEFORE Cala results in evidence array (structured data first)
- [ ] `company_profile` passed to analyst Dify workflow as input
- [ ] Dify analyst_workflow_v1.yml has `company_profile` input variable + prompt reference
- [ ] Graceful degradation: missing key → skip, timeout → skip, no results → null profile
- [ ] state.json contains `company_profile` when domain provided
- [ ] evidence[] contains specter-prefixed items when domain provided

### Slice A1 — Tool API Endpoints
- [ ] `server/src/tool-routes.ts` exists with Express Router
- [ ] `POST /api/tools/cala/search` — accepts `{ query }`, returns `{ evidence[], count }`
- [ ] `POST /api/tools/specter/enrich` — accepts `{ domain }`, returns `{ profile, evidence[], count }`
- [ ] `GET /api/tools/health` — returns JSON with cala/specter key availability + `status: 'ok'`
- [ ] Router mounted at `/api/tools` in `server/src/index.ts`
- [ ] Input validation: missing/empty `query`/`domain` → 400 with error message
- [ ] Error handling: upstream failures → 502 with error message + empty defaults
- [ ] `server/openapi-tools.json` is valid OpenAPI 3.0 spec with all 3 operations
- [ ] OpenAPI `servers[0].url` points to the tunnel URL (not localhost)
- [ ] API keys stay server-side — tool routes never expose credentials in responses
- [ ] Compiles clean (`npx tsc --noEmit`)

### Slice A2 — Dify Agent Apps (agent-chat mode)
- [ ] `dify-workflows/analyst_agent_v2.yml` exists with `app.mode: agent-chat`
- [ ] `dify-workflows/associate_agent_v2.yml` exists with `app.mode: agent-chat`
- [ ] `dify-workflows/partner_agent_v2.yml` exists with `app.mode: agent-chat`
- [ ] All 3 YAMLs use `agent_mode.strategy: function_call` (not ReAct)
- [ ] All 3 YAMLs reference tools `calaSearch` and `specterEnrich` under `agent_mode.tools[]`
- [ ] Tool provider is `dealbot_tools` (type: `api`) in all 3 YAMLs
- [ ] Analyst agent has `user_input_form` variables: `deal_input`, `fund_config`, `specialization`, `analyst_id`, `company_profile`, `prior_analyses`
- [ ] Associate agent has `user_input_form` variables: `deal_input`, `fund_config`, `analyst_outputs`, `company_profile`
- [ ] Partner agent has `user_input_form` variables: `deal_input`, `fund_config`, `associate_output`, `company_profile`
- [ ] All `pre_prompt` fields instruct agents to call tools BEFORE producing analysis
- [ ] All `pre_prompt` fields specify JSON-only output (no markdown, no narrative)
- [ ] Analyst prompt includes `prior_analyses` reference to avoid inter-analyst duplication
- [ ] Model set to `gpt-4o-mini` with low temperature (≤0.2) for all 3 agents
- [ ] `.env` has updated `ANALYST_DIFY_KEY`, `ASSOCIATE_DIFY_KEY`, `PARTNER_DIFY_KEY` pointing to agent-chat app IDs
- [ ] `dify-workflows/AGENT_SETUP.md` exists with setup instructions
- [ ] Dify Cloud has all 3 agents created with `dealbot_tools` custom tool provider configured

### Slice A3 — Orchestrator Agent Adapter
- [ ] `DifyClient.runAgent()` calls `/chat-messages` endpoint (not `/workflows/run`)
- [ ] Request body includes `inputs` (form variables) + `query` (user message) + `response_mode: 'blocking'`
- [ ] Response parsing reads `data.answer` (text string), not `data.data.outputs`
- [ ] `extractJSON()` handles: raw JSON, markdown-fenced JSON, text-wrapped JSON objects
- [ ] Timeout set to ≥90s (agents make tool calls — slower than workflows)
- [ ] Retry prompt passed via `query` parameter (not as an `inputs.retry_prompt` field)
- [ ] Orchestrator analyst calls: inputs are `deal_input`, `fund_config`, `specialization`, `analyst_id`, `company_profile`, `prior_analyses` — NO `evidence_json`, NO `persona_config`
- [ ] Orchestrator associate calls: inputs are `deal_input`, `fund_config`, `analyst_outputs`, `company_profile` — NO `evidence_json`, NO `persona_config`
- [ ] Orchestrator partner calls: inputs are `deal_input`, `fund_config`, `associate_output`, `company_profile` — NO `evidence_json`, NO `persona_config`
- [ ] Stub fallback still works when API keys missing (returns valid schema-matching JSON)
- [ ] `validateWithRetry` still functions: first call → validate → retry with errors in `query` → validate
- [ ] Event chain preserved: NODE_STARTED → MSG_SENT → NODE_DONE for each persona
- [ ] Compiles clean (`npx tsc --noEmit`)

### Slice 4.7 — Corpus KB (Dify Knowledge Base)
- [ ] `integrations/dify/corpus.ts` exists with dataset API wrapper
- [ ] `createDocument(text, metadata)` calls Dify `create_by_text` API
- [ ] `uploadFile(file)` calls Dify `create_by_file` API
- [ ] API endpoint `POST /api/corpus/upload` accepts file upload (PDF/DOCX/TXT)
- [ ] API endpoint `POST /api/corpus/text` accepts raw text body with metadata
- [ ] Both endpoints store to a persistent Dify Knowledge Base
- [ ] Dify KB name matches project convention (e.g., `deal-bot-corpus`)
- [ ] analyst_workflow_v1.yml includes Knowledge Retrieval node querying corpus KB
- [ ] Corpus documents queryable by analysts during simulation
- [ ] Graceful degradation: missing KB → skip retrieval, API errors → log and continue

### Slice 5 — UI skeleton
- [ ] React Flow graph renders nodes (partner, associate, analysts)
- [ ] SSE listener updates node statuses and edge messages in real time
- [ ] Decision Gate panel, Evidence Drawer, Event Timeline present
- [ ] Controls: allocate nodes, set configs, run/reset/export

### Slice 6 — Wiring + demo
- [ ] Seeded sample deal button works
- [ ] Full simulation completes <60s with 3 analysts
- [ ] Export checklist (markdown/JSON)
- [ ] README with run steps + partner tech + demo script

## Constraints (non-negotiable, ALL slices)
- No stage/geo defaults hardcoded. Use persona_config/deal_config.
- No long-form memos; Decision Gate only.
- Dify key may be missing: stub mode is required. Never block.

## When reviewing
- Be precise. Cite file paths and line numbers.
- If a fix is small (<20 lines), apply it directly.
- If a fix is large, describe what needs to change and let Cursor re-implement.
- Only FAIL a slice on items in that slice's checklist. Note future-slice gaps as INFO, not blockers.
