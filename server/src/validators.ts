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

// ─── Coerce raw LLM output before Zod validation ────────────────────────
// LLMs (especially gpt-4o-mini) often return almost-valid output.
// This normalizes common deviations so validation succeeds on first attempt.

const DECISION_MAP: Record<string, 'KILL' | 'PROCEED' | 'PROCEED_IF'> = {
  KILL: 'KILL', PASS: 'KILL', NO: 'KILL', REJECT: 'KILL',
  PROCEED: 'PROCEED', YES: 'PROCEED', STRONG_YES: 'PROCEED', APPROVE: 'PROCEED',
  PROCEED_IF: 'PROCEED_IF', CONDITIONAL: 'PROCEED_IF', MAYBE: 'PROCEED_IF',
};

export function coercePartnerOutput(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  const out = structuredClone(raw);

  if (out.decision_gate && typeof out.decision_gate === 'object') {
    const dg = out.decision_gate;

    // Normalize decision value
    if (typeof dg.decision === 'string') {
      const key = dg.decision.toUpperCase().replace(/[^A-Z_]/g, '');
      dg.decision = DECISION_MAP[key] || 'PROCEED_IF';
    }

    // Cap gating_questions to exactly 3
    if (Array.isArray(dg.gating_questions)) {
      if (dg.gating_questions.length > 3) {
        dg.gating_questions = dg.gating_questions.slice(0, 3);
      }
      while (dg.gating_questions.length < 3) {
        dg.gating_questions.push('Additional due diligence required');
      }
    }

    // Clamp evidence_checklist q values to 1-3 and cap at 15
    if (Array.isArray(dg.evidence_checklist)) {
      dg.evidence_checklist = dg.evidence_checklist.slice(0, 15).map((item: any) => ({
        ...item,
        q: typeof item.q === 'number' ? Math.max(1, Math.min(3, item.q)) : 1,
        evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids : [],
      }));
    }
  }

  // Cap rubric reasons to 4 per dimension
  if (out.rubric && typeof out.rubric === 'object') {
    for (const dim of ['market', 'moat', 'why_now', 'execution', 'deal_fit']) {
      if (out.rubric[dim]?.reasons?.length > 4) {
        out.rubric[dim].reasons = out.rubric[dim].reasons.slice(0, 4);
      }
    }
  }

  return out;
}

export function coerceAnalystOutput(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  const out = structuredClone(raw);
  if (Array.isArray(out.facts) && out.facts.length > 12) out.facts = out.facts.slice(0, 12);
  if (Array.isArray(out.contradictions) && out.contradictions.length > 8) out.contradictions = out.contradictions.slice(0, 8);
  if (Array.isArray(out.unknowns) && out.unknowns.length > 8) out.unknowns = out.unknowns.slice(0, 8);
  return out;
}

export function coerceAssociateOutput(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  const out = structuredClone(raw);
  if (Array.isArray(out.hypotheses) && out.hypotheses.length > 6) out.hypotheses = out.hypotheses.slice(0, 6);
  return out;
}

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
