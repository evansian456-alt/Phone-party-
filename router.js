/**
 * Lightweight SPA Router — History API
 *
 * Responsibilities
 *  - Map URL paths to view IDs
 *  - navigate(path, opts) — pushState / replaceState + render
 *  - popstate handler so browser back/forward works
 *  - Route guards: unauthenticated → /, authenticated on / → /home
 *  - Initial load renders the correct screen (no flicker)
 *
 * Depends on globals from app.js / auth.js that are loaded first:
 *   isLoggedIn(), showLanding(), showView(), showParty(),
 *   initPartyHomeView(), state, ALL_VIEWS
 */

// ---------------------------------------------------------------------------
// Route map  (path → view id that owns the screen)
// ---------------------------------------------------------------------------
const ROUTE_MAP = {
  '/':              'viewLanding',
  '/login':         'viewLogin',
  '/signup':        'viewSignup',
  '/home':          'viewAuthHome',   // authenticated Create-or-Join hub
  '/party/create':  'viewAuthHome',   // create form shown inside the hub
  '/party/join':    'viewAuthHome',   // join  form shown inside the hub
  '/account':       'viewProfile',
};

// Prefix for routes that carry a dynamic segment: /party/:code
const PARTY_ROUTE_PREFIX = '/party/';

// Paths that require the user to be logged in
const PROTECTED_PATHS = ['/home', '/party/create', '/party/join', '/account'];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a path is protected (needs login).
 * /party/:code paths are also protected.
 * @param {string} path
 * @returns {boolean}
 */
function _isProtected(path) {
  if (PROTECTED_PATHS.includes(path)) return true;
  if (path.startsWith(PARTY_ROUTE_PREFIX) && path.length > PARTY_ROUTE_PREFIX.length) return true;
  return false;
}

/**
 * Extract a party code from a /party/:code path.
 * Returns null when the path doesn't match that pattern.
 * @param {string} path
 * @returns {string|null}
 */
function _partyCodeFromPath(path) {
  if (!path.startsWith(PARTY_ROUTE_PREFIX)) return null;
  const code = path.slice(PARTY_ROUTE_PREFIX.length);
  // Codes are 6 alphanumeric chars; normalise to upper-case
  if (/^[a-z0-9]{6}$/i.test(code)) return code.toUpperCase();
  return null;
}

// ---------------------------------------------------------------------------
// navigate  — push or replace history entry then render
// ---------------------------------------------------------------------------
/**
 * Navigate to a path.
 * @param {string} path   URL pathname, e.g. '/home'
 * @param {{ replace?: boolean }} [opts]
 */
function navigate(path, opts) {
  const replace = opts && opts.replace;
  if (replace) {
    history.replaceState({ path }, '', path);
  } else {
    history.pushState({ path }, '', path);
  }
  _renderRoute(path);
}

// ---------------------------------------------------------------------------
// _renderRoute  — show the right screen for a given path
// ---------------------------------------------------------------------------
/**
 * @param {string} path
 */
function _renderRoute(path) {
  var loggedIn = (typeof isLoggedIn === 'function') ? isLoggedIn() : false;

  // --- Route guards ---
  if (_isProtected(path) && !loggedIn) {
    // Redirect to landing without creating a history entry
    history.replaceState({ path: '/' }, '', '/');
    _showScreen('viewLanding');
    return;
  }

  if ((path === '/' || path === '/login' || path === '/signup') && loggedIn) {
    // Already authenticated — skip landing/auth screens
    history.replaceState({ path: '/home' }, '', '/home');
    _showScreen('viewAuthHome');
    if (typeof initPartyHomeView === 'function') initPartyHomeView();
    return;
  }

  // --- Party route with dynamic code ---
  var partyCode = _partyCodeFromPath(path);
  if (partyCode) {
    if (typeof state !== 'undefined') state.code = partyCode;
    if (typeof showParty === 'function') showParty();
    return;
  }

  // --- Static route ---
  var viewId = ROUTE_MAP[path];
  if (viewId) {
    _showScreen(viewId);
    if (viewId === 'viewAuthHome' && typeof initPartyHomeView === 'function') {
      initPartyHomeView();
    }
    return;
  }

  // --- Fallback ---
  if (loggedIn) {
    history.replaceState({ path: '/home' }, '', '/home');
    _showScreen('viewAuthHome');
    if (typeof initPartyHomeView === 'function') initPartyHomeView();
  } else {
    history.replaceState({ path: '/' }, '', '/');
    _showScreen('viewLanding');
  }
}

/**
 * Show a view by its DOM id, hiding all others.
 * Falls back to showView() from app.js if available.
 * @param {string} viewId
 */
function _showScreen(viewId) {
  if (typeof showView === 'function') {
    showView(viewId);
  } else if (typeof ALL_VIEWS !== 'undefined') {
    ALL_VIEWS.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    var target = document.getElementById(viewId);
    if (target) target.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// Boot — handle initial page load
// ---------------------------------------------------------------------------
/**
 * Called once on DOMContentLoaded (or immediately if DOM is already ready).
 * Reads the current URL and renders the appropriate screen without flicker.
 */
function _bootRouter() {
  window.addEventListener('popstate', function(e) {
    _renderRoute(window.location.pathname);
  });

  // Replace current history entry so it carries our state shape
  var currentPath = window.location.pathname || '/';
  history.replaceState({ path: currentPath }, '', currentPath);

  // The main app init (initAuthFlow) already checks auth and calls show*()
  // on first load. We skip re-rendering here to avoid a double flash.
  // Instead, we hook into the existing initAuthFlow result by patching
  // navigate calls used after login / logout (see app.js integration).
}

// Run boot when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bootRouter);
  } else {
    _bootRouter();
  }
}

// ---------------------------------------------------------------------------
// Export for testing (Node / Jest environment)
// ---------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    navigate,
    _renderRoute,
    _isProtected,
    _partyCodeFromPath,
    ROUTE_MAP,
  };
}
