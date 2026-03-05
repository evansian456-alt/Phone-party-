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
  test('login with wrong password shows error in auth-error-box', async ({ page, request }) => {
    const user = makeUser();
    // Pre-create user using the standalone request fixture (NOT page.request)
    // to avoid setting an auth cookie on the page context which would cause
    // the app to start in authenticated state, hiding the landing/login view.
    const signupRes = await request.post(`${BASE}/api/auth/signup`, {
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

// ─── Full UI signup → logout → login flow (no API shortcuts) ─────────────────
//
// Requirement: users must be able to sign up from the FIRST PAGE via the UI.
// This test validates the entire journey in a real Chromium browser.

test.describe('Full UI signup → logout → login journey', () => {
  test('user can sign up, log out, and log back in from the landing page', async ({ page }) => {
    const user = makeUser('ui_signup');

    // ── Step 1: Open landing page ──────────────────────────────────────────
    await page.goto(BASE);
    await expect(page.locator('[data-testid="signup-button"]')).toBeVisible({ timeout: 10000 });

    // ── Step 2: Navigate to Create Account view ───────────────────────────
    await page.locator('[data-testid="signup-button"]').click();
    await page.locator('#viewSignup').waitFor({ state: 'visible', timeout: 5000 });

    // ── Step 3: Fill in signup form ────────────────────────────────────────
    await page.locator('#signupEmail').fill(user.email);
    await page.locator('#signupPassword').fill(user.password);
    await page.locator('#signupDjName').fill(user.djName);

    const terms = page.locator('#signupTermsAccept');
    if (!(await terms.isChecked())) await terms.check();

    // ── Step 4: Submit ─────────────────────────────────────────────────────
    await page.locator('[data-testid="signup-form"] button[type="submit"]').click();

    // ── Step 5: Verify no 429 error and authenticated view shown ──────────
    // The signup success message ("Welcome to the party 🥳") is transient;
    // immediately after it initAuthFlow() transitions to the authenticated home view.
    await page.waitForFunction(() => {
      const errEl = document.getElementById('signupError');
      const has429 = errEl && errEl.textContent && errEl.textContent.includes('429');
      if (has429) throw new Error('429 rate-limit error shown during signup');
      // Check we are on an authenticated view
      const authHome = document.getElementById('viewAuthHome');
      const home = document.getElementById('viewHome');
      return (
        (authHome && !authHome.classList.contains('hidden')) ||
        (home && !home.classList.contains('hidden'))
      );
    }, { timeout: 15000 });

    // ── Step 6: Log out ────────────────────────────────────────────────────
    const logoutBtn = page.locator('[data-testid="logout-button"]').first();
    await expect(logoutBtn).toBeVisible({ timeout: 8000 });
    await logoutBtn.click();

    // After logout the landing / unauthenticated view should be visible
    await page.waitForFunction(() => {
      const landing = document.getElementById('viewLanding');
      return landing && !landing.classList.contains('hidden');
    }, { timeout: 10000 });

    // ── Step 7: Log back in with the same credentials ─────────────────────
    await page.locator('[data-testid="login-button"]').click();
    await page.locator('#loginEmail').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#loginEmail').fill(user.email);
    await page.locator('#loginPassword').fill(user.password);
    await page.locator('[data-testid="login-form"] button[type="submit"]').click();

    // Authenticated view must appear again
    await page.waitForFunction(() => {
      const authHome = document.getElementById('viewAuthHome');
      const home = document.getElementById('viewHome');
      return (
        (authHome && !authHome.classList.contains('hidden')) ||
        (home && !home.classList.contains('hidden'))
      );
    }, { timeout: 12000 });
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
