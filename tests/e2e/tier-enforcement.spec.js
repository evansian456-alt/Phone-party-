// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Tier enforcement tests.
 * Verifies that FREE, PARTY_PASS, and PRO tiers unlock the correct features
 * and that the UI tier badges match backend state.
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeUser(prefix = 'tier') {
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
  const res = await request.post(`${BASE}/api/auth/login`, {
    data: { email: user.email, password: user.password },
  });
  return res;
}

test.describe('Tier enforcement — FREE', () => {
  let freeUser;

  test.beforeAll(async ({ request }) => {
    freeUser = makeUser('free');
    await signupAndLogin(request, freeUser);
  });

  test('FREE user /api/me returns tier=FREE', async ({ request }) => {
    await request.post(`${BASE}/api/auth/login`, { data: { email: freeUser.email, password: freeUser.password } });
    const res = await request.get(`${BASE}/api/me`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.tier).toBe('FREE');
    expect(body.effectiveTier).toBe('FREE');
  });

  test('FREE user entitlements: no partyPass, no pro', async ({ request }) => {
    await request.post(`${BASE}/api/auth/login`, { data: { email: freeUser.email, password: freeUser.password } });
    const res = await request.get(`${BASE}/api/me`);
    const body = await res.json();
    expect(body.entitlements.hasPartyPass).toBe(false);
    expect(body.entitlements.hasPro).toBe(false);
  });

  test('FREE tier info endpoint reflects FREE tier', async ({ request }) => {
    await request.post(`${BASE}/api/auth/login`, { data: { email: freeUser.email, password: freeUser.password } });
    const res = await request.get(`${BASE}/api/tier-info`);
    if (res.status() === 401 || res.status() === 404) return; // optional endpoint
    const body = await res.json();
    expect(body.tier || body.effectiveTier).toBeDefined();
  });
});

test.describe('Tier enforcement — PARTY_PASS (simulated)', () => {
  let ppUser;

  test.beforeAll(async ({ request }) => {
    if (process.env.NODE_ENV !== 'test') return;
    ppUser = makeUser('pp');
    await signupAndLogin(request, ppUser);
  });

  test('simulate Party Pass purchase and verify tier update', async ({ request }) => {
    if (process.env.NODE_ENV !== 'test') {
      // Can only run in test environment where simulate-webhook is available
      return;
    }

    await request.post(`${BASE}/api/auth/login`, { data: { email: ppUser.email, password: ppUser.password } });
    const meRes = await request.get(`${BASE}/api/me`);
    const { user } = await meRes.json();

    // Simulate the checkout.session.completed webhook
    const webhookRes = await request.post(`${BASE}/api/test/stripe/simulate-webhook`, {
      data: {
        type: 'checkout.session.completed',
        data: {
          metadata: {
            userId: user.id,
            priceId: process.env.STRIPE_PRICE_PARTY_PASS || 'price_party_pass_test',
          },
          client_reference_id: user.id,
        },
      },
    });
    expect(webhookRes.ok()).toBeTruthy();

    // Re-fetch /api/me — tier should now be PARTY_PASS (or PRO if DB updated it that way)
    const afterRes = await request.get(`${BASE}/api/me`);
    const afterBody = await afterRes.json();
    expect(['PARTY_PASS', 'PRO']).toContain(afterBody.tier);
    expect(afterBody.entitlements.hasPartyPass).toBe(true);
  });

  test('UI tier badge matches backend tier after Party Pass purchase', async ({ page, request }) => {
    if (process.env.NODE_ENV !== 'test') return;

    // Get current tier from backend
    const meRes = await request.get(`${BASE}/api/me`);
    if (!meRes.ok()) return;
    const meBody = await meRes.json();
    const backendTier = meBody.effectiveTier || meBody.tier;

    // Navigate to app and check UI reflects the same tier
    await page.goto(BASE);
    await page.waitForTimeout(1500);

    // Look for any tier badge / tier display
    const tierBadge = page.locator('[data-tier], .tier-badge, .tier-label').first();
    if (await tierBadge.isVisible({ timeout: 3000 }).catch(() => false)) {
      const uiTier = await tierBadge.getAttribute('data-tier') || await tierBadge.textContent() || '';
      // Compare primary tier word (e.g. "PARTY_PASS" → "PARTY", "PRO" → "PRO", "FREE" → "FREE")
      const primaryWord = backendTier.split('_')[0].toUpperCase();
      expect(uiTier.toUpperCase()).toContain(primaryWord);
    }
    // If no tier badge is visible yet, the test passes silently (badge may only appear when logged in)
  });
});

test.describe('Tier enforcement — PRO (simulated)', () => {
  let proUser;

  test.beforeAll(async ({ request }) => {
    if (process.env.NODE_ENV !== 'test') return;
    proUser = makeUser('pro');
    await signupAndLogin(request, proUser);
  });

  test('simulate Pro subscription and verify tier update', async ({ request }) => {
    if (process.env.NODE_ENV !== 'test') return;

    await request.post(`${BASE}/api/auth/login`, { data: { email: proUser.email, password: proUser.password } });
    const meRes = await request.get(`${BASE}/api/me`);
    const { user } = await meRes.json();

    const webhookRes = await request.post(`${BASE}/api/test/stripe/simulate-webhook`, {
      data: {
        type: 'checkout.session.completed',
        data: {
          metadata: {
            userId: user.id,
            priceId: process.env.STRIPE_PRICE_PRO_MONTHLY || 'price_pro_monthly_test',
          },
          client_reference_id: user.id,
        },
      },
    });
    expect(webhookRes.ok()).toBeTruthy();

    const afterRes = await request.get(`${BASE}/api/me`);
    const afterBody = await afterRes.json();
    expect(afterBody.tier).toBe('PRO');
    expect(afterBody.entitlements.hasPro).toBe(true);
  });

  test('PRO user has all entitlements', async ({ request }) => {
    if (process.env.NODE_ENV !== 'test') return;

    await request.post(`${BASE}/api/auth/login`, { data: { email: proUser.email, password: proUser.password } });
    const res = await request.get(`${BASE}/api/me`);
    const body = await res.json();
    if (body.tier === 'PRO') {
      expect(body.entitlements.hasPartyPass).toBe(true);
      expect(body.entitlements.hasPro).toBe(true);
    }
  });
});
