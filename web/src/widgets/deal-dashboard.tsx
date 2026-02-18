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
interface LiveUpdate { phase: string; text: string; ts: string; toolInput?: string; toolOutput?: string }
interface RubricDim { score: number; reasons: string[] }
interface DashboardData {
  deal_id?: string;
  created_at?: string;
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
  const knownPhases = new Set([`${phasePrefix}_query`, `${phasePrefix}_tool`, `${phasePrefix}_think`, `${phasePrefix}_done`]);
  const extrasRaw = feed.filter(u => !knownPhases.has(u.phase));
  const seenTexts = new Set<string>();
  const extras = extrasRaw.filter(u => {
    if (seenTexts.has(u.text)) return false;
    seenTexts.add(u.text);
    return true;
  });

  let actualCalls = 0;
  for (const t of tools) {
    const multiples = t.text.match(/×(\d+)/g);
    if (multiples) {
      for (const m of multiples) actualCalls += parseInt(m.slice(1), 10);
    } else {
      actualCalls += 1;
    }
  }

  const getQueryStatus = (idx: number) => {
    if (isDone) return "done";
    if (!isRunning) return "pending";
    if (queries.length === 0) return "pending";
    const activeIdx = Math.min(actualCalls, queries.length - 1);
    if (idx < activeIdx) return "done";
    if (idx === activeIdx) return "active";
    return "pending";
  };

  const activity = [...tools, ...thinks].sort((a, b) => a.ts.localeCompare(b.ts));

