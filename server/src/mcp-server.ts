/**
 * MCP Server — Deal Bot: Org-Sim
 *
 * Design principles:
 * 1. `research_company` is the primary entry point — does Specter (fast) + Cala (parallel, capped timeout)
 * 2. Returns human-readable markdown, not raw JSON blobs
 * 3. Specter results return instantly while Cala runs in parallel
 * 4. Individual tools exist for follow-up deep dives
 * 5. Deal simulation tools for the full analyst → associate → partner flow
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CalaClient } from './integrations/cala/client';
import { SpecterClient, CompanyProfile } from './integrations/specter/client';
import { Orchestrator } from './orchestrator';
import { PersistenceManager } from './persistence';
import type { GetPromptResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Format a company profile into readable markdown */
function formatProfile(p: CompanyProfile): string {
  const lines: string[] = [];
  lines.push(`# ${p.name}`);
  if (p.tagline) lines.push(`> ${p.tagline}`);
  lines.push('');
  lines.push(`**Domain:** ${p.domain} | **Status:** ${p.operating_status} | **Stage:** ${p.growth_stage}`);
  lines.push(`**Founded:** ${p.founded_year || 'N/A'} | **HQ:** ${p.hq_city || '?'}, ${p.hq_country || '?'}`);
  lines.push(`**Employees:** ${p.employee_count?.toLocaleString() || 'N/A'} (${p.employee_range || '?'})`);
  lines.push(`**Focus:** ${p.customer_focus} | **Role:** ${p.primary_role}`);
  lines.push('');

  if (p.description) {
    lines.push(`## Description`);
    lines.push(p.description);
    lines.push('');
  }

  // Founders
  if (p.founders?.length) {
    lines.push(`## Founders (${p.founder_count})`);
    lines.push(p.founders.join(', '));
    lines.push('');
  }

  // Funding
  if (p.funding_total_usd || p.investors?.length) {
    lines.push(`## Funding`);
    if (p.funding_total_usd) lines.push(`- **Total raised:** $${(p.funding_total_usd / 1e6).toFixed(1)}M`);
    if (p.funding_last_round_type) lines.push(`- **Last round:** ${p.funding_last_round_type}${p.funding_last_round_usd ? ` ($${(p.funding_last_round_usd / 1e6).toFixed(1)}M)` : ''}`);
    if (p.investors?.length) lines.push(`- **Investors:** ${p.investors.slice(0, 10).join(', ')}${p.investors.length > 10 ? ` +${p.investors.length - 10} more` : ''}`);
    lines.push('');
  }

  // Industries
  if (p.industries?.length) {
    lines.push(`## Market`);
    lines.push(`- **Industries:** ${p.industries.join(', ')}`);
    if (p.sub_industries?.length) lines.push(`- **Sub-industries:** ${p.sub_industries.join(', ')}`);
    if (p.regions?.length) lines.push(`- **Regions:** ${p.regions.join(', ')}`);
    lines.push('');
  }

  // Traction
  const tractionParts: string[] = [];
  if (p.web_monthly_visits) tractionParts.push(`Web: ${p.web_monthly_visits.toLocaleString()} monthly visits (rank #${p.web_global_rank?.toLocaleString() || '?'})`);
  if (p.linkedin_followers) tractionParts.push(`LinkedIn: ${p.linkedin_followers.toLocaleString()} followers`);
  if (p.twitter_followers) tractionParts.push(`Twitter: ${p.twitter_followers.toLocaleString()} followers`);
  if (p.revenue_estimate_usd) tractionParts.push(`Revenue est.: $${p.revenue_estimate_usd.toLocaleString()}`);
  if (tractionParts.length) {
    lines.push(`## Traction`);
    tractionParts.forEach(t => lines.push(`- ${t}`));
    lines.push('');
  }

  // Signals
  if (p.highlights?.length) {
    lines.push(`## Growth Signals`);
    lines.push(p.highlights.join(', '));
    if (p.new_highlights?.length) lines.push(`**New this month:** ${p.new_highlights.join(', ')}`);
    lines.push('');
  }

  // IP
  if (p.patent_count || p.trademark_count || p.award_count) {
    lines.push(`## IP & Awards`);
    lines.push(`Patents: ${p.patent_count} | Trademarks: ${p.trademark_count} | Awards: ${p.award_count}`);
    lines.push('');
  }

  lines.push(`**Specter ID:** ${p.specter_id}`);
  return lines.join('\n');
}

