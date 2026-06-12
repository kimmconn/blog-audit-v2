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
  // posts = array of { postId, url, keywords: ['kw1','kw2','kw3'] }
  if (!posts || !posts.length) return res.status(400).json({ error: 'Missing posts' });

  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return res.status(500).json({ error: 'DataForSEO credentials not configured' });

  const kv = getRedis();
  const credentials = Buffer.from(`${login}:${password}`).toString('base64');

  // Check cache for each post, only fetch uncached ones
  const results = {};
  const toFetch = []; // { postId, keywords }
  const allKeywords = new Set();

  for (const post of posts) {
    if (!post.keywords || post.keywords.length === 0) continue;
    const cacheKey = `kw:${post.postId}`;
    if (!forceRefresh && kv) {
      try {
        const cached = await kv.get(cacheKey);
        if (cached && cached.scannedAt) {
          results[post.postId] = { ...cached, fromCache: true };
          continue;
        }
      } catch(e) {}
    }
    toFetch.push(post);
    post.keywords.slice(0, 3).forEach(kw => allKeywords.add(kw));
  }

  // If nothing to fetch, return cached results
  if (toFetch.length === 0) {
    return res.status(200).json({ results, cached: Object.keys(results).length, fetched: 0 });
  }

  // Batch all unique keywords into one DataForSEO request (much cheaper)
  const uniqueKeywords = [...allKeywords].slice(0, 1000);
  
  try {
    const dfsRes = await fetch(
      'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live',
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{
          keywords: uniqueKeywords,
          location_code: 2840, // US
          language_code: 'en',
        }]),
        signal: AbortSignal.timeout(30000),
      }
    );

    if (!dfsRes.ok) {
      return res.status(200).json({ error: `DataForSEO error ${dfsRes.status}`, results });
    }

    const dfsData = await dfsRes.json();
    if (dfsData.status_code !== 20000) {
      return res.status(200).json({ error: `DataForSEO: ${dfsData.status_message}`, results });
    }

    // Build volume lookup map
    const volumeMap = {};
    (dfsData.tasks?.[0]?.result || []).forEach(item => {
      if (item.keyword) volumeMap[item.keyword] = item.search_volume || 0;
    });

    // Map volumes back to posts and cache
    for (const post of toFetch) {
      const kwVolumes = {};
      let topVolume = 0;
      let topKeyword = '';

      post.keywords.slice(0, 3).forEach(kw => {
        const vol = volumeMap[kw] || 0;
        kwVolumes[kw] = vol;
        if (vol > topVolume) {
          topVolume = vol;
          topKeyword = kw;
        }
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

      // Cache per post
      if (kv) {
        try {
          await kv.set(`kw:${post.postId}`, postResult, { ex: 2592000 });
        } catch(e) {}
      }
    }

    return res.status(200).json({
      results,
      cached: Object.keys(results).length - toFetch.length,
      fetched: toFetch.length,
      keywordsLookedUp: uniqueKeywords.length,
    });

  } catch(e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ error: 'Timed out', results });
    return res.status(200).json({ error: e.message, results });
  }
}