  return (
    <div className="subtask-feed">
      {/* checklist */}
      {queries.length > 0 && (
        <div className="st-list">
          {queries.map((q, i) => {
            const status = getQueryStatus(i);
            const isLatestActive = status === "active" && i === Math.min(actualCalls, queries.length - 1);
            return (
              <div key={i} className={`st-item st-${status}${isLatestActive ? " st-latest" : ""}`}>
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

      {/* Extra items */}
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

      {/* Live activity stream — Cursor Style */}
      {activity.length > 0 && (
        <div className="st-activity">
          {activity.slice(-4).map((u, i) => {
            const isLast = i === Math.min(activity.length, 4) - 1 && isRunning;
            const isTool = u.phase.endsWith("_tool");
            return (
              <div key={i} className="st-activity-block">
                <div className={`st-activity-line ${isTool ? "st-act-tool" : "st-act-think"}`}>
                  <span className="st-act-verb">{isTool ? "Invoked" : "Thinking"}</span>
                  <span className="st-act-text">{u.text.replace(/^⚡\s*/, "")}</span>
                  {isLast && <span className="st-dots" />}
                </div>
                {isTool && (u.toolInput || u.toolOutput) && (
                  <div className="st-tool-io">
                    {u.toolInput && <div className="st-tool-input">{trunc(u.toolInput, 150)}</div>}
                    {u.toolOutput && <div className="st-tool-output">{trunc(u.toolOutput, 300)}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {isRunning && queries.length === 0 && activity.length === 0 && (
        <div className="feed-item feed-live">
          <span className="st-dots" /> {
            phasePrefix === 'analyst_1' ? "Initializing market analyst…" :
            phasePrefix === 'analyst_2' ? "Initializing competition analyst…" :
            phasePrefix === 'analyst_3' ? "Initializing traction analyst…" :
            phasePrefix === 'associate' ? "Synthesizing analyst findings…" :
            phasePrefix === 'partner' ? "Preparing investment decision…" :
            "Deploying queries…"
          }
        </div>
      )}

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
        <polygon points={dataPoly.map(p => `${p.x},${p.y}`).join(" ")} fill="#2563eb" fillOpacity={0.18} stroke="#2563eb" strokeWidth={1.5} className="radar-area" />
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

/* ── Research Timeline (analysts → associate → partner) ──────────────── */
function ResearchTimeline({ liveUpdates, analysts, associate, partner, rubric, decision, evidence }: {
  liveUpdates: LiveUpdate[];
  analysts: AnalystNode[];
  associate: { status: string; hypothesisCount: number };
  partner: { status: string };
  rubric?: DashboardData["rubric"];
  decision: string;
  evidence: any[];
}) {
  // Build timeline entries from live updates
  type TEntry = { ts: string; agent: string; action: string; detail: string; type: "research" | "evidence" | "analysis" | "decision" | "tool" | "score"; score?: number };
  const entries: TEntry[] = [];

  // Sources from evidence
  const sourceMap: Record<string, number> = {};
  for (const e of evidence) {
    const src = e.source || "unknown";
    sourceMap[src] = (sourceMap[src] || 0) + 1;
  }

  for (const u of liveUpdates) {
    const agentLabel = u.phase.startsWith("analyst_1") ? "Market Analyst" :
      u.phase.startsWith("analyst_2") ? "Competition Analyst" :
      u.phase.startsWith("analyst_3") ? "Traction Analyst" :
      u.phase.startsWith("associate") ? "Associate" :
      u.phase.startsWith("partner") ? "Partner" :
      u.phase.startsWith("init") ? "Orchestrator" :
      u.phase.startsWith("complete") ? "System" : u.phase;

    const isTool = u.phase.endsWith("_tool");
    const isThink = u.phase.endsWith("_think");
    const cleaned = u.text.replace(/^[⚡✓●]\s*/, "");

    if (isTool) {
      entries.push({ ts: u.ts, agent: agentLabel, action: cleaned, detail: u.toolOutput ? trunc(u.toolOutput, 120) : "", type: "tool" });
    } else if (u.phase === "complete") {
      entries.push({ ts: u.ts, agent: "Decision", action: cleaned, detail: "", type: "decision" });
    } else if (u.phase.startsWith("init")) {
      entries.push({ ts: u.ts, agent: "Orchestrator", action: cleaned, detail: "", type: "research" });
    } else {
      entries.push({ ts: u.ts, agent: agentLabel, action: cleaned, detail: "", type: isThink ? "analysis" : "research" });
    }
  }

  // Add score events from rubric
  if (rubric) {
    const dims = [
      { key: "market", label: "Market" },
      { key: "moat", label: "Moat" },
      { key: "why_now", label: "Why Now" },
      { key: "execution", label: "Execution" },
      { key: "deal_fit", label: "Deal Fit" },
    ];
    for (const dim of dims) {
      const d = (rubric as any)[dim.key];
      if (d?.score > 0) {
        entries.push({
          ts: "", agent: "Partner", action: `${dim.label}: ${d.score}/100`, detail: d.reasons?.[0] || "",
          type: "score", score: d.score,
        });
      }
    }
  }

  const agentColor: Record<string, string> = {
    "Market Analyst": "#2563eb", "Competition Analyst": "#7c3aed", "Traction Analyst": "#0891b2",
    "Associate": "#d97706", "Partner": "#111827", "Orchestrator": "#6b7280", "Decision": "#16a34a", "System": "#6b7280"
  };
  const typeIcon: Record<string, string> = { research: "◎", evidence: "📄", analysis: "◇", decision: "◆", tool: "⚡", score: "★" };

  return (
    <details className="timeline-details" open>
      <summary className="timeline-summary">
        <span className="timeline-title">Research Timeline</span>
        <span className="timeline-meta">
          {entries.length} events · {Object.entries(sourceMap).map(([k, v]) => `${v} ${k}`).join(", ")}
        </span>
      </summary>
      <div className="timeline-container">
        {/* Three lanes header */}
        <div className="timeline-lanes-header">
          <span className="tl-lane-label">Analysts</span>
          <span className="tl-lane-label">Associate</span>
          <span className="tl-lane-label">Partner</span>
        </div>
        <div className="timeline-scroll">
          {entries.slice(-40).map((e, i) => {
            const lane = e.agent.includes("Analyst") || e.agent === "Orchestrator" ? 0 : e.agent === "Associate" ? 1 : 2;
            const color = agentColor[e.agent] || "#6b7280";
            return (
              <div key={i} className={`tl-row tl-lane-${lane}`} style={{ "--tl-color": color } as React.CSSProperties}>
                <div className="tl-dot">{typeIcon[e.type] || "○"}</div>
                <div className="tl-content">
                  <span className="tl-agent" style={{ color }}>{e.agent}</span>
                  <span className="tl-action" title={e.action}>{trunc(e.action, 80)}</span>
                  {e.type === "score" && e.score !== undefined && (
                    <span className={`tl-score ${scCls(e.score)}`}>{e.score}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
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
  const [copied, setCopied] = React.useState<string | null>(null);
  
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

  const triggerDownload = (content: string, filename: string, mimeType: string, label: string) => {
    // In sandboxed ChatGPT iframes, blob URLs fail (BlobNotFound).
    // Use data: URI in a new window — works reliably in all sandbox modes.
    try {
      const encoded = btoa(unescape(encodeURIComponent(content)));
      const dataUri = `data:${mimeType};base64,${encoded}`;
      // Open in new tab — browser will offer Save/Download
      const w = window.open(dataUri, '_blank');
      if (w) {
        setCopied(`${label} opened`);
        setTimeout(() => setCopied(null), 3000);
        return;
      }
    } catch { /* data URI too large or popup blocked */ }

    // Fallback: blob + anchor (works in dev / non-sandboxed)
    try {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
      setCopied(`${label} downloading`);
      setTimeout(() => setCopied(null), 3000);
      return;
    } catch { /* sandbox blocked */ }

    // Last resort: copy to clipboard
    try {
      navigator.clipboard?.writeText(content).then(() => {
        setCopied(`${label} copied to clipboard`);
        setTimeout(() => setCopied(null), 3000);
      });
    } catch {
      setCopied(`${label} failed`);
      setTimeout(() => setCopied(null), 3000);
    }
  };

  const handleDownloadMd = () => {
    const { md, companyName, now } = buildMarkdown();
    triggerDownload(md, `${companyName.replace(/[^a-zA-Z0-9]/g, '_')}_Memo_${now}.md`, 'text/markdown;charset=utf-8', '.md');
  };

  const handleDownloadPdf = () => {
    const companyName = dealInput?.name || dealInput?.company_name || 'Deal';
    const now = new Date().toISOString().split('T')[0];
    // Build a proper slide-deck HTML with styled pages
    const slideHtml = enriched.map((slide, i) => {
      const icon = slideIcons[slide.type] || '📄';
      let metricsRow = '';
      if (slide.metrics && slide.metrics.length > 0) {
        metricsRow = `<div style="display:flex;gap:24px;margin:12px 0;flex-wrap:wrap">${slide.metrics.map(m =>
          `<div style="text-align:center"><div style="font-size:20px;font-weight:700;color:#1e293b">${m.value}</div><div style="font-size:11px;color:#64748b;text-transform:uppercase">${m.label}</div></div>`
        ).join('')}</div>`;
      }
      const bulletsHtml = slide.bullets.length > 0
        ? `<ul style="margin:8px 0;padding-left:18px;color:#334155;font-size:13px;line-height:1.7">${slide.bullets.map(b => `<li>${b}</li>`).join('')}</ul>`
        : '';
      if (slide.type === 'cover') {
        return `<div style="background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#fff;padding:60px 40px;min-height:280px;display:flex;flex-direction:column;justify-content:flex-end;border-radius:8px;margin-bottom:20px;page-break-after:always">
          <h1 style="font-size:32px;margin:0 0 8px">${slide.title}</h1>
          <p style="font-size:16px;opacity:0.8;margin:0">${slide.subtitle || ''}</p>
          ${slide.bullets.map(b => `<p style="font-size:13px;opacity:0.6;margin:4px 0">${b}</p>`).join('')}
        </div>`;
      }
      return `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:16px;page-break-inside:avoid">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <span style="font-size:10px;color:#94a3b8;font-weight:600">${String(i + 1).padStart(2, '0')}</span>
          <span style="font-size:16px">${icon}</span>
          <div><div style="font-size:16px;font-weight:600;color:#0f172a">${slide.title}</div>${slide.subtitle ? `<div style="font-size:12px;color:#64748b">${slide.subtitle}</div>` : ''}</div>
        </div>
        ${metricsRow}${bulletsHtml}
      </div>`;
    }).join('\n');

    // Add rubric scores table
    let rubricHtml = '';
    if (rubric) {
      rubricHtml = `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:16px;page-break-inside:avoid">
        <h3 style="font-size:16px;font-weight:600;color:#0f172a;margin:0 0 12px">Rubric Scores</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#f8fafc">
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0">Dimension</th>
          <th style="text-align:center;padding:6px 8px;border-bottom:1px solid #e2e8f0">Score</th>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0">Key Reasons</th>
        </tr></thead><tbody>
        ${Object.entries(rubric).map(([dim, data]) => {
          if (!data || typeof data !== 'object' || !('score' in data)) return '';
          const reasons = (data.reasons || []).slice(0, 2).join('; ');
          const color = data.score >= 70 ? '#16a34a' : data.score >= 40 ? '#d97706' : '#dc2626';
          return `<tr><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${dim.replace(/_/g, ' ')}</td>
            <td style="text-align:center;padding:6px 8px;border-bottom:1px solid #f1f5f9;font-weight:700;color:${color}">${data.score}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:12px">${reasons}</td></tr>`;
        }).join('')}
        </tbody></table></div>`;
    }

    // Decision gate
    let gateHtml = '';
    if (decisionGate && decisionGate.decision) {
      const gColor = decisionGate.decision === 'STRONG_YES' ? '#16a34a' : decisionGate.decision === 'PASS' || decisionGate.decision === 'KILL' ? '#dc2626' : '#d97706';
      gateHtml = `<div style="border:2px solid ${gColor};border-radius:8px;padding:20px;margin-bottom:16px">
        <div style="font-size:18px;font-weight:700;color:${gColor};margin-bottom:12px">Decision: ${decisionGate.decision}</div>
        ${decisionGate.gating_questions?.length > 0 ? `<div style="font-size:14px;font-weight:600;margin-bottom:8px">Gating Questions</div><ol style="margin:0;padding-left:18px;font-size:13px;color:#334155;line-height:1.8">${decisionGate.gating_questions.map((q: string) => `<li>${q}</li>`).join('')}</ol>` : ''}
      </div>`;
    }

    const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${companyName} — Investment Memo</title>
      <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#0f172a}@media print{body{padding:0}}</style>
    </head><body>${slideHtml}${rubricHtml}${gateHtml}
      <div style="text-align:center;font-size:11px;color:#94a3b8;margin-top:24px;padding:12px;border-top:1px solid #e2e8f0">Generated by DealBot — ${now}</div>
    </body></html>`;
    triggerDownload(fullHtml, `${companyName.replace(/[^a-zA-Z0-9]/g, '_')}_Memo_${now}.html`, 'text/html;charset=utf-8', '.pdf');
  };

  return (
    <details className="memo-details" open>
      <summary className="memo-summary">
        <span className="memo-summary-title">Investment Memo</span>
        <span className="memo-summary-actions">
          <button className="memo-download-btn" onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleDownloadMd(); }} title="Download or copy Markdown memo">
            {copied === '.md' || copied === '.md copied' ? "✓ Copied" : ".md"}
          </button>
          <button className="memo-download-btn memo-download-pdf" onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleDownloadPdf(); }} title="Download or copy HTML memo">
            {copied === '.pdf' || copied === '.pdf copied' ? "✓ Copied" : ".pdf"}
          </button>
          <span className="memo-summary-meta">{slides.length} slides</span>
        </span>
      </summary>
      <div className="memo-deck">
        {enriched.map((slide, i) => (
          <div key={i} className={`memo-slide memo-${slide.type}`}>
            {slide.imageUrl && (
              <div className="memo-cover-img" style={{ backgroundImage: `url(${slide.imageUrl})` }}>
                <div className="memo-cover-overlay">
                  <div className="memo-cover-title">{slide.title}</div>
                  {slide.subtitle && <div className="memo-cover-sub">{slide.subtitle}</div>}
                </div>
              </div>
            )}
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
  const [copied, setCopied] = React.useState<string | null>(null);
  const [profiling, setProfiling] = React.useState(false);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const failCountRef = React.useRef(0);
  const lastUpdateRef = React.useRef<number>(Date.now());

  const isRefreshing = refreshCall.isPending;
  const refresh = refreshCall.callTool;

  // ── Persistent cache: localStorage survives Alpic cold starts ──
  const cacheKey = (id: string) => `dealbot_state_${id}`;
  const saveToCache = (id: string, data: any) => {
    try { localStorage.setItem(cacheKey(id), JSON.stringify({ ...data, _cached_at: new Date().toISOString() })); } catch {}
  };
  const loadFromCache = (id: string): any => {
    try { const raw = localStorage.getItem(cacheKey(id)); return raw ? JSON.parse(raw) : null; } catch { return null; }
  };

  // Cache last successful refresh so UI never blanks between polls
  const cachedRef = React.useRef<any>(null);
  if (refreshCall.isSuccess && refreshCall.data?.structuredContent) {
    const sc = refreshCall.data.structuredContent as any;
    if (sc.error === "not_found") {
      // Server lost data — try localStorage fallback before giving up
      const did = sc.deal_id || (input as any)?.deal_id || "";
      if (did && !cachedRef.current) {
        const cached = loadFromCache(did);
        if (cached) {
          cachedRef.current = { ...cached, _from_cache: true };
        }
      }
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    } else {
      cachedRef.current = sc;
      failCountRef.current = 0;
      lastUpdateRef.current = Date.now();
      // Persist to localStorage for cold-start recovery
      const did = sc.deal_id || (input as any)?.deal_id || "";
      if (did) saveToCache(did, sc);
    }
  }
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

  if (d.error === "not_found" && !(d as any)._from_cache) {
    // No cached data available — show unavailable message
    const companyHint = (input as any)?.company_name || (input as any)?.deal_id || "";
    const dealIdHint = (input as any)?.deal_id || d.deal_id || "";
    return (
      <div className="widget deal-pipe">
        <div className="pipe-header" style={{ textAlign: "center", padding: "32px 24px" }}>
          <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.5 }}>⟳</div>
          <div className="pipe-title" style={{ fontSize: 18 }}>Session Unavailable</div>
          <div className="pipe-subtitle" style={{ maxWidth: 400, margin: "8px auto", lineHeight: 1.5 }}>
            This deal analysis session is no longer cached on the server. On serverless infrastructure, data is ephemeral between cold starts.
          </div>
          {dealIdHint && (
            <div style={{ fontSize: 11, opacity: 0.4, fontFamily: "monospace", marginTop: 8 }}>
              {dealIdHint}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, padding: "0 24px 24px", justifyContent: "center" }}>
          <button className="cp-btn-process" style={{ maxWidth: 200 }} onClick={() => {
            sendFollowUp(companyHint
              ? `Analyze the company "${companyHint}" — use analyze_deal tool`
              : "Start a new deal analysis — ask me which company");
          }}>
            Re-analyze
          </button>
          <button className="action-btn" style={{ padding: "8px 16px" }} onClick={() => {
            sendFollowUp("Show me my recent deal analysis history");
          }}>
            View History
          </button>
        </div>
      </div>
    );
  }

  const { pipeline: pl, liveUpdates, isComplete, avgScore } = d;
  const r = d.rubric;
  const dg = d.decision_gate;

  // Defensive: if pipeline is missing/corrupt, show loading state
  if (!pl?.analysts || !Array.isArray(pl.analysts)) {
    return <div className="loading">Loading pipeline data…</div>;
  }

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
          <div className="pipe-label">Deal Analysis Run{(d as any)._from_cache ? <span style={{ marginLeft: 8, fontSize: 10, color: '#9ca3af', background: '#f3f4f6', padding: '1px 6px', borderRadius: 4 }}>cached snapshot</span> : null}</div>
          <div className="pipe-title">{d.deal_input?.name || "Deal"}</div>
          <div className="pipe-subtitle">
            {d.created_at ? new Date(d.created_at).toLocaleDateString() : 'Today'} · {d.evidence?.length || 0} evidence{d.company_profile?.domain ? ` · ${d.company_profile.domain}` : ""}
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
          }} title="View history of deal analysis runs">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "middle" }}>
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
          </button>
        </div>
      </div>

      {/* ═══ HISTORY SIDE PANEL ═══ */}
      <div className={`history-backdrop ${showHistory ? 'history-backdrop-open' : ''}`} onClick={() => setShowHistory(false)} />
      <div className={`history-panel ${showHistory ? 'history-panel-open' : ''}`}>
        <div className="history-header">
          <span className="history-title">Deal History</span>
          <button className="history-close" onClick={() => setShowHistory(false)}>×</button>
        </div>
        <div className="history-list">
          {listDeals.isPending && <div className="history-loading"><span className="cp-spinner" /> Loading history...</div>}
          {listDeals.isSuccess && (() => {
            const deals = (listDeals.data?.structuredContent as any)?.deals || [];
            if (deals.length === 0) return <div className="history-empty">No deal runs found</div>;
            return deals.slice(0, 20).map((deal: any) => (
              <button
                key={deal.id || deal.deal_id}
                className={`history-item ${deal.id === dealId || deal.deal_id === dealId ? 'history-item-active' : ''}`}
                onClick={() => {
                  refresh({ deal_id: deal.id || deal.deal_id });
                  setShowHistory(false);
                }}
              >
                <div className="history-item-name">{deal.name || deal.domain || deal.id || deal.deal_id}</div>
                <div className="history-item-meta">
                  {deal.latest_decision && <span className={`history-decision ${decCls(deal.latest_decision)}`}>{deal.latest_decision}</span>}
                  <span className="history-item-date">{deal.updated_at ? new Date(deal.updated_at).toLocaleDateString() : ''}</span>
                </div>
                <div className="history-item-stats">
                  {deal.evidence_count || 0} evidence · {deal.latest_avg_score ? `${deal.latest_avg_score}/100` : 'No score'}
                </div>
              </button>
            ));
          })()}
        </div>
      </div>

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
          {/* Sub-task tracker */}
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

          {/* Rubric scores breakdown */}
          {hasScores && (
            <div className="partner-rubric-table">
              {Object.entries(r).map(([dim, data]) => (
                <div key={dim} className="rubric-row">
                  <span className="rubric-dim">{dim.replace(/_/g, ' ')}</span>
                  <span className={`rubric-score ${scCls(data.score)}`}>{data.score}/100</span>
                  <span className="rubric-reason">{data.reasons?.[0] ? trunc(data.reasons[0], 80) : ''}</span>
                </div>
              ))}
            </div>
          )}

          {/* Top reasons */}
          {hasScores && (
            <div className="partner-reasons">
              {[r.market, r.moat, r.execution].flatMap(dim => dim.reasons.slice(0, 1)).slice(0, 3).map((reason, i) => (
                <div key={i} className="feed-fact">{trunc(reason, 90)}</div>
              ))}
            </div>
          )}

          {/* Fallback: Partner done but no scores yet */}
          {pl.partner.status === "done" && !hasScores && feedForPhase(liveUpdates, "partner").length === 0 && (
            <div className="feed-item feed-done">Partner review complete — scores pending</div>
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

      {/* ═══ RESEARCH TIMELINE ═══ */}
      {liveUpdates.length > 3 && (
        <ResearchTimeline
          liveUpdates={liveUpdates}
          analysts={pl.analysts}
          associate={pl.associate}
          partner={pl.partner}
          rubric={d.rubric}
          decision={dg?.decision || "PENDING"}
          evidence={d.evidence || []}
        />
      )}

      {/* ═══ ACTIONS ═══ */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {!isComplete && (
          <button className="action-btn action-btn-primary" onClick={() => {
            if (dealId) { failCountRef.current = 0; refresh({ deal_id: dealId }); }
          }} disabled={isRefreshing}>
            {isRefreshing ? "Checking…" : "Check Progress"}
          </button>
        )}
        {d.company_profile?.domain && (
          <button className="action-btn" onClick={() => {
            setProfiling(true);
            sendFollowUp(`Call the company-profile tool with domain="${d.company_profile.domain}". Do not add commentary.`);
            setTimeout(() => setProfiling(false), 3000);
          }} disabled={profiling}>
            {profiling ? "Opening…" : "Company Profile"}
          </button>
        )}
        {d.evidence?.length > 0 && (
          <button className={`action-btn ${showEvidence ? 'action-btn-active' : ''}`} onClick={() => setShowEvidence(prev => !prev)}>
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

/* ── Error Boundary — prevents "Content failed to load" on runtime errors ── */
class DashboardErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message || "Unknown error" };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="widget deal-pipe">
          <div className="pipe-header">
            <div className="pipe-title">Dashboard Error</div>
            <div className="pipe-subtitle">
              Something went wrong rendering the dashboard. Try refreshing.
            </div>
          </div>
          <div style={{ padding: "12px", fontSize: "12px", color: "#999", fontFamily: "monospace" }}>
            {this.state.error}
          </div>
          <button className="cp-btn-process" onClick={() => this.setState({ hasError: false, error: "" })}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function DealDashboardWithBoundary() {
  return (
    <DashboardErrorBoundary>
      <DealDashboard />
    </DashboardErrorBoundary>
  );
}

export default DealDashboardWithBoundary;
mountWidget(<DealDashboardWithBoundary />);
