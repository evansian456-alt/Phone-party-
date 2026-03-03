/**
 * App State Machine — Phone Party SPA
 *
 * Single source of truth for which view is visible and whether the auth-gated
 * navigation icons should be shown.  All view-switching code should call
 * `transitionTo(APP_STATE.*)` instead of touching the DOM directly.
 *
 * States
 * ──────
 *   LOGGED_OUT                       Landing page, nav hidden.
 *   AUTHENTICATED_PROFILE_INCOMPLETE  "Complete your profile" view, nav visible.
 *   AUTHENTICATED_PROFILE_COMPLETE    Party hub (create/join), nav visible.
 *   IN_PARTY                          In-party view (host or guest), nav visible.
 */

'use strict';

/** Enumeration of all valid application states. */
var APP_STATE = {
  LOGGED_OUT: 'LOGGED_OUT',
  AUTHENTICATED_PROFILE_INCOMPLETE: 'AUTHENTICATED_PROFILE_INCOMPLETE',
  AUTHENTICATED_PROFILE_COMPLETE: 'AUTHENTICATED_PROFILE_COMPLETE',
  IN_PARTY: 'IN_PARTY'
};

/** Which view element to reveal for each state. */
var STATE_VIEW_MAP = {};
STATE_VIEW_MAP[APP_STATE.LOGGED_OUT]                       = 'viewLanding';
STATE_VIEW_MAP[APP_STATE.AUTHENTICATED_PROFILE_INCOMPLETE] = 'viewCompleteProfile';
STATE_VIEW_MAP[APP_STATE.AUTHENTICATED_PROFILE_COMPLETE]   = 'viewParty';
STATE_VIEW_MAP[APP_STATE.IN_PARTY]                         = 'viewParty';

/** States that require the auth-gated navigation bar to be visible. */
var AUTH_NAV_STATES = [
  APP_STATE.AUTHENTICATED_PROFILE_INCOMPLETE,
  APP_STATE.AUTHENTICATED_PROFILE_COMPLETE,
  APP_STATE.IN_PARTY
];

/**
 * All view section IDs managed by this state machine.
 * Kept in sync with ALL_VIEWS in app.js.
 */
var SM_ALL_VIEWS = [
  'viewLanding', 'viewChooseTier', 'viewAccountCreation', 'viewHome',
  'viewParty', 'viewPayment', 'viewGuest', 'viewLogin', 'viewSignup',
  'viewPasswordReset', 'viewProfile', 'viewUpgradeHub', 'viewVisualPackStore',
  'viewProfileUpgrades', 'viewPartyExtensions', 'viewDjTitleStore',
  'viewLeaderboard', 'viewMyProfile', 'viewCompleteProfile'
];

var _currentState = APP_STATE.LOGGED_OUT;

/**
 * Return the current application state string.
 * @returns {string}
 */
function getState() {
  return _currentState;
}

/**
 * Render the UI for the given state.
 * Hides all managed views then reveals the correct one; also toggles the
 * auth-gated header navigation.
 *
 * Safe to call when `document` is unavailable (server-side / test no-op guard).
 *
 * @param {string} newState - One of APP_STATE values.
 */
function render(newState) {
  if (typeof document === 'undefined') return;

  // Hide all managed views
  SM_ALL_VIEWS.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  // Reveal the target view
  var viewId = STATE_VIEW_MAP[newState] || 'viewLanding';
  var target = document.getElementById(viewId);
  if (target) target.classList.remove('hidden');

  // Show auth-gated nav only when the user is authenticated
  var nav = document.getElementById('headerAuthButtons');
  if (nav) {
    nav.style.display = AUTH_NAV_STATES.indexOf(newState) !== -1 ? '' : 'none';
  }
}

/**
 * Transition to a new state and apply the corresponding UI changes.
 *
 * @param {string} newState - One of APP_STATE values.
 */
function transitionTo(newState) {
  if (!(newState in APP_STATE)) {
    console.warn('[StateMachine] Unknown state:', newState);
    return;
  }
  _currentState = newState;
  render(newState);
}

// Expose globally in browser so app.js can reference window.AppStateMachine.
if (typeof window !== 'undefined') {
  window.AppStateMachine = { APP_STATE: APP_STATE, transitionTo: transitionTo, getState: getState, render: render };
}

// CommonJS export for Jest; harmless in browser (module is undefined there).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { APP_STATE: APP_STATE, transitionTo: transitionTo, getState: getState, render: render, SM_ALL_VIEWS: SM_ALL_VIEWS };
}
