# Dify Agent Setup Guide (v2 — agent-chat mode)

## What Changed from v1

| Aspect | v1 Workflow | v2 Agent-Chat |
|--------|-------------|---------------|
| Mode | `workflow` → `/workflows/run` API | `agent-chat` → `/chat-messages` API |
| Evidence | Orchestrator pre-fetched, passed as input | Agent autonomously calls tools |
| Iteration | Single LLM pass | Multi-step function calling (up to 7 iterations) |
| Template | Dify Workflow YAML | Dify Agent App YAML (this template) |
| Validation | Code node in Dify | Zod validation in orchestrator |

## Setup Steps

### 1. Create/Update Custom Tool Provider

1. Go to **Dify → Tools → Custom Tool → Create Custom Tool** (or edit existing `dealbot_tools`)
2. Name: `dealbot_tools`
3. Import from OpenAPI schema: paste contents of `server/openapi-tools.json`
4. Set the server URL to your tunnel URL (e.g. `https://xxxxx.lhr.life/api/tools`)
5. No auth required (local dev)
6. Save → you should see **26 operations** total. All 26 are registered in agent `tools[]` arrays.

> **If updating an existing provider**: Delete the old `dealbot_tools` provider, then re-create it with the updated OpenAPI spec. Dify doesn't always pick up schema changes on re-import.

> **CRITICAL — Disable Built-in Tavily**: You MUST disable/remove Dify's built-in Tavily tools (`tavily_research`, `tavily_map`, `tavily_crawl`, `tavily_search`) from all agent apps. Our custom `dealbot_tools` API already includes `tavilyWebSearch`, `tavilyExtract`, `tavilyCrawl`, and `tavilyResearch` as proxied endpoints with proper latency labels — agents should use those instead. Built-in tools duplicate functionality and bypass our API key management.
>
> **How to disable**: Open each agent app → Orchestrate → Tools → find any **Tavily built-in** tools → toggle them OFF or delete them. Only `dealbot_tools` custom tools should remain.

### 2. Import Agent Apps

Import each YAML file as a **new app** (not workflow):

1. **Dify → Studio → Create from DSL** → upload `analyst_agent_v2.yml`
2. **Dify → Studio → Create from DSL** → upload `associate_agent_v2.yml`
3. **Dify → Studio → Create from DSL** → upload `partner_agent_v2.yml`

Each will import as an **Agent** app (mode: agent-chat).

### 3. Verify Tool Binding

For each imported app:

1. Open the app → **Orchestrate** tab
2. Scroll to **Tools** section — should show **26 active tools** from `dealbot_tools`:
   - **Cala** (4): `Cala Search`, `Cala Query`, `Cala Search Entities`, `Cala Get Entity`
   - **Specter** (9): `Specter Enrich`, `Specter Similar Companies`, `Specter Company By ID`, `Specter Company People`, `Specter Enrich Person`, `Specter Person By ID`, `Specter Person Email`, `Specter Search Name`, `Specter Text Search`
   - **Tavily** (5): `Tavily Web Search`, `Tavily Extract`, `[SLOW] Tavily Crawl`, `[VERY SLOW] Tavily Research`, `Tavily Research Status`
   - **Advanced** (4): `Web Extract (legacy)`, `Dify Agent (FunctionCalling)`, `Dify Agent (ReAct)`, `[SLOW] Lightpanda Scrape`
   - **Triggers** (3): `Cala Create Trigger`, `Cala Subscribe Trigger`, `Cala List Triggers`
   - **Utility** (1): `Tool Health`
3. If tools show as missing/broken, re-add them from the `dealbot_tools` provider
4. **Critical chains to verify**: `specterSimilarCompanies` → `specterCompanyById` (competitor enrichment), `specterCompanyPeople` → `specterEnrichPerson` (founder diligence)
4. Test with the **Debug** panel:
   - Set `deal_input` to: `{"company_name": "Specter", "domain": "tryspecter.com", "stage": "Bootstrapped", "sector": "Data Infrastructure", "geo": "UK"}`
   - Set `specialization` to: `market` (for analyst) or leave defaults for others
   - Send a test message like "Analyze this deal"
   - Verify the agent calls MULTIPLE tools during its reasoning (expect 5+ tool calls for analysts)

### 4. Publish & Get API Keys

For each app:

1. Click **Publish** (top right)
2. Go to **API Access** → copy the API key
3. Update `.env`:

```
DIFY_API_KEY_ANALYST=app-xxxxx
DIFY_API_KEY_ASSOCIATE=app-xxxxx
DIFY_API_KEY_PARTNER=app-xxxxx
```

### 5. API Call Pattern (for Slice A3)

Agent-chat apps use the **Chat Messages API** (not Workflows):

```bash
curl -X POST https://api.dify.ai/v1/chat-messages \
  -H "Authorization: Bearer app-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "inputs": {
      "deal_input": "{...json...}",
      "fund_config": "{...json...}",
      "specialization": "market",
      "analyst_id": "analyst_1",
      "company_profile": "{...json...}",
      "prior_analyses": "[]"
    },
    "query": "Analyze this deal through the lens of your specialization.",
    "response_mode": "blocking",
    "user": "deal-bot-orchestrator"
  }'
```

**Key differences from v1 workflow API:**
- Endpoint: `/v1/chat-messages` (not `/v1/workflows/run`)
- Response: `{ "answer": "...", ... }` (not `{ "data": { "outputs": { "output": "..." } } }`)
- The `answer` field contains the agent's final text output (the JSON string)
- `inputs` map directly to `user_input_form` variables
- `query` is the user message that triggers the agent
- `response_mode: "blocking"` waits for full completion (use `"streaming"` for SSE)

