/**
 * Slice A1: Tool API Endpoints
 * Expose Cala search + Specter enrichment as REST endpoints
 * so Dify Agent nodes can call them as tools during reasoning.
 *
 * Keys stay server-side — agents don't need to know API credentials.
 */
import { Router } from 'express';
import { CalaClient } from './integrations/cala/client.js';
import { SpecterClient } from './integrations/specter/client.js';
import { TavilyClient } from './integrations/tavily/client.js';
import { DifyClient } from './integrations/dify/client.js';
import { PersistenceManager } from './persistence.js';

export const toolRouter = Router();

/**
 * POST /api/tools/cala/search
 * Body: { query: string }
 * Returns: { evidence: Evidence[] }
 */
toolRouter.post('/cala/search', async (req, res) => {
  const { query } = req.body;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or empty "query" string in request body.' });
  }

  try {
    console.log(`[ToolAPI] Cala search: "${query.slice(0, 80)}..."`);
    const actionId = PersistenceManager.startToolAction({ toolName: 'calaSearch', provider: 'cala', operation: 'search', input: { query: query.trim() }, calledBy: 'dify-agent' });
    const start = Date.now();
    const result = await CalaClient.searchFull(query.trim());
    PersistenceManager.completeToolAction(actionId, { status: 'success', latencyMs: Date.now() - start, resultCount: result.evidence.length });
    PersistenceManager.logQuery({ toolActionId: actionId, queryText: query.trim(), queryType: 'search', provider: 'cala', resultCount: result.evidence.length, answerText: result.content?.slice(0, 500) });
    res.json({
      content: result.content,
      evidence: result.evidence,
      entities: result.entities,
      explainability: result.explainability,
      count: result.evidence.length,
    });
  } catch (error: any) {
    console.error(`[ToolAPI] Cala search error:`, error.message);
    res.status(502).json({ error: `Cala search failed: ${error.message}`, content: '', evidence: [], entities: [] });
  }
});

/**
 * POST /api/tools/specter/enrich
 * Body: { domain: string }
 * Returns: { profile: CompanyProfile | null, evidence: Evidence[] }
 */
toolRouter.post('/specter/enrich', async (req, res) => {
  const { domain } = req.body;

  if (!domain || typeof domain !== 'string' || domain.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or empty "domain" string in request body.' });
  }

  try {
    console.log(`[ToolAPI] Specter enrich: "${domain}"`);
    const actionId = PersistenceManager.startToolAction({ toolName: 'specterEnrich', provider: 'specter', operation: 'enrich', input: { domain: domain.trim() }, calledBy: 'dify-agent' });
    const start = Date.now();
    const result = await SpecterClient.enrichByDomain(domain.trim());
    PersistenceManager.completeToolAction(actionId, { status: 'success', latencyMs: Date.now() - start, resultCount: result.evidence.length });
    if (result.profile) PersistenceManager.cacheCompanyProfile(result.profile);
    res.json({
      profile: result.profile,
      evidence: result.evidence,
      count: result.evidence.length
    });
  } catch (error: any) {
    console.error(`[ToolAPI] Specter enrich error:`, error.message);
    res.status(502).json({ error: `Specter enrichment failed: ${error.message}`, profile: null, evidence: [] });
  }
});

/**
 * POST /api/tools/specter/similar
 * Body: { company_id: string }
 * Returns: { companies: SimilarCompany[], evidence: Evidence[], count: number }
 */
toolRouter.post('/specter/similar', async (req, res) => {
  const { company_id } = req.body;

  if (!company_id || typeof company_id !== 'string' || company_id.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or empty "company_id" string in request body.' });
  }

  try {
    console.log(`[ToolAPI] Specter similar: "${company_id}"`);
    const result = await SpecterClient.getSimilarCompanies(company_id.trim());
    res.json({
      companies: result.companies,
      evidence: result.evidence,
      count: result.companies.length,
      raw_ids: result.rawIds,
    });
  } catch (error: any) {
    console.error(`[ToolAPI] Specter similar error:`, error.message);
    res.status(502).json({ error: `Specter similar failed: ${error.message}`, companies: [], evidence: [], count: 0 });
  }
});

