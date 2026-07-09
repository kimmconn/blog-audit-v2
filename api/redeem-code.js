import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code, userId, email } = req.body || {};
  if (!code || !userId || !email) {
    return res.status(400).json({ error: 'Missing code, userId, or email' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

  const { data: inviteCode, error: lookupError } = await supabase
    .from('invite_codes')
    .select('*')
    .eq('code', code.trim().toUpperCase())
    .single();

  if (lookupError || !inviteCode) {
    return res.status(400).json({ error: 'Invalid invite code.' });
  }
  if (inviteCode.redeemed) {
    return res.status(400).json({ error: 'This code has already been used.' });
  }

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + (inviteCode.trial_days || 30));

  const { error: updateError } = await supabase
    .from('invite_codes')
    .update({ redeemed: true, redeemed_by: userId, redeemed_at: new Date().toISOString() })
    .eq('code', inviteCode.code);
  if (updateError) return res.status(500).json({ error: 'Could not redeem code, please try again.' });

  const { error: profileError } = await supabase
    .from('profiles')
    .upsert({ id: userId, email, tier: 'trial', trial_ends_at: trialEndsAt.toISOString() });
  if (profileError) return res.status(500).json({ error: 'Code redeemed but profile setup failed.' });

  return res.status(200).json({ success: true, trialEndsAt: trialEndsAt.toISOString() });
}
