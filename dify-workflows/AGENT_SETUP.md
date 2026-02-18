# Dify Agent Setup Guide (v2 — agent-chat mode)

## Current Status (2026-02-18)

| Item | Status |
|------|--------|
| Blank agents created | ✅ `analyst_agent_v2`, `associate_agent_v2`, `partner_agent_v2` |
| API keys in `.env` | ✅ Updated |
| Full config pushed via POST model-config | ✅ All 3 agents: prompts + vars + 27 tools |
| Smoke tested with real inputs | ✅ All 3 agents call tools and respond correctly |
| DuckDuckGo + Web Scraper | ✅ Working (built-in tools) |
| dealbot_tools (25 custom tools) | ✅ Working (UUID provider_id required) |

**Key findings:**
1. DSL-imported agents return `500 Internal Server Error` — avoid DSL import entirely
2. Blank agents + `POST /model-config` works perfectly
3. Custom API tools require the provider **UUID** as `provider_id`, not the string name
   - `dealbot_tools` UUID: `53b57651-a62c-41dc-b140-b120993ed599`
4. Method is **POST** (not PUT) for `/console/api/apps/{id}/model-config`

## Files

| File | Purpose |
|------|---------|
| `analyst_agent_v2.yml` | Analyst agent DSL (reference — do NOT import directly) |
| `associate_agent_v2.yml` | Associate agent DSL (reference — do NOT import directly) |
| `partner_agent_v2.yml` | Partner agent DSL (reference — do NOT import directly) |
| `console-api.js` | Browser console scripts for Dify Cloud API workarounds |

## Architecture (v1 → v2)

| Aspect | v1 Workflow | v2 Agent-Chat |
|--------|-------------|---------------|
| Mode | `workflow` → `/workflows/run` | `agent-chat` → `/chat-messages` |
| Evidence | Orchestrator pre-fetched | Agent calls tools autonomously |
| Web Search | Tavily only (paid) | DuckDuckGo (free, preferred) + Tavily (fallback) |
| Iteration | Single LLM pass | Multi-step function calling (up to 15 iterations) |

## Setup — Recommended Workflow

### 1. Custom Tool Provider (`dealbot_tools`)

1. **Dify → Tools → Custom Tool → Create Custom Tool**
2. Name: `dealbot_tools`
3. Import OpenAPI schema from `server/openapi-tools.json`
4. Server URL: your deployment URL + `/api/tools`
5. No auth required (keys managed server-side)
6. Save → **26 operations** total

### 2. Create Blank Agents (script #2 in console-api.js)

**Do NOT use DSL import.** Use the browser console script to create blank agents:

```javascript
// Paste in browser console at cloud.dify.ai — see console-api.js script #2
```

This creates 3 agent-chat apps + generates API keys. Output:
```
✅ analyst_agent_v2: id=xxx key=app-xxx
✅ associate_agent_v2: id=xxx key=app-xxx
✅ partner_agent_v2: id=xxx key=app-xxx
```

### 3. Configure Agents (script #5 or #8 in console-api.js)

Use `PUT /console/api/apps/{id}/model-config` to add:
- System prompt (from YAML files, `pre_prompt` field)
- Model config (gpt-4o-mini, temp 0.15)
- Agent mode (function_call strategy, max 15 iterations)
- Tools (DuckDuckGo + Web Scraper built-in + dealbot_tools custom)
- Input variables (deal_input, fund_config, specialization, etc.)

### 4. Update `.env`

```
ANALYST_DIFY_KEY=app-xxxxx
ASSOCIATE_DIFY_KEY=app-xxxxx
PARTNER_DIFY_KEY=app-xxxxx
```

### 5. Tools per Agent

All agents should have **28 tools** (26 custom + 2 built-in):

**Custom (`dealbot_tools` — 26):**
- Cala (4): `calaSearch`, `calaQuery`, `calaSearchEntities`, `calaGetEntity`
- Specter (9): `specterEnrich`, `specterCompanyById`, `specterSimilarCompanies`, `specterCompanyPeople`, `specterEnrichPerson`, `specterPersonById`, `specterPersonEmail`, `specterSearchName`, `specterTextSearch`
- Tavily (5): `tavilyWebSearch`, `tavilyExtract`, `tavilyCrawl`, `tavilyResearch`, `tavilyResearchStatus`
- Advanced (4): `webExtract`, `difyAgentFC`, `difyAgentReAct`, `lightpandaScrape`
- Triggers (3): `calaCreateTrigger`, `calaSubscribeTrigger`, `calaListTriggers`
- Utility (1): `toolHealth`

**Built-in (2) — FREE, preferred for web search:**
- `ddgo_search` (DuckDuckGo Search) — use FIRST for all web lookups
- `webscraper` (Web Scraper) — extract content from URLs

### 6. API Call Pattern

```bash
curl -X POST https://api.dify.ai/v1/chat-messages \
  -H "Authorization: Bearer app-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "inputs": {
      "deal_input": "{...}",
      "fund_config": "{...}",
      "specialization": "market",
      "analyst_id": "analyst_1",
      "company_profile": "{...}",
      "prior_analyses": "[]"
    },
    "query": "Analyze this deal.",
    "response_mode": "streaming",
    "user": "deal-bot-orchestrator"
  }'
```

Response mode must be `streaming` for agent-chat apps (`blocking` returns 400).

## Console API Reference

Dify Cloud uses HttpOnly cookies + CSRF token. See `console-api.js` for ready-made scripts:

| # | Script | Status |
|---|--------|--------|
| 1 | List apps | ✅ Works |
| 2 | Create blank agents | ✅ Works (recommended) |
| 3 | Import from Gist URL | ⚠️ Creates apps but they crash on use |
| 4 | Get API keys | ✅ Works |
| 5 | POST model-config | ✅ Works (use POST, not PUT!) |
| 6 | Inspect agent config | ✅ Works (uses list endpoint) |
| 7 | Delete apps | ✅ Works |
| 8 | Full setup (combined) | ✅ Template ready |

**Dedicated config scripts:**
- `push-analyst-config.js` — Full analyst prompt + vars + built-in tools
- `push-associate-partner-config.js` — Both associate + partner in one script

## Known Dify Cloud Bugs

| Bug | Impact | Workaround |
|-----|--------|------------|
| `psycopg2.errors.InFailedSqlTransaction` on `annotation_reply` | GET /apps/{id} returns 400, frontend crashes | Use list endpoint instead; avoid DSL import |
| DSL-imported agents → 500 on real inputs | Agents created but unusable | Create blank agents + configure via POST model-config |
| GET /apps/{id}/model-config → 405 | Cannot read agent config via detail endpoint | Read `model_config` from list endpoint response |
| Custom tool `provider_id` as string → 500 | POST model-config fails with string name | Use UUID from `/workspaces/current/tool-providers` |
| Frontend error on click into apps | Cannot access app settings in UI | Use console API scripts |

## Troubleshooting

- **Tools show "deleted"**: Re-create `dealbot_tools` provider with latest `openapi-tools.json`
- **Agent doesn't call tools**: Check prompt says "MUST call tools before analysis"
- **401 from tool calls**: Verify server URL in custom tool provider matches deployment
- **Frontend error on click**: Use `console-api.js` workarounds (CSRF token approach)
- **500 from DSL-imported agent**: Delete and recreate as blank agent via console API
- **400 with blocking mode**: Use `response_mode: "streaming"` for agent-chat apps
