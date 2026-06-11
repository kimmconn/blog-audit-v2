// DataForSEO keyword volume lookup
// Takes keywords from GSC data and returns monthly search volumes

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { keywords, locationCode = 2840 } = req.body; // 2840 = United States
  if (!keywords || !keywords.length) return res.status(400).json({ error: 'Missing keywords' });

  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return res.status(500).json({ error: 'DataForSEO credentials not configured' });

  try {
    const credentials = Buffer.from(`${login}:${password}`).toString('base64');
    
    // Cap at 20 keywords per request to control costs
    const keywordsToCheck = keywords.slice(0, 20);

    const response = await fetch(
      'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live',
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{
          keywords: keywordsToCheck,
          location_code: locationCode,
          language_code: 'en',
        }]),
        signal: AbortSignal.timeout(30000),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return res.status(200).json({ error: `DataForSEO error ${response.status}: ${err.slice(0,200)}` });
    }

    const data = await response.json();
    
    if (data.status_code !== 20000) {
      return res.status(200).json({ error: `DataForSEO: ${data.status_message}` });
    }

    const results = data.tasks?.[0]?.result || [];
    
    // Format results as keyword → volume map
    const volumeMap = {};
    results.forEach(item => {
      if (item.keyword && item.search_volume !== null) {
        volumeMap[item.keyword] = {
          volume: item.search_volume,
          competition: item.competition,
          cpc: item.cpc,
          trend: item.monthly_searches?.slice(-3).map(m => m.search_volume) || [],
        };
      }
    });

    return res.status(200).json({ volumeMap, keywordsChecked: keywordsToCheck.length });

  } catch(e) {
    if (e.name === 'TimeoutError') return res.status(200).json({ error: 'Request timed out' });
    return res.status(200).json({ error: e.message });
  }
}
