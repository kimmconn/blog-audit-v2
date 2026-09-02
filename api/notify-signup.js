export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Simple shared-secret check so random internet traffic can't trigger emails.
  // Supabase lets you add a custom HTTP header when creating the webhook — set it to match WEBHOOK_SECRET below.
  const secret = req.headers['x-webhook-secret'];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'adventuresnsunsets@gmail.com';
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Resend not configured' });

  try {
    const payload = req.body || {};
    const row = payload.record || {};
    const table = payload.table || 'unknown table';

    const subject = `🔔 Bloupi: new row in ${table}`;
    const html = `
      <div style="font-family:sans-serif;font-size:14px;color:#161a2e">
        <p><strong>New ${table} entry</strong></p>
        <pre style="background:#f5f5f5;padding:12px;border-radius:8px;white-space:pre-wrap">${JSON.stringify(row, null, 2)}</pre>
      </div>
    `;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || 'Bloupi Alerts <onboarding@resend.dev>',
        to: NOTIFY_EMAIL,
        subject,
        html,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Resend error: ${err}` });
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
