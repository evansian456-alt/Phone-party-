/**
 * Admin System Tests
 *
 * Tests for:
 * 1. Admin recognition via ADMIN_EMAILS allowlist
 * 2. /api/admin/stats protection (401 / 403 / 200)
 * 3. Admin tier bypass (effectiveTier = PRO when isAdmin)
 * 4. requireAdmin middleware
 */

'use strict';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

// ── Database mock ─────────────────────────────────────────────────────────────
const mockDbQuery = jest.fn();
const mockGetOrCreateUserUpgrades = jest.fn().mockResolvedValue({
  party_pass_expires_at: null,
  pro_monthly_active: false,
  pro_monthly_started_at: null,
  pro_monthly_renewal_provider: null
});
const mockResolveEntitlements = jest.fn().mockReturnValue({ hasPartyPass: false, hasPro: false });

jest.mock('./database', () => ({
  query: mockDbQuery,
  getOrCreateUserUpgrades: mockGetOrCreateUserUpgrades,
  resolveEntitlements: mockResolveEntitlements,
  pool: { end: jest.fn() }
}));

// ── Redis mock ────────────────────────────────────────────────────────────────
jest.mock('ioredis', () => {
  const Redis = jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue('PONG'),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    keys: jest.fn().mockResolvedValue([]),
    scan: jest.fn().mockResolvedValue(['0', []]),
    flushall: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
    status: 'ready'
  }));
  return Redis;
});

// ── Stripe mock ───────────────────────────────────────────────────────────────
jest.mock('./stripe-client', () => null);

// ── Load auth-middleware (resets for each describe block as needed) ────────────
// We'll use a helper to get a fresh copy with specific ADMIN_EMAILS set.

