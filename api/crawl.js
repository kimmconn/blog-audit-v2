import { authenticate } from '../lib/auth.js';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const auth = await authenticate(req, res, { access: 'scans' });
  if (!auth) return;
  const userId = auth.userId;
  const { siteUrl, page = 1, perPage = 100 } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'Missing siteUrl' });
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
const cleanUrl = siteUrl.replace(/\/$/, '');
  const normalize = (u) => u.replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/$/,'').toLowerCase();

  const isBlockedHost = (u) => {
    try {
      const { protocol, hostname } = new URL(u);
      if (protocol !== 'http:' && protocol !== 'https:') return true;
      const h = hostname.toLowerCase();
      if (h === 'localhost' || h.endsWith('.local')) return true;
      if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
      if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
      if (h === '::1' || h === '0.0.0.0') return true;
      return false;
    } catch(e) { return true; }
  };
  if (isBlockedHost(cleanUrl)) return res.status(400).json({ error: 'Invalid site URL' });
  
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  const { data: profile } = await supabase.from('profiles').select('site_url, tier').eq('id', userId).single();

  let needRegister = false;
  if (profile?.tier !== 'owner') {
    if (!profile?.site_url) {
      needRegister = true; // saved only after the site actually returns posts (see below)
    } else if (normalize(profile.site_url) !== normalize(cleanUrl)) {
      return res.status(403).json({ error: `Your account is registered to ${profile.site_url}. To manage another blog, you'll need a separate subscription.` });
    }
  }
  const buildUrl = (base) => `${base}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&_fields=id,title,link,date,modified,categories,slug`;
  const urls = [cleanUrl, cleanUrl.includes('://www.') ? cleanUrl.replace('://www.','://') : cleanUrl.replace('://','://www.')];
  let lastError = null;
  for (const base of urls) {
    try {
      const r = await fetch(buildUrl(base), { headers: { 'User-Agent': 'BlogAuditTool/1.0' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) { lastError = `HTTP ${r.status}`; continue; }
      const posts = await r.json();
      if (needRegister && Array.isArray(posts) && posts.length > 0) {
        await supabase.from('profiles').update({ site_url: cleanUrl }).eq('id', userId);
      }
      const total = r.headers.get('X-WP-Total');
      const pages = r.headers.get('X-WP-TotalPages');
      if (total) res.setHeader('X-WP-Total', total);
      if (pages) res.setHeader('X-WP-TotalPages', pages);
      return res.status(200).json(posts);
    } catch(e) { lastError = e.message; }
  }
  if (lastError && /^HTTP (4\d\d)/.test(lastError)) {
    return res.status(422).json({ error: "We couldn't find a WordPress posts feed on this site. Bloupi currently works with WordPress blogs only, so this site may be on another platform (Squarespace, Wix, Ghost, a custom site, etc.). If it is WordPress, check that the URL matches exactly how your blog appears in your browser." });
  }
  return res.status(504).json({ error: `We couldn't reach that site (${lastError}). Check the URL and try again in a minute.` });
}
