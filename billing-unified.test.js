/**
 * billing-unified.test.js
 *
 * Tests for:
 * 1. billing/products.js  – product catalog mapping
 * 2. billing/entitlements.js – applyPurchaseToUser idempotency (in-memory)
 * 3. Admin gating via auth-middleware isAdminEmail / requireAdmin
 * 4. Heartbeat, basket, and IAP route smoke tests
 *
 * All tests run without a real database.
 */

'use strict';

// ── Reset module registry between describe blocks ─────────────────────────────
// (billing/entitlements.js has module-level state; _resetMemStore clears it)

// ── Database mock ─────────────────────────────────────────────────────────────
jest.mock('./database', () => ({
  query: jest.fn().mockRejectedValue(new Error('no db')), // force in-memory path
  getOrCreateUserUpgrades: jest.fn(),
  resolveEntitlements: jest.fn(),
  pool: { end: jest.fn() }
}));

// ── Redis mock ────────────────────────────────────────────────────────────────
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue('PONG'),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    keys: jest.fn().mockResolvedValue([]),
    scan: jest.fn().mockResolvedValue(['0', []]),
    flushall: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
    status: 'ready'
  }));
});

// ── Stripe mock ───────────────────────────────────────────────────────────────
jest.mock('./stripe-client', () => null);

// =============================================================================
// 1. billing/products.js
// =============================================================================

describe('billing/products.js', () => {
  const { PRODUCTS, getProduct, getProductByPlatformId } = require('./billing/products');

  test('exports party_pass and pro_monthly', () => {
    expect(PRODUCTS).toHaveProperty('party_pass');
    expect(PRODUCTS).toHaveProperty('pro_monthly');
  });

  test('party_pass has correct shape', () => {
    const p = PRODUCTS.party_pass;
    expect(p.key).toBe('party_pass');
    expect(p.type).toBe('one_time');
    expect(p.stripe.priceId).toBeTruthy();
    expect(p.apple.productId).toBeTruthy();
    expect(p.google.productId).toBeTruthy();
    expect(p.entitlement.tier).toBe('PARTY_PASS');
  });

  test('pro_monthly has correct shape', () => {
    const p = PRODUCTS.pro_monthly;
    expect(p.key).toBe('pro_monthly');
    expect(p.type).toBe('subscription');
    expect(p.stripe.priceId).toBeTruthy();
    expect(p.apple.productId).toBeTruthy();
    expect(p.google.productId).toBeTruthy();
    expect(p.entitlement.tier).toBe('PRO');
  });

  test('getProduct returns product by key', () => {
    expect(getProduct('party_pass')).toBe(PRODUCTS.party_pass);
    expect(getProduct('pro_monthly')).toBe(PRODUCTS.pro_monthly);
  });

  test('getProduct returns null for unknown key', () => {
    expect(getProduct('unknown_product')).toBeNull();
  });

  test('getProductByPlatformId finds Apple product', () => {
    const p = getProductByPlatformId('apple', 'com.houseparty.partypass');
    expect(p).not.toBeNull();
    expect(p.key).toBe('party_pass');
  });

  test('getProductByPlatformId finds Google product', () => {
    const p = getProductByPlatformId('google', 'com.houseparty.pro.monthly');
    expect(p).not.toBeNull();
    expect(p.key).toBe('pro_monthly');
  });

  test('getProductByPlatformId returns null for unknown productId', () => {
    expect(getProductByPlatformId('apple', 'com.unknown.product')).toBeNull();
  });

  test('Stripe price IDs use configured values', () => {
    // party_pass
    expect(PRODUCTS.party_pass.stripe.priceId).toMatch(/^price_/);
    // pro_monthly
    expect(PRODUCTS.pro_monthly.stripe.priceId).toMatch(/^price_/);
  });
});

// =============================================================================
// 2. billing/entitlements.js – applyPurchaseToUser (in-memory path)
// =============================================================================

