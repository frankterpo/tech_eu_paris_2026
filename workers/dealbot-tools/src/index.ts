/**
 * Cloudflare Worker: dealbot-tools
 * Permanent proxy for Dify agent tool calls.
 * Calls Cala / Specter / Tavily APIs directly with secrets.
 * No ngrok dependency, no interstitial pages, 24/7 uptime.
 */

interface Env {
  CALA_API_KEY: string;
  SPECTER_API_KEY: string;
  TAVILY_API_KEY: string;
  TAVILY_API_KEY1?: string;
  TAVILY_API_KEY2?: string;
  LIGHTPANDA_TOKEN?: string;
  DIFY_FC_AGENT_KEY?: string;
  DIFY_REACT_AGENT_KEY?: string;
  CALA_BASE: string;
  SPECTER_BASE: string;
  TAVILY_BASE: string;
}

type Handler = (req: Request, env: Env) => Promise<Response>;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

const errJson = (msg: string, status = 502, defaults: Record<string, unknown> = {}) =>
  json({ error: msg, ...defaults }, status);

async function body(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

// ═══════════════════════════════════════════════════════════════════
// Upstream fetch helpers
// ═══════════════════════════════════════════════════════════════════

async function calaFetch(env: Env, path: string, opts: RequestInit = {}): Promise<any> {
  if (!env.CALA_API_KEY) throw new Error('CALA_API_KEY not configured');
  const res = await fetch(`${env.CALA_BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': env.CALA_API_KEY, 'User-Agent': 'DealBot/2.0', 'Accept': 'application/json', ...(opts.headers as Record<string,string> || {}) },
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Cala ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function specterFetch(env: Env, path: string, opts: RequestInit = {}): Promise<any> {
  if (!env.SPECTER_API_KEY) throw new Error('SPECTER_API_KEY not configured');
  const res = await fetch(`${env.SPECTER_BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': env.SPECTER_API_KEY, 'User-Agent': 'DealBot/2.0', 'Accept': 'application/json', ...(opts.headers as Record<string,string> || {}) },
  });
  if (!res.ok) throw new Error(`Specter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function getTavilyKeys(env: Env): string[] {
  const keys: string[] = [];
  if (env.TAVILY_API_KEY) keys.push(env.TAVILY_API_KEY);
  if (env.TAVILY_API_KEY1) keys.push(env.TAVILY_API_KEY1);
  if (env.TAVILY_API_KEY2) keys.push(env.TAVILY_API_KEY2);
  return keys;
}

function getTavilyKey(env: Env): string {
  const keys = getTavilyKeys(env);
  if (keys.length === 0) throw new Error('No TAVILY_API_KEY configured');
  return keys[0];
}

async function tavilyFetch(env: Env, path: string, bodyData: any): Promise<any> {
  const keys = getTavilyKeys(env);
  if (keys.length === 0) throw new Error('No TAVILY_API_KEY configured');
  let lastErr: Error | null = null;
  for (const key of keys) {
    const res = await fetch(`${env.TAVILY_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'User-Agent': 'DealBot/2.0' },
      body: JSON.stringify(bodyData),
    });
    if (res.status === 429 || res.status === 402 || res.status === 432) {
      lastErr = new Error(`Tavily key exhausted (${res.status})`);
      continue;
    }
    if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw lastErr || new Error('All Tavily keys exhausted');
}

// ═══════════════════════════════════════════════════════════════════
// Evidence builder helpers
// ═══════════════════════════════════════════════════════════════════

const now = () => new Date().toISOString();

function calaContextToEvidence(context: any[]): any[] {
  return (context || []).map((item: any) => ({
    evidence_id: item.id,
    title: item.origins?.[0]?.document?.name || 'Untitled',
    snippet: item.content,
    source: item.origins?.[0]?.source?.name || 'Cala',
    url: item.origins?.[0]?.source?.url || item.origins?.[0]?.document?.url,
    retrieved_at: now(),
  }));
}

