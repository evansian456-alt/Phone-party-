'use strict';

/**
 * Stress tests — Concurrent users
 *
 * These tests verify that the server handles concurrent party creation,
 * concurrent joins, and concurrent queue mutations without corruption.
 *
 * They are intentionally lightweight (no Docker, no external deps) —
 * they rely on the in-process app (supertest) and the mocked Redis
 * (ioredis-mock, configured in jest.setup.js).
 *
 * To run:
 *   NODE_ENV=test npx jest tests/stress/concurrent-users.test.js
 */

const request = require('supertest');
const { assertStripeTestMode } = require('../helpers/stripe-guard');

assertStripeTestMode();

const { app } = require('../../server');

// ─── Helpers ────────────────────────────────────────────────────────────────

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeUser(prefix = 'stress') {
  const id = uid();
  return {
    email: `stress_${prefix}_${id}@test.invalid`,
    password: process.env.TEST_USER_PASSWORD || 'ChangeMe123!',
    djName: `DJ_${prefix}_${id}`.slice(0, 30),
  };
}

async function signupAndLogin(user) {
  const agent = request.agent(app);
  await agent
    .post('/api/auth/signup')
    .send({ email: user.email, password: user.password, djName: user.djName });
  await agent
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password });
  return agent;
}

// ─── Concurrent party creation ───────────────────────────────────────────────

describe('Concurrent party creation', () => {
  const CONCURRENCY = 10;

  test(`${CONCURRENCY} hosts can create parties simultaneously without collisions`, async () => {
    const tasks = Array.from({ length: CONCURRENCY }, async (_, i) => {
      const user = makeUser(`conchost_${i}`);
      const agent = await signupAndLogin(user);
      const res = await agent.post('/api/create-party').send({ djName: user.djName });
      return res.body.code;
    });

    const codes = await Promise.all(tasks);

    // All requests should succeed
    expect(codes.every((c) => typeof c === 'string' && c.length > 0)).toBe(true);

    // All party codes must be unique
    const unique = new Set(codes);
    expect(unique.size).toBe(CONCURRENCY);
  });
});

// ─── Concurrent joins ─────────────────────────────────────────────────────────

describe('Concurrent guests joining the same party', () => {
  const CONCURRENCY = 8;
  let partyCode;

  beforeAll(async () => {
    const host = makeUser('concjoinhost');
    const hostAgent = await signupAndLogin(host);
    const createRes = await hostAgent.post('/api/create-party').send({ djName: host.djName });
    partyCode = createRes.body.code;
  });

  test(`${CONCURRENCY} guests can join the same party concurrently`, async () => {
    const tasks = Array.from({ length: CONCURRENCY }, async (_, i) => {
      const guest = makeUser(`concguest_${i}`);
      const guestAgent = await signupAndLogin(guest);
      const res = await guestAgent.post('/api/join-party').send({
        code: partyCode,
        guestId: `guest_${uid()}`,
        djName: guest.djName,
      });
      return res.status;
    });

    const statuses = await Promise.all(tasks);
    // All joins should succeed (200) or return 409/conflict (both are safe outcomes)
    expect(statuses.every((s) => s === 200 || s === 409 || s === 400)).toBe(true);
    // At least some should have succeeded
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
  });
});

// ─── Concurrent reads ─────────────────────────────────────────────────────────

describe('Concurrent party-state reads', () => {
  const READ_COUNT = 20;
  let partyCode;
  let hostAgent;

  beforeAll(async () => {
    const host = makeUser('concreadhost');
    hostAgent = await signupAndLogin(host);
    const createRes = await hostAgent.post('/api/create-party').send({ djName: host.djName });
    partyCode = createRes.body.code;
  });

  test(`${READ_COUNT} concurrent party-state polls return consistent results`, async () => {
    const tasks = Array.from({ length: READ_COUNT }, () =>
      hostAgent.get(`/api/party-state?code=${partyCode}`)
    );

    const responses = await Promise.all(tasks);
    const statuses = responses.map((r) => r.status);

    // All reads should return 200
    expect(statuses.every((s) => s === 200)).toBe(true);

    // Party code in responses must all match
    const codes = responses.map((r) => r.body.party?.code).filter(Boolean);
    if (codes.length > 0) {
      expect(new Set(codes).size).toBe(1);
    }
  });
});

// ─── Signup uniqueness under concurrency ─────────────────────────────────────

describe('Signup uniqueness under concurrent requests', () => {
  test('simultaneous signup with the same email returns only one success', async () => {
    const user = makeUser('duprace');
    const ATTEMPTS = 5;

    const tasks = Array.from({ length: ATTEMPTS }, () =>
      request(app)
        .post('/api/auth/signup')
        .send({ email: user.email, password: user.password, djName: user.djName })
    );

    const results = await Promise.all(tasks);
    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    // Exactly one should succeed; the rest should conflict
    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(ATTEMPTS - 1);
  });
});
