import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import type { Request, Response, Express } from "express";
import fs from "node:fs";
import { mcp } from "./middleware.js";
import server from "./server.js";
import { Orchestrator } from "./orchestrator.js";
import { PersistenceManager } from "./persistence.js";
import { toolRouter } from "./tool-routes.js";
import type { DealInput } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try multiple .env locations: cwd first (Alpic), then relative to __dirname (local dev)
dotenv.config({ path: path.join(process.cwd(), ".env") });
dotenv.config({ path: path.join(__dirname, "../../.env") });

const app = express() as Express;
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── MCP endpoint (Skybridge middleware) ──────────────────────────────
app.use(mcp(server));

// ── Dev: Skybridge DevTools + Vite HMR ──────────────────────────────
const env = process.env.NODE_ENV || "development";

if (env !== "production") {
  try {
    const { devtoolsStaticServer } = await import("@skybridge/devtools");
    const { widgetsDevServer } = await import("skybridge/server");
    app.use(await devtoolsStaticServer());
    app.use(await widgetsDevServer());
  } catch (e) {
    console.warn("[Dev] Skybridge DevTools not available:", (e as Error).message);
  }
}

// ── Production: serve widget assets ─────────────────────────────────
if (env === "production") {
  app.use("/assets", cors());
  app.use("/assets", express.static(path.join(__dirname, "assets")));
}

// ── DSL endpoints — serve agent YAMLs for Dify ──────────────────────
const DSL_DIR = path.join(process.cwd(), "dify-workflows");

app.get("/dsl/:name", (req: Request, res: Response) => {
  const name = String(req.params.name).replace(/[^a-z0-9_\-]/gi, "");
  const filePath = path.join(DSL_DIR, `${name}.yml`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `DSL not found: ${name}` });
  }
  res.setHeader("Content-Type", "application/x-yaml");
  res.setHeader("Content-Disposition", `inline; filename="${name}.yml"`);
  fs.createReadStream(filePath).pipe(res);
});

app.get("/dsl", (_req: Request, res: Response) => {
  if (!fs.existsSync(DSL_DIR)) return res.json([]);
  const files = fs.readdirSync(DSL_DIR).filter((f) => f.endsWith(".yml"));
  const baseUrl = `${_req.protocol}://${_req.get("host")}`;
  res.json(files.map((f) => ({ name: f.replace(".yml", ""), url: `${baseUrl}/dsl/${f.replace(".yml", "")}` })));
});

// ── REST API routes (Dify compatibility) ─────────────────────────────
app.use("/api/tools", toolRouter);

