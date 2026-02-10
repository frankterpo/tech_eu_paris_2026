import React from "react";
import "@/index.css";
import { mountWidget, useSendFollowUpMessage } from "skybridge/web";
import { useToolInfo, useCallTool } from "../helpers.js";

/* ── Types ─────────────────────────────────────────────────────────── */
interface AnalystUnknown {
  question: string;
  resolved: boolean;
  answer: string | null;
}
interface AnalystNode {
  id: string;
  specialization: string;
  status: "done" | "running" | "pending";
  factCount: number;
  unknownCount: number;
  topFacts: string[];
  topUnknowns: (AnalystUnknown | string)[];
}
interface HypothesisSummary { text: string; risks: string[] }
interface LiveUpdate { phase: string; text: string; ts: string }
interface RubricDim { score: number; reasons: string[] }
interface DashboardData {
  deal_input: any;
  evidence: any[];
  hypotheses: any[];
  rubric: { market: RubricDim; moat: RubricDim; why_now: RubricDim; execution: RubricDim; deal_fit: RubricDim };
  decision_gate: { decision: string; gating_questions: string[]; evidence_checklist: any[] };
  company_profile: any;
  pipeline: {
    analysts: AnalystNode[];
    associate: { status: string; hypothesisCount: number; topHypotheses: HypothesisSummary[] };
    partner: { status: string };
  };
  liveUpdates: LiveUpdate[];
  memo: MemoSlide[] | null;
  isComplete: boolean;
  avgScore: number;
  error?: string;
  deal_id?: string;
}
interface MemoSlide {
  type: string;
  title: string;
  subtitle?: string;
  bullets: string[];
  imageUrl?: string;
  metrics?: { label: string; value: string }[];
}

/* ── Helpers ────────────────────────────────────────────────────────── */
const ico = (s: string) => s === "done" ? "✓" : s === "running" ? "●" : "○";
const cls = (s: string) => s === "done" ? "node-done" : s === "running" ? "node-running" : "node-pending";
const scCls = (n: number) => n >= 70 ? "score-high" : n >= 40 ? "score-mid" : "score-low";
const decCls = (d: string) => d === "STRONG_YES" ? "decision-strong-yes" : d === "PASS" || d === "KILL" ? "decision-pass" : "decision-proceed";
const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n) + "…" : s;

function feedForPhase(updates: LiveUpdate[], phasePrefix: string): LiveUpdate[] {
  return updates.filter(u => u.phase.startsWith(phasePrefix));
}

