/**
 * SQLite database — robust, UUID-keyed, fully normalized.
 *
 * Tables:
 *   users            — operator/analyst identities
 *   sessions         — each user interaction session
 *   deals            — deal records (company under review)
 *   deal_runs        — each simulation run of a deal (can re-run)
 *   events           — every orchestration event (UUID PK)
 *   evidence         — every evidence item across all deals
 *   tool_actions     — every external API call (Cala, Specter, Tavily, Dify…)
 *   queries          — every search/query issued (Cala search, Specter enrich…)
 *   personas         — analyst/associate/partner persona outputs per run
 *   rubric_scores    — individual rubric dimension scores per run
 *   hypotheses       — associate hypotheses per run
 *   triggers         — Cala Beta trigger records
 *   trigger_notifications — notification channels per trigger
 *   memos            — investment memo slides per run
 *   company_profiles — cached Specter company profiles
 *
 * All PKs are UUIDs (TEXT). All timestamps are ISO-8601 TEXT.
 * File: data/dealbot.sqlite (WAL mode, foreign keys enforced)
 */
import path from 'path';
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// Dynamic import of better-sqlite3 — native module may not be available on all platforms (e.g., Alpic containers).
// If it fails to load, the entire DB layer becomes a no-op and file persistence is the sole source of truth.
let DatabaseConstructor: any = null;
try {
  DatabaseConstructor = (await import('better-sqlite3')).default;
} catch (err: any) {
  console.warn(`[DB] better-sqlite3 not available (${err.message}) — running in file-only mode`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'dealbot.sqlite');

let db: any = null;

function getDb(): any {
  if (db) return db;
  if (!DatabaseConstructor) return null;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseConstructor(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF'); // OFF during hackathon — file persistence is source of truth
    initSchema(db);
    console.log(`[DB] SQLite initialized: ${DB_PATH}`);
    return db;
  } catch (err: any) {
    console.warn(`[DB] SQLite init failed (${err.message}) — falling back to file-only persistence`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════════════

function initSchema(db: any) {
  db.exec(`
    -- ── Users ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,  -- UUID
      name        TEXT,
      email       TEXT UNIQUE,
      role        TEXT DEFAULT 'operator',  -- operator | admin | viewer
      avatar_url  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Sessions ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,  -- UUID
      user_id     TEXT REFERENCES users(id),
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at    TEXT,
      metadata_json TEXT  -- browser info, IP, etc.
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- ── Deals ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS deals (
      id              TEXT PRIMARY KEY,  -- UUID
      created_by      TEXT REFERENCES users(id),
      name            TEXT NOT NULL,
      domain          TEXT,
      stage           TEXT,
      sector          TEXT,
      geo             TEXT,
      description     TEXT,
      status          TEXT NOT NULL DEFAULT 'created',  -- created | running | complete | error | archived
      latest_decision TEXT,    -- KILL | PROCEED | PROCEED_IF
      latest_avg_score INTEGER,
      evidence_count  INTEGER DEFAULT 0,
      hypothesis_count INTEGER DEFAULT 0,
      run_count       INTEGER DEFAULT 0,
      deal_input_json TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
    CREATE INDEX IF NOT EXISTS idx_deals_domain ON deals(domain);
    CREATE INDEX IF NOT EXISTS idx_deals_created_by ON deals(created_by);

    -- ── Deal Runs (each simulation execution) ──────────────────────
    CREATE TABLE IF NOT EXISTS deal_runs (
      id          TEXT PRIMARY KEY,  -- UUID
      deal_id     TEXT NOT NULL REFERENCES deals(id),
      run_number  INTEGER NOT NULL DEFAULT 1,
      triggered_by TEXT REFERENCES users(id),
      session_id  TEXT REFERENCES sessions(id),
      status      TEXT NOT NULL DEFAULT 'running',  -- running | complete | error | cancelled
      decision    TEXT,
      avg_score   INTEGER,
      duration_ms INTEGER,
      error_msg   TEXT,
      config_json TEXT,  -- fund_config + persona_config snapshot
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_deal ON deal_runs(deal_id);

    -- ── Events ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS events (
      id            TEXT PRIMARY KEY,  -- UUID
      deal_id       TEXT NOT NULL REFERENCES deals(id),
      run_id        TEXT REFERENCES deal_runs(id),
      type          TEXT NOT NULL,  -- NODE_STARTED, MSG_SENT, NODE_DONE, EVIDENCE_ADDED, etc.
      node_id       TEXT,           -- analyst_1, associate, partner, orchestrator
      payload_json  TEXT,
      ts            TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_deal ON events(deal_id);
    CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

    -- ── Evidence ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS evidence (
      id            TEXT PRIMARY KEY,  -- evidence_id (UUID or provider-prefixed)
      deal_id       TEXT NOT NULL REFERENCES deals(id),
      run_id        TEXT REFERENCES deal_runs(id),
      title         TEXT,
      snippet       TEXT,
      source        TEXT NOT NULL,  -- cala, specter, specter-competitive, tavily, dify, manual
      provider      TEXT,           -- cala | specter | tavily | dify | manual
      url           TEXT,
      confidence    REAL,           -- 0.0-1.0 if available
      metadata_json TEXT,           -- provider-specific raw data
      retrieved_at  TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_deal ON evidence(deal_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence(source);
    CREATE INDEX IF NOT EXISTS idx_evidence_provider ON evidence(provider);

    -- ── Tool Actions (every external API call) ─────────────────────
    CREATE TABLE IF NOT EXISTS tool_actions (
      id            TEXT PRIMARY KEY,  -- UUID
      deal_id       TEXT REFERENCES deals(id),
      run_id        TEXT REFERENCES deal_runs(id),
      session_id    TEXT REFERENCES sessions(id),
      tool_name     TEXT NOT NULL,     -- calaSearch, specterEnrich, tavilyWebSearch, difyRunAgent…
      provider      TEXT NOT NULL,     -- cala | specter | tavily | dify | lightpanda | fal
      operation     TEXT,              -- search, enrich, similar, people, query, crawl, research…
      input_json    TEXT,              -- request params (keys redacted)
      output_json   TEXT,              -- response summary (truncated)
      status        TEXT NOT NULL DEFAULT 'pending',  -- pending | success | error | timeout
      error_msg     TEXT,
      latency_ms    INTEGER,
      result_count  INTEGER,           -- how many items returned
      called_by     TEXT,              -- orchestrator | analyst_1 | associate | user | dify-agent
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_deal ON tool_actions(deal_id);
    CREATE INDEX IF NOT EXISTS idx_tool_run ON tool_actions(run_id);
    CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_actions(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_provider ON tool_actions(provider);
    CREATE INDEX IF NOT EXISTS idx_tool_status ON tool_actions(status);

    -- ── Queries (every search/query for auditing) ──────────────────
    CREATE TABLE IF NOT EXISTS queries (
      id            TEXT PRIMARY KEY,  -- UUID
      deal_id       TEXT REFERENCES deals(id),
      run_id        TEXT REFERENCES deal_runs(id),
      tool_action_id TEXT REFERENCES tool_actions(id),
      query_text    TEXT NOT NULL,
      query_type    TEXT,    -- search | query | enrich | similar | people | extract | crawl | research
      provider      TEXT,    -- cala | specter | tavily
      result_count  INTEGER,
      answer_text   TEXT,    -- AI-generated answer if applicable (Cala content, Tavily answer)
      latency_ms    INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_queries_deal ON queries(deal_id);
    CREATE INDEX IF NOT EXISTS idx_queries_type ON queries(query_type);

    -- ── Personas (analyst/associate/partner outputs per run) ────────
    CREATE TABLE IF NOT EXISTS personas (
      id              TEXT PRIMARY KEY,  -- UUID
      deal_id         TEXT NOT NULL REFERENCES deals(id),
      run_id          TEXT REFERENCES deal_runs(id),
      persona_type    TEXT NOT NULL,     -- analyst | associate | partner
      persona_id      TEXT,              -- analyst_1, analyst_2, analyst_3, associate, partner
      specialization  TEXT,              -- market | competition | traction (analysts only)
      status          TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error | degraded
      output_json     TEXT,              -- full validated output
      raw_response    TEXT,              -- raw Dify response before parsing
      validation_ok   BOOLEAN,
      retry_count     INTEGER DEFAULT 0,
      fact_count      INTEGER DEFAULT 0,
      unknown_count   INTEGER DEFAULT 0,
      latency_ms      INTEGER,
      dify_tool_calls INTEGER DEFAULT 0,
      error_msg       TEXT,
      started_at      TEXT,
      completed_at    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_personas_deal ON personas(deal_id);
    CREATE INDEX IF NOT EXISTS idx_personas_run ON personas(run_id);
    CREATE INDEX IF NOT EXISTS idx_personas_type ON personas(persona_type);

    -- ── Rubric Scores ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS rubric_scores (
      id          TEXT PRIMARY KEY,  -- UUID
      deal_id     TEXT NOT NULL REFERENCES deals(id),
      run_id      TEXT REFERENCES deal_runs(id),
      dimension   TEXT NOT NULL,     -- market | moat | why_now | execution | deal_fit
      score       INTEGER NOT NULL,  -- 0-100
      reasons_json TEXT,             -- JSON array of reason strings
      scored_by   TEXT,              -- partner persona_id
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(deal_id, run_id, dimension)
    );
    CREATE INDEX IF NOT EXISTS idx_rubric_deal ON rubric_scores(deal_id);

    -- ── Hypotheses ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS hypotheses (
      id                    TEXT PRIMARY KEY,  -- UUID
      deal_id               TEXT NOT NULL REFERENCES deals(id),
      run_id                TEXT REFERENCES deal_runs(id),
      hypothesis_id         TEXT,              -- h1, h2… from associate output
      text                  TEXT NOT NULL,
      support_evidence_ids  TEXT,              -- JSON array of evidence IDs
      risks_json            TEXT,              -- JSON array of risk strings
      created_by            TEXT,              -- associate persona_id
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hypotheses_deal ON hypotheses(deal_id);

    -- ── Triggers ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS triggers (
      id          TEXT PRIMARY KEY,  -- UUID (local) or Cala Beta trigger UUID
      deal_id     TEXT REFERENCES deals(id),
      cala_id     TEXT,              -- Cala Beta UUID if synced
      created_by  TEXT REFERENCES users(id),
      name        TEXT NOT NULL,
      query       TEXT NOT NULL,
      answer_baseline TEXT,          -- baseline from knowledge/search
      category    TEXT,              -- revenue_update | key_hire | deal_won | partnership | business_model
      company     TEXT,
      domain      TEXT,
      status      TEXT DEFAULT 'active',  -- active | paused | deleted
      last_checked_at TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_triggers_deal ON triggers(deal_id);
    CREATE INDEX IF NOT EXISTS idx_triggers_status ON triggers(status);

    -- ── Trigger Notifications ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS trigger_notifications (
      id          TEXT PRIMARY KEY,  -- UUID
      trigger_id  TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,     -- email | webhook
      target      TEXT NOT NULL,     -- email address or webhook URL
      cala_notification_id TEXT,     -- Cala Beta notification UUID if synced
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trg_notif_trigger ON trigger_notifications(trigger_id);

    -- ── Trigger Suggestions (pre-fetched Cala intel per deal) ──────
    CREATE TABLE IF NOT EXISTS trigger_suggestions (
      id            TEXT PRIMARY KEY,  -- UUID
      deal_id       TEXT NOT NULL REFERENCES deals(id),
      run_id        TEXT REFERENCES deal_runs(id),
      category      TEXT NOT NULL,     -- revenue_updates | business_model | partnerships | key_hires | deals_won | setbacks | staff_departures | key_events
      label         TEXT NOT NULL,     -- Human-readable: "Key Revenue Updates"
      query         TEXT NOT NULL,     -- The Cala query text (ready to become a trigger)
      baseline_answer TEXT,            -- Cala's current answer (baseline for trigger)
      evidence_json TEXT,              -- JSON array of evidence items
      evidence_count INTEGER DEFAULT 0,
      has_data      BOOLEAN DEFAULT 0,
      latency_ms    INTEGER,
      activated     BOOLEAN DEFAULT 0, -- 0 = suggestion only, 1 = trigger created
      trigger_id    TEXT REFERENCES triggers(id), -- link to actual trigger if activated
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trgsugg_deal ON trigger_suggestions(deal_id);
    CREATE INDEX IF NOT EXISTS idx_trgsugg_category ON trigger_suggestions(category);

    -- ── Company Profiles (cached Specter data) ─────────────────────
    CREATE TABLE IF NOT EXISTS company_profiles (
      id              TEXT PRIMARY KEY,  -- UUID
      specter_id      TEXT UNIQUE,
      name            TEXT NOT NULL,
      domain          TEXT,
      growth_stage    TEXT,
      employee_count  INTEGER,
      funding_total_usd REAL,
      hq_country      TEXT,
      hq_city         TEXT,
      industries_json TEXT,
      founders_json   TEXT,
      profile_json    TEXT,   -- full Specter profile blob
      fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at      TEXT    -- cache TTL
    );
    CREATE INDEX IF NOT EXISTS idx_cp_domain ON company_profiles(domain);
    CREATE INDEX IF NOT EXISTS idx_cp_specter ON company_profiles(specter_id);

    -- ── Memos ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS memos (
      id          TEXT PRIMARY KEY,  -- UUID
      deal_id     TEXT NOT NULL REFERENCES deals(id),
      run_id      TEXT REFERENCES deal_runs(id),
      slides_json TEXT NOT NULL,
      slide_count INTEGER DEFAULT 0,
      version     INTEGER DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memos_deal ON memos(deal_id);
  `);
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

export function newId(): string { return uuidv4(); }

export function dbAvailable(): boolean { return getDb() !== null; }

function now(): string { return new Date().toISOString(); }

function run(sql: string, params: any) {
  const d = getDb();
  if (!d) return;
  try { d.prepare(sql).run(params); } catch (err: any) { console.warn(`[DB] ${err.message}`); }
}

function get(sql: string, params?: any): any {
  const d = getDb();
  if (!d) return null;
  try { return d.prepare(sql).get(params) || null; } catch { return null; }
}

function all(sql: string, params?: any): any[] {
  const d = getDb();
  if (!d) return [];
  try { return d.prepare(sql).all(params); } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════════

export function upsertUser(user: { id?: string; name?: string; email?: string; role?: string }): string {
  const id = user.id || newId();
  run(`INSERT INTO users (id, name, email, role) VALUES (@id, @name, @email, @role)
       ON CONFLICT(id) DO UPDATE SET name=coalesce(@name, name), email=coalesce(@email, email), last_seen=datetime('now')`,
    { id, name: user.name || null, email: user.email || null, role: user.role || 'operator' });
  return id;
}

export function getUser(id: string) { return get(`SELECT * FROM users WHERE id = ?`, id); }
export function getUserByEmail(email: string) { return get(`SELECT * FROM users WHERE email = ?`, email); }

// ═══════════════════════════════════════════════════════════════════════
// SESSIONS
// ═══════════════════════════════════════════════════════════════════════

export function createSession(userId?: string, metadata?: any): string {
  const id = newId();
  run(`INSERT INTO sessions (id, user_id, metadata_json) VALUES (@id, @user_id, @metadata_json)`,
    { id, user_id: userId || null, metadata_json: metadata ? JSON.stringify(metadata) : null });
  return id;
}

export function endSession(sessionId: string) {
  run(`UPDATE sessions SET ended_at = datetime('now') WHERE id = ?`, sessionId);
}

// ═══════════════════════════════════════════════════════════════════════
// DEALS
// ═══════════════════════════════════════════════════════════════════════

export function upsertDeal(deal: {
  id: string; name: string; domain?: string; stage?: string; sector?: string; geo?: string;
  description?: string; status?: string; latest_decision?: string; latest_avg_score?: number;
  evidence_count?: number; hypothesis_count?: number; run_count?: number;
  deal_input_json?: string; created_by?: string;
}) {
  run(`INSERT INTO deals (id, created_by, name, domain, stage, sector, geo, description, status, latest_decision,
        latest_avg_score, evidence_count, hypothesis_count, run_count, deal_input_json)
       VALUES (@id, @created_by, @name, @domain, @stage, @sector, @geo, @description, @status, @latest_decision,
        @latest_avg_score, @evidence_count, @hypothesis_count, @run_count, @deal_input_json)
       ON CONFLICT(id) DO UPDATE SET
        name=@name, domain=coalesce(@domain, domain), stage=coalesce(@stage, stage),
        sector=coalesce(@sector, sector), geo=coalesce(@geo, geo),
        description=coalesce(@description, description),
        status=coalesce(@status, status),
        latest_decision=coalesce(@latest_decision, latest_decision),
        latest_avg_score=coalesce(@latest_avg_score, latest_avg_score),
        evidence_count=coalesce(@evidence_count, evidence_count),
        hypothesis_count=coalesce(@hypothesis_count, hypothesis_count),
        run_count=coalesce(@run_count, run_count),
        deal_input_json=coalesce(@deal_input_json, deal_input_json),
        updated_at=datetime('now')`,
    { ...deal, created_by: deal.created_by || null, domain: deal.domain || null,
      stage: deal.stage || null, sector: deal.sector || null, geo: deal.geo || null,
      description: deal.description || null, status: deal.status || 'created',
      latest_decision: deal.latest_decision || null, latest_avg_score: deal.latest_avg_score ?? null,
      evidence_count: deal.evidence_count ?? null, hypothesis_count: deal.hypothesis_count ?? null,
      run_count: deal.run_count ?? null, deal_input_json: deal.deal_input_json || null });
}

export function listDeals(opts?: { limit?: number; offset?: number; status?: string }): any[] {
  let sql = `SELECT id, name, domain, stage, sector, geo, status, latest_decision, latest_avg_score,
                    evidence_count, hypothesis_count, run_count, created_at, updated_at FROM deals`;
  const params: any = {};
  if (opts?.status) { sql += ` WHERE status = @status`; params.status = opts.status; }
  sql += ` ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`;
  params.limit = opts?.limit || 50;
  params.offset = opts?.offset || 0;
  return all(sql, params);
}

export function getDealFull(dealId: string) { return get(`SELECT * FROM deals WHERE id = ?`, dealId); }

export function findDealByNameOrDomain(query: string): any | null {
  const q = query.trim().toLowerCase();
  // Exact domain match first
  const byDomain = get(`SELECT id, name, domain, stage, sector, geo, status, latest_decision, latest_avg_score, evidence_count, run_count, created_at, updated_at FROM deals WHERE LOWER(domain) = ? ORDER BY updated_at DESC LIMIT 1`, q);
  if (byDomain) return byDomain;
  // Exact name match
  const byName = get(`SELECT id, name, domain, stage, sector, geo, status, latest_decision, latest_avg_score, evidence_count, run_count, created_at, updated_at FROM deals WHERE LOWER(name) = ? ORDER BY updated_at DESC LIMIT 1`, q);
  if (byName) return byName;
  // Fuzzy name match (LIKE) — use named params since get() accepts a single params object
  const pattern = `%${q}%`;
  const byLike = get(`SELECT id, name, domain, stage, sector, geo, status, latest_decision, latest_avg_score, evidence_count, run_count, created_at, updated_at FROM deals WHERE LOWER(name) LIKE @p OR LOWER(domain) LIKE @p ORDER BY updated_at DESC LIMIT 1`, { p: pattern });
  return byLike || null;
}

export function getDealStats(): { total: number; complete: number; avgScore: number; decisions: Record<string, number> } {
  const total = (get(`SELECT COUNT(*) as c FROM deals`) as any)?.c || 0;
  const complete = (get(`SELECT COUNT(*) as c FROM deals WHERE status = 'complete'`) as any)?.c || 0;
  const avgRow = get(`SELECT AVG(latest_avg_score) as a FROM deals WHERE latest_avg_score IS NOT NULL`) as any;
  const decRows = all(`SELECT latest_decision, COUNT(*) as c FROM deals WHERE latest_decision IS NOT NULL GROUP BY latest_decision`);
  const decisions: Record<string, number> = {};
  for (const r of decRows) decisions[(r as any).latest_decision] = (r as any).c;
  return { total, complete, avgScore: Math.round(avgRow?.a || 0), decisions };
}

// ═══════════════════════════════════════════════════════════════════════
// DEAL RUNS
// ═══════════════════════════════════════════════════════════════════════

export function createRun(dealId: string, opts?: { triggered_by?: string; session_id?: string; config_json?: string }): string {
  const id = newId();
  const runNum = ((get(`SELECT MAX(run_number) as n FROM deal_runs WHERE deal_id = ?`, dealId) as any)?.n || 0) + 1;
  run(`INSERT INTO deal_runs (id, deal_id, run_number, triggered_by, session_id, config_json)
       VALUES (@id, @deal_id, @run_number, @triggered_by, @session_id, @config_json)`,
    { id, deal_id: dealId, run_number: runNum,
      triggered_by: opts?.triggered_by || null, session_id: opts?.session_id || null,
      config_json: opts?.config_json || null });
  run(`UPDATE deals SET run_count = @run_number, status = 'running', updated_at = datetime('now') WHERE id = @deal_id`,
    { run_number: runNum, deal_id: dealId });
  return id;
}

export function completeRun(runId: string, result: { decision?: string; avg_score?: number; duration_ms?: number; error_msg?: string }) {
  const status = result.error_msg ? 'error' : 'complete';
  run(`UPDATE deal_runs SET status=@status, decision=@decision, avg_score=@avg_score,
       duration_ms=@duration_ms, error_msg=@error_msg, completed_at=datetime('now') WHERE id=@id`,
    { id: runId, status, decision: result.decision || null, avg_score: result.avg_score ?? null,
      duration_ms: result.duration_ms ?? null, error_msg: result.error_msg || null });
}

export function getRunsByDeal(dealId: string): any[] {
  return all(`SELECT * FROM deal_runs WHERE deal_id = ? ORDER BY run_number DESC`, dealId);
}

// ═══════════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════════

export function insertEvent(event: { deal_id: string; run_id?: string; type: string; node_id?: string; payload_json: string; ts: string }): string {
  const id = newId();
  run(`INSERT INTO events (id, deal_id, run_id, type, node_id, payload_json, ts)
       VALUES (@id, @deal_id, @run_id, @type, @node_id, @payload_json, @ts)`,
    { id, deal_id: event.deal_id, run_id: event.run_id || null, type: event.type,
      node_id: event.node_id || null, payload_json: event.payload_json, ts: event.ts });
  return id;
}

export function getEventsByDeal(dealId: string, opts?: { type?: string; run_id?: string; limit?: number }): any[] {
  let sql = `SELECT * FROM events WHERE deal_id = @deal_id`;
  const params: any = { deal_id: dealId };
  if (opts?.type) { sql += ` AND type = @type`; params.type = opts.type; }
  if (opts?.run_id) { sql += ` AND run_id = @run_id`; params.run_id = opts.run_id; }
  sql += ` ORDER BY ts ASC LIMIT @limit`;
  params.limit = opts?.limit || 1000;
  return all(sql, params);
}

// ═══════════════════════════════════════════════════════════════════════
// EVIDENCE
// ═══════════════════════════════════════════════════════════════════════

export function upsertEvidence(ev: {
  id: string; deal_id: string; run_id?: string; title?: string; snippet: string;
  source: string; provider?: string; url?: string; confidence?: number; metadata_json?: string; retrieved_at: string;
}) {
  run(`INSERT INTO evidence (id, deal_id, run_id, title, snippet, source, provider, url, confidence, metadata_json, retrieved_at)
       VALUES (@id, @deal_id, @run_id, @title, @snippet, @source, @provider, @url, @confidence, @metadata_json, @retrieved_at)
       ON CONFLICT(id) DO UPDATE SET snippet=@snippet, title=coalesce(@title, title), url=coalesce(@url, url)`,
    { ...ev, run_id: ev.run_id || null, title: ev.title || null, provider: ev.provider || ev.source?.split('-')[0] || null,
      url: ev.url || null, confidence: ev.confidence ?? null, metadata_json: ev.metadata_json || null });
}

export function bulkUpsertEvidence(dealId: string, runId: string | null, items: any[]) {
  const d = getDb();
  if (!d || items.length === 0) return;
  const stmt = d.prepare(`
    INSERT INTO evidence (id, deal_id, run_id, title, snippet, source, provider, url, retrieved_at)
    VALUES (@id, @deal_id, @run_id, @title, @snippet, @source, @provider, @url, @retrieved_at)
    ON CONFLICT(id) DO UPDATE SET snippet=@snippet, title=coalesce(@title, title), url=coalesce(@url, url)
  `);
  const tx = d.transaction((rows: any[]) => {
    for (const ev of rows) {
      stmt.run({
        id: ev.evidence_id || ev.id || newId(),
        deal_id: dealId,
        run_id: runId,
        title: ev.title || null,
        snippet: (ev.snippet || '').slice(0, 4000),
        source: ev.source || 'unknown',
        provider: ev.source?.split('-')[0] || 'unknown',
        url: ev.url || null,
        retrieved_at: ev.retrieved_at || now(),
      });
    }
  });
  try { tx(items); } catch (err: any) { console.warn(`[DB] bulkUpsertEvidence: ${err.message}`); }
}

export function searchEvidence(query: string, opts?: { deal_id?: string; source?: string; provider?: string; limit?: number }): any[] {
  let sql = `SELECT * FROM evidence WHERE (snippet LIKE @q OR title LIKE @q)`;
  const params: any = { q: `%${query}%` };
  if (opts?.deal_id) { sql += ` AND deal_id = @deal_id`; params.deal_id = opts.deal_id; }
  if (opts?.source) { sql += ` AND source = @source`; params.source = opts.source; }
  if (opts?.provider) { sql += ` AND provider = @provider`; params.provider = opts.provider; }
  sql += ` ORDER BY retrieved_at DESC LIMIT @limit`;
  params.limit = opts?.limit || 50;
  return all(sql, params);
}

export function getEvidenceByDeal(dealId: string, runId?: string): any[] {
  if (runId) return all(`SELECT * FROM evidence WHERE deal_id = ? AND run_id = ? ORDER BY retrieved_at`, [dealId, runId]);
  return all(`SELECT * FROM evidence WHERE deal_id = ? ORDER BY retrieved_at`, dealId);
}

// ═══════════════════════════════════════════════════════════════════════
// TOOL ACTIONS
// ═══════════════════════════════════════════════════════════════════════

export function startToolAction(action: {
  deal_id?: string; run_id?: string; session_id?: string;
  tool_name: string; provider: string; operation?: string;
  input_json?: string; called_by?: string;
}): string {
  const id = newId();
  run(`INSERT INTO tool_actions (id, deal_id, run_id, session_id, tool_name, provider, operation, input_json, status, called_by)
       VALUES (@id, @deal_id, @run_id, @session_id, @tool_name, @provider, @operation, @input_json, 'pending', @called_by)`,
    { id, deal_id: action.deal_id || null, run_id: action.run_id || null,
      session_id: action.session_id || null, tool_name: action.tool_name,
      provider: action.provider, operation: action.operation || null,
      input_json: action.input_json || null, called_by: action.called_by || null });
  return id;
}

export function completeToolAction(id: string, result: {
  status: 'success' | 'error' | 'timeout'; output_json?: string;
  error_msg?: string; latency_ms?: number; result_count?: number;
}) {
  run(`UPDATE tool_actions SET status=@status, output_json=@output_json, error_msg=@error_msg,
       latency_ms=@latency_ms, result_count=@result_count, completed_at=datetime('now') WHERE id=@id`,
    { id, status: result.status, output_json: result.output_json || null,
      error_msg: result.error_msg || null, latency_ms: result.latency_ms ?? null,
      result_count: result.result_count ?? null });
}

export function getToolActionsByDeal(dealId: string, opts?: { provider?: string; limit?: number }): any[] {
  let sql = `SELECT * FROM tool_actions WHERE deal_id = @deal_id`;
  const params: any = { deal_id: dealId };
  if (opts?.provider) { sql += ` AND provider = @provider`; params.provider = opts.provider; }
  sql += ` ORDER BY started_at DESC LIMIT @limit`;
  params.limit = opts?.limit || 200;
  return all(sql, params);
}

export function getToolStats(): any {
  return {
    total: (get(`SELECT COUNT(*) as c FROM tool_actions`) as any)?.c || 0,
    by_provider: all(`SELECT provider, COUNT(*) as count, AVG(latency_ms) as avg_latency FROM tool_actions GROUP BY provider`),
    by_status: all(`SELECT status, COUNT(*) as count FROM tool_actions GROUP BY status`),
    errors: all(`SELECT tool_name, error_msg, started_at FROM tool_actions WHERE status = 'error' ORDER BY started_at DESC LIMIT 20`),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// QUERIES
// ═══════════════════════════════════════════════════════════════════════

export function insertQuery(q: {
  deal_id?: string; run_id?: string; tool_action_id?: string;
  query_text: string; query_type?: string; provider?: string;
  result_count?: number; answer_text?: string; latency_ms?: number;
}): string {
  const id = newId();
  run(`INSERT INTO queries (id, deal_id, run_id, tool_action_id, query_text, query_type, provider, result_count, answer_text, latency_ms)
       VALUES (@id, @deal_id, @run_id, @tool_action_id, @query_text, @query_type, @provider, @result_count, @answer_text, @latency_ms)`,
    { id, deal_id: q.deal_id || null, run_id: q.run_id || null,
      tool_action_id: q.tool_action_id || null, query_text: q.query_text,
      query_type: q.query_type || null, provider: q.provider || null,
      result_count: q.result_count ?? null, answer_text: q.answer_text || null,
      latency_ms: q.latency_ms ?? null });
  return id;
}

export function getQueriesByDeal(dealId: string): any[] {
  return all(`SELECT * FROM queries WHERE deal_id = ? ORDER BY created_at DESC`, dealId);
}

// ═══════════════════════════════════════════════════════════════════════
// PERSONAS
// ═══════════════════════════════════════════════════════════════════════

export function upsertPersona(p: {
  id?: string; deal_id: string; run_id?: string; persona_type: string; persona_id?: string;
  specialization?: string; status: string; output_json?: string; raw_response?: string;
  validation_ok?: boolean; retry_count?: number; fact_count?: number; unknown_count?: number;
  latency_ms?: number; dify_tool_calls?: number; error_msg?: string;
  started_at?: string; completed_at?: string;
}): string {
  const id = p.id || newId();
  run(`INSERT INTO personas (id, deal_id, run_id, persona_type, persona_id, specialization, status,
        output_json, raw_response, validation_ok, retry_count, fact_count, unknown_count,
        latency_ms, dify_tool_calls, error_msg, started_at, completed_at)
       VALUES (@id, @deal_id, @run_id, @persona_type, @persona_id, @specialization, @status,
        @output_json, @raw_response, @validation_ok, @retry_count, @fact_count, @unknown_count,
        @latency_ms, @dify_tool_calls, @error_msg, @started_at, @completed_at)
       ON CONFLICT(id) DO UPDATE SET status=@status, output_json=coalesce(@output_json, output_json),
        raw_response=coalesce(@raw_response, raw_response), validation_ok=coalesce(@validation_ok, validation_ok),
        retry_count=coalesce(@retry_count, retry_count), fact_count=coalesce(@fact_count, fact_count),
        unknown_count=coalesce(@unknown_count, unknown_count), latency_ms=coalesce(@latency_ms, latency_ms),
        dify_tool_calls=coalesce(@dify_tool_calls, dify_tool_calls), error_msg=coalesce(@error_msg, error_msg),
        completed_at=coalesce(@completed_at, completed_at)`,
    { id, deal_id: p.deal_id, run_id: p.run_id || null, persona_type: p.persona_type,
      persona_id: p.persona_id || null, specialization: p.specialization || null,
      status: p.status, output_json: p.output_json || null, raw_response: p.raw_response || null,
      validation_ok: p.validation_ok ?? null, retry_count: p.retry_count ?? 0,
      fact_count: p.fact_count ?? 0, unknown_count: p.unknown_count ?? 0,
      latency_ms: p.latency_ms ?? null, dify_tool_calls: p.dify_tool_calls ?? 0,
      error_msg: p.error_msg || null, started_at: p.started_at || null, completed_at: p.completed_at || null });
  return id;
}

export function getPersonasByRun(runId: string): any[] {
  return all(`SELECT * FROM personas WHERE run_id = ? ORDER BY created_at`, runId);
}

// ═══════════════════════════════════════════════════════════════════════
// RUBRIC SCORES
// ═══════════════════════════════════════════════════════════════════════

export function upsertRubricScore(s: {
  deal_id: string; run_id?: string; dimension: string; score: number;
  reasons_json?: string; scored_by?: string;
}) {
  const id = newId();
  run(`INSERT INTO rubric_scores (id, deal_id, run_id, dimension, score, reasons_json, scored_by)
       VALUES (@id, @deal_id, @run_id, @dimension, @score, @reasons_json, @scored_by)
       ON CONFLICT(deal_id, run_id, dimension) DO UPDATE SET score=@score, reasons_json=@reasons_json`,
    { id, deal_id: s.deal_id, run_id: s.run_id || null, dimension: s.dimension,
      score: s.score, reasons_json: s.reasons_json || null, scored_by: s.scored_by || null });
}

export function getRubricByDeal(dealId: string, runId?: string): any[] {
  if (runId) return all(`SELECT * FROM rubric_scores WHERE deal_id = ? AND run_id = ?`, [dealId, runId]);
  return all(`SELECT * FROM rubric_scores WHERE deal_id = ? ORDER BY created_at DESC`, dealId);
}

// ═══════════════════════════════════════════════════════════════════════
// HYPOTHESES
// ═══════════════════════════════════════════════════════════════════════

export function insertHypothesis(h: {
  deal_id: string; run_id?: string; hypothesis_id?: string; text: string;
  support_evidence_ids?: string; risks_json?: string; created_by?: string;
}): string {
  const id = newId();
  run(`INSERT INTO hypotheses (id, deal_id, run_id, hypothesis_id, text, support_evidence_ids, risks_json, created_by)
       VALUES (@id, @deal_id, @run_id, @hypothesis_id, @text, @support_evidence_ids, @risks_json, @created_by)`,
    { id, deal_id: h.deal_id, run_id: h.run_id || null, hypothesis_id: h.hypothesis_id || null,
      text: h.text, support_evidence_ids: h.support_evidence_ids || null,
      risks_json: h.risks_json || null, created_by: h.created_by || null });
  return id;
}

// ═══════════════════════════════════════════════════════════════════════
// TRIGGERS
// ═══════════════════════════════════════════════════════════════════════

export function upsertTrigger(trigger: {
  id: string; deal_id?: string; cala_id?: string; created_by?: string;
  name: string; query: string; answer_baseline?: string; category?: string;
  company?: string; domain?: string; status?: string;
}) {
  run(`INSERT INTO triggers (id, deal_id, cala_id, created_by, name, query, answer_baseline, category, company, domain, status)
       VALUES (@id, @deal_id, @cala_id, @created_by, @name, @query, @answer_baseline, @category, @company, @domain, @status)
       ON CONFLICT(id) DO UPDATE SET cala_id=coalesce(@cala_id, cala_id), status=coalesce(@status, status),
        answer_baseline=coalesce(@answer_baseline, answer_baseline), updated_at=datetime('now')`,
    { id: trigger.id, deal_id: trigger.deal_id || null, cala_id: trigger.cala_id || null,
      created_by: trigger.created_by || null, name: trigger.name, query: trigger.query,
      answer_baseline: trigger.answer_baseline || null, category: trigger.category || null,
      company: trigger.company || null, domain: trigger.domain || null,
      status: trigger.status || 'active' });
}

export function upsertTriggerNotification(n: { id?: string; trigger_id: string; type: string; target: string; cala_notification_id?: string }): string {
  const id = n.id || newId();
  run(`INSERT OR REPLACE INTO trigger_notifications (id, trigger_id, type, target, cala_notification_id)
       VALUES (@id, @trigger_id, @type, @target, @cala_notification_id)`,
    { id, trigger_id: n.trigger_id, type: n.type, target: n.target,
      cala_notification_id: n.cala_notification_id || null });
  return id;
}

// ═══════════════════════════════════════════════════════════════════════
// TRIGGER SUGGESTIONS (batch Cala intel queries)
// ═══════════════════════════════════════════════════════════════════════

export function insertTriggerSuggestion(s: {
  deal_id: string; run_id?: string; category: string; label: string;
  query: string; baseline_answer?: string; evidence_json?: string;
  evidence_count?: number; has_data?: boolean; latency_ms?: number;
}): string {
  const id = newId();
  run(`INSERT INTO trigger_suggestions (id, deal_id, run_id, category, label, query, baseline_answer, evidence_json, evidence_count, has_data, latency_ms)
       VALUES (@id, @deal_id, @run_id, @category, @label, @query, @baseline_answer, @evidence_json, @evidence_count, @has_data, @latency_ms)`,
    { id, deal_id: s.deal_id, run_id: s.run_id || null, category: s.category, label: s.label,
      query: s.query, baseline_answer: s.baseline_answer || null,
      evidence_json: s.evidence_json || null, evidence_count: s.evidence_count ?? 0,
      has_data: s.has_data ? 1 : 0, latency_ms: s.latency_ms ?? null });
  return id;
}

export function bulkInsertTriggerSuggestions(dealId: string, runId: string | null, suggestions: {
  category: string; label: string; query: string; baseline_answer: string;
  evidence_json: string; evidence_count: number; has_data: boolean; latency_ms: number;
}[]) {
  const d = getDb();
  if (!d || suggestions.length === 0) return;
  const stmt = d.prepare(`INSERT INTO trigger_suggestions (id, deal_id, run_id, category, label, query, baseline_answer, evidence_json, evidence_count, has_data, latency_ms)
    VALUES (@id, @deal_id, @run_id, @category, @label, @query, @baseline_answer, @evidence_json, @evidence_count, @has_data, @latency_ms)`);
  const tx = d.transaction((rows: typeof suggestions) => {
    for (const s of rows) {
      stmt.run({ id: newId(), deal_id: dealId, run_id: runId, category: s.category, label: s.label,
        query: s.query, baseline_answer: s.baseline_answer || null, evidence_json: s.evidence_json || null,
        evidence_count: s.evidence_count, has_data: s.has_data ? 1 : 0, latency_ms: s.latency_ms });
    }
  });
  try { tx(suggestions); } catch (err: any) { console.warn(`[DB] bulkInsertTriggerSuggestions: ${err.message}`); }
}

export function getTriggerSuggestions(dealId: string): any[] {
  return all(`SELECT * FROM trigger_suggestions WHERE deal_id = ? ORDER BY has_data DESC, evidence_count DESC`, dealId);
}

export function activateTriggerSuggestion(suggestionId: string, triggerId: string) {
  run(`UPDATE trigger_suggestions SET activated = 1, trigger_id = @trigger_id WHERE id = @id`,
    { id: suggestionId, trigger_id: triggerId });
}

// ═══════════════════════════════════════════════════════════════════════
// COMPANY PROFILES
// ═══════════════════════════════════════════════════════════════════════

export function cacheCompanyProfile(profile: any) {
  if (!profile) return;
  const id = newId();
  run(`INSERT INTO company_profiles (id, specter_id, name, domain, growth_stage, employee_count,
        funding_total_usd, hq_country, hq_city, industries_json, founders_json, profile_json, expires_at)
       VALUES (@id, @specter_id, @name, @domain, @growth_stage, @employee_count,
        @funding_total_usd, @hq_country, @hq_city, @industries_json, @founders_json, @profile_json, @expires_at)
       ON CONFLICT(specter_id) DO UPDATE SET name=@name, employee_count=coalesce(@employee_count, employee_count),
        funding_total_usd=coalesce(@funding_total_usd, funding_total_usd), profile_json=@profile_json,
        fetched_at=datetime('now'), expires_at=@expires_at`,
    { id, specter_id: profile.specter_id, name: profile.name, domain: profile.domain || null,
      growth_stage: profile.growth_stage || null, employee_count: profile.employee_count ?? null,
      funding_total_usd: profile.funding_total_usd ?? null, hq_country: profile.hq_country || null,
      hq_city: profile.hq_city || null,
      industries_json: profile.industries ? JSON.stringify(profile.industries) : null,
      founders_json: profile.founders ? JSON.stringify(profile.founders) : null,
      profile_json: JSON.stringify(profile),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() });
}

export function getCachedProfile(specterId: string): any | null {
  const row = get(`SELECT profile_json, expires_at FROM company_profiles WHERE specter_id = ?`, specterId) as any;
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null; // expired
  try { return JSON.parse(row.profile_json); } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════
// MEMOS
// ═══════════════════════════════════════════════════════════════════════

export function saveMemo(dealId: string, runId: string | null, slidesJson: string, slideCount: number) {
  const id = newId();
  const version = ((get(`SELECT MAX(version) as v FROM memos WHERE deal_id = ?`, dealId) as any)?.v || 0) + 1;
  run(`INSERT INTO memos (id, deal_id, run_id, slides_json, slide_count, version)
       VALUES (@id, @deal_id, @run_id, @slides_json, @slide_count, @version)`,
    { id, deal_id: dealId, run_id: runId, slides_json: slidesJson, slide_count: slideCount, version });
}

export function getMemo(dealId: string): any | null {
  const row = get(`SELECT slides_json FROM memos WHERE deal_id = ? ORDER BY version DESC LIMIT 1`, dealId) as any;
  return row ? JSON.parse(row.slides_json) : null;
}

export function getMemoHistory(dealId: string): any[] {
  return all(`SELECT id, run_id, slide_count, version, created_at FROM memos WHERE deal_id = ? ORDER BY version DESC`, dealId);
}
