export interface DealInput {
  name: string;
  domain?: string;
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

export interface DealState {
  deal_input: DealInput;
  evidence: Evidence[];
  company_profile: CompanyProfile | null;
  hypotheses: Hypothesis[];
  rubric: Rubric;
  decision_gate: DecisionGate;
}

export type EventType = 
  | 'NODE_STARTED' 
  | 'MSG_SENT' 
  | 'NODE_DONE' 
  | 'EVIDENCE_ADDED' 
  | 'COMPANY_PROFILE_ADDED'
  | 'STATE_PATCH' 
  | 'DECISION_UPDATED' 
  | 'LIVE_UPDATE'
  | 'ERROR';

export interface DealEvent {
  ts: string;
  deal_id: string;
  type: EventType;
  payload: any;
}
