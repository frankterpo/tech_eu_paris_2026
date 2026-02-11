/**
 * Cala AI Trigger Webhook → Resend Email Relay
 *
 * Permanent microservice on Railway.
 * Zero dependencies — uses Node.js built-in fetch.
 *
 * Cala trigger-fired payload:
 * {
 *   "type": "string",
 *   "timestamp": "ISO",
 *   "data": { "trigger_id", "trigger_name", "query", "answer" }
 * }
 *
 * Env vars (set in Railway dashboard):
 *   RESEND_API_KEY, RESEND_FROM, TRIGGER_NOTIFY_EMAIL
 */

import { createServer } from "node:http";

const PORT = process.env.PORT || 3001;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "Deal Bot <onboarding@resend.dev>";
const TRIGGER_NOTIFY_EMAIL = process.env.TRIGGER_NOTIFY_EMAIL;

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function buildEmailHtml({ triggerName, query, triggerId, answer, timestamp }) {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #7c5cfc; margin-bottom: 4px;">Cala AI Trigger Fired</h2>
      <p style="color: #999; font-size: 13px; margin-top: 0;">${new Date(timestamp).toUTCString()}</p>

      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; background: #fafafa; border-radius: 8px;">
        <tr>
          <td style="padding: 10px 12px; color: #666; width: 100px;">Trigger</td>
          <td style="padding: 10px 12px; font-weight: 600; color: #1a1a2e;">${triggerName}</td>
        </tr>
        <tr>
          <td style="padding: 10px 12px; color: #666;">Query</td>
          <td style="padding: 10px 12px; color: #333;">${query}</td>
        </tr>
        ${triggerId ? `<tr><td style="padding: 10px 12px; color: #666;">ID</td><td style="padding: 10px 12px; font-size: 11px; color: #aaa; font-family: monospace;">${triggerId}</td></tr>` : ""}
      </table>

      <h3 style="color: #1a1a2e; margin-bottom: 8px;">Updated Intelligence</h3>
      <div style="background: #f8f8fc; padding: 16px; border-radius: 8px; border-left: 4px solid #7c5cfc; color: #333; line-height: 1.6;">
        ${answer.replace(/\n/g, "<br/>")}
      </div>

      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
      <p style="color: #bbb; font-size: 11px; text-align: center;">
        Sent by Deal Bot — powered by <a href="https://cala.ai" style="color: #7c5cfc;">Cala AI</a> · <a href="https://resend.com" style="color: #7c5cfc;">Resend</a>
      </p>
    </div>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === "OPTIONS") return json(res, 204, null);

  // Health
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      status: "ok",
      service: "dealbot-cala-webhook",
      resend: !!RESEND_API_KEY,
      email: TRIGGER_NOTIFY_EMAIL ? "configured" : "unset",
      uptime: process.uptime(),
    });
  }

  // Webhook receiver
  if (req.method === "POST" && (url.pathname === "/" || url.pathname === "/webhook")) {
    try {
      const payload = await readBody(req);

      // Parse nested or flat
      const d = payload.data || payload;
      const triggerId = d.trigger_id || "";
      const triggerName = d.trigger_name || d.name || "Unknown trigger";
      const query = d.query || "";
      const answer = d.answer || "";
      const timestamp = payload.timestamp || new Date().toISOString();

      // Recipient: query param > payload email > env
      const recipientEmail =
        url.searchParams.get("email") || d.email || TRIGGER_NOTIFY_EMAIL;

      if (!recipientEmail) {
        return json(res, 400, { error: "No recipient. Set TRIGGER_NOTIFY_EMAIL or pass ?email=..." });
      }
      if (!RESEND_API_KEY) {
        return json(res, 500, { error: "RESEND_API_KEY not configured" });
      }

      // Send via Resend
      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: RESEND_FROM,
          to: [recipientEmail],
          subject: `Trigger Alert: ${triggerName}`,
          html: buildEmailHtml({ triggerName, query, triggerId, answer, timestamp }),
        }),
      });

      const resendData = await resendRes.json();

      if (!resendRes.ok) {
        console.error("[Resend] Error:", resendData);
        return json(res, 502, { error: "Resend failed", details: resendData });
      }

      console.log(`[Webhook] ${triggerName} → ${recipientEmail} (${resendData.id})`);
      return json(res, 200, {
        received: true,
        email_sent: true,
        recipient: recipientEmail,
        resend_id: resendData.id,
        trigger_name: triggerName,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[Webhook] Error:", err.message);
      return json(res, 500, { error: err.message });
    }
  }

  json(res, 404, { error: "POST / or /webhook for triggers, GET /health for status" });
});

server.listen(PORT, () => {
  console.log(`Cala webhook relay listening on :${PORT}`);
  console.log(`  Resend: ${RESEND_API_KEY ? "configured" : "MISSING"}`);
  console.log(`  Email:  ${TRIGGER_NOTIFY_EMAIL || "MISSING — use ?email= param"}`);
});