function specterProfileToEvidence(p: any): any[] {
  if (!p) return [];
  const items: any[] = [];
  const n = now();
  if (p.description) items.push({ evidence_id: 'specter-overview', title: `${p.name} — Overview`, snippet: `${p.description} | Stage: ${p.growth_stage} | Founded: ${p.founded_year || 'N/A'}`, source: 'specter', retrieved_at: n });
  if (p.employee_count) items.push({ evidence_id: 'specter-headcount', title: `${p.name} — Headcount`, snippet: `Employees: ${p.employee_count} | Founders: ${(p.founders || []).join(', ') || 'N/A'}`, source: 'specter', retrieved_at: n });
  const ft = p.funding?.total_funding_usd;
  if (ft || (p.investors || []).length) items.push({ evidence_id: 'specter-funding', title: `${p.name} — Funding`, snippet: `${ft ? `Total: $${(ft/1e6).toFixed(1)}M` : ''}${p.investors?.length ? ` | Investors: ${p.investors.slice(0,8).join(', ')}` : ''}`, source: 'specter', retrieved_at: n });
  if ((p.industries || []).length) items.push({ evidence_id: 'specter-market', title: `${p.name} — Market`, snippet: `Industries: ${p.industries.join(', ')}`, source: 'specter', retrieved_at: n });
  if ((p.highlights || []).length) items.push({ evidence_id: 'specter-signals', title: `${p.name} — Signals`, snippet: `Signals: ${p.highlights.join(', ')}`, source: 'specter', retrieved_at: n });
  if (p.web?.visits) items.push({ evidence_id: 'specter-web', title: `${p.name} — Traffic`, snippet: `Monthly visits: ${p.web.visits.toLocaleString()}`, source: 'specter', retrieved_at: n });
  if (p.revenue_estimate_usd) items.push({ evidence_id: 'specter-revenue', title: `${p.name} — Revenue`, snippet: `Est. revenue: $${p.revenue_estimate_usd.toLocaleString()}`, source: 'specter', retrieved_at: n });
  return items;
}

