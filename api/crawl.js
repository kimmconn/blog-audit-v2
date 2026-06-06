export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { siteUrl, page = 1, perPage = 100 } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
  const cleanUrl = siteUrl.replace(/\/$/, '');
  const buildUrl = (base) => `${base}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&_fields=id,title,link,date,modified,categories,slug`;
  const urls = [cleanUrl, cleanUrl.includes('://www.') ? cleanUrl.replace('://www.','://') : cleanUrl.replace('://','://www.')];
  let lastError = null;
  for (const base of urls) {
    try {
      const r = await fetch(buildUrl(base), { headers: { 'User-Agent': 'BlogAuditTool/1.0' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) { lastError = `HTTP ${r.status}`; continue; }
      const posts = await r.json();
      const total = r.headers.get('X-WP-Total');
      const pages = r.headers.get('X-WP-TotalPages');
      if (total) res.setHeader('X-WP-Total', total);
      if (pages) res.setHeader('X-WP-TotalPages', pages);
      return res.status(200).json(posts);
    } catch(e) { lastError = e.message; }
  }
  return res.status(504).json({ error: `Failed: ${lastError}` });
}
