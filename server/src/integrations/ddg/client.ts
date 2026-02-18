import type { Evidence } from '../../types.js';

interface DDGResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * DuckDuckGo web search client — zero API key required.
 * Uses the DuckDuckGo HTML lite endpoint and parses results.
 * Drop-in replacement for TavilyClient.search() in the orchestrator.
 */
export class DuckDuckGoClient {
  private static readonly LITE_URL = 'https://lite.duckduckgo.com/lite/';
  private static readonly API_URL = 'https://api.duckduckgo.com/';
  private static readonly TIMEOUT_MS = 15_000;

  /**
   * Web search via DuckDuckGo lite HTML endpoint.
   * Returns evidence items compatible with the rest of the pipeline.
   */
  static async search(
    query: string,
    opts: { maxResults?: number } = {}
  ): Promise<{ evidence: Evidence[]; answer?: string }> {
    const max = opts.maxResults || 5;

    try {
      console.log(`[DDG] Search: "${query.slice(0, 60)}…"`);

      const [htmlResults, instantAnswer] = await Promise.all([
        this.searchLite(query, max),
        this.instantAnswer(query),
      ]);

      const now = new Date().toISOString();
      const evidence: Evidence[] = htmlResults.slice(0, max).map((r, i) => ({
        evidence_id: `ddg-search-${Date.now()}-${i}`,
        title: r.title || query,
        snippet: r.snippet?.slice(0, 500) || '',
        source: 'ddg-web',
        url: r.url,
        retrieved_at: now,
      }));

      console.log(`[DDG] Search: ${evidence.length} results${instantAnswer ? ' + instant answer' : ''}`);
      return { evidence, answer: instantAnswer || undefined };
    } catch (err: any) {
      console.warn(`[DDG] Search failed: ${err.message}`);
      return { evidence: [] };
    }
  }

  /**
   * Parse search results from DuckDuckGo lite HTML.
   */
  private static async searchLite(query: string, max: number): Promise<DDGResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      const params = new URLSearchParams({ q: query, kl: '' });
      const res = await fetch(this.LITE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (compatible; DealBot/2.0)',
        },
        body: params.toString(),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`DDG lite ${res.status}`);

      const html = await res.text();
      return this.parseLiteHTML(html, max);
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error(`DDG timeout (${this.TIMEOUT_MS}ms)`);
      throw err;
    }
  }

  /**
   * Extract results from DuckDuckGo lite HTML response.
   * The lite page has a simple table-based layout:
   *   <a class="result-link" href="...">Title</a>
   *   <td class="result-snippet">Snippet text</td>
   */
  private static parseLiteHTML(html: string, max: number): DDGResult[] {
    const results: DDGResult[] = [];

    // Match result links: <a rel="nofollow" href="URL" class='result-link'>TITLE</a>
    const linkRegex = /<a[^>]*class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
    // Match result snippets: <td class="result-snippet">SNIPPET</td>
    const snippetRegex = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

    const links: { url: string; title: string }[] = [];
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const url = match[1].replace(/&amp;/g, '&');
      const title = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim();
      if (url.startsWith('http') && title) {
        links.push({ url, title });
      }
    }

    const snippets: string[] = [];
    while ((match = snippetRegex.exec(html)) !== null) {
      const snippet = match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
      if (snippet) snippets.push(snippet);
    }

    for (let i = 0; i < Math.min(links.length, max); i++) {
      results.push({
        url: links[i].url,
        title: links[i].title,
        snippet: snippets[i] || '',
      });
    }

    // Fallback: try alternate parsing if no results found (DDG sometimes uses different markup)
    if (results.length === 0) {
      const altLinkRegex = /<a[^>]*href=['"]([^'"]*https?:\/\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
      const seen = new Set<string>();
      while ((match = altLinkRegex.exec(html)) !== null && results.length < max) {
        const url = match[1].replace(/&amp;/g, '&');
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        if (url.startsWith('http') && !url.includes('duckduckgo.com') && title.length > 5 && !seen.has(url)) {
          seen.add(url);
          results.push({ url, title, snippet: '' });
        }
      }
    }

    return results;
  }

  /**
   * DuckDuckGo Instant Answer API — returns a quick summary if available.
   * Free, no API key. Returns abstract/answer for common topics.
   */
  private static async instantAnswer(query: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        no_html: '1',
        skip_disambig: '1',
      });
      const res = await fetch(`${this.API_URL}?${params}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DealBot/2.0)' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) return null;
      const data = await res.json();

      // Prefer AbstractText, then Answer, then Definition
      return data.AbstractText || data.Answer || data.Definition || null;
    } catch {
      clearTimeout(timer);
      return null;
    }
  }
}
