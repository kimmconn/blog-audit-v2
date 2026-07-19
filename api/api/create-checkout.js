import Stripe from 'stripe';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { tier, userId, email } = req.body;
  if (!tier || !userId || !email) return res.status(400).json({ error: 'Missing tier, userId, or email' });

  const priceMap = {
    dashboard: process.env.STRIPE_PRICE_DASHBOARD,
    reports: process.env.STRIPE_PRICE_REPORTS,
  };
  const priceId = priceMap[tier];
  if (!priceId) return res.status(400).json({ error: 'Invalid tier' });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      client_reference_id: userId,
      success_url: `${process.env.NEXTAUTH_URL}/dashboard.html?subscribed=1`,
      cancel_url: `${process.env.NEXTAUTH_URL}/dashboard.html?subscribe_cancelled=1`,
      metadata: { userId, tier },
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
