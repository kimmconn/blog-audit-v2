// GSC OAuth handler - manages Google login flow
export default async function handler(req, res) {
  const { code, action } = req.query;
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const REDIRECT_URI = `${process.env.NEXTAUTH_URL}/api/auth`;

  // Step 1: Redirect to Google login
  if (action === 'login') {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/webmasters.readonly');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    return res.redirect(authUrl.toString());
  }

  // Step 2: Exchange code for tokens
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
      // Redirect back to dashboard with token in URL fragment
      const redirectUrl = new URL(process.env.NEXTAUTH_URL);
      redirectUrl.searchParams.set('gsc_token', tokens.access_token);
      if (tokens.refresh_token) redirectUrl.searchParams.set('gsc_refresh', tokens.refresh_token);
      return res.redirect(redirectUrl.toString());
    } catch (e) {
      return res.redirect(`${process.env.NEXTAUTH_URL}?gsc_error=${encodeURIComponent(e.message)}`);
    }
  }

  return res.status(400).json({ error: 'Invalid request' });
}
