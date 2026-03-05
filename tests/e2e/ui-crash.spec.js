// @ts-check
const { test, expect } = require('@playwright/test');
const { makeUser, apiSignup, apiLogin, BASE } = require('./helpers/auth');

/**
 * E2E — UI Crash & Error Monitoring
 *
 * Validates that:
 *  - Pages load without JavaScript exceptions
 *  - All major views render without crashes
 *  - Network requests do not produce 5xx errors on page load
 *  - Clicking primary navigation elements does not crash the page
 *  - Console errors are captured and reported
 *
 * This is the "click everything" safety net test.
 */

// ─── Page load without crashes ────────────────────────────────────────────────

test.describe('UI Crash — page load', () => {
  test('landing page loads without JavaScript exceptions', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('Non-Error promise rejection') &&
        !e.includes('favicon')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('landing page body is not empty', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('no 5xx responses on page load', async ({ page }) => {
    const serverErrors = [];
    page.on('response', (response) => {
      if (response.status() >= 500) {
        serverErrors.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    expect(serverErrors).toHaveLength(0);
  });
});

// ─── Navigation click tests ───────────────────────────────────────────────────

test.describe('UI Crash — navigation clicks', () => {
  test('clicking Sign Up button does not crash the page', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(BASE);
    await page.locator('#viewLanding').waitFor({ state: 'visible', timeout: 12_000 });

    const signupBtn = page.locator('[data-testid="signup-button"]');
    if (await signupBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await signupBtn.click();
    }

    await expect(page.locator('body')).not.toBeEmpty();
    const criticalErrors = errors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('Non-Error promise rejection')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('clicking Login button does not crash the page', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(BASE);
    await page.locator('#viewLanding').waitFor({ state: 'visible', timeout: 12_000 });

    const loginBtn = page.locator('[data-testid="login-button"]');
    if (await loginBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await loginBtn.click();
    }

    await expect(page.locator('body')).not.toBeEmpty();
    const criticalErrors = errors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('Non-Error promise rejection')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('navigating between signup and login does not crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(BASE);
    await page.locator('#viewLanding').waitFor({ state: 'visible', timeout: 12_000 });

    // Click Sign Up
    const signupBtn = page.locator('[data-testid="signup-button"]');
    if (await signupBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await signupBtn.click();
      await page.waitForTimeout(500);
    }

    // Navigate back and click Login
    await page.goto(BASE);
    await page.locator('#viewLanding').waitFor({ state: 'visible', timeout: 12_000 });
    const loginBtn = page.locator('[data-testid="login-button"]');
    if (await loginBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await loginBtn.click();
      await page.waitForTimeout(500);
    }

    await expect(page.locator('body')).not.toBeEmpty();
    const criticalErrors = errors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('Non-Error promise rejection')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});

// ─── Authenticated UI clicks ──────────────────────────────────────────────────

test.describe('UI Crash — authenticated clicks', () => {
  // Create a fresh user per test so `request` is used only in test scope,
  // not in beforeAll (which can cause fixture-scope issues).

  test('auth home renders without JavaScript errors after login', async ({ page, request }) => {
    const user = makeUser('authclick');
    await apiSignup(request, user);
    await apiLogin(request, user);

    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Login via UI
    await page.goto(BASE);
    await page.locator('#viewLanding').waitFor({ state: 'visible', timeout: 12_000 });
    await page.locator('[data-testid="login-button"]').click();
    await page.locator('#viewLogin').waitFor({ state: 'visible', timeout: 8_000 });
    await page.fill('#loginEmail', user.email);
    await page.fill('#loginPassword', user.password);
    await page.click('#formLogin button[type="submit"]');
    await expect(page.locator('#viewLogin')).not.toBeVisible({ timeout: 12_000 });

    // Wait for auth home view
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

    // Page should still be stable
    await expect(page.locator('body')).not.toBeEmpty();
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('Non-Error promise rejection') &&
        !e.includes('favicon')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});

// ─── Error monitoring — network failures ─────────────────────────────────────

test.describe('UI Crash — network error monitoring', () => {
  test('core API endpoints do not return 500 on landing page load', async ({ page }) => {
    const serverErrors = [];
    page.on('response', (response) => {
      const url = response.url();
      // Only check app API endpoints (not external CDN/assets)
      if (url.includes('/api/') && response.status() >= 500) {
        serverErrors.push(`${response.status()} ${url}`);
      }
    });

    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    expect(serverErrors).toHaveLength(0);
  });

  test('/api/me returns 401 (not 500) when not authenticated', async ({ request }) => {
    const res = await request.get(`${BASE}/api/me`);
    expect(res.status()).toBe(401);
  });

  test('/api/health or root endpoint returns 2xx', async ({ request }) => {
    // Try /api/health first, fall back to root
    const healthRes = await request.get(`${BASE}/api/health`).catch(() => null);
    if (healthRes && healthRes.ok()) {
      expect(healthRes.ok()).toBeTruthy();
      return;
    }
    // Root page should return 2xx
    const rootRes = await request.get(`${BASE}/`);
    expect(rootRes.ok()).toBeTruthy();
  });
});