function normalizeProfile(raw: any, domain: string) {
  return {
    specter_id: raw.id || raw._id || raw.specter_id || '',
    name: raw.name || raw.organization_name || '',
    domain,
    description: raw.description || '',
    tagline: raw.tagline,
    growth_stage: raw.growth_stage || 'unknown',
    employee_count: raw.employee_count || null,
    funding_total_usd: raw.funding?.total_funding_usd ?? null,
    funding_last_round_type: raw.funding?.last_funding_type ?? null,
    founders: raw.founders || [],
    founder_count: raw.founder_count || 0,
    investors: raw.investors || [],
    industries: raw.industries || [],
    highlights: raw.highlights || [],
    hq_city: raw.hq?.city ?? null,
    hq_country: raw.hq?.country ?? null,
    logo_url: raw.logo_url || raw.logo || null,
    founded_year: raw.founded_year || null,
    revenue_estimate_usd: raw.revenue_estimate_usd || null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Route handlers
// ═══════════════════════════════════════════════════════════════════

const routes: Record<string, Handler> = {};

// POST /cala/search
routes['POST /cala/search'] = async (req, env) => {
  const { query } = await body(req);
  if (!query) return errJson('Missing "query"', 400);
  const data = await calaFetch(env, '/search', { method: 'POST', body: JSON.stringify({ input: query }) });
  return json({
    content: data.content || '',
    evidence: calaContextToEvidence(data.context),
    entities: (data.entities || []).map((e: any) => ({ id: e.id, name: e.name, entity_type: e.entity_type })),
    explainability: (data.explainability || []).map((s: any) => ({ content: s.content, references: s.references || [] })),
    count: (data.context || []).length,
  });
};

// POST /cala/query
routes['POST /cala/query'] = async (req, env) => {
  const { query } = await body(req);
  if (!query) return errJson('Missing "query"', 400);
  const data = await calaFetch(env, '/query', { method: 'POST', body: JSON.stringify({ input: query }) });
  const results = data.results || [];
  const entities = (data.entities || []).map((e: any) => ({ id: e.id, name: e.name, entity_type: e.entity_type }));
  const evidence = results.map((r: any, i: number) => ({
    evidence_id: `cala-query-${Date.now()}-${i}`, title: r.name || r.title || `Result ${i+1}`,
    snippet: typeof r === 'string' ? r : JSON.stringify(r).slice(0, 500), source: 'cala-query', retrieved_at: now(),
  }));
  return json({ results, entities, evidence, count: results.length });
};

// POST /cala/search-entities
routes['POST /cala/search-entities'] = async (req, env) => {
  const { name, entity_types } = await body(req);
  if (!name) return errJson('Missing "name"', 400);
  let url = `/entities?name=${encodeURIComponent(name)}&limit=10`;
  if (entity_types) {
    const types = typeof entity_types === 'string' ? entity_types.split(',') : entity_types;
    for (const t of types) url += `&entity_types=${encodeURIComponent(t.trim())}`;
  }
  const data = await calaFetch(env, url);
  const entities = (data.entities || []).map((e: any) => ({ id: e.id, name: e.name, entity_type: e.entity_type }));
  return json({ entities, evidence: entities.map((e: any, i: number) => ({ evidence_id: `cala-ent-${i}`, title: `${e.name} (${e.entity_type})`, snippet: `Entity ID: ${e.id}`, source: 'cala-entities', retrieved_at: now() })), count: entities.length });
};

// GET /cala/entity/:id
routes['GET /cala/entity'] = async (req, env) => {
  const url = new URL(req.url);
  const parts = url.pathname.split('/');
  const entityId = parts[parts.length - 1];
  if (!entityId || isNaN(Number(entityId))) return errJson('Invalid entity_id', 400);
  const data = await calaFetch(env, `/entities/${entityId}`);
  return json({ entity: data, evidence: data ? [{ evidence_id: `cala-entity-${entityId}`, title: data.name || `Entity ${entityId}`, snippet: JSON.stringify(data).slice(0, 500), source: 'cala-entity', retrieved_at: now() }] : [] });
};

// POST /specter/enrich
routes['POST /specter/enrich'] = async (req, env) => {
  const { domain } = await body(req);
  if (!domain) return errJson('Missing "domain"', 400);
  const data = await specterFetch(env, '/companies', { method: 'POST', body: JSON.stringify({ domain }) });
  const results = Array.isArray(data) ? data : (data.results || data.data || []);
  if (!results.length) return json({ profile: null, evidence: [], count: 0 });
  const profile = normalizeProfile(results[0], domain);
  const evidence = specterProfileToEvidence(results[0]);
  return json({ profile, evidence, count: evidence.length });
};

// POST /specter/company-by-id
routes['POST /specter/company-by-id'] = async (req, env) => {
  const { company_id } = await body(req);
  if (!company_id) return errJson('Missing "company_id"', 400);
  const raw = await specterFetch(env, `/companies/${company_id}`);
  const profile = normalizeProfile(raw, raw.domain || '');
  return json({ profile, evidence: specterProfileToEvidence(raw), count: 1 });
};

// POST /specter/similar
routes['POST /specter/similar'] = async (req, env) => {
  const { company_id } = await body(req);
  if (!company_id) return errJson('Missing "company_id"', 400);
  const data = await specterFetch(env, `/companies/${company_id}/similar`);
  const rawIds: string[] = (Array.isArray(data) ? data : []).filter((x: any) => typeof x === 'string');
  const toEnrich = rawIds.slice(0, 10);
  const enriched = await Promise.allSettled(toEnrich.map(id => specterFetch(env, `/companies/${id}`)));
  const companies: any[] = []; const evidence: any[] = [];
  enriched.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      const p = normalizeProfile(r.value, r.value.domain || '');
      companies.push({ id: p.specter_id, name: p.name, domain: p.domain, growth_stage: p.growth_stage, employee_count: p.employee_count, funding_total_usd: p.funding_total_usd, industries: p.industries });
      evidence.push({ evidence_id: `specter-similar-${i}`, title: `Similar: ${p.name}`, snippet: `${p.name} (${p.domain}) | Stage: ${p.growth_stage} | Funding: ${p.funding_total_usd ? `$${(p.funding_total_usd/1e6).toFixed(1)}M` : '?'}`, source: 'specter-similar', retrieved_at: now() });
    }
  });
  return json({ companies, evidence, count: companies.length, raw_ids: rawIds });
};

