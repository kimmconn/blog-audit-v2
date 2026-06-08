// Update Report Generator
// Fetches post content, then uses Claude to analyze it for update opportunities

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
    // Step 1: Fetch post content
    const wpRes = await fetch(
      `${siteUrl}/wp-json/wp/v2/posts/${postId}?_fields=content,title,date,modified`,
      { headers: { 'User-Agent': 'BlogAuditTool/1.0' }, signal: AbortSignal.timeout(15000) }
    );

    if (!wpRes.ok) return res.status(200).json({ error: `Could not fetch post content: ${wpRes.status}` });

    const wpData = await wpRes.json();
    const rawHtml = wpData?.content?.rendered || '';
    
    // Strip HTML tags for Claude, but keep structure
    const content = rawHtml
      .replace(/<h[1-6][^>]*>/gi, '\n## ')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<p[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 8000); // cap at 8k chars to keep prompt manageable

    const publishDate = wpData?.date?.split('T')[0] || 'unknown';
    const modifiedDate = wpData?.modified?.split('T')[0] || 'unknown';

    // Step 2: Build context from GSC data and broken links
    const gscContext = gscData ? `
GSC Traffic Data:
- Recent clicks (last 8 months): ${gscData.recentClicks || 0}
- Older clicks (8-16 months ago): ${gscData.olderClicks || 0}
- Traffic decline: ${gscData.trafficDeclinePct || 0}%
- Average position: ${gscData.position ? gscData.position.toFixed(1) : 'unknown'}
- Impressions (recent): ${gscData.recentImpressions || 0}
` : '';

    const linksContext = brokenLinks && brokenLinks.length > 0 ? `
Potential broken links found (${brokenLinks.length} total):
${brokenLinks.slice(0, 10).map(l => `- ${l.url} (status: ${l.status || 'timeout'})`).join('\n')}
${brokenLinks.length > 10 ? `...and ${brokenLinks.length - 10} more` : ''}
` : '';

    // Step 3: Call Claude API
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: `You are an expert travel blog content auditor. Analyze blog posts and identify specific, actionable update opportunities. Be concrete and specific — mention actual content from the post, not generic advice. Return ONLY valid JSON, no markdown, no preamble.`,
        messages: [{
          role: 'user',
          content: `Analyze this travel blog post and return a JSON update report.

Post title: "${postTitle}"
Post URL: ${postUrl}
Published: ${publishDate}
Last modified: ${modifiedDate}
${gscContext}
${linksContext}

Post content:
${content}

Return this exact JSON structure:
{
  "summary": "2-3 sentence overview of the post's update needs",
  "urgencyReason": "The main reason this post needs updating",
  "outdatedContent": [
    {
      "type": "price|date|venue|event|info|reference",
      "quote": "exact text from post that is likely outdated",
      "issue": "why this is likely outdated",
      "suggestion": "what to update it to or how to verify"
    }
  ],
  "seoOpportunities": [
    {
      "type": "title|meta|keyword|structure|internal_link",
      "issue": "specific SEO issue",
      "suggestion": "specific actionable fix"
    }
  ],
  "contentGaps": [
    {
      "topic": "topic or section missing from this post",
      "reason": "why this would help the post rank better or serve readers better"
    }
  ],
  "quickWins": [
    "specific quick fix #1",
    "specific quick fix #2",
    "specific quick fix #3"
  ],
  "estimatedUpdateTime": "15 mins|30 mins|1 hour|2+ hours"
}`
        }],
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(200).json({ error: `Claude API error: ${claudeRes.status} — ${err.slice(0, 200)}` });
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '{}';
    
    let report;
    try {
      report = JSON.parse(rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    } catch {
      return res.status(200).json({ error: 'Could not parse Claude response', raw: rawText.slice(0, 500) });
    }

    return res.status(200).json({
      postId,
      postUrl,
      postTitle,
      publishDate,
      modifiedDate,
      brokenLinksCount: brokenLinks?.length || 0,
      report,
    });

  } catch (e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ error: 'Request timed out' });
    return res.status(200).json({ error: e.message });
  }
}
