/**
 * Authentication and User Management System (Client-side)
 * Handles user accounts, login, signup via backend API calls
 * Auth tokens are stored in HTTP-only cookies by the backend
 */

const CURRENT_USER_KEY = 'syncspeaker_current_user';
let _authSessionState = 'unknown';

function setAuthSessionState(nextState) {
  _authSessionState = nextState;
}

function getAuthSessionState() {
  return _authSessionState;
}

// Minimum milliseconds between consecutive auth API calls from the same client session.
// This is a last-resort guard; the primary protection is the inFlight flags in app.js.
const AUTH_MIN_INTERVAL_MS = 1000;
// Tracks the timestamp of the last auth call to enforce AUTH_MIN_INTERVAL_MS.
let _lastAuthCallAt = 0;

/**
 * Centralized auth error message mapper.
 * Returns a user-friendly string for a given server error / HTTP status.
 *
 * @param {string|undefined} serverError
 * @param {number|undefined} status
 * @returns {string}
 */
function mapAuthError(serverError, status) {
  if (status === 429 || (serverError && serverError.toLowerCase().includes('too many'))) {
    return 'Too many attempts. Please wait a minute before trying again.';
  }
  if (status === 401) {
    return 'Incorrect email or password. Please try again.';
  }
  if (status === 409) {
    return 'An account with that email already exists.';
  }
  if (serverError && serverError.toLowerCase().includes('invalid email')) {
    return 'Please enter a valid email address.';
  }
  if (serverError && serverError.toLowerCase().includes('password')) {
    return 'Password must be at least 6 characters.';
  }
  if (serverError && serverError.toLowerCase().includes('network')) {
    return 'Network error. Please check your connection and try again.';
  }
  return serverError || 'Something went wrong. Please try again.';
}

// User tier constants
const TIER = {
  FREE: 'FREE',
  PARTY_PASS: 'PARTY_PASS',
  PRO: 'PRO'
};

/**
 * Initialize authentication system
 */
async function initAuth() {
  console.log('[Auth] Auth system initializing');

  // Check if user is logged in by calling /api/me
  try {
    const user = await getCurrentUser();
    if (user) {
      console.log('[Auth] User is logged in:', user.user.email);
      // Cache user data in localStorage for quick access
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
      setAuthSessionState('authenticated');
    } else {
      console.log('[Auth] No user logged in');
      localStorage.removeItem(CURRENT_USER_KEY);
      setAuthSessionState('unauthenticated');
    }
  } catch (err) {
    console.log('[Auth] No active session');
    localStorage.removeItem(CURRENT_USER_KEY);
    setAuthSessionState('unauthenticated');
  }
}

/**
 * Sign up new user
 */
async function signUp(email, password, djName = '', termsAccepted = false) {
  if (!isValidEmail(email)) {
    return { success: false, error: 'Invalid email address' };
  }

  if (!isValidPassword(password)) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }

  if (!djName || djName.trim().length === 0) {
    return { success: false, error: 'DJ name is required' };
  }

  if (!termsAccepted) {
    return { success: false, error: 'You must accept the Terms & Conditions and Privacy Policy' };
  }

  // Enforce minimum interval between auth API calls to prevent rapid-fire requests.
  const now = Date.now();
  if (now - _lastAuthCallAt < AUTH_MIN_INTERVAL_MS) {
    return { success: false, error: 'Please wait a moment before trying again.' };
  }
  _lastAuthCallAt = now;

  try {
    const response = await fetch(API_BASE + '/api/auth/signup', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        password,
        djName: djName.trim(),
        termsAccepted
      })
    });

    let data;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      if (!response.ok) {
        return { success: false, error: `Server returned non-JSON error (status ${response.status}): ${text.slice(0, 200)}` };
      }
      data = {};
    }

    if (!response.ok) {
      return { success: false, error: data.error || 'Signup failed', status: response.status };
    }

    // Bootstrap a minimal session cache from the signup response so that
    // isLoggedIn() returns true immediately without an extra /api/me round-trip.
    // initAuthFlow() will replace this with the full /api/me payload shortly after.
    if (data.user) {
      const minimalSession = {
        user: {
          id: data.user.id,
          email: data.user.email,
          djName: data.user.djName,
          profileCompleted: !!data.user.profileCompleted,
          createdAt: data.user.createdAt
        },
        tier: 'FREE',
        effectiveTier: 'FREE',
        isAdmin: false
      };
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(minimalSession));
      setAuthSessionState('authenticated');
    }

    return { success: true, user: sanitizeUser(data.user) };
  } catch (error) {
    console.error('[Auth] Signup error:', error);
    return { success: false, error: 'Network error. Please try again.' };
  }
}

/**
 * Log in user
 */
