import "@/index.css";
import { mountWidget, useSendFollowUpMessage } from "skybridge/web";
import { useToolInfo, useCallTool } from "../helpers.js";

function scoreColor(score: number): string {
  if (score >= 70) return "score-high";
  if (score >= 40) return "score-mid";
  return "score-low";
}

function decisionClass(decision: string): string {
  if (decision === "STRONG_YES") return "decision-strong-yes";
  if (decision === "PROCEED_IF") return "decision-proceed";
  if (decision === "PASS") return "decision-pass";
  return "decision-pending";
}

function DealDashboard() {
  const { isSuccess, output, isPending, input } = useToolInfo<"deal-dashboard">();
  const { callTool: refresh, isPending: isRefreshing } = useCallTool("deal-dashboard");
  const sendFollowUp = useSendFollowUpMessage();

  if (isPending || !isSuccess || !output) {
    return <div className="loading">Loading deal analysis...</div>;
  }

  const state = output.structuredContent as any;

  if (state.error === "not_found") {
    return (
      <div className="widget deal-dashboard">
        <div className="decision-banner decision-pending">Deal not found: {state.deal_id}</div>
      </div>
    );
  }

  const r = state.rubric;
  const dg = state.decision_gate;
  const hasScores = r && (r.market?.score || r.moat?.score);
  const isComplete = dg?.decision && dg.decision !== "PROCEED_IF" && dg.gating_questions?.[0] !== "Pending...";

  return (
    <div
      className="widget deal-dashboard"
      data-llm={hasScores ? `Deal: ${state.deal_input?.name}, Decision: ${dg?.decision || "pending"}, Avg: ${hasScores ? Math.round((r.market.score + r.moat.score + r.why_now.score + r.execution.score + r.deal_fit.score) / 5) : "?"}` : `Deal: ${state.deal_input?.name}, Status: in progress`}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{state.deal_input?.name || "Deal"}</div>
          <div style={{ fontSize: 12, color: "#888" }}>
            {state.evidence?.length || 0} evidence items
            {state.company_profile?.domain ? ` · ${state.company_profile.domain}` : ""}
          </div>
        </div>
        <button
          onClick={() => refresh({ deal_id: input?.deal_id || state.deal_input?.name || "" })}
          disabled={isRefreshing}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid #ddd",
            background: isRefreshing ? "#f5f5f5" : "#fff",
            cursor: isRefreshing ? "default" : "pointer",
            fontSize: 12,
          }}
        >
          {isRefreshing ? "↻ Refreshing..." : "↻ Refresh"}
        </button>
      </div>

      {/* Rubric Scores */}
      {hasScores ? (
        <>
          <div className="rubric-grid">
            {[
              { key: "market", label: "Market" },
              { key: "moat", label: "Moat" },
              { key: "why_now", label: "Why Now" },
              { key: "execution", label: "Execution" },
              { key: "deal_fit", label: "Deal Fit" },
            ].map(({ key, label }) => {
              const score = r[key]?.score || 0;
              return (
                <div key={key} className="rubric-item">
                  <div className={`rubric-score ${scoreColor(score)}`}>{score}</div>
                  <div className="rubric-label">{label}</div>
                </div>
              );
            })}
          </div>

          {/* Average */}
          <div style={{ textAlign: "center", fontSize: 13, color: "#888" }}>
            Average: <strong>{Math.round((r.market.score + r.moat.score + r.why_now.score + r.execution.score + r.deal_fit.score) / 5)}/100</strong>
          </div>
        </>
      ) : (
        <div className="decision-banner decision-pending" style={{ fontSize: 14 }}>
          ⏳ Analysis in progress — scores will appear when analysts complete their review
        </div>
      )}

      {/* Decision */}
      {isComplete && dg && (
        <div className={`decision-banner ${decisionClass(dg.decision)}`}>
          {dg.decision === "STRONG_YES" && "✅ "}
          {dg.decision === "PROCEED_IF" && "⚠️ "}
          {dg.decision === "PASS" && "❌ "}
          {dg.decision}
        </div>
      )}

      {/* Gating Questions */}
      {dg?.gating_questions?.length > 0 && dg.gating_questions[0] !== "Pending..." && (
        <div>
          <div className="section-title">Gating Questions for IC</div>
          <ul className="gating-questions">
            {dg.gating_questions.map((q: string, i: number) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Hypotheses */}
      {state.hypotheses?.length > 0 && (
        <div>
          <div className="section-title">Hypotheses ({state.hypotheses.length})</div>
          {state.hypotheses.slice(0, 5).map((h: any, i: number) => (
            <div key={i} style={{ fontSize: 13, padding: "4px 0", borderBottom: "1px solid #f5f5f5" }}>
              {h.text}
              {h.risks?.length > 0 && (
                <span style={{ fontSize: 11, color: "#e65100", marginLeft: 8 }}>⚠️ {h.risks.join("; ")}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      {!isComplete && (
        <div style={{ textAlign: "center", marginTop: 8 }}>
          <button
            onClick={() => refresh({ deal_id: input?.deal_id || "" })}
            disabled={isRefreshing}
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              border: "none",
              background: "#667eea",
              color: "#fff",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {isRefreshing ? "Checking..." : "Check Progress"}
          </button>
        </div>
      )}
    </div>
  );
}

export default DealDashboard;
mountWidget(<DealDashboard />);