/** Format Cala evidence into readable markdown */
function formatCalaEvidence(evidence: any[]): string {
  if (!evidence.length) return '_No additional intelligence found._';
  const lines = ['## Market Intelligence (Cala)', ''];
  evidence.slice(0, 10).forEach((e, i) => {
    lines.push(`### ${i + 1}. ${e.title}`);
    lines.push(e.snippet || '');
    if (e.url) lines.push(`Source: ${e.url}`);
    lines.push('');
  });
  if (evidence.length > 10) {
    lines.push(`_...and ${evidence.length - 10} more results available._`);
  }
  return lines.join('\n');
}

// ── Cala with reduced timeout for MCP ────────────────────────────────
const CALA_MCP_TIMEOUT = 12_000; // 12s max for MCP context (vs 30s for background orchestrator)

async function calaSearchWithTimeout(query: string): Promise<any[]> {
  const apiKey = process.env.CALA_API_KEY;
  if (!apiKey) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALA_MCP_TIMEOUT);

  try {
    const response = await fetch('https://api.cala.ai/v1/knowledge/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({ input: query }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return [];

    const data = await response.json();
    const context = data.context || [];
    return context.map((item: any) => ({
      evidence_id: item.id,
      title: item.origins?.[0]?.document?.name || 'Untitled',
      snippet: item.content,
      source: item.origins?.[0]?.source?.name || 'Cala',
      url: item.origins?.[0]?.source?.url || item.origins?.[0]?.document?.url,
    }));
  } catch {
    clearTimeout(timeout);
    return [];
  }
}

