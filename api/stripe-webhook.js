import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { buffer } from 'micro';

export const config = { api: { bodyParser: false } };

// Welcome email via Resend. Never throws: if the key is missing or sending fails, we log it and
// carry on, so a failed email can never break the subscription itself.
async function sendWelcomeEmail(stripe, session, tier) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    const to = session.customer_email || session.customer_details?.email;
    if (!apiKey || !to) {
      if (!apiKey) console.warn('[welcome-email] RESEND_API_KEY not set, skipping');
      return;
    }
    let trialEnd = null;
    if (session.subscription) {
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      if (sub.status === 'trialing' && sub.trial_end) trialEnd = new Date(sub.trial_end * 1000);
    }
    const price = tier === 'reports' ? '$35' : '$20';
    const planName = tier === 'reports' ? 'Reports' : 'Dashboard';
    const trialLine = trialEnd
      ? `Your free trial runs until ${trialEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}. After that, your card is charged automatically (${price}/month for ${planName}) unless you cancel first. To cancel, sign in, open Settings, then Manage subscription.`
      : `Your ${planName} plan is ${price}/month. You can cancel any time: sign in, open Settings, then Manage subscription.`;
    const text = [
      "Hi! I'm Kimmie, the travel blogger who built Bloupi. Thanks for signing up, it means a lot.",
      '',
      "Here's the quickest way to get value:",
      '1. Sign in at https://www.bloupiforbloggers.com/dashboard.html and scan your blog.',
      '2. Connect Google Search Console so Bloupi can score your posts with your real data.',
      '3. Start with the post at the top of your ranked list, and mark it Done once you have updated it.',
      '',
      tier === 'reports' ? "Your update reports are customizable, so tick whatever you want included." : '',
      trialLine,
      '',
      'Reply to this email any time. It comes straight to me.',
      '',
      'Kimmie',
    ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
    const html = text
      .split('\n\n')
      .map(p => `<p style="margin:0 0 14px;line-height:1.6">${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'Kimmie at Bloupi <hello@bloupiforbloggers.com>',
        reply_to: process.env.EMAIL_REPLY_TO || 'hello@bloupiforbloggers.com',
        to: [to],
        subject: 'Welcome to Bloupi, here is how to start',
        text,
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:560px">${html}</div>`,
      }),
    });
    if (!r.ok) console.error('[welcome-email] Resend error', r.status, await r.text());
  } catch (e) {
    console.error('[welcome-email] failed:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const buf = await buffer(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: `Webhook signature verification failed: ${e.message}` });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id || session.metadata?.userId;
    const tier = session.metadata?.tier;
    if (userId && tier) {
      const { error: upsertError } = await supabase.from('profiles').upsert({
        id: userId,
        email: session.customer_email,
        tier,
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        subscribed_at: new Date().toISOString(),
      });
      if (upsertError) console.error('Profile upsert failed:', upsertError, 'for userId:', userId);
      else await sendWelcomeEmail(stripe, session, tier);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    await supabase.from('profiles').update({ tier: 'cancelled' }).eq('stripe_subscription_id', subscription.id);
  }

  // Fires when a customer changes plans (e.g. Dashboard <-> Reports) from the
  // self-serve billing portal - there's no checkout session here, so we map
  // the subscription's price back to a tier ourselves and sync it.
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const priceId = subscription.items?.data?.[0]?.price?.id;
    const priceTierMap = {
      [process.env.STRIPE_PRICE_DASHBOARD]: 'dashboard',
      [process.env.STRIPE_PRICE_REPORTS]: 'reports',
    };
    const tier = priceTierMap[priceId];
    if (tier && subscription.status === 'active') {
      await supabase.from('profiles')
        .update({ tier, stripe_subscription_id: subscription.id })
        .eq('stripe_customer_id', subscription.customer);
    }
  }

  return res.status(200).json({ received: true });
}
