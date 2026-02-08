import type { Evidence } from '../../types.js';

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string;
  favicon?: string;
}

interface TavilySearchResponse {
  query: string;
  results: TavilySearchResult[];
  answer?: string;
  images?: { url: string; description?: string }[];
  response_time?: number;
}

interface TavilyExtractResult {
  url: string;
  raw_content: string;
  images?: string[];
  favicon?: string;
}

interface TavilyCrawlResult {
  url: string;
  raw_content: string;
  favicon?: string;
}

export class TavilyClient {
  private static BASE = 'https://api.tavily.com';
  private static TIMEOUT_MS = 30_000;

  /** Track exhausted keys (429 / quota exceeded) so we skip them for the process lifetime */
  private static exhaustedKeys = new Set<string>();

  /** Return all available API keys in priority order, skipping exhausted ones */
  private static getKeys(): string[] {
    const keys: string[] = [];
    if (process.env.TAVILY_API_KEY) keys.push(process.env.TAVILY_API_KEY);
    if (process.env.TAVILY_API_KEY1) keys.push(process.env.TAVILY_API_KEY1);
    if (process.env.TAVILY_API_KEY2) keys.push(process.env.TAVILY_API_KEY2);
    return keys.filter(k => !this.exhaustedKeys.has(k));
  }

  private static getKey(): string | null {
    const keys = this.getKeys();
    return keys[0] || null;
  }