/**
 * POST /api/tools/specter/people
 * Body: { company_id: string }
 * Returns: { people: SpecterPerson[], evidence: Evidence[], count: number }
 */
toolRouter.post('/specter/people', async (req, res) => {
  const { company_id } = req.body;

  if (!company_id || typeof company_id !== 'string' || company_id.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or empty "company_id" string in request body.' });
  }

  try {
    console.log(`[ToolAPI] Specter people: "${company_id}"`);
    const result = await SpecterClient.getCompanyPeople(company_id.trim());
    res.json({
      people: result.people,
      evidence: result.evidence,
      count: result.people.length
    });
  } catch (error: any) {
    console.error(`[ToolAPI] Specter people error:`, error.message);
    res.status(502).json({ error: `Specter people failed: ${error.message}`, people: [], evidence: [], count: 0 });
  }
});

/**
 * POST /api/tools/specter/search-name
 * Body: { query: string }
 * Returns: { results: SimilarCompany[], evidence: Evidence[], count: number }
 */
toolRouter.post('/specter/search-name', async (req, res) => {
  const { query } = req.body;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or empty "query" string in request body.' });
  }

  try {
    console.log(`[ToolAPI] Specter name search: "${query}"`);
    const result = await SpecterClient.searchByName(query.trim());
    res.json({
      results: result.results,
      evidence: result.evidence,
      count: result.results.length
    });
  } catch (error: any) {
    console.error(`[ToolAPI] Specter name search error:`, error.message);
    res.status(502).json({ error: `Specter search failed: ${error.message}`, results: [], evidence: [], count: 0 });
  }
});

// ══════════════════════════════════════════════════════════════════════
// NEW ENDPOINTS — Specter advanced, Cala structured, Tavily web, Scrape
// ══════════════════════════════════════════════════════════════════════

/**
 * POST /api/tools/specter/text-search
 * Body: { text: string }  (max 1000 chars)
 * Extract company/investor entities from unstructured text.
 */
toolRouter.post('/specter/text-search', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'Missing "text" string in request body.' });
  }
  try {
    const result = await SpecterClient.textSearch(text.trim());
    res.json({ entities: result.entities, evidence: result.evidence, count: result.entities.length });
  } catch (error: any) {
    res.status(502).json({ error: `Text-search failed: ${error.message}`, entities: [], evidence: [] });
  }
});

/**
 * POST /api/tools/specter/company-by-id
 * Body: { company_id: string }
 * Get full company profile by Specter ID.
 */
toolRouter.post('/specter/company-by-id', async (req, res) => {
  const { company_id } = req.body;
  if (!company_id || typeof company_id !== 'string') {
    return res.status(400).json({ error: 'Missing "company_id" string.' });
  }
  try {
    const result = await SpecterClient.getCompanyById(company_id.trim());
    res.json({ profile: result.profile, evidence: result.evidence, count: result.evidence.length });
  } catch (error: any) {
    res.status(502).json({ error: error.message, profile: null, evidence: [] });
  }
});

/**
 * POST /api/tools/specter/enrich-person
 * Body: { linkedin_url?: string, linkedin_id?: string }
 * Enrich person by LinkedIn identifier. Returns profile_picture_url, career, skills.
 */
toolRouter.post('/specter/enrich-person', async (req, res) => {
  const { linkedin_url, linkedin_id } = req.body;
  if (!linkedin_url && !linkedin_id) {
    return res.status(400).json({ error: 'Provide linkedin_url or linkedin_id.' });
  }
  try {
    const identifier: any = {};
    if (linkedin_url) identifier.linkedin_url = linkedin_url;
    else identifier.linkedin_id = linkedin_id;
    const result = await SpecterClient.enrichPerson(identifier);
    res.json({ person: result.person, evidence: result.evidence });
  } catch (error: any) {
    res.status(502).json({ error: error.message, person: null, evidence: [] });
  }
});

