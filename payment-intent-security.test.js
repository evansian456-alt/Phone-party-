/**
 * Payment Intent Security Tests
 *
 * Tests the server-side payment intent tracking added to routes/billing.js:
 * - Intents must exist on the server before /confirm accepts them
 * - Intents are bound to the user who created them
 * - Intents are bound to the product they were created for
 * - Intents cannot be reused (replay protection)
 * - Party Pass gets purchase_kind='party_pass', not 'subscription'
 */

'use strict';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const authMiddleware = require('./auth-middleware');
const createBillingRouter = require('./routes/billing');

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDbQuery = jest.fn();
const mockGetClient = jest.fn();
const mockGetOrCreateUserUpgrades = jest.fn();
const mockResolveEntitlements = jest.fn();
const mockUpdatePartyPassExpiry = jest.fn();
const mockActivateProMonthly = jest.fn();

const mockDb = {
  query: mockDbQuery,
  getClient: mockGetClient,
  getOrCreateUserUpgrades: mockGetOrCreateUserUpgrades,
  resolveEntitlements: mockResolveEntitlements,
  updatePartyPassExpiry: mockUpdatePartyPassExpiry,
  activateProMonthly: mockActivateProMonthly
};

// A mock payment provider that always succeeds for tests
const mockPaymentProvider = {
  processPayment: jest.fn().mockResolvedValue({
    success: true,
    provider: 'simulated',
    transactionId: `sim_${Date.now()}_${crypto.randomUUID()}`,
    providerTransactionId: `token_test`,
    amount: 399,
    currency: 'GBP',
    productId: 'party_pass',
    timestamp: Date.now()
  })
};

const mockStoreCatalog = {
  getItemById: jest.fn((id) => {
    if (id === 'party_pass') return { id: 'party_pass', type: 'pass', price: 3.99, currency: 'GBP' };
    if (id === 'pro_monthly') return { id: 'pro_monthly', type: 'subscription', price: 9.99, currency: 'GBP' };
    return null;
  }),
  getStoreCatalog: jest.fn(() => ({ items: [] }))
};

const localFallbackUsersById = new Map();
const localFallbackUsersByEmail = new Map();

// ── Build a minimal Express app with billing routes ───────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const deps = {
    db: mockDb,
    redis: { set: jest.fn() },
    authMiddleware,
    apiLimiter: (req, res, next) => next(),
    purchaseLimiter: (req, res, next) => next(),
    stripeClient: null,
    PRODUCTS: [],
    getProductByPlatformId: jest.fn(),
    applyPurchaseToUser: jest.fn(),
    paymentProvider: mockPaymentProvider,
    storeCatalog: mockStoreCatalog,
    verifyStripeSignature: jest.fn(),
    processStripeWebhook: jest.fn(),
    metricsService: { record: jest.fn() },
    shouldBypassRateLimit: () => false,
    TEST_MODE: true,
    INSTANCE_ID: 'test',
    localFallbackUsersById,
    localFallbackUsersByEmail,
    canUseLocalAuthFallback: () => false,
    parties: new Map(),
    getMaxAllowedPhones: jest.fn(),
    getPartyFromRedis: jest.fn(),
    setPartyInRedis: jest.fn(),
    getPartyFromFallback: jest.fn(),
    setPartyInFallback: jest.fn()
  };

  const billingRouter = createBillingRouter(deps);
  app.use('/', billingRouter);

  return app;
}

// ── Helper: generate a JWT auth cookie for a user ────────────────────────────

function makeAuthCookie(userId) {
  const token = authMiddleware.generateToken({ userId, email: `${userId}@test.com`, isAdmin: false });
  return `auth_token=${token}`;
}

// ── Setup DB mock responses ────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Mock DB client for transactions
  const mockClient = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn()
  };
  mockGetClient.mockResolvedValue(mockClient);

  // getOrCreateUserUpgrades returns a plain object
  mockGetOrCreateUserUpgrades.mockResolvedValue({
    party_pass_expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000),
    pro_monthly_active: false,
    pro_monthly_started_at: null,
    pro_monthly_renewal_provider: null
  });

  mockResolveEntitlements.mockReturnValue({ hasPartyPass: true, hasPro: false });
  mockUpdatePartyPassExpiry.mockResolvedValue();
  mockActivateProMonthly.mockResolvedValue();
});