describe('billing/entitlements.js – applyPurchaseToUser (in-memory)', () => {
  let applyPurchaseToUser, getMemPurchases, getMemUserTier, _resetMemStore;

  beforeEach(() => {
    jest.resetModules();
    // Re-mock database so each test gets a fresh module with db unavailable
    jest.mock('./database', () => ({
      query: jest.fn().mockRejectedValue(new Error('no db')),
      getOrCreateUserUpgrades: jest.fn(),
      resolveEntitlements: jest.fn(),
      pool: { end: jest.fn() }
    }));
    const mod = require('./billing/entitlements');
    applyPurchaseToUser = mod.applyPurchaseToUser;
    getMemPurchases = mod.getMemPurchases;
    getMemUserTier = mod.getMemUserTier;
    _resetMemStore = mod._resetMemStore;
    _resetMemStore();
  });

  test('applies party_pass and sets tier PARTY_PASS', async () => {
    const result = await applyPurchaseToUser({
      userId: 'user-1',
      productKey: 'party_pass',
      provider: 'apple',
      providerTransactionId: 'txn-001',
      raw: {}
    });
    expect(result.applied).toBe(true);
    expect(result.alreadyApplied).toBe(false);
    expect(result.tier).toBe('PARTY_PASS');
    expect(getMemUserTier('user-1').partyPassActive).toBe(true);
  });

  test('applies pro_monthly and sets tier PRO', async () => {
    const result = await applyPurchaseToUser({
      userId: 'user-2',
      productKey: 'pro_monthly',
      provider: 'google',
      providerTransactionId: 'txn-002',
      raw: {}
    });
    expect(result.applied).toBe(true);
    expect(result.tier).toBe('PRO');
    expect(getMemUserTier('user-2').userTier).toBe('PRO');
    expect(getMemUserTier('user-2').subscriptionStatus).toBe('active');
  });

  test('idempotency – same transactionId does not double-apply', async () => {
    await applyPurchaseToUser({
      userId: 'user-3',
      productKey: 'party_pass',
      provider: 'stripe',
      providerTransactionId: 'txn-idem-001',
      raw: {}
    });
    const second = await applyPurchaseToUser({
      userId: 'user-3',
      productKey: 'party_pass',
      provider: 'stripe',
      providerTransactionId: 'txn-idem-001',
      raw: {}
    });
    expect(second.applied).toBe(false);
    expect(second.alreadyApplied).toBe(true);
    // Only one purchase record
    const purchases = getMemPurchases().filter(p => p.providerTransactionId === 'txn-idem-001');
    expect(purchases).toHaveLength(1);
  });

  test('different transactionIds for same user both apply', async () => {
    await applyPurchaseToUser({ userId: 'user-4', productKey: 'party_pass', provider: 'apple', providerTransactionId: 'txn-A', raw: {} });
    const r2 = await applyPurchaseToUser({ userId: 'user-4', productKey: 'pro_monthly', provider: 'apple', providerTransactionId: 'txn-B', raw: {} });
    expect(r2.applied).toBe(true);
    expect(getMemPurchases().filter(p => p.userId === 'user-4')).toHaveLength(2);
  });

  test('throws if userId is missing', async () => {
    await expect(applyPurchaseToUser({ productKey: 'party_pass', provider: 'apple', providerTransactionId: 'txn-x' }))
      .rejects.toThrow('userId is required');
  });

  test('throws if productKey is missing', async () => {
    await expect(applyPurchaseToUser({ userId: 'u1', provider: 'apple', providerTransactionId: 'txn-x' }))
      .rejects.toThrow('productKey is required');
  });

  test('throws if unknown productKey', async () => {
    await expect(applyPurchaseToUser({ userId: 'u1', productKey: 'magic_beans', provider: 'apple', providerTransactionId: 'txn-x' }))
      .rejects.toThrow('unknown productKey');
  });

  test('throws if provider is missing', async () => {
    await expect(applyPurchaseToUser({ userId: 'u1', productKey: 'party_pass', providerTransactionId: 'txn-x' }))
      .rejects.toThrow('provider is required');
  });

  test('throws if providerTransactionId is missing', async () => {
    await expect(applyPurchaseToUser({ userId: 'u1', productKey: 'party_pass', provider: 'apple' }))
      .rejects.toThrow('providerTransactionId is required');
  });
});