// POST /specter/people
routes['POST /specter/people'] = async (req, env) => {
  const { company_id } = await body(req);
  if (!company_id) return errJson('Missing "company_id"', 400);
  const data = await specterFetch(env, `/companies/${company_id}/people`);
  const results = Array.isArray(data) ? data : (data.results || data.data || []);
  const people = results.map((r: any) => ({
    specter_person_id: r.id || r.person_id || '', full_name: r.full_name || r.name || '',
    title: r.title || r.current_position_title || '', seniority: r.seniority || r.level_of_seniority || '',
    linkedin_url: r.linkedin_url || r.socials?.linkedin?.url, profile_picture_url: r.profile_picture_url || null,
    departments: r.departments || [], highlights: r.highlights || [],
  }));
  const leaders = people.filter((p: any) => /founder|ceo|cto|coo|vp|director/i.test(p.title));
  const evidence: any[] = people.length ? [{ evidence_id: 'specter-team', title: 'Team Overview', snippet: `${people.length} members, ${leaders.length} leadership. Key: ${leaders.slice(0,5).map((p:any) => `${p.full_name} (${p.title})`).join(', ')}`, source: 'specter-people', retrieved_at: now() }] : [];
  leaders.slice(0, 6).forEach((p: any, i: number) => evidence.push({ evidence_id: `specter-person-${i}`, title: `${p.full_name} — ${p.title}`, snippet: `${p.full_name} | ${p.title} | ${p.seniority}${p.linkedin_url ? ` | ${p.linkedin_url}` : ''}`, source: 'specter-people', retrieved_at: now() }));
  return json({ people, evidence, count: people.length });
};

// POST /specter/search-name
routes['POST /specter/search-name'] = async (req, env) => {
  const { query } = await body(req);
  if (!query) return errJson('Missing "query"', 400);
  const data = await specterFetch(env, `/companies/search?query=${encodeURIComponent(query)}`);
  const items = Array.isArray(data) ? data : (data.results || data.data || []);
  const results = items.map((r: any) => ({ id: r.id || '', name: r.name || '', domain: r.domain || '', growth_stage: r.growth_stage, industries: r.industries || [] }));
  return json({ results, evidence: results.slice(0,5).map((c: any, i: number) => ({ evidence_id: `specter-ns-${i}`, title: c.name, snippet: `${c.name} (${c.domain})`, source: 'specter-search', retrieved_at: now() })), count: results.length });
};

// POST /specter/text-search
routes['POST /specter/text-search'] = async (req, env) => {
  const { text } = await body(req);
  if (!text) return errJson('Missing "text"', 400);
  const data = await specterFetch(env, '/entities/text-search', { method: 'POST', body: JSON.stringify({ text: text.slice(0, 1000) }) });
  const entities = (Array.isArray(data) ? data : []).map((e: any) => ({ source_name: e.source_name, context: e.context, entity_id: e.entity_id, entity_type: e.entity_type }));
  return json({ entities, evidence: entities.map((e: any, i: number) => ({ evidence_id: `specter-ent-${i}`, title: `${e.source_name} (${e.entity_type})`, snippet: `ID: ${e.entity_id}`, source: 'specter-entities', retrieved_at: now() })), count: entities.length });
};

