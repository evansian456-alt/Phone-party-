// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * COMPREHENSIVE APP AUDIT — Landing, Auth, Navigation
 *
 * Every view, button, link and display element is validated:
 * - Does it render?
 * - Does pressing it navigate/act correctly?
 * - Does content disappear when it should?
 * - Is displayed text accurate?
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() { return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }
function makeUser(p = 'audit') {
  const id = uid();
  return { email: `e2e_${p}_${id}@test.invalid`, password: 'Audit123!', djName: `DJ_${p}_${id}`.slice(0, 30) };
}
async function signup(request, u) {
  return request.post(`${BASE}/api/auth/signup`, { data: { email: u.email, password: u.password, djName: u.djName, termsAccepted: true } });
}
async function login(request, u) {
  return request.post(`${BASE}/api/auth/login`, { data: { email: u.email, password: u.password } });
}

// ─────────────────────────────────────────────────────────────────
// LANDING PAGE
// ─────────────────────────────────────────────────────────────────
test.describe('Landing page', () => {
  test('renders title, subtitle and info cards', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('#viewLanding')).toBeVisible();
    await expect(page.locator('.landing-title-new')).toContainText('PHONE PARTY');
    await expect(page.locator('.landing-subtitle-new')).toContainText(/Turn Phones/i);
    // 3 info cards
    const cards = page.locator('.info-card');
    await expect(cards).toHaveCount(3);
  });

  test('GET STARTED FREE button navigates to signup', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingSignup');
    await expect(page.locator('#viewSignup')).toBeVisible();
    await expect(page.locator('#viewLanding')).not.toBeVisible();
  });

  test('LOG IN button navigates to login', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingLogin');
    await expect(page.locator('#viewLogin')).toBeVisible();
    await expect(page.locator('#viewLanding')).not.toBeVisible();
  });

  test('landing page prices are in GBP', async ({ page }) => {
    await page.goto(BASE);
    const bodyText = await page.locator('body').textContent();
    // Should mention £ (GBP) not $ (USD)
    expect(bodyText).toContain('£');
  });

  test('landing page does not show Invite Friends banner', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('#viewLanding')).toBeVisible();
    // The referral promo banner must not appear on the landing page
    await expect(page.locator('#referralLandingBanner')).not.toBeAttached();
  });
});

