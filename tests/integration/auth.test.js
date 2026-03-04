'use strict';

/**
 * Integration tests — Authentication API
 *
 * These tests run against a live Express server wired to the ephemeral
 * Postgres + Redis containers started in globalSetup. They use supertest
 * so no external port is needed.
 *
 * Coverage:
 *   - POST /api/auth/signup   (success, duplicate, missing fields)
 *   - POST /api/auth/login    (success, wrong password, unknown user)
 *   - GET  /api/me            (authenticated, unauthenticated)
 *   - POST /api/auth/logout   (clears session cookie)
 *   - Admin bootstrap (ADMIN_EMAILS env → is_admin=true on first login)
 */

const request = require('supertest');
const { assertStripeTestMode } = require('../helpers/stripe-guard');

// Guard — must run before any test
assertStripeTestMode();

// Load the app — server.js exports { app } and NODE_ENV=test is already set
// by jest.setup.js. Supertest creates its own socket; no port binding needed.
const { app } = require('../../server');

// ─── Helpers ────────────────────────────────────────────────────────────────

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeUser(prefix = 'auth') {
  const id = uid();
  return {
    email: `integration_${prefix}_${id}@test.invalid`,
    password: process.env.TEST_USER_PASSWORD || 'ChangeMe123!',
    djName: `DJ_${prefix}_${id}`.slice(0, 30),
  };
}

async function signupAndGetCookie(agent, user) {
  await agent
    .post('/api/auth/signup')
    .send({ email: user.email, password: user.password, djName: user.djName, termsAccepted: true })
    .expect(201);

  const loginRes = await agent
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password })
    .expect(200);

  expect(loginRes.body.success).toBe(true);
  return loginRes;
}

// ─── Test suites ────────────────────────────────────────────────────────────

describe('POST /api/auth/signup', () => {
  test('creates a new account and returns 201', async () => {
    const user = makeUser();
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: user.email, password: user.password, djName: user.djName, termsAccepted: true });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.user.email).toBe(user.email.toLowerCase());
  });

  test('returns 409 on duplicate email', async () => {
    const user = makeUser('dup');
    await request(app)
      .post('/api/auth/signup')
      .send({ email: user.email, password: user.password, djName: user.djName, termsAccepted: true });

    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: user.email, password: user.password, djName: user.djName, termsAccepted: true });

    expect(res.status).toBe(409);
  });

  test('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'incomplete@test.invalid' }); // missing password + djName

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  let user;
  beforeAll(async () => {
    user = makeUser('login');
    await request(app)
      .post('/api/auth/signup')
      .send({ email: user.email, password: user.password, djName: user.djName, termsAccepted: true });
  });

  test('returns 200 and sets session cookie on correct credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.email).toBe(user.email.toLowerCase());

    // A cookie must be set (JWT or session)
    const cookieHeader = res.headers['set-cookie'];
    expect(cookieHeader).toBeDefined();
    expect(cookieHeader.length).toBeGreaterThan(0);
  });

  test('returns 401 on wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'WrongPassword999!' });

    expect(res.status).toBe(401);
  });

  test('returns 401 for unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody_here@test.invalid', password: 'Whatever123!' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/me', () => {
  test('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  test('returns current user when authenticated', async () => {
    const agent = request.agent(app);
    const user = makeUser('me');

    await signupAndGetCookie(agent, user);
    const res = await agent.get('/api/me');

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(user.email.toLowerCase());
    expect(res.body.tier).toBeDefined();
    expect(res.body.entitlements).toBeDefined();
    expect(res.body.entitlements.hasPartyPass).toBe(false);
    expect(res.body.entitlements.hasPro).toBe(false);
  });

  test('/api/me effectiveTier is FREE for a new user', async () => {
    const agent = request.agent(app);
    const user = makeUser('freetier');
    await signupAndGetCookie(agent, user);

    const res = await agent.get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('FREE');
    expect(res.body.effectiveTier).toBe('FREE');
  });
});

describe('POST /api/auth/logout', () => {
  test('clears auth cookie and /api/me returns 401 afterwards', async () => {
    const agent = request.agent(app);
    const user = makeUser('logout');
    await signupAndGetCookie(agent, user);

    // Confirm authenticated
    const meBefore = await agent.get('/api/me');
    expect(meBefore.status).toBe(200);

    // Logout
    const logoutRes = await agent.post('/api/auth/logout');
    expect(logoutRes.status).toBe(200);

    // Confirm the session is gone — subsequent /api/me returns 401
    const meAfter = await agent.get('/api/me');
    expect(meAfter.status).toBe(401);
  });
});

describe('Admin bootstrap', () => {
  test('user whose email is in ADMIN_EMAILS gets is_admin=true on first login', async () => {
    // Use a unique admin email for this test to avoid collision with seeded admin
    const adminEmail = `admin_bootstrap_${uid()}@test.invalid`;
    const origEnv = process.env.ADMIN_EMAILS;

    // Temporarily add this email to the admin allowlist
    process.env.ADMIN_EMAILS = [process.env.ADMIN_EMAILS, adminEmail]
      .filter(Boolean)
      .join(',');

    try {
      await request(app)
        .post('/api/auth/signup')
        .send({ email: adminEmail, password: 'Admin123!', djName: 'AdminTest', termsAccepted: true });

      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: adminEmail, password: 'Admin123!' });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.user.isAdmin).toBe(true);
    } finally {
      process.env.ADMIN_EMAILS = origEnv || '';
    }
  });
});
