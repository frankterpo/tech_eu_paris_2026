import { Evidence } from '../../types';

export class CalaClient {
  private static readonly API_BASE = 'https://api.cala.ai/v1/knowledge/search';
  private static readonly TIMEOUT_MS = 30000; // 30s timeout — Cala can be slow

  static async search(query: string): Promise<Evidence[]> {
    const apiKey = process.env.CALA_API_KEY;
    if (!apiKey) {
      console.warn('[Cala] CALA_API_KEY not found. Returning empty evidence.');
      return [];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      console.log(`[Cala] Searching: "${query.slice(0, 80)}..."`);
      const response = await fetch(this.API_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apiKey
        },
        body: JSON.stringify({ input: query }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cala API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();

      // Normalize context items into Evidence[]
      const context = data.context || [];
      console.log(`[Cala] Got ${context.length} results`);
      return context.map((item: any) => ({
        evidence_id: item.id,
        title: item.origins?.[0]?.document?.name || 'Untitled',
        snippet: item.content,
        source: item.origins?.[0]?.source?.name || 'Cala',
        url: item.origins?.[0]?.source?.url || item.origins?.[0]?.document?.url,
        retrieved_at: new Date().toISOString()
      }));
    } catch (error: any) {
      clearTimeout(timeout);
      const reason = error.name === 'AbortError' ? `timeout (${this.TIMEOUT_MS}ms)` : error.message;
      console.warn(`[Cala] Search failed (${reason}). Returning empty evidence.`);
      return [];
    }
  }
}