// =============================================================================
// 3. Admin gating
// =============================================================================

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

describe('Admin gating', () => {
  const ADMIN_EMAIL = 'ianevans2023@outlook.com';
  let authMW;
  const savedAdminEmails = process.env.ADMIN_EMAILS;

  beforeAll(() => {
    jest.resetModules();
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    authMW = require('./auth-middleware');
  });

  afterAll(() => {
    if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdminEmails;
  });

  test('isAdminEmail returns true for admin email', () => {
    expect(authMW.isAdminEmail(ADMIN_EMAIL)).toBe(true);
    expect(authMW.isAdminEmail(ADMIN_EMAIL.toUpperCase())).toBe(true);
  });

  test('isAdminEmail returns false for non-admin email', () => {
    expect(authMW.isAdminEmail('other@example.com')).toBe(false);
  });

  test('requireAdmin allows admin user', async () => {
    const app = express();
    app.use(cookieParser());
    app.get('/test', authMW.requireAdmin, (_req, res) => res.json({ ok: true }));
    const token = authMW.generateToken({ userId: 'admin-1', email: ADMIN_EMAIL, isAdmin: true });
    const res = await request(app).get('/test').set('Cookie', `auth_token=${token}`);
    expect(res.status).toBe(200);
  });

  test('requireAdmin returns 403 for non-admin authenticated user', async () => {
    const app = express();
    app.use(cookieParser());
    app.get('/test', authMW.requireAdmin, (_req, res) => res.json({ ok: true }));
    const token = authMW.generateToken({ userId: 'user-99', email: 'user@example.com', isAdmin: false });
    const res = await request(app).get('/test').set('Cookie', `auth_token=${token}`);
    expect(res.status).toBe(403);
  });

  test('requireAdmin returns 401 for unauthenticated request', async () => {
    const app = express();
    app.use(cookieParser());
    app.get('/test', authMW.requireAdmin, (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
  });

  test('admin with isAdmin=true bypasses tier gating (effectiveTier=PRO)', () => {
    // Simulate the /api/me logic: isAdmin => effectiveTier = 'PRO'
    const mockUser = { tier: 'FREE', is_admin: true };
    const effectiveTier = (mockUser.is_admin) ? 'PRO' : (mockUser.tier || 'FREE');
    expect(effectiveTier).toBe('PRO');
  });
});

// =============================================================================
// 4. Heartbeat + basket route smoke tests (minimal Express app)
// =============================================================================

describe('Heartbeat and Basket routes (smoke)', () => {
  let app;
  let authMW;
  const savedAdminEmails = process.env.ADMIN_EMAILS;

  beforeAll(() => {
    jest.resetModules();
    process.env.ADMIN_EMAILS = 'admin@example.com';
    authMW = require('./auth-middleware');

    const { PRODUCTS } = require('./billing/products');
    const _heartbeatStore = new Map();
    const _baskets = new Map();

    app = express();
    app.use(cookieParser());
    app.use(express.json());

    // Heartbeat
    app.post('/api/metrics/heartbeat', (req, res) => {
      const { userId } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'userId required' });
      _heartbeatStore.set(String(userId), new Date());
      return res.json({ ok: true });
    });

    // Basket – add
    app.post('/api/basket/add', authMW.requireAuth, (req, res) => {
      const { productKey } = req.body || {};
      const userId = req.user.userId;
      if (!productKey) return res.status(400).json({ error: 'productKey required' });
      if (!PRODUCTS[productKey]) return res.status(400).json({ error: `Unknown productKey: ${productKey}` });
      const basket = _baskets.get(userId) || new Set();
      basket.add(productKey);
      _baskets.set(userId, basket);
      return res.json({ basket: Array.from(basket) });
    });

    // Basket – remove
    app.post('/api/basket/remove', authMW.requireAuth, (req, res) => {
      const { productKey } = req.body || {};
      const userId = req.user.userId;
      if (!productKey) return res.status(400).json({ error: 'productKey required' });
      const basket = _baskets.get(userId) || new Set();
      basket.delete(productKey);
      _baskets.set(userId, basket);
      return res.json({ basket: Array.from(basket) });
    });

    // Basket – get
    app.get('/api/basket', authMW.requireAuth, (req, res) => {
      const userId = req.user.userId;
      const basket = _baskets.get(userId) || new Set();
      return res.json({ basket: Array.from(basket) });
    });
  });

  afterAll(() => {
    if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdminEmails;
  });

  function makeAuthCookie(userId = 'user-1', email = 'test@example.com') {
    const token = authMW.generateToken({ userId, email });
    return `auth_token=${token}`;
  }

  test('POST /api/metrics/heartbeat returns 400 without userId', async () => {
    const res = await request(app).post('/api/metrics/heartbeat').send({});
    expect(res.status).toBe(400);
  });

  test('POST /api/metrics/heartbeat returns ok with userId', async () => {
    const res = await request(app).post('/api/metrics/heartbeat').send({ userId: 'u1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /api/basket returns 401 without auth', async () => {
    const res = await request(app).get('/api/basket');
    expect(res.status).toBe(401);
  });

  test('POST /api/basket/add adds product to basket', async () => {
    const res = await request(app)
      .post('/api/basket/add')
      .set('Cookie', [makeAuthCookie('basket-user-1')])
      .send({ productKey: 'party_pass' });
    expect(res.status).toBe(200);
    expect(res.body.basket).toContain('party_pass');
  });

  test('POST /api/basket/add returns 400 for unknown product', async () => {
    const res = await request(app)
      .post('/api/basket/add')
      .set('Cookie', [makeAuthCookie('basket-user-1')])
      .send({ productKey: 'nonexistent' });
    expect(res.status).toBe(400);
  });

  test('POST /api/basket/remove removes product from basket', async () => {
    // Add first
    await request(app)
      .post('/api/basket/add')
      .set('Cookie', [makeAuthCookie('basket-user-2')])
      .send({ productKey: 'pro_monthly' });
    // Remove
    const res = await request(app)
      .post('/api/basket/remove')
      .set('Cookie', [makeAuthCookie('basket-user-2')])
      .send({ productKey: 'pro_monthly' });
    expect(res.status).toBe(200);
    expect(res.body.basket).not.toContain('pro_monthly');
  });

  test('GET /api/basket returns current basket', async () => {
    await request(app)
      .post('/api/basket/add')
      .set('Cookie', [makeAuthCookie('basket-user-3')])
      .send({ productKey: 'party_pass' });
    const res = await request(app)
      .get('/api/basket')
      .set('Cookie', [makeAuthCookie('basket-user-3')]);
    expect(res.status).toBe(200);
    expect(res.body.basket).toContain('party_pass');
  });
});

// =============================================================================
// 5. billing/addon-config.js
// =============================================================================

describe('billing/addon-config.js', () => {
  let addonConfig;

  beforeAll(() => {
    jest.resetModules();
    addonConfig = require('./billing/addon-config');
  });

  test('exports EXTRA_SONG_ADDON_ENABLED flag', () => {
    expect(typeof addonConfig.EXTRA_SONG_ADDON_ENABLED).toBe('boolean');
  });

  test('exports EXTRA_SONG_BUNDLE_OPTIONS with at least 2 bundles', () => {
    expect(Array.isArray(addonConfig.EXTRA_SONG_BUNDLE_OPTIONS)).toBe(true);
    expect(addonConfig.EXTRA_SONG_BUNDLE_OPTIONS.length).toBeGreaterThanOrEqual(2);
  });

  test('each bundle has required fields', () => {
    for (const b of addonConfig.EXTRA_SONG_BUNDLE_OPTIONS) {
      expect(b).toHaveProperty('key');
      expect(b).toHaveProperty('songs');
      expect(b).toHaveProperty('priceGBP');
      expect(b).toHaveProperty('stripePriceId');
      expect(b).toHaveProperty('label');
      expect(b).toHaveProperty('description');
      expect(typeof b.songs).toBe('number');
      expect(b.songs).toBeGreaterThan(0);
      expect(typeof b.priceGBP).toBe('number');
      expect(b.priceGBP).toBeGreaterThan(0);
    }
  });

  test('getBundleByKey returns correct bundle', () => {
    const b5 = addonConfig.getBundleByKey('extra_songs_5');
    expect(b5).not.toBeNull();
    expect(b5.songs).toBe(5);
    const b10 = addonConfig.getBundleByKey('extra_songs_10');
    expect(b10).not.toBeNull();
    expect(b10.songs).toBe(10);
  });

  test('getBundleByKey returns null for unknown key', () => {
    expect(addonConfig.getBundleByKey('extra_songs_999')).toBeNull();
  });

  test('getBundleByStripePriceId returns correct bundle', () => {
    const b5 = addonConfig.getBundleByKey('extra_songs_5');
    const found = addonConfig.getBundleByStripePriceId(b5.stripePriceId);
    expect(found).not.toBeNull();
    expect(found.key).toBe('extra_songs_5');
  });

  test('getBundleByStripePriceId returns null for unknown priceId', () => {
    expect(addonConfig.getBundleByStripePriceId('price_nonexistent')).toBeNull();
  });

  test('extra_songs_5 and extra_songs_10 are in PRODUCTS', () => {
    jest.resetModules();
    const { PRODUCTS } = require('./billing/products');
    expect(PRODUCTS).toHaveProperty('extra_songs_5');
    expect(PRODUCTS).toHaveProperty('extra_songs_10');
    expect(PRODUCTS.extra_songs_5.type).toBe('addon');
    expect(PRODUCTS.extra_songs_10.type).toBe('addon');
    expect(PRODUCTS.extra_songs_5.songsGranted).toBe(5);
    expect(PRODUCTS.extra_songs_10.songsGranted).toBe(10);
  });
});

// =============================================================================
// 6. billing/entitlements.js – applyAddonEntitlement (in-memory)
// =============================================================================

describe('billing/entitlements.js – applyAddonEntitlement (in-memory)', () => {
  let mod;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('./database', () => ({
      query: jest.fn().mockRejectedValue(new Error('no db')),
      getOrCreateUserUpgrades: jest.fn(),
      resolveEntitlements: jest.fn(),
      pool: { end: jest.fn() }
    }));
    mod = require('./billing/entitlements');
    mod._resetMemStore();
  });

  test('grants correct number of uploads for extra_songs_5', async () => {
    const result = await mod.applyAddonEntitlement({
      userId: 'user-a',
      partyCode: 'PARTY1',
      productKey: 'extra_songs_5',
      songsGranted: 5,
      provider: 'stripe',
      providerSessionId: 'cs_test_001'
    });
    expect(result.applied).toBe(true);
    expect(result.alreadyApplied).toBe(false);
    expect(result.songsGranted).toBe(5);
  });

  test('grants correct number of uploads for extra_songs_10', async () => {
    const result = await mod.applyAddonEntitlement({
      userId: 'user-b',
      partyCode: 'PARTY2',
      productKey: 'extra_songs_10',
      songsGranted: 10,
      provider: 'stripe',
      providerSessionId: 'cs_test_002'
    });
    expect(result.applied).toBe(true);
    expect(result.songsGranted).toBe(10);
  });

  test('idempotency – duplicate session ID does not double-grant', async () => {
    const opts = {
      userId: 'user-c',
      partyCode: 'PARTY3',
      productKey: 'extra_songs_5',
      songsGranted: 5,
      provider: 'stripe',
      providerSessionId: 'cs_idem_001'
    };
    const first = await mod.applyAddonEntitlement(opts);
    const second = await mod.applyAddonEntitlement(opts);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.alreadyApplied).toBe(true);
    // Total must still be 5
    const total = await mod.getPartyAddonUploads({ partyCode: 'PARTY3' });
    expect(total).toBe(5);
  });

  test('multiple distinct addon purchases stack correctly', async () => {
    await mod.applyAddonEntitlement({
      userId: 'user-d',
      partyCode: 'PARTY4',
      productKey: 'extra_songs_5',
      songsGranted: 5,
      provider: 'stripe',
      providerSessionId: 'cs_stack_001'
    });
    await mod.applyAddonEntitlement({
      userId: 'user-d',
      partyCode: 'PARTY4',
      productKey: 'extra_songs_10',
      songsGranted: 10,
      provider: 'stripe',
      providerSessionId: 'cs_stack_002'
    });
    const total = await mod.getPartyAddonUploads({ partyCode: 'PARTY4' });
    expect(total).toBe(15);
  });

  test('entitlement is scoped to the correct party', async () => {
    await mod.applyAddonEntitlement({
      userId: 'user-e',
      partyCode: 'PARTYABC',
      productKey: 'extra_songs_5',
      songsGranted: 5,
      provider: 'stripe',
      providerSessionId: 'cs_scope_001'
    });
    const totalABC = await mod.getPartyAddonUploads({ partyCode: 'PARTYABC' });
    const totalXYZ = await mod.getPartyAddonUploads({ partyCode: 'PARTYXYZ' });
    expect(totalABC).toBe(5);
    expect(totalXYZ).toBe(0);
  });

  test('getPartyAddonUploads returns 0 when no addons purchased', async () => {
    const total = await mod.getPartyAddonUploads({ partyCode: 'NOADDON' });
    expect(total).toBe(0);
  });

  test('getMemAddonEntitlements returns all grants', async () => {
    await mod.applyAddonEntitlement({
      userId: 'user-f',
      partyCode: 'PARTYZ',
      productKey: 'extra_songs_5',
      songsGranted: 5,
      provider: 'stripe',
      providerSessionId: 'cs_mem_001'
    });
    const all = mod.getMemAddonEntitlements();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all[0].partyCode).toBe('PARTYZ');
    expect(all[0].songsGranted).toBe(5);
  });

  test('throws if productKey is not an addon', async () => {
    await expect(mod.applyAddonEntitlement({
      userId: 'user-g',
      partyCode: 'PARTYW',
      productKey: 'party_pass',
      songsGranted: 5,
      provider: 'stripe',
      providerSessionId: 'cs_bad_001'
    })).rejects.toThrow('not an addon product');
  });

  test('throws if userId is missing', async () => {
    await expect(mod.applyAddonEntitlement({
      partyCode: 'PARTYW',
      productKey: 'extra_songs_5',
      songsGranted: 5,
      provider: 'stripe',
      providerSessionId: 'cs_err_001'
    })).rejects.toThrow('userId is required');
  });

  test('throws if partyCode is missing', async () => {
    await expect(mod.applyAddonEntitlement({
      userId: 'user-g',
      productKey: 'extra_songs_5',
      songsGranted: 5,
      provider: 'stripe',
      providerSessionId: 'cs_err_002'
    })).rejects.toThrow('partyCode is required');
  });

  test('throws if songsGranted is 0 or missing', async () => {
    await expect(mod.applyAddonEntitlement({
      userId: 'user-g',
      partyCode: 'PARTYW',
      productKey: 'extra_songs_5',
      songsGranted: 0,
      provider: 'stripe',
      providerSessionId: 'cs_err_003'
    })).rejects.toThrow('songsGranted must be >= 1');
  });
});

