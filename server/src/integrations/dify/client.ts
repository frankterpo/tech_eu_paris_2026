import type { AnalystOutput, AssociateOutput, PartnerOutput } from '../../validators.js';

export type DifyAgentName = 'analyst' | 'associate' | 'partner';

/** Per-agent env var mapping (now pointing to agent-chat app keys) */
const AGENT_KEY_MAP: Record<DifyAgentName, string> = {
  analyst:   'ANALYST_DIFY_KEY',
  associate: 'ASSOCIATE_DIFY_KEY',
  partner:   'PARTNER_DIFY_KEY',
};

export class DifyClient {
  // Agent mode: tool calls take longer (5+ tools × 30s each), so 300s timeout
  private static readonly TIMEOUT_MS = 300_000;

  private static get API_BASE() {
    return process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1';
  }

  private static getKeyForAgent(agent: DifyAgentName): string | undefined {
    return process.env[AGENT_KEY_MAP[agent]];
  }

  // ── JSON extraction helpers ──────────────────────────────────────────
  /**
   * Robustly extract a JSON object from agent text response.
   * Handles: raw JSON, markdown-fenced, text-wrapped.
   */
  private static extractJSON(text: string): unknown | null {
    const trimmed = text.trim();

    // 1. Direct parse
    try { return JSON.parse(trimmed); } catch { /* continue */ }

    // 2. Markdown code fence: ```json ... ``` or ``` ... ```
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
    }

