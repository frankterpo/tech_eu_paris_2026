import type { Evidence } from '../../types.js';

export interface CompanyProfile {
  specter_id: string;
  name: string;
  domain: string;
  description: string;
  tagline?: string;
  primary_role: string;
  operating_status: string;
  growth_stage: string;
  customer_focus: string;
  founded_year: number | null;
  employee_count: number | null;
  employee_range: string | null;
  revenue_estimate_usd: number | null;
  industries: string[];
  sub_industries: string[];
  tags: string[];
  highlights: string[];
  new_highlights: string[];
  regions: string[];
  // Funding
  investors: string[];
  investor_count: number;
  funding_total_usd: number | null;
  funding_last_round_type: string | null;
  funding_last_round_usd: number | null;
  // Traction signals
  patent_count: number;
  trademark_count: number;
  award_count: number;
  // Web metrics
  web_monthly_visits: number | null;
  web_global_rank: number | null;
  // Social
  linkedin_followers: number | null;
  twitter_followers: number | null;
  // Founders
  founder_count: number;
  founders: string[];
  // Raw traction_metrics for analysts
  traction_metrics: any;
  // Contact
  hq_city: string | null;
  hq_country: string | null;
}

export interface SpecterPerson {
  specter_person_id: string;
  full_name: string;
  title: string;
  departments: string[];
  seniority: string;
  linkedin_url?: string;
}

export interface SimilarCompany {
  id: string;
  name: string;
  domain: string;
  tagline?: string;
  hq_city?: string;
  hq_country?: string;
  growth_stage?: string;
  employee_count?: number;
  founded_year?: number;
  industries?: string[];
  funding_total_usd?: number;
}

export class SpecterClient {
  private static readonly API_BASE = 'https://app.tryspecter.com/api/v1';
  private static readonly TIMEOUT_MS = 20000; // 20s

  private static getKey(): string | null {
    return process.env.SPECTER_API_KEY || null;
  }

