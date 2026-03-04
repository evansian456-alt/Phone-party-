// @ts-check
/**
 * Signup Production E2E Test
 *
 * Validates the full signup flow including:
 * - Successful account creation (returns 201 with success:true)
 * - Success message "Welcome to the party 🥳" in the UI
 * - Duplicate signup returns 409 "Account already exists"
 * - Login works after account creation
 * - /api/me returns 200 for authenticated user
 */

const { test, expect } = require('@playwright/test');

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function makeEmail() {
  return `e2e_${Date.now()}_${Math.random().toString(36).slice(2)}@test.invalid`;
}

const PASSWORD = 'SecurePass123!';
const DJ_NAME = 'EvoTest';

test.describe.serial('Signup flow', () => {
  let testEmail;

  test.beforeAll(() => {
    testEmail = makeEmail();
  });

  test('creates a new account via API and returns 201', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/signup`, {
      data: {
        email: testEmail,
        password: PASSWORD,
        djName: DJ_NAME,
        termsAccepted: true,
      },
    });

    const body = await res.json();
    console.log('[signup] status:', res.status(), 'body:', JSON.stringify(body));

    expect(res.status()).toBe(201);
    expect(body.success).toBe(true);
  });

  test('login works with new account credentials', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, {
      data: { email: testEmail, password: PASSWORD },
    });

    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.user.email).toBe(testEmail.toLowerCase());
  });

  test('/api/me returns 200 after login', async ({ request }) => {
    // Login first to get cookie
    await request.post(`${BASE}/api/auth/login`, {
      data: { email: testEmail, password: PASSWORD },
    });

    const meRes = await request.get(`${BASE}/api/me`);
    expect(meRes.ok()).toBeTruthy();
    const meBody = await meRes.json();
    expect(meBody.user.email).toBe(testEmail.toLowerCase());
  });

  test('duplicate signup returns 409 Account already exists', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/signup`, {
      data: {
        email: testEmail,
        password: PASSWORD,
        djName: DJ_NAME,
        termsAccepted: true,
      },
    });

    const body = await res.json();
    console.log('[duplicate-signup] status:', res.status(), 'body:', JSON.stringify(body));

    expect(res.status()).toBe(409);
    expect(body.error).toBe('Account already exists');
  });

  test('success message "Welcome to the party 🥳" shown after UI signup', async ({ page }) => {
    const uniqueEmail = makeEmail();

    await page.goto(BASE);

    // Navigate to signup view
    const signupBtn = page.locator('button, a').filter({ hasText: /\b(sign up|create account|register)\b/i }).first();
    const signupVisible = await signupBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (signupVisible) {
      await signupBtn.click();
    } else {
      await page.evaluate(() => {
        if (typeof window.setView === 'function') window.setView('signup');
      });
    }

    // Fill the form
    await page.locator('input#signupEmail, input[id="signupEmail"]').fill(uniqueEmail);
    await page.locator('input#signupPassword, input[id="signupPassword"]').fill(PASSWORD);

    const djNameField = page.locator('input#signupDjName, input[id="signupDjName"]');
    if (await djNameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await djNameField.fill(DJ_NAME);
    }

    const termsCheckbox = page.locator('input#signupTermsAccept, input[id="signupTermsAccept"]');
    if (await termsCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      await termsCheckbox.check();
    }

    await page.locator('button').filter({ hasText: /\b(create account|sign up|register)\b/i }).first().click();

    // Expect success message
    await expect(page.locator('body')).toContainText('Welcome to the party 🥳', { timeout: 10000 });
  });
});
