/**
 * nav-auth.test.js
 *
 * Unit tests for the lightweight SPA router (router.js) and
 * auth-driven navigation logic.
 *
 * These tests run in Node (Jest) without a real browser.
 * They import router.js directly and stub browser globals.
 */

'use strict';

// ---------------------------------------------------------------------------
// Stubs for browser globals consumed by router.js
// ---------------------------------------------------------------------------

// history stub
const historyStub = {
  pushState: jest.fn(),
  replaceState: jest.fn(),
};

// showView stub
let showViewCalls = [];
function showView(id) { showViewCalls.push(id); }

// isLoggedIn stub — toggled per test
let _loggedIn = false;
function isLoggedIn() { return _loggedIn; }

// initPartyHomeView stub
let initPartyHomeViewCalled = false;
function initPartyHomeView() { initPartyHomeViewCalled = true; }

// showLanding stub
let showLandingCalled = false;
function showLanding() { showLandingCalled = true; }

// showParty stub
let showPartyCalled = false;
function showParty() { showPartyCalled = true; }

// ALL_VIEWS (subset enough for router)
const ALL_VIEWS = ['viewLanding', 'viewAuthHome', 'viewParty', 'viewGuest', 'viewLogin'];

// state stub
const state = { code: null };

// Minimal document stub
global.document = {
  getElementById: jest.fn(() => ({ classList: { add: jest.fn(), remove: jest.fn() } })),
  readyState: 'complete',
  addEventListener: jest.fn(),
};
global.window = {
  location: { pathname: '/' },
  addEventListener: jest.fn(),
};
global.history = historyStub;

// Expose stubs as globals so router.js can find them
global.isLoggedIn = isLoggedIn;
global.showView = showView;
global.initPartyHomeView = initPartyHomeView;
global.showLanding = showLanding;
global.showParty = showParty;
global.ALL_VIEWS = ALL_VIEWS;
global.state = state;

// ---------------------------------------------------------------------------
// Load the router module
// ---------------------------------------------------------------------------
const router = require('./router.js');
const { _isProtected, _partyCodeFromPath, _renderRoute, navigate, ROUTE_MAP } = router;

// ---------------------------------------------------------------------------
// Helper — reset stubs between tests
// ---------------------------------------------------------------------------
function resetStubs() {
  showViewCalls = [];
  initPartyHomeViewCalled = false;
  showLandingCalled = false;
  showPartyCalled = false;
  historyStub.pushState.mockClear();
  historyStub.replaceState.mockClear();
  state.code = null;
}

// ---------------------------------------------------------------------------
// ROUTE_MAP
// ---------------------------------------------------------------------------
describe('ROUTE_MAP', () => {
  test('maps / to viewLanding', () => {
    expect(ROUTE_MAP['/']).toBe('viewLanding');
  });

  test('maps /home to viewAuthHome', () => {
    expect(ROUTE_MAP['/home']).toBe('viewAuthHome');
  });

  test('maps /login to viewLogin', () => {
    expect(ROUTE_MAP['/login']).toBe('viewLogin');
  });
});

