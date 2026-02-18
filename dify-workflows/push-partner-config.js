/**
 * Push partner_agent_v2 config via POST /model-config
 * App ID: be759e29-2183-4d30-a741-ecf3dd8717f7
 * API Key: app-EvLZXmR5NiDCpuLMEaPEoSb4
 *
 * Paste in browser console at cloud.dify.ai
 */
(async () => {
  const csrf = document.cookie.split(';').find(c => c.trim().startsWith('__Host-csrf_token='))?.trim().split('=').slice(1).join('=');
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  const appId = 'be759e29-2183-4d30-a741-ecf3dd8717f7';
  const PID = '53b57651-a62c-41dc-b140-b120993ed599';

  const dt = (name, label, params) => ({
    enabled: true, isDeleted: false, notAuthor: false,
    provider_id: PID, provider_name: 'dealbot_tools', provider_type: 'api',
    tool_label: label, tool_name: name, tool_parameters: params
  });

  const allTools = [
    { enabled: true, isDeleted: false, notAuthor: false, provider_id: 'duckduckgo', provider_name: 'duckduckgo', provider_type: 'builtin', tool_label: 'DuckDuckGo Search', tool_name: 'ddgo_search', tool_parameters: {} },
    { enabled: true, isDeleted: false, notAuthor: false, provider_id: 'webscraper', provider_name: 'webscraper', provider_type: 'builtin', tool_label: 'Web Scraper', tool_name: 'webscraper', tool_parameters: { url: '', user_agent: '' } },
    dt('calaSearch', 'Cala Search', { query: '' }),
    dt('calaQuery', 'Cala Query', { query: '' }),
    dt('calaSearchEntities', 'Cala Search Entities', { name: '' }),
    dt('calaGetEntity', 'Cala Get Entity', { entity_id: '' }),
    dt('specterEnrich', 'Specter Enrich', { domain: '' }),
    dt('specterSimilarCompanies', 'Specter Similar Companies', { company_id: '' }),
    dt('specterCompanyById', 'Specter Company By ID', { company_id: '' }),
    dt('specterCompanyPeople', 'Specter Company People', { company_id: '' }),
    dt('specterEnrichPerson', 'Specter Enrich Person', { linkedin_url: '' }),
    dt('specterPersonById', 'Specter Person By ID', { person_id: '' }),
    dt('specterPersonEmail', 'Specter Person Email', { person_id: '' }),
    dt('specterSearchName', 'Specter Search Name', { query: '' }),
    dt('specterTextSearch', 'Specter Text Search', { text: '' }),
    dt('tavilyWebSearch', 'Tavily Web Search', { query: '' }),
    dt('tavilyExtract', 'Tavily Extract', { urls: '' }),
    dt('tavilyCrawl', '[SLOW] Tavily Crawl', { url: '' }),
    dt('tavilyResearch', '[VERY SLOW] Tavily Research', { input: '' }),
    dt('tavilyResearchStatus', 'Tavily Research Status', {}),
    dt('webExtract', 'Web Extract (legacy)', { url: '' }),
    dt('difyAgentFC', 'Dify Agent (FunctionCalling)', { query: '' }),
    dt('difyAgentReAct', 'Dify Agent (ReAct)', { query: '' }),
    dt('lightpandaScrape', '[SLOW] Lightpanda Scrape', { url: '' }),
    dt('calaCreateTrigger', 'Cala Create Trigger', { query: '', email: '' }),
    dt('calaSubscribeTrigger', 'Cala Subscribe Trigger', { trigger_id: '', email: '' }),
    dt('calaListTriggers', 'Cala List Triggers', {}),
  ];

  const pre_prompt = `You are a VC Partner making the final investment decision on a deal.

## YOUR TOOLS — FACT-CHECK AGGRESSIVELY BEFORE SCORING
You have 26 research tools. Use them ALL to convert ASSUMPTIONS into EVIDENCE. The more evidence, the stronger the decision:
### PRIMARY TOOLS (Cala + Specter — use FIRST to fact-check)
1. **Cala Search** (\`calaSearch\`) — Search for evidence to validate or challenge hypotheses. Run AT LEAST 2 queries. Chain entity names from responses.
2. **Cala Query** (\`calaQuery\`) — Structured data for precise numbers. Better for verifying specific claims (revenue, funding amounts).
3. **Cala Search Entities** (\`calaSearchEntities\`) — Fuzzy search for companies/people by name.
4. **Cala Get Entity** (\`calaGetEntity\`) — Get full entity details by Cala entity ID.
5. **Specter Enrich** (\`specterEnrich\`) — Hard data by domain (funding, headcount, traction).
6. **Specter Similar Companies** (\`specterSimilarCompanies\`) — AI-matched competitors. Benchmark on funding, team, growth stage. Feeds Market + Moat scores.
7. **Specter Company By ID** (\`specterCompanyById\`) — Full profiles for competitor IDs from specterSimilarCompanies. USE THIS to compare competitor metrics.
8. **Specter Company People** (\`specterCompanyPeople\`) — Verify leadership depth. Complete C-suite? Feeds Execution score.
9. **Specter Enrich Person** (\`specterEnrichPerson\`) — Full person profile by LinkedIn URL. Verify founder track records, prior exits.
10-13. specterPersonById, specterPersonEmail, specterSearchName, specterTextSearch.
### FREE WEB TOOLS (DuckDuckGo + Web Scraper — PREFERRED for web search)
14. **DuckDuckGo Search** (\`ddgo_search\`) — FREE web search. Use FIRST for all web lookups. No API key needed.
15. **Web Scraper** (\`webscraper\`) — FREE URL content extractor. Scrape full page content from URLs. No API key needed.
### BACKUP WEB TOOLS (Tavily — use ONLY if DuckDuckGo returns no results)
16-17. tavilyWebSearch (paid fallback), tavilyExtract (paid fallback).
### DEEP WEB / ADVANCED / TRIGGER TOOLS
18-26. tavilyCrawl, tavilyResearch, tavilyResearchStatus, webExtract, lightpandaScrape, difyAgentFC, difyAgentReAct, Cala Triggers, toolHealth.

IMPORTANT: Use tools BEFORE scoring the rubric. The more evidence you gather, the fewer ASSUMPTIONS in your checklist, and the stronger your decision.

## SPEED GUIDELINES
- Aim for 4-8 tool calls. You already have rich evidence from analysts + associate. Be surgical.
- Use \`ddgo_search\` (FREE) for all web searches FIRST. Only fall back to \`tavilyWebSearch\` if DuckDuckGo returns nothing.
- Use \`webscraper\` (FREE) to extract URL content. Only fall back to \`tavilyExtract\` if webscraper fails.
- Cala + Specter are fastest AND best for structured data — always try them first.
- Complete ALL tool calls in rounds 1-3, then produce output. No more than 4 rounds total.

## MANDATORY TOOL SEQUENCE
1. FIRST: Review associate synthesis. Identify the 2-3 weakest hypotheses (highest assumption ratio).
2. ROUND 1 (parallel): specterCompanyPeople + specterSimilarCompanies + 1 calaSearch (stress-test bull case)
3. ROUND 2 (only if gaps): 1 calaSearch (verify specific claim) + 1 ddgo_search (recent news check)
4. ROUND 3: STOP calling tools. Score the rubric and produce the Decision Gate immediately.

## DEAL INPUT
{{deal_input}}

## FUND CONFIG
{{fund_config}}

## ASSOCIATE SYNTHESIS (hypotheses, unknowns, requests)
{{associate_output}}

## COMPANY PROFILE (pre-enriched — cite specter-* evidence_ids)
{{company_profile}}

## HARD CONSTRAINTS — VIOLATING ANY OF THESE INVALIDATES YOUR OUTPUT
### Rubric
- 5 dimensions: market, moat, why_now, execution, deal_fit
- Each dimension: {"score": 0-100, "reasons": ["...", ...]}
- reasons: MAX 4 short bullet strings per dimension. No paragraphs.
- Scores must reflect actual evidence strength, not optimism.
### Decision Gate
- decision: EXACTLY one of "KILL", "PROCEED", or "PROCEED_IF"
- gating_questions: EXACTLY 3 items. Not 2. Not 4. Exactly 3.
  Each must be a short, specific, testable question.
- evidence_checklist: MAX 15 items TOTAL across all questions.
  Each item: {"q": 1|2|3, "item": "...", "type": "EVIDENCE"|"ASSUMPTION", "evidence_ids": ["eid-..."]}
  - q: which gating question (1, 2, or 3) this item supports.
  - type "EVIDENCE": must have at least one evidence_id from analyst facts, associate hypotheses, or your tool results.
  - type "ASSUMPTION": evidence_ids should be empty [].
### Evidence/Assumption Rule (CRITICAL)
- Any factual claim with NO supporting evidence_id -> mark as "ASSUMPTION".
- Count assumptions. If assumptions > 5 or assumptions > 40% of checklist -> decision CANNOT be "PROCEED". Must be "PROCEED_IF" or "KILL".
- Never hallucinate evidence IDs. Only reference IDs from inputs or your tool results.

## OUTPUT FORMAT
After fact-checking with tools, respond with ONLY a JSON object:
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
    "evidence_checklist": [
      {"q": 1, "item": "...", "type": "EVIDENCE", "evidence_ids": ["eid-..."]},
      {"q": 2, "item": "...", "type": "ASSUMPTION", "evidence_ids": []}
    ]
  }
}
No markdown fences. No explanation. Just the raw JSON object.`;

  const config = {
    pre_prompt,
    prompt_type: 'simple',
    model: {
      provider: 'openai', name: 'gpt-4o-mini', mode: 'chat',
      completion_params: { temperature: 0.1, max_tokens: 4500, top_p: 0.9, frequency_penalty: 0, presence_penalty: 0, stop: [] }
    },
    agent_mode: { enabled: true, strategy: 'function_call', max_iteration: 15, tools: allTools },
    user_input_form: [
      { paragraph: { label: 'Deal Input', variable: 'deal_input', required: true, default: '' } },
      { paragraph: { label: 'Fund Config', variable: 'fund_config', required: false, default: '{}' } },
      { paragraph: { label: 'Associate Output', variable: 'associate_output', required: true, default: '' } },
      { paragraph: { label: 'Company Profile', variable: 'company_profile', required: false, default: '' } }
    ],
    opening_statement: '',
    suggested_questions: [],
    suggested_questions_after_answer: { enabled: false },
    speech_to_text: { enabled: false },
    text_to_speech: { enabled: false },
    retriever_resource: { enabled: false },
    more_like_this: { enabled: false },
    sensitive_word_avoidance: { configs: [], enabled: false, type: '' },
    file_upload: { image: { detail: 'high', enabled: false, number_limits: 3, transfer_methods: ['remote_url', 'local_file'] } },
    dataset_configs: { datasets: { datasets: [] }, retrieval_model: 'single' },
    dataset_query_variable: '',
    external_data_tools: [],
    chat_prompt_config: {},
    completion_prompt_config: {}
  };

  console.log(`📤 Pushing partner_agent_v2 (${allTools.length} tools, ${config.user_input_form.length} vars)...`);
  const r = await fetch(`/console/api/apps/${appId}/model-config`, { method: 'POST', headers, body: JSON.stringify(config) });
  console.log(`partner_agent_v2: ${r.status}`, r.ok ? '✅' : await r.text());
})();
