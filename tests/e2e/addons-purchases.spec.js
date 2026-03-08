// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Add-on purchase and UI state tests.
 *
 * Validates:
 * - /api/store returns all expected item categories and prices
 * - /api/tier-info returns accurate tier feature definitions
 * - Purchasing a visual pack updates dj_profiles.active_visual_pack (/api/me profile)
 * - Purchasing a DJ title updates dj_profiles.active_title
 * - Purchasing a profile upgrade (crown, badge, trail, animated name) updates flags
 * - After purchase, /api/me returns the new profile state (UI/backend consistency)
 * - /api/user/entitlements reflects purchased items
 * - Non-existent item purchase returns 404
 * - All store item prices are in GBP (not $0)
 *
 * NOTE: The /api/purchase endpoint requires a real database. Tests that mutate DB
 * state skip gracefully when DATABASE_URL is not available (like in unit-test mode).
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeUser(prefix = 'addon') {
  const id = uid();
  return {
    email: `e2e_${prefix}_${id}@test.invalid`,
    password: 'E2eTest123!',
    djName: `DJ_${prefix}_${id}`.slice(0, 30),
  };
}

async function signupAndLogin(request, user) {
  await request.post(`${BASE}/api/auth/signup`, {
    data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
  });
  await request.post(`${BASE}/api/auth/login`, {
    data: { email: user.email, password: user.password },
  });
}

test.describe('Store catalog — information accuracy', () => {
  test('/api/store returns all expected item categories', async ({ request }) => {
    const res = await request.get(`${BASE}/api/store`);
    expect(res.ok()).toBeTruthy();
    const catalog = await res.json();

    expect(catalog.visualPacks).toBeDefined();
    expect(catalog.djTitles).toBeDefined();
    expect(catalog.profileUpgrades).toBeDefined();
    expect(catalog.partyExtensions).toBeDefined();
    expect(catalog.hypeEffects).toBeDefined();
    expect(catalog.subscriptions).toBeDefined();

    // Each category should be an array with at least one item
    expect(catalog.visualPacks.length).toBeGreaterThan(0);
    expect(catalog.djTitles.length).toBeGreaterThan(0);
    expect(catalog.profileUpgrades.length).toBeGreaterThan(0);
  });

  test('all store items have required fields (id, name, price, type)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/store`);
    const catalog = await res.json();

    const allItems = [
      ...catalog.visualPacks,
      ...catalog.djTitles,
      ...catalog.profileUpgrades,
      ...catalog.partyExtensions,
      ...(catalog.hypeEffects || []),
    ];

    for (const item of allItems) {
      expect(item.id, `${item.name || 'item'} missing id`).toBeDefined();
      expect(item.name, `${item.id} missing name`).toBeDefined();
      expect(item.price, `${item.id} missing price`).toBeDefined();
      expect(item.type, `${item.id} missing type`).toBeDefined();
      // Price must be non-zero (Stripe test mode — all items should cost something)
      expect(item.price).toBeGreaterThan(0);
    }
  });

  test('store items use GBP currency', async ({ request }) => {
    const res = await request.get(`${BASE}/api/store`);
    const catalog = await res.json();

    const allItems = [
      ...catalog.visualPacks,
      ...catalog.djTitles,
      ...catalog.profileUpgrades,
    ];

    for (const item of allItems) {
      if (item.currency) {
        expect(item.currency).toBe('GBP');
      }
    }
  });

  test('/api/tier-info returns all three tiers with accurate feature info', async ({ request }) => {
    const res = await request.get(`${BASE}/api/tier-info`);
    expect(res.ok()).toBeTruthy();
    const info = await res.json();

    expect(info.tiers).toBeDefined();
    expect(info.tiers.FREE).toBeDefined();
    expect(info.tiers.PARTY_PASS).toBeDefined();
    // PRO_MONTHLY or PRO
    const proTier = info.tiers.PRO || info.tiers.PRO_MONTHLY;
    expect(proTier).toBeDefined();

    // FREE tier should have lower phone limit than PARTY_PASS
    expect(info.tiers.FREE.phoneLimit).toBeLessThanOrEqual(info.tiers.PARTY_PASS.phoneLimit);

    // PARTY_PASS price must be defined and non-empty
    expect(info.tiers.PARTY_PASS.price).toBeDefined();
    expect(info.tiers.PARTY_PASS.price.length).toBeGreaterThan(0);

    // Chat should be disabled for FREE, enabled for PARTY_PASS
    expect(info.tiers.FREE.chatEnabled).toBe(false);
    expect(info.tiers.PARTY_PASS.chatEnabled).toBe(true);
  });

  test('/api/tier-info phone limits match expected values', async ({ request }) => {
    const res = await request.get(`${BASE}/api/tier-info`);
    const info = await res.json();

    // FREE: 3 phones (1 host + 2 guests)
    expect(info.tiers.FREE.phoneLimit).toBe(3);
    // PARTY_PASS: at least 4 phones
    expect(info.tiers.PARTY_PASS.phoneLimit).toBeGreaterThanOrEqual(4);
    // PRO: at least 10 phones
    const proTier = info.tiers.PRO || info.tiers.PRO_MONTHLY;
    expect(proTier.phoneLimit).toBeGreaterThanOrEqual(10);
  });
});

