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
const { data: profile } = await supabase.from('profiles').select('reports_this_month, reports_month, tier, report_limit_override').eq('id', userId).single();
let reportsUsed = profile?.reports_this_month || 0;
if (profile?.reports_month !== currentMonth) reportsUsed = 0;
const reportLimit = profile?.report_limit_override || 12;
if (profile?.tier !== 'owner' && reportsUsed >= reportLimit) {
  return res.status(200).json({ error: `You've hit your ${reportLimit} reports this month limit. It resets next month!` });
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
      ? `\nTOP GSC KEYWORDS FOR THIS POST (by impressions, last 6 months):\n${gscKeywords.slice(0,10).map((k,i) => `${i+1}. "${k.keyword}" - ${k.impressions} impressions, ${k.clicks} clicks${k.volume?`, ${k.volume} monthly searches`:''}`).join('\n')}\nNaturally weave these keywords into your update where relevant, favoring higher search volume ones when there's a natural fit.`
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
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const wordCountContext = `\nPOST WORD COUNT: ~${wordCount} words.`;
    const competitors = await searchCompetitors(postTitle);
    const competitorContext = competitors.titles?.length > 0
      ? `\nTOP COMPETING RESULTS CURRENTLY RANKING FOR THIS TOPIC (from a live search, titles only):\n${competitors.titles.map((t,i) => `${i+1}. ${t}`).join('\n')}\nUse these to help ground your content gap suggestions - what do these competing posts likely cover that this post doesn't?`
      : '';
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
- The link checker has a HIGH FALSE POSITIVE RATE, but do NOT repeat that caveat in every fix — the brief shows one disclaimer once, automatically, above the first broken link
- Action should be direct and short: just say what to do if the link turns out to be broken. Do NOT start with "check if this is actually broken first" — skip straight to the fix
- KNOWN BOT-BLOCKING DOMAINS: tripadvisor.com, yelp.com, facebook.com, instagram.com, linkedin.com, pinterest.com. These sites block automated link checkers and routinely show as "broken" even when the link works fine for a real visitor. For a broken_link fix on one of these domains, set "lowConfidence": true and keep the action to: "Open in an incognito browser to confirm — [domain] often blocks automated checks."
- For all other broken_link fixes, "lowConfidence": false (or omit)
- NEVER say "replace with affiliate link" — the blog owner handles all affiliate links themselves
- For tour/activity links: editorNote says "If broken, find a replacement on GetYourGuide or Viator"
- For hotel links: find working link on SAME OTA first
AFFILIATE LINKS: Never mention "affiliate link" anywhere
AFFILIATE DISCLOSURES: Never suggest relocating, removing, or altering the placement of affiliate/sponsorship disclosures. Disclosure compliance is entirely outside this tool's scope — don't comment on it in any way.
VENUE VERIFICATION:
- Extract ALL named venues: restaurants, bars, cafes, clubs, hotels, hostels, attractions, parks, beaches, tour operators
- Up to 10 venues for Google Places verification
IMAGE ALT TEXT:
- ONLY flag images that are actually missing alt text (filenames provided in context)
- If context says "All images appear to have alt text" — do NOT suggest alt text optimization at all
- If images ARE missing alt text, add a missing_alt_text fix in the SECTION where that image appears in the post
- Suggest descriptive alt text based on the surrounding post content (what the image likely shows)
- Place these fixes in section order alongside other fixes for that section — not all bunched together
NEW IMAGES:
- Separately from alt text, always suggest at least one specific NEW image to add (not a fix to an existing one) via seoQuickWins with type "image" — describe what the image should show and roughly where it goes. Always phrase this as adding a new image, never replacing an existing one. This is one of the highest-impact updates a post can get.
CLARITY & STRUCTURE:
- While reading through the post, flag vague phrasing, superfluous content, and confusing sentence construction:
  - Vague: a generic descriptor where a specific one (a name, price, distance, number) is knowable but missing. Example: "responds quickly for a while" should be "responds consistently, with stable response times."
  - Superfluous: a sentence that could be deleted without losing any information or decision-usefulness for the reader.
  - Confusing structure: a sentence crams in unrelated ideas or unclear references, forcing a re-read. Example: "there are limits to how much time Google's crawlers can spend crawling any single site, where a site is defined by the hostname" should be split into "there are limits to how much time and resources Google can devote to crawling any single site."
  - When you replace vague phrasing with something "specific," it needs to actually be specific — a single figure or a narrow, meaningful range. A broad range spanning many units (e.g. "8-18°C") is barely more useful than the vague version it replaced and should not be flagged as a fix.
- Only flag issues you're confident would meaningfully help the reader if fixed — if in doubt, don't flag it. Precision over recall.
- Add these as fixes in the correct section, using type "vague_content", "superfluous_content", or "confusing_structure" — same currentText/action/suggestedText/editorNote format as other fixes
- Cap it: include at most the 3-5 most impactful clarity fixes total across the whole post, even if there are more you could flag
KEYWORD STUFFING (already in the post):
- While reading, watch for old-school keyword stuffing already baked into the existing content: the same keyword or an obvious variation of it repeated so often it reads unnatural or robotic. This is NOT about simple topical repetition — real writing naturally repeats its subject. The telltale pattern is circular restatement, where a sentence just repeats the keyword back at itself instead of adding information. Two real examples of what TO catch:
  - "These Ohio treehouse rentals are some of the best tree cabins in Ohio because the people who love Ohio treehouses love booking treehouse cabins in Ohio."
  - A heading reading "The Maritime Museum, a unique thing to do in Santa Barbara," immediately followed by "The Maritime Museum is one of the most fun things to do in Santa Barbara because other Santa Barbara activities don't involve boats."
- Concretely: flag it when 3 or more variations of the same keyword/topic phrase appear within any 4-sentence window and the repeats add no new information. This can happen anywhere in a paragraph, not only right after a heading.
- Do NOT flag normal repetition of a place or venue name — only flag when it reads like it's performing for a search engine rather than talking to a reader.
- Add as a fix with type "keyword_stuffing", same currentText/action/suggestedText/editorNote format as other fixes. suggestedText should keep one clean mention and cut the rest, replacing the padding with a real detail instead.
- Cap at 3 per report, only the clearest, most confident instances. Precision over recall.
GENERIC / IMPERSONAL VOICE:
- Flag sections that read like generic travel-guide copy: no "I/my/we," no specific sensory or anecdotal detail, no opinion — just facts anyone could pull off the venue's own website, interchangeable with a thousand other posts on the same place.
- This is a judgment call about density in context, not a banned-word list. A single "hidden gem" or "must-visit" inside an otherwise specific, firsthand paragraph is fine — do not flag individual stock phrases on their own. Only flag when a whole section leans on this kind of generic language AND has zero firsthand markers.
- Add as a fix with type "generic_voice". suggestedText should keep the factual content but reframe it with an actual firsthand-sounding detail, reaction, or small anecdote — the goal is sounding like the blogger was really there, not just avoiding certain words.
- Cap at 3-5 per report, only the clearest instances. Precision over recall.
PERSONAL EXPERIENCE OPPORTUNITIES:
- Separate from GENERIC / IMPERSONAL VOICE above (which flags writing that's already bad), proactively look for good SPOTS where inviting the blogger to add a personal, firsthand detail would make an already-fine section noticeably better - even when nothing is wrong with the current text.
- Frame it as an invitation to the blogger, never as a criticism or a fix to something broken. Example tone: "Do you have a specific memory from visiting Trinket, something you noticed or a moment that stuck with you? A line like that would make this section stand out." Address the blogger directly, as a question.
- Good candidates: a venue or section described only in facts (hours, location, what it offers) where a specific memory, sensory detail, personal tip, or reaction from an actual visit would add real value; a listicle entry that's accurate but could use one line of "why I picked this one" or "what surprised me when I went."
- Add as a fix with type "personal_experience". Leave suggestedText empty for this type - you don't have the blogger's real experience to invent, so don't write fake anecdotes. The "action" field carries the inviting question itself.
- Default priority to "medium" unless the whole section is one of the thinnest, most fact-only parts of the post.
- Cap at 3-5 per report - pick the spots where a personal detail would add the most value, not every section.
THIN CONTENT (whole post only, separate from the per-section fixes above):
- Assess whether the ENTIRE post is thin per Google's own definition: content that provides little or no added value to a reader — auto-generated-feeling filler, listicle entries that are each one bland interchangeable sentence with no unique detail, or a post that reads like hundreds of others on the same topic with nothing original added.
- This is a whole-post judgment, not a per-section one. Most posts have a few short or generic-feeling spots and that's normal — do NOT flag a post just because one section is thin. Only flag if the post AS A WHOLE genuinely reads this way.
- Set the top-level "thinContent" field accordingly. Default to isThin:false unless you're genuinely confident — this should be rare, most posts should not trigger it.
REFRESH DEPTH:
- Data shows refreshes need to change more than 10% of a post's word count to meaningfully move traffic — light tweaks alone tend not to. As the final sentence of "summary", honestly note whether the fixes you're suggesting add up to a meaningful refresh for a post this length, or whether it's a lighter touch-up — and if it's light, name one additional section that could use deeper attention.
NEW THINGS TO ADD:
- For each post, think about what types of venues, experiences, or content have likely opened or become popular since the post was last updated
- Ground this specifically in the actual gap between the post's last-updated date and today (both are provided below) — not a generic "things change over time" narrative
- Do NOT default to "post-pandemic" or "pandemic recovery" as the explanation for what's changed. That framing is stale and overused. Only reference the pandemic at all if the post was last meaningfully updated before 2022. For posts updated 2022 or later, reason about what's actually new or different in that specific window (new openings, closures, trends, price shifts, changed logistics) — not COVID-era recovery
- Suggest specific search strategies for the editor to find new things to add (e.g. "Search Google Maps for [location] + [category] and filter by 'Opened after [year]'")
- This is one of the most valuable parts of the report, but only if the suggestions are genuinely specific to this destination and this gap in time — 1-2 sharp, well-grounded newThingsToAdd items beat 3 generic ones. Don't pad to hit a count.
- If competing result titles are provided below, ground topContentGaps in what those competing posts likely cover that this one doesn't — mention the angle, not the competitor by name. If no competitor titles are provided, rely on your own knowledge of the destination and topic instead.
YEAR REFERENCES: Only suggest adding a year to the title if it would genuinely help THIS specific post — ranked/best-of lists, pricing or cost guides, or content about what's currently open or trending, where readers actively want the newest version. Skip it for evergreen itineraries, personal narratives, and how-to/step-by-step guides where the content isn't year-bound — most posts should NOT get this suggestion. If you do suggest it: title only, never throughout the post body, and only once.
GLOBAL STYLE RULE: No em dashes (—) anywhere in ANY generated text in this response — not in summary, action, editorNote, whyRelevant, suggestedText, or anywhere else. Use a comma, period, or a regular hyphen (-) instead. This applies everywhere, not just suggestedText.
SUGGESTED TEXT: Match the blog's existing voice, based on the post content provided. No "verify", "current", "as of [year]". No generic filler. When adding a concrete detail (temperature, price, distance, timing, etc.), give a real specific value or a narrow, genuinely useful range — never a broad range spanning many units that conveys almost nothing (e.g. an 8-18°C range). If you don't actually know a specific value from the post or context, leave it out rather than inventing a wide range to sound specific.
DO NOT SUGGEST: Table of contents, internal links, affiliate links, alt text if all images have it
TWO SEPARATE FIELDS:
1. suggestedText = ready-to-paste post content in the blog owner's own first-person voice ONLY
2. editorNote = tips for VA only. NOT post content.
Return ONLY valid JSON, no markdown fences.`,
        messages: [{
          role: 'user',
          content: `Create a section-by-section update brief for this travel blog post.
Title: "${postTitle}"
URL: ${postUrl}
Published: ${publishDate} | Last modified: ${modifiedDate}
${gscContext}
${wordCountContext}
${topKeywordsContext}
${competitorContext}
${linksContext}
${altTextContext}
${existingLinksContext}
POST CONTENT:
${content}
Return ONLY this JSON:
{
  "summary": "2-3 sentences: what needs updating and why it matters for traffic/readers, ending with the refresh-depth note described above",
  "thinContent": {"isThin": true or false, "reason": "one sentence, only if isThin is true, per the whole-post THIN CONTENT rule above"},
  "estimatedUpdateTime": "15 mins|30 mins|1 hour|2+ hours",
  "location": "city and country this post is about",
  "venueNames": ["every named restaurant", "bar", "cafe", "club", "hotel", "hostel", "attraction", "park", "tour operator"],
  "newThingsToAdd": [
    {
      "category": "restaurant|bar|attraction|experience|neighbourhood|event",
      "suggestion": "specific research task, e.g. 'Search Google Maps for [location] [category] filtered by opened after [year] to find new additions worth mentioning'",
      "whyRelevant": "why readers today would want this info"
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
          "type": "broken_link|outdated_price|closed_venue|outdated_date|outdated_info|add_content|seo_fix|missing_alt_text|vague_content|superfluous_content|confusing_structure|keyword_stuffing|generic_voice|personal_experience",
          "priority": "critical|high|medium",
          "lowConfidence": true or false — true ONLY for broken_link fixes on known bot-blocking domains (tripadvisor.com, yelp.com, facebook.com, instagram.com, linkedin.com, pinterest.com), otherwise false,
          "currentText": "exact short quote",
          "action": "specific instruction — for broken links, state directly what to do if it's broken, no preamble about checking first",
          "suggestedText": "ready-to-paste post content in the blog owner's own voice OR omit if not applicable",
          "editorNote": "tips for VA only — verification sources, replacement links, etc. NOT post content"
        }
      ]
    }
  ],
  "topContentGaps": [
    {
      "topic": "specific thing that has likely changed or been added since post was written",
      "whyUrgent": "why this matters for SEO or readers now",
      "suggestedText": "full paragraph in the blog owner's own voice — specific, casual, first-person, no prices",
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
    const venueResults = venueNames.length > 0 && process.env.GOOGLE_PLACES_API_KEY
      ? await Promise.allSettled(venueNames.slice(0, 10).map(v => checkVenueStatus(v, location)))
          .then(checks => checks.filter(r => r.status === 'fulfilled').map(r => r.value))
      : [];
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
