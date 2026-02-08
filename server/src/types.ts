// ── Investor Persona ─────────────────────────────────────────────────
export type FirmType = 'angel' | 'early_vc' | 'growth_vc' | 'late_vc' | 'pe' | 'ib';

export interface FundProfile {
  firm_type: FirmType;
  aum: string;                    // "$10M", "$500M", "$5B"
  risk_appetite: 'aggressive' | 'moderate' | 'conservative';
  return_target: string;          // "100x", "10-30x", "3-5x", "2-3x MOIC"
  return_horizon: string;         // "7-10y", "5-7y", "3-5y"
  check_size_guidance: string;    // "1-5% of AUM"
  evaluation_lens: string;        // What this investor type fundamentally cares about
  key_metrics: string[];          // Ordered by importance
  deal_breakers: string[];        // What kills a deal for this investor type
  scoring_weights: {              // How rubric dimensions should be weighted
    market: number;               // 0-2x multiplier
    moat: number;
    why_now: number;
    execution: number;
    deal_fit: number;
  };
}

export const FUND_PROFILES: Record<FirmType, Omit<FundProfile, 'aum'>> = {
  angel: {
    firm_type: 'angel',
    risk_appetite: 'aggressive',
    return_target: '50-100x on winners',
    return_horizon: '7-10 years',
    check_size_guidance: '$25K-$500K per deal',
    evaluation_lens: 'Bet on extraordinary founders with massive vision. Portfolio construction expects 90% failure — one unicorn pays for everything. Conviction in the founder matters more than metrics.',
    key_metrics: ['founder domain expertise', 'vision clarity', 'market timing', 'TAM potential', 'capital efficiency'],
    deal_breakers: ['weak founder conviction', 'small TAM (<$1B)', 'crowded market with no differentiation', 'capital-intensive with no path to efficiency'],
    scoring_weights: { market: 1.0, moat: 0.7, why_now: 1.3, execution: 1.5, deal_fit: 0.5 },
  },
  early_vc: {
    firm_type: 'early_vc',
    risk_appetite: 'aggressive',
    return_target: '10-30x fund returns',
    return_horizon: '5-7 years to exit',
    check_size_guidance: '1-3% of AUM per deal',
    evaluation_lens: 'Find companies that can become category leaders. Need evidence of product-market fit or clear path to it. Team quality + TAM size are the primary filters. Growth trajectory matters more than current revenue.',
    key_metrics: ['TAM/SAM/SOM', 'team completeness', 'PMF signals', 'growth rate', 'burn multiple', 'competitive positioning'],
    deal_breakers: ['TAM < $5B', 'incomplete founding team', 'no PMF signals', 'burn rate with no growth', 'regulatory risk without clear path'],
    scoring_weights: { market: 1.3, moat: 1.0, why_now: 1.2, execution: 1.2, deal_fit: 0.8 },
  },
  growth_vc: {
    firm_type: 'growth_vc',
    risk_appetite: 'moderate',
    return_target: '5-10x on invested capital',
    return_horizon: '3-5 years to exit',
    check_size_guidance: '2-5% of AUM per deal',
    evaluation_lens: 'Invest in proven business models scaling rapidly. Revenue must be real and growing. Unit economics must work or be clearly trending positive. The question is not "will this work?" but "how big can this get and how fast?"',
    key_metrics: ['ARR/revenue', 'revenue growth rate', 'net retention', 'gross margin', 'CAC/LTV', 'burn multiple', 'path to profitability'],
    deal_breakers: ['declining growth', 'negative unit economics at scale', 'customer concentration >30%', 'no clear path to $100M+ ARR', 'governance concerns'],
    scoring_weights: { market: 1.2, moat: 1.3, why_now: 0.8, execution: 1.2, deal_fit: 1.0 },
  },
  late_vc: {
    firm_type: 'late_vc',
    risk_appetite: 'moderate',
    return_target: '3-5x on invested capital',
    return_horizon: '2-4 years to exit/IPO',
    check_size_guidance: '3-7% of AUM per deal',
    evaluation_lens: 'Pre-IPO and late-stage growth. Company must demonstrate clear market leadership, sustainable competitive advantages, and a credible path to public markets or strategic acquisition. Valuation discipline is critical.',
    key_metrics: ['revenue scale ($50M+)', 'profitability trajectory', 'market share', 'competitive moat depth', 'management bench', 'IPO readiness'],
    deal_breakers: ['overvalued vs comparables', 'weak CFO/finance function', 'regulatory overhang', 'customer churn >15%', 'no clear exit path in 3y'],
    scoring_weights: { market: 1.0, moat: 1.5, why_now: 0.7, execution: 1.3, deal_fit: 1.2 },
  },
  pe: {
    firm_type: 'pe',
    risk_appetite: 'conservative',
    return_target: '2-3x MOIC, 20-25% IRR',
    return_horizon: '3-5 year hold period',
    check_size_guidance: '5-15% of fund per deal',
    evaluation_lens: 'Value creation through operational improvement, not just growth. Need stable cash flows, clear operational levers, and defensible market position. Downside protection matters as much as upside. Leverage and capital structure are key tools.',
    key_metrics: ['EBITDA', 'EBITDA margin expansion potential', 'free cash flow', 'customer retention', 'operational efficiency', 'management depth', 'debt capacity'],
    deal_breakers: ['negative EBITDA with no path', 'high customer concentration', 'key-person dependency', 'weak cash flow conversion', 'regulatory risk that impairs value'],
    scoring_weights: { market: 0.8, moat: 1.5, why_now: 0.6, execution: 1.5, deal_fit: 1.3 },
  },
  ib: {
    firm_type: 'ib',
    risk_appetite: 'conservative',
    return_target: 'Advisory: maximize transaction value',
    return_horizon: '6-18 month transaction timeline',
    check_size_guidance: 'N/A — advisory mandate',
    evaluation_lens: 'Evaluate as a potential M&A target or IPO candidate. Focus on comparable transactions, strategic value to acquirers, defensible positioning, and financial profile that commands premium multiples. Think in terms of deal structure and buyer universe.',
    key_metrics: ['revenue multiple vs comps', 'strategic acquirer fit', 'IP/patent portfolio', 'recurring revenue %', 'management retention risk', 'regulatory clearance risk'],
    deal_breakers: ['no strategic acquirer interest', 'messy cap table', 'unresolved litigation', 'declining fundamentals', 'key-person risk with no succession'],
    scoring_weights: { market: 1.0, moat: 1.3, why_now: 1.0, execution: 1.0, deal_fit: 1.5 },
  },
};