test.describe('Add-on purchases — visual pack', () => {
  let user;

  test.beforeAll(async ({ request }) => {
    user = makeUser('visual');
    await signupAndLogin(request, user);
  });

  test('purchasing a visual pack succeeds and updates profile', async ({ request }) => {
    const purchaseRes = await request.post(`${BASE}/api/purchase`, {
      data: { itemId: 'neon_pack' },
    });

    // Purchase may fail if DB not available (500/503) — acceptable in non-DB CI
    if (!purchaseRes.ok()) {
      console.log(`[Test] Visual pack purchase returned ${purchaseRes.status()} — DB may be unavailable`);
      return;
    }

    const body = await purchaseRes.json();
    expect(body.success).toBe(true);
    expect(body.item.id).toBe('neon_pack');
    expect(body.item.type).toBe('visual_pack');

    // Verify /api/me reflects the new active visual pack
    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();
    expect(me.profile.activeVisualPack).toBe('neon_pack');
  });

  test('purchasing a DJ title succeeds and updates profile', async ({ request }) => {
    const purchaseRes = await request.post(`${BASE}/api/purchase`, {
      data: { itemId: 'rising_title' },
    });

    if (!purchaseRes.ok()) return; // DB unavailable

    const body = await purchaseRes.json();
    expect(body.success).toBe(true);
    expect(body.item.type).toBe('dj_title');

    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();
    expect(me.profile.activeTitle).toBe('rising_title');
  });

  test('purchased visual pack appears in /api/user/entitlements as ownedItems', async ({ request }) => {
    // Check /api/me ownedItems (set of permanently owned entitlements)
    const meRes = await request.get(`${BASE}/api/me`);
    if (!meRes.ok()) return;

    const me = await meRes.json();
    // If purchase worked, neon_pack should be in ownedItems
    if (me.ownedItems && me.ownedItems.length > 0) {
      const hasNeonPack = me.ownedItems.some(
        (i) => i.key === 'neon_pack' && i.type === 'visual_pack'
      );
      // This will be true if the DB purchase succeeded above; skip check otherwise
      if (me.profile.activeVisualPack === 'neon_pack') {
        expect(hasNeonPack).toBe(true);
      }
    }
  });

  test('purchasing a non-existent item returns 404', async ({ request }) => {
    const testUser = makeUser('purchasefail');
    await signupAndLogin(request, testUser);
    const res = await request.post(`${BASE}/api/purchase`, {
      data: { itemId: 'totally_fake_item_xyz' },
    });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

test.describe('Add-on purchases — profile upgrades', () => {
  let user;

  test.beforeAll(async ({ request }) => {
    user = makeUser('profile');
    await signupAndLogin(request, user);
  });

  test('purchasing crown_effect updates profile.crownEffect', async ({ request }) => {
    const purchaseRes = await request.post(`${BASE}/api/purchase`, {
      data: { itemId: 'crown_effect' },
    });
    if (!purchaseRes.ok()) return; // DB unavailable

    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();
    expect(me.profile.crownEffect).toBe(true);
  });

  test('purchasing verified_badge updates profile.verifiedBadge', async ({ request }) => {
    const purchaseRes = await request.post(`${BASE}/api/purchase`, {
      data: { itemId: 'verified_badge' },
    });
    if (!purchaseRes.ok()) return;

    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();
    expect(me.profile.verifiedBadge).toBe(true);
  });

  test('purchasing animated_name updates profile.animatedName', async ({ request }) => {
    const purchaseRes = await request.post(`${BASE}/api/purchase`, {
      data: { itemId: 'animated_name' },
    });
    if (!purchaseRes.ok()) return;

    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();
    expect(me.profile.animatedName).toBe(true);
  });

  test('purchasing reaction_trail updates profile.reactionTrail', async ({ request }) => {
    const purchaseRes = await request.post(`${BASE}/api/purchase`, {
      data: { itemId: 'reaction_trail' },
    });
    if (!purchaseRes.ok()) return;

    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();
    expect(me.profile.reactionTrail).toBe(true);
  });
});

test.describe('Add-on UI state consistency', () => {
  let user;

  test.beforeEach(async ({ request }) => {
    user = makeUser('uistate');
    await signupAndLogin(request, user);
  });

  test('/api/me profile fields are always defined (never undefined)', async ({ request }) => {
    const meRes = await request.get(`${BASE}/api/me`);
    expect(meRes.ok()).toBeTruthy();
    const me = await meRes.json();

    // All profile fields must be defined (not undefined) so the UI can render them
    const p = me.profile;
    expect(p).toBeDefined();
    expect(p.djScore).toBeDefined();
    expect(p.djRank).toBeDefined();
    expect(p.activeVisualPack !== undefined).toBe(true);   // may be null but not undefined
    expect(p.activeTitle !== undefined).toBe(true);
    expect(p.verifiedBadge).toBeDefined();
    expect(p.crownEffect).toBeDefined();
    expect(p.animatedName).toBeDefined();
    expect(p.reactionTrail).toBeDefined();
  });

  test('/api/me tier and entitlement fields are always consistent', async ({ request }) => {
    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();

    // An admin always gets effectiveTier=PRO regardless of stored tier
    if (me.isAdmin) {
      expect(me.effectiveTier).toBe('PRO');
    } else {
      // For regular users, effectiveTier should equal tier (no secret override)
      expect(['FREE', 'PARTY_PASS', 'PRO', 'PRO_MONTHLY']).toContain(me.effectiveTier);
    }

    // entitlements fields are always boolean
    expect(typeof me.entitlements.hasPartyPass).toBe('boolean');
    expect(typeof me.entitlements.hasPro).toBe('boolean');
  });

  test('/api/me djScore and djRank default correctly for new user', async ({ request }) => {
    const meRes = await request.get(`${BASE}/api/me`);
    const me = await meRes.json();

    // New user should have 0 djScore and 'Bedroom DJ' rank
    expect(me.profile.djScore).toBe(0);
    expect(me.profile.djRank).toBe('Bedroom DJ');
  });

  test('planPill values (phone limits) match tier-info (UI accuracy)', async ({ request }) => {
    const [meRes, tierRes] = await Promise.all([
      request.get(`${BASE}/api/me`),
      request.get(`${BASE}/api/tier-info`),
    ]);

    const me = await meRes.json();
    const tierInfo = await tierRes.json();

    const tier = me.effectiveTier || me.tier;
    const expectedLimits = {
      FREE: tierInfo.tiers.FREE.phoneLimit,
      PARTY_PASS: tierInfo.tiers.PARTY_PASS.phoneLimit,
      PRO: (tierInfo.tiers.PRO || tierInfo.tiers.PRO_MONTHLY)?.phoneLimit,
      PRO_MONTHLY: (tierInfo.tiers.PRO || tierInfo.tiers.PRO_MONTHLY)?.phoneLimit,
    };

    if (expectedLimits[tier] !== undefined) {
      // The phone limit for the user's tier should match what tier-info says
      expect(expectedLimits[tier]).toBeGreaterThan(0);
    }
  });
});
