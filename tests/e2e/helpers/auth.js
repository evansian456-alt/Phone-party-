// @ts-check
'use strict';

/**
 * Shared Playwright E2E auth helpers.
 *
 * These helpers accept a Playwright `APIRequestContext` (the `request` fixture
 * or any context created via `request.newContext()`) so they work correctly in
 * both test bodies and `beforeEach`/`beforeAll` hooks.
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

/** Generate a collision-resistant unique suffix. */
function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Build a fresh test-user descriptor (not yet persisted).
 * @param {string} [prefix]
 */
function makeUser(prefix = 'user') {
  const id = uid();
  return {
    email: `e2e_${prefix}_${id}@test.invalid`,
    password: 'E2eTest123!',
    djName: `DJ_${prefix}_${id}`.slice(0, 30),
  };
}

/**
 * POST /api/auth/signup via the provided Playwright request context.
 * @param {import('@playwright/test').APIRequestContext} ctx
 * @param {{ email: string, password: string, djName: string }} user
 */
async function apiSignup(ctx, user) {
  return ctx.post(`${BASE}/api/auth/signup`, {
    data: {
      email: user.email,
      password: user.password,
      djName: user.djName,
      termsAccepted: true,
    },
  });
}

/**
 * POST /api/auth/login via the provided Playwright request context.
 * @param {import('@playwright/test').APIRequestContext} ctx
 * @param {{ email: string, password: string }} user
 */
async function apiLogin(ctx, user) {
  return ctx.post(`${BASE}/api/auth/login`, {
    data: { email: user.email, password: user.password },
  });
}

/**
 * Sign up and log in a new unique user in one step.
 * Returns the user descriptor (with email, password, djName populated).
 * @param {import('@playwright/test').APIRequestContext} ctx
 * @param {string} [prefix]
 */
async function createAndLogin(ctx, prefix = 'user') {
  const user = makeUser(prefix);
  await apiSignup(ctx, user);
  await apiLogin(ctx, user);
  return user;
}

module.exports = { uid, makeUser, apiSignup, apiLogin, createAndLogin, BASE };
