import { Redis } from '@upstash/redis';

let redis;
function getRedis() {
  if (!redis) {
    // Try both possible env var names
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (url && token) {
      redis = new Redis({ url, token });
    }
  }
  return redis;
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
  const kv = getRedis();

  // Check cache first (skip if forceRefresh)
  if (!forceRefresh && kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached && (cached.venueIssues > 0 || cached.outdatedCount > 0 || cached.scannedAt)) {
        // Only use cache if it has real data OR was explicitly saved
        return res.status(200).json({ ...cached, fromCache: true });
      }
    } catch(e) {}
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
1. venueIssues: number of specific named venues (hotels, cafes, restaurants, bars, attractions) that may have closed, moved, or changed
2. outdatedCount: other outdated items (old prices, old currency like Croatian Kuna, COVID refs, "recently opened" claims, old stats)
3. venueNames: array of specific venue names mentioned (max 10)

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

    // Save to cache with 30 day TTL
    if (kv) {
      try {
        await kv.set(cacheKey, output, { ex: 2592000 });
      } catch(e) {
        // Log error in response for debugging
        output.cacheError = e.message;
      }
    }

    return res.status(200).json(output);

  } catch(e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ postId, venueIssues: 0, outdatedCount: 0, error: 'timeout' });
    return res.status(200).json({ postId, venueIssues: 0, outdatedCount: 0, error: e.message });
  }
}
