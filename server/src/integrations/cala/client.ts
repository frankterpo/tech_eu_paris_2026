import type { Evidence } from '../../types.js';

export interface CalaEntity {
  id: number;
  name: string;
  entity_type: string;
}

export interface CalaTrigger {
  id: string;
  name: string;
  query: string;
  answer: string;
  status: 'active' | 'paused';
  last_checked_at?: string | null;
  created_at: string;
  updated_at?: string | null;
  notifications: CalaNotification[];
}

export interface CalaNotification {
  id: string;
  type: 'email' | 'webhook';
  target: string;
  created_at: string;
}

export class CalaClient {
  private static readonly BASE = 'https://api.cala.ai/v1/knowledge';
  private static readonly BETA_BASE = 'https://api.cala.ai/beta';
  private static readonly TIMEOUT_MS = 45000; // 45s — Cala can be slow under load

  private static getKey(): string | null {
    return process.env.CALA_API_KEY || null;
  }

  /**
   * API fetch with X-API-KEY header — works for both /v1/knowledge/* and /beta/* endpoints.
   */
  private static async apiFetch(url: string, options: RequestInit = {}): Promise<any> {
    const apiKey = this.getKey();
    if (!apiKey) throw new Error('CALA_API_KEY not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apiKey,
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      // 204 No Content (e.g., delete) — no body to parse
      if (res.status === 204) return null;

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Cala ${res.status}: ${errText.slice(0, 300)}`);
      }
      return res.json();
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error(`Cala timeout (${this.TIMEOUT_MS}ms)`);
      throw err;
    }
  }

  // ── Search (existing — returns Evidence[] for backward compat) ─────
  static async search(query: string): Promise<Evidence[]> {
    const full = await this.searchFull(query);
    return full.evidence;
  }

  /**
   * Full search returning ALL Cala response fields:
   * - content: AI-generated answer summarizing the knowledge
   * - explainability: reasoning steps with references
   * - context/evidence: citable KnowBit items
   * - entities: named entities extracted (PERSON, ORG, GPE, etc.) with IDs
   *
   * Agents should use `entities` to chain further queries: e.g., search for
   * "Mistral AI funding", get entity "Arthur Mensch" (PERSON), then search
   * "Arthur Mensch founder background experience" to build a deeper profile.
   */
  static async searchFull(query: string): Promise<{
    content: string;
    evidence: Evidence[];
    entities: CalaEntity[];
    explainability: { content: string; references: string[] }[];
  }> {
    const empty = { content: '', evidence: [], entities: [], explainability: [] };
    if (!this.getKey()) {
      console.warn('[Cala] CALA_API_KEY not found. Returning empty.');
      return empty;
    }
    try {
      console.log(`[Cala] Searching: "${query.slice(0, 80)}…"`);
      const data = await this.apiFetch(`${this.BASE}/search`, {
        method: 'POST',
        body: JSON.stringify({ input: query }),
      });

      const context = data.context || [];
      const evidence: Evidence[] = context.map((item: any) => ({
        evidence_id: item.id,
        title: item.origins?.[0]?.document?.name || 'Untitled',
        snippet: item.content,
        source: item.origins?.[0]?.source?.name || 'Cala',
        url: item.origins?.[0]?.source?.url || item.origins?.[0]?.document?.url,
        retrieved_at: new Date().toISOString(),
      }));

      const entities: CalaEntity[] = (data.entities || []).map((e: any) => ({
        id: e.id,
        name: e.name,
        entity_type: e.entity_type,
      }));

      const explainability = (data.explainability || []).map((s: any) => ({
        content: s.content || '',
        references: s.references || [],
      }));

      console.log(`[Cala] Got ${context.length} results, ${entities.length} entities, answer: ${(data.content || '').length} chars`);
      return {
        content: data.content || '',
        evidence,
        entities,
        explainability,
      };
    } catch (error: any) {
      console.warn(`[Cala] Search failed (${error.message}). Returning empty.`);
      return empty;
    }
  }

  // ── Query (structured results) ──────────────────────────────────────
  /**
   * POST /v1/knowledge/query
   * Returns structured results + entities — better for precise data extraction.
   */
  static async query(input: string): Promise<{ results: any[]; entities: CalaEntity[]; evidence: Evidence[] }> {
    if (!this.getKey()) return { results: [], entities: [], evidence: [] };
    try {
      console.log(`[Cala] Query: "${input.slice(0, 80)}…"`);
      const data = await this.apiFetch(`${this.BASE}/query`, {
        method: 'POST',
        body: JSON.stringify({ input }),
      });
      const results = data.results || [];
      const entities: CalaEntity[] = (data.entities || []).map((e: any) => ({
        id: e.id,
        name: e.name,
        entity_type: e.entity_type,
      }));
      const evidence: Evidence[] = results.map((r: any, i: number) => ({
        evidence_id: `cala-query-${Date.now()}-${i}`,
        title: r.name || r.title || `Query result ${i + 1}`,
        snippet: typeof r === 'string' ? r : JSON.stringify(r).slice(0, 500),
        source: 'cala-query',
        retrieved_at: new Date().toISOString(),
      }));
      console.log(`[Cala] Query: ${results.length} results, ${entities.length} entities`);
      return { results, entities, evidence };
    } catch (err: any) {
      console.warn(`[Cala] Query failed: ${err.message}`);
      return { results: [], entities: [], evidence: [] };
    }
  }

  // ── Get Entity ──────────────────────────────────────────────────────
  /**
   * GET /v1/knowledge/entities/{entity_id}
   * Get detailed information about a specific entity.
   */
  static async getEntity(entityId: number): Promise<{ entity: any; evidence: Evidence[] }> {
    if (!this.getKey()) return { entity: null, evidence: [] };
    try {
      console.log(`[Cala] Get entity: ${entityId}`);
      const data = await this.apiFetch(`${this.BASE}/entities/${entityId}`);
      const evidence: Evidence[] = data ? [{
        evidence_id: `cala-entity-${entityId}`,
        title: data.name || `Entity ${entityId}`,
        snippet: JSON.stringify(data).slice(0, 500),
        source: 'cala-entity',
        retrieved_at: new Date().toISOString(),
      }] : [];
      return { entity: data, evidence };
    } catch (err: any) {
      console.warn(`[Cala] Get entity failed: ${err.message}`);
      return { entity: null, evidence: [] };
    }
  }

  // ── Search Entities ─────────────────────────────────────────────────
  /**
   * GET /v1/knowledge/entities?name=...
   * Fuzzy search for entities by name.
   */
  static async searchEntities(name: string, entityTypes?: string[], limit = 10): Promise<{ entities: CalaEntity[]; evidence: Evidence[] }> {
    if (!this.getKey()) return { entities: [], evidence: [] };
    try {
      console.log(`[Cala] Search entities: "${name}"`);
      let url = `${this.BASE}/entities?name=${encodeURIComponent(name)}&limit=${limit}`;
      if (entityTypes?.length) {
        for (const t of entityTypes) url += `&entity_types=${encodeURIComponent(t)}`;
      }
      const data = await this.apiFetch(url);
      const entities: CalaEntity[] = (data.entities || []).map((e: any) => ({
        id: e.id,
        name: e.name,
        entity_type: e.entity_type,
      }));
      const evidence: Evidence[] = entities.map((e, i) => ({
        evidence_id: `cala-entity-search-${i}`,
        title: `${e.name} (${e.entity_type})`,
        snippet: `Cala entity: ${e.name} | Type: ${e.entity_type} | ID: ${e.id}`,
        source: 'cala-entities',
        retrieved_at: new Date().toISOString(),
      }));
      console.log(`[Cala] Found ${entities.length} entities`);
      return { entities, evidence };
    } catch (err: any) {
      console.warn(`[Cala] Search entities failed: ${err.message}`);
      return { entities: [], evidence: [] };
    }
  }

  static readonly FOUNDER_DEEP_DIVE_CATEGORIES = [
    { id: 'founder_track_record',  label: 'Founder Track Record',          template: (name: string, founders: string) => `${name} founders ${founders} background career exits track record` },
    { id: 'cap_table_quality',    label: 'Cap Table & Investors',         template: (name: string) => `${name} cap table investors ownership structure fundraising history` },
    { id: 'customer_revenue',     label: 'Customer & Revenue Evidence',   template: (name: string) => `${name} customer reviews case studies revenue growth verified evidence` },
    { id: 'risk_factors',         label: 'Risk Factors & Controversies',  template: (name: string) => `${name} risk factors controversies regulatory issues lawsuits competition threats` },
  ] as const;

  /**
   * Fire targeted founder and deal deep-dive queries.
   * Throttled to CONCURRENCY=2.
   */
  static async founderDeepDiveQueries(companyName: string, founderNames: string): Promise<{
    category: string;
    label: string;
    query: string;
    content: string;
    evidence: import('../../types.js').Evidence[];
    hasData: boolean;
    latencyMs: number;
  }[]> {
    if (!this.getKey()) return [];

    const CONCURRENCY = 2;
    console.log(`[Cala] 🚀 Founder deep dive for "${companyName}" (${this.FOUNDER_DEEP_DIVE_CATEGORIES.length} categories, concurrency=${CONCURRENCY})…`);
    
    const results: any[] = [];
    const queue = [...this.FOUNDER_DEEP_DIVE_CATEGORIES];

    while (queue.length > 0) {
      const chunk = queue.splice(0, CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (cat) => {
          const query = cat.template(companyName, founderNames);
          const start = Date.now();
          try {
            const result = await this.searchFull(query);
            return {
              category: cat.id, label: cat.label, query,
              content: result.content || '', evidence: result.evidence,
              hasData: result.evidence.length > 0 || (result.content || '').length > 50,
              latencyMs: Date.now() - start,
            };
          } catch (err: any) {
            console.warn(`[Cala] Founder deep dive failed for ${cat.id}: ${err.message}`);
            return {
              category: cat.id, label: cat.label, query,
              content: '', evidence: [], hasData: false,
              latencyMs: Date.now() - start,
            };
          }
        })
      );
      results.push(...chunkResults);
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════
  // BATCH INTELLIGENCE QUERIES — fire event-category queries on company name
  // Runs all 8 categories in parallel via /v1/knowledge/search
  // Results are cached as trigger suggestions for the user to activate later.
  // ═══════════════════════════════════════════════════════════════════

  static readonly INTEL_CATEGORIES = [
    { id: 'revenue_updates',       label: 'Key Revenue Updates',           template: (name: string) => `${name} key revenue updates earnings growth` },
    { id: 'business_model',        label: 'Key Business Model Updates',    template: (name: string) => `${name} key business model changes pivot strategy` },
    { id: 'partnerships',          label: 'Key Partnership Updates',       template: (name: string) => `${name} key partnerships alliances strategic collaborations` },
    { id: 'key_hires',             label: 'Key Hire Updates',              template: (name: string) => `${name} key hires executive appointments leadership changes` },
    { id: 'deals_won',             label: 'Key Deals Won',                 template: (name: string) => `${name} key deals won contracts customers enterprise wins` },
    { id: 'setbacks',              label: 'Key Setbacks',                  template: (name: string) => `${name} key setbacks failures regulatory issues lawsuits` },
    { id: 'staff_departures',      label: 'Key Staff Departures',          template: (name: string) => `${name} key staff departures executive exits leadership turnover` },
    { id: 'key_events',            label: 'Other Key Events',              template: (name: string) => `${name} key events product launches funding rounds IPO acquisitions` },
  ] as const;

  /**
   * Fire all 8 intelligence category queries for a company.
   * Throttled to CONCURRENCY=2 to avoid Cala rate limits.
   * Graceful: individual failures don't block others.
   */
  static async batchIntelQueries(companyName: string): Promise<{
    category: string;
    label: string;
    query: string;
    content: string;
    evidence: import('../../types.js').Evidence[];
    hasData: boolean;
    latencyMs: number;
  }[]> {
    if (!this.getKey()) {
      console.warn('[Cala] CALA_API_KEY not set — skipping batch intel queries');
      return [];
    }

    const CONCURRENCY = 2; // Cala rate-limits hard on parallel requests
    console.log(`[Cala] 🚀 Batch intel for "${companyName}" (${this.INTEL_CATEGORIES.length} categories, concurrency=${CONCURRENCY})…`);
    const startAll = Date.now();

    type IntelResult = {
      category: string; label: string; query: string; content: string;
      evidence: import('../../types.js').Evidence[]; hasData: boolean; latencyMs: number;
    };

    const results: IntelResult[] = [];
    const queue = [...this.INTEL_CATEGORIES];

    // Process in chunks of CONCURRENCY
    while (queue.length > 0) {
      const chunk = queue.splice(0, CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (cat) => {
          const query = cat.template(companyName);
          const start = Date.now();
          try {
            const result = await this.searchFull(query);
            return {
              category: cat.id, label: cat.label, query,
              content: result.content || '', evidence: result.evidence,
              hasData: result.evidence.length > 0 || (result.content || '').length > 50,
              latencyMs: Date.now() - start,
            };
          } catch (err: any) {
            console.warn(`[Cala] Intel query failed for ${cat.id}: ${err.message}`);
            return {
              category: cat.id, label: cat.label, query,
              content: '', evidence: [], hasData: false,
              latencyMs: Date.now() - start,
            };
          }
        })
      );
      results.push(...chunkResults);
    }

    const totalMs = Date.now() - startAll;
    const withData = results.filter(r => r.hasData).length;
    console.log(`[Cala] ✅ Batch intel complete: ${withData}/${results.length} categories have data (${totalMs}ms total)`);
    return results;
  }

  // ═══════════════════════════════════════════════════════════════════
  // TRIGGERS — Decommissioned: /beta/triggers was temporary.
  //
  // New flow:
  //   1. Analysts run knowledge queries → baselines cached locally
  //   2. User manually creates triggers at https://console.cala.ai/triggers
  //   3. Cala fires webhook POST to our /api/webhooks/cala-trigger
  //   4. We forward via Resend email to the user
  //
  // createTrigger returns null — triggers are local-only.
  // ═══════════════════════════════════════════════════════════════════

  /** @deprecated Beta API decommissioned. Returns null — triggers saved locally by caller. */
  static async createTrigger(_trigger: {
    name: string;
    query: string;
    email?: string;
    webhookUrl?: string;
    baselineAnswer?: string;
  }): Promise<CalaTrigger | null> {
    console.log(`[Cala] Trigger saved locally (beta API decommissioned)`);
    return null;
  }

  /** @deprecated Beta API decommissioned. */
  static async listTriggers(): Promise<CalaTrigger[]> { return []; }
  /** @deprecated */
  static async deleteTrigger(_id: string): Promise<boolean> { return false; }

  static triggersAvailable(): boolean {
    return !!this.getKey();
  }
}
