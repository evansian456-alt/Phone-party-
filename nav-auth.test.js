/**
 * @jest-environment jsdom
 *
 * Frontend state machine tests — nav-auth.test.js
 *
 * Verifies the three core auth-state transitions that drive view visibility
 * and header navigation gating.
 */

'use strict';

const { APP_STATE, transitionTo, getState, render } = require('./ui/stateMachine');

/** Build the minimal DOM that the state machine needs to operate on. */
function createDOM() {
  document.body.innerHTML = `
    <div id="headerAuthButtons" style="display:none"></div>
    <section id="viewLanding"></section>
    <section id="viewCompleteProfile" class="hidden"></section>
    <section id="viewParty"           class="hidden"></section>
    <section id="viewGuest"           class="hidden"></section>
  `;
}

describe('App State Machine', () => {
  beforeEach(createDOM);

  test('LOGGED_OUT: landing is visible and nav is hidden', () => {
    transitionTo(APP_STATE.LOGGED_OUT);

    expect(getState()).toBe(APP_STATE.LOGGED_OUT);
    expect(document.getElementById('viewLanding').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('headerAuthButtons').style.display).toBe('none');
  });

  test('AUTHENTICATED_PROFILE_INCOMPLETE: complete-profile is visible and nav is shown', () => {
    transitionTo(APP_STATE.AUTHENTICATED_PROFILE_INCOMPLETE);

    expect(getState()).toBe(APP_STATE.AUTHENTICATED_PROFILE_INCOMPLETE);
    expect(document.getElementById('viewCompleteProfile').classList.contains('hidden')).toBe(false);
    // Landing should be hidden once authenticated
    expect(document.getElementById('viewLanding').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('headerAuthButtons').style.display).not.toBe('none');
  });

  test('AUTHENTICATED_PROFILE_COMPLETE: party hub is visible and nav is shown', () => {
    transitionTo(APP_STATE.AUTHENTICATED_PROFILE_COMPLETE);

    expect(getState()).toBe(APP_STATE.AUTHENTICATED_PROFILE_COMPLETE);
    expect(document.getElementById('viewParty').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('viewLanding').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('headerAuthButtons').style.display).not.toBe('none');
  });

  test('Transition back to LOGGED_OUT hides nav again', () => {
    transitionTo(APP_STATE.AUTHENTICATED_PROFILE_COMPLETE);
    transitionTo(APP_STATE.LOGGED_OUT);

    expect(getState()).toBe(APP_STATE.LOGGED_OUT);
    expect(document.getElementById('headerAuthButtons').style.display).toBe('none');
    expect(document.getElementById('viewLanding').classList.contains('hidden')).toBe(false);
  });

  test('Unknown state is ignored and does not crash', () => {
    const before = getState();
    transitionTo('NOT_A_REAL_STATE');
    expect(getState()).toBe(before); // state unchanged
  });
});
