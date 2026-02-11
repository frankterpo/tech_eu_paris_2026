/**
 * Skybridge MCP Server — Deal Bot: Org-Sim
 *
 * Two widget tools (with rich UI) + text-only tools.
 * ALL registrations use method chaining so AppType captures every tool.
 * Widget file names must match registration name (e.g. "company-profile" → company-profile.tsx).
 */
import { McpServer } from "skybridge/server";
import { z } from "zod";
import { CalaClient } from "./integrations/cala/client.js";
import { SpecterClient } from "./integrations/specter/client.js";
import { TavilyClient } from "./integrations/tavily/client.js";
import { DifyClient } from "./integrations/dify/client.js";
// Lightpanda imported dynamically only when needed (for scrape tool)
import { Orchestrator } from "./orchestrator.js";
import { PersistenceManager } from "./persistence.js";

// ── Server — single fluent chain for full type inference ─────────────

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
      description:
        "Research a company — shows profile card with funding, traction, team, and market intelligence",
      _meta: { ui: { prefersBorder: false } },
    },
    {
      description:
        "STEP 1: Research a company. Use this when the user mentions any company name or domain. Returns instant profile from Specter with funding, traction, and team data. IMPORTANT: After showing this widget, do NOT add any text or commentary — the widget is self-contained with its own 'Process Deal' button. Only speak if the user explicitly asks a question.",
      inputSchema: {
        domain: z.string().describe("Company domain (e.g. mistral.ai, stripe.com)"),
        name: z.string().optional().describe("Company name (optional)"),
        context: z.string().optional().describe("Additional search context"),
      },
      annotations: { readOnlyHint: true },
      _meta: {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Researching company...",
        "openai/toolInvocation/invoked": "Company profile ready",
      },
    },
    async ({ domain, name }) => {
      // Specter only — instant. Cala enriches asynchronously in the widget.
      const specterResult = await SpecterClient.enrichByDomain(domain)
        .catch(() => ({ profile: null, evidence: [] }));

      const profile = specterResult.profile;
      const textParts: string[] = [];

      if (profile) {
        textParts.push(
          `${profile.name} (${profile.domain}) — ${profile.growth_stage}, ${profile.hq_country || "?"}`,
        );
        if (profile.funding_total_usd)
          textParts.push(`Total raised: $${(profile.funding_total_usd / 1e6).toFixed(1)}M`);
        if (profile.founders?.length) textParts.push(`Founders: ${profile.founders.join(", ")}`);
        textParts.push(`Specter ID: ${profile.specter_id}`);

        // Check if deal already exists
        const existingDeal = PersistenceManager.findDealByNameOrDomain(domain);
        if (existingDeal) {
          textParts.push(`\nExisting deal found: ${existingDeal.id} (${existingDeal.status || 'in_progress'}). Show deal-dashboard with deal_id="${existingDeal.id}" to view results.`);
        } else {
          textParts.push(`\nNo deal exists yet. Ask the user if they want to run a full deal analysis — if yes, call analyze_deal with name="${profile.name}" and domain="${domain}".`);
        }
      } else {
        textParts.push(`Company not found for domain: ${domain}`);
      }

      // Check for existing deal
      const existingDeal = PersistenceManager.findDealByNameOrDomain(domain);

      return {
        content: [{ type: "text" as const, text: textParts.join("\n") }],
        structuredContent: {
          profile,
          domain,
          name: name || profile?.name || domain,
          existing_deal_id: existingDeal?.id || null,
          existing_deal_status: existingDeal?.status || null,
          existing_deal_decision: existingDeal?.latest_decision || null,
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
      description:
        "Deal analysis dashboard with rubric scores, evidence, hypotheses, and decision gate",
      _meta: { ui: { prefersBorder: false } },
    },
    {
      description:
        "STEP 3: Show the live deal analysis dashboard. Use this IMMEDIATELY after analyze_deal returns a deal_id, or when the user says 'show dashboard', 'check progress', or 'show deal'. The dashboard auto-refreshes with live analyst progress, rubric scores, and investment decision. IMPORTANT: After showing this widget, do NOT add any text or commentary — the dashboard is self-updating. Only speak if the user explicitly asks a question.",
      inputSchema: {
        deal_id: z.string().describe("Deal ID (from analyze_deal, create_deal, lookup_deal, or list_deals)"),
      },
      annotations: { readOnlyHint: true },
      _meta: {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Loading deal analysis...",
        "openai/toolInvocation/invoked": "Deal dashboard ready",
      },
    },
    async ({ deal_id }) => {
      console.log(`[deal-dashboard] Reading state for ${deal_id}…`);
      const state = PersistenceManager.getState(deal_id);
      if (!state) {
        console.warn(`[deal-dashboard] State NOT FOUND for ${deal_id}`);
        // NOTE: Do NOT set isError:true — ChatGPT MCP proxy converts that to 400 Bad Request
        // which cascades into repeated failures on every poll cycle
        return {
          content: [{ type: "text" as const, text: `Deal ${deal_id} expired or not found. Click Re-analyze to start fresh.` }],
          structuredContent: { error: "not_found" as const, deal_id },
        };
      }
      console.log(`[deal-dashboard] State found for ${deal_id}: evidence=${state.evidence?.length}, company=${state.deal_input?.name}`);

      // ── AUTO-RESUME: On serverless, background promises die. Each dashboard
      // poll advances the stalled simulation by one wave (analysts→associate→partner).
      // Racing against Alpic's ~30s function timeout.
      let resumeResult = 'skipped';
      try {
        const raceResult = await Promise.race([
          Orchestrator.resumeIfStalled(deal_id),
          new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 20000))
        ]);
        resumeResult = raceResult || 'done';
      } catch (err: any) {
        resumeResult = `error: ${err.message?.slice(0, 100)}`;
      }
      console.log(`[deal-dashboard] Resume result for ${deal_id}: ${resumeResult}`);

      // ── Build rich pipeline status from node memories ──────────────
      const analystConfigs = state.deal_input.persona_config?.analysts || [
        { specialization: "market" },
        { specialization: "competition" },
        { specialization: "traction" },
      ];

      const analysts = analystConfigs.map((cfg: any, i: number) => {
        const id = `analyst_${i + 1}`;
        const mem = PersistenceManager.getNodeMemory(deal_id, id);
        return {
          id,
          specialization: cfg.specialization || "general",
          status: mem ? ("done" as const) : ("pending" as const),
          factCount: mem?.facts?.length || 0,
          unknownCount: mem?.unknowns?.length || 0,
          topFacts: (mem?.facts || []).slice(0, 3).map((f: any) => f.text),
          topUnknowns: (mem?.unknowns || []).slice(0, 3).map((u: any) => ({
            question: u.question,
            resolved: !!u.resolved,
            answer: u.answer || null,
          })),
        };
      });

      const assocMem = PersistenceManager.getNodeMemory(deal_id, "associate");
      const partnerMem = PersistenceManager.getNodeMemory(deal_id, "partner");
      const allAnalystsDone = analysts.every((a: any) => a.status === "done");
      const hasScores = state.rubric?.market?.score > 0;
      const liveUpdates = PersistenceManager.getLiveUpdates(deal_id);

      // ── BULLETPROOF status detection ──────────────────────────────
      // On Alpic (serverless), we can't rely on complex event parsing.
      // Simple rule: if events.jsonl has ANY content, the simulation
      // has started → all non-done analysts are "running".
      const eventsFileHasContent = PersistenceManager.hasEvents(deal_id);
      const anyAnalystStarted = eventsFileHasContent || liveUpdates.length > 0;
      if (anyAnalystStarted) {
        for (const a of analysts) {
          if ((a as any).status !== "done") (a as any).status = "running";
        }
      }

      const associateStatus = assocMem ? "done" : allAnalystsDone ? "running" : "pending";
      const partnerStatus = partnerMem || hasScores ? "done" : associateStatus === "done" ? "running" : "pending";

      // ── Text summary for AI ────────────────────────────────────────
      const r = state.rubric;
      const avg = hasScores
        ? Math.round((r.market.score + r.moat.score + r.why_now.score + r.execution.score + r.deal_fit.score) / 5)
        : 0;
      const dg = state.decision_gate;
      const isComplete = hasScores && dg?.decision && dg.gating_questions?.[0] !== "Pending...";

      const textParts = [
        `Deal: ${state.deal_input.name}`,
        `Evidence: ${state.evidence?.length || 0} items`,
        `Analysts: ${analysts.filter((a: any) => a.status === "done").length}/${analysts.length} complete`,
        `Associate: ${associateStatus} | Partner: ${partnerStatus}`,
      ];
      if (isComplete) {
        textParts.push(`Decision: ${dg.decision} | Avg: ${avg}/100`);
      }

      return {
        content: [{ type: "text" as const, text: textParts.join("\n") }],
        structuredContent: {
          deal_id,
          ...state,
          pipeline: {
            analysts,
            associate: {
              status: associateStatus,
              hypothesisCount: state.hypotheses?.length || 0,
              topHypotheses: (state.hypotheses || []).slice(0, 3).map((h: any) => ({
                text: h.text,
                risks: h.risks?.slice(0, 2) || [],
              })),
            },
            partner: {
              status: partnerStatus,
            },
          },
          liveUpdates: liveUpdates.slice(-50),
          memo: PersistenceManager.getMemo(deal_id),
          isComplete: !!isComplete,
          avgScore: avg,
          _debug: { resumeResult },
        },
      };
    },
  )

  // ══════════════════════════════════════════════════════════════════
  // TEXT-ONLY TOOLS (no widget UI) — all chained via registerTool
  // ══════════════════════════════════════════════════════════════════

  .registerTool("specter_company_people", {
    description:
      "Get team and leadership at a company. Use this when the user asks about founders, executives, or team. Returns founders, C-suite, VPs, directors with LinkedIn URLs.",
    inputSchema: {
      company_id: z.string().describe("Specter company ID (from company-profile results)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ company_id }) => {
    try {
      const result = await SpecterClient.getCompanyPeople(company_id);
      if (!result.people.length) {
        return { content: [{ type: "text" as const, text: "No team data found." }] };
      }
      const leadership = result.people.filter(
        (p) =>
          /founder|ceo|cto|coo|cfo|vp|director|chief|head of/i.test(p.title) ||
          /executive|c-level/i.test(p.seniority),
      );
      const lines = [`# Team (${result.people.length} tracked)`, "## Leadership"];
      leadership.forEach((p) =>
        lines.push(
          `- **${p.full_name}** — ${p.title}${p.linkedin_url ? ` [LinkedIn](${p.linkedin_url})` : ""}`,
        ),
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  })

  .registerTool("specter_similar_companies", {
    description:
      "Find companies similar to a given company. Use this when the user asks about competitors or competitive landscape. Returns competitors with funding and stage.",
    inputSchema: {
      company_id: z.string().describe("Specter company ID"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ company_id }) => {
    try {
      const result = await SpecterClient.getSimilarCompanies(company_id);
      if (!result.companies.length) {
        return { content: [{ type: "text" as const, text: "No similar companies found." }] };
      }
      const lines = [
        `# Similar Companies (${result.companies.length})`,
        "| Company | Stage | Funding |",
        "|---------|-------|---------|",
      ];
      result.companies.slice(0, 12).forEach((c) => {
        const f = c.funding_total_usd ? `$${(c.funding_total_usd / 1e6).toFixed(1)}M` : "N/A";
        lines.push(`| ${c.name} (${c.domain}) | ${c.growth_stage || "?"} | ${f} |`);
      });
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  })

  .registerTool("specter_search_name", {
    description: "Search for a company by name when you don't have the domain.",
    inputSchema: {
      query: z.string().describe("Company name"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    try {
      const result = await SpecterClient.searchByName(query);
      if (!result.results.length) {
        return { content: [{ type: "text" as const, text: `No results for "${query}".` }] };
      }
      const lines = result.results
        .slice(0, 8)
        .map(
          (c, i) => `${i + 1}. **${c.name}** (${c.domain || "?"}) — ${c.tagline || "N/A"}`,
        );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  })

  .registerTool("cala_search", {
    description:
      "Deep search Cala knowledge base. Returns AI-generated answer, cited evidence, AND extracted entities (people, orgs, locations). Chain entity names into follow-up queries to build deeper profiles.",
    inputSchema: {
      query: z.string().describe("Specific search query — chain results: use entity names from previous searches"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    try {
      const result = await CalaClient.searchFull(query);
      if (!result.evidence.length && !result.content) {
        return {
          content: [{ type: "text" as const, text: `No results for: "${query}".` }],
          structuredContent: { evidence: [], entities: [], query },
        };
      }
      const lines: string[] = [];
      // AI-generated answer
      if (result.content) {
        lines.push(`**Answer:** ${result.content.slice(0, 500)}`);
      }
      // Evidence
      result.evidence.slice(0, 6).forEach((e: any, i: number) => {
        lines.push(`${i + 1}. **${e.title}**\n   ${(e.snippet || "").slice(0, 200)}`);
      });
      // Extracted entities — these are gold for chaining
      if (result.entities.length) {
        lines.push(`\n**Entities found** (use these names for deeper queries):`);
        result.entities.forEach((e) => {
          lines.push(`- ${e.name} (${e.entity_type}, id=${e.id})`);
        });
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n\n") }],
        structuredContent: {
          content: result.content,
          evidence: result.evidence.slice(0, 8),
          entities: result.entities,
          query,
        },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        structuredContent: { evidence: [], entities: [], query, error: err.message },
        isError: true,
      };
    }
  })

  // ── NEW: Specter Entities / Text-Search ───────────────────────────
  .registerTool("specter_text_search", {
    description: "Extract company/investor entities from unstructured text (press releases, bios, notes). Returns matched Specter entity IDs for enrichment.",
    inputSchema: {
      text: z.string().max(1000).describe("Unstructured text to extract entities from (max 1000 chars)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ text }) => {
    try {
      const result = await SpecterClient.textSearch(text);
      if (!result.entities.length) {
        return { content: [{ type: "text" as const, text: "No entities found in text." }] };
      }
      const lines = result.entities.map((e, i) =>
        `${i + 1}. **${e.source_name}** (${e.entity_type}) — Context: ${e.context} | ID: ${e.entity_id}`
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── NEW: Specter Get Company by ID ──────────────────────────────────
  .registerTool("specter_company_by_id", {
    description: "Get full company profile by Specter company ID. Use when you have an ID from similar companies or entity search.",
    inputSchema: {
      company_id: z.string().describe("Specter company ID"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ company_id }) => {
    try {
      const result = await SpecterClient.getCompanyById(company_id);
      if (!result.profile) {
        return { content: [{ type: "text" as const, text: `Company ${company_id} not found.` }] };
      }
      const p = result.profile;
      const text = `**${p.name}** (${p.domain})\nStage: ${p.growth_stage} | HQ: ${p.hq_city}, ${p.hq_country}\nFunding: $${p.funding_total_usd ? (p.funding_total_usd / 1e6).toFixed(1) + 'M' : 'N/A'} | Employees: ${p.employee_count || '?'}\nLogo: ${p.logo_url || 'N/A'}`;
      return { content: [{ type: "text" as const, text }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── NEW: Specter Enrich Person ──────────────────────────────────────
  .registerTool("specter_enrich_person", {
    description: "Enrich a person by LinkedIn URL or ID. Returns full professional profile with profile picture, career history, skills, education.",
    inputSchema: {
      linkedin_url: z.string().optional().describe("LinkedIn profile URL"),
      linkedin_id: z.string().optional().describe("LinkedIn ID (slug from profile URL)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ linkedin_url, linkedin_id }) => {
    try {
      const identifier: { linkedin_url?: string; linkedin_id?: string } = {};
      if (linkedin_url) identifier.linkedin_url = linkedin_url;
      else if (linkedin_id) identifier.linkedin_id = linkedin_id;
      else return { content: [{ type: "text" as const, text: "Provide linkedin_url or linkedin_id." }], isError: true };

      const result = await SpecterClient.enrichPerson(identifier);
      if (!result.person) {
        return { content: [{ type: "text" as const, text: "Person not found or queued for enrichment." }] };
      }
      const p = result.person;
      const text = `**${p.full_name}** — ${p.title}\n${p.tagline || ''}\nLocation: ${p.location || '?'} | Exp: ${p.years_of_experience || '?'} yrs | Ed: ${p.education_level || '?'}\nSkills: ${p.skills?.slice(0, 8).join(', ') || '?'}\nPhoto: ${p.profile_picture_url || 'N/A'}`;
      return { content: [{ type: "text" as const, text }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── NEW: Specter Get Person by ID ───────────────────────────────────
  .registerTool("specter_person_by_id", {
    description: "Get full person profile by Specter person ID. Returns career history, skills, profile picture.",
    inputSchema: {
      person_id: z.string().describe("Specter person ID (from company people results)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ person_id }) => {
    try {
      const result = await SpecterClient.getPersonById(person_id);
      if (!result.person) {
        return { content: [{ type: "text" as const, text: `Person ${person_id} not found.` }] };
      }
      const p = result.person;
      const text = `**${p.full_name}** — ${p.title}\n${p.about?.slice(0, 200) || ''}\nPhoto: ${p.profile_picture_url || 'N/A'}`;
      return { content: [{ type: "text" as const, text }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── NEW: Specter Get Person Email ───────────────────────────────────
  .registerTool("specter_person_email", {
    description: "Get verified professional email for a person by their Specter person ID.",
    inputSchema: {
      person_id: z.string().describe("Specter person ID"),
      type: z.enum(["professional", "personal"]).optional().describe("Email type (default: professional)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ person_id, type }) => {
    try {
      const result = await SpecterClient.getPersonEmail(person_id, type || 'professional');
      if (!result.email) {
        return { content: [{ type: "text" as const, text: `No email found for ${person_id}.` }] };
      }
      return { content: [{ type: "text" as const, text: `Email: ${result.email}` }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── NEW: Cala Query (structured) ────────────────────────────────────
  .registerTool("cala_query", {
    description: "Structured query to Cala knowledge base. Returns structured data results + entity extraction. Better than cala_search for precise data points.",
    inputSchema: {
      query: z.string().describe("Structured query — e.g., 'Mistral AI revenue 2024', 'AI market size Europe'"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    try {
      const result = await CalaClient.query(query);
      const lines = result.results.slice(0, 5).map((r: any, i: number) => {
        const text = typeof r === 'string' ? r : JSON.stringify(r).slice(0, 200);
        return `${i + 1}. ${text}`;
      });
      if (result.entities.length) {
        lines.push(`\nEntities: ${result.entities.map(e => `${e.name} (${e.entity_type})`).join(', ')}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") || "No results." }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── NEW: Cala Get Entity ────────────────────────────────────────────
  .registerTool("cala_get_entity", {
    description: "Get detailed information about a specific Cala entity by ID. Use entity IDs from search or query results.",
    inputSchema: {
      entity_id: z.number().describe("Cala entity ID (integer)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ entity_id }) => {
    try {
      const result = await CalaClient.getEntity(entity_id);
      if (!result.entity) {
        return { content: [{ type: "text" as const, text: `Entity ${entity_id} not found.` }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result.entity, null, 2).slice(0, 1000) }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── NEW: Cala Search Entities ───────────────────────────────────────
  .registerTool("cala_search_entities", {
    description: "Fuzzy search Cala's entity database by name. Find companies, people, organizations, products. Returns entity IDs for deeper lookups.",
    inputSchema: {
      name: z.string().describe("Entity name to search for"),
      entity_types: z.array(z.string()).optional().describe("Filter by types: PERSON, ORG, GPE, LOC, PRODUCT, FAC, WORK_OF_ART, LAW, LANGUAGE"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ name, entity_types }) => {
    try {
      const result = await CalaClient.searchEntities(name, entity_types);
      if (!result.entities.length) {
        return { content: [{ type: "text" as const, text: `No entities found for "${name}".` }] };
      }
      const lines = result.entities.map((e, i) => `${i + 1}. **${e.name}** (${e.entity_type}) — ID: ${e.id}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── Tavily: Web Search ──────────────────────────────────────────────
  .registerTool("tavily_web_search", {
    description: "Real-time web search via Tavily. Returns ranked results with URLs and an AI answer. Supports topic filtering (general/news/finance), time ranges, domain filters, and image search.",
    inputSchema: {
      query: z.string().describe("Search query — be specific"),
      search_depth: z.enum(["basic", "advanced", "fast", "ultra-fast"]).optional().describe("Relevance vs latency tradeoff (default: basic)"),
      max_results: z.number().min(1).max(20).optional().describe("Max results (default: 5)"),
      topic: z.enum(["general", "news", "finance"]).optional().describe("Search category (default: general)"),
      time_range: z.enum(["day", "week", "month", "year"]).optional().describe("Filter by recency"),
      include_images: z.boolean().optional().describe("Include image search results"),
      include_domains: z.array(z.string()).optional().describe("Only include results from these domains"),
      exclude_domains: z.array(z.string()).optional().describe("Exclude results from these domains"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query, search_depth, max_results, topic, time_range, include_images, include_domains, exclude_domains }) => {
    try {
      const result = await TavilyClient.search(query, {
        searchDepth: search_depth || 'basic',
        maxResults: max_results || 5,
        topic,
        timeRange: time_range,
        includeImages: include_images,
        includeDomains: include_domains,
        excludeDomains: exclude_domains,
      });
      if (!result.evidence.length) {
        return { content: [{ type: "text" as const, text: `No web results for "${query}".` }] };
      }
      const lines = result.evidence.map((e, i) =>
        `${i + 1}. **${e.title}**\n   ${(e.snippet || '').slice(0, 200)}\n   ${e.url || ''}`
      );
      if (result.answer) lines.unshift(`**Answer:** ${result.answer}\n`);
      return { content: [{ type: "text" as const, text: lines.join("\n\n") }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── Tavily: Extract ───────────────────────────────────────────────
  .registerTool("tavily_extract", {
    description: "Extract and parse web page content from one or more URLs. Optimized for LLMs — returns clean markdown/text. Use for scraping competitor sites, press releases, blog posts, regulatory docs.",
    inputSchema: {
      urls: z.union([z.string(), z.array(z.string())]).describe("Single URL or array of URLs to extract (max 20)"),
      extract_depth: z.enum(["basic", "advanced"]).optional().describe("'advanced' for tables/embedded content (default: basic)"),
      format: z.enum(["markdown", "text"]).optional().describe("Output format (default: markdown)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ urls, extract_depth, format }) => {
    try {
      const result = await TavilyClient.extract(urls, { extractDepth: extract_depth, format });
      if (!result.results.length) {
        return { content: [{ type: "text" as const, text: `Could not extract content from provided URL(s).` }] };
      }
      const lines = result.results.map((r, i) =>
        `### Page ${i + 1}: ${r.url}\n${(r.content || '').slice(0, 1500)}`
      );
      if (result.failedUrls.length) lines.push(`\n**Failed:** ${result.failedUrls.join(', ')}`);
      return { content: [{ type: "text" as const, text: lines.join("\n\n---\n\n") }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── Tavily: Crawl ─────────────────────────────────────────────────
  .registerTool("tavily_crawl", {
    description: "Graph-based website traversal with extraction. Crawls pages in parallel from a root URL. Use to map competitor websites, discover product pages, or build a comprehensive view of a company's web presence.",
    inputSchema: {
      url: z.string().describe("Root URL to begin crawl. E.g., 'mistral.ai'"),
      instructions: z.string().optional().describe("Natural language instructions. E.g., 'Find all pages about pricing and enterprise'"),
      max_depth: z.number().min(1).max(5).optional().describe("How far from base URL to explore (default: 1)"),
      limit: z.number().min(1).optional().describe("Total pages to process (default: 10)"),
      select_paths: z.array(z.string()).optional().describe("Regex patterns for URL paths to include"),
      exclude_paths: z.array(z.string()).optional().describe("Regex patterns for URL paths to exclude"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ url, instructions, max_depth, limit, select_paths, exclude_paths }) => {
    try {
      const result = await TavilyClient.crawl(url, { instructions, maxDepth: max_depth, limit, selectPaths: select_paths, excludePaths: exclude_paths });
      if (!result.results.length) {
        return { content: [{ type: "text" as const, text: `No pages crawled from ${url}.` }] };
      }
      const lines = result.results.map((r, i) =>
        `### [${i + 1}] ${r.url}\n${(r.content || '').slice(0, 800)}`
      );
      return { content: [{ type: "text" as const, text: `Crawled ${result.results.length} pages from ${url}\n\n${lines.join("\n\n---\n\n")}` }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── Tavily: Research ──────────────────────────────────────────────
  .registerTool("tavily_research", {
    description: "Initiate comprehensive async research. Conducts multiple searches, analyzes sources, generates a detailed report. Returns a request_id — poll with tavily_research_status. Use for deep-dive topics.",
    inputSchema: {
      input: z.string().describe("Research task or question. E.g., 'Comprehensive analysis of Mistral AI competitive position in European LLM market'"),
      model: z.enum(["mini", "pro", "auto"]).optional().describe("'mini' for narrow Qs, 'pro' for complex multi-domain (default: auto)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ input, model }) => {
    try {
      const result = await TavilyClient.research(input, { model });
      if (!result.requestId) {
        return { content: [{ type: "text" as const, text: `Research task could not be started: ${result.status}` }] };
      }
      return { content: [{ type: "text" as const, text: `Research task queued.\n**Request ID:** ${result.requestId}\n**Status:** ${result.status}\n\nPoll with \`tavily_research_status\` using this ID.` }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── Tavily: Research Status ───────────────────────────────────────
  .registerTool("tavily_research_status", {
    description: "Poll for results of a Tavily Research task. Returns status and, when complete, the full research report with sources.",
    inputSchema: {
      request_id: z.string().describe("Research task ID from tavily_research"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ request_id }) => {
    try {
      const result = await TavilyClient.getResearchStatus(request_id);
      const lines = [`**Status:** ${result.status}`];
      if (result.report) lines.push(`\n**Report:**\n${result.report}`);
      if (result.sources?.length) lines.push(`\n**Sources:** ${result.sources.length} referenced`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: result };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ── Web Extract (legacy) ──────────────────────────────────────────
  .registerTool("web_extract", {
    description: "Legacy alias: Extract content from a URL using Tavily Extract. Prefer tavily_extract for richer extraction.",
    inputSchema: {
      url: z.string().url().describe("URL to scrape and extract content from"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ url }) => {
    try {
      const result = await TavilyClient.extract(url);
      if (result.results.length > 0) {
        return { content: [{ type: "text" as const, text: result.results[0].content?.slice(0, 3000) || "No content extracted." }], structuredContent: result };
      }
      // Fallback: direct fetch
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'DealBot/1.0' } });
      clearTimeout(timer);
      const html = await res.text();
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
      return { content: [{ type: "text" as const, text: text || "Could not extract content." }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error extracting ${url}: ${err.message}` }], isError: true };
    }
  })

  // ── Dify Agent Strategy: FunctionCalling ──────────────────────────
  .registerTool("dify_agent_fc", {
    description: "Run a sub-task using Dify FunctionCalling agent strategy. The agent iteratively calls tools to fulfill the query. Use for structured, tool-heavy sub-tasks (enrichment, data gathering, multi-step lookups).",
    inputSchema: {
      query: z.string().describe("The task or question for the agent to solve"),
      instruction: z.string().optional().describe("System instruction to guide the agent's behavior"),
      context: z.string().optional().describe("Additional context to provide (e.g., prior findings, evidence)"),
      max_iterations: z.number().min(1).max(25).optional().describe("Max tool call rounds (default: 5)"),
    },
  }, async ({ query, instruction, context, max_iterations }) => {
    const apiKey = process.env.DIFY_FC_AGENT_KEY;
    if (!apiKey) {
      return { content: [{ type: "text" as const, text: "DIFY_FC_AGENT_KEY not configured. Create a Dify Agent app with FunctionCalling strategy." }], isError: true };
    }
    try {
      const result = await DifyClient.runCustomAgent(apiKey, {
        instruction: instruction || 'You are a research agent. Use available tools to thoroughly answer the query. Return a structured answer.',
        query,
        context,
        maxIterations: max_iterations || 5,
        label: 'fc-strategy',
      });
      const lines = [`**Strategy:** FunctionCalling`, `**Tool Calls:** ${result.toolCalls}`, '', result.answer];
      return { content: [{ type: "text" as const, text: lines.join('\n') }], structuredContent: { answer: result.answer, parsed: result.parsed, toolCalls: result.toolCalls, strategy: 'function_calling' } };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `FC Agent error: ${err.message}` }], isError: true };
    }
  })

  // ── Dify Agent Strategy: ReAct ────────────────────────────────────
  .registerTool("dify_agent_react", {
    description: "Run a sub-task using Dify ReAct agent strategy. The agent reasons step-by-step (Thought → Action → Observation) to solve the query. Use for complex reasoning tasks that require iterative thinking and evidence synthesis.",
    inputSchema: {
      query: z.string().describe("The task or question for the agent to reason through"),
      instruction: z.string().optional().describe("System instruction to guide the agent's reasoning"),
      context: z.string().optional().describe("Additional context to provide (e.g., prior findings, evidence)"),
      max_iterations: z.number().min(1).max(25).optional().describe("Max reasoning iterations (default: 5)"),
    },
  }, async ({ query, instruction, context, max_iterations }) => {
    const apiKey = process.env.DIFY_REACT_AGENT_KEY;
    if (!apiKey) {
      return { content: [{ type: "text" as const, text: "DIFY_REACT_AGENT_KEY not configured. Create a Dify Agent app with ReAct strategy." }], isError: true };
    }
    try {
      const result = await DifyClient.runCustomAgent(apiKey, {
        instruction: instruction || 'You are a reasoning agent. Think step-by-step: observe results, reflect, and iterate to build a thorough answer.',
        query,
        context,
        maxIterations: max_iterations || 5,
        label: 'react-strategy',
      });
      const lines = [`**Strategy:** ReAct`, `**Tool Calls:** ${result.toolCalls}`, '', result.answer];
      return { content: [{ type: "text" as const, text: lines.join('\n') }], structuredContent: { answer: result.answer, parsed: result.parsed, toolCalls: result.toolCalls, strategy: 'react' } };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `ReAct Agent error: ${err.message}` }], isError: true };
    }
  })

  .registerTool("create_deal", {
    description: "Create a deal analysis session WITHOUT running it. Prefer analyze_deal instead (which creates AND runs in one step). Only use create_deal if you need to set detailed deal terms (ticket_size, valuation, etc.) before running. Returns a deal_id — call run_deal next, then show deal-dashboard.",
    inputSchema: {
      name: z.string().describe("Company name"),
      domain: z.string().describe("Company domain"),
      stage: z.string().optional().describe("Investment stage (seed, series_a, series_b, growth, late)"),
      geo: z.string().optional().describe("Geographic focus (EU, US, Global)"),
      firm_type: z.enum(["angel", "early_vc", "growth_vc", "late_vc", "pe", "ib"]).optional().describe("Investor type: angel, early_vc, growth_vc, late_vc, pe (private equity), ib (investment banking)."),
      aum: z.string().optional().describe("Assets under management, e.g. '$50M', '$500M', '$2B'"),
      ticket_size: z.string().optional().describe("Our ticket size in this round, e.g. '$2M', '$500K'"),
      valuation: z.string().optional().describe("Valuation, e.g. '$50M pre-money', '$80M post-money'"),
      round_type: z.string().optional().describe("Round type: Seed, Series A, Series B, Bridge, etc."),
      raise_amount: z.string().optional().describe("Total raise amount, e.g. '$5M', '$15M'"),
      current_arr: z.string().optional().describe("Current ARR if known, e.g. '$1.2M'"),
      burn_rate: z.string().optional().describe("Monthly burn rate, e.g. '$200K/mo'"),
      runway_months: z.number().optional().describe("Months of runway remaining"),
      team_size: z.number().optional().describe("Current team headcount"),
      use_of_proceeds: z.string().optional().describe("How the company plans to use raised funds"),
      founder_notes: z.string().optional().describe("Any additional context from founder conversations"),
    },
  }, async ({ name, domain, stage, geo, firm_type, aum, ticket_size, valuation, round_type, raise_amount, current_arr, burn_rate, runway_months, team_size, use_of_proceeds, founder_notes }) => {
    try {
      const deal_terms: any = {};
      if (ticket_size) deal_terms.ticket_size = ticket_size;
      if (valuation) deal_terms.valuation = valuation;
      if (round_type) deal_terms.round_type = round_type;
      if (raise_amount) deal_terms.raise_amount = raise_amount;
      if (current_arr) deal_terms.current_arr = current_arr;
      if (burn_rate) deal_terms.burn_rate = burn_rate;
      if (runway_months) deal_terms.runway_months = runway_months;
      if (team_size) deal_terms.team_size = team_size;
      if (use_of_proceeds) deal_terms.use_of_proceeds = use_of_proceeds;
      if (founder_notes) deal_terms.founder_notes = founder_notes;

      const dealId = await Orchestrator.createDeal({
        name,
        domain,
        firm_type: firm_type as any,
        aum,
        deal_terms: Object.keys(deal_terms).length > 0 ? deal_terms : undefined,
        fund_config: { stage: stage || "seed", geo: geo || "EU", sector: "", thesis: "" },
        persona_config: {
          analysts: [
            { specialization: "market" },
            { specialization: "competition" },
            { specialization: "traction" },
          ],
          deal_config: { stage: stage || "seed", geo: geo || "EU", sector: "" },
        },
      });
      const profileLabel = firm_type ? `${firm_type.replace('_', ' ').toUpperCase()}${aum ? ` (AUM: ${aum})` : ''}` : 'Early VC (default)';
      const termsCount = Object.keys(deal_terms).length;
      return {
        content: [
          {
            type: "text" as const,
            text: `Deal created: ${dealId}\nInvestor profile: ${profileLabel}\nDeal terms: ${termsCount > 0 ? `${termsCount} fields captured` : 'None yet — can be added via PATCH'}\nUse run_deal to start the simulation, then deal-dashboard to view results.`,
          },
        ],
        structuredContent: { deal_id: dealId, name, domain, firm_type: firm_type || 'early_vc', aum, deal_terms },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        structuredContent: { error: err.message },
        isError: true,
      };
    }
  })

  .registerTool("run_deal", {
    description:
      "Start/re-run the simulation for an existing deal. Prefer analyze_deal for new deals (creates + runs in one step). After calling this, IMMEDIATELY show deal-dashboard with the same deal_id.",
    inputSchema: {
      deal_id: z.string().describe("Deal ID from create_deal"),
    },
  }, async ({ deal_id }) => {
    if (!Orchestrator.dealExists(deal_id)) {
      // Don't use isError:true — it causes ChatGPT MCP proxy to return 400
      return {
        content: [{ type: "text" as const, text: `Deal ${deal_id} not found — it may have expired. Use analyze_deal to create a fresh analysis.` }],
        structuredContent: { error: "not_found", deal_id },
      };
    }
    // Race simulation against 25s timeout — Alpic has ~30s function execution limit.
    // Background promise dies when container scales down, but deal-dashboard polls
    // will auto-resume the simulation via Orchestrator.resumeIfStalled().
    const simPromise = Orchestrator.runSimulation(deal_id).catch((err) =>
      console.error(`Sim error for ${deal_id}: ${err.message}`)
    );
    const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 25000));
    const result = await Promise.race([simPromise.then(() => 'done' as const), timeout]);
    const completed = result !== 'timeout';
    return {
      content: [
        {
          type: "text" as const,
          text: completed
            ? `Simulation complete for ${deal_id}. Show deal-dashboard now.`
            : `Simulation running for ${deal_id}. Show deal-dashboard now to track live progress.`,
        },
      ],
      structuredContent: { deal_id, completed, in_progress: !completed },
    };
  })

  // ══════════════════════════════════════════════════════════════════
  // TRIGGER SYSTEM — Cala search monitoring + Resend email delivery
  // Attempts Cala native /admin/triggers (JWT required), falls back to
  // local persistence + Cala search polling + Resend email.
  // ══════════════════════════════════════════════════════════════════

  .registerTool("create_trigger", {
    description:
      "Save a monitoring trigger locally and provide instructions to create it on Cala AI console (console.cala.ai/triggers). When Cala fires the trigger, our webhook receives it and forwards via email (Resend).",
    inputSchema: {
      query: z.string().describe("What to monitor — e.g. 'Mistral AI major partnership', 'Stripe revenue milestone'. Be specific."),
      company: z.string().optional().describe("Company name for context"),
      email: z.string().describe("Email address to receive alerts"),
      category: z.enum(["revenue_update", "key_hire", "deal_won", "partnership", "business_model", "general"]).optional().describe("Milestone category"),
    },
  }, async ({ query, company, email, category }) => {
    try {
      const catLabel = (category || 'general').replace(/_/g, ' ');
      const name = company ? `${company} — ${catLabel}: ${query}` : query;
      const id = `trg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

      const trigger = {
        id, cala_id: null, query, enrichedQuery: query, name,
        company: company || '', email, category: category || 'general',
        frequency: 'daily', status: 'active' as const, source: 'local' as const,
        created_at: new Date().toISOString(),
        last_checked: null as string | null, last_fired: null as string | null, fire_count: 0,
      };
      PersistenceManager.saveTrigger(trigger);

      const webhookUrl = 'https://tech-eu-paris-2026-0d53df71.alpic.live/api/webhooks/cala-trigger';

      return {
        content: [{
          type: "text" as const,
          text: [
            `Trigger saved: "${name}" → ${email}`,
            `ID: ${id}`,
            '',
            'To activate on Cala:',
            '1. Go to https://console.cala.ai/triggers',
            `2. Create trigger with query: ${query}`,
            `3. Set webhook URL: ${webhookUrl}`,
            `4. Cala fires → we email ${email} via Resend`,
          ].join('\n'),
        }],
        structuredContent: { trigger, webhookUrl, calaConsoleUrl: 'https://console.cala.ai/triggers' },
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error creating trigger: ${err.message}` }], isError: true };
    }
  })

  .registerTool("list_triggers", {
    description: "List all active monitoring triggers. Use this when the user asks 'what triggers do I have' or 'show my alerts'.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    // Try Cala native (may return empty if JWT auth fails)
    const calaTriggers = await CalaClient.listTriggers().catch(() => []);
    const localTriggers = PersistenceManager.listTriggers();

    if (calaTriggers.length === 0 && localTriggers.length === 0) {
      return { content: [{ type: "text" as const, text: "No triggers configured. Use create_trigger or the trigger-setup widget." }] };
    }

    const lines = [`# Active Triggers (${localTriggers.length} local${calaTriggers.length ? `, ${calaTriggers.length} Cala native` : ''})`];

    if (localTriggers.length > 0) {
      lines.push('| ID | Query | Email | Category | Fires |');
      lines.push('|----|-------|-------|----------|-------|');
      for (const t of localTriggers) {
        lines.push(`| ${t.id} | ${(t.name || t.query || '').slice(0, 35)} | ${t.email} | ${(t.category || 'general').replace(/_/g, ' ')} | ${t.fire_count || 0} |`);
      }
    }

    if (calaTriggers.length > 0) {
      lines.push(`\n**Cala Native (${calaTriggers.length}):**`);
      for (const t of calaTriggers) {
        const emails = (t.notifications || []).map((n: any) => n.target).join(', ');
        lines.push(`• ${t.name || t.query} → ${emails}`);
      }
    }

    return {
      content: [{ type: "text" as const, text: lines.join('\n') }],
      structuredContent: { calaTriggers, localTriggers },
    };
  })

  .registerTool("check_triggers", {
    description: "Run all pending triggers NOW. Searches Cala knowledge base for new content matching each trigger query. Sends email alerts via Resend if results found.",
    inputSchema: {},
  }, async () => {
    const triggers = PersistenceManager.listTriggers().filter(t => t.status === 'active');
    if (triggers.length === 0) {
      return { content: [{ type: "text" as const, text: "No active triggers to check." }] };
    }

    const results: string[] = [];
    const RESEND_KEY = process.env.RESEND_API_KEY;

    for (const trigger of triggers) {
      try {
        const searchQuery = trigger.enrichedQuery || trigger.query;
        const calaRes = await CalaClient.search(searchQuery).catch(() => []);
        const totalHits = Array.isArray(calaRes) ? calaRes.length : 0;

        trigger.last_checked = new Date().toISOString();

        if (totalHits > 0) {
          trigger.last_fired = new Date().toISOString();
          trigger.fire_count = (trigger.fire_count || 0) + 1;

          // Build email body from Cala results
          const topSnippets = Array.isArray(calaRes)
            ? calaRes.slice(0, 4).map((e: any) => `• ${e.title || ''}: ${(e.snippet || '').slice(0, 150)}`)
            : [];
          const alertBody = [
            `Trigger: "${trigger.name || trigger.query}"${trigger.company ? ` (${trigger.company})` : ''}`,
            `Category: ${(trigger.category || 'general').replace(/_/g, ' ')}`,
            `Found ${totalHits} results from Cala knowledge base`,
            '',
            ...topSnippets,
          ].filter(Boolean).join('\n');

          // Send email via Resend
          if (RESEND_KEY && trigger.email) {
            try {
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  from: process.env.RESEND_FROM || 'Deal Bot <onboarding@resend.dev>',
                  to: [trigger.email],
                  subject: `Alert: ${trigger.name || trigger.query}${trigger.company ? ` — ${trigger.company}` : ''}`,
                  text: alertBody,
                }),
              });
              results.push(`✅ ${trigger.id}: ${totalHits} hits → email sent to ${trigger.email}`);
            } catch (emailErr: any) {
              results.push(`⚠️ ${trigger.id}: ${totalHits} hits but email failed: ${emailErr.message}`);
            }
          } else {
            results.push(`✅ ${trigger.id}: ${totalHits} hits${!RESEND_KEY ? ' (add RESEND_API_KEY for email)' : ''}`);
          }
        } else {
          results.push(`○ ${trigger.id}: no new results`);
        }

        PersistenceManager.saveTrigger(trigger);
      } catch (err: any) {
        results.push(`❌ ${trigger.id}: error — ${err.message}`);
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: `# Trigger Check Complete\n${results.join('\n')}`,
      }],
    };
  })

  .registerTool("delete_trigger", {
    description: "Delete a monitoring trigger by ID.",
    inputSchema: {
      trigger_id: z.string().describe("Trigger ID to delete"),
    },
  }, async ({ trigger_id }) => {
    const trigger = PersistenceManager.getTrigger(trigger_id);
    if (!trigger) {
      return { content: [{ type: "text" as const, text: `Trigger ${trigger_id} not found.` }], isError: true };
    }
    if (trigger.cala_id) await CalaClient.deleteTrigger(trigger.cala_id).catch(() => {});
    PersistenceManager.deleteTrigger(trigger_id);
    return { content: [{ type: "text" as const, text: `Trigger "${trigger.name || trigger.query}" deleted.` }] };
  })

  // ── Receive Cala trigger-fired webhook payload via MCP ─────────────
  // Since Alpic doesn't expose custom HTTP routes, this tool allows
  // processing Cala trigger-fired payloads via MCP and forwarding via Resend.
  // Can also be used to manually test the email pipeline.
  .registerTool("receive_trigger_webhook", {
    description: "Process a Cala trigger-fired webhook payload. Logs the event, matches to a local trigger, and sends an email alert via Resend. Use this to forward Cala trigger notifications or to test the email pipeline.",
    inputSchema: {
      trigger_id: z.string().optional().describe("Cala trigger ID"),
      trigger_name: z.string().describe("Name of the trigger that fired"),
      query: z.string().describe("The monitored query"),
      answer: z.string().describe("The updated answer/intelligence from Cala"),
      email: z.string().optional().describe("Override recipient email (uses trigger's saved email if omitted)"),
    },
  }, async ({ trigger_id, trigger_name, query, answer, email: overrideEmail }) => {
    try {
      // Log event
      PersistenceManager.startToolAction({
        toolName: 'calaWebhook', provider: 'cala', operation: 'trigger_fired',
        input: { trigger_id, trigger_name, query }, calledBy: 'mcp-webhook-tool',
      });

      // Find matching local trigger for saved email
      const localTriggers = PersistenceManager.listTriggers();
      const matched = localTriggers.find((t: any) =>
        t.query === query || t.name === trigger_name || t.cala_id === trigger_id
      );
      const recipientEmail = overrideEmail || matched?.email || process.env.TRIGGER_NOTIFY_EMAIL;

      if (!recipientEmail) {
        return { content: [{ type: "text" as const, text: `Trigger "${trigger_name}" received but no email configured. Set email param or TRIGGER_NOTIFY_EMAIL.` }] };
      }

      const RESEND_KEY = process.env.RESEND_API_KEY;
      if (!RESEND_KEY) {
        return { content: [{ type: "text" as const, text: `Trigger "${trigger_name}" received but RESEND_API_KEY not configured.` }] };
      }

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'Deal Bot <onboarding@resend.dev>',
          to: [recipientEmail],
          subject: `Trigger Alert: ${trigger_name}`,
          html: `
            <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #7c5cfc;">Cala Trigger Fired</h2>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr><td style="padding: 8px; color: #666;">Trigger</td><td style="padding: 8px; font-weight: bold;">${trigger_name}</td></tr>
                <tr><td style="padding: 8px; color: #666;">Query</td><td style="padding: 8px;">${query}</td></tr>
                ${trigger_id ? `<tr><td style="padding: 8px; color: #666;">Trigger ID</td><td style="padding: 8px; font-size: 12px; color: #999;">${trigger_id}</td></tr>` : ''}
              </table>
              <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
              <h3 style="color: #333;">Updated Intelligence</h3>
              <div style="background: #f8f8fc; padding: 16px; border-radius: 8px; border-left: 4px solid #7c5cfc;">
                ${answer.replace(/\n/g, '<br/>')}
              </div>
              <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
              <p style="color: #aaa; font-size: 11px;">Sent by Deal Bot — powered by Cala AI triggers</p>
            </div>
          `,
        }),
      });

      // Update local trigger stats
      if (matched) {
        matched.last_fired = new Date().toISOString();
        matched.fire_count = (matched.fire_count || 0) + 1;
        PersistenceManager.saveTrigger(matched);
      }

      return {
        content: [{ type: "text" as const, text: `Trigger alert for "${trigger_name}" sent to ${recipientEmail} via Resend.` }],
        structuredContent: { sent: true, recipient: recipientEmail, trigger_name, query },
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error forwarding trigger: ${err.message}` }], isError: true };
    }
  })

  // ── Batch trigger creation (local + Cala console instructions) ─────
  .registerTool("create_triggers_batch", {
    description: "Create monitoring triggers for a company. Saves queries locally and provides step-by-step instructions for the user to create native triggers on Cala AI console (https://console.cala.ai/triggers). When Cala fires a trigger, our webhook receives it and forwards via email (Resend).",
    inputSchema: {
      company: z.string().describe("Company name being reviewed"),
      domain: z.string().optional().describe("Company domain (e.g. mistral.ai)"),
      email: z.string().describe("Email for trigger alerts (via Resend)"),
      categories: z.array(z.string()).describe("Milestone categories: revenue_update, key_hire, deal_won, partnership, business_model"),
      custom_query: z.string().optional().describe("Optional custom focus"),
    },
  }, async ({ company, domain, email, categories, custom_query }) => {
    try {
      const categoryConfig: Record<string, { label: string; queryTemplate: string }> = {
        revenue_update: { label: 'Key Revenue Updates', queryTemplate: `${company} revenue ARR growth metrics quarterly results financial performance` },
        key_hire: { label: 'Key Executive Hires', queryTemplate: `${company} executive hire leadership appointed CTO CRO VP director` },
        deal_won: { label: 'Key Deals Won', queryTemplate: `${company} deal closed contract signed customer win enterprise partnership` },
        partnership: { label: 'Key Partnerships', queryTemplate: `${company} partnership strategic alliance integration collaboration` },
        business_model: { label: 'Business Model Updates', queryTemplate: `${company} business model pricing pivot strategy new vertical expansion` },
      };

      // Build webhook URL for Cala console
      const webhookUrl = `https://tech-eu-paris-2026-0d53df71.alpic.live/api/webhooks/cala-trigger`;

      const created: any[] = [];
      const queriesForConsole: { name: string; query: string }[] = [];

      for (const cat of categories) {
        const config = categoryConfig[cat];
        if (!config) continue;

        const baseQuery = custom_query ? `${company} ${custom_query} ${config.label}` : config.queryTemplate;
        const name = `${company} — ${config.label}`;
        const id = `trg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

        const trigger = {
          id, cala_id: null, query: baseQuery, enrichedQuery: baseQuery, name, company,
          domain: domain || '', email, category: cat, frequency: 'daily',
          status: 'active' as const, source: 'local' as const,
          created_at: new Date().toISOString(),
          last_checked: null as string | null, last_fired: null as string | null, fire_count: 0,
        };
        PersistenceManager.saveTrigger(trigger);
        created.push(trigger);
        queriesForConsole.push({ name, query: baseQuery });
      }

      // Build user-facing instructions
      const queryList = queriesForConsole.map((q, i) =>
        `${i + 1}. "${q.name}"\n   Query: ${q.query}`
      ).join('\n\n');

      const instructions = [
        `Saved ${created.length} triggers locally for ${company} → ${email}`,
        '',
        'To activate native Cala monitoring:',
        '1. Go to https://console.cala.ai/triggers',
        '2. Create a trigger for each query below',
        '3. Set webhook URL to:',
        `   ${webhookUrl}`,
        '4. When Cala detects changes, it fires the webhook',
        `5. We forward alerts to ${email} via Resend`,
        '',
        '── Queries to paste into Cala Console ──',
        '',
        queryList,
      ].join('\n');

      return {
        content: [{ type: "text" as const, text: instructions }],
        structuredContent: {
          triggers: created, company, email,
          webhookUrl,
          calaConsoleUrl: 'https://console.cala.ai/triggers',
          queriesForConsole,
        },
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ══════════════════════════════════════════════════════════════════
  // WIDGET: trigger-setup — company-specific trigger creation
  // Tied to the company being reviewed. Categories match what a VC
  // analyst cares about when monitoring a portfolio/pipeline company.
  // ══════════════════════════════════════════════════════════════════
  .registerWidget(
    "trigger-setup",
    {
      description:
        "Set up monitoring triggers for the company being reviewed — revenue updates, key hires, deals won, partnerships, business model changes",
      _meta: { ui: { prefersBorder: false } },
    },
    {
      description:
        "Open the trigger setup for a company the user is currently reviewing. Shows 5 milestone categories (revenue updates, key hires, deals won, partnerships, business model changes) and email input. When Lightpanda JWT is available, creates native Cala triggers; otherwise uses local persistence + polling.",
      inputSchema: {
        company: z.string().describe("Company name to monitor (from the company being reviewed)"),
        domain: z.string().optional().describe("Company domain"),
      },
      _meta: {
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Loading trigger setup...",
        "openai/toolInvocation/invoked": "Trigger setup ready",
      },
    },
    async ({ company, domain }) => {
      // Fetch existing triggers — local + Cala native
      const localTriggers = PersistenceManager.listTriggers();
      const calaTriggers = await CalaClient.listTriggers().catch(() => []);

      // Filter to this company
      const companyLocal = localTriggers.filter(
        t => t.company?.toLowerCase() === company.toLowerCase() && t.status === 'active'
      );
      const companyCala = calaTriggers.filter(
        (t: any) => (t.name || t.query || '').toLowerCase().includes(company.toLowerCase())
      );

      // Merge — deduplicate by query
      const seen = new Set<string>();
      const existingTriggers: any[] = [];
      for (const t of [...companyLocal, ...companyCala]) {
        const key = (t.query || t.name || '').toLowerCase().slice(0, 50);
        if (!seen.has(key)) {
          seen.add(key);
          existingTriggers.push({
            id: t.id,
            name: t.name || t.query,
            query: t.query,
            category: t.category || 'general',
            email: (t.notifications?.[0]?.target) || t.email || '',
            source: t.source || (t.notifications ? 'cala' : 'local'),
          });
        }
      }

      // Get Specter profile for company context card (non-blocking)
      const specterProfile = domain
        ? await SpecterClient.enrichByDomain(domain).then(r => r.profile).catch(() => null)
        : null;

      // Check if Cala triggers API is available (just needs API key)
      const calaTriggersAvailable = CalaClient.triggersAvailable();

      return {
        content: [{
          type: "text" as const,
          text: `Trigger setup for ${company}${domain ? ` (${domain})` : ''}. ${existingTriggers.length} existing triggers. ${calaTriggersAvailable ? 'Cala Beta Triggers API active.' : 'Cala API key required.'} Select categories and enter email to create alerts.`,
        }],
        structuredContent: {
          company,
          domain: domain || '',
          existingTriggers,
          calaTriggersAvailable,
          specterProfile: specterProfile ? {
            name: specterProfile.name,
            domain: specterProfile.domain,
            growth_stage: specterProfile.growth_stage,
            hq_country: specterProfile.hq_country,
            industries: specterProfile.industries?.slice(0, 3),
            logo_url: specterProfile.logo_url,
            employee_count: specterProfile.employee_count,
          } : null,
          categories: [
            { id: 'revenue_update', label: 'Revenue Updates', icon: '📈', desc: 'Key ARR/MRR milestones, quarterly results, growth targets hit' },
            { id: 'key_hire', label: 'Key Hires', icon: '👤', desc: 'C-suite, VP, director appointments and leadership changes' },
            { id: 'deal_won', label: 'Deals Won', icon: '🤝', desc: 'Major contracts, enterprise customer wins, pilot deployments' },
            { id: 'partnership', label: 'Partnerships', icon: '🔗', desc: 'Strategic alliances, integrations, ecosystem partnerships' },
            { id: 'business_model', label: 'Business Model', icon: '🔄', desc: 'Pricing changes, new verticals, market expansion, pivots' },
          ],
        },
      };
    },
  )

  // ══════════════════════════════════════════════════════════════════
  // SPECTER COMPETITIVE PIPELINE — structured competitor enrichment
  // ══════════════════════════════════════════════════════════════════

  .registerTool("specter_competitor_pipeline", {
    description:
      "Run a full competitive intelligence pipeline: find similar companies via Specter AI matching, then enrich top N competitors with full profiles (funding, team, revenue, traction). Returns structured comparison data. Use this instead of web search for competitive analysis.",
    inputSchema: {
      company_id: z.string().describe("Specter company ID of the target company"),
      top_n: z.number().min(1).max(10).optional().describe("Number of competitors to fully enrich (default: 5)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ company_id, top_n }) => {
    try {
      const n = top_n || 5;
      const { companies, evidence: similarEvidence } = await SpecterClient.getSimilarCompanies(company_id);

      if (!companies.length) {
        return { content: [{ type: "text" as const, text: `No similar companies found for ${company_id}.` }] };
      }

      // Enrich top N
      const enrichResults = await Promise.all(
        companies.slice(0, n).filter(c => c.id).map(async (comp) => {
          const { profile, evidence } = await SpecterClient.getCompanyById(comp.id);
          return { comp, profile, evidence };
        })
      );

      const enriched = enrichResults.filter(r => r.profile);
      const allEvidence = [...similarEvidence, ...enriched.flatMap(r => r.evidence)];

      // Build comparison table
      const lines = [
        `# Competitive Landscape (${companies.length} similar, ${enriched.length} enriched)`,
        "",
        "| Company | Domain | Stage | Employees | Funding | Revenue Est. |",
        "|---------|--------|-------|-----------|---------|--------------|",
      ];
      for (const r of enriched) {
        const p = r.profile!;
        const funding = p.funding_total_usd ? `$${(p.funding_total_usd / 1e6).toFixed(1)}M` : "N/A";
        const revenue = p.revenue_estimate_usd ? `$${(p.revenue_estimate_usd / 1e6).toFixed(1)}M` : "N/A";
        lines.push(`| ${p.name} | ${p.domain} | ${p.growth_stage || "?"} | ${p.employee_count || "?"} | ${funding} | ${revenue} |`);
      }

      // Aggregate stats
      const totalFunding = enriched.reduce((s, r) => s + (r.profile!.funding_total_usd || 0), 0);
      const avgEmployees = Math.round(enriched.reduce((s, r) => s + (r.profile!.employee_count || 0), 0) / enriched.length);
      lines.push(`\n**Aggregate:** Combined funding: $${(totalFunding / 1e6).toFixed(1)}M | Avg employees: ${avgEmployees}`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: {
          similarCount: companies.length,
          enrichedCount: enriched.length,
          competitors: enriched.map(r => r.profile),
          evidence: allEvidence,
        },
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ══════════════════════════════════════════════════════════════════
  // LIGHTPANDA — Headless browser for JS-heavy pages + Cala JWT auth
  // ══════════════════════════════════════════════════════════════════

  .registerTool("lightpanda_scrape", {
    description:
      "Scrape a JS-heavy web page using Lightpanda headless browser. Unlike regular fetch, this renders JavaScript, loads dynamic content, and handles SPAs. Use for: competitor product pages, pricing pages, dashboards, any page that requires JS rendering.",
    inputSchema: {
      url: z.string().describe("URL to scrape with headless browser"),
      wait_selector: z.string().optional().describe("CSS selector to wait for before extracting (e.g., '.pricing-table', '#content')"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ url, wait_selector }) => {
    try {
      const { LightpandaClient } = await import('./integrations/lightpanda/client.js');
      if (!LightpandaClient.isAvailable()) {
        return { content: [{ type: "text" as const, text: "Lightpanda not configured (LIGHTPANDA_TOKEN missing). Use tavily_extract instead." }], isError: true };
      }
      const result = await LightpandaClient.scrapeUrl(url, { waitSelector: wait_selector });
      if (!result.content) {
        return { content: [{ type: "text" as const, text: `Could not scrape ${url}.` }] };
      }
      return {
        content: [{ type: "text" as const, text: `**${result.title || url}**\n\n${result.content.slice(0, 3000)}` }],
        structuredContent: { ...result, source: 'lightpanda' },
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  // ══════════════════════════════════════════════════════════════════
  // DEAL WORKFLOW — streamlined UX: analyze, list, lookup
  // ══════════════════════════════════════════════════════════════════

  .registerTool("analyze_deal", {
    description:
      "STEP 2: Run full deal analysis with 3 AI analysts, associate synthesis, and partner decision. Use this when the user says 'analyze', 'process deal', 'run analysis', 'evaluate this company', or clicks Process Deal. Returns a deal_id. CRITICAL: After calling this, IMMEDIATELY call deal-dashboard with the returned deal_id to show the live dashboard. Do NOT add any text between analyze_deal and deal-dashboard — just chain the two calls.",
    inputSchema: {
      name: z.string().describe("Company name"),
      domain: z.string().describe("Company domain (e.g. mistral.ai)"),
      stage: z.string().optional().describe("Investment stage (seed, series_a, series_b, growth, late)"),
      geo: z.string().optional().describe("Geographic focus (EU, US, Global)"),
      sector: z.string().optional().describe("Sector (AI, Fintech, SaaS, etc.)"),
      firm_type: z.enum(["angel", "early_vc", "growth_vc", "late_vc", "pe", "ib"]).optional().describe("Investor type"),
      aum: z.string().optional().describe("Assets under management"),
    },
  }, async ({ name, domain, stage, geo, sector, firm_type, aum }) => {
    try {
      // Check if deal already exists for this company
      const existing = PersistenceManager.findDealByNameOrDomain(domain || name);
      if (existing) {
        // Race simulation against 25s timeout — Alpic has ~30s limit
        const simP = Orchestrator.runSimulation(existing.id).catch((err) =>
          console.error(`Sim error for ${existing.id}: ${err.message}`)
        );
        const tOut = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 25000));
        const res = await Promise.race([simP.then(() => 'done' as const), tOut]);
        const done = res !== 'timeout';
        return {
          content: [{
            type: "text" as const,
            text: done
              ? `Deal analysis complete for ${name}.\nDeal ID: ${existing.id}\n\nNow show the deal-dashboard widget with deal_id="${existing.id}".`
              : `Deal analysis running for ${name}.\nDeal ID: ${existing.id}\n\nShow deal-dashboard widget with deal_id="${existing.id}" to track live progress.`,
          }],
          structuredContent: { deal_id: existing.id, name: existing.name, domain: existing.domain, rerun: true, completed: done, in_progress: !done },
        };
      }

      // Create new deal
      const dealId = await Orchestrator.createDeal({
        name,
        domain,
        firm_type: firm_type as any,
        aum,
        fund_config: { stage: stage || "seed", geo: geo || "EU", sector: sector || "", thesis: "" },
        persona_config: {
          analysts: [
            { specialization: "market" },
            { specialization: "competition" },
            { specialization: "traction" },
          ],
          deal_config: { stage: stage || "seed", geo: geo || "EU", sector: sector || "" },
        },
      });

      // Race simulation against 25s timeout — Alpic has ~30s limit
      const simP = Orchestrator.runSimulation(dealId).catch((err) =>
        console.error(`Sim error for ${dealId}: ${err.message}`)
      );
      const tOut = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 25000));
      const res = await Promise.race([simP.then(() => 'done' as const), tOut]);
      const done = res !== 'timeout';

      return {
        content: [{
          type: "text" as const,
          text: done
            ? `Deal analysis complete for ${name} (${domain}).\nDeal ID: ${dealId}\n\nNow show the deal-dashboard widget with deal_id="${dealId}".`
            : `Deal analysis running for ${name} (${domain}).\nDeal ID: ${dealId}\n\nShow deal-dashboard widget with deal_id="${dealId}" to track live progress.`,
        }],
        structuredContent: { deal_id: dealId, name, domain, firm_type: firm_type || 'early_vc', aum, completed: done, in_progress: !done },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  })

  .registerTool("list_deals", {
    description:
      "List all deal analysis sessions with their IDs, names, domains, status, and scores. Use when the user asks 'show my deals', 'what deals have I run', 'find deal for X'. Returns deal_id values that can be used with deal-dashboard widget.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const deals = PersistenceManager.listDeals({ limit: 20 });
      if (!deals.length) {
        return {
          content: [{ type: "text" as const, text: "No deals yet. Use analyze_deal or create_deal to start." }],
          structuredContent: { deals: [] },
        };
      }
      const lines = [
        `# Your Deals (${deals.length})`,
        "",
        "| # | Company | Domain | Status | Decision | Score | Deal ID |",
        "|---|---------|--------|--------|----------|-------|---------|",
      ];
      deals.forEach((d: any, i: number) => {
        const score = d.latest_avg_score ? `${d.latest_avg_score}/100` : '—';
        const decision = d.latest_decision || '—';
        const status = d.status || 'pending';
        lines.push(`| ${i + 1} | ${d.name} | ${d.domain || '—'} | ${status} | ${decision} | ${score} | \`${d.id}\` |`);
      });
      lines.push(`\nTo view any deal: use the **deal-dashboard** widget with the deal_id.`);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: { deals },
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  .registerTool("lookup_deal", {
    description:
      "Find a deal by company name or domain. Use when the user says 'show me the Mistral deal', 'open deal for stripe.com', 'what was the score for X'. Returns the deal_id and current state summary. Then show deal-dashboard with that ID.",
    inputSchema: {
      query: z.string().describe("Company name or domain to search for (e.g. 'Mistral AI', 'mistral.ai', 'stripe')"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    try {
      const deal = PersistenceManager.findDealByNameOrDomain(query);
      if (!deal) {
        return {
          content: [{
            type: "text" as const,
            text: `No deal found for "${query}". Use analyze_deal to create and run one.`,
          }],
          structuredContent: { found: false, query },
        };
      }
      const state = PersistenceManager.getState(deal.id);
      const evidenceCount = state?.evidence?.length || 0;
      const decision = state?.decision_gate?.decision || deal.latest_decision || 'pending';
      const score = deal.latest_avg_score || 0;

      return {
        content: [{
          type: "text" as const,
          text: `Found: **${deal.name}** (${deal.domain})\nDeal ID: ${deal.id}\nStatus: ${deal.status || 'in_progress'} | Decision: ${decision} | Score: ${score}/100 | Evidence: ${evidenceCount} items\n\nShow the deal-dashboard widget with deal_id="${deal.id}" to view full results.`,
        }],
        structuredContent: { found: true, deal_id: deal.id, ...deal, evidenceCount, decision },
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  })

  .registerTool("cala_triggers_status", {
    description:
      "Check Cala Beta Triggers API status and list existing triggers. Triggers use /beta/triggers with X-API-KEY auth — no JWT needed.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const available = CalaClient.triggersAvailable();
    if (!available) {
      return {
        content: [{ type: "text" as const, text: "Cala triggers API not available — CALA_API_KEY not set." }],
        structuredContent: { available: false, triggers: [] },
      };
    }
    try {
      const triggers = await CalaClient.listTriggers();
      return {
        content: [{
          type: "text" as const,
          text: `Cala triggers API active. ${triggers.length} trigger(s) found.${triggers.length > 0 ? '\n' + triggers.map(t => `• ${t.name} (${t.status}) — ${t.notifications.length} notification(s)`).join('\n') : ''}`,
        }],
        structuredContent: { available: true, triggers },
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error listing triggers: ${err.message}` }], isError: true };
    }
  })

  // ══════════════════════════════════════════════════════════════════
  // DIAGNOSTIC: debug_deal — for MCP Inspector / troubleshooting
  // ══════════════════════════════════════════════════════════════════
  .registerTool("debug_deal", {
    description:
      "Diagnostic tool: returns internal state details for a deal (DATA_DIR, file existence, event counts, liveUpdate phases). Use via MCP Inspector for troubleshooting.",
    inputSchema: {
      deal_id: z.string().describe("Deal ID to inspect"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ deal_id }) => {
    const fs = await import('fs');
    const path = await import('path');
    const dataDir = process.env.DATA_DIR_OVERRIDE || (process.cwd() + '/data/deals');
    const tmpDir = '/tmp/dealbot/data/deals';

    // Check both possible DATA_DIR locations
    const cwdPath = path.join(process.cwd(), 'data/deals', deal_id);
    const tmpPath = path.join(tmpDir, deal_id);
    const cwdExists = fs.existsSync(cwdPath);
    const tmpExists = fs.existsSync(tmpPath);
    const dealDir = cwdExists ? cwdPath : tmpExists ? tmpPath : null;

    const diag: any = {
      cwd: process.cwd(),
      cwdDataExists: cwdExists,
      tmpDataExists: tmpExists,
      activeDealDir: dealDir,
      stateFileExists: false,
      eventsFileExists: false,
      eventsFileSize: 0,
      eventCount: 0,
      liveUpdateCount: 0,
      liveUpdatePhases: [] as string[],
      nodeMemoryFiles: [] as string[],
      hasState: false,
      stateEvidence: 0,
      stateCompanyName: '',
    };

    if (dealDir) {
      const stateFile = path.join(dealDir, 'state.json');
      const eventsFile = path.join(dealDir, 'events.jsonl');
      diag.stateFileExists = fs.existsSync(stateFile);
      diag.eventsFileExists = fs.existsSync(eventsFile);

      if (diag.eventsFileExists) {
        const stat = fs.statSync(eventsFile);
        diag.eventsFileSize = stat.size;
        try {
          const lines = fs.readFileSync(eventsFile, 'utf-8').split('\n').filter((l: string) => l.trim());
          diag.eventCount = lines.length;
          const parsed = lines.map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const liveUpdates = parsed.filter((e: any) => e.type === 'LIVE_UPDATE');
          diag.liveUpdateCount = liveUpdates.length;
          diag.liveUpdatePhases = liveUpdates.map((e: any) => e.payload?.phase).filter(Boolean);
          // Show last 5 event types for quick diagnostics
          diag.recentEventTypes = parsed.slice(-5).map((e: any) => `${e.type}:${e.payload?.phase || e.payload?.node_id || ''}`);
          // Extract ALL error events with full payload
          const errorEvents = parsed.filter((e: any) => e.type === 'ERROR');
          diag.errorCount = errorEvents.length;
          diag.errors = errorEvents.map((e: any) => ({
            where: e.payload?.where || 'unknown',
            message: (e.payload?.message || '').slice(0, 500),
            ts: e.ts,
          }));
          // Show NODE_DONE events to see which nodes completed
          const nodeDones = parsed.filter((e: any) => e.type === 'NODE_DONE');
          diag.completedNodes = nodeDones.map((e: any) => ({
            node: e.payload?.node_id,
            summary: (e.payload?.output_summary || '').slice(0, 200),
          }));
        } catch (err: any) { diag.eventsParseError = err.message; }
      }

      if (diag.stateFileExists) {
        try {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          diag.hasState = true;
          diag.stateEvidence = state.evidence?.length || 0;
          diag.stateCompanyName = state.deal_input?.name || '';
          diag.hasRubric = state.rubric?.market?.score > 0;
          diag.decision = state.decision_gate?.decision || 'none';
        } catch (err: any) { diag.stateParseError = err.message; }
      }

      // Check memory files
      try {
        const files = fs.readdirSync(dealDir);
        diag.nodeMemoryFiles = files.filter((f: string) => f.startsWith('mem_'));
        diag.allFiles = files;
      } catch {}
    }

    // PersistenceManager checks
    diag.pmHasEvents = PersistenceManager.hasEvents(deal_id);
    diag.pmGetState = PersistenceManager.getState(deal_id) !== null;
    diag.pmLiveUpdates = PersistenceManager.getLiveUpdates(deal_id).length;

    // Dify health check — test if each agent key is valid
    diag.difyKeys = {
      analyst: !!process.env.ANALYST_DIFY_KEY,
      associate: !!process.env.ASSOCIATE_DIFY_KEY,
      partner: !!process.env.PARTNER_DIFY_KEY,
      narrator: !!process.env.NARRATOR_DIFY_KEY,
    };
    // Quick ping to Dify API — use /parameters?user=diag (GET) to verify key validity
    const difyBase = process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1';
    const testKeys: [string, string | undefined][] = [
      ['analyst', process.env.ANALYST_DIFY_KEY],
      ['associate', process.env.ASSOCIATE_DIFY_KEY],
      ['partner', process.env.PARTNER_DIFY_KEY],
    ];
    diag.difyPing = {};
    await Promise.all(testKeys.map(async ([name, key]) => {
      if (!key) { diag.difyPing[name] = 'NO_KEY'; return; }
      try {
        const resp = await fetch(`${difyBase}/parameters?user=diag`, {
          headers: { 'Authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const data = await resp.json() as any;
          const vars = data.user_input_form?.map((f: any) => Object.keys(f)[0] === 'text-input' ? f['text-input']?.variable : '?').filter(Boolean);
          diag.difyPing[name] = `OK — vars: ${vars?.join(', ') || 'none'}`;
        } else {
          diag.difyPing[name] = `FAIL (${resp.status})`;
        }
      } catch (e: any) {
        diag.difyPing[name] = `ERROR: ${e.message?.slice(0, 100)}`;
      }
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify(diag, null, 2) }],
      structuredContent: diag,
    };
  });

export default server;
export type AppType = typeof server;
