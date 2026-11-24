import { createClient } from '@supabase/supabase-js';

// Shared login check for the API endpoints that cost money or touch private data.
//
// How it works: the dashboard sends the user's Supabase login token in an
// "Authorization: Bearer ..." header. We ask Supabase who that token belongs to and use
// THAT user id, never a user id the caller typed into the request.
//
// Rollout switch: until the environment variable AUTH_ENFORCE is set to "1" in Vercel,
// requests with NO token still work the old way (so a customer with an old cached page
// isn't locked out) and a warning is logged. Requests that DO carry a token are always
// verified, and a token that is invalid is always refused. Once the logs show no more
// "unauthenticated call" warnings, set AUTH_ENFORCE=1 and redeploy to close the door.

// Which plans may use which kind of endpoint.
const ACCESS = {
  scans: ['owner', 'agentic', 'reports', 'dashboard', 'trial'],
  reports: ['owner', 'agentic', 'reports', 'trial'],
};

export async function authenticate(req, res, { access = null } = {}) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  const token = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    if (process.env.AUTH_ENFORCE === '1') {
      res.status(401).json({ error: 'Please sign in again to continue.' });
      return null;
    }
    console.warn('[auth] unauthenticated call allowed (AUTH_ENFORCE is off):', req.url);
    return {
      userId: req.body?.userId || req.query?.userId || null,
      user: null,
      profile: null,
      authed: false,
      supabase,
    };
  }

  const { data: { user } = {}, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    return null;
  }

  let profile = null;
  if (access) {
    const { data } = await supabase
      .from('profiles')
      .select('tier, trial_ends_at')
      .eq('id', user.id)
      .maybeSingle();
    profile = data;
    const trialExpired =
      profile?.tier === 'trial' && profile.trial_ends_at && new Date(profile.trial_ends_at) <= new Date();
    if (!profile || !(ACCESS[access] || []).includes(profile.tier) || trialExpired) {
      res.status(403).json({
        error: access === 'reports'
          ? 'This feature is included with the Reports plan.'
          : 'You need an active plan to use this.',
      });
      return null;
    }
  }

  return { userId: user.id, user, profile, authed: true, supabase };
}

// Refuses private, local and non-web addresses so an endpoint can't be pointed at our own
// infrastructure. Basic string checks only; it does not resolve DNS.
export function isBlockedUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol !== 'http:' && protocol !== 'https:') return true;
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
    if (h === '::1' || h === '0.0.0.0' || h.startsWith('::ffff:') || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
    return false;
  } catch (e) {
    return true;
  }
}
