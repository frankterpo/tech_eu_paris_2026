/**
 * MCP Server — exposes Deal Bot tools via the Model Context Protocol.
 * Mounted on the existing Express app at /mcp for Alpic deployment.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CalaClient } from './integrations/cala/client';
import { SpecterClient } from './integrations/specter/client';
import { Orchestrator } from './orchestrator';
import { PersistenceManager } from './persistence';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'dealbot-org-sim',
    version: '1.0.0',
  });

  // ── Cala Search ────────────────────────────────────────────────────
  server.tool(
    'cala_search',
    'Search the Cala knowledge base for company intelligence, market data, funding info, and founder backgrounds.',
    { query: z.string().describe('Search query for Cala knowledge base') },
    async ({ query }) => {
      try {
        const evidence = await CalaClient.search(query);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ evidence, count: evidence.length }) }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  // ── Specter Enrich ─────────────────────────────────────────────────
  server.tool(
    'specter_enrich',
    'Enrich a company profile by domain using the Specter API. Returns detailed company data including funding, team, traction metrics.',
    { domain: z.string().describe('Company domain (e.g. tryspecter.com)') },
    async ({ domain }) => {
      try {
        const result = await SpecterClient.enrichByDomain(domain);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ profile: result.profile, evidence: result.evidence }) }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  // ── Specter Similar Companies ──────────────────────────────────────
  server.tool(
    'specter_similar_companies',
    'Find companies similar to a given company using Specter AI matching. Useful for competitive landscape analysis.',
    { company_id: z.string().describe('Specter company ID') },
    async ({ company_id }) => {
      try {
        const result = await SpecterClient.getSimilarCompanies(company_id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ companies: result.companies, count: result.companies.length }) }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  // ── Specter Company People ─────────────────────────────────────────
  server.tool(
    'specter_company_people',
    'Get people/team members at a company from Specter. Returns founders, executives, and key team members.',
    { company_id: z.string().describe('Specter company ID') },
    async ({ company_id }) => {
      try {
        const result = await SpecterClient.getCompanyPeople(company_id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ people: result.people, count: result.people.length }) }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  // ── Specter Search by Name ─────────────────────────────────────────
  server.tool(
    'specter_search_name',
    'Search for companies by name in the Specter database. Useful when you only have a company name, not a domain.',
    { query: z.string().describe('Company name to search for') },
    async ({ query }) => {
      try {
        const result = await SpecterClient.searchByName(query);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ results: result.results, count: result.results.length }) }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  // ── Create Deal ────────────────────────────────────────────────────
  server.tool(
    'create_deal',
    'Create a new deal analysis session for a company. Returns a deal ID that can be used to run the simulation.',
    {
      name: z.string().describe('Company name'),
      domain: z.string().describe('Company domain (e.g. tryspecter.com)'),
      stage: z.string().optional().describe('Investment stage (seed, series_a, etc.)'),
      geo: z.string().optional().describe('Geographic focus (EU, US, etc.)'),
      sector: z.string().optional().describe('Industry sector'),
      thesis: z.string().optional().describe('Fund investment thesis'),
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
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ dealId, status: 'created' }) }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
      }
    }
  );

  // ── Run Deal Simulation ────────────────────────────────────────────
  server.tool(
    'run_deal',
    'Run the full deal analysis simulation (analysts → associate → partner). This triggers background processing. Poll get_deal_state for results.',
    { deal_id: z.string().describe('Deal ID from create_deal') },
    async ({ deal_id }) => {
      if (!Orchestrator.dealExists(deal_id)) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Deal not found' }) }], isError: true };
      }
      Orchestrator.runSimulation(deal_id).catch(err => {
        console.error(`Simulation error for deal ${deal_id}:`, err.message);
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ status: 'started', deal_id }) }],
      };
    }
  );

  // ── Get Deal State ─────────────────────────────────────────────────
  server.tool(
    'get_deal_state',
    'Get the current state of a deal analysis, including evidence, hypotheses, rubric scores, and the final decision.',
    { deal_id: z.string().describe('Deal ID') },
    async ({ deal_id }) => {
      const state = PersistenceManager.getState(deal_id);
      if (!state) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Deal not found' }) }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(state) }],
      };
    }
  );

  return server;
}
