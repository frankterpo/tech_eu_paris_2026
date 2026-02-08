import fs from 'fs';
import path from 'path';
import type { DealState, DealEvent, DealInput } from './types.js';
import * as db from './db.js';

// Resolve data dir: try cwd first, fall back to /tmp if cwd is read-only
const CWD_DATA = path.join(process.cwd(), 'data/deals');
const TMP_DATA = '/tmp/dealbot/data/deals';

let DATA_DIR = CWD_DATA;
try {
  fs.mkdirSync(CWD_DATA, { recursive: true });
} catch {
  console.warn(`[Persistence] Cannot write to ${CWD_DATA} — falling back to ${TMP_DATA}`);
  DATA_DIR = TMP_DATA;
  fs.mkdirSync(TMP_DATA, { recursive: true });
}
console.log(`[Persistence] DATA_DIR = ${DATA_DIR} (cwd = ${process.cwd()})`);

export class PersistenceManager {
  // ── Current run context (set by orchestrator at the start of each run) ──
  private static currentRunId: string | null = null;
  private static currentSessionId: string | null = null;

  static setRunContext(runId: string, sessionId?: string) {
    this.currentRunId = runId;
    this.currentSessionId = sessionId || null;
  }

  static getRunId(): string | null { return this.currentRunId; }
  static getSessionId(): string | null { return this.currentSessionId; }

  private static ensureDealDir(dealId: string) {
    const dir = path.join(DATA_DIR, dealId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  // ── Deal creation ────────────────────────────────────────────────
  static createDeal(dealId: string, input: DealInput, userId?: string) {
    this.ensureDealDir(dealId);
    db.upsertDeal({
      id: dealId,
      name: input.name,
      domain: input.domain,
      stage: input.fund_config?.stage,
      sector: input.fund_config?.sector,
      geo: input.fund_config?.geo,
      status: 'created',
      deal_input_json: JSON.stringify(input),
      created_by: userId,
    });
  }

  // ── Deal Run lifecycle ───────────────────────────────────────────
  static startRun(dealId: string, opts?: { userId?: string; sessionId?: string; config?: any }): string {
    const runId = db.createRun(dealId, {
      triggered_by: opts?.userId,
      session_id: opts?.sessionId || this.currentSessionId || undefined,
      config_json: opts?.config ? JSON.stringify(opts.config) : undefined,
    });
    this.setRunContext(runId, opts?.sessionId);
    return runId;
  }

  static completeRun(result: { decision?: string; avg_score?: number; duration_ms?: number; error_msg?: string }) {
    if (this.currentRunId) {
      db.completeRun(this.currentRunId, result);
    }
  }

  // ── Events ───────────────────────────────────────────────────────
  static saveEvent(dealId: string, event: DealEvent) {
    // File
    const dir = this.ensureDealDir(dealId);
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
    // SQLite — UUID-keyed, linked to run
    db.insertEvent({
      deal_id: dealId,
      run_id: this.currentRunId || undefined,
      type: event.type,
      node_id: event.payload?.node_id || event.payload?.from || undefined,
      payload_json: JSON.stringify(event.payload),
      ts: event.ts,
    });
  }

  // ── State ────────────────────────────────────────────────────────
  static saveState(dealId: string, state: DealState) {
    // File
    const dir = this.ensureDealDir(dealId);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));

    // SQLite — update deal summary
    const avgScore = state.rubric
      ? Math.round(Object.values(state.rubric).reduce((s: number, d: any) => s + (d?.score || 0), 0) / 5)
      : undefined;
    db.upsertDeal({
      id: dealId,
      name: state.deal_input.name,
      domain: state.deal_input.domain,
      latest_decision: state.decision_gate?.decision,
      latest_avg_score: avgScore,
      status: state.decision_gate?.decision ? 'complete' : 'running',
      evidence_count: state.evidence?.length,
      hypothesis_count: state.hypotheses?.length,
    });

    // Bulk upsert evidence with run context
    if (state.evidence?.length > 0) {
      db.bulkUpsertEvidence(dealId, this.currentRunId, state.evidence);
    }

    // Upsert rubric scores individually
    if (state.rubric) {
      for (const [dim, val] of Object.entries(state.rubric)) {
        if (val && typeof (val as any).score === 'number') {
          db.upsertRubricScore({
            deal_id: dealId,
            run_id: this.currentRunId || undefined,
            dimension: dim,
            score: (val as any).score,
            reasons_json: (val as any).reasons ? JSON.stringify((val as any).reasons) : undefined,
            scored_by: 'partner',
          });
        }
      }
    }

    // Upsert hypotheses
    if (state.hypotheses?.length > 0) {
      for (const h of state.hypotheses) {
        db.insertHypothesis({
          deal_id: dealId,
          run_id: this.currentRunId || undefined,
          hypothesis_id: h.id,
          text: h.text,
          support_evidence_ids: h.support_evidence_ids ? JSON.stringify(h.support_evidence_ids) : undefined,
          risks_json: h.risks ? JSON.stringify(h.risks) : undefined,
          created_by: 'associate',
        });
      }
    }
  }