    // 3. Outermost { ... } braces
    const braceStart = trimmed.indexOf('{');
    const braceEnd = trimmed.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      try { return JSON.parse(trimmed.slice(braceStart, braceEnd + 1)); } catch { /* continue */ }
    }

    return null;
  }

  // ── SSE stream reader ────────────────────────────────────────────────
  /**
   * Read a Dify streaming SSE response and accumulate the full answer text.
   * Agent-chat streams events: agent_thought, agent_message, message_end, error.
   * We accumulate `answer` chunks from `agent_message` events.
   * Optional onToolCall fires on each agent_thought with tool names + thinking + tool input.
   */
  private static async readSSEAnswer(
    response: Response,
    agent: string,
    onToolCall?: (info: { toolNames: string[]; callNumber: number; thought?: string; toolInput?: string }) => void,
  ): Promise<string> {
    const body = response.body;
    if (!body) throw new Error(`Dify agent "${agent}" returned no response body`);

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let answer = '';
    let buffer = '';
    let toolCalls = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6); // remove "data: "
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);
            const eventType = event.event;

            if (eventType === 'agent_message' || eventType === 'message') {
              // Accumulate answer text chunks
              answer += event.answer || '';
            } else if (eventType === 'agent_thought') {
              // Log tool calls for debugging + fire callback
              if (event.tool) {
                toolCalls++;
                const toolNames = event.tool.split(';').filter(Boolean);
                console.log(`[Dify] Agent "${agent}" tool call #${toolCalls}: ${event.tool}`);
                if (onToolCall) {
                  onToolCall({ toolNames, callNumber: toolCalls, thought: event.thought || undefined, toolInput: event.tool_input || undefined });
                }
              } else if (event.thought && onToolCall) {
                // Pure thinking (no tool call) — still emit for narration
                onToolCall({ toolNames: [], callNumber: toolCalls, thought: event.thought });
              }
            } else if (eventType === 'message_end') {
              // Stream complete
              console.log(`[Dify] Agent "${agent}" stream ended (${toolCalls} tool calls)`);
            } else if (eventType === 'error') {
              throw new Error(`Dify stream error (${agent}): ${event.message || event.code || 'unknown'}`);
            }
          } catch (parseErr: any) {
            if (parseErr.message?.startsWith('Dify stream error')) throw parseErr;
            // Ignore non-JSON SSE lines (e.g., comments, pings)
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return answer;
  }

  // ── Main entry point ─────────────────────────────────────────────────
  /**
   * Call a Dify agent-chat app (streaming mode — agent-chat doesn't support blocking).
   *
   * @param agent   – which persona (analyst | associate | partner)
   * @param inputs  – user_input_form variables (deal_input, fund_config, etc.)
   * @param query   – the "user message" sent to the agent; used for retry prompts
   */
  static async runAgent<T>(
    agent: DifyAgentName,
    inputs: Record<string, string>,
    query?: string,
    onToolCall?: (info: { toolNames: string[]; callNumber: number; thought?: string; toolInput?: string }) => void,
  ): Promise<T> {
    const apiKey = this.getKeyForAgent(agent);

    if (!apiKey) {
      console.warn(`No API key for Dify agent "${agent}" (env: ${AGENT_KEY_MAP[agent]}). Using stub.`);
      return this.getStubResponse<T>(agent, inputs);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      const userQuery = query || 'Run your analysis and return the JSON output.';
      console.log(`[Dify] Calling agent "${agent}" (streaming, query: "${userQuery.slice(0, 80)}…")…`);

      const response = await fetch(`${this.API_BASE}/chat-messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          inputs,
          query: userQuery,
          response_mode: 'streaming',
          user: 'orchestrator'
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        clearTimeout(timeout);
        const errorText = await response.text();
        throw new Error(`Dify API error (${agent}): ${response.status} ${response.statusText} – ${errorText}`);
      }

      // Read the SSE stream and accumulate the full answer
      const answer = await this.readSSEAnswer(response, agent, onToolCall);
      clearTimeout(timeout);

      if (!answer) {
        console.warn(`[Dify] Agent "${agent}" returned empty answer after streaming.`);
        throw new Error(`Dify agent "${agent}" returned empty answer`);
      }

      const parsed = this.extractJSON(answer);
      if (parsed !== null) {
        console.log(`[Dify] Agent "${agent}" completed — JSON extracted (${answer.length} chars)`);
        return parsed as T;
      }

      console.warn(`[Dify] Agent "${agent}" answer not parseable as JSON (${answer.length} chars). First 300: ${answer.slice(0, 300)}`);
      throw new Error(`Dify agent "${agent}" did not return valid JSON. First 300 chars: ${answer.slice(0, 300)}`);

    } catch (error: any) {
      clearTimeout(timeout);
      const reason = error.name === 'AbortError' ? `timeout (${this.TIMEOUT_MS}ms)` : error.message;
      console.error(`[Dify] Error calling agent "${agent}": ${reason}`);
      throw new Error(`Dify agent "${agent}" failed: ${reason}`);
    }
  }

  // ── Completion API (text-gen apps — fast, blocking, no tool calls) ───
  /**
   * Call a Dify Completion (text-generation) app.
   * Uses `/completion-messages` in blocking mode for quick, one-shot narration.
   *
   * @param prompt  – the input text (mapped to `inputs.query`)
   * @param apiKey  – the completion app API key (env: NARRATOR_DIFY_KEY)
   * @returns the completion answer string
   */
  static async runCompletion(prompt: string, apiKey?: string): Promise<string> {
    const key = apiKey || process.env.NARRATOR_DIFY_KEY;
    if (!key) return '';  // no narrator key → caller falls back to template

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000); // 30s max

    try {
      const response = await fetch(`${this.API_BASE}/completion-messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
          inputs: { query: prompt },
          response_mode: 'blocking',
          user: 'narrator'
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const err = await response.text();
        console.warn(`[Dify] Completion error: ${response.status} – ${err.slice(0, 200)}`);
        return '';
      }

      const data = await response.json() as any;
      return (data.answer || '').trim();
    } catch (e: any) {
      clearTimeout(timeout);
      console.warn(`[Dify] Completion failed: ${e.message}`);
      return '';
    }
  }

  // ── Generic agent call (FunctionCalling / ReAct sub-agents) ──────────
  /**
   * Call any Dify agent-chat app by explicit API key.
   * Used for FunctionCalling and ReAct strategy sub-agents.
   *
   * @param apiKey       – Dify app API key
   * @param instruction  – system instruction for the agent
   * @param query        – the user query / task
   * @param context      – optional context string injected as input variable
   * @param maxIterations – hint for the agent (passed as input variable)
   * @param label        – display label for logging
   */
  static async runCustomAgent(
    apiKey: string,
    opts: {
      instruction: string;
      query: string;
      context?: string;
      maxIterations?: number;
      label?: string;
    },
    onToolCall?: (info: { toolNames: string[]; callNumber: number; thought?: string; toolInput?: string }) => void,
  ): Promise<{ answer: string; parsed: unknown | null; toolCalls: number }> {
    const label = opts.label || 'custom';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      console.log(`[Dify] Custom agent "${label}" — query: "${opts.query.slice(0, 80)}…"`);

      const response = await fetch(`${this.API_BASE}/chat-messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          inputs: {
            query: opts.query,
            instruction: opts.instruction || '',
            context: opts.context || '',
            max_iterations: String(opts.maxIterations || 5),
          },
          query: opts.query,
          response_mode: 'streaming',
          user: `agent-${label}`,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        clearTimeout(timeout);
        const errText = await response.text();
        throw new Error(`Dify API error (${label}): ${response.status} – ${errText.slice(0, 300)}`);
      }

      let toolCallCount = 0;
      const answer = await this.readSSEAnswer(response, label, (info) => {
        toolCallCount = info.callNumber;
        if (onToolCall) onToolCall(info);
      });
      clearTimeout(timeout);

      const parsed = this.extractJSON(answer);
      console.log(`[Dify] Custom agent "${label}" done — ${answer.length} chars, ${toolCallCount} tool calls, JSON: ${parsed !== null}`);

      return { answer, parsed, toolCalls: toolCallCount };
    } catch (error: any) {
      clearTimeout(timeout);
      const reason = error.name === 'AbortError' ? `timeout (${this.TIMEOUT_MS}ms)` : error.message;
      console.error(`[Dify] Custom agent "${label}" error: ${reason}`);
      throw new Error(`Dify custom agent "${label}" failed: ${reason}`);
    }
  }

  // ── Backward-compat alias (used by validateWithRetry) ────────────────
  /** @deprecated — alias kept so existing orchestrator compiles during transition */
  static async runWorkflow<T>(
    workflow: DifyAgentName,
    inputs: Record<string, any>,
    query?: string
  ): Promise<T> {
    return this.runAgent<T>(workflow, inputs, query);
  }

  // ── Stub responses (no API key) ──────────────────────────────────────
  private static getStubResponse<T>(agent: DifyAgentName, inputs: Record<string, any>): T {
    switch (agent) {
      case 'analyst': {
        const analystId = inputs.analyst_id || 'analyst';
        const specialization = inputs.specialization || 'general';
        return {
          facts: [{ text: `Stub fact from ${analystId} (${specialization})`, evidence_ids: ['e1'] }],
          contradictions: [],
          unknowns: [{ question: `Stub unknown from ${analystId}`, why: 'Stub mode — no Dify key' }],
          evidence_requests: []
        } as any;
      }
      case 'associate':
        return {
          hypotheses: [{ id: 'h1', text: 'Stub hypothesis (Dify stub)', support_evidence_ids: ['e1'], risks: ['Stub risk'] }],
          top_unknowns: [{ question: 'Stub top unknown', why_it_matters: 'Needs investigation' }],
          requests_to_analysts: []
        } as any;

      case 'partner':
        return {
          rubric: {
            market: { score: 72, reasons: ['Large TAM from stub data'] },
            moat: { score: 45, reasons: ['No clear moat identified'] },
            why_now: { score: 60, reasons: ['Market timing favorable'] },
            execution: { score: 55, reasons: ['Team capability unknown'] },
            deal_fit: { score: 65, reasons: ['Aligns with fund thesis'] }
          },
          decision_gate: {
            decision: 'PROCEED_IF',
            gating_questions: [
              'Is the addressable market >$1B?',
              'Can the team ship v1 in <6 months?',
              'Is there a defensible moat beyond first-mover?'
            ],
            evidence_checklist: [
              { q: 1, item: 'Market size estimate (stub)', type: 'EVIDENCE', evidence_ids: ['e1'] },
              { q: 2, item: 'Team shipping velocity', type: 'ASSUMPTION', evidence_ids: [] },
              { q: 3, item: 'IP / network effects', type: 'ASSUMPTION', evidence_ids: [] }
            ]
          }
        } as any;

      default:
        throw new Error(`Unknown agent: ${agent}`);
    }
  }
}