app.post("/api/deals", async (req: Request, res: Response) => {
  try {
    // Accept both shapes:
    //   A) { deal_input: { name, domain, ... }, fund_config: { ... }, persona_config: { ... } }
    //   B) { name, domain, fund_config, persona_config }  (flat DealInput)
    const raw = req.body;
    const di = raw.deal_input || raw;
    const input: DealInput = {
      name: di.name,
      domain: di.domain,
      firm_type: raw.firm_type || di.firm_type,
      aum: raw.aum || di.aum,
      deal_terms: raw.deal_terms || di.deal_terms,
      fund_config: raw.fund_config || di.fund_config || {},
      persona_config: raw.persona_config || di.persona_config || {
        deal_config: { stage: di.stage, sector: di.sector, geo: di.geo },
        analysts: [
          { specialization: 'market' },
          { specialization: 'competition' },
          { specialization: 'traction' },
        ],
      },
    };
    if (!input.name) return res.status(400).json({ error: 'Missing deal name' });
    // Merge stage/sector/geo into persona_config.deal_config if provided at top level
    if (!input.persona_config?.deal_config && (di.stage || di.sector || di.geo)) {
      input.persona_config = {
        ...(input.persona_config || {}),
        deal_config: { stage: di.stage, sector: di.sector, geo: di.geo },
      };
    }
    const dealId = await Orchestrator.createDeal(input);
    res.json({ dealId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/deals/:id/run", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!Orchestrator.dealExists(id)) return res.status(404).json({ error: "Deal not found" });
  Orchestrator.runSimulation(id).catch((err) => console.error(`Sim error: ${err.message}`));
  res.json({ status: "started", dealId: id });
});

/** PATCH /api/deals/:id — update investor profile (firm_type, aum) and optionally re-run */
app.patch("/api/deals/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const state = PersistenceManager.getState(id);
  if (!state) return res.status(404).json({ error: "Deal not found" });

  const { firm_type, aum, deal_terms, rerun } = req.body;
  let changed = false;
  if (firm_type && firm_type !== state.deal_input.firm_type) {
    state.deal_input.firm_type = firm_type;
    changed = true;
  }
  if (aum !== undefined && aum !== state.deal_input.aum) {
    state.deal_input.aum = aum;
    changed = true;
  }
  if (deal_terms && typeof deal_terms === 'object') {
    state.deal_input.deal_terms = { ...(state.deal_input.deal_terms || {}), ...deal_terms };
    changed = true;
  }
  if (changed) {
    PersistenceManager.saveState(id, state);
  }
  if (rerun && changed) {
    Orchestrator.runSimulation(id).catch((err) => console.error(`Re-run error: ${err.message}`));
    return res.json({ status: "profile_updated_and_restarted", dealId: id, firm_type: state.deal_input.firm_type, aum: state.deal_input.aum, deal_terms: state.deal_input.deal_terms });
  }
  res.json({ status: changed ? "profile_updated" : "no_change", dealId: id, firm_type: state.deal_input.firm_type, aum: state.deal_input.aum });
});

app.get("/api/deals/:id/state", (req: Request, res: Response) => {
  const state = PersistenceManager.getState(String(req.params.id));
  if (!state) return res.status(404).json({ error: "Deal not found" });
  res.json(state);
});

/** GET /api/deals/:id/runs — list archived runs (time-series history) */
app.get("/api/deals/:id/runs", (req: Request, res: Response) => {
  const runs = PersistenceManager.listRuns(String(req.params.id));
  res.json({ runs: runs.map(r => ({ ts: r.ts, files: r.files.length })) });
});

/** GET /api/deals/:id/runs/:ts — get archived state for a specific run */
app.get("/api/deals/:id/runs/:ts", (req: Request, res: Response) => {
  const state = PersistenceManager.getArchivedState(String(req.params.id), String(req.params.ts));
  if (!state) return res.status(404).json({ error: "Archived run not found" });
  res.json(state);
});

app.get("/api/deals/:id/stream", (req: Request, res: Response) => {
  const id = String(req.params.id);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  Orchestrator.addStream(id, res);
});

// ═══════════════════════════════════════════════════════════════════════
// DATABASE-BACKED ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/** GET /api/deals — list all deals (summary) + stats */
app.get("/api/deals", (req: Request, res: Response) => {
  const limit = parseInt(String(req.query.limit)) || 50;
  const offset = parseInt(String(req.query.offset)) || 0;
  const status = req.query.status ? String(req.query.status) : undefined;
  const deals = PersistenceManager.listDeals({ limit, offset, status });
  const stats = PersistenceManager.getDealStats();
  res.json({ deals, stats, db_available: PersistenceManager.isDatabaseAvailable() });
});

/** GET /api/deals/:id/detail — full deal record with run history */
app.get("/api/deals/:id/detail", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const state = PersistenceManager.getState(id);
  if (!state) return res.status(404).json({ error: "Deal not found" });
  const runs = PersistenceManager.getRunHistory(id);
  const rubric = PersistenceManager.getRubricByDeal(id);
  const memos = PersistenceManager.getMemoHistory(id);
  res.json({ deal_id: id, state, runs, rubric, memos });
});

/** GET /api/deals/:id/history — event timeline for a deal */
app.get("/api/deals/:id/history", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const type = req.query.type ? String(req.query.type) : undefined;
  const run_id = req.query.run_id ? String(req.query.run_id) : undefined;
  const limit = parseInt(String(req.query.limit)) || 500;
  const events = PersistenceManager.getEventHistory(id, { type, run_id, limit });
  res.json({ deal_id: id, events, count: events.length });
});

/** GET /api/deals/:id/evidence — all evidence items for a deal */
app.get("/api/deals/:id/evidence", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const run_id = req.query.run_id ? String(req.query.run_id) : undefined;
  const evidence = PersistenceManager.getEvidenceByDeal(id, run_id);
  res.json({ deal_id: id, evidence, count: evidence.length });
});

/** GET /api/deals/:id/queries — all search queries issued for a deal */
app.get("/api/deals/:id/queries", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const queries = PersistenceManager.getQueriesByDeal(id);
  res.json({ deal_id: id, queries, count: queries.length });
});

