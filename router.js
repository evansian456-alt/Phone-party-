/**
 * router.js — Lightweight History API router for Phone Party SPA.
 *
 * Maps URL paths to view IDs, enforces auth guards, and uses
 * history.pushState / replaceState so back/forward buttons work
 * and deep links survive a page refresh.
 *
 * Exports (for Jest tests):
 *   ROUTES, VIEWS, HASH_TO_VIEW, routerState,
 *   matchRoute, checkGuard, resolvePath, navigate, initRouter
 */

'use strict';

// ---------------------------------------------------------------------------
// Route definitions
// auth: null   = public (anyone)
//       'user' = logged-in only  → redirect to /  if not authed
//       'guest'= logged-out only → redirect to /home if already authed
// ---------------------------------------------------------------------------
var ROUTES = [
  { pattern: /^\/$/, view: 'viewLanding', auth: null },
  { pattern: /^\/login$/, view: 'viewLogin', auth: 'guest' },
  { pattern: /^\/signup$/, view: 'viewSignup', auth: 'guest' },
  { pattern: /^\/home$/, view: 'viewAuthHome', auth: 'user' },
  { pattern: /^\/party\/create$/, view: 'viewAuthHome', auth: 'user' },
  { pattern: /^\/party\/join$/, view: 'viewAuthHome', auth: 'user' },
  { pattern: /^\/party\/([A-Za-z0-9]{6})$/, view: 'viewParty', auth: 'user', paramKey: 'code' },
  { pattern: /^\/account$/, view: 'viewProfile', auth: 'user' }
];

// VIEWS registry: logical name → DOM element id
var VIEWS = {
  landing:          'viewLanding',
  login:            'viewLogin',
  signup:           'viewSignup',
  home:             'viewAuthHome',
  party:            'viewParty',
  guest:            'viewGuest',
  profile:          'viewProfile',
  chooseTier:       'viewChooseTier',
  accountCreation:  'viewAccountCreation',
  completeProfile:  'viewCompleteProfile',
  payment:          'viewPayment',
  upgradeHub:       'viewUpgradeHub'
};

// Legacy hash-fragment → view name mapping (kept for back-compat)
var HASH_TO_VIEW = {
  '#landing':  'landing',
  '#login':    'login',
  '#signup':   'signup',
  '#home':     'home',
  '#party':    'party',
  '#profile':  'profile'
};

// Mutable router state (inspectable from tests)
var routerState = {
  currentPath: '/',
  isAuthenticated: false,
  partyCode: null
};

// ---------------------------------------------------------------------------
// Pure helpers (no DOM, no side-effects — safe to unit-test)
// ---------------------------------------------------------------------------

/**
 * Match a pathname against the route table.
 * @param {string} path
 * @returns {{ route: Object, params: Object }|null}
 */
function matchRoute(path) {
  for (var i = 0; i < ROUTES.length; i++) {
    var route = ROUTES[i];
    var m = path.match(route.pattern);
    if (m) {
      var params = {};
      if (route.paramKey && m[1]) {
        params[route.paramKey] = m[1].toUpperCase();
      }
      return { route: route, params: params };
    }
  }
  return null;
}

/**
 * Evaluate the auth guard for a route.
 * @param {Object} route
 * @param {boolean} isAuthenticated
 * @returns {{ allowed: boolean, redirect: string|null }}
 */
function checkGuard(route, isAuthenticated) {
  if (route.auth === 'user' && !isAuthenticated) {
    return { allowed: false, redirect: '/' };
  }
  if (route.auth === 'guest' && isAuthenticated) {
    return { allowed: false, redirect: '/home' };
  }
  return { allowed: true, redirect: null };
}

/**
 * Resolve a path against the route table, applying auth guards.
 * Returns the final { path, view, params } after any redirects.
 * @param {string} path
 * @param {boolean} isAuthenticated
 * @returns {{ path: string, view: string, params: Object }}
 */
function resolvePath(path, isAuthenticated) {
  // Logged-in users landing on / go straight to /home
  if (path === '/' && isAuthenticated) {
    return resolvePath('/home', isAuthenticated);
  }

  var result = matchRoute(path);
  if (!result) {
    // Unknown path → sensible default
    return isAuthenticated
      ? resolvePath('/home', isAuthenticated)
      : resolvePath('/', false);
  }

  var guard = checkGuard(result.route, isAuthenticated);
  if (!guard.allowed) {
    return resolvePath(guard.redirect, isAuthenticated);
  }

  return { path: path, view: result.route.view, params: result.params };
}

// ---------------------------------------------------------------------------
// DOM-side navigation (only runs in browser)
// ---------------------------------------------------------------------------

/**
 * Navigate to a path, push/replace browser history, and return the resolved
 * route so the caller can render the correct view.
 *
 * @param {string} path          - Target pathname (e.g. '/home')
 * @param {Object} [opts]
 * @param {boolean} [opts.replace]          - Use replaceState instead of pushState
 * @param {boolean} [opts.isAuthenticated]  - Override auth state (optional)
 * @returns {{ path: string, view: string, params: Object }}
 */
function navigate(path, opts) {
  opts = opts || {};
  var isAuthenticated = (opts.isAuthenticated !== undefined)
    ? opts.isAuthenticated
    : routerState.isAuthenticated;

  var resolved = resolvePath(path, isAuthenticated);

  if (typeof history !== 'undefined') {
    var histState = { path: resolved.path, params: resolved.params };
    if (opts.replace || resolved.path !== path) {
      history.replaceState(histState, '', resolved.path);
    } else {
      history.pushState(histState, '', resolved.path);
    }
  }

  routerState.currentPath = resolved.path;
  if (resolved.params && resolved.params.code) {
    routerState.partyCode = resolved.params.code;
  }

  return resolved;
}

/**
 * Boot the router: wire up popstate and resolve the current URL.
 *
 * @param {Function} onNavigate   - Called with (viewId, params) on every route change
 * @param {Function} getAuthState - Returns { isAuthenticated: boolean }
 * @returns {{ path: string, view: string, params: Object }}  Initial resolved route
 */
function initRouter(onNavigate, getAuthState) {
  window.addEventListener('popstate', function (e) {
    var st = e.state;
    var path = (st && st.path) ? st.path : window.location.pathname;
    var auth = getAuthState();
    var resolved = resolvePath(path, auth.isAuthenticated);
    routerState.currentPath = resolved.path;
    if (resolved.params && resolved.params.code) {
      routerState.partyCode = resolved.params.code;
    }
    onNavigate(resolved.view, resolved.params || {});
  });

  // Resolve the current URL on first load
  var initialPath = window.location.pathname;
  var auth = getAuthState();
  var resolved = resolvePath(initialPath, auth.isAuthenticated);

  // Stamp the history entry so popstate carries the route state
  if (typeof history !== 'undefined') {
    history.replaceState(
      { path: resolved.path, params: resolved.params || {} },
      '',
      resolved.path
    );
  }

  routerState.currentPath = resolved.path;
  return resolved;
}

// ---------------------------------------------------------------------------
// CommonJS export (Jest / Node)
// ---------------------------------------------------------------------------
/* istanbul ignore next */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ROUTES: ROUTES,
    VIEWS: VIEWS,
    HASH_TO_VIEW: HASH_TO_VIEW,
    routerState: routerState,
    matchRoute: matchRoute,
    checkGuard: checkGuard,
    resolvePath: resolvePath,
    navigate: navigate,
    initRouter: initRouter
  };
}
