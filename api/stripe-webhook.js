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
      let subscriptionStatus = null;
      let trialEndsAt = null;
      if (session.subscription) {
        try {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          subscriptionStatus = subscription.status;
          trialEndsAt = subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null;
        } catch (e) {
          console.error('Could not retrieve subscription for trial info:', e.message);
        }
      }
      const { error: upsertError } = await supabase.from('profiles').upsert({
        id: userId,
        email: session.customer_email,
        tier,
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        subscription_status: subscriptionStatus,
        trial_ends_at: trialEndsAt,
        subscribed_at: new Date().toISOString(),
      });
      if (upsertError) console.error('Profile upsert failed:', upsertError, 'for userId:', userId);
    }
  }

  // Fires when a trial converts to active, a renewal payment fails (past_due/unpaid),
  // or any other status change on an existing subscription.
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const trialEndsAt = subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null;
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ subscription_status: subscription.status, trial_ends_at: trialEndsAt })
      .eq('stripe_subscription_id', subscription.id);
    if (updateError) console.error('Profile status update failed:', updateError, 'for subscription:', subscription.id);
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    await supabase.from('profiles').update({ tier: 'cancelled', subscription_status: 'canceled' }).eq('stripe_subscription_id', subscription.id);
  }

  return res.status(200).json({ received: true });
}
