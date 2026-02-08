import "@/index.css";
import { useEffect } from "react";
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

// Module-level guards — survive widget remounts
const _dealFired = new Set<string>();
const _runFired = new Set<string>();

/* ── Widget ────────────────────────────────────────────────────────── */
function CompanyProfile() {
  const { isSuccess, output, isPending, input } =
    useToolInfo<"company-profile">();
  const sendFollowUp = useSendFollowUpMessage();
  const deal = useCallTool("create_deal");
  const run = useCallTool("run_deal");

  const data = output as any;
  const p = data?.profile;

  // Auto-chain: create_deal → run_deal → show dashboard
  useEffect(() => {
    if (deal.isSuccess && deal.data?.structuredContent) {
      const sc = deal.data.structuredContent as any;
      const key = sc.deal_id;
      if (key && !_runFired.has(key)) {
        _runFired.add(key);
        run.callTool({ deal_id: key });
      }
    }
  }, [deal.isSuccess, deal.data]);

  useEffect(() => {
    if (run.isSuccess && deal.data?.structuredContent) {
      const sc = deal.data.structuredContent as any;
      const key = sc.deal_id;
      if (key && !_dealFired.has(key)) {
        _dealFired.add(key);
        sendFollowUp(
          `Show me the live deal dashboard for deal ${key} — Mistral AI analysis is running.`,
        );
      }
    }
  }, [run.isSuccess, deal.data]);

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

  /* ── Processing state (deal created, running) ──────────────── */
  const isProcessing = deal.isPending || deal.isSuccess;
  const dealId = (deal.data?.structuredContent as any)?.deal_id;

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
      {isProcessing ? (
        <div className="cp-processing">
          <span className="cala-pulse" />
          <span>
            {deal.isPending
              ? "Creating deal..."
              : run.isPending
                ? "Launching analysts..."
                : `Analysis running — deal ${dealId?.slice(0, 8)}…`}
          </span>
        </div>
      ) : (
        <div className="cp-actions">
          <button
            className="cp-btn-process"
            onClick={() => {
              deal.callTool({
                name: p.name,
                domain: p.domain,
                stage: p.growth_stage || "seed",
                geo: p.hq_country || "EU",
              });
            }}
          >
            Process Deal →
          </button>
          <button
            className="cp-btn-bench"
            onClick={() =>
              sendFollowUp(
                `Bench ${p.name} (${p.domain}) for later review. Save the profile and move on.`,
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
