/**
 * App State Machine
 *
 * Single source-of-truth for which "view" is visible and what the
 * header/nav should show.  Any part of the app that needs to change
 * the visible screen should call  transitionTo(STATES.xxx)  rather
 * than toggling DOM classes directly.
 *
 * States
 * ──────
 *  LOGGED_OUT             – unauthenticated; landing page, nav hidden
 *  PROFILE_INCOMPLETE     – authenticated but DJ name not yet set
 *  PARTY_HUB              – authenticated + profile complete; create/join hub
 *  IN_PARTY               – inside an active party session (host)
 *  IN_PARTY_GUEST         – inside an active party session (guest)
 */

'use strict';

// ── State constants ──────────────────────────────────────────────────────────

const STATES = Object.freeze({
  LOGGED_OUT:         'LOGGED_OUT',
  PROFILE_INCOMPLETE: 'PROFILE_INCOMPLETE',
  PARTY_HUB:          'PARTY_HUB',
  IN_PARTY:           'IN_PARTY',
  IN_PARTY_GUEST:     'IN_PARTY_GUEST'
});

// Views shown for each state (first entry is the primary view to reveal)
const STATE_VIEWS = {
  [STATES.LOGGED_OUT]:         ['viewLanding'],
  [STATES.PROFILE_INCOMPLETE]: ['viewCompleteProfile'],
  [STATES.PARTY_HUB]:          ['viewAuthHome'],
  [STATES.IN_PARTY]:           ['viewParty'],
  [STATES.IN_PARTY_GUEST]:     ['viewGuest']
};

// All managed view IDs (mirrors ALL_VIEWS in app.js for the views we gate)
const GATED_VIEWS = [
  'viewLanding',
  'viewCompleteProfile',
  'viewAuthHome',
  'viewParty',
  'viewGuest',
  'viewHome',
  'viewChooseTier',
  'viewAccountCreation',
  'viewPayment',
  'viewLogin',
  'viewSignup',
  'viewPasswordReset',
  'viewProfile',
  'viewUpgradeHub',
  'viewVisualPackStore',
  'viewProfileUpgrades',
  'viewPartyExtensions',
  'viewDjTitleStore',
  'viewLeaderboard',
  'viewMyProfile'
];

// ── Internal helpers ─────────────────────────────────────────────────────────

function _getElementById(id) {
  /* Allow tests to inject a document stub via module.document */
  const doc = (typeof module !== 'undefined' && module.document) ||
              (typeof document !== 'undefined' ? document : null);
  return doc ? doc.getElementById(id) : null;
}

function _setNavVisible(visible) {
  const nav = _getElementById('headerAuthButtons');
  if (!nav) return;
  nav.style.display = visible ? '' : 'none';
}

// ── Current state tracking ───────────────────────────────────────────────────

let _currentState = null;

/**
 * Render the UI for the given state:
 *  • hide all gated views
 *  • show the view(s) associated with the new state
 *  • show/hide the header nav based on authentication
 *
 * @param {string} newState - One of the STATES values
 */
function render(newState) {
  if (!Object.values(STATES).includes(newState)) {
    console.warn('[StateMachine] Unknown state:', newState);
    return;
  }

  // Hide all gated views
  GATED_VIEWS.forEach(id => {
    const el = _getElementById(id);
    if (el) el.classList.add('hidden');
  });

  // Show views for this state
  const views = STATE_VIEWS[newState] || [];
  views.forEach(id => {
    const el = _getElementById(id);
    if (el) el.classList.remove('hidden');
  });

  // Nav visibility: hidden on landing, visible when authenticated
  _setNavVisible(newState !== STATES.LOGGED_OUT);

  _currentState = newState;
  console.log('[StateMachine] →', newState);
}

/**
 * Transition to a new state (calls render internally).
 *
 * @param {string} newState - One of the STATES values
 */
function transitionTo(newState) {
  render(newState);
}

/**
 * Return the current state string (or null before first transition).
 * @returns {string|null}
 */
function currentState() {
  return _currentState;
}

/** Alias for currentState() — backward compatibility. */
function getState() {
  return _currentState;
}

// ── Exports (CommonJS for tests; also available as globals in browser) ───────

// APP_STATE is a backward-compat alias for STATES (same keys and values)
const APP_STATE = STATES;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { STATES, APP_STATE, transitionTo, render, currentState, getState, GATED_VIEWS };
}

/* Expose on window for use by app.js in the browser */
if (typeof window !== 'undefined') {
  window.AppStateMachine = { STATES, APP_STATE, transitionTo, render, currentState, getState };
}
