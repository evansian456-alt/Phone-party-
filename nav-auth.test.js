/**
 * @jest-environment jsdom
 *
 * Navigation + Auth-state unit tests.
 * These tests do NOT require Redis or a running server.
 * They validate:
 *   - Profile schema helpers (getSavedProfile, saveProfile, clearProfile, hasValidProfile)
 *   - VIEWS registry structure
 *   - setView() auth gating and hash routing
 *   - Nav-bar visibility rules
 */

// ── Spy on history.pushState before loading app.js ───────────────────────────
const pushStateMock = jest.fn();
Object.defineProperty(window, 'history', {
  value: { pushState: pushStateMock, replaceState: jest.fn(), back: jest.fn() },
  writable: true,
  configurable: true,
});

// ── Stub WebSocket (connectWS opens one at startup) ──────────────────────────
global.WebSocket = class {
  constructor() { this.readyState = 0; }
  send() {} close() {} addEventListener() {} removeEventListener() {}
};

// ── Stub cross-file globals (live in other <script> tags in the real page) ───
// API_BASE is defined in config.js (loaded separately in the browser) — provide
// an empty-string default here so fetch() calls use relative URLs in the test env.
global.API_BASE = '';
global.connectWS = jest.fn().mockResolvedValue(undefined);
global.toast = jest.fn();
global.showToast = jest.fn();
global.logOut = jest.fn();
global.logIn = jest.fn();
global.signUp = jest.fn();
global.getCurrentUser = jest.fn().mockReturnValue(null);
global.getCachedUser = jest.fn().mockReturnValue(null);
global.isLoggedIn = jest.fn().mockReturnValue(false);
global.restoreUserEntitlements = jest.fn().mockResolvedValue(undefined);
global.initNetworkMonitoring = jest.fn();
global.initAccessibility = jest.fn();
global.initModeration = jest.fn();
global.initMediaSession = jest.fn();
global.SyncStatusUI = class { start() {} };
global.DriftController = class { start() {} };
global.TimeSyncClient = class { start() {} };
global.ReferralUI = undefined;

// ── Stub init helpers called during initializeAllFeatures ────────────────────
global.initCrowdEnergyMeter = jest.fn();
global.initDJMoments = jest.fn();
global.initPartyRecap = jest.fn();
global.initHostGiftPartyPass = jest.fn();
global.initParentInfo = jest.fn();
global.initBeatAwareUI = jest.fn();
global.initSessionStats = jest.fn();
global.initBoostAddons = jest.fn();
global.initLeaderboardProfileUI = jest.fn();
global.initMonetizationUI = jest.fn();
global.initProductionUpgradeModules = jest.fn();
global.checkAutoReconnect = jest.fn();
global.initializeMusicPlayer = jest.fn();
global.updateDebugState = jest.fn();
global.cleanupMusicPlayer = jest.fn();
global.cleanupGuestAudio = jest.fn();
global.stopPartyStatusPolling = jest.fn();
global.startPartyStatusPolling = jest.fn();
global.setPlanPill = jest.fn();
global.checkPartyPassStatus = jest.fn();
global.updatePartyPassUI = jest.fn();
global.renderRoom = jest.fn();
global.initCompleteProfileView = jest.fn();
global.initPartyHomeView = jest.fn();
global.updatePlaybackUI = jest.fn();
global.updateQualityUI = jest.fn();
global.hasPartyPassEntitlement = jest.fn().mockReturnValue(false);
global.showGuest = jest.fn();
global.showPayment = jest.fn();
global.updateSelectedTierDisplay = jest.fn();
global.showProfile = jest.fn();