/**
 * POST /api/tools/specter/person-by-id
 * Body: { person_id: string }
 * Get full person profile by Specter person ID.
 */
toolRouter.post('/specter/person-by-id', async (req, res) => {
  const { person_id } = req.body;
  if (!person_id || typeof person_id !== 'string') {
    return res.status(400).json({ error: 'Missing "person_id" string.' });
  }
  try {
    const result = await SpecterClient.getPersonById(person_id.trim());
    res.json({ person: result.person, evidence: result.evidence });
  } catch (error: any) {
    res.status(502).json({ error: error.message, person: null, evidence: [] });
  }
});

/**
 * POST /api/tools/specter/person-email
 * Body: { person_id: string, type?: 'professional' | 'personal' }
 * Get verified email for a person.
 */
toolRouter.post('/specter/person-email', async (req, res) => {
  const { person_id, type } = req.body;
  if (!person_id || typeof person_id !== 'string') {
    return res.status(400).json({ error: 'Missing "person_id" string.' });
  }
  try {
    const result = await SpecterClient.getPersonEmail(person_id.trim(), type || 'professional');
    res.json({ email: result.email, evidence: result.evidence });
  } catch (error: any) {
    res.status(502).json({ error: error.message, email: null, evidence: [] });
  }
});

/**
 * POST /api/tools/cala/query
 * Body: { query: string }
 * Structured query — returns data objects + entities.
 */
toolRouter.post('/cala/query', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing "query" string.' });
  }
  try {
    const result = await CalaClient.query(query.trim());
    res.json({ results: result.results, entities: result.entities, evidence: result.evidence, count: result.results.length });
  } catch (error: any) {
    res.status(502).json({ error: error.message, results: [], entities: [], evidence: [] });
  }
});

/**
 * GET /api/tools/cala/entity/:entity_id
 * Get detailed entity information by Cala entity ID.
 */
toolRouter.get('/cala/entity/:entity_id', async (req, res) => {
  const entityId = parseInt(req.params.entity_id, 10);
  if (isNaN(entityId)) {
    return res.status(400).json({ error: 'entity_id must be an integer.' });
  }
  try {
    const result = await CalaClient.getEntity(entityId);
    res.json({ entity: result.entity, evidence: result.evidence });
  } catch (error: any) {
    res.status(502).json({ error: error.message, entity: null, evidence: [] });
  }
});

/**
 * POST /api/tools/cala/search-entities
 * Body: { name: string, entity_types?: string[] }
 * Fuzzy search entities by name.
 */
toolRouter.post('/cala/search-entities', async (req, res) => {
  const { name, entity_types } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Missing "name" string.' });
  }
  try {
    const result = await CalaClient.searchEntities(name.trim(), entity_types);
    res.json({ entities: result.entities, evidence: result.evidence, count: result.entities.length });
  } catch (error: any) {
    res.status(502).json({ error: error.message, entities: [], evidence: [] });
  }
});

/**
 * POST /api/tools/tavily/search
 * Body: { query: string, search_depth?: 'basic' | 'advanced' }
 * Web search via Tavily.
 */
toolRouter.post('/tavily/search', async (req, res) => {
  const { query, search_depth } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing "query" string.' });
  }
  try {
    const result = await TavilyClient.search(query.trim(), { searchDepth: search_depth || 'basic', maxResults: 5 });
    res.json({ evidence: result.evidence, answer: result.answer || null, count: result.evidence.length });
  } catch (error: any) {
    res.status(502).json({ error: error.message, evidence: [], answer: null });
  }
});

/**
 * POST /api/tools/tavily/extract
 * Body: { urls: string | string[], extract_depth?: 'basic' | 'advanced', format?: 'markdown' | 'text' }
 * Extract content from one or more URLs using Tavily Extract.
 */
