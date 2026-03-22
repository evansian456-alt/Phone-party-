'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');

module.exports = function createBillingRouter(deps) {
  const {
    db, redis, authMiddleware, apiLimiter, purchaseLimiter,
    stripeClient, PRODUCTS, getProductByPlatformId, applyPurchaseToUser,
    paymentProvider, storeCatalog, verifyStripeSignature, processStripeWebhook,
    metricsService, shouldBypassRateLimit, TEST_MODE, INSTANCE_ID,
    localFallbackUsersById, localFallbackUsersByEmail, canUseLocalAuthFallback,
    parties, getMaxAllowedPhones, getPartyFromRedis, setPartyInRedis,
    getPartyFromFallback, setPartyInFallback
  } = deps;

  const router = express.Router();

  // Constants
  const PARTY_PASS_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours
  const STRIPE_PRICE_PARTY_PASS = process.env.STRIPE_PRICE_PARTY_PASS || 'price_1T730tK3GhmyOKSB36mifw84';
  const STRIPE_PRICE_PRO_MONTHLY = process.env.STRIPE_PRICE_PRO_MONTHLY || 'price_1T733rK3GhmyOKSBsghjQPUZ';
  const STRIPE_SERVICE_URL = 'https://app.phone-party.com';
  const STRIPE_SUCCESS_URL = (process.env.PUBLIC_BASE_URL || STRIPE_SERVICE_URL) + '/payment-success';
  const STRIPE_CANCEL_URL = (process.env.PUBLIC_BASE_URL || STRIPE_SERVICE_URL) + '/payment-cancel';

  /**
   * Derive tier string from subscription status.
   * Policy: PRO when active or trialing; FREE otherwise.
   * past_due keeps FREE (conservative).
   */
  function tierFromSubscriptionStatus(status) {
    if (status === 'active' || status === 'trialing') return 'PRO';
    return 'FREE';
  }

  /**
   * Handle a verified billing webhook event and update the DB.
   */
  async function handleBillingWebhookEvent(event) {
    const { type, data } = event;
    const obj = data.object;

    console.log(`[BillingWebhook] Received event: ${type}`);

    switch (type) {
      case 'checkout.session.completed': {
        const userId = obj.client_reference_id;
        const customerId = obj.customer;
        const subscriptionId = obj.subscription;
        if (!userId) {
          console.error('[BillingWebhook] checkout.session.completed: missing client_reference_id');
          return;
        }
        await db.query(
          'UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, $1), stripe_subscription_id = $2 WHERE id = $3',
          [customerId, subscriptionId, userId]
        );
        // Fetch subscription to get status + period end
        if (subscriptionId && stripeClient) {
          try {
            const sub = await stripeClient.subscriptions.retrieve(subscriptionId);
            const newTier = tierFromSubscriptionStatus(sub.status);
            await db.query(
              `UPDATE users SET subscription_status = $1, current_period_end = $2, tier = $3
               WHERE id = $4`,
              [sub.status, new Date(sub.current_period_end * 1000), newTier, userId]
            );
            console.log(`[BillingWebhook] checkout.session.completed: userId=${userId} tier=${newTier}`);
          } catch (fetchErr) {
            console.error('[BillingWebhook] Failed to fetch subscription after checkout:', fetchErr.message);
          }
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscriptionId = obj.id;
        const customerId = obj.customer;
        const status = obj.status;
        const periodEnd = new Date(obj.current_period_end * 1000);
        const newTier = tierFromSubscriptionStatus(status);

        // Prefer metadata.userId; fall back to stripe_customer_id lookup
        let userId = obj.metadata?.userId;
        if (!userId) {
          const r = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
          if (r.rows.length > 0) userId = r.rows[0].id;
        }
        if (!userId) {
          console.error(`[BillingWebhook] ${type}: no userId for customer ${customerId}`);
          return;
        }

        await db.query(
          `UPDATE users SET stripe_subscription_id = $1, subscription_status = $2,
           current_period_end = $3, tier = $4 WHERE id = $5`,
          [subscriptionId, status, periodEnd, newTier, userId]
        );
        console.log(`[BillingWebhook] ${type}: userId=${userId} status=${status} tier=${newTier}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscriptionId = obj.id;
        const customerId = obj.customer;
        const status = obj.status;

        let userId = obj.metadata?.userId;
        if (!userId) {
          const r = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
          if (r.rows.length > 0) userId = r.rows[0].id;
        }
        if (!userId) {
          const r = await db.query('SELECT id FROM users WHERE stripe_subscription_id = $1', [subscriptionId]);
          if (r.rows.length > 0) userId = r.rows[0].id;
        }
        if (!userId) {
          console.error(`[BillingWebhook] customer.subscription.deleted: no userId found`);
          return;
        }

        await db.query(
          `UPDATE users SET subscription_status = $1, tier = 'FREE' WHERE id = $2`,
          [status || 'canceled', userId]
        );
        console.log(`[BillingWebhook] customer.subscription.deleted: userId=${userId} tier=FREE`);
        break;
      }

      case 'invoice.payment_succeeded': {
        const subscriptionId = obj.subscription;
        if (!subscriptionId) return;
        const periodEnd = new Date(obj.period_end * 1000);
        await db.query(
          `UPDATE users SET subscription_status = 'active', current_period_end = $1, tier = 'PRO'
           WHERE stripe_subscription_id = $2`,
          [periodEnd, subscriptionId]
        );
        console.log(`[BillingWebhook] invoice.payment_succeeded: subscription=${subscriptionId} tier=PRO`);
        break;
      }

      case 'invoice.payment_failed': {
        const subscriptionId = obj.subscription;
        if (!subscriptionId) return;
        // Keep subscription_status as past_due; conservative: set tier to FREE
        await db.query(
          `UPDATE users SET subscription_status = 'past_due', tier = 'FREE'
           WHERE stripe_subscription_id = $1`,
          [subscriptionId]
        );
        console.log(`[BillingWebhook] invoice.payment_failed: subscription=${subscriptionId} tier=FREE`);
        break;
      }

      default:
        console.log(`[BillingWebhook] Unhandled event type: ${type}`);
    }
  }

  /**
   * Handle a verified Stripe webhook event.
   */
  async function handleStripeWebhookEvent(event) {
    const { type, data } = event;
    const obj = data.object;
    console.log(`[Stripe] Processing webhook event: ${type}`);

    switch (type) {
      case 'checkout.session.completed': {
        const userId = obj.metadata?.userId || obj.client_reference_id;
        if (!userId) {
          console.error('[Stripe] checkout.session.completed: no userId in metadata');
          return;
        }
        // Get price ID from metadata (set at session creation) or expand line_items
        let priceId = obj.metadata?.priceId;
        const productType = obj.metadata?.productType; // test/fallback identifier
        const validProductTypes = ['party_pass', 'pro_monthly'];
        const resolvedProductType = validProductTypes.includes(productType) ? productType : null;
        if (!priceId && !resolvedProductType) {
          try {
            const expanded = await stripeClient.checkout.sessions.retrieve(obj.id, { expand: ['line_items'] });
            priceId = expanded.line_items?.data?.[0]?.price?.id;
          } catch (err) {
            console.error('[Stripe] Failed to retrieve line_items:', err.message);
          }
        }
        if (priceId === STRIPE_PRICE_PARTY_PASS || resolvedProductType === 'party_pass') {
          const expiresAt = new Date(Date.now() + PARTY_PASS_DURATION_MS);
          await db.query(
            `INSERT INTO user_upgrades (user_id, party_pass_expires_at)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET party_pass_expires_at = $2, updated_at = NOW()`,
            [userId, expiresAt]
          );
          await db.query(`UPDATE users SET tier = 'PARTY_PASS' WHERE id = $1`, [userId]);
          console.log(`[Stripe] Party Pass activated for user ${userId} (expires ${expiresAt.toISOString()})`);
        } else if (priceId === STRIPE_PRICE_PRO_MONTHLY || resolvedProductType === 'pro_monthly') {
          await db.query(
            `INSERT INTO user_upgrades (user_id, pro_monthly_active, pro_monthly_started_at, pro_monthly_renewal_provider)
             VALUES ($1, true, NOW(), 'stripe')
             ON CONFLICT (user_id) DO UPDATE SET pro_monthly_active = true, pro_monthly_started_at = NOW(),
               pro_monthly_renewal_provider = 'stripe', updated_at = NOW()`,
            [userId]
          );
          await db.query(
            `UPDATE users SET tier = 'PRO', subscription_status = 'active' WHERE id = $1`,
            [userId]
          );
          console.log(`[Stripe] Pro subscription activated for user ${userId}`);
        } else {
          console.log(`[Stripe] checkout.session.completed: unrecognised priceId=${priceId}, productType=${productType}`);
        }
        break;
      }

      case 'invoice.paid': {
        const subscriptionId = obj.subscription;
        if (!subscriptionId) return;
        // Try to resolve userId directly from metadata first (used in test webhooks and
        // real Stripe webhooks where the invoice metadata was set at subscription creation).
        const directUserId = obj.metadata?.userId || obj.lines?.data?.[0]?.metadata?.userId;
        const periodEnd = obj.period_end ? new Date(obj.period_end * 1000) : null;
        if (directUserId) {
          // Update user record and set stripe_subscription_id for future webhook lookups.
          await db.query(
            `UPDATE users SET subscription_status = 'active', tier = 'PRO',
              stripe_subscription_id = COALESCE(stripe_subscription_id, $2)
              ${periodEnd ? ', current_period_end = $3' : ''}
             WHERE id = $1`,
            periodEnd ? [directUserId, subscriptionId, periodEnd] : [directUserId, subscriptionId]
          );
          // Also update user_upgrades so /api/me entitlements.hasPro is correct.
          await db.query(
            `INSERT INTO user_upgrades (user_id, pro_monthly_active, pro_monthly_started_at,
               pro_monthly_renewal_provider, pro_monthly_provider_subscription_id)
             VALUES ($1, true, NOW(), 'stripe', $2)
             ON CONFLICT (user_id) DO UPDATE SET
               pro_monthly_active = true,
               pro_monthly_started_at = COALESCE(user_upgrades.pro_monthly_started_at, NOW()),
               pro_monthly_renewal_provider = 'stripe',
               pro_monthly_provider_subscription_id = $2,
               updated_at = NOW()`,
            [directUserId, subscriptionId]
          );
        } else {
          // Fall back to stripe_subscription_id lookup for webhooks without userId metadata.
          await db.query(
            `UPDATE users SET subscription_status = 'active', tier = 'PRO'${periodEnd ? ', current_period_end = $2' : ''}
             WHERE stripe_subscription_id = $1`,
            periodEnd ? [subscriptionId, periodEnd] : [subscriptionId]
          );
        }
        console.log(`[Stripe] invoice.paid: subscription=${subscriptionId}`);
        break;
      }

      case 'invoice.payment_failed': {
        const subscriptionId = obj.subscription;
        if (!subscriptionId) return;
        await db.query(
          `UPDATE users SET subscription_status = 'past_due', tier = 'FREE'
           WHERE stripe_subscription_id = $1`,
          [subscriptionId]
        );
        await db.query(
          `UPDATE user_upgrades SET pro_monthly_active = false, updated_at = NOW()
           WHERE user_id = (SELECT id FROM users WHERE stripe_subscription_id = $1)`,
          [subscriptionId]
        );
        console.log(`[Stripe] invoice.payment_failed: subscription=${subscriptionId}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscriptionId = obj.id;
        const customerId = obj.customer;
        let userId = obj.metadata?.userId;
        if (!userId) {
          const r = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
          if (r.rows.length > 0) userId = r.rows[0].id;
        }
        if (!userId) {
          const r = await db.query('SELECT id FROM users WHERE stripe_subscription_id = $1', [subscriptionId]);
          if (r.rows.length > 0) userId = r.rows[0].id;
        }
        if (!userId) {
          console.error('[Stripe] customer.subscription.deleted: no userId found');
          return;
        }
        await db.query(
          `UPDATE users SET subscription_status = 'canceled', tier = 'FREE' WHERE id = $1`,
          [userId]
        );
        await db.query(
          `UPDATE user_upgrades SET pro_monthly_active = false, updated_at = NOW() WHERE user_id = $1`,
          [userId]
        );
        console.log(`[Stripe] customer.subscription.deleted: userId=${userId}`);
        break;
      }

      default:
        console.log(`[Stripe] Unhandled event type: ${type}`);
    }
  }

  // ============================================================================
  // STORE / PURCHASE
  // ============================================================================

  router.post("/api/purchase", purchaseLimiter, authMiddleware.requireAuth, async (req, res) => {
    if (canUseLocalAuthFallback()) {
      try {
        const { itemId, partyCode } = req.body;
        const userId = req.user.userId;
        const user = localFallbackUsersById.get(userId);
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        const item = storeCatalog.getItemById(itemId);
        if (!item) {
          return res.status(404).json({ error: 'Item not found' });
        }

        if (item.id === 'party_pass') user.upgrades.party_pass_active = true;
        if (item.id === 'pro_monthly') user.upgrades.pro_monthly_active = true;

        if (partyCode) {
          const normalizedCode = String(partyCode).toUpperCase();
          const localParty = parties.get(normalizedCode);
          const fallbackParty = getPartyFromFallback(normalizedCode);

          const applyPartyUpgrade = (party) => {
            if (!party) return;
            if (item.id === 'party_pass') {
              party.maxPhones = 4;
              party.partyPassExpiresAt = Date.now() + 2 * 60 * 60 * 1000;
              party.tier = 'PARTY_PASS';
              party.partyPro = true;
            }
            if (item.id === 'add_5phones') {
              party.maxPhones = (party.maxPhones || 2) + 5;
            }
            if (item.id === 'add_30min') {
              party.partyPassExpiresAt = (party.partyPassExpiresAt || Date.now()) + 30 * 60 * 1000;
            }
          };

          applyPartyUpgrade(localParty);
          applyPartyUpgrade(fallbackParty);
          if (fallbackParty) {
            setPartyInFallback(normalizedCode, fallbackParty);
          }
        }

        const type = item.type;
        user.entitlements.push({ type, key: item.id });
        if (type === storeCatalog.STORE_CATEGORIES.VISUAL_PACKS) user.profile.activeVisualPack = item.id;
        if (type === storeCatalog.STORE_CATEGORIES.DJ_TITLES) user.profile.activeTitle = item.id;
        if (item.id === 'verified_badge') user.profile.verifiedBadge = true;
        if (item.id === 'crown_effect') user.profile.crownEffect = true;
        if (item.id === 'animated_name') user.profile.animatedName = true;
        if (item.id === 'reaction_trail') user.profile.reactionTrail = true;

        return res.json({
          success: true,
          message: 'Purchase successful',
          item: { id: item.id, name: item.name, type: item.type }
        });
      } catch (error) {
        console.error('[Store] Local fallback purchase error:', error);
        return res.status(500).json({ error: 'Failed to process purchase' });
      }
    }

    const client = await db.getClient();

    try {
      const { itemId, partyCode } = req.body;
      const userId = req.user.userId;

      // Get item from catalog
      const item = storeCatalog.getItemById(itemId);
      if (!item) {
        return res.status(404).json({ error: 'Item not found' });
      }

      await client.query('BEGIN');

      // Record purchase
      const expiresAt = item.duration ?
        new Date(Date.now() + item.duration * 1000) : null;

      const purchaseKind = item.permanent ? 'permanent' :
        (item.type === storeCatalog.STORE_CATEGORIES.SUBSCRIPTIONS ? 'subscription' : 'party_temp');

      await client.query(
        `INSERT INTO purchases (user_id, purchase_kind, item_type, item_key, price_gbp, party_code, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, purchaseKind, item.type, item.id, item.price, partyCode || null, expiresAt] // GBP - Prices in pounds
      );

      // Grant entitlement for permanent items
      if (item.permanent) {
        await client.query(
          `INSERT INTO entitlements (user_id, item_type, item_key)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, item_type, item_key) DO NOTHING`,
          [userId, item.type, item.id]
        );
      }

      // Apply item effect based on type
      if (item.type === storeCatalog.STORE_CATEGORIES.VISUAL_PACKS) {
        // Replace active visual pack
        await client.query(
          'UPDATE dj_profiles SET active_visual_pack = $1, updated_at = NOW() WHERE user_id = $2',
          [item.id, userId]
        );
      } else if (item.type === storeCatalog.STORE_CATEGORIES.DJ_TITLES) {
        // Replace active title
        await client.query(
          'UPDATE dj_profiles SET active_title = $1, updated_at = NOW() WHERE user_id = $2',
          [item.id, userId]
        );
      } else if (item.type === storeCatalog.STORE_CATEGORIES.PROFILE_UPGRADES) {
        // Stack profile upgrades
        const updates = {};
        if (item.id === 'verified_badge') updates.verified_badge = true;
        if (item.id === 'crown_effect') updates.crown_effect = true;
        if (item.id === 'animated_name') updates.animated_name = true;
        if (item.id === 'reaction_trail') updates.reaction_trail = true;

        if (Object.keys(updates).length > 0) {
          const setClause = Object.keys(updates).map((key, i) => `${key} = $${i + 1}`).join(', ');
          const values = [...Object.values(updates), userId];
          await client.query(
            `UPDATE dj_profiles SET ${setClause}, updated_at = NOW() WHERE user_id = $${values.length}`,
            values
          );
        }
      } else if (item.type === storeCatalog.STORE_CATEGORIES.SUBSCRIPTIONS) {
        // Handle subscription
        if (item.id === 'party_pass') {
          // Party Pass is handled per-party - update the JSON party data in Redis
          if (partyCode && redis) {
            try {
              const partyData = await getPartyFromRedis(partyCode);
              if (partyData) {
                const partyPassExpires = Date.now() + item.duration * 1000;
                partyData.partyPassExpiresAt = partyPassExpires;
                partyData.maxPhones = item.maxPhones;
                await setPartyInRedis(partyCode, partyData);

                // Also update local party if it exists
                const localParty = parties.get(partyCode);
                if (localParty) {
                  localParty.partyPassExpiresAt = partyPassExpires;
                  localParty.maxPhones = item.maxPhones;
                }
              }
            } catch (err) {
              console.error(`[Purchase] Error updating party ${partyCode} with party pass:`, err.message);
            }
          }
        } else if (item.id === 'pro_monthly') {
          // Create/update Pro subscription
          const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

          // Check if user already has an active subscription
          const existingSub = await client.query(
            'SELECT id FROM subscriptions WHERE user_id = $1 AND status = \'active\'',
            [userId]
          );

          if (existingSub.rows.length > 0) {
            // Update existing subscription
            await client.query(
              `UPDATE subscriptions SET
                current_period_start = NOW(),
                current_period_end = $1,
                updated_at = NOW()
               WHERE user_id = $2 AND status = 'active'`,
              [periodEnd, userId]
            );
          } else {
            // Create new subscription
            await client.query(
              `INSERT INTO subscriptions (user_id, status, current_period_start, current_period_end)
               VALUES ($1, 'active', NOW(), $2)`,
              [userId, periodEnd]
            );
          }
        }
      } else if (item.type === storeCatalog.STORE_CATEGORIES.PARTY_EXTENSIONS) {
        // Party extensions - apply to Redis party using JSON storage
        if (partyCode && redis) {
          try {
            const partyData = await getPartyFromRedis(partyCode);
            if (partyData) {
              if (item.id === 'add_30min') {
                const currentExpiry = partyData.partyPassExpiresAt || Date.now();
                partyData.partyPassExpiresAt = currentExpiry + 30 * 60 * 1000;
              } else if (item.id === 'add_5phones') {
                const currentMax = partyData.maxPhones || 2;
                partyData.maxPhones = currentMax + 5;
              }
              await setPartyInRedis(partyCode, partyData);

              // Also update local party if it exists
              const localParty = parties.get(partyCode);
              if (localParty) {
                if (item.id === 'add_30min') {
                  localParty.partyPassExpiresAt = partyData.partyPassExpiresAt;
                } else if (item.id === 'add_5phones') {
                  localParty.maxPhones = partyData.maxPhones;
                }
              }
            }
          } catch (err) {
            console.error(`[Purchase] Error updating party ${partyCode} with extension:`, err.message);
          }
        }
      }

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Purchase successful',
        item: {
          id: item.id,
          name: item.name,
          type: item.type
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Store] Purchase error:', error);
      res.status(500).json({ error: 'Failed to process purchase' });
    } finally {
      client.release();
    }
  });

  // ============================================================================
  // PAYMENT ENDPOINTS
  // ============================================================================

  // In-process store for pending payment intents.
  // Keys are intentId strings; values include userId, productId, amount, currency,
  // platform, paymentMethod, createdAt, and used flag.
  // In a multi-instance deployment these should be persisted in Redis or the DB.
  // For now, a module-level Map provides correct behaviour in a single process and
  // survives across requests within that process.
  const _pendingIntents = new Map();
  const INTENT_TTL_MS = 30 * 60 * 1000; // 30 minutes

  /**
   * POST /api/payment/initiate
   * Initiate a purchase (returns payment intent)
   */
  router.post("/api/payment/initiate", purchaseLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      const { productId, platform, paymentMethod } = req.body;
      const userId = req.user.userId;

      // Validate input
      if (!productId || !platform || !paymentMethod) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Validate product
      const validProducts = ['party_pass', 'pro_monthly'];
      if (!validProducts.includes(productId)) {
        return res.status(400).json({ error: 'Invalid product ID' });
      }

      // Get product details from catalog
      const product = storeCatalog.getItemById(productId);
      if (!product) {
        return res.status(404).json({ error: 'Product not found in catalog' });
      }

      // Create payment intent with cryptographically secure ID
      const crypto = require('crypto');
      const intentId = `intent_${Date.now()}_${crypto.randomUUID()}`;
      const paymentIntent = {
        intentId,
        userId,
        productId,
        amount: Math.floor(product.price * 100), // GBP - Convert price to pence, use floor to avoid rounding up
        currency: product.currency || 'GBP', // Default to GBP currency
        platform,
        paymentMethod,
        createdAt: Date.now()
      };

      // Persist intent server-side so that /api/payment/confirm can validate it.
      _pendingIntents.set(intentId, { ...paymentIntent, used: false });

      // Purge stale intents to prevent unbounded Map growth.
      const cutoff = Date.now() - INTENT_TTL_MS;
      for (const [id, intent] of _pendingIntents) {
        if (intent.createdAt < cutoff) _pendingIntents.delete(id);
      }

      console.log(`[Payment] Created payment intent ${intentId} for ${productId}`);

      res.json({
        success: true,
        paymentIntent
      });
    } catch (error) {
      console.error('[Payment] Initiate payment error:', error);
      res.status(500).json({ error: 'Failed to initiate payment' });
    }
  });

  /**
   * POST /api/payment/confirm
   * Confirm payment and grant entitlement
   */
  router.post("/api/payment/confirm", purchaseLimiter, authMiddleware.requireAuth, async (req, res) => {
    const client = await db.getClient();

    try {
      const { intentId, paymentToken, productId, platform, paymentMethod } = req.body;
      const userId = req.user.userId;

      // Validate input
      if (!intentId || !productId || !platform || !paymentMethod) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Validate that the intent was created by this server for this user.
      const storedIntent = _pendingIntents.get(intentId);
      if (!storedIntent) {
        return res.status(400).json({ error: 'Payment intent not found or expired.' });
      }
      if (String(storedIntent.userId) !== String(userId)) {
        return res.status(403).json({ error: 'Payment intent does not belong to this user.' });
      }
      if (storedIntent.productId !== productId) {
        return res.status(400).json({ error: 'Product mismatch on payment intent.' });
      }
      if (storedIntent.used) {
        return res.status(409).json({ error: 'Payment intent has already been used.' });
      }
      if (Date.now() - storedIntent.createdAt > INTENT_TTL_MS) {
        _pendingIntents.delete(intentId);
        return res.status(400).json({ error: 'Payment intent has expired. Please start a new purchase.' });
      }

      // Mark the intent as used immediately to prevent replay attacks.
      storedIntent.used = true;

      // Get product details
      const product = storeCatalog.getItemById(productId);
      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }

      // Process payment through provider
      const paymentResult = await paymentProvider.processPayment({
        userId,
        productId,
        paymentMethod,
        platform,
        paymentToken,
        amount: storedIntent.amount, // Use server-side amount, not client-supplied
        currency: storedIntent.currency
      });

      if (!paymentResult.success) {
        // Leave the intent marked as used to prevent replay attacks.
        // The client must initiate a new intent if they wish to retry.
        return res.status(402).json({
          error: 'Payment failed',
          details: paymentResult.error
        });
      }

      console.log(`[Payment] Payment confirmed for ${productId}: ${paymentResult.transactionId}`);

      await client.query('BEGIN');

      // Derive the correct purchase kind for the product.
      // Party Pass is a time-limited access product, not a recurring subscription.
      const purchaseKind = productId === 'party_pass' ? 'party_pass' : 'subscription';

      // Record purchase in database
      await client.query(
        `INSERT INTO purchases (user_id, purchase_kind, item_type, item_key, price_gbp, provider, provider_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          purchaseKind,
          product.type,
          product.id,
          product.price, // GBP - Price stored in pounds (e.g., 3.99 for Party Pass, 9.99 for Pro Monthly)
          paymentResult.provider,
          paymentResult.providerTransactionId
        ]
      );

      // Grant entitlement based on product
      if (productId === 'party_pass') {
        // Set Party Pass expiration
        const expiresAt = new Date(Date.now() + PARTY_PASS_DURATION_MS);
        await db.updatePartyPassExpiry(userId, expiresAt);
      } else if (productId === 'pro_monthly') {
        // Activate Pro Monthly subscription
        await db.activateProMonthly(userId, paymentResult.provider, paymentResult.providerTransactionId);
      }

      // Get updated upgrades and entitlements
      const upgrades = await db.getOrCreateUserUpgrades(userId);
      const entitlements = db.resolveEntitlements(upgrades);

      await client.query('COMMIT');

      // Remove the intent from the store now that it has been finalised.
      _pendingIntents.delete(intentId);

      res.json({
        success: true,
        transactionId: paymentResult.transactionId,
        upgrades: {
          partyPass: {
            expiresAt: upgrades.party_pass_expires_at
          },
          proMonthly: {
            active: upgrades.pro_monthly_active,
            startedAt: upgrades.pro_monthly_started_at,
            renewalProvider: upgrades.pro_monthly_renewal_provider
          }
        },
        entitlements
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Payment] Confirm payment error:', error);
      res.status(500).json({ error: 'Failed to confirm payment' });
    } finally {
      client.release();
    }
  });

  /**
   * GET /api/user/entitlements
   * Get current user entitlements (for restoration on app load)
   */
  router.get("/api/user/entitlements", apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      const userId = req.user.userId;

      if (canUseLocalAuthFallback()) {
        const user = localFallbackUsersById.get(userId);
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }
        return res.json({
          success: true,
          upgrades: {
            partyPass: {
              expiresAt: user.upgrades.party_pass_active ? new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() : null
            },
            proMonthly: {
              active: !!user.upgrades.pro_monthly_active,
              startedAt: user.upgrades.pro_monthly_active ? new Date().toISOString() : null,
              renewalProvider: null
            }
          },
          entitlements: {
            hasPartyPass: !!user.upgrades.party_pass_active,
            hasPro: !!user.upgrades.pro_monthly_active,
          }
        });
      }

      // Get user upgrades
      const upgrades = await db.getOrCreateUserUpgrades(userId);
      const entitlements = db.resolveEntitlements(upgrades);

      res.json({
        success: true,
        upgrades: {
          partyPass: {
            expiresAt: upgrades.party_pass_expires_at
          },
          proMonthly: {
            active: upgrades.pro_monthly_active,
            startedAt: upgrades.pro_monthly_started_at,
            renewalProvider: upgrades.pro_monthly_renewal_provider
          }
        },
        entitlements
      });
    } catch (error) {
      console.error('[Payment] Get entitlements error:', error);
      res.status(500).json({ error: 'Failed to get entitlements' });
    }
  });

  // ============================================================================
  // STRIPE CHECKOUT SESSION ENDPOINT
  // ============================================================================

  /**
   * POST /api/stripe/create-checkout-session
   * Creates a Stripe Checkout Session for a specific price.
   * mode: "payment" for Party Pass, "subscription" for Pro.
   */
  router.post('/api/stripe/create-checkout-session', apiLimiter, authMiddleware.optionalAuth, async (req, res) => {
    if (!stripeClient) {
      return res.status(503).json({ error: 'Billing not configured. STRIPE_SECRET_KEY is missing.' });
    }
    const { priceId, userId } = req.body;
    if (!priceId || !userId) {
      return res.status(400).json({ error: 'priceId and userId are required' });
    }
    // If authenticated, userId in body must match the authenticated user
    if (req.user && req.user.userId && req.user.userId !== String(userId)) {
      return res.status(403).json({ error: 'userId does not match authenticated user' });
    }
    const mode = priceId === STRIPE_PRICE_PARTY_PASS ? 'payment' : 'subscription';
    try {
      const session = await stripeClient.checkout.sessions.create({
        mode,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: STRIPE_SUCCESS_URL,
        cancel_url: STRIPE_CANCEL_URL,
        metadata: { userId: String(userId), priceId }
      });
      return res.json({ sessionId: session.id });
    } catch (error) {
      console.error('[StripeCheckout] Error creating session:', error.message);
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  // ============================================================================
  // BILLING ENDPOINTS (Stripe Checkout subscriptions)
  // ============================================================================

  /**
   * POST /api/billing/create-checkout-session
   * Creates a Stripe Checkout Session for a PRO monthly subscription.
   * Does NOT grant tier here — the webhook does that.
   */
  router.post('/api/billing/create-checkout-session', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    if (!stripeClient) {
      return res.status(503).json({ error: 'Billing not configured. STRIPE_SECRET_KEY is missing.' });
    }
    const priceId = process.env.STRIPE_PRICE_ID_PRO_MONTHLY;
    if (!priceId) {
      return res.status(503).json({ error: 'Billing not configured. STRIPE_PRICE_ID_PRO_MONTHLY is missing.' });
    }
    const publicBaseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

    try {
      const userId = req.user.userId;

      // Fetch user email and current stripe_customer_id
      const userResult = await db.query(
        'SELECT email, stripe_customer_id FROM users WHERE id = $1',
        [userId]
      );
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const user = userResult.rows[0];
      let customerId = user.stripe_customer_id;

      // Create Stripe customer if not yet linked
      if (!customerId) {
        const customer = await stripeClient.customers.create({
          email: user.email,
          metadata: { userId }
        });
        customerId = customer.id;
        await db.query(
          'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, userId]
        );
      }

      // Create Checkout Session
      const session = await stripeClient.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${publicBaseUrl}/?billing=success`,
        cancel_url: `${publicBaseUrl}/?billing=cancel`,
        client_reference_id: String(userId)
      });

      return res.json({ url: session.url });
    } catch (error) {
      console.error('[BillingCheckout] Error creating session:', error.message);
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  /**
   * GET /api/billing/status
   * Returns the authenticated user's current tier/subscription state.
   * Includes computed fields (activeTier, tierStatus, startedAt, expiresAt,
   * timeRemainingSeconds, isExpired) for frontend display.
   */
  router.get('/api/billing/status', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      const userId = req.user.userId;

      // Fetch user billing row and upgrades row in parallel
      const [userResult, upgrades] = await Promise.all([
        db.query(
          `SELECT tier, subscription_status, current_period_end,
                  stripe_customer_id, stripe_subscription_id
           FROM users WHERE id = $1`,
          [userId]
        ),
        db.getOrCreateUserUpgrades(userId)
      ]);

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const userRow = userResult.rows[0];
      const status = db.buildTierStatus(userRow, upgrades);

      return res.json(status);
    } catch (error) {
      console.error('[BillingStatus] Error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch billing status' });
    }
  });

  /**
   * POST /api/billing/webhook
   * Stripe webhook endpoint. Uses raw body for signature verification.
   * IMPORTANT: this route must be registered BEFORE the JSON body-parser middleware
   * applies to it, so we attach express.raw() directly on this route.
   */
  router.post(
    '/api/billing/webhook',
    rateLimit({ windowMs: 60000, max: 200 }),
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        console.error('[BillingWebhook] STRIPE_WEBHOOK_SECRET not configured');
        return res.status(500).json({ error: 'Webhook not configured' });
      }
      if (!stripeClient) {
        console.error('[BillingWebhook] Stripe client not available');
        return res.status(503).json({ error: 'Billing not configured' });
      }

      let event;
      try {
        event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
      } catch (err) {
        console.error('[BillingWebhook] Signature verification failed:', err.message);
        return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
      }

      // Respond 200 quickly; process asynchronously
      res.json({ received: true });

      try {
        await handleBillingWebhookEvent(event);
      } catch (err) {
        console.error('[BillingWebhook] Handler error:', err.message);
      }
    }
  );

  /**
   * POST /api/stripe/webhook
   * Stripe webhook handler (raw body required for signature verification).
   * Note: Webhooks should have lenient rate limiting as they're externally triggered.
   */
  router.post("/api/stripe/webhook", rateLimit({ windowMs: 60000, max: 100 }), express.raw({ type: 'application/json' }), async (req, res) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[Stripe] Webhook secret not configured');
      return res.status(500).json({ error: 'Webhook not configured' });
    }
    if (!stripeClient) {
      console.error('[Stripe] Stripe client not available');
      return res.status(503).json({ error: 'Billing not configured' });
    }

    let event;
    try {
      event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
    } catch (err) {
      console.error('[Stripe] Signature verification failed:', err.message);
      return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    }

    // Respond 200 immediately; process asynchronously
    res.json({ received: true });

    try {
      await handleStripeWebhookEvent(event);
    } catch (err) {
      console.error('[Stripe] Webhook handler error:', err.message);
    }
  });

  return router;
};
