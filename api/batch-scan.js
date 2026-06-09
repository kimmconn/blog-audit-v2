// Batch AI Scanner with Upstash caching
// Uses Claude Haiku for speed/cost efficiency

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

async function kvSet(key, value, ttlSeconds = 2592000) { // 30 days
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(value), ex: ttlSeconds }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { postId, postUrl, postTitle, siteUrl, forceRefresh } = req.body;
  if (!postId || !siteUrl) return res.status(400).json({ error: 'Missing postId or siteUrl' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Anthropic API key not configured' });

  const cacheKey = `scan:${siteUrl}:${postId}`;

  // Check cache first
  if (!forceRefresh) {
    const cached = await kvGet(cacheKey);
    if (cached) return res.status(200).json({ ...cached, fromCache: true });
  }

  try {
    const wpRes = await fetch(
      `${siteUrl}/wp-json/wp/v2/posts/${postId}?_fields=content,title`,
      { headers: { 'User-Agent': 'BlogAuditTool/1.0' }, signal: AbortSignal.timeout(12000) }
    );
    if (!wpRes.ok) return res.status(200).json({ postId, venueIssues: 0, outdatedCount: 0, error: `fetch failed ${wpRes.status}` });

    const wpData = await wpRes.json();
    const rawHtml = wpData?.content?.rendered || '';
    const content = rawHtml
      .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
      .replace(/\s{2,}/g, ' ').trim().slice(0, 4000);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: `You are a travel blog content auditor. Scan posts and extract venue names and outdated content counts. Return ONLY valid JSON, nothing else.`,
        messages: [{
          role: 'user',
          content: `Scan this travel blog post quickly.

Title: "${postTitle}"
Content: ${content}

Count and extract:
1. venueIssues: number of specific named venues (hotels, cafes, restaurants, bars, attractions) that may have closed, moved, or changed — use your knowledge
2. outdatedCount: other outdated items (old prices, old currency like Croatian Kuna, COVID refs, "recently opened" claims that are now old, old stats)
3. venueNames: array of specific venue names mentioned (max 10, for later Google verification)

Return ONLY this JSON:
{
  "venueIssues": 0,
  "outdatedCount": 0,
  "hasOldCurrency": false,
  "hasCovid": false,
  "hasOldPrices": false,
  "venueNames": []
}`
        }]
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!claudeRes.ok) return res.status(200).json({ postId, venueIssues: 0, outdatedCount: 0, error: `claude ${claudeRes.status}` });

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '{}';

    let result;
    try {
      result = JSON.parse(rawText.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim());
    } catch {
      return res.status(200).json({ postId, venueIssues: 0, outdatedCount: 0, error: 'parse failed' });
    }

    const output = {
      postId,
      venueIssues: Math.max(0, parseInt(result.venueIssues) || 0),
      outdatedCount: Math.max(0, parseInt(result.outdatedCount) || 0),
      hasOldCurrency: result.hasOldCurrency || false,
      hasCovid: result.hasCovid || false,
      hasOldPrices: result.hasOldPrices || false,
      venueNames: result.venueNames || [],
      scannedAt: new Date().toISOString(),
      fromCache: false,
    };

    // Save to cache
    await kvSet(cacheKey, output);

    return res.status(200).json(output);

  } catch(e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ postId, venueIssues: 0, outdatedCount: 0, error: 'timeout' });
    return res.status(200).json({ postId, venueIssues: 0, outdatedCount: 0, error: e.message });
  }
}