toolRouter.post('/tavily/extract', async (req, res) => {
  const { urls, extract_depth, format } = req.body;
  if (!urls) {
    return res.status(400).json({ error: 'Missing "urls" (string or array).' });
  }
  try {
    const result = await TavilyClient.extract(urls, { extractDepth: extract_depth, format });
    res.json({
      results: result.results,
      failed_urls: result.failedUrls,
      evidence: result.evidence,
      count: result.results.length,
    });
  } catch (error: any) {
    res.status(502).json({ error: error.message, results: [], evidence: [] });
  }
});

/**
 * POST /api/tools/tavily/crawl
 * Body: { url: string, instructions?: string, max_depth?: number, limit?: number }
 * Crawl a website graph-style with extraction.
 */
toolRouter.post('/tavily/crawl', async (req, res) => {
  const { url, instructions, max_depth, limit, select_paths, exclude_paths } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing "url" string.' });
  }
  try {
    const result = await TavilyClient.crawl(url, {
      instructions,
      maxDepth: max_depth,
      limit: limit || 10,
      selectPaths: select_paths,
      excludePaths: exclude_paths,
    });
    res.json({
      results: result.results,
      evidence: result.evidence,
      count: result.results.length,
    });
  } catch (error: any) {
    res.status(502).json({ error: error.message, results: [], evidence: [] });
  }
});

/**
 * POST /api/tools/tavily/research
 * Body: { input: string, model?: 'mini' | 'pro' | 'auto' }
 * Initiate comprehensive async research task.
 */
toolRouter.post('/tavily/research', async (req, res) => {
  const { input, model } = req.body;
  if (!input || typeof input !== 'string') {
    return res.status(400).json({ error: 'Missing "input" string.' });
  }
  try {
    const result = await TavilyClient.research(input, { model });
    res.json(result);
  } catch (error: any) {
    res.status(502).json({ error: error.message, requestId: null, status: 'error' });
  }
});

/**
 * GET /api/tools/tavily/research/:request_id
 * Poll for research task results.
 */
toolRouter.get('/tavily/research/:request_id', async (req, res) => {
  const { request_id } = req.params;
  try {
    const result = await TavilyClient.getResearchStatus(request_id);
    res.json(result);
  } catch (error: any) {
    res.status(502).json({ error: error.message, status: 'error' });
  }
});

/**
 * POST /api/tools/web/extract  (legacy alias → uses Tavily Extract directly now)
 */
toolRouter.post('/web/extract', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing "url" string.' });
  }
  try {
    const result = await TavilyClient.extract(url);
    if (result.results.length > 0) {
      return res.json({ content: result.results[0].content?.slice(0, 3000), evidence: result.evidence, source: 'tavily-extract' });
    }
    // Fallback: direct fetch + strip HTML
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'DealBot/1.0' } });
    clearTimeout(timer);
    const html = await r.text();
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
    res.json({ content: text, evidence: [], source: 'direct' });
  } catch (error: any) {
    res.status(502).json({ error: error.message, content: '', evidence: [] });
  }
});

/**
 * POST /api/tools/completion
 * Troubleshooting endpoint — test Dify Completion API (text-gen) directly.
 * Body: { prompt: string, api_key?: string }
 * If api_key not provided, falls back to NARRATOR_DIFY_KEY env var.
 * Returns: { answer: string, source: "dify" | "none", latency_ms: number }
 */