// ── Minimal DOM (every view + required controls) ─────────────────────────────
document.body.innerHTML = `
  <header class="top">
    <div class="header-right">
      <button id="btnParentInfo">ℹ️</button>
      <button class="btn-leaderboard post-auth-only nav-hidden" id="btnLeaderboard">🏆</button>
      <button class="btn-profile post-auth-only nav-hidden" id="btnProfile">👤</button>
      <button class="btn-upgrade post-auth-only nav-hidden" id="btnUpgradeHub">⭐</button>
      <button class="btn-account" id="btnAccount">🔑</button>
      <div class="pill post-auth-only nav-hidden" id="planPill">Free · 2 phones</div>
    </div>
    <div class="header-right-public pre-auth-only" id="headerPublicButtons">
    </div>
  </header>
  <main class="wrap">
    <section class="landing-page" id="viewLanding">
      <h1>Landing</h1>
      <div class="landing-cta-buttons pre-auth-only">
        <button id="btnLandingSignup">GET STARTED FREE</button>
        <button id="btnLandingLogin">LOG IN</button>
      </div>
    </section>
    <section class="card hidden" id="viewChooseTier"><h1>Choose Tier</h1></section>
    <section class="card hidden" id="viewAccountCreation"><h1>Create Account</h1></section>
    <section class="card hidden" id="viewHome"><h1>Create/Join</h1></section>
    <section class="card hidden" id="viewParty"><h1>Party</h1></section>
    <section class="card hidden" id="viewPayment"><h1>Payment</h1></section>
    <section class="card hidden" id="viewGuest"><h1>Guest</h1></section>
    <section class="card hidden" id="viewLogin"><h1>Login</h1></section>
    <section class="card hidden" id="viewSignup"><h1>Signup</h1></section>
    <section class="card hidden" id="viewPasswordReset"><h1>Reset</h1></section>
    <section class="card hidden" id="viewProfile"><h1>Profile</h1></section>
    <section class="card hidden" id="viewUpgradeHub"><h1>Upgrade</h1></section>
    <section class="card hidden" id="viewVisualPackStore"><h1>Visual</h1></section>
    <section class="card hidden" id="viewProfileUpgrades"><h1>Upgrades</h1></section>
    <section class="card hidden" id="viewPartyExtensions"><h1>Extensions</h1></section>
    <section class="card hidden" id="viewDjTitleStore"><h1>DJ Titles</h1></section>
    <section class="card hidden" id="viewLeaderboard"><h1>Leaderboard</h1></section>
    <section class="card hidden" id="viewMyProfile"><h1>My Profile</h1></section>
    <section class="card hidden" id="viewCompleteProfile"><h1>Complete Profile</h1></section>
    <section class="card hidden" id="viewAuthHome"><h1>Auth Home</h1></section>
    <section class="card hidden" id="viewAdminDashboard"><h1>Admin Dashboard</h1></section>
    <section class="card hidden" id="viewInviteFriends"><h1>Invite Friends</h1></section>
    <section class="card hidden" id="viewTerms"><h1>Terms</h1></section>
    <section class="card hidden" id="viewPrivacy"><h1>Privacy</h1></section>
    <section class="card hidden" id="viewYoutubeService"><h1>YouTube Service</h1></section>
    <input id="joinCode" /><input id="guestName" />
    <input id="accountDjName" /><input id="accountEmail" /><input id="accountPassword" />
    <div id="selectedTierInfo">
      <div class="selected-tier-badge"></div>
      <div class="selected-tier-details"></div>
    </div>
    <div id="partyCode"></div><div id="partyTitle"></div><div id="partyMeta"></div>
    <div id="createStatusMessage"></div><div id="createDebugInfo"></div>
    <div id="joinStatusMessage"></div><div id="joinDebugInfo"></div>
    <div id="partyStatus" class="hidden"></div><div id="joinStatus" class="hidden"></div>
    <div id="offlineWarning" class="hidden"></div>
    <div id="partyPassBanner" class="hidden"></div>
    <div id="partyPassActive" class="hidden"></div>
    <div id="partyPassUpgrade" class="hidden"></div>
    <div id="partyPassTitle"></div><div id="partyPassTimer"></div>
    <div id="partyPassDesc" class="hidden"></div>
    <div id="partyGuestCount"></div><div id="partyTimeRemaining"></div>
    <div id="crowdEnergyCard" class="hidden"></div>
    <div id="djMomentsCard" class="hidden"></div>
    <div id="hostGiftSection" class="hidden"></div>
    <div id="djEmojiReactionsSection" class="hidden"></div>
    <div id="djPresetMessagesSection" class="hidden"></div>
    <div id="djQuickButtonsContainer" class="hidden"></div>
    <div id="officialAppSyncSection" class="hidden"></div>
    <div id="musicUploadSection" class="hidden"></div>
    <div id="hostQueueSection" class="hidden"></div>
    <button id="btnBackToDj" class="hidden"></button>
    <button id="btnCloseDj"></button>
    <div id="devNavigationPanel" class="hidden"></div>
    <div id="upgradeWarning" class="hidden"></div>
    <div id="promoModal" class="hidden"></div>
    <input id="promoInput" /><button id="promoBtn"></button>
    <button id="promoApply"></button><button id="promoClose"></button>
    <button id="btnSeePricing"></button>
    <button id="btnSelectFree"></button>
    <button id="btnSelectPartyPass"></button>
    <button id="btnSelectPro"></button>
    <button id="btnBackToLanding"></button>
    <button id="btnBackToTiers"></button>
    <button id="btnContinueToCreateParty"></button>
    <button id="btnLandingAddons"></button>
    <button id="btnShowCreateParty"></button>
    <button id="btnShowJoinParty"></button>
    <button id="btnHideCreateParty"></button>
    <button id="btnHideJoinParty"></button>
    <button id="btnCreate"></button>
    <button id="btnJoin"></button>
    <div id="createPartySection" class="hidden"></div>
    <div id="joinPartySection" class="hidden"></div>
    <button id="btnCreateAccountSubmit"></button>
    <button id="btnShowLogin"></button>
    <button id="btnSkipAccount">Skip</button>
    <div class="prototype-mode-section"><div class="line"></div></div>
    <!-- Party view controls (needed so init() event-handler setup doesn't throw) -->
    <input type="checkbox" id="togglePro" />
    <button id="btnLeave"></button>
    <button id="btnCopy"></button>
    <button id="btnPlay"></button>
    <button id="btnPause"></button>
    <button id="btnAd"></button>
    <button id="btnAddPhone"></button>
    <button id="btnSpeaker"></button>
    <button id="btnCompletePayment"></button>
    <button id="btnCancelPayment"></button>
    <button id="btnProYes"></button>
    <button id="btnProNo"></button>
    <button id="btnWarnCancel"></button>
    <button id="btnWarnAnyway"></button>
    <button id="btnSpeakerOk"></button>
  </main>
`;

