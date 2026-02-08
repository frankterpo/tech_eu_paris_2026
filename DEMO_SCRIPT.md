# Deal Bot — 2-Minute Demo Script

## [0:00–0:10] HOOK

**SAY:**
> "What if you could deploy an entire investment committee — three analysts, an associate, and a partner — in one click, right inside ChatGPT? This is Deal Bot."

---

## [0:10–0:30] STEP 1 — Company Research

**TYPE:**
```
Look up the company mistral.ai
```

→ Triggers `company-profile` widget.

**SAY:**
> "I type a domain. The company profile loads instantly — funding raised, team size, revenue estimate, founders, growth stage. All real structured data. No hallucinations."

**POINT OUT:** Key numbers on the widget. The "Process Deal →" button.

---

## [0:30–0:50] STEP 2 — Process Deal

**CLICK:** the **"Process Deal →"** button on the widget.

→ Triggers `analyze_deal` which creates the deal, launches the simulation, and opens the `deal-dashboard` automatically.

**SAY:**
> "One click launches everything. Evidence collection starts — the knowledge base is searched, competitor profiles are pulled, and three specialized analysts fire simultaneously: market, competition, and traction. Each one is making live tool calls you can watch in real time."

---

## [0:50–1:15] STEP 3 — Watch the Analysts Work

**SHOW:** The live dashboard updating. Scroll through the feed.

**SAY:**
> "This is the core experience — you're watching your analysts work. The competition analyst is pulling similar companies. The traction analyst is enriching founders. The market analyst is sizing the TAM. The associate starts immediately when results arrive — building hypotheses with bull cases, bear cases, and risk mitigants. No one waits."

---

## [1:15–1:35] STEP 4 — Decision Gate

**SAY:**
> "The partner scores five dimensions — market, moat, timing, execution, deal fit — calibrated to the investor profile. The final output: a decision gate with three testable gating questions. Every claim cites evidence or is flagged as an assumption."

**POINT OUT:** Rubric scores, decision badge, gating questions, evidence checklist.

---

## [1:35–1:50] STEP 5 — Memo + Triggers

**SAY:**
> "The investment memo is auto-generated — download as PDF. Then set monitoring triggers so the deal stays alive after this session."

**TYPE:**
```
Set up monitoring triggers for Mistral AI
```

→ Triggers `trigger-setup` widget with category checkboxes.

---

## [1:50–2:00] CLOSE

**SAY:**
> "One domain. One click. A full investment committee in 60 seconds. This is Deal Bot."

---

## Backup Prompts (if something doesn't auto-trigger)

| Situation | Type this |
|-----------|-----------|
| Dashboard didn't appear | `Show me the deal dashboard for Mistral AI` |
| Want to find a past deal | `Show me my deals` |
| Re-run with different lens | `Re-analyze Mistral AI as a PE fund with $500M AUM` |

---

## Production URL
https://tech-eu-paris-2026-0d53df71.alpic.live