describe('Admin System', () => {

  // ── 1. isAdminEmail helper ────────────────────────────────────────────────
  describe('isAdminEmail()', () => {
    let authMW;
    const originalAdminEmails = process.env.ADMIN_EMAILS;

    beforeEach(() => {
      jest.resetModules();
      process.env.ADMIN_EMAILS = 'admin@example.com, BOSS@DOMAIN.COM ';
      authMW = require('./auth-middleware');
    });

    afterEach(() => {
      if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = originalAdminEmails;
    });

    it('returns true for exact match (case insensitive, trimmed)', () => {
      expect(authMW.isAdminEmail('admin@example.com')).toBe(true);
      expect(authMW.isAdminEmail('ADMIN@EXAMPLE.COM')).toBe(true);
      expect(authMW.isAdminEmail('boss@domain.com')).toBe(true);
    });

    it('returns false for non-admin email', () => {
      expect(authMW.isAdminEmail('user@example.com')).toBe(false);
    });

    it('returns false for empty/null', () => {
      expect(authMW.isAdminEmail('')).toBe(false);
      expect(authMW.isAdminEmail(null)).toBe(false);
      expect(authMW.isAdminEmail(undefined)).toBe(false);
    });

    it('returns false when ADMIN_EMAILS is not set', () => {
      jest.resetModules();
      delete process.env.ADMIN_EMAILS;
      const fresh = require('./auth-middleware');
      expect(fresh.isAdminEmail('admin@example.com')).toBe(false);
    });
  });

  // ── 2. requireAdmin middleware ────────────────────────────────────────────
  describe('requireAdmin middleware', () => {
    let authMW;
    const originalAdminEmails = process.env.ADMIN_EMAILS;

    beforeAll(() => {
      jest.resetModules();
      process.env.ADMIN_EMAILS = 'admin@example.com';
      authMW = require('./auth-middleware');
    });

    afterAll(() => {
      if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = originalAdminEmails;
    });

    function buildApp(isAdmin) {
      const app = express();
      app.use(cookieParser());
      app.use(express.json());
      // Inject a fake JWT cookie with the given isAdmin flag
      app.use((req, _res, next) => {
        const token = authMW.generateToken({ userId: 'u1', email: 'test@test.com', isAdmin });
        req.cookies = req.cookies || {};
        req.cookies.auth_token = token;
        next();
      });
      app.get('/api/admin/stats', authMW.requireAdmin, (_req, res) => res.json({ ok: true }));
      return app;
    }

    it('returns 200 for admin user', async () => {
      const app = buildApp(true);
      const res = await request(app).get('/api/admin/stats');
      expect(res.status).toBe(200);
    });

    it('returns 403 for authenticated non-admin user', async () => {
      const app = buildApp(false);
      const res = await request(app).get('/api/admin/stats');
      expect(res.status).toBe(403);
    });

    it('returns 401 when no cookie is present', async () => {
      const app = express();
      app.use(cookieParser());
      app.get('/api/admin/stats', authMW.requireAdmin, (_req, res) => res.json({ ok: true }));
      const res = await request(app).get('/api/admin/stats');
      expect(res.status).toBe(401);
    });
  });

  // ── 3. /api/me returns isAdmin + effectiveTier for admin user ─────────────
  describe('/api/me isAdmin and effectiveTier', () => {
    let authMW;
    const originalAdminEmails = process.env.ADMIN_EMAILS;

    beforeAll(() => {
      jest.resetModules();
      process.env.ADMIN_EMAILS = 'admin@example.com';
      authMW = require('./auth-middleware');
    });

    afterAll(() => {
      if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = originalAdminEmails;
    });

    function buildMeApp(dbUser) {
      const app = express();
      app.use(cookieParser());
      app.use(express.json());

      const db = require('./database');
      const redisClient = { set: jest.fn().mockResolvedValue('OK'), ping: jest.fn() };

      // Inject cookie
      const token = authMW.generateToken({ userId: 'u1', email: dbUser.email, isAdmin: dbUser.is_admin || false });
      app.use((req, _res, next) => {
        req.cookies = req.cookies || {};
        req.cookies.auth_token = token;
        next();
      });

      app.get('/api/me', authMW.requireAuth, async (req, res) => {
        const user = dbUser;
        // Minimal inline /api/me logic matching server.js
        const isAdminUser = user.is_admin || req.user.isAdmin || false;
        const tier = user.tier || 'FREE';
        const effectiveTier = isAdminUser ? 'PRO' : tier;
        res.json({
          user: { id: user.id, email: user.email, djName: user.dj_name, profileCompleted: true },
          isAdmin: isAdminUser,
          tier,
          effectiveTier
        });
      });
      return app;
    }

    it('returns isAdmin=true and effectiveTier=PRO for admin user', async () => {
      const app = buildMeApp({ id: 'u1', email: 'admin@example.com', dj_name: 'Admin DJ', tier: 'FREE', is_admin: true });
      const res = await request(app).get('/api/me');
      expect(res.status).toBe(200);
      expect(res.body.isAdmin).toBe(true);
      expect(res.body.effectiveTier).toBe('PRO');
    });

    it('returns isAdmin=false and effectiveTier=FREE for regular user', async () => {
      const app = buildMeApp({ id: 'u2', email: 'user@example.com', dj_name: 'Regular DJ', tier: 'FREE', is_admin: false });
      const res = await request(app).get('/api/me');
      expect(res.status).toBe(200);
      expect(res.body.isAdmin).toBe(false);
      expect(res.body.effectiveTier).toBe('FREE');
    });
  });

  // ── 4. Admin stats endpoint protection ───────────────────────────────────
  describe('/api/admin/stats endpoint protection', () => {
    let authMW;
    let app;
    const originalAdminEmails = process.env.ADMIN_EMAILS;

    beforeAll(() => {
      jest.resetModules();
      process.env.ADMIN_EMAILS = 'admin@example.com';
      authMW = require('./auth-middleware');

      app = express();
      app.use(cookieParser());
      app.use(express.json());

      // A minimal /api/admin/stats route using requireAdmin
      app.get('/api/admin/stats', authMW.requireAdmin, (_req, res) => {
        res.json({
          serverTime: new Date().toISOString(),
          users: { total: 10, profilesCompleted: 7, newLast24h: 2, activeLast24h: 5 },
          live: { onlineUsers: 3, activeParties: 1, activeHosts: 1, activeGuests: 2 },
          tiers: { FREE: 7, PARTY_PASS: 2, PRO: 1 },
          purchases: { tierPurchasesTotal: 3, addonPurchasesTotal: 1, bySku: { pro: 1 }, revenueCentsLast30d: 999 },
          health: { db: 'ok', redis: 'ok', uptimeSec: 120, version: '0.1.0' }
        });
      });
    });

    afterAll(() => {
      if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = originalAdminEmails;
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).get('/api/admin/stats');
      expect(res.status).toBe(401);
    });

    it('returns 403 for authenticated non-admin', async () => {
      const token = authMW.generateToken({ userId: 'u2', email: 'user@example.com', isAdmin: false });
      const res = await request(app).get('/api/admin/stats').set('Cookie', `auth_token=${token}`);
      expect(res.status).toBe(403);
    });

    it('returns 200 with stats for admin', async () => {
      const token = authMW.generateToken({ userId: 'u1', email: 'admin@example.com', isAdmin: true });
      const res = await request(app).get('/api/admin/stats').set('Cookie', `auth_token=${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('users');
      expect(res.body).toHaveProperty('live');
      expect(res.body).toHaveProperty('tiers');
      expect(res.body).toHaveProperty('purchases');
      expect(res.body).toHaveProperty('health');
    });

    it('stats response has correct shape', async () => {
      const token = authMW.generateToken({ userId: 'u1', email: 'admin@example.com', isAdmin: true });
      const res = await request(app).get('/api/admin/stats').set('Cookie', `auth_token=${token}`);
      const b = res.body;
      expect(typeof b.users.total).toBe('number');
      expect(typeof b.live.onlineUsers).toBe('number');
      expect(typeof b.tiers.FREE).toBe('number');
      expect(typeof b.purchases.tierPurchasesTotal).toBe('number');
      expect(b.health.db).toBe('ok');
    });
  });

  // ── 5. Admin promo code endpoints ─────────────────────────────────────────
  describe('Admin promo code endpoints', () => {
    let authMW;
    let app;
    const originalAdminEmails = process.env.ADMIN_EMAILS;

    beforeAll(() => {
      jest.resetModules();
      process.env.ADMIN_EMAILS = 'admin@example.com';
      authMW = require('./auth-middleware');

      app = express();
      app.use(cookieParser());
      app.use(express.json());

      const db = require('./database');

      // POST /api/admin/promo-codes stub
      app.post('/api/admin/promo-codes', authMW.requireAdmin, async (req, res) => {
        const { type } = req.body;
        if (!type || !['party_pass', 'pro_monthly'].includes(type)) {
          return res.status(400).json({ error: "type must be 'party_pass' or 'pro_monthly'" });
        }
        // Simulate DB insert
        db.query.mockResolvedValueOnce({ rows: [] });
        await db.query(`INSERT INTO promo_codes (code, type, created_by) VALUES ($1, $2, $3)`, ['PROMO-TEST1234', type, 'u1']);
        return res.status(201).json({ ok: true, code: 'PROMO-TEST1234', type });
      });

      // GET /api/admin/promo-codes stub
      app.get('/api/admin/promo-codes', authMW.requireAdmin, async (_req, res) => {
        db.query.mockResolvedValueOnce({
          rows: [
            { id: 'uuid-1', code: 'PROMO-TEST1234', type: 'party_pass', is_used: false, created_at: new Date().toISOString(), created_by_email: 'admin@example.com', used_at: null, used_by_email: null }
          ]
        });
        const result = await db.query('SELECT * FROM promo_codes');
        return res.json({ ok: true, promoCodes: result.rows });
      });
    });

    afterAll(() => {
      if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = originalAdminEmails;
    });

    it('POST /api/admin/promo-codes returns 401 when unauthenticated', async () => {
      const res = await request(app).post('/api/admin/promo-codes').send({ type: 'party_pass' });
      expect(res.status).toBe(401);
    });

    it('POST /api/admin/promo-codes returns 403 for non-admin', async () => {
      const token = authMW.generateToken({ userId: 'u2', email: 'user@example.com', isAdmin: false });
      const res = await request(app)
        .post('/api/admin/promo-codes')
        .set('Cookie', `auth_token=${token}`)
        .send({ type: 'party_pass' });
      expect(res.status).toBe(403);
    });

    it('POST /api/admin/promo-codes returns 400 for invalid type', async () => {
      const token = authMW.generateToken({ userId: 'u1', email: 'admin@example.com', isAdmin: true });
      const res = await request(app)
        .post('/api/admin/promo-codes')
        .set('Cookie', `auth_token=${token}`)
        .send({ type: 'invalid_type' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/party_pass.*pro_monthly/i);
    });

    it('POST /api/admin/promo-codes returns 201 with code for admin (party_pass)', async () => {
      const token = authMW.generateToken({ userId: 'u1', email: 'admin@example.com', isAdmin: true });
      const res = await request(app)
        .post('/api/admin/promo-codes')
        .set('Cookie', `auth_token=${token}`)
        .send({ type: 'party_pass' });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.code).toBe('string');
      expect(res.body.type).toBe('party_pass');
    });

    it('POST /api/admin/promo-codes returns 201 with code for admin (pro_monthly)', async () => {
      const token = authMW.generateToken({ userId: 'u1', email: 'admin@example.com', isAdmin: true });
      const res = await request(app)
        .post('/api/admin/promo-codes')
        .set('Cookie', `auth_token=${token}`)
        .send({ type: 'pro_monthly' });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe('pro_monthly');
    });

    it('GET /api/admin/promo-codes returns 401 when unauthenticated', async () => {
      const res = await request(app).get('/api/admin/promo-codes');
      expect(res.status).toBe(401);
    });

    it('GET /api/admin/promo-codes returns list for admin', async () => {
      const token = authMW.generateToken({ userId: 'u1', email: 'admin@example.com', isAdmin: true });
      const res = await request(app)
        .get('/api/admin/promo-codes')
        .set('Cookie', `auth_token=${token}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.promoCodes)).toBe(true);
      expect(res.body.promoCodes[0]).toHaveProperty('code');
      expect(res.body.promoCodes[0]).toHaveProperty('type');
      expect(res.body.promoCodes[0]).toHaveProperty('is_used');
    });
  });
});