// ── MCP Server ───────────────────────────────────────────────────────

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'dealbot-org-sim',
    version: '1.0.0',
  });

  // ════════════════════════════════════════════════════════════════════
  // PRIMARY TOOL — research_company
  // ════════════════════════════════════════════════════════════════════
  server.tool(
    'research_company',
    'Primary research tool. Quickly identifies a company via Specter (instant) and enriches with Cala intelligence (parallel). Always start here — returns company profile, funding, team, traction, and market intelligence in one call.',
    {
      domain: z.string().describe('Company domain (e.g. mistral.ai, stripe.com). Required for best results.'),
      name: z.string().optional().describe('Company name (optional, helps with Cala search context)'),
      context: z.string().optional().describe('Additional context for intelligence search (e.g. "Series B AI infrastructure")'),
    },
    async ({ domain, name, context: searchContext }) => {
      const startMs = Date.now();
      const sections: string[] = [];

      // Run Specter (fast ~1s) and Cala (slow, 12s cap) in PARALLEL
      const calaQuery = [name || domain, domain, searchContext].filter(Boolean).join(' ');

      const [specterResult, calaEvidence] = await Promise.all([
        SpecterClient.enrichByDomain(domain).catch(() => ({ profile: null, evidence: [] })),
        calaSearchWithTimeout(calaQuery).catch(() => []),
      ]);

      const elapsedMs = Date.now() - startMs;

      // Section 1: Company profile (Specter)
      if (specterResult.profile) {
        sections.push(formatProfile(specterResult.profile));
      } else {
        sections.push(`# ${name || domain}\n\n_Company not found in Specter database. Try a different domain or use \`specter_search_name\` to find it._`);
      }

      // Section 2: Market intelligence (Cala)
      sections.push('---');
      if (calaEvidence.length > 0) {
        sections.push(formatCalaEvidence(calaEvidence));
      } else if (elapsedMs > 11000) {
        sections.push('## Market Intelligence (Cala)\n\n_Cala search timed out (>12s). Use `cala_search` separately for a deeper query._');
      } else {
        sections.push('## Market Intelligence (Cala)\n\n_No additional market intelligence found._');
      }

      // Section 3: Available follow-up actions
      const followUps: string[] = ['---', '## Next Steps'];
      if (specterResult.profile) {
        const sid = specterResult.profile.specter_id;
        followUps.push(`- **Get team/founders:** Use \`specter_company_people\` with company_id="${sid}"`);
        followUps.push(`- **Find competitors:** Use \`specter_similar_companies\` with company_id="${sid}"`);
      }
      followUps.push(`- **Deep search:** Use \`cala_search\` with a specific question about this company`);
      followUps.push(`- **Run full deal analysis:** Use \`create_deal\` → \`run_deal\` for the complete analyst→associate→partner simulation`);
      sections.push(followUps.join('\n'));

      sections.push(`\n_Research completed in ${(elapsedMs / 1000).toFixed(1)}s_`);

      return {
        content: [{ type: 'text' as const, text: sections.join('\n\n') }],
      };
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // FOLLOW-UP TOOLS — for targeted deep dives
  // ════════════════════════════════════════════════════════════════════

  server.tool(
    'specter_company_people',
    'Get the team and leadership at a company. Returns founders, C-suite, VPs, and directors with titles and LinkedIn URLs. Use after research_company to assess execution capability.',
    { company_id: z.string().describe('Specter company ID (from research_company results)') },
    async ({ company_id }) => {
      try {
        const result = await SpecterClient.getCompanyPeople(company_id);
        if (!result.people.length) {
          return { content: [{ type: 'text' as const, text: '_No team data found for this company._' }] };
        }

        const lines = [`# Team (${result.people.length} members tracked)`, ''];

        // Leadership first
        const leadership = result.people.filter(p =>
          /founder|ceo|cto|coo|cfo|vp|director|chief|head of/i.test(p.title) ||
          /executive|c-level/i.test(p.seniority)
        );
        const others = result.people.filter(p => !leadership.includes(p));

        if (leadership.length) {
          lines.push('## Leadership');
          leadership.forEach(p => {
            lines.push(`- **${p.full_name}** — ${p.title}${p.linkedin_url ? ` ([LinkedIn](${p.linkedin_url}))` : ''}`);
          });
          lines.push('');
        }

        if (others.length) {
          lines.push(`## Other Team Members (${others.length})`);
          others.slice(0, 15).forEach(p => {
            lines.push(`- ${p.full_name} — ${p.title}`);
          });
          if (others.length > 15) lines.push(`_...and ${others.length - 15} more_`);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'specter_similar_companies',
    'Find companies similar to a given company using AI matching. Returns competitors and comparables with funding, team size, and stage. Use after research_company for competitive landscape.',
    { company_id: z.string().describe('Specter company ID (from research_company results)') },
    async ({ company_id }) => {
      try {
        const result = await SpecterClient.getSimilarCompanies(company_id);
        if (!result.companies.length) {
          return { content: [{ type: 'text' as const, text: '_No similar companies found._' }] };
        }

        const lines = [`# Similar Companies (${result.companies.length} found)`, ''];
        lines.push('| Company | Domain | Stage | Employees | Founded | Funding |');
        lines.push('|---------|--------|-------|-----------|---------|---------|');
        result.companies.slice(0, 15).forEach(c => {
          const funding = c.funding_total_usd ? `$${(c.funding_total_usd / 1e6).toFixed(1)}M` : 'N/A';
          lines.push(`| **${c.name}** | ${c.domain || 'N/A'} | ${c.growth_stage || '?'} | ${c.employee_count || '?'} | ${c.founded_year || '?'} | ${funding} |`);
        });

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'specter_search_name',
    'Search for a company by name when you don\'t have their domain. Returns matching companies with basic info. Use this to find a company, then use research_company with the domain.',
    { query: z.string().describe('Company name to search for') },
    async ({ query }) => {
      try {
        const result = await SpecterClient.searchByName(query);
        if (!result.results.length) {
          return { content: [{ type: 'text' as const, text: `_No companies found matching "${query}"._` }] };
        }

        const lines = [`# Search Results for "${query}"`, ''];
        result.results.slice(0, 10).forEach((c, i) => {
          lines.push(`${i + 1}. **${c.name}** (${c.domain || 'no domain'}) — ${c.tagline || 'N/A'}`);
          lines.push(`   Stage: ${c.growth_stage || '?'} | HQ: ${c.hq_city || '?'}, ${c.hq_country || '?'} | Founded: ${c.founded_year || '?'}`);
        });

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'cala_search',
    'Deep search the Cala knowledge base for company intelligence, market data, funding news, and founder backgrounds. Slower (5-15s) but broader coverage than Specter. Use for specific questions after research_company.',
    { query: z.string().describe('Specific search query (e.g. "Mistral AI Series B valuation 2024")') },
    async ({ query }) => {
      try {
        const evidence = await calaSearchWithTimeout(query);
        if (!evidence.length) {
          return { content: [{ type: 'text' as const, text: `_No results found for: "${query}". Try rephrasing or broadening the query._` }] };
        }

        return { content: [{ type: 'text' as const, text: formatCalaEvidence(evidence) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // DEAL SIMULATION TOOLS
  // ════════════════════════════════════════════════════════════════════

  server.tool(
    'create_deal',
    'Create a new deal analysis session. Returns a deal_id. After creation, call run_deal to trigger the full analyst→associate→partner simulation.',
    {
      name: z.string().describe('Company name'),
      domain: z.string().describe('Company domain'),
      stage: z.string().optional().describe('Investment stage (seed, series_a, series_b, etc.)'),
      geo: z.string().optional().describe('Geographic focus (EU, US, Global)'),
      sector: z.string().optional().describe('Industry sector'),
      thesis: z.string().optional().describe('Fund investment thesis / context'),
    },
    async ({ name, domain, stage, geo, sector, thesis }) => {
      try {
        const dealId = await Orchestrator.createDeal({
          name,
          domain,
          fund_config: { stage: stage || 'seed', geo: geo || 'EU', sector: sector || '', thesis: thesis || '' },
          persona_config: {
            analysts: [
              { specialization: 'market' },
              { specialization: 'competition' },
              { specialization: 'traction' },
            ],
            deal_config: { stage: stage || 'seed', geo: geo || 'EU', sector: sector || '' },
          },
        });

        const text = [
          `# Deal Created`,
          '',
          `**Deal ID:** \`${dealId}\``,
          `**Company:** ${name} (${domain})`,
          `**Stage:** ${stage || 'seed'} | **Geo:** ${geo || 'EU'}`,
          '',
          'To run the full simulation (3 analysts → associate → partner), call `run_deal` with this deal_id.',
          'The simulation runs in background (~2-5 min). Poll `get_deal_state` for results.',
        ].join('\n');

        return { content: [{ type: 'text' as const, text }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'run_deal',
    'Start the full deal simulation: evidence gathering → 3 specialist analysts → associate synthesis → partner scoring + decision gate. Runs in background (2-5 min). Poll get_deal_state for progress.',
    { deal_id: z.string().describe('Deal ID from create_deal') },
    async ({ deal_id }) => {
      if (!Orchestrator.dealExists(deal_id)) {
        return { content: [{ type: 'text' as const, text: `Error: Deal \`${deal_id}\` not found.` }], isError: true };
      }

      Orchestrator.runSimulation(deal_id).catch(err => {
        console.error(`Simulation error for deal ${deal_id}:`, err.message);
      });

      const text = [
        '# Simulation Started',
        '',
        `**Deal ID:** \`${deal_id}\``,
        '',
        '**Pipeline:**',
        '1. 📡 Evidence gathering (Specter + Cala)',
        '2. 🔬 Analyst 1: Market analysis',
        '3. 🔬 Analyst 2: Competition analysis',
        '4. 🔬 Analyst 3: Traction & team analysis',
        '5. 📋 Associate: Hypothesis synthesis',
        '6. ⚖️ Partner: Rubric scoring + decision gate',
        '',
        'This takes 2-5 minutes. Use `get_deal_state` to check progress.',
      ].join('\n');

      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'get_deal_state',
    'Get the current state of a deal analysis. Shows evidence count, rubric scores, hypotheses, and the final decision gate (STRONG_YES / PROCEED_IF / PASS).',
    { deal_id: z.string().describe('Deal ID') },
    async ({ deal_id }) => {
      const state = PersistenceManager.getState(deal_id);
      if (!state) {
        return { content: [{ type: 'text' as const, text: `Error: Deal \`${deal_id}\` not found.` }], isError: true };
      }

      const lines = [`# Deal: ${state.deal_input.name}`, ''];

      // Evidence
      lines.push(`## Evidence: ${state.evidence?.length || 0} items collected`);
      if (state.company_profile) {
        lines.push(`**Company:** ${state.company_profile.name} (${state.company_profile.domain})`);
      }
      lines.push('');

      // Hypotheses
      if (state.hypotheses?.length) {
        lines.push(`## Hypotheses (${state.hypotheses.length})`);
        state.hypotheses.forEach((h: any, i: number) => {
          lines.push(`${i + 1}. ${h.text}`);
          if (h.risks?.length) lines.push(`   ⚠️ Risks: ${h.risks.join('; ')}`);
        });
        lines.push('');
      }

      // Rubric
      const r = state.rubric;
      const hasScores = r && (r.market?.score || r.moat?.score || r.why_now?.score || r.execution?.score || r.deal_fit?.score);
      if (hasScores) {
        const avg = Math.round((r.market.score + r.moat.score + r.why_now.score + r.execution.score + r.deal_fit.score) / 5);
        lines.push(`## Rubric Scores (avg: ${avg}/100)`);
        lines.push(`| Dimension | Score | Top Reason |`);
        lines.push(`|-----------|-------|------------|`);
        for (const [dim, data] of Object.entries(r) as [string, any][]) {
          if (data?.score) {
            lines.push(`| ${dim} | **${data.score}**/100 | ${data.reasons?.[0] || 'N/A'} |`);
          }
        }
        lines.push('');
      }

      // Decision
      const dg = state.decision_gate;
      if (dg && dg.decision !== 'PROCEED_IF' || (dg?.gating_questions?.[0] !== 'Pending...')) {
        lines.push(`## Decision: **${dg.decision}**`);
        lines.push('');
        lines.push('**Gating Questions:**');
        dg.gating_questions.forEach((q: string, i: number) => {
          lines.push(`${i + 1}. ${q}`);
        });
      } else {
        lines.push('## Status: ⏳ Analysis in progress...');
        lines.push('The simulation is still running. Check back in 30-60 seconds.');
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // PROMPTS — guide AI on how to use tools intelligently
  // ════════════════════════════════════════════════════════════════════

  server.prompt(
    'research-company',
    'How to research a company step-by-step. Use this when a user asks about a company.',
    {
      company: z.string().describe('Company name or domain'),
    },
    async ({ company }): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `Research the company: ${company}`,
                '',
                'Follow this workflow:',
                '',
                '1. FIRST: Call `research_company` with the domain (or use `specter_search_name` if you only have a name).',
                '   - This runs Specter (instant company profile) and Cala (market intelligence) in parallel.',
                '   - Present the company overview to the user immediately.',
                '',
                '2. THEN: Based on what was found, offer to dig deeper:',
                '   - `specter_company_people` → team assessment (founders, C-suite)',
                '   - `specter_similar_companies` → competitive landscape',
                '   - `cala_search` → specific questions (e.g. "latest funding round details")',
                '',
                '3. PRESENT FINDINGS as a structured brief:',
                '   - Company snapshot (name, stage, HQ, funding)',
                '   - Key strengths and signals',
                '   - Potential risks or gaps',
                '   - Recommendation for further investigation',
                '',
                'IMPORTANT: Always present Specter results first (they arrive instantly).',
                'Never make the user wait for Cala if Specter has good data.',
              ].join('\n'),
            },
          },
        ],
      };
    }
  );

  server.prompt(
    'deal-analysis',
    'Run a full VC deal analysis simulation for a company. Creates a deal, runs 3 analysts + associate + partner scoring.',
    {
      company_name: z.string().describe('Company name'),
      domain: z.string().describe('Company domain'),
      stage: z.string().optional().describe('Investment stage (seed, series_a, series_b)'),
    },
    async ({ company_name, domain, stage }): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `Run a full deal analysis for ${company_name} (${domain}).`,
                '',
                'Follow this workflow:',
                '',
                '1. FIRST: Call `research_company` to get the company profile and intelligence.',
                '   Present a quick summary to the user.',
                '',
                '2. Call `create_deal` with the company details:',
                `   - name: "${company_name}"`,
                `   - domain: "${domain}"`,
                `   - stage: "${stage || 'seed'}"`,
                '',
                '3. Call `run_deal` with the returned deal_id.',
                '   Tell the user: "Simulation started — this takes 2-5 minutes."',
                '',
                '4. Poll `get_deal_state` every 30-60 seconds until the decision gate is populated.',
                '   Update the user on progress:',
                '   - "Gathering evidence..."',
                '   - "Analysts reviewing..."',
                '   - "Associate synthesizing..."',
                '   - "Partner scoring..."',
                '',
                '5. Present the final results:',
                '   - Rubric scores table (market, moat, why_now, execution, deal_fit)',
                '   - Decision gate (STRONG_YES / PROCEED_IF / PASS)',
                '   - Gating questions the IC should ask',
              ].join('\n'),
            },
          },
        ],
      };
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // RESOURCES — system context for AI clients
  // ════════════════════════════════════════════════════════════════════

  server.resource(
    'system-instructions',
    'dealbot://instructions',
    { mimeType: 'text/markdown' },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: 'dealbot://instructions',
            text: [
              '# Deal Bot: Org-Sim — System Instructions',
              '',
              'You are a VC deal analysis assistant powered by Deal Bot. You help investors research companies and make investment decisions.',
              '',
              '## Personality',
              '- Direct and analytical — like a top-tier VC associate',
              '- Present data before opinions',
              '- Flag risks explicitly, don\'t sugarcoat',
              '- Use tables and structured formats for clarity',
              '',
              '## Tool Priority',
              '1. **Always start with `research_company`** — it runs Specter (fast) + Cala (parallel) in one call',
              '2. Use `specter_search_name` only when you have a name but no domain',
              '3. After initial research, offer targeted follow-ups:',
              '   - Team deep dive → `specter_company_people`',
              '   - Competitors → `specter_similar_companies`',
              '   - Specific questions → `cala_search`',
              '4. For full deal analysis → `create_deal` → `run_deal` → poll `get_deal_state`',
              '',
              '## Response Format',
              '- Lead with a 1-2 sentence summary',
              '- Use markdown tables for structured data',
              '- End with suggested next actions',
              '- Never dump raw JSON to the user',
              '',
              '## Available Data Sources',
              '- **Specter**: Company profiles, funding, team, traction metrics, similar companies (~1s)',
              '- **Cala**: Market intelligence, news, research reports (5-15s)',
              '- **Deal Simulation**: 3-analyst pipeline → associate synthesis → partner scoring (2-5min)',
            ].join('\n'),
          },
        ],
      };
    }
  );

  return server;
}
