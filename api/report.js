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

async function checkVenueStatus(venueName, location) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return { venue: venueName, status: 'unknown', flag: false };
  try {
    const searchRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.businessStatus,places.formattedAddress',
      },
      body: JSON.stringify({ textQuery: `${venueName} ${location}`, maxResultCount: 1 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!searchRes.ok) return { venue: venueName, status: 'unknown', flag: false };
    const data = await searchRes.json();
    const place = data.places?.[0];
    if (!place) return { venue: venueName, status: 'not_found', flag: false };
    const status = place.businessStatus;
    return {
      venue: venueName,
      displayName: place.displayName?.text || venueName,
      address: place.formattedAddress || '',
      status: status === 'CLOSED_PERMANENTLY' ? 'permanently_closed' : status === 'CLOSED_TEMPORARILY' ? 'temporarily_closed' : 'open',
      flag: status === 'CLOSED_PERMANENTLY' || status === 'CLOSED_TEMPORARILY',
    };
  } catch(e) {
    return { venue: venueName, status: 'unknown', flag: false };
  }
}

async function searchCompetitors(postTitle) {
  try {
    const searchQuery = postTitle.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
    const res = await fetch(`https://www.google.com/search?q=${encodeURIComponent(searchQuery + ' 2026')}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlogAuditBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    const html = await res.text();
    const titleMatches = html.match(/<h3[^>]*>([^<]+)<\/h3>/g) || [];
    const titles = titleMatches.slice(0, 5).map(t => t.replace(/<[^>]+>/g, '').trim()).filter(t => t.length > 10);
    return { titles: titles.slice(0, 3) };
  } catch(e) {
    return { titles: [] };
  }
}

function extractInternalLinks(html, siteUrl) {
  const matches = html.match(/href="([^"]+)"/g) || [];
  const domain = siteUrl.replace(/https?:\/\//, '').replace(/www\./, '').split('/')[0];
  const internal = matches
    .map(m => m.replace('href="', '').replace('"', ''))
    .filter(url => url.includes(domain) && !url.includes('#') && url.length > 20)
    .map(url => url.split('?')[0].replace(/\/$/, ''))
    .filter((url, i, arr) => arr.indexOf(url) === i)
    .slice(0, 50);
  return internal;
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

  const cacheKey = `report_v2:${siteUrl}:${postId}`;
  const kv = getRedis();

  if (!forceRefresh && kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached && cached.generatedAt) return res.status(200).json({ ...cached, fromCache: true });
    } catch(e) {}
  }

  try {
    const wpRes = await fetch(
      `${siteUrl}/wp-json/wp/v2/posts/${postId}?_fields=content,title,date,modified`,
      { headers: { 'User-Agent': 'BlogAuditTool/1.0' }, signal: AbortSignal.timeout(15000) }
    );
    if (!wpRes.ok) return res.status(200).json({ error: `Could not fetch post: ${wpRes.status}` });

    const wpData = await wpRes.json();
    const rawHtml = wpData?.content?.rendered || '';

    const existingInternalLinks = extractInternalLinks(rawHtml, siteUrl);

    const content = rawHtml
      .replace(/<h[1-6][^>]*>/gi, '\n## ').replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ').replace(/<p[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n')
      .trim();

    const publishDate = wpData?.date?.split('T')[0] || 'unknown';
    const modifiedDate = wpData?.modified?.split('T')[0] || 'unknown';

    const gscContext = gscData
      ? `GSC: ${gscData.recentClicks||0} clicks (recent 8mo), ${gscData.olderClicks||0} clicks (prior 8mo), ${gscData.trafficDeclinePct||0}% decline, position ${gscData.position?.toFixed(1)||'?'}, ${gscData.recentImpressions||0} impressions`
      : 'No GSC data available';

    const linksContext = brokenLinks?.length > 0
      ? `${brokenLinks.length} potential broken links (NOTE: the link checker has false positives — always verify before flagging as broken):\n${brokenLinks.slice(0,10).map(l=>`- ${l.url} (${l.status||'timeout'})`).join('\n')}`
      : 'No broken links detected';

    const existingLinksContext = existingInternalLinks.length > 0
      ? `\nEXISTING INTERNAL LINKS ALREADY IN THIS POST (do NOT suggest these again):\n${existingInternalLinks.join('\n')}`
      : '';

    const competitorPromise = searchCompetitors(postTitle);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 16000,
        system: `You are an expert travel blog content auditor for Kimmie, a professional travel blogger at adventuresnsunsets.com. Today's date is ${new Date().toLocaleDateString("en-US", {year:"numeric",month:"long",day:"numeric"})}.

ABOUT KIMMIE'S WRITING VOICE:
- First-person, experience-first: "I worked there for 10 summers", "I have never laughed so hard"
- Personality in quick casual injections: "cough cough, Dubrovnik", "VERY worth it"
- Discovery energy — sharing something she found, not lecturing
- Direct practical friend-advice: "Find the booths along the beach", "just don't get too close"
- Occasional light humor, ALL CAPS for emphasis, specific hyper-local details
- Does NOT need a table of contents (already has a plugin)

CRITICAL RULES:

PRICES:
- General price references like "less than $200 a night" or "under $50" are FINE and useful — flag them to verify accuracy, do not remove them
- NEVER invent specific prices — only flag existing ones to verify
- Croatia switched to Euro January 2023 — never suggest HRK prices
- For prices that need checking: editorNote should say "Verify this price is still accurate at [official website]"
- Do NOT suggest removing general price ballparks — they help readers plan

BROKEN LINKS:
- The link checker has a HIGH FALSE POSITIVE RATE — many "broken" links actually work fine
- ALWAYS start the action with: "Check if this link is actually broken first (the link checker is often wrong). If broken, [then what to do]"
- NEVER say "replace with affiliate link" or suggest adding affiliate links — Kimmie handles all affiliate links herself
- For tour/activity links: editorNote should say "If broken, find a replacement on GetYourGuide or Viator"
- For hotel links: always try to find a working link on the SAME OTA first. Only suggest a different OTA if the same one doesn't have a working link. Kimmie uses regular booking links (not affiliate) for hotels
- Do NOT suggest replacing working links

AFFILIATE LINKS:
- Never mention "affiliate link" anywhere in the report — Kimmie manages all affiliate links herself
- For broken tour links: just say "find a replacement on GetYourGuide or Viator" in editorNote — not "affiliate link"
- For broken hotel links: "find a working link on [same OTA]" — no mention of affiliate

VENUE VERIFICATION:
- Extract ALL named venues: restaurants, bars, cafes, clubs, hotels, hostels, attractions, parks, beaches, tour operators
- Up to 10 venues for Google Places verification

YEAR REFERENCES:
- Do NOT suggest adding the current year throughout the post body
- Only suggest year in the title ONCE if relevant for SEO

SUGGESTED TEXT:
- Only suggest text based on what's actually in the post or what Kimmie personally would know
- Never write "verify this is current" or "check before publishing" in suggestedText — those go in editorNote
- Never say "as of [year]" or "currently" or "verified" in suggestedText
- Never write generic "arrive early" or "call ahead" filler
- Write in Kimmie's voice: casual, first-person, discovery energy

INTERNAL LINKS:
- Only suggest internal links to pages NOT already in the post (existing links provided below)
- Suggest them in the order they appear in the post (section by section)
- Format: "Add internal link to your [topic] guide at this mention of [keyword]"

DO NOT SUGGEST:
- Table of contents
- Generic travel tips not grounded in the post
- Affiliate links or replacing links with affiliate versions
- "Verified", "current", "as of [year]" language in suggested text

TWO SEPARATE FIELDS — CRITICAL:
1. suggestedText = ready-to-paste post content in Kimmie's voice ONLY
2. editorNote = tips for the editor/VA: where to verify, which social media to check, whether to remove if closed. NOT post content. This is where "check if link is broken", "verify price at X", "find replacement on GetYourGuide" go.

Return ONLY valid JSON, no markdown fences.`,

        messages: [{
          role: 'user',
          content: `Create a section-by-section update brief for this travel blog post.

Title: "${postTitle}"
URL: ${postUrl}
Published: ${publishDate} | Last modified: ${modifiedDate}
${gscContext}
${linksContext}
${existingLinksContext}

POST CONTENT:
${content}

Return ONLY this JSON:
{
  "summary": "2-3 sentences: what needs updating and why it matters for traffic/readers",
  "estimatedUpdateTime": "15 mins|30 mins|1 hour|2+ hours",
  "location": "city and country this post is about",
  "venueNames": ["every named restaurant", "bar", "cafe", "club", "hotel", "hostel", "attraction", "park", "tour operator — be thorough"],
  "quickReferenceLists": [
    {
      "title": "e.g. Free entry spots, best for sunset",
      "items": ["extracted from post content only"],
      "suggestedPlacement": "where to add this in the post"
    }
  ],
  "sections": [
    {
      "sectionName": "Section heading as it appears in post, or Introduction / Throughout post — list sections IN ORDER they appear in the post",
      "fixes": [
        {
          "type": "broken_link|outdated_price|closed_venue|outdated_date|outdated_info|add_content|seo_fix|internal_link",
          "priority": "critical|high|medium",
          "currentText": "exact short quote from post",
          "action": "specific instruction — for broken links ALWAYS start with 'Check if this link is actually broken first (the checker is often wrong).'",
          "suggestedText": "ONLY ready-to-paste post content in Kimmie's voice. For broken_link: rewrite sentence naturally if needed. For add_content: full paragraph. For seo_fix: exact change. For outdated_price: OMIT. For internal_link: OMIT. Never include 'verified', 'current', 'as of [year]'.",
          "editorNote": "Tips for VA: where to verify, which social media to check, where to find replacement links, whether to remove if closed. For broken tour links: 'If broken, find a replacement on GetYourGuide or Viator'. For hotel links: 'If broken, find a working link on [same OTA]'. For prices: 'Verify this price is still accurate at [official website URL]'. NOT post content."
        }
      ]
    }
  ],
  "topContentGaps": [
    {
      "topic": "specific thing that has likely changed or been added since post was written",
      "whyUrgent": "why this matters for SEO or readers now",
      "suggestedText": "full paragraph in Kimmie's first-person casual voice — specific, not generic, no prices, no 'verified/current' language",
      "placement": "exactly where in the post to add it"
    }
  ],
  "otherContentIdeas": ["specific idea 1", "specific idea 2", "specific idea 3"],
  "seoQuickWins": [
    {
      "idea": "specific actionable SEO change",
      "type": "title|heading|internal_link|schema|table|meta|image",
      "canGenerate": true or false
    }
  ]
}`
        }]
      }),
      signal: AbortSignal.timeout(240000),
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

    const venueNames = report.venueNames || [];
    const location = report.location || '';
    delete report.venueNames;
    delete report.location;

    const [venueResults, competitors] = await Promise.all([
      venueNames.length > 0 && process.env.GOOGLE_PLACES_API_KEY
        ? Promise.allSettled(venueNames.slice(0, 10).map(v => checkVenueStatus(v, location)))
            .then(checks => checks.filter(r => r.status === 'fulfilled').map(r => r.value))
        : Promise.resolve([]),
      competitorPromise,
    ]);

    venueResults.filter(v => v.flag).forEach(v => {
      const sectionIdx = (report.sections || []).findIndex(s =>
        s.fixes?.some(f => f.currentText?.toLowerCase().includes(v.venue.toLowerCase())) ||
        s.sectionName?.toLowerCase().includes(v.venue.toLowerCase())
      );
      const closedFix = {
        type: 'closed_venue',
        priority: 'critical',
        currentText: v.venue,
        action: `❌ CONFIRMED ${v.status === 'permanently_closed' ? 'PERMANENTLY' : 'TEMPORARILY'} CLOSED via Google Maps${v.address ? ' (' + v.address + ')' : ''}`,
        suggestedText: `Remove all mentions of ${v.venue} or replace with somewhere you've personally been in the same area.`,
        editorNote: `Google Maps confirms ${v.status === 'permanently_closed' ? 'permanently' : 'temporarily'} closed. Remove this section or find a replacement you can personally vouch for.`
      };
      if (sectionIdx > -1) {
        report.sections[sectionIdx].fixes.unshift(closedFix);
      } else {
        report.sections = [{ sectionName: v.venue, fixes: [closedFix] }, ...(report.sections || [])];
      }
    });

    const result = {
      postId, postUrl, postTitle, publishDate, modifiedDate,
      brokenLinksCount: brokenLinks?.length || 0,
      venueChecks: venueResults,
      competitors,
      existingInternalLinks,
      generatedAt: new Date().toISOString(),
      report,
      fromCache: false,
    };

    if (kv) {
      try { await kv.set(cacheKey, result, { ex: 2592000 }); } catch(e) {}
    }

    return res.status(200).json(result);

  } catch(e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ error: 'Request timed out — try again' });
    return res.status(200).json({ error: e.message });
  }
}
