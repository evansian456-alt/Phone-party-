/**
 * @jest-environment jsdom
 *
 * Tests for the view state machine (ui/stateMachine.js).
 * Verifies that the correct views are shown/hidden and the header nav
 * is toggled correctly for each application state.
 */

'use strict';

// Provide a fresh jsdom environment for each test via the @jest-environment
// annotation above.  We also reset module state between tests so that the
// _currentState internal variable starts clean.

let sm; // stateMachine module reference

// Helper – build a minimal DOM with all view elements + the nav element
function buildDOM() {
  document.body.innerHTML = `
    <div id="headerAuthButtons" style="display:none"></div>
    <section id="viewLanding"></section>
    <section id="viewCompleteProfile" class="hidden"></section>
    <section id="viewAuthHome" class="hidden"></section>
    <section id="viewParty" class="hidden"></section>
    <section id="viewGuest" class="hidden"></section>
    <section id="viewHome" class="hidden"></section>
    <section id="viewLogin" class="hidden"></section>
    <section id="viewSignup" class="hidden"></section>
  `;
}

beforeEach(() => {
  // Re-require the module so _currentState is reset between tests
  jest.resetModules();

  buildDOM();

  // Load the module – it runs in Node (no real browser), so we patch
  // module._document to point at the jsdom document.
  sm = require('./stateMachine.js');
  // Patch the document lookup used inside the module (reads module.document)
  const mod = require.cache[require.resolve('./stateMachine.js')];
  if (mod) mod.document = document;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isHidden(id) {
  const el = document.getElementById(id);
  return el ? el.classList.contains('hidden') : true;
}

function isNavVisible() {
  const nav = document.getElementById('headerAuthButtons');
  return nav ? nav.style.display !== 'none' : false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('StateMachine – LOGGED_OUT', () => {
  beforeEach(() => sm.transitionTo(sm.STATES.LOGGED_OUT));

  test('shows viewLanding', () => {
    expect(isHidden('viewLanding')).toBe(false);
  });

  test('hides viewCompleteProfile', () => {
    expect(isHidden('viewCompleteProfile')).toBe(true);
  });

  test('hides viewParty', () => {
    expect(isHidden('viewParty')).toBe(true);
  });

  test('hides header nav buttons', () => {
    expect(isNavVisible()).toBe(false);
  });

  test('currentState() returns LOGGED_OUT', () => {
    expect(sm.currentState()).toBe(sm.STATES.LOGGED_OUT);
  });
});

describe('StateMachine – PROFILE_INCOMPLETE', () => {
  beforeEach(() => sm.transitionTo(sm.STATES.PROFILE_INCOMPLETE));

  test('shows viewCompleteProfile', () => {
    expect(isHidden('viewCompleteProfile')).toBe(false);
  });

  test('hides viewLanding', () => {
    expect(isHidden('viewLanding')).toBe(true);
  });

  test('shows header nav buttons', () => {
    expect(isNavVisible()).toBe(true);
  });

  test('currentState() returns PROFILE_INCOMPLETE', () => {
    expect(sm.currentState()).toBe(sm.STATES.PROFILE_INCOMPLETE);
  });
});

describe('StateMachine – PARTY_HUB', () => {
  beforeEach(() => sm.transitionTo(sm.STATES.PARTY_HUB));

  test('shows viewAuthHome (create/join hub)', () => {
    expect(isHidden('viewAuthHome')).toBe(false);
  });

  test('hides viewParty while on hub', () => {
    expect(isHidden('viewParty')).toBe(true);
  });

  test('hides viewLanding', () => {
    expect(isHidden('viewLanding')).toBe(true);
  });

  test('shows header nav buttons', () => {
    expect(isNavVisible()).toBe(true);
  });

  test('currentState() returns PARTY_HUB', () => {
    expect(sm.currentState()).toBe(sm.STATES.PARTY_HUB);
  });
});

describe('StateMachine – IN_PARTY', () => {
  beforeEach(() => sm.transitionTo(sm.STATES.IN_PARTY));

  test('shows viewParty', () => {
    expect(isHidden('viewParty')).toBe(false);
  });

  test('shows header nav buttons', () => {
    expect(isNavVisible()).toBe(true);
  });

  test('hides viewLanding', () => {
    expect(isHidden('viewLanding')).toBe(true);
  });
});

describe('StateMachine – state transitions', () => {
  test('login flow: LOGGED_OUT → PROFILE_INCOMPLETE → PARTY_HUB', () => {
    sm.transitionTo(sm.STATES.LOGGED_OUT);
    expect(isHidden('viewLanding')).toBe(false);
    expect(isNavVisible()).toBe(false);

    sm.transitionTo(sm.STATES.PROFILE_INCOMPLETE);
    expect(isHidden('viewCompleteProfile')).toBe(false);
    expect(isNavVisible()).toBe(true);

    sm.transitionTo(sm.STATES.PARTY_HUB);
    expect(isHidden('viewAuthHome')).toBe(false);
    expect(isHidden('viewCompleteProfile')).toBe(true);
    expect(isNavVisible()).toBe(true);
  });

  test('logout: PARTY_HUB → LOGGED_OUT hides nav and shows landing', () => {
    sm.transitionTo(sm.STATES.PARTY_HUB);
    sm.transitionTo(sm.STATES.LOGGED_OUT);
    expect(isNavVisible()).toBe(false);
    expect(isHidden('viewLanding')).toBe(false);
    expect(isHidden('viewAuthHome')).toBe(true);
  });

  test('unknown state emits warning and does not crash', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    sm.transitionTo('NOT_A_REAL_STATE');
    expect(warn).toHaveBeenCalledWith(
      '[StateMachine] Unknown state:',
      'NOT_A_REAL_STATE'
    );
    warn.mockRestore();
  });
});