// ── Suppress noise from app.js during tests ───────────────────────────────────
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
  console.warn.mockRestore();
  console.error.mockRestore();
});

// ── Load app.js; destructure exported helpers ─────────────────────────────────
localStorage.clear();
const appModule = require('./app.js');

const {
  VIEWS,
  HASH_TO_VIEW,
  ALL_VIEWS,
  PROFILE_SCHEMA_VERSION,
  getSavedProfile,
  saveProfile,
  clearProfile,
  hasValidProfile,
  setView,
  initAuthFlow,
  confirmAuthSession,
} = appModule;

// ── DOM helpers ───────────────────────────────────────────────────────────────
function isVisible(id) {
  const el = document.getElementById(id);
  return el != null && !el.classList.contains('hidden');
}

function resetViews() {
  ALL_VIEWS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('Profile schema helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('getSavedProfile() returns null when nothing is stored', () => {
    expect(getSavedProfile()).toBeNull();
  });

  test('saveProfile() persists a profile and getSavedProfile() retrieves it', () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    const p = getSavedProfile();
    expect(p).not.toBeNull();
    expect(p.djName).toBe('DJ Test');
    expect(p.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
  });

  test('clearProfile() removes the saved profile', () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    clearProfile();
    expect(getSavedProfile()).toBeNull();
  });

  test('hasValidProfile() returns false when no profile saved', () => {
    expect(hasValidProfile()).toBe(false);
  });

  test('hasValidProfile() returns true after saveProfile()', () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    expect(hasValidProfile()).toBe(true);
  });

  test('getSavedProfile() returns null when stored profile has no djName', () => {
    localStorage.setItem('syncSpeakerProfile_v' + PROFILE_SCHEMA_VERSION, JSON.stringify({ tier: 'FREE' }));
    expect(getSavedProfile()).toBeNull();
  });

  test('saveProfile() clears older schema versions', () => {
    if (PROFILE_SCHEMA_VERSION > 0) {
      const oldKey = 'syncSpeakerProfile_v' + (PROFILE_SCHEMA_VERSION - 1);
      localStorage.setItem(oldKey, 'old-data');
      saveProfile({ djName: 'New DJ', tier: 'FREE' });
      expect(localStorage.getItem(oldKey)).toBeNull();
    }
    expect(getSavedProfile()).not.toBeNull();
  });
});