/* ── Sub-Task Feed (shared by all stages) ──────────────────────────── */
function SubTaskFeed({
  feed, isDone, isRunning, phasePrefix
}: {
  feed: LiveUpdate[];
  isDone: boolean;
  isRunning: boolean;
  phasePrefix: string;
}) {
  const queries = feed.filter(u => u.phase === `${phasePrefix}_query`);
  const tools = feed.filter(u => u.phase === `${phasePrefix}_tool`);
  const thinks = feed.filter(u => u.phase === `${phasePrefix}_think`);
  const doneItem = feed.find(u => u.phase === `${phasePrefix}_done`);
  // Catch-all: items that don't match query/tool/think/done (e.g. competitive intel results)
  // Deduplicate by text to prevent duplicate rendering of competitive intel etc.
  const knownPhases = new Set([`${phasePrefix}_query`, `${phasePrefix}_tool`, `${phasePrefix}_think`, `${phasePrefix}_done`]);
  const extrasRaw = feed.filter(u => !knownPhases.has(u.phase));
  const seenTexts = new Set<string>();
  const extras = extrasRaw.filter(u => {
    if (seenTexts.has(u.text)) return false;
    seenTexts.add(u.text);
    return true;
  });

  // Count ACTUAL tool calls — parse "⚡ Cala ×3, Specter ×2" → 5 calls, not 1 event
  let actualCalls = 0;
  for (const t of tools) {
    const multiples = t.text.match(/×(\d+)/g);
    if (multiples) {
      for (const m of multiples) actualCalls += parseInt(m.slice(1), 10);
    } else {
      actualCalls += 1;
    }
  }

  // Compute per-query status: advance by actual calls, cap at last query
  const getQueryStatus = (idx: number) => {
    if (isDone) return "done";
    if (!isRunning) return "pending";
    if (queries.length === 0) return "pending";
    // Cap so the last query stays "active" until _done event arrives
    const activeIdx = Math.min(actualCalls, queries.length - 1);
    if (idx < activeIdx) return "done";
    if (idx === activeIdx) return "active";
    return "pending";
  };

  // Interleave tools + thinks by timestamp for activity stream
  const activity = [...tools, ...thinks].sort((a, b) => a.ts.localeCompare(b.ts));

  return (
    <div className="subtask-feed">
      {/* Progress bar */}
      {isRunning && queries.length > 0 && (
        <div className="st-progress">
          <div
            className="st-progress-bar"
            style={{ width: `${Math.min((actualCalls / Math.max(queries.length, 1)) * 100, 95)}%` }}
          />
          <span className="st-progress-label">
            {actualCalls} tool{actualCalls !== 1 ? "s" : ""} called
          </span>
        </div>
      )}

      {/* Sub-task checklist */}
      {queries.length > 0 && (
        <div className="st-list">
          {queries.map((q, i) => {
            const status = getQueryStatus(i);
            return (
              <div key={i} className={`st-item st-${status}`}>
                <span className="st-icon">
                  {status === "done" ? "✓" : status === "active" ? "⟳" : "○"}
                </span>
                <span className="st-text">{q.text}</span>
                {status === "active" && <span className="st-dots" />}
              </div>
            );
          })}
        </div>
      )}

      {/* Extra items (competitive intel, misc) */}
      {extras.length > 0 && (
        <div className="st-list">
          {extras.map((u, i) => (
            <div key={`x-${i}`} className="st-item st-done">
              <span className="st-icon">✓</span>
              <span className="st-text">{u.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Live activity stream (collapsible) */}
      {activity.length > 0 && (() => {
        // Build tool-type breakdown: "4 Cala · 3 Specter · 2 Web Search"
        const toolCounts: Record<string, number> = {};
        for (const u of tools) {
          const parts = u.text.replace(/^⚡\s*/, "").split("·");
          for (const part of parts) {
            const m = part.trim().match(/^(.+?)(?:\s*[×x:])/);
            const label = m ? m[1].trim() : part.trim().split(":")[0].trim();
            if (label) toolCounts[label] = (toolCounts[label] || 0) + 1;
          }
        }
        const thinkCount = thinks.length;
        const breakdown = Object.entries(toolCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([k, v]) => `${v} ${k}`)
          .join(" · ");
        const summary = breakdown
          ? `${breakdown}${thinkCount > 0 ? ` · ${thinkCount} thought${thinkCount > 1 ? "s" : ""}` : ""}`
          : `${activity.length} action${activity.length !== 1 ? "s" : ""}`;
        return (
        <details className="st-activity-details" open={isRunning && activity.length <= 4}>
          <summary className="st-activity-toggle">
            <span>{summary}</span>
            {isRunning && <span className="st-dots" />}
          </summary>
          <div className="st-activity">
            {activity.map((u, i) => {
              const isLast = i === activity.length - 1 && isRunning;
              const itemCls = u.phase.endsWith("_tool") ? "feed-tool" : "feed-think";
              return (
                <div key={i} className={`feed-item ${itemCls}${isLast ? " feed-active" : ""}`}>
                  {u.text}
                </div>
              );
            })}
          </div>
        </details>
        );
      })()}

      {/* Placeholder when running but no feed yet */}
      {isRunning && queries.length === 0 && activity.length === 0 && (
        <div className="feed-item feed-live">
          <span className="st-dots" /> Deploying queries…
        </div>
      )}

      {/* Done summary */}
      {doneItem && (
        <div className="feed-item feed-done">{doneItem.text}</div>
      )}
    </div>
  );
}

/* ── Radar Chart (Partner rubric) ───────────────────────────────────── */
function RadarChart({ scores }: { scores: { label: string; value: number }[] }) {
  const cx = 90, cy = 90, R = 65;
  const n = scores.length;
  const angle = (i: number) => (Math.PI * 2 * i / n) - Math.PI / 2;
  const pt = (i: number, r: number) => ({
    x: cx + r * Math.cos(angle(i)),
    y: cy + r * Math.sin(angle(i)),
  });
  const poly = (r: number) => Array.from({ length: n }, (_, i) => `${pt(i, r).x},${pt(i, r).y}`).join(" ");
  const dataPoly = scores.map((s, i) => pt(i, (s.value / 100) * R));
  const scColor = (v: number) => v >= 70 ? "#2e7d32" : v >= 40 ? "#f57c00" : "#c62828";

  return (
    <div className="radar-wrap">
      <svg viewBox="0 0 180 185" className="radar-svg">
        {[25, 50, 75, 100].map(lv => (
          <polygon key={lv} points={poly((lv / 100) * R)} fill="none" stroke="currentColor" strokeOpacity={0.12} strokeWidth={0.7} />
        ))}
        {scores.map((_, i) => (
          <line key={i} x1={cx} y1={cy} x2={pt(i, R).x} y2={pt(i, R).y} stroke="currentColor" strokeOpacity={0.1} strokeWidth={0.5} />
        ))}
        <polygon points={dataPoly.map(p => `${p.x},${p.y}`).join(" ")} fill="#667eea" fillOpacity={0.18} stroke="#667eea" strokeWidth={1.5} className="radar-area" />
        {scores.map((s, i) => {
          const d = dataPoly[i];
          const lbl = pt(i, R + 16);
          return (
            <g key={i}>
              <circle cx={d.x} cy={d.y} r={3.5} fill={scColor(s.value)} />
              <text x={lbl.x} y={lbl.y - 1} textAnchor="middle" className="radar-label">{s.label}</text>
              <text x={lbl.x} y={lbl.y + 9} textAnchor="middle" className="radar-value" fill={scColor(s.value)}>{s.value}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ── Swarm Mind Map (post-deal agent network) ──────────────────────── */
function SwarmMap({ liveUpdates, analysts, decision, companyName, avgScore }: {
  liveUpdates: LiveUpdate[];
  analysts: AnalystNode[];
  decision: string;
  companyName: string;
  avgScore: number;
}) {
  // Parse tool calls per agent
  const agentTools: Record<string, Record<string, number>> = {};
  for (const u of liveUpdates) {
    if (!u.phase.endsWith("_tool")) continue;
    const agent = u.phase.replace("_tool", "");
    if (!agentTools[agent]) agentTools[agent] = {};
    for (const part of u.text.replace(/^⚡\s*/, "").split(",")) {
      const m = part.trim().match(/^(.+?)(?:\s*×(\d+))?$/);
      if (m) {
        const raw = m[1].trim().toLowerCase();
        const cnt = parseInt(m[2] || "1", 10);
        const key = raw.includes("cala") ? "Cala" : raw.includes("specter") ? "Specter" : raw.includes("tavily") ? "Tavily" : m[1].trim();
        agentTools[agent][key] = (agentTools[agent][key] || 0) + cnt;
      }
    }
  }

  // Aggregate tool totals
  const tt: Record<string, number> = {};
  for (const a of Object.values(agentTools)) for (const [k, v] of Object.entries(a)) tt[k] = (tt[k] || 0) + v;

  // Timing
  const ts0 = liveUpdates.length ? new Date(liveUpdates[0].ts).getTime() : 0;
  const ts1 = liveUpdates.length ? new Date(liveUpdates[liveUpdates.length - 1].ts).getTime() : 0;
  const dur = Math.round((ts1 - ts0) / 1000);
  const durStr = dur > 60 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${dur}s`;
  const totalCalls = Object.values(tt).reduce((s, v) => s + v, 0);

  // SVG layout
  const W = 560, H = 360;
  const toolY = 40, anY = 135, asY = 225, ptY = 305;
  const cx = [93, 280, 467];
  const toolColor: Record<string, string> = { Specter: "#7c4dff", Cala: "#26a69a", Tavily: "#ffa726" };
  // Order by call volume — Specter first (primary), then Cala, then Tavily
  const allTools = Object.entries(tt).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const top3 = allTools.slice(0, 3);
  // Ensure at least Specter and Cala are shown
  if (!top3.includes("Specter")) top3.unshift("Specter");
  if (!top3.includes("Cala")) top3.splice(1, 0, "Cala");
  const toolNodes = top3.slice(0, 3).map((t, i) => ({ label: t, x: cx[i], y: toolY, calls: tt[t] || 0, color: toolColor[t] || "#90a4ae" }));
  const anNodes = analysts.map((a, i) => ({ ...a, x: cx[i], y: anY }));
  const decColor = decision === "STRONG_YES" ? "#2e7d32" : decision === "PASS" || decision === "KILL" ? "#c62828" : "#f57c00";

  // Build edges
  const edges: { x1: number; y1: number; x2: number; y2: number; w: number; c: string }[] = [];
  for (let ai = 0; ai < 3; ai++) {
    const at = agentTools[`analyst_${ai + 1}`] || {};
    for (const tn of toolNodes) {
      const calls = at[tn.label] || 0;
      if (calls > 0) edges.push({ x1: tn.x, y1: tn.y + 18, x2: cx[ai], y2: anY - 22, w: Math.min(calls * 0.6, 4), c: tn.color });
    }
    if (anNodes[ai].factCount > 0) edges.push({ x1: cx[ai], y1: anY + 22, x2: cx[1], y2: asY - 18, w: Math.min(anNodes[ai].factCount * 0.4, 3), c: "#667eea" });
  }
  // assoc tools
  const ast = agentTools["associate"] || {};
  for (const tn of toolNodes) { if (ast[tn.label]) edges.push({ x1: tn.x, y1: tn.y + 18, x2: cx[1], y2: asY - 18, w: 1, c: tn.color }); }
  edges.push({ x1: cx[1], y1: asY + 18, x2: cx[1], y2: ptY - 18, w: 2, c: "#5c6bc0" });
  // partner tools
  const ptt = agentTools["partner"] || {};
  for (const tn of toolNodes) { if (ptt[tn.label]) edges.push({ x1: tn.x, y1: tn.y + 18, x2: cx[1], y2: ptY - 18, w: 1, c: tn.color }); }

  return (
    <details className="swarm-details" open>
      <summary className="swarm-summary">
        <span className="swarm-title">Agent Swarm Activity</span>
        <span className="swarm-meta">{totalCalls} tool calls · {durStr}</span>
      </summary>
      <svg viewBox={`0 0 ${W} ${H}`} className="swarm-svg">
        <defs>
          <filter id="glow"><feGaussianBlur stdDeviation="2.5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>

        {/* Edges */}
        {edges.map((e, i) => (
          <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
            stroke={e.c} strokeWidth={e.w} strokeOpacity={0.35} className="swarm-edge" />
        ))}

        {/* Tool nodes */}
        {toolNodes.map(t => (
          <g key={t.label} filter="url(#glow)">
            <circle cx={t.x} cy={t.y} r={16} fill={t.color} fillOpacity={0.12} stroke={t.color} strokeWidth={1.2} />
            <text x={t.x} y={t.y - 1} textAnchor="middle" className="sw-label" fill={t.color}>{t.label}</text>
            <text x={t.x} y={t.y + 9} textAnchor="middle" className="sw-stat">{t.calls}</text>
          </g>
        ))}

        {/* Analyst nodes */}
        {anNodes.map((a, i) => (
          <g key={a.id} filter="url(#glow)">
            <circle cx={a.x} cy={a.y} r={22} fill="#667eea" fillOpacity={0.1} stroke="#667eea" strokeWidth={1.3} />
            <text x={a.x} y={a.y - 4} textAnchor="middle" className="sw-label" fill="#667eea">{a.specialization}</text>
            <text x={a.x} y={a.y + 8} textAnchor="middle" className="sw-stat">{a.factCount}f · {a.unknownCount}u</text>
          </g>
        ))}

        {/* Associate */}
        <g filter="url(#glow)">
          <circle cx={cx[1]} cy={asY} r={20} fill="#5c6bc0" fillOpacity={0.1} stroke="#5c6bc0" strokeWidth={1.3} />
          <text x={cx[1]} y={asY - 2} textAnchor="middle" className="sw-label" fill="#5c6bc0">Associate</text>
          <text x={cx[1]} y={asY + 10} textAnchor="middle" className="sw-stat">synthesis</text>
        </g>

        {/* Partner */}
        <g filter="url(#glow)">
          <circle cx={cx[1]} cy={ptY} r={20} fill={decColor} fillOpacity={0.12} stroke={decColor} strokeWidth={1.8} />
          <text x={cx[1]} y={ptY - 2} textAnchor="middle" className="sw-label" fill={decColor}>Partner</text>
          <text x={cx[1]} y={ptY + 10} textAnchor="middle" className="sw-stat">{avgScore}/100</text>
        </g>

        {/* Decision label */}
        <text x={cx[1]} y={ptY + 32} textAnchor="middle" className="sw-decision" fill={decColor}>
          {decision === "STRONG_YES" ? "● INVEST" : decision === "PROCEED_IF" ? "● PROCEED" : `● ${decision}`}
        </text>

        {/* Company name (center top) */}
        <text x={cx[1]} y={14} textAnchor="middle" className="sw-company">{companyName}</text>
      </svg>
    </details>
  );
}

/* ── Investment Memo Deck ───────────────────────────────────────────── */
function InvestmentMemo({ slides, decision, avgScore, rubric, decisionGate, dealInput }: {
  slides: MemoSlide[];
  decision?: string;
  avgScore: number;
  rubric?: DashboardData["rubric"];
  decisionGate?: DashboardData["decision_gate"];
  dealInput?: any;
}) {
  // Update recommendation slide with Partner decision if available
  const enriched = slides.map(s => {
    if (s.type === 'recommendation' && decision && decision !== 'PROCEED_IF') {
      const decLabel = decision === 'STRONG_YES' ? 'INVEST' : decision === 'PROCEED_IF' ? 'PROCEED WITH CONDITIONS' : decision;
      return {
        ...s,
        subtitle: `${decLabel} — Avg Score ${avgScore}/100`,
        bullets: [`Decision: ${decLabel}`, `Average rubric score: ${avgScore}/100`, ...s.bullets.slice(0, 3)],
      };
    }
    return s;
  });

  const slideIcons: Record<string, string> = {
    cover: '', overview: '🏢', market: '📈', competition: '⚔️',
    traction: '🚀', thesis: '💡', risks: '⚠️', recommendation: '🎯',
  };

  const buildMarkdown = () => {
    const companyName = dealInput?.name || dealInput?.company_name || 'Deal';
    const now = new Date().toISOString().split('T')[0];
    let md = `# Investment Memo — ${companyName}\n`;
    md += `> Generated ${now} | Average Score: ${avgScore}/100`;
    if (decision) md += ` | Decision: **${decision}**`;
    md += `\n\n---\n\n`;

    for (const slide of enriched) {
      const icon = slideIcons[slide.type] || '';
      md += `## ${icon} ${slide.title}\n\n`;
      if (slide.subtitle) md += `*${slide.subtitle}*\n\n`;
      if (slide.metrics && slide.metrics.length > 0) {
        md += `| ${slide.metrics.map(m => m.label).join(' | ')} |\n`;
        md += `| ${slide.metrics.map(() => '---').join(' | ')} |\n`;
        md += `| ${slide.metrics.map(m => m.value).join(' | ')} |\n\n`;
      }
      if (slide.bullets.length > 0) {
        for (const b of slide.bullets) md += `- ${b}\n`;
        md += '\n';
      }
    }

    if (rubric) {
      md += `---\n\n## Rubric Scores\n\n`;
      md += `| Dimension | Score | Key Reasons |\n`;
      md += `| --- | --- | --- |\n`;
      for (const [dim, data] of Object.entries(rubric)) {
        if (data && typeof data === 'object' && 'score' in data) {
          const reasons = (data.reasons || []).slice(0, 2).join('; ');
          md += `| ${dim.replace(/_/g, ' ')} | ${data.score}/100 | ${reasons} |\n`;
        }
      }
      md += '\n';
    }

    if (decisionGate) {
      md += `## Decision Gate\n\n`;
      md += `**Decision:** ${decisionGate.decision}\n\n`;
      if (decisionGate.gating_questions?.length > 0) {
        md += `### Gating Questions\n\n`;
        for (const q of decisionGate.gating_questions) md += `1. ${q}\n`;
        md += '\n';
      }
      if (decisionGate.evidence_checklist?.length > 0) {
        md += `### Evidence Checklist\n\n`;
        for (const item of decisionGate.evidence_checklist) {
          const text = typeof item === 'string' ? item : item.text || item.item || JSON.stringify(item);
          const status = (typeof item === 'object' && item.status === 'verified') ? 'x' : ' ';
          md += `- [${status}] ${text}\n`;
        }
        md += '\n';
      }
    }

    md += `---\n\n*Generated by DealBot — Cala + Specter + Dify*\n`;
    return { md, companyName, now };
  };

  const triggerDownload = (content: string, filename: string, mimeType: string) => {
    // Try blob URL first (works in most contexts)
    try {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
    } catch {
      // Fallback: data URI (works in iframe contexts where blob URLs are blocked)
      const encoded = btoa(unescape(encodeURIComponent(content)));
      const a = document.createElement('a');
      a.href = `data:${mimeType};base64,${encoded}`;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => document.body.removeChild(a), 300);
    }
  };

  const handleDownloadMd = () => {
    const { md, companyName, now } = buildMarkdown();
    triggerDownload(md, `${companyName.replace(/[^a-zA-Z0-9]/g, '_')}_Memo_${now}.md`, 'text/markdown;charset=utf-8');
  };

  const handleDownloadPdf = () => {
    const { companyName, now } = buildMarkdown();
    const decLabel = decision === 'STRONG_YES' ? 'INVEST' : decision === 'PASS' || decision === 'KILL' ? decision : 'PROCEED WITH CONDITIONS';
    const scColor = (n: number) => n >= 70 ? '#2e7d32' : n >= 40 ? '#f57c00' : '#c62828';

    // Build styled HTML for print-to-PDF
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Investment Memo — ${companyName}</title>
<style>
  @page { margin: 1.5cm; size: A4; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, sans-serif; color: #1a1a2e; line-height: 1.5; padding: 2rem; max-width: 800px; margin: 0 auto; }
  .cover { text-align: center; padding: 3rem 0 2rem; border-bottom: 3px solid #667eea; margin-bottom: 2rem; }
  .cover h1 { font-size: 2rem; color: #1a1a2e; margin-bottom: 0.5rem; }
  .cover .subtitle { font-size: 1.1rem; color: #666; }
  .cover .decision-badge { display: inline-block; padding: 8px 24px; border-radius: 6px; font-weight: 700; font-size: 1.2rem; margin-top: 1rem; color: #fff; }
  .score-row { display: flex; gap: 1rem; justify-content: center; margin: 1.5rem 0; flex-wrap: wrap; }
  .score-item { text-align: center; min-width: 80px; }
  .score-val { font-size: 1.8rem; font-weight: 700; }
  .score-label { font-size: 0.75rem; color: #888; text-transform: uppercase; }
  h2 { font-size: 1.3rem; color: #1a1a2e; margin: 2rem 0 0.8rem; padding-bottom: 0.3rem; border-bottom: 1px solid #e0e0e0; page-break-after: avoid; }
  ul { padding-left: 1.5rem; margin: 0.5rem 0 1rem; }
  li { margin: 0.3rem 0; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; margin: 0.8rem 0 1.5rem; font-size: 0.85rem; }
  th, td { padding: 6px 10px; border: 1px solid #ddd; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  .metrics-row { display: flex; gap: 1rem; margin: 0.5rem 0 1rem; flex-wrap: wrap; }
  .metric { background: #f8f9fa; border-radius: 6px; padding: 8px 14px; text-align: center; min-width: 70px; }
  .metric-val { font-size: 1.1rem; font-weight: 700; color: #1a1a2e; }
  .metric-label { font-size: 0.7rem; color: #888; text-transform: uppercase; }
  .gating { background: #fff8e1; border-left: 3px solid #f57c00; padding: 8px 12px; margin: 0.3rem 0; font-size: 0.9rem; }
  .footer { text-align: center; color: #aaa; font-size: 0.75rem; margin-top: 3rem; border-top: 1px solid #eee; padding-top: 1rem; }
  @media print { body { padding: 0; } .no-print { display: none; } }
</style></head><body>`;

    // Cover
    const decBg = decision === 'STRONG_YES' ? '#2e7d32' : decision === 'PASS' || decision === 'KILL' ? '#c62828' : '#f57c00';
    html += `<div class="cover">
      <h1>${companyName}</h1>
      <div class="subtitle">Investment Memo — ${now}</div>
      <div class="decision-badge" style="background:${decBg}">${decLabel} — ${avgScore}/100</div>
    </div>`;

    // Rubric scores row
    if (rubric) {
      html += `<div class="score-row">`;
      for (const [dim, data] of Object.entries(rubric)) {
        if (data && typeof data === 'object' && 'score' in data) {
          html += `<div class="score-item"><div class="score-val" style="color:${scColor(data.score)}">${data.score}</div><div class="score-label">${dim.replace(/_/g, ' ')}</div></div>`;
        }
      }
      html += `</div>`;
    }

    // Slides
    for (const slide of enriched) {
      if (slide.type === 'cover') continue; // skip cover, we made our own
      const icon = slideIcons[slide.type] || '';
      html += `<h2>${icon} ${slide.title}</h2>`;
      if (slide.subtitle) html += `<p style="color:#666;font-style:italic;margin-bottom:0.5rem">${slide.subtitle}</p>`;
      if (slide.metrics && slide.metrics.length > 0) {
        html += `<div class="metrics-row">${slide.metrics.map(m => `<div class="metric"><div class="metric-val">${m.value}</div><div class="metric-label">${m.label}</div></div>`).join('')}</div>`;
      }
      if (slide.bullets.length > 0) {
        html += `<ul>${slide.bullets.map(b => `<li>${b}</li>`).join('')}</ul>`;
      }
    }

    // Rubric table
    if (rubric) {
      html += `<h2>Rubric Scores</h2><table><tr><th>Dimension</th><th>Score</th><th>Key Reasons</th></tr>`;
      for (const [dim, data] of Object.entries(rubric)) {
        if (data && typeof data === 'object' && 'score' in data) {
          const reasons = (data.reasons || []).slice(0, 2).join('; ');
          html += `<tr><td style="text-transform:capitalize">${dim.replace(/_/g, ' ')}</td><td style="font-weight:700;color:${scColor(data.score)}">${data.score}/100</td><td>${reasons}</td></tr>`;
        }
      }
      html += `</table>`;
    }

    // Gating questions
    if (decisionGate && decisionGate.gating_questions && decisionGate.gating_questions.length > 0 && decisionGate.gating_questions[0] !== 'Pending...') {
      html += `<h2>Gating Questions for IC</h2>`;
      for (const q of decisionGate.gating_questions) html += `<div class="gating">${q}</div>`;
    }

    html += `<div class="footer">Generated by DealBot — Cala + Specter + Dify — ${now}</div>`;
    html += `</body></html>`;

    // Download as HTML file (iframe-safe — no window.open needed)
    // User opens the .html file in browser → Ctrl/Cmd+P → Save as PDF
    html += `<script>window.onload=function(){setTimeout(function(){window.print()},400)}</script>`;
    triggerDownload(html, `${companyName.replace(/[^a-zA-Z0-9]/g, '_')}_Memo_${now}.html`, 'text/html;charset=utf-8');
  };

  return (
    <details className="memo-details" open>
      <summary className="memo-summary">
        <span className="memo-summary-title">Investment Memo</span>
        <span className="memo-summary-actions">
          <button className="memo-download-btn" onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleDownloadMd(); }} title="Download as Markdown">
            .md
          </button>
          <button className="memo-download-btn memo-download-pdf" onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleDownloadPdf(); }} title="Export as PDF">
            .pdf
          </button>
          <span className="memo-summary-meta">{slides.length} slides</span>
        </span>
      </summary>
      <div className="memo-deck">
        {enriched.map((slide, i) => (
          <div key={i} className={`memo-slide memo-${slide.type}`}>
            {/* Cover image */}
            {slide.imageUrl && (
              <div className="memo-cover-img" style={{ backgroundImage: `url(${slide.imageUrl})` }}>
                <div className="memo-cover-overlay">
                  <div className="memo-cover-title">{slide.title}</div>
                  {slide.subtitle && <div className="memo-cover-sub">{slide.subtitle}</div>}
                </div>
              </div>
            )}

            {/* Non-cover slides */}
            {!slide.imageUrl && (
              <>
                <div className="memo-slide-header">
                  <span className="memo-slide-num">{String(i + 1).padStart(2, '0')}</span>
                  <span className="memo-slide-icon">{slideIcons[slide.type] || '📄'}</span>
                  <div>
                    <div className="memo-slide-title">{slide.title}</div>
                    {slide.subtitle && <div className="memo-slide-sub">{slide.subtitle}</div>}
                  </div>
                </div>

                {/* Metrics row */}
                {slide.metrics && slide.metrics.length > 0 && (
                  <div className="memo-metrics">
                    {slide.metrics.map((m, j) => (
                      <div key={j} className="memo-metric">
                        <div className="memo-metric-val">{m.value}</div>
                        <div className="memo-metric-label">{m.label}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Bullets */}
                {slide.bullets.length > 0 && (
                  <ul className="memo-bullets">
                    {slide.bullets.map((b, j) => (
                      <li key={j} className="memo-bullet">{b}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

/* ── Source Feed (Cala/Specter init progress) ─────────────────────── */
function SourceFeed({ updates, isComplete }: { updates: LiveUpdate[]; isComplete: boolean }) {
  const initStages = updates.filter(u => u.phase === 'init_stage' || u.phase === 'founder_deep_dive');
  const sources = updates.filter(u => u.phase === 'source_found');
  const intelQueries = updates.filter(u => u.phase === 'intel_query');
  const intelResults = updates.filter(u => u.phase === 'intel_result');

  const allItems = [...initStages, ...sources, ...intelQueries, ...intelResults];
  if (allItems.length === 0) return null;

  // Once analysts are running, collapse the source feed
  const analystsStarted = updates.some(u => u.phase.startsWith('analyst_'));
  if (isComplete && sources.length === 0) return null;

  return (
    <details className="source-feed" open={!analystsStarted}>
      <summary className="source-feed-header">
        <span className="source-feed-label">EVIDENCE COLLECTION</span>
        <span className="source-feed-count">{sources.length + intelResults.filter(r => r.text.startsWith('✅')).length} sources</span>
      </summary>
      <div className="source-feed-items">
        {initStages.map((s, i) => (
          <div key={`s-${i}`} className="src-item src-stage" style={{ animationDelay: `${i * 0.08}s` }}>
            <span className="src-text">{s.text}</span>
          </div>
        ))}
        {sources.map((s, i) => (
          <div key={`e-${i}`} className="src-item src-source" style={{ animationDelay: `${(initStages.length + i) * 0.08}s` }}>
            <span className="src-text">{s.text}</span>
          </div>
        ))}
        {intelResults.length > 0 && (
          <div className="src-intel-grid">
            {intelResults.map((r, i) => (
              <div key={`i-${i}`} className={`src-intel-chip ${r.text.startsWith('✅') ? 'src-intel-hit' : 'src-intel-miss'}`} style={{ animationDelay: `${i * 0.1}s` }}>
                {r.text.replace(/^[✅○]\s*/, '')}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

/* ── Investor Profile Badge ────────────────────────────────────────── */
const FIRM_TYPES = [
  { value: 'angel', label: 'Angel', emoji: '👼' },
  { value: 'early_vc', label: 'Early VC', emoji: '🚀' },
  { value: 'growth_vc', label: 'Growth VC', emoji: '📈' },
  { value: 'late_vc', label: 'Late VC', emoji: '🏛️' },
  { value: 'pe', label: 'PE', emoji: '🏦' },
  { value: 'ib', label: 'IB', emoji: '💼' },
] as const;

function InvestorProfileBadge({ firmType, aum, dealId, onSwitch, sendFollowUp }: {
  firmType?: string;
  aum?: string;
  dealId: string;
  onSwitch: (firmType: string, aum: string) => void;
  sendFollowUp?: (msg: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [selectedFirm, setSelectedFirm] = React.useState(firmType || 'early_vc');
  const [selectedAum, setSelectedAum] = React.useState(aum || '');
  const [saving, setSaving] = React.useState(false);

  // Sync when parent data changes
  React.useEffect(() => { if (firmType) setSelectedFirm(firmType); }, [firmType]);
  React.useEffect(() => { if (aum) setSelectedAum(aum); }, [aum]);

  const current = FIRM_TYPES.find(f => f.value === (firmType || 'early_vc')) || FIRM_TYPES[1];

  const handleApply = async (rerun: boolean) => {
    if (!dealId) return;
    setSaving(true);
    const firmLabel = FIRM_TYPES.find(f => f.value === selectedFirm)?.label || selectedFirm;
    onSwitch(selectedFirm, selectedAum);
    setOpen(false);
    if (sendFollowUp) {
      sendFollowUp(
        rerun
          ? `Re-run the deal analysis for deal_id="${dealId}" with investor lens: ${firmLabel}${selectedAum ? `, AUM: ${selectedAum}` : ''}. Use run_deal then show deal-dashboard.`
          : `Updated investor profile to ${firmLabel}${selectedAum ? ` with AUM ${selectedAum}` : ''}. Show deal-dashboard for deal_id="${dealId}".`
      );
    }
    setSaving(false);
  };

  return (
    <div className="inv-profile-bar">
      <button className="inv-badge" onClick={() => setOpen(!open)} title="Switch investor profile">
        <span className="inv-badge-emoji">{current.emoji}</span>
        <span className="inv-badge-label">{current.label}</span>
        {aum && <span className="inv-badge-aum">{aum}</span>}
        <span className="inv-badge-arrow">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="inv-dropdown">
          <div className="inv-dropdown-title">Investor Lens</div>
          <div className="inv-firm-grid">
            {FIRM_TYPES.map(ft => (
              <button
                key={ft.value}
                className={`inv-firm-btn ${selectedFirm === ft.value ? 'inv-firm-active' : ''}`}
                onClick={() => setSelectedFirm(ft.value)}
              >
                <span>{ft.emoji}</span>
                <span>{ft.label}</span>
              </button>
            ))}
          </div>
          <input
            className="inv-aum-input"
            type="text"
            placeholder="AUM (e.g. $50M, $500M, $2B)"
            value={selectedAum}
            onChange={e => setSelectedAum(e.target.value)}
          />
          <div className="inv-actions">
            <button className="inv-apply" onClick={() => handleApply(false)} disabled={saving}>
              {saving ? '…' : 'Save'}
            </button>
            <button className="inv-apply inv-apply-rerun" onClick={() => handleApply(true)} disabled={saving}>
              {saving ? '…' : 'Save & Re-run'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Widget ─────────────────────────────────────────────────────────── */
function DealDashboard() {
  const { isSuccess, output, isPending, input } = useToolInfo<"deal-dashboard">();
  const refreshCall = useCallTool("deal-dashboard");
  const runDeal = useCallTool("run_deal");
  const listDeals = useCallTool("list_deals");
  const sendFollowUp = useSendFollowUpMessage();
  const [retrying, setRetrying] = React.useState(false);
  const [showEvidence, setShowEvidence] = React.useState(false);
  const [showHistory, setShowHistory] = React.useState(false);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const failCountRef = React.useRef(0);
  const lastUpdateRef = React.useRef<number>(Date.now());

  const isRefreshing = refreshCall.isPending;
  const refresh = refreshCall.callTool;

  // Cache last successful refresh so UI never blanks between polls
  const cachedRef = React.useRef<any>(null);
  if (refreshCall.isSuccess && refreshCall.data?.structuredContent) {
    const sc = refreshCall.data.structuredContent as any;
    // If server returned "not_found", stop polling — deal is gone
    if (sc.error === "not_found") {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    } else {
      cachedRef.current = sc;
      failCountRef.current = 0; // reset on success
      lastUpdateRef.current = Date.now();
    }
  }
  // Track failed polls (isError on callTool)
  if (refreshCall.isError) {
    failCountRef.current++;
    if (failCountRef.current >= 3 && pollRef.current) {
      clearInterval(pollRef.current); pollRef.current = null;
    }
  }

  const latestOutput = cachedRef.current || output;

  // Determine if pipeline is actively running (not complete)
  const d = (isSuccess && latestOutput) ? latestOutput as unknown as DashboardData : null;
  const dealId = d?.deal_id || (input as any)?.deal_id || "";
  const isRunning = d ? !d.isComplete && !d.error : false;

  // Auto-poll every 12s while running — ChatGPT MCP round-trips are slow
  // On localhost useCallTool is fast, but on ChatGPT each call goes:
  //   widget → ChatGPT backend → Alpic MCP → server → back (3-8s)
  React.useEffect(() => {
    if (isRunning && dealId && !pollRef.current && failCountRef.current < 3) {
      pollRef.current = setInterval(() => {
        if (dealId && !isRefreshing) refresh({ deal_id: dealId });
      }, 12000);
    }
    if ((!isRunning || failCountRef.current >= 3) && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [isRunning, dealId]);

  if (isPending || !isSuccess || !output) {
    return <div className="loading">Loading deal analysis...</div>;
  }

  if (!d) return null;

  if (d.error === "not_found") {
    const companyHint = (input as any)?.company_name || (input as any)?.deal_id || "";
    return (
      <div className="widget deal-pipe">
        <div className="pipe-header">
          <div className="pipe-title">Deal Expired</div>
          <div className="pipe-subtitle">This deal session has expired. Re-run the analysis to get fresh results.</div>
        </div>
        <button className="cp-btn-process" onClick={() => {
          sendFollowUp(companyHint
            ? `Analyze the company "${companyHint}" — use analyze_deal tool`
            : "Start a new deal analysis — ask me which company");
        }}>
          Re-analyze
        </button>
      </div>
    );
  }

  const { pipeline: pl, liveUpdates, isComplete, avgScore } = d;
  const r = d.rubric;
  const dg = d.decision_gate;
  const hasScores = r?.market?.score > 0;
  const analystsDone = pl.analysts.filter(a => a.status === "done").length;
  const totalFacts = pl.analysts.reduce((s, a) => s + a.factCount, 0);
  const anyRunning = pl.analysts.some(a => a.status === "running");
  const assocRunning = pl.associate?.status === "running";
  const partnerRunning = pl.partner?.status === "running";

  // Live status message
  const livePhase = partnerRunning ? "Partner reviewing..." :
    assocRunning ? "Associate analyzing..." :
    anyRunning ? `Analyst researching (${analystsDone}/${pl.analysts.length} done)...` :
    retrying ? "Starting agents..." :
    !isComplete ? "Processing..." : "";

  return (
    <div className="widget deal-pipe" data-llm={`Deal analysis: ${d.deal_input?.name || "unknown"}${d.company_profile?.domain ? ` (${d.company_profile.domain})` : ""}. Status: ${isComplete ? "COMPLETE" : anyRunning ? "analysts researching" : assocRunning ? "associate synthesizing" : partnerRunning ? "partner deciding" : "processing"}. Analysts: ${analystsDone}/${pl.analysts.length} done, ${totalFacts} facts. ${hasScores ? `Scores: market=${r.market.score}, moat=${r.moat.score}, execution=${r.execution.score}, avg=${avgScore}. Decision: ${dg?.decision}.` : "Scoring pending."} Evidence: ${d.evidence?.length || 0} items.`}>


      {/* ═══ HEADER ═══ */}
      <div className="pipe-header">
        <div>
          <div className="pipe-title">{d.deal_input?.name || "Deal"}</div>
          <div className="pipe-subtitle">
            {d.evidence?.length || 0} evidence{d.company_profile?.domain ? ` · ${d.company_profile.domain}` : ""}
            {isComplete ? " · Complete" : ""}
            {!isComplete && (
              <span className="live-inline">
                <span className="live-dot-sm" />
                {livePhase || "Agents initializing..."} · {liveUpdates.length} events
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className={`action-btn action-btn-retry ${retrying ? 'action-btn-spinning' : ''}`}
            disabled={retrying || runDeal.isPending}
            onClick={() => {
              if (!dealId) return;
              setRetrying(true);
              runDeal.callTool({ deal_id: dealId });
              // Start polling after a beat, then clear retrying
              setTimeout(() => { if (dealId) refresh({ deal_id: dealId }); }, 3000);
              setTimeout(() => setRetrying(false), 6000);
            }}
            title="Re-run the full deal analysis pipeline"
          >
            {retrying || runDeal.isPending ? "⟳ Starting…" : "↻ Retry"}
          </button>
          <button className="action-btn" onClick={() => {
            if (dealId) { failCountRef.current = 0; refresh({ deal_id: dealId }); }
          }} disabled={isRefreshing}>
            {isRefreshing ? "Checking…" : "Refresh"}
          </button>
          <button className="action-btn" onClick={() => {
            setShowHistory(!showHistory);
            if (!showHistory) listDeals.callTool({});
          }}>
            {showHistory ? "×" : "History"}
          </button>
        </div>
      </div>

      {/* ═══ HISTORY SIDE PANEL ═══ */}
      {showHistory && (
        <div className="history-panel">
          <div className="history-header">
            <span className="history-title">Deal Runs</span>
            <button className="history-close" onClick={() => setShowHistory(false)}>×</button>
          </div>
          <div className="history-list">
            {listDeals.isPending && <div className="history-loading"><span className="cp-spinner" /> Loading...</div>}
            {listDeals.isSuccess && (() => {
              const deals = (listDeals.data?.structuredContent as any)?.deals || [];
              if (deals.length === 0) return <div className="history-empty">No deal runs found</div>;
              return deals.slice(0, 20).map((deal: any) => (
                <button
                  key={deal.deal_id}
                  className={`history-item ${deal.deal_id === dealId ? 'history-item-active' : ''}`}
                  onClick={() => {
                    refresh({ deal_id: deal.deal_id });
                    setShowHistory(false);
                  }}
                >
                  <div className="history-item-name">{deal.name || deal.domain || deal.deal_id.slice(0, 8)}</div>
                  <div className="history-item-meta">
                    {deal.decision && <span className={`history-decision ${decCls(deal.decision)}`}>{deal.decision}</span>}
                    <span className="history-item-date">{deal.created_at ? new Date(deal.created_at).toLocaleDateString() : ''}</span>
                  </div>
                </button>
              ));
            })()}
          </div>
        </div>
      )}

      {/* ═══ INVESTOR PROFILE BADGE ═══ */}
      <InvestorProfileBadge
        firmType={d.deal_input?.firm_type}
        aum={d.deal_input?.aum}
        dealId={dealId}
        sendFollowUp={sendFollowUp}
        onSwitch={(newFirmType, newAum) => {
          // Optimistically update local, then refresh
          if (d.deal_input) {
            d.deal_input.firm_type = newFirmType;
            d.deal_input.aum = newAum;
          }
          if (dealId) refresh({ deal_id: dealId });
        }}
      />

      {/* ═══ SOURCE FEED (init + intel) ═══ */}
      <SourceFeed updates={liveUpdates} isComplete={isComplete} />

      {/* ═══ ANALYSTS (toggle dropdowns) ═══ */}
      <div className="pipe-stage">
        <div className="pipe-stage-header">
          <span className="pipe-stage-label">ANALYSTS</span>
          <span className="pipe-stage-count">{analystsDone}/{pl.analysts.length} · {totalFacts} facts</span>
        </div>
        {pl.analysts.map((a, idx) => {
          const phase = `analyst_${idx + 1}`;
          const feed = feedForPhase(liveUpdates, phase);
          return (
            <details key={a.id} className={`toggle-node ${cls(a.status)}`} open={a.status === "running" || (a.status === "done" && !isComplete)}
              data-llm={`${a.specialization} analyst: ${a.status}${a.status === "done" ? `, ${a.factCount} facts, ${a.unknownCount} unknowns` : ""}`}>
              <summary className="toggle-summary">
                <span className={`agent-status ${cls(a.status)}`}>{ico(a.status)}</span>
                <span className="toggle-role">{a.specialization}</span>
                {a.status === "done" && <span className="toggle-stats">{a.factCount} facts · {a.unknownCount} unknowns</span>}
                {a.status === "running" && <span className="toggle-stats pulse-text">researching…</span>}
                {a.status === "pending" && <span className="toggle-stats dim">queued</span>}
              </summary>
              <div className="toggle-feed">
                {/* Streaming sub-task tracker */}
                <SubTaskFeed
                  feed={feed}
                  isDone={a.status === "done"}
                  isRunning={a.status === "running"}
                  phasePrefix={phase}
                />

                {/* Facts when done */}
                {a.status === "done" && a.topFacts.length > 0 && (
                  <div className="feed-facts">
                    {a.topFacts.map((f, i) => (
                      <div key={i} className="feed-fact">{f}</div>
                    ))}
                  </div>
                )}
                {/* Unknowns (with Tavily resolution) */}
                {a.status === "done" && a.topUnknowns.length > 0 && (
                  <div className="feed-unknowns">
                    {a.topUnknowns.map((u, i) => {
                      const isObj = typeof u === "object" && u !== null;
                      const question = isObj ? (u as AnalystUnknown).question : (u as string);
                      const resolved = isObj ? (u as AnalystUnknown).resolved : false;
                      const answer = isObj ? (u as AnalystUnknown).answer : null;
                      return (
                        <div key={i} className={`feed-unknown ${resolved ? "feed-unknown-resolved" : ""}`}>
                          <div>{resolved ? "✅" : "?"} {question}</div>
                          {resolved && answer && (
                            <div className="unknown-answer">→ {trunc(answer, 180)}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </details>
          );
        })}
      </div>

      {/* connector between analysts and associate */}

      <div className="pipe-connector" />

      {/* ═══ ASSOCIATE (toggle dropdown — same sub-task UI as analysts) ═══ */}
      <details className={`toggle-node ${cls(pl.associate.status)}`} open={pl.associate.status !== "pending"}>
        <summary className="toggle-summary">
          <span className={`agent-status ${cls(pl.associate.status)}`}>{ico(pl.associate.status)}</span>
          <span className="toggle-role">Associate</span>
          {pl.associate.hypothesisCount > 0 && <span className="toggle-stats">{pl.associate.hypothesisCount} hypotheses</span>}
          {pl.associate.status === "running" && <span className="toggle-stats pulse-text">synthesizing…</span>}
          {pl.associate.status === "pending" && <span className="toggle-stats dim">awaiting analysts</span>}
        </summary>
        <div className="toggle-feed">
          {/* Sub-task tracker (same pattern as analysts) */}
          <SubTaskFeed
            feed={feedForPhase(liveUpdates, "associate")}
            isDone={pl.associate.status === "done"}
            isRunning={pl.associate.status === "running"}
            phasePrefix="associate"
          />

          {/* Hypotheses when done */}
          {pl.associate.topHypotheses.map((h, i) => (
            <div key={i} className="hypothesis-card">
              <div className="hypothesis-text">{trunc(h.text, 120)}</div>
              {h.risks.length > 0 && <div className="hypothesis-risk">Risk: {h.risks[0]}</div>}
            </div>
          ))}
        </div>
      </details>

      {/* ═══ INVESTMENT MEMO (from Associate → presented to Partner) ═══ */}
      {d.memo && d.memo.length > 0 && pl.associate.status === "done" && (
        <>
          <div className="pipe-connector" />
          <InvestmentMemo
            slides={d.memo}
            decision={dg?.decision}
            avgScore={avgScore}
            rubric={d.rubric}
            decisionGate={d.decision_gate}
            dealInput={d.deal_input}
          />
        </>
      )}

      <div className="pipe-connector" />

      {/* ═══ PARTNER (toggle dropdown — same sub-task UI) ═══ */}
      <details className={`toggle-node ${cls(pl.partner.status)}`} open={pl.partner.status !== "pending"}>
        <summary className="toggle-summary">
          <span className={`agent-status ${cls(pl.partner.status)}`}>{ico(pl.partner.status)}</span>
          <span className="toggle-role">Partner</span>
          {hasScores && <span className="toggle-stats">Avg {avgScore}/100</span>}
          {pl.partner.status === "running" && <span className="toggle-stats pulse-text">scoring…</span>}
          {pl.partner.status === "pending" && <span className="toggle-stats dim">awaiting synthesis</span>}
        </summary>
        <div className="toggle-feed">
          {/* Sub-task tracker (same pattern) */}
          <SubTaskFeed
            feed={feedForPhase(liveUpdates, "partner")}
            isDone={pl.partner.status === "done" || hasScores}
            isRunning={pl.partner.status === "running"}
            phasePrefix="partner"
          />

          {/* Rubric Radar Chart */}
          {hasScores && (
            <RadarChart scores={[
              { label: "Market", value: r.market.score },
              { label: "Moat", value: r.moat.score },
              { label: "Why Now", value: r.why_now.score },
              { label: "Exec", value: r.execution.score },
              { label: "Fit", value: r.deal_fit.score },
            ]} />
          )}

          {/* Top reasons */}
          {hasScores && (
            <div className="partner-reasons">
              {[r.market, r.moat, r.execution].flatMap(dim => dim.reasons.slice(0, 1)).slice(0, 3).map((reason, i) => (
                <div key={i} className="feed-fact">{trunc(reason, 90)}</div>
              ))}
            </div>
          )}
        </div>
      </details>

      {/* ═══ DECISION GATE ═══ */}
      {isComplete && dg && (
        <>
          <div className={`decision-banner ${decCls(dg.decision)}`}>
            {dg.decision === "STRONG_YES" ? "INVEST" : dg.decision === "PROCEED_IF" ? "PROCEED WITH CONDITIONS" : dg.decision}
          </div>
          {dg.gating_questions?.length > 0 && dg.gating_questions[0] !== "Pending..." && (
            <div className="gating-section">
              <div className="section-title">Gating Questions for IC</div>
              <ul className="gating-questions">
                {dg.gating_questions.map((q: string, i: number) => <li key={i}>{q}</li>)}
              </ul>
            </div>
          )}
        </>
      )}

      {/* ═══ SWARM MIND MAP ═══ */}
      {isComplete && liveUpdates.length > 5 && (
        <SwarmMap
          liveUpdates={liveUpdates}
          analysts={pl.analysts}
          decision={dg?.decision || "PENDING"}
          companyName={d.deal_input?.name || "Deal"}
          avgScore={avgScore}
        />
      )}

      {/* ═══ ACTIONS ═══ */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!isComplete && (
          <button className="action-btn action-btn-primary" onClick={() => {
            if (dealId) { failCountRef.current = 0; refresh({ deal_id: dealId }); }
          }} disabled={isRefreshing}>
            {isRefreshing ? "Checking…" : "Check Progress"}
          </button>
        )}
        {d.company_profile?.domain && (
          <button className="action-btn" onClick={() =>
            sendFollowUp(`Call the company-profile tool with domain="${d.company_profile.domain}". Do not add commentary.`)
          }>
            Company Profile
          </button>
        )}
        {d.evidence?.length > 0 && (
          <button className="action-btn" onClick={() => setShowEvidence(prev => !prev)}>
            {showEvidence ? "Hide Evidence" : `Evidence (${d.evidence.length})`}
          </button>
        )}
      </div>

      {/* ═══ EVIDENCE PANEL ═══ */}
      {showEvidence && d.evidence?.length > 0 && (
        <div className="evidence-panel">
          <div className="evidence-panel-header">
            <span className="evidence-panel-title">{d.evidence.length} Evidence Items</span>
            <button className="evidence-close" onClick={() => setShowEvidence(false)}>×</button>
          </div>
          <div className="evidence-list">
            {d.evidence.slice(0, 20).map((ev: any, i: number) => (
              <div key={i} className="evidence-item">
                <div className="evidence-source">
                  <span className={`evidence-badge evidence-badge-${ev.source || 'unknown'}`}>
                    {ev.source || 'unknown'}
                  </span>
                  {ev.url && (
                    <a className="evidence-url" href={ev.url} target="_blank" rel="noopener noreferrer">↗</a>
                  )}
                </div>
                <div className="evidence-title">{ev.title || ev.evidence_id}</div>
                <div className="evidence-snippet">
                  {(ev.snippet || '').length > 200 ? ev.snippet.slice(0, 200) + '…' : ev.snippet}
                </div>
              </div>
            ))}
            {d.evidence.length > 20 && (
              <div className="evidence-more">+{d.evidence.length - 20} more items</div>
            )}
          </div>
        </div>
      )}

      {/* ═══ NEXT STEPS (post-assessment) ═══ */}
      {isComplete && (
        <div className="next-steps">
          <div className="next-steps-title">Next Steps</div>
          <div className="next-steps-grid">
            {/* Founder outreach */}
            {d.company_profile?.founders?.length > 0 && (
              <button
                className="next-step-card"
                onClick={() => sendFollowUp(
                  `Map out profiles and outreach strategy for the founders of ${d.deal_input?.name}: ${d.company_profile.founders.join(', ')}. Include LinkedIn profiles and a concise outreach message referencing our analysis.`
                )}
              >
                <span className="next-step-icon">👤</span>
                <span className="next-step-label">Founder Outreach</span>
                <span className="next-step-desc">
                  Map {d.company_profile.founders.length} founder{d.company_profile.founders.length > 1 ? 's' : ''} & draft outreach
                </span>
              </button>
            )}

            {/* Create Cala triggers */}
            <button
              className="next-step-card"
              onClick={() => sendFollowUp(
                `Set up monitoring triggers for ${d.deal_input?.name} using the trigger-setup tool. Track: key revenue updates, key hires, key partnerships, key deals won, key business model updates, key setbacks.`
              )}
            >
              <span className="next-step-icon">🔔</span>
              <span className="next-step-label">Monitor Triggers</span>
              <span className="next-step-desc">
                Track key events via Cala AI alerts
              </span>
            </button>

            {/* Competitive deep dive */}
            {d.company_profile?.domain && (
              <button
                className="next-step-card"
                onClick={() => sendFollowUp(
                  `Do a competitive deep dive on ${d.deal_input?.name}'s key competitors using Specter similar companies for ${d.company_profile.domain}. Compare funding, team size, and traction.`
                )}
              >
                <span className="next-step-icon">⚔️</span>
                <span className="next-step-label">Competitor Deep Dive</span>
                <span className="next-step-desc">
                  Full competitive landscape analysis
                </span>
              </button>
            )}

            {/* Re-run with different lens */}
            <button
              className="next-step-card"
              onClick={() => sendFollowUp(
                `Re-analyze ${d.deal_input?.name} with a different investor lens. Current: ${d.deal_input?.firm_type || 'early_vc'}. What other fund type should we evaluate from?`
              )}
            >
              <span className="next-step-icon">🔄</span>
              <span className="next-step-label">Switch Investor Lens</span>
              <span className="next-step-desc">
                Re-evaluate from a different fund perspective
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default DealDashboard;
mountWidget(<DealDashboard />);