toolRouter.post('/completion', async (req, res) => {
  const { prompt, api_key } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or empty "prompt" string in request body.' });
  }

  const key = api_key || process.env.NARRATOR_DIFY_KEY;
  if (!key) {
    return res.json({ answer: '', source: 'none', latency_ms: 0, note: 'No NARRATOR_DIFY_KEY configured and no api_key provided.' });
  }

  const start = Date.now();
  try {
    const { DifyClient } = await import('./integrations/dify/client.js');
    const answer = await DifyClient.runCompletion(prompt.trim(), key);
    res.json({
      answer,
      source: answer ? 'dify' : 'none',
      latency_ms: Date.now() - start
    });
  } catch (error: any) {
    res.status(502).json({ error: `Completion failed: ${error.message}`, answer: '', latency_ms: Date.now() - start });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Dify Agent Strategies — FunctionCalling & ReAct sub-agents
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /api/tools/dify/agent-fc
 * Body: { instruction, query, context?, max_iterations? }
 * Run a sub-task using FunctionCalling agent strategy.
 */
toolRouter.post('/dify/agent-fc', async (req, res) => {
  const { instruction, query, context, max_iterations } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing "query" string.' });
  }
  const apiKey = process.env.DIFY_FC_AGENT_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'DIFY_FC_AGENT_KEY not configured. Create a Dify Agent app with FunctionCalling strategy and set the key.' });
  }
  try {
    const result = await DifyClient.runCustomAgent(apiKey, {
      instruction: instruction || 'You are a helpful research assistant. Use the available tools to answer the query thoroughly.',
      query,
      context,
      maxIterations: max_iterations || 5,
      label: 'fc-strategy',
    });
    res.json({
      answer: result.answer,
      parsed: result.parsed,
      tool_calls: result.toolCalls,
      strategy: 'function_calling',
    });
  } catch (error: any) {
    res.status(502).json({ error: error.message, strategy: 'function_calling' });
  }
});

/**
 * POST /api/tools/dify/agent-react
 * Body: { instruction, query, context?, max_iterations? }
 * Run a sub-task using ReAct agent strategy.
 */
toolRouter.post('/dify/agent-react', async (req, res) => {
  const { instruction, query, context, max_iterations } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing "query" string.' });
  }
  const apiKey = process.env.DIFY_REACT_AGENT_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'DIFY_REACT_AGENT_KEY not configured. Create a Dify Agent app with ReAct strategy and set the key.' });
  }
  try {
    const result = await DifyClient.runCustomAgent(apiKey, {
      instruction: instruction || 'You are a reasoning agent. Think step by step, observe results, and iterate to answer the query.',
      query,
      context,
      maxIterations: max_iterations || 5,
      label: 'react-strategy',
    });
    res.json({
      answer: result.answer,
      parsed: result.parsed,
      tool_calls: result.toolCalls,
      strategy: 'react',
    });
  } catch (error: any) {
    res.status(502).json({ error: error.message, strategy: 'react' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// Lightpanda — Headless browser scrape (kept for JS-heavy pages)
// ══════════════════════════════════════════════════════════════════════

/**
 * POST /api/tools/lightpanda/scrape
 * Headless scrape a URL using Lightpanda cloud browser.
 * Body: { url: string, wait_selector?: string }
 * Useful for JS-heavy pages that fetch() can't render.
 */
toolRouter.post('/lightpanda/scrape', async (req, res) => {
  const { url, wait_selector } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing "url" string.' });
  }
  try {
    const { LightpandaClient } = await import('./integrations/lightpanda/client.js');
    if (!LightpandaClient.isAvailable()) {
      return res.status(503).json({ error: 'Lightpanda not configured (LIGHTPANDA_TOKEN missing)' });
    }
    const result = await LightpandaClient.scrapeUrl(url, { waitSelector: wait_selector });
    res.json({
      content: result.content?.slice(0, 5000),
      title: result.title,
      source: 'lightpanda',
    });
  } catch (error: any) {
    res.status(502).json({ error: error.message, content: null });
  }
});

// ══════════════════════════════════════════════════════════════════════
// Cala Triggers — /beta/triggers API (X-API-KEY auth, no JWT needed)
// ══════════════════════════════════════════════════════════════════════

/**
 * POST /api/tools/cala/trigger
 * Create a Cala trigger. Auto-fetches baseline answer from knowledge/search.
 * Body: { name?: string, query: string, email?: string, webhook_url?: string }
 */
toolRouter.post('/cala/trigger', async (req, res) => {
  const { name, query, email, webhook_url } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Missing "query" string.' });
  }
  if (!email && !webhook_url) {
    return res.status(400).json({ error: 'Provide at least one of "email" or "webhook_url".' });
  }
  try {
    const trigger = await CalaClient.createTrigger({
      name: name || query.slice(0, 60),
      query,
      email,
      webhookUrl: webhook_url,
    });
    res.status(trigger ? 201 : 500).json({
      trigger,
      source: trigger ? 'cala-beta' : 'failed',
    });
  } catch (error: any) {
    res.status(502).json({ error: error.message, trigger: null });
  }
});

/**
 * GET /api/tools/cala/triggers
 * List all Cala triggers.
 */
toolRouter.get('/cala/triggers', async (_req, res) => {
  try {
    const triggers = await CalaClient.listTriggers();
    res.json({ triggers, count: triggers.length });
  } catch (error: any) {
    res.status(502).json({ error: error.message, triggers: [] });
  }
});

/**
 * DELETE /api/tools/cala/trigger/:id
 * Delete a Cala trigger.
 */
toolRouter.delete('/cala/trigger/:id', async (req, res) => {
  try {
    const ok = await CalaClient.deleteTrigger(req.params.id);
    res.json({ deleted: ok, id: req.params.id });
  } catch (error: any) {
    res.status(502).json({ error: error.message, deleted: false });
  }
});

/**
 * PATCH /api/tools/cala/trigger/:id/status
 * Pause or resume a trigger.
 * Body: { status: 'active' | 'paused' }
 */
toolRouter.patch('/cala/trigger/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!status || !['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'status must be "active" or "paused".' });
  }
  try {
    const trigger = await CalaClient.updateTriggerStatus(req.params.id, status);
    res.json({ trigger, updated: !!trigger });
  } catch (error: any) {
    res.status(502).json({ error: error.message, trigger: null });
  }
});

