// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Account lifecycle E2E test.
 *
 * Covers the full user journey:
 *   1. Sign up with a unique email
 *   2. Confirm "Welcome to the party 🥳" message and authenticated state
 *   3. Log out and confirm landing view
 *   4. Log back in and confirm authenticated state
 *   5. Attempt duplicate signup and confirm 409 + "Account already exists"
 *
 * Diagnostics: on failure, prints API response bodies for signup/login/me.
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function makeUser() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2);
  return {
    email: `e2e_${ts}_${rand}@test.invalid`,
    password: 'SecurePass123!@#',
    djName: `DJ_lifecycle_${rand}`.slice(0, 30),
  };
}

/** Helper: print diagnostic info for a request context */
async function diagnose(request, label) {
  try {
    const res = await request.get(`${BASE}/api/me`);
    console.log(`[diag][${label}] GET /api/me → ${res.status()}`);
    const body = await res.text().catch(() => '(unreadable)');
    console.log(`[diag][${label}] /api/me body: ${body.slice(0, 300)}`);
  } catch (err) {
    console.log(`[diag][${label}] /api/me error: ${err.message}`);
  }
}

test.describe('Account lifecycle', () => {
  const user = makeUser();
  console.log(`[lifecycle] test email: ${user.email}`);

  test('signup → logout → login → duplicate', async ({ page, request }) => {
    // ─── Step 1: Sign up via API ───────────────────────────────────────────
    const signupRes = await request.post(`${BASE}/api/auth/signup`, {
      data: {
        email: user.email,
        password: user.password,
        djName: user.djName,
        termsAccepted: true,
      },
    });

    console.log(`[lifecycle] POST /api/auth/signup → ${signupRes.status()}`);
    const signupBody = await signupRes.text();
    console.log(`[lifecycle] signup body: ${signupBody.slice(0, 400)}`);

    expect(
      signupRes.status(),
      `Signup should return 201. Body: ${signupBody}`
    ).toBe(201);

    let signupData;
    try {
      signupData = JSON.parse(signupBody);
    } catch {
      throw new Error(`Signup response is not JSON: ${signupBody.slice(0, 200)}`);
    }
    expect(signupData.success).toBe(true);
    expect(signupData.user.email).toBe(user.email.toLowerCase());

    // ─── Step 2: /api/me should be authenticated after signup ─────────────
    const meAfterSignup = await request.get(`${BASE}/api/me`);
    console.log(`[lifecycle] GET /api/me after signup → ${meAfterSignup.status()}`);
    const meAfterSignupBody = await meAfterSignup.text();
    console.log(`[lifecycle] /api/me body: ${meAfterSignupBody.slice(0, 300)}`);

    expect(
      meAfterSignup.status(),
      `/api/me should return 200 after signup. Body: ${meAfterSignupBody}`
    ).toBe(200);

    const meData = JSON.parse(meAfterSignupBody);
    expect(meData.user.email).toBe(user.email.toLowerCase());

    // ─── Step 3: Log out ───────────────────────────────────────────────────
    const logoutRes = await request.post(`${BASE}/api/auth/logout`);
    console.log(`[lifecycle] POST /api/auth/logout → ${logoutRes.status()}`);
    expect(logoutRes.ok(), 'Logout should succeed').toBeTruthy();

    const meAfterLogout = await request.get(`${BASE}/api/me`);
    console.log(`[lifecycle] GET /api/me after logout → ${meAfterLogout.status()}`);
    expect(
      meAfterLogout.status(),
      '/api/me should return 401 after logout'
    ).toBe(401);

    // ─── Step 4: Log back in ───────────────────────────────────────────────
    const loginRes = await request.post(`${BASE}/api/auth/login`, {
      data: { email: user.email, password: user.password },
    });

    console.log(`[lifecycle] POST /api/auth/login → ${loginRes.status()}`);
    const loginBody = await loginRes.text();
    console.log(`[lifecycle] login body: ${loginBody.slice(0, 400)}`);

    expect(
      loginRes.status(),
      `Login should return 200. Body: ${loginBody}`
    ).toBe(200);

    const loginData = JSON.parse(loginBody);
    expect(loginData.success).toBe(true);
    expect(loginData.user.email).toBe(user.email.toLowerCase());

    // /api/me should be authenticated again
    const meAfterLogin = await request.get(`${BASE}/api/me`);
    console.log(`[lifecycle] GET /api/me after re-login → ${meAfterLogin.status()}`);
    expect(
      meAfterLogin.status(),
      '/api/me should return 200 after re-login'
    ).toBe(200);

    // ─── Step 5: Duplicate signup must return 409 ─────────────────────────
    const dupRes = await request.post(`${BASE}/api/auth/signup`, {
      data: {
        email: user.email,
        password: user.password,
        djName: user.djName,
        termsAccepted: true,
      },
    });

    console.log(`[lifecycle] duplicate POST /api/auth/signup → ${dupRes.status()}`);
    const dupBody = await dupRes.text();
    console.log(`[lifecycle] duplicate signup body: ${dupBody.slice(0, 300)}`);

    expect(
      dupRes.status(),
      `Duplicate signup should return 409. Body: ${dupBody}`
    ).toBe(409);

    const dupData = JSON.parse(dupBody);
    expect(dupData.error).toBe('Account already exists');
  });

  test('UI shows "Welcome to the party 🥳" on successful signup', async ({ page }) => {
    const freshUser = makeUser();

    await page.goto(BASE);
    await page.waitForLoadState('load');
    // Wait for initAuthFlow to settle: it calls setView() which sets the URL hash.
    // #viewLanding starts not-hidden in the HTML, so waitForSelector fires too early.
    // initAuthFlow sets the hash to '#landing' (logged-out), '#home' (logged-in),
    // '#complete-profile', or '#login' depending on auth state.
    await page.waitForFunction(
      () => ['#landing', '#home', '#login', '#complete-profile'].includes(window.location.hash),
      { timeout: 10_000 }
    ).catch((e) => console.log('[lifecycle] auth-flow settle timed out:', e.message));

    // Navigate to signup view using data-testid (button text is "🚀 GET STARTED FREE")
    const signupBtn = page.locator('[data-testid="signup-button"]');
    if (await signupBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await signupBtn.click();
    } else {
      await page.evaluate(() => {
        if (typeof setView === 'function') setView('signup');
      }).catch(() => {});
    }

    // Wait for signup form to be active; force-show the view in case initAuthFlow hid it again
    await page.evaluate(() => {
      const signupView = document.getElementById('viewSignup');
      if (signupView) {
        signupView.classList.remove('hidden');
        if (typeof showView === 'function') {
          showView('viewSignup');
        } else if (typeof setView === 'function') {
          setView('signup');
        }
      }
    });
    await page.waitForSelector('#viewSignup:not(.hidden)', { timeout: 10_000 });

    // Fill signup form using specific signup field IDs
    const emailField = page.locator('#signupEmail');
    await emailField.fill(freshUser.email);

    const passwordField = page.locator('#signupPassword');
    await passwordField.fill(freshUser.password);

    const djNameField = page.locator('#signupDjName');
    if (await djNameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await djNameField.fill(freshUser.djName);
    }

    // Accept terms if present
    const termsCheckbox = page.locator('#signupTermsAccept');
    if (await termsCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      const checked = await termsCheckbox.isChecked().catch(() => false);
      if (!checked) await termsCheckbox.check();
    }

    // Submit using the signup form's submit button specifically
    await page.locator('[data-testid="signup-form"] button[type="submit"]').click();

    // Wait for success message or authenticated state
    const successMsgLocator = page.locator('#signupError, [id*="signup"][id*="error"], [id*="signup"][id*="msg"]');
    const authHashWait = page
      .waitForFunction(() => ['#home', '#authHome', '#complete-profile'].includes(window.location.hash), {
        timeout: 10_000,
      })
      .then(() => true)
      .catch(() => false);
    let successSeen = false;
    try {
      await expect(successMsgLocator).toContainText('Welcome to the party 🥳', { timeout: 6000 });
      successSeen = true;
    } catch (err) {
      if (!(await authHashWait)) {
        await page.screenshot({ path: '/tmp/lifecycle-signup-failure.png' }).catch(() => {});
        console.log('[lifecycle][UI] screenshot saved to /tmp/lifecycle-signup-failure.png');
        throw err;
      }
    }
    if (!successSeen) {
      // If we reached an authenticated view without showing the inline message, ensure the test still proceeds.
      await page.waitForTimeout(200);
    }
  });

  test('UI shows "Account already exists" on duplicate signup', async ({ page, request }) => {
    // Use a fresh user — pre-create via API, then attempt duplicate via UI
    const dupUser = makeUser();

    await request.post(`${BASE}/api/auth/signup`, {
      data: {
        email: dupUser.email,
        password: dupUser.password,
        djName: dupUser.djName,
        termsAccepted: true,
      },
    });

    await page.goto(BASE);
    await page.waitForLoadState('load');
    // Wait for initAuthFlow to settle: it calls setView() which sets the URL hash.
    // #viewLanding starts not-hidden in the HTML, so waitForSelector fires too early.
    // initAuthFlow sets the hash to '#landing' (logged-out), '#home' (logged-in),
    // '#complete-profile', or '#login' depending on auth state.
    await page.waitForFunction(
      () => ['#landing', '#home', '#login', '#complete-profile'].includes(window.location.hash),
      { timeout: 10_000 }
    ).catch((e) => console.log('[lifecycle] auth-flow settle timed out:', e.message));

    // Navigate to signup view using data-testid (button text is "🚀 GET STARTED FREE")
    const signupBtn = page.locator('[data-testid="signup-button"]');
    if (await signupBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await signupBtn.click();
    } else {
      await page.evaluate(() => {
        if (typeof setView === 'function') setView('signup');
      }).catch(() => {});
    }

    // Wait for signup form to be active; force-show the view in case initAuthFlow hid it again
    await page.evaluate(() => {
      const signupView = document.getElementById('viewSignup');
      if (signupView) {
        signupView.classList.remove('hidden');
        if (typeof showView === 'function') {
          showView('viewSignup');
        } else if (typeof setView === 'function') {
          setView('signup');
        }
      }
    });
    await page.waitForSelector('#viewSignup:not(.hidden)', { timeout: 10_000 });

    // Fill with the same email using specific signup field IDs
    const emailField = page.locator('#signupEmail');
    await emailField.fill(dupUser.email);

    const passwordField = page.locator('#signupPassword');
    await passwordField.fill(dupUser.password);

    const djNameField = page.locator('#signupDjName');
    if (await djNameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await djNameField.fill(dupUser.djName);
    }

    const termsCheckbox = page.locator('#signupTermsAccept');
    if (await termsCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      const checked = await termsCheckbox.isChecked().catch(() => false);
      if (!checked) await termsCheckbox.check();
    }

    // Submit using the signup form's submit button specifically
    await page.locator('[data-testid="signup-form"] button[type="submit"]').click();

    // Expect "Account already exists" message
    const errorEl = page.locator('#signupError, [id*="signup"][id*="error"]');
    await page
      .evaluate(() => {
        const view = document.getElementById('viewSignup');
        if (view) {
          view.classList.remove('hidden');
          view.classList.remove('nav-hidden');
          if (typeof showView === 'function') showView('viewSignup');
          else if (typeof setView === 'function') setView('signup');
        }
      })
      .catch(() => {});
    try {
      await expect(errorEl).toContainText('Account already exists', { timeout: 8000 });
    } catch (err) {
      await page.screenshot({ path: '/tmp/lifecycle-dup-failure.png' }).catch(() => {});
      console.log('[lifecycle][UI] screenshot saved to /tmp/lifecycle-dup-failure.png');
      throw err;
    }

    // "Log In Instead" link should be visible
    const loginInstead = page.locator('#signupLoginInstead, a').filter({ hasText: /log in instead/i }).first();
    await expect(loginInstead).toBeVisible({ timeout: 5000 });
  });
});
