import "@/index.css";
import { mountWidget, useLayout, useSendFollowUpMessage } from "skybridge/web";
import { useToolInfo, useCallTool } from "../helpers.js";

// Types for structured content (mirrors server output)
interface CompanyProfileData {
  profile: any;
  calaEvidence: any[];
  domain: string;
  name: string;
}

function formatMoney(n: number | null | undefined): string {
  if (!n) return "N/A";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

function formatNum(n: number | null | undefined): string {
  if (!n) return "N/A";
  return n.toLocaleString();
}

function scoreColor(score: number): string {
  if (score >= 70) return "score-high";
  if (score >= 40) return "score-mid";
  return "score-low";
}

function CompanyProfile() {
  const { isSuccess, output, isPending } = useToolInfo<"company-profile">();
  const { theme } = useLayout();
  const sendFollowUp = useSendFollowUpMessage();
  const { callTool: searchName, isPending: isSearching } = useCallTool("company-profile");

  if (isPending || !isSuccess || !output) {
    return <div className="loading">Researching company...</div>;
  }

  const { profile: p, calaEvidence, name } = output.structuredContent as CompanyProfileData;

  if (!p) {
    return (
      <div className="widget company-card">
        <div className="company-header">
          <div className="company-avatar">?</div>
          <div>
            <div className="company-name">{name}</div>
            <div className="company-tagline">Company not found in Specter</div>
          </div>
        </div>
        {calaEvidence?.length > 0 && (
          <div className="intel-section">
            <div className="section-title">Market Intelligence ({calaEvidence.length})</div>
            {calaEvidence.slice(0, 5).map((item: any, i: number) => (
              <div key={i} className="intel-item">
                <div className="intel-title">{item.title}</div>
                <div className="intel-snippet">{item.snippet}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="widget company-card" data-llm={`Company: ${p.name}, Stage: ${p.growth_stage}, Funding: ${formatMoney(p.funding_total_usd)}`}>
      {/* Header */}
      <div className="company-header">
        <div className="company-avatar">{p.name?.[0] || "?"}</div>
        <div>
          <div className="company-name">{p.name}</div>
          <div className="company-tagline">
            {p.tagline || p.description?.slice(0, 80) || p.domain}
          </div>
          <div style={{ marginTop: 4, display: "flex", gap: 6 }}>
            <span className="badge badge-stage">{p.growth_stage}</span>
            <span className="badge badge-status">{p.operating_status}</span>
          </div>
        </div>
      </div>

      {/* Key Stats */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Raised</div>
          <div className="stat-value">{formatMoney(p.funding_total_usd)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Employees</div>
          <div className="stat-value">{formatNum(p.employee_count)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Founded</div>
          <div className="stat-value">{p.founded_year || "N/A"}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">HQ</div>
          <div className="stat-value">{p.hq_city ? `${p.hq_city}, ${p.hq_country}` : p.hq_country || "N/A"}</div>
        </div>
      </div>

      {/* Funding */}
      {(p.funding_last_round_type || p.investors?.length > 0) && (
        <div>
          <div className="section-title">Funding</div>
          {p.funding_last_round_type && (
            <div style={{ fontSize: 13 }}>
              Last round: <strong>{p.funding_last_round_type}</strong>
              {p.funding_last_round_usd ? ` (${formatMoney(p.funding_last_round_usd)})` : ""}
            </div>
          )}
          {p.investors?.length > 0 && (
            <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
              {p.investors.slice(0, 6).join(" · ")}
              {p.investors.length > 6 && ` +${p.investors.length - 6} more`}
            </div>
          )}
        </div>
      )}

      {/* Founders */}
      {p.founders?.length > 0 && (
        <div>
          <div className="section-title">Founders ({p.founder_count})</div>
          <div className="founders-list">
            {p.founders.map((f: string, i: number) => (
              <span key={i} className="founder-chip">{f}</span>
            ))}
          </div>
        </div>
      )}

      {/* Traction */}
      {(p.web_monthly_visits || p.linkedin_followers) && (
        <div className="stat-grid">
          {p.web_monthly_visits && (
            <div className="stat-card">
              <div className="stat-label">Web Traffic</div>
              <div className="stat-value">{formatNum(p.web_monthly_visits)}/mo</div>
            </div>
          )}
          {p.linkedin_followers && (
            <div className="stat-card">
              <div className="stat-label">LinkedIn</div>
              <div className="stat-value">{formatNum(p.linkedin_followers)}</div>
            </div>
          )}
          {p.twitter_followers && (
            <div className="stat-card">
              <div className="stat-label">Twitter</div>
              <div className="stat-value">{formatNum(p.twitter_followers)}</div>
            </div>
          )}
        </div>
      )}

      {/* Signals */}
      {p.highlights?.length > 0 && (
        <div>
          <div className="section-title">Growth Signals</div>
          <div className="signals-list">
            {p.highlights.slice(0, 8).map((s: string, i: number) => (
              <span key={i} className="signal-tag">{s}</span>
            ))}
          </div>
        </div>
      )}

      {/* Market Intel (Cala) */}
      {calaEvidence?.length > 0 && (
        <div className="intel-section">
          <div className="section-title">Market Intelligence ({calaEvidence.length})</div>
          {calaEvidence.slice(0, 4).map((item: any, i: number) => (
            <div key={i} className="intel-item">
              <div className="intel-title">{item.title}</div>
              <div className="intel-snippet">{item.snippet}</div>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => sendFollowUp(`Show me the team and leadership at ${p.name} (Specter ID: ${p.specter_id})`)}
          style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", fontSize: 12 }}
        >
          👥 Team
        </button>
        <button
          onClick={() => sendFollowUp(`Find competitors similar to ${p.name} (Specter ID: ${p.specter_id})`)}
          style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", fontSize: 12 }}
        >
          🏢 Competitors
        </button>
        <button
          onClick={() => sendFollowUp(`Run a full deal analysis for ${p.name} (${p.domain})`)}
          style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#667eea", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
        >
          ⚖️ Deal Analysis
        </button>
      </div>
    </div>
  );
}

export default CompanyProfile;
mountWidget(<CompanyProfile />);
