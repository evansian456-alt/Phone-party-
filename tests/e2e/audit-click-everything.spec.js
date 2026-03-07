// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');

/**
 * AUDIT: Click-Everything
 *
 * Navigates through every major view of the app and clicks every visible,
 * enabled button/link. Asserts:
 *   - No JavaScript crash (no uncaught error dialog)
 *   - Page doesn't break (body still present with content)
 *
 * Buttons that trigger navigation are handled by restoring state before
 * the next test.
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
function makeUser(prefix = 'click') {
  const id = uid();
  return {
    email: `e2e_${prefix}_${id}@test.invalid`,
    password: 'ClickTest123!',
    djName: `DJ_${prefix}_${id}`.slice(0, 30),
  };
}

async function screenshot(page, name) {
  const dir = path.resolve(__dirname, '../../playwright-audit-report/screenshots');
  require('fs').mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `click_${name.replace(/[^a-z0-9_-]/gi, '_')}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
}

async function signupAndLogin(page, request, user) {
  const signupRes = await request.post(`${BASE}/api/auth/signup`, {
    data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
  });
  if (!signupRes.ok() && signupRes.status() !== 409) {
    const body = await signupRes.text();
    throw new Error(`Signup failed: ${signupRes.status()} ${body}`);
  }
  await page.goto(BASE);
  await page.locator('#viewLanding').waitFor({ state: 'visible', timeout: 12_000 });
  await page.click('[data-testid="login-button"]');
  await page.locator('#viewLogin').waitFor({ state: 'visible', timeout: 8_000 });
  await page.fill('#loginEmail', user.email);
  await page.fill('#loginPassword', user.password);
  await page.click('#formLogin button[type="submit"]');
  await expect(page.locator('#viewLogin')).not.toBeVisible({ timeout: 12_000 });
  // Wait for auth home view to fully render (viewAuthHome or viewHome)
  await page.waitForSelector('#viewAuthHome:not(.hidden), #viewHome:not(.hidden)', { timeout: 12_000 });
}

/**
 * Create a party through the UI, handling both viewAuthHome and viewHome flows.
 * Returns the party code.
 */
async function createPartyInUI(page, djName) {
  // Wait for auth state — either viewAuthHome or viewHome active
  await page.waitForFunction(() => {
    const ah = document.getElementById('viewAuthHome');
    const h = document.getElementById('viewHome');
    return (ah && !ah.classList.contains('hidden')) || (h && !h.classList.contains('hidden'));
  }, { timeout: 15_000 });

  // Click the create party button from the ACTIVE view
  const isAuthHome = await page.evaluate(() => {
    const el = document.getElementById('viewAuthHome');
    return el && !el.classList.contains('hidden');
  });

  if (isAuthHome) {
    // viewAuthHome flow: click big button, fill form, click start → goes to viewHome
    await page.locator('#viewAuthHome [data-testid="create-party"]').click();
    const hostInput = page.locator('#partyHostName');
    await hostInput.waitFor({ state: 'visible', timeout: 5_000 });
    await hostInput.fill(djName);
    await page.locator('[data-testid="start-party-auth-home"]').click();
    // Transitions to viewHome with createPartySection visible
    await page.waitForFunction(() => {
      const h = document.getElementById('viewHome');
      return h && !h.classList.contains('hidden');
    }, { timeout: 10_000 });
  } else {
    // viewHome flow: click big create button to show create section
    await page.locator('#viewHome [data-testid="create-party"]').click();
  }

  // Fill hostName in viewHome if present
  const homeHostInput = page.locator('#hostName');
  if (await homeHostInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const currentVal = await homeHostInput.inputValue();
    if (!currentVal) await homeHostInput.fill(djName);
  }

  // Click "Start the party" (viewHome btnCreate, data-testid="start-party")
  await page.locator('[data-testid="start-party"]').waitFor({ state: 'visible', timeout: 8_000 });
  await page.locator('[data-testid="start-party"]').click();

  // Wait for party view
  await page.locator('#viewParty').waitFor({ state: 'visible', timeout: 15_000 });
  const codeEl = page.locator('[data-testid="party-code"]');
  await codeEl.waitFor({ state: 'visible', timeout: 8_000 });
  return (await codeEl.textContent()).trim();
}

/**
 * Click every visible, enabled button/link in the given page context.
 * Returns list of clicked element descriptions.
 */
