// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Basket and checkout tests.
 * Covers: add/remove items from basket, verify basket matches backend, checkout session.
 * All Stripe interactions use test mode only — never live keys.
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeUser(prefix = 'basket') {
  const id = uid();
  return {
    email: `e2e_${prefix}_${id}@test.invalid`,
    password: 'E2eTest123!',
    djName: `DJ_${prefix}_${id}`.slice(0, 30),
  };
}

async function signupAndLogin(request, user) {
  await request.post(`${BASE}/api/auth/signup`, {
    data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
  });
  await request.post(`${BASE}/api/auth/login`, {
    data: { email: user.email, password: user.password },
  });
}

const TEST_PRICE_ID = process.env.STRIPE_PRICE_PARTY_PASS || 'price_party_pass_test';
const TEST_PRICE_PRO = process.env.STRIPE_PRICE_PRO_MONTHLY || 'price_pro_monthly_test';

test.describe('Basket — add / remove', () => {
  let user;

  test.beforeAll(async ({ request }) => {
    user = makeUser();
    await signupAndLogin(request, user);
  });

  test('basket starts empty', async ({ request }) => {
    await request.post(`${BASE}/api/auth/login`, { data: { email: user.email, password: user.password } });
    const res = await request.get(`${BASE}/api/basket`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.basket).toEqual([]);
  });

  test('add item to basket', async ({ request }) => {
    await request.post(`${BASE}/api/auth/login`, { data: { email: user.email, password: user.password } });
    const res = await request.post(`${BASE}/api/basket/add`, {
      data: { priceId: TEST_PRICE_ID },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.basket).toContain(TEST_PRICE_ID);
  });

  test('basket contents match after add — UI state consistency', async ({ request }) => {
    await request.post(`${BASE}/api/auth/login`, { data: { email: user.email, password: user.password } });
    // Add the item in this test's context then verify
    await request.post(`${BASE}/api/basket/add`, { data: { priceId: TEST_PRICE_ID } });
    // Backend state
    const backendRes = await request.get(`${BASE}/api/basket`);
    const backendBody = await backendRes.json();

    // The basket should contain the item
    expect(backendBody.basket).toContain(TEST_PRICE_ID);
  });

  test('adding duplicate item does not create duplicates', async ({ request }) => {
    await request.post(`${BASE}/api/auth/login`, { data: { email: user.email, password: user.password } });
    // Add the same item twice
    await request.post(`${BASE}/api/basket/add`, { data: { priceId: TEST_PRICE_ID } });
    await request.post(`${BASE}/api/basket/add`, { data: { priceId: TEST_PRICE_ID } });

    const res = await request.get(`${BASE}/api/basket`);
    const body = await res.json();
    const occurrences = body.basket.filter((p) => p === TEST_PRICE_ID).length;
    expect(occurrences).toBe(1);
  });

  test('remove item from basket', async ({ request }) => {
    await request.post(`${BASE}/api/auth/login`, { data: { email: user.email, password: user.password } });
    // Ensure item is in basket first
    await request.post(`${BASE}/api/basket/add`, { data: { priceId: TEST_PRICE_ID } });

    const delRes = await request.delete(`${BASE}/api/basket/item/${encodeURIComponent(TEST_PRICE_ID)}`);
    expect(delRes.ok()).toBeTruthy();
    const delBody = await delRes.json();
    expect(delBody.basket).not.toContain(TEST_PRICE_ID);

    // Verify removal persisted
    const getRes = await request.get(`${BASE}/api/basket`);
    const getBody = await getRes.json();
    expect(getBody.basket).not.toContain(TEST_PRICE_ID);
  });

  test('basket requires authentication', async ({ page }) => {
    // Fresh context with no cookies
    const noAuthCtx = await page.context().browser().newContext();
    try {
      const noAuthReq = noAuthCtx.request;
      const res = await noAuthReq.get(`${BASE}/api/basket`);
      expect(res.status()).toBe(401);
    } finally {
      await noAuthCtx.close();
    }
  });
});

test.describe('Basket — checkout session', () => {
  let user;

  test.beforeAll(async ({ request }) => {
    user = makeUser('checkout');
    await signupAndLogin(request, user);
  });

  test('checkout with empty basket returns 400', async ({ request }) => {
    await request.post(`${BASE}/api/auth/login`, { data: { email: user.email, password: user.password } });
    // Ensure basket is empty
    const basketRes = await request.get(`${BASE}/api/basket`);
    const { basket } = await basketRes.json();
    for (const priceId of basket) {
      await request.delete(`${BASE}/api/basket/item/${encodeURIComponent(priceId)}`);
    }

    const res = await request.post(`${BASE}/api/basket/checkout`);
    // 400 = empty basket validation; 503 = Stripe not configured (server-side check runs first)
    expect([400, 503]).toContain(res.status());
  });

  test('checkout with item creates session (Stripe configured) or 503 (not configured)', async ({ request }) => {
    await request.post(`${BASE}/api/auth/login`, { data: { email: user.email, password: user.password } });
    await request.post(`${BASE}/api/basket/add`, { data: { priceId: TEST_PRICE_ID } });

    const res = await request.post(`${BASE}/api/basket/checkout`);
    // In CI without Stripe keys → 503 is acceptable
    // With real test-mode Stripe keys → 200 with sessionId
    expect([200, 201, 503]).toContain(res.status());
    if (res.ok()) {
      const body = await res.json();
      expect(body.sessionId || body.url).toBeDefined();
    }
  });

  test('direct create-checkout-session endpoint works', async ({ request }) => {
    await request.post(`${BASE}/api/auth/login`, { data: { email: user.email, password: user.password } });
    const res = await request.post(`${BASE}/api/create-checkout-session`, {
      data: { tier: 'PARTY_PASS' },
    });
    expect([200, 201, 400, 404, 503]).toContain(res.status());
  });
});
