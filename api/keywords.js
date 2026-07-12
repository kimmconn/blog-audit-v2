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
  const { keywords, locationCode = 2840, forceRefresh } = req.body;
  if (!keywords || !keywords.length) return res.status(400).json({ error: 'Missing keywords' });
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return res.status(500).json({ error: 'DataForSEO credentials not configured' });

  const kv = getRedis();
  const volumeMap = {};
  let toFetch = keywords
    .filter(k => k && typeof k === 'string')
    .map(k => k.replace(/[^a-z0-9\s'-]/gi, '').trim())
    .filter(k => k.length > 0 && k.length <= 80 && k.split(/\s+/).length <= 10)
    .filter((k, i, arr) => arr.indexOf(k) === i)
    .slice(0, 500);
  if (!forceRefresh && kv) {
    const cacheChecks = await Promise.allSettled(
      toFetch.map(async kw => ({ kw, cached: await kv.get(`kwvol:${kw.toLowerCase()}`) }))
    );
    const stillNeeded = [];
    cacheChecks.forEach(check => {
      if (check.status === 'fulfilled' && check.value.cached) {
        volumeMap[check.value.kw] = check.value.cached;
      } else if (check.status === 'fulfilled') {
        stillNeeded.push(check.value.kw);
      }
    });
    toFetch = stillNeeded;
  }

  if (toFetch.length === 0) {
    return res.status(200).json({ volumeMap, keywordsChecked: keywords.length, fromCache: keywords.length, fetched: 0 });
  }

  try {
    const credentials = Buffer.from(`${login}:${password}`).toString('base64');
    const response = await fetch(
      'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live',
      {
        method: 'POST',
        headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ keywords: toFetch, location_code: locationCode, language_code: 'en' }]),
        signal: AbortSignal.timeout(30000),
      }
    );
    if (!response.ok) {
      const err = await response.text();
      return res.status(200).json({ error: `DataForSEO error ${response.status}: ${err.slice(0,200)}`, volumeMap });
    }
    const data = await response.json();
    if (data.status_code !== 20000) {
      return res.status(200).json({ error: `DataForSEO: ${data.status_message}`, volumeMap });
    }
const results = data.tasks?.[0]?.result || [];
    const _taskDebug = { taskStatusCode: data.tasks?.[0]?.status_code, taskStatusMessage: data.tasks?.[0]?.status_message, resultCount: results.length };
 results.forEach(item => {
      if (item.keyword) {
        const entry = {
          volume: item.search_volume || 0,
          competition: item.competition,
          cpc: item.cpc,
          trend: item.monthly_searches?.slice(-3).map(m => m.search_volume) || [],
        };
        volumeMap[item.keyword] = entry;
        if (kv) { try { kv.set(`kwvol:${item.keyword.toLowerCase()}`, entry, { ex: 2592000 }); } catch(e) {} }
      }
    });
    toFetch.forEach(kw => {
      if (!volumeMap[kw] && kv) {
        const empty = { volume: 0, competition: null, cpc: null, trend: [] };
        volumeMap[kw] = empty;
        try { kv.set(`kwvol:${kw.toLowerCase()}`, empty, { ex: 2592000 }); } catch(e) {}
      }
    });
    return res.status(200).json({ volumeMap, keywordsChecked: keywords.length, fromCache: keywords.length - toFetch.length, fetched: toFetch.length, _debug: { sentSample: toFetch.slice(0,5), receivedSample: results.slice(0,5).map(r=>r.keyword), taskInfo: _taskDebug } });
  } catch(e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ error: 'Request timed out', volumeMap });
    return res.status(200).json({ error: e.message, volumeMap });
  }
}
