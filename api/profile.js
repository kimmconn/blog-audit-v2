import { createClient } from '@supabase/supabase-js';

// Server-side profile lookup used by dashboard.html as a fallback when the browser's own
// profiles query comes back empty. It verifies the caller's login token, then reads ONLY
// that user's profile with the service key, so it works even if a browser-side permission
// or timing problem hides the row. It never returns anyone else's data.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) return res.status(401).json({ error: 'Invalid token' });

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ profile: profile || null, userId: user.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
