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
6. Save → you should see **6 tools**: `calaSearch`, `specterEnrich`, `specterSimilarCompanies`, `specterCompanyPeople`, `specterSearchName`

> **If updating an existing provider**: Delete the old `dealbot_tools` provider, then re-create it with the updated OpenAPI spec. Dify doesn't always pick up schema changes on re-import.

### 1b. Verify Tavily Built-in Tool

1. Go to **Dify → Tools → Built-in Tools**
2. Find **Tavily** and ensure it's enabled with your API key
3. The agent YAMLs reference `tavily_search` as a built-in tool

### 2. Import Agent Apps

Import each YAML file as a **new app** (not workflow):

1. **Dify → Studio → Create from DSL** → upload `analyst_agent_v2.yml`
2. **Dify → Studio → Create from DSL** → upload `associate_agent_v2.yml`
3. **Dify → Studio → Create from DSL** → upload `partner_agent_v2.yml`

Each will import as an **Agent** app (mode: agent-chat).

### 3. Verify Tool Binding

For each imported app:

1. Open the app → **Orchestrate** tab
2. Scroll to **Tools** section — should show all 6 tools:
   - `Cala Search`, `Specter Enrich`, `Specter Similar Companies`, `Specter Company People`, `Specter Search Name` (from `dealbot_tools`)
   - `TavilySearch` (built-in)
3. If tools show as missing/broken, re-add them from the `dealbot_tools` provider or Tavily built-in
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

| Tool | Endpoint | What it does |
|------|----------|-------------|
| `calaSearch` | POST `/api/tools/cala/search` | Searches Cala KB. Body: `{"query": "..."}`. Returns `{evidence: [...], count: N}` |
| `specterEnrich` | POST `/api/tools/specter/enrich` | Enriches company by domain. Body: `{"domain": "..."}`. Returns `{profile: {...}, evidence: [...], count: N}` |
| `specterSimilarCompanies` | POST `/api/tools/specter/similar` | AI-matched competitors. Body: `{"company_id": "..."}`. Returns `{companies: [...], evidence: [...], count: N}` |
| `specterCompanyPeople` | POST `/api/tools/specter/people` | Team members + leadership. Body: `{"company_id": "..."}`. Returns `{people: [...], evidence: [...], count: N}` |
| `specterSearchName` | POST `/api/tools/specter/search-name` | Search companies by name. Body: `{"query": "..."}`. Returns `{results: [...], evidence: [...], count: N}` |
| `tavily_search` | Built-in (Tavily) | Real-time web search. Configured in Dify as built-in tool. |

## Troubleshooting

- **Tools show "deleted"**: The tool provider name in the YAML must match exactly. Re-add tools from your `dealbot_tools` custom provider.
- **Agent doesn't call tools**: Check the `pre_prompt` instructs tool use. The instruction says "MUST call them before writing analysis."
- **Empty/malformed JSON output**: Increase `max_iteration` or `max_tokens` in the app config.
- **401 from tool calls**: Ensure the server is running on the URL configured in the custom tool provider.
