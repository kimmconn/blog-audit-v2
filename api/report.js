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

function extractImagesWithoutAlt(html) {
  const imgMatches = html.match(/<img[^>]+>/gi) || [];
  const missing = [];
  imgMatches.forEach(img => {
    const altMatch = img.match(/alt="([^"]*)"/i);
    const srcMatch = img.match(/src="([^"]+)"/i);
    if (!altMatch || altMatch[1].trim() === '') {
      const src = srcMatch ? srcMatch[1] : 'unknown';
      const filename = src.split('/').pop().split('?')[0];
      missing.push(filename);
    }
  });
  return missing.slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

const { postId, postUrl, postTitle, siteUrl, gscData, brokenLinks, gscKeywords, forceRefresh, userId } = req.body;
if (!postId || !siteUrl) return res.status(400).json({ error: 'Missing postId or siteUrl' });
if (!userId) return res.status(400).json({ error: 'Missing userId' });

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const currentMonth = new Date().toISOString().slice(0, 7);
const { data: profile } = await supabase.from('profiles').select('reports_this_month, reports_month, tier').eq('id', userId).single();

let reportsUsed = profile?.reports_this_month || 0;
if (profile?.reports_month !== currentMonth) reportsUsed = 0;

if (profile?.tier !== 'owner' && reportsUsed >= 25) {
  return res.status(200).json({ error: "You've hit your 25 reports this month limit. It resets next month!" });
}

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
    const imagesWithoutAlt = extractImagesWithoutAlt(rawHtml);

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

    const topKeywordsContext = gscKeywords?.length > 0
      ? `\nTOP GSC KEYWORDS FOR THIS POST (by impressions, last 6 months):\n${gscKeywords.slice(0,10).map((k,i) => `${i+1}. "${k.keyword}" — ${k.impressions} impressions, ${k.clicks} clicks`).join('\n')}\nNaturally weave these keywords into your update where relevant.`
      : '';

    const linksContext = brokenLinks?.length > 0
      ? `${brokenLinks.length} potential broken links (NOTE: the link checker has false positives — always verify before flagging as broken):\n${brokenLinks.slice(0,10).map(l=>`- ${l.url} (${l.status||'timeout'})`).join('\n')}`
      : 'No broken links detected';

    const altTextContext = imagesWithoutAlt.length > 0
      ? `\nIMAGES MISSING ALT TEXT (${imagesWithoutAlt.length} found): ${imagesWithoutAlt.join(', ')}`
      : '\nAll images appear to have alt text — do NOT suggest image alt text optimization.';

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
    system: `You are an expert travel blog content auditor. Today's date is ${new Date().toLocaleDateString("en-US", {year:"numeric",month:"long",day:"numeric"})}.

WRITING VOICE (match the blog's existing tone from the post content provided):
- First-person, experience-first, conversational
- Discovery energy — sharing something found, not lecturing
- Direct, practical, friend-to-friend advice
- Occasional light humor and personality where it fits naturally
- Does NOT need a table of contents unless the post structure suggests otherwise

CRITICAL RULES:

PRICES:
- General price references like "less than $200 a night" or "under $50" are FINE — flag to verify, do not remove
- NEVER invent specific prices — only flag existing ones to verify
- Croatia switched to Euro January 2023 — never suggest HRK prices
- For prices that need checking: editorNote should say "Verify this price is still accurate at [official website]"

BROKEN LINKS:
- The link checker has a HIGH FALSE POSITIVE RATE
- ALWAYS start the action with: "Check if this link is actually broken first (the checker is often wrong). If broken, [then what to do]"
- NEVER say "replace with affiliate link" — Kimmie handles all affiliate links herself
- For tour/activity links: editorNote says "If broken, find a replacement on GetYourGuide or Viator"
- For hotel links: find working link on SAME OTA first

AFFILIATE LINKS: Never mention "affiliate link" anywhere

VENUE VERIFICATION:
- Extract ALL named venues: restaurants, bars, cafes, clubs, hotels, hostels, attractions, parks, beaches, tour operators
- Up to 10 venues for Google Places verification

IMAGE ALT TEXT:
- ONLY flag images that are actually missing alt text (filenames provided in context)
- If context says "All images appear to have alt text" — do NOT suggest alt text optimization at all
- If images ARE missing alt text, add a missing_alt_text fix in the SECTION where that image appears in the post
- Suggest descriptive alt text based on the surrounding post content (what the image likely shows)
- Place these fixes in section order alongside other fixes for that section — not all bunched together

NEW THINGS TO ADD:
- For each post, think about what types of venues, experiences, or content have likely opened or become popular since the post was last updated
- Suggest specific search strategies for the editor to find new things to add (e.g. "Search Google Maps for [location] + [category] and filter by 'Opened after [year]'")
- This is one of the most valuable parts of the report — always include at least 2-3 newThingsToAdd items

YEAR REFERENCES: Do NOT suggest adding year throughout post body. Title only, once.

SUGGESTED TEXT: Kimmie's voice only. No "verify", "current", "as of [year]". No generic filler.

DO NOT SUGGEST: Table of contents, internal links, affiliate links, alt text if all images have it

TWO SEPARATE FIELDS:
1. suggestedText = ready-to-paste post content in Kimmie's voice ONLY
2. editorNote = tips for VA only. NOT post content.

Return ONLY valid JSON, no markdown fences.`,

        messages: [{
          role: 'user',
          content: `Create a section-by-section update brief for this travel blog post.

Title: "${postTitle}"
URL: ${postUrl}
Published: ${publishDate} | Last modified: ${modifiedDate}
${gscContext}
${topKeywordsContext}
${linksContext}
${altTextContext}
${existingLinksContext}

POST CONTENT:
${content}

Return ONLY this JSON:
{
  "summary": "2-3 sentences: what needs updating and why it matters for traffic/readers",
  "estimatedUpdateTime": "15 mins|30 mins|1 hour|2+ hours",
  "location": "city and country this post is about",
  "venueNames": ["every named restaurant", "bar", "cafe", "club", "hotel", "hostel", "attraction", "park", "tour operator"],
  "newThingsToAdd": [
    {
      "category": "restaurant|bar|attraction|experience|neighbourhood|event",
      "suggestion": "specific research task, e.g. 'Search Google Maps for [location] [category] filtered by opened after [year] to find new additions worth mentioning'",
      "whyRelevant": "why readers in 2026 would want this info"
    }
  ],
  "quickReferenceLists": [
    {
      "title": "descriptive title",
      "items": ["extracted from post content only"],
      "suggestedPlacement": "where to add this"
    }
  ],
  "sections": [
    {
      "sectionName": "Section heading IN ORDER as it appears in post",
      "fixes": [
        {
          "type": "broken_link|outdated_price|closed_venue|outdated_date|outdated_info|add_content|seo_fix|missing_alt_text",
          "priority": "critical|high|medium",
          "currentText": "exact short quote",
          "action": "specific instruction — broken links ALWAYS start with 'Check if this link is actually broken first (the checker is often wrong).'",
          "suggestedText": "ready-to-paste post content in Kimmie's voice OR omit if not applicable",
          "editorNote": "tips for VA only — verification sources, replacement links, etc. NOT post content"
        }
      ]
    }
  ],
  "topContentGaps": [
    {
      "topic": "specific thing that has likely changed or been added since post was written",
      "whyUrgent": "why this matters for SEO or readers now",
      "suggestedText": "full paragraph in Kimmie's voice — specific, casual, first-person, no prices",
      "placement": "exactly where in the post to add it"
    }
  ],
  "otherContentIdeas": ["specific idea 1", "specific idea 2", "specific idea 3"],
  "seoQuickWins": [
    {
      "idea": "specific actionable SEO change",
      "type": "title|heading|schema|table|meta|image",
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
        editorNote: `Google Maps confirms ${v.status === 'permanently_closed' ? 'permanently' : 'temporarily'} closed. Remove or find a replacement you can personally vouch for.`
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
      imagesWithoutAlt,
      generatedAt: new Date().toISOString(),
      report,
      fromCache: false,
    };

if (kv) {
      try { await kv.set(cacheKey, result, { ex: 2592000 }); } catch(e) {}
    }

    if (profile?.tier !== 'owner') {
      await supabase.from('profiles').update({ reports_this_month: reportsUsed + 1, reports_month: currentMonth }).eq('id', userId);
    }

    return res.status(200).json(result);

  } catch(e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ error: 'Request timed out — try again' });
    return res.status(200).json({ error: e.message });
  }
}
