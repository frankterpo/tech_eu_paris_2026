/**
 * Cloudflare Worker — Cala AI Trigger Webhook → Resend Email
 *
 * Permanent relay: Cala fires webhook → this worker → Resend email
 * Deploy: cd webhook-worker && npx wrangler deploy
 * Secrets: npx wrangler secret put RESEND_API_KEY
 *          npx wrangler secret put TRIGGER_NOTIFY_EMAIL
 */

function buildHtml({ triggerName, query, triggerId, answer, timestamp }) {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #7c5cfc; margin-bottom: 4px;">Cala AI Trigger Fired</h2>
      <p style="color: #999; font-size: 13px; margin-top: 0;">${new Date(timestamp).toUTCString()}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; background: #fafafa; border-radius: 8px;">
        <tr><td style="padding: 10px 12px; color: #666; width: 100px;">Trigger</td><td style="padding: 10px 12px; font-weight: 600; color: #1a1a2e;">${triggerName}</td></tr>
        <tr><td style="padding: 10px 12px; color: #666;">Query</td><td style="padding: 10px 12px; color: #333;">${query}</td></tr>
        ${triggerId ? `<tr><td style="padding: 10px 12px; color: #666;">ID</td><td style="padding: 10px 12px; font-size: 11px; color: #aaa; font-family: monospace;">${triggerId}</td></tr>` : ''}
      </table>
      <h3 style="color: #1a1a2e; margin-bottom: 8px;">Updated Intelligence</h3>
      <div style="background: #f8f8fc; padding: 16px; border-radius: 8px; border-left: 4px solid #7c5cfc; color: #333; line-height: 1.6;">
        ${answer.replace(/\n/g, '<br/>')}
      </div>
      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
      <p style="color: #bbb; font-size: 11px; text-align: center;">
        Sent by Deal Bot — powered by <a href="https://cala.ai" style="color: #7c5cfc;">Cala AI</a> · <a href="https://resend.com" style="color: #7c5cfc;">Resend</a>
      </p>
    </div>`;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return json(204, null);

    const url = new URL(request.url);

    // Health
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      return json(200, {
        status: 'ok',
        service: 'dealbot-cala-webhook',
        resend: !!env.RESEND_API_KEY,
        email: env.TRIGGER_NOTIFY_EMAIL ? 'configured' : 'unset',
      });
    }

    // Webhook
    if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '/webhook')) {
      try {
        const payload = await request.json();
        const d = payload.data || payload;
        const triggerId = d.trigger_id || '';
        const triggerName = d.trigger_name || d.name || 'Unknown trigger';
        const query = d.query || '';
        const answer = d.answer || '';
        const timestamp = payload.timestamp || new Date().toISOString();

        const recipientEmail = url.searchParams.get('email') || d.email || env.TRIGGER_NOTIFY_EMAIL;
        if (!recipientEmail) return json(400, { error: 'No recipient. Set TRIGGER_NOTIFY_EMAIL or ?email=...' });
        if (!env.RESEND_API_KEY) return json(500, { error: 'RESEND_API_KEY not configured' });

        const fromAddr = env.RESEND_FROM || 'Deal Bot <onboarding@resend.dev>';
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: fromAddr,
            to: [recipientEmail],
            subject: `Trigger Alert: ${triggerName}`,
            html: buildHtml({ triggerName, query, triggerId, answer, timestamp }),
          }),
        });

        const data = await res.json();
        if (!res.ok) return json(502, { error: 'Resend failed', details: data });

        return json(200, {
          received: true,
          email_sent: true,
          recipient: recipientEmail,
          resend_id: data.id,
          trigger_name: triggerName,
          ts: new Date().toISOString(),
        });
      } catch (err) {
        return json(500, { error: err.message });
      }
    }

    return json(404, { error: 'POST / or /webhook for triggers. GET /health for status.' });
  },
};
