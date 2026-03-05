// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * E2E Audit — Auth Flow
 *
 * Validates data-testid attributes on auth elements and tests:
 * - signup-button / login-button presence on landing
 * - signup-form / login-form presence in their views
 * - auth-error-box appears on bad credentials
 * - logout-button works
 * - nav-settings button visible after login
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
function makeUser(p = 'audit_auth') {
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

// ─── data-testid presence tests ──────────────────────────────────────────────

test.describe('Auth data-testid attributes', () => {
  test('signup-button is present on landing page', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="signup-button"]')).toBeVisible({ timeout: 10000 });
  });

  test('login-button is present on landing page', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="login-button"]')).toBeVisible({ timeout: 10000 });
  });

  test('signup-form is present in signup view', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('[data-testid="signup-button"]').click();
    await expect(page.locator('[data-testid="signup-form"]')).toBeVisible({ timeout: 5000 });
  });

  test('login-form is present in login view', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('[data-testid="login-button"]').click();
    await expect(page.locator('[data-testid="login-form"]')).toBeVisible({ timeout: 5000 });
  });

  test('auth-error-box is present in login form', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('[data-testid="login-button"]').click();
    await page.locator('#viewLogin').waitFor({ state: 'visible', timeout: 5000 });
    // The error box exists in the DOM (hidden by default)
    await expect(page.locator('#viewLogin [data-testid="auth-error-box"]')).toBeAttached();
  });

  test('auth-error-box is present in signup form', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('[data-testid="signup-button"]').click();
    await page.locator('#viewSignup').waitFor({ state: 'visible', timeout: 5000 });
    await expect(page.locator('#viewSignup [data-testid="auth-error-box"]')).toBeAttached();
  });

  test('toast element exists in the DOM', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('[data-testid="toast"]')).toBeAttached();
  });
});

// ─── Auth error handling ──────────────────────────────────────────────────────

test.describe('Auth error flow', () => {
  test('login with wrong password shows error in auth-error-box', async ({ page }) => {
    const user = makeUser();
    // Pre-create user
    const signupRes = await page.request.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });
    expect(signupRes.ok()).toBeTruthy();

    await page.goto(BASE);
    await page.locator('[data-testid="login-button"]').click();
    await page.locator('#loginEmail').waitFor({ state: 'visible', timeout: 5000 });

    await page.locator('#loginEmail').fill(user.email);
    await page.locator('#loginPassword').fill('WrongPassword!');
    await page.locator('[data-testid="login-form"] button[type="submit"]').click();

    // Error box should become visible with an error message
    await expect(page.locator('#viewLogin [data-testid="auth-error-box"]')).toBeVisible({ timeout: 8000 });
    const errText = await page.locator('#viewLogin [data-testid="auth-error-box"]').textContent();
    expect(errText && errText.trim().length).toBeGreaterThan(0);
  });

  test('signup with duplicate email shows error in auth-error-box', async ({ page, request }) => {
    const user = makeUser();
    // Pre-create user
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });

    await page.goto(BASE);
    await page.locator('[data-testid="signup-button"]').click();
    await page.locator('#signupEmail').waitFor({ state: 'visible', timeout: 5000 });

    await page.locator('#signupEmail').fill(user.email);
    await page.locator('#signupPassword').fill(user.password);
    await page.locator('#signupDjName').fill(user.djName);
    const terms = page.locator('#signupTermsAccept');
    if (!(await terms.isChecked())) await terms.check();

    await page.locator('[data-testid="signup-form"] button[type="submit"]').click();

    await expect(page.locator('#viewSignup [data-testid="auth-error-box"]')).toBeVisible({ timeout: 8000 });
    const errText = await page.locator('#viewSignup [data-testid="auth-error-box"]').textContent();
    expect(errText && errText.trim().length).toBeGreaterThan(0);
  });
});

// ─── Logout flow ─────────────────────────────────────────────────────────────

test.describe('Logout flow', () => {
  test('logout-button present in header after login', async ({ page, request }) => {
    const user = makeUser();
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });

    await page.goto(BASE);
    await page.locator('[data-testid="login-button"]').click();
    await page.locator('#loginEmail').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#loginEmail').fill(user.email);
    await page.locator('#loginPassword').fill(user.password);
    await page.locator('[data-testid="login-form"] button[type="submit"]').click();

    // After login the header logout button should be visible
    await expect(page.locator('#headerAuthButtons [data-testid="logout-button"]')).toBeVisible({ timeout: 10000 });
  });

  test('nav-settings button is visible after login', async ({ page, request }) => {
    const user = makeUser();
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });

    await page.goto(BASE);
    await page.locator('[data-testid="login-button"]').click();
    await page.locator('#loginEmail').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#loginEmail').fill(user.email);
    await page.locator('#loginPassword').fill(user.password);
    await page.locator('[data-testid="login-form"] button[type="submit"]').click();

    await expect(page.locator('[data-testid="nav-settings"]')).toBeVisible({ timeout: 10000 });
  });

  test('API logout clears session — /api/me returns 401', async ({ request }) => {
    const user = makeUser();
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });
    await request.post(`${BASE}/api/auth/login`, {
      data: { email: user.email, password: user.password },
    });

    const meBefore = await request.get(`${BASE}/api/me`);
    expect(meBefore.ok()).toBeTruthy();

    await request.post(`${BASE}/api/auth/logout`);

    const meAfter = await request.get(`${BASE}/api/me`);
    expect(meAfter.status()).toBe(401);
  });
});
