/**
 * Password Reset Route Tests
 *
 * Tests the POST /api/auth/request-reset and POST /api/auth/reset-password
 * endpoints using in-process local auth fallback (no database required).
 */

'use strict';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const authMiddleware = require('./auth-middleware');
const createAuthRouter = require('./routes/auth');

// ── Minimal stub dependencies ─────────────────────────────────────────────────

const localFallbackUsersByEmail = new Map();
const localFallbackUsersById = new Map();
let localFallbackUserIdSeq = 1;

function buildDeps() {
  return {
    db: {
      query: jest.fn().mockRejectedValue(new Error('DB not available in test')),
      getClient: jest.fn().mockRejectedValue(new Error('DB not available in test'))
    },
    redis: { set: jest.fn().mockResolvedValue('OK') },
    authMiddleware,
    storeCatalog: { getStoreCatalog: () => ({ items: [] }), getItemById: () => null },
    apiLimiter: (req, res, next) => next(),
    authLimiter: (req, res, next) => next(),
    isStreamingPartyEnabled: false,
    isHttpsRequest: () => false,
    buildLocalFallbackMePayload: (user) => ({ user }),
    ErrorMessages: {},
    setSecureCookie: (res, name, value) => res.cookie(name, value),
    parties: new Map(),
    paymentProvider: {},
    localFallbackUsersByEmail,
    localFallbackUsersById,
    localFallbackUserIdSeq,
    canUseLocalAuthFallback: () => true
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const deps = buildDeps();
  const authRouter = createAuthRouter(deps);
  app.use('/api', authRouter);

  return { app, deps };
}

// ── Helper: create a user in the local fallback store ─────────────────────────
async function createLocalUser(email, password = 'password123') {
  const normalizedEmail = email.toLowerCase();
  const passwordHash = await authMiddleware.hashPassword(password);
  const user = {
    id: localFallbackUserIdSeq++,
    email: normalizedEmail,
    djName: 'Test DJ',
    passwordHash,
    profileCompleted: true,
    upgrades: { party_pass_active: false, pro_monthly_active: false },
    entitlements: [],
    profile: {}
  };
  localFallbackUsersByEmail.set(normalizedEmail, user);
  localFallbackUsersById.set(user.id, user);
  return user;
}

// ── Reset fallback store between test groups ──────────────────────────────────
beforeEach(() => {
  localFallbackUsersByEmail.clear();
  localFallbackUsersById.clear();
});

// =============================================================================
describe('POST /api/auth/request-reset', () => {
  it('returns 400 for missing email', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/auth/request-reset').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid email/i);
  });

  it('returns 400 for invalid email', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/auth/request-reset')
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid email/i);
  });

  it('returns success for an email that does not exist (no account leak)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/auth/request-reset')
      .send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBeDefined();
    // Must NOT expose whether an account exists
    expect(res.body.error).toBeUndefined();
  });

  it('returns a debug code for an existing account (local/dev mode)', async () => {
    const { app } = buildApp();
    await createLocalUser('user@example.com');

    const res = await request(app)
      .post('/api/auth/request-reset')
      .send({ email: 'user@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.debugCode).toBeDefined();
    expect(res.body.debugCode).toMatch(/^\d{6}$/);
  });

  it('stores the reset code on the user object', async () => {
    const { app } = buildApp();
    const user = await createLocalUser('stored@example.com');

    await request(app)
      .post('/api/auth/request-reset')
      .send({ email: 'stored@example.com' });

    expect(user.resetCode).toBeDefined();
    expect(user.resetCodeExpiry).toBeGreaterThan(Date.now());
  });
});

// =============================================================================
describe('POST /api/auth/reset-password', () => {
  it('returns 400 for missing email', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ code: '123456', newPassword: 'newpass1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid email/i);
  });

  it('returns 400 for empty code', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'user@example.com', code: '', newPassword: 'newpass1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/code/i);
  });

  it('returns 400 for short password', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'user@example.com', code: '123456', newPassword: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  it('returns 400 for wrong reset code', async () => {
    const { app } = buildApp();
    const user = await createLocalUser('reset@example.com');
    user.resetCode = '999999';
    user.resetCodeExpiry = Date.now() + 60_000;

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'reset@example.com', code: '000000', newPassword: 'newpassword1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  it('returns 400 for expired reset code', async () => {
    const { app } = buildApp();
    const user = await createLocalUser('expired@example.com');
    user.resetCode = '123456';
    user.resetCodeExpiry = Date.now() - 1000; // already expired

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'expired@example.com', code: '123456', newPassword: 'newpassword1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  it('returns 400 for unknown email', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'ghost@example.com', code: '123456', newPassword: 'newpassword1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  it('resets password and clears reset code on success', async () => {
    const { app } = buildApp();
    const user = await createLocalUser('success@example.com', 'oldpassword');
    user.resetCode = '654321';
    user.resetCodeExpiry = Date.now() + 60_000;

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'success@example.com', code: '654321', newPassword: 'brandnewpassword' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Reset code must be cleared
    expect(user.resetCode).toBeUndefined();
    expect(user.resetCodeExpiry).toBeUndefined();

    // New password must authenticate correctly
    const isValid = await authMiddleware.verifyPassword('brandnewpassword', user.passwordHash);
    expect(isValid).toBe(true);
  });

  it('full round-trip: request reset then reset password', async () => {
    const { app } = buildApp();
    await createLocalUser('roundtrip@example.com', 'oldpassword');

    // Step 1: request reset
    const reqRes = await request(app)
      .post('/api/auth/request-reset')
      .send({ email: 'roundtrip@example.com' });
    expect(reqRes.status).toBe(200);
    const code = reqRes.body.debugCode;
    expect(code).toBeDefined();

    // Step 2: reset password with the code
    const resetRes = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'roundtrip@example.com', code, newPassword: 'mynewpassword' });
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.success).toBe(true);
  });

  it('code cannot be reused after a successful reset', async () => {
    const { app } = buildApp();
    await createLocalUser('reuse@example.com', 'oldpassword');

    const reqRes = await request(app)
      .post('/api/auth/request-reset')
      .send({ email: 'reuse@example.com' });
    const code = reqRes.body.debugCode;

    // First reset — must succeed
    await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'reuse@example.com', code, newPassword: 'firstnewpassword' });

    // Second reset with same code — must fail
    const secondRes = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'reuse@example.com', code, newPassword: 'secondnewpassword' });
    expect(secondRes.status).toBe(400);
    expect(secondRes.body.error).toMatch(/invalid or expired/i);
  });
});