async function logIn(email, password) {
  if (!isValidEmail(email)) {
    return { success: false, error: 'Invalid email address' };
  }

  // Enforce minimum interval between auth API calls to prevent rapid-fire requests.
  const now = Date.now();
  if (now - _lastAuthCallAt < AUTH_MIN_INTERVAL_MS) {
    return { success: false, error: 'Please wait a moment before trying again.' };
  }
  _lastAuthCallAt = now;

  try {
    const response = await fetch(API_BASE + '/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        password
      })
    });

    let data;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      if (!response.ok) {
        return { success: false, error: `Server returned non-JSON error (status ${response.status}): ${text.slice(0, 200)}` };
      }
      data = {};
    }

    if (!response.ok) {
      return { success: false, error: data.error || 'Login failed' };
    }

    // Fetch full user data
    const userData = await getCurrentUser();
    if (userData) {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(userData));
      setAuthSessionState('authenticated');
    }

    return { success: true, user: sanitizeUser(data.user) };
  } catch (error) {
    console.error('[Auth] Login error:', error);
    return { success: false, error: 'Network error. Please try again.' };
  }
}

/**
 * Log out current user
 */
async function logOut() {
  try {
    await fetch(API_BASE + '/api/auth/logout', {
      method: 'POST',
      credentials: 'include'
    });

    localStorage.removeItem(CURRENT_USER_KEY);
    setAuthSessionState('unauthenticated');
    return { success: true };
  } catch (error) {
    console.error('[Auth] Logout error:', error);
    // Still clear local cache even if request fails
    localStorage.removeItem(CURRENT_USER_KEY);
    setAuthSessionState('unauthenticated');
    return { success: false, error: 'Logout failed' };
  }
}

/**
 * Get current logged in user with full profile data
 */
async function getCurrentUser() {
  try {
    const response = await fetch(API_BASE + '/api/me', { credentials: 'include' });

    if (!response.ok) {
      if (response.status === 401) {
        // Not authenticated
        setAuthSessionState('unauthenticated');
        return null;
      }
      throw new Error('Failed to get user');
    }

    const data = await response.json();
    setAuthSessionState('authenticated');
    return data;
  } catch (error) {
    console.error('[Auth] Get user error:', error);
    if (_authSessionState !== 'authenticated') {
      setAuthSessionState('unauthenticated');
    }
    return null;
  }
}

/**
 * Get cached user data (fast, but may be stale)
 */
function getCachedUser() {
  try {
    const data = localStorage.getItem(CURRENT_USER_KEY);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    console.error('[Auth] Error reading cached user:', e);
    return null;
  }
}

/**
 * Check if user is logged in (uses cache)
 */
function isLoggedIn() {
  return _authSessionState === 'authenticated';
}

/**
 * Update user profile (DJ name)
 */
async function updateUserProfile(updates) {
  try {
    const response = await fetch(API_BASE + '/api/profile/update', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ djName: updates.djName })
    });

    let data;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = {};
    }

    if (!response.ok) {
      return { success: false, error: data.error || 'Failed to update profile' };
    }

    // Update cached user data with the new DJ name without an extra round-trip
    try {
      const cached = localStorage.getItem(CURRENT_USER_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.user) parsed.user.djName = data.djName;
        localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(parsed));
      }
    } catch (_) { /* non-fatal */ }

    return { success: true, djName: data.djName };
  } catch (error) {
    console.error('[Auth] Update profile error:', error);
    return { success: false, error: 'Network error. Please try again.' };
  }
}

/**
 * Update user tier (not implemented - handled via purchase system)
 */
async function updateUserTier(tier, purchaseInfo = {}) {
  console.warn('[Auth] updateUserTier not needed - handled by purchase system');
  return { success: false, error: 'Use purchase system instead' };
}

/**
 * Update DJ stats (not implemented yet - kept for compatibility)
 */
async function updateDJStats(updates) {
  console.warn('[Auth] updateDJStats not yet implemented');
  return { success: false, error: 'Not implemented' };
}

/**
 * Update party stats (not implemented yet - kept for compatibility)
 */
async function updatePartyStats(partyInfo) {
  console.warn('[Auth] updatePartyStats not yet implemented');
  return { success: false, error: 'Not implemented' };
}

/**
 * Request password reset (not implemented yet - kept for compatibility)
 */
async function requestPasswordReset(email) {
  console.warn('[Auth] requestPasswordReset not yet implemented');
  return { success: false, error: 'Not implemented' };
}

/**
 * Reset password with code (not implemented yet - kept for compatibility)
 */
async function resetPassword(email, resetCode, newPassword) {
  console.warn('[Auth] resetPassword not yet implemented');
  return { success: false, error: 'Not implemented' };
}

/**
 * Remove sensitive data from user object
 */
function sanitizeUser(user) {
  const clean = { ...user };
  delete clean.passwordHash;
  delete clean.resetCode;
  delete clean.resetCodeExpiry;
  return clean;
}

// Export functions (for use in other scripts)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TIER,
    signUp,
    logIn,
    logOut,
    getCurrentUser,
    getCachedUser,
    isLoggedIn,
    getAuthSessionState,
    setAuthSessionState,
    updateUserProfile,
    updateUserTier,
    updateDJStats,
    updatePartyStats,
    requestPasswordReset,
    resetPassword,
    mapAuthError
  };
}
