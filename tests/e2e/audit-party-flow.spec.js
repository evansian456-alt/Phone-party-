// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * E2E Audit — Party Lifecycle
 *
 * Validates data-testid attributes on party elements and tests:
 * - create-party / join-party buttons present
 * - party-code element exists after creating party
 * - start-party / end-party buttons
 * - music-tab / upload-audio elements
 * - provider cards (provider-youtube, provider-soundcloud, provider-spotify)
 * - party-player open-in buttons present in DOM
 * - sync-info-modal / sync-coach modals exist
 * - upgrade-button / checkout-start elements
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
function makeUser(p = 'audit_party') {
  const id = uid();
  return {
    email: `e2e_${p}_${id}@test.invalid`,
    password: 'Audit123!',
    djName: `DJ_${p}_${id}`.slice(0, 30),
  };
}
async function apiSignup(request, u) {
  return request.post(`${BASE}/api/auth/signup`, {
    data: { email: u.email, password: u.password, djName: u.djName, termsAccepted: true },
  });
}
async function apiLogin(request, u) {
  return request.post(`${BASE}/api/auth/login`, {
    data: { email: u.email, password: u.password },
  });
}

// ─── Party UI data-testid presence ──────────────────────────────────────────

test.describe('Party UI data-testid attributes', () => {
  test('create-party and join-party buttons are present in home view', async ({ page, request }) => {
    const user = makeUser();
    await apiSignup(request, user);
    await apiLogin(request, user);

    await page.goto(BASE);
    await page.locator('[data-testid="login-button"]').click();
    await page.locator('#loginEmail').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#loginEmail').fill(user.email);
    await page.locator('#loginPassword').fill(user.password);
    await page.locator('#formLogin button[type="submit"]').click();

    await page.waitForFunction(() => { const ah = document.getElementById('viewAuthHome'); const h = document.getElementById('viewHome'); return (ah && !ah.classList.contains('hidden')) || (h && !h.classList.contains('hidden')); }, { timeout: 12000 });

    await expect(page.locator('[data-testid="create-party"]')).toBeVisible();
    await expect(page.locator('[data-testid="join-party"]')).toBeVisible();
  });

  test('party-code element exists in viewParty', async ({ page }) => {
    await page.goto(BASE);
    // The party-code element exists in the DOM (inside viewParty which may be hidden)
    await expect(page.locator('[data-testid="party-code"]')).toBeAttached();
  });

  test('end-party button exists in viewParty', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="end-party"]')).toBeAttached();
  });

  test('play-party button exists in viewParty', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="play-party"]')).toBeAttached();
  });

  test('music-tab section exists in viewParty', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="music-tab"]')).toBeAttached();
  });

  test('upload-audio button exists in music section', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="upload-audio"]')).toBeAttached();
  });

  test('provider-youtube card exists in streaming section', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="provider-youtube"]')).toBeAttached();
  });

  test('provider-spotify card exists in streaming section', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="provider-spotify"]')).toBeAttached();
  });

  test('provider-soundcloud card exists in streaming section', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="provider-soundcloud"]')).toBeAttached();
  });

  test('party-player-youtube open-in button exists', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="party-player-youtube"]')).toBeAttached();
  });

  test('party-player-spotify-link open-in button exists', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="party-player-spotify-link"]')).toBeAttached();
  });

  test('party-player-soundcloud open-in button exists', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="party-player-soundcloud"]')).toBeAttached();
  });

  test('sync-info-modal exists in the DOM', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="sync-info-modal"]')).toBeAttached();
  });

  test('sync-coach modal exists in the DOM', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="sync-coach-modal"]')).toBeAttached();
  });

  test('upgrade-button exists in header', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="upgrade-button"]')).toBeAttached();
  });

  test('checkout-start button exists in checkout modal', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="checkout-start"]')).toBeAttached();
  });

  test('checkout-modal element exists', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="checkout-modal"]')).toBeAttached();
  });
});

// ─── Party API lifecycle ──────────────────────────────────────────────────────