// ---------------------------------------------------------------------------
// _isProtected
// ---------------------------------------------------------------------------
describe('_isProtected()', () => {
  test('/home is protected', () => {
    expect(_isProtected('/home')).toBe(true);
  });

  test('/party/ABC123 is protected', () => {
    expect(_isProtected('/party/ABC123')).toBe(true);
  });

  test('/account is protected', () => {
    expect(_isProtected('/account')).toBe(true);
  });

  test('/ is NOT protected', () => {
    expect(_isProtected('/')).toBe(false);
  });

  test('/login is NOT protected', () => {
    expect(_isProtected('/login')).toBe(false);
  });

  test('/signup is NOT protected', () => {
    expect(_isProtected('/signup')).toBe(false);
  });

  test('/party/ (no code) is NOT treated as a valid party route', () => {
    // The prefix check requires a non-empty code after /party/
    expect(_isProtected('/party/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// _partyCodeFromPath
// ---------------------------------------------------------------------------
describe('_partyCodeFromPath()', () => {
  test('returns code for valid 6-char code', () => {
    expect(_partyCodeFromPath('/party/ABC123')).toBe('ABC123');
  });

  test('upper-cases the code', () => {
    expect(_partyCodeFromPath('/party/abc123')).toBe('ABC123');
  });

  test('returns null for non-party path', () => {
    expect(_partyCodeFromPath('/home')).toBeNull();
  });

  test('returns null for invalid code (too short)', () => {
    expect(_partyCodeFromPath('/party/AB')).toBeNull();
  });

  test('returns null for invalid code (too long)', () => {
    expect(_partyCodeFromPath('/party/ABCDEFG')).toBeNull();
  });

  test('returns null for /party/ with no code', () => {
    expect(_partyCodeFromPath('/party/')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _renderRoute — route guard: unauthenticated user
// ---------------------------------------------------------------------------
describe('_renderRoute() — unauthenticated', () => {
  beforeEach(() => {
    _loggedIn = false;
    resetStubs();
  });

  test('/ shows landing', () => {
    _renderRoute('/');
    expect(showViewCalls).toContain('viewLanding');
  });

  test('/login shows login view', () => {
    _renderRoute('/login');
    expect(showViewCalls).toContain('viewLogin');
  });

  test('/home redirects to / (route guard)', () => {
    _renderRoute('/home');
    expect(historyStub.replaceState).toHaveBeenCalledWith({ path: '/' }, '', '/');
    expect(showViewCalls).toContain('viewLanding');
  });

  test('/party/ABC123 redirects to / (route guard)', () => {
    _renderRoute('/party/ABC123');
    expect(historyStub.replaceState).toHaveBeenCalledWith({ path: '/' }, '', '/');
  });
});

// ---------------------------------------------------------------------------
// _renderRoute — authenticated user
// ---------------------------------------------------------------------------
describe('_renderRoute() — authenticated', () => {
  beforeEach(() => {
    _loggedIn = true;
    resetStubs();
  });

  test('/ redirects to /home', () => {
    _renderRoute('/');
    expect(historyStub.replaceState).toHaveBeenCalledWith({ path: '/home' }, '', '/home');
    expect(showViewCalls).toContain('viewAuthHome');
  });

  test('/login redirects to /home', () => {
    _renderRoute('/login');
    expect(historyStub.replaceState).toHaveBeenCalledWith({ path: '/home' }, '', '/home');
  });

  test('/home shows viewAuthHome and calls initPartyHomeView', () => {
    _renderRoute('/home');
    expect(showViewCalls).toContain('viewAuthHome');
    expect(initPartyHomeViewCalled).toBe(true);
  });

  test('/party/ABC123 calls showParty() and sets state.code', () => {
    _renderRoute('/party/ABC123');
    expect(state.code).toBe('ABC123');
    expect(showPartyCalled).toBe(true);
  });

  test('unknown path falls back to /home', () => {
    _renderRoute('/unknown-route-xyz');
    expect(historyStub.replaceState).toHaveBeenCalledWith({ path: '/home' }, '', '/home');
    expect(showViewCalls).toContain('viewAuthHome');
  });
});

// ---------------------------------------------------------------------------
// navigate()
// ---------------------------------------------------------------------------
describe('navigate()', () => {
  beforeEach(() => {
    _loggedIn = true;
    resetStubs();
    // reset window.location.pathname
    global.window.location.pathname = '/home';
  });

  test('calls pushState with the given path', () => {
    navigate('/home');
    expect(historyStub.pushState).toHaveBeenCalledWith({ path: '/home' }, '', '/home');
  });

  test('calls replaceState when replace:true', () => {
    navigate('/home', { replace: true });
    expect(historyStub.replaceState).toHaveBeenCalledWith({ path: '/home' }, '', '/home');
    expect(historyStub.pushState).not.toHaveBeenCalled();
  });

  test('renders the route after navigation', () => {
    navigate('/home');
    expect(showViewCalls).toContain('viewAuthHome');
  });
});