describe('VIEWS registry', () => {
  test('VIEWS is defined with expected entries', () => {
    expect(VIEWS).toBeDefined();
    expect(VIEWS.landing).toBeDefined();
    expect(VIEWS.auth).toBeDefined();
    expect(VIEWS.createJoin).toBeDefined();
    expect(VIEWS.party).toBeDefined();
  });

  test('createJoin view requires auth', () => {
    expect(VIEWS.createJoin.requiresAuth).toBe(true);
  });

  test('party view requires auth', () => {
    expect(VIEWS.party.requiresAuth).toBe(true);
  });

  test('landing view does NOT require auth', () => {
    expect(VIEWS.landing.requiresAuth).toBe(false);
  });

  test('auth view does NOT require auth', () => {
    expect(VIEWS.auth.requiresAuth).toBe(false);
  });

  test('every view in VIEWS has an element in the test DOM', () => {
    Object.entries(VIEWS).forEach(([, def]) => {
      expect(document.getElementById(def.id)).not.toBeNull();
    });
  });
});

describe('setView() – auth gating', () => {
  beforeEach(() => {
    localStorage.clear();
    global.isLoggedIn.mockReturnValue(false);
    resetViews();
    pushStateMock.mockClear();
  });

  test('setView("createJoin") when logged out → shows landing (viewLanding)', () => {
    setView('createJoin');
    expect(isVisible('viewLanding')).toBe(true);
    expect(isVisible('viewHome')).toBe(false);
  });

  test('setView("party") when logged out → shows landing (viewLanding)', () => {
    setView('party');
    expect(isVisible('viewLanding')).toBe(true);
    expect(isVisible('viewParty')).toBe(false);
  });

  test('setView("createJoin") when profile exists → shows createJoin (viewHome)', () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    setView('createJoin');
    expect(isVisible('viewHome')).toBe(true);
  });

  test('setView("landing") always works without auth', () => {
    setView('landing');
    expect(isVisible('viewLanding')).toBe(true);
  });

  test('setView("login") always works without auth', () => {
    setView('login');
    expect(isVisible('viewLogin')).toBe(true);
  });

  test('setView("auth") always works without auth', () => {
    setView('auth');
    expect(isVisible('viewAccountCreation')).toBe(true);
  });

  test('setView with unknown view name logs error and keeps current view', () => {
    // Landing should still be showing from previous reset
    document.getElementById('viewLanding').classList.remove('hidden');
    setView('nonExistentViewXYZ');
    // Should not have changed anything
    expect(isVisible('viewLanding')).toBe(true);
  });
});

describe('setView() – hash routing', () => {
  beforeEach(() => {
    localStorage.clear();
    global.isLoggedIn.mockReturnValue(false);
    resetViews();
    pushStateMock.mockClear();
  });

  test('setView("landing") calls pushState with #landing', () => {
    setView('landing');
    expect(pushStateMock).toHaveBeenCalledWith(null, '', '#landing');
  });

  test('setView("auth") calls pushState with #auth', () => {
    setView('auth');
    expect(pushStateMock).toHaveBeenCalledWith(null, '', '#auth');
  });

  test('setView with fromHash:true does NOT call pushState', () => {
    setView('landing', { fromHash: true });
    expect(pushStateMock).not.toHaveBeenCalled();
  });

  test('redirecting from a protected hash updates URL to #landing via replaceState', () => {
    // Navigate to a requiresAuth view via hash (fromHash:true), logged out
    // setView should redirect to landing and update URL with replaceState
    window.location.hash = '#party';
    setView('party', { fromHash: true });
    // Landing view should be shown
    expect(isVisible('viewLanding')).toBe(true);
    // replaceState should have been called to update the URL to #landing
    expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '#landing');
  });

  test('HASH_TO_VIEW maps #create-join → createJoin', () => {
    expect(HASH_TO_VIEW['create-join']).toBe('createJoin');
  });

  test('HASH_TO_VIEW maps #landing → landing', () => {
    expect(HASH_TO_VIEW['landing']).toBe('landing');
  });

  test('HASH_TO_VIEW maps #auth → auth', () => {
    expect(HASH_TO_VIEW['auth']).toBe('auth');
  });

  test('HASH_TO_VIEW maps #party → party', () => {
    expect(HASH_TO_VIEW['party']).toBe('party');
  });
});

