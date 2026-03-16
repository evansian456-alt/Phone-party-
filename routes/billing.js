'use strict';

const express = require('express');
const ErrorMessages = require('../error-messages');

// Per-user shopping basket (in-memory, module-scoped)
const userBaskets = new Map();

/**
 * Billing, payment, IAP and basket routes.
 * @param {object} context - Shared server context
 * @returns {express.Router}
 */
module.exports = function createBillingRouter(context) {
  const router = express.Router();
  const {
    db,
    authMiddleware,
    redis,
    stripeClient,
    storeCatalog,
    paymentProvider,
    PRODUCTS,
    getProductByPlatformId,
    applyPurchaseToUser,
    apiLimiter,
    purchaseLimiter,
    TEST_MODE,
    PROMO_CODES,
    PARTY_PASS_DURATION_MS,
    FREE_PARTY_LIMIT,
    MAX_PRO_PARTY_DEVICES,
    getPartyFromRedis,
    setPartyInRedis,
    getPartyFromFallback,
    setPartyInFallback,
    parties,
    verifyStripeSignature,
    processStripeWebhook,
    shouldBypassRateLimit,
    rateLimit,
    // Mutable runtime state — caller must pass these via context so handlers
    // read current values.  Access via context.<field> where staleness matters.
    IS_PRODUCTION,
    INSTANCE_ID,
    canUseLocalAuthFallback,
    localFallbackUsersById,
    broadcastRoomState,
  } = context;

  // Stripe price IDs / redirect URLs (mirrors server.js lines 6570-6574)
  const STRIPE_SERVICE_URL = 'https://app.phone-party.com';
  const STRIPE_PRICE_PARTY_PASS = process.env.STRIPE_PRICE_PARTY_PASS || 'price_1T730tK3GhmyOKSB36mifw84';
  const STRIPE_PRICE_PRO_MONTHLY = process.env.STRIPE_PRICE_PRO_MONTHLY || 'price_1T733rK3GhmyOKSBsghjQPUZ';
  const STRIPE_SUCCESS_URL = (process.env.PUBLIC_BASE_URL || STRIPE_SERVICE_URL) + '/payment-success';
  const STRIPE_CANCEL_URL = (process.env.PUBLIC_BASE_URL || STRIPE_SERVICE_URL) + '/payment-cancel';

  // ── Promo helper functions ────────────────────────────────────────────────

  async function _getPartyDataForPromo(code, useRedis) {
    if (useRedis) {
      try {
        return await getPartyFromRedis(code);
      } catch (_) {
        return getPartyFromFallback(code);
      }
    }
    return getPartyFromFallback(code);
  }

  async function _savePartyDataForPromo(code, partyData, useRedis) {
    if (useRedis) {
      try {
        await setPartyInRedis(code, partyData);
      } catch (_) {
        setPartyInFallback(code, partyData);
      }
    } else {
      setPartyInFallback(code, partyData);
    }
  }

  function _updateWsPartyForPromo(code) {
    const wsParty = parties.get(code);
    if (wsParty) {
      wsParty.promoUsed = true;
      wsParty.partyPro = true;
      broadcastRoomState(code);
    }
  }

  // ── Billing webhook helpers ───────────────────────────────────────────────

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
  // PURCHASE ENDPOINT
  // ============================================================================

  router.post('/purchase', purchaseLimiter, authMiddleware.requireAuth, async (req, res) => {
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

  /**
   * POST /payment/initiate
   * Initiate a purchase (returns payment intent)
   */
  router.post('/payment/initiate', purchaseLimiter, authMiddleware.requireAuth, async (req, res) => {
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
      const paymentIntent = {
        intentId: `intent_${Date.now()}_${crypto.randomUUID()}`,
        userId,
        productId,
        amount: Math.floor(product.price * 100), // GBP - Convert price to pence, use floor to avoid rounding up
        currency: product.currency || 'GBP', // Default to GBP currency
        platform,
        paymentMethod,
        createdAt: Date.now()
      };

      console.log(`[Payment] Created payment intent ${paymentIntent.intentId} for ${productId}`);

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
   * POST /payment/confirm
   * Confirm payment and grant entitlement
   */
  router.post('/payment/confirm', purchaseLimiter, authMiddleware.requireAuth, async (req, res) => {
    const client = await db.getClient();
    
    try {
      const { intentId, paymentToken, productId, platform, paymentMethod } = req.body;
      const userId = req.user.userId;

      // Validate input
      if (!intentId || !productId || !platform || !paymentMethod) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

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
        amount: Math.round(product.price * 100), // GBP - Convert price to pence (smallest currency unit)
        currency: product.currency || 'GBP'
      });

      if (!paymentResult.success) {
        return res.status(402).json({ 
          error: 'Payment failed', 
          details: paymentResult.error 
        });
      }

      console.log(`[Payment] Payment confirmed for ${productId}: ${paymentResult.transactionId}`);

      await client.query('BEGIN');

      // Record purchase in database
      await client.query(
        `INSERT INTO purchases (user_id, purchase_kind, item_type, item_key, price_gbp, provider, provider_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId, 
          'subscription', 
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
   * GET /user/entitlements
   * Get current user entitlements (for restoration on app load)
   */
  router.get('/user/entitlements', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
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
  // PROMO CODE ENDPOINT
  // ============================================================================

  router.post('/apply-promo', apiLimiter, authMiddleware.optionalAuth, async (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[HTTP] POST /api/apply-promo at ${timestamp}, instanceId: ${INSTANCE_ID}`, req.body);
    
    try {
      const { partyCode, promoCode } = req.body;
      
      if (!partyCode || !promoCode) {
        return res.status(400).json({ error: "Party code and promo code are required" });
      }
      
      // Normalize codes
      const code = partyCode.trim().toUpperCase();
      const promo = promoCode.trim().toUpperCase();
      
      // Validate party code length
      if (code.length !== 6) {
        return res.status(400).json({ error: "Party code must be 6 characters" });
      }
      
      // Determine storage backend
      const useRedis = redis && context.redisReady;
      
      // In production mode, Redis is required
      if (IS_PRODUCTION && !useRedis) {
        return res.status(503).json({ 
          error: "Server not ready - Redis unavailable",
          details: "Multi-device features require Redis"
        });
      }

      // ── Check DB-backed admin-generated promo codes first ─────────────────────
      let dbPromo = null;
      try {
        const dbResult = await db.query(
          `SELECT id, code, type, is_used FROM promo_codes WHERE code = $1`,
          [promo]
        );
        if (dbResult.rows.length > 0) {
          dbPromo = dbResult.rows[0];
        }
      } catch (dbErr) { console.warn('[Promo] DB lookup unavailable, falling back to legacy codes:', dbErr.message); }

      if (dbPromo) {
        // Found in DB — enforce one-time-use
        if (dbPromo.is_used) {
          console.log(`[Promo] DB promo code already used: ${promo}, partyCode: ${code}`);
          return res.status(400).json({ error: "This promo code has already been used." });
        }

        const userId = req.user ? (req.user.id || req.user.userId) : null;

        // Mark as used atomically
        const updated = await db.query(
          `UPDATE promo_codes SET is_used = TRUE, used_at = NOW(), used_by = $1
           WHERE id = $2 AND is_used = FALSE
           RETURNING id`,
          [userId || null, dbPromo.id]
        );
        if (updated.rows.length === 0) {
          // Race condition — another request beat us to it
          return res.status(400).json({ error: "This promo code has already been used." });
        }

        // Apply the benefit based on promo type
        if (dbPromo.type === 'pro_monthly' && userId) {
          // Activate pro monthly subscription for the authenticated user
          await db.activateProMonthly(userId, 'promo', promo);
          console.log(`[Promo] DB promo ${promo} (pro_monthly) applied for user ${userId}`);
          return res.json({ ok: true, type: 'pro_monthly', message: "Pro Monthly activated!" });
        }

        // Default: party_pass — unlock party-wide Pro (same as legacy flow)
        // (also used for pro_monthly codes when user is not logged in)
        const partyData = await _getPartyDataForPromo(code, useRedis);
        if (!partyData) {
          return res.status(404).json({ error: ErrorMessages.partyNotFound() });
        }

        if (partyData.promoUsed) {
          return res.status(400).json({ error: "This party already used a promo code." });
        }

        partyData.promoUsed = true;
        partyData.partyPro = true;
        await _savePartyDataForPromo(code, partyData, useRedis);
        _updateWsPartyForPromo(code);

        console.log(`[Promo] DB promo ${promo} (${dbPromo.type}) unlocked party ${code}`);
        return res.json({ ok: true, type: dbPromo.type, partyPro: true, message: "Pro unlocked for this party!" });
      }

      // ── Fall back to legacy hardcoded promo codes ──────────────────────────────
      
      // Get party data
      const partyData = await _getPartyDataForPromo(code, useRedis);
      
      if (!partyData) {
        return res.status(404).json({ error: ErrorMessages.partyNotFound() });
      }
      
      // Check if promo already used
      if (partyData.promoUsed) {
        console.log(`[Promo] Attempt to reuse promo in party ${code}`);
        return res.status(400).json({ error: "This party already used a promo code." });
      }
      
      // Validate promo code (using constant from top of file)
      if (!PROMO_CODES.includes(promo)) {
        console.log(`[Promo] Invalid promo code attempt: ${promo}, partyCode: ${code}`);
        return res.status(400).json({ error: "Invalid or expired promo code." });
      }
      
      // Valid and unused - unlock party-wide Pro
      partyData.promoUsed = true;
      partyData.partyPro = true;
      console.log(`[Promo] Party ${code} unlocked with promo code ${promo} via HTTP`);

      await _savePartyDataForPromo(code, partyData, useRedis);
      _updateWsPartyForPromo(code);
      
      res.json({ 
        ok: true, 
        partyPro: true,
        message: "Pro unlocked for this party!"
      });
      
    } catch (error) {
      console.error(`[HTTP] Error applying promo, instanceId: ${INSTANCE_ID}:`, error);
      res.status(500).json({ 
        error: "Failed to apply promo code",
        details: error.message 
      });
    }
  });

  // ============================================================================
  // BASKET / CART ENDPOINTS
  // ============================================================================

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

  // ============================================================================
  // STRIPE CHECKOUT SESSION ENDPOINT
  // ============================================================================

  /**
   * POST /stripe/create-checkout-session
   * Creates a Stripe Checkout Session for a specific price.
   * mode: "payment" for Party Pass, "subscription" for Pro.
   */
  router.post('/stripe/create-checkout-session', apiLimiter, authMiddleware.optionalAuth, async (req, res) => {
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
   * POST /billing/create-checkout-session
   * Creates a Stripe Checkout Session for a PRO monthly subscription.
   * Does NOT grant tier here — the webhook does that.
   */
  router.post('/billing/create-checkout-session', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
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
   * GET /billing/status
   * Returns the authenticated user's current billing/subscription state.
   */
  router.get('/billing/status', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      const userId = req.user.userId;
      const result = await db.query(
        `SELECT tier, subscription_status, current_period_end, stripe_customer_id, stripe_subscription_id
         FROM users WHERE id = $1`,
        [userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const row = result.rows[0];
      return res.json({
        tier: row.tier || 'FREE',
        subscription_status: row.subscription_status || null,
        current_period_end: row.current_period_end || null,
        stripe_customer_id: row.stripe_customer_id || null,
        stripe_subscription_id: row.stripe_subscription_id || null
      });
    } catch (error) {
      console.error('[BillingStatus] Error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch billing status' });
    }
  });

  /**
   * POST /billing/webhook
   * Stripe webhook endpoint. Uses raw body for signature verification.
   * IMPORTANT: this route must be registered BEFORE the JSON body-parser middleware
   * applies to it, so we attach express.raw() directly on this route.
   */
  router.post(
    '/billing/webhook',
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

  // ============================================================================
  // STRIPE WEBHOOK ENDPOINT
  // ============================================================================

  // Stripe webhook handler (raw body required for signature verification)
  // Note: Webhooks should have lenient rate limiting as they're externally triggered
  router.post('/stripe/webhook', rateLimit({ windowMs: 60000, max: 100 }), express.raw({ type: 'application/json' }), async (req, res) => {
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

  // ============================================================================
  // IAP – Apple In-App Purchase verification
  // ============================================================================

  /**
   * POST /iap/apple/verify
   * Body: { receiptData, userId }
   * ENV: APPLE_SHARED_SECRET
   */
  router.post('/iap/apple/verify', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    const { receiptData } = req.body || {};
    const userId = req.user.userId;

    if (!receiptData) return res.status(400).json({ error: 'receiptData required' });

    const sharedSecret = process.env.APPLE_SHARED_SECRET;
    if (!sharedSecret) {
      console.error('[IAP/Apple] APPLE_SHARED_SECRET not set');
      return res.status(503).json({ error: 'Apple IAP not configured' });
    }

    // Verify with Apple – try production first, then sandbox
    const https = require('https');
    async function verifyWithApple(url, payload) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const opts = new URL(url);
        const reqOpts = {
          hostname: opts.hostname,
          path: opts.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const r = https.request(reqOpts, (resp) => {
          let data = '';
          resp.on('data', d => { data += d; });
          resp.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          });
        });
        r.on('error', reject);
        r.write(body);
        r.end();
      });
    }

    try {
      const payload = { 'receipt-data': receiptData, password: sharedSecret, 'exclude-old-transactions': true };
      let appleResp = await verifyWithApple('https://buy.itunes.apple.com/verifyReceipt', payload);

      // Status 21007 = sandbox receipt sent to production – retry with sandbox
      if (appleResp.status === 21007) {
        appleResp = await verifyWithApple('https://sandbox.itunes.apple.com/verifyReceipt', payload);
      }

      if (appleResp.status !== 0) {
        console.warn(`[IAP/Apple] Verification failed with status ${appleResp.status}`);
        return res.status(400).json({ error: `Apple verification failed: status ${appleResp.status}` });
      }

      const latestReceipts = appleResp.latest_receipt_info || appleResp.receipt?.in_app || [];
      const results = [];

      for (const receipt of latestReceipts) {
        const productId = receipt.product_id;
        const transactionId = receipt.transaction_id;
        const product = getProductByPlatformId('apple', productId);
        if (!product) {
          console.warn(`[IAP/Apple] Unknown productId: ${productId}`);
          continue;
        }
        try {
          const result = await applyPurchaseToUser({
            userId,
            productKey: product.key,
            provider: 'apple',
            providerTransactionId: transactionId,
            raw: receipt
          });
          results.push({ productId, productKey: product.key, ...result });
        } catch (err) {
          console.error(`[IAP/Apple] applyPurchaseToUser error for ${productId}:`, err.message);
        }
      }

      return res.json({ ok: true, results });
    } catch (err) {
      console.error('[IAP/Apple] Verification error:', err.message);
      return res.status(500).json({ error: 'Apple verification failed' });
    }
  });

  // ============================================================================
  // IAP – Google Play Billing verification
  // ============================================================================

  /**
   * POST /iap/google/verify
   * Body: { packageName, productId, purchaseToken, userId }
   * ENV: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, GOOGLE_PLAY_PACKAGE_NAME
   */
  router.post('/iap/google/verify', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    const { packageName: bodyPackageName, productId, purchaseToken } = req.body || {};
    const userId = req.user.userId;

    const packageName = bodyPackageName || process.env.GOOGLE_PLAY_PACKAGE_NAME;
    if (!productId || !purchaseToken) {
      return res.status(400).json({ error: 'productId and purchaseToken required' });
    }
    if (!packageName) {
      return res.status(400).json({ error: 'packageName required (or set GOOGLE_PLAY_PACKAGE_NAME)' });
    }

    const serviceAccountJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
      console.error('[IAP/Google] GOOGLE_PLAY_SERVICE_ACCOUNT_JSON not set');
      return res.status(503).json({ error: 'Google Play IAP not configured' });
    }

    try {
      const serviceAccount = JSON.parse(serviceAccountJson);

      // Get access token via JWT + Google OAuth2
      const jwt = require('jsonwebtoken');
      const now = Math.floor(Date.now() / 1000);
      const jwtPayload = {
        iss: serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/androidpublisher',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
      };
      const signedJwt = jwt.sign(jwtPayload, serviceAccount.private_key, { algorithm: 'RS256' });

      const https = require('https');
      async function postForm(url, formData) {
        return new Promise((resolve, reject) => {
          const body = new URLSearchParams(formData).toString();
          const opts = new URL(url);
          const reqOpts = {
            hostname: opts.hostname,
            path: opts.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
          };
          const r = https.request(reqOpts, (resp) => {
            let data = '';
            resp.on('data', d => { data += d; });
            resp.on('end', () => {
              try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
          });
          r.on('error', reject);
          r.write(body);
          r.end();
        });
      }

      async function getJson(url, accessToken) {
        return new Promise((resolve, reject) => {
          const opts = new URL(url);
          const reqOpts = {
            hostname: opts.hostname,
            path: opts.pathname + opts.search,
            method: 'GET',
            headers: { Authorization: `Bearer ${accessToken}` }
          };
          const r = https.request(reqOpts, (resp) => {
            let data = '';
            resp.on('data', d => { data += d; });
            resp.on('end', () => {
              try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
          });
          r.on('error', reject);
          r.end();
        });
      }

      const tokenResp = await postForm('https://oauth2.googleapis.com/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedJwt
      });

      if (!tokenResp.access_token) {
        console.error('[IAP/Google] Failed to get access token:', tokenResp);
        return res.status(500).json({ error: 'Failed to authenticate with Google' });
      }

      // Determine if product is one-time or subscription and use appropriate API
      const product = getProductByPlatformId('google', productId);
      const productType = product ? product.type : 'one_time';

      let purchaseData;
      if (productType === 'subscription') {
        purchaseData = await getJson(
          `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/subscriptions/${productId}/tokens/${purchaseToken}`,
          tokenResp.access_token
        );
      } else {
        purchaseData = await getJson(
          `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/products/${productId}/tokens/${purchaseToken}`,
          tokenResp.access_token
        );
      }

      if (purchaseData.error) {
        console.warn('[IAP/Google] Purchase validation error:', purchaseData.error);
        return res.status(400).json({ error: `Google validation failed: ${purchaseData.error.message || 'unknown'}` });
      }

      if (!product) {
        console.warn(`[IAP/Google] Unknown productId: ${productId}`);
        return res.status(400).json({ error: `Unknown productId: ${productId}` });
      }

      const transactionId = purchaseToken; // Use token as unique transaction ID
      const result = await applyPurchaseToUser({
        userId,
        productKey: product.key,
        provider: 'google',
        providerTransactionId: transactionId,
        raw: purchaseData
      });

      return res.json({ ok: true, productKey: product.key, ...result });
    } catch (err) {
      console.error('[IAP/Google] Verification error:', err.message);
      return res.status(500).json({ error: 'Google Play verification failed' });
    }
  });

  return router;
};
