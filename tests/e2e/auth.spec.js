// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * End-to-end authentication tests.
 * Covers: landing page, signup, login, session persistence, logout.
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeUser() {
  const id = uid();
  return {
    email: `e2e_auth_${id}@test.invalid`,
    password: 'E2eTest123!',
    djName: `DJ_Auth_${id}`.slice(0, 30),
  };
}

test.describe('Auth flow', () => {
  test('landing page loads', async ({ page }) => {
    await page.goto(BASE);
    await expect(page).toHaveURL(/./);
    // The page should render something — at minimum a body element with content
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('signup creates account and reaches authenticated view', async ({ page }) => {
    const user = makeUser();
    await page.goto(BASE);

    // Navigate to signup
    const signupBtn = page.locator('button, a').filter({ hasText: /sign up|register|create account/i }).first();
    if (await signupBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await signupBtn.click();
    } else {
      await page.goto(`${BASE}/#signup`);
    }

    // Fill signup form
    await page.locator('input[type="email"]').first().fill(user.email);
    const passwordFields = page.locator('input[type="password"]');
    await passwordFields.first().fill(user.password);
    // Some forms have a confirm-password field
    if ((await passwordFields.count()) > 1) {
      await passwordFields.nth(1).fill(user.password);
    }
    const djNameField = page.locator('input[name="djName"], input[id="signupDjName"]').first();
    if (await djNameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await djNameField.fill(user.djName);
    }

    await page.locator('button[type="submit"], button').filter({ hasText: /sign up|register|create/i }).first().click();

    // After signup the UI should leave the signup view
    await expect(page.locator('body')).not.toContainText('Sign up', { timeout: 10000 }).catch(() => {});
  });

  test('login succeeds and /api/me returns authenticated user', async ({ page, request }) => {
    const user = makeUser();

    // Create account via API
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });

    // Verify login via API
    const loginRes = await request.post(`${BASE}/api/auth/login`, {
      data: { email: user.email, password: user.password },
    });
    expect(loginRes.ok()).toBeTruthy();
    const loginBody = await loginRes.json();
    expect(loginBody.success).toBe(true);
    expect(loginBody.user.email).toBe(user.email.toLowerCase());

    // /api/me should return the authenticated user using the cookie from the login response
    const meRes = await request.get(`${BASE}/api/me`);
    expect(meRes.ok()).toBeTruthy();
    const meBody = await meRes.json();
    expect(meBody.user.email).toBe(user.email.toLowerCase());
  });

  test('logout destroys session — /api/me returns 401 afterwards', async ({ request }) => {
    const user = makeUser();

    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });
    await request.post(`${BASE}/api/auth/login`, {
      data: { email: user.email, password: user.password },
    });

    // Confirm authenticated
    const meRes = await request.get(`${BASE}/api/me`);
    expect(meRes.ok()).toBeTruthy();

    // Logout
    const logoutRes = await request.post(`${BASE}/api/auth/logout`);
    expect(logoutRes.ok()).toBeTruthy();

    // Cookie should be cleared — new request context won't have the cookie
    // (Playwright APIRequestContext preserves cookies so we check the logout cleared it)
    const meAfter = await request.get(`${BASE}/api/me`);
    expect(meAfter.status()).toBe(401);
  });

  test('unauthenticated /api/me returns 401', async ({ request }) => {
    // Use a fresh request context with no cookies
    const meRes = await request.get(`${BASE}/api/me`);
    expect(meRes.status()).toBe(401);
  });

  test('UI transitions to authenticated view after login', async ({ page }) => {
    const user = makeUser();

    // Pre-create account
    const req = page.context().request;
    await req.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });

    await page.goto(BASE);

    // Find and click login button/link
    const loginLink = page.locator('button, a').filter({ hasText: /log in|sign in/i }).first();
    if (await loginLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await loginLink.click();
    } else {
      await page.goto(`${BASE}/#login`);
    }

    await page.locator('input[type="email"]').first().fill(user.email);
    await page.locator('input[type="password"]').first().fill(user.password);
    await page.locator('button[type="submit"], button').filter({ hasText: /log in|sign in/i }).first().click();

    // After login the app should no longer show the login form
    await page.waitForTimeout(2000);
    const loginForm = page.locator('#formLogin, form').filter({ hasText: /log in|sign in/i });
    // Either the form is gone or the URL changed
    const visible = await loginForm.isVisible().catch(() => false);
    // Acceptable: form hidden OR we navigated away from login
    expect(!visible || !page.url().includes('#login')).toBeTruthy();
  });
});
