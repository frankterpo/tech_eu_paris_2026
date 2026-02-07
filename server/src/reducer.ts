import { DealState, DealEvent, Evidence } from './types';

/**
 * Pure reducer: given current state + a persisted event, returns new state.
 * events.jsonl stores FULL payloads (not the SSE-trimmed ones), so this
 * function can reconstruct canonical state from an event replay.
 */
export function reduceState(state: DealState, event: DealEvent): DealState {
  const newState = { ...state };

  switch (event.type) {
    case 'EVIDENCE_ADDED':
      // Persisted payload: { items, evidence_items_count, last_evidence_id }
      if (event.payload.items && Array.isArray(event.payload.items)) {
        newState.evidence = [...newState.evidence, ...event.payload.items];
      }
      break;

    case 'COMPANY_PROFILE_ADDED':
      // Persisted payload: { profile: CompanyProfile }
      if (event.payload.profile) {
        newState.company_profile = event.payload.profile;
      }
      break;

    case 'DECISION_UPDATED':
      // Persisted payload: { decision, gating_questions, evidence_checklist? }
      newState.decision_gate = {
        ...newState.decision_gate,
        decision: event.payload.decision ?? newState.decision_gate.decision,
        gating_questions: event.payload.gating_questions ?? newState.decision_gate.gating_questions,
        evidence_checklist: event.payload.evidence_checklist ?? newState.decision_gate.evidence_checklist
      };
      break;

    case 'STATE_PATCH':
      if (event.payload.hypotheses) {
        newState.hypotheses = event.payload.hypotheses;
      }
      if (event.payload.rubric) {
        newState.rubric = { ...newState.rubric, ...event.payload.rubric };
      }
      break;

    // NODE_STARTED, MSG_SENT, NODE_DONE, ERROR — logged but don't mutate canonical state
    default:
      break;
  }

  return newState;
}