describe('setView() – nav visibility', () => {
  beforeEach(() => {
    localStorage.clear();
    global.isLoggedIn.mockReturnValue(false);
    resetViews();
    // Reset nav-hidden on post-auth elements (they start hidden)
    document.querySelectorAll('.post-auth-only').forEach(el => el.classList.add('nav-hidden'));
    // Reset nav-hidden on pre-auth elements (they start visible)
    document.querySelectorAll('.pre-auth-only').forEach(el => el.classList.remove('nav-hidden'));
  });

  test('post-auth-only elements remain hidden when not logged in', () => {
    setView('landing');
    document.querySelectorAll('.post-auth-only').forEach(el => {
      expect(el.classList.contains('nav-hidden')).toBe(true);
    });
  });

  test('post-auth-only elements become visible when profile exists', () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    setView('createJoin');
    document.querySelectorAll('.post-auth-only').forEach(el => {
      expect(el.classList.contains('nav-hidden')).toBe(false);
    });
  });

  test('pre-auth-only elements are visible when not logged in', () => {
    global.isLoggedIn.mockReturnValue(false);
    setView('landing');
    document.querySelectorAll('.pre-auth-only').forEach(el => {
      expect(el.classList.contains('nav-hidden')).toBe(false);
    });
  });

  test('pre-auth-only elements get nav-hidden when profile exists', () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    setView('authHome');
    document.querySelectorAll('.pre-auth-only').forEach(el => {
      expect(el.classList.contains('nav-hidden')).toBe(true);
    });
  });

  test('pre-auth-only header area is hidden when logged in', () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    setView('authHome');
    // nav-hidden is added to the .pre-auth-only parent div, which hides all children
    const publicBtnsDiv = document.getElementById('headerPublicButtons');
    expect(publicBtnsDiv).not.toBeNull();
    expect(publicBtnsDiv.classList.contains('nav-hidden')).toBe(true);
  });

  test('pre-auth-only header area is visible when logged out', () => {
    global.isLoggedIn.mockReturnValue(false);
    setView('landing');
    const publicBtnsDiv = document.getElementById('headerPublicButtons');
    expect(publicBtnsDiv).not.toBeNull();
    expect(publicBtnsDiv.classList.contains('nav-hidden')).toBe(false);
  });
});

describe('btnLandingLogin – click navigates to login view', () => {
  beforeEach(() => {
    localStorage.clear();
    global.isLoggedIn.mockReturnValue(false);
    resetViews();
    pushStateMock.mockClear();
  });

  test('btnHeaderLogin no longer exists in the DOM', () => {
    expect(document.getElementById('btnHeaderLogin')).toBeNull();
  });

  test('clicking #btnLandingLogin shows the login view', () => {
    const btn = document.getElementById('btnLandingLogin');
    expect(btn).not.toBeNull();
    btn.click();
    expect(isVisible('viewLogin')).toBe(true);
  });

  test('clicking #btnLandingLogin updates the URL hash to #login', () => {
    const btn = document.getElementById('btnLandingLogin');
    btn.click();
    expect(pushStateMock).toHaveBeenCalledWith(null, '', '#login');
  });

  test('clicking #btnLandingLogin hides the landing view', () => {
    document.getElementById('viewLanding').classList.remove('hidden');
    const btn = document.getElementById('btnLandingLogin');
    btn.click();
    expect(isVisible('viewLanding')).toBe(false);
  });
});

// =============================================================================
// initAuthFlow() — boot auth guard
// Verifies that initAuthFlow() always consults the server and that stale
// localStorage data cannot bypass the landing page for logged-out users.
// =============================================================================

