/**
 * Skybridge MCP Server — Deal Bot: Org-Sim
 *
 * Two widget tools (with rich UI) + text-only tools for follow-ups.
 * Widget file names must match registration name (e.g. "company-profile" → company-profile.tsx).
 */
import { McpServer } from "skybridge/server";
import { z } from "zod";
import { CalaClient } from "./integrations/cala/client.js";
import { SpecterClient } from "./integrations/specter/client.js";
import { Orchestrator } from "./orchestrator.js";
import { PersistenceManager } from "./persistence.js";

// ── Cala with 12s timeout for MCP ────────────────────────────────────
async function calaSearchFast(query: string): Promise<any[]> {
  const apiKey = process.env.CALA_API_KEY;
  if (!apiKey) return [];
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch("https://api.cala.ai/v1/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({ input: query }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.context || []).map((item: any) => ({
      id: item.id,
      title: item.origins?.[0]?.document?.name || "Untitled",
      snippet: item.content,
      source: item.origins?.[0]?.source?.name || "Cala",
      url: item.origins?.[0]?.source?.url || item.origins?.[0]?.document?.url,
    }));
  } catch {
    clearTimeout(t);
    return [];
  }
}

// ── Server ───────────────────────────────────────────────────────────

const server = new McpServer(
  { name: "dealbot-org-sim", version: "2.0.0" },
  { capabilities: {} },
)

  // ══════════════════════════════════════════════════════════════════
  // WIDGET: company-profile — primary research entry point
  // ══════════════════════════════════════════════════════════════════
  .registerWidget(
    "company-profile",
    {
      description: "Research a company — shows profile card with funding, traction, team, and market intelligence",
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    {
      description:
        "Primary research tool. Identifies a company via Specter (instant) and enriches with Cala intelligence (parallel). Always start here.",
      inputSchema: {
        domain: z.string().describe("Company domain (e.g. mistral.ai, stripe.com)"),
        name: z.string().optional().describe("Company name (optional)"),
        context: z.string().optional().describe("Additional search context"),
      },
      _meta: {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Researching company...",
        "openai/toolInvocation/invoked": "Company profile ready",
      },
    },
    async ({ domain, name, context: ctx }) => {
      const calaQuery = [name || domain, domain, ctx].filter(Boolean).join(" ");

      const [specterResult, calaEvidence] = await Promise.all([
        SpecterClient.enrichByDomain(domain).catch(() => ({ profile: null, evidence: [] })),
        calaSearchFast(calaQuery).catch(() => []),
      ]);

      const profile = specterResult.profile;
      const textParts: string[] = [];

      if (profile) {
        textParts.push(`${profile.name} (${profile.domain}) — ${profile.growth_stage}, ${profile.hq_country || "?"}`);
        if (profile.funding_total_usd) textParts.push(`Total raised: $${(profile.funding_total_usd / 1e6).toFixed(1)}M`);
        if (profile.founders?.length) textParts.push(`Founders: ${profile.founders.join(", ")}`);
        textParts.push(`Specter ID: ${profile.specter_id}`);
      } else {
        textParts.push(`Company not found for domain: ${domain}`);
      }

      if (calaEvidence.length) {
        textParts.push(`\nMarket intelligence: ${calaEvidence.length} results from Cala`);
      }

      return {
        content: [{ type: "text" as const, text: textParts.join("\n") }],
        structuredContent: {
          profile,
          calaEvidence,
          domain,
          name: name || profile?.name || domain,
        },
      };
    },
  )

  // ══════════════════════════════════════════════════════════════════
  // WIDGET: deal-dashboard — deal analysis visualization
  // ══════════════════════════════════════════════════════════════════
  .registerWidget(
    "deal-dashboard",
    {
      description: "Deal analysis dashboard with rubric scores, evidence, hypotheses, and decision gate",
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    {
      description: "Get the current state of a deal analysis with visual rubric scores and decision gate.",
      inputSchema: {
        deal_id: z.string().describe("Deal ID"),
      },
      _meta: {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Loading deal analysis...",
        "openai/toolInvocation/invoked": "Deal dashboard ready",
      },
    },
    async ({ deal_id }) => {
      const state = PersistenceManager.getState(deal_id);
      if (!state) {
        return {
          content: [{ type: "text" as const, text: `Deal ${deal_id} not found.` }],
          structuredContent: { error: "not_found", deal_id },
          isError: true,
        };
      }

      const textParts = [`Deal: ${state.deal_input.name}`, `Evidence: ${state.evidence?.length || 0} items`];

      const r = state.rubric;
      if (r?.market?.score) {
        const avg = Math.round(
          (r.market.score + r.moat.score + r.why_now.score + r.execution.score + r.deal_fit.score) / 5,
        );
        textParts.push(`Average score: ${avg}/100`);
      }

      const dg = state.decision_gate;
      if (dg?.decision && dg.decision !== "PROCEED_IF") {
        textParts.push(`Decision: ${dg.decision}`);
      }

      return {
        content: [{ type: "text" as const, text: textParts.join("\n") }],
        structuredContent: state,
      };
    },
  );

// ══════════════════════════════════════════════════════════════════
// TEXT-ONLY TOOLS (no widget UI)
// ══════════════════════════════════════════════════════════════════

server.tool(
  "specter_company_people",
  "Get team and leadership at a company. Returns founders, C-suite, VPs, directors with LinkedIn URLs.",
  { company_id: z.string().describe("Specter company ID (from company-profile results)") },
  async ({ company_id }) => {
    try {
      const result = await SpecterClient.getCompanyPeople(company_id);
      if (!result.people.length) {
        return { content: [{ type: "text" as const, text: "No team data found." }] };
      }
      const leadership = result.people.filter((p) =>
        /founder|ceo|cto|coo|cfo|vp|director|chief|head of/i.test(p.title) ||
        /executive|c-level/i.test(p.seniority),
      );
      const lines = [`# Team (${result.people.length} tracked)`, "## Leadership"];
      leadership.forEach((p) => lines.push(`- **${p.full_name}** — ${p.title}${p.linkedin_url ? ` [LinkedIn](${p.linkedin_url})` : ""}`));
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "specter_similar_companies",
  "Find companies similar to a given company using AI matching. Returns competitors with funding and stage.",
  { company_id: z.string().describe("Specter company ID") },
  async ({ company_id }) => {
    try {
      const result = await SpecterClient.getSimilarCompanies(company_id);
      if (!result.companies.length) {
        return { content: [{ type: "text" as const, text: "No similar companies found." }] };
      }
      const lines = [`# Similar Companies (${result.companies.length})`, "| Company | Stage | Funding |", "|---------|-------|---------|"];
      result.companies.slice(0, 12).forEach((c) => {
        const f = c.funding_total_usd ? `$${(c.funding_total_usd / 1e6).toFixed(1)}M` : "N/A";
        lines.push(`| ${c.name} (${c.domain}) | ${c.growth_stage || "?"} | ${f} |`);
      });
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "specter_search_name",
  "Search for a company by name when you don't have the domain.",
  { query: z.string().describe("Company name") },
  async ({ query }) => {
    try {
      const result = await SpecterClient.searchByName(query);
      if (!result.results.length) {
        return { content: [{ type: "text" as const, text: `No results for "${query}".` }] };
      }
      const lines = result.results.slice(0, 8).map((c, i) => `${i + 1}. **${c.name}** (${c.domain || "?"}) — ${c.tagline || "N/A"}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "cala_search",
  "Deep search the Cala knowledge base for market intelligence. Slower (5-15s) but broad coverage.",
  { query: z.string().describe("Specific search query") },
  async ({ query }) => {
    try {
      const evidence = await calaSearchFast(query);
      if (!evidence.length) {
        return { content: [{ type: "text" as const, text: `No results for: "${query}".` }] };
      }
      const lines = evidence.slice(0, 8).map((e: any, i: number) => `${i + 1}. **${e.title}**\n   ${(e.snippet || "").slice(0, 200)}`);
      return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "create_deal",
  "Create a new deal analysis session. Returns a deal_id to use with run_deal.",
  {
    name: z.string().describe("Company name"),
    domain: z.string().describe("Company domain"),
    stage: z.string().optional().describe("Investment stage"),
    geo: z.string().optional().describe("Geographic focus"),
  },
  async ({ name, domain, stage, geo }) => {
    try {
      const dealId = await Orchestrator.createDeal({
        name,
        domain,
        fund_config: { stage: stage || "seed", geo: geo || "EU", sector: "", thesis: "" },
        persona_config: {
          analysts: [{ specialization: "market" }, { specialization: "competition" }, { specialization: "traction" }],
          deal_config: { stage: stage || "seed", geo: geo || "EU", sector: "" },
        },
      });
      return { content: [{ type: "text" as const, text: `Deal created: ${dealId}\nUse run_deal to start the simulation, then deal-dashboard to view results.` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "run_deal",
  "Start the full deal simulation (analysts → associate → partner). Takes 2-5 min. Use deal-dashboard to view results.",
  { deal_id: z.string().describe("Deal ID from create_deal") },
  async ({ deal_id }) => {
    if (!Orchestrator.dealExists(deal_id)) {
      return { content: [{ type: "text" as const, text: `Deal ${deal_id} not found.` }], isError: true };
    }
    Orchestrator.runSimulation(deal_id).catch((err) => console.error(`Sim error: ${err.message}`));
    return { content: [{ type: "text" as const, text: `Simulation started for ${deal_id}. Use deal-dashboard widget to track progress.` }] };
  },
);

export default server;
export type AppType = typeof server;