/** GET /api/deals/:id/runs — all simulation runs for a deal */
app.get("/api/deals/:id/runs", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const runs = PersistenceManager.getRunHistory(id);
  res.json({ deal_id: id, runs, count: runs.length });
});

/** GET /api/deals/:id/runs/:runId/personas — persona outputs for a specific run */
app.get("/api/deals/:id/runs/:runId/personas", (req: Request, res: Response) => {
  const runId = String(req.params.runId);
  const personas = PersistenceManager.getPersonasByRun(runId);
  res.json({ run_id: runId, personas, count: personas.length });
});

/** GET /api/evidence/search?q=...&deal_id=...&source=...&provider=... */
app.get("/api/evidence/search", (req: Request, res: Response) => {
  const q = String(req.query.q || '');
  if (!q) return res.status(400).json({ error: 'Missing "q" query parameter.' });
  const deal_id = req.query.deal_id ? String(req.query.deal_id) : undefined;
  const source = req.query.source ? String(req.query.source) : undefined;
  const provider = req.query.provider ? String(req.query.provider) : undefined;
  const limit = parseInt(String(req.query.limit)) || 50;
  const results = PersistenceManager.searchEvidence(q, { deal_id, source, provider, limit });
  res.json({ query: q, results, count: results.length });
});

/** GET /api/tools/stats — tool usage analytics */
app.get("/api/tools/stats", (_req: Request, res: Response) => {
  const stats = PersistenceManager.getToolStats();
  res.json(stats);
});

/** POST /api/users — create or update a user */
app.post("/api/users", (req: Request, res: Response) => {
  const { name, email, role } = req.body;
  const userId = PersistenceManager.upsertUser({ name, email, role });
  res.json({ user_id: userId });
});

/** GET /api/db/status — database health and table counts */
app.get("/api/db/status", (_req: Request, res: Response) => {
  const available = PersistenceManager.isDatabaseAvailable();
  const stats = PersistenceManager.getDealStats();
  const toolStats = PersistenceManager.getToolStats();
  res.json({ available, deals: stats, tools: toolStats });
});

// ═══════════════════════════════════════════════════════════════════════
// TRIGGER SUGGESTIONS + ACTIVATION
// ═══════════════════════════════════════════════════════════════════════

import { CalaClient } from './integrations/cala/client.js';

/** GET /api/deals/:id/trigger-suggestions — list intel-based trigger suggestions */
app.get("/api/deals/:id/trigger-suggestions", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const suggestions = PersistenceManager.getTriggerSuggestions(id);
  res.json({ deal_id: id, suggestions, count: suggestions.length });
});

/**
 * POST /api/deals/:id/triggers/activate
 * Body: { categories: string[], email?: string, webhook_url?: string }
 *
 * Takes selected category IDs from trigger suggestions, creates real Cala Beta triggers
 * for each, and attaches notifications (email + webhook).
 */
app.post("/api/deals/:id/triggers/activate", async (req: Request, res: Response) => {
  const dealId = String(req.params.id);
  const { categories, email, webhook_url } = req.body;

  if (!categories || !Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ error: 'Provide "categories" array (e.g., ["revenue_updates", "key_hires"])' });
  }

  const suggestions = PersistenceManager.getTriggerSuggestions(dealId);
  if (suggestions.length === 0) {
    return res.status(404).json({ error: 'No trigger suggestions found for this deal. Run the analysis first.' });
  }

  // Build the server's webhook URL for receiving Cala trigger notifications
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const webhookTarget = webhook_url || `${baseUrl}/api/webhooks/cala-trigger`;

  const results: any[] = [];
  const errors: string[] = [];

  for (const catId of categories) {
    const suggestion = suggestions.find((s: any) => s.category === catId);
    if (!suggestion) {
      errors.push(`Category "${catId}" not found in suggestions`);
      continue;
    }

    try {
      const trigger = await CalaClient.createTrigger({
        name: suggestion.label,
        query: suggestion.query,
        email,
        webhookUrl: webhookTarget,
      });

      if (trigger) {
        // Mark suggestion as activated + save trigger to DB
        PersistenceManager.activateTriggerSuggestion(suggestion.id, trigger.id);
        PersistenceManager.saveTrigger({
          id: trigger.id,
          deal_id: dealId,
          cala_id: trigger.id,
          name: trigger.name,
          query: trigger.query,
          answer_baseline: trigger.answer,
          category: catId,
          company: PersistenceManager.getState(dealId)?.deal_input.name,
          email,
          webhookUrl: webhookTarget,
          status: 'active',
        });
        results.push({ category: catId, label: suggestion.label, trigger_id: trigger.id, status: 'active' });
      } else {
        errors.push(`Failed to create trigger for "${catId}"`);
      }
    } catch (err: any) {
      errors.push(`${catId}: ${err.message}`);
    }
  }

  res.json({
    deal_id: dealId,
    activated: results,
    errors,
    total_activated: results.length,
    webhook_url: webhookTarget,
  });
});

