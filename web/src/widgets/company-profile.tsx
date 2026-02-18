import { useEffect, useState } from "react";
import "@/index.css";
import { mountWidget, useSendFollowUpMessage } from "skybridge/web";
import { useToolInfo, useCallTool } from "../helpers.js";

/* ── Types & helpers ──────────────────────────────────────────────── */
function fmtMoney(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${(n / 1e3).toFixed(0)}K`;
}
function fmtNum(n: number | null | undefined): string {
  return n ? n.toLocaleString() : "—";
}

const FIRM_TYPES = [
  { value: "angel", label: "Angel" },
  { value: "early_vc", label: "Early VC" },
  { value: "growth_vc", label: "Growth VC" },
  { value: "late_vc", label: "Late VC" },
  { value: "pe", label: "PE" },
  { value: "ib", label: "IB" },
];

const AUM_OPTIONS = [
  { value: "<50M", label: "<$50M" },
  { value: "50-250M", label: "$50-250M" },
  { value: "250M-1B", label: "$250M-1B" },
  { value: "1-5B", label: "$1-5B" },
  { value: "5B+", label: "$5B+" },
];

/* ── Widget ────────────────────────────────────────────────────────── */
function CompanyProfile() {
  const { isSuccess, output, isPending, input } =
    useToolInfo<"company-profile">();
  const sendFollowUp = useSendFollowUpMessage();
  const analyze = useCallTool("analyze_deal");
  const [dashboardRequested, setDashboardRequested] = useState(false);
  const [firmType, setFirmType] = useState<string>("early_vc");
  const [aum, setAum] = useState("50-250M");
  const [showFundConfig, setShowFundConfig] = useState(false);

  const data = output as any;
  const p = data?.profile;
  const existingDealId = data?.existing_deal_id;

  // Auto-chain: when analyze_deal returns a deal_id → ask ChatGPT to render dashboard
  const analyzeDealId = (analyze.data?.structuredContent as any)?.deal_id;
  useEffect(() => {
    if (analyze.isSuccess && !dashboardRequested && analyzeDealId) {
      setDashboardRequested(true);
      sendFollowUp(
        `Show the deal dashboard for deal_id="${analyzeDealId}".`,
      );
    }
  }, [analyze.isSuccess, analyzeDealId, dashboardRequested]);

  /* ── Loading ─────────────────────────────────────────────────── */
  if (isPending || !isSuccess || !output) {
    return (
      <div className="cp-card">
        <div className="cp-loading">
          <span className="cp-spinner" />
          <span className="cp-loading-text">
            {input?.domain
              ? `Researching ${input.name || input.domain}...`
              : "Researching company..."}
          </span>
        </div>
      </div>
    );
  }

  /* ── Not found ───────────────────────────────────────────────── */
  if (!p) {
    return (
      <div className="cp-card">
        <div className="cp-header">
          <div className="cp-initials">{(data?.name || "?").slice(0, 2).toUpperCase()}</div>
          <div>
            <div className="cp-title">{data?.name || "Unknown"}</div>
            <div className="cp-subtitle">Company not found in Specter</div>
          </div>
        </div>
        <button
          className="cp-btn cp-btn-secondary"
          onClick={() =>
            sendFollowUp(
              `Search for ${data?.name || data?.domain} by name in Specter and show me the results so I can pick the correct one.`,
            )
          }
        >
          Search by Name
        </button>
      </div>
    );
  }

  const handleProcessDeal = () => {
    analyze.callTool({
      name: p.name,
      domain: p.domain,
      stage: p.growth_stage || "seed",
      geo: p.hq_country || "EU",
      firm_type: firmType as any,
      aum,
    });
  };

  /* ── Compact profile ─────────────────────────────────────────── */
  return (
    <div
      className="cp-card"
      data-llm={`Company: ${p.name}, Stage: ${p.growth_stage}, Funding: ${fmtMoney(p.funding_total_usd)}, Employees: ${p.employee_count}, Fund: ${firmType} ${aum}`}
    >
      {/* Header: Logo + Name */}
      <div className="cp-header">
        <img
          className="cp-avatar"
          src={p.logo_url || `https://icons.duckduckgo.com/ip3/${p.domain}.ico`}
          alt={p.name}
          onError={(e) => {
            const el = e.currentTarget;
            el.style.display = 'none';
            const fb = el.parentElement?.querySelector('.cp-initials') as HTMLElement;
            if (fb) fb.style.display = 'flex';
          }}
        />
        <div className="cp-initials" style={{ display: 'none' }}>
          {(p.name || '?').slice(0, 2).toUpperCase()}
        </div>
        <div className="cp-header-text">
          <div className="cp-title">
            {p.domain ? (
              <a
                className="cp-title-link"
                href={`https://www.${p.domain.replace(/^www\./i, '')}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {p.name} <span className="cp-arrow">↗</span>
              </a>
            ) : (
              p.name
            )}
          </div>
          <div className="cp-subtitle">
            {p.domain}
            {p.hq_city ? ` · ${p.hq_city}` : p.hq_country ? ` · ${p.hq_country}` : ""}
            {p.growth_stage ? ` · ${p.growth_stage}` : ""}
          </div>
        </div>
      </div>

      {/* Wrong company link */}
      <button
        className="cp-wrong-link"
        onClick={() =>
          sendFollowUp(
            `That's not the right company. Search for "${p.name}" by name in Specter and show me the results so I can pick the correct one.`,
          )
        }
      >
        Not this company? Try a different domain
      </button>

      {/* Key metrics row */}
      <div className="cp-metrics">
        <div className="cp-metric">
          <span className="cp-metric-value">{fmtMoney(p.funding_total_usd)}</span>
          <span className="cp-metric-label">raised</span>
        </div>
        <div className="cp-metric-divider" />
        <div className="cp-metric">
          <span className="cp-metric-value">{fmtNum(p.employee_count)}</span>
          <span className="cp-metric-label">team</span>
        </div>
        <div className="cp-metric-divider" />
        <div className="cp-metric">
          <span className="cp-metric-value">{fmtNum(p.web_monthly_visits)}</span>
          <span className="cp-metric-label">/mo visits</span>
        </div>
        {p.founded_year && (
          <>
            <div className="cp-metric-divider" />
            <div className="cp-metric">
              <span className="cp-metric-value">{p.founded_year}</span>
              <span className="cp-metric-label">est.</span>
            </div>
          </>
        )}
      </div>

      {/* Founders */}
      {p.founders?.length > 0 && (
        <div className="cp-founders">
          {p.founders.slice(0, 3).map((f: string, i: number) => (
            <a
              key={i}
              className="cp-founder-chip"
              href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(f + " " + (p.name || ""))}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {f} ↗
            </a>
          ))}
          {p.founders.length > 3 && (
            <span className="cp-founder-more">+{p.founders.length - 3}</span>
          )}
        </div>
      )}

      {/* Description */}
      {p.description && (
        <div className="cp-description">
          {p.description.length > 140
            ? p.description.slice(0, 140) + "..."
            : p.description}
        </div>
      )}

      {/* ═══ FUND PROFILE SELECTOR ═══ */}
      <div className="cp-fund-section">
        <button
          className="cp-fund-toggle"
          onClick={() => setShowFundConfig(!showFundConfig)}
        >
          <span className="cp-fund-label">Investor Lens</span>
          <span className="cp-fund-summary">
            {FIRM_TYPES.find(f => f.value === firmType)?.label} · {AUM_OPTIONS.find(a => a.value === aum)?.label}
          </span>
          <span className={`cp-chevron ${showFundConfig ? 'open' : ''}`}>▾</span>
        </button>
        {showFundConfig && (
          <div className="cp-fund-config">
            <div className="cp-fund-row">
              <label className="cp-fund-field-label">Firm Type</label>
              <div className="cp-pill-group">
                {FIRM_TYPES.map(ft => (
                  <button
                    key={ft.value}
                    className={`cp-pill ${firmType === ft.value ? 'active' : ''}`}
                    onClick={() => setFirmType(ft.value)}
                  >
                    {ft.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="cp-fund-row">
              <label className="cp-fund-field-label">AUM</label>
              <div className="cp-pill-group">
                {AUM_OPTIONS.map(a => (
                  <button
                    key={a.value}
                    className={`cp-pill ${aum === a.value ? 'active' : ''}`}
                    onClick={() => setAum(a.value)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ═══ ACTIONS ═══ */}
      {existingDealId ? (
        <div className="cp-actions-row">
          <button
            className="cp-btn cp-btn-primary"
            style={{ whiteSpace: "nowrap" }}
            onClick={() =>
              sendFollowUp(
                `Show the deal dashboard for deal_id="${existingDealId}".`,
              )
            }
          >
            Open Dashboard →
          </button>
          <button
            className="cp-btn cp-btn-ghost"
            onClick={() => {
              setDashboardRequested(false);
              handleProcessDeal();
            }}
          >
            Re-run ↻
          </button>
        </div>
      ) : analyze.isPending ? (
        <div className="cp-status">
          <span className="cp-spinner" />
          <span>Creating deal & launching agents...</span>
        </div>
      ) : analyze.isSuccess ? (
        <div className="cp-status cp-status-success">
          <span className="cp-check">✓</span>
          <span>Analysis running</span>
          <button
            className="cp-btn cp-btn-primary cp-btn-sm"
            style={{ whiteSpace: "nowrap" }}
            onClick={() =>
              sendFollowUp(
                `Show the deal dashboard for deal_id="${analyzeDealId}".`,
              )
            }
          >
            Open Dashboard →
          </button>
        </div>
      ) : (
        <div className="cp-actions-row">
          <button className="cp-btn cp-btn-primary" onClick={handleProcessDeal}>
            Process Deal →
          </button>
          <button
            className="cp-btn cp-btn-ghost"
            onClick={() =>
              sendFollowUp(
                `Bench ${p.name} (${p.domain}) for later review.`,
              )
            }
          >
            Bench
          </button>
        </div>
      )}
    </div>
  );
}

export default CompanyProfile;
mountWidget(<CompanyProfile />);