describe('initAuthFlow() — boot auth guard', () => {
  let origFetch;

  beforeEach(() => {
    localStorage.clear();
    global.isLoggedIn.mockReturnValue(false);
    resetViews();
    origFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = origFetch;
  });

  test('shows landing and returns false when /api/me returns 401', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await initAuthFlow();
    expect(result).toBe(false);
    expect(isVisible('viewLanding')).toBe(true);
  });

  test('clears stale user cache from localStorage when /api/me returns 401', async () => {
    // Simulate stale session: user entry left in localStorage after session expired
    localStorage.setItem('syncspeaker_current_user', JSON.stringify({ user: { id: '1' } }));
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    await initAuthFlow();
    expect(localStorage.getItem('syncspeaker_current_user')).toBeNull();
  });

  test('shows landing and returns false when fetch throws (network error)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
    const result = await initAuthFlow();
    expect(result).toBe(false);
    expect(isVisible('viewLanding')).toBe(true);
  });

  test('clears stale user cache when fetch throws (network error)', async () => {
    localStorage.setItem('syncspeaker_current_user', JSON.stringify({ user: { id: '1' } }));
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
    await initAuthFlow();
    expect(localStorage.getItem('syncspeaker_current_user')).toBeNull();
  });

  test('stale profile in localStorage does NOT bypass landing when not authenticated', async () => {
    // Simulate: user previously logged in (profile in localStorage) but session expired
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    localStorage.setItem('syncspeaker_current_user', JSON.stringify({ user: { id: '1' } }));
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await initAuthFlow();
    // Should be redirected to landing, not to createJoin or authHome
    expect(result).toBe(false);
    expect(isVisible('viewLanding')).toBe(true);
    expect(isVisible('viewHome')).toBe(false);
    expect(isVisible('viewAuthHome')).toBe(false);
  });

  test('initAuthFlow() 401 clears saved profile so hasValidProfile() returns false', async () => {
    // Stale profile in localStorage
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    expect(hasValidProfile()).toBe(true); // profile exists before auth check
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    await initAuthFlow();
    // Profile must be cleared so hasValidProfile() returns false
    expect(hasValidProfile()).toBe(false);
  });

  test('after initAuthFlow() 401, stale profile does NOT allow navigation to protected view', async () => {
    // Simulate: profile in localStorage, server returns 401 (session expired)
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    localStorage.setItem('syncspeaker_current_user', JSON.stringify({ user: { id: '1' } }));
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    await initAuthFlow(); // clears both user cache and profile
    resetViews();
    // Now try to navigate to a protected view — should redirect to landing
    global.isLoggedIn.mockReturnValue(false); // ensure isLoggedIn also returns false
    setView('createJoin');
    // Protected view must NOT be shown; landing view should appear
    expect(isVisible('viewHome')).toBe(false);
    expect(isVisible('viewLanding')).toBe(true);
  });

  test('initAuthFlow() network error also clears saved profile', async () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    expect(hasValidProfile()).toBe(true);
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
    await initAuthFlow();
    expect(hasValidProfile()).toBe(false);
  });
});

// =============================================================================
// confirmAuthSession() — post-login session confirmation
// Verifies that confirmAuthSession() does NOT clear auth state or redirect to
// landing on failure — unlike initAuthFlow() which is the boot-time guard.
// =============================================================================

describe('confirmAuthSession() — post-login session confirmation', () => {
  let origFetch;

  beforeEach(() => {
    localStorage.clear();
    global.isLoggedIn.mockReturnValue(false);
    resetViews();
    origFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = origFetch;
  });

  test('returns true and navigates to authHome when /api/me succeeds with profileCompleted', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        user: { id: '1', djName: 'DJ Test', email: 'test@test.com', profileCompleted: true },
        tier: 'FREE',
        effectiveTier: 'FREE',
        isAdmin: false,
      }),
    });
    const result = await confirmAuthSession();
    expect(result).toBe(true);
    expect(isVisible('viewAuthHome')).toBe(true);
    expect(isVisible('viewLanding')).toBe(false);
  });

  test('returns true and navigates to completeProfile when profileCompleted is false', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        user: { id: '1', djName: 'DJ Test', email: 'test@test.com', profileCompleted: false },
        tier: 'FREE',
        effectiveTier: 'FREE',
        isAdmin: false,
      }),
    });
    const result = await confirmAuthSession();
    expect(result).toBe(true);
    expect(isVisible('viewCompleteProfile')).toBe(true);
    expect(isVisible('viewLanding')).toBe(false);
  });

  test('returns false but does NOT redirect to landing when /api/me returns 401', async () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    const result = await confirmAuthSession();
    expect(result).toBe(false);
    // Must NOT redirect to landing — user just logged in successfully
    expect(isVisible('viewLanding')).toBe(false);
  });

  test('does NOT clear saved profile when /api/me returns 401', async () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    await confirmAuthSession();
    // Profile must remain intact so the user stays in the authenticated flow
    expect(hasValidProfile()).toBe(true);
  });

  test('returns false but does NOT redirect to landing on network error', async () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
    const result = await confirmAuthSession();
    expect(result).toBe(false);
    expect(isVisible('viewLanding')).toBe(false);
  });

  test('does NOT clear saved profile on network error', async () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
    await confirmAuthSession();
    // Profile must remain so hasValidProfile() still allows access to protected views
    expect(hasValidProfile()).toBe(true);
  });

  test('after confirmAuthSession() 401, saved profile still allows navigation to protected view', async () => {
    saveProfile({ djName: 'DJ Test', tier: 'FREE' });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    await confirmAuthSession();
    resetViews();
    // isLoggedIn returns false but hasValidProfile() is true — setView() should pass
    setView('createJoin');
    expect(isVisible('viewHome')).toBe(true);
    expect(isVisible('viewLanding')).toBe(false);
  });
});
