# Deal Bot: Org-Sim

**Deploy an entire investment committee — analysts, associate, and partner — in 60 seconds, directly inside ChatGPT.**

Deal Bot is an AI-powered deal analysis platform that simulates a full VC investment committee. Give it a company domain, and it deploys three specialized research analysts (market, competition, traction), a synthesizing associate, and a decision-making partner — all running in parallel, all with access to real-time data via 20+ research tools.

> **Live demo:** [tech-eu-paris-2026-0d53df71.alpic.live](https://tech-eu-paris-2026-0d53df71.alpic.live)

---

## Table of Contents

- [Architecture](#architecture)
- [Key Features](#key-features)
- [Tech Stack & Partner APIs](#tech-stack--partner-apis)
- [Setup & Installation](#setup--installation)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Orchestration Pipeline](#orchestration-pipeline)
- [Data Models](#data-models)
- [Investor Lens System](#investor-lens-system)
- [Deployment](#deployment)
- [Project Structure](#project-structure)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ChatGPT / OpenAI GPT                        │
│  (User interface — natural language → MCP tool calls)          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ MCP Protocol (Skybridge)
┌───────────────────────────▼─────────────────────────────────────┐
│                    Deal Bot Server                               │
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
│  │  Persistence: SQLite + File-based (dual-write)              │ │
│  │  Events: events.jsonl | State: state.json | Memory: mem_*   │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            │ SSE / Polling
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

### 1. One-Click Deal Analysis
Type a company name → get a full investment committee simulation. Three analysts research in parallel, an associate synthesizes with bull/bear cases, a partner scores and decides.

### 2. Real-Time Pipeline Visualization
Watch analysts make tool calls live. See evidence sources appear one by one. Track each agent's thinking, queries, and progress in real time.

### 3. Investor Lens System
Configure your fund type (Angel, Early VC, Growth VC, Late VC, PE, IB) and AUM. Every analysis is calibrated to your risk appetite, return targets, and evaluation philosophy.

### 4. 30+ Research Tools
Agents have access to Specter (company data, competitors, people), Cala (knowledge base search, entity extraction), Tavily (web search, crawl, deep research), and more.

### 5. Evidence-First Architecture
Every factual claim must cite evidence or be labeled ASSUMPTION. No hallucinated analysis — all outputs are validated via Zod schemas with retry-on-failure.

### 6. Monitoring Triggers
Set up alerts for revenue milestones, key hires, deals won, partnerships, and business model changes. Cala monitors the knowledge base; Resend delivers email alerts.

### 7. Investment Memo Export
Auto-generated structured memos with AI cover art (fal.ai), exportable as PDF. Includes company overview, market analysis, competitive landscape, thesis, risks, and recommendation.

### 8. Time-Series Run Archive
Every re-analysis archives the previous run. Compare results across different investor profiles, deal terms, or market conditions.

---

## Tech Stack & Partner APIs

| Component | Technology | Role |
|-----------|-----------|------|
| **Frontend** | React 19, Skybridge Widgets, Vite 7 | Interactive UI inside ChatGPT |
| **Backend** | Node.js, Express 5, TypeScript 5.9 | MCP server, REST API, orchestration |
| **AI Orchestration** | [Dify Cloud](https://dify.ai) | Agent execution (function-calling + ReAct strategies) |
| **Knowledge Search** | [Cala AI](https://cala.ai) | 100M+ source knowledge base, entity extraction, triggers |
| **Company Data** | [Specter AI](https://specter.ai) | Company profiles, funding, competitors, people, revenue estimates |
| **Web Research** | [Tavily AI](https://tavily.com) | Real-time web search, content extraction, site crawl, async research |
| **Image Generation** | [fal.ai](https://fal.ai) | AI-generated investment memo cover art |
| **Email Alerts** | [Resend](https://resend.com) | Trigger notification delivery |
| **Database** | SQLite (better-sqlite3) | Persistent storage with UUID primary keys |
| **Validation** | Zod 4 | Schema validation with retry-on-failure |
| **Deployment** | [Alpic](https://alpic.io) | One-command cloud deployment |
| **Protocol** | MCP (Model Context Protocol) | ChatGPT ↔ Server communication via Skybridge |

---

## Setup & Installation

### Prerequisites
- Node.js 20+
- npm 10+
- API keys for partner services (see [Configuration](#configuration))

### Install

```bash
git clone https://github.com/frankterpo/tech_eu_paris_2026.git
cd tech_eu_paris_2026
npm install
```

### Development

```bash
# Start dev server with hot reload
npm run dev
```

The Skybridge dev server starts on `http://localhost:3000`.

### Production Build

```bash
# Build TypeScript + bundle widgets
npm run build

# Start production server
npm start
```

### Deploy to Alpic

```bash
ALPIC_API_KEY=your_key alpic deploy .
```

---

## Configuration

Create a `.env` file in the project root:

```env
# ── Required ──────────────────────────────────────────────
CALA_API_KEY=your_cala_api_key          # Cala AI knowledge search
SPECTER_API_KEY=your_specter_api_key    # Specter company enrichment

# ── Dify Agent Keys (one per persona) ────────────────────
ANALYST_DIFY_KEY=app-xxx                # Dify analyst agent app
ASSOCIATE_DIFY_KEY=app-xxx              # Dify associate agent app
PARTNER_DIFY_KEY=app-xxx                # Dify partner agent app

# ── Optional (enhanced features) ─────────────────────────
TAVILY_API_KEY=tvly-xxx                 # Tavily web search
FAL_AI_API_KEY=xxx                      # fal.ai cover image generation
RESEND_API_KEY=re_xxx                   # Resend email for triggers
LIGHTPANDA_TOKEN=xxx                    # Lightpanda headless browser
DIFY_FC_AGENT_KEY=app-xxx              # Dify FunctionCalling sub-agent
DIFY_REACT_AGENT_KEY=app-xxx           # Dify ReAct sub-agent
NARRATOR_DIFY_KEY=app-xxx              # Dify narration completions

# ── Trigger System ────────────────────────────────────────
TRIGGER_NOTIFY_EMAIL=you@example.com    # Default trigger alert recipient
RESEND_FROM=Deal Bot <you@example.com>  # Sender for trigger emails
```

### Stub Mode
If Dify API keys are missing, the system automatically falls back to **stub mode** — returning valid schema-matching JSON for all personas. This ensures the server always runs, even without Dify configured.

---

## API Reference

### MCP Tools (via ChatGPT)

#### Widgets (Rich UI)
| Tool | Description |
|------|-------------|
| `company-profile` | Research a company — instant Specter profile with funding, team, traction |
| `deal-dashboard` | Live deal analysis dashboard with pipeline status, rubric, decision gate |
| `trigger-setup` | Configure monitoring triggers for a company |

#### Deal Workflow
| Tool | Description |
|------|-------------|
| `analyze_deal` | **Primary tool** — creates deal + runs full simulation in one step |
| `create_deal` | Create deal session with detailed deal terms (without running) |
| `run_deal` | Start/re-run simulation for existing deal |
| `list_deals` | List all deal analysis sessions |
| `lookup_deal` | Find deal by company name or domain |

#### Specter AI (Company Intelligence)
| Tool | Description |
|------|-------------|
| `specter_company_people` | Get leadership team with LinkedIn URLs |
| `specter_similar_companies` | AI-matched competitor discovery |
| `specter_search_name` | Search company by name |
| `specter_text_search` | Extract entities from unstructured text |
| `specter_company_by_id` | Full company profile by Specter ID |
| `specter_enrich_person` | Enrich person by LinkedIn URL |
| `specter_person_by_id` | Person profile by Specter ID |
| `specter_person_email` | Verified professional email lookup |
| `specter_competitor_pipeline` | Full competitive intelligence pipeline |

#### Cala AI (Knowledge Search)
| Tool | Description |
|------|-------------|
| `cala_search` | Deep search with AI answer + entity extraction |
| `cala_query` | Structured query for precise data points |
| `cala_get_entity` | Entity detail by ID |
| `cala_search_entities` | Fuzzy entity search |

#### Tavily AI (Web Research)
| Tool | Description |
|------|-------------|
| `tavily_web_search` | Real-time web search with topic/time filters |
| `tavily_extract` | Extract/parse web page content |
| `tavily_crawl` | Graph-based website traversal |
| `tavily_research` | Async deep research with report generation |
| `tavily_research_status` | Poll research task status |

#### Dify Agents (Sub-tasks)
| Tool | Description |
|------|-------------|
| `dify_agent_fc` | FunctionCalling strategy agent |
| `dify_agent_react` | ReAct strategy agent (step-by-step reasoning) |

#### Triggers & Monitoring
| Tool | Description |
|------|-------------|
| `create_trigger` | Create a monitoring trigger with email alerts |
| `create_triggers_batch` | Batch create triggers for a company |
| `list_triggers` | List all active triggers |
| `check_triggers` | Run all triggers NOW (poll + email) |
| `delete_trigger` | Remove a trigger |
| `cala_triggers_status` | Check Cala Beta Triggers API status |

#### Utilities
| Tool | Description |
|------|-------------|
| `web_extract` | Legacy URL content extraction |
| `lightpanda_scrape` | JS-heavy page scraping via headless browser |

### REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/deals` | Create a deal session |
| `POST` | `/api/deals/:id/run` | Start simulation |
| `GET` | `/api/deals/:id/stream` | SSE event stream |
| `GET` | `/api/deals/:id/state` | Current deal state |
| `GET` | `/api/deals/:id/runs` | List archived runs |
| `GET` | `/api/deals` | List all deals |
| `POST` | `/api/tools/cala/search` | Direct Cala search |
| `POST` | `/api/tools/specter/enrich` | Direct Specter enrich |
| `GET` | `/api/tools/health` | Tool health check |

### OpenAPI Spec
Full OpenAPI 3.0 specification for all tool endpoints: [`server/openapi-tools.json`](server/openapi-tools.json)

---

## Orchestration Pipeline

The orchestrator runs a **3-wave parallel pipeline**:

```
Wave 0: Evidence Seed (parallel)
├── Cala search (knowledge base)
├── Specter enrich (company profile)
├── [background] Batch intel (8 categories, throttled)
└── [background] Founder deep dive (4 targeted queries)

Wave 1: Analysts + Competitive Intel (ALL parallel)
├── Analyst 1: Market (TAM, growth, demand)
├── Analyst 2: Competition (competitors, moats, positioning)
├── Analyst 3: Traction (revenue, team, PMF signals)
├── Specter similar companies (competitive benchmarking)
└── fal.ai cover image (memo aesthetic)

Wave 2: Associate + Unknown Resolution (parallel)
├── Associate (synthesize → hypotheses, bull/bear, mitigants)
└── Unknown resolution (Specter + Tavily for analyst gaps)

Wave 3: Partner + Memo
├── Partner (score rubric, decision gate, gating questions)
└── Investment memo (8 slides + cover art)
```

### Event Types
| Event | Description |
|-------|-------------|
| `NODE_STARTED` | Agent begins work |
| `MSG_SENT` | Message passed between agents |
| `NODE_DONE` | Agent completes |
| `EVIDENCE_ADDED` | New evidence items added to state |
| `STATE_PATCH` | State updated (hypotheses, rubric) |
| `DECISION_UPDATED` | Decision gate produced |
| `LIVE_UPDATE` | Real-time narration for UI |
| `COMPANY_PROFILE_ADDED` | Specter profile ingested |
| `TRIGGER_SUGGESTIONS_READY` | Intel categories ready for trigger creation |
| `ERROR` | Error (non-blocking, continues degraded) |

---

## Data Models

### DealState
```typescript
interface DealState {
  deal_input: DealInput;          // Company info, fund config, persona config
  evidence: Evidence[];            // All collected evidence items
  company_profile: CompanyProfile; // Specter company data
  hypotheses: Hypothesis[];        // Associate-generated
  rubric: {                        // Partner scores (0-100 each)
    market: { score: number; reasons: string[] };
    moat: { score: number; reasons: string[] };
    why_now: { score: number; reasons: string[] };
    execution: { score: number; reasons: string[] };
    deal_fit: { score: number; reasons: string[] };
  };
  decision_gate: {
    decision: 'KILL' | 'PROCEED' | 'PROCEED_IF' | 'STRONG_YES';
    gating_questions: [string, string, string]; // Exactly 3
    evidence_checklist: ChecklistItem[];         // ≤ 15 items
  };
}
```

### Validation (Zod Schemas)
All agent outputs are validated with strict Zod schemas:
- `AnalystOutput`: facts (≤12), contradictions (≤8), unknowns (≤8)
- `AssociateOutput`: hypotheses (≤6), top_unknowns, requests_to_analysts
- `PartnerOutput`: rubric (5 dimensions), decision_gate (exactly 3 gating Qs), evidence_checklist (≤15)

Failed validation triggers a **retry-once** with errors embedded in the re-prompt. Second failure emits an `ERROR` event and continues in degraded mode — the Decision Gate is always produced.

---

## Investor Lens System

The system supports 6 fund types, each with distinct evaluation philosophies:

| Fund Type | Risk Appetite | Return Target | Key Focus |
|-----------|--------------|---------------|-----------|
| Angel | Aggressive | 50-100x | Founder conviction, vision, TAM |
| Early VC | Aggressive | 10-30x | PMF signals, team, growth rate |
| Growth VC | Moderate | 5-10x | ARR, unit economics, path to $100M |
| Late VC | Moderate | 3-5x | Market leadership, IPO readiness |
| PE | Conservative | 2-3x MOIC | EBITDA, cash flow, operational levers |
| IB | Conservative | Fee-based | M&A readiness, strategic positioning |

Each fund type has:
- **Scoring weights** (market, moat, why_now, execution, deal_fit — 0-2x multipliers)
- **Deal-breakers** (automatic flags in analysis)
- **Key metrics** (ordered by importance for the fund type)
- **Evaluation lens** (injected into every agent prompt)

---

## Deployment

### Alpic (Production)
```bash
ALPIC_API_KEY=your_key alpic deploy .
```
Deploys to: `https://tech-eu-paris-2026-{hash}.alpic.live`

### Local Development
```bash
npm run dev  # Starts Skybridge dev server on :3000
```

### ChatGPT Integration
1. Deploy to Alpic (or use ngrok for local)
2. In ChatGPT → Create a GPT → Add Action → MCP Server
3. Point to your deployment URL
4. The GPT auto-discovers all 30+ tools via MCP protocol

---

## Project Structure

```
tech_eu_paris_2026/
├── server/
│   ├── src/
│   │   ├── server.ts              # MCP tool registrations (30+ tools)
│   │   ├── orchestrator.ts        # 3-wave parallel pipeline
│   │   ├── types.ts               # TypeScript types + investor profiles
│   │   ├── validators.ts          # Zod schemas for agent outputs
│   │   ├── validate-with-retry.ts # Retry-once validation logic
│   │   ├── reducer.ts             # Event → state reducer
│   │   ├── persistence.ts         # Dual-write: SQLite + file
│   │   ├── db.ts                  # SQLite with UUID primary keys
│   │   ├── middleware.ts          # Express middleware
│   │   ├── tool-routes.ts         # REST API for tool endpoints
│   │   ├── index.ts               # Server entry point
│   │   └── integrations/
│   │       ├── cala/client.ts     # Cala AI: search, query, entities, triggers
│   │       ├── specter/client.ts  # Specter: enrich, similar, people, search
│   │       ├── dify/client.ts     # Dify: agent execution, completions
│   │       ├── tavily/client.ts   # Tavily: search, extract, crawl, research
│   │       ├── fal/client.ts      # fal.ai: memo cover generation
│   │       └── lightpanda/client.ts # Headless browser scraping
│   └── openapi-tools.json         # OpenAPI 3.0 spec for Dify agents
├── web/
│   └── src/
│       ├── widgets/
│       │   ├── company-profile.tsx # Company research card
│       │   ├── deal-dashboard.tsx  # Live pipeline + decision gate
│       │   └── trigger-setup.tsx   # Monitoring trigger configuration
│       ├── helpers.ts             # Skybridge hooks
│       └── index.css              # Global styles
├── context/                       # Architecture docs + specs
├── dify-workflows/                # Dify agent YAML configs
├── DEMO_SCRIPT.md                 # 2-minute video demo script
├── AGENTS.md                      # AI agent coding rules
├── alpic.json                     # Alpic deployment config
├── package.json
└── tsconfig.json
```

---

## License

Built for Tech EU Paris 2026 Hackathon.
