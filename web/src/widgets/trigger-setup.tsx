import "@/index.css";
import { useState, useEffect } from "react";
import { mountWidget, useSendFollowUpMessage } from "skybridge/web";
import { useToolInfo, useCallTool } from "../helpers.js";

/* ── Types ─────────────────────────────────────────────────────────── */
interface CategoryOption {
  id: string;
  label: string;
  icon: string;
  desc: string;
}
interface ExistingTrigger {
  id: string;
  name: string;
  query: string;
  category: string;
  email: string;
  source: string;
}
interface TriggerSetupData {
  company: string;
  domain: string;
  existingTriggers: ExistingTrigger[];
  categories: CategoryOption[];
  calaTriggersAvailable: boolean;
  specterProfile: any | null;
}

/* ── Widget ────────────────────────────────────────────────────────── */
function TriggerSetup() {
  const { isSuccess, output, isPending, input } = useToolInfo<"trigger-setup">();
  const sendFollowUp = useSendFollowUpMessage();
  const batchCreate = useCallTool("create_triggers_batch");
  const checkTriggers = useCallTool("check_triggers");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [email, setEmail] = useState("");
  const [customQuery, setCustomQuery] = useState("");
  const [created, setCreated] = useState(false);

  const data = output as TriggerSetupData | undefined;

  useEffect(() => {
    if (batchCreate.isSuccess) setCreated(true);
  }, [batchCreate.isSuccess]);

  /* ── Loading ─────────────────────────────────────────────────── */
  if (isPending || !isSuccess || !data) {
    return (
      <div className="loading">
        Loading trigger setup{input?.company ? ` for ${input.company}` : ""}...
      </div>
    );
  }

  const toggleCategory = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === data.categories.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(data.categories.map(c => c.id)));
    }
  };

  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const canSubmit = selected.size > 0 && isValidEmail && !batchCreate.isPending && !created;

  const handleCreate = () => {
    if (!canSubmit) return;
    batchCreate.callTool({
      company: data.company,
      domain: data.domain || undefined,
      email,
      categories: Array.from(selected),
      custom_query: customQuery || undefined,
    });
  };

  const createdData = batchCreate.data?.structuredContent as any;

  /* ── Render ──────────────────────────────────────────────────── */
  return (
    <div className="widget trg-setup">
      {/* Header */}
      <div className="trg-header">
        <div className="trg-icon-wrap">
          <span className="trg-icon">🔔</span>
        </div>
        <div>
          <div className="trg-title">Monitor {data.company}</div>
          <div className="trg-subtitle">
            Track key milestones for {data.company}{data.domain ? ` (${data.domain})` : ""}.
            {data.calaTriggersAvailable
              ? " Triggers are created natively on Cala's Beta API."
              : " Cala API key required — set CALA_API_KEY in .env."}
          </div>
        </div>
        {data.calaTriggersAvailable && (
          <span className="trg-jwt-badge" title="Cala Beta Triggers API active">⚡ API</span>
        )}
      </div>

      {/* Company context card (if Specter profile available) */}
      {data.specterProfile && (
        <div className="trg-company-ctx">
          {data.specterProfile.logo_url && (
            <img src={data.specterProfile.logo_url} alt="" className="trg-company-logo" />
          )}
          <div className="trg-company-info">
            <span className="trg-company-name">{data.specterProfile.name || data.company}</span>
            <span className="trg-company-meta">
              {data.specterProfile.growth_stage || ""}
              {data.specterProfile.hq_country ? ` · ${data.specterProfile.hq_country}` : ""}
              {data.specterProfile.industries?.length ? ` · ${data.specterProfile.industries.slice(0, 2).join(", ")}` : ""}
            </span>
          </div>
        </div>
      )}

      {/* Existing Triggers */}
      {data.existingTriggers.length > 0 && (
        <div className="trg-existing">
          <div className="trg-section-label">
            Active Triggers ({data.existingTriggers.length})
          </div>
          <div className="trg-existing-list">
            {data.existingTriggers.map((t, i) => (
              <div key={t.id || i} className="trg-existing-item">
                <span className="trg-existing-cat">
                  {data.categories.find(c => c.id === t.category)?.icon || "📌"}{" "}
                  {(t.name || t.query || '').slice(0, 40)}
                </span>
                <span className="trg-existing-email">{t.email}</span>
                <span className="trg-existing-source">
                  {t.source === 'cala' ? '⚡ Cala' : '📦 Local'}
                </span>
              </div>
            ))}
          </div>
          <button
            className="trg-check-btn"
            onClick={() => checkTriggers.callTool({})}
            disabled={checkTriggers.isPending}
          >
            {checkTriggers.isPending ? "Checking..." : "⚡ Check All Now"}
          </button>
          {checkTriggers.isSuccess && (
            <div className="trg-check-result">✅ Check complete — see chat for results</div>
          )}
        </div>
      )}

      {/* ── Success State ────────────────────────────────────────── */}
      {created && createdData ? (
        <div className="trg-success">
          <div className="trg-success-icon">✅</div>
          <div className="trg-success-title">
            {createdData.triggers?.length || 0} Triggers Created
          </div>
          <div className="trg-success-subtitle">
            Monitoring <b>{data.company}</b> → alerts to <b>{createdData.email}</b>
          </div>
          <div className="trg-success-list">
            {(createdData.triggers || []).map((t: any) => (
              <div key={t.id} className="trg-success-item">
                {data.categories.find(c => c.id === t.category)?.icon || "📌"}{" "}
                {(t.category || '').replace(/_/g, " ")}
                <span className="trg-success-source">
                  {t.source === 'cala' ? 'Cala native' : 'Local + Resend'}
                </span>
              </div>
            ))}
          </div>
          <div className="trg-success-note">
            Ask the AI to <b>check triggers</b> anytime, or triggers will be checked on next interaction.
          </div>
          <button
            className="trg-check-btn"
            onClick={() => checkTriggers.callTool({})}
            disabled={checkTriggers.isPending}
          >
            {checkTriggers.isPending ? "Checking..." : "⚡ Run First Check Now"}
          </button>
        </div>
      ) : (
        <>
          {/* ── Category Selector ──────────────────────────────── */}
          <div className="trg-section">
            <div className="trg-section-header">
              <div className="trg-section-label">Milestone Categories</div>
              <button className="trg-select-all" onClick={selectAll}>
                {selected.size === data.categories.length ? "Deselect All" : "Select All"}
              </button>
            </div>
            <div className="trg-categories">
              {data.categories.map(cat => (
                <button
                  key={cat.id}
                  className={`trg-cat-btn ${selected.has(cat.id) ? "trg-cat-active" : ""}`}
                  onClick={() => toggleCategory(cat.id)}
                >
                  <span className="trg-cat-icon">{cat.icon}</span>
                  <span className="trg-cat-label">{cat.label}</span>
                  {selected.has(cat.id) && <span className="trg-cat-check">✓</span>}
                </button>
              ))}
            </div>
            {selected.size > 0 && (
              <div className="trg-selected-desc">
                {Array.from(selected).map(id => {
                  const cat = data.categories.find(c => c.id === id);
                  return cat ? `${cat.icon} ${cat.desc}` : id;
                }).join(" · ")}
              </div>
            )}
          </div>

          {/* ── Custom query (optional) ───────────────────────── */}
          <div className="trg-section">
            <div className="trg-section-label">Custom Focus (optional)</div>
            <input
              className="trg-input"
              type="text"
              placeholder={`e.g., "European expansion", "API launch"...`}
              value={customQuery}
              onChange={e => setCustomQuery(e.target.value)}
            />
          </div>

          {/* ── Email ─────────────────────────────────────────── */}
          <div className="trg-section">
            <div className="trg-section-label">Email for Alerts</div>
            <input
              className="trg-input"
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>

          {/* ── Submit ────────────────────────────────────────── */}
          <button
            className={`trg-submit ${canSubmit ? "" : "trg-submit-disabled"}`}
            onClick={handleCreate}
            disabled={!canSubmit}
          >
            {batchCreate.isPending ? (
              <>
                <span className="cala-pulse" />
                Creating {selected.size} triggers...
              </>
            ) : (
              `Create ${selected.size} Trigger${selected.size !== 1 ? "s" : ""} →`
            )}
          </button>

          <div className="trg-powered">
            {data.calaTriggersAvailable
              ? <>Native triggers via <b>Cala.ai</b> Beta API</>
              : <>Monitored via <b>Cala.ai</b> knowledge base · Alerts via <b>Resend</b></>
            }
          </div>
        </>
      )}
    </div>
  );
}

export default TriggerSetup;
mountWidget(<TriggerSetup />);