test.describe('Party API lifecycle', () => {

  test('POST /api/create-party returns a party code (authenticated)', async ({ request }) => {
    const user = makeUser('lifecycle');
    await apiSignup(request, user);
    await apiLogin(request, user);

    const res = await request.post(`${BASE}/api/create-party`, {
      data: { djName: user.djName },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // Server returns partyCode (not code)
    expect(body.partyCode || body.code).toBeTruthy();
    const partyCode = body.partyCode || body.code;
    expect(typeof partyCode).toBe('string');
    expect(partyCode.length).toBeGreaterThan(0);
  });

  test('POST /api/join-party succeeds with valid code', async ({ request }) => {
    // Create a fresh party to join (self-contained)
    const host = makeUser('lifecyclehost');
    await apiSignup(request, host);
    await apiLogin(request, host);
    const createRes = await request.post(`${BASE}/api/create-party`, {
      data: { djName: host.djName },
    });
    expect(createRes.ok()).toBeTruthy();
    const createBody = await createRes.json();
    const code = createBody.partyCode || createBody.code;
    expect(code).toBeTruthy();

    const res = await request.post(`${BASE}/api/join-party`, {
      data: { partyCode: code, nickname: 'TestGuest' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok || body.partyCode || body.success).toBeTruthy();
  });

  test('POST /api/join-party with bad code returns 4xx', async ({ request }) => {
    const res = await request.post(`${BASE}/api/join-party`, {
      data: { partyCode: 'BADCODE999', nickname: 'Ghost' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('GET /api/feature-flags returns object', async ({ request }) => {
    const res = await request.get(`${BASE}/api/feature-flags`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body).toBe('object');
  });
});

// ─── Party UI create flow ────────────────────────────────────────────────────

test.describe('Party create flow (UI)', () => {
  test('clicking create-party shows create form', async ({ page, request }) => {
    const user = makeUser('createui');
    await apiSignup(request, user);

    await page.goto(BASE);
    await page.locator('[data-testid="login-button"]').click();
    await page.locator('#loginEmail').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#loginEmail').fill(user.email);
    await page.locator('#loginPassword').fill(user.password);
    await page.locator('#formLogin button[type="submit"]').click();

    await page.waitForFunction(() => { const ah = document.getElementById('viewAuthHome'); const h = document.getElementById('viewHome'); return (ah && !ah.classList.contains('hidden')) || (h && !h.classList.contains('hidden')); }, { timeout: 12000 });
    // viewAuthHome: click create-party shows partyCreateSection; viewHome: shows createPartySection
    const createBtn = page.locator('#viewAuthHome [data-testid="create-party"], #viewHome [data-testid="create-party"]').first();
    await createBtn.waitFor({ state: 'visible', timeout: 8000 });
    await createBtn.click();
    // Either partyCreateSection (viewAuthHome) or createPartySection (viewHome) should appear
    await expect(page.locator('#partyCreateSection, #createPartySection').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="start-party-auth-home"], [data-testid="start-party"]').first()).toBeVisible();
  });

  test('clicking join-party shows join form', async ({ page, request }) => {
    const user = makeUser('joinui');
    await apiSignup(request, user);

    await page.goto(BASE);
    await page.locator('[data-testid="login-button"]').click();
    await page.locator('#loginEmail').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#loginEmail').fill(user.email);
    await page.locator('#loginPassword').fill(user.password);
    await page.locator('#formLogin button[type="submit"]').click();

    await page.waitForFunction(() => { const ah = document.getElementById('viewAuthHome'); const h = document.getElementById('viewHome'); return (ah && !ah.classList.contains('hidden')) || (h && !h.classList.contains('hidden')); }, { timeout: 12000 });
    const joinBtn = page.locator('#viewAuthHome [data-testid="join-party"], #viewHome [data-testid="join-party"]').first();
    await joinBtn.waitFor({ state: 'visible', timeout: 8000 });
    await joinBtn.click();
    // Either partyJoinSection (viewAuthHome) or joinPartySection (viewHome) should appear
    await expect(page.locator('#partyJoinSection, #joinPartySection').first()).toBeVisible({ timeout: 5000 });
  });
});
