# Deal Bot: Org-Sim

**Deploy an entire investment committee — analysts, associate, and partner — in 60 seconds, directly inside ChatGPT.**

Deal Bot simulates a full VC investment committee. Give it a company domain, and it deploys three specialized research analysts (market, competition, traction), a synthesizing associate, and a decision-making partner — all running in parallel, all with access to real-time data via 30+ research tools.

[![Watch the Demo](https://img.shields.io/badge/Demo-Watch_on_Loom-blueviolet?style=for-the-badge&logo=loom)](https://www.loom.com/share/5f9542c8f96545cba1d1c1abde822cc6)
[![Live](https://img.shields.io/badge/Live-Try_It_Now-green?style=for-the-badge)](https://tech-eu-paris-2026-0d53df71.alpic.live)
[![GitHub](https://img.shields.io/badge/Source-GitHub-black?style=for-the-badge&logo=github)](https://github.com/frankterpo/tech_eu_paris_2026)

---

## Try It Yourself (5 minutes)

### Option A: Use the Live Deployment (no setup)

1. Open [ChatGPT](https://chatgpt.com) → **Settings → Developer Mode** (enable if not already)
2. Click **"Add MCP Server"** → Transport: **Streamable HTTP**
3. URL: `https://tech-eu-paris-2026-0d53df71.alpic.live/mcp` → Save
4. Start a **new chat** and type: **`Look up the company mistral.ai`**
5. Click **"Process Deal →"** on the company profile card
6. Watch the analysts work in real time on the deal dashboard

> **Tip:** If the dashboard doesn't auto-open after processing, type: `Show deal dashboard for deal_id="<id>"` using the ID from the tool response.

### Option B: Run Locally

```bash
# 1. Clone & install
git clone https://github.com/frankterpo/tech_eu_paris_2026.git
cd tech_eu_paris_2026
npm install

# 2. Create .env (see Configuration section below)
cp .env.example .env   # or create manually

# 3. Start dev server
npm run dev             # → http://localhost:3000

# 4. (Optional) Expose via ngrok for ChatGPT
ngrok http 3000

# 5. Connect ChatGPT → Settings → Connected Apps → Add MCP Server
#    Paste your ngrok URL
```

### Option C: Deploy Your Own Instance

```bash
# 1. Install Alpic CLI
npm i -g alpic

# 2. Deploy (one command)
ALPIC_API_KEY=your_key alpic deploy .

# 3. Connect ChatGPT to your new URL
```

### Option D: Build Your Own Skybridge App

Want to build something similar? Deal Bot is built on **Skybridge** — the framework for creating ChatGPT Apps with rich widgets and MCP tools.

```bash
# Scaffold a new Skybridge project
npm create skybridge@latest

# Or add the skill to an existing project
npx skills add alpic-ai/skybridge
```

Then deploy on [app.alpic.ai](https://app.alpic.ai) (login → connect GitHub → create project).

---

## What's New (V3 — February 2026)

| Change | Detail |
|--------|--------|
| **Cala Trigger Webhook Relay** | Permanent Cloudflare Worker (`dealbot-cala-webhook.teamdeel.workers.dev`) receives Cala trigger-fired webhooks and forwards alerts via Resend email. Zero maintenance, free forever. |
| **Manual Trigger Flow** | Users create triggers on [console.cala.ai/triggers](https://console.cala.ai/triggers) using queries from analyst research. Webhook relay handles the notification pipeline. |
| **Resend Email Integration** | Styled HTML trigger alerts delivered to user-specified email addresses via Resend API. |
| **Cursor Dark Theme** | company-profile and deal-dashboard widgets rethemed to Cursor.com color palette. |
| **Investor Lens in Widget** | AUM + Firm Type selectors integrated directly into the company-profile card — no extra prompts. |
| **Side-Panel Deal History** | Slide-open panel in deal-dashboard shows past + ongoing deal runs with quick navigation. |
| **Agent Thinking UX** | Analyst dropdowns show live thinking/milestone updates during processing. |
| **Next Steps Prompts** | Post-assessment recommendations: founder outreach mapping + Cala trigger setup. |
| **Evidence Panel** | Inline evidence viewer with source citations, replaces old modal. |
| **Auto-Resume Pipeline** | Serverless-safe: if Alpic times out, dashboard poll advances the simulation. No data loss. |
| **Graceful Dify Fallback** | 401/403 from Dify → automatic stub responses. Pipeline always completes. |
| **Double-Execution Guard** | `activeDeals` set prevents concurrent run/resume conflicts. |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ChatGPT / OpenAI GPT                        │
│  (User interface — natural language → MCP tool calls)          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ MCP Protocol (Skybridge)
┌───────────────────────────▼─────────────────────────────────────┐
│                    Deal Bot Server (Node.js/Express)             │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ MCP Tools │  │ Orchestrator │  │  REST API    │              │
│  │ (30+)     │  │ (3 waves)    │  │  /api/deals  │              │
│  └─────┬─────┘  └──────┬───────┘  └──────┬───────┘              │
│        │               │                 │                       │
│  ┌─────▼─────────────────▼─────────────────▼───────────────────┐ │
│  │                  Integration Layer                          │ │
│  │  ┌───────┐ ┌────────┐ ┌───────┐ ┌───────┐ ┌─────┐ ┌─────┐│ │
│  │  │ Cala  │ │Specter │ │ Dify  │ │Tavily │ │ fal │ │Resend│ │
│  │  │  AI   │ │  AI    │ │ Cloud │ │  AI   │ │ .ai │ │     ││ │
│  │  └───────┘ └────────┘ └───────┘ └───────┘ └─────┘ └─────┘│ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Persistence: SQLite (UUID keys) + File-based (dual-write)  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            │ MCP Polling
┌───────────────────────────▼─────────────────────────────────────┐
│                    Skybridge Widgets (React)                     │
│  ┌─────────────────┐ ┌──────────────┐ ┌──────────────────────┐ │
│  │ company-profile  │ │deal-dashboard│ │  trigger-setup       │ │
│  │ (research card)  │ │(live pipeline│ │  (monitoring alerts) │ │
│  │                  │ │ + decision)  │ │                      │ │
│  └─────────────────┘ └──────────────┘ └──────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Features

| # | Feature | Description |
|---|---------|-------------|
| 1 | **One-Click Deal Analysis** | Type a company domain → full IC simulation. 3 analysts in parallel, associate synthesizes, partner decides. |
| 2 | **Real-Time Pipeline** | Watch agents make tool calls live. See evidence appear, queries chain, thinking unfold. |
| 3 | **Investor Lens** | 6 fund types (Angel → IB), each with distinct risk appetite, return targets, scoring weights. |
| 4 | **30+ Research Tools** | Specter (companies, people, competitors), Cala (100M+ knowledge base), Tavily (web), fal.ai (images). |
| 5 | **Evidence-First** | Every claim cites evidence or is flagged ASSUMPTION. Zod validation with retry-on-failure. |
| 6 | **Monitoring Triggers** | Revenue, hires, deals, partnerships alerts via Cala + Resend email delivery. |
| 7 | **Investment Memo** | Auto-generated 8-slide memo with AI cover art (fal.ai). Export as PDF or Markdown. |
| 8 | **Run History** | Every re-analysis archives the previous run. Time-series comparison across profiles. |

---

## Orchestration Pipeline

The orchestrator runs a **3-wave parallel pipeline** — no agent ever waits idle:

```
Wave 0: Evidence Seed (parallel)
├── Cala search (100M+ source knowledge base)
├── Specter enrich (company profile, funding, team)
├── [background] Batch intel (8 categories — revenue, hires, deals, partners...)
└── [background] Founder deep dive (4 targeted queries)

Wave 1: Analysts + Competitive Intel (ALL parallel)
├── Analyst 1: Market (TAM/SAM/SOM, growth rates, demand drivers)
├── Analyst 2: Competition (Specter AI-matched competitors, moats, positioning)
├── Analyst 3: Traction (revenue, team quality, PMF signals, founder track record)
├── Specter similar companies (competitive benchmarking, 5 enriched)
└── fal.ai cover image (non-blocking, aesthetic)

Wave 2: Associate + Unknown Resolution (parallel)
├── Associate (synthesize → hypotheses, bull/bear cases, risk mitigants)
└── Unknown resolution (Specter + Tavily for analyst knowledge gaps)

Wave 3: Partner + Memo
├── Partner (5-dimension rubric, decision gate, 3 gating questions)
└── Investment memo (8 slides + AI cover art)
```

---

## Tech Stack & Partner APIs

| Component | Technology | Role |
|-----------|-----------|------|
| **Frontend** | React 19, Skybridge Widgets, Vite 7 | Interactive UI rendered inside ChatGPT |
| **Backend** | Node.js, Express 5, TypeScript 5.9 | MCP server, REST API, 3-wave orchestrator |
| **AI Orchestration** | [Dify Cloud](https://dify.ai) | Agent execution — function-calling strategy, 3-6 tool calls per agent |
| **Knowledge Search** | [Cala AI](https://cala.ai) | 100M+ source knowledge base, entity extraction, trigger monitoring |
| **Webhook Relay** | [Cloudflare Workers](https://workers.cloudflare.com) | Permanent trigger webhook → Resend email relay (`dealbot-cala-webhook.teamdeel.workers.dev`) |
| **Company Data** | [Specter AI](https://tryspecter.com) | Company profiles, funding, competitors, people, revenue estimates |
| **Web Research** | [Tavily AI](https://tavily.com) | Real-time web search, content extraction, site crawl, async research |
| **Image Generation** | [fal.ai](https://fal.ai) | AI-generated investment memo cover art |
| **Email Alerts** | [Resend](https://resend.com) | Trigger notification delivery |
| **Database** | SQLite (better-sqlite3) | Persistent storage — UUID primary keys, 10+ tables |
| **Validation** | Zod 4 | Strict schema validation with retry-once on failure |
| **Deployment** | [Alpic](https://alpic.io) | One-command cloud deployment for Skybridge apps |
| **Protocol** | MCP (Model Context Protocol) | ChatGPT ↔ Server communication via Skybridge |

---

## Configuration

Create a `.env` file in the project root:

```env
# ── Required ──────────────────────────────────────────────
CALA_API_KEY=your_cala_api_key          # Cala AI knowledge search
SPECTER_API_KEY=your_specter_api_key    # Specter company enrichment

# ── Dify Agent Keys (one per persona) ────────────────────
ANALYST_DIFY_KEY=app-xxx                # Dify analyst agent-chat app
ASSOCIATE_DIFY_KEY=app-xxx              # Dify associate agent-chat app
PARTNER_DIFY_KEY=app-xxx                # Dify partner agent-chat app

# ── Optional (enhanced features) ─────────────────────────
TAVILY_API_KEY=tvly-xxx                 # Tavily web search + research
FAL_AI_API_KEY=xxx                      # fal.ai cover image generation
RESEND_API_KEY=re_xxx                   # Resend email for triggers
ALPIC_API_KEY=sk_xxx                    # Alpic deployment

# ── Trigger System (email alerts via Resend) ─────────────
RESEND_API_KEY=re_xxx                   # Resend API key
RESEND_FROM=Deal Bot <onboarding@resend.dev>  # Sender address (Resend verified)
TRIGGER_NOTIFY_EMAIL=you@example.com    # Default trigger alert recipient
CALA_EMAIL=you@example.com              # Cala console account email
```

### Graceful Degradation

Every integration degrades gracefully — the server **always starts**:

| Missing Key | Behavior |
|-------------|----------|
| `*_DIFY_KEY` | Stub mode — returns valid schema-matching JSON |
| `CALA_API_KEY` | Empty evidence seed, agents rely on Specter + Tavily |
| `SPECTER_API_KEY` | No company profile, agents rely on Cala + Tavily |
| `TAVILY_API_KEY` | No web search fallback for unknown resolution |
| `FAL_AI_API_KEY` | Memo renders without cover image |
| `RESEND_API_KEY` | Trigger alerts logged but not emailed |

---

## How It's Built — Partner Deep Dives

### Alpic + Skybridge — Framework & Cloud Deployment

Deal Bot is built on **[Skybridge](https://github.com/alpic-ai/skybridge)** — the open-source framework for creating ChatGPT Apps with interactive widgets. [Alpic](https://alpic.io) deploys the full MCP server in one command. No Docker, no CI/CD.

```bash
# Start from scratch
npm create skybridge@latest

# Or add to existing project
npx skills add alpic-ai/skybridge

# Deploy
ALPIC_API_KEY=your_key alpic deploy .
```

**What happens:**
1. `alpic deploy .` reads `alpic.json` + `.env`, bundles the build, pushes to cloud
2. Alpic provisions a Node.js container, injects env vars, starts the server
3. Live at `https://tech-eu-paris-2026-0d53df71.alpic.live`
4. ChatGPT connects to `/mcp` — all 30+ tools auto-discovered via MCP protocol

**Config (`alpic.json`):**
```json
{ "name": "tech-eu-paris-2026", "framework": "skybridge" }
```

### Dify Cloud — AI Agent Execution

[Dify](https://dify.ai) powers the 3 persona agents. Each runs as an **agent-chat** app with **function-calling** strategy — the agent autonomously decides which tools to call and how to chain results.

**How it works:**
1. Orchestrator sends rich context (company brief, evidence, investor lens) to Dify via `/chat-messages` (streaming)
2. Agent has access to full tool suite via custom **OpenAPI tool provider** (`dealbot_tools`)
3. Agent makes 3-6 tool calls, chaining results (e.g., Cala → extract entities → Specter enrich)
4. Returns structured JSON validated server-side with Zod (retry-once on failure)

**To recreate agents in Dify Cloud:**
1. Create **Agent** app (agent-chat mode) for each persona
2. Add **Custom Tool** provider `dealbot_tools` → point to `https://your-server/openapi-tools.json`
3. Enable all tools in the agent's tool list
4. Model: `gpt-4o-mini`, temperature ≤ 0.2
5. System prompt: instruct JSON-only output matching the persona schema
6. Copy API key → set as `ANALYST_DIFY_KEY` / `ASSOCIATE_DIFY_KEY` / `PARTNER_DIFY_KEY`

**OpenAPI spec:** [`server/openapi-tools.json`](server/openapi-tools.json)

### Cala AI Triggers + Cloudflare Worker — Permanent Monitoring

Deal Bot's analysts run knowledge queries via [Cala AI](https://cala.ai) during analysis. Users can turn any query into a persistent trigger:

1. **During analysis** — analysts research 8+ categories (revenue, hires, deals, partnerships, etc.) via Cala
2. **After analysis** — the trigger-setup widget lists these queries with click-to-copy
3. **User creates triggers** at [console.cala.ai/triggers](https://console.cala.ai/triggers) with the queries
4. **Webhook fires** — Cala detects changes and POSTs to `https://dealbot-cala-webhook.teamdeel.workers.dev/webhook`
5. **Email delivered** — Cloudflare Worker parses payload, sends styled HTML email via [Resend](https://resend.com)

**Webhook Worker:** Zero-dependency Cloudflare Worker. Free forever (100k req/day). Deployed at:
```
https://dealbot-cala-webhook.teamdeel.workers.dev/webhook
```

**Deploy your own:**
```bash
cd webhook-worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put RESEND_API_KEY      # Resend API key
npx wrangler secret put TRIGGER_NOTIFY_EMAIL # Default recipient email
```

### fal.ai — Investment Memo Cover Art

[fal.ai](https://fal.ai) generates AI cover images for the investment memo. Fires in Wave 1 (parallel with analysts) — non-blocking. If unavailable, memo renders without cover image.

**Flow:** `FalClient.generateMemoCover(companyName, industries)` → prompt → fal.ai API → image URL → memo cover slide

---

## Investor Lens System

6 fund types, each with distinct evaluation philosophies injected into every agent prompt:

| Fund Type | Risk Appetite | Return Target | Key Focus |
|-----------|--------------|---------------|-----------|
| Angel | Aggressive | 50-100x | Founder conviction, vision, TAM |
| Early VC | Aggressive | 10-30x | PMF signals, team, growth rate |
| Growth VC | Moderate | 5-10x | ARR, unit economics, path to $100M |
| Late VC | Moderate | 3-5x | Market leadership, IPO readiness |
| PE | Conservative | 2-3x MOIC | EBITDA, cash flow, operational levers |
| IB | Conservative | Fee-based | M&A readiness, strategic positioning |

Each includes: scoring weight multipliers, deal-breakers, prioritized metrics, and evaluation lens text.

---

## MCP Tools (30+)

### Widgets (Rich UI inside ChatGPT)
| Tool | Description |
|------|-------------|
| `company-profile` | Company research card — funding, team, traction, founders |
| `deal-dashboard` | Live pipeline visualization — agents, evidence, rubric, decision |
| `trigger-setup` | Monitoring trigger configuration UI |

### Deal Workflow
| Tool | Description |
|------|-------------|
| `analyze_deal` | **Primary** — creates + runs full simulation, returns deal_id |
| `run_deal` | Re-run simulation for existing deal |
| `list_deals` / `lookup_deal` | Find and list deal sessions |

### Specter AI (9 tools)
`specter_company_people`, `specter_similar_companies`, `specter_search_name`, `specter_text_search`, `specter_company_by_id`, `specter_enrich_person`, `specter_person_by_id`, `specter_person_email`, `specter_competitor_pipeline`

### Cala AI (4 tools)
`cala_search`, `cala_query`, `cala_get_entity`, `cala_search_entities`

### Tavily AI (5 tools)
`tavily_web_search`, `tavily_extract`, `tavily_crawl`, `tavily_research`, `tavily_research_status`

### Triggers & Monitoring (6 tools)
`create_trigger`, `create_triggers_batch`, `list_triggers`, `check_triggers`, `delete_trigger`, `receive_trigger_webhook`

---

## Data Models

### DealState
```typescript
interface DealState {
  deal_input: DealInput;          // Company, fund config, investor lens, deal terms
  evidence: Evidence[];            // All collected evidence (Cala, Specter, Tavily)
  company_profile: CompanyProfile; // Specter enrichment (50+ fields)
  hypotheses: Hypothesis[];        // Associate-generated bull/bear cases
  rubric: {                        // Partner scores (0-100 per dimension)
    market: { score: number; reasons: string[] };
    moat: { score: number; reasons: string[] };
    why_now: { score: number; reasons: string[] };
    execution: { score: number; reasons: string[] };
    deal_fit: { score: number; reasons: string[] };
  };
  decision_gate: {
    decision: 'KILL' | 'PROCEED' | 'PROCEED_IF' | 'STRONG_YES';
    gating_questions: [string, string, string];
    evidence_checklist: ChecklistItem[];
  };
}
```

### Validation
All outputs validated with Zod schemas — retry-once on failure, degraded mode on second failure. **Decision Gate is always produced.**

---

## Project Structure

```
tech_eu_paris_2026/
├── server/src/
│   ├── server.ts              # 30+ MCP tool registrations
│   ├── orchestrator.ts        # 3-wave parallel pipeline (1800 lines)
│   ├── types.ts               # Types + 6 investor fund profiles
│   ├── validators.ts          # Zod schemas (analyst, associate, partner)
│   ├── validate-with-retry.ts # Retry-once validation
│   ├── reducer.ts             # Event → state reducer
│   ├── persistence.ts         # SQLite + file dual-write
│   ├── db.ts                  # SQLite — 10+ tables, UUID keys
│   ├── index.ts               # Express entry, REST API, SSE
│   ├── tool-routes.ts         # OpenAPI-compatible REST tool routes
│   └── integrations/
│       ├── cala/client.ts     # Search, query, entities, triggers, batch intel
│       ├── specter/client.ts  # Enrich, similar, people, search, person
│       ├── dify/client.ts     # Agent streaming, SSE parsing, JSON extraction
│       ├── tavily/client.ts   # Search, extract, crawl, async research
│       ├── fal/client.ts      # Memo cover image generation
│       └── lightpanda/client.ts
├── web/src/
│   ├── widgets/
│   │   ├── company-profile.tsx  # Research card + Process Deal flow
│   │   ├── deal-dashboard.tsx   # Live pipeline, memo, radar chart, decision
│   │   └── trigger-setup.tsx    # Alert configuration
│   ├── helpers.ts               # Typed Skybridge hooks
│   └── index.css                # 1600+ lines of widget styles
├── webhook-worker/              # Cloudflare Worker — Cala trigger → Resend relay
│   ├── src/worker.js            # Worker handler (zero deps, <100 lines)
│   ├── src/index.js             # Standalone Node.js version (Railway/local)
│   ├── wrangler.toml            # Cloudflare config
│   └── package.json
├── server/openapi-tools.json    # OpenAPI 3.0 spec for Dify agents
├── dify-workflows/              # Dify agent YAML configs
├── context/                     # Architecture specs (10 docs)
├── DEMO_SCRIPT.md
├── alpic.json
└── package.json
```

---

## Event Types

| Event | Description |
|-------|-------------|
| `NODE_STARTED` / `NODE_DONE` | Agent lifecycle |
| `MSG_SENT` | Inter-agent message (analyst→associate→partner) |
| `EVIDENCE_ADDED` | New evidence items ingested |
| `STATE_PATCH` | Hypotheses or rubric updated |
| `DECISION_UPDATED` | Decision gate produced |
| `LIVE_UPDATE` | Real-time narration for dashboard UI |
| `COMPANY_PROFILE_ADDED` | Specter profile ingested |
| `TRIGGER_SUGGESTIONS_READY` | Intel categories ready for trigger creation |
| `ERROR` | Non-blocking — continues in degraded mode |

---

## License

Built for **Tech EU Paris 2026 Hackathon**.

**Team:** Francisco Terpolilli

**Partners:** [Cala AI](https://cala.ai) · [Specter AI](https://tryspecter.com) · [Dify](https://dify.ai) · [Tavily](https://tavily.com) · [fal.ai](https://fal.ai) · [Alpic](https://alpic.io) · [Resend](https://resend.com)
