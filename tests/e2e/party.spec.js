// @ts-check
const { test, expect } = require('@playwright/test');
const { makeUser, apiSignup, apiLogin, BASE } = require('./helpers/auth');

/**
 * E2E — Party System
 *
 * Covers:
 *  - Create party (via API + UI)
 *  - Party code is returned and is non-empty
 *  - Party details retrievable via GET /api/party
 *  - Join-party button present after login
 *  - End party via API
 *  - Invalid party code returns 404 / exists=false
 */

// ─── API-level party tests ────────────────────────────────────────────────────

test.describe('Party creation (API)', () => {
  // Each test gets its own authenticated user via beforeEach so the
  // Playwright `request` fixture is used only in the correct (test) scope.
  let host;

  test.beforeEach(async ({ request }) => {
    host = makeUser('host');
    await apiSignup(request, host);
    await apiLogin(request, host);
  });

  test('POST /api/create-party returns a party code', async ({ request }) => {
    const res = await request.post(`${BASE}/api/create-party`, {
      data: { djName: host.djName },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('code');
    expect(typeof body.code).toBe('string');
    expect(body.code.length).toBeGreaterThan(0);
  });

  test('GET /api/party returns party info for a valid code', async ({ request }) => {
    // Create a party within the test to avoid cross-test state dependencies
    const createRes = await request.post(`${BASE}/api/create-party`, {
      data: { djName: host.djName },
    });
    const { code } = await createRes.json();

    const res = await request.get(`${BASE}/api/party?code=${code}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.partyCode).toBeDefined();
  });

  test('GET /api/party returns exists=false for invalid code', async ({ request }) => {
    const res = await request.get(`${BASE}/api/party?code=INVALID_CODE_XXXX`);
    const body = await res.json();
    expect(body.exists).toBe(false);
  });

  test('POST /api/end-party ends the party', async ({ request }) => {
    const createRes = await request.post(`${BASE}/api/create-party`, {
      data: { djName: host.djName },
    });
    const { code, hostId } = await createRes.json();

    const endRes = await request.post(`${BASE}/api/end-party`, {
      data: { partyCode: code, hostId },
    });
    expect(endRes.ok()).toBeTruthy();

    // Party should no longer exist
    const checkRes = await request.get(`${BASE}/api/party?code=${code}`);
    const checkBody = await checkRes.json();
    const ended = !checkBody.exists || checkBody.status === 'ended';
    expect(ended).toBe(true);
  });
});

// ─── UI party element presence tests ─────────────────────────────────────────

test.describe('Party UI elements', () => {
  test('create-party data-testid button is present after login', async ({ page, request }) => {
    const user = makeUser('uiparty');
    await apiSignup(request, user);
    await apiLogin(request, user);

    await page.goto(BASE);
    await page.locator('#viewLanding').waitFor({ state: 'visible', timeout: 12_000 });
    await page.locator('[data-testid="login-button"]').click();
    await page.locator('#viewLogin').waitFor({ state: 'visible', timeout: 8_000 });
    await page.fill('#loginEmail', user.email);
    await page.fill('#loginPassword', user.password);
    await page.click('#formLogin button[type="submit"]');
    await expect(page.locator('#viewLogin')).not.toBeVisible({ timeout: 12_000 });

    // Wait for auth home or home view
    await page.waitForFunction(
      () => {
        const ah = document.getElementById('viewAuthHome');
        const h = document.getElementById('viewHome');
        return (
          (ah && !ah.classList.contains('hidden')) ||
          (h && !h.classList.contains('hidden'))
        );
      },
      { timeout: 12_000 }
    );

    await expect(page.locator('[data-testid="create-party"]')).toBeVisible();
    await expect(page.locator('[data-testid="join-party"]')).toBeVisible();
  });

  test('party-code element is attached in the DOM', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="party-code"]')).toBeAttached();
  });

  test('end-party button is attached in the DOM', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="end-party"]')).toBeAttached();
  });

  test('start-party button is attached in the DOM', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="start-party"]')).toBeAttached();
  });
});
