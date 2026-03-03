/**
 * nav-auth.test.js
 *
 * Unit tests for the lightweight router (router.js) and server
 * navigation/auth endpoints (/ready, /version).
 *
 * The router's pure helpers (matchRoute, checkGuard, resolvePath, navigate)
 * are tested without DOM or browser APIs.  navigate() is tested with a
 * minimal history stub so the real History API isn't required.
 */

'use strict';

const request = require('supertest');

// ── Server (needed for /ready and /version tests) ────────────────────────────
let app;
beforeAll(() => {
  // Load server lazily so Redis mock in jest.setup.js is already in place
  ({ app } = require('./server'));
});

// ── Router module ─────────────────────────────────────────────────────────────
const {
  ROUTES,
  VIEWS,
  HASH_TO_VIEW,
  routerState,
  matchRoute,
  checkGuard,
  resolvePath,
  navigate
} = require('./router');

// ─────────────────────────────────────────────────────────────────────────────
// matchRoute
// ─────────────────────────────────────────────────────────────────────────────
describe('matchRoute()', () => {
  it('matches / to viewLanding', () => {
    const result = matchRoute('/');
    expect(result).not.toBeNull();
    expect(result.route.view).toBe('viewLanding');
  });

  it('matches /login to viewLogin', () => {
    const result = matchRoute('/login');
    expect(result).not.toBeNull();
    expect(result.route.view).toBe('viewLogin');
  });

  it('matches /home to viewAuthHome', () => {
    const result = matchRoute('/home');
    expect(result).not.toBeNull();
    expect(result.route.view).toBe('viewAuthHome');
  });

  it('matches /party/ABC123 and extracts code param', () => {
    const result = matchRoute('/party/ABC123');
    expect(result).not.toBeNull();
    expect(result.route.view).toBe('viewParty');
    expect(result.params.code).toBe('ABC123');
  });

  it('uppercases the party code', () => {
    const result = matchRoute('/party/abc123');
    expect(result.params.code).toBe('ABC123');
  });

  it('returns null for unknown paths', () => {
    expect(matchRoute('/does-not-exist')).toBeNull();
  });

  it('matches /account to viewProfile', () => {
    const result = matchRoute('/account');
    expect(result.route.view).toBe('viewProfile');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkGuard
// ─────────────────────────────────────────────────────────────────────────────
describe('checkGuard()', () => {
  const landingRoute  = ROUTES.find(r => r.pattern.test('/'));
  const homeRoute     = ROUTES.find(r => r.pattern.test('/home'));
  const loginRoute    = ROUTES.find(r => r.pattern.test('/login'));

  it('allows landing (auth:null) for logged-out users', () => {
    expect(checkGuard(landingRoute, false).allowed).toBe(true);
  });

  it('allows landing (auth:null) for logged-in users', () => {
    expect(checkGuard(landingRoute, true).allowed).toBe(true);
  });

  it('blocks /home (auth:user) for logged-out users and redirects to /', () => {
    const result = checkGuard(homeRoute, false);
    expect(result.allowed).toBe(false);
    expect(result.redirect).toBe('/');
  });

  it('allows /home (auth:user) for logged-in users', () => {
    expect(checkGuard(homeRoute, true).allowed).toBe(true);
  });

  it('blocks /login (auth:guest) for logged-in users and redirects to /home', () => {
    const result = checkGuard(loginRoute, true);
    expect(result.allowed).toBe(false);
    expect(result.redirect).toBe('/home');
  });

  it('allows /login (auth:guest) for logged-out users', () => {
    expect(checkGuard(loginRoute, false).allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolvePath
// ─────────────────────────────────────────────────────────────────────────────
describe('resolvePath()', () => {
  it('logged-out user on / gets viewLanding', () => {
    const r = resolvePath('/', false);
    expect(r.view).toBe('viewLanding');
    expect(r.path).toBe('/');
  });

  it('logged-in user on / is redirected to /home → viewAuthHome', () => {
    const r = resolvePath('/', true);
    expect(r.view).toBe('viewAuthHome');
    expect(r.path).toBe('/home');
  });

  it('logged-out user requesting /home is redirected to /', () => {
    const r = resolvePath('/home', false);
    expect(r.view).toBe('viewLanding');
    expect(r.path).toBe('/');
  });

  it('logged-in user requesting /login is redirected to /home', () => {
    const r = resolvePath('/login', true);
    expect(r.view).toBe('viewAuthHome');
    expect(r.path).toBe('/home');
  });

  it('logged-in user on /party/XY1234 gets viewParty with code param', () => {
    const r = resolvePath('/party/XY1234', true);
    expect(r.view).toBe('viewParty');
    expect(r.params.code).toBe('XY1234');
  });

  it('unknown path for logged-out user falls back to /', () => {
    const r = resolvePath('/unknown-route', false);
    expect(r.path).toBe('/');
    expect(r.view).toBe('viewLanding');
  });

  it('unknown path for logged-in user falls back to /home', () => {
    const r = resolvePath('/unknown-route', true);
    expect(r.path).toBe('/home');
    expect(r.view).toBe('viewAuthHome');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// navigate() — tested with a minimal history stub
// ─────────────────────────────────────────────────────────────────────────────
describe('navigate()', () => {
  let pushStateCalls;
  let replaceStateCalls;
  let originalHistory;

  beforeEach(() => {
    pushStateCalls = [];
    replaceStateCalls = [];
    // Stub global history
    originalHistory = global.history;
    global.history = {
      pushState:    (st, t, url) => pushStateCalls.push(url),
      replaceState: (st, t, url) => replaceStateCalls.push(url)
    };
    routerState.isAuthenticated = false;
    routerState.currentPath = '/';
    routerState.partyCode = null;
  });

  afterEach(() => {
    global.history = originalHistory;
  });

  it('pushes /home to history when logged-in user navigates there', () => {
    navigate('/home', { isAuthenticated: true });
    expect(pushStateCalls).toContain('/home');
  });

  it('updates routerState.currentPath', () => {
    navigate('/home', { isAuthenticated: true });
    expect(routerState.currentPath).toBe('/home');
  });

  it('uses replaceState when opts.replace is true', () => {
    navigate('/home', { isAuthenticated: true, replace: true });
    expect(replaceStateCalls.length).toBeGreaterThan(0);
    expect(pushStateCalls.length).toBe(0);
  });

  it('redirects logged-out user to / when navigating to /home', () => {
    navigate('/home', { isAuthenticated: false });
    // replaceState is used because the resolved path differs from requested
    const allCalls = [...pushStateCalls, ...replaceStateCalls];
    expect(allCalls).toContain('/');
    expect(routerState.currentPath).toBe('/');
  });

  it('stores party code in routerState when navigating to /party/:code', () => {
    navigate('/party/XYZABC', { isAuthenticated: true });
    expect(routerState.partyCode).toBe('XYZABC');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VIEWS and HASH_TO_VIEW exports
// ─────────────────────────────────────────────────────────────────────────────
describe('VIEWS registry', () => {
  it('maps home to viewAuthHome', () => {
    expect(VIEWS.home).toBe('viewAuthHome');
  });

  it('maps party to viewParty', () => {
    expect(VIEWS.party).toBe('viewParty');
  });

  it('maps landing to viewLanding', () => {
    expect(VIEWS.landing).toBe('viewLanding');
  });
});

describe('HASH_TO_VIEW registry', () => {
  it('maps #home to home', () => {
    expect(HASH_TO_VIEW['#home']).toBe('home');
  });

  it('maps #login to login', () => {
    expect(HASH_TO_VIEW['#login']).toBe('login');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server endpoints: /ready and /version
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /ready', () => {
  it('returns HTTP 200', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
  });

  it('returns a body with status "ready"', async () => {
    const res = await request(app).get('/ready');
    expect(res.body.status).toBe('ready');
  });
});

describe('GET /version', () => {
  it('returns HTTP 200', async () => {
    const res = await request(app).get('/version');
    expect(res.status).toBe(200);
  });

  it('includes a commit field (string)', async () => {
    const res = await request(app).get('/version');
    expect(typeof res.body.commit).toBe('string');
  });

  it('includes an environment field', async () => {
    const res = await request(app).get('/version');
    expect(res.body).toHaveProperty('environment');
  });

  it('includes a nodeVersion field (string)', async () => {
    const res = await request(app).get('/version');
    expect(typeof res.body.nodeVersion).toBe('string');
  });
});