  private static async apiFetch(url: string, options: RequestInit = {}): Promise<any> {
    const apiKey = this.getKey();
    if (!apiKey) throw new Error('SPECTER_API_KEY not set');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
          ...(options.headers || {})
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Specter API ${res.status}: ${errText}`);
      }
      return res.json();
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error(`Specter timeout (${this.TIMEOUT_MS}ms)`);
      throw err;
    }
  }

  // ── Similar companies ─────────────────────────────────────────────
  /**
   * GET /companies/{companyId}/similar
   * Returns AI-matched similar companies — crucial for competitive analysis.
   */
  static async getSimilarCompanies(companyId: string): Promise<{ companies: SimilarCompany[]; evidence: Evidence[] }> {
    if (!this.getKey()) return { companies: [], evidence: [] };

    try {
      console.log(`[Specter] Similar companies for ID: ${companyId}`);
      const data = await this.apiFetch(`${this.API_BASE}/companies/${companyId}/similar`);
      const results = Array.isArray(data) ? data : (data.results || data.data || []);

      const companies: SimilarCompany[] = results.map((r: any) => ({
        id: r.id || '',
        name: r.name || r.organization_name || '',
        domain: r.domain || r.website?.domain || '',
        tagline: r.tagline,
        hq_city: r.hq?.city,
        hq_country: r.hq?.country,
        growth_stage: r.growth_stage,
        employee_count: r.employee_count,
        founded_year: r.founded_year,
        industries: r.industries || [],
        funding_total_usd: r.funding?.total_funding_usd ?? r.funding_total_usd ?? null,
      }));

      const evidence: Evidence[] = companies.slice(0, 10).map((c, i) => ({
        evidence_id: `specter-similar-${i}`,
        title: `Similar company: ${c.name}`,
        snippet: `${c.name} (${c.domain}) — ${c.tagline || 'N/A'} | Stage: ${c.growth_stage || '?'} | Employees: ${c.employee_count || '?'} | HQ: ${c.hq_city || '?'}, ${c.hq_country || '?'} | Industries: ${c.industries?.join(', ') || '?'}${c.funding_total_usd ? ` | Funding: $${(c.funding_total_usd / 1e6).toFixed(1)}M` : ''}`,
        source: 'specter-similar',
        retrieved_at: new Date().toISOString()
      }));

      console.log(`[Specter] Found ${companies.length} similar companies`);
      return { companies, evidence };
    } catch (err: any) {
      console.warn(`[Specter] Similar companies failed: ${err.message}`);
      return { companies: [], evidence: [] };
    }
  }

  // ── Company people / team ─────────────────────────────────────────
  /**
   * GET /companies/{companyId}/people
   * Returns team members — essential for execution/team assessment.
   */
  static async getCompanyPeople(companyId: string): Promise<{ people: SpecterPerson[]; evidence: Evidence[] }> {
    if (!this.getKey()) return { people: [], evidence: [] };

    try {
      console.log(`[Specter] People for company ID: ${companyId}`);
      const data = await this.apiFetch(`${this.API_BASE}/companies/${companyId}/people`);
      const results = Array.isArray(data) ? data : (data.results || data.data || []);

      const people: SpecterPerson[] = results.map((r: any) => ({
        specter_person_id: r.id || r.specter_person_id || '',
        full_name: r.full_name || r.name || '',
        title: r.title || r.job_title || '',
        departments: r.departments || [],
        seniority: r.seniority || '',
        linkedin_url: r.linkedin_url || r.socials?.linkedin?.url,
      }));

      // Build evidence from team data
      const leadershipPeople = people.filter(p =>
        p.seniority?.toLowerCase().includes('executive') ||
        p.seniority?.toLowerCase().includes('c-level') ||
        p.title?.toLowerCase().includes('founder') ||
        p.title?.toLowerCase().includes('ceo') ||
        p.title?.toLowerCase().includes('cto') ||
        p.title?.toLowerCase().includes('coo') ||
        p.title?.toLowerCase().includes('vp') ||
        p.title?.toLowerCase().includes('director')
      );

      const evidence: Evidence[] = [];
      if (people.length > 0) {
        evidence.push({
          evidence_id: 'specter-team-overview',
          title: 'Team Overview',
          snippet: `Total team members tracked: ${people.length} | Leadership: ${leadershipPeople.length} | Key people: ${leadershipPeople.slice(0, 8).map(p => `${p.full_name} (${p.title})`).join(', ')}`,
          source: 'specter-people',
          retrieved_at: new Date().toISOString()
        });
      }

      // Individual leadership profiles as evidence
      leadershipPeople.slice(0, 6).forEach((p, i) => {
        evidence.push({
          evidence_id: `specter-person-${i}`,
          title: `${p.full_name} — ${p.title}`,
          snippet: `${p.full_name} | Title: ${p.title} | Dept: ${p.departments.join(', ') || 'N/A'} | Seniority: ${p.seniority}${p.linkedin_url ? ` | LinkedIn: ${p.linkedin_url}` : ''}`,
          source: 'specter-people',
          retrieved_at: new Date().toISOString()
        });
      });

      console.log(`[Specter] Found ${people.length} people (${leadershipPeople.length} leadership)`);
      return { people, evidence };
    } catch (err: any) {
      console.warn(`[Specter] Company people failed: ${err.message}`);
      return { people: [], evidence: [] };
    }
  }

  // ── Search by name ────────────────────────────────────────────────
  /**
   * GET /companies/search?query=...
   * Search companies by name — useful for finding competitors by name.
   */
  static async searchByName(query: string): Promise<{ results: SimilarCompany[]; evidence: Evidence[] }> {
    if (!this.getKey()) return { results: [], evidence: [] };

    try {
      console.log(`[Specter] Name search: "${query}"`);
      const data = await this.apiFetch(`${this.API_BASE}/companies/search?query=${encodeURIComponent(query)}`);
      const items = Array.isArray(data) ? data : (data.results || data.data || []);

      const results: SimilarCompany[] = items.map((r: any) => ({
        id: r.id || '',
        name: r.name || r.organization_name || '',
        domain: r.domain || '',
        tagline: r.tagline,
        hq_city: r.hq?.city,
        hq_country: r.hq?.country,
        growth_stage: r.growth_stage,
        employee_count: r.employee_count,
        founded_year: r.founded_year,
        industries: r.industries || [],
        funding_total_usd: r.funding?.total_funding_usd ?? null,
      }));

      const evidence: Evidence[] = results.slice(0, 5).map((c, i) => ({
        evidence_id: `specter-namesearch-${i}`,
        title: `Name search result: ${c.name}`,
        snippet: `${c.name} (${c.domain}) — ${c.tagline || 'N/A'} | Founded: ${c.founded_year || '?'} | HQ: ${c.hq_city || '?'}, ${c.hq_country || '?'}`,
        source: 'specter-search',
        retrieved_at: new Date().toISOString()
      }));

      console.log(`[Specter] Name search: ${results.length} results`);
      return { results, evidence };
    } catch (err: any) {
      console.warn(`[Specter] Name search failed: ${err.message}`);
      return { results: [], evidence: [] };
    }
  }

  // ── Enrich by domain (existing) ───────────────────────────────────
  /**
   * Enrich a company by domain. Returns structured profile + evidence items.
   */
  static async enrichByDomain(domain: string): Promise<{ profile: CompanyProfile | null; evidence: Evidence[] }> {
    if (!this.getKey()) {
      console.warn('[Specter] SPECTER_API_KEY not found. Skipping enrichment.');
      return { profile: null, evidence: [] };
    }

    try {
      console.log(`[Specter] Enriching domain: ${domain}`);
      const data = await this.apiFetch(`${this.API_BASE}/companies`, {
        method: 'POST',
        body: JSON.stringify({ domain })
      });
      // Specter enrichment returns a flat array of company objects
      const results = Array.isArray(data) ? data : (data.results || data.data || []);

      if (!results.length) {
        console.log(`[Specter] No results for domain: ${domain}`);
        return { profile: null, evidence: [] };
      }

      const raw = results[0];
      const profile = this.normalizeProfile(raw, domain);
      const evidence = this.profileToEvidence(profile);

      console.log(`[Specter] Enriched "${profile.name}" — ${evidence.length} evidence items`);
      return { profile, evidence };
    } catch (error: any) {
      console.warn(`[Specter] Enrichment failed (${error.message}). Skipping.`);
      return { profile: null, evidence: [] };
    }
  }

  private static normalizeProfile(raw: any, domain: string): CompanyProfile {
    return {
      specter_id: raw.id || raw._id || '',
      name: raw.name || raw.organization_name || '',
      domain,
      description: raw.description || '',
      tagline: raw.tagline || undefined,
      primary_role: raw.primary_role || '',
      operating_status: raw.operating_status || 'unknown',
      growth_stage: raw.growth_stage || 'unknown',
      customer_focus: raw.customer_focus || '',
      founded_year: raw.founded_year || null,
      employee_count: raw.employee_count || null,
      employee_range: raw.employee_count_range || null,
      revenue_estimate_usd: raw.revenue_estimate_usd || null,
      industries: raw.industries || [],
      sub_industries: raw.sub_industries || [],
      tags: raw.tags || [],
      highlights: raw.highlights || [],
      new_highlights: raw.new_highlights || [],
      regions: raw.regions || [],
      investors: raw.investors || [],
      investor_count: raw.investor_count || 0,
      funding_total_usd: raw.funding?.total_funding_usd ?? null,
      funding_last_round_type: raw.funding?.last_funding_type ?? null,
      funding_last_round_usd: raw.funding?.last_funding_usd ?? null,
      patent_count: raw.patent_count || 0,
      trademark_count: raw.trademark_count || 0,
      award_count: raw.award_count || 0,
      web_monthly_visits: raw.web?.visits ?? null,
      web_global_rank: raw.web?.popularity_rank ?? null,
      linkedin_followers: raw.socials?.linkedin?.follower_count ?? null,
      twitter_followers: raw.socials?.twitter?.follower_count ?? null,
      founder_count: raw.founder_count || 0,
      founders: raw.founders || [],
      traction_metrics: raw.traction_metrics || null,
      hq_city: raw.hq?.city ?? null,
      hq_country: raw.hq?.country ?? null,
    };
  }

  /**
   * Convert key profile fields into citable evidence items (source: specter).
   */
  private static profileToEvidence(p: CompanyProfile): Evidence[] {
    const now = new Date().toISOString();
    const items: Evidence[] = [];
    const eid = (suffix: string) => `specter-${suffix}`;

    // Company overview
    if (p.description) {
      items.push({
        evidence_id: eid('overview'),
        title: `${p.name} — Company Overview`,
        snippet: `${p.description}${p.tagline ? ` | "${p.tagline}"` : ''} | Status: ${p.operating_status} | Stage: ${p.growth_stage} | Focus: ${p.customer_focus} | Founded: ${p.founded_year || 'N/A'}`,
        source: 'specter',
        url: `https://tryspecter.com/company/${p.domain}`,
        retrieved_at: now
      });
    }

    // Team & headcount
    if (p.employee_count) {
      items.push({
        evidence_id: eid('headcount'),
        title: `${p.name} — Headcount`,
        snippet: `Employees: ${p.employee_count} (${p.employee_range || 'N/A'}) | Founders: ${p.founder_count} (${p.founders.join(', ') || 'N/A'})`,
        source: 'specter',
        retrieved_at: now
      });
    }

    // Funding
    if (p.funding_total_usd || p.investors.length) {
      const parts = [];
      if (p.funding_total_usd) parts.push(`Total raised: $${(p.funding_total_usd / 1e6).toFixed(1)}M`);
      if (p.funding_last_round_type) parts.push(`Last round: ${p.funding_last_round_type}${p.funding_last_round_usd ? ` ($${(p.funding_last_round_usd / 1e6).toFixed(1)}M)` : ''}`);
      if (p.investors.length) parts.push(`Investors: ${p.investors.slice(0, 8).join(', ')}${p.investors.length > 8 ? ` +${p.investors.length - 8} more` : ''}`);
      items.push({
        evidence_id: eid('funding'),
        title: `${p.name} — Funding`,
        snippet: parts.join(' | '),
        source: 'specter',
        retrieved_at: now
      });
    }

    // Market / industry
    if (p.industries.length || p.tags.length) {
      items.push({
        evidence_id: eid('market'),
        title: `${p.name} — Market & Industry`,
        snippet: `Industries: ${p.industries.join(', ')} | Sub-industries: ${p.sub_industries.join(', ')} | Tags: ${p.tags.slice(0, 10).join(', ')} | Regions: ${p.regions.join(', ')}`,
        source: 'specter',
        retrieved_at: now
      });
    }

    // Signals / highlights
    if (p.highlights.length) {
      items.push({
        evidence_id: eid('signals'),
        title: `${p.name} — Growth Signals`,
        snippet: `Active signals: ${p.highlights.join(', ')}${p.new_highlights.length ? ` | New this month: ${p.new_highlights.join(', ')}` : ''}`,
        source: 'specter',
        retrieved_at: now
      });
    }

    // Web traction
    if (p.web_monthly_visits) {
      items.push({
        evidence_id: eid('web'),
        title: `${p.name} — Web Traffic`,
        snippet: `Monthly visits: ${p.web_monthly_visits.toLocaleString()}${p.web_global_rank ? ` | Global rank: #${p.web_global_rank.toLocaleString()}` : ''}`,
        source: 'specter',
        retrieved_at: now
      });
    }

    // Social traction
    if (p.linkedin_followers || p.twitter_followers) {
      const parts = [];
      if (p.linkedin_followers) parts.push(`LinkedIn: ${p.linkedin_followers.toLocaleString()}`);
      if (p.twitter_followers) parts.push(`Twitter: ${p.twitter_followers.toLocaleString()}`);
      items.push({
        evidence_id: eid('social'),
        title: `${p.name} — Social Presence`,
        snippet: parts.join(' | '),
        source: 'specter',
        retrieved_at: now
      });
    }

    // Revenue estimate
    if (p.revenue_estimate_usd) {
      items.push({
        evidence_id: eid('revenue'),
        title: `${p.name} — Revenue Estimate`,
        snippet: `Estimated annual revenue: $${p.revenue_estimate_usd.toLocaleString()} USD`,
        source: 'specter',
        retrieved_at: now
      });
    }

    // IP
    if (p.patent_count || p.trademark_count) {
      items.push({
        evidence_id: eid('ip'),
        title: `${p.name} — Intellectual Property`,
        snippet: `Patents: ${p.patent_count} | Trademarks: ${p.trademark_count} | Awards: ${p.award_count}`,
        source: 'specter',
        retrieved_at: now
      });
    }

    return items;
  }
}