// POST /specter/enrich-person
routes['POST /specter/enrich-person'] = async (req, env) => {
  const b = await body(req);
  if (!b.linkedin_url && !b.linkedin_id) return errJson('Provide linkedin_url or linkedin_id', 400);
  const payload: any = {};
  if (b.linkedin_url) payload.linkedin_url = b.linkedin_url;
  else payload.linkedin_id = b.linkedin_id;
  const data = await specterFetch(env, '/people', { method: 'POST', body: JSON.stringify(payload) });
  if (!data?.full_name && !data?.person_id) return json({ person: null, evidence: [] });
  const person = { specter_person_id: data.person_id || '', full_name: data.full_name || '', title: data.current_position_title || '', seniority: data.level_of_seniority || '', profile_picture_url: data.profile_picture_url, about: data.about, highlights: data.highlights || [], skills: (data.skills || []).slice(0, 15) };
  return json({ person, evidence: [{ evidence_id: `specter-person-enriched`, title: `${person.full_name} — Profile`, snippet: `${person.full_name} | ${person.title} | ${person.seniority}`, source: 'specter-people', retrieved_at: now() }] });
};

// POST /specter/person-by-id
routes['POST /specter/person-by-id'] = async (req, env) => {
  const { person_id } = await body(req);
  if (!person_id) return errJson('Missing "person_id"', 400);
  const data = await specterFetch(env, `/people/${person_id}`);
  if (!data) return json({ person: null, evidence: [] });
  const person = { specter_person_id: data.person_id || person_id, full_name: data.full_name || '', title: data.current_position_title || '', profile_picture_url: data.profile_picture_url, about: data.about, skills: (data.skills || []).slice(0, 15) };
  return json({ person, evidence: [{ evidence_id: `specter-person-${person_id}`, title: `${person.full_name}`, snippet: `${person.full_name} | ${person.title}`, source: 'specter-people', retrieved_at: now() }] });
};

// POST /specter/person-email
routes['POST /specter/person-email'] = async (req, env) => {
  const { person_id, type } = await body(req);
  if (!person_id) return errJson('Missing "person_id"', 400);
  const data = await specterFetch(env, `/people/${person_id}/email?type=${type || 'professional'}`);
  const email = data?.email || data?.address || null;
  return json({ email, evidence: email ? [{ evidence_id: `specter-email-${person_id}`, title: `Email for ${person_id}`, snippet: `${email} (${type || 'professional'})`, source: 'specter-email', retrieved_at: now() }] : [] });
};

// POST /tavily/search
routes['POST /tavily/search'] = async (req, env) => {
  const b = await body(req);
  if (!b.query) return errJson('Missing "query"', 400);
  const payload: any = { query: b.query, search_depth: b.search_depth || 'basic', max_results: b.max_results || 5, include_answer: true };
  if (b.topic) payload.topic = b.topic;
  if (b.time_range) payload.time_range = b.time_range;
  if (b.include_images) { payload.include_images = true; payload.include_image_descriptions = true; }
  if (b.include_domains) payload.include_domains = typeof b.include_domains === 'string' ? b.include_domains.split(',') : b.include_domains;
  if (b.exclude_domains) payload.exclude_domains = typeof b.exclude_domains === 'string' ? b.exclude_domains.split(',') : b.exclude_domains;
  const data = await tavilyFetch(env, '/search', payload);
  const evidence = (data.results || []).map((r: any, i: number) => ({ evidence_id: `tavily-${Date.now()}-${i}`, title: r.title || b.query, snippet: (r.content || '').slice(0, 500), source: 'tavily-web', url: r.url, retrieved_at: now() }));
  return json({ evidence, answer: data.answer || null, images: data.images || null, count: evidence.length });
};

// POST /tavily/extract
routes['POST /tavily/extract'] = async (req, env) => {
  const b = await body(req);
  if (!b.urls) return errJson('Missing "urls"', 400);
  const urlList = typeof b.urls === 'string' ? b.urls.split(',').map((u: string) => u.trim()) : b.urls;
  const data = await tavilyFetch(env, '/extract', { urls: urlList, extract_depth: b.extract_depth || 'basic', format: b.format || 'markdown' });
  const results = (data.results || []).map((r: any) => ({ url: r.url, content: r.raw_content || '', images: r.images }));
  const failedUrls = (data.failed_results || []).map((f: any) => f.url);
  const evidence = results.map((r: any, i: number) => ({ evidence_id: `tavily-ext-${Date.now()}-${i}`, title: `Extracted: ${r.url}`, snippet: (r.content || '').slice(0, 500), source: 'tavily-extract', url: r.url, retrieved_at: now() }));
  return json({ results, failed_urls: failedUrls, evidence, count: results.length });
};

