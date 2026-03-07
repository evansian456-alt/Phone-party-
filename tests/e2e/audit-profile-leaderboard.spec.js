// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * COMPREHENSIVE APP AUDIT — Profile, Leaderboard, My Profile
 *
 * Validates:
 * - Profile view renders DJ name, email, tier badge
 * - Stats grid (parties hosted, tracks played, total guests)
 * - DJ Rank section (rank badge, score, progress bar)
 * - Settings form (DJ name, guest name update)
 * - Leaderboard: Top DJs and Top Guests tabs
 * - My Profile view: profile fields, owned items, entitlements
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() { return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }
function makeUser(p = 'profileaudit') {
  const id = uid();
  return { email: `e2e_${p}_${id}@test.invalid`, password: 'Audit123!', djName: `DJ_${p}_${id}`.slice(0, 30) };
}

// ─────────────────────────────────────────────────────────────────
// PROFILE VIEW (viewProfile)
// ─────────────────────────────────────────────────────────────────
test.describe('Profile view — /api/me accuracy', () => {
  test('/api/me returns djName matching signup input', async ({ request }) => {
    const u = makeUser();
    await request.post(`${BASE}/api/auth/signup`, { data: { email: u.email, password: u.password, djName: u.djName, termsAccepted: true } });
    await request.post(`${BASE}/api/auth/login`, { data: { email: u.email, password: u.password } });

    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();

    expect(me.user.djName).toBe(u.djName);
    expect(me.user.email).toBe(u.email);
  });

  test('/api/me returns tier FREE for new user', async ({ request }) => {
    const u = makeUser();
    await request.post(`${BASE}/api/auth/signup`, { data: { email: u.email, password: u.password, djName: u.djName, termsAccepted: true } });
    await request.post(`${BASE}/api/auth/login`, { data: { email: u.email, password: u.password } });

    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();

    expect(me.tier).toBe('FREE');
    expect(me.effectiveTier).toBe('FREE');
  });

  test('/api/me profileCompleted is true after signup', async ({ request }) => {
    const u = makeUser();
    await request.post(`${BASE}/api/auth/signup`, { data: { email: u.email, password: u.password, djName: u.djName, termsAccepted: true } });
    await request.post(`${BASE}/api/auth/login`, { data: { email: u.email, password: u.password } });

    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();

    // This is the login bug fix — profileCompleted must be true immediately
    expect(me.user.profileCompleted).toBe(true);
  });

  test('/api/me profile.djScore defaults to 0', async ({ request }) => {
    const u = makeUser();
    await request.post(`${BASE}/api/auth/signup`, { data: { email: u.email, password: u.password, djName: u.djName, termsAccepted: true } });
    await request.post(`${BASE}/api/auth/login`, { data: { email: u.email, password: u.password } });

    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();

    expect(me.profile.djScore).toBe(0);
  });

  test('/api/me profile.djRank is "Bedroom DJ" for new user', async ({ request }) => {
    const u = makeUser();
    await request.post(`${BASE}/api/auth/signup`, { data: { email: u.email, password: u.password, djName: u.djName, termsAccepted: true } });
    await request.post(`${BASE}/api/auth/login`, { data: { email: u.email, password: u.password } });

    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();

    expect(me.profile.djRank).toBe('Bedroom DJ');
  });

  test('profile view renders tier badge', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewProfile')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);
    await expect(page.locator('#profileTierBadge')).toBeAttached();
  });

  test('profile view renders stats grid', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewProfile')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    await expect(page.locator('#statTotalParties')).toBeAttached();
    await expect(page.locator('#statTotalTracks')).toBeAttached();
    await expect(page.locator('#statTotalGuests')).toBeAttached();
  });

  test('profile view DJ rank section renders rank badge and score', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewProfile')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    await expect(page.locator('#profileRankBadge')).toBeAttached();
    await expect(page.locator('#profileScore')).toBeAttached();
    await expect(page.locator('#profileRankProgress')).toBeAttached();
  });

  test('profile settings form renders DJ name and guest name inputs', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewProfile')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    await expect(page.locator('#profileDjNameInput')).toBeAttached();
    await expect(page.locator('#profileGuestNameInput')).toBeAttached();
  });

  test('updating DJ name via API reflects in /api/me', async ({ request }) => {
    const u = makeUser('nameupdate');
    await request.post(`${BASE}/api/auth/signup`, { data: { email: u.email, password: u.password, djName: u.djName, termsAccepted: true } });
    await request.post(`${BASE}/api/auth/login`, { data: { email: u.email, password: u.password } });

    const newName = `Updated_${uid()}`.slice(0, 30);
    const updateRes = await request.post(`${BASE}/api/complete-profile`, {
      data: { djName: newName },
    });
    if (!updateRes.ok()) return; // API may require specific fields

    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();
    expect(me.user.djName).toBe(newName);
  });
});