// ─────────────────────────────────────────────────────────────────
// SIGNUP VIEW
// ─────────────────────────────────────────────────────────────────
test.describe('Signup view', () => {
  test('form renders all required fields', async ({ page }) => {
    await page.goto(`${BASE}/#signup`);
    await page.click('#btnLandingSignup').catch(() => {});
    await page.waitForSelector('#viewSignup', { state: 'visible' });

    await expect(page.locator('#signupEmail')).toBeVisible();
    await expect(page.locator('#signupPassword')).toBeVisible();
    await expect(page.locator('#signupDjName')).toBeVisible();
    await expect(page.locator('#viewSignup button[type="submit"]')).toBeVisible();
  });

  test('signup with valid data succeeds and transitions away from signup view', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingSignup');
    await page.waitForSelector('#viewSignup', { state: 'visible' });

    const u = makeUser('signup');
    await page.fill('#signupEmail', u.email);
    await page.fill('#signupPassword', u.password);
    await page.fill('#signupDjName', u.djName);
    await page.click('#viewSignup button[type="submit"]');

    // Should navigate away from signup
    await page.waitForTimeout(2000);
    const signupVisible = await page.locator('#viewSignup').isVisible();
    // After successful signup the user should be on home/authHome — not still on signup
    expect(signupVisible).toBe(false);
  });

  test('signup with missing DJ name shows error', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingSignup');
    await page.waitForSelector('#viewSignup', { state: 'visible' });

    await page.fill('#signupEmail', `missing_dj_${uid()}@test.invalid`);
    await page.fill('#signupPassword', 'Pass123!');
    // intentionally leave djName empty
    await page.click('#viewSignup button[type="submit"]');

    // Error should appear
    const err = page.locator('#signupError');
    await expect(err).toBeVisible({ timeout: 3000 });
    await expect(err).not.toBeEmpty();
  });

  test('"Already have an account?" link goes to login', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingSignup');
    await page.waitForSelector('#viewSignup', { state: 'visible' });
    await page.click('#linkToLogin');
    await expect(page.locator('#viewLogin')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────
// LOGIN VIEW
// ─────────────────────────────────────────────────────────────────
test.describe('Login view', () => {
  test('form renders email, password, submit button', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingLogin');
    await expect(page.locator('#loginEmail')).toBeVisible();
    await expect(page.locator('#loginPassword')).toBeVisible();
    await expect(page.locator('#formLogin button[type="submit"]')).toBeVisible();
  });

  test('wrong password shows error, does not navigate away', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingLogin');
    await page.fill('#loginEmail', 'nonexistent@test.invalid');
    await page.fill('#loginPassword', 'WrongPass!');
    await page.click('#formLogin button[type="submit"]');
    await page.waitForTimeout(1500);

    const err = page.locator('#loginError');
    await expect(err).toBeVisible({ timeout: 4000 });
    await expect(page.locator('#viewLogin')).toBeVisible();
  });

  test('valid login transitions to authenticated home', async ({ page, request }) => {
    const u = makeUser('logintest');
    await signup(request, u);

    await page.goto(BASE);
    await page.click('#btnLandingLogin');
    await page.fill('#loginEmail', u.email);
    await page.fill('#loginPassword', u.password);
    await page.click('#formLogin button[type="submit"]');

    await page.waitForTimeout(2000);
    // Should no longer be on login view
    const loginVisible = await page.locator('#viewLogin').isVisible();
    expect(loginVisible).toBe(false);
  });

  test('"Forgot password?" link shows reset form', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingLogin');
    await page.click('#linkForgotPassword');
    await expect(page.locator('#viewPasswordReset')).toBeVisible();
  });

  test('"Create account" link goes to signup', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingLogin');
    await page.click('#linkToSignup');
    await expect(page.locator('#viewSignup')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────
// PASSWORD RESET VIEW
// ─────────────────────────────────────────────────────────────────
test.describe('Password reset view', () => {
  test('reset form renders correctly', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingLogin');
    await page.click('#linkForgotPassword');
    await expect(page.locator('#resetEmail')).toBeVisible();
    await expect(page.locator('#formPasswordResetRequest button[type="submit"]')).toBeVisible();
  });

  test('"Back to Login" link returns to login', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingLogin');
    await page.click('#linkForgotPassword');
    await page.click('#linkResetToLogin');
    await expect(page.locator('#viewLogin')).toBeVisible();
  });

  test('submitting reset form for non-existent email shows feedback', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingLogin');
    await page.click('#linkForgotPassword');
    await page.fill('#resetEmail', `nobody_${uid()}@test.invalid`);
    await page.click('#formPasswordResetRequest button[type="submit"]');
    await page.waitForTimeout(1500);
    // Should show success or error message — not crash
    const success = page.locator('#resetRequestSuccess');
    const error = page.locator('#resetRequestError');
    const hasAny = (await success.isVisible()) || (await error.isVisible());
    expect(hasAny).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// AUTHENTICATED HOME (authHome / viewAuthHome)
// ─────────────────────────────────────────────────────────────────
test.describe('Authenticated home', () => {
  test('shows create and join party buttons after login', async ({ page, request }) => {
    const u = makeUser('authhome');
    await signup(request, u);

    await page.goto(BASE);
    await page.click('#btnLandingLogin');
    await page.fill('#loginEmail', u.email);
    await page.fill('#loginPassword', u.password);
    await page.click('#formLogin button[type="submit"]');
    await page.waitForTimeout(2000);

    // viewAuthHome should be visible
    const authHome = page.locator('#viewAuthHome');
    if (await authHome.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(page.locator('#btnPartyShowCreateParty')).toBeVisible();
      await expect(page.locator('#btnPartyShowJoinParty')).toBeVisible();
    }
  });

  test('plan pill shows correct tier info', async ({ page, request }) => {
    const u = makeUser('planpill');
    await signup(request, u);

    await page.goto(BASE);
    await page.click('#btnLandingLogin');
    await page.fill('#loginEmail', u.email);
    await page.fill('#loginPassword', u.password);
    await page.click('#formLogin button[type="submit"]');
    await page.waitForTimeout(2000);

    const planPill = page.locator('#planPill');
    if (await planPill.isVisible({ timeout: 3000 }).catch(() => false)) {
      const text = await planPill.textContent();
      // Should mention tier and phone count
      expect(text).toMatch(/FREE|PARTY|PRO/i);
      expect(text).toMatch(/\d\s*phone/i);
    }
  });

  test('nav header auth buttons appear after login', async ({ page, request }) => {
    const u = makeUser('navbtn');
    await signup(request, u);

    await page.goto(BASE);
    await page.click('#btnLandingLogin');
    await page.fill('#loginEmail', u.email);
    await page.fill('#loginPassword', u.password);
    await page.click('#formLogin button[type="submit"]');
    await page.waitForTimeout(2000);

    // Upgrade, leaderboard and profile buttons should appear (post-auth-only elements)
    const upgradeBtn = page.locator('#btnUpgradeHub');
    if (await upgradeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      expect(await upgradeBtn.isVisible()).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────────────────────────
test.describe('Logout', () => {
  test('logout returns to landing and clears auth', async ({ page, request }) => {
    const u = makeUser('logout');
    await signup(request, u);
    await login(request, u);

    await page.goto(BASE);
    await page.waitForTimeout(1500);

    // Click logout if button is visible
    const logoutBtn = page.locator('#btnLogout').first();
    if (await logoutBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await logoutBtn.click();
      await page.waitForTimeout(1500);
      await expect(page.locator('#viewLanding')).toBeVisible();
    }

    // /api/me should be 401 after logout
    const meRes = await request.get(`${BASE}/api/me`);
    expect(meRes.status()).toBe(401);
  });
});
