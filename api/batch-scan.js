// Batch AI Scanner
// Lightweight Claude scan for ALL posts — extracts counts for urgency scoring
// Much faster/cheaper than full report — just counts, no detailed analysis

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { postId, postUrl, postTitle, siteUrl } = req.body;
  if (!postId || !siteUrl) return res.status(400).json({ error: 'Missing postId or siteUrl' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Anthropic API key not configured' });

  try {
    // Fetch post content — smaller slice for speed
    const wpRes = await fetch(
      `${siteUrl}/wp-json/wp/v2/posts/${postId}?_fields=content,title`,
      { headers: { 'User-Agent': 'BlogAuditTool/1.0' }, signal: AbortSignal.timeout(12000) }
    );
    if (!wpRes.ok) return res.status(200).json({ postId, venueIssues: 0, outdatedCount: 0, error: `fetch failed ${wpRes.status}` });

    const wpData = await wpRes.json();
    const rawHtml = wpData?.content?.rendered || '';
    const content = rawHtml
      .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
      .replace(/\s{2,}/g, ' ').trim().slice(0, 4000); // smaller for speed

    // Quick Claude scan — just counts, no detailed analysis
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: `You are a travel blog content auditor. Quickly scan blog posts and count issues. Return ONLY valid JSON, nothing else.`,
        messages: [{
          role: 'user',
          content: `Quickly scan this travel blog post and count issues. 

Title: "${postTitle}"
Content: ${content}

Count:
1. venueIssues: specific named venues/hotels/restaurants/cafes that may have closed, moved, or changed (use your knowledge of business closures and changes)
2. outdatedCount: other outdated items (old prices, old currency like Croatian Kuna, COVID references, "recently opened" claims, old stats with specific years, outdated transport info)

Return ONLY this JSON:
{"venueIssues": 0, "outdatedCount": 0, "hasOldCurrency": false, "hasCovid": false, "hasOldPrices": false}`
        }]
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!claudeRes.ok) {
      return res.status(200).json({ postId, venueIssues: 0, outdatedCount: 0, error: `claude ${claudeRes.status}` });
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '{}';

    let result;
    try {
      result = JSON.parse(rawText.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim());
    } catch {
      return res.status(200).json({ postId, venueIssues: 0, outdatedCount: 0, error: 'parse failed' });
    }

    return res.status(200).json({
      postId,
      venueIssues: Math.max(0, parseInt(result.venueIssues) || 0),
      outdatedCount: Math.max(0, parseInt(result.outdatedCount) || 0),
      hasOldCurrency: result.hasOldCurrency || false,
      hasCovid: result.hasCovid || false,
      hasOldPrices: result.hasOldPrices || false,
    });

  } catch(e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ postId, venueIssues: 0, outdatedCount: 0, error: 'timeout' });
    return res.status(200).json({ postId, venueIssues: 0, outdatedCount: 0, error: e.message });
  }
}
