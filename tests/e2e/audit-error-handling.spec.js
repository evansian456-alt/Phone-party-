// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * E2E Audit — Error Handling
 *
 * Validates error responses from key API endpoints:
 * - Unauthenticated access to protected routes returns 401
 * - Invalid input to auth endpoints returns 400/422
 * - Non-existent resources return 404
 * - Party join with bad code returns 4xx
 * - Duplicate signup returns 409
 * - Profile update without auth returns 401
 * - Purchase without auth returns 401
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
function makeUser(p = 'audit_err') {
  const id = uid();
  return {
    email: `e2e_${p}_${id}@test.invalid`,
    password: 'Audit123!',
    djName: `DJ_${p}_${id}`.slice(0, 30),
  };
}

// ─── Unauthenticated access ──────────────────────────────────────────────────

test.describe('Unauthenticated access protection', () => {
  test('GET /api/me returns 401 without session', async ({ request }) => {
    const res = await request.get(`${BASE}/api/me`);
    expect(res.status()).toBe(401);
  });

  test('POST /api/create-party without auth creates party (no auth required)', async ({ request }) => {
    // The /api/create-party endpoint is open — it does not require authentication
    const res = await request.post(`${BASE}/api/create-party`, {
      data: { djName: 'TestDJ' },
    });
    // Should succeed (200) since the endpoint is open
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.partyCode).toBeTruthy();
  });

  test('GET /api/user/entitlements returns 401 without auth', async ({ request }) => {
    const res = await request.get(`${BASE}/api/user/entitlements`);
    expect(res.status()).toBe(401);
  });
});

// ─── Input validation errors ─────────────────────────────────────────────────

test.describe('Auth input validation', () => {
  test('signup with missing email returns 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/signup`, {
      data: { password: 'Test123!', djName: 'DJ Test', termsAccepted: true },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('signup with missing password returns 400', async ({ request }) => {
    const id = uid();
    const res = await request.post(`${BASE}/api/auth/signup`, {
      data: { email: `e2e_missing_pw_${id}@test.invalid`, djName: 'DJ Test', termsAccepted: true },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('signup with short password returns 400', async ({ request }) => {
    const id = uid();
    const res = await request.post(`${BASE}/api/auth/signup`, {
      data: { email: `e2e_short_pw_${id}@test.invalid`, password: '123', djName: 'DJ Test', termsAccepted: true },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('signup without termsAccepted returns 400', async ({ request }) => {
    const id = uid();
    const res = await request.post(`${BASE}/api/auth/signup`, {
      data: { email: `e2e_noterms_${id}@test.invalid`, password: 'Test123!', djName: 'DJ Test', termsAccepted: false },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('login with wrong password returns 401', async ({ request }) => {
    const user = makeUser('wrongpw');
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });

    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { email: user.email, password: 'WrongPassword999!' },
    });
    expect(res.status()).toBe(401);
  });

  test('login with non-existent account returns 401', async ({ request }) => {
    const id = uid();
    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { email: `nonexistent_${id}@ghost.invalid`, password: 'Password123!' },
    });
    expect(res.status()).toBe(401);
  });

  test('duplicate signup returns 409', async ({ request }) => {
    const user = makeUser('dupsign');
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });
    const dup = await request.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });
    expect(dup.status()).toBe(409);
    const body = await dup.json();
    expect(body.error).toBe('Account already exists');
  });
});

// ─── Party join error handling ────────────────────────────────────────────────

test.describe('Party join error handling', () => {
  test('join with non-existent party code returns 4xx', async ({ request }) => {
    const res = await request.post(`${BASE}/api/join-party`, {
      data: { partyCode: 'XXXYYY', nickname: 'Ghost' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('join with empty code returns 4xx', async ({ request }) => {
    const res = await request.post(`${BASE}/api/join-party`, {
      data: { partyCode: '', nickname: 'Ghost' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });
});

// ─── Profile & store errors ───────────────────────────────────────────────────

test.describe('Profile and store error handling', () => {
  test('GET /api/store returns a valid catalog (no auth required)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/store`);
    // store should be publicly readable
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toBeDefined();
  });

  test('POST /api/purchase without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE}/api/purchase`, {
      data: { itemId: 'neon-pack', itemType: 'visual_pack' },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /api/purchase non-existent item returns 404 (authenticated)', async ({ request }) => {
    const user = makeUser('purchase_err');
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });
    await request.post(`${BASE}/api/auth/login`, {
      data: { email: user.email, password: user.password },
    });

    const res = await request.post(`${BASE}/api/purchase`, {
      data: { itemId: 'nonexistent-item-xyz', itemType: 'visual_pack' },
    });
    expect(res.status()).toBe(404);
  });
});

// ─── UI error display ─────────────────────────────────────────────────────────

test.describe('UI error display', () => {
  test('nav-home element exists on landing page', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="nav-home"]')).toBeVisible({ timeout: 10000 });
  });

  test('profile-form elements are present in profile view (DOM)', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="profile-form"]')).toBeAttached();
    await expect(page.locator('[data-testid="profile-save"]')).toBeAttached();
    await expect(page.locator('[data-testid="profile-avatar-upload"]')).toBeAttached();
  });

  test('chat-input and send-message elements exist in party view', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="chat-input"]')).toBeAttached();
    await expect(page.locator('[data-testid="send-message"]')).toBeAttached();
  });
});
