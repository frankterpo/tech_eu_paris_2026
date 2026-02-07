import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DealInput, DealState, DealEvent, EventType } from './types';
import { PersistenceManager } from './persistence';
import { reduceState } from './reducer';
import {
  AnalystOutputSchema, AssociateOutputSchema, PartnerOutputSchema,
  enforceEvidenceRule,
  type AnalystOutput, type AssociateOutput, type PartnerOutput
} from './validators';
import { validateWithRetry } from './validate-with-retry';
import { CalaClient } from './integrations/cala/client';
import { DifyClient, type DifyAgentName } from './integrations/dify/client';
import { SpecterClient } from './integrations/specter/client';

export class Orchestrator {
  private static streams: Map<string, Response[]> = new Map();

  static async createDeal(input: DealInput): Promise<string> {
    const dealId = uuidv4();
    const initialState: DealState = {
      deal_input: input,
      evidence: [],
      company_profile: null,
      hypotheses: [],
      rubric: {
        market: { score: 0, reasons: [] },
        moat: { score: 0, reasons: [] },
        why_now: { score: 0, reasons: [] },
        execution: { score: 0, reasons: [] },
        deal_fit: { score: 0, reasons: [] },
      },
      decision_gate: {
        decision: 'PROCEED_IF',
        gating_questions: ['Pending...', 'Pending...', 'Pending...'],
        evidence_checklist: []
      }
    };

    PersistenceManager.saveState(dealId, initialState);
    return dealId;
  }

  static dealExists(dealId: string): boolean {
    return PersistenceManager.getState(dealId) !== null;
  }

  static addStream(dealId: string, res: Response) {
    const dealStreams = this.streams.get(dealId) || [];
    dealStreams.push(res);
    this.streams.set(dealId, dealStreams);

    res.on('close', () => {
      const updated = (this.streams.get(dealId) || []).filter(s => s !== res);
      if (updated.length === 0) {
        this.streams.delete(dealId);
      } else {
        this.streams.set(dealId, updated);
      }
    });
  }

  /**
   * Core event emitter.
   * - Persists full payload to events.jsonl (for replay via reducer).
   * - Runs reducer to update canonical state.json.
   * - Sends ssePayload (spec-compliant subset) to SSE clients; falls back to full payload.
   */
  static emitEvent(dealId: string, type: EventType, payload: any, ssePayload?: any) {
    const event: DealEvent = {
      ts: new Date().toISOString(),
      deal_id: dealId,
      type,
      payload       // full data — persisted + fed to reducer
    };

    PersistenceManager.saveEvent(dealId, event);

    // Update state via reducer (uses full payload)
    const currentState = PersistenceManager.getState(dealId);
    if (currentState) {
      const newState = reduceState(currentState, event);
      PersistenceManager.saveState(dealId, newState);
    }

    // Push spec-compliant payload to SSE clients
    const sseEvent = ssePayload
      ? { ts: event.ts, deal_id: dealId, type, payload: ssePayload }
      : event;
    const dealStreams = this.streams.get(dealId) || [];
    dealStreams.forEach(res => {
      res.write(`data: ${JSON.stringify(sseEvent)}\n\n`);
    });
  }

  /**
   * Add evidence: persists items in event for replay, sends spec-clean SSE.
   */
  static addEvidence(dealId: string, items: any[]) {
    const fullPayload = {
      items,
      evidence_items_count: items.length,
      last_evidence_id: items[items.length - 1]?.evidence_id ?? null
    };
    const ssePayload = {
      evidence_items_count: fullPayload.evidence_items_count,
      last_evidence_id: fullPayload.last_evidence_id
    };
    this.emitEvent(dealId, 'EVIDENCE_ADDED', fullPayload, ssePayload);
  }

  /**
   * Update decision gate: persists full gate in event for replay, sends spec-clean SSE.
   */
  static updateDecisionGate(dealId: string, gate: { decision: string; gating_questions: string[]; evidence_checklist?: any[] }) {
    const fullPayload = { ...gate };
    const ssePayload = {
      decision: gate.decision,
      gating_questions: gate.gating_questions
    };
    this.emitEvent(dealId, 'DECISION_UPDATED', fullPayload, ssePayload);
  }

  /**
   * Helper: stringify a value for Dify workflow inputs (paragraph/text variables expect strings).
   */
  private static toInputStr(val: any): string {
    if (val === undefined || val === null) return '';
    if (typeof val === 'string') return val;
    return JSON.stringify(val);
  }

