export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { postId, postUrl, postTitle, siteUrl, gscData, brokenLinks } = req.body;
  if (!postId || !siteUrl) return res.status(400).json({ error: 'Missing postId or siteUrl' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Anthropic API key not configured' });

  try {
    // Fetch post content from WordPress
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

    const gscContext = gscData
      ? `GSC: ${gscData.recentClicks||0} clicks (recent 8mo), ${gscData.olderClicks||0} clicks (prior 8mo), ${gscData.trafficDeclinePct||0}% decline, position ${gscData.position?.toFixed(1)||'?'}, ${gscData.recentImpressions||0} impressions`
      : 'No GSC data available';

    const linksContext = brokenLinks?.length > 0
      ? `${brokenLinks.length} potential broken links:\n${brokenLinks.slice(0,8).map(l=>`- ${l.url} (${l.status||'timeout'})`).join('\n')}`
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
        system: `You are an expert travel blog content auditor. You have deep knowledge of world events, currency changes, business closures, and travel requirement changes. Be specific — quote actual text from the post when flagging issues. Return ONLY valid JSON, no markdown fences, no extra text.`,
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

Check for ALL of these:
- Prices (meals, hotels, tours, entry fees)
- "New", "recently opened", "just opened", "brand new" claims
- Statistics with specific years/numbers
- Award references ("best of 2019")
- Old currencies (e.g. Croatian Kuna — Croatia switched to Euro Jan 2023)
- COVID/pandemic references now outdated
- Outdated visa or entry requirements
- Old transport routes, prices, companies
- Outdated seasonal info with specific past years
- Dead social media handles or apps
- Old exchange rates presented as current
- "Recently" or "just" claims that are now old given publish date
- Business hours presented as definitive
- Affiliate or booking links that may have changed
- Safety warnings that may be outdated

Return ONLY this JSON structure, nothing else:
{
  "summary": "2-3 sentence overview",
  "urgencyReason": "main reason to update now",
  "estimatedUpdateTime": "15 mins|30 mins|1 hour|2+ hours",
  "venueIssues": 0,
  "outdatedContentCount": 0,
  "outdatedContent": [
    {
      "type": "price|date|venue|currency|visa|transport|covid|award|stat|seasonal|social|app|safety|hours|affiliate",
      "quote": "exact short quote from post",
      "issue": "why outdated",
      "suggestion": "how to fix"
    }
  ],
  "seoOpportunities": [
    {
      "type": "title|meta|keyword|heading|internal_link|freshness",
      "issue": "specific SEO issue",
      "suggestion": "specific fix"
    }
  ],
  "contentGaps": [
    {
      "topic": "missing topic",
      "reason": "why it would help"
    }
  ],
  "quickWins": ["quick fix 1", "quick fix 2", "quick fix 3"]
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
    } catch(e) {
      return res.status(200).json({ error: 'Could not parse Claude response', raw: rawText.slice(0,300) });
    }

    return res.status(200).json({
      postId, postUrl, postTitle, publishDate, modifiedDate,
      brokenLinksCount: brokenLinks?.length || 0,
      generatedAt: new Date().toISOString(),
      report,
      fromCache: false,
    });

  } catch(e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ error: 'Request timed out — try again' });
    return res.status(200).json({ error: e.message });
  }
}
