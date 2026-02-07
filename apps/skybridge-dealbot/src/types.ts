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

export interface DealState {
  deal_input: DealInput;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  rubric: Rubric;
  decision_gate: DecisionGate;
}

export type EventType = 
  | 'NODE_STARTED' 
  | 'MSG_SENT' 
  | 'NODE_DONE' 
  | 'EVIDENCE_ADDED' 
  | 'STATE_PATCH' 
  | 'DECISION_UPDATED' 
  | 'ERROR';

export interface DealEvent {
  ts: string;
  deal_id: string;
  type: EventType;
  payload: any;
}
