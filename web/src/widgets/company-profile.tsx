import "@/index.css";
import { mountWidget, useSendFollowUpMessage } from "skybridge/web";
import { useToolInfo } from "../helpers.js";

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

/* ── Widget ────────────────────────────────────────────────────────── */
function CompanyProfile() {
  const { isSuccess, output, isPending, input } =
    useToolInfo<"company-profile">();
  const sendFollowUp = useSendFollowUpMessage();

  const data = output as any;
  const p = data?.profile;
  const existingDealId = data?.existing_deal_id;

  /* ── Loading ─────────────────────────────────────────────────── */
  if (isPending || !isSuccess || !output) {
    return (
      <div className="loading">
        {input?.domain
          ? `Researching ${input.name || input.domain}...`
          : "Researching company..."}
      </div>
    );
  }

  /* ── Not found ───────────────────────────────────────────────── */
  if (!p) {
    return (
      <div className="widget cp-compact">
        <div className="cp-name">{data?.name || "Unknown"}</div>
        <div className="cp-meta">Company not found in Specter</div>
        <button
          className="action-btn"
          onClick={() =>
            sendFollowUp(
              `Search for ${data?.name || data?.domain} by name in Specter`,
            )
          }
        >
          Search by Name
        </button>
      </div>
    );
  }

  /* ── Compact profile ─────────────────────────────────────────── */
  return (
    <div
      className="widget cp-compact"
      data-llm={`Company: ${p.name}, Stage: ${p.growth_stage}, Funding: ${fmtMoney(p.funding_total_usd)}, Employees: ${p.employee_count}`}
    >
      {/* Row 1: Identity */}
      <div className="cp-row-id">
        <img
          className="cp-logo"
          src={`https://app.tryspecter.com/logo?domain=${p.domain}`}
          alt={p.name}
        />
        <div>
          <div className="cp-name">
            {p.domain ? (
              <a
                className="cp-name-link"
                href={`https://www.${p.domain.replace(/^www\./i, '')}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {p.name} <span className="cp-ext">↗</span>
              </a>
            ) : (
              p.name
            )}
          </div>
          <div className="cp-meta">
            {p.domain}
            {p.hq_country ? ` · ${p.hq_city || p.hq_country}` : ""}
            {p.growth_stage ? ` · ${p.growth_stage}` : ""}
          </div>
        </div>
      </div>

      {/* Wrong company? */}
      <button
        className="cp-wrong-btn"
        onClick={() =>
          sendFollowUp(
            `That's not the right company. Search for "${p.name}" by name in Specter and show me the results so I can pick the correct one.`,
          )
        }
      >
        Not this company? Try a different domain
      </button>

      {/* Row 2: Key numbers — single line */}
      <div className="cp-nums">
        <span>
          <b>{fmtMoney(p.funding_total_usd)}</b> raised
        </span>
        <span className="cp-sep">|</span>
        <span>
          <b>{fmtNum(p.employee_count)}</b> team
        </span>
        <span className="cp-sep">|</span>
        <span>
          <b>{fmtNum(p.web_monthly_visits)}</b>/mo visits
        </span>
        {p.founded_year && (
          <>
            <span className="cp-sep">|</span>
            <span>Est. {p.founded_year}</span>
          </>
        )}
      </div>

      {/* Row 3: Founders (one line, hyperlinked to LinkedIn search) */}
      {p.founders?.length > 0 && (
        <div className="cp-founders">
          {p.founders.slice(0, 3).map((f: string, i: number) => (
            <span key={i}>
              {i > 0 && " · "}
              <a
                className="cp-founder-link"
                href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(f + " " + (p.name || ""))}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {f} ↗
              </a>
            </span>
          ))}
          {p.founders.length > 3 && ` +${p.founders.length - 3}`}
        </div>
      )}

      {/* Row 4: One-liner description */}
      {p.description && (
        <div className="cp-desc">
          {p.description.length > 120
            ? p.description.slice(0, 120) + "…"
            : p.description}
        </div>
      )}

      {/* ═══ ACTIONS ═══ */}
      {existingDealId ? (
        <div className="cp-actions">
          <button
            className="cp-btn-process"
            onClick={() =>
              sendFollowUp(
                `Show me the deal-dashboard for ${p.name} — deal_id is ${existingDealId}`,
              )
            }
          >
            View Deal Dashboard →
          </button>
          <button
            className="cp-btn-bench"
            onClick={() =>
              sendFollowUp(
                `Re-analyze ${p.name} (${p.domain}) as a deal. Use analyze_deal, then immediately show the deal-dashboard with the returned deal_id.`,
              )
            }
          >
            Re-run ↻
          </button>
        </div>
      ) : (
        <div className="cp-actions">
          <button
            className="cp-btn-process"
            onClick={() =>
              sendFollowUp(
                `Analyze ${p.name} (${p.domain}) as a deal — use analyze_deal with name="${p.name}" domain="${p.domain}" stage="${p.growth_stage || 'seed'}" geo="${p.hq_country || 'EU'}", then IMMEDIATELY show the deal-dashboard widget with the returned deal_id. Do both in one response.`,
              )
            }
          >
            Process Deal →
          </button>
          <button
            className="cp-btn-bench"
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
