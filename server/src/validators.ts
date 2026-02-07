import { z } from 'zod';

// ─── AnalystOutput ──────────────────────────────────────────────────────
// Spec: context/04_DATA_MODELS_AND_EVENTS.md + context/06_VALIDATION_NO_SLOP.md

const FactItem = z.object({
  text: z.string().min(1),
  evidence_ids: z.array(z.string())
});

const ContradictionItem = z.object({
  text: z.string().min(1),
  evidence_ids: z.array(z.string())
});

const UnknownItem = z.object({
  question: z.string().min(1),
  why: z.string().min(1)
});

const EvidenceRequest = z.object({
  query: z.string().min(1),
  reason: z.string().min(1)
});

export const AnalystOutputSchema = z.object({
  facts: z.array(FactItem).max(12),
  contradictions: z.array(ContradictionItem).max(8),
  unknowns: z.array(UnknownItem).max(8),
  evidence_requests: z.array(EvidenceRequest)
});
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

// ─── AssociateOutput ────────────────────────────────────────────────────

const HypothesisItem = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  support_evidence_ids: z.array(z.string()),
  risks: z.array(z.string())
});

const TopUnknown = z.object({
  question: z.string().min(1),
  why_it_matters: z.string().min(1)
});

const AnalystRequest = z.object({
  specialization: z.string().min(1),
  question: z.string().min(1)
});

export const AssociateOutputSchema = z.object({
  hypotheses: z.array(HypothesisItem).max(6),
  top_unknowns: z.array(TopUnknown),
  requests_to_analysts: z.array(AnalystRequest)
});
export type AssociateOutput = z.infer<typeof AssociateOutputSchema>;

// ─── PartnerOutput ──────────────────────────────────────────────────────

const RubricDimension = z.object({
  score: z.number().int().min(0).max(100),
  reasons: z.array(z.string()).max(4)
});

const RubricSchema = z.object({
  market: RubricDimension,
  moat: RubricDimension,
  why_now: RubricDimension,
  execution: RubricDimension,
  deal_fit: RubricDimension
});

const ChecklistItem = z.object({
  q: z.number().int().min(1).max(3),
  item: z.string().min(1),
  type: z.enum(['EVIDENCE', 'ASSUMPTION']),
  evidence_ids: z.array(z.string())
});

const DecisionGateSchema = z.object({
  decision: z.enum(['KILL', 'PROCEED', 'PROCEED_IF']),
  gating_questions: z.array(z.string().min(1)).length(3),
  evidence_checklist: z.array(ChecklistItem).max(15)
});

export const PartnerOutputSchema = z.object({
  rubric: RubricSchema,
  decision_gate: DecisionGateSchema
});
export type PartnerOutput = z.infer<typeof PartnerOutputSchema>;

// ─── Evidence rule enforcement ──────────────────────────────────────────
// Spec (06_VALIDATION_NO_SLOP.md): facts asserting a claim with no evidence_ids
// must be converted to ASSUMPTION in the checklist.

export function enforceEvidenceRule(output: PartnerOutput): PartnerOutput {
  const result = { ...output, decision_gate: { ...output.decision_gate } };
  const checklist = [...result.decision_gate.evidence_checklist];
  let hasNewAssumptions = false;

  // Check checklist items marked EVIDENCE that have no evidence_ids
  for (let i = 0; i < checklist.length; i++) {
    if (checklist[i].type === 'EVIDENCE' && checklist[i].evidence_ids.length === 0) {
      checklist[i] = { ...checklist[i], type: 'ASSUMPTION' };
      hasNewAssumptions = true;
    }
  }

  result.decision_gate.evidence_checklist = checklist;

  // If too many assumptions, force decision to PROCEED_IF or KILL
  const assumptionCount = checklist.filter(c => c.type === 'ASSUMPTION').length;
  if (assumptionCount > checklist.length / 2 && result.decision_gate.decision === 'PROCEED') {
    result.decision_gate.decision = 'PROCEED_IF';
  }

  return result;
}

// ─── Format errors for re-prompt ────────────────────────────────────────

export function formatValidationErrors(error: z.ZodError): string {
  return error.issues.map(issue => {
    const path = issue.path.join('.');
    return `- ${path ? path + ': ' : ''}${issue.message}`;
  }).join('\n');
}