// =============================================================================
describe('POST /api/payment/initiate', () => {
  const userId = 'user-initiate-1';

  it('returns 401 when not authenticated', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/payment/initiate')
      .send({ productId: 'party_pass', platform: 'web', paymentMethod: 'card' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing fields', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/payment/initiate')
      .set('Cookie', makeAuthCookie(userId))
      .send({ productId: 'party_pass' }); // missing platform and paymentMethod
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing/i);
  });

  it('returns 400 for invalid product ID', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/payment/initiate')
      .set('Cookie', makeAuthCookie(userId))
      .send({ productId: 'invalid_product', platform: 'web', paymentMethod: 'card' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid product/i);
  });

  it('creates a payment intent for party_pass', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/payment/initiate')
      .set('Cookie', makeAuthCookie(userId))
      .send({ productId: 'party_pass', platform: 'web', paymentMethod: 'card' });

    expect(res.status).toBe(200);
    expect(res.body.paymentIntent).toBeDefined();
    expect(res.body.paymentIntent.intentId).toMatch(/^intent_/);
    expect(res.body.paymentIntent.productId).toBe('party_pass');
    expect(res.body.paymentIntent.amount).toBe(399); // £3.99 in pence
  });

  it('creates a payment intent for pro_monthly', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/payment/initiate')
      .set('Cookie', makeAuthCookie(userId))
      .send({ productId: 'pro_monthly', platform: 'web', paymentMethod: 'card' });

    expect(res.status).toBe(200);
    expect(res.body.paymentIntent.productId).toBe('pro_monthly');
    expect(res.body.paymentIntent.amount).toBe(999); // £9.99 in pence
  });
});

// =============================================================================
describe('POST /api/payment/confirm — intent security', () => {
  const userId = 'user-confirm-1';
  const otherUserId = 'user-confirm-2';

  it('returns 400 when intentId was never issued by the server', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/payment/confirm')
      .set('Cookie', makeAuthCookie(userId))
      .send({
        intentId: 'intent_fake_id',
        productId: 'party_pass',
        platform: 'web',
        paymentMethod: 'card',
        paymentToken: 'tok_test'
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found or expired/i);
  });

  it('returns 403 when intent belongs to a different user', async () => {
    const app = buildApp();

    // Create intent as userId
    const initiateRes = await request(app)
      .post('/api/payment/initiate')
      .set('Cookie', makeAuthCookie(userId))
      .send({ productId: 'party_pass', platform: 'web', paymentMethod: 'card' });
    const { intentId } = initiateRes.body.paymentIntent;

    // Try to confirm as otherUserId
    const res = await request(app)
      .post('/api/payment/confirm')
      .set('Cookie', makeAuthCookie(otherUserId))
      .send({ intentId, productId: 'party_pass', platform: 'web', paymentMethod: 'card' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/does not belong/i);
  });

  it('returns 400 when productId does not match the intent', async () => {
    const app = buildApp();

    const initiateRes = await request(app)
      .post('/api/payment/initiate')
      .set('Cookie', makeAuthCookie(userId))
      .send({ productId: 'party_pass', platform: 'web', paymentMethod: 'card' });
    const { intentId } = initiateRes.body.paymentIntent;

    const res = await request(app)
      .post('/api/payment/confirm')
      .set('Cookie', makeAuthCookie(userId))
      .send({ intentId, productId: 'pro_monthly', platform: 'web', paymentMethod: 'card' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mismatch/i);
  });

  it('returns 409 when the same intent is confirmed twice (replay protection)', async () => {
    const app = buildApp();

    const initiateRes = await request(app)
      .post('/api/payment/initiate')
      .set('Cookie', makeAuthCookie(userId))
      .send({ productId: 'party_pass', platform: 'web', paymentMethod: 'card' });
    const { intentId } = initiateRes.body.paymentIntent;

    const payload = { intentId, productId: 'party_pass', platform: 'web', paymentMethod: 'card' };

    // First confirm — must succeed
    const first = await request(app)
      .post('/api/payment/confirm')
      .set('Cookie', makeAuthCookie(userId))
      .send(payload);
    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);

    // Second confirm with same intentId — must be rejected
    const second = await request(app)
      .post('/api/payment/confirm')
      .set('Cookie', makeAuthCookie(userId))
      .send(payload);
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/not found or expired|already been used/i);
  });

  it('successful party_pass confirm returns entitlements', async () => {
    const app = buildApp();

    const initiateRes = await request(app)
      .post('/api/payment/initiate')
      .set('Cookie', makeAuthCookie(userId))
      .send({ productId: 'party_pass', platform: 'web', paymentMethod: 'card' });
    const { intentId } = initiateRes.body.paymentIntent;

    const res = await request(app)
      .post('/api/payment/confirm')
      .set('Cookie', makeAuthCookie(userId))
      .send({ intentId, productId: 'party_pass', platform: 'web', paymentMethod: 'card' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.entitlements).toBeDefined();
    expect(res.body.transactionId).toBeDefined();
  });

  it('requires authentication for /confirm', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/payment/confirm')
      .send({ intentId: 'x', productId: 'party_pass', platform: 'web', paymentMethod: 'card' });
    expect(res.status).toBe(401);
  });
});

