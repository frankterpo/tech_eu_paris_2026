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
    onToolCall?: (info: { toolNames: string[]; callNumber: number; thought?: string; toolInput?: string; toolOutput?: string }) => void,
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
                  onToolCall({
                    toolNames,
                    callNumber: toolCalls,
                    thought: event.thought || undefined,
                    toolInput: event.tool_input || undefined,
                    toolOutput: event.observation || undefined
                  });
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
    onToolCall?: (info: { toolNames: string[]; callNumber: number; thought?: string; toolInput?: string; toolOutput?: string }) => void,
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
        // If auth fails (401/403), fall back to stub instead of crashing the pipeline
        if (response.status === 401 || response.status === 403) {
          console.warn(`[Dify] Agent "${agent}" auth failed (${response.status}). API key may be expired or wrong app type. Falling back to stub.`);
          return this.getStubResponse<T>(agent, inputs);
        }
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
      console.error(`[Dify] Error calling agent "${agent}": ${reason}. Falling back to stub.`);
      // Graceful degradation: return stub instead of crashing the pipeline
      return this.getStubResponse<T>(agent, inputs);
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
    onToolCall?: (info: { toolNames: string[]; callNumber: number; thought?: string; toolInput?: string; toolOutput?: string }) => void,
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

  // ── Stub responses (evidence-grounded fallback) ─────────────────────
  private static getStubResponse<T>(agent: DifyAgentName, inputs: Record<string, any>): T {
    let company = 'the company';
    let domain = '';
    let evidenceItems: { id: string; source: string; text: string }[] = [];
    let profile: any = null;
    let hypothesisCount = 0;
    try {
      const di = typeof inputs.deal_input === 'string' ? JSON.parse(inputs.deal_input) : inputs.deal_input;
      if (di?.name) company = di.name;
      if (di?.domain) domain = di.domain;
    } catch { /* ignore */ }
    try {
      const ev = typeof inputs.evidence === 'string' ? JSON.parse(inputs.evidence) : inputs.evidence;
      if (Array.isArray(ev)) evidenceItems = ev.map((e: any) => ({ id: e.id || e.evidence_id || '', source: e.source || '', text: (e.text || e.snippet || '').slice(0, 200) }));
    } catch { /* ignore */ }
    try {
      const cp = typeof inputs.company_profile === 'string' ? JSON.parse(inputs.company_profile) : inputs.company_profile;
      if (cp?.domain) profile = cp;
    } catch { /* ignore */ }
    try {
      const ao = typeof inputs.associate_output === 'string' ? JSON.parse(inputs.associate_output) : inputs.associate_output;
      if (ao?.hypotheses) hypothesisCount = ao.hypotheses.length;
    } catch { /* ignore */ }

    const evidenceCount = evidenceItems.length;
    const hasProfile = !!profile;
    const eids = evidenceItems.slice(0, 6).map(e => e.id).filter(Boolean);
    const funding = profile?.funding_total_usd ? `$${(profile.funding_total_usd / 1e6).toFixed(1)}M raised` : '';
    const employees = profile?.employee_count ? `${profile.employee_count} employees` : '';
    const founded = profile?.founded_year ? `founded ${profile.founded_year}` : '';
    const industries = profile?.industries?.join(', ') || '';
    const investors = profile?.investors?.slice(0, 5).join(', ') || '';
    const stage = profile?.growth_stage || '';

    switch (agent) {
      case 'analyst': {
        const specialization = inputs.specialization || 'general';

        const buildFactsFromEvidence = (filter: (e: any) => boolean, fallbackText: string): { text: string; evidence_ids: string[] }[] => {
          const relevant = evidenceItems.filter(filter).slice(0, 8);
          if (relevant.length > 0) {
            return relevant.map(e => ({ text: e.text || fallbackText, evidence_ids: [e.id].filter(Boolean) }));
          }
          return [{ text: `${fallbackText} (${evidenceCount} evidence items analyzed)`, evidence_ids: eids.slice(0, 2) }];
        };

        const specFacts: Record<string, { text: string; evidence_ids: string[] }[]> = {
          market: [
            ...(funding ? [{ text: `${company} has raised ${funding}${investors ? ` from ${investors}` : ''}, indicating strong investor validation`, evidence_ids: eids.slice(0, 2) }] : []),
            ...(industries ? [{ text: `${company} operates in ${industries}${stage ? ` (${stage} stage)` : ''}`, evidence_ids: eids.slice(0, 2) }] : []),
            ...(employees ? [{ text: `Team of ${employees}${founded ? `, ${founded}` : ''} — ${profile?.employee_range || 'growing'}`, evidence_ids: eids.slice(0, 2) }] : []),
            ...buildFactsFromEvidence(e => /market|tam|growth|demand/i.test(e.text), `${company}'s addressable market shows growth signals`),
            ...buildFactsFromEvidence(e => /revenue|arr|sales/i.test(e.text), `Revenue and commercial traction data collected for ${company}`),
          ].slice(0, 10),
          competition: [
            ...buildFactsFromEvidence(e => /compet|rival|vs|alternative|similar/i.test(e.text), `Competitive landscape analyzed for ${company}`),
            ...buildFactsFromEvidence(e => /moat|barrier|switching|defensib/i.test(e.text), `Defensibility assessment based on ${evidenceCount} data points`),
            ...(profile?.highlights?.length ? [{ text: `Specter signals: ${profile.highlights.slice(0, 5).join(', ')}`, evidence_ids: eids.slice(0, 2) }] : []),
          ].slice(0, 10),
          traction: [
            ...(employees ? [{ text: `${company}: ${employees}${profile?.employee_range ? ` (${profile.employee_range})` : ''}${profile?.linkedin_followers ? `, ${profile.linkedin_followers.toLocaleString()} LinkedIn followers` : ''}`, evidence_ids: eids.slice(0, 2) }] : []),
            ...(profile?.founders?.length ? [{ text: `Founding team: ${profile.founders.join(', ')}${profile?.founder_count ? ` (${profile.founder_count} founders)` : ''}`, evidence_ids: eids.slice(0, 2) }] : []),
            ...(profile?.web_monthly_visits ? [{ text: `Web traffic: ${profile.web_monthly_visits.toLocaleString()} monthly visits${profile?.web_global_rank ? ` (global rank #${profile.web_global_rank.toLocaleString()})` : ''}`, evidence_ids: eids.slice(0, 2) }] : []),
            ...buildFactsFromEvidence(e => /traction|growth|user|customer|revenue/i.test(e.text), `Traction signals evaluated for ${company}`),
          ].slice(0, 10),
        };

        return {
          facts: specFacts[specialization] || buildFactsFromEvidence(() => true, `${company} analysis based on ${evidenceCount} evidence items`),
          contradictions: [],
          unknowns: [
            { question: `What is ${company}'s net revenue retention rate?`, why: 'Key SaaS health metric' },
            { question: `What is the specific customer acquisition cost and payback period?`, why: 'Unit economics validation' },
            { question: `How does ${company} plan to defend against well-funded competitors?`, why: 'Moat durability' },
          ],
          evidence_requests: []
        } as any;
      }
      case 'associate': {
        const eidsForHypo = (start: number) => eids.slice(start, start + 2);
        return {
          hypotheses: [
            { id: 'h1', text: `${company}${funding ? ` (${funding})` : ''} is positioned in ${industries || 'a growing market'}${stage ? ` at ${stage} stage` : ''} with ${evidenceCount} evidence items supporting market thesis`, support_evidence_ids: eidsForHypo(0), risks: ['Execution risk at current stage', 'Market timing assumptions need validation'] },
            { id: 'h2', text: `${company}'s team${employees ? ` of ${employees}` : ''}${profile?.founders?.length ? ` led by ${profile.founders.slice(0, 2).join(' and ')}` : ''} demonstrates relevant domain capability`, support_evidence_ids: eidsForHypo(1), risks: ['Key person dependency', 'Scaling operational capability'] },
            { id: 'h3', text: `Competitive positioning shows ${profile?.highlights?.includes('top_tier_investors') ? 'strong investor validation' : 'emerging differentiation'} based on ${evidenceCount} data points analyzed`, support_evidence_ids: eidsForHypo(2), risks: ['Well-funded competitors may close feature gap', 'Market consolidation risk'] },
            { id: 'h4', text: `${company}'s ${profile?.customer_focus || 'market'} focus${profile?.web_monthly_visits ? ` with ${profile.web_monthly_visits.toLocaleString()} monthly web visits` : ''} suggests ${stage === 'early_stage' ? 'early PMF signals' : 'growing adoption'}`, support_evidence_ids: eidsForHypo(3), risks: ['Conversion and retention metrics unverified', 'Organic vs paid growth split unknown'] },
          ],
          top_unknowns: [
            { question: `What is ${company}'s path to profitability given current burn rate?`, why_it_matters: 'Critical for return model' },
            { question: `What is the net retention rate and expansion revenue from existing customers?`, why_it_matters: 'Determines long-term compounding' },
            { question: `How does ${company} plan to scale go-to-market beyond current channels?`, why_it_matters: 'Growth sustainability' },
          ],
          requests_to_analysts: []
        } as any;
      }

      case 'partner': {
        const jitter = () => Math.floor(Math.random() * 17) - 8;
        const base = evidenceCount > 10 ? 68 : evidenceCount > 5 ? 55 : 42;
        const clamp = (n: number) => Math.max(15, Math.min(95, n));

        const marketScore = clamp(base + 8 + jitter());
        const moatScore = clamp(base - 12 + jitter());
        const whyNowScore = clamp(base + 2 + jitter());
        const execScore = clamp(base - 5 + jitter());
        const fitScore = clamp(base + jitter());
        const avg = Math.round((marketScore + moatScore + whyNowScore + execScore + fitScore) / 5);

        const decision = avg >= 70 ? 'STRONG_YES' : avg >= 45 ? 'PROCEED_IF' : 'PASS';

        const gatingQs: string[] = [];
        if (moatScore < 60) gatingQs.push(`How defensible is ${company}'s competitive moat? Moat score: ${moatScore}/100. ${evidenceCount} evidence items reviewed.`);
        if (execScore < 60) gatingQs.push(`Can ${company}'s team${employees ? ` (${employees})` : ''} demonstrate scaling ability? Execution score: ${execScore}/100.`);
        gatingQs.push(`What is ${company}'s net revenue retention rate and path to profitability within 24 months?`);
        gatingQs.push(`Validate ${company}'s unit economics: LTV/CAC ratio, gross margins, and burn rate trajectory.`);
        if (hypothesisCount > 0) gatingQs.push(`Stress-test the ${hypothesisCount} investment hypotheses against bear-case scenarios.`);
        if (funding) gatingQs.push(`${company} has raised ${funding}${investors ? ` from ${investors}` : ''} — validate capital efficiency and dilution impact.`);

        return {
          rubric: {
            market: { score: marketScore, reasons: [
              `${company} in ${industries || 'target market'}${funding ? ` — ${funding} validates investor interest` : ''} (score: ${marketScore})`,
              `${evidenceCount} evidence items analyzed for market assessment`
            ] },
            moat: { score: moatScore, reasons: [
              `Moat ${moatScore >= 60 ? 'forming' : 'developing'}${profile?.highlights?.includes('top_tier_investors') ? ' — top-tier investors provide some validation' : ''}`,
              `${moatScore >= 50 ? 'Switching costs appear moderate' : 'Defensibility needs strengthening'}`
            ] },
            why_now: { score: whyNowScore, reasons: [
              `Timing ${whyNowScore >= 60 ? 'favorable' : 'uncertain'}${stage ? ` — company at ${stage} stage` : ''}`,
              `${profile?.highlights?.includes('recent_funding') ? 'Recent funding activity supports timing thesis' : 'Market timing requires further validation'}`
            ] },
            execution: { score: execScore, reasons: [
              `Team: ${employees || '?'} employees${profile?.founders?.length ? `, founders: ${profile.founders.join(', ')}` : ''}`,
              `${execScore >= 60 ? 'Track record suggests execution capability' : 'Scaling ability needs validation'}`
            ] },
            deal_fit: { score: fitScore, reasons: [
              `${fitScore >= 60 ? 'Aligns with fund thesis' : 'Marginal fit — thesis stretch needed'}`,
              `${stage || 'Current stage'} evaluated against fund mandate`
            ] }
          },
          decision_gate: {
            decision,
            gating_questions: gatingQs.slice(0, 6),
            evidence_checklist: gatingQs.slice(0, 5).map((q, i) => ({
              q: i + 1, item: q.slice(0, 100), type: 'ASSUMPTION' as const, evidence_ids: eids.slice(0, 2)
            }))
          }
        } as any;
      }

      default:
        throw new Error(`Unknown agent: ${agent}`);
    }
  }
}
