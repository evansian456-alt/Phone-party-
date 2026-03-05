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
  </header>
  <main class="wrap">
    <section class="landing-page" id="viewLanding"><h1>Landing</h1></section>
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
    <input id="joinCode" /><input id="guestName" />
    <input id="accountDjName" /><input id="accountEmail" /><input id="accountPassword" />
    <div id="accountTermsGroup" class="hidden"><input type="checkbox" id="accountTermsAccept" /></div>
    <div id="accountCreationError" class="auth-error hidden"></div>
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
    <div id="members"></div>
    <button id="btnCompletePayment"></button>
    <button id="btnCancelPayment"></button>
    <div class="prototype-mode-section"><div class="line"></div></div>
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

  test('setView("createJoin") when logged out → shows auth (viewAccountCreation)', () => {
    setView('createJoin');
    expect(isVisible('viewAccountCreation')).toBe(true);
    expect(isVisible('viewHome')).toBe(false);
  });

  test('setView("party") when logged out → shows auth (viewAccountCreation)', () => {
    setView('party');
    expect(isVisible('viewAccountCreation')).toBe(true);
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

  test('redirecting from a protected hash updates URL to #auth via replaceState', () => {
    // Navigate to a requiresAuth view via hash (fromHash:true), logged out
    // setView should redirect to auth and update URL with replaceState
    window.location.hash = '#party';
    setView('party', { fromHash: true });
    // Auth view should be shown
    expect(isVisible('viewAccountCreation')).toBe(true);
    // replaceState should have been called to update the URL to #auth
    expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '#auth');
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
    // Reset nav-hidden on post-auth elements
    document.querySelectorAll('.post-auth-only').forEach(el => el.classList.add('nav-hidden'));
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
});

describe('viewAccountCreation button handlers', () => {
  beforeEach(() => {
    localStorage.clear();
    global.isLoggedIn.mockReturnValue(false);
    global.signUp.mockReset();
    resetViews();
    // Reset form fields
    document.getElementById('accountDjName').value = '';
    document.getElementById('accountEmail').value = '';
    document.getElementById('accountPassword').value = '';
    document.getElementById('accountTermsAccept').checked = false;
    document.getElementById('accountTermsGroup').classList.add('hidden');
    const errorEl = document.getElementById('accountCreationError');
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
    // Show the viewAccountCreation
    document.getElementById('viewAccountCreation').classList.remove('hidden');
  });

  test('btnShowLogin navigates to login view', () => {
    document.getElementById('btnShowLogin').click();
    expect(isVisible('viewLogin')).toBe(true);
    expect(isVisible('viewAccountCreation')).toBe(false);
  });

  test('btnBackToTiers navigates to chooseTier view', () => {
    document.getElementById('btnBackToTiers').click();
    expect(isVisible('viewChooseTier')).toBe(true);
    expect(isVisible('viewAccountCreation')).toBe(false);
  });

  test('btnCreateAccountSubmit shows error when DJ name is empty', () => {
    document.getElementById('accountDjName').value = '';
    document.getElementById('btnCreateAccountSubmit').click();
    const errorEl = document.getElementById('accountCreationError');
    expect(errorEl.classList.contains('hidden')).toBe(false);
    expect(errorEl.textContent).toContain('DJ Name is required');
  });

  test('btnCreateAccountSubmit with DJ name only saves local profile and navigates to createJoin', () => {
    document.getElementById('accountDjName').value = 'DJ Cool';
    document.getElementById('btnCreateAccountSubmit').click();
    expect(getSavedProfile()).not.toBeNull();
    expect(getSavedProfile().djName).toBe('DJ Cool');
    expect(isVisible('viewHome')).toBe(true);
  });

  test('btnCreateAccountSubmit with email but no password shows error', () => {
    document.getElementById('accountDjName').value = 'DJ Cool';
    document.getElementById('accountEmail').value = 'test@example.com';
    document.getElementById('accountPassword').value = '';
    document.getElementById('btnCreateAccountSubmit').click();
    const errorEl = document.getElementById('accountCreationError');
    expect(errorEl.classList.contains('hidden')).toBe(false);
    expect(errorEl.textContent).toContain('Both email and password are required');
  });

  test('btnCreateAccountSubmit with email+password but no terms shows error', () => {
    document.getElementById('accountDjName').value = 'DJ Cool';
    document.getElementById('accountEmail').value = 'test@example.com';
    document.getElementById('accountPassword').value = 'password123';
    document.getElementById('accountTermsAccept').checked = false;
    document.getElementById('btnCreateAccountSubmit').click();
    const errorEl = document.getElementById('accountCreationError');
    expect(errorEl.classList.contains('hidden')).toBe(false);
    expect(errorEl.textContent).toContain('Terms & Conditions');
  });

  test('btnCreateAccountSubmit with email+password+terms calls signUp', async () => {
    // Return failure so the success path (saveProfile + initAuthFlow) is not triggered —
    // we only need to assert that signUp was called with the correct arguments.
    global.signUp.mockResolvedValue({ success: false, error: 'test-only failure' });
    document.getElementById('accountDjName').value = 'DJ Cool';
    document.getElementById('accountEmail').value = 'test@example.com';
    document.getElementById('accountPassword').value = 'password123';
    document.getElementById('accountTermsAccept').checked = true;
    document.getElementById('btnCreateAccountSubmit').click();
    // Allow async handler to run
    await new Promise(r => setTimeout(r, 10));
    expect(global.signUp).toHaveBeenCalledWith('test@example.com', 'password123', 'DJ Cool', true);
  });
});