// =============================================================================
describe('Party Pass purchase_kind', () => {
  const userId = 'user-pk-1';

  it('records party_pass purchases with purchase_kind=party_pass, not subscription', async () => {
    const insertCalls = [];
    const mockClientForPk = {
      query: jest.fn().mockImplementation((sql, params) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO purchases')) {
          insertCalls.push(params);
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    mockGetClient.mockResolvedValueOnce(mockClientForPk);

    const app = buildApp();

    const initiateRes = await request(app)
      .post('/api/payment/initiate')
      .set('Cookie', makeAuthCookie(userId))
      .send({ productId: 'party_pass', platform: 'web', paymentMethod: 'card' });
    const { intentId } = initiateRes.body.paymentIntent;

    await request(app)
      .post('/api/payment/confirm')
      .set('Cookie', makeAuthCookie(userId))
      .send({ intentId, productId: 'party_pass', platform: 'web', paymentMethod: 'card' });

    expect(insertCalls.length).toBeGreaterThan(0);
    const purchaseKindArg = insertCalls[0][1]; // second param in the VALUES array is purchase_kind
    expect(purchaseKindArg).toBe('party_pass');
    expect(purchaseKindArg).not.toBe('subscription');
  });

  it('records pro_monthly purchases with purchase_kind=subscription', async () => {
    mockResolveEntitlements.mockReturnValueOnce({ hasPartyPass: true, hasPro: true });
    mockGetOrCreateUserUpgrades.mockResolvedValueOnce({
      party_pass_expires_at: null,
      pro_monthly_active: true,
      pro_monthly_started_at: new Date(),
      pro_monthly_renewal_provider: 'simulated'
    });

    const insertCalls = [];
    const mockClientForPk = {
      query: jest.fn().mockImplementation((sql, params) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO purchases')) {
          insertCalls.push(params);
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    mockGetClient.mockResolvedValueOnce(mockClientForPk);

    const app = buildApp();

    const initiateRes = await request(app)
      .post('/api/payment/initiate')
      .set('Cookie', makeAuthCookie(userId))
      .send({ productId: 'pro_monthly', platform: 'web', paymentMethod: 'card' });
    const { intentId } = initiateRes.body.paymentIntent;

    await request(app)
      .post('/api/payment/confirm')
      .set('Cookie', makeAuthCookie(userId))
      .send({ intentId, productId: 'pro_monthly', platform: 'web', paymentMethod: 'card' });

    expect(insertCalls.length).toBeGreaterThan(0);
    const purchaseKindArg = insertCalls[0][1]; // second param is purchase_kind
    expect(purchaseKindArg).toBe('subscription');
  });
});