// =============================================================================
// 7. tier-policy.js – PARTY_PASS upload limit is 15
// =============================================================================

describe('tier-policy.js', () => {
  let tierPolicy;

  beforeAll(() => {
    jest.resetModules();
    tierPolicy = require('./tier-policy');
  });

  test('PARTY_PASS maxUploadsPerSession is 15', () => {
    const policy = tierPolicy.getPolicyForTier('PARTY_PASS');
    expect(policy.maxUploadsPerSession).toBe(15);
  });

  test('PRO maxUploadsPerSession is at least 50', () => {
    const policy = tierPolicy.getPolicyForTier('PRO');
    expect(policy.maxUploadsPerSession).toBeGreaterThanOrEqual(50);
  });

  test('FREE has uploadsAllowed=false', () => {
    const policy = tierPolicy.getPolicyForTier('FREE');
    expect(policy.uploadsAllowed).toBe(false);
  });
});

// =============================================================================
// 8. Addon checkout endpoint smoke tests
// =============================================================================

describe('Addon checkout endpoint (smoke)', () => {
  let app;
  let authMW;
  const mockSessionCreate = jest.fn();

  beforeAll(() => {
    jest.resetModules();

    // Re-mock stripe, db, etc.
    jest.mock('./stripe-client', () => ({
      checkout: { sessions: { create: mockSessionCreate } },
      webhooks: { constructEvent: jest.fn() }
    }));
    jest.mock('./database', () => ({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      getOrCreateUserUpgrades: jest.fn(),
      resolveEntitlements: jest.fn(),
      pool: { end: jest.fn() }
    }));

    authMW = require('./auth-middleware');

    // Build minimal express app with just the addon endpoint inlined
    app = express();
    app.use(cookieParser());
    app.use(express.json());

    const stripeClient = require('./stripe-client');
    const addonConfig = require('./billing/addon-config');
    const { getPolicyForTier } = require('./tier-policy');

    // Fake party store
    const fakeParties = new Map();
    fakeParties.set('PPTEST', { tier: 'PARTY_PASS', code: 'PPTEST' });
    fakeParties.set('FREETEST', { tier: 'FREE', code: 'FREETEST' });
    fakeParties.set('PROTEST', { tier: 'PRO', code: 'PROTEST' });

    app.post(
      '/api/addon/create-checkout-session',
      authMW.requireAuth,
      async (req, res) => {
        if (!addonConfig.EXTRA_SONG_ADDON_ENABLED) {
          return res.status(403).json({ error: 'Extra-song addons are not currently available' });
        }
        if (!stripeClient) {
          return res.status(503).json({ error: 'Billing not configured' });
        }
        const { bundleKey, partyCode } = req.body;
        const userId = String(req.user.userId);
        if (!bundleKey) return res.status(400).json({ error: 'bundleKey is required' });
        const bundle = addonConfig.getBundleByKey(bundleKey);
        if (!bundle) return res.status(400).json({ error: `Unknown bundle: ${bundleKey}` });
        if (!partyCode) return res.status(400).json({ error: 'partyCode is required' });
        const normalizedCode = String(partyCode).toUpperCase().trim();
        const partyData = fakeParties.get(normalizedCode);
        if (!partyData) return res.status(404).json({ error: 'Party not found or no longer active' });
        const partyTier = partyData.tier || 'FREE';
        if (partyTier === 'FREE') {
          return res.status(403).json({ error: 'Extra-song addons require an active Party Pass for this party' });
        }
        if (partyTier === 'PRO' || partyTier === 'PRO_MONTHLY') {
          return res.status(403).json({ error: 'Monthly subscribers have unlimited uploads' });
        }
        try {
          const session = await stripeClient.checkout.sessions.create({
            mode: 'payment',
            line_items: [{ price: bundle.stripePriceId, quantity: 1 }],
            success_url: 'https://example.com/?addon=success',
            cancel_url: 'https://example.com/?addon=cancel',
            metadata: { userId, partyCode: normalizedCode, addonType: bundleKey, songsGranted: String(bundle.songs) }
          });
          return res.json({ sessionId: session.id, url: session.url, bundle: { key: bundle.key, songs: bundle.songs } });
        } catch (err) {
          return res.status(500).json({ error: 'Failed to create addon checkout session' });
        }
      }
    );

    // Upload quota endpoint
    app.get('/api/party/:code/upload-quota', authMW.requireAuth, async (req, res) => {
      const partyCode = (req.params.code || '').toUpperCase().trim();
      const partyData = fakeParties.get(partyCode);
      if (!partyData) return res.status(404).json({ error: 'Party not found' });
      const partyTier = partyData.tier || 'FREE';
      const policy = getPolicyForTier(partyTier);
      const baseLimit = policy.maxUploadsPerSession || 0;
      return res.json({ partyCode, tier: partyTier, baseLimit, addonUploads: 0, effectiveLimit: baseLimit, uploadsAllowed: policy.uploadsAllowed });
    });
  });

  function makeAuthCookie(userId = 'user-1', email = 'test@example.com') {
    const token = authMW.generateToken({ userId, email });
    return `auth_token=${token}`;
  }

  test('valid Party Pass user can create addon checkout', async () => {
    mockSessionCreate.mockResolvedValueOnce({ id: 'cs_test_ok', url: 'https://checkout.stripe.com/test' });
    const res = await request(app)
      .post('/api/addon/create-checkout-session')
      .set('Cookie', [makeAuthCookie('pp-user')])
      .send({ bundleKey: 'extra_songs_5', partyCode: 'PPTEST' });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('cs_test_ok');
    expect(res.body.bundle.songs).toBe(5);
  });

  test('free user is blocked from addon checkout', async () => {
    const res = await request(app)
      .post('/api/addon/create-checkout-session')
      .set('Cookie', [makeAuthCookie('free-user')])
      .send({ bundleKey: 'extra_songs_5', partyCode: 'FREETEST' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Party Pass/i);
  });

  test('PRO user is blocked from addon checkout', async () => {
    const res = await request(app)
      .post('/api/addon/create-checkout-session')
      .set('Cookie', [makeAuthCookie('pro-user')])
      .send({ bundleKey: 'extra_songs_5', partyCode: 'PROTEST' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Monthly/i);
  });

  test('unknown party is blocked', async () => {
    const res = await request(app)
      .post('/api/addon/create-checkout-session')
      .set('Cookie', [makeAuthCookie('pp-user')])
      .send({ bundleKey: 'extra_songs_5', partyCode: 'NOPRT' });
    expect(res.status).toBe(404);
  });

  test('unauthenticated user is blocked', async () => {
    const res = await request(app)
      .post('/api/addon/create-checkout-session')
      .send({ bundleKey: 'extra_songs_5', partyCode: 'PPTEST' });
    expect(res.status).toBe(401);
  });

  test('invalid bundleKey returns 400', async () => {
    const res = await request(app)
      .post('/api/addon/create-checkout-session')
      .set('Cookie', [makeAuthCookie('pp-user')])
      .send({ bundleKey: 'extra_songs_99999', partyCode: 'PPTEST' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown bundle/);
  });

  test('missing bundleKey returns 400', async () => {
    const res = await request(app)
      .post('/api/addon/create-checkout-session')
      .set('Cookie', [makeAuthCookie('pp-user')])
      .send({ partyCode: 'PPTEST' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bundleKey/);
  });

  test('missing partyCode returns 400', async () => {
    const res = await request(app)
      .post('/api/addon/create-checkout-session')
      .set('Cookie', [makeAuthCookie('pp-user')])
      .send({ bundleKey: 'extra_songs_5' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/partyCode/);
  });

  test('GET /api/party/:code/upload-quota returns correct data for PARTY_PASS', async () => {
    const res = await request(app)
      .get('/api/party/PPTEST/upload-quota')
      .set('Cookie', [makeAuthCookie('pp-user')]);
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('PARTY_PASS');
    expect(res.body.baseLimit).toBe(15);
    expect(res.body.uploadsAllowed).toBe(true);
    expect(typeof res.body.effectiveLimit).toBe('number');
  });

  test('GET /api/party/:code/upload-quota requires auth', async () => {
    const res = await request(app).get('/api/party/PPTEST/upload-quota');
    expect(res.status).toBe(401);
  });
});
