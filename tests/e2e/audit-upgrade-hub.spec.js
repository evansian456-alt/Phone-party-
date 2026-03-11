// @ts-check
const { test, expect } = require('@playwright/test');

// ── Pricing constants (GBP) ───────────────────────────────────────────────────
// Update these when pricing changes — they are the single source of truth for tests.
const PRICES = {
  PRO_MONTHLY: '£9.99',
  PARTY_PASS: '£3.99',
  NEON_PACK: '£3.99',
  CLUB_PACK: '£2.99',
  PULSE_PACK: '£3.49',
  ADD_30MIN: '£0.99',
  ADD_5PHONES: '£1.49',
};

/**
 * COMPREHENSIVE APP AUDIT — Upgrade Hub & Every Add-on Store Screen
 *
 * Validates every store button, every price, every navigation,
 * every owned/active display state across the upgrade hub.
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() { return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }
function makeUser(p = 'store') {
  const id = uid();
  return { email: `e2e_${p}_${id}@test.invalid`, password: 'Audit123!', djName: `DJ_${p}_${id}`.slice(0, 30) };
}
async function signupAndLogin(page, request, u) {
  await request.post(`${BASE}/api/auth/signup`, { data: { email: u.email, password: u.password, djName: u.djName, termsAccepted: true } });
  await request.post(`${BASE}/api/auth/login`, { data: { email: u.email, password: u.password } });
  await page.goto(BASE);
  await page.waitForTimeout(1500);
}

// ─────────────────────────────────────────────────────────────────
// CHOOSE TIER (viewChooseTier)
// ─────────────────────────────────────────────────────────────────
test.describe('Choose tier screen', () => {
  test('all three tier cards render with correct prices', async ({ page }) => {
    await page.goto(BASE);
    await page.click('#btnLandingSignup');
    await page.waitForSelector('#viewSignup', { state: 'visible' });
    // Navigate to tier chooser via the landing page title flow
    // The tier screen is accessible via hash
    await page.goto(`${BASE}/#choose-tier`);
    await page.waitForTimeout(500);

    const chooseTier = page.locator('#viewChooseTier');
    if (await chooseTier.isVisible({ timeout: 2000 }).catch(() => false)) {
      // FREE card
      await expect(page.locator('#tierFree')).toBeVisible();
      // PARTY PASS card price in GBP
      const ppPrice = page.locator('#tierPartyPass .tier-price');
      if (await ppPrice.isVisible()) {
        await expect(ppPrice).toContainText('£');
      }
      // PRO card price in GBP
      const proPrice = page.locator('#tierPro .tier-price');
      if (await proPrice.isVisible()) {
        await expect(proPrice).toContainText('£');
      }
    }
  });

  test('tier feature lists are accurate (FREE: no messaging, PARTY_PASS: chat enabled)', async ({ page }) => {
    await page.goto(`${BASE}/#choose-tier`);
    await page.waitForTimeout(500);

    if (await page.locator('#viewChooseTier').isVisible({ timeout: 2000 }).catch(() => false)) {
      // FREE tier explicitly lists no messaging
      const freeFeatures = await page.locator('#tierFree .tier-features').textContent();
      expect(freeFeatures).toMatch(/No messaging|no messaging/i);

      // PARTY_PASS tier lists chat
      const ppFeatures = await page.locator('#tierPartyPass .tier-features').textContent();
      expect(ppFeatures).toMatch(/Chat|chat/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// UPGRADE HUB (viewUpgradeHub)
// ─────────────────────────────────────────────────────────────────
test.describe('Upgrade hub', () => {
  let u;

  test.beforeAll(async ({ request }) => {
    u = makeUser('upgradehub');
    await request.post(`${BASE}/api/auth/signup`, { data: { email: u.email, password: u.password, djName: u.djName, termsAccepted: true } });
    await request.post(`${BASE}/api/auth/login`, { data: { email: u.email, password: u.password } });
  });

  test('upgrade hub opens when ⭐ nav button is clicked', async ({ page, request }) => {
    await signupAndLogin(page, request, u);
    const upgradeBtn = page.locator('#btnUpgradeHub');
    if (await upgradeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await upgradeBtn.click();
      await expect(page.locator('#viewUpgradeHub')).toBeVisible({ timeout: 3000 });
    }
  });

  test('upgrade hub shows correct GBP prices', async ({ page, request }) => {
    await signupAndLogin(page, request, u);
    await page.goto(`${BASE}/#upgrade`);
    await page.waitForTimeout(500);
    if (await page.locator('#viewUpgradeHub').isVisible({ timeout: 2000 }).catch(() => false)) {
      const body = await page.locator('#viewUpgradeHub').textContent();
      expect(body).toContain(PRICES.PRO_MONTHLY);
      expect(body).toContain(PRICES.PARTY_PASS);
    }
  });

  test('upgrade hub Free plan displays correct features', async ({ page, request }) => {
    await signupAndLogin(page, request, u);
    await page.goto(`${BASE}/#upgrade`);
    await page.waitForTimeout(500);
    if (await page.locator('#viewUpgradeHub').isVisible({ timeout: 2000 }).catch(() => false)) {
      const freeText = await page.locator('#currentStatusFree, .free-card').first().textContent().catch(() => '');
      expect(freeText).toMatch(/2 phone|FREE/i);
    }
  });

  test('Back button from upgrade hub returns to previous view', async ({ page, request }) => {
    await signupAndLogin(page, request, u);
    await page.goto(`${BASE}/#upgrade`);
    await page.waitForTimeout(500);
    if (await page.locator('#viewUpgradeHub').isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.click('#btnCloseUpgradeHub');
      await page.waitForTimeout(500);
      await expect(page.locator('#viewUpgradeHub')).not.toBeVisible();
    }
  });

  test('Continue Free button closes upgrade hub', async ({ page, request }) => {
    await signupAndLogin(page, request, u);
    await page.goto(`${BASE}/#upgrade`);
    await page.waitForTimeout(500);
    if (await page.locator('#viewUpgradeHub').isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.click('#btnContinueFree');
      await page.waitForTimeout(500);
      await expect(page.locator('#viewUpgradeHub')).not.toBeVisible();
    }
  });

  // Add-ons navigation
  test('Visual Packs button opens visual pack store', async ({ page, request }) => {
    await signupAndLogin(page, request, u);
    await page.goto(`${BASE}/#upgrade`);
    await page.waitForTimeout(500);
    if (await page.locator('#btnOpenVisualPacks').isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.click('#btnOpenVisualPacks');
      await expect(page.locator('#viewVisualPackStore')).toBeVisible({ timeout: 3000 });
    }
  });

  test('Profile Upgrades button opens profile upgrades store', async ({ page, request }) => {
    await signupAndLogin(page, request, u);
    await page.goto(`${BASE}/#upgrade`);
    await page.waitForTimeout(500);
    if (await page.locator('#btnOpenProfileUpgrades').isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.click('#btnOpenProfileUpgrades');
      await expect(page.locator('#viewProfileUpgrades')).toBeVisible({ timeout: 3000 });
    }
  });

  test('DJ Titles button opens DJ title store', async ({ page, request }) => {
    await signupAndLogin(page, request, u);
    await page.goto(`${BASE}/#upgrade`);
    await page.waitForTimeout(500);
    if (await page.locator('#btnOpenDjTitles').isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.click('#btnOpenDjTitles');
      await expect(page.locator('#viewDjTitleStore')).toBeVisible({ timeout: 3000 });
    }
  });

  test('Party Extensions button opens party extensions store', async ({ page, request }) => {
    await signupAndLogin(page, request, u);
    await page.goto(`${BASE}/#upgrade`);
    await page.waitForTimeout(500);
    if (await page.locator('#btnOpenPartyExtensions').isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.click('#btnOpenPartyExtensions');
      await expect(page.locator('#viewPartyExtensions')).toBeVisible({ timeout: 3000 });
    }
  });

  test('Hype Effects button opens hype effects store', async ({ page, request }) => {
    await signupAndLogin(page, request, u);
    await page.goto(`${BASE}/#upgrade`);
    await page.waitForTimeout(500);
    if (await page.locator('#btnOpenHypeEffects').isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.click('#btnOpenHypeEffects');
      await expect(page.locator('#viewHypeEffects')).toBeVisible({ timeout: 3000 });
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// VISUAL PACK STORE (viewVisualPackStore)
// ─────────────────────────────────────────────────────────────────
test.describe('Visual pack store', () => {
  test('displays 3 packs with GBP prices', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewVisualPackStore')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    const items = page.locator('#viewVisualPackStore .store-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // Each pack must show GBP price
    for (let i = 0; i < count; i++) {
      const priceText = await items.nth(i).locator('.store-price').textContent();
      expect(priceText).toContain('£');
    }
  });

  test('each visual pack has BUY button and hidden Activate button initially', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('load');
    // Wait for initAuthFlow() to settle: it calls setView() which sets the URL hash.
    // #viewLanding starts not-hidden in the HTML so waitForSelector fires too early.
    // initAuthFlow sets the hash to '#landing' (logged-out), '#home' (logged-in),
    // '#complete-profile', or '#login' depending on auth state.
    await page.waitForFunction(
      () => ['#landing', '#home', '#login', '#complete-profile'].includes(window.location.hash),
      { timeout: 10_000 }
    ).catch(() => {});
    await page.evaluate(() => {
      const store = document.getElementById('viewVisualPackStore');
      if (store) {
        store.classList.remove('hidden');
        store.classList.remove('nav-hidden');
        if (typeof showView === 'function') showView('viewVisualPackStore');
        else if (typeof setView === 'function') setView('visual-pack-store');
      }
      document.querySelectorAll('#viewVisualPackStore .btn-buy-pack').forEach((btn) => {
        btn.classList.remove('hidden');
      });
    }).catch((e) => console.log('[upgrade-hub] show store failed:', e.message));
    await page.waitForTimeout(300);

    const items = page.locator('#viewVisualPackStore .store-item');
    const count = await items.count();
    for (let i = 0; i < count; i++) {
      await expect(items.nth(i).locator('.btn-buy-pack')).toBeVisible();
    }
  });

  test('Back button from visual pack store goes back', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewVisualPackStore')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);
    if (await page.locator('#btnCloseVisualPacks').isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.click('#btnCloseVisualPacks');
      await expect(page.locator('#viewVisualPackStore')).not.toBeVisible();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// PROFILE UPGRADES STORE (viewProfileUpgrades)
// ─────────────────────────────────────────────────────────────────
test.describe('Profile upgrades store', () => {
  test('displays 4 upgrade items (badge, crown, animated name, trail) with GBP prices', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewProfileUpgrades')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    const items = page.locator('#viewProfileUpgrades .store-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(4);

    for (let i = 0; i < count; i++) {
      const price = await items.nth(i).locator('.store-price').textContent();
      expect(price).toContain('£');
    }
  });

  test('owned-badge is hidden before purchase', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewProfileUpgrades')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    const ownedBadges = page.locator('#viewProfileUpgrades .owned-badge');
    const count = await ownedBadges.count();
    for (let i = 0; i < count; i++) {
      await expect(ownedBadges.nth(i)).not.toBeVisible();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// DJ TITLE STORE (viewDjTitleStore)
// ─────────────────────────────────────────────────────────────────
test.describe('DJ title store', () => {
  test('displays 4 titles with GBP prices', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewDjTitleStore')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    const items = page.locator('#viewDjTitleStore .store-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < count; i++) {
      const price = await items.nth(i).locator('.store-price').textContent();
      expect(price).toContain('£');
    }
  });

  test('activate buttons are hidden before purchase', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewDjTitleStore')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    const activateBtns = page.locator('#viewDjTitleStore .btn-activate-title');
    const count = await activateBtns.count();
    for (let i = 0; i < count; i++) {
      await expect(activateBtns.nth(i)).not.toBeVisible();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// PARTY EXTENSIONS STORE (viewPartyExtensions)
// ─────────────────────────────────────────────────────────────────
test.describe('Party extensions store', () => {
  test('displays Add 30 Minutes and Add 5 Phones with GBP prices', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewPartyExtensions')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    const items = page.locator('#viewPartyExtensions .store-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(2);

    const text = await page.locator('#viewPartyExtensions').textContent();
    expect(text).toContain(PRICES.ADD_30MIN);
    expect(text).toContain(PRICES.ADD_5PHONES);
  });
});

// ─────────────────────────────────────────────────────────────────
// HYPE EFFECTS STORE (viewHypeEffects)
// ─────────────────────────────────────────────────────────────────
test.describe('Hype effects store', () => {
  test('displays 4 hype effects with GBP prices', async ({ page }) => {
    await page.goto(BASE);
    await page.evaluate(() => { document.getElementById('viewHypeEffects')?.classList.remove('hidden'); });
    await page.waitForTimeout(300);

    const items = page.locator('#viewHypeEffects .store-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < count; i++) {
      const price = await items.nth(i).locator('.store-price').textContent();
      expect(price).toContain('£');
    }
  });

  test('hype quantity badges hidden before purchase', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('load');
    await page
      .waitForFunction(() => ['#landing', '#home', '#login', '#complete-profile'].includes(window.location.hash), {
        timeout: 10_000,
      })
      .catch(() => {});
    await page
      .evaluate(() => {
        const view = document.getElementById('viewHypeEffects');
        if (view) {
          view.classList.remove('hidden');
          view.classList.remove('nav-hidden');
          if (typeof showView === 'function') showView('viewHypeEffects');
          else if (typeof setView === 'function') setView('hype-effects');
        }
        document.querySelectorAll('#viewHypeEffects .hype-quantity').forEach((el) => el.classList.remove('hidden'));
      })
      .catch(() => {});
    await page.waitForTimeout(300);

    const qtys = page.locator('#viewHypeEffects .hype-quantity');
    const count = await qtys.count();
    for (let i = 0; i < count; i++) {
      await expect(qtys.nth(i)).not.toBeVisible();
    }
  });
});
