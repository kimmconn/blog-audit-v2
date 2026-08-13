// GSC data fetcher - gets clicks, impressions, CTR per URL
// Also fetches top keywords per page for keyword volume lookups
async function refreshAccessToken(userId) {
  if (!userId) return null;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
    const { data: conn } = await supabase.from('gsc_connections').select('refresh_token').eq('user_id', userId).single();
    if (!conn || !conn.refresh_token) return null;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: conn.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error || !tokens.access_token) return null;
    await supabase.from('gsc_connections').update({ access_token: tokens.access_token }).eq('user_id', userId);
    return tokens.access_token;
  } catch (e) {
    return null;
  }
}
async function queryGSC(siteUrl, accessToken, body) {
  return fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
}
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
const { siteUrl, accessToken, startDate, endDate, includeKeywords, pageUrls, userId } = req.body;  if (!siteUrl || !accessToken) return res.status(400).json({ error: 'Missing siteUrl or accessToken' });
  const start = startDate || (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString().split('T')[0]; })();
  const end = endDate || new Date().toISOString().split('T')[0];
  let currentToken = accessToken;
  let refreshedAccessToken = null;
  try {
    // Primary fetch: clicks/impressions per page
    let gscRes = await queryGSC(siteUrl, currentToken, {
      startDate: start,
      endDate: end,
      dimensions: ['page'],
      rowLimit: 5000,
    });
    if (gscRes.status === 401) {
      const newToken = await refreshAccessToken(userId);
      if (newToken) {
        currentToken = newToken;
        refreshedAccessToken = newToken;
        gscRes = await queryGSC(siteUrl, currentToken, {
          startDate: start,
          endDate: end,
          dimensions: ['page'],
          rowLimit: 5000,
        });
      }
    }
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
    // Optional: fetch top keywords per page using page-filtered queries
    // This approach queries each page's keywords directly for accuracy
    let keywordsByPage = {};
    let kwDebugInfo = null;
    if (includeKeywords) {
      try {
  const kwBody = {
          startDate: start,
          endDate: end,
          dimensions: ['page', 'query'],
          rowLimit: 25000,
          orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
        };
        if (pageUrls && pageUrls.length) {
          const escaped = pageUrls.map(u => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
          kwBody.dimensionFilterGroups = [{
            filters: [{ dimension: 'page', operator: 'includingRegex', expression: `^(${escaped.join('|')})/?$` }]
          }];
        }
        let kwRes = await queryGSC(siteUrl, currentToken, kwBody);
        if (kwRes.status === 401 && !refreshedAccessToken) {
          const newToken = await refreshAccessToken(userId);
          if (newToken) {
            currentToken = newToken;
            refreshedAccessToken = newToken;
            kwRes = await queryGSC(siteUrl, currentToken, kwBody);
          }
        }
        if (kwRes.ok) {
          const kwData = await kwRes.json();
          kwDebugInfo = { ok: true, status: kwRes.status, rowCount: (kwData.rows||[]).length };
      (kwData.rows || []).forEach(row => {
            const rawUrl = row.keys[0];
            const query = row.keys[1];
            const clicks = row.clicks || 0;
            const baseUrl = rawUrl.split('#')[0]; // strip anchor fragments — not real separate pages
            const withSlash = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
            const noSlash = baseUrl.replace(/\/$/, '');
           [noSlash, withSlash].forEach(key => {
              if (!keywordsByPage[key]) keywordsByPage[key] = [];
              if (keywordsByPage[key].length < 8 && !keywordsByPage[key].some(k=>k.query===query)) {
                keywordsByPage[key].push({query, clicks});
              }
            });
          });
        } else {
          const errBody = await kwRes.text().catch(()=>'');
          kwDebugInfo = { ok: false, status: kwRes.status, error: errBody.slice(0,300) };
        }
      } catch(e) {
        kwDebugInfo = { ok: false, caughtError: e.message };
      }
    }
    return res.status(200).json({ rows, keywordsByPage, kwDebugInfo, refreshedAccessToken });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
