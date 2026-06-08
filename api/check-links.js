// Broken link scanner
// Accepts a WordPress post URL, fetches its content, extracts all outbound links,
// checks each one for 4xx/5xx responses, returns broken ones

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { postUrl, postId, siteUrl } = req.body;
  if (!postUrl) return res.status(400).json({ error: 'Missing postUrl' });

  try {
    // Step 1: Fetch post content via WordPress REST API
    const apiUrl = `${siteUrl}/wp-json/wp/v2/posts/${postId}?_fields=content`;
    const postRes = await fetch(apiUrl, {
      headers: { 'User-Agent': 'BlogAuditTool/1.0' },
      signal: AbortSignal.timeout(15000),
    });

    if (!postRes.ok) {
      return res.status(200).json({ postUrl, brokenLinks: [], totalLinks: 0, error: `Could not fetch post content: ${postRes.status}` });
    }

    const postData = await postRes.json();
    const html = postData?.content?.rendered || '';

    // Step 2: Extract all outbound links
    const linkRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
    const allLinks = [];
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const url = match[1];
      // Skip internal links, images, and anchors
      const siteHostname = new URL(siteUrl).hostname;
      try {
        const linkHostname = new URL(url).hostname;
        if (linkHostname === siteHostname) continue; // skip internal
        if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|mp3)$/i.test(url)) continue; // skip media
      } catch { continue; }
      if (!allLinks.includes(url)) allLinks.push(url);
    }

    // Cap at 50 links per post to avoid timeouts
    const linksToCheck = allLinks.slice(0, 50);

    // Step 3: Check each link in parallel batches of 10
    const brokenLinks = [];
    const batchSize = 10;
    
    for (let i = 0; i < linksToCheck.length; i += batchSize) {
      const batch = linksToCheck.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (url) => {
          try {
            const r = await fetch(url, {
              method: 'HEAD',
              signal: AbortSignal.timeout(8000),
              headers: { 'User-Agent': 'Mozilla/5.0 BlogAuditTool/1.0' },
              redirect: 'follow',
            });
            // If HEAD not allowed, try GET
            if (r.status === 405) {
              const r2 = await fetch(url, {
                method: 'GET',
                signal: AbortSignal.timeout(8000),
                headers: { 'User-Agent': 'Mozilla/5.0 BlogAuditTool/1.0' },
                redirect: 'follow',
              });
              return { url, status: r2.status, ok: r2.ok };
            }
            return { url, status: r.status, ok: r.ok };
          } catch (e) {
            return { url, status: 0, ok: false, error: e.message };
          }
        })
      );
      results.forEach(r => {
        if (r.status === 'fulfilled' && !r.value.ok) {
          brokenLinks.push({ url: r.value.url, status: r.value.status, error: r.value.error });
        }
      });
    }

    return res.status(200).json({
      postUrl,
      postId,
      totalLinks: linksToCheck.length,
      brokenCount: brokenLinks.length,
      brokenLinks,
    });

  } catch (e) {
    return res.status(200).json({ postUrl, brokenLinks: [], totalLinks: 0, error: e.message });
  }
}