  // ── Rich query builders ─────────────────────────────────────────────
  /**
   * Build a concise company brief from the profile + evidence for agent queries.
   * This ensures agents always have the specific company data inline, independent
   * of whether their tool calls succeed.
   */
  private static buildCompanyBrief(state: DealState): string {
    const p = state.company_profile;
    const di = state.deal_input;
    const dc = di.persona_config?.deal_config || {};
    const lines: string[] = [];

    lines.push(`COMPANY: ${di.name} (${di.domain})`);
    lines.push(`Stage: ${dc.stage || 'unknown'} | Geo: ${dc.geo || 'unknown'} | Sector: ${dc.sector || 'unknown'}`);

    if (p) {
      lines.push(`Description: ${p.description}`);
      if (p.tagline) lines.push(`Tagline: "${p.tagline}"`);
      lines.push(`Founded: ${p.founded_year || 'N/A'} | HQ: ${p.hq_city || '?'}, ${p.hq_country || '?'}`);
      lines.push(`Employees: ${p.employee_count || 'N/A'} (${p.employee_range || '?'}) | Founders (${p.founder_count}): ${p.founders?.join(', ') || 'N/A'}`);
      lines.push(`Customer focus: ${p.customer_focus} | Primary role: ${p.primary_role}`);
      lines.push(`Industries: ${p.industries?.join(', ') || 'N/A'}`);
      lines.push(`Sub-industries: ${p.sub_industries?.join(', ') || 'N/A'}`);
      if (p.funding_total_usd) lines.push(`Total funding: $${(p.funding_total_usd / 1e6).toFixed(1)}M`);
      if (p.investors?.length) lines.push(`Investors: ${p.investors.join(', ')}`);
      if (!p.funding_total_usd && !p.investors?.length) lines.push('Funding: Bootstrapped / No external funding');
      if (p.web_monthly_visits) lines.push(`Web traffic: ${p.web_monthly_visits.toLocaleString()} monthly visits (rank #${p.web_global_rank?.toLocaleString() || '?'})`);
      if (p.linkedin_followers) lines.push(`LinkedIn: ${p.linkedin_followers.toLocaleString()} followers`);
      if (p.twitter_followers) lines.push(`Twitter: ${p.twitter_followers.toLocaleString()} followers`);
      if (p.revenue_estimate_usd) lines.push(`Revenue est.: $${p.revenue_estimate_usd.toLocaleString()}`);
      if (p.highlights?.length) lines.push(`Signals: ${p.highlights.join(', ')}`);
      if (p.tags?.length) lines.push(`Tags: ${p.tags.join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Summarize evidence items into a compact numbered list for agent queries.
   */
  private static buildEvidenceSummary(evidence: any[]): string {
    if (!evidence?.length) return '(No evidence seeded yet)';
    return evidence.map((e, i) =>
      `[${i + 1}] (id=${e.evidence_id}) [${e.source}] ${e.title}: ${(e.snippet || '').slice(0, 200)}`
    ).join('\n');
  }

  /**
   * Build a rich, context-specific query for an analyst agent.
   */
  private static buildAnalystQuery(
    state: DealState,
    specialization: string,
    analystId: string,
    priorAnalyses: { analyst_id: string; specialization: string; facts: any[]; unknowns: any[] }[]
  ): string {
    const brief = this.buildCompanyBrief(state);
    const evidenceSummary = this.buildEvidenceSummary(state.evidence);

    const specterId = state.company_profile?.specter_id || '';
    const founderNames = state.company_profile?.founders?.join(', ') || 'unknown';

    // Specialization-specific AGGRESSIVE focus instructions with mandatory tool calls
    const focusMap: Record<string, string> = {
      market: `FOCUS: Market size (TAM/SAM/SOM), growth rates, market trends, demand drivers, customer segments, and market timing.

YOU MUST USE THESE TOOLS (do NOT skip any):
1. calaSearch — Run AT LEAST 3 separate queries:
   - "${state.deal_input.name} market size TAM"
   - "${state.company_profile?.industries?.join(' ') || state.deal_input.name} industry growth rate trends"
   - "${state.deal_input.name} ${state.company_profile?.customer_focus || 'B2B'} customer segments demand"
2. web_search (Tavily) — Search for:
   - "${state.deal_input.name} market analysis ${new Date().getFullYear()}"
   - "${state.company_profile?.sub_industries?.[0] || state.deal_input.name} TAM SAM SOM"
3. If you find competitor names, use specterSearchName to look them up and compare metrics.

Assess: Is this a $1B+ market? Growing >20% YoY? What drives demand? Which customer segments are underserved?`,

      competition: `FOCUS: Direct and indirect competitors, competitive positioning, differentiation, market share, switching costs, barriers to entry, moats.

YOU MUST USE THESE TOOLS (do NOT skip any):
1. specterSimilarCompanies — Call with company_id="${specterId}" to get AI-matched competitors. THIS IS MANDATORY.
2. For each top 3-5 competitor found, use specterEnrich (with their domain) to get detailed profiles.
3. calaSearch — Run AT LEAST 3 separate queries:
   - "${state.deal_input.name} competitors landscape"
   - "${state.deal_input.name} vs [competitor names found above]"
   - "${state.company_profile?.industries?.[0] || state.deal_input.name} market share competitive analysis"
4. web_search (Tavily) — Search for:
   - "${state.deal_input.name} competitors ${new Date().getFullYear()}"
   - "${state.deal_input.name} competitive advantage differentiation"

Build a competitive map: Who are the top 5 competitors? How do they compare on funding, team size, traction? What is ${state.deal_input.name}'s moat?`,

      traction: `FOCUS: Revenue/growth metrics, user adoption, web traffic trends, social growth, founding team quality, retention signals, product-market fit indicators, milestones.

YOU MUST USE THESE TOOLS (do NOT skip any):
1. specterCompanyPeople — Call with company_id="${specterId}" to get the full team. Assess leadership depth, founder backgrounds, key hires. THIS IS MANDATORY.
2. calaSearch — Run AT LEAST 3 separate queries:
   - "${state.deal_input.name} revenue growth traction metrics"
   - "${founderNames} founder background experience"
   - "${state.deal_input.name} funding round investors"
3. web_search (Tavily) — Search for:
   - "${state.deal_input.name} ${state.deal_input.domain} product reviews users"
   - "${founderNames} ${state.deal_input.name} founder CEO"

Assess: What are actual growth numbers? Are founders strong domain experts? Is the team complete (CTO, VP Sales, etc.)? What traction signals exist (traffic, social, revenue)?`,

      general: `FOCUS: Overall company assessment covering market, product, team, and business model.

USE ALL AVAILABLE TOOLS: calaSearch (multiple queries), specterSimilarCompanies, specterCompanyPeople, specterEnrich, specterSearchName, web_search (Tavily).`
    };

    let query = `You are analyst "${analystId}" specializing in ${specialization} analysis for VC deal evaluation.

=== COMPANY BRIEF ===
${brief}

=== FUND CONTEXT ===
${typeof state.deal_input.fund_config === 'string' ? state.deal_input.fund_config : JSON.stringify(state.deal_input.fund_config)}

=== EVIDENCE (${state.evidence.length} items — cite these by evidence_id) ===
${evidenceSummary}

=== YOUR TASK ===
${focusMap[specialization] || focusMap.general}

=== MANDATORY REQUIREMENTS ===
1. Extract specific, quantitative facts from evidence AND from your tool calls. Cite evidence_ids for every fact.
2. Identify gaps — what critical information is missing for a ${specialization} assessment?
3. BE AGGRESSIVE with tool calls — launch multiple searches. The more data you gather, the better the analysis.
4. Be SPECIFIC to ${state.deal_input.name} — never produce generic/boilerplate analysis.
5. Reference founders (${founderNames}) by name, cite actual metrics, name specific competitors.
6. You have access to: calaSearch, specterEnrich, specterSimilarCompanies, specterCompanyPeople, specterSearchName, and web_search (Tavily). USE THEM ALL as relevant to your specialization.

Return your analysis as the required JSON schema.`;

    // Add cross-reference instructions if prior analyses exist
    if (priorAnalyses.length > 0) {
      query += `\n\n=== PRIOR ANALYST FINDINGS (challenge, build on, or corroborate) ===`;
      for (const pa of priorAnalyses) {
        query += `\n--- ${pa.analyst_id} (${pa.specialization}) ---`;
        if (pa.facts.length) {
          query += `\nFacts: ${pa.facts.map(f => f.text).join(' | ')}`;
        }
        if (pa.unknowns.length) {
          query += `\nUnknowns: ${pa.unknowns.map(u => u.question).join(' | ')}`;
        }
      }
      query += `\n\nIMPORTANT: Do NOT repeat facts already covered above. Instead:
- Challenge or refine prior findings from your ${specialization} perspective
- Fill gaps identified as "unknowns" by prior analysts if you can
- Add NEW facts specific to ${specialization} that prior analysts missed`;
    }

    return query;
  }

  /**
   * Build a rich query for the associate agent.
   */
  private static buildAssociateQuery(
    state: DealState,
    analystOutputs: AnalystOutput[]
  ): string {
    const brief = this.buildCompanyBrief(state);
    const evidenceSummary = this.buildEvidenceSummary(state.evidence);

    const analystSummaries = analystOutputs.map((a, i) => {
      const config = state.deal_input.persona_config?.analysts?.[i];
      const spec = config?.specialization || 'general';
      return `--- Analyst ${i + 1} (${spec}) ---
Facts (${a.facts.length}): ${a.facts.map(f => `• ${f.text} [${f.evidence_ids.join(',')}]`).join('\n')}
Unknowns (${a.unknowns.length}): ${a.unknowns.map(u => `• ${u.question}`).join('\n')}
Contradictions: ${a.contradictions.length ? a.contradictions.map(c => `• ${c.text}`).join('\n') : 'None'}`;
    }).join('\n\n');

    const specterId = state.company_profile?.specter_id || '';
    const founderNames = state.company_profile?.founders?.join(', ') || 'unknown';

    return `You are the deal associate synthesizing analyst findings into investment hypotheses for VC deal evaluation.

=== COMPANY BRIEF ===
${brief}

=== FUND CONTEXT ===
${typeof state.deal_input.fund_config === 'string' ? state.deal_input.fund_config : JSON.stringify(state.deal_input.fund_config)}

=== EVIDENCE (${state.evidence.length} items) ===
${evidenceSummary}

=== ANALYST FINDINGS ===
${analystSummaries}

=== YOUR TASK ===
1. Synthesize the analyst findings into 3-6 investment hypotheses.
2. Identify the top unknowns that would change the investment decision.
3. Each hypothesis must reference specific evidence_ids and analyst facts.
4. Be SPECIFIC to ${state.deal_input.name} — reference founders (${founderNames}), actual metrics, and concrete risks.
5. Where analysts disagree or have gaps, flag these as key unknowns.

=== MANDATORY TOOL USAGE ===
You MUST use tools to fill gaps the analysts left open. Do NOT just summarize — go deeper.

1. specterSimilarCompanies — Call with company_id="${specterId}" to map the competitive landscape. Cross-reference with analyst competition findings.
2. specterCompanyPeople — Call with company_id="${specterId}" to verify team composition. Are there key hire gaps?
3. calaSearch — Run AT LEAST 3 queries to resolve analyst unknowns:
   - "${state.deal_input.name} funding valuation cap table"
   - "${state.deal_input.name} ${founderNames} track record exits"
   - "${state.deal_input.name} unit economics revenue model"
4. web_search (Tavily) — Search for recent news:
   - "${state.deal_input.name} funding round ${new Date().getFullYear()}"
   - "${state.deal_input.name} product launch news"

For each hypothesis, quantify the bull and bear case. Reference specific dollar amounts, growth rates, team members by name, and competitor comparisons.

Return your synthesis as the required JSON schema.`;
  }

  /**
   * Build a rich query for the partner agent.
   */
  private static buildPartnerQuery(
    state: DealState,
    associateOutput: AssociateOutput | { hypotheses: any[]; top_unknowns: any[]; requests_to_analysts: any[] }
  ): string {
    const brief = this.buildCompanyBrief(state);

    const hypothesesText = associateOutput.hypotheses.map((h, i) =>
      `${i + 1}. ${h.text} [evidence: ${h.support_evidence_ids?.join(', ') || 'none'}] Risks: ${h.risks?.join('; ') || 'none'}`
    ).join('\n');

    const unknownsText = associateOutput.top_unknowns.map((u, i) =>
      `${i + 1}. ${u.question} — ${u.why_it_matters}`
    ).join('\n');

    const specterId = state.company_profile?.specter_id || '';
    const founderNames = state.company_profile?.founders?.join(', ') || 'unknown founders';

    return `You are the deal partner making the final investment decision on ${state.deal_input.name}.

=== COMPANY BRIEF ===
${brief}

=== FUND CONTEXT ===
${typeof state.deal_input.fund_config === 'string' ? state.deal_input.fund_config : JSON.stringify(state.deal_input.fund_config)}

=== INVESTMENT HYPOTHESES (from associate) ===
${hypothesesText || '(No hypotheses produced)'}

=== TOP UNKNOWNS ===
${unknownsText || '(None identified)'}

=== YOUR TASK ===
Score the deal on 5 dimensions (0-100 each with SPECIFIC reasons backed by data):
- Market: TAM size, growth rate, timing for ${state.deal_input.name}
- Moat: Defensibility, network effects, switching costs, IP
- Why Now: Market timing, technology inflection, regulatory tailwinds
- Execution: Team (${founderNames}), ${state.company_profile?.employee_count || '?'} employees, operational track record
- Deal Fit: Alignment with fund thesis, check size, stage preference

Then produce a decision: STRONG_YES / PROCEED_IF / PASS, with 3 gating questions and an evidence checklist.

=== MANDATORY TOOL USAGE ===
Before scoring, you MUST validate the associate's hypotheses with fresh data:

1. specterCompanyPeople — Call with company_id="${specterId}". Verify leadership depth: Does ${state.deal_input.name} have a complete C-suite? Any red flags in team composition? Score Execution accordingly.
2. specterSimilarCompanies — Call with company_id="${specterId}". How does ${state.deal_input.name} stack up against comparable companies on funding, team size, growth stage? This feeds Market and Moat scores.
3. calaSearch — Run AT LEAST 2 queries to stress-test the bull case:
   - "${state.deal_input.name} risks challenges criticism"
   - "${state.deal_input.name} regulatory compliance barriers"
4. web_search (Tavily) — Final check:
   - "${state.deal_input.name} latest news ${new Date().getFullYear()}"
   - "${founderNames} previous startups exits"

Every score must cite concrete data: "$XM ARR growing Y% QoQ", "Z competitors raised $W total", "CEO ${founderNames} previously exited company ABC for $Xm". No generic VC boilerplate.

Return as the required JSON schema.`;
  }

  // ── Live narration ─────────────────────────────────────────────────
  /**
   * Emit a LIVE_UPDATE event with a mini status narration.
   * If NARRATOR_DIFY_KEY is set, uses Dify Completion API for a richer message.
   * Otherwise, falls back to the provided template text (always emitted immediately).
   *
   * Fire-and-forget: never blocks the simulation.
   */
  private static emitLiveUpdate(
    dealId: string,
    phase: string,
    templateText: string,
    difyPrompt?: string
  ) {
    // Emit template immediately so SSE clients get instant feedback
    this.emitEvent(dealId, 'LIVE_UPDATE', {
      phase,
      text: templateText,
      source: 'template'
    });

    // Optionally enrich with Dify completion (non-blocking)
    if (difyPrompt && process.env.NARRATOR_DIFY_KEY) {
      DifyClient.runCompletion(difyPrompt).then(answer => {
        if (answer) {
          this.emitEvent(dealId, 'LIVE_UPDATE', {
            phase,
            text: answer,
            source: 'narrator'
          });
        }
      }).catch(() => { /* swallow — narration is best-effort */ });
    }
  }

  static async runSimulation(dealId: string) {
    let state = PersistenceManager.getState(dealId);
    if (!state) throw new Error(`Deal ${dealId} not found`);

    const analystConfigs = state.deal_input.persona_config?.analysts || [
      { specialization: 'market' },
      { specialization: 'competition' },
      { specialization: 'traction' }
    ];
    const analystIds = analystConfigs.map((_: any, i: number) => `analyst_${i + 1}`);

    try {
      // Step 1: Orchestrator start
      this.emitEvent(dealId, 'NODE_STARTED', { node_id: 'orchestrator', role: 'system' });
      this.emitLiveUpdate(dealId, 'init', `Starting deal analysis for ${state.deal_input.name}…`);

      // Step 2: Evidence seed — Cala (search) + Specter (company enrichment) in parallel
      const dealConfig = state.deal_input.persona_config?.deal_config || {};
      const query = [
        state.deal_input.name,
        state.deal_input.domain,
        dealConfig.stage,
        dealConfig.geo,
        dealConfig.sector,
        typeof state.deal_input.fund_config === 'string' ? state.deal_input.fund_config : JSON.stringify(state.deal_input.fund_config)
      ].filter(Boolean).join(' ');

      // Run both in parallel — neither blocks the other on failure
      const [calaResults, specterResult] = await Promise.all([
        CalaClient.search(query),
        state.deal_input.domain
          ? SpecterClient.enrichByDomain(state.deal_input.domain)
          : Promise.resolve({ profile: null, evidence: [] })
      ]);

      // Merge evidence: Specter structured data + Cala search results
      const allEvidence = [
        ...specterResult.evidence,    // structured company data first
        ...calaResults.slice(0, 15)   // then search results
      ];

      if (allEvidence.length > 0) {
        this.addEvidence(dealId, allEvidence);
      } else {
        const fallback = [
          { evidence_id: 'e1', title: 'Basic info', snippet: `No specific results found for "${state.deal_input.name}". Continuing with general knowledge.`, source: 'system', retrieved_at: new Date().toISOString() }
        ];
        this.addEvidence(dealId, fallback);
      }

      // Store company profile if Specter returned one
      if (specterResult.profile) {
        this.emitEvent(dealId, 'COMPANY_PROFILE_ADDED', { profile: specterResult.profile });
        this.emitLiveUpdate(
          dealId, 'evidence_seed',
          `Gathered ${allEvidence.length} evidence items + company profile for ${state.deal_input.name}. Briefing analysts…`,
          `In 1-2 sentences, describe what an investment team just learned about "${state.deal_input.name}" (${state.deal_input.domain}) from initial research: ${allEvidence.length} data points found, company based in ${dealConfig.geo || 'unknown'}, stage: ${dealConfig.stage || 'unknown'}.`
        );
      }

      // Re-read state after evidence seed so downstream nodes get fresh evidence
      state = PersistenceManager.getState(dealId)!;

      // Step 3: Analysts (sequential — each sees prior outputs to avoid duplication)
      const analystOutputs: AnalystOutput[] = [];
      const priorAnalyses: { analyst_id: string; specialization: string; facts: any[]; unknowns: any[] }[] = [];
      for (let idx = 0; idx < analystIds.length; idx++) {
        const analystId = analystIds[idx];
        const specialization = analystConfigs[idx]?.specialization || 'general';
        this.emitEvent(dealId, 'NODE_STARTED', { node_id: analystId, role: 'analyst', specialization });
        this.emitLiveUpdate(
          dealId, `analyst_${idx + 1}`,
          `Analyst ${idx + 1}/${analystIds.length} (${specialization}) is researching…`,
          `In 1 sentence, describe what a "${specialization}" analyst would be investigating about "${state.deal_input.name}" for a VC deal evaluation.`
        );

        // Produce + validate analyst output — rich query ensures agents have full context
        const analystQuery = this.buildAnalystQuery(state!, specialization, analystId, priorAnalyses);
        const analystResult = await validateWithRetry(
          AnalystOutputSchema,
          'AnalystOutput',
          async (retryPrompt?: string) => {
            return DifyClient.runAgent('analyst', {
              deal_input: this.toInputStr(state!.deal_input),
              fund_config: this.toInputStr(state!.deal_input.fund_config),
              specialization,
              analyst_id: analystId,
              company_profile: this.toInputStr(state!.company_profile),
              evidence: this.toInputStr(state!.evidence),
              prior_analyses: this.toInputStr(priorAnalyses),
            }, retryPrompt || analystQuery);
          }
        );

        if (analystResult.ok) {
          analystOutputs.push(analystResult.data);
          // Accumulate prior analyses so next analyst avoids duplication
          priorAnalyses.push({
            analyst_id: analystId,
            specialization,
            facts: analystResult.data.facts,
            unknowns: analystResult.data.unknowns
          });
          // Save validated output as node memory with real evidence refs
          const analystEvidenceIds = analystResult.data.facts
            .flatMap(f => f.evidence_ids)
            .concat(analystResult.data.contradictions.flatMap(c => c.evidence_ids));
          PersistenceManager.saveNodeMemory(dealId, analystId, {
            ...analystResult.data,
            hypotheses: [],
            evidence_ids: [...new Set(analystEvidenceIds)]
          });
        } else {
          // Validation failed twice — emit ERROR, continue degraded
          this.emitEvent(dealId, 'ERROR', {
            where: `${analystId}_validation`,
            message: `Analyst ${analystId} output failed validation after retry: ${analystResult.errors}`
          });
          PersistenceManager.saveNodeMemory(dealId, analystId, {
            facts: [], contradictions: [], unknowns: [], hypotheses: [], evidence_ids: []
          });
        }

        this.emitEvent(dealId, 'MSG_SENT', { from: analystId, to: 'associate', summary: `Analysis complete for ${specialization}` });
        this.emitEvent(dealId, 'NODE_DONE', { node_id: analystId, output_summary: `${specialization} analysis done` });

        const aOut = analystOutputs[idx];
        if (aOut) {
          this.emitLiveUpdate(
            dealId, `analyst_${idx + 1}_done`,
            `✓ Analyst ${idx + 1} (${specialization}): ${aOut.facts.length} facts, ${aOut.unknowns.length} unknowns found.`
          );
        }
      }

      // Step 4: Associate
      this.emitEvent(dealId, 'NODE_STARTED', { node_id: 'associate', role: 'associate' });
      const totalFacts = analystOutputs.reduce((sum, a) => sum + a.facts.length, 0);
      this.emitLiveUpdate(
        dealId, 'associate',
        `All analysts complete (${totalFacts} total facts). Associate is synthesizing hypotheses…`,
        `In 1-2 sentences, describe how a VC associate would synthesize ${totalFacts} facts from ${analystIds.length} analysts into investment hypotheses for "${state.deal_input.name}".`
      );

      // Re-read state to get latest evidence (analysts may have added more)
      state = PersistenceManager.getState(dealId)!;

      const associateQuery = this.buildAssociateQuery(state!, analystOutputs);
      const associateResult = await validateWithRetry(
        AssociateOutputSchema,
        'AssociateOutput',
        async (retryPrompt?: string) => {
          return DifyClient.runAgent('associate', {
            deal_input: this.toInputStr(state!.deal_input),
            fund_config: this.toInputStr(state!.deal_input.fund_config),
            analyst_outputs: this.toInputStr(analystOutputs),
            company_profile: this.toInputStr(state!.company_profile),
            evidence: this.toInputStr(state!.evidence),
          }, retryPrompt || associateQuery);
        }
      );

      if (associateResult.ok) {
        const assocEvidenceIds = associateResult.data.hypotheses.flatMap(h => h.support_evidence_ids);
        PersistenceManager.saveNodeMemory(dealId, 'associate', {
          facts: [], contradictions: [], unknowns: [],
          hypotheses: associateResult.data.hypotheses,
          evidence_ids: [...new Set(assocEvidenceIds)]
        });
        // Patch hypotheses into state
        this.emitEvent(dealId, 'STATE_PATCH', { hypotheses: associateResult.data.hypotheses, patch_summary: 'Associate hypotheses added' });
      } else {
        this.emitEvent(dealId, 'ERROR', {
          where: 'associate_validation',
          message: `Associate output failed validation after retry: ${associateResult.errors}`
        });
        PersistenceManager.saveNodeMemory(dealId, 'associate', {
          facts: [], contradictions: [], unknowns: [], hypotheses: [], evidence_ids: []
        });
      }

      // Save edge memories: each analyst -> associate (use real refs from outputs)
      for (let idx = 0; idx < analystIds.length; idx++) {
        const aid = analystIds[idx];
        const output = analystOutputs[idx];
        const refs = output
          ? [...new Set(output.facts.flatMap(f => f.evidence_ids).concat(output.contradictions.flatMap(c => c.evidence_ids)))]
          : [];
        PersistenceManager.saveEdgeMemory(dealId, aid, 'associate', {
          messages: [{ ts: new Date().toISOString(), from: aid, to: 'associate', type: 'analysis', payload: { text: `Analysis from ${analystConfigs[idx]?.specialization || 'general'}`, refs } }],
          shared_artifacts: { evidence_refs: refs, hypotheses_refs: [] }
        });
      }

      this.emitEvent(dealId, 'MSG_SENT', { from: 'associate', to: 'partner', summary: 'Synthesis complete' });
      this.emitEvent(dealId, 'NODE_DONE', { node_id: 'associate', output_summary: 'Synthesis complete' });

      if (associateResult.ok) {
        this.emitLiveUpdate(
          dealId, 'associate_done',
          `✓ Associate produced ${associateResult.data.hypotheses.length} hypotheses, ${associateResult.data.top_unknowns.length} unknowns. Escalating to Partner…`
        );
      }

      // Step 6: Partner
      this.emitEvent(dealId, 'NODE_STARTED', { node_id: 'partner', role: 'partner' });
      this.emitLiveUpdate(
        dealId, 'partner',
        `Partner is scoring rubric and forming deal decision…`,
        `In 1 sentence, describe a VC partner reviewing investment hypotheses and scoring a deal on market, moat, timing, execution, and fund fit for "${state.deal_input.name}".`
      );

      // Re-read state to get latest (includes hypotheses patch from associate)
      state = PersistenceManager.getState(dealId)!;

      // Save associate -> partner edge memory
      const assocHyps = associateResult.ok ? associateResult.data.hypotheses.map(h => h.id) : [];
      const evidenceRefs = state.evidence.slice(0, 5).map(e => e.evidence_id);
      PersistenceManager.saveEdgeMemory(dealId, 'associate', 'partner', {
        messages: [{ ts: new Date().toISOString(), from: 'associate', to: 'partner', type: 'synthesis', payload: { text: 'Validated synthesis', refs: evidenceRefs } }],
        shared_artifacts: { evidence_refs: evidenceRefs, hypotheses_refs: assocHyps }
      });

      // Provide associate output or a meaningful fallback
      const associateForPartner = associateResult.ok
        ? associateResult.data
        : { hypotheses: [], top_unknowns: [{ question: 'Associate validation failed', why_it_matters: 'Degraded mode' }], requests_to_analysts: [] };

      const partnerQuery = this.buildPartnerQuery(state!, associateForPartner);
      const partnerResult = await validateWithRetry(
        PartnerOutputSchema,
        'PartnerOutput',
        async (retryPrompt?: string) => {
          return DifyClient.runAgent('partner', {
            deal_input: this.toInputStr(state!.deal_input),
            fund_config: this.toInputStr(state!.deal_input.fund_config),
            associate_output: this.toInputStr(associateForPartner),
            company_profile: this.toInputStr(state!.company_profile),
            evidence: this.toInputStr(state!.evidence),
          }, retryPrompt || partnerQuery);
        }
      );

      if (partnerResult.ok) {
        // Apply evidence rule: uncited claims → ASSUMPTION
        const enforced = enforceEvidenceRule(partnerResult.data);

        const partnerEvidenceIds = enforced.decision_gate.evidence_checklist
          .filter(c => c.type === 'EVIDENCE')
          .flatMap(c => c.evidence_ids);
        PersistenceManager.saveNodeMemory(dealId, 'partner', {
          facts: [], contradictions: [], unknowns: [], hypotheses: [],
          evidence_ids: [...new Set(partnerEvidenceIds)]
        });

        // Patch rubric into state
        this.emitEvent(dealId, 'STATE_PATCH', { rubric: enforced.rubric, patch_summary: 'Partner rubric scores' });

        // Update decision gate (persists full gate, sends spec SSE)
        this.updateDecisionGate(dealId, enforced.decision_gate);
      } else {
        // Validation failed twice — degraded decision gate
        this.emitEvent(dealId, 'ERROR', {
          where: 'partner_validation',
          message: `Partner output failed validation after retry: ${partnerResult.errors}`
        });
        PersistenceManager.saveNodeMemory(dealId, 'partner', {
          facts: [], contradictions: [], unknowns: [], hypotheses: [], evidence_ids: []
        });
        // Always produce a decision gate, even degraded
        this.updateDecisionGate(dealId, {
          decision: 'PROCEED_IF',
          gating_questions: ['Validation failed — manual review needed', 'Verify all data sources', 'Reassess after fix'],
          evidence_checklist: [{ q: 1, item: 'Partner validation failed — treat all as assumptions', type: 'ASSUMPTION', evidence_ids: [] }]
        });
      }

      this.emitEvent(dealId, 'MSG_SENT', { from: 'partner', to: 'orchestrator', summary: `Decision: ${partnerResult.ok ? partnerResult.data.decision_gate.decision : 'PROCEED_IF (degraded)'}` });
      this.emitEvent(dealId, 'NODE_DONE', { node_id: 'partner', output_summary: `Decision gate: ${partnerResult.ok ? partnerResult.data.decision_gate.decision : 'PROCEED_IF (degraded)'}` });

      if (partnerResult.ok) {
        const r = partnerResult.data.rubric;
        const avg = Math.round((r.market.score + r.moat.score + r.why_now.score + r.execution.score + r.deal_fit.score) / 5);
        this.emitLiveUpdate(
          dealId, 'complete',
          `✓ Deal analysis complete — Decision: ${partnerResult.data.decision_gate.decision} | Avg score: ${avg}/100 | ${partnerResult.data.decision_gate.gating_questions.length} gating questions.`,
          `In 1-2 sentences, summarize this VC deal decision for "${state.deal_input.name}": decision=${partnerResult.data.decision_gate.decision}, average rubric score ${avg}/100, with ${partnerResult.data.decision_gate.gating_questions.length} gating questions remaining.`
        );
      }

      this.emitEvent(dealId, 'NODE_DONE', { node_id: 'orchestrator', output_summary: 'Simulation complete' });

    } catch (err: any) {
      // Degraded mode: always emit a decision gate even on failure
      this.emitEvent(dealId, 'ERROR', { where: 'simulation_run', message: err.message });
      this.updateDecisionGate(dealId, {
        decision: 'PROCEED_IF',
        gating_questions: ['Error during analysis — manual review needed', 'Verify all data sources', 'Reassess after fix'],
        evidence_checklist: [{ q: 1, item: 'Simulation failed — treat all outputs as assumptions', type: 'ASSUMPTION', evidence_ids: [] }]
      });
    }
  }
}
