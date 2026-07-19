import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const { code, action, userId, state } = req.query;
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const REDIRECT_URI = `${process.env.NEXTAUTH_URL}/api/auth`;

  // Step 1: Redirect to Google login, carrying the user's ID along as 'state'
  if (action === 'login') {
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/webmasters.readonly');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', userId);
    return res.redirect(authUrl.toString());
  }

  // Step 2: Google calls back with a code, plus our original state (the userId)
  if (code) {
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (tokens.error) throw new Error(tokens.error_description || tokens.error);

      const connectedUserId = state;
      if (!connectedUserId) throw new Error('Missing user reference from Google redirect');

      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
      const { error: upsertError } = await supabase
        .from('gsc_connections')
        .upsert({
          user_id: connectedUserId,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || null,
          connected_at: new Date().toISOString(),
        });
      if (upsertError) throw new Error(upsertError.message);

  return res.redirect(`${process.env.NEXTAUTH_URL}/dashboard.html?gsc_connected=1`);
    } catch (e) {
      return res.redirect(`${process.env.NEXTAUTH_URL}/dashboard.html?gsc_error=${encodeURIComponent(e.message)}`);
    }
  }

  return res.status(400).json({ error: 'Invalid request' });
}
