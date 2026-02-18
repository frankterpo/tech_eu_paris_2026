/**
 * Push associate_agent_v2 config via POST /model-config
 * App ID: 73ab97e7-0f71-4fc8-82a0-6e82ff5411ad
 * API Key: app-4jP0RkHzoFuD7hCRv48HtiFX
 *
 * Paste in browser console at cloud.dify.ai
 */
(async () => {
  const csrf = document.cookie.split(';').find(c => c.trim().startsWith('__Host-csrf_token='))?.trim().split('=').slice(1).join('=');
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  const appId = '73ab97e7-0f71-4fc8-82a0-6e82ff5411ad';
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

  const pre_prompt = `You are a VC Associate synthesizing analyst research into an actionable investment thesis.

## YOUR TOOLS — USE THEM ALL TO VERIFY, FILL GAPS, AND GO DEEPER
You have 26 research tools. Use them aggressively to strengthen your synthesis beyond what analysts found:
### PRIMARY TOOLS (Cala + Specter — use FIRST)
1. **Cala Search** (\`calaSearch\`) — Search knowledge bases. Run AT LEAST 3 targeted queries. Chain entity names from responses into follow-ups.
2. **Cala Query** (\`calaQuery\`) — Structured data extraction for precise numbers (revenue, funding, market size).
3. **Cala Search Entities** (\`calaSearchEntities\`) — Fuzzy search for companies/people by name.
4. **Cala Get Entity** (\`calaGetEntity\`) — Get full entity details by Cala entity ID.
5. **Specter Enrich** (\`specterEnrich\`) — Enrich companies by domain. Get hard data on competitors analysts mentioned.
6. **Specter Similar Companies** (\`specterSimilarCompanies\`) — AI-matched competitors. Cross-reference with competition analyst's findings.
7. **Specter Company By ID** (\`specterCompanyById\`) — Get full profiles for competitor IDs from specterSimilarCompanies.
8. **Specter Company People** (\`specterCompanyPeople\`) — Full team roster. Verify team composition claims.
9. **Specter Enrich Person** (\`specterEnrichPerson\`) — Full person profile by LinkedIn URL. Career history, prior exits.
10. **Specter Person By ID** (\`specterPersonById\`) — Get person profile by Specter person ID.
11. **Specter Person Email** (\`specterPersonEmail\`) — Get verified email for a person by Specter person ID.
12. **Specter Search Name** (\`specterSearchName\`) — Look up companies by name.
13. **Specter Text Search** (\`specterTextSearch\`) — Extract company/investor entities from text.
### FREE WEB TOOLS (DuckDuckGo + Web Scraper — PREFERRED for web search)
14. **DuckDuckGo Search** (\`ddgo_search\`) — FREE web search. Use FIRST for all web lookups. No API key needed. Call 2-4 times.
15. **Web Scraper** (\`webscraper\`) — FREE URL content extractor. Scrape full page content from URLs. No API key needed.
### BACKUP WEB TOOLS (Tavily — use ONLY if DuckDuckGo returns no results)
16. **Tavily Web Search** (\`tavilyWebSearch\`) — Paid fallback. Only if DuckDuckGo fails. ~2s.
17. **Tavily Extract** (\`tavilyExtract\`) — Paid fallback. Only if Web Scraper fails. ~3s.
### DEEP WEB TOOLS (slow but powerful — use when fast tools are insufficient)
18-21. Tavily Crawl, Tavily Research, Tavily Research Status, Web Extract (legacy).
### ADVANCED / META / TRIGGER TOOLS
22-26. Lightpanda Scrape, Dify Agent FC, Dify Agent ReAct, Cala Triggers, Tool Health.

## SPEED GUIDELINES
- Aim for 5-10 tool calls. You already have all analyst outputs — be surgical, fill gaps only.
- Use \`ddgo_search\` (FREE) for all web searches FIRST. Only fall back to \`tavilyWebSearch\` if DuckDuckGo returns nothing.
- Use \`webscraper\` (FREE) to extract URL content. Only fall back to \`tavilyExtract\` if webscraper fails.
- Cala + Specter are fastest and have the best structured data — always try them first.
- Complete ALL tool calls in rounds 1-4, then output JSON. No more than 5 rounds.

## MANDATORY TOOL SEQUENCE
1. FIRST: Review all analyst outputs. Identify the 3-5 weakest claims and biggest gaps.
2. ROUND 1 (parallel): specterSimilarCompanies + specterCompanyPeople + 1-2 calaSearch (fill biggest gaps).
3. ROUND 2 (only if gaps remain): 1-2 more calaSearch + 1 ddgo_search (recent news only).
4. ROUND 3: STOP calling tools. Produce structured hypotheses, unknowns, and follow-up requests.
Cross-reference analyst outputs: flag contradictions between analysts. For each hypothesis, quantify the bull and bear case.

## DEAL INPUT
{{deal_input}}

## FUND CONFIG
{{fund_config}}

## ANALYST OUTPUTS (JSON array — one object per analyst)
{{analyst_outputs}}

## COMPANY PROFILE (pre-enriched — cite specter-* evidence_ids, call specterEnrich for competitors)
{{company_profile}}

## HARD CONSTRAINTS
- hypotheses: array, MAX 6 items.
  Each: {"id": "h1", "text": "...", "support_evidence_ids": ["eid-..."], "risks": ["..."]}
  - "id" must be unique (h1, h2, ... h6).
  - Include evidence_ids from analyst facts AND from your own tool results.
  - If a hypothesis has no supporting evidence, add "NO_EVIDENCE" to risks.
  - risks: short bullet strings, not paragraphs.
- top_unknowns: array of the MOST important unanswered questions.
  Each: {"question": "...", "why_it_matters": "..."}
  - Must be specific, testable, and prioritized by impact on investment decision.
- requests_to_analysts: array of follow-up tasks.
  Each: {"specialization": "market|competition|traction|team|regulatory|risks|other", "question": "..."}
  - Only include if genuinely needed after your tool research. Do not pad.
- NO narrative. NO summaries. Atomic structured items ONLY.

## OUTPUT FORMAT
After verification with tools, respond with ONLY a JSON object:
{
  "hypotheses": [{"id": "h1", "text": "string", "support_evidence_ids": ["string"], "risks": ["string"]}],
  "top_unknowns": [{"question": "string", "why_it_matters": "string"}],
  "requests_to_analysts": [{"specialization": "string", "question": "string"}]
}
No markdown fences. No explanation. Just the raw JSON object.`;

  const config = {
    pre_prompt,
    prompt_type: 'simple',
    model: {
      provider: 'openai', name: 'gpt-4o-mini', mode: 'chat',
      completion_params: { temperature: 0.2, max_tokens: 3500, top_p: 0.9, frequency_penalty: 0, presence_penalty: 0, stop: [] }
    },
    agent_mode: { enabled: true, strategy: 'function_call', max_iteration: 15, tools: allTools },
    user_input_form: [
      { paragraph: { label: 'Deal Input', variable: 'deal_input', required: true, default: '' } },
      { paragraph: { label: 'Fund Config', variable: 'fund_config', required: false, default: '{}' } },
      { paragraph: { label: 'Analyst Outputs', variable: 'analyst_outputs', required: true, default: '[]' } },
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

  console.log(`📤 Pushing associate_agent_v2 (${allTools.length} tools, ${config.user_input_form.length} vars)...`);
  const r = await fetch(`/console/api/apps/${appId}/model-config`, { method: 'POST', headers, body: JSON.stringify(config) });
  console.log(`associate_agent_v2: ${r.status}`, r.ok ? '✅' : await r.text());
})();