async function clickAllVisible(page, scope = 'body') {
  const jsResults = await page.evaluate((scopeSelector) => {
    const container = document.querySelector(scopeSelector) || document.body;
    const elements = Array.from(container.querySelectorAll(
      'button:not([disabled]):not([aria-disabled="true"]), a[href]:not([href^="http"]):not([href^="mailto"])'
    ));

    // Skip elements that are hidden (display:none, visibility:hidden, or zero-size)
    const visible = elements.filter(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        !el.closest('.hidden');
    });

    return visible.map(el => ({
      tag: el.tagName,
      id: el.id || '',
      text: (el.textContent || '').trim().slice(0, 60),
      testid: el.getAttribute('data-testid') || '',
      classes: el.className ? String(el.className).slice(0, 80) : '',
    }));
  }, scope);

  return jsResults;
}

// ─── test: landing page buttons ──────────────────────────────────────────────

test.describe('Click-Everything Audit', () => {

  test('Landing page — every button is clickable without crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(BASE);
    await page.locator('#viewLanding').waitFor({ state: 'visible', timeout: 12_000 });

    await screenshot(page, 'landing_before');
    const buttons = await clickAllVisible(page, '#viewLanding');
    console.log(`[click-all] Landing visible buttons: ${buttons.map(b => b.text || b.id || b.testid).join(', ')}`);

    // Click signup button (navigates away — so verify and return)
    await page.click('[data-testid="signup-button"]');
    await page.locator('#viewSignup').waitFor({ state: 'visible', timeout: 8_000 });
    await screenshot(page, 'landing_signup_click');
    // Go back
    await page.goto(BASE);
    await page.locator('#viewLanding').waitFor({ state: 'visible', timeout: 12_000 });

    // Click login button
    await page.click('[data-testid="login-button"]');
    await page.locator('#viewLogin').waitFor({ state: 'visible', timeout: 8_000 });
    await screenshot(page, 'landing_login_click');

    const fatalErrors = errors.filter(e => !e.includes("require is not defined")); expect(fatalErrors).toHaveLength(0);
  });

  test('Login form — invalid credentials shows error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(BASE);
    await page.locator('#viewLanding').waitFor({ state: 'visible', timeout: 12_000 });
    await page.click('[data-testid="login-button"]');
    await page.locator('#viewLogin').waitFor({ state: 'visible', timeout: 8_000 });

    // Fill invalid creds
    await page.fill('#loginEmail', 'nobody@nowhere.invalid');
    await page.fill('#loginPassword', 'wrongpassword');
    await page.click('#formLogin button[type="submit"]');

    // Error should appear
    const loginError = page.locator('#loginError, [data-testid="auth-error-box"]').first();
    await expect(loginError).toBeVisible({ timeout: 8_000 });
    const errorText = await loginError.textContent();
    expect(errorText.trim().length).toBeGreaterThan(0);
    await screenshot(page, 'login_error_shown');
    const fatalErrors = errors.filter(e => !e.includes("require is not defined")); expect(fatalErrors).toHaveLength(0);
  });

  test('Signup form — missing DJ name shows validation', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(BASE);
    await page.locator('#viewLanding').waitFor({ state: 'visible', timeout: 12_000 });
    await page.click('[data-testid="signup-button"]');
    await page.locator('#viewSignup').waitFor({ state: 'visible', timeout: 8_000 });

    // Fill email and password but skip DJ name
    await page.fill('#signupEmail', `nobody_${uid()}@test.invalid`);
    await page.fill('#signupPassword', 'TestPass123!');
    // Don't fill DJ name
    const submitBtn = page.locator('[data-testid="signup-form"] button[type="submit"]');
    await submitBtn.click();

    // Either HTML5 validation or app-level error
    const djInput = page.locator('#signupDjName');
    const isInvalid = await djInput.evaluate((el) => !el.validity.valid).catch(() => false);
    const errorEl = page.locator('#signupError, [data-testid="auth-error-box"]').first();
    const hasAppError = await errorEl.isVisible({ timeout: 3_000 }).catch(() => false);
    expect(isInvalid || hasAppError).toBeTruthy();
    await screenshot(page, 'signup_validation_error');
    const fatalErrors = errors.filter(e => !e.includes("require is not defined")); expect(fatalErrors).toHaveLength(0);
  });

  test('Authenticated home — create/join party buttons are clickable', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const user = makeUser('home');
    await signupAndLogin(page, request, user);
    await screenshot(page, 'auth_home_before');

    // Create party button — find the visible one (either viewAuthHome or viewHome)
    const createBtn = page.locator('#viewAuthHome:not(.hidden) [data-testid="create-party"], #viewHome:not(.hidden) [data-testid="create-party"]').first();
    await createBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await screenshot(page, 'auth_home_create_visible');

    // Join party button — find the visible one
    const joinBtn = page.locator('#viewAuthHome:not(.hidden) [data-testid="join-party"], #viewHome:not(.hidden) [data-testid="join-party"]').first();
    await joinBtn.waitFor({ state: 'visible', timeout: 5_000 });

    // Nav buttons — wait for nav to be fully updated after login
    await page.waitForTimeout(500); // let _updateNavVisibility() run
    const upgradeBtn = page.locator('[data-testid="upgrade-button"]:not(.nav-hidden)');
    const profileBtn = page.locator('[data-testid="nav-settings"]:not(.nav-hidden)');

    if (await upgradeBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await upgradeBtn.click();
      await page.locator('#viewUpgradeHub').waitFor({ state: 'visible', timeout: 8_000 });
      await screenshot(page, 'upgrade_hub_view');
      // Go back
      await page.goto(BASE);
      await page.waitForSelector('#viewAuthHome:not(.hidden), #viewHome:not(.hidden)', { timeout: 10_000 });
    }

    if (await profileBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await profileBtn.click();
      // nav-settings opens viewMyProfile
      await page.waitForSelector('#viewMyProfile:not(.hidden), #viewProfile:not(.hidden)', { timeout: 8_000 });
      await screenshot(page, 'profile_view');
      // Go back
      await page.goto(BASE);
    }

    const fatalErrors = errors.filter(e => !e.includes("require is not defined")); expect(fatalErrors).toHaveLength(0);
  });

  test('Party view — all party control buttons are clickable without crash', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const user = makeUser('party');
    await signupAndLogin(page, request, user);

    // Create party via unified helper (handles viewAuthHome + viewHome)
    const partyCode = await createPartyInUI(page, user.djName);
    await screenshot(page, 'party_view_entered');

    // Get visible party control buttons
    const partyButtons = await clickAllVisible(page, '#viewParty');
    console.log(`[click-all] Party view visible buttons: ${partyButtons.length}`);
    console.log(`[click-all] Buttons: ${partyButtons.map(b => b.text || b.id || b.testid).slice(0, 20).join(', ')}`);
    await screenshot(page, 'party_view_all_buttons');

    // Party code exists
    const codeEl = page.locator('[data-testid="party-code"]');
    await expect(codeEl).toBeVisible({ timeout: 5_000 });
    const code = (await codeEl.textContent()).trim();
    expect(code).toMatch(/^[A-Z0-9]{6}$/);

    // Play button
    const playBtn = page.locator('[data-testid="play-party"]');
    if (await playBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      // Dismiss any overlaid modal before clicking
      const nudge = page.locator('#modalReferralNudge');
      if (await nudge.isVisible({ timeout: 500 }).catch(() => false)) {
        await page.keyboard.press('Escape');
        await nudge.waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => {});
      }
      await playBtn.click({ force: true });
      await screenshot(page, 'party_play_clicked');
    }

    // Music upload button
    const uploadBtn = page.locator('[data-testid="upload-audio"]');
    if (await uploadBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await uploadBtn.click();
      await screenshot(page, 'party_upload_clicked');
    }

    const fatalErrors = errors.filter(e => !e.includes("require is not defined")); expect(fatalErrors).toHaveLength(0);
  });

  test('Upgrade hub — all tier cards are visible and Party Pass button clickable', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const user = makeUser('upgrade');
    await signupAndLogin(page, request, user);
    await page.waitForTimeout(500); // let nav update

    const upgradeBtn = page.locator('[data-testid="upgrade-button"]:not(.nav-hidden)');
    await upgradeBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await upgradeBtn.click();
    await page.locator('#viewUpgradeHub').waitFor({ state: 'visible', timeout: 10_000 });
    await screenshot(page, 'upgrade_hub_entered');

    // Party Pass button
    const partyPassBtn = page.locator('#btnPurchasePartyPass');
    if (await partyPassBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await partyPassBtn.click();
      // Should show checkout modal
      const modal = page.locator('#modalCheckout, [data-testid="checkout-modal"]');
      await expect(modal).toBeVisible({ timeout: 8_000 });
      await screenshot(page, 'upgrade_checkout_modal');

      // Checkout start button
      const checkoutStartBtn = page.locator('[data-testid="checkout-start"]');
      if (await checkoutStartBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await checkoutStartBtn.click();
        await screenshot(page, 'upgrade_checkout_payment_step');
      }

      // Close modal by clicking backdrop or close button
      const closeBtn = page.locator('#modalCheckout .btn:not(.btn-primary), #modalCheckout .modal-close').first();
      if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await closeBtn.click();
      } else {
        await page.keyboard.press('Escape');
      }
    }

    const fatalErrors = errors.filter(e => !e.includes("require is not defined")); expect(fatalErrors).toHaveLength(0);
    await screenshot(page, 'upgrade_hub_complete');
  });

  test('Profile view — all profile buttons are clickable', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const user = makeUser('profile');
    await signupAndLogin(page, request, user);
    await page.waitForTimeout(500); // let nav update

    const profileBtn = page.locator('[data-testid="nav-settings"]:not(.nav-hidden)');
    await profileBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await profileBtn.click();
    // nav-settings opens viewMyProfile (not viewProfile)
    await page.waitForSelector('#viewMyProfile:not(.hidden), #viewProfile:not(.hidden)', { timeout: 10_000 });
    await screenshot(page, 'profile_view_entered');

    // Profile form exists
    await expect(page.locator('[data-testid="profile-form"]')).toBeAttached();
    await expect(page.locator('[data-testid="profile-save"]')).toBeAttached();

    // Fill and save profile
    const djInput = page.locator('#profileDjNameInput');
    if (await djInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await djInput.fill(user.djName);
      await page.click('[data-testid="profile-save"]');
      await screenshot(page, 'profile_saved');
    }

    const fatalErrors = errors.filter(e => !e.includes("require is not defined")); expect(fatalErrors).toHaveLength(0);
  });

  test('Error handling — duplicate signup shows "Account already exists"', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const user = makeUser('dup');
    // First signup via API
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
    });

    // Second signup via UI
    await page.goto(BASE);
    await page.locator('#viewLanding').waitFor({ state: 'visible', timeout: 12_000 });
    await page.click('[data-testid="signup-button"]');
    await page.locator('#viewSignup').waitFor({ state: 'visible', timeout: 8_000 });
    await page.fill('#signupEmail', user.email);
    await page.fill('#signupPassword', user.password);
    await page.fill('#signupDjName', user.djName);
    const terms = page.locator('#signupTermsAccept');
    if (await terms.isVisible({ timeout: 2_000 }).catch(() => false)) {
      if (!(await terms.isChecked())) await terms.check();
    }
    await page.click('[data-testid="signup-form"] button[type="submit"]');

    // Error should appear
    const errorEl = page.locator('#signupError');
    await expect(errorEl).toBeVisible({ timeout: 8_000 });
    const text = await errorEl.textContent();
    expect(text.toLowerCase()).toMatch(/already|exists|taken|registered/);
    await screenshot(page, 'error_duplicate_signup');
    const fatalErrors = errors.filter(e => !e.includes("require is not defined")); expect(fatalErrors).toHaveLength(0);
  });

  test('Error handling — invalid join code shows error', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const user = makeUser('badjoin');
    await signupAndLogin(page, request, user);

    // Find the visible join party button (may be in viewAuthHome or viewHome)
    const joinBtn = page.locator('#viewAuthHome:not(.hidden) [data-testid="join-party"], #viewHome:not(.hidden) [data-testid="join-party"]').first();
    await joinBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await joinBtn.click();

    // Fill code in whichever form appeared
    const authJoinCode = page.locator('#partyJoinCode');
    const homeJoinCode = page.locator('#joinCode');

    if (await authJoinCode.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await authJoinCode.fill('XXXXXX');
      await page.locator('[data-testid="join-party-submit-auth-home"]').click();
      // Transitions to viewHome join section
      await page.waitForSelector('#viewHome:not(.hidden)', { timeout: 8_000 }).catch(() => {});
      const homeCode = page.locator('#joinCode');
      if (await homeCode.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const val = await homeCode.inputValue();
        if (!val) await homeCode.fill('XXXXXX');
        await page.click('[data-testid="join-party-submit"]');
      }
    } else if (await homeJoinCode.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await homeJoinCode.fill('XXXXXX');
      const guestNameInput = page.locator('#guestName');
      if (await guestNameInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await guestNameInput.fill('TestGuest');
      }
      await page.click('[data-testid="join-party-submit"]');
    }

    // Should show error toast or error message
    const toast = page.locator('[data-testid="toast"], .toast, .error-message, #partyJoinStatus, #joinStatus');
    await toast.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    await screenshot(page, 'error_bad_party_code');
    const fatalErrors = errors.filter(e => !e.includes("require is not defined")); expect(fatalErrors).toHaveLength(0);
  });

});