// POST /tavily/crawl
routes['POST /tavily/crawl'] = async (req, env) => {
  const b = await body(req);
  if (!b.url) return errJson('Missing "url"', 400);
  const payload: any = { url: b.url, max_depth: b.max_depth || 1, max_breadth: 10, limit: b.limit || 10, extract_depth: 'basic', format: 'markdown' };
  if (b.instructions) payload.instructions = b.instructions;
  if (b.select_paths) payload.select_paths = typeof b.select_paths === 'string' ? b.select_paths.split(',') : b.select_paths;
  if (b.exclude_paths) payload.exclude_paths = typeof b.exclude_paths === 'string' ? b.exclude_paths.split(',') : b.exclude_paths;
  const data = await tavilyFetch(env, '/crawl', payload);
  const results = (data.results || []).map((r: any) => ({ url: r.url, content: r.raw_content || '' }));
  const evidence = results.map((r: any, i: number) => ({ evidence_id: `tavily-crawl-${Date.now()}-${i}`, title: `Crawled: ${r.url}`, snippet: (r.content || '').slice(0, 500), source: 'tavily-crawl', url: r.url, retrieved_at: now() }));
  return json({ results, evidence, count: results.length });
};

// POST /tavily/research
routes['POST /tavily/research'] = async (req, env) => {
  const b = await body(req);
  if (!b.input) return errJson('Missing "input"', 400);
  const data = await tavilyFetch(env, '/research', { input: b.input, model: b.model || 'auto', stream: false });
  return json({ requestId: data.request_id || null, status: data.status || 'pending' }, 201);
};

