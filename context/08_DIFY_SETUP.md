# Dify Setup (workflow-based personas)

## What to build in Dify

Create THREE workflows (or one workflow with a role switch):
1. analyst_workflow_v1
2. associate_workflow_v1
3. partner_workflow_v1

Each must:
- accept: deal_input, fund_config, persona_config, evidence_json, memory_json
- output STRICT JSON matching schemas in context/04_DATA_MODELS_AND_EVENTS.md

## How to create (aligned with your screenshots)

1. Dify → Create App → Workflow/Chatflow
2. Add input variables
3. LLM node: prompt = STRICT JSON only + schema pasted
4. JSON parse node to enforce JSON
5. (Optional) aggregator/assign variables nodes
6. Publish → obtain API endpoint + API key

## After publishing

Add to .env:
- DIFY_BASE_URL
- DIFY_API_KEY

Then orchestrator stops stub mode and calls Dify for persona turns.

## Until then

Stub mode must:
- return valid JSON for each persona schema
- still emit events and render simulation (so demo is never blocked)
