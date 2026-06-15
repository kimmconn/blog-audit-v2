import { Redis } from '@upstash/redis';

let redis;
function getRedis() {
  if (!redis) {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (url && token) redis = new Redis({ url, token });
  }
  return redis;
}

// Check venue status using Google Places API (New)
async function checkVenueStatus(venueName, location) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return { venue: venueName, status: 'unknown', flag: false };

  try {
    // Text search for the venue
    const query = `${venueName} ${location}`;
    const searchRes = await fetch(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.displayName,places.businessStatus,places.formattedAddress',
        },
        body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!searchRes.ok) {
      return { venue: venueName, status: 'unknown', flag: false };
    }

    const data = await searchRes.json();
    const place = data.places?.[0];

    if (!place) {
      return { venue: venueName, status: 'not_found', flag: false };
    }

    const status = place.businessStatus;
    const isClosed = status === 'CLOSED_PERMANENTLY';
    const isTemporary = status === 'CLOSED_TEMPORARILY';

    return {
      venue: venueName,
      displayName: place.displayName?.text || venueName,
      address: place.formattedAddress || '',
      status: isClosed ? 'permanently_closed' : isTemporary ? 'temporarily_closed' : 'open',
      businessStatus: status,
      flag: isClosed || isTemporary,
    };
  } catch(e) {
    return { venue: venueName, status: 'unknown', flag: false, error: e.message };
  }
}

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
  const kv = getRedis();

  // Check cache first
  if (!forceRefresh && kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached && cached.generatedAt) return res.status(200).json({ ...cached, fromCache: true });
    } catch(e) {}
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

    const gscContext = gscData
      ? `GSC: ${gscData.recentClicks||0} clicks (recent 8mo), ${gscData.olderClicks||0} clicks (prior 8mo), ${gscData.trafficDeclinePct||0}% decline, position ${gscData.position?.toFixed(1)||'?'}, ${gscData.recentImpressions||0} impressions`
      : 'No GSC data available';

    const linksContext = brokenLinks?.length > 0
      ? `${brokenLinks.length} potential broken links:\n${brokenLinks.slice(0,8).map(l=>`- ${l.url} (${l.status||'timeout'})`).join('\n')}`
      : 'No broken links detected';

    // Step 1: Extract venue names with Haiku
    const venueExtractRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: 'Extract venue names and location from travel blog content. Return ONLY valid JSON.',
        messages: [{
          role: 'user',
          content: `Extract up to 8 specific named venues (hotels, restaurants, cafes, bars, attractions) from this post, and the main destination/city.

Title: "${postTitle}"
Content: ${content}

Return ONLY: {"venues": ["venue name 1", "venue name 2"], "location": "city, country"}`
        }]
      }),
      signal: AbortSignal.timeout(15000),
    });

    let venueNames = [];
    let location = '';
    if (venueExtractRes.ok) {
      const venueData = await venueExtractRes.json();
      try {
        const parsed = JSON.parse(venueData.content?.[0]?.text || '{}');
        venueNames = parsed.venues || [];
        location = parsed.location || '';
      } catch(e) {}
    }

    // Step 2: Check venues via Google Places API
    const venueResults = [];
    if (venueNames.length > 0 && process.env.GOOGLE_PLACES_API_KEY) {
      const venuesToCheck = venueNames.slice(0, 6);
      const checks = await Promise.allSettled(
        venuesToCheck.map(v => checkVenueStatus(v, location))
      );
      checks.forEach(r => {
        if (r.status === 'fulfilled') venueResults.push(r.value);
      });
    }

    const venueContext = venueResults.length > 0
      ? `Venue verification results:\n${venueResults.map(v => {
          if (v.status === 'permanently_closed') return `- ${v.venue}: ❌ PERMANENTLY CLOSED`;
          if (v.status === 'temporarily_closed') return `- ${v.venue}: ⚠️ TEMPORARILY CLOSED`;
          if (v.status === 'not_found') return `- ${v.venue}: ❓ NOT FOUND on Google Maps`;
          return `- ${v.venue}: ✅ open`;
        }).join('\n')}`
      : '';

    // Step 3: Full Claude report
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2500,
        system: `You are an expert travel blog content auditor. Today's date is ${new Date().toLocaleDateString("en-US", {year:"numeric",month:"long",day:"numeric"})}. Always use the current year when making suggestions. Be specific — quote actual text from the post when flagging issues. Return ONLY valid JSON, no markdown fences.`,
        messages: [{
          role: 'user',
          content: `Audit this travel blog post for update opportunities.

Title: "${postTitle}"
URL: ${postUrl}
Published: ${publishDate} | Last modified: ${modifiedDate}
${gscContext}
${linksContext}
${venueContext}

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
- Business hours presented as definitive
- Affiliate or booking links that may have changed
- Safety warnings that may be outdated
- Any venues marked as PERMANENTLY CLOSED or NOT FOUND above

Return ONLY this JSON:
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

    const result = {
      postId, postUrl, postTitle, publishDate, modifiedDate,
      brokenLinksCount: brokenLinks?.length || 0,
      venueChecks: venueResults,
      _venueDebug: {
        extractedVenues: venueNames,
        location,
        placesApiKeyPresent: !!process.env.GOOGLE_PLACES_API_KEY,
        venueResultsRaw: venueResults,
      },
      generatedAt: new Date().toISOString(),
      report,
      fromCache: false,
    };

    if (kv) {
      try {
        await kv.set(cacheKey, result, { ex: 2592000 });
      } catch(e) {}
    }

    return res.status(200).json(result);

  } catch(e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ error: 'Request timed out — try again' });
    return res.status(200).json({ error: e.message });
  }
}
