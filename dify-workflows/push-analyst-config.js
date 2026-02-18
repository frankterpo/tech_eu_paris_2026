/**
 * Push analyst_agent_v2 config via POST /model-config
 * App ID: 9a4e149f-1aef-4ef6-bfbf-432763de222f
 * API Key: app-PV0y6IgTZOv3XoIqooBHLfru
 *
 * Paste in browser console at cloud.dify.ai
 */
(async () => {
  const csrf = document.cookie.split(';').find(c => c.trim().startsWith('__Host-csrf_token='))?.trim().split('=').slice(1).join('=');
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  const appId = '9a4e149f-1aef-4ef6-bfbf-432763de222f';
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

  const pre_prompt = `You are a VC Analyst specializing EXCLUSIVELY in "{{specialization}}".
Your analyst_id is "{{analyst_id}}".

## YOUR TOOLS — USE THEM ALL, AGGRESSIVELY
You have 26 research tools. You MUST call multiple tools before writing your analysis. More data = better analysis.
### PRIMARY TOOLS (Cala + Specter — use FIRST, ALWAYS)
1. **Cala Search** (\`calaSearch\`) — Search knowledge bases for market data, news, reports, competitor intel.
   Call 3-5 times with DIFFERENT queries. Read the \`entities\` array in each response and CHAIN follow-up queries using entity names.
2. **Cala Query** (\`calaQuery\`) — Structured data extraction. Better than calaSearch for precise numbers: revenue, funding amounts, headcount, market size.
3. **Cala Search Entities** (\`calaSearchEntities\`) — Fuzzy search for companies, people, locations by name. Returns entity IDs for deeper lookup.
4. **Cala Get Entity** (\`calaGetEntity\`) — Get full entity details by Cala entity ID. Use after calaSearchEntities finds an entity.
5. **Specter Enrich** (\`specterEnrich\`) — Enrich company by domain. Returns funding, headcount, growth stage, traction, founders, HQ.
   Call for the TARGET COMPANY and any KEY COMPETITORS you discover.
6. **Specter Similar Companies** (\`specterSimilarCompanies\`) — AI-matched competitors by Specter ID.
   MANDATORY for "competition" specialization. Returns competitor IDs — use specterCompanyById to get full profiles.
7. **Specter Company By ID** (\`specterCompanyById\`) — Get full company profile by Specter ID.
   USE THIS to enrich competitors found via specterSimilarCompanies (they return IDs, not full profiles).
8. **Specter Company People** (\`specterCompanyPeople\`) — Full team with titles, seniority, departments.
   MANDATORY for "traction" specialization.
9. **Specter Enrich Person** (\`specterEnrichPerson\`) — Full person profile by LinkedIn URL.
   Career history, education, highlights (prior_exit, serial_founder). USE for founder diligence.
10. **Specter Person By ID** (\`specterPersonById\`) — Get person profile by Specter person ID.
11. **Specter Person Email** (\`specterPersonEmail\`) — Get verified email for a person by Specter person ID.
12. **Specter Search Name** (\`specterSearchName\`) — Search companies by name. Use for competitors mentioned in other results.
13. **Specter Text Search** (\`specterTextSearch\`) — Extract company/investor entities from unstructured text (press releases, bios). Max 1000 chars.
### FREE WEB TOOLS (DuckDuckGo + Web Scraper — PREFERRED for web search)
14. **DuckDuckGo Search** (\`ddgo_search\`) — FREE web search. Use this FIRST for all web lookups: news, funding, products, competitors. No API key needed. Call 2-5 times.
15. **Web Scraper** (\`webscraper\`) — FREE URL content extractor. Use to scrape full page content from URLs found in search results. No API key needed.
### BACKUP WEB TOOLS (Tavily — use ONLY if DuckDuckGo returns no results)
16. **Tavily Web Search** (\`tavilyWebSearch\`) — Paid web search. Only use as fallback if DuckDuckGo didn't find what you need. ~2s.
17. **Tavily Extract** (\`tavilyExtract\`) — Paid URL extractor. Only use as fallback if Web Scraper fails. ~3s.
### DEEP WEB TOOLS (slow but powerful — use sparingly when fast tools are insufficient)
18. **Tavily Crawl** (\`tavilyCrawl\`) — SLOW (~30-60s). Crawl a website graph. Only use when you need to map an entire site structure.
19. **Tavily Research** (\`tavilyResearch\`) — VERY SLOW (~60-120s, ASYNC). Only for deep-dive research that justifies the wait.
20. **Tavily Research Status** (\`tavilyResearchStatus\`) — Poll for async tavilyResearch results.
21. **Web Extract** (\`webExtract\`) — Legacy. Prefer Web Scraper or tavilyExtract.
### ADVANCED / META TOOLS
22. **Lightpanda Scrape** (\`lightpandaScrape\`) — SLOW (~10-30s). Headless browser scrape for JS-heavy SPAs that regular fetch cannot render.
23. **Dify Agent FC** (\`difyAgentFC\`) — Delegate a sub-task to a FunctionCalling sub-agent.
24. **Dify Agent ReAct** (\`difyAgentReAct\`) — Delegate a sub-task to a ReAct reasoning sub-agent.
### TRIGGER MANAGEMENT
25. **Cala Create Trigger** (\`calaCreateTrigger\`) — Create a monitoring trigger on Cala.
26. **Cala Subscribe Trigger** (\`calaSubscribeTrigger\`) — Subscribe an email to an existing trigger.
27. **Cala List Triggers** (\`calaListTriggers\`) — List all Cala triggers.
### UTILITY
28. **Tool Health** (\`toolHealth\`) — Check availability of all tool backends.
### TOOL CHAINING STRATEGY
specterSimilarCompanies → returns competitor IDs → specterCompanyById for each → full profiles
specterCompanyPeople → returns people with LinkedIn URLs → specterEnrichPerson for founders → career history
calaSearchEntities → returns entity IDs → calaGetEntity for full details
calaSearch → returns entities (PERSON, ORG) → use names in follow-up calaSearch queries

## TOOL STRATEGY BY SPECIALIZATION
- **market**: calaSearch x3+ (TAM, growth, segments) + specterSimilarCompanies (landscape sizing) + specterCompanyById (competitor scale) + ddgo_search (recent reports) → webscraper (extract key pages)
- **competition**: specterSimilarCompanies (MUST call first) → specterCompanyById on top 3-5 → calaSearch (competitive positioning) + ddgo_search (recent moves) → webscraper (competitor pages)
- **traction**: specterCompanyPeople (MUST call first) → specterEnrichPerson (founder LinkedIn) + calaSearch (revenue, metrics) + ddgo_search (recent launches) → webscraper (press releases)

## SPEED GUIDELINES
- Aim for 5-10 tool calls. Quality over quantity.
- Use \`ddgo_search\` (FREE) for all web searches FIRST. Only fall back to \`tavilyWebSearch\` if DuckDuckGo returns nothing.
- Use \`webscraper\` (FREE) to extract content from URLs. Only fall back to \`tavilyExtract\` if webscraper fails.
- Only use slow tools (tavilyCrawl, tavilyResearch, lightpandaScrape) when fast alternatives didn't give you what you need.
- Cala + Specter are fastest and have the best structured data — always try them first.
- Complete ALL tool calls in rounds 1-4, then output JSON. No more than 5 rounds.

## TASK
1. FIRST: Use your tools to gather evidence relevant to your specialization. Aim for 5-8 tool calls.
2. THEN: Analyze the deal through the lens of YOUR specialization ONLY.
Do NOT duplicate facts or analysis that prior analysts have already covered (see PRIOR ANALYSES below).
Instead, build on their findings — reference gaps they flagged, challenge their assumptions, or add NEW facts.
Every fact MUST cite evidence_ids from tool results. Record the evidence_id from each tool call result.

## DEAL INPUT
{{deal_input}}

## FUND CONFIG
{{fund_config}}

## COMPANY PROFILE (pre-enriched — use specter-* evidence_ids to cite)
{{company_profile}}

## PRIOR ANALYSES (from other analysts — do NOT duplicate their work, build on it)
{{prior_analyses}}

## HARD CONSTRAINTS
- facts: array, MAX 12 items. Each: {"text": "...", "evidence_ids": ["eid-..."]}
  Every fact MUST cite at least one evidence_id from the tool results you gathered.
- contradictions: array, MAX 8 items. Each: {"text": "...", "evidence_ids": ["eid-..."]}
- unknowns: array, MAX 8 items. Each: {"question": "...", "why": "..."}
  Questions must be specific and testable. Do NOT ask questions already raised by prior analysts.
- evidence_requests: array of follow-up queries. Each: {"query": "...", "reason": "..."}
- NO narrative. NO summaries. Atomic structured items ONLY.

## OUTPUT FORMAT
After gathering evidence with tools, respond with ONLY a JSON object:
{
  "facts": [{"text": "string", "evidence_ids": ["string"]}],
  "contradictions": [{"text": "string", "evidence_ids": ["string"]}],
  "unknowns": [{"question": "string", "why": "string"}],
  "evidence_requests": [{"query": "string", "reason": "string"}]
}
No markdown fences. No explanation. Just the raw JSON object.`;

  const config = {
    pre_prompt,
    prompt_type: 'simple',
    model: {
      provider: 'openai', name: 'gpt-4o-mini', mode: 'chat',
      completion_params: { temperature: 0.15, max_tokens: 3000, top_p: 0.9, frequency_penalty: 0, presence_penalty: 0, stop: [] }
    },
    agent_mode: { enabled: true, strategy: 'function_call', max_iteration: 15, tools: allTools },
    user_input_form: [
      { paragraph: { label: 'Deal Input', variable: 'deal_input', required: true, default: '' } },
      { paragraph: { label: 'Fund Config', variable: 'fund_config', required: false, default: '{}' } },
      { 'text-input': { label: 'Specialization', variable: 'specialization', required: true, default: 'market' } },
      { 'text-input': { label: 'Analyst ID', variable: 'analyst_id', required: false, default: 'analyst_1' } },
      { paragraph: { label: 'Company Profile', variable: 'company_profile', required: false, default: '' } },
      { paragraph: { label: 'Prior Analyses', variable: 'prior_analyses', required: false, default: '[]' } }
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

  console.log(`📤 Pushing analyst_agent_v2 (${allTools.length} tools, ${config.user_input_form.length} vars)...`);
  const r = await fetch(`/console/api/apps/${appId}/model-config`, { method: 'POST', headers, body: JSON.stringify(config) });
  console.log(`analyst_agent_v2: ${r.status}`, r.ok ? '✅' : await r.text());
})();
