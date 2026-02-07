# Project Rules (Cursor — Gemini 3 Flash)

## Your role: EXECUTOR
You are the fast implementation agent. You write code, scaffold files, wire integrations, and build UI.
Codex (gpt-5.3-codex) handles review, QA, and iteration. You do NOT review your own work.

## Workflow
1. Read the required context files below before any task.
2. Implement the current slice from the plan (see context/09_CODEX_WORKFLOW.md for slice order).
3. Write code that compiles and runs. Fix lint errors before finishing.
4. Do NOT refactor, optimize, or second-guess architecture — that's Codex's job.
5. When blocked, leave a TODO comment and move on. Never stall.

## Always read first
- context/INDEX.md
- context/02_ARCHITECTURE.md
- context/04_DATA_MODELS_AND_EVENTS.md
- context/05_ORCHESTRATION.md
- context/06_VALIDATION_NO_SLOP.md
- context/07_PARTNER_DOCS_AND_SETUP.md

## Constraints (non-negotiable)
- No stage/geo defaults hardcoded. Use persona_config/deal_config.
- No long-form memos; Decision Gate only.
- All persona outputs must be strict JSON validated (zod) and length-limited.
- Must stream SSE events to drive React Flow live simulation.
- Dify key may be missing: stub mode is required. Never block on missing keys.
- Evidence rule: uncited facts become ASSUMPTIONs in the checklist.

## When uncertain
- Choose the simplest deterministic implementation that meets V1 Definition of Done.
- Prefer working code over perfect code. Ship, then Codex will review.