## Tool Descriptions (for reference)

All tools are served by the `dealbot_tools` custom API provider. API keys are managed server-side.

| # | Tool | operationId | Endpoint | Speed | What it does |
|---|------|-------------|----------|-------|-------------|
| 1 | Cala Search | `calaSearch` | POST `/cala/search` | ~2s | Knowledge base search. Returns `{content, evidence[], entities[], count}` |
| 2 | Cala Query | `calaQuery` | POST `/cala/query` | ~2s | Structured data extraction. Returns `{results[], entities[], evidence[], count}` |
| 3 | Cala Search Entities | `calaSearchEntities` | POST `/cala/search-entities` | ~2s | Fuzzy entity search by name. Returns `{entities[], count}` |
| 4 | Cala Get Entity | `calaGetEntity` | GET `/cala/entity/{id}` | ~1s | Full entity details by Cala entity ID |
| 5 | Specter Enrich | `specterEnrich` | POST `/specter/enrich` | ~3s | Company profile by domain. Returns `{profile, evidence[], count}` |
| 6 | Specter Company By ID | `specterCompanyById` | POST `/specter/company-by-id` | ~2s | Full profile by Specter ID. Returns `{profile, evidence[], count}` |
| 7 | Specter Similar Companies | `specterSimilarCompanies` | POST `/specter/similar` | ~5s | AI-matched competitors by ID. Returns `{companies[], evidence[], count}` |
| 8 | Specter Company People | `specterCompanyPeople` | POST `/specter/people` | ~3s | Team + leadership. Returns `{people[], evidence[], count}` |
| 9 | Specter Search Name | `specterSearchName` | POST `/specter/search-name` | ~2s | Search companies by name. Returns `{results[], evidence[], count}` |
| 10 | Specter Text Search | `specterTextSearch` | POST `/specter/text-search` | ~2s | Extract entities from text. Returns `{entities[], count}` |
| 11 | Specter Enrich Person | `specterEnrichPerson` | POST `/specter/enrich-person` | ~3s | Person by LinkedIn URL. Returns `{person, evidence[]}` |
| 12 | Specter Person By ID | `specterPersonById` | POST `/specter/person-by-id` | ~2s | Person profile by Specter person ID |
| 13 | Specter Person Email | `specterPersonEmail` | POST `/specter/person-email` | ~2s | Verified email for a person by Specter person ID |
| 14 | Tavily Web Search | `tavilyWebSearch` | POST `/tavily/search` | ~2s | Web search with AI answer. Returns `{evidence[], answer, count}` |
| 15 | Tavily Extract | `tavilyExtract` | POST `/tavily/extract` | ~3s | Extract URL content. Returns `{results[], evidence[], count}` |
| 16 | Tavily Crawl | `tavilyCrawl` | POST `/tavily/crawl` | ⚠️ ~30-60s | Website graph crawl. Use sparingly. |
| 17 | Tavily Research | `tavilyResearch` | POST `/tavily/research` | ⚠️ ~60-120s | Async comprehensive research. Returns `request_id` to poll. |
| 18 | Tavily Research Status | `tavilyResearchStatus` | GET `/tavily/research/{id}` | ~1s | Poll for async research results |
| 19 | Web Extract | `webExtract` | POST `/web/extract` | ~5s | Legacy URL scraper. Prefer tavilyExtract. |
| 20 | Lightpanda Scrape | `lightpandaScrape` | POST `/lightpanda/scrape` | ⚠️ ~10-30s | Headless browser for JS-heavy SPAs |
| 21 | Dify Agent FC | `difyAgentFC` | POST `/dify/agent-fc` | varies | Delegate sub-task to FunctionCalling sub-agent |
| 22 | Dify Agent ReAct | `difyAgentReAct` | POST `/dify/agent-react` | varies | Delegate sub-task to ReAct reasoning sub-agent |
| 23 | Cala Create Trigger | `calaCreateTrigger` | POST `/cala/trigger` | ~3s | Create Cala monitoring trigger (needs JWT) |
| 24 | Cala Subscribe Trigger | `calaSubscribeTrigger` | POST `/cala/trigger/subscribe` | ~2s | Subscribe email to existing trigger |
| 25 | Cala List Triggers | `calaListTriggers` | GET `/cala/triggers` | ~2s | List all Cala triggers |
| 26 | Tool Health | `toolHealth` | GET `/health` | ~1s | Check backend availability |

### Tool Chaining Patterns

```
specterSimilarCompanies(company_id) → competitor IDs → specterCompanyById(id) → full profiles
specterCompanyPeople(company_id) → people with LinkedIn → specterEnrichPerson(linkedin_url) → career history
calaSearch(query) → entities (PERSON, ORG) → calaSearch("{entity_name} ...") → deeper profile
```

## Troubleshooting

- **Tools show "deleted"**: The tool provider name in the YAML must match exactly. Re-add tools from your `dealbot_tools` custom provider.
- **Agent doesn't call tools**: Check the `pre_prompt` instructs tool use. The instruction says "MUST call them before writing analysis."
- **Empty/malformed JSON output**: Increase `max_iteration` or `max_tokens` in the app config.
- **401 from tool calls**: Ensure the server is running on the URL configured in the custom tool provider.