export function resolveFundProfile(firmType?: FirmType | string, aum?: string): FundProfile {
  const ft = (firmType as FirmType) || 'early_vc';
  const base = FUND_PROFILES[ft] || FUND_PROFILES.early_vc;
  return { ...base, aum: aum || 'Not specified' };
}

/** Founder-provided deal terms — captured at creation or updated mid-flow. */
export interface DealTerms {
  ticket_size?: string;         // "$2M", "$500K"
  valuation?: string;           // "$50M pre-money", "$80M post"
  round_type?: string;          // "Seed", "Series A", "Bridge"
  raise_amount?: string;        // Total raise: "$5M"
  pre_money_valuation?: string; // Explicit pre-money
  post_money_valuation?: string;// Explicit post-money
  equity_offered?: string;      // "10%", "15-20%"
  use_of_proceeds?: string;     // "Hire 10 engineers, expand to US"
  current_arr?: string;         // "$1.2M ARR"
  mrr?: string;                 // "$100K MRR"
  burn_rate?: string;           // "$200K/mo"
  runway_months?: number;       // Months of runway remaining
  revenue_growth?: string;      // "15% MoM", "3x YoY"
  gross_margin?: string;        // "72%"
  team_size?: number;           // Current headcount
  key_hires_planned?: string;   // "CTO, VP Sales"
  previous_rounds?: string;     // "Pre-seed: $500K from angels"
  cap_table_notes?: string;     // "Founders own 80%, ESOP 10%"
  existing_investors?: string;  // "Sequoia, Y Combinator"
  board_seats?: string;         // "1 investor seat offered"
  timeline?: string;            // "Closing by March 2026"
  founder_notes?: string;       // Free-form founder context
}

export interface DealInput {
  name: string;
  domain?: string;
  firm_type?: FirmType;
  aum?: string;
  deal_terms?: DealTerms;
  fund_config: any;
  persona_config: any;
}

export interface Evidence {
  evidence_id: string;
  title?: string;
  snippet: string;
  source: string;
  url?: string;
  retrieved_at: string;
}

export interface Hypothesis {
  id: string;
  text: string;
  support_evidence_ids: string[];
  risks: string[];
}

export interface RubricDimension {
  score: number;
  reasons: string[];
}

export interface Rubric {
  market: RubricDimension;
  moat: RubricDimension;
  why_now: RubricDimension;
  execution: RubricDimension;
  deal_fit: RubricDimension;
}

export interface DecisionGate {
  decision: 'KILL' | 'PROCEED' | 'PROCEED_IF';
  gating_questions: string[];
  evidence_checklist: {
    q: number;
    item: string;
    type: 'EVIDENCE' | 'ASSUMPTION';
    evidence_ids: string[];
  }[];
}

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
  investors: string[];
  investor_count: number;
  funding_total_usd: number | null;
  funding_last_round_type: string | null;
  funding_last_round_usd: number | null;
  patent_count: number;
  trademark_count: number;
  award_count: number;
  web_monthly_visits: number | null;
  web_global_rank: number | null;
  linkedin_followers: number | null;
  twitter_followers: number | null;
  founder_count: number;
  founders: string[];
  traction_metrics: any;
  hq_city: string | null;
  hq_country: string | null;
}

export interface TriggerSuggestion {
  category: string;
  label: string;
  query: string;
  baseline_answer: string;
  evidence_count: number;
  has_data: boolean;
  activated?: boolean;
  trigger_id?: string;
}

export interface DealState {
  deal_input: DealInput;
  evidence: Evidence[];
  company_profile: CompanyProfile | null;
  hypotheses: Hypothesis[];
  rubric: Rubric;
  decision_gate: DecisionGate;
  trigger_suggestions?: TriggerSuggestion[];
}

export type EventType = 
  | 'NODE_STARTED' 
  | 'MSG_SENT' 
  | 'NODE_DONE' 
  | 'EVIDENCE_ADDED' 
  | 'COMPANY_PROFILE_ADDED'
  | 'STATE_PATCH' 
  | 'DECISION_UPDATED' 
  | 'TRIGGER_SUGGESTIONS_READY'
  | 'LIVE_UPDATE'
  | 'ERROR';

export interface DealEvent {
  ts: string;
  deal_id: string;
  type: EventType;
  payload: any;
}
