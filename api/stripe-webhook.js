import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { buffer } from 'micro';

export const config = { api: { bodyParser: false } };

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