// GET /tavily/research/:id
routes['GET /tavily/research'] = async (req, env) => {
  const url = new URL(req.url);
  const parts = url.pathname.split('/');
  const requestId = parts[parts.length - 1];
  const key = getTavilyKey(env);
  const res = await fetch(`${env.TAVILY_BASE}/research/${requestId}`, { headers: { 'Authorization': `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = await res.json() as any;
  return json({ status: data.status || 'unknown', report: data.output || data.report, sources: data.sources });
};

// POST /web/extract (legacy alias)
routes['POST /web/extract'] = async (req, env) => {
  const { url: targetUrl } = await body(req);
  if (!targetUrl) return errJson('Missing "url"', 400);
  const data = await tavilyFetch(env, '/extract', { urls: [targetUrl], extract_depth: 'basic', format: 'markdown' });
  const result = (data.results || [])[0];
  return json({ content: (result?.raw_content || '').slice(0, 3000), evidence: result ? [{ evidence_id: 'web-extract', title: targetUrl, snippet: (result.raw_content || '').slice(0, 500), source: 'tavily-extract', url: targetUrl, retrieved_at: now() }] : [], source: 'tavily-extract' });
};

// POST /dify/agent-fc & /dify/agent-react (passthrough to Dify API)
async function difyAgent(req: Request, env: Env, strategy: 'fc' | 'react'): Promise<Response> {
  const b = await body(req);
  if (!b.query) return errJson('Missing "query"', 400);
  const key = strategy === 'fc' ? env.DIFY_FC_AGENT_KEY : env.DIFY_REACT_AGENT_KEY;
  if (!key) return errJson(`DIFY_${strategy.toUpperCase()}_AGENT_KEY not configured`, 503);
  const res = await fetch('https://api.dify.ai/v1/chat-messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ inputs: { instruction: b.instruction || '', context: b.context || '' }, query: b.query, response_mode: 'blocking', user: 'dealbot-worker' }),
  });
  if (!res.ok) throw new Error(`Dify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json() as any;
  let parsed = null;
  try { const m = (data.answer || '').match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/); parsed = JSON.parse(m ? m[1] : data.answer); } catch {}
  return json({ answer: data.answer, parsed, tool_calls: data.metadata?.tool_calls?.length || 0, strategy: strategy === 'fc' ? 'function_calling' : 'react' });
}
routes['POST /dify/agent-fc'] = (req, env) => difyAgent(req, env, 'fc');
routes['POST /dify/agent-react'] = (req, env) => difyAgent(req, env, 'react');

// POST /lightpanda/scrape
routes['POST /lightpanda/scrape'] = async (req, env) => {
  const { url: targetUrl } = await body(req);
  if (!targetUrl) return errJson('Missing "url"', 400);
  if (!env.LIGHTPANDA_TOKEN) return errJson('LIGHTPANDA_TOKEN not configured', 503);
  const res = await fetch('https://api.lightpanda.cloud/v1/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.LIGHTPANDA_TOKEN}` },
    body: JSON.stringify({ url: targetUrl }),
  });
  if (!res.ok) throw new Error(`Lightpanda ${res.status}`);
  const data = await res.json() as any;
  return json({ content: (data.content || data.text || '').slice(0, 5000), title: data.title || '', source: 'lightpanda' });
};

// Trigger endpoints (decommissioned — return 410)
routes['POST /cala/trigger'] = async () => json({ error: 'Beta trigger API decommissioned. Use console.cala.ai/triggers.', trigger: null }, 410);
routes['POST /cala/trigger/subscribe'] = async () => json({ error: 'Decommissioned' }, 410);
routes['GET /cala/triggers'] = async () => json({ triggers: [], count: 0 });

// GET /openapi.json — serve the full OpenAPI spec so Dify can "Import from URL"
routes['GET /openapi.json'] = async (req, env) => {
  const specUrl = 'https://raw.githubusercontent.com/franciscoterpolilli/tech_eu_paris_2026/main/server/openapi-tools.json';
  try {
    const res = await fetch(specUrl, { headers: { 'User-Agent': 'DealBot/2.0' } });
    if (res.ok) {
      const spec = await res.json();
      return json(spec);
    }
  } catch {}
  // Fallback: minimal redirect instruction
  return json({ error: 'Spec not found at GitHub — paste server/openapi-tools.json manually into Dify' }, 404);
};

// GET /health
routes['GET /health'] = async (_req, env) => json({
  cala: !!env.CALA_API_KEY, specter: !!env.SPECTER_API_KEY, tavily: !!env.TAVILY_API_KEY,
  lightpanda_token: !!env.LIGHTPANDA_TOKEN, dify_fc: !!env.DIFY_FC_AGENT_KEY, dify_react: !!env.DIFY_REACT_AGENT_KEY,
  status: 'ok',
});

// ═══════════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════════

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' } });
    }

    const url = new URL(request.url);
    const method = request.method;
    let path = url.pathname;

    // Strip /api/tools prefix if present (OpenAPI spec base URL includes it)
    if (path.startsWith('/api/tools')) path = path.slice('/api/tools'.length);
    // Strip trailing slash
    if (path.endsWith('/') && path.length > 1) path = path.slice(0, -1);

    // Exact route match
    const routeKey = `${method} ${path}`;
    if (routes[routeKey]) {
      try {
        return await routes[routeKey](request, env);
      } catch (err: any) {
        return errJson(err.message || 'Internal error', 502);
      }
    }

    // Pattern routes: /cala/entity/:id and /tavily/research/:id
    if (method === 'GET' && path.startsWith('/cala/entity/')) {
      try { return await routes['GET /cala/entity'](request, env); } catch (err: any) { return errJson(err.message, 502); }
    }
    if (method === 'GET' && path.startsWith('/tavily/research/')) {
      try { return await routes['GET /tavily/research'](request, env); } catch (err: any) { return errJson(err.message, 502); }
    }

    return json({ error: `Not found: ${method} ${path}` }, 404);
  },
};