  private static async apiFetch(url: string, body: any, timeoutMs?: number): Promise<any> {
    const keys = this.getKeys();
    if (keys.length === 0) throw new Error('All TAVILY_API_KEYs exhausted or not set');

    let lastErr: Error | null = null;

    for (const apiKey of keys) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs || this.TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.status === 429 || res.status === 402) {
          // Rate limit or quota exceeded — mark key as exhausted, try next
          const errText = await res.text().catch(() => '');
          console.warn(`[Tavily] Key ${apiKey.slice(0, 12)}… hit limit (${res.status}): ${errText.slice(0, 100)}`);
          this.exhaustedKeys.add(apiKey);
          lastErr = new Error(`Tavily ${res.status}: ${errText.slice(0, 200)}`);
          continue; // try next key
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`Tavily ${res.status}: ${errText.slice(0, 300)}`);
        }
        return res.json();
      } catch (err: any) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          lastErr = new Error(`Tavily timeout (${timeoutMs || this.TIMEOUT_MS}ms)`);
          continue; // timeout — try next key in case it's key-specific throttling
        }
        if (err.message?.includes('429') || err.message?.includes('402')) {
          this.exhaustedKeys.add(apiKey);
          lastErr = err;
          continue;
        }
        throw err;
      }
    }

    throw lastErr || new Error('All TAVILY_API_KEYs failed');
  }

  // ── Search ──────────────────────────────────────────────────────────
  /**
   * POST /search
   * Full-featured web search with AI answer, topic filtering, time range, images.
   */
  static async search(
    query: string,
    opts: {
      maxResults?: number;
      searchDepth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
      topic?: 'general' | 'news' | 'finance';
      timeRange?: 'day' | 'week' | 'month' | 'year';
      includeImages?: boolean;
      includeDomains?: string[];
      excludeDomains?: string[];
    } = {}
  ): Promise<{ evidence: Evidence[]; answer?: string; images?: { url: string; description?: string }[] }> {
    if (!this.getKey()) {
      console.warn('[Tavily] No TAVILY_API_KEY — skipping search');
      return { evidence: [] };
    }

    try {
      console.log(`[Tavily] Search: "${query.slice(0, 60)}…"`);
      const body: any = {
        query,
        search_depth: opts.searchDepth || 'basic',
        max_results: opts.maxResults || 5,
        include_answer: true,
      };
      if (opts.topic) body.topic = opts.topic;
      if (opts.timeRange) body.time_range = opts.timeRange;
      if (opts.includeImages) {
        body.include_images = true;
        body.include_image_descriptions = true;
      }
      if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
      if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains;

      const data = (await this.apiFetch(`${this.BASE}/search`, body)) as TavilySearchResponse;
      const now = new Date().toISOString();

      const evidence: Evidence[] = (data.results || []).map((r, i) => ({
        evidence_id: `tavily-search-${Date.now()}-${i}`,
        title: r.title || query,
        snippet: r.content?.slice(0, 500) || '',
        source: 'tavily-web',
        url: r.url,
        retrieved_at: now,
      }));

      console.log(`[Tavily] Search: ${evidence.length} results${data.answer ? ' + answer' : ''}`);
      return { evidence, answer: data.answer, images: data.images };
    } catch (err: any) {
      console.warn(`[Tavily] Search failed: ${err.message}`);
      return { evidence: [] };
    }
  }

  // ── Extract ─────────────────────────────────────────────────────────
  /**
   * POST /extract
   * Extract content from one or more URLs. Optimized for LLMs.
   */
  static async extract(
    urls: string | string[],
    opts: {
      extractDepth?: 'basic' | 'advanced';
      format?: 'markdown' | 'text';
      includeImages?: boolean;
    } = {}
  ): Promise<{ results: { url: string; content: string; images?: string[] }[]; failedUrls: string[]; evidence: Evidence[] }> {
    if (!this.getKey()) {
      console.warn('[Tavily] No TAVILY_API_KEY — skipping extract');
      return { results: [], failedUrls: [], evidence: [] };
    }

    try {
      const urlList = Array.isArray(urls) ? urls : [urls];
      console.log(`[Tavily] Extract: ${urlList.length} URL(s)`);

      const data = await this.apiFetch(`${this.BASE}/extract`, {
        urls: urlList,
        extract_depth: opts.extractDepth || 'basic',
        format: opts.format || 'markdown',
        include_images: opts.includeImages || false,
      });

      const results = (data.results || []).map((r: TavilyExtractResult) => ({
        url: r.url,
        content: r.raw_content || '',
        images: r.images,
      }));

      const failedUrls = (data.failed_results || []).map((f: any) => f.url);
      const now = new Date().toISOString();

      const evidence: Evidence[] = results.map((r: any, i: number) => ({
        evidence_id: `tavily-extract-${Date.now()}-${i}`,
        title: `Extracted: ${new URL(r.url).hostname}`,
        snippet: r.content?.slice(0, 500) || '',
        source: 'tavily-extract',
        url: r.url,
        retrieved_at: now,
      }));

      console.log(`[Tavily] Extract: ${results.length} success, ${failedUrls.length} failed`);
      return { results, failedUrls, evidence };
    } catch (err: any) {
      console.warn(`[Tavily] Extract failed: ${err.message}`);
      return { results: [], failedUrls: [], evidence: [] };
    }
  }

  // ── Crawl ───────────────────────────────────────────────────────────
  /**
   * POST /crawl
   * Graph-based website traversal with extraction.
   */
  static async crawl(
    url: string,
    opts: {
      instructions?: string;
      maxDepth?: number;
      maxBreadth?: number;
      limit?: number;
      selectPaths?: string[];
      excludePaths?: string[];
      extractDepth?: 'basic' | 'advanced';
      format?: 'markdown' | 'text';
    } = {}
  ): Promise<{ results: { url: string; content: string }[]; evidence: Evidence[] }> {
    if (!this.getKey()) {
      console.warn('[Tavily] No TAVILY_API_KEY — skipping crawl');
      return { results: [], evidence: [] };
    }

    try {
      console.log(`[Tavily] Crawl: ${url}${opts.instructions ? ` — "${opts.instructions.slice(0, 40)}…"` : ''}`);

      const body: any = {
        url,
        max_depth: opts.maxDepth || 1,
        max_breadth: opts.maxBreadth || 10,
        limit: opts.limit || 10,
        extract_depth: opts.extractDepth || 'basic',
        format: opts.format || 'markdown',
      };
      if (opts.instructions) body.instructions = opts.instructions;
      if (opts.selectPaths?.length) body.select_paths = opts.selectPaths;
      if (opts.excludePaths?.length) body.exclude_paths = opts.excludePaths;

      const data = await this.apiFetch(`${this.BASE}/crawl`, body, 60_000);

      const results = (data.results || []).map((r: TavilyCrawlResult) => ({
        url: r.url,
        content: r.raw_content || '',
      }));

      const now = new Date().toISOString();
      const evidence: Evidence[] = results.map((r: any, i: number) => ({
        evidence_id: `tavily-crawl-${Date.now()}-${i}`,
        title: `Crawled: ${r.url}`,
        snippet: r.content?.slice(0, 500) || '',
        source: 'tavily-crawl',
        url: r.url,
        retrieved_at: now,
      }));

      console.log(`[Tavily] Crawl: ${results.length} pages extracted`);
      return { results, evidence };
    } catch (err: any) {
      console.warn(`[Tavily] Crawl failed: ${err.message}`);
      return { results: [], evidence: [] };
    }
  }

  // ── Research ────────────────────────────────────────────────────────
  /**
   * POST /research
   * Comprehensive async research — returns request_id. Poll with GET /research/{id}.
   */
  static async research(
    input: string,
    opts: { model?: 'mini' | 'pro' | 'auto' } = {}
  ): Promise<{ requestId: string | null; status: string; report?: string }> {
    if (!this.getKey()) {
      console.warn('[Tavily] No TAVILY_API_KEY — skipping research');
      return { requestId: null, status: 'skipped' };
    }

    try {
      console.log(`[Tavily] Research: "${input.slice(0, 60)}…"`);
      const data = await this.apiFetch(`${this.BASE}/research`, {
        input,
        model: opts.model || 'auto',
        stream: false,
      }, 60_000);

      return {
        requestId: data.request_id || null,
        status: data.status || 'pending',
      };
    } catch (err: any) {
      console.warn(`[Tavily] Research failed: ${err.message}`);
      return { requestId: null, status: 'error' };
    }
  }

  /**
   * GET /research/{request_id}
   * Poll for research results.
   */
  static async getResearchStatus(requestId: string): Promise<{ status: string; report?: string; sources?: any[] }> {
    const keys = this.getKeys();
    if (keys.length === 0) return { status: 'error' };

    for (const apiKey of keys) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        const res = await fetch(`${this.BASE}/research/${requestId}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.status === 429 || res.status === 402) {
          this.exhaustedKeys.add(apiKey);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return {
          status: data.status || 'unknown',
          report: data.output || data.report || data.result,
          sources: data.sources,
        };
      } catch (err: any) {
        console.warn(`[Tavily] Research status failed (key ${apiKey.slice(0, 12)}…): ${err.message}`);
      }
    }
    return { status: 'error' };
  }
}
