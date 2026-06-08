import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { postId, postUrl, postTitle, siteUrl, gscData, brokenLinks, forceRefresh } = req.body;
  if (!postId || !siteUrl) return res.status(400).json({ error: 'Missing postId or siteUrl' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Anthropic API key not configured' });

  const cacheKey = `report:${siteUrl}:${postId}`;
  const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days

  // Check cache first (unless force refresh)
  if (!forceRefresh) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) {
        return res.status(200).json({ ...cached, fromCache: true });
      }
    } catch (e) {
      // KV not available, proceed without cache
    }
  }

  try {
    // Fetch post content
    const wpRes = await fetch(
      `${siteUrl}/wp-json/wp/v2/posts/${postId}?_fields=content,title,date,modified`,
      { headers: { 'User-Agent': 'BlogAuditTool/1.0' }, signal: AbortSignal.timeout(15000) }
    );
    if (!wpRes.ok) return res.status(200).json({ error: `Could not fetch post: ${wpRes.status}` });

    const wpData = await wpRes.json();
    const rawHtml = wpData?.content?.rendered || '';
    const content = rawHtml
      .replace(/<h[1-6][^>]*>/gi, '\n## ').replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ').replace(/<p[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n')
      .trim().slice(0, 8000);

    const publishDate = wpData?.date?.split('T')[0] || 'unknown';
    const modifiedDate = wpData?.modified?.split('T')[0] || 'unknown';

    const gscContext = gscData ? `GSC Data: ${gscData.recentClicks||0} clicks (recent), ${gscData.olderClicks||0} clicks (older period), ${gscData.trafficDeclinePct||0}% decline, position ${gscData.position?.toFixed(1)||'unknown'}, ${gscData.recentImpressions||0} impressions` : 'No GSC data available';

    const linksContext = brokenLinks?.length > 0
      ? `${brokenLinks.length} potential broken links detected:\n${brokenLinks.slice(0,10).map(l=>`- ${l.url} (${l.status||'timeout'})`).join('\n')}${brokenLinks.length>10?`\n...and ${brokenLinks.length-10} more`:''}`
      : 'No broken links detected';

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        system: `You are an expert travel blog content auditor specializing in keeping travel content accurate, current, and SEO-optimized. You have deep knowledge of world events, currency changes, business closures, travel requirement changes, and cultural shifts that affect travel content accuracy. Be specific — quote actual text from the post when flagging issues. Return ONLY valid JSON, no markdown fences, no preamble.`,
        messages: [{
          role: 'user',
          content: `Audit this travel blog post for update opportunities.

Title: "${postTitle}"
URL: ${postUrl}
Published: ${publishDate} | Last modified: ${modifiedDate}
${gscContext}
${linksContext}

POST CONTENT:
${content}

Check specifically for:
- Outdated prices or cost references (meals, accommodation, tours, entry fees)
- References to "new", "recently opened", "just opened", "brand new" venues or attractions
- Old statistics or data points with specific years/numbers
- Award references ("best of 2019", "#1 rated in 2020")
- Currency references (especially old currencies like Croatian Kuna, pre-Euro countries)
- COVID/pandemic references that are now outdated
- Outdated visa or entry requirements
- Old transport info (routes, companies, prices)
- Outdated seasonal info with specific past years
- Dead or changed social media handles
- App recommendations that may no longer exist
- Old exchange rates presented as current
- "Recently" or "just" claims that are now years old given publish date
- Safety warnings that may be outdated
- Business hours presented as definitive
- Specific hotel/accommodation prices
- Affiliate or booking links that may have changed

Return this exact JSON:
{
  "summary": "2-3 sentence overview of update needs and overall post health",
  "urgencyReason": "single most important reason to update this post now",
  "estimatedUpdateTime": "15 mins|30 mins|1 hour|2+ hours",
  "outdatedContent": [
    {
      "type": "price|date|venue|currency|visa|transport|covid|award|stat|seasonal|social|app|safety|hours|affiliate",
      "quote": "exact short quote from post",
      "issue": "why this is likely outdated",
      "suggestion": "specific fix or how to verify"
    }
  ],
  "seoOpportunities": [
    {
      "type": "title|meta|keyword|heading|internal_link|freshness|schema",
      "issue": "specific SEO issue found",
      "suggestion": "specific actionable fix"
    }
  ],
  "contentGaps": [
    {
      "topic": "missing topic or section",
      "reason": "why adding this would help rankings or reader experience"
    }
  ],
  "quickWins": [
    "specific quick fix that takes under 5 minutes"
  ]
}`
        }]
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(200).json({ error: `Claude API error ${claudeRes.status}: ${err.slice(0,200)}` });
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '{}';

    let report;
    try {
      report = JSON.parse(rawText.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim());
    } catch {
      return res.status(200).json({ error: 'Could not parse Claude response', raw: rawText.slice(0,500) });
    }

    const result = {
      postId, postUrl, postTitle, publishDate, modifiedDate,
      brokenLinksCount: brokenLinks?.length || 0,
      generatedAt: new Date().toISOString(),
      report,
      fromCache: false,
    };

    // Save to cache
    try {
      await kv.set(cacheKey, result, { ex: CACHE_TTL });
    } catch (e) {
      // KV not available, return without caching
    }

    return res.status(200).json(result);

  } catch (e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ error: 'Request timed out — try again' });
    return res.status(200).json({ error: e.message });
  }
}
