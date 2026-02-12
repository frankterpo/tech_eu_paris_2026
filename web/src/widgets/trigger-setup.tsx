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

const WEBHOOK_URL = "https://tech-eu-paris-2026-0d53df71.alpic.live/api/webhooks/cala-trigger";
const CALA_CONSOLE_URL = "https://console.cala.ai/triggers";

/* ── Widget ────────────────────────────────────────────────────────── */
function TriggerSetup() {
  const { isSuccess, output, isPending, input } = useToolInfo<"trigger-setup">();
  const sendFollowUp = useSendFollowUpMessage();
  const batchCreate = useCallTool("create_triggers_batch");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [email, setEmail] = useState("");
  const [customQuery, setCustomQuery] = useState("");
  const [created, setCreated] = useState(false);
  const [copiedQuery, setCopiedQuery] = useState<string | null>(null);

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
    if (selected.size === data.categories.length) setSelected(new Set());
    else setSelected(new Set(data.categories.map(c => c.id)));
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

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedQuery(label);
      setTimeout(() => setCopiedQuery(null), 2000);
    }).catch(() => {});
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
            Track key milestones. Triggers created via{" "}
            <a href={CALA_CONSOLE_URL} target="_blank" rel="noopener" style={{ color: "#2563eb" }}>
              Cala AI Console
            </a>{" "}
            — alerts forwarded to your email via Resend.
          </div>
        </div>
      </div>

      {/* ── Success State ──────────────────────────────────────── */}
      {created && createdData ? (
        <div className="trg-success">
          <div className="trg-success-icon">✅</div>
          <div className="trg-success-title">
            {createdData.triggers?.length || 0} Triggers Saved
          </div>
          <div className="trg-success-subtitle">
            Alerts for <b>{data.company}</b> → <b>{createdData.email}</b>
          </div>

          {/* ── Step-by-step Cala Console Instructions ──────── */}
          <div className="trg-instructions">
            <div className="trg-instructions-title">Set up native Cala triggers:</div>

            <div className="trg-step">
              <span className="trg-step-num">1</span>
              <span>
                Open{" "}
                <a href={CALA_CONSOLE_URL} target="_blank" rel="noopener" style={{ color: "#2563eb", fontWeight: 600 }}>
                  console.cala.ai/triggers
                </a>
              </span>
            </div>

            <div className="trg-step">
              <span className="trg-step-num">2</span>
              <span>Create a trigger for each query below (click to copy):</span>
            </div>

            <div className="trg-query-list">
              {(createdData.queriesForConsole || []).map((q: any, i: number) => (
                <button
                  key={i}
                  className="trg-query-item"
                  onClick={() => copyToClipboard(q.query, q.name)}
                  title="Click to copy query"
                >
                  <span className="trg-query-name">{q.name}</span>
                  <span className="trg-query-text">{q.query}</span>
                  <span className="trg-query-copy">
                    {copiedQuery === q.name ? "✓ Copied" : "Copy"}
                  </span>
                </button>
              ))}
            </div>

            <div className="trg-step">
              <span className="trg-step-num">3</span>
              <span>Add webhook notification with this URL:</span>
            </div>
            <button
              className="trg-webhook-url"
              onClick={() => copyToClipboard(WEBHOOK_URL, "webhook")}
              title="Click to copy webhook URL"
            >
              <code>{WEBHOOK_URL}</code>
              <span className="trg-query-copy">
                {copiedQuery === "webhook" ? "✓ Copied" : "Copy"}
              </span>
            </button>

            <div className="trg-step">
              <span className="trg-step-num">4</span>
              <span>When Cala detects changes, we email <b>{createdData.email}</b> via Resend</span>
            </div>
          </div>
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
                Setting up {selected.size} triggers...
              </>
            ) : (
              `Set Up ${selected.size} Trigger${selected.size !== 1 ? "s" : ""} →`
            )}
          </button>

          <div className="trg-powered">
            Triggers via{" "}
            <a href={CALA_CONSOLE_URL} target="_blank" rel="noopener" style={{ color: "#2563eb" }}>
              <b>Cala.ai</b>
            </a>{" "}
            · Alerts via <b>Resend</b>
          </div>
        </>
      )}
    </div>
  );
}

export default TriggerSetup;
mountWidget(<TriggerSetup />);
