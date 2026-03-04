'use strict';

/**
 * Shared API helpers for integration and e2e tests.
 *
 * These functions wrap supertest / fetch so every test file can
 * call signupAndLogin(), createParty(), etc. without repeating boilerplate.
 */

let _baseUrl = null;

/**
 * Configure the base URL once per test run.
 * Called automatically by globalSetup; can also be set via BASE_URL env.
 */
function setBaseUrl(url) {
  _baseUrl = url;
}

function getBaseUrl() {
  return _baseUrl || process.env.BASE_URL || `http://127.0.0.1:${process.env.APP_PORT || 8080}`;
}

/** Generate a collision-resistant unique suffix for test data. */
function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Build a fresh test user object (not yet persisted). */
function makeUser(prefix = 'user') {
  const id = uid();
  return {
    email: `test_${prefix}_${id}@test.invalid`,
    password: process.env.TEST_USER_PASSWORD || 'ChangeMe123!',
    djName: `DJ_${prefix}_${id}`.slice(0, 30),
  };
}

/**
 * Perform a JSON fetch against the test server.
 * Returns { status, body, headers } — does NOT throw on non-2xx.
 */
async function apiFetch(path, { method = 'GET', body, cookies = '' } = {}) {
  const url = `${getBaseUrl()}${path}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(url, opts);
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/**
 * Sign up a user via the API. Returns the response body.
 * Resolves on any status code (caller asserts).
 */
async function signup(user) {
  return apiFetch('/api/auth/signup', {
    method: 'POST',
    body: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
  });
}

/**
 * Login a user and return { status, body, setCookieHeader }.
 * The caller must preserve the returned cookie for subsequent requests.
 */
async function login(user) {
  const url = `${getBaseUrl()}/api/auth/login`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const setCookie = res.headers.get('set-cookie') || '';
  return { status: res.status, body, setCookieHeader: setCookie };
}

/**
 * Sign up + login in one step.
 * Returns { user, cookies } where `cookies` is the raw Set-Cookie header string
 * to pass as the `Cookie` header in subsequent requests.
 */
async function signupAndLogin(userOverrides = {}) {
  const user = makeUser();
  Object.assign(user, userOverrides);
  await signup(user);
  const { status, body, setCookieHeader } = await login(user);
  if (status !== 200 || !body?.success) {
    throw new Error(`[helpers/api] login failed for ${user.email}: ${JSON.stringify(body)}`);
  }
  // Extract the cookie value(s) — keep the full header value for sending back
  const cookies = setCookieHeader
    .split(',')
    .map((c) => c.trim().split(';')[0])
    .join('; ');
  return { user, cookies };
}

/**
 * Create a party as the currently authenticated user (identified by cookies).
 * Returns the party code.
 */
async function createParty(djName, cookies) {
  const res = await apiFetch('/api/create-party', {
    method: 'POST',
    body: { djName },
    cookies,
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`[helpers/api] create-party failed: ${JSON.stringify(res.body)}`);
  }
  return res.body.code;
}

/**
 * Simulate a Stripe webhook event via the test-only endpoint.
 * NODE_ENV must be 'test'. Throws if the endpoint is not available.
 */
async function simulateStripeWebhook(type, data, cookies = '') {
  const res = await apiFetch('/api/test/stripe/simulate-webhook', {
    method: 'POST',
    body: { type, data },
    cookies,
  });
  if (res.status !== 200) {
    throw new Error(
      `[helpers/api] simulate-webhook failed (${res.status}): ${JSON.stringify(res.body)}`
    );
  }
  return res.body;
}

module.exports = {
  setBaseUrl,
  getBaseUrl,
  uid,
  makeUser,
  apiFetch,
  signup,
  login,
  signupAndLogin,
  createParty,
  simulateStripeWebhook,
};
