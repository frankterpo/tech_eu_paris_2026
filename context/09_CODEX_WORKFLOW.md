# Codex CLI Workflow (iterate fast, avoid thrash)

## Principle

Codex should implement in small slices. Cursor verifies + runs + fixes.

## Always include context

Every Codex run MUST read:
- context/INDEX.md
- context/02_ARCHITECTURE.md
- context/05_ORCHESTRATION.md
- context/06_VALIDATION_NO_SLOP.md

## Slice plan (recommended order)

1. Server skeleton (endpoints + SSE + file persistence)
2. Event reducer + canonical state + JSONL log
3. Validators (zod) + retry-once mechanism
4. Cala wrapper (real)
5. UI skeleton (React Flow + SSE listener + panels)
6. Wiring + seeded demo + export

## Codex prompt template (copy/paste)

"Read the context files listed above. Implement ONLY <slice>. Do not build UI unless requested.
Respect: Decision Gate only, strict JSON validation, stub Dify if missing key.
After code changes, add run steps and ensure it compiles."

## "No excuses" rule

If Dify key missing: implement stub mode and continue. Do NOT block.