/**
 * POST /api/deals/:id/triggers/activate-all
 * Body: { email?: string, webhook_url?: string }
 *
 * Activates ALL trigger suggestions that have data (has_data = true).
 */
app.post("/api/deals/:id/triggers/activate-all", async (req: Request, res: Response) => {
  const dealId = String(req.params.id);
  const { email, webhook_url } = req.body;

  const suggestions = PersistenceManager.getTriggerSuggestions(dealId)
    .filter((s: any) => s.has_data && !s.activated);

  if (suggestions.length === 0) {
    return res.status(404).json({ error: 'No activatable trigger suggestions found.' });
  }

  const categories = suggestions.map((s: any) => s.category);
  // Delegate to the regular activate endpoint logic
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const webhookTarget = webhook_url || `${baseUrl}/api/webhooks/cala-trigger`;

  const results: any[] = [];
  for (const suggestion of suggestions) {
    try {
      const trigger = await CalaClient.createTrigger({
        name: suggestion.label,
        query: suggestion.query,
        email,
        webhookUrl: webhookTarget,
      });
      if (trigger) {
        PersistenceManager.activateTriggerSuggestion(suggestion.id, trigger.id);
        PersistenceManager.saveTrigger({
          id: trigger.id, deal_id: dealId, cala_id: trigger.id,
          name: trigger.name, query: trigger.query, answer_baseline: trigger.answer,
          category: suggestion.category, company: PersistenceManager.getState(dealId)?.deal_input.name,
          email, webhookUrl: webhookTarget, status: 'active',
        });
        results.push({ category: suggestion.category, label: suggestion.label, trigger_id: trigger.id });
      }
    } catch { /* swallow — best effort */ }
  }

  res.json({
    deal_id: dealId,
    activated: results,
    total_activated: results.length,
    total_categories: categories.length,
    webhook_url: webhookTarget,
  });
});

// ═══════════════════════════════════════════════════════════════════════
// WEBHOOK RECEIVER — Cala trigger notifications
// When Cala detects a change, it POSTs here. We log + optionally forward via Resend.
// ═══════════════════════════════════════════════════════════════════════

app.post("/api/webhooks/cala-trigger", async (req: Request, res: Response) => {
  const payload = req.body;
  console.log(`[Webhook] Cala trigger fired:`, JSON.stringify(payload).slice(0, 500));

  // Log as a tool action
  PersistenceManager.startToolAction({
    toolName: 'calaWebhook', provider: 'cala', operation: 'trigger_fired',
    input: payload, calledBy: 'cala-webhook',
  });

  // Attempt to forward via Resend if configured
  const resendKey = process.env.RESEND_API_KEY;
  const notifyEmail = process.env.TRIGGER_NOTIFY_EMAIL;
  if (resendKey && notifyEmail) {
    try {
      const triggerName = payload.name || payload.trigger_name || 'Unknown trigger';
      const triggerQuery = payload.query || '';
      const newAnswer = payload.answer || payload.new_answer || 'No details available';

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'Deal Bot <alerts@updates.dealbot.ai>',
          to: [notifyEmail],
          subject: `🔔 Trigger Alert: ${triggerName}`,
          html: `
            <h2>Cala Trigger Fired</h2>
            <p><strong>Trigger:</strong> ${triggerName}</p>
            <p><strong>Query:</strong> ${triggerQuery}</p>
            <hr/>
            <h3>Updated Intelligence</h3>
            <p>${newAnswer}</p>
            <hr/>
            <p style="color: #888; font-size: 12px;">Sent by Deal Bot trigger system</p>
          `,
        }),
      });
      console.log(`[Webhook] Forwarded trigger alert to ${notifyEmail} via Resend`);
    } catch (err: any) {
      console.warn(`[Webhook] Resend forward failed: ${err.message}`);
    }
  }

  res.json({ received: true, ts: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

process.on("SIGINT", async () => {
  console.log("Server shutdown complete");
  process.exit(0);
});
