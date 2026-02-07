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
    const evidence = await CalaClient.search(query.trim());
    res.json({ evidence, count: evidence.length });
  } catch (error: any) {
    console.error(`[ToolAPI] Cala search error:`, error.message);
    res.status(502).json({ error: `Cala search failed: ${error.message}`, evidence: [] });
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
    const result = await SpecterClient.enrichByDomain(domain.trim());
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
      count: result.companies.length
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

/**
 * GET /api/tools/health
 * Quick health check for tool availability.
 */
toolRouter.get('/health', (_req, res) => {
  res.json({
    cala: !!process.env.CALA_API_KEY,
    specter: !!process.env.SPECTER_API_KEY,
    narrator: !!process.env.NARRATOR_DIFY_KEY,
    status: 'ok'
  });
});