  static getState(dealId: string): DealState | null {
    const filePath = path.join(DATA_DIR, dealId, 'state.json');
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  /** Archive previous run into runs/<timestamp>/ then reset for a fresh run. */
  static resetRun(dealId: string, currentState: DealState) {
    const dir = path.join(DATA_DIR, dealId);
    if (!fs.existsSync(dir)) return;

    // ── 1. Archive previous run artifacts ────────────────────────
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveDir = path.join(dir, 'runs', ts);
    fs.mkdirSync(archiveDir, { recursive: true });

    const files = fs.readdirSync(dir);
    for (const f of files) {
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile()) continue; // skip dirs (runs/)
      if (f.startsWith('mem_node_') || f.startsWith('mem_edge_') || f === 'memo.json' || f === 'events.jsonl' || f === 'state.json') {
        fs.copyFileSync(full, path.join(archiveDir, f));
      }
    }
    console.log(`[Archive] Saved previous run → runs/${ts} (${dealId})`);

    // ── 2. Clear current run artifacts ───────────────────────────
    for (const f of files) {
      if (f.startsWith('mem_node_') || f.startsWith('mem_edge_') || f === 'memo.json') {
        fs.unlinkSync(path.join(dir, f));
      }
    }
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '');

    // ── 3. Fresh state — keep deal_input + company_profile ───────
    const freshState: any = {
      deal_input: currentState.deal_input,
      evidence: [],
      company_profile: currentState.company_profile || null,
      hypotheses: [],
      rubric: {},
      decision_gate: { decision: '', gating_questions: [], evidence_checklist: [] },
      trigger_suggestions: currentState.trigger_suggestions || [],
    };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(freshState, null, 2));
    console.log(`[Reset] Fresh state ready for deal ${dealId}`);
  }

  /** List all archived runs for a deal, newest first. */
  static listRuns(dealId: string): { ts: string; files: string[] }[] {
    const runsDir = path.join(DATA_DIR, dealId, 'runs');
    if (!fs.existsSync(runsDir)) return [];
    return fs.readdirSync(runsDir)
      .filter(d => fs.statSync(path.join(runsDir, d)).isDirectory())
      .sort().reverse()
      .map(ts => ({
        ts,
        files: fs.readdirSync(path.join(runsDir, ts)),
      }));
  }

  /** Get archived state for a specific run. */
  static getArchivedState(dealId: string, runTs: string): DealState | null {
    const fp = path.join(DATA_DIR, dealId, 'runs', runTs, 'state.json');
    if (!fs.existsSync(fp)) return null;
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
  }

  // ── Node / Edge memory (file only — ephemeral per run) ────────
  static saveNodeMemory(dealId: string, nodeId: string, memory: any) {
    const dir = this.ensureDealDir(dealId);
    fs.writeFileSync(path.join(dir, `mem_node_${nodeId}.json`), JSON.stringify(memory, null, 2));
  }

  static saveEdgeMemory(dealId: string, from: string, to: string, memory: any) {
    const dir = this.ensureDealDir(dealId);
    fs.writeFileSync(path.join(dir, `mem_edge_${from}_${to}.json`), JSON.stringify(memory, null, 2));
  }

  static getNodeMemory(dealId: string, nodeId: string): any | null {
    const filePath = path.join(DATA_DIR, dealId, `mem_node_${nodeId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
  }

  // ── Memos ────────────────────────────────────────────────────────
  static saveMemo(dealId: string, slides: any[]) {
    // File
    const dir = this.ensureDealDir(dealId);
    fs.writeFileSync(path.join(dir, 'memo.json'), JSON.stringify(slides, null, 2));
    // SQLite — versioned per run
    db.saveMemo(dealId, this.currentRunId, JSON.stringify(slides), slides.length);
  }

  static getMemo(dealId: string): any[] | null {
    const filePath = path.join(DATA_DIR, dealId, 'memo.json');
    if (!fs.existsSync(filePath)) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
  }

  // ── Persona outputs ──────────────────────────────────────────────
  static savePersona(p: {
    dealId: string; personaType: string; personaId: string;
    specialization?: string; status: string; output?: any; rawResponse?: string;
    validationOk?: boolean; retryCount?: number; latencyMs?: number;
    difyToolCalls?: number; errorMsg?: string; startedAt?: string; completedAt?: string;
  }): string {
    return db.upsertPersona({
      deal_id: p.dealId,
      run_id: this.currentRunId || undefined,
      persona_type: p.personaType,
      persona_id: p.personaId,
      specialization: p.specialization,
      status: p.status,
      output_json: p.output ? JSON.stringify(p.output) : undefined,
      raw_response: p.rawResponse,
      validation_ok: p.validationOk,
      retry_count: p.retryCount,
      fact_count: p.output?.facts?.length,
      unknown_count: p.output?.unknowns?.length,
      latency_ms: p.latencyMs,
      dify_tool_calls: p.difyToolCalls,
      error_msg: p.errorMsg,
      started_at: p.startedAt,
      completed_at: p.completedAt,
    });
  }

  // ── Tool Actions ─────────────────────────────────────────────────
  static startToolAction(p: {
    dealId?: string; toolName: string; provider: string;
    operation?: string; input?: any; calledBy?: string;
  }): string {
    return db.startToolAction({
      deal_id: p.dealId,
      run_id: this.currentRunId || undefined,
      session_id: this.currentSessionId || undefined,
      tool_name: p.toolName,
      provider: p.provider,
      operation: p.operation,
      input_json: p.input ? JSON.stringify(p.input) : undefined,
      called_by: p.calledBy,
    });
  }

  static completeToolAction(actionId: string, result: {
    status: 'success' | 'error' | 'timeout';
    output?: any; errorMsg?: string; latencyMs?: number; resultCount?: number;
  }) {
    db.completeToolAction(actionId, {
      status: result.status,
      output_json: result.output ? JSON.stringify(result.output).slice(0, 8000) : undefined,
      error_msg: result.errorMsg,
      latency_ms: result.latencyMs,
      result_count: result.resultCount,
    });
  }

  // ── Queries ──────────────────────────────────────────────────────
  static logQuery(q: {
    dealId?: string; toolActionId?: string; queryText: string;
    queryType?: string; provider?: string; resultCount?: number;
    answerText?: string; latencyMs?: number;
  }): string {
    return db.insertQuery({
      deal_id: q.dealId,
      run_id: this.currentRunId || undefined,
      tool_action_id: q.toolActionId,
      query_text: q.queryText,
      query_type: q.queryType,
      provider: q.provider,
      result_count: q.resultCount,
      answer_text: q.answerText,
      latency_ms: q.latencyMs,
    });
  }

  // ── Company profile caching ──────────────────────────────────────
  static cacheCompanyProfile(profile: any) { db.cacheCompanyProfile(profile); }
  static getCachedProfile(specterId: string) { return db.getCachedProfile(specterId); }

  // ── Triggers ─────────────────────────────────────────────────────
  private static get triggersDir() { return path.join(DATA_DIR, '../triggers'); }

  static saveTrigger(trigger: any) {
    // File
    const dir = this.triggersDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${trigger.id}.json`), JSON.stringify(trigger, null, 2));
    // SQLite
    db.upsertTrigger({
      id: trigger.id,
      deal_id: trigger.deal_id,
      cala_id: trigger.cala_id,
      created_by: trigger.created_by,
      name: trigger.name || trigger.query,
      query: trigger.query,
      answer_baseline: trigger.answer_baseline,
      category: trigger.category,
      company: trigger.company,
      domain: trigger.domain,
      status: trigger.status || 'active',
    });
    if (trigger.email) {
      db.upsertTriggerNotification({ trigger_id: trigger.id, type: 'email', target: trigger.email });
    }
    if (trigger.webhookUrl) {
      db.upsertTriggerNotification({ trigger_id: trigger.id, type: 'webhook', target: trigger.webhookUrl });
    }
  }

  static getTrigger(id: string): any | null {
    const fp = path.join(this.triggersDir, `${id}.json`);
    if (!fs.existsSync(fp)) return null;
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
  }

  static listTriggers(): any[] {
    const dir = this.triggersDir;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { return null; } })
      .filter(Boolean);
  }

  static deleteTrigger(id: string) {
    const fp = path.join(this.triggersDir, `${id}.json`);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  /** Read LIVE_UPDATE events for narration/thinking excerpts. */
  static getLiveUpdates(dealId: string): Array<{ phase: string; text: string; ts: string }> {
    const filePath = path.join(DATA_DIR, dealId, 'events.jsonl');
    if (!fs.existsSync(filePath)) return [];
    try {
      return fs.readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(line => line.trim())
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter((e: any) => e && e.type === 'LIVE_UPDATE')
        .map((e: any) => ({ phase: e.payload.phase, text: e.payload.text, ts: e.ts }));
    } catch { return []; }
  }

  // ── Trigger Suggestions ────────────────────────────────────────────
  static saveTriggerSuggestions(dealId: string, suggestions: {
    category: string; label: string; query: string; baseline_answer: string;
    evidence_json: string; evidence_count: number; has_data: boolean; latency_ms: number;
  }[]) {
    db.bulkInsertTriggerSuggestions(dealId, this.currentRunId, suggestions);
  }

  static getTriggerSuggestions(dealId: string) {
    return db.getTriggerSuggestions(dealId);
  }

  static activateTriggerSuggestion(suggestionId: string, triggerId: string) {
    db.activateTriggerSuggestion(suggestionId, triggerId);
  }

  // ── DB query helpers (pass-through) ──────────────────────────────
  static listDeals(opts?: { limit?: number; offset?: number; status?: string }) {
    const dbResult = db.listDeals(opts);
    if (dbResult && dbResult.length > 0) return dbResult;
    // File-based fallback: scan data/deals/ directories
    return this.listDealsFromFiles(opts?.limit || 50);
  }

  static findDealByNameOrDomain(query: string) {
    const dbResult = db.findDealByNameOrDomain(query);
    if (dbResult) return dbResult;
    // File-based fallback: scan deal state files
    return this.findDealFromFiles(query);
  }

  /** Scan data/deals/ for state.json files — used when DB is unavailable */
  private static listDealsFromFiles(limit: number): any[] {
    if (!fs.existsSync(DATA_DIR)) return [];
    try {
      const dirs = fs.readdirSync(DATA_DIR).filter(d => {
        const stateFile = path.join(DATA_DIR, d, 'state.json');
        return fs.existsSync(stateFile);
      });
      return dirs.slice(0, limit).map(id => {
        try {
          const state: DealState = JSON.parse(fs.readFileSync(path.join(DATA_DIR, id, 'state.json'), 'utf-8'));
          const avgScore = state.rubric
            ? Math.round(Object.values(state.rubric).reduce((s: number, d: any) => s + (d?.score || 0), 0) / 5)
            : 0;
          return {
            id,
            name: state.deal_input?.name || 'Unknown',
            domain: state.deal_input?.domain || '',
            stage: state.deal_input?.fund_config?.stage || '',
            status: state.decision_gate?.decision ? 'complete' : 'in_progress',
            latest_decision: state.decision_gate?.decision || null,
            latest_avg_score: avgScore || null,
            evidence_count: state.evidence?.length || 0,
          };
        } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  /** Scan data/deals/ for a deal matching name or domain */
  private static findDealFromFiles(query: string): any | null {
    if (!fs.existsSync(DATA_DIR)) return null;
    const q = query.trim().toLowerCase();
    try {
      const dirs = fs.readdirSync(DATA_DIR);
      for (const id of dirs) {
        const stateFile = path.join(DATA_DIR, id, 'state.json');
        if (!fs.existsSync(stateFile)) continue;
        try {
          const state: DealState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          const name = (state.deal_input?.name || '').toLowerCase();
          const domain = (state.deal_input?.domain || '').toLowerCase();
          if (domain === q || name === q || name.includes(q) || domain.includes(q)) {
            const avgScore = state.rubric
              ? Math.round(Object.values(state.rubric).reduce((s: number, d: any) => s + (d?.score || 0), 0) / 5)
              : 0;
            return {
              id,
              name: state.deal_input?.name || 'Unknown',
              domain: state.deal_input?.domain || '',
              stage: state.deal_input?.fund_config?.stage || '',
              status: state.decision_gate?.decision ? 'complete' : 'in_progress',
              latest_decision: state.decision_gate?.decision || null,
              latest_avg_score: avgScore || null,
              evidence_count: state.evidence?.length || 0,
            };
          }
        } catch { continue; }
      }
    } catch { /* ignore */ }
    return null;
  }

  static getDealStats() { return db.getDealStats(); }
  static getToolStats() { return db.getToolStats(); }

  static searchEvidence(query: string, opts?: { deal_id?: string; source?: string; provider?: string; limit?: number }) {
    return db.searchEvidence(query, opts);
  }

  static getEvidenceByDeal(dealId: string, runId?: string) {
    return db.getEvidenceByDeal(dealId, runId);
  }

  static getEventHistory(dealId: string, opts?: { type?: string; run_id?: string; limit?: number }) {
    return db.getEventsByDeal(dealId, opts);
  }

  static getRunHistory(dealId: string) { return db.getRunsByDeal(dealId); }
  static getPersonasByRun(runId: string) { return db.getPersonasByRun(runId); }
  static getRubricByDeal(dealId: string, runId?: string) { return db.getRubricByDeal(dealId, runId); }
  static getQueriesByDeal(dealId: string) { return db.getQueriesByDeal(dealId); }
  static getMemoHistory(dealId: string) { return db.getMemoHistory(dealId); }

  // ── Users & Sessions ──────────────────────────────────────────────
  static upsertUser(user: { id?: string; name?: string; email?: string; role?: string }) { return db.upsertUser(user); }
  static getUser(id: string) { return db.getUser(id); }
  static getUserByEmail(email: string) { return db.getUserByEmail(email); }
  static createSession(userId?: string, metadata?: any) { return db.createSession(userId, metadata); }
  static endSession(sessionId: string) { db.endSession(sessionId); }

  static isDatabaseAvailable() { return db.dbAvailable(); }
}
