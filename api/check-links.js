import { Redis } from '@upstash/redis';

let redis;
function getRedis() {
  if (!redis) {
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

  const { postUrl, postId, siteUrl, forceRefresh } = req.body;
  if (!postUrl) return res.status(400).json({ error: 'Missing postUrl' });

  const cacheKey = `links:${siteUrl}:${postId}`;
  const kv = getRedis();

  // Check cache first
  if (!forceRefresh && kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) return res.status(200).json({ ...cached, fromCache: true });
    } catch(e) {}
  }

  try {
    const apiUrl = `${siteUrl}/wp-json/wp/v2/posts/${postId}?_fields=content`;
    const postRes = await fetch(apiUrl, {
      headers: { 'User-Agent': 'BlogAuditTool/1.0' },
      signal: AbortSignal.timeout(15000),
    });

    if (!postRes.ok) {
      return res.status(200).json({ postUrl, brokenLinks: [], totalLinks: 0, brokenCount: 0, error: `Could not fetch post: ${postRes.status}` });
    }

    const postData = await postRes.json();
    const html = postData?.content?.rendered || '';

    const linkRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
    const allLinks = [];
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const url = match[1];
      try {
        const siteHostname = new URL(siteUrl).hostname;
        const linkHostname = new URL(url).hostname;
        if (linkHostname === siteHostname) continue;
        if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|mp3)$/i.test(url)) continue;
      } catch { continue; }
      if (!allLinks.includes(url)) allLinks.push(url);
    }

    const linksToCheck = allLinks.slice(0, 50);
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

    const output = {
      postUrl,
      postId,
      totalLinks: linksToCheck.length,
      brokenCount: brokenLinks.length,
      brokenLinks,
      scannedAt: new Date().toISOString(),
      fromCache: false,
    };

    // Save to cache with 30 day TTL — same pattern as batch-scan.js
    if (kv) {
      try {
        await kv.set(cacheKey, output, { ex: 2592000 });
      } catch(e) {
        output.cacheError = e.message;
      }
    }

    return res.status(200).json(output);

  } catch (e) {
    return res.status(200).json({ postUrl, brokenLinks: [], totalLinks: 0, brokenCount: 0, error: e.message });
  }
}