/**
 * POST /api/tools/cala/trigger/:id/notification
 * Add a notification (email or webhook) to a trigger.
 * Body: { type: 'email' | 'webhook', target: string }
 */
toolRouter.post('/cala/trigger/:id/notification', async (req, res) => {
  const { type, target } = req.body;
  if (!type || !target) {
    return res.status(400).json({ error: 'Missing "type" and "target".' });
  }
  try {
    const notification = await CalaClient.addNotification(req.params.id, { type, target });
    res.status(notification ? 201 : 500).json({ notification, added: !!notification });
  } catch (error: any) {
    res.status(502).json({ error: error.message, notification: null });
  }
});

/**
 * DELETE /api/tools/cala/trigger/:trigger_id/notification/:notification_id
 * Remove a notification from a trigger.
 */
toolRouter.delete('/cala/trigger/:trigger_id/notification/:notification_id', async (req, res) => {
  try {
    const ok = await CalaClient.removeNotification(req.params.trigger_id, req.params.notification_id);
    res.json({ removed: ok });
  } catch (error: any) {
    res.status(502).json({ error: error.message, removed: false });
  }
});

/**
 * POST /api/tools/cala/trigger/subscribe
 * Convenience: add an email notification to a trigger (wraps addNotification).
 * Body: { trigger_id: string, email: string }
 */
toolRouter.post('/cala/trigger/subscribe', async (req, res) => {
  const { trigger_id, email } = req.body;
  if (!trigger_id || !email) {
    return res.status(400).json({ error: 'Missing "trigger_id" and "email".' });
  }
  try {
    const notification = await CalaClient.addNotification(trigger_id, { type: 'email', target: email });
    res.json({ subscribed: !!notification, trigger_id, email, notification });
  } catch (error: any) {
    res.status(502).json({ error: error.message, subscribed: false });
  }
});

/**
 * GET /api/tools/health
 * Quick health check for tool availability.
 */
toolRouter.get('/health', (_req, res) => {
  res.json({
    cala: !!process.env.CALA_API_KEY,
    cala_triggers: CalaClient.triggersAvailable(),
    specter: !!process.env.SPECTER_API_KEY,
    tavily: !!process.env.TAVILY_API_KEY,
    lightpanda_token: !!process.env.LIGHTPANDA_TOKEN,
    narrator: !!process.env.NARRATOR_DIFY_KEY,
    dify_fc: !!process.env.DIFY_FC_AGENT_KEY,
    dify_react: !!process.env.DIFY_REACT_AGENT_KEY,
    status: 'ok'
  });
});