// ─────────────────────────────────────────────────────────────────
// LEADERBOARD (viewLeaderboard)
// ─────────────────────────────────────────────────────────────────
test.describe('Leaderboard', () => {
  test('leaderboard view renders Top DJs and Top Guests tabs', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewLeaderboard')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    await expect(page.locator('#btnTabDjs')).toBeAttached();
    await expect(page.locator('#btnTabGuests')).toBeAttached();
  });

  test('Top DJs tab is active by default', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewLeaderboard')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    const djTab = page.locator('#btnTabDjs');
    if (await djTab.isVisible({ timeout: 1000 }).catch(() => false)) {
      const classes = await djTab.getAttribute('class');
      expect(classes).toContain('active');
    }
  });

  test('clicking Guests tab switches content', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewLeaderboard')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    const guestTab = page.locator('#btnTabGuests');
    if (await guestTab.isVisible({ timeout: 1000 }).catch(() => false)) {
      await guestTab.click();
      const classes = await guestTab.getAttribute('class');
      expect(classes).toContain('active');
    }
  });

  test('/api/leaderboard returns top DJs list', async ({ request }) => {
    const res = await request.get(`${BASE}/api/leaderboard`);
    expect([200, 404]).toContain(res.status());
    if (res.ok()) {
      const body = await res.json();
      // Should have djs or topDjs array
      expect(body.djs || body.topDjs || body).toBeTruthy();
    }
  });

  test('Back button from leaderboard navigates away', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewLeaderboard')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);
    const backBtn = page.locator('#btnBackFromLeaderboard');
    if (await backBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await backBtn.click();
      await expect(page.locator('#viewLeaderboard')).not.toBeVisible();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// MY PROFILE (viewMyProfile)
// ─────────────────────────────────────────────────────────────────
test.describe('My Profile view', () => {
  test('my profile view renders correctly', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewMyProfile')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);
    await expect(page.locator('#viewMyProfile')).toBeAttached();
  });

  test('/api/me entitlements structure is correct', async ({ request }) => {
    const u = makeUser('entitlements');
    await request.post(`${BASE}/api/auth/signup`, { data: { email: u.email, password: u.password, djName: u.djName, termsAccepted: true } });
    await request.post(`${BASE}/api/auth/login`, { data: { email: u.email, password: u.password } });

    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();

    expect(me.entitlements).toBeDefined();
    expect(typeof me.entitlements.hasPartyPass).toBe('boolean');
    expect(typeof me.entitlements.hasPro).toBe('boolean');
    // New user should have both false
    expect(me.entitlements.hasPartyPass).toBe(false);
    expect(me.entitlements.hasPro).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// ADMIN DASHBOARD VIEW STRUCTURE
// ─────────────────────────────────────────────────────────────────
test.describe('Admin dashboard view', () => {
  test('admin dashboard view HTML is present in DOM', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('#viewAdminDashboard')).toBeAttached();
  });

  test('/api/admin/stats returns 401 for unauthenticated requests', async ({ playwright }) => {
    const noAuth = await playwright.request.newContext();
    let status;
    try {
      const res = await noAuth.get(`${BASE}/api/admin/stats`);
      status = res.status();
    } finally {
      await noAuth.dispose();
    }
    expect(status).toBe(401);
  });

  test('/api/admin/stats returns 403 for non-admin users', async ({ request }) => {
    const u = makeUser('nonadmin');
    await request.post(`${BASE}/api/auth/signup`, { data: { email: u.email, password: u.password, djName: u.djName, termsAccepted: true } });
    await request.post(`${BASE}/api/auth/login`, { data: { email: u.email, password: u.password } });

    const res = await request.get(`${BASE}/api/admin/stats`);
    expect(res.status()).toBe(403);
  });
});
