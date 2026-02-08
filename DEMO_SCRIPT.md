# Deal Bot: Org-Sim — 2-Minute Loom Demo Script

## Pre-Demo Checklist
- [ ] ChatGPT open with the Deal Bot GPT loaded
- [ ] Loom recording ready (screen + mic)
- [ ] Speak at a natural pace — you have exactly 120 seconds

---

## [0:00–0:15] HOOK — What is this?

**SAY:**
> "Every VC deal starts the same way — someone drops a company name in Slack and then 3 people spend a week Googling. What if you could deploy an entire investment committee — analysts, associate, and partner — in 60 seconds, directly inside ChatGPT?"

**SHOW:** ChatGPT open, nothing typed yet.

---

## [0:15–0:35] STEP 1 — Company Research (Company Profile Widget)

**TYPE in ChatGPT:**
> `Research mistral.ai`

**SAY:**
> "I give it a domain. Specter AI instantly returns the company profile — funding history, team size, revenue estimates, founder names, competitive signals. All structured, all real data, no hallucinations."

**SHOW:** The `company-profile` widget rendering with:
- Funding: $2.1B raised
- Founders: Arthur Mensch, Guillaume Lample, Timothée Lacroix
- Growth stage, employee count, investors
- The "Process Deal →" button

---

## [0:35–0:55] STEP 2 — One Click → Full Deal Analysis

**CLICK:** "Process Deal →"

**SAY:**
> "One click. That's it. Behind the scenes: Cala AI searches its knowledge base for evidence. Specter pulls competitor profiles. Three specialized analysts — market, competition, and traction — launch simultaneously using Dify agent orchestration. Each analyst has access to 20+ research tools and chains queries intelligently."

**SHOW:** The `deal-dashboard` widget appearing with:
- Live animated source feed — evidence cards appearing one by one
- All 3 analyst nodes showing "running" with real-time tool call updates
- Status messages like "⚡ Cala Search: 'Mistral AI market size TAM 2026'"

---

## [0:55–1:20] STEP 3 — Watch the Pipeline Work (The Holy Shit Moment)

**SAY:**
> "This is the magic — you're watching your analysts work. Each one is calling Specter for competitor data, Cala for market intelligence, Tavily for web research. They chain results — entity names from one search drive the next. The associate doesn't wait — the moment analyst findings arrive, it starts synthesizing hypotheses with bull/bear cases and risk mitigants."

**SHOW (scroll through the live dashboard):**
- Analyst nodes turning green as they complete
- Tool call counts: "⚡ Specter Similar × 3 · Cala Search: 'competitive moat defensibility'"
- Associate node activating with hypothesis count
- Partner node scoring the rubric

---

## [1:20–1:40] STEP 4 — The Decision Gate

**SAY:**
> "The partner scores five dimensions — market, moat, timing, execution, deal fit — through an investor lens. We configured this as an Early VC fund, so execution and market are weighted higher. The Decision Gate lands: PROCEED_IF, with three specific, testable gating questions."

**SHOW:**
- Rubric radar chart with scores
- Decision badge: "PROCEED_IF" or "STRONG_YES"
- Three gating questions displayed
- Evidence checklist items

---

## [1:40–1:55] STEP 5 — Export + Triggers

**SAY:**
> "Download the full investment memo as a PDF — cover slide, market analysis, competitive landscape, thesis, risks, and recommendation. Then set up monitoring triggers: revenue milestones, key hires, partnerships. Cala monitors the knowledge base and Resend delivers email alerts. Your deal pipeline stays alive."

**SHOW:**
- Click PDF download button
- Quick flash of trigger-setup widget with category checkboxes

---

## [1:55–2:00] CLOSE

**SAY:**
> "An entire investment committee, deployed in 60 seconds, powered by Cala, Specter, Dify, and Tavily. This is Deal Bot."

**SHOW:** Final dashboard view with completed analysis.

---

## Key Talking Points (if asked follow-ups)

| Feature | Tech | Why it matters |
|---------|------|----------------|
| Company enrichment | Specter API | Real structured data — no hallucinations |
| Knowledge search | Cala AI | 100M+ sources, entity extraction, chained queries |
| Agent orchestration | Dify Cloud | 3 analysts in parallel, function-calling strategy |
| Web research | Tavily API | Real-time search, crawl, deep research |
| Cover art | fal.ai | AI-generated memo covers |
| Monitoring | Cala Triggers + Resend | Persistent deal pipeline alerts |
| Investor lens | Custom profiles | Angel → PE — different risk appetites, scoring weights |
| Deployment | Alpic Cloud | One-command deploy to production |

## Production URL
https://tech-eu-paris-2026-0d53df71.alpic.live
