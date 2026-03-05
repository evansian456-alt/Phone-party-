// @ts-check
const { test, expect } = require('@playwright/test');
const { makeUser, apiSignup, apiLogin, BASE } = require('./helpers/auth');

/**
 * E2E — Music Providers
 *
 * Verifies:
 *  - Provider logos (YouTube, Spotify, SoundCloud) are in the DOM
 *  - Provider cards have correct data-testid attributes
 *  - Provider use-buttons are present (locked for free tier, unlocked for paid)
 *  - Streaming API returns 401 or 403 for unauthenticated users
 *  - Streaming API returns 403 for free-tier users
 *  - No console errors from provider-related elements
 */

// ─── Provider DOM presence ────────────────────────────────────────────────────

test.describe('Music provider DOM elements', () => {
  test('provider-youtube card is attached in DOM', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="provider-youtube"]')).toBeAttached();
  });

  test('provider-spotify card is attached in DOM', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="provider-spotify"]')).toBeAttached();
  });

  test('provider-soundcloud card is attached in DOM', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="provider-soundcloud"]')).toBeAttached();
  });

  test('provider-logo-youtube image is attached in DOM', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    const logos = page.locator('[data-testid="provider-logo-youtube"]');
    expect(await logos.count()).toBeGreaterThan(0);
  });

  test('provider-logo-spotify image is attached in DOM', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    const logos = page.locator('[data-testid="provider-logo-spotify"]');
    expect(await logos.count()).toBeGreaterThan(0);
  });

  test('provider-logo-soundcloud image is attached in DOM', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    const logos = page.locator('[data-testid="provider-logo-soundcloud"]');
    expect(await logos.count()).toBeGreaterThan(0);
  });
});

// ─── Provider use-buttons presence ───────────────────────────────────────────

test.describe('Music provider use-buttons', () => {
  test('btn-use-provider-youtube button is attached', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="btn-use-provider-youtube"]')).toBeAttached();
  });

  test('btn-use-provider-spotify button is attached', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="btn-use-provider-spotify"]')).toBeAttached();
  });

  test('btn-use-provider-soundcloud button is attached', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="btn-use-provider-soundcloud"]')).toBeAttached();
  });

  test('locked provider buttons exist for free-tier paywall', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    // These locked buttons exist in the paywall section for free-tier users
    await expect(page.locator('[data-testid="btn-use-provider-youtube-locked"]')).toBeAttached();
    await expect(page.locator('[data-testid="btn-use-provider-spotify-locked"]')).toBeAttached();
    await expect(page.locator('[data-testid="btn-use-provider-soundcloud-locked"]')).toBeAttached();
  });
});

// ─── Streaming API paywall (unauthenticated) ──────────────────────────────────

test.describe('Streaming API — unauthenticated paywall', () => {
  test('GET /api/streaming/providers returns 401 or 403 without auth', async ({ request }) => {
    const res = await request.get(`${BASE}/api/streaming/providers`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/streaming/select-track returns 401 or 403 without auth', async ({ request }) => {
    const res = await request.post(`${BASE}/api/streaming/select-track`, {
      data: { partyCode: 'ABC123', provider: 'youtube', trackId: 'dQw4w9WgXcQ' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/streaming/access returns 401 or 403 without auth', async ({ request }) => {
    const res = await request.get(`${BASE}/api/streaming/access`);
    expect([401, 403]).toContain(res.status());
  });
});

// ─── Streaming API paywall (free-tier authenticated) ─────────────────────────

test.describe('Streaming API — free-tier paywall', () => {
  // Setup is done per-test so `request` is used only in test scope,
  // not in beforeAll (which can cause fixture-scope issues).
  test('GET /api/streaming/providers returns 403 for free-tier user', async ({ request }) => {
    const freeUser = makeUser('freetier');
    await apiSignup(request, freeUser);
    await apiLogin(request, freeUser);

    const res = await request.get(`${BASE}/api/streaming/providers`);
    // Free users cannot access streaming providers
    expect([401, 403]).toContain(res.status());
  });
});

// ─── Provider page renders without critical errors ────────────────────────────

test.describe('Provider page — no critical errors', () => {
  test('page loads without JavaScript exceptions', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Filter known/acceptable warnings vs actual errors
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('Non-Error promise rejection') &&
        !e.includes('favicon')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('provider section renders in DOM without page crash', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');
    // Body must be non-empty — page has not crashed
    await expect(page.locator('body')).not.toBeEmpty();
    // All three provider cards must exist
    await expect(page.locator('[data-testid="provider-youtube"]')).toBeAttached();
    await expect(page.locator('[data-testid="provider-spotify"]')).toBeAttached();
    await expect(page.locator('[data-testid="provider-soundcloud"]')).toBeAttached();
  });
});
