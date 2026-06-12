// GSC data fetcher - gets clicks, impressions, CTR per URL
// Also fetches top keywords per page for keyword volume lookups
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { siteUrl, accessToken, startDate, endDate, includeKeywords } = req.body;
  if (!siteUrl || !accessToken) return res.status(400).json({ error: 'Missing siteUrl or accessToken' });

  const start = startDate || (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString().split('T')[0]; })();
  const end = endDate || new Date().toISOString().split('T')[0];

  try {
    // Primary fetch: clicks/impressions per page
    const gscRes = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate: start,
          endDate: end,
          dimensions: ['page'],
          rowLimit: 5000,
        }),
      }
    );

    if (!gscRes.ok) {
      const err = await gscRes.json().catch(() => ({}));
      return res.status(gscRes.status).json({ error: err.error?.message || `GSC API error ${gscRes.status}` });
    }

    const data = await gscRes.json();
    const rows = (data.rows || []).map(row => ({
      url: row.keys[0],
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    }));

    // Optional: fetch top keywords per page (only when explicitly requested)
    let keywordsByPage = {};
    if (includeKeywords) {
      try {
        const kwRes = await fetch(
          `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              startDate: start,
              endDate: end,
              dimensions: ['page', 'query'],
              rowLimit: 25000,
              dimensionFilterGroups: [{
                filters: [{ dimension: 'query', operator: 'notContains', expression: 'xxx' }]
              }]
            }),
          }
        );
        if (kwRes.ok) {
          const kwData = await kwRes.json();
          (kwData.rows || []).forEach(row => {
            const url = row.keys[0];
            const query = row.keys[1];
            if (!keywordsByPage[url]) keywordsByPage[url] = [];
            if (keywordsByPage[url].length < 10) {
              keywordsByPage[url].push(query);
            }
          });
        }
      } catch(e) {}
    }

    return res.status(200).json({ rows, keywordsByPage });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
