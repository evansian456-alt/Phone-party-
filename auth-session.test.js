/**
 * @jest-environment node
 */

'use strict';

describe('client auth session state', () => {
  let auth;
  let store;

  beforeEach(() => {
    jest.resetModules();
    store = {};
    global.localStorage = {
      getItem: jest.fn((key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null)),
      setItem: jest.fn((key, value) => { store[key] = String(value); }),
      removeItem: jest.fn((key) => { delete store[key]; })
    };
    global.API_BASE = '';
    global.isValidEmail = jest.fn(() => true);
    global.isValidPassword = jest.fn(() => true);
    global.fetch = jest.fn();
    auth = require('./auth.js');
  });

  afterEach(() => {
    delete global.localStorage;
    delete global.API_BASE;
    delete global.isValidEmail;
    delete global.isValidPassword;
    delete global.fetch;
  });

  test('does not treat cached localStorage alone as an authenticated session', () => {
    localStorage.setItem('syncspeaker_current_user', JSON.stringify({ user: { email: 'stale@example.com' } }));
    auth.setAuthSessionState('unauthenticated');

    expect(auth.getCachedUser()).toEqual({ user: { email: 'stale@example.com' } });
    expect(auth.isLoggedIn()).toBe(false);
  });

  test('marks the session unauthenticated when /api/me returns 401', async () => {
    fetch.mockResolvedValue({ ok: false, status: 401 });
    auth.setAuthSessionState('authenticated');

    const result = await auth.getCurrentUser();

    expect(result).toBeNull();
    expect(auth.getAuthSessionState()).toBe('unauthenticated');
  });

  test('marks the session authenticated when /api/me succeeds', async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user: { email: 'real@example.com' } })
    });

    const result = await auth.getCurrentUser();

    expect(result).toEqual({ user: { email: 'real@example.com' } });
    expect(auth.getAuthSessionState()).toBe('authenticated');
    expect(auth.isLoggedIn()).toBe(true);
  });
});
