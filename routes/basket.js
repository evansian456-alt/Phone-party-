'use strict';
const express = require('express');

// In-memory basket store (keyed by userId). Cleared after successful checkout.
const userBaskets = new Map();

module.exports = function createBasketRouter(deps) {
  const {
    apiLimiter,
    authMiddleware,
    stripeClient
  } = deps;

  const router = express.Router();

  const STRIPE_PRICE_PARTY_PASS = process.env.STRIPE_PRICE_PARTY_PASS || 'price_1T730tK3GhmyOKSB36mifw84';
  const STRIPE_PRICE_PRO_MONTHLY = process.env.STRIPE_PRICE_PRO_MONTHLY || 'price_1T733rK3GhmyOKSBsghjQPUZ';
  const STRIPE_SERVICE_URL = 'https://app.phone-party.com';
  const STRIPE_SUCCESS_URL = (process.env.PUBLIC_BASE_URL || STRIPE_SERVICE_URL) + '/payment-success';
  const STRIPE_CANCEL_URL = (process.env.PUBLIC_BASE_URL || STRIPE_SERVICE_URL) + '/payment-cancel';

  router.get('/basket', apiLimiter, authMiddleware.requireAuth, (req, res) => {
    const userId = req.user.userId;
    return res.json({ basket: userBaskets.get(userId) || [] });
  });

  router.post('/basket/add', apiLimiter, authMiddleware.requireAuth, (req, res) => {
    const userId = req.user.userId;
    const { priceId } = req.body;
    if (!priceId) return res.status(400).json({ error: 'priceId is required' });
    const basket = userBaskets.get(userId) || [];
    if (!basket.includes(priceId)) basket.push(priceId);
    userBaskets.set(userId, basket);
    return res.json({ basket });
  });

  router.delete('/basket/item/:priceId', apiLimiter, authMiddleware.requireAuth, (req, res) => {
    const userId = req.user.userId;
    const priceId = req.params.priceId;
    const basket = (userBaskets.get(userId) || []).filter(p => p !== priceId);
    userBaskets.set(userId, basket);
    return res.json({ basket });
  });

  router.post('/basket/checkout', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    if (!stripeClient) return res.status(503).json({ error: 'Billing not configured. STRIPE_SECRET_KEY is missing.' });
    const userId = req.user.userId;
    const basket = userBaskets.get(userId) || [];
    if (basket.length === 0) return res.status(400).json({ error: 'Basket is empty' });
    const hasSubscription = basket.some(p => p === STRIPE_PRICE_PRO_MONTHLY);
    const mode = hasSubscription ? 'subscription' : 'payment';
    try {
      const session = await stripeClient.checkout.sessions.create({
        mode,
        line_items: basket.map(priceId => ({ price: priceId, quantity: 1 })),
        success_url: STRIPE_SUCCESS_URL,
        cancel_url: STRIPE_CANCEL_URL,
        metadata: { userId }
      });
      userBaskets.delete(userId);
      return res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
      console.error('[BasketCheckout] Error:', error.message);
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  return router;
};
