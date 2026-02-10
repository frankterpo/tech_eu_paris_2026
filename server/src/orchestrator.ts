import type { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { DealInput, DealState, DealEvent, EventType, FundProfile } from './types.js';
import { resolveFundProfile } from './types.js';
import { PersistenceManager } from './persistence.js';
import { reduceState } from './reducer.js';
import {
  AnalystOutputSchema, AssociateOutputSchema, PartnerOutputSchema,
  enforceEvidenceRule,
  type AnalystOutput, type AssociateOutput, type PartnerOutput
} from './validators.js';
import { validateWithRetry } from './validate-with-retry.js';
import { CalaClient } from './integrations/cala/client.js';
import { DifyClient, type DifyAgentName } from './integrations/dify/client.js';
import { SpecterClient } from './integrations/specter/client.js';
import { TavilyClient } from './integrations/tavily/client.js';
import { FalClient } from './integrations/fal/client.js';

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

    try {
      PersistenceManager.createDeal(dealId, input);
      PersistenceManager.saveState(dealId, initialState);
      // Verify the state was actually written
      const verify = PersistenceManager.getState(dealId);
      if (!verify) {
        console.error(`[Orchestrator] CRITICAL: saveState succeeded but getState returned null for ${dealId}`);
      } else {
        console.log(`[Orchestrator] Deal ${dealId} created and verified on disk`);
      }
    } catch (err: any) {
      console.error(`[Orchestrator] CRITICAL: Failed to create deal ${dealId}: ${err.message}`);
      throw err;
    }
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

  /**
   * Compact evidence map to fit within token limits.
   * Keeps at most 25 evidence items, each text truncated to 400 chars.
   * Falls back to '[]' if evidence is empty.
   */
  private static compactEvidence(evidence: any): string {
    if (!evidence) return '[]';
    const entries = Array.isArray(evidence) ? evidence : Object.values(evidence);
    if (entries.length === 0) return '[]';
    const capped = entries.slice(0, 25).map((e: any) => ({
      id: e.id || e.evidence_id,
      source: e.source,
      text: typeof e.text === 'string' ? e.text.slice(0, 400) : '',
    }));
    return JSON.stringify(capped);
  }

  // ── Investor Lens ──────────────────────────────────────────────────
  /**
   * Resolve the fund profile for a deal and build the INVESTOR LENS context
   * block that gets injected into every persona prompt.
   */
  private static getFundProfile(state: DealState): FundProfile {
    return resolveFundProfile(state.deal_input.firm_type, state.deal_input.aum);
  }

  private static buildInvestorLens(state: DealState): string {
    const fp = this.getFundProfile(state);
    const fc = state.deal_input.fund_config;
    const thesis = typeof fc === 'string' ? fc : (fc?.thesis || 'Not specified');
    return `=== INVESTOR LENS ===
Fund Type: ${fp.firm_type.replace('_', ' ').toUpperCase()} | AUM: ${fp.aum}
Risk Appetite: ${fp.risk_appetite.toUpperCase()}
Return Target: ${fp.return_target} over ${fp.return_horizon}
Typical Check Size: ${fp.check_size_guidance}
Fund Thesis: ${thesis}

EVALUATION PHILOSOPHY:
${fp.evaluation_lens}

KEY METRICS (in priority order):
${fp.key_metrics.map((m, i) => `  ${i + 1}. ${m}`).join('\n')}

DEAL BREAKERS for this fund type:
${fp.deal_breakers.map(d => `  ✗ ${d}`).join('\n')}

SCORING EMPHASIS:
${Object.entries(fp.scoring_weights).map(([k, v]) => `  ${k}: ${v > 1.2 ? '▲▲ HIGH WEIGHT' : v > 0.9 ? '● NORMAL' : '▽ LOWER WEIGHT'} (${v}x)`).join('\n')}

CRITICAL: Your entire analysis must be viewed through this investor lens. A ${fp.firm_type.replace('_', ' ')} fund with ${fp.risk_appetite} risk appetite evaluates VERY differently than other fund types. Calibrate your language, thresholds, and recommendations accordingly.`;
  }

  /** Build a deal terms block from founder-provided data. */
  private static buildDealTermsBlock(state: DealState): string {
    const t = state.deal_input.deal_terms;
    if (!t || Object.keys(t).length === 0) {
      return `=== DEAL TERMS ===\nNo founder-provided deal terms available. Flag this as a key unknown — the associate/partner CANNOT properly evaluate without: valuation, ticket size, round type, ARR, burn rate.`;
    }

    const lines: string[] = ['=== DEAL TERMS (from founder) ==='];
    if (t.round_type) lines.push(`Round: ${t.round_type}`);
    if (t.raise_amount) lines.push(`Total Raise: ${t.raise_amount}`);
    if (t.ticket_size) lines.push(`Our Ticket: ${t.ticket_size}`);
    if (t.valuation) lines.push(`Valuation: ${t.valuation}`);
    if (t.pre_money_valuation) lines.push(`Pre-Money: ${t.pre_money_valuation}`);
    if (t.post_money_valuation) lines.push(`Post-Money: ${t.post_money_valuation}`);
    if (t.equity_offered) lines.push(`Equity Offered: ${t.equity_offered}`);
    if (t.current_arr) lines.push(`Current ARR: ${t.current_arr}`);
    if (t.mrr) lines.push(`Current MRR: ${t.mrr}`);
    if (t.revenue_growth) lines.push(`Revenue Growth: ${t.revenue_growth}`);
    if (t.gross_margin) lines.push(`Gross Margin: ${t.gross_margin}`);
    if (t.burn_rate) lines.push(`Burn Rate: ${t.burn_rate}`);
    if (t.runway_months) lines.push(`Runway: ${t.runway_months} months`);
    if (t.team_size) lines.push(`Team Size: ${t.team_size}`);
    if (t.key_hires_planned) lines.push(`Key Hires Planned: ${t.key_hires_planned}`);
    if (t.use_of_proceeds) lines.push(`Use of Proceeds: ${t.use_of_proceeds}`);
    if (t.previous_rounds) lines.push(`Previous Rounds: ${t.previous_rounds}`);
    if (t.cap_table_notes) lines.push(`Cap Table: ${t.cap_table_notes}`);
    if (t.existing_investors) lines.push(`Existing Investors: ${t.existing_investors}`);
    if (t.board_seats) lines.push(`Board: ${t.board_seats}`);
    if (t.timeline) lines.push(`Timeline: ${t.timeline}`);
    if (t.founder_notes) lines.push(`Founder Notes: ${t.founder_notes}`);

    // Flag missing critical fields
    const missing: string[] = [];
    if (!t.valuation && !t.pre_money_valuation) missing.push('valuation');
    if (!t.ticket_size) missing.push('ticket size');
    if (!t.current_arr && !t.mrr) missing.push('ARR/MRR');
    if (!t.burn_rate) missing.push('burn rate');
    if (missing.length > 0) {
      lines.push(`\n⚠️ MISSING CRITICAL DATA: ${missing.join(', ')} — flag as top unknowns for founder follow-up`);
    }

    return lines.join('\n');
  }

  /**
   * Pre-chew Specter + founder data into a Deal Economics Digest.
   * Computes multiples, implied ownership, burn analysis, comp benchmarks, etc.
   * This is the "informationally chewed" block the associate + partner need.
   */
  private static buildDealEconomicsDigest(state: DealState): string {
    const p = state.company_profile;
    const t = state.deal_input.deal_terms;
    const fp = this.getFundProfile(state);
    const lines: string[] = ['=== DEAL ECONOMICS DIGEST (pre-computed) ==='];

    // ── Revenue & Valuation Analysis ──
    const revEst = p?.revenue_estimate_usd;
    const fundingTotal = p?.funding_total_usd;
    const lastRoundUsd = p?.funding_last_round_usd;
    const lastRoundType = p?.funding_last_round_type;
    const employees = p?.employee_count;
    const foundedYear = p?.founded_year;
    const age = foundedYear ? new Date().getFullYear() - foundedYear : null;

    if (revEst) {
      lines.push(`\nREVENUE ANALYSIS:`);
      lines.push(`  Specter Revenue Estimate: $${(revEst / 1e6).toFixed(1)}M/yr`);
      if (employees) {
        const revPerHead = Math.round(revEst / employees);
        lines.push(`  Revenue/Employee: $${revPerHead.toLocaleString()} ${revPerHead > 200000 ? '(STRONG)' : revPerHead > 100000 ? '(HEALTHY)' : '(LOW — early or R&D heavy)'}`);
      }
      if (fundingTotal) {
        const capitalEfficiency = (revEst / fundingTotal).toFixed(2);
        lines.push(`  Capital Efficiency: ${capitalEfficiency}x revenue/$-raised ${parseFloat(capitalEfficiency) > 0.5 ? '(EFFICIENT)' : '(CAPITAL INTENSIVE — needs justification)'}`);
      }
    }

    // ── Valuation Multiples ──
    const parseUsd = (s?: string) => {
      if (!s) return null;
      const match = s.match(/\$?([\d.]+)\s*(M|B|K)?/i);
      if (!match) return null;
      const num = parseFloat(match[1]);
      const mult = match[2]?.toUpperCase() === 'B' ? 1e9 : match[2]?.toUpperCase() === 'M' ? 1e6 : match[2]?.toUpperCase() === 'K' ? 1e3 : 1;
      return num * mult;
    };

    const valuation = parseUsd(t?.valuation) || parseUsd(t?.pre_money_valuation);
    const ticketUsd = parseUsd(t?.ticket_size);
    const raiseUsd = parseUsd(t?.raise_amount);
    const arrUsd = parseUsd(t?.current_arr) || revEst;

    if (valuation) {
      lines.push(`\nVALUATION ANALYSIS:`);
      lines.push(`  Stated Valuation: $${(valuation / 1e6).toFixed(1)}M`);
      if (arrUsd) {
        const revenueMultiple = (valuation / arrUsd).toFixed(1);
        lines.push(`  Revenue Multiple: ${revenueMultiple}x ${parseFloat(revenueMultiple) > 50 ? '(VERY HIGH — needs >100% growth to justify)' : parseFloat(revenueMultiple) > 20 ? '(HIGH — typical for fast-growth SaaS)' : parseFloat(revenueMultiple) > 10 ? '(MODERATE — reasonable for stage)' : '(LOW — potential value opportunity)'}`);
      }
      if (employees) {
        const perHead = Math.round(valuation / employees);
        lines.push(`  Valuation/Employee: $${(perHead / 1e6).toFixed(2)}M ${perHead > 2000000 ? '(PREMIUM)' : perHead > 500000 ? '(NORMAL)' : '(LEAN)'}`);
      }
      if (fundingTotal) {
        const markup = (valuation / fundingTotal).toFixed(1);
        lines.push(`  Valuation/Total Raised: ${markup}x ${parseFloat(markup) > 5 ? '(STRONG value creation)' : parseFloat(markup) > 2 ? '(ADEQUATE)' : '(CONCERNING — raised a lot relative to valuation)'}`);
      }
    }

    // ── Deal Structure ──
    if (ticketUsd || raiseUsd) {
      lines.push(`\nDEAL STRUCTURE:`);
      if (raiseUsd) lines.push(`  Total Raise: $${(raiseUsd / 1e6).toFixed(1)}M`);
      if (ticketUsd) lines.push(`  Our Ticket: $${(ticketUsd / 1e6).toFixed(1)}M`);
      if (ticketUsd && valuation) {
        const postMoney = valuation + (raiseUsd || 0);
        const impliedOwnership = ((ticketUsd / postMoney) * 100).toFixed(1);
        lines.push(`  Implied Ownership: ${impliedOwnership}% (post-money: $${(postMoney / 1e6).toFixed(1)}M)`);
        // Check against fund type expectations
        const minOwn = fp.firm_type === 'angel' ? 1 : fp.firm_type === 'pe' ? 20 : 5;
        if (parseFloat(impliedOwnership) < minOwn) {
          lines.push(`  ⚠️ OWNERSHIP WARNING: ${impliedOwnership}% may be below ${fp.firm_type.replace('_', ' ')} minimum threshold (~${minOwn}%)`);
        }
      }
      if (ticketUsd && raiseUsd) {
        const shareOfRound = ((ticketUsd / raiseUsd) * 100).toFixed(0);
        lines.push(`  Share of Round: ${shareOfRound}% ${parseInt(shareOfRound) > 50 ? '(LEAD position)' : parseInt(shareOfRound) > 20 ? '(SIGNIFICANT)' : '(CO-INVESTOR)'}`);
      }
    }

    // ── Burn & Runway ──
    const burnUsd = parseUsd(t?.burn_rate);
    const runway = t?.runway_months;
    if (burnUsd || runway) {
      lines.push(`\nBURN & RUNWAY:`);
      if (burnUsd) lines.push(`  Monthly Burn: $${(burnUsd / 1e3).toFixed(0)}K`);
      if (burnUsd && arrUsd) {
        const monthlyRev = arrUsd / 12;
        const netBurn = burnUsd - monthlyRev;
        lines.push(`  Net Burn: $${(netBurn / 1e3).toFixed(0)}K/mo (after ~$${(monthlyRev / 1e3).toFixed(0)}K revenue)`);
      }
      if (runway) lines.push(`  Stated Runway: ${runway} months`);
      if (raiseUsd && burnUsd) {
        const extendedRunway = Math.round(raiseUsd / burnUsd);
        lines.push(`  Post-raise Runway: ~${extendedRunway} months ${extendedRunway > 18 ? '(COMFORTABLE)' : extendedRunway > 12 ? '(ADEQUATE)' : '(TIGHT — will need to raise again soon)'}`);
      }
    }

    // ── Funding History ──
    if (fundingTotal || lastRoundType) {
      lines.push(`\nFUNDING HISTORY (Specter):`);
      if (fundingTotal) lines.push(`  Total Raised to Date: $${(fundingTotal / 1e6).toFixed(1)}M`);
      if (lastRoundType) lines.push(`  Last Round: ${lastRoundType}${lastRoundUsd ? ` — $${(lastRoundUsd / 1e6).toFixed(1)}M` : ''}`);
      if (p?.investors?.length) {
        lines.push(`  Investor Roster (${p.investor_count}): ${p.investors.slice(0, 10).join(', ')}${p.investors.length > 10 ? ` +${p.investors.length - 10} more` : ''}`);
      }
      if (raiseUsd && fundingTotal) {
        const dilutionStack = ((fundingTotal + raiseUsd) / 1e6).toFixed(1);
        lines.push(`  Cumulative Capital (incl. this round): $${dilutionStack}M`);
      }
    }

    // ── Company Vitals ──
    lines.push(`\nCOMPANY VITALS (Specter):`);
    if (employees) lines.push(`  Team: ${employees} people${p?.employee_range ? ` (${p.employee_range})` : ''}`);
    if (age) lines.push(`  Age: ${age} years (founded ${foundedYear})`);
    if (employees && age) {
      const hiringVelocity = Math.round(employees / age);
      lines.push(`  Hiring Velocity: ~${hiringVelocity} people/year avg`);
    }
    if (p?.growth_stage) lines.push(`  Growth Stage: ${p.growth_stage}`);
    if (p?.web_monthly_visits) lines.push(`  Web Traffic: ${p.web_monthly_visits.toLocaleString()} visits/mo${p.web_global_rank ? ` (rank #${p.web_global_rank.toLocaleString()})` : ''}`);
    if (p?.linkedin_followers) lines.push(`  LinkedIn: ${p.linkedin_followers.toLocaleString()} followers`);
    if (p?.patent_count) lines.push(`  IP: ${p.patent_count} patents, ${p?.trademark_count || 0} trademarks`);

    // ── Comp Benchmarks (from similar companies if available) ──
    const compEvidence = state.evidence.filter(e => e.source === 'specter-similar');
    if (compEvidence.length > 0) {
      lines.push(`\nCOMPETITOR BENCHMARKS (${compEvidence.length} comps from Specter):`);
      for (const e of compEvidence.slice(0, 5)) {
        lines.push(`  • ${e.snippet}`);
      }
      // Extract funding amounts from comp snippets for median calc
      const compFunding: number[] = [];
      for (const e of compEvidence) {
        const match = e.snippet.match(/Funding: \$([\d.]+)M/);
        if (match) compFunding.push(parseFloat(match[1]) * 1e6);
      }
      if (compFunding.length >= 2) {
        compFunding.sort((a, b) => a - b);
        const median = compFunding[Math.floor(compFunding.length / 2)];
        const avg = compFunding.reduce((a, b) => a + b, 0) / compFunding.length;
        lines.push(`  → Comp Median Funding: $${(median / 1e6).toFixed(1)}M | Avg: $${(avg / 1e6).toFixed(1)}M`);
        if (fundingTotal) {
          const vs = fundingTotal > median ? 'ABOVE' : fundingTotal < median * 0.5 ? 'WELL BELOW' : 'NEAR';
          lines.push(`  → ${state.deal_input.name} is ${vs} comp median ($${(fundingTotal / 1e6).toFixed(1)}M vs $${(median / 1e6).toFixed(1)}M)`);
        }
      }
    }

    // ── Recommended Deal Terms (if none provided) ──
    if (!t || Object.keys(t).length < 3) {
      lines.push(`\nRECOMMENDED TERMS TO NEGOTIATE:`);
      if (!t?.valuation && valuation === null) {
        if (revEst) {
          const low = Math.round(revEst * 8 / 1e6);
          const high = Math.round(revEst * 25 / 1e6);
          lines.push(`  Suggested Valuation Range: $${low}M–$${high}M (8-25x revenue, stage-dependent)`);
        } else if (fundingTotal) {
          const low = Math.round(fundingTotal * 2 / 1e6);
          const high = Math.round(fundingTotal * 6 / 1e6);
          lines.push(`  Suggested Valuation Range: $${low}M–$${high}M (2-6x total raised, typical for stage)`);
        }
      }
      if (!t?.ticket_size) {
        const typicalCheck = fp.check_size_guidance;
        lines.push(`  Suggested Ticket: ${typicalCheck} (based on ${fp.firm_type.replace('_', ' ')} profile)`);
      }
      lines.push(`  ⚠️ AGENT TASK: Recommend specific deal terms in your output based on comps and fundamentals`);
    }

    return lines.join('\n');
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
  private static buildEvidenceSummary(evidence: any[], max = 10): string {
    if (!evidence?.length) return '(No evidence seeded yet)';
    const capped = evidence.slice(0, max);
    const suffix = evidence.length > max ? `\n(… ${evidence.length - max} more items omitted)` : '';
    return capped.map((e, i) =>
      `[${i + 1}] (id=${e.evidence_id}) [${e.source}] ${e.title}: ${(e.snippet || '').slice(0, 150)}`
    ).join('\n') + suffix;
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
    const investorLens = this.buildInvestorLens(state);

    const specterId = state.company_profile?.specter_id || '';
    const founderNames = state.company_profile?.founders?.join(', ') || 'unknown';

    // Specialization-specific AGGRESSIVE focus instructions with mandatory tool calls
    // CRITICAL: Cala returns `content` (AI answer), `evidence` (citable items), AND `entities` (PERSON, ORG, etc.)
    // Teach analysts to CHAIN: use entity names from each Cala response to drive follow-up queries.
    const calaChainInstructions = `
=== CALA SEARCH TECHNIQUE (CRITICAL — READ THIS) ===
calaSearch returns 3 things: (1) content = AI answer, (2) evidence = citable items, (3) entities = extracted names (PERSON, ORG, GPE, PRODUCT).

YOU MUST CHAIN QUERIES using entities from previous results:
- Search 1: "${state.deal_input.name} overview funding"
  → Read the content answer. Note entities: e.g., "Arthur Mensch" (PERSON), "Lightspeed" (ORG), "Paris" (GPE)
- Search 2: Use those entity names → "${'{'}extracted_person_name{'}'} founder background experience track record"
- Search 3: Use ORG entities → "${'{'}extracted_org_name{'}'} investment portfolio AI companies"
- Search 4: Build on what you learned → "${state.deal_input.name} ${'{'}specific_topic_from_content{'}'}"

This iterative approach builds a FAR richer profile than single broad queries. Read the "content" field — it's an AI-generated synthesis. Use "entities" to find the next query.`;

    const focusMap: Record<string, string> = {
      market: `FOCUS: Market size (TAM/SAM/SOM), growth rates, demand drivers, customer segments, market timing. Be FAST — extract numbers, cite sources, move on.

=== TOOL EXECUTION (speed-optimized — call ALL in round 1) ===
Fire ALL these tools SIMULTANEOUSLY in your first round — they are independent:

1. specterSimilarCompanies — company_id="${specterId}" → see how peers are sized, funded, staged → infer market maturity
2. specterEnrich — domain="${state.deal_input.domain}" → get verified revenue estimate, employee count, traffic → baseline market traction
3. calaSearch — "${state.deal_input.name} market size TAM addressable market ${new Date().getFullYear()}"
4. calaSearch — "${state.company_profile?.industries?.[0] || state.deal_input.name} ${state.company_profile?.customer_focus || 'B2B'} growth rate demand drivers"

After reading all 4 results → synthesize immediately if you have dollar TAM + growth rate.
If specific gaps remain (e.g. missing SAM/SOM or geographic breakdown) → ONE tavilyWebSearch to fill the gap, then STOP.

Assess: Is this a $1B+ market? Growing >20% YoY? What drives demand? Which customer segments are underserved?`,

      competition: `FOCUS: Direct and indirect competitors, competitive positioning, differentiation, market share, switching costs, barriers to entry, moats.

${calaChainInstructions}

=== MANDATORY TOOL EXECUTION ORDER ===
You MUST call tools in THIS ORDER. Cala and Specter are your PRIMARY tools. Tavily is supplementary ONLY.

STEP 1 — Specter (structured competitor discovery — THIS IS YOUR PRIMARY TOOL):
   - specterSimilarCompanies — company_id="${specterId}" → get top 10 AI-matched competitors. THIS IS MANDATORY FIRST CALL.
   - For each of the top 5 competitors → specterEnrich with their domain → get funding, headcount, revenue, growth stage
   - specterSearchName — look up any competitor names from Cala that Specter didn't already surface

STEP 2 — calaSearch (run AT LEAST 4 chained queries for competitive intelligence):
   Q1: "${state.deal_input.name} competitors landscape competitive analysis"
   → Read entities → find competitor ORG names
   Q2: "{competitor_name_from_Q1} vs ${state.deal_input.name} comparison strengths weaknesses"
   Q3: "${state.company_profile?.industries?.[0] || state.deal_input.name} market share ${new Date().getFullYear()} competitive dynamics"
   Q4: "${state.deal_input.name} competitive advantage moat defensibility switching costs"
   → If entities include partnership/integration names → chain those too

STEP 3 — tavilyWebSearch (supplementary, only AFTER Cala + Specter):
   - "${state.deal_input.name} competitors ${new Date().getFullYear()}" (ONLY if gaps remain)

Build a competitive map: Who are the top 5 competitors? How do they compare on funding, team size, traction? What is ${state.deal_input.name}'s moat?`,

      traction: `FOCUS: Revenue/growth metrics, user adoption, web traffic trends, social growth, founding team quality, retention signals, product-market fit indicators, milestones.

${calaChainInstructions}

=== MANDATORY TOOL EXECUTION ORDER ===
You MUST call tools in THIS ORDER. Cala and Specter are your PRIMARY tools. Tavily is supplementary ONLY.

STEP 1 — Specter (structured team + traction data — THIS IS YOUR PRIMARY TOOL):
   - specterCompanyPeople — company_id="${specterId}" → get the FULL team roster. THIS IS MANDATORY FIRST CALL.
   - For each key founder/CxO found → specterEnrichPerson with their LinkedIn URL → get full career history, education, prior exits
   - specterEnrich — domain="${state.deal_input.domain}" → get verified web traffic, social metrics, employee growth, revenue estimate

STEP 2 — calaSearch (run AT LEAST 4 chained queries building founder + traction profiles):
   Q1: "${state.deal_input.name} revenue growth traction metrics users customers"
   → Read entities → find PERSON entities (founders, executives, investors)
   Q2: "{founder_name_from_Q1} founder background experience career track record"
   Q3: "${state.deal_input.name} product launch milestones partnerships ${new Date().getFullYear()}"
   Q4: "${founderNames} previous companies exits acquisitions"
   → If Q1-Q4 entities include new PERSON names (advisors, investors) → chain those too

STEP 3 — tavilyWebSearch (supplementary, only AFTER Cala + Specter):
   - "${state.deal_input.name} product reviews users" (ONLY if Cala/Specter left gaps)

Assess: What are actual growth numbers? Are founders strong domain experts with relevant exits? Is the team complete (CTO, VP Sales, etc.)? What traction signals exist?`,

      general: `FOCUS: Overall company assessment covering market, product, team, and business model.

${calaChainInstructions}

USE ALL AVAILABLE TOOLS: calaSearch (chain queries using entities!), specterSimilarCompanies, specterCompanyPeople, specterEnrich, specterEnrichPerson, specterSearchName, tavilyWebSearch, webExtract.`
    };

    let query = `You are analyst "${analystId}" specializing in ${specialization} analysis for deal evaluation.

=== COMPANY BRIEF ===
${brief}

${investorLens}

=== EVIDENCE (${state.evidence.length} items — cite these by evidence_id) ===
${evidenceSummary}

=== YOUR TASK ===
${focusMap[specialization] || focusMap.general}

=== MANDATORY REQUIREMENTS ===
1. Extract specific, quantitative facts from evidence AND from your tool calls. Cite evidence_ids for every fact.
2. Identify gaps — what critical information is missing for a ${specialization} assessment through THIS investor's lens?
3. Be SPECIFIC to ${state.deal_input.name} — never produce generic/boilerplate analysis.
4. Reference founders (${founderNames}) by name, cite actual metrics, name specific competitors.
5. CHAIN Cala queries: read the "content" answer AND "entities" from each calaSearch response. Use entity names to drive your next query.
6. INVESTOR CALIBRATION: Your analysis must reflect the fund type's priorities. A ${this.getFundProfile(state).firm_type.replace('_', ' ')} fund cares most about: ${this.getFundProfile(state).key_metrics.slice(0, 3).join(', ')}.

⚠️ CRITICAL: Complete your analysis in MAX 4 tool-call rounds. Prioritize Cala + Specter depth over Tavily breadth. After 4 rounds STOP and synthesize immediately — speed matters.

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

    const fp = this.getFundProfile(state);
    const investorLens = this.buildInvestorLens(state);
    const dealTermsBlock = this.buildDealTermsBlock(state);
    const economicsDigest = this.buildDealEconomicsDigest(state);

    return `You are the deal associate — the CRITICAL FILTER between raw research and the investment decision.
Your job is NOT to summarize. Your job is to BUILD THE HONEST CASE: every strength has a constraint, every weakness has a mitigant or is flagged as a deal-breaker.

The Partner will decide whether to take the risk. YOU decide what the risks actually ARE.

=== COMPANY BRIEF ===
${brief}

${investorLens}
${dealTermsBlock}

${economicsDigest}

=== EVIDENCE (${state.evidence.length} items) ===
${evidenceSummary}

=== ANALYST FINDINGS ===
${analystSummaries}

=== YOUR MANDATE ===
You are writing the DECISION BRIEF that the Partner reads before making a ${fp.firm_type.replace('_', ' ')} investment call.

STRUCTURE YOUR HYPOTHESES AS FOLLOWS:
For each hypothesis (3-6 total), you MUST include:

1. THE BULL CASE — What makes this compelling? Quantify: "$XM ARR", "Y% growth", "Z market position"
   → Then immediately: CONSTRAINT — What limits this upside? What assumption must hold? What could cap the return?

2. THE BEAR CASE — What could go wrong? Be specific and brutal.
   → Then immediately: MITIGANT — What reduces this risk? Is there a hedge, a pivot path, an insurance policy?
   → If NO mitigant exists: Flag as UNMITIGATED RISK — the Partner must accept this with eyes open.

3. THE SO-WHAT — Through a ${fp.firm_type.replace('_', ' ')} lens with ${fp.risk_appetite} risk appetite:
   - Is this risk acceptable given ${fp.return_target} return targets?
   - Does this align with the fund's evaluation philosophy?
   - Would this be a deal-breaker for THIS specific fund type?

DEAL ECONOMICS ANALYSIS (MANDATORY if deal terms provided):
- Is the valuation reasonable given ARR/growth/comps? Show the math.
- Does our ticket size vs total raise give us meaningful ownership + influence?
- Implied ownership: ticket / post-money = X%. Is that acceptable for a ${fp.firm_type.replace('_', ' ')} fund?
- Burn vs runway: at current burn, how long until next raise or profitability? Is that enough to hit milestones?
- Use of proceeds: does the allocation make strategic sense? Will it move the needle on key metrics?

DEAL-BREAKER CHECK:
Cross-reference findings against this fund's deal-breakers:
${fp.deal_breakers.map(d => `  ✗ ${d}`).join('\n')}
If ANY deal-breaker is triggered, it MUST appear as a top_unknown with "why_it_matters" explaining the severity.

TOP UNKNOWNS:
These are not generic "we need more data" items. Each unknown must be:
- Specific enough to be answerable ("What is Mistral's net retention rate?" not "Is retention good?")
- Decision-relevant ("If answer is X, we invest. If Y, we pass.")
- Calibrated to THIS fund type's risk tolerance

FOUNDER QUESTIONS (generate 3-5 questions the partner should ask the founder):
Based on evidence gaps and deal terms, what SPECIFIC questions would you ask the founder in the next meeting?
These should be pointed, uncomfortable, and reveal hidden risks or upside.

=== MANDATORY TOOL EXECUTION ORDER ===
STEP 1 — Specter: specterSimilarCompanies (${specterId}), specterCompanyPeople, specterEnrichPerson for founders
STEP 2 — calaSearch (4+ chained queries): funding/valuation, investor track records, founder history, unit economics, risks
STEP 3 — tavilyWebSearch: gap-fill only after Cala + Specter

CRITICAL: No VC boilerplate. No "this is a promising company." Every sentence must contain a specific fact, number, name, or evidence_id. The Partner is experienced — they want the unvarnished truth with YOUR assessment of what matters.

Return as the required JSON schema.`;
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

    const fp = this.getFundProfile(state);
    const investorLens = this.buildInvestorLens(state);
    const dealTermsBlock = this.buildDealTermsBlock(state);
    const economicsDigest = this.buildDealEconomicsDigest(state);

    return `You are the deal partner at a ${fp.firm_type.replace('_', ' ').toUpperCase()} fund (AUM: ${fp.aum}) making the final investment decision on ${state.deal_input.name}.

=== COMPANY BRIEF ===
${brief}

${investorLens}
${dealTermsBlock}

${economicsDigest}

=== INVESTMENT HYPOTHESES (from associate) ===
${hypothesesText || '(No hypotheses produced)'}

=== TOP UNKNOWNS ===
${unknownsText || '(None identified)'}

=== YOUR DECISION FRAMEWORK ===
You are scoring this deal through the lens of a ${fp.firm_type.replace('_', ' ')} partner.

RISK CALIBRATION:
- Your risk appetite is: ${fp.risk_appetite.toUpperCase()}
- Your return bar is: ${fp.return_target} over ${fp.return_horizon}
- An ${fp.firm_type === 'angel' || fp.firm_type === 'early_vc' ? 'early-stage investor TOLERATES high uncertainty if upside is massive' : fp.firm_type === 'pe' ? 'PE investor REQUIRES downside protection and clear operational levers' : 'investor at this stage BALANCES growth potential with risk mitigation'}

SCORING (0-100 each, with WEIGHTED IMPORTANCE for your fund type):
- Market ${fp.scoring_weights.market > 1.2 ? '▲▲' : fp.scoring_weights.market < 0.9 ? '▽' : '●'}: TAM, growth rate, timing — weight: ${fp.scoring_weights.market}x
- Moat ${fp.scoring_weights.moat > 1.2 ? '▲▲' : fp.scoring_weights.moat < 0.9 ? '▽' : '●'}: Defensibility, switching costs, IP — weight: ${fp.scoring_weights.moat}x
- Why Now ${fp.scoring_weights.why_now > 1.2 ? '▲▲' : fp.scoring_weights.why_now < 0.9 ? '▽' : '●'}: Market timing, inflection — weight: ${fp.scoring_weights.why_now}x
- Execution ${fp.scoring_weights.execution > 1.2 ? '▲▲' : fp.scoring_weights.execution < 0.9 ? '▽' : '●'}: Team (${founderNames}), ${state.company_profile?.employee_count || '?'} employees — weight: ${fp.scoring_weights.execution}x
- Deal Fit ${fp.scoring_weights.deal_fit > 1.2 ? '▲▲' : fp.scoring_weights.deal_fit < 0.9 ? '▽' : '●'}: Fund thesis alignment — weight: ${fp.scoring_weights.deal_fit}x

Dimensions marked ▲▲ are CRITICAL for your fund type — score these with extra rigor.

DECISION CRITERIA for ${fp.firm_type.replace('_', ' ').toUpperCase()}:
- STRONG_YES: Meets ALL key metrics, no unmitigated deal-breakers, clear path to ${fp.return_target}
- PROCEED_IF: Promising but has gating questions that MUST be answered. Specify what would flip your decision.
- PASS: Triggers a deal-breaker OR insufficient evidence of achieving ${fp.return_target} within ${fp.return_horizon}

GATING QUESTIONS: Must be specific, answerable, and decision-relevant for a ${fp.firm_type.replace('_', ' ')} investor.
Example good: "Can Mistral demonstrate >130% net retention in enterprise contracts within 6 months?"
Example bad: "Is the market big enough?"

=== MANDATORY TOOL EXECUTION ORDER ===
STEP 1 — Specter: specterCompanyPeople (${specterId}), specterEnrichPerson for CxOs, specterSimilarCompanies for benchmarking
STEP 2 — calaSearch (4+ chained): risks, regulatory, controversy, customer complaints
STEP 3 — tavilyWebSearch: latest news gap-fill only

Every score must cite concrete data. No generic boilerplate. You are a ${fp.firm_type.replace('_', ' ')} partner — your LP's expect ${fp.return_target}. Would you commit your fund's capital?

Return as the required JSON schema.`;
  }

  // ── Tool-call label map + query extractor ─────────────────────────
  /** Maps Dify operationIds → human-readable action labels */
  private static readonly TOOL_LABELS: Record<string, string> = {
    calaSearch: 'Cala Search', calaQuery: 'Cala Query', calaSearchEntities: 'Cala Entities',
    specterEnrich: 'Specter Enrich', specterSimilarCompanies: 'Specter Similar',
    specterCompanyPeople: 'Specter People', specterSearchName: 'Specter Lookup',
    specterEnrichPerson: 'Specter Person',
    tavilyWebSearch: 'Web Search', tavilyExtract: 'Page Extract',
    tavilyCrawl: 'Site Crawl', tavilyResearch: 'Deep Research',
    tavilyResearchStatus: 'Research Poll', webExtract: 'Page Scrape',
    dify_agent_fc: 'FC Sub-Agent', dify_agent_react: 'ReAct Sub-Agent',
  };

  /**
   * Build a rich tool-call description from Dify agent_thought event data.
   * Instead of "⚡ Tavily Research ×6" → "⚡ Web Search: 'AI market size', 'TAM SAM SOM', +1 more"
   */
  private static formatToolEvent(
    toolNames: string[],
    toolInput?: string,
  ): string {
    // 1. Group tools by label
    const groups: Record<string, number> = {};
    for (const t of toolNames) {
      const label = this.TOOL_LABELS[t] || t;
      groups[label] = (groups[label] || 0) + 1;
    }

    // 2. Try to extract search queries from tool_input JSON
    const queries: string[] = [];
    if (toolInput) {
      // Extract "query" values from possibly concatenated JSON objects
      const qMatches = toolInput.match(/"query"\s*:\s*"([^"]{5,80})"/g);
      if (qMatches) {
        for (const m of qMatches) {
          const val = m.match(/"query"\s*:\s*"(.+)"/)?.[1];
          if (val) queries.push(val.length > 50 ? val.slice(0, 48) + '…' : val);
        }
      }
      // Also extract "url"/"urls" for extract/crawl tools
      const urlMatches = toolInput.match(/"url(?:s)?"\s*:\s*"(https?:\/\/[^"]{10,60})"/g);
      if (urlMatches && queries.length === 0) {
        for (const m of urlMatches) {
          const val = m.match(/"url(?:s)?"\s*:\s*"(.+)"/)?.[1];
          if (val) {
            try { queries.push(new URL(val).hostname); } catch { queries.push(val.slice(0, 40)); }
          }
        }
      }
      // Extract "company_id" or "domain" for Specter calls
      if (queries.length === 0) {
        const domainMatch = toolInput.match(/"domain"\s*:\s*"([^"]+)"/);
        if (domainMatch) queries.push(domainMatch[1]);
        const nameMatch = toolInput.match(/"name"\s*:\s*"([^"]+)"/);
        if (nameMatch) queries.push(nameMatch[1]);
      }
    }

    // 3. Build the description
    const parts: string[] = [];
    for (const [label, count] of Object.entries(groups)) {
      // Find queries that match this tool type
      const relevant = queries.slice(0, 3); // show up to 3 queries
      if (relevant.length > 0 && (label.includes('Search') || label.includes('Research') || label.includes('Extract') || label.includes('Crawl') || label.includes('Query'))) {
        const shown = relevant.slice(0, 2).map(q => `"${q}"`).join(', ');
        const extra = count > 2 ? ` +${count - 2} more` : '';
        parts.push(`${label}: ${shown}${extra}`);
        queries.splice(0, relevant.length); // consume used queries
      } else {
        parts.push(count > 1 ? `${label} ×${count}` : label);
      }
    }

    return `⚡ ${parts.join(' · ')}`;
  }

  // ── Investment Memo Builder ────────────────────────────────────────
  /**
   * Build structured memo slides from analyst outputs + associate hypotheses.
   * Returns an array of slide objects for the dashboard to render.
   */
  private static buildMemoSlides(
    state: DealState,
    analystOutputs: AnalystOutput[],
    associateData: AssociateOutput | null
  ): Array<{ type: string; title: string; subtitle?: string; bullets: string[]; imageUrl?: string; metrics?: Array<{ label: string; value: string }> }> {
    const cp = state.company_profile;
    const name = state.deal_input.name;
    const domain = cp?.domain || state.deal_input.domain || '';

    const fmt = (n: number | null | undefined) => {
      if (!n) return '—';
      if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
      if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
      return `$${n}`;
    };

    const slides: Array<{ type: string; title: string; subtitle?: string; bullets: string[]; imageUrl?: string; metrics?: Array<{ label: string; value: string }> }> = [];

    // Slide 1: Cover
    slides.push({
      type: 'cover',
      title: name,
      subtitle: `Investment Memo — ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
      bullets: [
        cp?.description?.slice(0, 120) || `Deep-dive analysis of ${name}`,
        domain ? `${domain}` : '',
        cp?.growth_stage ? `Stage: ${cp.growth_stage}` : '',
      ].filter(Boolean),
    });

    // Slide 2: Company Overview
    slides.push({
      type: 'overview',
      title: 'Company Overview',
      subtitle: cp?.tagline || cp?.description?.slice(0, 80) || name,
      bullets: [
        cp?.description?.slice(0, 200) || `${name} operates in ${cp?.industries?.join(', ') || 'technology'}`,
        cp?.founded_year ? `Founded ${cp.founded_year} — ${cp.hq_city ? `HQ: ${cp.hq_city}, ${cp.hq_country}` : ''}` : '',
        cp?.founders?.length ? `Founders: ${cp.founders.slice(0, 3).join(', ')}` : '',
        cp?.operating_status ? `Status: ${cp.operating_status} | ${cp.customer_focus || ''} focus` : '',
      ].filter(Boolean),
      metrics: [
        { label: 'Employees', value: cp?.employee_range || String(cp?.employee_count || '—') },
        { label: 'Total Funding', value: fmt(cp?.funding_total_usd) },
        { label: 'Last Round', value: `${cp?.funding_last_round_type || '—'} ${cp?.funding_last_round_usd ? fmt(cp.funding_last_round_usd) : ''}`.trim() },
        { label: 'Revenue Est.', value: fmt(cp?.revenue_estimate_usd) },
      ],
    });

    // Slide 3: Market Analysis (from market analyst)
    const marketAnalyst = analystOutputs.find((_, i) =>
      (state.deal_input.persona_config?.analysts?.[i]?.specialization || '') === 'market'
    ) || analystOutputs[0];
    if (marketAnalyst) {
      slides.push({
        type: 'market',
        title: 'Market Opportunity',
        subtitle: `${marketAnalyst.facts.length} findings from market analysis`,
        bullets: marketAnalyst.facts.slice(0, 5).map(f => f.text.slice(0, 150)),
        metrics: marketAnalyst.unknowns.length > 0
          ? [{ label: 'Open Questions', value: String(marketAnalyst.unknowns.length) }]
          : undefined,
      });
    }

    // Slide 4: Competitive Landscape (from competition analyst + Specter competitors)
    const compAnalyst = analystOutputs.find((_, i) =>
      (state.deal_input.persona_config?.analysts?.[i]?.specialization || '') === 'competition'
    ) || analystOutputs[1];
    {
      // Gather Specter competitor evidence from state
      const specterCompEvidence = (state.evidence || []).filter(
        (e: any) => e.source === 'specter-competitive' && !e.evidence_id?.includes('landscape')
      );
      const specterLandscape = (state.evidence || []).find(
        (e: any) => e.evidence_id === 'specter-competitive-landscape'
      );

      const analystBullets = (compAnalyst?.facts || []).slice(0, 5).map((f: any) => f.text.slice(0, 150));
      const specterBullets = specterCompEvidence.slice(0, 5).map((e: any) => e.snippet?.slice(0, 150) || e.title);
      // Merge: analyst facts first, fill remaining with Specter competitor profiles
      const mergedBullets = analystBullets.length >= 3
        ? analystBullets
        : [...analystBullets, ...specterBullets].slice(0, 5);

      const totalInsights = (compAnalyst?.facts?.length || 0) + specterCompEvidence.length;

      slides.push({
        type: 'competition',
        title: 'Competitive Landscape',
        subtitle: totalInsights > 0
          ? `${totalInsights} competitive insights identified${specterCompEvidence.length > 0 ? ` (${specterCompEvidence.length} via Specter)` : ''}`
          : 'No competitive data yet — run analysis to populate',
        bullets: mergedBullets,
        metrics: specterLandscape ? [{
          label: 'Competitors Profiled',
          value: String(specterCompEvidence.length),
        }] : undefined,
      });
    }

    // Slide 5: Traction & Growth (from traction analyst)
    const tractAnalyst = analystOutputs.find((_, i) =>
      (state.deal_input.persona_config?.analysts?.[i]?.specialization || '') === 'traction'
    ) || analystOutputs[2];
    if (tractAnalyst) {
      slides.push({
        type: 'traction',
        title: 'Traction & Execution',
        subtitle: `${tractAnalyst.facts.length} traction data points`,
        bullets: tractAnalyst.facts.slice(0, 5).map(f => f.text.slice(0, 150)),
        metrics: [
          { label: 'Web Traffic', value: cp?.web_monthly_visits ? `${(cp.web_monthly_visits / 1000).toFixed(0)}K/mo` : '—' },
          { label: 'LinkedIn', value: cp?.linkedin_followers ? `${(cp.linkedin_followers / 1000).toFixed(1)}K` : '—' },
          { label: 'Patents', value: String(cp?.patent_count || 0) },
          { label: 'Awards', value: String(cp?.award_count || 0) },
        ],
      });
    }

    // Slide 6: Investment Thesis (from associate hypotheses)
    if (associateData && associateData.hypotheses.length > 0) {
      slides.push({
        type: 'thesis',
        title: 'Investment Thesis',
        subtitle: `${associateData.hypotheses.length} hypotheses synthesized`,
        bullets: associateData.hypotheses.slice(0, 4).map(h =>
          `${h.text.slice(0, 120)}${h.risks?.length ? ` — Risk: ${h.risks[0]?.slice(0, 60)}` : ''}`
        ),
      });
    }

    // Slide 7: Key Risks
    const allRisks = [
      ...(associateData?.hypotheses?.flatMap(h => h.risks || []) || []),
      ...(associateData?.top_unknowns?.map(u => `${u.question} — ${u.why_it_matters}`) || []),
    ];
    if (allRisks.length > 0) {
      slides.push({
        type: 'risks',
        title: 'Key Risks & Open Questions',
        subtitle: `${allRisks.length} risk factors identified`,
        bullets: allRisks.slice(0, 6).map(r => r.slice(0, 150)),
      });
    }

    // Slide 8: Recommendation (placeholder — filled by Partner later)
    slides.push({
      type: 'recommendation',
      title: 'Recommendation',
      subtitle: 'Awaiting Partner scoring…',
      bullets: [
        `Total evidence collected: ${state.evidence?.length || 0} items`,
        `Analysts deployed: ${analystOutputs.length}`,
        `Hypotheses: ${associateData?.hypotheses?.length || 0}`,
        'Rubric scoring and decision gate pending Partner review.',
      ],
    });

    return slides;
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

    // ── Reset previous run artifacts so dashboard shows fresh state ──
    PersistenceManager.resetRun(dealId, state);
    // Re-read after reset
    state = PersistenceManager.getState(dealId)!;

    // ── Start a new run (UUID-keyed, linked to deal) ──────────────
    this.activeDeals.add(dealId);
    const runStartTime = Date.now();
    const runId = PersistenceManager.startRun(dealId, {
      config: { fund_config: state.deal_input.fund_config, persona_config: state.deal_input.persona_config },
    });

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
      ].filter(Boolean).join(' ');

      // ── CRITICAL PATH: Cala search + Specter enrich (evidence seed) ──
      // These two run in parallel. The batch intel queries run AFTER as a
      // background task to avoid Cala rate limits.
      const calaActionId = PersistenceManager.startToolAction({ dealId, toolName: 'calaSearch', provider: 'cala', operation: 'search', input: { query }, calledBy: 'orchestrator' });
      const specterActionId = state.deal_input.domain ? PersistenceManager.startToolAction({ dealId, toolName: 'specterEnrich', provider: 'specter', operation: 'enrich', input: { domain: state.deal_input.domain }, calledBy: 'orchestrator' }) : null;

      const calaStart = Date.now();
      const specterStart = Date.now();
      const [calaResults, specterResult] = await Promise.all([
        CalaClient.search(query).then(r => {
          PersistenceManager.completeToolAction(calaActionId, { status: 'success', latencyMs: Date.now() - calaStart, resultCount: r.length });
          PersistenceManager.logQuery({ dealId, toolActionId: calaActionId, queryText: query, queryType: 'search', provider: 'cala', resultCount: r.length });
          if (r.length > 0) this.emitLiveUpdate(dealId, 'source_found', `Cala: ${r.length} sources`);
          return r;
        }).catch(err => {
          PersistenceManager.completeToolAction(calaActionId, { status: 'error', errorMsg: err.message, latencyMs: Date.now() - calaStart });
          this.emitLiveUpdate(dealId, 'source_found', `Cala: timeout — continuing`);
          return [];
        }),
        state.deal_input.domain
          ? SpecterClient.enrichByDomain(state.deal_input.domain).then(r => {
              if (specterActionId) PersistenceManager.completeToolAction(specterActionId, { status: 'success', latencyMs: Date.now() - specterStart, resultCount: r.evidence.length });
              if (r.profile) PersistenceManager.cacheCompanyProfile(r.profile);
              if (r.evidence.length > 0) this.emitLiveUpdate(dealId, 'source_found', `Specter: ${r.evidence.length} data points`);
              if (r.profile?.funding_total_usd) {
                this.emitLiveUpdate(dealId, 'source_found', `Funding: $${(r.profile.funding_total_usd / 1e6).toFixed(1)}M raised`);
              }
              if (r.profile?.employee_count) {
                this.emitLiveUpdate(dealId, 'source_found', `Team: ${r.profile.employee_count} employees`);
              }
              if (r.profile?.revenue_estimate_usd) {
                this.emitLiveUpdate(dealId, 'source_found', `Revenue: ~$${(r.profile.revenue_estimate_usd / 1e6).toFixed(1)}M est.`);
              }
              return r;
            }).catch(err => {
              if (specterActionId) PersistenceManager.completeToolAction(specterActionId, { status: 'error', errorMsg: err.message, latencyMs: Date.now() - specterStart });
              this.emitLiveUpdate(dealId, 'source_found', `Specter: unavailable`);
              return { profile: null, evidence: [] };
            })
          : Promise.resolve({ profile: null, evidence: [] })
      ]);

      if (calaResults.length + specterResult.evidence.length > 0) {
        this.emitLiveUpdate(dealId, 'init_stage', `Evidence seed: ${calaResults.length + specterResult.evidence.length} sources collected`);
      }

      // ── BACKGROUND: Batch intel queries (8 categories, throttled) ──
      // Runs AFTER evidence seed to avoid Cala rate limits.
      // Does NOT block the analyst swarm — results arrive asynchronously.
      const companyNameForIntel = state.deal_input.name;
      const founderNamesForIntel = state.company_profile?.founders?.join(', ') || 'founders';

      const founderDeepDivePromise = (async () => {
        try {
          this.emitLiveUpdate(dealId, 'founder_deep_dive', `Deep dive: ${companyNameForIntel}`);
          const results = await CalaClient.founderDeepDiveQueries(companyNameForIntel, founderNamesForIntel);
          
          for (const r of results) {
            if (r.hasData) {
              if (r.evidence.length > 0) this.emitLiveUpdate(dealId, 'source_found', `${r.label}: ${r.evidence.length} sources`);
              this.addEvidence(dealId, r.evidence);
              // Also log as query for traceability
              PersistenceManager.logQuery({
                dealId, queryText: r.query, queryType: 'founder_deep_dive', provider: 'cala',
                resultCount: r.evidence.length, answerText: r.content.slice(0, 300), latencyMs: r.latencyMs,
              });
            }
          }
        } catch (err: any) {
          console.warn(`[Orchestrator] Founder deep dive failed (non-blocking): ${err.message}`);
        }
      })();

      const batchIntelPromise = (async () => {
        try {
          this.emitLiveUpdate(dealId, 'intel_queries', `Intelligence scan: ${CalaClient.INTEL_CATEGORIES.length} categories for ${companyNameForIntel}…`);
          const batchIntelActionId = PersistenceManager.startToolAction({ dealId, toolName: 'calaBatchIntel', provider: 'cala', operation: 'batch_intel', input: { company: companyNameForIntel }, calledBy: 'orchestrator' });
          const batchIntelStart = Date.now();

          const intelResults = await CalaClient.batchIntelQueries(companyNameForIntel);

          // Emit per-result source updates (animated appearance in UI)
          for (const r of intelResults) {
            if (r.hasData) {
              if (r.evidence.length > 0) this.emitLiveUpdate(dealId, 'intel_result', `${r.label}: ${r.evidence.length} sources`);
            } else {
              this.emitLiveUpdate(dealId, 'intel_result', `○ ${r.label}: no data`);
            }
          }
          PersistenceManager.completeToolAction(batchIntelActionId, {
            status: 'success', latencyMs: Date.now() - batchIntelStart,
            resultCount: intelResults.filter(r => r.hasData).length,
          });
          for (const r of intelResults) {
            PersistenceManager.logQuery({
              dealId, queryText: r.query, queryType: 'intel_batch', provider: 'cala',
              resultCount: r.evidence.length, answerText: r.content.slice(0, 500), latencyMs: r.latencyMs,
            });
          }

          if (intelResults.length > 0) {
            const withData = intelResults.filter(r => r.hasData);
            this.emitLiveUpdate(dealId, 'intel_done',
              `📊 Intel scan complete: ${withData.length}/${intelResults.length} categories have data for ${companyNameForIntel}`);
            PersistenceManager.saveTriggerSuggestions(dealId, intelResults.map(r => ({
              category: r.category, label: r.label, query: r.query,
              baseline_answer: r.content, evidence_json: JSON.stringify(r.evidence),
              evidence_count: r.evidence.length, has_data: r.hasData, latency_ms: r.latencyMs,
            })));
            const suggestions = intelResults.map(r => ({
              category: r.category, label: r.label, query: r.query,
              baseline_answer: r.content.slice(0, 300), evidence_count: r.evidence.length, has_data: r.hasData,
            }));
            this.emitEvent(dealId, 'TRIGGER_SUGGESTIONS_READY', { suggestions, count: withData.length });
          }
        } catch (err: any) {
          console.warn(`[Orchestrator] Batch intel failed (non-blocking): ${err.message}`);
        }
      })();
      // Don't await — let analysts start immediately. We'll await before the end.

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

      // ═══════════════════════════════════════════════════════════════
      // WAVE 1 — MAXIMUM PARALLELISM
      // Fire ALL of these simultaneously:
      //   • 3 Analyst agents (Dify)
      //   • Specter similar companies (competitive intel)
      //   • fal.ai cover image (aesthetic, non-blocking)
      //   • Batch intel queries (already background from above)
      // ═══════════════════════════════════════════════════════════════
      const companyName = state.deal_input.name;
      const industries = state.company_profile?.industries?.join(', ') || companyName;
      const founderNames = state.company_profile?.founders?.join(', ') || 'founders';
      const specterId = state.company_profile?.specter_id || '';
      const yr = new Date().getFullYear();

      this.emitLiveUpdate(dealId, 'analysts_launched',
        `${analystIds.length} analysts launching — market, competition, traction`);

      // Pre-emit NODE_STARTED for ALL analysts so dashboard shows all 3 as "running" simultaneously
      for (let idx = 0; idx < analystIds.length; idx++) {
        this.emitEvent(dealId, 'NODE_STARTED', {
          node_id: analystIds[idx], role: 'analyst',
          specialization: analystConfigs[idx]?.specialization || 'general'
        });
      }

      // ── Specter competitive intel (fires NOW, not after analysts) ──
      const specterCompanyId = state.company_profile?.specter_id;
      const competitiveIntelPromise = (async () => {
        if (!specterCompanyId) return { companies: [] as any[], evidence: [] as any[] };
        try {
          this.emitLiveUpdate(dealId, 'competitive_intel',
            `Specter: finding competitors for ${companyName}…`);
          const simActionId = PersistenceManager.startToolAction({ dealId, toolName: 'specterSimilarCompanies', provider: 'specter', operation: 'similar', input: { companyId: specterCompanyId }, calledBy: 'orchestrator' });
          const simStart = Date.now();
          const { companies, evidence: similarEvidence, rawIds } = await SpecterClient.getSimilarCompanies(
            specterCompanyId, { enrichTop: 5 }
          );
          PersistenceManager.completeToolAction(simActionId, { status: 'success', latencyMs: Date.now() - simStart, resultCount: companies.length });
          PersistenceManager.logQuery({ dealId, toolActionId: simActionId, queryText: `similar companies for ${specterCompanyId}`, queryType: 'similar', provider: 'specter', resultCount: rawIds.length });

          const compEvidence: any[] = [...similarEvidence];
          const enriched = companies.filter(c => c.name && !c.name.startsWith('(ID:'));
          for (let i = 0; i < enriched.length; i++) {
            const c = enriched[i];
            this.emitLiveUpdate(dealId, `analyst_2_competitor_${i + 1}`,
              `${c.name}: ${c.employee_count || '?'} employees, ${c.funding_total_usd ? '$' + (c.funding_total_usd / 1e6).toFixed(1) + 'M raised' : 'funding unknown'}`);
            compEvidence.push({
              evidence_id: `specter-competitor-${i}`, title: `Competitor: ${c.name} vs ${companyName}`,
              snippet: `${c.name} (${c.domain}) | Stage: ${c.growth_stage || '?'} | Employees: ${c.employee_count || '?'} | Funding: ${c.funding_total_usd ? '$' + (c.funding_total_usd / 1e6).toFixed(1) + 'M' : '?'} | Industries: ${c.industries?.join(', ') || '?'} | HQ: ${c.hq_city || '?'}, ${c.hq_country || '?'}`,
              source: 'specter-competitive', retrieved_at: new Date().toISOString(),
            });
          }
          if (enriched.length > 0) {
            const totalCompFunding = enriched.reduce((s, c) => s + (c.funding_total_usd || 0), 0);
            const avgCompEmployees = Math.round(enriched.reduce((s, c) => s + (c.employee_count || 0), 0) / enriched.length);
            compEvidence.push({
              evidence_id: 'specter-competitive-landscape', title: `Competitive Landscape — ${companyName}`,
              snippet: `${enriched.length} key competitors analyzed | Combined funding: $${(totalCompFunding / 1e6).toFixed(1)}M | Avg employees: ${avgCompEmployees} | Competitors: ${enriched.map(c => `${c.name} ($${(c.funding_total_usd || 0) / 1e6 > 0.1 ? ((c.funding_total_usd || 0) / 1e6).toFixed(1) + 'M' : '?'})`).join(', ')}`,
              source: 'specter-competitive', retrieved_at: new Date().toISOString(),
            });
          }
          this.emitLiveUpdate(dealId, 'analyst_2_intel_done',
            `Competitive intel: ${rawIds.length} similar, ${enriched.length} profiled — ${compEvidence.length} evidence`);
          return { companies: enriched, evidence: compEvidence };
        } catch (err: any) {
          console.warn(`[Orchestrator] Specter competitive intel failed: ${err.message}`);
          return { companies: [], evidence: [] };
        }
      })();

      // ── fal.ai cover image (fires NOW, cheap + fast) ──
      const coverImagePromise = FalClient.generateMemoCover(
        companyName, state.company_profile?.industries || []
      ).catch(() => null);

      // ── 3 Analyst agents — all fire simultaneously ──
      const analystResultsPromise = Promise.all(
        analystIds.map(async (analystId: string, idx: number) => {
          const specialization = analystConfigs[idx]?.specialization || 'general';
          const phase = `analyst_${idx + 1}`;

          // ── IMMEDIATE FEEDBACK: Show what each analyst is researching ──
          // This prevents the "Deploying queries…" stall — users see research intent instantly
          const researchFocus: Record<string, string> = {
            market: `Analyzing market size, TAM, growth drivers for ${companyName} in ${industries}`,
            competition: `Mapping competitive landscape, moats, differentiation for ${companyName}`,
            traction: `Evaluating revenue traction, growth metrics, customer signals for ${companyName}`,
          };
          this.emitLiveUpdate(dealId, `${phase}_query`,
            researchFocus[specialization] || `Researching ${specialization} for ${companyName}`);

          const onToolCall = (info: { toolNames: string[]; callNumber: number; thought?: string; toolInput?: string }) => {
            if (info.thought && info.toolNames.length === 0) {
              const thought = info.thought.replace(/\n/g, ' ').slice(0, 100);
              if (thought.length > 20) this.emitLiveUpdate(dealId, `${phase}_think`, `${thought}${info.thought.length > 100 ? '…' : ''}`);
            } else if (info.toolNames.length > 0) {
              this.emitLiveUpdate(dealId, `${phase}_tool`, this.formatToolEvent(info.toolNames, info.toolInput));
            }
          };

          const analystQuery = this.buildAnalystQuery(state!, specialization, analystId, []);
          const personaStartTime = Date.now();
          const difyActionId = PersistenceManager.startToolAction({ dealId, toolName: 'difyRunAgent', provider: 'dify', operation: 'analyst', input: { specialization, analystId }, calledBy: 'orchestrator' });

          const analystResult = await validateWithRetry(
            AnalystOutputSchema, 'AnalystOutput',
            async (retryPrompt?: string) => {
              return DifyClient.runAgent('analyst', {
                deal_input: this.toInputStr(state!.deal_input),
                fund_config: this.toInputStr(state!.deal_input.fund_config),
                specialization, analyst_id: analystId,
                company_profile: this.toInputStr(state!.company_profile),
                evidence: this.compactEvidence(state!.evidence),
                prior_analyses: '[]',
              }, retryPrompt || analystQuery, onToolCall);
            }
          );

          const personaLatency = Date.now() - personaStartTime;
          PersistenceManager.completeToolAction(difyActionId, {
            status: analystResult.ok ? 'success' : 'error', latencyMs: personaLatency,
            resultCount: analystResult.ok ? analystResult.data.facts.length : 0,
            errorMsg: analystResult.ok ? undefined : 'Validation failed',
          });
          PersistenceManager.savePersona({
            dealId, personaType: 'analyst', personaId: analystId, specialization,
            status: analystResult.ok ? 'done' : 'degraded',
            output: analystResult.ok ? analystResult.data : undefined,
            validationOk: analystResult.ok, retryCount: analystResult.ok ? 0 : 1,
            latencyMs: personaLatency,
            startedAt: new Date(Date.now() - personaLatency).toISOString(),
            completedAt: new Date().toISOString(),
          });

          if (analystResult.ok) {
            const eids = analystResult.data.facts.flatMap(f => f.evidence_ids)
              .concat(analystResult.data.contradictions.flatMap(c => c.evidence_ids));
            PersistenceManager.saveNodeMemory(dealId, analystId, {
              ...analystResult.data, hypotheses: [], evidence_ids: [...new Set(eids)]
            });
            this.emitEvent(dealId, 'MSG_SENT', { from: analystId, to: 'associate', summary: `Analysis complete for ${specialization}` });
            this.emitEvent(dealId, 'NODE_DONE', { node_id: analystId, output_summary: `${specialization} analysis done` });
            const topFact = analystResult.data.facts[0]?.text?.slice(0, 60) || '';
            this.emitLiveUpdate(dealId, `${phase}_done`,
              `✓ ${specialization}: ${analystResult.data.facts.length} facts, ${analystResult.data.unknowns.length} unknowns${topFact ? ` — "${topFact}…"` : ''}`);
            return analystResult.data;
          } else {
            this.emitEvent(dealId, 'ERROR', { where: `${analystId}_validation`, message: `Analyst ${analystId} output failed validation: ${analystResult.errors}` });
            PersistenceManager.saveNodeMemory(dealId, analystId, { facts: [], contradictions: [], unknowns: [], hypotheses: [], evidence_ids: [] });
            this.emitEvent(dealId, 'NODE_DONE', { node_id: analystId, output_summary: `${specialization} validation failed` });
            this.emitLiveUpdate(dealId, `${phase}_done`, `${specialization}: validation failed — degraded mode`);
            return null;
          }
        })
      );

      // ── AWAIT WAVE 1 — analysts + competitive intel finish together ──
      const [analystResults, competitiveIntel] = await Promise.all([
        analystResultsPromise,
        competitiveIntelPromise,
      ]);

      // Inject competitive evidence immediately
      if (competitiveIntel.evidence.length > 0) {
        this.addEvidence(dealId, competitiveIntel.evidence);
      }

      const analystOutputs: AnalystOutput[] = analystResults.filter((r): r is AnalystOutput => r !== null);

      // ═══════════════════════════════════════════════════════════════
      // WAVE 2 — ASSOCIATE + UNKNOWN RESOLUTION IN PARALLEL
      // Associate doesn't need resolved unknowns to start — it has
      // all analyst outputs + evidence already. Unknown resolution
      // enriches the state for Partner.
      // ═══════════════════════════════════════════════════════════════
      const allUnknowns = analystOutputs.flatMap((a, idx) =>
        a.unknowns.map(u => ({
          question: u.question, analystId: analystIds[idx],
          specialization: analystConfigs[idx]?.specialization || 'general',
        }))
      );

      // ── Unknown resolution (parallel batch — NOT sequential) ──
      const unknownResolutionPromise = (async () => {
        const allNewEvidence: any[] = [];
        const resolutionResults: { unknown: typeof allUnknowns[0]; answer?: string; evidence: any[] }[] = [];
        if (allUnknowns.length === 0) return { evidence: allNewEvidence, results: resolutionResults };
        const toResolve = allUnknowns.slice(0, 5);
        const hasTavily = !!process.env.TAVILY_API_KEY;
        if (!specterCompanyId && !hasTavily) return { evidence: allNewEvidence, results: resolutionResults };

        this.emitLiveUpdate(dealId, 'unknown_resolution',
          `🔎 ${toResolve.length} open questions — resolving ALL in parallel…`);

        const resolutions = await Promise.all(toResolve.map(async (unk, i) => {
          const phase = `resolve_${i + 1}`;
          this.emitLiveUpdate(dealId, phase,
            `🔍 "${unk.question.slice(0, 80)}${unk.question.length > 80 ? '…' : ''}" (${unk.specialization})`);

          const isCompetitiveQ = /competitor|compet|rival|market share|versus|vs\b|alternative/i.test(unk.question);
          if (isCompetitiveQ && specterCompanyId) {
            const nameMatch = unk.question.match(/(?:competitor|rival|vs\.?\s+|alternative to\s+)([A-Z][a-zA-Z0-9\s]+)/i);
            if (nameMatch) {
              try {
                const searchResult = await SpecterClient.searchByName(nameMatch[1].trim());
                if (searchResult.evidence.length > 0) {
                  this.emitLiveUpdate(dealId, `${phase}_done`, `Specter: ${searchResult.results.length} matches for "${nameMatch[1].trim()}"`);
                  return { unknown: unk, answer: `Found ${searchResult.results.length} results`, evidence: searchResult.evidence };
                }
              } catch { /* fall through to Tavily */ }
            }
          }
          if (hasTavily) {
            try {
              const result = await TavilyClient.search(unk.question, { maxResults: 2 });
              if (result.evidence.length > 0) {
                if (result.evidence.length > 0) this.emitLiveUpdate(dealId, `${phase}_done`, `${result.evidence.length} sources found`);
                return { unknown: unk, answer: result.answer, evidence: result.evidence };
              }
            } catch { /* skip */ }
          }
          this.emitLiveUpdate(dealId, `${phase}_done`, `Unresolved: "${unk.question.slice(0, 60)}…"`);
          return { unknown: unk, evidence: [] as any[] };
        }));

        for (const r of resolutions) {
          allNewEvidence.push(...r.evidence);
          resolutionResults.push(r);
        }
        return { evidence: allNewEvidence, results: resolutionResults };
      })();

      // ── Associate (fires NOW — doesn't wait for unknowns) ──
      this.emitEvent(dealId, 'NODE_STARTED', { node_id: 'associate', role: 'associate' });
      const totalFacts = analystOutputs.reduce((sum, a) => sum + a.facts.length, 0);
      this.emitLiveUpdate(dealId, 'associate',
        `🚀 Wave 2 — Associate (${totalFacts} facts) + ${allUnknowns.length} unknowns resolving in parallel`);

      state = PersistenceManager.getState(dealId)!;

      const associateQuery = this.buildAssociateQuery(state!, analystOutputs);
      const onAssocToolCall = (info: { toolNames: string[]; callNumber: number; thought?: string; toolInput?: string }) => {
        if (info.thought && info.toolNames.length === 0) {
          const t = info.thought.replace(/\n/g, ' ').slice(0, 100);
          if (t.length > 20) this.emitLiveUpdate(dealId, 'associate_think', `${t}${info.thought.length > 100 ? '…' : ''}`);
        } else if (info.toolNames.length > 0) {
          this.emitLiveUpdate(dealId, 'associate_tool', this.formatToolEvent(info.toolNames, info.toolInput));
        }
      };

      const assocStartTime = Date.now();
      const assocActionId = PersistenceManager.startToolAction({ dealId, toolName: 'difyRunAgent', provider: 'dify', operation: 'associate', calledBy: 'orchestrator' });

      const associateResultPromise = validateWithRetry(
        AssociateOutputSchema, 'AssociateOutput',
        async (retryPrompt?: string) => {
          return DifyClient.runAgent('associate', {
            deal_input: this.toInputStr(state!.deal_input),
            fund_config: this.toInputStr(state!.deal_input.fund_config),
            analyst_outputs: this.toInputStr(analystOutputs),
            company_profile: this.toInputStr(state!.company_profile),
            evidence: this.compactEvidence(state!.evidence),
          }, retryPrompt || associateQuery, onAssocToolCall);
        }
      );

      // ── AWAIT WAVE 2 — associate + unknowns finish together ──
      const [associateResult, unknownResolution] = await Promise.all([
        associateResultPromise,
        unknownResolutionPromise,
      ]);

      // Inject resolved evidence
      if (unknownResolution.evidence.length > 0) {
        this.addEvidence(dealId, unknownResolution.evidence);
        const resolvedCount = unknownResolution.results.filter(r => r.evidence.length > 0).length;
        this.emitLiveUpdate(dealId, 'unknown_resolution_done',
          `✓ ${unknownResolution.evidence.length} new evidence items, ${resolvedCount} unknowns resolved`);
      }

      // Update analyst memories with resolved unknowns
      for (const r of unknownResolution.results) {
        if (r.answer) {
          const analystMem = PersistenceManager.getNodeMemory(dealId, r.unknown.analystId);
          if (analystMem) {
            const updatedUnknowns = (analystMem.unknowns || []).map((u: any) =>
              u.question === r.unknown.question ? { ...u, resolved: true, answer: (r.answer || '').slice(0, 300) } : u
            );
            PersistenceManager.saveNodeMemory(dealId, r.unknown.analystId, { ...analystMem, unknowns: updatedUnknowns });
          }
        }
      }

      const assocLatency = Date.now() - assocStartTime;
      PersistenceManager.completeToolAction(assocActionId, {
        status: associateResult.ok ? 'success' : 'error', latencyMs: assocLatency,
        resultCount: associateResult.ok ? associateResult.data.hypotheses.length : 0,
        errorMsg: associateResult.ok ? undefined : 'Validation failed',
      });
      PersistenceManager.savePersona({
        dealId, personaType: 'associate', personaId: 'associate',
        status: associateResult.ok ? 'done' : 'degraded',
        output: associateResult.ok ? associateResult.data : undefined,
        validationOk: associateResult.ok, latencyMs: assocLatency,
        startedAt: new Date(Date.now() - assocLatency).toISOString(),
        completedAt: new Date().toISOString(),
      });

      if (associateResult.ok) {
        const assocEvidenceIds = associateResult.data.hypotheses.flatMap(h => h.support_evidence_ids);
        PersistenceManager.saveNodeMemory(dealId, 'associate', {
          facts: [], contradictions: [], unknowns: [],
          hypotheses: associateResult.data.hypotheses,
          evidence_ids: [...new Set(assocEvidenceIds)]
        });
        this.emitEvent(dealId, 'STATE_PATCH', { hypotheses: associateResult.data.hypotheses, patch_summary: 'Associate hypotheses added' });
      } else {
        this.emitEvent(dealId, 'ERROR', { where: 'associate_validation', message: `Associate output failed validation after retry: ${associateResult.errors}` });
        PersistenceManager.saveNodeMemory(dealId, 'associate', { facts: [], contradictions: [], unknowns: [], hypotheses: [], evidence_ids: [] });
      }

      // Save edge memories: each analyst -> associate
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
        this.emitLiveUpdate(dealId, 'associate_done',
          `✓ Associate produced ${associateResult.data.hypotheses.length} hypotheses, ${associateResult.data.top_unknowns.length} unknowns. Escalating to Partner…`);
      }

      // ═══════════════════════════════════════════════════════════════
      // WAVE 3 — MEMO + PARTNER
      // Build memo (wait for cover from Wave 1), then Partner scores
      // ═══════════════════════════════════════════════════════════════
      state = PersistenceManager.getState(dealId)!;

      // Cover image was fired in Wave 1 — resolve now (should be done)
      const coverUrl = await Promise.race([coverImagePromise, new Promise<null>(r => setTimeout(() => r(null), 5000))]);
      const memoSlides = this.buildMemoSlides(state!, analystOutputs, associateResult.ok ? associateResult.data : null);
      if (coverUrl) memoSlides[0].imageUrl = coverUrl;
      PersistenceManager.saveMemo(dealId, memoSlides);
      this.emitLiveUpdate(dealId, 'memo_done',
        `✓ Investment memo — ${memoSlides.length} slides${coverUrl ? ' + AI cover art' : ''}`);

      // Step 6: Partner
      this.emitEvent(dealId, 'NODE_STARTED', { node_id: 'partner', role: 'partner' });
      this.emitLiveUpdate(
        dealId, 'partner',
        `Partner is scoring rubric and forming deal decision…`
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
      const onPartnerToolCall = (info: { toolNames: string[]; callNumber: number; thought?: string; toolInput?: string }) => {
        if (info.thought && info.toolNames.length === 0) {
          const t = info.thought.replace(/\n/g, ' ').slice(0, 100);
          if (t.length > 20) this.emitLiveUpdate(dealId, 'partner_think', `${t}${info.thought.length > 100 ? '…' : ''}`);
        } else if (info.toolNames.length > 0) {
          this.emitLiveUpdate(dealId, 'partner_tool', this.formatToolEvent(info.toolNames, info.toolInput));
        }
      };

      const partnerStartTime = Date.now();
      const partnerActionId = PersistenceManager.startToolAction({ dealId, toolName: 'difyRunAgent', provider: 'dify', operation: 'partner', calledBy: 'orchestrator' });

      const partnerResult = await validateWithRetry(
        PartnerOutputSchema,
        'PartnerOutput',
        async (retryPrompt?: string) => {
          return DifyClient.runAgent('partner', {
            deal_input: this.toInputStr(state!.deal_input),
            fund_config: this.toInputStr(state!.deal_input.fund_config),
            associate_output: this.toInputStr(associateForPartner),
            company_profile: this.toInputStr(state!.company_profile),
            evidence: this.compactEvidence(state!.evidence),
          }, retryPrompt || partnerQuery, onPartnerToolCall);
        }
      );

      const partnerLatency = Date.now() - partnerStartTime;
      PersistenceManager.completeToolAction(partnerActionId, {
        status: partnerResult.ok ? 'success' : 'error', latencyMs: partnerLatency,
        errorMsg: partnerResult.ok ? undefined : 'Validation failed',
      });
      PersistenceManager.savePersona({
        dealId, personaType: 'partner', personaId: 'partner',
        status: partnerResult.ok ? 'done' : 'degraded',
        output: partnerResult.ok ? partnerResult.data : undefined,
        validationOk: partnerResult.ok,
        latencyMs: partnerLatency,
        startedAt: new Date(Date.now() - partnerLatency).toISOString(),
        completedAt: new Date().toISOString(),
      });

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

        // Update memo recommendation slide with final Partner decision + scores
        const existingMemo = PersistenceManager.getMemo(dealId);
        if (existingMemo) {
          const updated = existingMemo.map((slide: any) => {
            if (slide.type === 'recommendation') {
              const dec = partnerResult.data.decision_gate;
              const d = dec.decision as string;
              const decLabel = d === 'STRONG_YES' ? 'INVEST' : d === 'KILL' || d === 'PASS' ? d : 'PROCEED WITH CONDITIONS';
              return {
                ...slide,
                subtitle: `${decLabel} — Avg Score ${avg}/100`,
                bullets: [
                  `Decision: ${decLabel}`,
                  `Average rubric score: ${avg}/100`,
                  `Market: ${r.market.score} | Moat: ${r.moat.score} | Why Now: ${r.why_now.score} | Exec: ${r.execution.score} | Fit: ${r.deal_fit.score}`,
                  ...dec.gating_questions.slice(0, 3).map((q: string) => `Gating: ${q}`),
                ],
                metrics: [
                  { label: 'Market', value: String(r.market.score) },
                  { label: 'Moat', value: String(r.moat.score) },
                  { label: 'Why Now', value: String(r.why_now.score) },
                  { label: 'Exec', value: String(r.execution.score) },
                  { label: 'Fit', value: String(r.deal_fit.score) },
                ],
              };
            }
            return slide;
          });
          PersistenceManager.saveMemo(dealId, updated);
        }

        this.emitLiveUpdate(
          dealId, 'complete',
          `✓ Deal analysis complete — Decision: ${partnerResult.data.decision_gate.decision} | Avg score: ${avg}/100 | ${partnerResult.data.decision_gate.gating_questions.length} gating questions.`,
          `In 1-2 sentences, summarize this VC deal decision for "${state.deal_input.name}": decision=${partnerResult.data.decision_gate.decision}, average rubric score ${avg}/100, with ${partnerResult.data.decision_gate.gating_questions.length} gating questions remaining.`
        );
      }

      // Await background tasks if they haven't finished yet (best-effort, 60s max)
      await Promise.race([
        Promise.all([batchIntelPromise, founderDeepDivePromise]),
        new Promise(resolve => setTimeout(resolve, 60000))
      ]);

      this.emitEvent(dealId, 'NODE_DONE', { node_id: 'orchestrator', output_summary: 'Simulation complete' });

      // ── Complete run ────────────────────────────────────────────
      const finalState = PersistenceManager.getState(dealId);
      const avgScore = finalState?.rubric
        ? Math.round(Object.values(finalState.rubric).reduce((s: number, d: any) => s + (d?.score || 0), 0) / 5)
        : undefined;
      PersistenceManager.completeRun({
        decision: finalState?.decision_gate?.decision,
        avg_score: avgScore,
        duration_ms: Date.now() - runStartTime,
      });

    } catch (err: any) {
      // Degraded mode: always emit a decision gate even on failure
      this.emitEvent(dealId, 'ERROR', { where: 'simulation_run', message: err.message });
      this.updateDecisionGate(dealId, {
        decision: 'PROCEED_IF',
        gating_questions: ['Error during analysis — manual review needed', 'Verify all data sources', 'Reassess after fix'],
        evidence_checklist: [{ q: 1, item: 'Simulation failed — treat all outputs as assumptions', type: 'ASSUMPTION', evidence_ids: [] }]
      });
      PersistenceManager.completeRun({ error_msg: err.message, duration_ms: Date.now() - runStartTime });
    } finally {
      this.activeDeals.delete(dealId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // AUTO-RESUME: Called by deal-dashboard on each poll to advance a
  // stalled simulation. On serverless (Alpic), background promises
  // die when the container scales down, so we need this to complete
  // the pipeline step-by-step across multiple requests.
  //
  // Each call is designed to complete ONE wave within ~20s:
  //   Wave 1: Analysts (Dify agents or stubs)
  //   Wave 2: Associate
  //   Wave 3: Partner + memo
  // ═══════════════════════════════════════════════════════════════════
  // Tracks deals with active simulation or resume in progress — prevents double-execution
  private static activeDeals = new Set<string>();

  static async resumeIfStalled(dealId: string): Promise<'complete' | 'advanced' | 'running' | 'noop'> {
    // Prevent concurrent resumes / double-execution with run()
    if (this.activeDeals.has(dealId)) {
      console.log(`[Resume] ${dealId}: already in progress (run or resume active)`);
      return 'running';
    }

    const state = PersistenceManager.getState(dealId);
    if (!state) {
      console.log(`[Resume] ${dealId}: no state found`);
      return 'noop';
    }

    // Check what has completed by reading events
    const events = PersistenceManager.getEventHistory(dealId);
    const nodesDone = new Set(
      events.filter((e: any) => e.type === 'NODE_DONE').map((e: any) => e.payload?.node_id)
    );
    const nodesStarted = new Set(
      events.filter((e: any) => e.type === 'NODE_STARTED').map((e: any) => e.payload?.node_id)
    );

    console.log(`[Resume] ${dealId}: ${events.length} events, started=[${[...nodesStarted].join(',')}], done=[${[...nodesDone].join(',')}]`);

    // If orchestrator completed, nothing to do
    if (nodesDone.has('orchestrator')) return 'complete';

    // If orchestrator started but analysts didn't → evidence seed was interrupted.
    // Skip evidence seed (whatever evidence exists is enough) and launch analysts directly.
    if (!nodesStarted.has('analyst_1')) {
      console.log(`[Resume] ${dealId}: analyst_1 not started yet — LAUNCHING ANALYSTS (evidence seed may have been interrupted)`);
      // Emit NODE_STARTED for analysts so subsequent resumes track correctly
      for (const aid of ['analyst_1', 'analyst_2', 'analyst_3']) {
        this.emitEvent(dealId, 'NODE_STARTED', { node_id: aid, role: 'analyst' });
      }
      this.activeDeals.add(dealId);
      try {
        await this.resumeAnalysts(dealId, state, new Set());
        console.log(`[Resume] ${dealId}: analysts wave complete (from cold start)`);
        return 'advanced';
      } catch (err: any) {
        console.error(`[Resume] ${dealId}: analysts cold-start failed: ${err.message}`);
        return 'advanced';
      } finally {
        this.activeDeals.delete(dealId);
      }
    }

    // Determine which wave to run
    const analyst1Done = nodesDone.has('analyst_1');
    const analyst2Done = nodesDone.has('analyst_2');
    const analyst3Done = nodesDone.has('analyst_3');
    const allAnalystsDone = analyst1Done && analyst2Done && analyst3Done;
    const associateDone = nodesDone.has('associate');
    const partnerDone = nodesDone.has('partner');

    // If analysts started but not all done → need to run analysts
    if (!allAnalystsDone) {
      console.log(`[Resume] ${dealId}: RESUMING ANALYSTS (done: ${[analyst1Done, analyst2Done, analyst3Done]})`);
      this.activeDeals.add(dealId);
      try {
        await this.resumeAnalysts(dealId, state, nodesDone);
        console.log(`[Resume] ${dealId}: analysts wave complete`);
        return 'advanced';
      } catch (err: any) {
        console.error(`[Resume] ${dealId}: analysts failed: ${err.message}`);
        return 'advanced';
      } finally {
        this.activeDeals.delete(dealId);
      }
    }

    // If analysts done but associate not done → run associate
    if (allAnalystsDone && !associateDone) {
      console.log(`[Resume] ${dealId}: RESUMING ASSOCIATE`);
      this.activeDeals.add(dealId);
      try {
        await this.resumeAssociate(dealId, state);
        console.log(`[Resume] ${dealId}: associate wave complete`);
        return 'advanced';
      } catch (err: any) {
        console.error(`[Resume] ${dealId}: associate failed: ${err.message}`);
        return 'advanced';
      } finally {
        this.activeDeals.delete(dealId);
      }
    }

    // If associate done but partner not done → run partner
    if (associateDone && !partnerDone) {
      console.log(`[Resume] ${dealId}: RESUMING PARTNER`);
      this.activeDeals.add(dealId);
      try {
        await this.resumePartner(dealId, state);
        console.log(`[Resume] ${dealId}: partner wave complete`);
        return 'advanced';
      } catch (err: any) {
        console.error(`[Resume] ${dealId}: partner failed: ${err.message}`);
        return 'advanced';
      } finally {
        this.activeDeals.delete(dealId);
      }
    }

    console.log(`[Resume] ${dealId}: all waves complete`);
    return 'complete';
  }

  private static async resumeAnalysts(dealId: string, state: DealState, nodesDone: Set<string>): Promise<void> {
    const analystConfigs = [
      { specialization: 'market' },
      { specialization: 'competition' },
      { specialization: 'traction' }
    ];
    const analystIds = ['analyst_1', 'analyst_2', 'analyst_3'];
    const companyName = state.deal_input.name;
    const industries = state.company_profile?.industries?.join(', ') || companyName;

    this.emitLiveUpdate(dealId, 'resume', `Resuming analyst analysis for ${companyName}…`);

    const results = await Promise.all(
      analystIds.map(async (analystId, idx) => {
        if (nodesDone.has(analystId)) return null; // Already done

        const specialization = analystConfigs[idx]?.specialization || 'general';
        const phase = `analyst_${idx + 1}`;

        this.emitLiveUpdate(dealId, `${phase}_query`,
          `Resuming ${specialization} analysis for ${companyName}…`);

        const analystQuery = this.buildAnalystQuery(state, specialization, analystId, []);
        const analystResult = await validateWithRetry(
          AnalystOutputSchema, 'AnalystOutput',
          async (retryPrompt?: string) => {
            return DifyClient.runAgent('analyst', {
              deal_input: this.toInputStr(state.deal_input),
              fund_config: this.toInputStr(state.deal_input.fund_config),
              specialization, analyst_id: analystId,
              company_profile: this.toInputStr(state.company_profile),
              evidence: this.compactEvidence(state.evidence),
              prior_analyses: '[]',
            }, retryPrompt || analystQuery);
          }
        );

        if (analystResult.ok) {
          const eids = analystResult.data.facts.flatMap(f => f.evidence_ids)
            .concat(analystResult.data.contradictions.flatMap(c => c.evidence_ids));
          PersistenceManager.saveNodeMemory(dealId, analystId, {
            ...analystResult.data, hypotheses: [], evidence_ids: [...new Set(eids)]
          });
          this.emitEvent(dealId, 'MSG_SENT', { from: analystId, to: 'associate', summary: `Analysis complete for ${specialization}` });
          this.emitEvent(dealId, 'NODE_DONE', { node_id: analystId, output_summary: `${specialization} analysis done` });
          this.emitLiveUpdate(dealId, `${phase}_done`,
            `✓ ${specialization}: ${analystResult.data.facts.length} facts, ${analystResult.data.unknowns.length} unknowns`);
          return analystResult.data;
        } else {
          this.emitEvent(dealId, 'ERROR', { where: `${analystId}_validation`, message: `Resume: analyst ${analystId} failed` });
          PersistenceManager.saveNodeMemory(dealId, analystId, { facts: [], contradictions: [], unknowns: [], hypotheses: [], evidence_ids: [] });
          this.emitEvent(dealId, 'NODE_DONE', { node_id: analystId, output_summary: `${specialization} validation failed` });
          this.emitLiveUpdate(dealId, `${phase}_done`, `${specialization}: degraded`);
          return null;
        }
      })
    );
  }

  private static async resumeAssociate(dealId: string, state: DealState): Promise<void> {
    // Gather analyst outputs from node memory
    const analystOutputs: AnalystOutput[] = [];
    for (const aid of ['analyst_1', 'analyst_2', 'analyst_3']) {
      const mem = PersistenceManager.getNodeMemory(dealId, aid);
      if (mem && mem.facts && mem.facts.length > 0) {
        analystOutputs.push(mem as unknown as AnalystOutput);
      }
    }

    this.emitEvent(dealId, 'NODE_STARTED', { node_id: 'associate', role: 'associate' });
    this.emitLiveUpdate(dealId, 'associate', `Associate synthesizing ${analystOutputs.reduce((s, a) => s + a.facts.length, 0)} facts…`);

    state = PersistenceManager.getState(dealId)!;
    const associateQuery = this.buildAssociateQuery(state, analystOutputs);
    const associateResult = await validateWithRetry(
      AssociateOutputSchema, 'AssociateOutput',
      async (retryPrompt?: string) => {
        return DifyClient.runAgent('associate', {
          deal_input: this.toInputStr(state.deal_input),
          fund_config: this.toInputStr(state.deal_input.fund_config),
          analyst_outputs: this.toInputStr(analystOutputs),
          company_profile: this.toInputStr(state.company_profile),
          evidence: this.compactEvidence(state.evidence),
        }, retryPrompt || associateQuery);
      }
    );

    if (associateResult.ok) {
      PersistenceManager.saveNodeMemory(dealId, 'associate', {
        facts: [], contradictions: [], unknowns: [],
        hypotheses: associateResult.data.hypotheses,
        evidence_ids: [...new Set(associateResult.data.hypotheses.flatMap(h => h.support_evidence_ids))]
      });
      this.emitEvent(dealId, 'STATE_PATCH', { hypotheses: associateResult.data.hypotheses, patch_summary: 'Associate hypotheses added' });
    } else {
      this.emitEvent(dealId, 'ERROR', { where: 'associate_validation', message: 'Resume: associate failed' });
      PersistenceManager.saveNodeMemory(dealId, 'associate', { facts: [], contradictions: [], unknowns: [], hypotheses: [], evidence_ids: [] });
    }

    this.emitEvent(dealId, 'MSG_SENT', { from: 'associate', to: 'partner', summary: 'Synthesis complete' });
    this.emitEvent(dealId, 'NODE_DONE', { node_id: 'associate', output_summary: 'Synthesis complete' });
    this.emitLiveUpdate(dealId, 'associate_done',
      associateResult.ok
        ? `✓ Associate: ${associateResult.data.hypotheses.length} hypotheses`
        : `Associate: degraded mode`);
  }

  private static async resumePartner(dealId: string, state: DealState): Promise<void> {
    const assocMem = PersistenceManager.getNodeMemory(dealId, 'associate');
    const associateForPartner = assocMem?.hypotheses?.length
      ? { hypotheses: assocMem.hypotheses, top_unknowns: [], requests_to_analysts: [] }
      : { hypotheses: [], top_unknowns: [{ question: 'Associate failed', why_it_matters: 'Degraded' }], requests_to_analysts: [] };

    this.emitEvent(dealId, 'NODE_STARTED', { node_id: 'partner', role: 'partner' });
    this.emitLiveUpdate(dealId, 'partner', `Partner scoring rubric…`);

    state = PersistenceManager.getState(dealId)!;
    const partnerQuery = this.buildPartnerQuery(state, associateForPartner as AssociateOutput);
    const partnerResult = await validateWithRetry(
      PartnerOutputSchema, 'PartnerOutput',
      async (retryPrompt?: string) => {
        return DifyClient.runAgent('partner', {
          deal_input: this.toInputStr(state.deal_input),
          fund_config: this.toInputStr(state.deal_input.fund_config),
          associate_output: this.toInputStr(associateForPartner),
          company_profile: this.toInputStr(state.company_profile),
          evidence: this.compactEvidence(state.evidence),
        }, retryPrompt || partnerQuery);
      }
    );

    if (partnerResult.ok) {
      const enforced = enforceEvidenceRule(partnerResult.data);
      PersistenceManager.saveNodeMemory(dealId, 'partner', {
        facts: [], contradictions: [], unknowns: [], hypotheses: [],
        evidence_ids: [...new Set(enforced.decision_gate.evidence_checklist.filter(c => c.type === 'EVIDENCE').flatMap(c => c.evidence_ids))]
      });
      this.emitEvent(dealId, 'STATE_PATCH', { rubric: enforced.rubric, patch_summary: 'Partner rubric scores' });
      this.updateDecisionGate(dealId, enforced.decision_gate);

      const r = enforced.rubric;
      const avg = Math.round((r.market.score + r.moat.score + r.why_now.score + r.execution.score + r.deal_fit.score) / 5);
      this.emitLiveUpdate(dealId, 'complete',
        `✓ Deal analysis complete — Decision: ${enforced.decision_gate.decision} | Avg score: ${avg}/100`);
    } else {
      this.emitEvent(dealId, 'ERROR', { where: 'partner_validation', message: 'Resume: partner failed' });
      PersistenceManager.saveNodeMemory(dealId, 'partner', { facts: [], contradictions: [], unknowns: [], hypotheses: [], evidence_ids: [] });
      this.updateDecisionGate(dealId, {
        decision: 'PROCEED_IF',
        gating_questions: ['Validation failed', 'Manual review needed', 'Reassess after fix'],
        evidence_checklist: [{ q: 1, item: 'Partner validation failed', type: 'ASSUMPTION', evidence_ids: [] }]
      });
      this.emitLiveUpdate(dealId, 'complete', `Deal analysis complete — degraded mode`);
    }

    this.emitEvent(dealId, 'MSG_SENT', { from: 'partner', to: 'orchestrator', summary: `Decision made` });
    this.emitEvent(dealId, 'NODE_DONE', { node_id: 'partner', output_summary: `Decision gate set` });

    // Generate memo from whatever state exists
    try {
      const finalState = PersistenceManager.getState(dealId)!;
      const analystOutputs: AnalystOutput[] = [];
      for (const aid of ['analyst_1', 'analyst_2', 'analyst_3']) {
        const mem = PersistenceManager.getNodeMemory(dealId, aid);
        if (mem?.facts?.length) analystOutputs.push(mem as unknown as AnalystOutput);
      }
      const assocMemFinal = PersistenceManager.getNodeMemory(dealId, 'associate');
      const memoSlides = this.buildMemoSlides(
        finalState, analystOutputs,
        assocMemFinal?.hypotheses?.length ? assocMemFinal as unknown as AssociateOutput : null
      );
      PersistenceManager.saveMemo(dealId, memoSlides);
      this.emitLiveUpdate(dealId, 'memo_done', `Investment memo generated — ${memoSlides.length} slides`);
    } catch (err: any) {
      console.warn(`[Resume] Memo generation failed: ${err.message}`);
    }

    this.emitEvent(dealId, 'NODE_DONE', { node_id: 'orchestrator', output_summary: 'Simulation complete' });
  }
}
