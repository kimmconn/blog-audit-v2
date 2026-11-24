import { authenticate } from '../lib/auth.js';
import Stripe from 'stripe';
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await authenticate(req, res);
  if (!auth) return;
  const { tier, promoCode } = req.body;
  const userId = auth.userId;
  const email = auth.user?.email || req.body.email;
  if (!tier || !userId || !email) return res.status(400).json({ error: 'Missing tier, userId, or email' });
  const priceMap = {
    dashboard: process.env.STRIPE_PRICE_DASHBOARD,
    reports: process.env.STRIPE_PRICE_REPORTS,
  };
  const priceId = priceMap[tier];
  if (!priceId) return res.status(400).json({ error: 'Invalid tier' });
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    // If the customer typed a free trial / promo code on our plan screen, look it up and apply
    // it BEFORE they reach the card form, so they can't miss it. With no code entered, we fall
    // back to Stripe's own "Add promotion code" link on the checkout page.
    let discounts;
    const entered = (promoCode || '').trim();
    if (entered) {
      let found = (await stripe.promotionCodes.list({ code: entered.toUpperCase(), active: true, limit: 1 })).data[0];
      if (!found) found = (await stripe.promotionCodes.list({ code: entered, active: true, limit: 1 })).data[0];
      if (!found) return res.status(400).json({ error: "We couldn't find that code. Check the spelling, or clear the box and add it on the checkout page." });
      discounts = [{ promotion_code: found.id }];
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      client_reference_id: userId,
      ...(discounts ? { discounts } : { allow_promotion_codes: true }),
      custom_text: {
        submit: {
          message: `Free trial or discount code? It ends automatically, and your card is then charged ${tier === 'reports' ? '$35' : '$20'}/month until you cancel. Cancel any time: sign in to Bloupi, open Settings, then Manage subscription.`,
        },
      },
      success_url: `${process.env.NEXTAUTH_URL}/dashboard.html?subscribed=1&tier=${tier}`,
      cancel_url: `${process.env.NEXTAUTH_URL}/dashboard.html?subscribe_cancelled=1`,
      metadata: { userId, tier },
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
