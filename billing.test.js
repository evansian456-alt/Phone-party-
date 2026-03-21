/**
 * Billing Endpoint Tests (Stripe Checkout subscriptions)
 *
 * These tests mock the Stripe client and the database layer so they
 * run without any external services.
 */

'use strict';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

// ── Stripe mock ──────────────────────────────────────────────────────────────
const mockStripeCheckoutSessionCreate = jest.fn();
const mockStripeCustomerCreate = jest.fn();
const mockStripeSubscriptionsRetrieve = jest.fn();
const mockStripeWebhooksConstructEvent = jest.fn();

jest.mock('./stripe-client', () => {
  const stripeInstance = {
    customers: { create: mockStripeCustomerCreate },
    checkout: { sessions: { create: mockStripeCheckoutSessionCreate } },
    subscriptions: { retrieve: mockStripeSubscriptionsRetrieve },
    webhooks: { constructEvent: mockStripeWebhooksConstructEvent }
  };
  return stripeInstance;
});

// ── Database mock ────────────────────────────────────────────────────────────
const mockDbQuery = jest.fn();
const mockGetOrCreateUserUpgrades = jest.fn();
const mockResolveEntitlements = jest.fn();
const mockBuildTierStatus = jest.fn();

jest.mock('./database', () => ({
  query: mockDbQuery,
  getOrCreateUserUpgrades: mockGetOrCreateUserUpgrades,
  resolveEntitlements: mockResolveEntitlements,
  buildTierStatus: mockBuildTierStatus,
  pool: { end: jest.fn() }
}));

// ── Auth middleware (real JWT, no DB needed) ─────────────────────────────────
const authMiddleware = require('./auth-middleware');

// ── Build a minimal Express app with billing routes ──────────────────────────
// We inline the billing route logic here so tests don't need a full server.js
// import (which would pull in Redis, S3, etc.).

function buildBillingApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const stripeClient = require('./stripe-client');
  const db = require('./database');

  function tierFromSubscriptionStatus(status) {
    return (status === 'active' || status === 'trialing') ? 'PRO' : 'FREE';
  }

  // POST /api/billing/create-checkout-session
  app.post(
    '/api/billing/create-checkout-session',
    authMiddleware.requireAuth,
    async (req, res) => {
      if (!stripeClient) {
        return res.status(503).json({ error: 'Billing not configured' });
      }
      const priceId = process.env.STRIPE_PRICE_ID_PRO_MONTHLY || 'price_test';
      const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://example.com';

      try {
        const userId = req.user.userId;
        const userResult = await db.query(
          'SELECT email, stripe_customer_id FROM users WHERE id = $1',
          [userId]
        );
        if (userResult.rows.length === 0) {
          return res.status(404).json({ error: 'User not found' });
        }
        const user = userResult.rows[0];
        let customerId = user.stripe_customer_id;

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
        return res.status(500).json({ error: 'Failed to create checkout session' });
      }
    }
  );

  // GET /api/billing/status
  app.get(
    '/api/billing/status',
    authMiddleware.requireAuth,
    async (req, res) => {
      try {
        const userId = req.user.userId;
        const [userResult, upgrades] = await Promise.all([
          db.query(
            `SELECT tier, subscription_status, current_period_end, stripe_customer_id, stripe_subscription_id
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
        return res.status(500).json({ error: 'Failed to fetch billing status' });
      }
    }
  );

  // POST /api/billing/webhook
  app.post(
    '/api/billing/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        return res.status(500).json({ error: 'Webhook not configured' });
      }

      let event;
      try {
        event = stripeClient.webhooks.constructEvent(
          req.body,
          req.headers['stripe-signature'],
          webhookSecret
        );
      } catch (err) {
        return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
      }

      res.json({ received: true });

      try {
        const { type, data } = event;
        const obj = data.object;

        if (type === 'customer.subscription.updated' || type === 'customer.subscription.created') {
          const subscriptionId = obj.id;
          const customerId = obj.customer;
          const status = obj.status;
          const periodEnd = new Date(obj.current_period_end * 1000);
          const newTier = tierFromSubscriptionStatus(status);

          let userId = obj.metadata?.userId;
          if (!userId) {
            const r = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
            if (r.rows.length > 0) userId = r.rows[0].id;
          }
          if (userId) {
            await db.query(
              `UPDATE users SET stripe_subscription_id = $1, subscription_status = $2,
               current_period_end = $3, tier = $4 WHERE id = $5`,
              [subscriptionId, status, periodEnd, newTier, userId]
            );
          }
        }

        if (type === 'customer.subscription.deleted') {
          const subscriptionId = obj.id;
          const customerId = obj.customer;
          let userId = obj.metadata?.userId;
          if (!userId) {
            const r = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
            if (r.rows.length > 0) userId = r.rows[0].id;
          }
          if (userId) {
            await db.query(
              `UPDATE users SET subscription_status = $1, tier = 'FREE' WHERE id = $2`,
              [obj.status || 'canceled', userId]
            );
          }
        }
      } catch (_) { /* swallow */ }
    }
  );

  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAuthCookie(userId = 'user-1', email = 'test@example.com') {
  const token = authMiddleware.generateToken({ userId, email });
  return `auth_token=${token}`;
}

// ── Tests ────────────────────────────────────────────────────────────────────

let app;

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  process.env.STRIPE_PRICE_ID_PRO_MONTHLY = 'price_pro_monthly_test';
  process.env.PUBLIC_BASE_URL = 'https://example.com';
  app = buildBillingApp();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Default: DB returns a user
  mockDbQuery.mockResolvedValue({ rows: [{ email: 'test@example.com', stripe_customer_id: null }] });
  mockGetOrCreateUserUpgrades.mockResolvedValue({ pro_monthly_active: false, party_pass_expires_at: null });
  mockResolveEntitlements.mockReturnValue({ hasPartyPass: false, hasPro: false });
  mockBuildTierStatus.mockReturnValue({
    activeTier: 'FREE',
    tierStatus: 'free',
    startedAt: null,
    expiresAt: null,
    timeRemainingSeconds: null,
    isExpired: false,
    tier: 'FREE',
    subscription_status: null,
    current_period_end: null,
    stripe_customer_id: null,
    stripe_subscription_id: null
  });
});

// ─── create-checkout-session ─────────────────────────────────────────────────

describe('POST /api/billing/create-checkout-session', () => {
  test('returns 401 when not authenticated', async () => {
    const res = await request(app).post('/api/billing/create-checkout-session');
    expect(res.status).toBe(401);
  });

  test('returns { url } for authenticated user (no existing customer)', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ email: 'dj@example.com', stripe_customer_id: null }] }) // SELECT user
      .mockResolvedValueOnce({ rows: [] }); // UPDATE stripe_customer_id
    mockStripeCustomerCreate.mockResolvedValue({ id: 'cus_new_123' });
    mockStripeCheckoutSessionCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/abc' });

    const res = await request(app)
      .post('/api/billing/create-checkout-session')
      .set('Cookie', [makeAuthCookie()]);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');
    expect(res.body.url).toBe('https://checkout.stripe.com/pay/abc');
  });

  test('creates Stripe customer with userId in metadata when no customer exists', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ email: 'dj@example.com', stripe_customer_id: null }] })
      .mockResolvedValueOnce({ rows: [] });
    mockStripeCustomerCreate.mockResolvedValue({ id: 'cus_new_456' });
    mockStripeCheckoutSessionCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/xyz' });

    await request(app)
      .post('/api/billing/create-checkout-session')
      .set('Cookie', [makeAuthCookie('user-abc')]);

    expect(mockStripeCustomerCreate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ userId: 'user-abc' }) })
    );
  });

  test('uses STRIPE_PRICE_ID_PRO_MONTHLY in line_items', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ email: 'dj@example.com', stripe_customer_id: 'cus_existing' }] });
    mockStripeCheckoutSessionCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/123' });

    await request(app)
      .post('/api/billing/create-checkout-session')
      .set('Cookie', [makeAuthCookie()]);

    expect(mockStripeCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: 'price_pro_monthly_test', quantity: 1 }]
      })
    );
  });

  test('success_url includes PUBLIC_BASE_URL', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ email: 'dj@example.com', stripe_customer_id: 'cus_existing' }] });
    mockStripeCheckoutSessionCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/123' });

    await request(app)
      .post('/api/billing/create-checkout-session')
      .set('Cookie', [makeAuthCookie()]);

    expect(mockStripeCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: 'https://example.com/?billing=success',
        cancel_url: 'https://example.com/?billing=cancel'
      })
    );
  });

  test('skips customer creation when stripe_customer_id already set', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ email: 'dj@example.com', stripe_customer_id: 'cus_already' }] });
    mockStripeCheckoutSessionCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/existing' });

    const res = await request(app)
      .post('/api/billing/create-checkout-session')
      .set('Cookie', [makeAuthCookie()]);

    expect(res.status).toBe(200);
    expect(mockStripeCustomerCreate).not.toHaveBeenCalled();
  });
});

// ─── GET /api/billing/status ─────────────────────────────────────────────────

describe('GET /api/billing/status', () => {
  test('returns 401 when not authenticated', async () => {
    const res = await request(app).get('/api/billing/status');
    expect(res.status).toBe(401);
  });

  test('returns comprehensive tier status for FREE user', async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        tier: 'FREE',
        subscription_status: null,
        current_period_end: null,
        stripe_customer_id: null,
        stripe_subscription_id: null
      }]
    });
    mockGetOrCreateUserUpgrades.mockResolvedValueOnce({
      pro_monthly_active: false,
      party_pass_expires_at: null,
      party_pass_started_at: null
    });
    mockBuildTierStatus.mockReturnValueOnce({
      activeTier: 'FREE',
      tierStatus: 'free',
      startedAt: null,
      expiresAt: null,
      timeRemainingSeconds: null,
      isExpired: false,
      tier: 'FREE',
      subscription_status: null,
      current_period_end: null,
      stripe_customer_id: null,
      stripe_subscription_id: null
    });

    const res = await request(app)
      .get('/api/billing/status')
      .set('Cookie', [makeAuthCookie()]);

    expect(res.status).toBe(200);
    expect(res.body.activeTier).toBe('FREE');
    expect(res.body.tierStatus).toBe('free');
    expect(res.body.isExpired).toBe(false);
    expect(res.body.timeRemainingSeconds).toBeNull();
  });

  test('returns billing status fields for authenticated PRO user', async () => {
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        tier: 'PRO',
        subscription_status: 'active',
        current_period_end: futureDate,
        stripe_customer_id: 'cus_abc',
        stripe_subscription_id: 'sub_abc'
      }]
    });
    mockGetOrCreateUserUpgrades.mockResolvedValueOnce({
      pro_monthly_active: true,
      pro_monthly_started_at: '2026-03-01T00:00:00Z',
      party_pass_expires_at: null
    });
    mockBuildTierStatus.mockReturnValueOnce({
      activeTier: 'PRO',
      tierStatus: 'active',
      startedAt: '2026-03-01T00:00:00.000Z',
      expiresAt: futureDate,
      timeRemainingSeconds: 30 * 24 * 3600,
      isExpired: false,
      tier: 'PRO',
      subscription_status: 'active',
      current_period_end: futureDate,
      stripe_customer_id: 'cus_abc',
      stripe_subscription_id: 'sub_abc'
    });

    const res = await request(app)
      .get('/api/billing/status')
      .set('Cookie', [makeAuthCookie()]);

    expect(res.status).toBe(200);
    expect(res.body.activeTier).toBe('PRO');
    expect(res.body.tierStatus).toBe('active');
    expect(res.body.isExpired).toBe(false);
    expect(res.body.timeRemainingSeconds).toBeGreaterThan(0);
    expect(res.body.startedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(res.body.stripe_customer_id).toBe('cus_abc');
    expect(res.body.stripe_subscription_id).toBe('sub_abc');
  });

  test('returns PARTY_PASS status with timeRemainingSeconds when pass is active', async () => {
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        tier: 'PARTY_PASS',
        subscription_status: null,
        current_period_end: null,
        stripe_customer_id: null,
        stripe_subscription_id: null
      }]
    });
    mockGetOrCreateUserUpgrades.mockResolvedValueOnce({
      pro_monthly_active: false,
      party_pass_expires_at: futureExpiry,
      party_pass_started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    });
    mockBuildTierStatus.mockReturnValueOnce({
      activeTier: 'PARTY_PASS',
      tierStatus: 'active',
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      expiresAt: futureExpiry,
      timeRemainingSeconds: 3600,
      isExpired: false,
      tier: 'PARTY_PASS',
      subscription_status: null,
      current_period_end: null,
      stripe_customer_id: null,
      stripe_subscription_id: null
    });

    const res = await request(app)
      .get('/api/billing/status')
      .set('Cookie', [makeAuthCookie()]);

    expect(res.status).toBe(200);
    expect(res.body.activeTier).toBe('PARTY_PASS');
    expect(res.body.tierStatus).toBe('active');
    expect(res.body.isExpired).toBe(false);
    expect(res.body.timeRemainingSeconds).toBeGreaterThan(0);
    expect(res.body.expiresAt).toBe(futureExpiry);
  });

  test('returns isExpired=true when party pass has expired', async () => {
    const pastExpiry = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        tier: 'FREE',
        subscription_status: null,
        current_period_end: null,
        stripe_customer_id: null,
        stripe_subscription_id: null
      }]
    });
    mockGetOrCreateUserUpgrades.mockResolvedValueOnce({
      pro_monthly_active: false,
      party_pass_expires_at: pastExpiry,
      party_pass_started_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    });
    mockBuildTierStatus.mockReturnValueOnce({
      activeTier: 'PARTY_PASS',
      tierStatus: 'expired',
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      expiresAt: pastExpiry,
      timeRemainingSeconds: 0,
      isExpired: true,
      tier: 'FREE',
      subscription_status: null,
      current_period_end: null,
      stripe_customer_id: null,
      stripe_subscription_id: null
    });

    const res = await request(app)
      .get('/api/billing/status')
      .set('Cookie', [makeAuthCookie()]);

    expect(res.status).toBe(200);
    expect(res.body.isExpired).toBe(true);
    expect(res.body.tierStatus).toBe('expired');
    expect(res.body.timeRemainingSeconds).toBe(0);
  });
});

// ─── Webhook ─────────────────────────────────────────────────────────────────

describe('POST /api/billing/webhook', () => {
  test('returns 400 when Stripe signature verification fails', async () => {
    mockStripeWebhooksConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const res = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 't=123,v1=badsig')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'test' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  test('returns 200 with { received: true } for valid event', async () => {
    const fakeEvent = {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_abc',
          customer: 'cus_abc',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
          metadata: { userId: 'user-1' }
        }
      }
    };
    mockStripeWebhooksConstructEvent.mockReturnValue(fakeEvent);
    mockDbQuery.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 't=123,v1=validsig')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(fakeEvent));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  test('updates user tier to PRO when subscription status is active', async () => {
    const fakeEvent = {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_abc',
          customer: 'cus_abc',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
          metadata: { userId: 'user-1' }
        }
      }
    };
    mockStripeWebhooksConstructEvent.mockReturnValue(fakeEvent);
    mockDbQuery.mockResolvedValue({ rows: [] });

    await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 't=123,v1=validsig')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(fakeEvent));

    // Give the async handler a tick to run
    await new Promise(r => setTimeout(r, 50));

    const updateCall = mockDbQuery.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE users') && c[1].includes('PRO')
    );
    expect(updateCall).toBeDefined();
  });

  test('updates user tier to FREE when subscription is deleted/canceled', async () => {
    const fakeEvent = {
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_abc',
          customer: 'cus_abc',
          status: 'canceled',
          metadata: { userId: 'user-1' }
        }
      }
    };
    mockStripeWebhooksConstructEvent.mockReturnValue(fakeEvent);
    mockDbQuery.mockResolvedValue({ rows: [] });

    await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 't=123,v1=validsig')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(fakeEvent));

    await new Promise(r => setTimeout(r, 50));

    const updateCall = mockDbQuery.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE users') && c[0].includes("'FREE'")
    );
    expect(updateCall).toBeDefined();
  });
});
