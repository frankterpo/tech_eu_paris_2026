# Partner Docs Map + Setup (No Excuses)

## Skybridge (Alpic)

Docs: https://docs.skybridge.tech/home
We use:
- ChatGPT App UI (React)
- Tool wiring to call orchestrator endpoints
- Local dev emulator / fast iteration
- MCP configuration (can be configured dynamically per Alpic founder note)

Search keywords in docs:
- Apps SDK, Tools, Devtools emulator, MCP, Secrets/Auth

## Cala

Docs: https://docs.cala.ai/
We use:
- Knowledge Search API to retrieve evidence items
- Optional entity drill endpoint if needed

Implementation:
- integrations/cala/client.ts
- Normalize evidence items into: {evidence_id, snippet, source, url}

## Dify

Docs: https://docs.dify.ai/en/use-dify/getting-started/introduction
We use:
- Workflow/Chatflow to implement personas (analyst/associate/partner)
- Publish workflow as API endpoint (Orchestrator calls it)

NOTE: DIFY API key not in .env yet; stub mode must exist.

## Specter

Docs: https://api.tryspecter.com/api-ref/introduction
We use:
- Company enrichment by domain: `POST /api/v1/companies` with `X-API-Key` header
- Returns: funding, employees, growth stage, traction metrics, investors, highlights, web traffic, social metrics, IP, news

Implementation:
- integrations/specter/client.ts
- Runs parallel with Cala during evidence seed
- Normalizes key fields into Evidence items (source: specter, evidence_ids: specter-*)
- Also stores raw CompanyProfile on deal_state for direct analyst access

## fal (optional)

Docs: https://docs.fal.ai/
Use only if time:
- Generate "Decision Gate Card" image from final decision_gate JSON.

## Gradium (optional)

Docs: https://gradium.ai/api_docs.html
Use only if time:
- Voice input/output for demo flair.

## Environment keys

All API keys present in .env:
- `OPENAI_API_KEY` — OpenAI
- `ALPIC_API_KEY` — Skybridge / Alpic
- `CALA_API_KEY` — Cala evidence retrieval (real)
- `SPECTER_API_KEY` — Specter company enrichment (real)
- `ANALYST_DIFY_KEY` — Dify analyst workflow (real)
- `ASSOCIATE_DIFY_KEY` — Dify associate workflow (real)
- `PARTNER_DIFY_KEY` — Dify partner workflow (real)
- `FAL_AI_API_KEY` — fal (optional)
- `GRADIUM_API_KEY` — Gradium (optional)

So:
- Cala + Specter integrations MUST be real
- Dify integration MUST be pluggable (stub mode if keys missing)
