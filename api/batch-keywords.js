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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { posts, forceRefresh } = req.body;
  if (!posts || !posts.length) return res.status(400).json({ error: 'Missing posts' });

  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return res.status(500).json({ error: 'DataForSEO credentials not configured' });

  const kv = getRedis();
  const credentials = Buffer.from(`${login}:${password}`).toString('base64');
  const results = {};
  const toFetch = [];
  const allKeywords = new Set();

  for (const post of posts) {
    if (!post.keywords || post.keywords.length === 0) continue;
    const cacheKey = `kw:${post.postId}`;
    if (!forceRefresh && kv) {
      try {
        const cached = await kv.get(cacheKey);
        if (cached && cached.scannedAt && cached.topVolume > 0) {
          results[post.postId] = { ...cached, fromCache: true };
          continue;
        }
      } catch(e) {}
    }
    toFetch.push(post);
    post.keywords.slice(0, 5).forEach(kw => allKeywords.add(kw));
    if (post.titleKeyword) allKeywords.add(post.titleKeyword);
  }

  if (toFetch.length === 0) {
    return res.status(200).json({ results, cached: Object.keys(results).length, fetched: 0 });
  }

  try {
    // Batch keywords into chunks of 200 (DataForSEO works best with smaller batches)
    const allKwArray = [...allKeywords].slice(0, 1000);
    const CHUNK_SIZE = 200;
    const volumeMap = {};

    for (let i = 0; i < allKwArray.length; i += CHUNK_SIZE) {
      const chunk = allKwArray.slice(i, i + CHUNK_SIZE);
      const dfsRes = await fetch(
        'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live',
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([{
            keywords: chunk,
            location_code: 2840,
            language_code: 'en',
          }]),
          signal: AbortSignal.timeout(30000),
        }
      );
      if (!dfsRes.ok) continue;
      const dfsData = await dfsRes.json();
      if (dfsData.status_code !== 20000) continue;
      (dfsData.tasks?.[0]?.result || []).forEach(item => {
        if (item.keyword) volumeMap[item.keyword] = item.search_volume || 0;
      });
    }

    for (const post of toFetch) {
      const kwVolumes = {};
      let topVolume = 0;
      let topKeyword = '';

      // Title keyword gets priority as the primary display keyword
      if (post.titleKeyword) {
        const titleVol = volumeMap[post.titleKeyword] || 0;
        kwVolumes[post.titleKeyword] = titleVol;
        if (titleVol > 0) {
          topVolume = titleVol;
          topKeyword = post.titleKeyword;
        }
      }

      // Also check GSC keywords — if any have higher volume, use that
      (post.keywords || []).slice(0, 5).forEach(kw => {
        const vol = volumeMap[kw] || 0;
        kwVolumes[kw] = vol;
        if (vol > topVolume) { topVolume = vol; topKeyword = kw; }
      });

      const postResult = {
        postId: post.postId,
        topKeyword,
        topVolume,
        keywords: kwVolumes,
        scannedAt: new Date().toISOString(),
        fromCache: false,
      };

      results[post.postId] = postResult;
      if (kv) {
        try { await kv.set(`kw:${post.postId}`, postResult, { ex: 2592000 }); } catch(e) {}
      }
    }

    return res.status(200).json({
      results,
      cached: Object.keys(results).length - toFetch.length,
      fetched: toFetch.length,
      keywordsLookedUp: allKeywords.size,
    });

  } catch(e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ error: 'Timed out', results });
    return res.status(200).json({ error: e.message, results });
  }
}
