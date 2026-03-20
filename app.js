const FREE_LIMIT = 2;
const PARTY_PASS_LIMIT = 4;
const PRO_LIMIT = 10;
const PARTY_CODE_LENGTH = 6; // Length of party code
// PHASE 6: Increased timeout for create-party (20s) and other API calls
const API_TIMEOUT_MS = 20000; // 20 second timeout for API calls
const PARTY_LOOKUP_RETRIES = 5; // Number of retries for party lookup (updated for Railway multi-instance)
const PARTY_LOOKUP_RETRY_DELAY_MS = 1000; // Initial delay between retries in milliseconds (exponential backoff)
const CREATE_PARTY_RETRY_DELAY_MS = 800; // Delay before retrying create-party request (ms)
const MAX_CREATE_PARTY_ATTEMPTS = 2; // Maximum attempts for create-party (1 initial + 1 retry)
const PARTY_STATUS_POLL_INTERVAL_MS = 3000; // Poll party status every 3 seconds
const DRIFT_CORRECTION_THRESHOLD_SEC = 0.20; // Ignore drift below this threshold

// PHASE 2: Upload retry configuration
const UPLOAD_RETRY_DELAY_MS = 800; // Delay before retrying failed upload

// PHASE 7: Bluetooth latency calibration
const LATENCY_CLICK_AMPLITUDE = 0.3; // Generate white noise click at -10dB to avoid startling users
const LATENCY_CLICK_OFFSET = 0.15; // Center amplitude around zero
const DRIFT_SOFT_CORRECTION_THRESHOLD_SEC = 0.80; // Soft correction threshold
const DRIFT_HARD_RESYNC_THRESHOLD_SEC = 1.00; // Hard resync threshold
const DRIFT_SHOW_RESYNC_THRESHOLD_SEC = 1.50; // Show manual re-sync button above this
const DRIFT_CORRECTION_INTERVAL_MS = 2000; // Check drift every 2 seconds
const MESSAGE_TTL_MS = 12000; // Messages auto-disappear after 12 seconds (unified feed)
const AUDIO_UNLOCK_SUCCESS_DELAY_MS = 300; // Delay to show "Audio enabled" success message before playing

// Changer version – bump this whenever platform detection / URL transformation logic changes.
// Used to confirm the new changer build is running (visible in browser devtools console).
const CHANGER_VERSION = '2026-03-03-a';

// ── Auth inFlight guards ──────────────────────────────────────────────────
// Prevent duplicate auth requests when a user clicks the submit button
// multiple times (which would exhaust the server-side rate limit quickly).
let _loginInFlight = false;
let _signupInFlight = false;
// Sentinel so setupAuthEventListeners never attaches its listeners more than once.
let _authListenersAttached = false;
// Timestamp of the last rate-limit error; used for a client-side cooldown.
let _authRateLimitedUntil = 0;
console.log('[Changer] version:', CHANGER_VERSION);

// Sync quality indicator labels
const SYNC_QUALITY_EXCELLENT = "Excellent";
const SYNC_QUALITY_GOOD = "Good";
const SYNC_QUALITY_MEDIUM = "Medium";
const SYNC_QUALITY_POOR = "Poor";

// All views in the application
const ALL_VIEWS = ['viewLanding', 'viewChooseTier', 'viewAccountCreation', 'viewHome', 'viewAuthHome', 'viewParty', 'viewPayment', 'viewGuest', 
                   'viewLogin', 'viewSignup', 'viewPasswordReset', 'viewProfile', 'viewUpgradeHub', 'viewVisualPackStore',
                   'viewProfileUpgrades', 'viewPartyExtensions', 'viewDjTitleStore', 'viewLeaderboard', 'viewMyProfile',
                   'viewCompleteProfile', 'viewAdminDashboard', 'viewInviteFriends', 'viewTerms', 'viewPrivacy',
                   'viewYoutubeService'];

// ============================================================
// PROFILE SCHEMA (versioned localStorage helpers)
// ============================================================
const PROFILE_SCHEMA_VERSION = 1;
const PROFILE_STORAGE_KEY = 'syncSpeakerProfile_v' + PROFILE_SCHEMA_VERSION;

function getSavedProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !p.djName) return null;
    return p;
  } catch (e) {
    return null;
  }
}

function saveProfile(profile) {
  try {
    // Clear any older schema version keys (e.g. v0 → v1 when current is v1).
    // The loop is intentionally 0..PROFILE_SCHEMA_VERSION-1 so it cleans up all
    // previously deployed storage keys when the schema version is bumped.
    for (let v = 0; v < PROFILE_SCHEMA_VERSION; v++) {
      localStorage.removeItem('syncSpeakerProfile_v' + v);
    }
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ ...profile, schemaVersion: PROFILE_SCHEMA_VERSION }));
  } catch (e) {
    console.warn('[Profile] Could not save profile:', e);
  }
}

function clearProfile() {
  for (let v = 0; v <= PROFILE_SCHEMA_VERSION; v++) {
    try { localStorage.removeItem('syncSpeakerProfile_v' + v); } catch (e) {}
  }
  try { localStorage.removeItem('syncSpeakerPrototypeId'); } catch (e) {}
}

function hasValidProfile() {
  return getSavedProfile() !== null;
}

// ============================================================
// VIEW REGISTRY — single source of truth for all screens
// ============================================================
// Note: onEnter callbacks reference functions defined later in this file;
// they are only *called* at runtime, so forward references are safe.
/* eslint-disable no-use-before-define */
const VIEWS = {
  landing:       { id: 'viewLanding',         requiresAuth: false, hash: 'landing',     onEnter: () => showLanding() },
  chooseTier:    { id: 'viewChooseTier',       requiresAuth: false, hash: 'choose-tier', onEnter: () => showChooseTier() },
  auth:          { id: 'viewAccountCreation',  requiresAuth: false, hash: 'auth',        onEnter: () => showAccountCreation() },
  createJoin:    { id: 'viewHome',             requiresAuth: true,  hash: 'create-join', onEnter: () => showHome() },
  party:         { id: 'viewParty',            requiresAuth: true,  hash: 'party',       onEnter: () => showParty() },
  guest:         { id: 'viewGuest',            requiresAuth: true,  hash: 'guest',       onEnter: () => showGuest() },
  payment:       { id: 'viewPayment',          requiresAuth: false, hash: 'payment',     onEnter: () => showPayment() },
  login:         { id: 'viewLogin',            requiresAuth: false, hash: 'login' },
  signup:        { id: 'viewSignup',           requiresAuth: false, hash: 'signup' },
  passwordReset: { id: 'viewPasswordReset',    requiresAuth: false, hash: 'reset' },
  profile:       { id: 'viewProfile',          requiresAuth: true,  hash: 'profile' },
  upgradeHub:    { id: 'viewUpgradeHub',       requiresAuth: true,  hash: 'upgrade' },
  leaderboard:   { id: 'viewLeaderboard',      requiresAuth: false, hash: 'leaderboard' },
  myProfile:       { id: 'viewMyProfile',        requiresAuth: true,  hash: 'my-profile' },
  completeProfile: { id: 'viewCompleteProfile',  requiresAuth: true,  hash: 'complete-profile', onEnter: () => initCompleteProfileView() },
  authHome:        { id: 'viewAuthHome',          requiresAuth: true,  hash: 'home',             onEnter: () => initPartyHomeView() },
  adminDashboard:  { id: 'viewAdminDashboard',    requiresAuth: true,  requiresAdmin: true,  hash: 'admin',            onEnter: () => initAdminDashboard() },
  inviteFriends:   { id: 'viewInviteFriends',     requiresAuth: true,  hash: 'invite',           onEnter: () => { if (window._referralUI) { window._referralUI._buildInvitePage(); window._referralUI.startPolling(); } } },
  terms:           { id: 'viewTerms',              requiresAuth: false, hash: 'terms' },
  privacy:         { id: 'viewPrivacy',            requiresAuth: false, hash: 'privacy' },
  youtubeService:  { id: 'viewYoutubeService',     requiresAuth: true,  hash: 'youtube-service', onEnter: () => showYoutubeServiceView() },
};
/* eslint-enable no-use-before-define */

// Hash → viewName lookup (built from VIEWS registry)
const HASH_TO_VIEW = Object.fromEntries(
  Object.entries(VIEWS).map(([name, def]) => [def.hash, name])
);

// ============================================================
// SET VIEW — single navigation controller
// ============================================================
let _currentViewName = null;
let _currentUserIsAdmin = false; // set to true when /api/me confirms user.isAdmin

// Feature flags — loaded from /api/feature-flags at startup
let _featureFlags = {
  STREAMING_PARTY_ENABLED: true // Default ON — YouTube Party is a core feature
};

/**
 * Fetch feature flags from the server and store them in _featureFlags.
 * Safe to call without authentication (flags are public).
 * @returns {Promise<void>}
 */
async function fetchFeatureFlags() {
  try {
    const res = await fetch(API_BASE + '/api/feature-flags');
    if (res.ok) {
      const data = await res.json();
      _featureFlags = Object.assign(_featureFlags, data);
    }
  } catch (_e) {
    // Non-fatal — flags remain at conservative defaults
  }
}

/**
 * Navigate to a named view.
 * @param {string} viewName  - Key from VIEWS registry
 * @param {object} [opts]
 * @param {boolean} [opts.fromHash] - true when called from hashchange (avoids redundant pushState)
 */
function setView(viewName, opts = {}) {
  const view = VIEWS[viewName];
  if (!view) {
    console.error('[NAV] Unknown view:', viewName, '— valid views:', Object.keys(VIEWS));
    return;
  }

  // Auth gating: redirect unauthenticated users away from protected views.
  // Redirect to the landing page (not the sign-up form) so unauthenticated visitors
  // always see the marketing landing page first — consistent with the boot flow in
  // initAuthFlow() which also lands on 'landing' for logged-out users.
  // A valid local profile (hasValidProfile) also counts as authenticated so that
  // users who just logged in or signed up are never bounced back to the landing page
  // due to a transient /api/me delay before isLoggedIn() reflects server state.
  if (view.requiresAuth) {
    const authenticated = (typeof isLoggedIn === 'function' && isLoggedIn()) ||
                          (typeof hasValidProfile === 'function' && hasValidProfile());
    if (!authenticated) {
      console.log('[NAV] Auth required for', viewName, '→ redirecting to landing');
      // Update the URL to #landing before redirecting so the address bar reflects reality.
      // Use replaceState (not pushState) so back-button doesn't loop on the protected hash.
      const landingView = VIEWS['landing'];
      if (landingView && window.location) {
        try { history.replaceState(null, '', '#' + landingView.hash); } catch (e) { /* may throw in tests */ }
      }
      setView('landing', { fromHash: true });
      return;
    }
  }

  // Admin-role gating: only users with admin role may access admin-only views.
  // Note: this guard runs after requiresAuth, so unauthenticated users are already
  // redirected above and never reach this check. Server-side /api/admin/* endpoints
  // independently enforce admin status — this is a client-side UX guard only.
  if (view.requiresAdmin && !_currentUserIsAdmin) {
    console.log('[NAV] Admin role required for', viewName, '→ redirecting to authHome');
    const homeView = VIEWS['authHome'];
    if (homeView && window.location) {
      try { history.replaceState(null, '', '#' + homeView.hash); } catch (e) { /* may throw in tests */ }
    }
    setView('authHome', { fromHash: true });
    return;
  }

  const from = _currentViewName;
  _currentViewName = viewName;
  console.log('[NAV]', from, '->', viewName, { hash: '#' + view.hash });

  // Update location hash:
  // - pushState for normal navigation (new history entry)
  // - replaceState when redirected by auth flow (fromHash:true) so the address
  //   bar reflects the current view without adding a redundant history entry.
  //   When the URL already matches (genuine hashchange), neither call is needed.
  if (window.location && window.location.hash !== '#' + view.hash) {
    try {
      if (opts.fromHash) {
        history.replaceState(null, '', '#' + view.hash);
      } else {
        history.pushState(null, '', '#' + view.hash);
      }
    } catch (e) { /* may throw in tests */ }
  }

  // Always hide ALL_VIEWS first (via showView) to guarantee single-view display,
  // then run the view-specific onEnter handler for state cleanup side effects.
  // The show/hide calls inside onEnter handlers (showHome, showParty, etc.) are
  // idempotent with respect to the classList already set by showView(), so this
  // is safe and does not cause any visible double-transition.
  showView(view.id);
  if (typeof view.onEnter === 'function') {
    view.onEnter();
  }

  // Apply enter animation and update nav visibility
  const targetEl = document.getElementById(view.id);
  if (targetEl) {
    targetEl.classList.remove('is-entering');
    void targetEl.offsetWidth; // Force reflow so the animation re-triggers on re-entry
    targetEl.classList.add('is-entering');
    targetEl.addEventListener('animationend', () => targetEl.classList.remove('is-entering'), { once: true });

    // Accessibility: focus first heading or interactive element for keyboard/screen-reader users.
    // preventScroll:true avoids the browser auto-scrolling the element into view, which would
    // undo the window.scrollTo(0,0) reset performed by showView() and cause a visible jump.
    setTimeout(() => {
      const focusTarget = targetEl.querySelector('h1, h2, [autofocus], button:not([disabled]), input:not([disabled])');
      if (focusTarget) {
        focusTarget.focus({ preventScroll: true });
      }
    }, 50);
  }

  // Show/hide header elements based on auth state
  _updateNavVisibility();
}

/**
 * Update header/nav visibility based on post-auth vs pre-auth state.
 */
function _updateNavVisibility() {
  const authenticated = (typeof isLoggedIn === 'function' && isLoggedIn()) ||
                        (typeof hasValidProfile === 'function' && hasValidProfile());
  const postAuthEls = document.querySelectorAll('.post-auth-only');
  postAuthEls.forEach(el => {
    if (authenticated) {
      el.classList.remove('nav-hidden');
    } else {
      el.classList.add('nav-hidden');
    }
  });
  // Hide elements that should only be visible to logged-out users
  const preAuthEls = document.querySelectorAll('.pre-auth-only');
  preAuthEls.forEach(el => {
    if (authenticated) {
      el.classList.add('nav-hidden');
    } else {
      el.classList.remove('nav-hidden');
    }
  });
}

/**
 * Handle browser hash changes (back/forward button support).
 */
window.addEventListener('hashchange', () => {
  const hash = window.location.hash.replace('#', '');
  if (!hash) return;
  const viewName = HASH_TO_VIEW[hash];
  if (viewName) {
    setView(viewName, { fromHash: true });
  }
});


// User tier constants
const USER_TIER = {
  FREE: 'FREE',
  PARTY_PASS: 'PARTY_PASS',
  PRO: 'PRO'
};

// Music player state
const musicState = {
  selectedFile: null,
  currentObjectURL: null,
  audioElement: null,
  audioInitialized: false, // Track if audio element event listeners have been set up
  fileInputInitialized: false, // Track if file input handler has been set up
  queuedFile: null, // Next track to play
  queuedObjectURL: null, // Object URL for queued track
  queuedTrack: null, // Uploaded track info for queued track { trackId, trackUrl, title, durationMs, uploadStatus }
  // Track upload and queue state
  currentTrack: null, // { trackId, trackUrl, title, durationMs, uploadStatus: 'uploading'|'ready'|'error' }
  queue: [], // Array of track objects (max 5)
  uploadProgress: 0 // Upload progress percentage (0-100)
};


const state = {
  ws: null,
  clientId: null,
  code: null,
  hostId: null, // PHASE 7: Host ID for queue operations (returned from create-party)
  isHost: false,
  name: "Guest",
  djName: null, // DJ name for guest view
  source: "local",
  isPro: false,
  partyPro: false,
  playing: false,
  adActive: false,
  snapshot: null,
  partyPassActive: false,
  partyPassEndTime: null,
  partyPassTimerInterval: null,
  partyStatusPollingInterval: null, // Interval for polling party status
  partyStatusPollingInProgress: false, // Flag to prevent overlapping polling requests
  offlineMode: false, // Track if party was created in offline fallback mode
  chatMode: "OPEN", // OPEN, EMOJI_ONLY, LOCKED
  userTier: USER_TIER.FREE, // User's subscription tier
  // Guest-specific state
  nowPlayingFilename: null,
  upNextFilename: null,
  playbackState: "STOPPED", // PLAYING, PAUSED, STOPPED
  lastHostEvent: null, // PLAY, PAUSE, TRACK_SELECTED, NEXT_TRACK_QUEUED, TRACK_CHANGED
  visualMode: "idle", // playing, paused, idle
  connected: false,
  guestVolume: 80,
  guestAudioElement: null, // Audio element for guest playback
  guestAudioReady: false, // Flag if guest audio is loaded and ready
  guestNeedsTap: false, // Flag if guest needs to tap to play
  audioUnlocked: false, // Flag if audio has been unlocked by user interaction (for autoplay restrictions)
  showResyncButton: false, // Flag to show/hide Re-sync button conditionally
  driftCheckFailures: 0, // Counter for consecutive large drift failures
  // Scheduled playback state (PREPARE_PLAY -> PLAY_AT)
  pendingStartAtServerMs: null,
  pendingStartPositionSec: null,
  pendingTrackUrl: null,
  pendingTrackTitle: null,
  pendingExpectedSec: null, // For autoplay recovery
  // Crowd Energy state
  crowdEnergy: 0, // 0-100
  crowdEnergyPeak: 0,
  crowdEnergyDecayInterval: null,
  // DJ Moments state
  currentMoment: null,
  momentTimeout: null,
  // Session stats for recap
  sessionStats: {
    startTime: null,
    tracksPlayed: 0,
    totalReactions: 0,
    totalShoutouts: 0,
    totalMessages: 0,
    emojiCounts: {},
    peakEnergy: 0
  },
  // Guest counter for anonymous names
  nextGuestNumber: 1,
  guestNickname: null,
  lastDjMessageTimestamp: 0, // Track last DJ message to avoid duplicates
  isReconnecting: false, // Track if currently in reconnect flow
  // Message spam prevention
  lastMessageTimestamp: 0,
  messageCooldownMs: 2000, // 2 second cooldown between messages
  // Unified reactions feed (Phase 2)
  unifiedFeed: [], // Array of { id, timestamp, sender, senderName, type, content, isEmoji }
  maxFeedItems: 30, // Maximum items in unified feed (rolling limit)
  // Party Pass messaging feed (FEED_ITEM system)
  feedItems: [], // Array of feed items from FEED_ITEM messages
  maxMessagingFeedItems: 50, // Maximum items in messaging feed
  feedItemTimeouts: new Map(), // Map<itemId, timeoutId> for TTL removal
  // Unified feed event deduplication (Phase COPILOT PROMPT 2/4)
  feedSeenIds: new Set(), // Set of seen event IDs to prevent duplicates
  // New UX flow state
  selectedTier: null // Track tier selection before account creation
};

// Server clock synchronization state
let serverOffsetMs = 0; // Estimated offset: server time = local time + offset
let timePingCounter = 0; // Counter for generating unique ping IDs
let timePingInterval = null; // Interval for periodic TIME_PING
let isFirstSync = false; // Track if initial sync has occurred

// Helper function to compute current server time using offset
function nowServerMs() {
  return Date.now() + serverOffsetMs;
}

/**
 * Clean up filename for display as track title
 * Removes file extension and improves readability
 * @param {string} filename - Raw filename
 * @returns {string} Cleaned title
 */
function cleanTrackTitle(filename) {
  if (!filename) return 'Unknown Track';
  
  // Remove file extension
  let title = filename.replace(/\.(mp3|m4a|wav|ogg|flac|aac|wma|opus)$/i, '');
  
  // Replace underscores and hyphens with spaces
  title = title.replace(/[_-]/g, ' ');
  
  // Capitalize first letter of each word
  title = title.replace(/\b\w/g, char => char.toUpperCase());
  
  return title;
}

/**
 * Retry manager for loading tracks with exponential backoff
 */
const TrackLoader = {
  maxRetries: 3,
  retryDelay: 1000, // Start with 1 second
  
  /**
   * Load a track with automatic retry on failure
   * @param {HTMLAudioElement} audioElement - The audio element to load into
   * @param {string} trackUrl - URL of the track to load
   * @param {string} trackId - Unique identifier for the track
   * @param {number} attempt - Current attempt number (internal)
   * @returns {Promise<void>}
   */
  async loadWithRetry(audioElement, trackUrl, trackId, attempt = 1) {
    console.log(`[Retry] Loading ${trackId}, attempt ${attempt}/${this.maxRetries}`);
    
    try {
      await this.attemptLoad(audioElement, trackUrl);
      console.log(`[Retry] Successfully loaded ${trackId} on attempt ${attempt}`);
      return;
    } catch (error) {
      console.error(`[Retry] Attempt ${attempt} failed for ${trackId}:`, error.message);
      
      if (attempt >= this.maxRetries) {
        // Max retries reached - give up
        console.error(`[Retry] Max retries reached for ${trackId}, giving up`);
        this.showLoadError(trackId);
        throw error;
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const delay = this.retryDelay * Math.pow(2, attempt - 1);
      console.log(`[Retry] Retrying ${trackId} in ${delay}ms...`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      
      // Retry
      return this.loadWithRetry(audioElement, trackUrl, trackId, attempt + 1);
    }
  },
  
  /**
   * Attempt to load a track once
   * @param {HTMLAudioElement} audioElement - The audio element to load into
   * @param {string} trackUrl - URL of the track to load
   * @returns {Promise<void>}
   */
  attemptLoad(audioElement, trackUrl) {
    return new Promise((resolve, reject) => {
      // Set timeout for load attempt
      const timeout = setTimeout(() => {
        audioElement.removeEventListener('canplay', onSuccess);
        audioElement.removeEventListener('error', onError);
        audioElement.removeEventListener('abort', onAbort);
        reject(new Error('Load timeout (15 seconds)'));
      }, 15000); // 15 second timeout
      
      function onSuccess() {
        clearTimeout(timeout);
        audioElement.removeEventListener('canplay', onSuccess);
        audioElement.removeEventListener('error', onError);
        audioElement.removeEventListener('abort', onAbort);
        resolve();
      }
      
      function onError(err) {
        clearTimeout(timeout);
        audioElement.removeEventListener('canplay', onSuccess);
        audioElement.removeEventListener('error', onError);
        audioElement.removeEventListener('abort', onAbort);
        reject(err.error || new Error('Load error'));
      }
      
      function onAbort() {
        clearTimeout(timeout);
        audioElement.removeEventListener('canplay', onSuccess);
        audioElement.removeEventListener('error', onError);
        audioElement.removeEventListener('abort', onAbort);
        reject(new Error('Load aborted'));
      }
      
      audioElement.addEventListener('canplay', onSuccess);
      audioElement.addEventListener('error', onError);
      audioElement.addEventListener('abort', onAbort);
      
      // Trigger load
      audioElement.src = trackUrl;
      audioElement.load();
    });
  },
  
  /**
   * Show error message to user when track loading fails
   * @param {string} trackId - The track that failed to load
   */
  showLoadError(trackId) {
    console.error(`[Retry] Showing error UI for failed track ${trackId}`);
    
    // Show a toast notification
    if (typeof toast === 'function') {
      toast('❌ Failed to load track. Check your internet connection.', 'error');
    }
    
    // Update playback state to show error
    if (!state.isHost) {
      updateGuestPlaybackState("ERROR");
    }
  }
};

/**
 * Analytics helper functions for tracking key events
 */
const Analytics = {
  /**
   * Track an event with Google Analytics
   * @param {string} eventName - Name of the event
   * @param {object} params - Event parameters
   */
  track(eventName, params = {}) {
    // Only track if gtag is available (production only)
    if (typeof gtag === 'function') {
      gtag('event', eventName, params);
    }
    // Also log to console for debugging (only when developer tools are open)
    if (typeof console !== 'undefined' && console._commandLineAPI) {
      console.log('[Analytics]', eventName, params);
    }
  },

  /**
   * Track party creation
   * @param {string} tier - User tier (FREE, PARTY_PASS, PRO)
   * @param {string} code - Party code
   */
  trackPartyCreated(tier, code) {
    this.track('party_created', {
      tier: tier,
      party_code: code
    });
  },

  /**
   * Track party join
   * @param {string} code - Party code
   * @param {boolean} isHost - Whether user is host
   */
  trackPartyJoined(code, isHost) {
    this.track('party_joined', {
      party_code: code,
      is_host: isHost
    });
  },

  /**
   * Track purchase initiation
   * @param {string} itemType - Type of item (party_pass, pro_monthly, visual_pack, etc.)
   * @param {string} itemKey - Item key
   * @param {number} price - Price in currency
   */
  trackPurchaseInitiated(itemType, itemKey, price) {
    this.track('begin_checkout', {
      item_type: itemType,
      item_key: itemKey,
      value: price,
      currency: 'GBP'
    });
  },

  /**
   * Track completed purchase
   * @param {string} itemType - Type of item
   * @param {string} itemKey - Item key
   * @param {number} price - Price in currency
   */
  trackPurchaseCompleted(itemType, itemKey, price) {
    // Generate unique transaction ID using crypto.randomUUID if available
    let uniqueId;
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      uniqueId = crypto.randomUUID();
    } else if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      // Fallback: Use crypto random bytes for older browsers
      const array = new Uint32Array(2);
      crypto.getRandomValues(array);
      uniqueId = `${array[0].toString(36)}-${array[1].toString(36)}`;
    } else {
      // Final fallback for very old browsers (not cryptographically secure)
      // This should rarely be used as crypto.getRandomValues is supported in all modern browsers
      console.warn('[Analytics] Using non-cryptographic random for transaction ID (very old browser detected)');
      uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}-${Math.random().toString(36).substring(2, 11)}`;
    }
    const transactionId = `${uniqueId}-${itemKey}`;
    
    this.track('purchase', {
      transaction_id: transactionId,
      item_type: itemType,
      item_key: itemKey,
      value: price,
      currency: 'GBP'
    });
  },

  /**
   * Track add-on purchase
   * @param {string} category - Add-on category
   * @param {string} itemKey - Item key
   * @param {number} price - Price in currency
   */
  trackAddonPurchased(category, itemKey, price) {
    this.track('addon_purchase', {
      category: category,
      item_key: itemKey,
      value: price,
      currency: 'GBP'
    });
  },

  /**
   * Track user signup
   * @param {string} method - Signup method (email)
   */
  trackSignup(method = 'email') {
    this.track('sign_up', {
      method: method
    });
  },

  /**
   * Track user login
   * @param {string} method - Login method (email)
   */
  trackLogin(method = 'email') {
    this.track('login', {
      method: method
    });
  }
};

/**
 * Monetization state - manages user purchases and subscriptions
 * 
 * Storage rules:
 * - Visual packs, titles, and profile upgrades are stored permanently to user account
 * - Party Pass and party extensions are temporary (reset when party ends)
 * 
 * Mutually exclusive items:
 * - Only ONE visual pack can be active at a time (user can switch between owned packs)
 * - Only ONE DJ title can be active at a time (user can switch between owned titles)
 * 
 * Stackable items:
 * - All owned profile upgrades display together on profile and DJ screen
 */
const monetizationState = {
  // User's purchased items
  ownedVisualPacks: [], // ['neon-lights', 'festival-stage', 'club-pulse']
  ownedTitles: [], // ['rising-dj', 'club-dj', 'superstar-dj', 'legend-dj']
  ownedProfileUpgrades: [], // ['verified-badge', 'crown-effect', 'animated-name', 'reaction-trail']
  
  // Currently active items (only one visual pack and one title at a time)
  activeVisualPack: null, // 'neon-lights' | 'festival-stage' | 'club-pulse' | null
  activeTitle: null, // 'rising-dj' | 'club-dj' | 'superstar-dj' | 'legend-dj' | null
  
  // Current party temporary extensions (reset when party ends)
  partyTimeExtensionMins: 0, // Additional minutes added to party
  partyPhoneExtensionCount: 0, // Additional phones added to party
  
  // Subscription status
  proSubscriptionActive: false,
  proSubscriptionEndDate: null,
  
  // Party Pass (temporary, per-party)
  partyPassActiveForCurrentParty: false,
  partyPassEndTimeForCurrentParty: null
};

// Visual Pack definitions
const VISUAL_PACKS = {
  'neon-lights': {
    id: 'neon-lights',
    name: 'Neon Lights',
    price: 3.99, // GBP - DJ visual effects pack (one-time purchase)
    currency: '£',
    description: 'Vibrant neon light show',
    previewColor: '#5AA9FF'
  },
  'festival-stage': {
    id: 'festival-stage',
    name: 'Festival Stage',
    price: 4.99, // GBP - DJ visual effects pack (one-time purchase)
    currency: '£',
    description: 'Epic festival vibes',
    previewColor: '#8B7CFF'
  },
  'club-pulse': {
    id: 'club-pulse',
    name: 'Club Pulse',
    price: 2.99, // GBP - DJ visual effects pack (one-time purchase)
    currency: '£',
    description: 'Underground club energy',
    previewColor: '#FF6B9D'
  }
};

// DJ Title definitions
const DJ_TITLES = {
  'rising-dj': {
    id: 'rising-dj',
    name: 'Rising DJ',
    price: 0.99, // GBP - DJ cosmetic title (one-time purchase)
    currency: '£',
    description: 'Starting your journey'
  },
  'club-dj': {
    id: 'club-dj',
    name: 'Club DJ',
    price: 1.49, // GBP - DJ cosmetic title (one-time purchase)
    currency: '£',
    description: 'Making moves'
  },
  'superstar-dj': {
    id: 'superstar-dj',
    name: 'Superstar DJ',
    price: 2.49, // GBP - DJ cosmetic title (one-time purchase)
    currency: '£',
    description: 'On top of the scene'
  },
  'legend-dj': {
    id: 'legend-dj',
    name: 'Legend DJ',
    price: 3.49, // GBP - DJ cosmetic title (one-time purchase)
    currency: '£',
    description: 'Hall of fame status'
  }
};

// Profile Upgrade definitions (stackable)
const PROFILE_UPGRADES = {
  'verified-badge': {
    id: 'verified-badge',
    name: 'Verified DJ Badge',
    price: 1.99, // GBP - Profile cosmetic upgrade (one-time purchase, stackable)
    currency: '£',
    description: 'Show you\'re legit',
    icon: '✓'
  },
  'crown-effect': {
    id: 'crown-effect',
    name: 'Crown Effect',
    price: 2.99, // GBP - Profile cosmetic upgrade (one-time purchase, stackable)
    currency: '£',
    description: 'Royalty vibes',
    icon: '👑'
  },
  'animated-name': {
    id: 'animated-name',
    name: 'Animated Name',
    price: 2.49, // GBP - Profile cosmetic upgrade (one-time purchase, stackable)
    currency: '£',
    description: 'Make your name pop',
    icon: '✨'
  },
  'reaction-trail': {
    id: 'reaction-trail',
    name: 'Reaction Trail',
    price: 1.99, // GBP - Profile cosmetic upgrade (one-time purchase, stackable)
    currency: '£',
    description: 'Leave your mark',
    icon: '🌟'
  }
};

// Party Extension definitions
const PARTY_EXTENSIONS = {
  'time-30': {
    id: 'time-30',
    name: 'Add 30 Minutes',
    price: 0.99, // GBP - Party session extension (per session, stackable)
    currency: '£',
    description: 'Keep the party going',
    extensionMinutes: 30
  },
  'phones-5': {
    id: 'phones-5',
    name: 'Add 5 More Phones',
    price: 1.49, // GBP - Party capacity boost (per session, stackable)
    currency: '£',
    description: 'Bring more friends',
    extensionPhones: 5
  }
};

const HYPE_EFFECTS = {
  'confetti-blast': {
    id: 'confetti-blast',
    name: 'Confetti Blast',
    price: 0.49, // GBP - Single-use hype effect
    currency: '£',
    description: 'Epic confetti explosion',
    icon: '🎊',
    duration: 5
  },
  'laser-show': {
    id: 'laser-show',
    name: 'Laser Show',
    price: 0.99, // GBP - Single-use hype effect
    currency: '£',
    description: 'Synchronized laser effects',
    icon: '⚡',
    duration: 10
  },
  'crowd-roar': {
    id: 'crowd-roar',
    name: 'Crowd Roar',
    price: 0.79, // GBP - Single-use hype effect
    currency: '£',
    description: 'Massive crowd cheer sound',
    icon: '📣',
    duration: 3
  },
  'fireworks': {
    id: 'fireworks',
    name: 'Fireworks',
    price: 1.49, // GBP - Single-use hype effect
    currency: '£',
    description: 'Spectacular fireworks display',
    icon: '🎆',
    duration: 8
  }
};

// Client-side party code generator for offline fallback
function generatePartyCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Health check function - checks if server is ready before operations
async function checkServerHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    
    const response = await fetch(API_BASE + "/api/health", {
      method: "GET",
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    const health = await response.json();
    
    console.log("[Health] Server health check:", health);
    
        // Build error message from enhanced health data
    let errorMsg = null;
    if (health.ok !== true) {
      if (health.redis?.errorType) {
        // Provide user-friendly error messages based on error type
        switch (health.redis.errorType) {
          case 'connection_refused':
            errorMsg = "Redis server not reachable. Contact support.";
            break;
          case 'timeout':
            errorMsg = "Redis connection timeout. Check network.";
            break;
          case 'host_not_found':
            errorMsg = "Redis host not found. Check configuration.";
            break;
          case 'auth_failed':
            errorMsg = "Redis authentication failed. Check credentials.";
            break;
          case 'tls_error':
            errorMsg = "Redis TLS/SSL error. Check configuration.";
            break;
          default:
            errorMsg = health.redis?.status || "Server not ready";
        }
      } else {
        errorMsg = health.redis?.status || "Server not ready";
      }
    }
    
    // Return health info with ok status
    // If ok field is missing, assume false for safety (server may be outdated)
    const result = {
      ok: health.ok === true,
      redis: health.redis?.connected || false,
      instanceId: health.instanceId,
      redisErrorType: health.redis?.errorType,
      configSource: health.redis?.configSource,
      version: health.version,
      error: errorMsg
    };
    
        return result;
  } catch (error) {
    console.error("[Health] Health check failed:", error);
    // If health check fails, server is not reachable
    // Return ok: false so caller knows not to proceed with operations
    const result = {
      ok: false,
      redis: false,
      instanceId: null,
      error: error.message
    };
    
    return result;
  }
}

const el = (id) => document.getElementById(id);
const toastEl = el("toast");

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  setTimeout(() => toastEl.classList.add("hidden"), 2200);
}


function show(id) { el(id).classList.remove("hidden"); }
function hide(id) { el(id).classList.add("hidden"); }

function setPlanPill() {
  const pill = el("planPill");
  if (state.partyPassActive) {
    pill.textContent = "🎉 Party Pass · Active";
  } else if (state.partyPro) {
    pill.textContent = "Supporter · party unlocked";
  } else {
    pill.textContent = "Free · up to 2 phones";
  }
}

function connectWS() {
  return new Promise((resolve, reject) => {
    // When API_BASE is a full URL, derive the WS URL from it.
    // When API_BASE is empty (relative-URL mode), build the WS URL from window.location
    // so connections always target the same host that served the page.
    const wsUrl = API_BASE
      ? API_BASE.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
      : (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host;
    console.log("[WS] Connecting to:", wsUrl);
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      console.log("[WS] Connected successfully");
      updateHeaderConnectionStatus("connected");
      resolve();
    };
    ws.onerror = (e) => {
      console.error("[WS] Connection error:", e);
      updateHeaderConnectionStatus("error");
      reject(e);
    };
    ws.onmessage = (ev) => {
      console.log("[WS] Received message:", ev.data);
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleServer(msg);
    };
    ws.onclose = () => {
      console.log("[WS] Connection closed");
      updateHeaderConnectionStatus("disconnected");
      toast("Disconnected");
      stopTimePing(); // Stop periodic time sync
      isFirstSync = false; // Reset sync flag for next connection
      state.ws = null;
      state.clientId = null;
      showLanding();
    };
  });
}

// Update header connection status indicator
function updateHeaderConnectionStatus(status) {
  const indicator = document.getElementById('connectionIndicator');
  if (!indicator) return;
  
  switch (status) {
    case 'connected':
      indicator.textContent = '● Connected';
      indicator.style.color = 'var(--success, #5cff8a)';
      break;
    case 'disconnected':
      indicator.textContent = '● Disconnected';
      indicator.style.color = 'var(--danger, #ff5a6a)';
      break;
    case 'reconnecting':
      indicator.textContent = '● Reconnecting...';
      indicator.style.color = 'var(--warning, #ffd15a)';
      break;
    case 'error':
      indicator.textContent = '● Connection Error';
      indicator.style.color = 'var(--danger, #ff5a6a)';
      break;
    default:
      indicator.textContent = '● Unknown';
      indicator.style.color = 'var(--muted, #999)';
  }
}

function send(obj) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    console.error("[WS] Cannot send - WebSocket not connected");
    return;
  }
  console.log("[WS] Sending message:", obj);
  state.ws.send(JSON.stringify(obj));
}

/**
 * Send MESSAGE_ACK to acknowledge receipt of a critical message
 * Part of Event Replay System for reliable message delivery
 */
function sendMessageAck(messageId) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    console.warn("[MESSAGE_ACK] Cannot send - WebSocket not connected");
    return;
  }
  
  console.log(`[MESSAGE_ACK] Acknowledging message ${messageId}`);
  send({ t: "MESSAGE_ACK", messageId });
}

/**
 * Send TIME_PING to server for clock synchronization
 * Uses exponentially weighted moving average (EWMA) to smooth offset estimates
 */
function sendTimePing() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    console.warn("[TIME_PING] Cannot send - WebSocket not connected");
    return;
  }
  
  timePingCounter++;
  const pingId = timePingCounter;
  const clientSendMs = Date.now();
  
  // Store ping metadata for RTT calculation
  if (!window.timePingPending) {
    window.timePingPending = new Map();
  }
  window.timePingPending.set(pingId, { clientSendMs });
  
  console.log(`[TIME_PING] Sending ping ${pingId}`);
  send({ 
    t: "TIME_PING", 
    clientNowMs: clientSendMs,
    pingId 
  });
}

/**
 * Start periodic TIME_PING (every 30 seconds)
 */
function startTimePing() {
  // Stop any existing interval
  if (timePingInterval) {
    clearInterval(timePingInterval);
  }
  
  // Send initial ping immediately
  sendTimePing();
  
  // Then send every 30 seconds
  timePingInterval = setInterval(() => {
    sendTimePing();
  }, 30000);
  
  console.log("[TIME_PING] Started periodic time sync (every 30s)");
}

/**
 * Stop periodic TIME_PING
 */
function stopTimePing() {
  if (timePingInterval) {
    clearInterval(timePingInterval);
    timePingInterval = null;
    console.log("[TIME_PING] Stopped periodic time sync");
  }
}

/**
 * Send DJ quick button message (Party Pass feature)
 */
function sendDjQuickButton(key) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    console.error("[WS] Cannot send - WebSocket not connected");
    toast("Not connected to server", "error");
    return;
  }
  
  if (!state.isHost) {
    toast("Only the DJ can use quick buttons", "error");
    return;
  }
  
  console.log("[WS] Sending DJ quick button:", key);
  send({ t: "DJ_QUICK_BUTTON", key: key });
}

/**
 * Send guest quick reply (Party Pass feature)
 */
function sendGuestQuickReply(key) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    console.error("[WS] Cannot send - WebSocket not connected");
    toast("Not connected to server", "error");
    return;
  }
  
  if (state.isHost) {
    toast("Guests only", "error");
    return;
  }
  
  console.log("[WS] Sending guest quick reply:", key);
  send({ t: "GUEST_QUICK_REPLY", key: key });
}

/**
 * Send DJ short message (Party Pass / Pro Monthly feature)
 */
function sendDjShortMessage(text) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    console.error("[WS] Cannot send - WebSocket not connected");
    toast("Not connected to server", "error");
    return;
  }
  
  if (!state.isHost) {
    console.warn("[DJ Short Message] Only DJ can send short messages");
    return;
  }
  
  // DJ typed messages require PRO_MONTHLY tier only
  if (!hasProTierEntitlement()) {
    console.warn("[DJ Short Message] Pro Monthly tier required");
    return;
  }
  
  // Trim and validate
  const trimmedText = (text || "").trim();
  if (!trimmedText) {
    console.log("[WS] Empty message - not sending");
    return;
  }
  
  // Enforce max length (30 chars)
  const messageText = trimmedText.substring(0, 30);
  
  console.log("[WS] Sending DJ short message:", messageText);
  send({ t: "DJ_SHORT_MESSAGE", text: messageText });
}

/**
 * Request sync state from server (for late joiners or manual sync)
 */
function requestSyncState() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    console.error("[WS] Cannot request sync state - WebSocket not connected");
    return;
  }
  
  console.log("[WS] Requesting sync state from server");
  send({ t: "REQUEST_SYNC_STATE" });
}

function handleServer(msg) {
  // PHASE 5: Track eventId for RESUME
  if (msg.eventId !== undefined && state.partyCode) {
    const storageKey = `lastEventId:${state.partyCode}`;
    localStorage.setItem(storageKey, msg.eventId.toString());
  }
  
  // Send acknowledgment for messages that require it
  if (msg._requiresAck && msg._msgId) {
    sendMessageAck(msg._msgId);
  }
  
  if (msg.t === "WELCOME") { 
    state.clientId = msg.clientId; 
    state.connected = true;
    // Start periodic time sync
    startTimePing();
    return; 
  }
  if (msg.t === "TIME_PONG") {
    // Calculate server clock offset using EWMA smoothing
    const clientReceiveMs = Date.now();
    
    if (!window.timePingPending) {
      console.warn("[TIME_PONG] No pending pings map");
      return;
    }
    
    const pingData = window.timePingPending.get(msg.pingId);
    if (!pingData) {
      console.warn(`[TIME_PONG] Unknown ping ID: ${msg.pingId}`);
      return;
    }
    
    window.timePingPending.delete(msg.pingId);
    
    const clientSendMs = pingData.clientSendMs;
    const rttMs = clientReceiveMs - clientSendMs;
    
    // Ignore samples with RTT > 800ms (unreliable)
    if (rttMs > 800) {
      console.log(`[TIME_PONG] Ignoring ping ${msg.pingId} - RTT too high: ${rttMs}ms`);
      return;
    }
    
    // Estimate server time at the midpoint of the round trip
    const estimatedServerNowMs = msg.serverNowMs + (rttMs / 2);
    const newOffset = estimatedServerNowMs - clientReceiveMs;
    
    // Apply EWMA smoothing: offset = 0.8 * oldOffset + 0.2 * newOffset
    // On first sample, just use newOffset directly
    if (!isFirstSync) {
      serverOffsetMs = newOffset;
      isFirstSync = true;
      console.log(`[TIME_PONG] Initial offset: ${serverOffsetMs.toFixed(2)}ms (RTT: ${rttMs}ms)`);
    } else {
      serverOffsetMs = 0.8 * serverOffsetMs + 0.2 * newOffset;
      console.log(`[TIME_PONG] Updated offset: ${serverOffsetMs.toFixed(2)}ms (RTT: ${rttMs}ms, raw: ${newOffset.toFixed(2)}ms)`);
    }
    
    return;
  }
  if (msg.t === "CREATED") {
    state.code = msg.code; 
    state.isHost = true; 
    state.connected = true;
    showParty(); 
    toast(`Party created: ${msg.code}`); 
    // Save to localStorage for rejoin
    localStorage.setItem('lastPartyCode', msg.code);
    return;
  }
  if (msg.t === "HOST_JOINED") {
    // Host WebSocket registration confirmation - do NOT change navigation
    // Host has already navigated to showParty() after HTTP party creation
    state.code = msg.code;
    state.isHost = true; // Explicitly maintain host status
    state.connected = true;
    console.log(`[HOST_JOINED] Host WebSocket registered for party ${msg.code}, tier: ${msg.tier || state.userTier}`);
    // Save to localStorage for rejoin
    localStorage.setItem('lastPartyCode', msg.code);
    // Do NOT call showParty() again or showGuest() - host is already on correct screen
    return;
  }
  if (msg.t === "JOINED") {
    // Guest join only - hosts receive HOST_JOINED instead
    state.code = msg.code; 
    state.isHost = false; 
    state.connected = true;
    state.partyCode = msg.code; // PHASE 5: Track party code for eventId storage
    showGuest(); 
    toast(`Joined party ${msg.code}`); 
    
    // Save to localStorage for rejoin
    localStorage.setItem('lastPartyCode', msg.code);
    const guestNameInput = document.getElementById('guestName');
    if (guestNameInput?.value) {
      localStorage.setItem('lastGuestName', guestNameInput.value.trim());
    }
    
    // PHASE 5: Send RESUME with lastEventId if available
    const storageKey = `lastEventId:${msg.code}`;
    const lastEventId = parseInt(localStorage.getItem(storageKey) || '0', 10);
    
    if (lastEventId > 0) {
      console.log(`[Resume] Sending RESUME with lastEventId: ${lastEventId}`);
      send({ t: "RESUME", partyCode: msg.code, lastEventId });
    } else {
      // First time joining - request sync state
      requestSyncState();
    }
    
    return;
  }
  if (msg.t === "ROOM") {
    const previousSnapshot = state.snapshot;
    state.snapshot = msg.snapshot;
    // Update chat mode from snapshot
    if (msg.snapshot?.chatMode) {
      state.chatMode = msg.snapshot.chatMode;
      updateChatModeUI();
    }
    // Update tier from server snapshot (server-authoritative)
    if (msg.snapshot?.tier) {
      const oldTier = state.userTier;
      state.userTier = msg.snapshot.tier;
      if (oldTier !== state.userTier) {
        console.log(`[ROOM] Tier updated from server: ${oldTier} → ${state.userTier}`);
      }
    }
    // Party-wide Pro is now server-authoritative
    const wasPartyPro = state.partyPro;
    state.partyPro = !!msg.snapshot.partyPro;
    // Show success message when party becomes Pro
    if (!wasPartyPro && state.partyPro) {
      toast("🎉 Pro unlocked for this party!");
    }
    // Update Party Pass status from server (source of truth)
    const wasPartyPassActive = state.partyPassActive;
    state.partyPassActive = !!msg.snapshot.partyPassActive;
    state.partyPassEndTime = msg.snapshot.partyPassExpiresAt || null;
    if (!wasPartyPassActive && state.partyPassActive) {
      toast("✅ Party Pass active!");
    }
    // Update source from server (host-selected)
    if (msg.snapshot?.source) {
      state.source = msg.snapshot.source;
    }
    
    // Presence feedback: detect member joins/leaves
    if (previousSnapshot && msg.snapshot?.members) {
      const previousMembers = previousSnapshot.members || [];
      const currentMembers = msg.snapshot.members || [];
      
      // Detect new members (joined)
      const newMembers = currentMembers.filter(m => 
        !previousMembers.some(pm => pm.id === m.id)
      );
      newMembers.forEach(m => {
        if (m.id !== state.clientId) { // Don't show notification for self
          toast(`${m.name} joined`);
        }
      });
      
      // Detect removed members (left)
      const leftMembers = previousMembers.filter(pm => 
        !currentMembers.some(m => m.id === pm.id)
      );
      leftMembers.forEach(m => {
        if (m.id !== state.clientId) { // Don't show notification for self
          toast(`${m.name} left`);
        }
      });
    }
    
    // Update UI based on Party Pass status
    updatePartyPassUI();
    
    setPlanPill();
    if (state.isHost) {
      renderRoom();
    } else {
      updateGuestPartyStatus();
    }
    return;
  }
  
  // Scoreboard update
  if (msg.t === "SCOREBOARD_UPDATE") {
    if (msg.scoreboard) {
      updateScoreboard(msg.scoreboard);
    }
    return;
  }
  
  if (msg.t === "ENDED") { 
    state.connected = false;
    state.lastHostEvent = "PARTY_ENDED";
    if (!state.isHost) {
      updateGuestPlaybackState("STOPPED");
      updateGuestVisualMode("idle");
    }
    toast("Party ended (host left)"); 
    showLanding(); 
    return; 
  }
  if (msg.t === "KICKED") { 
    state.connected = false;
    toast("Removed by host"); 
    showLanding(); 
    return; 
  }
  
  // Guest-specific messages
  if (msg.t === "TRACK_SELECTED") {
    // Official App Sync mode
    if (msg.mode === "OFFICIAL_APP_SYNC") {
      handleOfficialAppSyncTrackSelected(msg);
      return;
    }
    state.nowPlayingFilename = msg.filename;
    state.lastHostEvent = "TRACK_SELECTED";
    if (!state.isHost) {
      updateGuestNowPlaying(msg.filename);
      // Store trackUrl for later playback
      if (msg.trackUrl) {
        state.guestTrackUrl = msg.trackUrl;
        state.guestTrackId = msg.trackId;
      }
      // Don't change playback state yet - wait for PLAY
    }
    return;
  }
  
  if (msg.t === "NEXT_TRACK_QUEUED") {
    state.upNextFilename = msg.filename;
    state.lastHostEvent = "NEXT_TRACK_QUEUED";
    if (!state.isHost) {
      updateGuestUpNext(msg.filename);
    }
    return;
  }
  
  if (msg.t === "PLAY") {
    state.playing = true;
    state.lastHostEvent = "PLAY";
    if (!state.isHost) {
      updateGuestPlaybackState("PLAYING");
      updateGuestVisualMode("playing");
      
      // Handle guest audio playback with proper server timestamp and position
      if (msg.trackUrl) {
        handleGuestAudioPlayback(msg.trackUrl, msg.filename, msg.serverTimestamp, msg.positionSec || 0);
      } else {
        // No track URL provided - show message
        toast("Host is playing locally - no audio sync available");
      }
    }
    return;
  }
  
  if (msg.t === "PAUSE") {
    state.playing = false;
    state.lastHostEvent = "PAUSE";
    if (!state.isHost) {
      updateGuestPlaybackState("PAUSED");
      updateGuestVisualMode("paused");
      
      // Pause guest audio if playing and sync to paused position if provided
      if (state.guestAudioElement) {
        if (!state.guestAudioElement.paused) {
          state.guestAudioElement.pause();
        }
        
        // If server provides pausedPositionSec, seek to that position
        if (hasPausedPosition(msg) && state.guestAudioElement.duration) {
          clampAndSeekAudio(state.guestAudioElement, msg.pausedPositionSec);
          console.log("[Guest] Paused at position:", msg.pausedPositionSec.toFixed(2), "s");
        }
        
        // Update dataset for future sync operations
        if (msg.pausedAtServerMs && hasPausedPosition(msg)) {
          state.guestAudioElement.dataset.startAtServerMs = msg.pausedAtServerMs.toString();
          state.guestAudioElement.dataset.startPositionSec = msg.pausedPositionSec.toString();
        }
      }
      
      // Stop drift correction when paused
      stopDriftCorrection();
    }
    return;
  }
  
  if (msg.t === "STOP") {
    state.playing = false;
    state.lastHostEvent = "STOP";
    if (!state.isHost) {
      updateGuestPlaybackState("STOPPED");
      updateGuestVisualMode("stopped");
      
      // Stop guest audio and reset to beginning
      if (state.guestAudioElement) {
        state.guestAudioElement.pause();
        state.guestAudioElement.currentTime = 0;
        console.log("[Guest] Received STOP - audio reset to beginning");
      }
      
      // Stop drift correction
      stopDriftCorrection();
      
    }
    return;
  }
  
  if (msg.t === "TRACK_CHANGED") {
    state.nowPlayingFilename = msg.filename || msg.title;
    state.upNextFilename = msg.nextFilename || null;
    state.lastHostEvent = "TRACK_CHANGED";
    
    // PHASE 7: Update currentTrack from server
    if (msg.currentTrack) {
      musicState.currentTrack = msg.currentTrack;
    }
    
    // PHASE 7: Update queue from server
    if (msg.queue !== undefined) {
      musicState.queue = msg.queue || [];
    }
    
    if (!state.isHost) {
      updateGuestNowPlaying(msg.title || msg.filename);
      
      // Update queue display
      if (msg.queue) {
        updateGuestQueue(msg.queue);
      }
      
      // Handle audio playback for new track
      if (msg.trackUrl) {
        handleGuestAudioPlayback(msg.trackUrl, msg.title || msg.filename, msg.startAtServerMs || msg.serverTimestamp, msg.startPositionSec || msg.positionSec || 0);
      }
      
      updateGuestVisualMode("track-change");
      // Flash effect then return to playing
      setTimeout(() => {
        if (state.playing && !state.isHost) {
          updateGuestVisualMode("playing");
        }
      }, 500);
    } else {
      // PHASE 7: Update host queue UI
      updateHostQueueUI();
    }
    return;
  }
  
  // New sync-specific messages
  if (msg.t === "TRACK_STARTED") {
    state.playing = true;
    state.lastHostEvent = "TRACK_STARTED";
    
    if (!state.isHost) {
      state.nowPlayingFilename = msg.title || msg.filename;
      updateGuestPlaybackState("PLAYING");
      updateGuestVisualMode("playing");
      updateGuestNowPlaying(msg.title || msg.filename);
      
      // Handle guest audio playback with precise sync
      if (msg.trackUrl) {
        handleGuestAudioPlayback(msg.trackUrl, msg.title || msg.filename, msg.startAtServerMs, msg.startPositionSec || 0);
      } else {
        toast("Host is playing locally - no audio sync available");
      }
    }
    return;
  }
  
  if (msg.t === "QUEUE_UPDATED") {
    // PHASE 7: Update queue from server
    if (msg.queue !== undefined) {
      musicState.queue = msg.queue || [];
    }
    
    // PHASE 7: Update currentTrack if provided
    if (msg.currentTrack !== undefined) {
      musicState.currentTrack = msg.currentTrack;
    }
    
    if (!state.isHost) {
      updateGuestQueue(msg.queue || []);
    } else {
      // PHASE 7: Update host queue UI
      updateHostQueueUI();
    }
    return;
  }
  
  // Pre-load next track in background for seamless transitions
  if (msg.t === "PRELOAD_NEXT_TRACK") {
    console.log("[Preload] Pre-loading next track:", msg.title || msg.trackId);
    
    // Create a hidden audio element for preloading if it doesn't exist
    if (!state.preloadAudioElement) {
      state.preloadAudioElement = document.createElement('audio');
      state.preloadAudioElement.preload = 'auto';
      state.preloadAudioElement.style.display = 'none';
      document.body.appendChild(state.preloadAudioElement);
      
      // Track listener reference for cleanup
      state.preloadProgressListener = null;
    }
    
    // Remove old progress listener if it exists to prevent memory leak
    if (state.preloadProgressListener) {
      state.preloadAudioElement.removeEventListener('progress', state.preloadProgressListener);
    }
    
    // Create new progress listener
    state.preloadProgressListener = function onProgress() {
      if (state.preloadAudioElement.buffered.length > 0) {
        const bufferedEnd = state.preloadAudioElement.buffered.end(0);
        const duration = state.preloadAudioElement.duration;
        if (duration > 0) {
          const percentLoaded = (bufferedEnd / duration) * 100;
          console.log(`[Preload] ${msg.title || msg.trackId}: ${percentLoaded.toFixed(1)}% buffered`);
          
          // Remove listener once fully loaded to prevent further processing
          if (percentLoaded >= 99) {
            state.preloadAudioElement.removeEventListener('progress', state.preloadProgressListener);
            state.preloadProgressListener = null;
          }
        }
      }
    };
    
    // Set source to trigger browser pre-fetch
    state.preloadAudioElement.src = msg.trackUrl;
    
    // Track preload progress
    state.preloadAudioElement.addEventListener('progress', state.preloadProgressListener);
    
    // Note: canplaythrough and error events use { once: true } because they fire only once
    // per load and auto-cleanup is appropriate. This differs from 'progress' which fires
    // repeatedly and requires manual cleanup.
    state.preloadAudioElement.addEventListener('canplaythrough', function onReady() {
      console.log(`[Preload] ${msg.title || msg.trackId} ready for instant playback`);
    }, { once: true });
    
    state.preloadAudioElement.addEventListener('error', function onError(err) {
      console.warn(`[Preload] Failed to preload ${msg.title || msg.trackId}:`, err);
      // Clean up progress listener on error
      if (state.preloadProgressListener) {
        state.preloadAudioElement.removeEventListener('progress', state.preloadProgressListener);
        state.preloadProgressListener = null;
      }
    }, { once: true });
    
    return;
  }
  
  if (msg.t === "ERROR") {
    toast(msg.message || "Error");
    
    // PHASE 1: Handle TRACK_NOT_READY error specifically
    if (msg.code === "TRACK_NOT_READY") {
      updateMusicStatus(msg.message);
      console.log("[Music] Play rejected by server - track not ready");
    }
    
    // Reset button state if party creation failed
    const btn = el("btnCreate");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Start party";
    }
    
    return;
  }
  
  // Handle sync issue acknowledgment (for guests who reported)
  if (msg.t === "SYNC_ISSUE_ACK") {
    console.log("[SYNC_ISSUE_ACK] Received acknowledgment from server");
    // Toast already shown when sending, this just confirms
    return;
  }
  
  // Handle sync issue report from guest (for host/DJ)
  if (msg.t === "SYNC_ISSUE_REPORT") {
    if (state.isHost) {
      const guestName = msg.guestName || "Guest";
      const drift = msg.drift !== "unknown" ? `${msg.drift}ms` : "unknown";
      console.log(`[SYNC_ISSUE_REPORT] ${guestName} reported sync issue, drift: ${drift}`);
      
      // Show toast notification to DJ
      toast(`⚠️ ${guestName} audio out of sync (${drift})`, "warning");
      
      // Log to DJ messages container if visible
      const djMessagesContainer = el("djMessagesContainer");
      if (djMessagesContainer) {
        const msgEl = document.createElement("div");
        msgEl.className = "dj-message warning";
        msgEl.textContent = `⚠️ ${guestName} audio sync issue (${drift})`;
        djMessagesContainer.appendChild(msgEl);
      }
    }
    return;
  }
  
  // Host-specific messages
  if (msg.t === "GUEST_MESSAGE") {
    if (state.isHost) {
      handleGuestMessageReceived(msg.message, msg.guestName, msg.guestId, msg.isEmoji);
    } else {
      // Guests also receive GUEST_MESSAGE when DJ sends emoji/messages
      // IMPORTANT: Guests only add messages to unified feed - NO POP-UPS, NO ANIMATIONS, NO CROWD ENERGY
      // This ensures DJ emoji clicks do NOT trigger guest UI changes as per role-based enforcement
      
      // Log DJ emoji events for debugging (role enforcement validation)
      if (msg.guestName === 'DJ' && msg.isEmoji) {
        console.log('[Role Enforcement] DJ emoji received by guest - adding to feed only, no animations');
      }
      
      // Add to unified feed only (live reaction box display)
      addToUnifiedFeed(
        msg.guestName === 'DJ' ? 'DJ' : 'GUEST',
        msg.guestName,
        msg.isEmoji ? 'emoji' : 'message',
        msg.message,
        msg.isEmoji
      );
      // No toast pop-up for guests receiving messages from others
      // No crowd energy increment for guests (crowd energy is DJ-side only)
      // No animations triggered for guests receiving reactions
    }
    return;
  }
  
  // New unified feed event handler (COPILOT PROMPT 2/4)
  if (msg.t === "FEED_EVENT") {
    handleFeedEvent(msg.event);
    return;
  }
  
  // New unified messaging feed (Party Pass feature)
  if (msg.t === "FEED_ITEM") {
    handleFeedItem(msg.item);
    return;
  }
  
  // Guest playback requests
  if (msg.t === "GUEST_PLAY_REQUEST") {
    if (state.isHost) {
      handleGuestPlayRequest(msg.guestName, msg.guestId);
    }
    return;
  }
  
  if (msg.t === "GUEST_PAUSE_REQUEST") {
    if (state.isHost) {
      handleGuestPauseRequest(msg.guestName, msg.guestId);
    }
    return;
  }
  
  // DJ auto-generated messages
  if (msg.t === "DJ_MESSAGE") {
    displayDjMessage(msg.message, msg.type);
    return;
  }
  
  // DJ broadcast messages to guests
  if (msg.t === "HOST_BROADCAST_MESSAGE") {
    // Both host and guests receive this message
    displayHostBroadcastMessage(msg.message);
    return;
  }
  
  // Chat mode update
  if (msg.t === "CHAT_MODE_SET") {
    state.chatMode = msg.mode;
    updateChatModeUI();
    return;
  }
  
  // Phase 8: Host failover - handle HOST_CHANGED event
  if (msg.t === "HOST_CHANGED") {
    console.log("[HOST_CHANGED] New host:", msg.newHostName, "ID:", msg.newHostId);
    
    // Check if current client is the new host
    if (msg.newHostId === state.clientId) {
      console.log("[HOST_CHANGED] You are now the host!");
      
      // Update state to reflect host status
      state.isHost = true;
      
      // Switch from guest view to host view
      showParty();
      
      // Show notification
      toast("🎉 You are now the host!");
      
      // Log for debugging
    } else {
      // Another guest became host
      console.log("[HOST_CHANGED] Host changed to:", msg.newHostName);
      toast(`Host changed to ${msg.newHostName}`);
    }
    
    return;
  }
  
  // Track ready for playback
  if (msg.t === "TRACK_READY") {
    console.log("[WS] Track ready:", msg.track);
    
    if (!state.isHost) {
      // Update guest state with track URL
      if (msg.track && msg.track.trackUrl) {
        state.nowPlayingFilename = msg.track.filename || "Unknown Track";
        updateGuestNowPlaying(state.nowPlayingFilename);
        
        // Set up guest audio element
        if (!state.guestAudioElement) {
          state.guestAudioElement = new Audio();
          state.guestAudioElement.volume = (state.guestVolume || 80) / 100;
          
          // Add event listeners for diagnostics
          state.guestAudioElement.addEventListener('loadeddata', () => {
            console.log("[Guest Audio] Track loaded");
            state.guestAudioReady = true;
          });
          
          state.guestAudioElement.addEventListener('error', (e) => {
            const errorCode = state.guestAudioElement.error?.code;
            const errorMsg = state.guestAudioElement.error?.message || "Unknown error";
            console.error("[Guest Audio] Error:", errorCode, errorMsg);
            toast(`❌ Audio error: ${errorMsg}`);
          });
          
          state.guestAudioElement.addEventListener('canplay', () => {
            console.log("[Guest Audio] Can play");
          });
          
          state.guestAudioElement.addEventListener('waiting', () => {
            console.log("[Guest Audio] Waiting for data");
          });
        }
        
        // Set the source
        state.guestAudioElement.src = msg.track.trackUrl;
        state.guestAudioReady = false;
        
        console.log("[Guest Audio] Audio src set to:", msg.track.trackUrl);
        
        toast(`🎵 Track ready: ${msg.track.filename}`);
      }
    }
    
    return;
  }
  
  // PREPARE_PLAY: Pre-load audio and store pending state for scheduled start
  if (msg.t === "PREPARE_PLAY") {
    console.log("[PREPARE_PLAY] Preparing track:", msg.title || msg.filename);
    
    // Store pending playback info
    state.pendingStartAtServerMs = msg.startAtServerMs;
    state.pendingStartPositionSec = msg.startPositionSec || 0;
    state.pendingTrackUrl = msg.trackUrl;
    state.pendingTrackTitle = msg.title || msg.filename;
    
    // Update UI
    if (!state.isHost) {
      updateGuestNowPlaying(msg.title || msg.filename);
      updateGuestPlaybackState("PREPARING");
    }
    
    // Pre-load audio if we have a track URL
    if (msg.trackUrl) {
      // Create or reuse audio element
      if (!state.guestAudioElement) {
        state.guestAudioElement = new Audio();
        state.guestAudioElement.volume = (state.guestVolume || 80) / 100;
      }
      
      // Load track with automatic retry on failure
      const audioEl = state.guestAudioElement;
      const trackId = msg.trackId || msg.title || 'unknown';
      
      // PHASE 3: Helper to calculate buffered seconds
      const getBufferedSeconds = (audio) => {
        try {
          if (!audio.buffered || audio.buffered.length === 0) return 0;
          const currentTime = audio.currentTime || 0;
          for (let i = 0; i < audio.buffered.length; i++) {
            const start = audio.buffered.start(i);
            const end = audio.buffered.end(i);
            if (currentTime >= start && currentTime <= end) {
              return end - currentTime;
            }
          }
          // If not in buffered range, return 0
          return 0;
        } catch (e) {
          return 0;
        }
      };
      
      // PHASE 3: Helper to send CLIENT_READY
      const sendClientReady = () => {
        const bufferedSec = getBufferedSeconds(audioEl);
        const readyState = audioEl.readyState;
        const canPlayThrough = readyState >= 4; // HAVE_ENOUGH_DATA
        
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({
            t: 'CLIENT_READY',
            trackId: trackId,
            readyState: readyState,
            bufferedSec: bufferedSec,
            canPlayThrough: canPlayThrough
          }));
          console.log(`[PREPARE_PLAY] Sent CLIENT_READY: buffered=${bufferedSec.toFixed(1)}s, readyState=${readyState}`);
        }
      };
      
      TrackLoader.loadWithRetry(audioEl, msg.trackUrl, trackId)
        .then(() => {
          console.log("[PREPARE_PLAY] Track loaded successfully:", msg.title);
          state.guestAudioReady = true;
          
          // PHASE 3: Send CLIENT_READY with buffer info
          sendClientReady();
          
          // Also send on canplaythrough event for better buffer estimates
          audioEl.addEventListener('canplaythrough', () => {
            sendClientReady();
          }, { once: true });
        })
        .catch((error) => {
          console.error("[PREPARE_PLAY] Failed to load track after retries:", error);
          state.guestAudioReady = false;
          
          // PHASE 3: Send CLIENT_NOT_READY on failure
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
              t: 'CLIENT_NOT_READY',
              trackId: trackId,
              reason: error.message || 'Failed to load track'
            }));
          }
        });
    }
    
    return;
  }
  
  // PLAY_AT: Compute expected position and start playback
  if (msg.t === "PLAY_AT") {
    console.log("[PLAY_AT] Starting playback at server time:", msg.startAtServerMs);
    
    state.playing = true;
    state.lastHostEvent = "PLAY_AT";
    
    // PHASE 7: Apply latency compensation for Bluetooth devices
    const compensatedStartMs = applyLatencyCompensation(msg.startAtServerMs);
    
    // Store sync info for drift correction (use original, not compensated)
    state.pendingStartAtServerMs = msg.startAtServerMs;
    state.pendingStartPositionSec = msg.startPositionSec || 0;
    
    // Compute expected position based on server clock (use compensated for scheduling)
    const serverNow = nowServerMs();
    const elapsedSec = (serverNow - compensatedStartMs) / 1000;
    const expectedSec = Math.max(0, (msg.startPositionSec || 0) + elapsedSec);
    
    console.log(`[PLAY_AT] Expected position: ${expectedSec.toFixed(2)}s (elapsed: ${elapsedSec.toFixed(2)}s)`);
    
    // Update UI
    if (!state.isHost) {
      updateGuestPlaybackState("PLAYING");
      updateGuestVisualMode("playing");
      if (msg.title || msg.filename) {
        updateGuestNowPlaying(msg.title || msg.filename);
      }
    }
    
    // Start playback if we have audio
    if (state.guestAudioElement && msg.trackUrl) {
      const audioEl = state.guestAudioElement;
      
      // Function to start playback with computed position
      const startPlayback = () => {
        // Re-compute expected position in case time passed
        const nowServer = nowServerMs();
        const elapsed = (nowServer - msg.startAtServerMs) / 1000;
        const targetSec = Math.max(0, (msg.startPositionSec || 0) + elapsed);
        
        console.log(`[PLAY_AT] Starting playback at ${targetSec.toFixed(2)}s`);
        
        // Set position if metadata is ready
        if (audioEl.duration && !isNaN(audioEl.duration)) {
          clampAndSeekAudio(audioEl, targetSec);
        } else {
          console.warn("[PLAY_AT] Duration not ready, setting position anyway");
          audioEl.currentTime = targetSec;
        }
        
        // Try to play
        const playPromise = audioEl.play();
        
        if (playPromise !== undefined) {
          playPromise.then(() => {
            console.log("[PLAY_AT] Playback started successfully");
            unlockAudioPlayback();
            
            // Start drift correction
            startDriftCorrection(msg.startAtServerMs, msg.startPositionSec || 0);
          }).catch(err => {
            console.warn("[PLAY_AT] Autoplay blocked:", err);
            
            // Store expected position for later recovery
            state.pendingExpectedSec = targetSec;
            state.guestNeedsTap = true;
            
            // Show "Tap to Sync" overlay with sync info
            handleAutoplayBlocked(audioEl, msg.title || msg.filename, msg.startAtServerMs, msg.startPositionSec || 0);
          });
        }
      };
      
      // If metadata is ready, start immediately
      if (audioEl.duration && !isNaN(audioEl.duration)) {
        startPlayback();
      } else {
        // Wait for metadata
        console.log("[PLAY_AT] Waiting for metadata...");
        const metadataHandler = () => {
          console.log("[PLAY_AT] Metadata loaded, starting playback");
          startPlayback();
        };
        audioEl.addEventListener('loadedmetadata', metadataHandler, { once: true });
      }
    } else if (!msg.trackUrl) {
      toast("Host is playing locally - no audio sync available");
    }
    
    return;
  }
  
  // SYNC_STATE: Response to late joiner or manual sync request
  if (msg.t === "SYNC_STATE") {
    console.log("[SYNC_STATE] Received sync state:", msg.status);
    
    // Update track info if available
    if (msg.track) {
      state.nowPlayingFilename = msg.track.title || msg.track.filename;
      if (!state.isHost) {
        updateGuestNowPlaying(state.nowPlayingFilename);
      }
    }
    
    // Update queue if available
    if (msg.queue) {
      musicState.queue = msg.queue;
      if (!state.isHost) {
        updateGuestQueue(msg.queue);
      }
    }
    
    // Handle based on status
    if (msg.status === 'playing' && msg.track && msg.startAtServerMs) {
      console.log("[SYNC_STATE] Host is playing - syncing to current position");
      
      state.playing = true;
      state.pendingStartAtServerMs = msg.startAtServerMs;
      state.pendingStartPositionSec = msg.startPositionSec || 0;
      
      // Compute expected position using server clock
      const serverNow = nowServerMs();
      const elapsedSec = (serverNow - msg.startAtServerMs) / 1000;
      const expectedSec = Math.max(0, (msg.startPositionSec || 0) + elapsedSec);
      
      console.log(`[SYNC_STATE] Expected position: ${expectedSec.toFixed(2)}s (elapsed: ${elapsedSec.toFixed(2)}s)`);
      
      if (!state.isHost) {
        updateGuestPlaybackState("PLAYING");
        updateGuestVisualMode("playing");
      }
      
      // Trigger audio playback with sync
      if (msg.track.trackUrl) {
        const trackUrl = msg.track.trackUrl;
        
        // Create or reuse audio element
        if (!state.guestAudioElement) {
          state.guestAudioElement = new Audio();
          state.guestAudioElement.volume = (state.guestVolume || 80) / 100;
        }
        
        // Set source and prepare if different
        if (state.guestAudioElement.src !== trackUrl) {
          state.guestAudioElement.src = trackUrl;
          state.guestAudioElement.load();
        }
        
        // Wait for metadata then sync and play
        const startPlayback = () => {
          // Re-compute position in case time passed
          const nowServer = nowServerMs();
          const elapsed = (nowServer - msg.startAtServerMs) / 1000;
          const targetSec = Math.max(0, (msg.startPositionSec || 0) + elapsed);
          
          clampAndSeekAudio(state.guestAudioElement, targetSec);
          
          state.guestAudioElement.play()
            .then(() => {
              console.log("[SYNC_STATE] Playing from position:", targetSec.toFixed(2), "s");
              unlockAudioPlayback();
              
              // Start drift correction
              startDriftCorrection(msg.startAtServerMs, msg.startPositionSec || 0);
            })
            .catch(err => {
              console.warn("[SYNC_STATE] Autoplay blocked:", err);
              state.pendingExpectedSec = targetSec;
              state.guestNeedsTap = true;
              
              // Show "Tap to Sync" overlay with sync info
              handleAutoplayBlocked(state.guestAudioElement, msg.track.title || msg.track.filename, msg.startAtServerMs, msg.startPositionSec || 0);
            });
        };
        
        if (state.guestAudioElement.duration && !isNaN(state.guestAudioElement.duration)) {
          startPlayback();
        } else {
          state.guestAudioElement.addEventListener('loadedmetadata', startPlayback, { once: true });
        }
      }
    } else if (msg.status === 'preparing' && msg.track && msg.startAtServerMs) {
      console.log("[SYNC_STATE] Track is preparing - will start at", msg.startAtServerMs);
      
      // Store pending info (PREPARE_PLAY logic)
      state.pendingStartAtServerMs = msg.startAtServerMs;
      state.pendingStartPositionSec = msg.startPositionSec || 0;
      state.pendingTrackUrl = msg.track.trackUrl;
      state.pendingTrackTitle = msg.track.title || msg.track.filename;
      
      if (!state.isHost) {
        updateGuestPlaybackState("PREPARING");
      }
      
      // Pre-load audio if we have a track URL
      if (msg.track.trackUrl) {
        if (!state.guestAudioElement) {
          state.guestAudioElement = new Audio();
          state.guestAudioElement.volume = (state.guestVolume || 80) / 100;
        }
        
        if (state.guestAudioElement.src !== msg.track.trackUrl) {
          state.guestAudioElement.src = msg.track.trackUrl;
          state.guestAudioElement.load();
        }
      }
    } else if (msg.status === 'paused' && msg.track) {
      console.log("[SYNC_STATE] Track is paused at position:", msg.pausedPositionSec);
      
      state.playing = false;
      
      if (!state.isHost) {
        updateGuestPlaybackState("PAUSED");
        updateGuestVisualMode("paused");
      }
      
      // Sync to paused position
      if (msg.track.trackUrl && msg.pausedPositionSec !== undefined) {
        if (!state.guestAudioElement) {
          state.guestAudioElement = new Audio();
          state.guestAudioElement.volume = (state.guestVolume || 80) / 100;
        }
        
        if (state.guestAudioElement.src !== msg.track.trackUrl) {
          state.guestAudioElement.src = msg.track.trackUrl;
          state.guestAudioElement.load();
        }
        
        const syncPaused = () => {
          if (state.guestAudioElement.duration) {
            clampAndSeekAudio(state.guestAudioElement, msg.pausedPositionSec);
            state.guestAudioElement.pause();
          }
        };
        
        if (state.guestAudioElement.duration && !isNaN(state.guestAudioElement.duration)) {
          syncPaused();
        } else {
          state.guestAudioElement.addEventListener('loadedmetadata', syncPaused, { once: true });
        }
      }
      
      // Stop drift correction when paused
      stopDriftCorrection();
    } else {
      console.log("[SYNC_STATE] Track is stopped or no track");
      state.playing = false;
      
      if (!state.isHost) {
        updateGuestPlaybackState("STOPPED");
        updateGuestVisualMode("stopped");
      }
      
      stopDriftCorrection();
    }
    
    return;
  }
  
  // PHASE 4: SYNC_TICK - Drift correction servo
  if (msg.t === "SYNC_TICK") {
    const audio = state.guestAudioElement;
    if (!audio || !msg.trackId) return;
    
    // Guard: Only apply if audio loaded and trackId matches current track
    if (audio.readyState < 2 || audio.paused || audio.seeking) {
      return;
    }
    
    // Calculate expected position using server offset
    const nowMs = Date.now();
    const serverOffset = state.serverOffsetMs || 0;
    const adjustedServerMs = nowMs + serverOffset;
    const elapsedSec = (adjustedServerMs - msg.startedAtServerMs) / 1000;
    const expectedPositionSec = msg.expectedPositionSec || elapsedSec;
    
    // Calculate drift
    const currentPos = audio.currentTime;
    const error = currentPos - expectedPositionSec;
    const absError = Math.abs(error);
    
    // Apply correction rules
    if (absError < 0.06) {
      // No correction needed
      return;
    } else if (absError >= 0.06 && absError < 0.20) {
      // Gentle playbackRate nudge for 1 second
      if (error < 0) {
        // Behind - speed up
        audio.playbackRate = 1.02;
        console.log(`[SYNC_TICK] Behind by ${absError.toFixed(3)}s, nudging to 1.02x`);
      } else {
        // Ahead - slow down
        audio.playbackRate = 0.98;
        console.log(`[SYNC_TICK] Ahead by ${absError.toFixed(3)}s, nudging to 0.98x`);
      }
      
      // Reset after 1 second
      setTimeout(() => {
        if (audio && !audio.paused && !audio.seeking) {
          audio.playbackRate = 1.0;
        }
      }, 1000);
    } else if (absError >= 0.20) {
      // Hard correction - seek to expected position
      if (!audio.seeking) {
        console.log(`[SYNC_TICK] Large drift ${absError.toFixed(3)}s, seeking to ${expectedPositionSec.toFixed(2)}s`);
        audio.currentTime = expectedPositionSec;
      }
    }
    
    return;
  }
  
  // PHASE 5: STATE_SNAPSHOT - Full state after RESUME
  if (msg.t === "STATE_SNAPSHOT") {
    console.log("[STATE_SNAPSHOT] Received full party state, eventId:", msg.eventId);
    
    // Update eventId
    if (msg.eventId && state.partyCode) {
      const storageKey = `lastEventId:${state.partyCode}`;
      localStorage.setItem(storageKey, msg.eventId.toString());
    }
    
    // Apply party state
    if (msg.partyState) {
      const ps = msg.partyState;
      
      // Update current track
      if (ps.currentTrack) {
        state.nowPlayingFilename = ps.currentTrack.title || ps.currentTrack.filename;
        if (!state.isHost) {
          updateGuestNowPlaying(state.nowPlayingFilename);
        }
        
        // If track is playing, sync to it
        if (ps.currentTrack.status === 'playing' && ps.currentTrack.startAtServerMs) {
          console.log("[STATE_SNAPSHOT] Track is playing, syncing...");
          state.playing = true;
          state.pendingStartAtServerMs = ps.currentTrack.startAtServerMs;
          state.pendingStartPositionSec = ps.currentTrack.startPositionSec || 0;
          state.pendingTrackUrl = ps.currentTrack.trackUrl;
          
          // Compute current position and start playing
          if (state.guestAudioElement && ps.currentTrack.trackUrl) {
            const audio = state.guestAudioElement;
            const nowMs = Date.now();
            const serverOffset = state.serverOffsetMs || 0;
            const adjustedServerMs = nowMs + serverOffset;
            const elapsedSec = (adjustedServerMs - ps.currentTrack.startAtServerMs) / 1000;
            const targetSec = (ps.currentTrack.startPositionSec || 0) + elapsedSec;
            
            audio.src = ps.currentTrack.trackUrl;
            audio.currentTime = targetSec;
            audio.play().catch(err => console.warn("[STATE_SNAPSHOT] Autoplay blocked:", err));
            
            if (!state.isHost) {
              updateGuestPlaybackState("PLAYING");
            }
          }
        }
      }
      
      // Update queue
      if (ps.queue) {
        musicState.queue = ps.queue;
        if (!state.isHost) {
          updateGuestQueue(ps.queue);
        }
      }
    }
    
    return;
  }

  // YOUTUBE PARTY PLAYER — incoming sync messages
  if (msg.t === "YOUTUBE_VIDEO") {
    // Guest receives: host loaded a new video
    console.log("[YouTubePlayer] Guest received YOUTUBE_VIDEO:", msg.videoId);
    if (!state.isHost) {
      ytGuestLoadVideo(msg.videoId, msg.title || null);
    }
    return;
  }

  if (msg.t === "YOUTUBE_PLAY") {
    // Guest receives: host pressed play
    console.log("[YouTubePlayer] Guest received YOUTUBE_PLAY at", msg.currentTime);
    if (!state.isHost) {
      ytGuestPlay(msg.currentTime || 0);
    }
    return;
  }

  if (msg.t === "YOUTUBE_PAUSE") {
    // Guest receives: host pressed pause
    console.log("[YouTubePlayer] Guest received YOUTUBE_PAUSE");
    if (!state.isHost) {
      ytGuestPause();
    }
    return;
  }
}

function showHome() {
  hide("viewLanding"); 
  hide("viewChooseTier");
  hide("viewPayment");
  hide("viewAccountCreation");
  show("viewHome"); 
  hide("viewAuthHome");
  hide("viewParty");
  hide("viewGuest");
  state.code = null; state.isHost = false; state.playing = false; state.adActive = false;
  state.snapshot = null; state.partyPro = false; state.offlineMode = false;
  state.connected = false;
  state.nowPlayingFilename = null;
  state.upNextFilename = null;
  state.playbackState = "STOPPED";
  state.lastHostEvent = null;
  state.visualMode = "idle";
  
  // Cleanup audio and ObjectURL
  cleanupMusicPlayer();
  
  // Clear Party Pass state when leaving party
  if (state.partyPassTimerInterval) {
    clearInterval(state.partyPassTimerInterval);
    state.partyPassTimerInterval = null;
  }
  state.partyPassActive = false;
  state.partyPassEndTime = null;
  
  // Stop party status polling
  stopPartyStatusPolling();
  
  setPlanPill();
}

function showLanding() {
  show("viewLanding"); 
  hide("viewHome"); 
  hide("viewAuthHome");
  hide("viewParty");
  hide("viewGuest");
  hide("viewChooseTier");
  hide("viewPayment");
  hide("viewAccountCreation");
  state.code = null; state.isHost = false; state.playing = false; state.adActive = false;
  state.snapshot = null; state.partyPro = false; state.offlineMode = false;
  state.connected = false;
  state.nowPlayingFilename = null;
  state.upNextFilename = null;
  state.playbackState = "STOPPED";
  state.lastHostEvent = null;
  state.visualMode = "idle";
  
  // Cleanup audio and ObjectURL
  cleanupMusicPlayer();
  
  // Cleanup guest audio element
  cleanupGuestAudio();
  
  // Clear guest session from localStorage (only if not navigating back from reconnect check)
  if (!state.isReconnecting) {
    try {
      const session = localStorage.getItem('syncSpeakerGuestSession');
      if (session) {
        console.log("[Guest] Clearing session - returning to landing");
        localStorage.removeItem('syncSpeakerGuestSession');
      }
    } catch (error) {
      console.warn("[Guest] Failed to clear session:", error);
    }
  }
  state.isReconnecting = false;
  
  // Clear Party Pass state when leaving party
  if (state.partyPassTimerInterval) {
    clearInterval(state.partyPassTimerInterval);
    state.partyPassTimerInterval = null;
  }
  state.partyPassActive = false;
  state.partyPassEndTime = null;
  
  // Stop party status polling
  stopPartyStatusPolling();
  
  setPlanPill();
}

function showParty() {
  hide("viewLanding"); 
  hide("viewHome"); 
  hide("viewAuthHome");
  hide("viewChooseTier");
  hide("viewPayment");
  show("viewParty");

  // Track first-party-join for referral system (fires only once per session)
  try {
    if (!sessionStorage.getItem('referral_party_tracked')) {
      sessionStorage.setItem('referral_party_tracked', '1');
      fetch(API_BASE + '/api/referral/party-first-join', {
        method: 'POST',
        credentials: 'include'
      }).then(r => r.json()).then(data => {
        if (data.rewarded && data.reward && window._referralUI) {
          window._referralUI._checkAndCelebrate(
            (data.total || 1) - 1, data.total || 1
          );
        }
        // Clean up stored referral keys after completion
        try { localStorage.removeItem('referral_code'); localStorage.removeItem('referral_click_id'); } catch (_) {}
      }).catch(() => {});
    }
  } catch (_) { /* non-fatal */ }
  // Update URL to /party/:code so back button and refresh work
  if (state.code && typeof history !== 'undefined') {
    var partyPath = '/party/' + state.code;
    if (window.location.pathname !== partyPath) {
      history.pushState({ path: partyPath }, '', partyPath);
    }
  }
  el("partyTitle").textContent = state.isHost ? "Host party" : "Guest party";
  
  // Display offline/local mode message
  if (state.offlineMode && state.isHost) {
    el("partyMeta").textContent = "Party created locally (offline mode)";
    el("partyMeta").style.color = "var(--accent, #5AA9FF)";
    
    // Show offline warning banner
    const warningEl = el("offlineWarning");
    if (warningEl) {
      warningEl.style.display = "flex";
    }
  } else {
    el("partyMeta").textContent = `Source: ${state.source} · You: ${state.name}${state.isHost ? " (Host)" : ""}`;
    el("partyMeta").style.color = "";
    
    // Hide offline warning banner
    const warningEl = el("offlineWarning");
    if (warningEl) {
      warningEl.style.display = "none";
    }
  }
  
  el("partyCode").textContent = state.code || "------";
  
  // Initialize music player now that viewParty is visible
  // This ensures the audio element reference is properly set
  initializeMusicPlayer();
  
  // Check if Party Pass is active for this party
  checkPartyPassStatus();
  
  setPlanPill();
  updatePartyPassUI();
  renderRoom();
  updatePlaybackUI();
  updateQualityUI();
  
  // Initialize session stats when party starts
  if (!state.sessionStats.startTime) {
    initSessionStats();
  }
  
  // Show host-only features
  if (state.isHost) {
    const crowdEnergyCard = el("crowdEnergyCard");
    const djMomentsCard = el("djMomentsCard");
    const hostGiftSection = el("hostGiftSection");
    
    const hasPartyPass = hasPartyPassEntitlement();
    
    // DJ Profile features (Crowd Energy & DJ Moments) only for users with Party Pass entitlement
    if (hasPartyPass) {
      if (crowdEnergyCard) crowdEnergyCard.classList.remove("hidden");
      if (djMomentsCard) djMomentsCard.classList.remove("hidden");
    } else {
      // FREE tier: hide DJ profile features
      if (crowdEnergyCard) crowdEnergyCard.classList.add("hidden");
      if (djMomentsCard) djMomentsCard.classList.add("hidden");
    }
    
    // Show gift section only if user doesn't have Party Pass entitlement
    if (hostGiftSection && !hasPartyPass) {
      hostGiftSection.classList.remove("hidden");
    }
    
    // Start polling for party status updates (guest joins)
    startPartyStatusPolling();
  }

  // Initialize YouTube Party Player section
  updateYoutubePartySection();
  initYoutubePartyControls();
  loadYouTubeIframeAPI();
}

// Show tier selection screen
function showChooseTier() {
  hide("viewLanding");
  hide("viewHome");
  hide("viewAuthHome");
  hide("viewParty");
  hide("viewGuest");
  hide("viewPayment");
  hide("viewAccountCreation");
  show("viewChooseTier");
}

// Show account creation screen
function showAccountCreation() {
  hide("viewLanding");
  hide("viewHome");
  hide("viewAuthHome");
  hide("viewParty");
  hide("viewGuest");
  hide("viewPayment");
  hide("viewChooseTier");
  show("viewAccountCreation");
  
  // Update the selected tier display
  updateSelectedTierDisplay();
}

// Update selected tier display on account creation page
function updateSelectedTierDisplay() {
  const tierInfo = el("selectedTierInfo");
  const tierBadge = tierInfo.querySelector(".selected-tier-badge");
  const tierDetails = tierInfo.querySelector(".selected-tier-details");
  
  if (state.selectedTier === USER_TIER.FREE) {
    tierBadge.textContent = "FREE MODE";
    tierDetails.textContent = "2 phones · Unlimited time · Basic features";
  } else if (state.selectedTier === USER_TIER.PARTY_PASS) {
    tierBadge.textContent = "PARTY PASS";
    tierDetails.textContent = "£3.99 · Up to 4 phones · 2 hours"; // GBP - Party Pass pricing
  } else if (state.selectedTier === USER_TIER.PRO) {
    tierBadge.textContent = "PRO MONTHLY";
    tierDetails.textContent = "£9.99/month · 12+ phones · Full features"; // GBP - Pro Monthly pricing
  }
}

// Show payment screen
function showPayment() {
  hide("viewLanding");
  hide("viewHome");
  hide("viewAuthHome");
  hide("viewParty");
  hide("viewGuest");
  hide("viewChooseTier");
  hide("viewAccountCreation");
  show("viewPayment");
}

// Start polling party status for updates (both host and guest)
function startPartyStatusPolling() {
  // Don't poll in offline mode
  if (state.offlineMode) {
    return;
  }
  
  // Clear any existing polling interval
  if (state.partyStatusPollingInterval) {
    clearInterval(state.partyStatusPollingInterval);
    state.partyStatusPollingInterval = null;
  }
  
  // Reset polling flag
  state.partyStatusPollingInProgress = false;
  
  console.log(`[Polling] Starting party status polling (${state.isHost ? 'host' : 'guest'} mode)`);
  
  // Poll every 2 seconds
  state.partyStatusPollingInterval = setInterval(async () => {
    // Skip if previous poll is still in progress
    if (state.partyStatusPollingInProgress) {
      return;
    }
    
    state.partyStatusPollingInProgress = true;
    try {
      if (!state.code) {
        // Stop polling if no party code
        stopPartyStatusPolling();
        return;
      }
      
      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      
      // Use /api/party-state for enhanced info including playback state
      const cacheBuster = Date.now();
      const response = await fetch(API_BASE + `/api/party-state?code=${state.code}&t=${cacheBuster}`, {
        signal: controller.signal,
        headers: {
          'Cache-Control': 'no-store'
        }
      });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        console.warn("[Polling] Failed to fetch party state:", response.status);
        return;
      }
      
      const data = await response.json();
      
      if (data.exists) {
        // Update party state
        const previousGuestCount = state.snapshot?.guestCount || 0;
        const newGuestCount = data.guestCount || 0;
        
        // Initialize snapshot if needed
        if (!state.snapshot) {
          state.snapshot = { members: [] };
        }
        
        // Update snapshot with party data
        state.snapshot.guestCount = newGuestCount;
        state.snapshot.chatMode = data.chatMode;
        state.snapshot.status = data.status;
        state.snapshot.expiresAt = data.expiresAt;
        state.snapshot.timeRemainingMs = data.timeRemainingMs;
        
        // Convert guests array to members format for compatibility
        if (data.guests) {
          state.snapshot.members = data.guests.map((guest, index) => ({
            id: guest.guestId,
            name: guest.nickname,
            isPro: false,
            isHost: false
          }));
          // Add host to members if not already there
          if (!state.snapshot.members.some(m => m.isHost)) {
            state.snapshot.members.unshift({
              id: 'host',
              name: 'Host',
              isPro: false,
              isHost: true
            });
          }
        }
        
        // Log when guests join or leave (host only)
        if (state.isHost && newGuestCount !== previousGuestCount) {
          console.log(`[Polling] Guest count changed: ${previousGuestCount} → ${newGuestCount}`);
          if (newGuestCount > previousGuestCount) {
            toast(`🎉 Guest joined (${newGuestCount} total)`);
          }
        }
        
        // Guest-specific: Handle playback state updates from polling
        if (!state.isHost && data.currentTrack) {
          const track = data.currentTrack;
          
          // Check if this is a new track or track start
          if (track.filename !== state.nowPlayingFilename) {
            console.log("[Polling] New track detected:", track.filename);
            state.nowPlayingFilename = track.filename;
            updateGuestNowPlaying(track.filename);
            
            // If track has URL, prepare guest audio
            if (track.url) {
              handleGuestAudioPlayback(track.url, track.filename, track.startAtServerMs, track.startPosition);
            }
          }
        }
        
        // Check for DJ messages
        if (data.djMessages && data.djMessages.length > 0) {
          // Only show new messages (check timestamp)
          const lastMessageTimestamp = state.lastDjMessageTimestamp || 0;
          let maxTimestamp = lastMessageTimestamp;
          
          data.djMessages.forEach(msg => {
            if (msg.timestamp > lastMessageTimestamp) {
              displayDjMessage(msg.message, msg.type);
              maxTimestamp = Math.max(maxTimestamp, msg.timestamp);
            }
          });
          
          // Update timestamp once after loop
          state.lastDjMessageTimestamp = maxTimestamp;
        }
        
        // Update host guest count display with detailed party information
        const guestCountEl = el("partyGuestCount");
        if (guestCountEl) {
          const currentLimit = getCurrentPhoneLimit();
          const totalConnected = newGuestCount + 1; // guests + host
          const remaining = Math.max(0, currentLimit - totalConnected);
          
          // Determine party tier status
          let tierInfo = '';
          if (state.userTier === USER_TIER.PRO) {
            tierInfo = 'Pro';
          } else if (state.userTier === USER_TIER.PARTY_PASS || state.partyPassActive) {
            tierInfo = 'Party Pass active';
          } else {
            tierInfo = 'Free party';
          }
          
          if (newGuestCount === 0) {
            guestCountEl.textContent = `${tierInfo} · Waiting for guests... (${currentLimit} phone limit)`;
          } else {
            guestCountEl.textContent = `${tierInfo} · ${totalConnected} of ${currentLimit} phones connected`;
            if (remaining > 0) {
              guestCountEl.textContent += ` (${remaining} more can join)`;
            } else {
              guestCountEl.textContent += ` (party full)`;
            }
          }
        }
        
        // Check for expired/ended status
        if (data.status === "expired" || data.status === "ended") {
          console.log(`[Polling] Party ${data.status}, stopping polling`);
          stopPartyStatusPolling();
          showPartyEnded(data.status);
          return;
        }
        
        // Re-render room to show updated member list
        renderRoom();
        updatePartyTimeRemaining(data.timeRemainingMs);
      } else {
        console.log("[Polling] Party no longer exists, stopping polling");
        stopPartyStatusPolling();
        showPartyEnded("expired");
      }
    } catch (error) {
      console.error("[Polling] Error fetching party status:", error);
    } finally {
      state.partyStatusPollingInProgress = false;
    }
  }, 2000); // 2 seconds interval
}

// Stop polling party status
function stopPartyStatusPolling() {
  if (state.partyStatusPollingInterval) {
    console.log("[Polling] Stopping party status polling");
    clearInterval(state.partyStatusPollingInterval);
    state.partyStatusPollingInterval = null;
    state.partyStatusPollingInProgress = false;
  }
}

// Helper: Check if track has valid paused position
function hasPausedPosition(track) {
  return track && track.pausedPositionSec != null; // Checks for both undefined and null
}

// Helper: Check if guest audio can auto-resume (is paused and unlocked)
function canResumeGuestAudio() {
  return state.guestAudioElement && 
         state.guestAudioElement.paused && 
         state.audioUnlocked;
}

// Helper: Handle playing track from polling
function handlePlayingTrackFromPolling(track) {
  // Check if this is a new track or track start
  if (track.filename !== state.nowPlayingFilename) {
    console.log("[Polling] New track detected:", track.filename);
    state.nowPlayingFilename = track.filename;
    updateGuestNowPlaying(track.filename);
    
    // If track has URL, prepare guest audio
    if (track.url) {
      handleGuestAudioPlayback(track.url, track.filename, track.startAtServerMs, track.startPosition);
    } else {
      // No URL - host playing local file
      toast("🎵 Host is playing: " + track.filename);
    }
  } else if (canResumeGuestAudio()) {
    // Track is same but guest audio is paused while host is playing - resume with sync
    console.log("[Polling] Resuming paused audio to match host playing state");
    const elapsedSec = (Date.now() - track.startAtServerMs) / 1000;
    const targetSec = (track.startPosition || 0) + elapsedSec;
    clampAndSeekAudio(state.guestAudioElement, targetSec);
    state.guestAudioElement.play().catch(err => {
      console.warn("[Polling] Could not auto-resume:", err);
    });
  }
}

// Helper: Handle paused track from polling
function handlePausedTrackFromPolling(track) {
  // Host paused - ensure guest is also paused at correct position
  if (state.guestAudioElement && !state.guestAudioElement.paused) {
    console.log("[Polling] Pausing guest audio to match host");
    state.guestAudioElement.pause();
    if (hasPausedPosition(track)) {
      clampAndSeekAudio(state.guestAudioElement, track.pausedPositionSec);
    }
  }
}

// Helper: Handle stopped track from polling
function handleStoppedTrackFromPolling(track) {
  // Host stopped - ensure guest is also stopped
  if (state.guestAudioElement) {
    console.log("[Polling] Stopping guest audio to match host");
    state.guestAudioElement.pause();
    state.guestAudioElement.currentTime = 0;
    stopDriftCorrection();
  }
}

// Start polling party status for guests
function startGuestPartyStatusPolling() {
  // Only poll for guests
  if (state.isHost) {
    return;
  }
  
  // Clear any existing polling interval
  if (state.partyStatusPollingInterval) {
    clearInterval(state.partyStatusPollingInterval);
    state.partyStatusPollingInterval = null;
  }
  
  // Reset polling flag
  state.partyStatusPollingInProgress = false;
  
  console.log("[Polling] Starting guest party status polling");
  
  // Poll every 2 seconds
  state.partyStatusPollingInterval = setInterval(async () => {
    // Skip if previous poll is still in progress
    if (state.partyStatusPollingInProgress) {
      return;
    }
    
    state.partyStatusPollingInProgress = true;
    try {
      if (!state.code || state.isHost) {
        // Stop polling if no party code or became host
        stopPartyStatusPolling();
        return;
      }
      
      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      
      // Use enhanced /api/party-state endpoint with cache buster
      const cacheBuster = Date.now();
      const response = await fetch(API_BASE + `/api/party-state?code=${state.code}&t=${cacheBuster}`, {
        signal: controller.signal,
        headers: {
          'Cache-Control': 'no-store'
        }
      });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        console.warn("[Polling] Failed to fetch party state:", response.status);
        return;
      }
      
      const data = await response.json();
      
      if (data.exists) {
        // Update party state for guest
        const previousGuestCount = state.snapshot?.guestCount || 0;
        const newGuestCount = data.guestCount || 0;
        
        // Initialize snapshot if needed
        if (!state.snapshot) {
          state.snapshot = { members: [] };
        }
        
        // Update snapshot with party data
        const previousChatMode = state.chatMode || "OPEN";
        state.snapshot.guestCount = newGuestCount;
        state.snapshot.chatMode = data.chatMode;
        state.snapshot.status = data.status;
        state.snapshot.expiresAt = data.expiresAt;
        state.snapshot.timeRemainingMs = data.timeRemainingMs;
        
        // Update chat mode if changed
        if (data.chatMode && data.chatMode !== previousChatMode) {
          console.log(`[Polling] Chat mode changed: ${previousChatMode} → ${data.chatMode}`);
          state.chatMode = data.chatMode;
          updateChatModeUI();
        }
        
        // Log when guests join or leave
        if (newGuestCount !== previousGuestCount) {
          console.log(`[Polling] Guest count changed: ${previousGuestCount} → ${newGuestCount}`);
        }
        
        // Handle playback state updates from polling (fallback if WebSocket not available)
        if (data.currentTrack) {
          const track = data.currentTrack;
          
          // Handle different playback statuses
          if (track.status === 'playing') {
            handlePlayingTrackFromPolling(track);
          } else if (track.status === 'paused') {
            handlePausedTrackFromPolling(track);
          } else if (track.status === 'stopped') {
            handleStoppedTrackFromPolling(track);
          }
        }
        
        // Check for DJ messages
        if (data.djMessages && data.djMessages.length > 0) {
          // Only show new messages (check timestamp)
          const lastMessageTimestamp = state.lastDjMessageTimestamp || 0;
          let maxTimestamp = lastMessageTimestamp;
          
          data.djMessages.forEach(msg => {
            if (msg.timestamp > lastMessageTimestamp) {
              displayDjMessage(msg.message, msg.type);
              maxTimestamp = Math.max(maxTimestamp, msg.timestamp);
            }
          });
          
          // Update timestamp once after loop
          state.lastDjMessageTimestamp = maxTimestamp;
        }
        
        // Check for expired/ended status
        if (data.status === "expired" || data.status === "ended") {
          console.log(`[Polling] Party ${data.status}, stopping polling`);
          stopPartyStatusPolling();
          showPartyEnded(data.status);
          return;
        }
        
        // Update guest UI
        updateGuestPartyInfo(data);
      } else {
        console.log("[Polling] Party no longer exists, stopping polling");
        stopPartyStatusPolling();
        showPartyEnded("expired");
      }
    } catch (error) {
      console.error("[Polling] Error fetching party status:", error);
    } finally {
      state.partyStatusPollingInProgress = false;
    }
  }, 2000); // 2 seconds interval
}

// Update guest party info UI
function updateGuestPartyInfo(partyData) {
  // Update guest count display with detailed information
  const guestCountEl = el("guestPartyGuestCount");
  if (guestCountEl) {
    const guestCount = partyData.guestCount || 0;
    const totalConnected = guestCount + 1; // guests + host
    
    // Get current phone limit (we may not have full state, so estimate based on party data)
    // This should be enhanced to get actual limit from server response
    let currentLimit = FREE_LIMIT; // default
    if (state.partyPassActive || (partyData.partyPassActive)) {
      currentLimit = PARTY_PASS_LIMIT;
    } else if (state.userTier === USER_TIER.PRO || (partyData.isPro)) {
      currentLimit = PRO_LIMIT;
    }
    
    const remaining = Math.max(0, currentLimit - totalConnected);
    
    guestCountEl.textContent = `${totalConnected} of ${currentLimit} phones connected`;
    if (remaining > 0) {
      guestCountEl.textContent += ` (${remaining} more can join)`;
    } else {
      guestCountEl.textContent += ` (party full)`;
    }
  }
  
  // Update time remaining
  if (partyData.timeRemainingMs) {
    updatePartyTimeRemaining(partyData.timeRemainingMs);
  }
  
  // Update status if needed
  updateGuestPartyStatus();
}

// Show party ended/expired screen
function showPartyEnded(status) {
  const message = status === "expired" ? "Party has expired" : "Party has ended";
  toast(`⏰ ${message}`);
  
  // Update connection status for guests
  if (!state.isHost) {
    updateGuestConnectionStatus('party-ended');
  }
  
  // Show message in UI
  const partyMetaEl = el("partyMeta");
  if (partyMetaEl) {
    partyMetaEl.textContent = message;
    partyMetaEl.style.color = "var(--danger, #ff5a6a)";
  }
  
  // Show end-of-party upsell after a short delay
  setTimeout(() => {
    showEndOfPartyUpsell();
  }, 2000);
  
  // Reset party monetization
  resetPartyMonetization();
  
  // For guests, show on their screen too
  const guestPartyStatusEl = el("guestPartyStatusText");
  if (guestPartyStatusEl && !state.isHost) {
    guestPartyStatusEl.textContent = message;
  }
  
  // Could navigate back to landing after a delay
  setTimeout(() => {
    showLanding();
  }, 3000);
}

// Update party time remaining display
function updatePartyTimeRemaining(timeRemainingMs) {
  // Update host view
  const hostTimerEl = el("partyTimeRemaining");
  if (hostTimerEl && state.isHost) {
    const minutes = Math.floor(timeRemainingMs / 60000);
    const seconds = Math.floor((timeRemainingMs % 60000) / 1000);
    hostTimerEl.textContent = `${minutes}m ${seconds}s remaining`;
  }
  
  // Update guest view
  const guestTimerEl = el("guestTimeRemaining");
  if (guestTimerEl && !state.isHost) {
    const minutes = Math.floor(timeRemainingMs / 60000);
    const seconds = Math.floor((timeRemainingMs % 60000) / 1000);
    guestTimerEl.textContent = `${minutes}m ${seconds}s remaining`;
  }
}

function showGuest() {
  hide("viewLanding"); 
  hide("viewHome"); 
  hide("viewAuthHome");
  hide("viewParty"); 
  show("viewGuest");
  // Update URL so refresh stays in guest view
  if (state.code && typeof history !== 'undefined') {
    var guestPath = '/party/' + state.code;
    if (window.location.pathname !== guestPath) {
      history.pushState({ path: guestPath }, '', guestPath);
    }
  }
  
  // Update guest meta with DJ name if available
  if (state.djName) {
    el("guestMeta").textContent = `Vibing with DJ ${state.djName} 🎧 · You: ${state.guestNickname || state.name}`;
  } else {
    el("guestMeta").textContent = `You: ${state.guestNickname || state.name}`;
  }
  
  // Update party code
  el("guestPartyCode").textContent = state.code || "------";
  
  // Update connection status
  updateGuestConnectionStatus();
  
  // Update party status
  updateGuestPartyStatus();
  
  // Update tier badge and messaging permissions
  updateGuestTierUI();
  
  // Update chat mode UI to show/hide preset messages
  updateChatModeUI();
  
  // Initialize guest UI
  updateGuestNowPlaying(state.nowPlayingFilename);
  updateGuestUpNext(state.upNextFilename);
  updateGuestPlaybackState(state.playbackState);
  updateGuestVisualMode(state.visualMode);
  
  // Setup volume control
  setupGuestVolumeControl();
  
  // Initialize resync button to hidden (will show only when needed)
  state.showResyncButton = false;
  updateResyncButtonVisibility();
  
  setPlanPill();
  
  // Check if audio has been unlocked previously
  // If not unlocked and not already set, check stored state
  if (!state.audioUnlocked) {
    const wasUnlockedBefore = checkAudioUnlockState();
    if (wasUnlockedBefore) {
      console.log("[Guest] Audio was unlocked in previous session");
      // Note: We still need a user gesture to actually play, but we can be less intrusive
    } else {
      console.log("[Guest] Audio not yet unlocked - will show prompt when needed");
    }
  }
  
  // Start polling for guests to get party updates
  startGuestPartyStatusPolling();

  // Initialize guest YouTube player (loads API if not already loaded)
  loadYouTubeIframeAPI();
  initYouTubeGuestPlayer();
}

// Check if host is already playing when guest joins mid-track
async function checkForMidTrackJoin(code) {
  try {
    const response = await fetch(API_BASE + `/api/party-state?code=${code}`);
    const data = await response.json();

    // Late-join YouTube sync: if host already has a video selected, load it
    if (data.exists && data.youtubeSync && data.youtubeSync.videoId) {
      const ys = data.youtubeSync;
      console.log('[Mid-Track Join] YouTube sync state:', ys);
      ytGuestLoadVideo(ys.videoId, ys.title || null);
      // If host was playing, also seek to approximate position and play
      if (ys.isPlaying && ys.currentTime != null) {
        var elapsed = (Date.now() - (ys.updatedAtMs || Date.now())) / 1000;
        var targetTime = Math.max(0, (ys.currentTime || 0) + elapsed);
        setTimeout(function() {
          ytGuestPlay(targetTime);
        }, 1500); // Give player time to load
      }
    }
    
    if (data.exists && data.currentTrack) {
      const currentTrack = data.currentTrack;
      console.log("[Mid-Track Join] Party state:", currentTrack);
      
      // Update state
      state.nowPlayingFilename = currentTrack.title || currentTrack.filename;
      updateGuestNowPlaying(state.nowPlayingFilename);
      
      // Update queue if available
      if (data.queue) {
        updateGuestQueue(data.queue);
      }
      
      // Handle playback based on track status
      if (currentTrack.status === 'playing' && currentTrack.startAtServerMs) {
        console.log("[Mid-Track Join] Host is playing - syncing to current position");
        
        // Compute expected position using server clock
        const serverNow = nowServerMs();
        const elapsedSec = (serverNow - currentTrack.startAtServerMs) / 1000;
        const expectedSec = Math.max(0, (currentTrack.startPositionSec || currentTrack.startPosition || 0) + elapsedSec);
        
        console.log(`[Mid-Track Join] Expected position: ${expectedSec.toFixed(2)}s (elapsed: ${elapsedSec.toFixed(2)}s)`);
        
        // Trigger audio playback with sync
        if (currentTrack.url || currentTrack.trackUrl) {
          const trackUrl = currentTrack.url || currentTrack.trackUrl;
          
          // Create or reuse audio element
          if (!state.guestAudioElement) {
            state.guestAudioElement = new Audio();
            state.guestAudioElement.volume = (state.guestVolume || 80) / 100;
          }
          
          // Set source and prepare
          state.guestAudioElement.src = trackUrl;
          state.guestAudioElement.load();
          
          // Wait for metadata then sync and play
          const startPlayback = () => {
            // Re-compute position in case time passed
            const nowServer = nowServerMs();
            const elapsed = (nowServer - currentTrack.startAtServerMs) / 1000;
            const targetSec = Math.max(0, (currentTrack.startPositionSec || currentTrack.startPosition || 0) + elapsed);
            
            clampAndSeekAudio(state.guestAudioElement, targetSec);
            
            state.guestAudioElement.play()
              .then(() => {
                console.log("[Mid-Track Join] Playing from position:", targetSec.toFixed(2), "s");
                state.audioUnlocked = true;
                state.guestNeedsTap = false;
                state.playing = true;
                updateGuestPlaybackState("PLAYING");
                updateGuestVisualMode("playing");
                
                // Start drift correction
                startDriftCorrection(currentTrack.startAtServerMs, currentTrack.startPositionSec || currentTrack.startPosition || 0);
              })
              .catch(err => {
                console.warn("[Mid-Track Join] Autoplay blocked:", err);
                state.pendingExpectedSec = targetSec;
                state.guestNeedsTap = true;
                
                // Show "Tap to Sync" overlay with sync info
                handleAutoplayBlocked(state.guestAudioElement, currentTrack.title || currentTrack.filename, currentTrack.startAtServerMs, currentTrack.startPositionSec || currentTrack.startPosition || 0);
                
                state.playing = true;
                updateGuestPlaybackState("PLAYING");
                updateGuestVisualMode("playing");
              });
          };
          
          if (state.guestAudioElement.duration && !isNaN(state.guestAudioElement.duration)) {
            startPlayback();
          } else {
            state.guestAudioElement.addEventListener('loadedmetadata', startPlayback, { once: true });
          }
        }
      } else if (currentTrack.status === 'preparing' && currentTrack.startAtServerMs) {
        console.log("[Mid-Track Join] Track is preparing - will start at", currentTrack.startAtServerMs);
        
        // Store pending info (PREPARE_PLAY logic)
        state.pendingStartAtServerMs = currentTrack.startAtServerMs;
        state.pendingStartPositionSec = currentTrack.startPositionSec || currentTrack.startPosition || 0;
        state.pendingTrackUrl = currentTrack.url || currentTrack.trackUrl;
        state.pendingTrackTitle = currentTrack.title || currentTrack.filename;
        
        updateGuestPlaybackState("PREPARING");
      }
    } else if (data.queue && data.queue.length > 0) {
      // No current track but queue exists
      updateGuestQueue(data.queue);
    }
  } catch (error) {
    console.error("[Mid-Track Join] Error checking party state:", error);
  }
}

function updateGuestConnectionStatus(status = null) {
  const statusEl = el("guestConnectionStatus");
  if (!statusEl) return;
  
  // If status is explicitly provided, use it. Otherwise, use state.connected
  const connectionStatus = status || (state.connected ? 'connected' : 'disconnected');
  
  switch (connectionStatus) {
    case 'connected':
      statusEl.textContent = "Connected";
      statusEl.className = "badge";
      statusEl.style.background = "rgba(92, 255, 138, 0.2)";
      statusEl.style.borderColor = "rgba(92, 255, 138, 0.4)";
      statusEl.style.color = "#5cff8a";
      break;
    case 'disconnected':
      statusEl.textContent = "Disconnected";
      statusEl.className = "badge";
      statusEl.style.background = "rgba(255, 90, 106, 0.2)";
      statusEl.style.borderColor = "rgba(255, 90, 106, 0.4)";
      statusEl.style.color = "#ff5a6a";
      break;
    case 'reconnecting':
      statusEl.textContent = "Reconnecting...";
      statusEl.className = "badge";
      statusEl.style.background = "rgba(255, 209, 90, 0.2)";
      statusEl.style.borderColor = "rgba(255, 209, 90, 0.4)";
      statusEl.style.color = "#ffd15a";
      break;
    case 'party-ended':
      statusEl.textContent = "Party Ended";
      statusEl.className = "badge";
      statusEl.style.background = "rgba(150, 150, 150, 0.2)";
      statusEl.style.borderColor = "rgba(150, 150, 150, 0.4)";
      statusEl.style.color = "#999";
      break;
    case 'host-left':
      statusEl.textContent = "Host Left";
      statusEl.className = "badge";
      statusEl.style.background = "rgba(255, 90, 106, 0.2)";
      statusEl.style.borderColor = "rgba(255, 90, 106, 0.4)";
      statusEl.style.color = "#ff5a6a";
      break;
    default:
      statusEl.textContent = "Unknown";
      statusEl.className = "badge";
      statusEl.style.background = "rgba(150, 150, 150, 0.2)";
      statusEl.style.borderColor = "rgba(150, 150, 150, 0.4)";
      statusEl.style.color = "#999";
  }
}

function updateGuestPartyStatus() {
  const statusTextEl = el("guestPartyStatusText");
  const statusIconEl = el("guestPartyStatusBadge")?.querySelector(".party-status-icon");
  const timerEl = el("guestPartyPassTimer");
  
  if (!statusTextEl) return;
  
  const hasPartyPass = hasPartyPassEntitlement();
  
  if (hasPartyPass) {
    if (statusIconEl) statusIconEl.textContent = "🎉";
    statusTextEl.textContent = "Party Pass Active";
    if (timerEl) {
      // Only show timer for temporary Party Pass (not PRO_MONTHLY)
      if (state.userTier === USER_TIER.PARTY_PASS && state.partyPassEndTime) {
        const remaining = Math.max(0, state.partyPassEndTime - Date.now());
        const minutes = Math.floor(remaining / 60000);
        timerEl.textContent = `${minutes}m remaining`;
        timerEl.classList.remove("hidden");
      } else {
        timerEl.classList.add("hidden");
      }
    }
  } else if (state.partyPro) {
    if (statusIconEl) statusIconEl.textContent = "💎";
    statusTextEl.textContent = "Pro";
    if (timerEl) timerEl.classList.add("hidden");
  } else {
    if (statusIconEl) statusIconEl.textContent = "✨";
    statusTextEl.textContent = "Free Plan";
    if (timerEl) timerEl.classList.add("hidden");
  }
}

// Update guest tier UI based on user's subscription tier
function updateGuestTierUI() {
  const hasPartyPass = hasPartyPassEntitlement();
  
  // Update tier based on party status
  if (hasPartyPass) {
    // User has Party Pass entitlement (PRO_MONTHLY, PARTY_PASS, or active Party Pass)
    // Keep current tier if it's already PRO, otherwise set to PARTY_PASS
    if (state.userTier !== USER_TIER.PRO) {
      state.userTier = USER_TIER.PARTY_PASS;
    }
  } else {
    state.userTier = USER_TIER.FREE;
  }
  
  // Show/hide text message buttons based on tier and chat mode
  const textMessagesEl = el("guestTextMessages");
  if (textMessagesEl) {
    // FREE tier: hide text messages (emoji only)
    // PARTY_PASS: show preset messages
    // PRO: show preset messages (custom text would need separate input)
    // Also respect chat mode
    if (state.userTier === USER_TIER.FREE || state.chatMode === "EMOJI_ONLY" || state.chatMode === "LOCKED") {
      textMessagesEl.style.display = "none";
    } else {
      textMessagesEl.style.display = "block";
    }
  }
  
  console.log(`[Guest] Tier updated to: ${state.userTier}, Chat mode: ${state.chatMode}`);
}

function updateGuestNowPlaying(filename, trackId) {
  const filenameEl = el("guestNowPlayingFilename");
  if (!filenameEl) return;
  
  if (filename) {
    filenameEl.textContent = filename;
  } else {
    filenameEl.textContent = "No track selected";
  }

  // Show/hide the Report Copyright button based on whether a track is playing
  const reportBtn = el("btnGuestReportCopyright");
  if (reportBtn) {
    if (filename) {
      reportBtn.classList.remove("hidden");
      reportBtn.dataset.trackId = trackId || '';
    } else {
      reportBtn.classList.add("hidden");
      reportBtn.dataset.trackId = '';
    }
  }
  
}

function updateGuestUpNext(filename) {
  const sectionEl = el("guestUpNextSection");
  const filenameEl = el("guestUpNextFilename");
  
  if (!sectionEl || !filenameEl) return;
  
  if (filename) {
    filenameEl.textContent = filename;
    sectionEl.classList.remove("hidden");
  } else {
    filenameEl.textContent = "No track queued";
    sectionEl.classList.add("hidden");
  }
  
}

function updateGuestPlaybackState(newState) {
  state.playbackState = newState;
  
  const iconEl = el("guestPlaybackStateIcon");
  const textEl = el("guestPlaybackStateText");
  const badgeEl = iconEl?.parentElement;
  
  if (!iconEl || !textEl || !badgeEl) return;
  
  // Remove all state classes
  badgeEl.classList.remove("paused", "stopped");
  
  switch (newState) {
    case "PLAYING":
      iconEl.textContent = "▶️";
      textEl.textContent = "Playing";
      break;
    case "PAUSED":
      iconEl.textContent = "⏸";
      textEl.textContent = "Paused by Host";
      badgeEl.classList.add("paused");
      break;
    case "STOPPED":
    default:
      iconEl.textContent = "⏹";
      textEl.textContent = "Stopped";
      badgeEl.classList.add("stopped");
      break;
  }
  
}

// Show autoplay notice when audio.play() is blocked
function showAutoplayNotice() {
  const noticeEl = el("guestAutoplayNotice");
  if (noticeEl) {
    noticeEl.style.display = "block";
    noticeEl.textContent = "🔊 Tap Play to start audio";
    console.log("[Autoplay] Notice shown");
  } else {
    // Fallback to toast if notice element doesn't exist
    toast("🔊 Tap Play to start audio", "info");
  }
}

// Hide autoplay notice
function hideAutoplayNotice() {
  const noticeEl = el("guestAutoplayNotice");
  if (noticeEl) {
    noticeEl.style.display = "none";
    console.log("[Autoplay] Notice hidden");
  }
}

/**
 * Helper to unlock audio playback and clean up autoplay state
 */
function unlockAudioPlayback() {
  state.audioUnlocked = true;
  state.guestNeedsTap = false;
  hideAutoplayNotice();
}

/**
 * Helper to persist audio unlock state to storage
 */
function persistAudioUnlockState() {
  sessionStorage.setItem('audioUnlocked', '1');
  try {
    localStorage.setItem('audioUnlocked', '1');
  } catch (e) {
    // localStorage might be unavailable in private mode - ignore
    console.warn("[Audio Unlock] Could not store in localStorage:", e);
  }
}

/**
 * Robust audio unlock - creates and plays a silent audio buffer to unlock autoplay
 * Must be called from a user gesture (click/tap)
 * @returns {Promise<boolean>} - true if unlock successful, false otherwise
 */
async function unlockAudio() {
  console.log("[Audio Unlock] Attempting to unlock audio...");
  
  try {
    // Check if already unlocked in storage and state
    if (checkAudioUnlockState() && state.audioUnlocked) {
      console.log("[Audio Unlock] Already unlocked (from storage and state)");
      return true;
    }
    
    // Create a silent audio buffer and play it
    // This is the standard way to unlock audio on mobile browsers
    if (state.guestAudioElement) {
      // Use existing audio element - play it briefly at volume 0
      const originalVolume = state.guestAudioElement.volume;
      state.guestAudioElement.volume = 0;
      
      try {
        await state.guestAudioElement.play();
        state.guestAudioElement.pause();
        state.guestAudioElement.volume = originalVolume;
        console.log("[Audio Unlock] Audio unlocked via existing audio element");
      } catch (err) {
        console.warn("[Audio Unlock] Failed with existing element:", err);
        state.guestAudioElement.volume = originalVolume;
        throw err;
      }
    } else {
      // Create a temporary silent audio element
      const tempAudio = new Audio();
      // Create a tiny silent audio data URL (0.1s of silence)
      tempAudio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
      tempAudio.volume = 0;
      
      try {
        await tempAudio.play();
        tempAudio.pause();
        console.log("[Audio Unlock] Audio unlocked via temporary silent audio");
      } catch (err) {
        console.warn("[Audio Unlock] Failed with temp audio:", err);
        throw err;
      }
    }
    
    // Mark as unlocked
    state.audioUnlocked = true;
    state.guestNeedsTap = false;
    
    // Persist unlock state
    persistAudioUnlockState();
    
    console.log("[Audio Unlock] ✅ Audio successfully unlocked!");
    return true;
    
  } catch (error) {
    console.error("[Audio Unlock] Failed to unlock audio:", error);
    return false;
  }
}

/**
 * Check if audio has been unlocked in a previous session
 * Call this on page load or when joining a party
 */
function checkAudioUnlockState() {
  const sessionUnlocked = sessionStorage.getItem('audioUnlocked') === '1';
  const localUnlocked = localStorage.getItem('audioUnlocked') === '1';
  
  if (sessionUnlocked || localUnlocked) {
    console.log("[Audio Unlock] Found previous unlock state");
    // Don't automatically set state.audioUnlocked - still need user gesture
    // But we can avoid showing the prompt immediately
    return true;
  }
  
  return false;
}

function updateGuestVisualMode(mode) {
  state.visualMode = mode;
  
  const equalizerEl = el("guestEqualizer");
  if (!equalizerEl) return;
  
  // Remove all mode classes
  equalizerEl.classList.remove("playing", "paused", "idle", "track-change");
  
  // Add the new mode class
  if (mode) {
    equalizerEl.classList.add(mode);
  }
  
}

// Handle guest audio playback with sync
function handleGuestAudioPlayback(trackUrl, filename, startAtServerMs, startPosition = 0) {
  console.log("[Guest Audio] Received track:", filename, "URL:", trackUrl);
  console.log("[Guest Audio] Sync info - startAtServerMs:", startAtServerMs, "startPosition:", startPosition);
  
  if (!trackUrl) {
    toast("⚠️ Host playing local file - no audio available");
    state.guestNeedsTap = false;
    return;
  }
  
  // Create or reuse audio element
  if (!state.guestAudioElement) {
    state.guestAudioElement = new Audio();
    // Safe volume start - prevent audio blasting
    // Start at 50% volume or user's saved preference (whichever is lower)
    const safeVolume = Math.min(state.guestVolume, 50);
    state.guestAudioElement.volume = safeVolume / 100;
    state.guestVolume = safeVolume; // Update state to match
    
    // Update volume slider if exists
    const volumeSlider = el("guestVolumeSlider");
    const volumeValue = el("guestVolumeValue");
    if (volumeSlider) volumeSlider.value = safeVolume;
    if (volumeValue) volumeValue.textContent = `${safeVolume}%`;
    
    console.log(`[Guest Audio] Safe volume start at ${safeVolume}%`);
    
    // Add event listeners
    state.guestAudioElement.addEventListener('loadeddata', () => {
      console.log("[Guest Audio] Audio loaded and ready");
      state.guestAudioReady = true;
    });
    
    state.guestAudioElement.addEventListener('error', (e) => {
      console.error("[Guest Audio] Error loading audio:", e);
      toast("❌ Failed to load audio track");
      state.guestNeedsTap = false;
    });
    
    // Update Media Session position state during playback
    state.guestAudioElement.addEventListener('timeupdate', () => {
      if (typeof updateMediaSessionPosition === 'function' && 
          state.guestAudioElement.duration && 
          !state.guestAudioElement.paused) {
        updateMediaSessionPosition(
          state.guestAudioElement.duration, 
          state.guestAudioElement.currentTime, 
          state.guestAudioElement.playbackRate || 1.0
        );
      }
    });
    
    // Clear metadata when guest audio ends
    state.guestAudioElement.addEventListener('ended', () => {
      if (typeof clearMediaSessionMetadata === 'function') {
        clearMediaSessionMetadata();
      }
    });
  }
  
  // Set source
  state.guestAudioElement.src = trackUrl;
  state.guestAudioReady = false;
  state.guestNeedsTap = true;
  
  // Store sync info for precise timing and Media Session
  state.guestAudioElement.dataset.startAtServerMs = startAtServerMs.toString();
  state.guestAudioElement.dataset.startPositionSec = startPosition.toString();
  state.guestAudioElement.dataset.trackTitle = filename; // For Media Session metadata
  
  // Show "Tap to Sync" prompt
  showGuestTapToPlay(filename, startAtServerMs, startPosition);
  
  console.log("[Guest Audio] Ready for user interaction");
}

// Show "Tap to Play" button for guest with sync info
function showGuestTapToPlay(filename, startAtServerMs, startPositionSec) {
  // Determine if this is a mid-track join or fresh start
  const elapsedSec = (nowServerMs() - startAtServerMs) / 1000;
  const isMidTrackJoin = elapsedSec > 2; // If more than 2 seconds elapsed, it's mid-track
  
  // Create overlay if it doesn't exist
  let overlay = el("guestTapOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "guestTapOverlay";
    overlay.className = "guest-tap-overlay";
    overlay.innerHTML = `
      <div class="guest-tap-content">
        <div class="guest-tap-icon">🎵</div>
        <div class="guest-tap-title" id="guestTapTitle">Tap to enable audio</div>
        <div class="guest-tap-filename"></div>
        <button class="btn btn-primary guest-tap-button">Enable Audio</button>
        <div class="guest-tap-note">Your browser requires a tap to start audio playback</div>
        <div class="guest-tap-success" style="display: none; color: #4ade80; font-size: 16px; margin-top: 12px;">
          ✅ Audio enabled
        </div>
        <div class="guest-sync-debug">
          <div>Debug Info:</div>
          <div id="guestDebugTarget">Target: --</div>
          <div id="guestDebugElapsed">Elapsed: --</div>
          <div id="guestDebugStart">Start Pos: --</div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    
    // Add click handler - unlock audio then play
    const tapBtn = overlay.querySelector(".guest-tap-button");
    tapBtn.onclick = async () => {
      console.log("[Guest Tap] User tapped to enable audio");
      
      // Capture isMidTrackJoin at click time for use in async context
      const currentElapsed = (nowServerMs() - startAtServerMs) / 1000;
      const isMidTrack = currentElapsed > 2;
      
      // First, try to unlock audio
      const unlocked = await unlockAudio();
      
      if (unlocked) {
        // Show success message briefly
        const successEl = overlay.querySelector(".guest-tap-success");
        const noteEl = overlay.querySelector(".guest-tap-note");
        const titleEl = overlay.querySelector("#guestTapTitle");
        
        if (successEl && noteEl && titleEl) {
          noteEl.style.display = "none";
          successEl.style.display = "block";
          titleEl.textContent = isMidTrack ? "Syncing to DJ..." : "Starting playback...";
          tapBtn.disabled = true;
          tapBtn.textContent = "Loading...";
        }
        
        // Delay to show success message before starting playback
        await new Promise(resolve => setTimeout(resolve, AUDIO_UNLOCK_SUCCESS_DELAY_MS));
        
        // Now play the audio
        playGuestAudio();
      } else {
        // Unlock failed, but still try to play (fallback)
        console.warn("[Guest Tap] Audio unlock failed, trying to play anyway");
        playGuestAudio();
      }
    };
  }
  
  // Update title based on mid-track join status (only if not showing success)
  const titleEl = overlay.querySelector("#guestTapTitle");
  const successEl = overlay.querySelector(".guest-tap-success");
  if (titleEl && (!successEl || successEl.style.display === "none")) {
    titleEl.textContent = "Tap to enable audio";
  }
  
  // Update filename
  const filenameEl = overlay.querySelector(".guest-tap-filename");
  if (filenameEl) {
    filenameEl.textContent = filename || "Unknown Track";
  }
  
  // Reset button state in case it was used before
  const tapBtn = overlay.querySelector(".guest-tap-button");
  if (tapBtn) {
    tapBtn.disabled = false;
    tapBtn.textContent = "Enable Audio";
  }
  
  // Reset note visibility
  const noteEl = overlay.querySelector(".guest-tap-note");
  if (noteEl) {
    noteEl.style.display = "block";
  }
  
  // Hide success message
  if (successEl) {
    successEl.style.display = "none";
  }
  
  // Update debug info
  updateGuestSyncDebug(startAtServerMs, startPositionSec);
  
  overlay.style.display = "flex";
}

// Update guest sync debug display
function updateGuestSyncDebug(startAtServerMs, startPositionSec) {
  const elapsedSec = (Date.now() - startAtServerMs) / 1000;
  const targetSec = startPositionSec + elapsedSec;
  
  const targetEl = el("guestDebugTarget");
  const elapsedEl = el("guestDebugElapsed");
  const startEl = el("guestDebugStart");
  
  if (targetEl) targetEl.textContent = `Target: ${targetSec.toFixed(2)}s`;
  if (elapsedEl) elapsedEl.textContent = `Elapsed: ${elapsedSec.toFixed(2)}s`;
  if (startEl) startEl.textContent = `Start Pos: ${startPositionSec.toFixed(2)}s`;
}

// Helper: Store sync data and show "Tap to Sync" overlay when autoplay is blocked
function handleAutoplayBlocked(audioElement, trackTitle, startAtServerMs, startPositionSec) {
  // Store sync info in audio element dataset for playGuestAudio()
  audioElement.dataset.startAtServerMs = startAtServerMs.toString();
  audioElement.dataset.startPositionSec = startPositionSec.toString();
  
  // Show prominent "Tap to Sync" overlay
  showGuestTapToPlay(trackTitle, startAtServerMs, startPositionSec);
}

// Play guest audio with metadata-safe seek and autoplay unlock handling
function playGuestAudio() {
  if (!state.guestAudioElement || !state.guestAudioElement.src) {
    toast("No audio loaded");
    return;
  }
  
  const audioEl = state.guestAudioElement;
  const startAtServerMs = parseFloat(audioEl.dataset.startAtServerMs || "0");
  const startPositionSec = parseFloat(audioEl.dataset.startPositionSec || "0");
  
  // Function to compute and seek to correct position
  const computeAndSeek = () => {
    const elapsedSec = (nowServerMs() - startAtServerMs) / 1000;
    let targetSec = startPositionSec + elapsedSec;
    
    // Clamp target to valid range
    if (audioEl.duration && targetSec > audioEl.duration - 0.25) {
      targetSec = Math.max(0, audioEl.duration - 0.25);
    }
    
    console.log("[Guest Audio] Syncing to position:", targetSec.toFixed(2), "s");
    console.log("[Guest Audio] Debug - elapsedSec:", elapsedSec.toFixed(2), "startPositionSec:", startPositionSec);
    
    // Safely seek to target position
    clampAndSeekAudio(audioEl, targetSec);
    
    audioEl.play()
      .then(() => {
        console.log("[Guest Audio] Playing from position:", targetSec.toFixed(2), "s");
        toast("🎵 Audio synced and playing!");
        state.guestNeedsTap = false;
        state.audioUnlocked = true; // Mark audio as unlocked
        
        // Persist unlock state
        persistAudioUnlockState();
        
        // Update Media Session metadata for background audio (guest)
        if (typeof updateMediaSessionMetadata === 'function') {
          const rawTitle = audioEl.dataset.trackTitle || 'Playing';
          const trackTitle = cleanTrackTitle(rawTitle);
          updateMediaSessionMetadata({
            title: trackTitle,
            artist: 'Phone Party',
            album: state.code ? `Party ${state.code}` : 'Party'
          });
          
          // Update position state
          if (typeof updateMediaSessionPosition === 'function' && audioEl.duration) {
            updateMediaSessionPosition(audioEl.duration, audioEl.currentTime, audioEl.playbackRate || 1.0);
          }
        }
        
        // Hide tap overlay
        const overlay = el("guestTapOverlay");
        if (overlay) {
          overlay.style.display = "none";
        }
        
        // Start drift correction
        startDriftCorrection(startAtServerMs, startPositionSec);
        
        // Hide re-sync button initially
        state.showResyncButton = false;
        updateResyncButtonVisibility();
      })
      .catch((error) => {
        console.error("[Guest Audio] Play failed:", error);
        
        // Autoplay was blocked
        state.audioUnlocked = false;
        toast("⚠️ Tap Play button to start audio");
        
        // Keep the tap overlay or show a message
        const overlay = el("guestTapOverlay");
        if (overlay) {
          overlay.style.display = "flex";
        }
      });
  };
  
  // Wait for metadata before seeking (CRITICAL for mobile browsers)
  if (audioEl.readyState >= 1) { // HAVE_METADATA or better
    computeAndSeek();
  } else {
    console.log("[Guest Audio] Waiting for metadata before seeking...");
    audioEl.onloadedmetadata = () => {
      console.log("[Guest Audio] Metadata loaded, duration:", audioEl.duration);
      computeAndSeek();
    };
  }
}

// Drift correction - runs every 2 seconds with multi-threshold correction
let driftCorrectionInterval = null;
let lastDriftValue = 0; // Track last drift for UI updates

/**
 * Start drift correction for guest audio synchronization
 * Uses server-synced clock to maintain accurate playback position across devices
 * 
 * @param {number} startAtServerMs - Server timestamp when playback started (in milliseconds)
 * @param {number} startPositionSec - Starting position in the audio track (in seconds)
 * 
 * @description
 * Implements multi-threshold drift correction strategy:
 * - <200ms: Ignored (normal variance)
 * - 200-800ms: Soft correction (small seek adjustment)
 * - 800-1000ms: Moderate correction (hard seek with failure tracking)
 * - >1000ms: Hard resync (immediate correction, shows manual resync button)
 * 
 * Runs every 2 seconds to check and correct drift. Uses server time via nowServerMs()
 * to calculate ideal position, ensuring all guests stay synchronized with the host.
 * 
 * @see constants.js - SYNC_THRESHOLDS for threshold values
 * @see docs/SYNC_ARCHITECTURE_EXPLAINED.md - Complete sync architecture documentation
 */
function startDriftCorrection(startAtServerMs, startPositionSec) {
  // Clear any existing interval
  if (driftCorrectionInterval) {
    clearInterval(driftCorrectionInterval);
  }
  
  // Reset drift corrections count for new track
  driftCorrectionsCount = 0;
  
  console.log("[Drift Correction] Started with server-synced multi-threshold approach");
  
  driftCorrectionInterval = setInterval(() => {
    if (!state.guestAudioElement || state.guestAudioElement.paused) {
      return;
    }
    
    // Calculate ideal position based on SERVER timestamp (using synced clock)
    const elapsedSec = (nowServerMs() - startAtServerMs) / 1000;
    const idealSec = startPositionSec + elapsedSec;
    
    // Calculate drift (positive = ahead, negative = behind)
    const currentSec = state.guestAudioElement.currentTime;
    const signedDrift = currentSec - idealSec;
    const absDrift = Math.abs(signedDrift);
    lastDriftValue = absDrift;
    
    console.log("[Drift Correction] Current:", currentSec.toFixed(2), "Ideal:", idealSec.toFixed(2), "Drift:", signedDrift.toFixed(3), "s");
    
    // Update drift UI
    updateGuestSyncQuality(absDrift);
    
    // Multi-threshold drift correction
    if (absDrift < DRIFT_CORRECTION_THRESHOLD_SEC) {
      // Drift < 0.20s - ignore, within acceptable range
      state.driftCheckFailures = 0;
      // Hide resync button if drift is good
      if (state.showResyncButton) {
        state.showResyncButton = false;
        updateResyncButtonVisibility();
      }
    } else if (absDrift < DRIFT_SOFT_CORRECTION_THRESHOLD_SEC) {
      // Drift 0.20s - 0.80s - soft correction (small seek)
      console.log("[Drift Correction] Soft correction - adjusting by", signedDrift.toFixed(3), "s");
      clampAndSeekAudio(state.guestAudioElement, idealSec);
      driftCorrectionsCount++; // Track correction for debug panel
      state.driftCheckFailures = 0;
      // Hide resync button if drift improved below soft correction threshold
      if (state.showResyncButton && absDrift < DRIFT_SOFT_CORRECTION_THRESHOLD_SEC) {
        state.showResyncButton = false;
        updateResyncButtonVisibility();
        console.log("[Drift Correction] Re-sync button hidden - drift improved");
      }
    } else if (absDrift < DRIFT_HARD_RESYNC_THRESHOLD_SEC) {
      // Drift 0.80s - 1.00s - moderate correction with failure tracking
      console.log("[Drift Correction] Moderate drift - hard seeking to", idealSec.toFixed(2), "s");
      clampAndSeekAudio(state.guestAudioElement, idealSec);
      driftCorrectionsCount++; // Track correction for debug panel
      state.driftCheckFailures++;
    } else {
      // Drift > 1.00s - hard resync
      console.log("[Drift Correction] Large drift detected - hard resync to", idealSec.toFixed(2), "s");
      clampAndSeekAudio(state.guestAudioElement, idealSec);
      driftCorrectionsCount++; // Track correction for debug panel
      state.driftCheckFailures++;
      
      // Show re-sync button if drift is very large or repeated failures
      if (absDrift > DRIFT_SHOW_RESYNC_THRESHOLD_SEC || state.driftCheckFailures > 3) {
        state.showResyncButton = true;
        updateResyncButtonVisibility();
        console.log("[Drift Correction] Re-sync button shown due to large/persistent drift");
      }
    }
  }, DRIFT_CORRECTION_INTERVAL_MS);
}

/**
 * Clamp and safely seek audio element to target position
 * Prevents seeking beyond valid audio range which can cause playback errors
 * 
 * @param {HTMLAudioElement} audioEl - Audio element to seek
 * @param {number} targetSec - Target position in seconds
 * 
 * @description
 * Ensures target time is within valid range [0, duration - 0.25].
 * The 0.25s buffer at the end prevents seeking errors near track end.
 * Wraps seek operation in try-catch to handle errors gracefully.
 */
function clampAndSeekAudio(audioEl, targetSec) {
  if (!audioEl || !audioEl.duration) return;
  
  // Clamp target time to valid range [0, duration - 0.25]
  const clampedSec = Math.max(0, Math.min(targetSec, audioEl.duration - 0.25));
  
  try {
    audioEl.currentTime = clampedSec;
  } catch (err) {
    console.error("[Drift Correction] Failed to seek:", err);
  }
}

/**
 * Stop drift correction interval and reset related state
 * Called when playback stops or guest leaves party
 * 
 * @description
 * Cleans up drift correction interval, resets failure counter,
 * and hides manual resync button if visible.
 */
function stopDriftCorrection() {
  if (driftCorrectionInterval) {
    clearInterval(driftCorrectionInterval);
    driftCorrectionInterval = null;
    console.log("[Drift Correction] Stopped");
  }
  // Reset drift-related state
  state.driftCheckFailures = 0;
  state.showResyncButton = false;
  updateResyncButtonVisibility();
}

// Update resync button visibility based on state
function updateResyncButtonVisibility() {
  const btnResync = el("btnGuestResync");
  if (btnResync) {
    if (state.showResyncButton) {
      btnResync.style.display = "block";
    } else {
      btnResync.style.display = "none";
    }
  }
}

// Update guest sync quality indicator based on drift
function updateGuestSyncQuality(drift) {
  const driftValueEl = el("guestDriftValue");
  const qualityBadgeEl = el("guestSyncQuality");
  
  if (driftValueEl) {
    driftValueEl.textContent = drift.toFixed(2);
  }
  
  if (qualityBadgeEl) {
    // Remove all quality classes
    qualityBadgeEl.classList.remove("medium", "bad");
    
    // Classify sync quality based on new drift thresholds
    if (drift < DRIFT_CORRECTION_THRESHOLD_SEC) {
      // Excellent sync (< 200ms) - within ignore threshold
      qualityBadgeEl.textContent = SYNC_QUALITY_EXCELLENT;
    } else if (drift < DRIFT_SOFT_CORRECTION_THRESHOLD_SEC) {
      // Good sync (200-800ms) - soft correction range
      qualityBadgeEl.textContent = SYNC_QUALITY_GOOD;
      qualityBadgeEl.classList.add("medium");
    } else if (drift < DRIFT_SHOW_RESYNC_THRESHOLD_SEC) {
      // Medium sync (800ms-1.5s) - hard correction range
      qualityBadgeEl.textContent = SYNC_QUALITY_MEDIUM;
      qualityBadgeEl.classList.add("medium");
    } else {
      // Poor sync (> 1.5s) - show resync button
      qualityBadgeEl.textContent = SYNC_QUALITY_POOR;
      qualityBadgeEl.classList.add("bad");
    }
  }
}

// Manual resync function for guests - improved with forced sync
function manualResyncGuest() {
  console.log("[Guest] Manual resync triggered");
  
  // Show feedback
  toast("Resyncing audio...");
  
  // Force re-sync by reloading current playback state
  if (state.guestAudioElement && state.guestAudioElement.dataset.startAtServerMs) {
    const startAtServerMs = parseFloat(state.guestAudioElement.dataset.startAtServerMs);
    const startPositionSec = parseFloat(state.guestAudioElement.dataset.startPositionSec || "0");
    
    const elapsedSec = (Date.now() - startAtServerMs) / 1000;
    const idealSec = startPositionSec + elapsedSec;
    
    console.log("[Guest] Manual resync - jumping to ideal position:", idealSec.toFixed(2), "s");
    
    // Use clamped seek
    clampAndSeekAudio(state.guestAudioElement, idealSec);
    
    // If audio is paused, try to play it (if unlocked)
    if (state.guestAudioElement.paused && state.audioUnlocked) {
      state.guestAudioElement.play()
        .then(() => {
          console.log("[Guest] Resumed playback after resync");
          toast("✓ Resynced!", "success");
        })
        .catch(err => {
          console.warn("[Guest] Could not resume after resync:", err);
          toast("✓ Position resynced (tap Play if needed)", "success");
        });
    } else {
      toast("✓ Resynced!", "success");
    }
    
    // Reset drift failures and hide resync button
    state.driftCheckFailures = 0;
    state.showResyncButton = false;
    updateResyncButtonVisibility();
  } else {
    console.warn("[Guest] Cannot resync - no active playback state");
    toast("No active playback to resync", "warning");
  }
}

// Report out of sync to host
function reportOutOfSync() {
  console.log("[Guest] Reporting out of sync");
  
  // Calculate drift if we have playback state
  let drift = "unknown";
  if (state.guestAudioElement && state.lastSyncData) {
    const currentTime = state.guestAudioElement.currentTime;
    const serverNow = Date.now();
    const expectedPosition = state.lastSyncData.startPositionSec + 
      (serverNow - state.lastSyncData.startAtServerMs) / 1000;
    drift = Math.round((currentTime - expectedPosition) * 1000); // ms
  }
  
  // Send WebSocket message to host about sync issue
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      t: "SYNC_ISSUE",
      drift: drift,
      timestamp: Date.now()
    }));
    console.log(`[Guest] Sent SYNC_ISSUE to server, drift: ${drift}ms`);
    toast("Out of sync report sent to DJ");
  } else {
    console.warn("[Guest] Cannot report sync issue - WebSocket not connected");
    toast("Cannot report sync issue - not connected", "warning");
  }
}

// Cleanup guest audio element
function cleanupGuestAudio() {
  if (state.guestAudioElement) {
    // Pause audio if playing
    if (!state.guestAudioElement.paused) {
      state.guestAudioElement.pause();
    }
    
    // Stop drift correction
    stopDriftCorrection();

// Update guest queue display
// PHASE 7: Update host queue UI display
function updateHostQueueUI() {
  console.log("[Host] Updating queue UI:", musicState.queue);
  
  // Update both queue lists (main party view and DJ overlay)
  const queueElements = ['hostQueueList', 'djHostQueueList'];
  
  queueElements.forEach(elementId => {
    const queueEl = el(elementId);
    if (!queueEl) {
      return; // Element not present in current view
    }
    
    if (!musicState.queue || musicState.queue.length === 0) {
      queueEl.innerHTML = '<div class="queue-empty">No tracks in queue</div>';
      return;
    }
    
    queueEl.innerHTML = musicState.queue.map((track, index) => `
      <div class="queue-item" data-track-id="${track.trackId}" data-index="${index}">
        <span class="queue-number">${index + 1}.</span>
        <span class="queue-title">${escapeHtml(track.title || 'Unknown Track')}</span>
        <div class="queue-controls queue-item-actions">
          ${index > 0 ? '<button class="queue-btn-up" onclick="moveQueueTrackUp(' + index + ')">↑</button>' : ''}
          ${index < musicState.queue.length - 1 ? '<button class="queue-btn-down" onclick="moveQueueTrackDown(' + index + ')">↓</button>' : ''}
          <button class="queue-btn-remove" onclick="removeQueueTrack('${escapeHtml(track.trackId)}')">×</button>
          <button class="btn-report-small"
            data-report-track="1"
            data-track-id="${escapeHtml(track.trackId||'')}"
            data-track-title="${escapeHtml(track.title||'')}"
            data-track-provider="${escapeHtml(track.provider||'')}"
            data-track-ref="${escapeHtml(track.providerRef||'')}"
            data-queue-pos="${index}">🚩</button>
        </div>
      </div>
    `).join('');
  });
}

function updateGuestQueue(queue) {
  console.log("[Guest] Updating queue:", queue);
  
  const queueEl = el("guestQueueList");
  if (!queueEl) {
    console.warn("[Guest] Queue element not found");
    return;
  }
  
  if (!queue || queue.length === 0) {
    queueEl.innerHTML = '<div class="queue-empty">No tracks in queue</div>';
    return;
  }
  
  queueEl.innerHTML = queue.map((track, index) => `
    <div class="queue-item">
      <span class="queue-number">${index + 1}.</span>
      <span class="queue-title">${escapeHtml(track.title || 'Unknown Track')}</span>
      <div class="queue-item-actions">
        <button class="btn-report-small"
          data-report-track="1"
          data-track-id="${escapeHtml(track.trackId||'')}"
          data-track-title="${escapeHtml(track.title||'')}"
          data-track-provider="${escapeHtml(track.provider||'')}"
          data-queue-pos="${index}">🚩</button>
      </div>
    </div>
  `).join('');
}
    
    // Clear source to free memory
    state.guestAudioElement.src = "";
    state.guestAudioElement.load(); // Force release
    
    // Remove element
    state.guestAudioElement = null;
    state.guestAudioReady = false;
    state.guestNeedsTap = false;
  }
  
  // Hide tap overlay if visible
  const overlay = el("guestTapOverlay");
  if (overlay) {
    overlay.style.display = "none";
  }
}

// Display DJ auto-generated message
function displayDjMessage(message, type = "system") {
  console.log("[DJ Message]", type, ":", message);
  
  // Show as toast with appropriate styling
  let icon = "🎧";
  if (type === "warning") icon = "⏰";
  if (type === "prompt") icon = "💬";
  
  toast(`${icon} ${message}`, type === "warning" ? 8000 : 5000);
  
  // Also display in party view if exists
  const djMessagesContainer = el("djMessagesContainer");
  if (djMessagesContainer) {
    const msgEl = document.createElement("div");
    msgEl.className = `dj-message dj-message-${type}`;
    msgEl.textContent = message;
    djMessagesContainer.appendChild(msgEl);
    
    // Auto-remove after 10 seconds
    setTimeout(() => {
      msgEl.remove();
    }, 10000);
  }
}

// Display host broadcast message on guest screen
function displayHostBroadcastMessage(message) {
  console.log("[Host Broadcast]", message);
  
  // Add to unified feed
  addToUnifiedFeed('DJ', 'DJ', 'broadcast', message, false);
  
  // Show as toast with DJ icon
  toast(`📢 ${message}`, 5000);
}

function setupGuestVolumeControl() {
  const sliderEl = el("guestVolumeSlider");
  const valueEl = el("guestVolumeValue");
  
  if (!sliderEl || !valueEl) return;
  
  // Set initial value
  sliderEl.value = state.guestVolume;
  valueEl.textContent = `${state.guestVolume}%`;
  
  // Update on change
  sliderEl.oninput = () => {
    state.guestVolume = parseInt(sliderEl.value);
    valueEl.textContent = `${state.guestVolume}%`;
    // In a real app, this would control local audio volume
  };
}

// Scoreboard Functions
function updateScoreboard(scoreboard) {
  if (!scoreboard) return;
  
  // Update DJ scoreboard (visible to host)
  if (state.isHost) {
    updateDjScoreboard(scoreboard);
  }
  
  // Update guest scoreboard (visible to all)
  updateGuestScoreboard(scoreboard);
}

function updateDjScoreboard(scoreboard) {
  // Update DJ session score
  const djSessionScoreEl = el("djSessionScore");
  if (djSessionScoreEl && scoreboard.dj) {
    const newScore = scoreboard.dj.sessionScore || 0;
    const oldScore = parseInt(djSessionScoreEl.textContent) || 0;
    
    djSessionScoreEl.textContent = newScore;
    
    // Animate if score increased
    if (newScore > oldScore) {
      djSessionScoreEl.classList.add("score-increase");
      setTimeout(() => djSessionScoreEl.classList.remove("score-increase"), 500);
    }
  }
  
  // Update stats
  const totalReactionsEl = el("totalReactions");
  if (totalReactionsEl) {
    totalReactionsEl.textContent = scoreboard.totalReactions || 0;
  }
  
  const totalMessagesEl = el("totalMessages");
  if (totalMessagesEl) {
    totalMessagesEl.textContent = scoreboard.totalMessages || 0;
  }
  
  const peakEnergyEl = el("peakEnergy");
  if (peakEnergyEl) {
    peakEnergyEl.textContent = scoreboard.peakCrowdEnergy || 0;
  }
  
  // Update guest list
  const djScoreboardListEl = el("djScoreboardList");
  if (djScoreboardListEl && scoreboard.guests) {
    if (scoreboard.guests.length === 0) {
      djScoreboardListEl.innerHTML = `
        <div class="scoreboard-placeholder">
          <span class="tiny muted">No guest activity yet...</span>
        </div>
      `;
    } else {
      djScoreboardListEl.innerHTML = scoreboard.guests.map((guest, index) => `
        <div class="scoreboard-item rank-${guest.rank}">
          <div class="scoreboard-rank">#${guest.rank}</div>
          <div class="scoreboard-guest-info">
            <div class="scoreboard-guest-name">${escapeHtml(guest.nickname || 'Guest')}</div>
            <div class="scoreboard-guest-stats">
              ${guest.emojis || 0} emojis · ${guest.messages || 0} messages
            </div>
          </div>
          <div class="scoreboard-points">${guest.points || 0}</div>
        </div>
      `).join('');
    }
  }
}

function updateGuestScoreboard(scoreboard) {
  // Show scoreboard card for guests
  const guestScoreboardCardEl = el("guestScoreboardCard");
  if (guestScoreboardCardEl && !state.isHost && scoreboard.guests && scoreboard.guests.length > 0) {
    guestScoreboardCardEl.classList.remove("hidden");
  }
  
  // Find current guest's score
  const guestScoreboardListEl = el("guestScoreboardList");
  const yourScoreEl = el("guestYourScore");
  const yourRankEl = el("guestYourRank");
  
  if (scoreboard.guests) {
    // Find my score if I'm a guest
    const myGuest = scoreboard.guests.find(g => g.guestId === state.clientId);
    
    if (yourScoreEl && myGuest) {
      const newScore = myGuest.points || 0;
      const oldScore = parseInt(yourScoreEl.textContent) || 0;
      
      yourScoreEl.textContent = newScore;
      
      // Animate if score increased
      if (newScore > oldScore) {
        yourScoreEl.classList.add("score-increase");
        setTimeout(() => yourScoreEl.classList.remove("score-increase"), 500);
      }
    }
    
    if (yourRankEl && myGuest) {
      yourRankEl.textContent = `#${myGuest.rank}`;
    }
    
    // Update top 5 list
    if (guestScoreboardListEl) {
      const top5 = scoreboard.guests.slice(0, 5);
      if (top5.length === 0) {
        guestScoreboardListEl.innerHTML = `
          <div class="scoreboard-placeholder">
            <span class="tiny muted">No activity yet...</span>
          </div>
        `;
      } else {
        guestScoreboardListEl.innerHTML = top5.map((guest, index) => `
          <div class="scoreboard-item rank-${guest.rank}">
            <div class="scoreboard-rank">#${guest.rank}</div>
            <div class="scoreboard-guest-info">
              <div class="scoreboard-guest-name">${escapeHtml(guest.nickname || 'Guest')}</div>
              <div class="scoreboard-guest-stats">
                ${guest.emojis || 0} 🎉 · ${guest.messages || 0} 💬
              </div>
            </div>
            <div class="scoreboard-points">${guest.points || 0}</div>
          </div>
        `).join('');
      }
    }
  }
}

// DJ Screen Functions
function showDjScreen() {
  const djOverlay = el("djScreenOverlay");
  if (djOverlay) {
    djOverlay.classList.remove("hidden");
    updateDjScreen();
    updateBackToDjButton();
  }
}

function hideDjScreen() {
  const djOverlay = el("djScreenOverlay");
  if (djOverlay) {
    djOverlay.classList.add("hidden");
    updateBackToDjButton();
  }
}

function updateDjScreen() {
  // Update party code
  const djPartyCodeEl = el("djPartyCode");
  if (djPartyCodeEl) {
    djPartyCodeEl.textContent = state.code || "------";
  }
  
  // Update guest count (exclude host)
  const djGuestCountEl = el("djGuestCount");
  if (djGuestCountEl) {
    const guestCount = (state.snapshot?.members || []).filter(m => !m.isHost).length;
    djGuestCountEl.textContent = guestCount;
  }
  
  // Update now playing
  const djNowPlayingEl = el("djNowPlayingTrack");
  if (djNowPlayingEl && musicState.selectedFile) {
    djNowPlayingEl.textContent = musicState.selectedFile.name;
  } else if (djNowPlayingEl) {
    djNowPlayingEl.textContent = "No Track";
  }
  
  // Update up next display
  const djUpNextEl = el("djUpNext");
  const djUpNextTrackEl = el("djUpNextTrack");
  if (djUpNextEl && djUpNextTrackEl) {
    if (musicState.queuedFile) {
      djUpNextEl.classList.remove("hidden");
      djUpNextTrackEl.textContent = musicState.queuedFile.name;
    } else {
      djUpNextEl.classList.add("hidden");
      djUpNextTrackEl.textContent = "No track queued";
    }
  }
  
  // Check if Party Pass or Pro is active (server-authoritative tier check)
  const hasPartyPassOrPro = state.partyPassActive || state.partyPro || 
                            state.userTier === USER_TIER.PARTY_PASS || 
                            state.userTier === USER_TIER.PRO;
  
  // Show/hide DJ preset messages section based on tier
  const djPresetMessagesSection = el("djPresetMessagesSection");
  if (djPresetMessagesSection) {
    if (hasPartyPassOrPro) {
      djPresetMessagesSection.classList.remove("hidden");
    } else {
      djPresetMessagesSection.classList.add("hidden");
    }
  }
  
  // Show/hide DJ emoji reactions section based on tier (Party Pass / Pro Monthly)
  const djEmojiReactionsSection = el("djEmojiReactionsSection");
  if (djEmojiReactionsSection) {
    if (hasPartyPassOrPro) {
      djEmojiReactionsSection.classList.remove("hidden");
    } else {
      djEmojiReactionsSection.classList.add("hidden");
    }
  }
  
  // Show/hide DJ short message section based on tier (PRO MONTHLY ONLY)
  // DJ typed messages require Pro tier, not Party Pass
  const djShortMessageSection = el("djShortMessageSection");
  if (djShortMessageSection) {
    if (hasProTierEntitlement()) {
      djShortMessageSection.classList.remove("hidden");
    } else {
      djShortMessageSection.classList.add("hidden");
    }
  }
}

function updateBackToDjButton() {
  const btnBackToDj = el("btnBackToDj");
  const djOverlay = el("djScreenOverlay");
  
  if (btnBackToDj) {
    // Show button if: host is playing, and DJ screen is hidden
    const djScreenHidden = djOverlay && djOverlay.classList.contains("hidden");
    if (state.isHost && state.playing && djScreenHidden) {
      btnBackToDj.classList.remove("hidden");
    } else {
      btnBackToDj.classList.add("hidden");
    }
  }
}

/**
 * Handle guest message/emoji received from server
 * GUEST REACTIONS: Generate crowd energy, appear in live reaction box (no popups/animations)
 */
function handleGuestMessageReceived(message, guestName, guestId, isEmoji) {
  console.log(`[DJ] Received message from ${guestName}: ${message}, isEmoji: ${isEmoji}`);
  
  // Track reaction/message for session stats (Feature 3)
  if (isEmoji) {
    trackReaction(message);
  } else {
    trackMessage(true); // Track as shoutout
  }
  
  // CROWD ENERGY: Only increment from GUEST reactions (not DJ)
  // This is the key requirement - crowd energy ONLY from guests
  increaseCrowdEnergy(isEmoji ? 5 : 8);
  
  // Trigger beat pulse (Feature 8)
  triggerBeatPulse();
  
  // Check for smart upsell opportunities (Feature 4)
  checkSmartUpsell();
  
  // Show DJ screen if not already shown and playing
  if (state.playing) {
    showDjScreen();
  }
  
  // Add to unified feed (live reaction box - guest reactions displayed here only)
  addToUnifiedFeed('GUEST', guestName, isEmoji ? 'emoji' : 'message', message, isEmoji);
  
  // Trigger flash effect for subtle feedback
  triggerDjFlash();
}

function handleGuestPlayRequest(guestName, guestId) {
  console.log(`[DJ] Guest "${guestName}" requested to play music`);
  
  // Show toast notification to host
  toast(`▶️ ${guestName} wants to start the music`, "info");
  
  // Auto-play if there's a track available
  const btnDjPlay = el("btnDjPlay");
  if (btnDjPlay && !btnDjPlay.disabled) {
    // Simulate click on play button
    btnDjPlay.click();
    toast(`✓ Playing music for ${guestName}`, "success");
  } else {
    toast(`⚠️ No track available to play`, "warning");
  }
}

function handleGuestPauseRequest(guestName, guestId) {
  console.log(`[DJ] Guest "${guestName}" requested to pause music`);
  
  // Show toast notification to host
  toast(`⏸️ ${guestName} wants to stop the music`, "info");
  
  // Auto-pause if music is playing
  const btnDjPause = el("btnDjPause");
  if (btnDjPause && !btnDjPause.disabled) {
    // Simulate click on pause button
    btnDjPause.click();
    toast(`✓ Paused music for ${guestName}`, "success");
  } else {
    toast(`⚠️ No music playing to pause`, "warning");
  }
}

// ============================================================================
// UNIFIED REACTIONS FEED (Phase 2)
// ============================================================================

/**
 * Add an item to the unified feed
 * @param {string} sender - 'DJ' or 'GUEST' or 'SYSTEM'
 * @param {string} senderName - Display name of sender
 * @param {string} type - 'emoji', 'message', 'preset', 'broadcast', 'system'
 * @param {string} content - The emoji or message text
 * @param {boolean} isEmoji - Whether this is an emoji reaction
 * @param {string} id - Optional stable event ID (for FEED_EVENT dedupe)
 */
let feedItemCounter = 0; // Counter to ensure unique IDs

/**
 * Host removes a message from the unified feed (party-level only)
 */
function hostRemoveMessage(messageId) {
  if (!state.isHost) return;
  const idx = state.unifiedFeed.findIndex(item => item.id === messageId);
  if (idx !== -1) {
    state.unifiedFeed.splice(idx, 1);
    renderDJUnifiedFeed();
    if (typeof showModerationToast === 'function') showModerationToast('Message removed from party');
  }
}

function addToUnifiedFeed(sender, senderName, type, content, isEmoji = false, id = null) {
  const feedItem = {
    id: id || `${Date.now()}-${++feedItemCounter}`, // Use provided ID or generate one
    timestamp: Date.now(),
    sender: sender, // 'DJ', 'GUEST', or 'SYSTEM'
    senderName: senderName,
    type: type, // 'emoji', 'message', 'preset', 'broadcast', 'system'
    content: content,
    isEmoji: isEmoji
  };
  
  // Add to end (newest at bottom, oldest at top)
  state.unifiedFeed.push(feedItem);
  
  // Enforce rolling limit - remove oldest (from beginning) if exceeded
  if (state.unifiedFeed.length > state.maxFeedItems) {
    state.unifiedFeed = state.unifiedFeed.slice(-state.maxFeedItems);
  }
  
  // Update UI
  renderUnifiedFeed();
  
  console.log('[Unified Feed] Added:', feedItem, 'Total items:', state.unifiedFeed.length);
}

/**
 * Render the unified feed in both DJ and Guest views
 */
function renderUnifiedFeed() {
  // Render in DJ view
  const djMessagesContainer = el("djMessagesContainer");
  const djNoMessages = el("djNoMessages");
  
  if (djMessagesContainer) {
    // Clear existing messages
    djMessagesContainer.innerHTML = '';
    
    if (state.unifiedFeed.length === 0) {
      // Show "no messages" placeholder
      const noMsgEl = document.createElement("div");
      noMsgEl.className = "dj-no-messages";
      noMsgEl.id = "djNoMessages";
      noMsgEl.textContent = "Waiting for guest reactions...";
      djMessagesContainer.appendChild(noMsgEl);
    } else {
      // Use DocumentFragment for efficient DOM operations
      const fragment = document.createDocumentFragment();
      
      // Render feed items (oldest first at top, newest last at bottom)
      state.unifiedFeed.forEach(item => {
        const messageEl = document.createElement("div");
        messageEl.className = item.isEmoji ? "dj-message dj-message-emoji" : "dj-message";
        const safeContent = escapeHtml(item.content);
        const safeSender = escapeHtml(item.senderName);
        const safeId = escapeHtml(item.id || '');
        const safeSenderId = escapeHtml(item.senderId || '');
        const isHost = typeof state !== 'undefined' && state.isHost;
        messageEl.innerHTML = `
          <div class="dj-message-text">${safeContent}</div>
          <div class="dj-message-sender">${safeSender}</div>
          <div class="dj-message-actions" style="margin-top:2px;display:flex;gap:4px;">
            <button class="btn-report-small"
              data-report-msg="1"
              data-msg-id="${safeId}"
              data-msg-sender="${safeSenderId}">🚩 Report</button>
            ${isHost ? `<button class="btn-host-action-small" data-remove-msg="1" data-msg-id="${safeId}">✕ Remove</button>` : ''}
          </div>
        `;
        fragment.appendChild(messageEl);
      });
      
      djMessagesContainer.appendChild(fragment);
      
      // Auto-scroll to bottom to show newest message
      setTimeout(() => {
        djMessagesContainer.scrollTop = djMessagesContainer.scrollHeight;
      }, 0);
    }
  }
  
  // Render in Guest view (if exists)
  renderGuestUnifiedFeed();
}

/**
 * Render unified feed in guest view
 */
function renderGuestUnifiedFeed() {
  const guestFeedContainer = el("guestUnifiedFeedContainer");
  
  if (guestFeedContainer) {
    // Clear existing
    guestFeedContainer.innerHTML = '';
    
    if (state.unifiedFeed.length === 0) {
      const noMsgEl = document.createElement("div");
      noMsgEl.className = "guest-no-messages";
      noMsgEl.textContent = "No reactions yet...";
      guestFeedContainer.appendChild(noMsgEl);
    } else {
      // Use DocumentFragment for efficient DOM operations
      const fragment = document.createDocumentFragment();
      
      // Render feed items
      state.unifiedFeed.forEach(item => {
        const messageEl = document.createElement("div");
        messageEl.className = item.isEmoji ? "guest-feed-item guest-feed-item-emoji" : "guest-feed-item";
        messageEl.setAttribute('data-testid', 'message-item');
        const safeContent = escapeHtml(item.content);
        const safeSender = escapeHtml(item.senderName);
        const safeId = escapeHtml(item.id || '');
        const safeSenderId = escapeHtml(item.senderId || '');
        messageEl.innerHTML = `
          <div class="guest-feed-content">${safeContent}</div>
          <div class="guest-feed-sender">${safeSender}</div>
          <div style="margin-top:2px;">
            <button class="btn-report-small"
              data-report-msg="1"
              data-msg-id="${safeId}"
              data-msg-sender="${safeSenderId}">🚩 Report</button>
          </div>
        `;
        fragment.appendChild(messageEl);
      });
      
      guestFeedContainer.appendChild(fragment);
      
      // Auto-scroll to bottom to show newest message
      setTimeout(() => {
        guestFeedContainer.scrollTop = guestFeedContainer.scrollHeight;
      }, 0);
    }
  }
}

/**
 * Handle FEED_ITEM messages from Party Pass messaging suite
 * Messages appear inline in the feed, oldest first, and auto-disappear after TTL
 */
function handleFeedItem(item) {
  if (!item || !item.id) {
    console.warn('[handleFeedItem] Invalid feed item:', item);
    return;
  }
  
  console.log('[handleFeedItem] Received item:', item.id, 'kind:', item.kind);
  
  // Add to feedItems array (oldest first - push to end)
  state.feedItems.push(item);
  
  // Enforce cap of 50 items - use while loop to handle multiple excess items
  while (state.feedItems.length > state.maxMessagingFeedItems) {
    // Remove oldest items (from beginning)
    const removed = state.feedItems.shift();
    // Cancel timeout for removed item if exists
    if (state.feedItemTimeouts.has(removed.id)) {
      clearTimeout(state.feedItemTimeouts.get(removed.id));
      state.feedItemTimeouts.delete(removed.id);
    }
  }
  
  // Render the feed
  renderFeedItems();
  
  // Set up auto-removal timeout
  const ttl = item.ttlMs || 12000;
  const timeoutId = setTimeout(() => {
    removeFeedItem(item.id);
  }, ttl);
  
  state.feedItemTimeouts.set(item.id, timeoutId);
}

/**
 * Remove a feed item by ID
 */
function removeFeedItem(itemId) {
  // Remove from array
  const index = state.feedItems.findIndex(item => item.id === itemId);
  if (index !== -1) {
    state.feedItems.splice(index, 1);
    console.log('[removeFeedItem] Removed item:', itemId);
  }
  
  // Clear timeout
  if (state.feedItemTimeouts.has(itemId)) {
    clearTimeout(state.feedItemTimeouts.get(itemId));
    state.feedItemTimeouts.delete(itemId);
  }
  
  // Re-render
  renderFeedItems();
}

/**
 * Handle FEED_EVENT messages (COPILOT PROMPT 2/4: Unified Feed)
 * This is the canonical handler for the new unified feed system.
 * Deduplicates events and adds them to the unified feed with TTL-based auto-removal.
 * 
 * ROLE-BASED ENFORCEMENT:
 * - DJ emoji events (kind: "dj_emoji") are added to feed only
 * - Guest emoji events (kind: "guest_message") are added to feed only
 * - NO pop-ups, animations, or crowd energy updates triggered here
 * - Animations/energy are handled separately in handleGuestMessageReceived (DJ-side only)
 */
function handleFeedEvent(event) {
  if (!event || !event.id) {
    console.warn('[handleFeedEvent] Invalid event:', event);
    return;
  }
  
  // Check for duplicate using feedSeenIds
  if (state.feedSeenIds.has(event.id)) {
    console.log('[handleFeedEvent] Duplicate event ignored:', event.id);
    return;
  }
  
  // Mark as seen
  state.feedSeenIds.add(event.id);
  
  console.log('[handleFeedEvent] Processing event:', event.id, 'kind:', event.kind);
  
  // Role enforcement logging for DJ emojis
  if (event.kind === 'dj_emoji' && !state.isHost) {
    console.log('[Role Enforcement] Guest received DJ emoji - adding to feed only, no pop-ups/animations');
  }
  
  // Convert FEED_EVENT to unified feed format
  const sender = event.kind === 'dj_emoji' || event.kind === 'host_broadcast' || event.kind === 'dj_short_message' ? 'DJ' : 
                 event.kind === 'system' ? 'SYSTEM' : 'GUEST';
  
  const type = event.isEmoji ? 'emoji' : 
               event.kind === 'host_broadcast' ? 'broadcast' : 
               event.kind === 'dj_short_message' ? 'message' :
               event.kind === 'system' ? 'system' : 'message';
  
  // Add to unified feed using existing function, passing the stable event ID
  // NOTE: This only updates the feed display - does NOT trigger pop-ups, animations, or crowd energy
  addToUnifiedFeed(sender, event.senderName, type, event.text, event.isEmoji, event.id);
  
  // Set up auto-removal timeout based on TTL
  const ttl = event.ttlMs || MESSAGE_TTL_MS;
  setTimeout(() => {
    removeFeedEventById(event.id);
  }, ttl);
}

/**
 * Remove a feed event by ID from unified feed
 */
function removeFeedEventById(eventId) {
  // Find and remove from unifiedFeed
  const index = state.unifiedFeed.findIndex(item => item.id === eventId);
  if (index !== -1) {
    state.unifiedFeed.splice(index, 1);
    console.log('[removeFeedEventById] Removed event:', eventId);
    renderUnifiedFeed();
  }
  
  // Clean up from feedSeenIds (optional - can keep for session to prevent late duplicates)
  // Commenting out to keep IDs for the session
  // state.feedSeenIds.delete(eventId);
}

/**
 * Render feed items in the messaging feed
 */
function renderFeedItems() {
  // For DJ view
  const djFeedContainer = el("djMessagingFeed");
  if (djFeedContainer) {
    djFeedContainer.innerHTML = '';
    
    if (state.feedItems.length === 0) {
      const noMsgEl = document.createElement("div");
      noMsgEl.className = "messaging-feed-empty";
      noMsgEl.textContent = "No messages yet...";
      djFeedContainer.appendChild(noMsgEl);
    } else {
      const fragment = document.createDocumentFragment();
      
      // Render items in order (oldest first)
      state.feedItems.forEach(item => {
        const itemEl = document.createElement("div");
        itemEl.className = `messaging-feed-item messaging-feed-${item.kind}`;
        itemEl.dataset.itemId = item.id;
        
        // Different styling based on kind
        let senderLabel = item.name;
        if (item.kind === 'system_auto') {
          senderLabel = 'Phone Party';
        }
        
        itemEl.innerHTML = `
          <span class="messaging-feed-sender">${escapeHtml(senderLabel)}:</span>
          <span class="messaging-feed-text">${escapeHtml(item.text)}</span>
        `;
        
        fragment.appendChild(itemEl);
      });
      
      djFeedContainer.appendChild(fragment);
      
      // Auto-scroll to bottom (newest message)
      djFeedContainer.scrollTop = djFeedContainer.scrollHeight;
    }
  }
  
  // For Guest view
  const guestFeedContainer = el("guestMessagingFeed");
  if (guestFeedContainer) {
    guestFeedContainer.innerHTML = '';
    
    if (state.feedItems.length === 0) {
      const noMsgEl = document.createElement("div");
      noMsgEl.className = "messaging-feed-empty";
      noMsgEl.textContent = "No messages yet...";
      guestFeedContainer.appendChild(noMsgEl);
    } else {
      const fragment = document.createDocumentFragment();
      
      // Render items in order (oldest first)
      state.feedItems.forEach(item => {
        const itemEl = document.createElement("div");
        itemEl.className = `messaging-feed-item messaging-feed-${item.kind}`;
        itemEl.dataset.itemId = item.id;
        
        // Different styling based on kind
        let senderLabel = item.name;
        if (item.kind === 'system_auto') {
          senderLabel = 'Phone Party';
        }
        
        itemEl.innerHTML = `
          <span class="messaging-feed-sender">${escapeHtml(senderLabel)}:</span>
          <span class="messaging-feed-text">${escapeHtml(item.text)}</span>
        `;
        
        fragment.appendChild(itemEl);
      });
      
      guestFeedContainer.appendChild(fragment);
      
      // Auto-scroll to bottom (newest message)
      guestFeedContainer.scrollTop = guestFeedContainer.scrollHeight;
    }
  }
}

/**
 * Update UI based on Party Pass status
 * Show/hide messaging controls based on active status
 */
// Helper: Check if user has Party Pass entitlement
// PRO_MONTHLY implicitly includes Party Pass features
function hasPartyPassEntitlement() {
  // Check tier-based entitlement
  if (state.userTier === USER_TIER.PRO || state.userTier === USER_TIER.PARTY_PASS) {
    return true;
  }
  // Check active Party Pass flag (from server)
  if (state.partyPassActive) {
    return true;
  }
  // Check party-wide Pro status
  if (state.partyPro) {
    return true;
  }
  return false;
}

// Helper: Check if user has Pro tier entitlement (for DJ typed messages)
// DJ typed messages require PRO_MONTHLY tier only
function hasProTierEntitlement() {
  // Check Pro tier (including PRO_MONTHLY string from server)
  if (state.userTier === USER_TIER.PRO || state.userTier === 'PRO_MONTHLY') {
    return true;
  }
  // Check party-wide Pro status flag
  if (state.partyPro) {
    return true;
  }
  return false;
}

function updatePartyPassUI() {
  const hasPartyPass = hasPartyPassEntitlement();

  // --- 1. Banner state ---
  const banner = el("partyPassBanner");
  const activeStatus = el("partyPassActive");
  const upgradeCard = el("partyPassUpgrade");
  const descEl = el("partyPassDesc");
  const titleEl = el("partyPassTitle");
  const timerEl = el("partyPassTimer");

  if (banner && activeStatus && upgradeCard) {
    if (hasPartyPass) {
      banner.classList.remove("hidden");
      activeStatus.classList.remove("hidden");
      upgradeCard.classList.add("hidden");
      if (titleEl) titleEl.textContent = "Party Pass Active";
      if (descEl) descEl.classList.add("hidden");
      if (timerEl) {
        if (state.userTier === USER_TIER.PARTY_PASS && state.partyPassActive && state.partyPassEndTime) {
          timerEl.classList.remove("hidden");
        } else {
          timerEl.classList.add("hidden");
        }
      }
    } else if (state.partyPro && !state.isHost) {
      banner.classList.remove("hidden");
      activeStatus.classList.remove("hidden");
      upgradeCard.classList.add("hidden");
      if (titleEl) titleEl.textContent = "🎉 Party Pass Active";
      if (descEl) descEl.classList.remove("hidden");
      if (timerEl) timerEl.classList.add("hidden");
    } else if (!state.partyPro && state.isHost) {
      banner.classList.remove("hidden");
      activeStatus.classList.add("hidden");
      upgradeCard.classList.remove("hidden");
      if (timerEl) timerEl.classList.add("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  // --- 2. DJ host controls ---
  const djQuickButtons = el("djQuickButtonsContainer");
  if (djQuickButtons) {
    if (hasPartyPass && state.isHost) {
      djQuickButtons.classList.remove("hidden");
    } else {
      djQuickButtons.classList.add("hidden");
    }
  }

  const djLockedMsg = el("djMessagingLocked");
  if (djLockedMsg) {
    if (!hasPartyPass && state.isHost) {
      djLockedMsg.classList.remove("hidden");
    } else {
      djLockedMsg.classList.add("hidden");
    }
  }

  const djMessagingFeedSection = el("djMessagingFeedSection");
  if (djMessagingFeedSection) {
    if (hasPartyPass && state.isHost) {
      djMessagingFeedSection.classList.remove("hidden");
    } else {
      djMessagingFeedSection.classList.add("hidden");
    }
  }

  // --- 3. Guest messaging UI ---
  const guestQuickReplies = el("guestQuickRepliesContainer");
  if (guestQuickReplies) {
    if (state.partyPassActive && !state.isHost) {
      guestQuickReplies.classList.remove("hidden");
    } else {
      guestQuickReplies.classList.add("hidden");
    }
  }

  const guestChatContainer = el("guestChatInputContainer");
  if (guestChatContainer) {
    if (state.partyPassActive && !state.isHost) {
      guestChatContainer.classList.remove("hidden");
    } else {
      guestChatContainer.classList.add("hidden");
    }
  }

  const guestLockedMsg = el("guestMessagingLocked");
  if (guestLockedMsg) {
    if (!state.partyPassActive && !state.isHost) {
      guestLockedMsg.classList.remove("hidden");
    } else {
      guestLockedMsg.classList.add("hidden");
    }
  }

  const guestMessagingFeedSection = el("guestMessagingFeedSection");
  if (guestMessagingFeedSection) {
    if (state.partyPassActive && !state.isHost) {
      guestMessagingFeedSection.classList.remove("hidden");
    } else {
      guestMessagingFeedSection.classList.add("hidden");
    }
  }

  // --- 4. Streaming party paywall ---
  // YouTube Party is a core feature — show the section for all hosts when enabled.
  const officialAppSyncSection = el("officialAppSyncSection");
  const streamingPartyPaywall = el("streamingPartyPaywall");
  if (state.isHost && _featureFlags.STREAMING_PARTY_ENABLED) {
    if (officialAppSyncSection) officialAppSyncSection.classList.remove('hidden');
    if (streamingPartyPaywall) streamingPartyPaywall.classList.add('hidden');
  } else {
    if (officialAppSyncSection) officialAppSyncSection.classList.add('hidden');
    if (streamingPartyPaywall) streamingPartyPaywall.classList.add('hidden');
  }
}

function createEmojiReactionEffect(emoji) {
  // Create floating emoji animation on DJ screen
  const djOverlay = el("djScreenOverlay");
  if (!djOverlay) return;
  
  const emojiEl = document.createElement("div");
  emojiEl.className = "emoji-reaction-float";
  emojiEl.textContent = emoji;
  
  // Random horizontal position
  const randomX = Math.random() * 80 + 10; // 10-90% of width
  emojiEl.style.left = `${randomX}%`;
  emojiEl.style.bottom = "10%";
  
  djOverlay.appendChild(emojiEl);
  
  // Remove after animation completes
  setTimeout(() => {
    if (emojiEl.parentNode) {
      emojiEl.parentNode.removeChild(emojiEl);
    }
  }, 2000);
}

function triggerDjFlash() {
  const flashOverlay = el("djFlashOverlay");
  if (flashOverlay) {
    flashOverlay.classList.add("flash-active");
    setTimeout(() => {
      flashOverlay.classList.remove("flash-active");
    }, 200);
  }
}

function setupGuestMessageButtons() {
  const messageButtons = document.querySelectorAll(".btn-guest-message");
  
  messageButtons.forEach(btn => {
    btn.onclick = () => {
      // Check spam cooldown
      const now = Date.now();
      if (now - state.lastMessageTimestamp < state.messageCooldownMs) {
        const remainingMs = state.messageCooldownMs - (now - state.lastMessageTimestamp);
        toast(`Please wait ${Math.ceil(remainingMs / 1000)}s before sending another message`, "warning");
        return;
      }
      
      // Check tier permissions for preset messages
      if (state.userTier === USER_TIER.FREE) {
        showUpsellModal('Unlock Messages', 'Unlock messages with Pro!');
        return;
      }
      
      // Check chat mode
      if (state.chatMode === "LOCKED") {
        toast("Chat is locked by DJ", "warning");
        return;
      }
      
      if (state.chatMode === "EMOJI_ONLY") {
        toast("DJ has enabled emoji-only mode", "warning");
        return;
      }
      
      const message = btn.getAttribute("data-message");
      if (message && state.ws) {
        send({ t: "GUEST_MESSAGE", message: message, isEmoji: false });
        state.lastMessageTimestamp = now;
        
        // Visual feedback
        btn.classList.add("btn-sending");
        setTimeout(() => {
          btn.classList.remove("btn-sending");
        }, 300);
        
        toast(`Sent: ${message}`);
      }
    };
  });
}

function setupEmojiReactionButtons() {
  const emojiButtons = document.querySelectorAll(".btn-emoji-reaction");
  
  emojiButtons.forEach(btn => {
    btn.onclick = () => {
      // Check spam cooldown (shorter cooldown for emojis - 1 second)
      const now = Date.now();
      const emojiCooldownMs = 1000;
      if (now - state.lastMessageTimestamp < emojiCooldownMs) {
        const remainingMs = emojiCooldownMs - (now - state.lastMessageTimestamp);
        toast(`Please wait ${Math.ceil(remainingMs / 1000)}s before sending another reaction`, "warning");
        return;
      }
      
      // Check chat mode (emojis blocked only in LOCKED mode)
      if (state.chatMode === "LOCKED") {
        toast("Chat is locked by DJ", "warning");
        return;
      }
      
      // All tiers can send emojis (unless chat is locked)
      const emoji = btn.getAttribute("data-emoji");
      const message = btn.getAttribute("data-message") || emoji;
      if (message && state.ws) {
        send({ t: "GUEST_MESSAGE", message: message, isEmoji: true });
        state.lastMessageTimestamp = now;
        
        // Visual feedback
        btn.classList.add("btn-sending");
        setTimeout(() => {
          btn.classList.remove("btn-sending");
        }, 300);
        
        // GUEST POP-UP: Show confirmation toast for guests
        // This is the normal behavior - guests see pop-ups when they send emojis
        toast(`Sent: ${emoji}`);
      }
    };
  });
}

function setupDjPresetMessageButtons() {
  const presetMessageButtons = document.querySelectorAll(".btn-dj-preset-message");
  
  presetMessageButtons.forEach(btn => {
    btn.onclick = () => {
      // Check spam cooldown
      const now = Date.now();
      if (now - state.lastMessageTimestamp < state.messageCooldownMs) {
        const remainingMs = state.messageCooldownMs - (now - state.lastMessageTimestamp);
        toast(`Please wait ${Math.ceil(remainingMs / 1000)}s before sending another message`, "warning");
        return;
      }
      
      // Only host can send DJ preset messages
      if (!state.isHost) {
        console.warn("[DJ Preset] Only DJ can send preset messages");
        return;
      }
      
      // Check tier using helper (Party Pass or Pro only)
      // Server will validate and send ERROR if tier insufficient
      if (!hasPartyPassEntitlement()) {
        console.warn("[DJ Preset] Party Pass or Pro required");
        return;
      }
      
      const message = btn.getAttribute("data-message");
      if (message && state.ws) {
        send({ t: "HOST_BROADCAST_MESSAGE", message: message });
        state.lastMessageTimestamp = now;
        
        // Visual feedback
        btn.classList.add("btn-sending");
        setTimeout(() => {
          btn.classList.remove("btn-sending");
        }, 300);
        
        // Do not add to unified feed here - wait for server echo to avoid duplicates
      }
    };
  });
}

function setupDjEmojiReactionButtons() {
  const djEmojiButtons = document.querySelectorAll("#djEmojiReactionsSection .btn-emoji-reaction");
  
  djEmojiButtons.forEach(btn => {
    btn.onclick = () => {
      // Check spam cooldown (shorter cooldown for emojis - 1 second)
      const now = Date.now();
      const emojiCooldownMs = 1000;
      if (now - state.lastMessageTimestamp < emojiCooldownMs) {
        const remainingMs = emojiCooldownMs - (now - state.lastMessageTimestamp);
        // DJ: No toast pop-ups for cooldown, just silently block
        console.warn(`[DJ Emoji] Cooldown: ${Math.ceil(remainingMs / 1000)}s remaining`);
        return;
      }
      
      // ROLE CHECK: Only host/DJ can send DJ emojis
      if (!state.isHost) {
        console.warn("[DJ Emoji] Only DJ can send emojis from this panel");
        return;
      }
      
      // Check tier using helper (Party Pass or Pro only)
      // Server will validate and send ERROR if tier insufficient
      if (!hasPartyPassEntitlement()) {
        console.warn("[DJ Emoji] Party Pass or Pro required");
        return;
      }
      
      const emoji = btn.getAttribute("data-emoji");
      const message = btn.getAttribute("data-message") || emoji;
      
      if (message) {
        state.lastMessageTimestamp = now;
        
        // Visual feedback
        btn.classList.add("btn-sending");
        setTimeout(() => {
          btn.classList.remove("btn-sending");
        }, 300);
        
        // Show emoji on DJ screen immediately (visual effect only)
        createEmojiReactionEffect(emoji);
        
        // Trigger flash effect
        triggerDjFlash();
        
        // Do not add to unified feed here - wait for server echo to avoid duplicates
      
        // Track the emoji (DJ session stats only)
        trackReaction(emoji);
        
        // IMPORTANT: DJ emoji clicks do NOT generate crowd energy
        // Crowd energy is ONLY from guest reactions
        // Do not call increaseCrowdEnergy() here
        
        // Broadcast to guests via WebSocket if connected
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          send({ t: "DJ_EMOJI", emoji: message });
        }
        
        // NO TOAST POP-UP for DJ - feedback appears in Guest Reaction Box via server echo
        // DJ reactions appear in live reaction box but don't affect crowd energy or leaderboard
      }
    };
  });
}

function setupChatModeSelector() {
  const chatModeRadios = document.querySelectorAll('input[name="chatMode"]');
  
  chatModeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked && state.ws && state.isHost) {
        const mode = e.target.value;
        send({ t: "CHAT_MODE_SET", mode: mode });
        toast(`Chat mode: ${mode}`);
      }
    });
  });
}

// Automated hype messages
const hypeMessages = {
  trackStart: [
    "🔥 Let's go!",
    "🎵 Here we go!",
    "💥 Drop incoming!",
    "🎉 Time to vibe!",
    "✨ New track energy!"
  ],
  guestJoin: [
    "👋 Welcome to the party!",
    "🎉 Someone joined!",
    "✨ New energy in the room!",
    "👥 Squad getting bigger!"
  ],
  peakEnergy: [
    "🔥🔥🔥 The energy!",
    "💥 Everyone's vibing!",
    "🎉 This is the moment!",
    "⚡ Peak hype achieved!"
  ]
};

// Send automated hype message
function sendAutoHypeMessage(eventType) {
  if (!state.isHost || !state.ws) return;
  
  const messages = hypeMessages[eventType];
  if (!messages || messages.length === 0) return;
  
  // Pick a random message from the category
  const message = messages[Math.floor(Math.random() * messages.length)];
  
  // Send as DJ message
  send({ t: "DJ_MESSAGE", message: message, isHype: true });
  console.log(`[Hype] Auto-sent: ${message}`);
}

function updateChatModeUI() {
  const mode = state.chatMode;
  
  // Update host UI
  if (state.isHost) {
    const radioOpen = el("chatModeOpen");
    const radioEmojiOnly = el("chatModeEmojiOnly");
    const radioLocked = el("chatModeLocked");
    
    if (radioOpen && mode === "OPEN") radioOpen.checked = true;
    if (radioEmojiOnly && mode === "EMOJI_ONLY") radioEmojiOnly.checked = true;
    if (radioLocked && mode === "LOCKED") radioLocked.checked = true;
  }
  
  // Update guest UI
  if (!state.isHost) {
    const badge = el("guestChatModeBadge");
    const icon = el("guestChatModeIcon");
    const text = el("guestChatModeText");
    const textMessages = el("guestTextMessages");
    const emojiReactions = el("guestEmojiReactions");
    
    if (badge) {
      badge.className = "guest-chat-mode-badge";
      if (mode === "EMOJI_ONLY") badge.classList.add("mode-emoji-only");
      if (mode === "LOCKED") badge.classList.add("mode-locked");
    }
    
    if (icon) {
      if (mode === "OPEN") icon.textContent = "💬";
      if (mode === "EMOJI_ONLY") icon.textContent = "😀";
      if (mode === "LOCKED") icon.textContent = "🔒";
    }
    
    if (text) {
      text.textContent = `Chat: ${mode.replace("_", " ")}`;
    }
    
    // Control visibility based on BOTH chat mode AND user tier
    if (textMessages) {
      // Show text messages only if:
      // - Chat mode is OPEN AND
      // - User tier is PARTY_PASS or PRO (not FREE)
      if (mode === "OPEN" && (state.userTier === USER_TIER.PARTY_PASS || state.userTier === USER_TIER.PRO)) {
        textMessages.style.display = "flex";
        textMessages.classList.remove("disabled");
      } else {
        textMessages.style.display = "none";
      }
    }
    
    if (emojiReactions) {
      if (mode === "LOCKED") {
        emojiReactions.classList.add("disabled");
      } else {
        emojiReactions.classList.remove("disabled");
      }
    }
  }
}


function hashStr(s){
  let h = 2166136261;
  for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

function computeQualitySnapshot() {
  const n = state.snapshot?.members?.length || 1;
  let base = 90;
  if (state.source === "external") base -= 8;
  if (state.source === "mic") base -= 3;

  let score = base - Math.min(12, (n - 1) * 1.2);
  if (state.code) {
    const seed = hashStr(state.code + ":" + n);
    const wobble = (seed % 9) - 4;
    score += wobble;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  let tier = "Excellent", hint = "Great conditions";
  if (score < 85) { tier = "Good"; hint = "Minor drift possible"; }
  if (score < 70) { tier = "Limited"; hint = "More phones may degrade"; }
  if (score < 50) { tier = "Poor"; hint = "Blocking new joins"; }

  const baseLimit = state.source === "local" ? 6 : (state.source === "mic" ? 5 : 4);
  let rec = baseLimit;
  if (score < 85) rec = Math.max(2, baseLimit - 1);
  if (score < 70) rec = Math.max(2, baseLimit - 2);
  if (score < 50) rec = 2;

  const hardCap = state.source === "local" ? 10 : 8;
  return { score, tier, hint, rec, hardCap, n };
}

function updateQualityUI() {
  const q = computeQualitySnapshot();
  el("qualityScore").textContent = q.score;
  el("qualityTier").textContent = q.tier;
  el("qualityHint").textContent = q.hint;
  el("qualityFill").style.width = `${q.score}%`;
  el("limitsLine").textContent = `Recommended: ${q.rec} · Hard cap: ${q.hardCap}`;

  let col = "rgba(90,169,255,0.7)";
  if (q.score < 85) col = "rgba(255,198,90,0.75)";
  if (q.score < 70) col = "rgba(255,140,90,0.75)";
  if (q.score < 50) col = "rgba(255,90,106,0.75)";
  el("qualityFill").style.background = col;
}

function updatePlaybackUI() {
  el("btnPlay").disabled = state.adActive;
  el("btnPause").disabled = state.adActive;
  const isProOrPartyPass = state.partyPro || state.partyPassActive;
  el("btnAd").disabled = isProOrPartyPass || state.source === "mic";
  el("adLine").textContent = isProOrPartyPass ? "No ads (Pro)"
    : (state.source === "mic" ? "No ads in mic mode" : "Ads interrupt playback for free users.");
}

// Music file handling functions
function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function updateMusicStatus(message, isError = false) {
  const statusEl = el("statusMessage");
  if (statusEl) {
    statusEl.textContent = message;
    if (isError) {
      statusEl.style.color = "var(--danger)";
    } else {
      statusEl.style.color = "var(--text)";
    }
  }
  console.log(`[Music] Status: ${message}`);
}

function showMusicWarning(message, isError = false) {
  const warningEl = el("musicWarning");
  if (warningEl) {
    warningEl.textContent = message;
    warningEl.classList.remove("hidden");
    if (isError) {
      warningEl.classList.add("error");
    } else {
      warningEl.classList.remove("error");
    }
  }
}

function hideMusicWarning() {
  const warningEl = el("musicWarning");
  if (warningEl) {
    warningEl.classList.add("hidden");
    warningEl.classList.remove("error");
  }
}

function cleanupMusicPlayer() {
  // Stop audio playback
  const audioEl = musicState.audioElement;
  if (audioEl) {
    audioEl.pause();
    audioEl.src = "";
    audioEl.load(); // Reset the audio element
  }
  
  // Revoke ObjectURL to prevent memory leak
  if (musicState.currentObjectURL) {
    URL.revokeObjectURL(musicState.currentObjectURL);
    musicState.currentObjectURL = null;
  }
  
  // Reset music state
  musicState.selectedFile = null;
  
  console.log("[Music] Player cleaned up");
}

function playQueuedTrack() {
  if (!musicState.queuedFile || !musicState.queuedObjectURL) {
    console.log("[DJ Queue] No queued track available");
    toast("No track queued");
    return;
  }

  console.log(`[DJ Queue] Playing queued track: ${musicState.queuedFile.name}`);

  // Clean up current track
  if (musicState.currentObjectURL) {
    URL.revokeObjectURL(musicState.currentObjectURL);
  }

  // Move queued track to current
  musicState.selectedFile = musicState.queuedFile;
  musicState.currentObjectURL = musicState.queuedObjectURL;
  
  // Move queued track upload info to current
  if (musicState.queuedTrack) {
    musicState.currentTrack = musicState.queuedTrack;
  }

  // Clear queue
  musicState.queuedFile = null;
  musicState.queuedObjectURL = null;
  musicState.queuedTrack = null;

  // Update audio element
  const audioEl = musicState.audioElement;
  if (audioEl && musicState.currentObjectURL) {
    audioEl.src = musicState.currentObjectURL;
    audioEl.load();
    
    // SECTION 1A: Client guard - check for valid trackUrl before auto-playing with guests
    if (state.isHost && state.guestCount > 0) {
      const hasValidTrack = musicState.currentTrack 
        && musicState.currentTrack.uploadStatus === 'ready' 
        && musicState.currentTrack.trackUrl;
      
      if (!hasValidTrack) {
        console.log("[DJ Queue] Auto-play blocked - no valid trackUrl for synced playback");
        updateMusicStatus(`Ready: ${musicState.selectedFile.name}`);
        toast("⏳ Upload in progress - track queued, will play when ready");
        return;
      }
    }
    
    // Auto-play the queued track
    audioEl.play()
      .then(() => {
        state.playing = true;
        updateMusicStatus(`Playing: ${musicState.selectedFile.name}`);
        console.log("[DJ Queue] Auto-playing queued track");
        
        // Track play for session stats (Feature 3)
        if (!state.sessionStats.tracksPlayed) {
          state.sessionStats.tracksPlayed = 1;
        }
        
        // Start beat-aware UI (Feature 8)
        startBeatPulse();
        
        // Update DJ screen
        updateDjScreen();
        
        // Show DJ screen for host
        if (state.isHost) {
          showDjScreen();
        }
        
        // Broadcast to guests
        if (state.isHost && state.ws) {
          // Use auto-uploaded track URL from musicState
          const trackUrl = musicState.currentTrack ? musicState.currentTrack.trackUrl : null;
          
          send({ 
            t: "HOST_PLAY",
            trackUrl: trackUrl,
            filename: musicState.selectedFile.name,
            startPosition: 0
          });
        }
        
        // Update back to DJ button visibility
        updateBackToDjButton();
      })
      .catch((error) => {
        console.error("[DJ Queue] Auto-play failed:", error);
        updateMusicStatus(`Ready: ${musicState.selectedFile.name}`);
        toast("Track loaded. Press play to start.");
      });
  } else {
    console.log("[DJ Queue] Playing in simulated mode");
    state.playing = true;
    updateMusicStatus(`Playing: ${musicState.selectedFile.name} (simulated)`);
    
    // Track play for session stats (Feature 3)
    if (!state.sessionStats.tracksPlayed) {
      state.sessionStats.tracksPlayed = 1;
    }
    
    // Start beat-aware UI (Feature 8)
    startBeatPulse();
    
    updateDjScreen();
    
    // Show DJ screen for host even in simulated mode
    if (state.isHost) {
      showDjScreen();
    }
    
    // Update back to DJ button visibility
    updateBackToDjButton();
  }

  toast(`♫ Now playing: ${musicState.selectedFile.name}`);
}

// ========================================
// PHASE 7: Queue Management API Functions
// ========================================

/**
 * Add a track to the queue (host only)
 */
async function queueTrackToServer(track) {
  if (!state.isHost || !state.hostId || !state.code) {
    console.error("[Queue] Cannot queue track: not host or missing hostId/code");
    toast("Only the host can manage the queue", "error");
    return false;
  }
  
  try {
    const response = await fetch(API_BASE + `/api/party/${state.code}/queue-track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostId: state.hostId,
        trackId: track.trackId,
        trackUrl: track.trackUrl,
        title: track.title,
        durationMs: track.durationMs,
        filename: track.filename,
        contentType: track.contentType,
        sizeBytes: track.sizeBytes
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to queue track');
    }
    
    const data = await response.json();
    console.log("[Queue] Track queued successfully:", data);
    
    // Update local state (will also be updated via WS broadcast)
    musicState.queue = data.queue;
    updateHostQueueUI();
    
    toast("✓ Track added to queue");
    return true;
  } catch (error) {
    console.error("[Queue] Error queueing track:", error);
    toast(error.message || "Failed to queue track", "error");
    return false;
  }
}

/**
 * Play next track from queue (host only)
 */
async function playNextFromQueue() {
  if (!state.isHost || !state.hostId || !state.code) {
    console.error("[Queue] Cannot play next: not host or missing hostId/code");
    return false;
  }
  
  try {
    const response = await fetch(API_BASE + `/api/party/${state.code}/play-next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostId: state.hostId
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to play next track');
    }
    
    const data = await response.json();
    console.log("[Queue] Playing next track:", data);
    
    // Update local state (will also be updated via WS broadcast)
    musicState.currentTrack = data.currentTrack;
    musicState.queue = data.queue;
    updateHostQueueUI();
    
    toast("♫ Playing next track");
    return true;
  } catch (error) {
    console.error("[Queue] Error playing next:", error);
    toast(error.message || "Failed to play next track", "error");
    return false;
  }
}

/**
 * Remove a track from queue (host only)
 */
async function removeQueueTrack(trackId) {
  if (!state.isHost || !state.hostId || !state.code) {
    console.error("[Queue] Cannot remove track: not host or missing hostId/code");
    return false;
  }
  
  try {
    const response = await fetch(API_BASE + `/api/party/${state.code}/remove-track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostId: state.hostId,
        trackId: trackId
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to remove track');
    }
    
    const data = await response.json();
    console.log("[Queue] Track removed:", data);
    
    // Update local state (will also be updated via WS broadcast)
    musicState.queue = data.queue;
    updateHostQueueUI();
    
    toast("✓ Track removed from queue");
    return true;
  } catch (error) {
    console.error("[Queue] Error removing track:", error);
    toast(error.message || "Failed to remove track", "error");
    return false;
  }
}

/**
 * Clear all tracks from queue (host only)
 */
async function clearQueue() {
  if (!state.isHost || !state.hostId || !state.code) {
    console.error("[Queue] Cannot clear queue: not host or missing hostId/code");
    return false;
  }
  
  try {
    const response = await fetch(API_BASE + `/api/party/${state.code}/clear-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostId: state.hostId
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to clear queue');
    }
    
    const data = await response.json();
    console.log("[Queue] Queue cleared:", data);
    
    // Update local state (will also be updated via WS broadcast)
    musicState.queue = data.queue;
    updateHostQueueUI();
    
    toast("✓ Queue cleared");
    return true;
  } catch (error) {
    console.error("[Queue] Error clearing queue:", error);
    toast(error.message || "Failed to clear queue", "error");
    return false;
  }
}

/**
 * Move track up in queue (host only)
 */
async function moveQueueTrackUp(index) {
  if (index <= 0) return;
  await reorderQueueTrack(index, index - 1);
}

/**
 * Move track down in queue (host only)
 */
async function moveQueueTrackDown(index) {
  if (index >= musicState.queue.length - 1) return;
  await reorderQueueTrack(index, index + 1);
}

/**
 * Reorder track in queue (host only)
 */
async function reorderQueueTrack(fromIndex, toIndex) {
  if (!state.isHost || !state.hostId || !state.code) {
    console.error("[Queue] Cannot reorder: not host or missing hostId/code");
    return false;
  }
  
  try {
    const response = await fetch(API_BASE + `/api/party/${state.code}/reorder-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostId: state.hostId,
        fromIndex: fromIndex,
        toIndex: toIndex
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to reorder queue');
    }
    
    const data = await response.json();
    console.log("[Queue] Queue reordered:", data);
    
    // Update local state (will also be updated via WS broadcast)
    musicState.queue = data.queue;
    updateHostQueueUI();
    
    return true;
  } catch (error) {
    console.error("[Queue] Error reordering queue:", error);
    toast(error.message || "Failed to reorder queue", "error");
    return false;
  }
}

function checkFileTypeSupport(file) {
  const audio = musicState.audioElement || document.createElement("audio");
  
  // Try to check if the browser can play this file type
  if (file.type) {
    const canPlay = audio.canPlayType(file.type);
    if (canPlay === "" || canPlay === "no") {
      return false;
    }
  } else {
    // If file.type is empty, check file extension as fallback
    const extension = file.name.split('.').pop().toLowerCase();
    const commonFormats = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus'];
    if (!commonFormats.includes(extension)) {
      return false;
    }
  }
  
  return true;
}

function handleMusicFileSelection(file) {
  if (!file) return;
  
  console.log(`[Music] File selected:`, file.name, file.type, file.size);
  
  // Revoke old ObjectURL to prevent memory leaks
  if (musicState.currentObjectURL) {
    URL.revokeObjectURL(musicState.currentObjectURL);
    musicState.currentObjectURL = null;
  }
  
  hideMusicWarning();
  
  // Store the selected file
  musicState.selectedFile = file;
  
  // Show file info
  const filenameEl = el("musicFilename");
  const filesizeEl = el("musicFilesize");
  const infoEl = el("musicInfo");
  
  if (filenameEl) filenameEl.textContent = file.name;
  if (filesizeEl) filesizeEl.textContent = formatFileSize(file.size);
  if (infoEl) infoEl.classList.remove("hidden");
  
  // Show "Change file" button, hide "Choose music file" button
  const chooseBtnEl = el("btnChooseMusic");
  const changeBtnEl = el("btnChangeMusic");
  if (chooseBtnEl) chooseBtnEl.classList.add("hidden");
  if (changeBtnEl) changeBtnEl.classList.remove("hidden");
  
  // Check file size (50MB = 52428800 bytes)
  const MAX_SIZE = 52428800;
  const warnings = [];
  
  if (file.size > MAX_SIZE) {
    warnings.push("⚠️ Large file — may take longer to load or stream.");
  }
  
  // Check if browser can play this file type
  const canPlay = checkFileTypeSupport(file);
  if (!canPlay) {
    warnings.push("⚠️ This file type may not play on this device. Try MP3 or M4A.");
  }
  
  // Display warnings
  if (warnings.length > 0) {
    showMusicWarning(warnings.join(" "), !canPlay);
  }
  
  // Create ObjectURL and set audio source for local playback
  const objectURL = URL.createObjectURL(file);
  musicState.currentObjectURL = objectURL;
  
  const audioEl = musicState.audioElement;
  if (audioEl) {
    audioEl.src = objectURL;
    audioEl.load(); // Force buffering/loading, especially important for iOS Safari
    updateMusicStatus(`File selected: ${file.name}`);
    
    // Broadcast TRACK_SELECTED to guests
    if (state.isHost && state.ws) {
      state.nowPlayingFilename = file.name;
      send({ t: "HOST_TRACK_SELECTED", filename: file.name });
    }
  }
  
  toast(`✓ Music file selected: ${file.name}`);
  
  // AUTO-UPLOAD: Upload the file immediately for guest streaming
  // PHASE 2: Use presigned upload for production
  if (state.isHost) {
    uploadTrackToServerPresigned(file);
  }
}

// PHASE 1: Helper function to enable/disable play button consistently
function setPlayButtonEnabled(enabled) {
  const playBtn = el("btnPlay");
  if (playBtn) {
    playBtn.disabled = !enabled;
    if (enabled) {
      playBtn.classList.remove('disabled');
    } else {
      playBtn.classList.add('disabled');
    }
  }
}

// PHASE 2: Upload track using presigned URL (direct to R2) with retry and fallback
async function uploadTrackToServerPresigned(file) {
  if (!file) return;
  
  console.log(`[Upload] Starting presigned upload for ${file.name}`);
  updateMusicStatus(`Uploading ${file.name}...`);
  
  // PHASE 1: Disable play button during upload
  setPlayButtonEnabled(false);
  
  // Show upload progress UI
  const uploadStatusEl = el("uploadStatus");
  const uploadProgressEl = el("uploadProgress");
  if (uploadStatusEl) uploadStatusEl.classList.remove("hidden");
  
  try {
    // Step 1: Get presigned URL
    console.log('[Upload] Requesting presigned URL...');
    const presignResponse = await fetch(API_BASE + '/api/tracks/presign-put', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || 'audio/mpeg',
        sizeBytes: file.size
      })
    });
    
    if (!presignResponse.ok) {
      // Fallback to traditional upload
      console.warn('[Upload] Presigned upload not supported, falling back to traditional upload');
      return uploadTrackToServer(file);
    }
    
    const presignData = await presignResponse.json();
    console.log('[Upload] Got presigned URL, uploading directly to R2...');
    
    // Step 2: PUT file directly to R2 with retry logic
    let uploadSuccess = false;
    let lastError = null;
    
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const xhr = new XMLHttpRequest();
        
        // Track upload progress
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percentComplete = Math.round((e.loaded / e.total) * 100);
            musicState.uploadProgress = percentComplete;
            if (uploadProgressEl) {
              uploadProgressEl.textContent = `Uploading: ${percentComplete}%`;
            }
            const progressBarEl = el("uploadProgressBar");
            if (progressBarEl) {
              progressBarEl.style.width = `${percentComplete}%`;
            }
            console.log(`[Upload] Progress: ${percentComplete}%`);
          }
        });
        
        await new Promise((resolve, reject) => {
          xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else if (xhr.status === 0) {
              reject(new Error('Network error during upload'));
            } else {
              reject(new Error(`Upload failed with status ${xhr.status}`));
            }
          });
          
          xhr.addEventListener('error', () => {
            reject(new Error('Network error during upload'));
          });
          
          xhr.addEventListener('abort', () => {
            reject(new Error('Upload aborted'));
          });
          
          xhr.ontimeout = () => {
            reject(new Error('Upload timed out'));
          };
          
          xhr.open('PUT', presignData.putUrl);
          xhr.setRequestHeader('Content-Type', file.type || 'audio/mpeg');
          xhr.timeout = 60000;
          xhr.send(file);
        });
        
        uploadSuccess = true;
        console.log('[Upload] Direct R2 upload complete');
        break;
      } catch (err) {
        lastError = err;
        console.error(`[Upload] Attempt ${attempt} failed:`, err.message);
        
        if (attempt < 2) {
          console.log('[Upload] Retrying in 800ms...');
          await new Promise(resolve => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS));
        }
      }
    }
    
    if (!uploadSuccess) {
      // Fall back to legacy upload instead of leaving UI stuck
      console.warn('[Upload] Direct upload failed after retries. Falling back to legacy upload...');
      updateMusicStatus('Direct upload failed. Falling back…');
      if (uploadProgressEl) {
        uploadProgressEl.textContent = 'Falling back to legacy upload...';
      }
      const progressBarEl = el("uploadProgressBar");
      if (progressBarEl) {
        progressBarEl.style.width = '0%';
      }
      return uploadTrackToServer(file);
    }
    
    // Step 3: Set party track (broadcast to guests)
    console.log('[Upload] Setting party track...');
    const setTrackResponse = await fetch(API_BASE + '/api/set-party-track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyCode: state.partyCode,
        trackId: presignData.trackId,
        trackUrl: presignData.trackUrl,
        filename: file.name,
        contentType: file.type || 'audio/mpeg'
      })
    });
    
    if (!setTrackResponse.ok) {
      throw new Error('Failed to set party track');
    }
    
    // Wait for audio metadata to get accurate duration
    const audioEl = musicState.audioElement;
    if (audioEl) {
      const handleMetadata = () => {
        const durationMs = audioEl.duration ? Math.round(audioEl.duration * 1000) : null;
        
        musicState.currentTrack = {
          trackId: presignData.trackId,
          trackUrl: presignData.trackUrl,
          title: file.name,
          durationMs: durationMs,
          uploadStatus: 'ready',
          filename: file.name
        };
        
        updateMusicStatus(`✓ Ready: ${file.name}`);
        if (uploadProgressEl) {
          uploadProgressEl.textContent = `✓ Ready`;
        }
        toast(`✓ Track uploaded and ready`);
        setPlayButtonEnabled(true);
        
        // Broadcast to guests
        if (state.isHost && state.ws) {
          send({ 
            t: "HOST_TRACK_SELECTED", 
            trackId: presignData.trackId,
            trackUrl: presignData.trackUrl,
            filename: file.name 
          });
          state.nowPlayingFilename = file.name;
        }
        
        setTimeout(() => {
          if (uploadStatusEl) uploadStatusEl.classList.add("hidden");
        }, 2000);
      };
      
      if (audioEl.readyState >= 1) {
        handleMetadata();
      } else {
        audioEl.addEventListener('loadedmetadata', handleMetadata, { once: true });
      }
    } else {
      musicState.currentTrack = {
        trackId: presignData.trackId,
        trackUrl: presignData.trackUrl,
        title: file.name,
        durationMs: null,
        uploadStatus: 'ready',
        filename: file.name
      };
      
      updateMusicStatus(`✓ Ready: ${file.name}`);
      if (uploadProgressEl) {
        uploadProgressEl.textContent = `✓ Ready`;
      }
      toast(`✓ Track uploaded and ready`);
      setPlayButtonEnabled(true);
    }
    
  } catch (error) {
    console.error(`[Upload] Error during presigned upload:`, error);
    updateMusicStatus(`Upload error: ${error.message}`);
    toast(`Upload failed: ${error.message}`);
    if (uploadStatusEl) uploadStatusEl.classList.add("hidden");
    setPlayButtonEnabled(true);
  }
}

// Upload track to server for guest streaming (DEPRECATED: Use uploadTrackToServerPresigned)
async function uploadTrackToServer(file) {
  if (!file) return;
  
  console.log(`[Upload] Starting upload for ${file.name}`);
  updateMusicStatus(`Uploading ${file.name}...`);
  
  // PHASE 1: Disable play button during upload
  setPlayButtonEnabled(false);
  
  // Show upload progress UI
  const uploadStatusEl = el("uploadStatus");
  const uploadProgressEl = el("uploadProgress");
  if (uploadStatusEl) uploadStatusEl.classList.remove("hidden");
  
  try {
    const formData = new FormData();
    formData.append('audio', file);
    
    const xhr = new XMLHttpRequest();
    
    // Track upload progress
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percentComplete = Math.round((e.loaded / e.total) * 100);
        musicState.uploadProgress = percentComplete;
        if (uploadProgressEl) {
          uploadProgressEl.textContent = `Uploading: ${percentComplete}%`;
        }
        // Update progress bar
        const progressBarEl = el("uploadProgressBar");
        if (progressBarEl) {
          progressBarEl.style.width = `${percentComplete}%`;
        }
        console.log(`[Upload] Progress: ${percentComplete}%`);
      }
    });
    
    // Handle completion
    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        try {
          const response = JSON.parse(xhr.responseText);
          console.log(`[Upload] Upload complete:`, response);
          
          // Wait for audio metadata to get accurate duration
          const audioEl = musicState.audioElement;
          if (audioEl) {
            const handleMetadata = () => {
              const durationMs = audioEl.duration ? Math.round(audioEl.duration * 1000) : null;
              
              // Store track info
              musicState.currentTrack = {
                trackId: response.trackId,
                trackUrl: response.trackUrl,
                title: response.title,
                durationMs: durationMs,
                uploadStatus: 'ready',
                filename: response.filename
              };
              
              updateMusicStatus(`✓ Ready: ${file.name}`);
              if (uploadProgressEl) {
                uploadProgressEl.textContent = `✓ Ready`;
              }
              toast(`✓ Track uploaded and ready`);
              
              // PHASE 1: Re-enable play button
              setPlayButtonEnabled(true);
              
              // Broadcast TRACK_SELECTED to guests with trackId and trackUrl
              if (state.isHost && state.ws) {
                try {
                  send({ 
                    t: "HOST_TRACK_SELECTED", 
                    trackId: response.trackId,
                    trackUrl: response.trackUrl,
                    filename: file.name 
                  });
                  // Only update state after successful send
                  state.nowPlayingFilename = file.name;
                } catch (e) {
                  console.error("[Upload] Error broadcasting track selected:", e);
                }
              }
              
              // Hide upload status after 2 seconds
              setTimeout(() => {
                if (uploadStatusEl) uploadStatusEl.classList.add("hidden");
              }, 2000);
            };
            
            if (audioEl.readyState >= 1) {
              // Metadata already loaded
              handleMetadata();
            } else {
              // Wait for metadata
              audioEl.addEventListener('loadedmetadata', handleMetadata, { once: true });
            }
          } else {
            // No audio element - store without duration
            musicState.currentTrack = {
              trackId: response.trackId,
              trackUrl: response.trackUrl,
              title: response.title,
              durationMs: null,
              uploadStatus: 'ready',
              filename: response.filename
            };
            
            updateMusicStatus(`✓ Ready: ${file.name}`);
            if (uploadProgressEl) {
              uploadProgressEl.textContent = `✓ Ready`;
            }
            toast(`✓ Track uploaded and ready`);
            
            // PHASE 1: Re-enable play button
            setPlayButtonEnabled(true);
          }
          
        } catch (e) {
          console.error(`[Upload] Error parsing response:`, e);
          updateMusicStatus(`Upload error: Invalid response`);
          toast(`Upload failed: Invalid response`);
          
          // PHASE 1: Re-enable play button on error
          setPlayButtonEnabled(true);
        }
      } else {
        console.error(`[Upload] Upload failed with status ${xhr.status}`);
        updateMusicStatus(`Upload failed: ${xhr.status}`);
        toast(`Upload failed (${xhr.status})`);
        
        // PHASE 1: Re-enable play button on error
        setPlayButtonEnabled(true);
      }
    });
    
    // Handle errors
    xhr.addEventListener('error', () => {
      console.error(`[Upload] Network error during upload`);
      updateMusicStatus(`Upload failed: Network error`);
      toast(`Upload failed: Network error`);
      if (uploadStatusEl) uploadStatusEl.classList.add("hidden");
      
      // PHASE 1: Re-enable play button on error
      setPlayButtonEnabled(true);
    });
    
    // Send request
    xhr.open('POST', API_BASE + '/api/upload-track');
    xhr.send(formData);
    
  } catch (error) {
    console.error(`[Upload] Error uploading track:`, error);
    updateMusicStatus(`Upload error: ${error.message}`);
    toast(`Upload failed: ${error.message}`);
    if (uploadStatusEl) uploadStatusEl.classList.add("hidden");
    
    // PHASE 1: Re-enable play button on error
    setPlayButtonEnabled(true);
  }
}

// Upload queued track to server for guest streaming
async function uploadQueuedTrackToServer(file) {
  if (!file) return;
  
  console.log(`[Upload Queue] Starting upload for queued track: ${file.name}`);
  
  try {
    const formData = new FormData();
    formData.append('audio', file);
    
    const xhr = new XMLHttpRequest();
    
    // Track upload progress
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percentComplete = Math.round((e.loaded / e.total) * 100);
        console.log(`[Upload Queue] Progress: ${percentComplete}%`);
      }
    });
    
    // Handle completion
    xhr.addEventListener('load', async () => {
      if (xhr.status === 200) {
        try {
          const response = JSON.parse(xhr.responseText);
          console.log(`[Upload Queue] Upload complete:`, response);
          
          // Store queued track info with duration if available from response
          musicState.queuedTrack = {
            trackId: response.trackId,
            trackUrl: response.trackUrl,
            title: response.title,
            durationMs: response.durationMs || null,
            uploadStatus: 'ready',
            filename: response.filename
          };
          
          console.log(`[Upload Queue] Queued track ready for streaming`);
          
          // PHASE 7: Add track to queue via API endpoint
          if (state.isHost && state.hostId && state.code) {
            console.log(`[Upload Queue] Adding track to queue via API`);
            await queueTrackToServer({
              trackId: response.trackId,
              trackUrl: response.trackUrl,
              title: response.title || response.filename,
              filename: response.filename,
              durationMs: response.durationMs,
              contentType: response.contentType,
              sizeBytes: response.sizeBytes
            });
          }
        } catch (e) {
          console.error(`[Upload Queue] Error parsing response:`, e);
          // Set error state
          musicState.queuedTrack = {
            uploadStatus: 'error',
            filename: file.name
          };
        }
      } else {
        console.error(`[Upload Queue] Upload failed with status ${xhr.status}`);
        // Set error state on upload failure
        musicState.queuedTrack = {
          uploadStatus: 'error',
          filename: file.name
        };
      }
    });
    
    // Handle errors
    xhr.addEventListener('error', () => {
      console.error(`[Upload Queue] Network error`);
      // Set error state on network error
      musicState.queuedTrack = {
        uploadStatus: 'error',
        filename: file.name
      };
    });
    
    // Send request
    xhr.open('POST', API_BASE + '/api/upload-track');
    xhr.send(formData);
    
  } catch (error) {
    console.error(`[Upload Queue] Error uploading queued track:`, error);
  }
}

function initializeMusicPlayer() {
  console.log("[Music] initializeMusicPlayer() called");
  
  // Initialize audio element and its event listeners
  const audioEl = el("hostAudioPlayer");
  console.log("[Music] Audio element found:", !!audioEl);
  
  if (audioEl) {
    // Always update the element reference
    musicState.audioElement = audioEl;
    console.log("[Music] Audio element reference updated");
    
    // Restore the audio src if a file was previously selected
    if (musicState.currentObjectURL) {
      audioEl.src = musicState.currentObjectURL;
      console.log("[Music] Restored audio src to audio element");
    }
    
    // Only add event listeners once
    if (!musicState.audioInitialized) {
      console.log("[Music] Setting up audio element event listeners");
      musicState.audioInitialized = true;
      
      // Audio event listeners
      audioEl.addEventListener("play", () => {
        state.playing = true;
        updateMusicStatus("Playing…");
        
        // Update Media Session metadata for background audio
        if (typeof updateMediaSessionMetadata === 'function' && musicState.selectedFile) {
          const rawTitle = musicState.currentTrack?.title || musicState.selectedFile.name;
          const trackTitle = cleanTrackTitle(rawTitle);
          updateMediaSessionMetadata({
            title: trackTitle,
            artist: 'Phone Party DJ',
            album: state.code ? `Party ${state.code}` : 'Local Playback'
          });
          
          // Update position state
          if (typeof updateMediaSessionPosition === 'function' && audioEl.duration) {
            updateMediaSessionPosition(audioEl.duration, audioEl.currentTime, audioEl.playbackRate);
          }
        }
        
        // When host presses play, call start-track API
        if (state.isHost && state.code && musicState.currentTrack) {
          const startPositionSec = audioEl.currentTime || 0;
          
          // Call the new start-track endpoint
          fetch(API_BASE + `/api/party/${state.code}/start-track`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              trackId: musicState.currentTrack.trackId,
              trackUrl: musicState.currentTrack.trackUrl,
              title: musicState.currentTrack.title,
              durationMs: musicState.currentTrack.durationMs,
              startPositionSec: startPositionSec
            })
          })
          .then(res => res.json())
          .then(data => {
            console.log('[Music] Track started:', data);
          })
          .catch(err => {
            console.error('[Music] Error starting track:', err);
          });
        }
      });
      
      audioEl.addEventListener("pause", () => {
        state.playing = false;
        updateMusicStatus("Paused");
      });
      
      audioEl.addEventListener("ended", () => {
        state.playing = false;
        updateMusicStatus("Ended");
        
        // Clear Media Session metadata when track ends
        if (typeof clearMediaSessionMetadata === 'function') {
          clearMediaSessionMetadata();
        }
        
        // Auto-play queued track if available
        if (musicState.queuedFile && state.isHost) {
          console.log("[DJ Queue] Current track ended, playing queued track");
          setTimeout(() => {
            playQueuedTrack();
          }, 500); // Small delay to ensure smooth transition
        }
      });
      
      audioEl.addEventListener("error", (e) => {
        // Only show error if a file was actually selected
        if (!musicState.selectedFile) {
          return;
        }
        
        console.error("[Music] Audio error:", e);
        let errorMsg = "Error: Unable to play this file";
        
        if (audioEl.error) {
          // Use numeric values instead of MediaError constants for better compatibility
          switch (audioEl.error.code) {
            case 1: // MEDIA_ERR_ABORTED
              errorMsg = "Error: Playback aborted";
              break;
            case 2: // MEDIA_ERR_NETWORK
              errorMsg = "Error: Network error";
              break;
            case 3: // MEDIA_ERR_DECODE
              errorMsg = "Error: File format not supported or corrupted";
              break;
            case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
              errorMsg = "Error: File type not supported on this device";
              break;
          }
        }
        
        updateMusicStatus(errorMsg, true);
        showMusicWarning(errorMsg + ". Try a different file format (MP3, M4A).", true);
      });
      
      audioEl.addEventListener("loadedmetadata", () => {
        console.log("[Music] Audio loaded, duration:", audioEl.duration);
      });
      
      // Update Media Session position state during playback
      audioEl.addEventListener("timeupdate", () => {
        if (typeof updateMediaSessionPosition === 'function' && audioEl.duration && !audioEl.paused) {
          updateMediaSessionPosition(audioEl.duration, audioEl.currentTime, audioEl.playbackRate);
        }
      });
    }
  } else {
    console.warn("[Music] Audio element not found - viewParty may not be visible yet");
  }
  
  // File input handler - only set up once
  if (!musicState.fileInputInitialized) {
    const fileInputEl = el("musicFileInput");
    if (fileInputEl) {
      console.log("[Music] Setting up file input handler");
      musicState.fileInputInitialized = true;
      
      fileInputEl.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) {
          handleMusicFileSelection(file);
        }
      });
    }
  }
  
  // Choose music button - set up onclick handlers
  const chooseBtnEl = el("btnChooseMusic");
  if (chooseBtnEl) {
    chooseBtnEl.onclick = () => {
      const fileInputEl = el("musicFileInput");
      if (fileInputEl) {
        fileInputEl.click();
      }
    };
  }
  
  // Change file button
  const changeBtnEl = el("btnChangeMusic");
  if (changeBtnEl) {
    changeBtnEl.onclick = () => {
      const fileInputEl = el("musicFileInput");
      if (fileInputEl) {
        fileInputEl.click();
      }
    };
  }
}


async function activatePartyPass() {
  if (!state.code) {
    toast("Join or start a party first!");
    return;
  }
  
  if (state.partyPassActive) {
    toast("Party Pass already active!");
    return;
  }
  
  // Show loading state
  toast("Processing payment...");
  
  try {
    // Purchase Party Pass through payment flow
    const result = await purchaseUpgrade('party_pass', PAYMENT_METHOD.CARD);
    
    if (!result.success) {
      if (result.cancelled) {
        toast("Payment cancelled");
      } else {
        toast(`Payment failed: ${result.error}`);
      }
      return;
    }
    
    // Apply entitlements from server response
    if (result.entitlements && result.upgrades) {
      applyEntitlementsToState(result.entitlements, result.upgrades);
      
      // Start the timer if Party Pass is active
      if (state.partyPassActive && state.partyPassEndTime) {
        updatePartyPassTimer();
        if (state.partyPassTimerInterval) {
          clearInterval(state.partyPassTimerInterval);
        }
        state.partyPassTimerInterval = setInterval(updatePartyPassTimer, 60000);
      }
      
      // Update UI
      setPlanPill();
      updatePartyPassUI();
      updatePlaybackUI();
      updateBoostsUI();
      
      toast("🎉 Party Pass activated! Enjoy 2 hours of Pro features!");
    }
  } catch (error) {
    console.error('[App] Party Pass activation error:', error);
    toast("Failed to activate Party Pass. Please try again.");
  }
}

function updatePartyPassTimer() {
  if (!state.partyPassActive || !state.partyPassEndTime) return;
  
  const now = Date.now();
  const remaining = state.partyPassEndTime - now;
  
  if (remaining <= 0) {
    // Party Pass expired
    expirePartyPass();
    return;
  }
  
  // Calculate hours and minutes
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
  
  const timerEl = el("partyPassTimer");
  if (timerEl) {
    timerEl.textContent = `${hours}h ${minutes}m remaining`;
  }
}

function expirePartyPass() {
  state.partyPassActive = false;
  state.partyPassEndTime = null;
  // Check if any members have regular Pro (not Party Pass)
  state.partyPro = state.snapshot?.members?.some(m => m.isPro) || false;
  state.userTier = state.isPro ? USER_TIER.PRO : USER_TIER.FREE; // Reset tier
  
  if (state.partyPassTimerInterval) {
    clearInterval(state.partyPassTimerInterval);
    state.partyPassTimerInterval = null;
  }
  
  // Remove from localStorage
  if (state.code) {
    localStorage.removeItem(`partyPass_${state.code}`);
  }
  
  setPlanPill();
  updatePartyPassUI();
  updatePlaybackUI();
  updateBoostsUI(); // Update boosts UI when tier changes
  
  toast("⏰ Party Pass has expired");
}


function checkPartyPassStatus() {
  if (!state.code) return;
  
  const stored = localStorage.getItem(`partyPass_${state.code}`);
  if (!stored) return;
  
  try {
    const data = JSON.parse(stored);
    if (data.active && data.endTime && state.isHost) {
      const now = Date.now();
      if (data.endTime > now) {
        // Party Pass is still valid - restore it from localStorage (only hosts can restore)
        state.partyPassActive = true;
        state.partyPassEndTime = data.endTime;
        state.partyPro = true;
        
        // Start the timer
        updatePartyPassTimer();
        if (state.partyPassTimerInterval) {
          clearInterval(state.partyPassTimerInterval);
        }
        state.partyPassTimerInterval = setInterval(updatePartyPassTimer, 60000); // Update every minute
        
        setPlanPill();
        updatePartyPassUI();
        updatePlaybackUI();
      } else {
        // Party Pass has expired
        localStorage.removeItem(`partyPass_${state.code}`);
      }
    }
  } catch (e) {
    console.error("Error loading Party Pass state:", e);
  }
}

function renderRoom() {
  const wrap = el("members");
  wrap.innerHTML = "";
  const members = state.snapshot?.members || [];

  members.forEach(m => {
    const div = document.createElement("div");
    div.className = "member";
    const left = document.createElement("div");
    left.innerHTML = `
      <div class="name">${escapeHtml(m.name)} ${m.isHost ? '<span class="badge">Host</span>' : ''}</div>
      <div class="meta">${m.isPro ? "Pro" : "Free"} · ID ${m.id}</div>
    `;
    const right = document.createElement("div");
    right.style.display = 'flex';
    right.style.gap = '4px';
    right.style.flexWrap = 'wrap';
    if (state.isHost && !m.isHost) {
      const btnKick = document.createElement("button");
      btnKick.className = "btn";
      btnKick.textContent = "Kick";
      btnKick.onclick = () => send({ t: "KICK", targetId: m.id });
      right.appendChild(btnKick);

      const btnMute = document.createElement("button");
      btnMute.className = "btn-host-action-small";
      btnMute.textContent = "🔇 Mute";
      btnMute.onclick = () => { send({ t: "MUTE", targetId: m.id }); showModerationToast && showModerationToast('Guest muted'); };
      right.appendChild(btnMute);
    } else if (!m.isHost) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = m.isPro ? "Pro" : "Free";
      right.appendChild(badge);
    }
    if (!m.isHost) {
      const btnReport = document.createElement("button");
      btnReport.className = "btn-report-small";
      btnReport.textContent = "🚩 Report";
      btnReport.onclick = () => typeof openReportUserModal === 'function' && openReportUserModal(m.id, m.name);
      right.appendChild(btnReport);
    }
    div.appendChild(left); div.appendChild(right);
    wrap.appendChild(div);
  });

  updateQualityUI();
  updatePlaybackUI();
  updatePartyPassUI();
}

function openPaywall() { show("modalPaywall"); }
function closePaywall(){ hide("modalPaywall"); }
function openWarn(rec, next) {
  el("warnText").textContent =
    `Recommended is \${rec} phones for the best sound. You’re adding phone #\${next}. This might cause a small delay or echo.`;
  show("modalWarn");
}
function closeWarn(){ hide("modalWarn"); }
function openSpeaker(){ show("modalSpeaker"); }
function closeSpeaker(){ hide("modalSpeaker"); }

function attemptAddPhone() {
  const q = computeQualitySnapshot();
  const next = q.n + 1;

  if (next > q.hardCap) { toast(`Hard cap reached (${q.hardCap})`); return; }
  if (q.score < 50) { toast("Connection is weak — try moving closer or using a hotspot"); return; }

  const isProOrPartyPass = state.partyPro || state.partyPassActive;
  if (!isProOrPartyPass && next > FREE_LIMIT) { openPaywall(); return; }

  if (next > q.rec) {
    if (!isProOrPartyPass) { openPaywall(); return; }
    openWarn(q.rec, next); return;
  }

  toast("Open this link on another phone and tap Join");
}

/**
 * Initialize auth flow: check if user is logged in and redirect appropriately.
 * Uses state machine transitions (AppStateMachine) and setView() routing.
 * - Logged out: LOGGED_OUT state (landing page, nav hidden)
 * - Logged in + profileCompleted=false: PROFILE_INCOMPLETE state (complete-profile view)
 * - Logged in + profileCompleted=true: PARTY_HUB state (auth home view)
 */
async function initAuthFlow() {
  const headerAuthButtons = document.getElementById('headerAuthButtons');
  try {
    const response = await fetch(API_BASE + '/api/me', { credentials: 'include' });
    if (!response.ok) {
      // Not authenticated — clear any stale user cache/profile and explicitly mark
      // the client session unauthenticated so protected-view guards keep the user on
      // the landing page until the server confirms a real session again.
      try { localStorage.removeItem('syncspeaker_current_user'); } catch (_) {}
      try { clearProfile(); } catch (_) {}
      if (typeof setAuthSessionState === 'function') setAuthSessionState('unauthenticated');
      if (headerAuthButtons) headerAuthButtons.style.display = 'none';
      window.AppStateMachine && window.AppStateMachine.transitionTo(window.AppStateMachine.STATES.LOGGED_OUT);
      setView('landing', { fromHash: true });
      return false;
    }
    const data = await response.json();
    if (typeof setAuthSessionState === 'function') setAuthSessionState('authenticated');
    // Authenticated - show auth buttons
    if (headerAuthButtons) headerAuthButtons.style.display = '';
    // Update state from server data
    state.userTier = data.effectiveTier || data.tier || USER_TIER.FREE;
    if (data.user && data.user.djName) {
      state.djName = data.user.djName;
      saveProfile({ djName: data.user.djName, email: data.user.email, tier: state.userTier });
    }
    // Show admin nav if applicable.
    // Support multiple server response shapes: flat data.isAdmin, nested data.user.isAdmin,
    // or role-based data.user.role === 'admin' (all are equivalent server-side checks).
    _currentUserIsAdmin = !!(data.isAdmin || (data.user && data.user.isAdmin) || (data.user && data.user.role === 'admin'));
    if (typeof setAdminNavVisible === 'function') setAdminNavVisible(_currentUserIsAdmin);
    // Redirect based on profileCompleted
    if (!data.user || !data.user.profileCompleted) {
      window.AppStateMachine && window.AppStateMachine.transitionTo(window.AppStateMachine.STATES.PROFILE_INCOMPLETE);
      setView('completeProfile', { fromHash: true });
    } else {
      window.AppStateMachine && window.AppStateMachine.transitionTo(window.AppStateMachine.STATES.PARTY_HUB);
      setView('authHome', { fromHash: true });
      // Start referral polling now that user is authenticated
      if (window._referralUI) window._referralUI.startPolling();
    }
    return true;
  } catch (err) {
    console.warn('[Auth] Could not check auth status:', err.message);
    // Clear stale user cache/profile and explicitly mark the session logged out so
    // protected views cannot be reached from cached client-side state alone.
    try { localStorage.removeItem('syncspeaker_current_user'); } catch (_) {}
    try { clearProfile(); } catch (_) {}
    if (typeof setAuthSessionState === 'function') setAuthSessionState('unauthenticated');
    if (headerAuthButtons) headerAuthButtons.style.display = 'none';
    window.AppStateMachine && window.AppStateMachine.transitionTo(window.AppStateMachine.STATES.LOGGED_OUT);
    setView('landing', { fromHash: true });
    return false;
  }
}

/**
 * Confirm auth session after a successful login or signup.
 *
 * Unlike initAuthFlow() (which is the boot-time guard), this function is called
 * once the API has already confirmed the credentials are correct.  It contacts
 * /api/me to refresh server state and route the user to the right authenticated
 * view, but it intentionally does NOT:
 *   - clear auth state / localStorage on failure
 *   - redirect the user back to the landing page on failure
 *
 * This prevents a transient /api/me failure or a momentary session-propagation
 * delay from undoing a just-completed login/signup.
 *
 * @returns {Promise<boolean>} true if the session was confirmed and the user was
 *   routed to an authenticated view; false if the server check failed (the caller
 *   should surface an appropriate inline error without redirecting to landing).
 */
async function confirmAuthSession() {
  const headerAuthButtons = document.getElementById('headerAuthButtons');
  try {
    const response = await fetch(API_BASE + '/api/me', { credentials: 'include' });
    if (!response.ok) {
      // The server did not confirm the session — surface an error but do NOT clear
      // auth state or redirect to the landing page. The credentials API already
      // returned success; a momentary 401 here is most likely a propagation race.
      console.warn(`[Auth] Post-login /api/me returned ${response.status} ${response.statusText} — user remains authenticated. If this persists, check session cookie propagation.`);
      return false;
    }
    const data = await response.json();
    if (typeof setAuthSessionState === 'function') setAuthSessionState('authenticated');
    if (headerAuthButtons) headerAuthButtons.style.display = '';
    state.userTier = data.effectiveTier || data.tier || USER_TIER.FREE;
    if (data.user && data.user.djName) {
      state.djName = data.user.djName;
      saveProfile({ djName: data.user.djName, email: data.user.email, tier: state.userTier });
    }
    _currentUserIsAdmin = !!(data.isAdmin || (data.user && data.user.isAdmin) || (data.user && data.user.role === 'admin'));
    if (typeof setAdminNavVisible === 'function') setAdminNavVisible(_currentUserIsAdmin);
    if (!data.user || !data.user.profileCompleted) {
      window.AppStateMachine && window.AppStateMachine.transitionTo(window.AppStateMachine.STATES.PROFILE_INCOMPLETE);
      setView('completeProfile', { fromHash: true });
    } else {
      window.AppStateMachine && window.AppStateMachine.transitionTo(window.AppStateMachine.STATES.PARTY_HUB);
      setView('authHome', { fromHash: true });
      if (window._referralUI) window._referralUI.startPolling();
    }
    return true;
  } catch (err) {
    // Network or other error — do NOT clear auth state or send the user to landing.
    // The login/signup API already confirmed the credentials; we keep the user in
    // the authenticated flow so a connectivity blip does not undo their login.
    console.warn(`[Auth] Post-login session check failed — user remains authenticated. Error: ${err.message}`);
    return false;
  }
}


function initCompleteProfileView() {
  const form = document.getElementById('formCompleteProfile');
  if (!form || form.dataset.initialized) return;
  form.dataset.initialized = 'true';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const djNameInput = document.getElementById('completeProfileDjName');
    const errorEl = document.getElementById('completeProfileError');
    const djName = djNameInput ? djNameInput.value.trim() : '';
    if (!djName) {
      if (errorEl) { errorEl.textContent = 'DJ Name is required'; errorEl.classList.remove('hidden'); }
      return;
    }
    try {
      const resp = await fetch(API_BASE + '/api/complete-profile', { 
        method: 'POST', 
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ djName })
      });
      if (!resp.ok) {
        const d = await resp.json();
        if (errorEl) { errorEl.textContent = d.error || 'Failed to save profile'; errorEl.classList.remove('hidden'); }
        return;
      }
      toast('✅ Profile complete! Welcome to Phone Party!');
      window.AppStateMachine && window.AppStateMachine.transitionTo(window.AppStateMachine.STATES.PARTY_HUB);
      if (typeof navigate === 'function') {
        navigate('/home', { replace: true });
      } else {
        showView('viewAuthHome');
        initPartyHomeView();
      }
      if (window.AppStateMachine) window.AppStateMachine.transitionTo(window.AppStateMachine.STATES.PARTY_HUB);
    } catch (err) {
      if (errorEl) { errorEl.textContent = 'Network error. Please try again.'; errorEl.classList.remove('hidden'); }
    }
  });
}

/**
 * Initialize the /party authenticated home view handlers
 */
function initPartyHomeView() {
  const btnPartyShowCreate = document.getElementById('btnPartyShowCreateParty');
  const btnPartyShowJoin = document.getElementById('btnPartyShowJoinParty');
  const btnHideCreate = document.getElementById('btnHidePartyCreate');
  const btnHideJoin = document.getElementById('btnHidePartyJoin');
  const btnPartyCreate = document.getElementById('btnPartyCreate');
  const btnPartyJoin = document.getElementById('btnPartyJoin');

  // Billing: wire up upgrade button and show billing box
  initBillingBox();

  if (btnPartyShowCreate) {
    btnPartyShowCreate.onclick = () => {
      const s = document.getElementById('partyCreateSection');
      const j = document.getElementById('partyJoinSection');
      if (s) s.classList.remove('hidden');
      if (j) j.classList.add('hidden');
    };
  }
  if (btnPartyShowJoin) {
    btnPartyShowJoin.onclick = () => {
      const s = document.getElementById('partyCreateSection');
      const j = document.getElementById('partyJoinSection');
      if (j) j.classList.remove('hidden');
      if (s) s.classList.add('hidden');
    };
  }
  if (btnHideCreate) {
    btnHideCreate.onclick = () => { const s = document.getElementById('partyCreateSection'); if (s) s.classList.add('hidden'); };
  }
  if (btnHideJoin) {
    btnHideJoin.onclick = () => { const j = document.getElementById('partyJoinSection'); if (j) j.classList.add('hidden'); };
  }
  if (btnPartyCreate) {
    btnPartyCreate.onclick = async () => {
      const hostNameEl = document.getElementById('partyHostName');
      const djName = hostNameEl ? hostNameEl.value.trim() : (state.djName || 'DJ');
      if (!djName) { toast('Enter your DJ name'); return; }
      state.djName = djName;
      // Delegate to existing create party flow
      const btnCreate = document.getElementById('btnCreate');
      const hostNameInput = document.getElementById('hostName');
      if (hostNameInput) hostNameInput.value = djName;
      showHome();
      const createSection = document.getElementById('createPartySection');
      if (createSection) createSection.classList.remove('hidden');
    };
  }
  if (btnPartyJoin) {
    btnPartyJoin.onclick = () => {
      const code = document.getElementById('partyJoinCode')?.value?.trim();
      const name = document.getElementById('partyGuestName')?.value?.trim();
      // Pre-fill join form in the existing viewHome and trigger join
      const joinCode = document.getElementById('joinCode');
      const guestName = document.getElementById('guestName');
      if (joinCode && code) joinCode.value = code;
      if (guestName && name) guestName.value = name;
      showHome();
      const joinSection = document.getElementById('joinPartySection');
      if (joinSection) joinSection.classList.remove('hidden');
    };
  }
}

/**
 * Update the billing box in viewAuthHome to reflect current tier.
 */
function initBillingBox() {
  const box = document.getElementById('billingBox');
  const freeSection = document.getElementById('billingBoxFree');
  const proSection = document.getElementById('billingBoxPro');
  const btnUpgrade = document.getElementById('btnUpgradeToPro');
  if (!box) return;

  const tier = state.userTier || USER_TIER.FREE;
  const isPro = (tier === 'PRO' || tier === 'PRO_MONTHLY');
  box.classList.remove('hidden');

  if (isPro) {
    if (freeSection) freeSection.classList.add('hidden');
    if (proSection) proSection.classList.remove('hidden');
    // Show subscription end date if available
    const statusEl = document.getElementById('billingProStatus');
    if (statusEl) {
      fetch(API_BASE + '/api/billing/status')
        .then(r => r.json())
        .then(d => {
          if (d.current_period_end) {
            const until = new Date(d.current_period_end).toLocaleDateString();
            statusEl.textContent = `Renews/expires ${until}`;
          }
        })
        .catch(() => {});
    }
  } else {
    if (freeSection) freeSection.classList.remove('hidden');
    if (proSection) proSection.classList.add('hidden');
    if (btnUpgrade && !btnUpgrade.dataset.wired) {
      btnUpgrade.dataset.wired = '1';
      btnUpgrade.addEventListener('click', () => {
        // Navigate to the upgrade hub pricing screen where the user can choose
        // their tier and initiate checkout.
        if (typeof setView === 'function') {
          setView('upgradeHub');
        } else if (typeof showView === 'function') {
          showView('viewUpgradeHub');
        }
      });
    }
  }
}

/**
 * Refresh current user data from /api/me and update state.
 */
async function refreshMe() {
  try {
    const res = await fetch(API_BASE + '/api/me', { credentials: 'include' });
    if (!res.ok) return false;
    const data = await res.json();
    state.userTier = data.tier || USER_TIER.FREE;
    if (data.user && data.user.djName) state.djName = data.user.djName;
    return data;
  } catch (e) {
    return false;
  }
}

/**
 * Handle billing=success/cancel query parameters on app load.
 * Strips the query param from the URL after handling.
 */
async function handleBillingReturn() {
  const params = new URLSearchParams(window.location.search);
  const billing = params.get('billing');
  if (!billing) return;

  // Clean URL immediately
  params.delete('billing');
  const newSearch = params.toString();
  const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
  history.replaceState(null, '', newUrl);

  if (billing === 'cancel') {
    toast('Checkout canceled.');
    return;
  }

  if (billing === 'success') {
    toast('Payment successful! Activating your Pro account…');
    // Webhook may not have fired yet — poll /api/billing/status for up to 10s
    const deadline = Date.now() + 10000;
    let gotPro = false;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const res = await fetch(API_BASE + '/api/billing/status');
        if (res.ok) {
          const d = await res.json();
          if (d.tier === 'PRO') {
            gotPro = true;
            break;
          }
        }
      } catch (_) { /* ignore */ }
    }
    // Refresh state from /api/me
    await refreshMe();
    // Re-render billing box if we're on the party view
    initBillingBox();
    if (gotPro) {
      toast('✅ You\'re now Pro!');
    } else {
      toast('Payment received. Pro access will activate shortly.');
    }
  }
}

(async function init(){
  // Fetch feature flags early — used to gate UI sections
  await fetchFeatureFlags();

  // WebSocket is NOT connected on startup — it is only established when a
  // party is created or joined, to avoid connecting on the landing page.

  // BOOT: check if a specific view was requested via URL hash (e.g. after refresh or back navigation)
  const _bootHash = window.location.hash.replace('#', '');
  const _bootHashView = HASH_TO_VIEW[_bootHash];
  console.log('[BOOT]', { commit: CHANGER_VERSION, hasProfile: hasValidProfile(), hash: _bootHashView || null });

  // Always verify auth with the server first on startup. This prevents stale
  // localStorage data (isLoggedIn returning true for an expired session, or a
  // leftover profile entry) from bypassing the landing page for logged-out users.
  // initAuthFlow() redirects to landing when not authenticated and returns false;
  // only navigate to the requested hash view when the user is confirmed logged in.
  const _bootAuthenticated = await initAuthFlow();
  if (_bootAuthenticated && _bootHashView) {
    setView(_bootHashView);
  }

  // Handle billing return parameters (billing=success or billing=cancel in URL)
  await handleBillingReturn();

  // Capture referral code from ?ref= URL param and store in localStorage
  try {
    const _refParams = new URLSearchParams(window.location.search);
    const _refCode = _refParams.get('ref');
    if (_refCode && _refCode.length <= 20) {
      const _cleanCode = _refCode.toUpperCase();
      localStorage.setItem('referral_code', _cleanCode);
      localStorage.setItem('referral_ts', Date.now().toString());
      // Record the click event (async, non-blocking)
      fetch(API_BASE + '/api/referral/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referralCode: _cleanCode })
      }).then(r => r.json()).then(data => {
        if (data.clickId) localStorage.setItem('referral_click_id', data.clickId);
      }).catch(() => {});
    }
  } catch (_) { /* localStorage may be unavailable */ }
  
  // Initialize music player
  initializeMusicPlayer();

  // Set up auth form submit handlers and navigation links
  setupAuthEventListeners();

  // LANDING PAGE BUTTONS (for logged-out users)
  const btnLandingSignup = el("btnLandingSignup");
  const btnLandingLogin = el("btnLandingLogin");

  if (btnLandingSignup) {
    btnLandingSignup.onclick = () => {
      console.log("[UI] Landing signup clicked");
      setView('signup');
    };
  }

  if (btnLandingLogin) {
    btnLandingLogin.onclick = () => {
      console.log("[UI] Landing login clicked");
      setView('login');
    };
  }

  // LANDING PAGE BUTTON (for admin users)
  const btnGoToDashboard = el("btnGoToDashboard");
  if (btnGoToDashboard) {
    btnGoToDashboard.onclick = () => {
      console.log("[UI] Go to Admin Dashboard clicked");
      setView('adminDashboard');
    };
  }

  // Tier selection handlers (from viewChooseTier page)
  el("btnSelectFree").onclick = () => {
    console.log("[UI] Free tier selected");
    state.selectedTier = USER_TIER.FREE;
    state.userTier = USER_TIER.FREE;
    setView('signup');
  };

  el("btnSelectPartyPass").onclick = () => {
    console.log("[UI] Party Pass tier selected");
    state.selectedTier = USER_TIER.PARTY_PASS;
    setView('signup');
  };

  el("btnSelectPro").onclick = () => {
    console.log("[UI] Pro tier selected");
    state.selectedTier = USER_TIER.PRO;
    setView('signup');
  };

  el("btnBackToLanding").onclick = () => {
    console.log("[UI] Back to landing from tier selection");
    showLanding();
  };

  // Payment screen handlers
  const _btnCompletePayment = el("btnCompletePayment");
  if (_btnCompletePayment) {
    _btnCompletePayment.onclick = () => {
      console.log("[UI] Party Pass payment completed (demo)");
      state.userTier = USER_TIER.PARTY_PASS;
      state.partyPassActive = true;
      state.partyPassEndTime = Date.now() + (2 * 60 * 60 * 1000); // 2 hours from now
      
      // Notify user about Party Pass activation
      toast("🎉 Party Pass activated! You have 2 hours of party time.");
      
      showHome();
    };
  }

  const _btnCancelPayment = el("btnCancelPayment");
  if (_btnCancelPayment) {
    _btnCancelPayment.onclick = () => {
      console.log("[UI] Payment cancelled");
      showChooseTier();
    };
  }

  // PHONE PARTY - Giant Start/Join Buttons
  const btnShowCreateParty = el("btnShowCreateParty");
  const btnShowJoinParty = el("btnShowJoinParty");
  const btnHideCreateParty = el("btnHideCreateParty");
  const btnHideJoinParty = el("btnHideJoinParty");
  const createPartySection = el("createPartySection");
  const joinPartySection = el("joinPartySection");

  if (btnShowCreateParty) {
    btnShowCreateParty.onclick = () => {
      console.log("[UI] Show create party form");
      if (createPartySection) createPartySection.classList.remove("hidden");
      if (joinPartySection) joinPartySection.classList.add("hidden");
    };
  }

  if (btnShowJoinParty) {
    btnShowJoinParty.onclick = () => {
      console.log("[UI] Show join party form");
      if (joinPartySection) joinPartySection.classList.remove("hidden");
      if (createPartySection) createPartySection.classList.add("hidden");
    };
  }

  if (btnHideCreateParty) {
    btnHideCreateParty.onclick = () => {
      console.log("[UI] Hide create party form");
      if (createPartySection) createPartySection.classList.add("hidden");
    };
  }

  if (btnHideJoinParty) {
    btnHideJoinParty.onclick = () => {
      console.log("[UI] Hide join party form");
      if (joinPartySection) joinPartySection.classList.add("hidden");
    };
  }

  // Color Picker for Profile
  const colorOptions = document.querySelectorAll('.color-option');
  const favoriteColorInput = el("favoriteColor");
  
  if (colorOptions && favoriteColorInput) {
    colorOptions.forEach(option => {
      option.addEventListener('click', () => {
        // Remove selected class from all options
        colorOptions.forEach(opt => opt.classList.remove('selected'));
        // Add selected class to clicked option
        option.classList.add('selected');
        // Update hidden input
        const color = option.getAttribute('data-color');
        favoriteColorInput.value = color;
        console.log("[UI] Color selected:", color);
      });
    });
    
    // Select default color (purple)
    const defaultColor = document.querySelector('.color-option[data-color="purple"]');
    if (defaultColor) {
      defaultColor.classList.add('selected');
    }
  }

  el("btnCreate").onclick = async () => {
    console.log("[UI] Start party button clicked");
    const btn = el("btnCreate");
    const partyStatusEl = el("partyStatus");
    const messageEl = el("createStatusMessage");
    
    // Prevent multiple clicks - check if button is already disabled
    if (btn.disabled) {
      console.log("[UI] Button already processing, ignoring click");
      return;
    }
    
    // Helper function to update status
    const updateStatus = (message, isError = false) => {
      if (partyStatusEl) partyStatusEl.classList.remove("hidden");
      if (messageEl) {
        messageEl.textContent = message;
        messageEl.style.color = isError ? "var(--danger, #ff5a6a)" : "var(--text, #fff)";
      }
      console.log(`[Party] ${message}`);
    };
    
    try {
      btn.disabled = true;
      btn.textContent = "Creating party...";
      updateStatus("Creating party…");
      
      // Get and validate host name (required for DJ identity)
      const hostNameInput = el("hostName").value.trim();
      if (!hostNameInput) {
        updateStatus("Please enter your name (it will be prefixed with 'DJ')", true);
        throw new Error("DJ name is required to start a party");
      }
      
      // Validate name length (cap at 24 characters before adding DJ prefix)
      let validatedName = hostNameInput;
      if (validatedName.length > 24) {
        validatedName = validatedName.substring(0, 24);
        toast("Name shortened to 24 characters");
      }
      
      // Add "DJ" prefix to host name
      const djName = `DJ ${validatedName}`;
      state.name = djName;
      console.log("[DJ Identity] Host name with DJ prefix:", djName);
      
      // Apply guest anonymity (Feature 7)
      applyGuestAnonymity();
      
      // Get user configuration
      state.source = "local"; // Always use local source for music from phone
      state.isPro = el("togglePro").checked;
      console.log("[UI] Creating party with:", { name: state.name, source: state.source, isPro: state.isPro, tier: state.userTier });
      
      // Generate idempotency key for request (reused on retry)
      const requestId = crypto.randomUUID();
      const requestStartTime = Date.now();
      console.log(`[CreateParty] Request ID: ${requestId}`);
      
      // Helper function to make create-party request
      const makeCreatePartyRequest = async (attemptNumber) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        
        const requestBody = {
          djName: djName,
          source: state.source || "local"
        };
        
        try {
          const response = await fetch(API_BASE + "/api/create-party", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": requestId
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          const latency = Date.now() - requestStartTime;
          console.log(`[CreateParty] Request completed (attempt ${attemptNumber}), status: ${response.status}, latency: ${latency}ms`);
          
          return response;
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      };
      
      // Try request with one retry on timeout/network failure
      let response;
      let lastError;
      
      for (let attempt = 1; attempt <= MAX_CREATE_PARTY_ATTEMPTS; attempt++) {
        try {
          if (attempt === 2) {
            updateStatus("Waking up server… retrying");
            console.log(`[CreateParty] Retry attempt ${attempt - 1} due to ${lastError?.name || 'error'}`);
            await new Promise(resolve => setTimeout(resolve, CREATE_PARTY_RETRY_DELAY_MS));
          }
          
          response = await makeCreatePartyRequest(attempt);
          break; // Success - exit retry loop
        } catch (error) {
          lastError = error;
          
          // Only retry on AbortError (timeout) or network failure (TypeError from fetch)
          const shouldRetry = (error.name === "AbortError" || error.name === "TypeError") && attempt < MAX_CREATE_PARTY_ATTEMPTS;
          
          if (!shouldRetry) {
            throw error; // Don't retry - propagate error
          }
        }
      }
      
      // Success - response is set from retry loop above
      const data = await response.json();
      const partyCode = data.partyCode;
      const hostId = data.hostId; // PHASE 7: Store hostId for queue operations
  
      console.log("[Party] Party created via API:", partyCode, "hostId:", hostId);
      
      // Set party state
      state.code = partyCode;
      state.isHost = true;
      state.hostId = hostId;
      state.offlineMode = false;
      
      // Initialize snapshot with host member
      state.snapshot = {
        members: [{
          id: "host-" + Date.now(),
          name: state.name,
          isHost: true,
          isPro: state.isPro
        }]
      };
      
      // Show party view
      showParty();
      
      // Show YouTube service selection screen for hosts (post-create interstitial)
      setView('youtubeService');
      
      // Show success toast
      toast(`Party created: ${partyCode}`);
      
      // Hide status
      if (partyStatusEl) partyStatusEl.classList.add("hidden");
      
      // Register host via WebSocket for real-time updates
      try {
        // Ensure WebSocket is connected to the backend before sending
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
          await connectWS();
        }
        send({ 
          t: "JOIN", 
          code: partyCode, 
          name: state.name, 
          isPro: state.isPro,
          isHost: true 
        });
        console.log("[Party] Host registered via WebSocket");
      } catch (wsError) {
        console.warn("[Party] WebSocket not available for host registration:", wsError);
      }
      
      // PHASE 7: Fetch initial party state to get queue/currentTrack
      try {
        const stateResponse = await fetch(API_BASE + `/api/party-state?code=${partyCode}`);
        if (stateResponse.ok) {
          const partyState = await stateResponse.json();
          if (partyState.exists) {
            // Initialize queue and currentTrack from server
            musicState.queue = partyState.queue || [];
            musicState.currentTrack = partyState.currentTrack || null;
            console.log("[Party] Initialized queue from server:", musicState.queue.length, "tracks");
            
            // Update host queue UI (defensive check ensures function is available)
            // Note: This runs in async callback, so we verify function exists before calling
            if (state.isHost && typeof updateHostQueueUI === 'function') {
              updateHostQueueUI();
            }
          }
        }
      } catch (error) {
        console.warn("[Party] Could not fetch initial party state:", error);
        // Non-fatal - continue with empty queue
        musicState.queue = [];
        musicState.currentTrack = null;
      }
      
    } catch (error) {
      console.error("[Party] Error creating party:", error);
      
      // Improved error messages based on error type
      if (error.name === "AbortError") {
        updateStatus("Request timed out after retries. Server may be slow to respond.", true);
      } else if (error.message.includes("Failed to fetch")) {
        updateStatus("Cannot reach server. Check network connection.", true);
      } else {
        updateStatus(error.message || "Failed to create party", true);
      }
      
      // Re-enable button
      btn.disabled = false;
      btn.textContent = "Start party";
    }
  };

  el("btnJoin").onclick = async () => {
    console.log("[UI] Join party button clicked");
    const btn = el("btnJoin");
    const statusEl = el("joinStatus");
    const messageEl = el("joinStatusMessage");
    const debugEl = el("joinDebugInfo");
    const code = el("joinCode").value.trim().toUpperCase();
    
    if (!code) {
      toast("Enter a party code");
      return;
    }
    
    // Validate code format (6 alphanumeric characters)
    if (code.length !== 6 || !/^[A-Z0-9]{6}$/.test(code)) {
      toast("Party code must be 6 characters");
      return;
    }
    
    // Validate and sanitize guest name
    const guestNameInput = el("guestName");
    if (guestNameInput && guestNameInput.value) {
      const trimmedName = guestNameInput.value.trim();
      if (trimmedName.length > 24) {
        guestNameInput.value = trimmedName.substring(0, 24);
        toast("Name shortened to 24 characters");
      }
    }
    
    // Prevent multiple clicks
    if (btn.disabled) {
      console.log("[UI] Button already processing, ignoring click");
      return;
    }
    
    // Helper function to update status
    const updateStatus = (message, isError = false) => {
      if (statusEl) statusEl.classList.remove("hidden");
      if (messageEl) {
        messageEl.textContent = message;
        messageEl.style.color = isError ? "var(--danger, #ff5a6a)" : "var(--text, #fff)";
      }
      console.log(`[Party] ${message}`);
    };
    
    // Helper function to update debug info
    const updateDebug = (message) => {
      if (debugEl) {
        debugEl.textContent = message;
      }
    };
    
    try {
      btn.disabled = true;
      btn.textContent = "Joining...";
      updateStatus("Connecting to party…");
      
      // Apply guest anonymity (Feature 7)
      applyGuestAnonymity();
      
      state.isPro = el("togglePro").checked;
      console.log("[UI] Joining party with:", { code, name: state.name, isPro: state.isPro });
      
      // Retry logic for party lookup with exponential backoff
      let lastError = null;
      let response = null;
      const endpoint = "POST /api/join-party";
      
      for (let attempt = 1; attempt <= PARTY_LOOKUP_RETRIES; attempt++) {
        try {
          // Update status with retry count and exponential backoff info
          if (attempt > 1) {
            updateStatus(`Connecting to party… (attempt ${attempt}/${PARTY_LOOKUP_RETRIES})`);
          } else {
            updateStatus("Connecting to party…");
          }
          
          // Create AbortController for timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
          
          updateDebug(`Endpoint: ${endpoint} (attempt ${attempt})`);
          updateDebugPanel(endpoint, null);
          
          response = await fetch(API_BASE + "/api/join-party", {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              partyCode: code,
              nickname: state.guestNickname || state.name || "Guest"
            }),
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          // If we get a response, break out of retry loop
          break;
        } catch (fetchError) {
          lastError = fetchError;
          console.log(`[Party] Join attempt ${attempt} failed:`, fetchError.message);
          
          // If this is not the last attempt and it's a network/timeout error, retry with exponential backoff
          if (attempt < PARTY_LOOKUP_RETRIES) {
            const backoffDelay = PARTY_LOOKUP_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            console.log(`[Party] Retrying in ${backoffDelay}ms...`);
            updateDebug(`Network error - retrying in ${backoffDelay}ms`);
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
          }
        }
      }
      
      // If all retries failed, throw error
      if (!response && lastError) {
        // Provide browser-only mode friendly error messages
        let errorMsg;
        if (lastError.name === "AbortError") {
          errorMsg = "Server not responding. Try again.";
        } else if (lastError.message.includes("Failed to fetch")) {
          errorMsg = "Multi-device sync requires the server to be running. Use 'npm start' to enable joining parties.";
        } else {
          errorMsg = lastError.message;
        }
        
        updateDebugPanel(endpoint, `${endpoint} (${lastError.name === "AbortError" ? "timeout" : "network error"})`);
        throw new Error(errorMsg);
      }
      
      updateStatus("Server responded…");
      
      // Check for 501 (Unsupported method) which happens with simple HTTP servers
      if (response.status === 501) {
        const errorMsg = "Multi-device sync requires the server to be running. Use 'npm start' to enable joining parties.";
        updateDebugPanel(endpoint, "Server doesn't support POST (browser-only mode)");
        throw new Error(errorMsg);
      }
      
      // Check for 503 (Service Unavailable - Redis not ready)
      if (response.status === 503) {
        const errorData = await response.json().catch(() => ({ error: "Server not ready" }));
        const errorMsg = errorData.error || "Server not ready - Redis unavailable";
        updateDebugPanel(endpoint, `HTTP 503: ${errorMsg}`);
        updateDebug(`HTTP 503 - ${errorMsg}`);
        
        // Provide actionable error message with retry guidance
        let userMessage = "⏳ Party service is starting up. ";
        if (errorMsg.includes("Redis")) {
          userMessage += "Server is connecting to party database. Please wait 10-20 seconds and try again.";
        } else {
          userMessage += "Please wait a moment and try again.";
        }
        
        updateStatus(userMessage, true);
        throw new Error(userMessage);
      }
      
      // Handle all error responses with exact backend message
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
        const errorMsg = errorData.error || `Server error: ${response.status}`;
        const statusMessage = `HTTP ${response.status}: ${errorMsg}`;
        updateDebugPanel(endpoint, statusMessage);
        updateDebug(`HTTP ${response.status} - ${errorMsg}`);
        
        // Provide actionable error message for 404
        if (response.status === 404) {
          updateStatus("❌ Party not found. Check the code or ask the host to create a new party.", true);
          throw new Error("Party not found. The party may have expired or the code is incorrect.");
        }
        
        // For other errors, display exact backend message
        throw new Error(errorMsg);
      }
      
      const data = await response.json();
      console.log("[API] Join response:", data);
      updateDebugPanel(endpoint, null); // Clear error on success
      
      // Store guest info
      if (data.guestId) {
        state.clientId = data.guestId;
      }
      if (data.nickname) {
        state.guestNickname = data.nickname;
      }
      
      // Store DJ name for display
      if (data.djName && data.djName.trim()) {
        state.djName = data.djName.trim();
        console.log("[DJ Identity] Joined party with DJ:", data.djName);
      }
      
      // Store chat mode from join response
      if (data.chatMode) {
        state.chatMode = data.chatMode;
        console.log("[Chat Mode] Initial chat mode:", data.chatMode);
      }
      
      // Set state for joined party
      state.code = code;
      state.isHost = false;
      state.connected = true;
      
      // Save guest session to localStorage for auto-reconnect
      try {
        const guestSession = {
          partyCode: code,
          guestId: data.guestId,
          nickname: data.nickname,
          joinedAt: Date.now()
        };
        localStorage.setItem('syncSpeakerGuestSession', JSON.stringify(guestSession));
        console.log("[Guest] Session saved for auto-reconnect:", guestSession);
      } catch (error) {
        console.warn("[Guest] Failed to save session to localStorage:", error);
      }
      
      updateStatus(`✓ Joined party ${code}`);
      
      // Transition to guest view immediately (HTTP-based join)
      showGuest();
      
      // Show welcome message with DJ name
      if (data.djName) {
        toast(`Now vibing with DJ ${data.djName}! 🎵🔥`);
      } else {
        toast(`Joined party ${code} – let's go! 🎉`);
      }
      
      // Try to connect via WebSocket for real-time updates (optional fallback)
      try {
        // Ensure WebSocket is connected to the backend before sending
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
          await connectWS();
        }
        send({ t: "JOIN", code, name: state.name, isPro: state.isPro });
      } catch (wsError) {
        console.warn("[Party] WebSocket not available, using polling only:", wsError);
      }
      
      // Clear status after a short delay
      setTimeout(() => {
        if (statusEl) statusEl.classList.add("hidden");
      }, 2000);
      
    } catch (error) {
      console.error("[Party] Error joining party:", error);
      updateStatus(error.message || "Error joining party. Try again.", true);
      
      // Show toast with error
      toast(error.message || "Error joining party");
    } finally {
      // ALWAYS re-enable button and reset text
      btn.disabled = false;
      btn.textContent = "Join party";
    }
  };

  el("togglePro").onchange = (e) => {
    state.isPro = !!e.target.checked;
    send({ t: "SET_PRO", isPro: state.isPro });
  };

  el("btnLeave").onclick = async () => { 
    // For host: end party
    if (state.isHost) {
      // Show party recap before leaving
      showPartyRecap();
      
      // Call end-party endpoint
      try {
        if (state.code) {
          const response = await fetch(API_BASE + "/api/end-party", {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              partyCode: state.code
            })
          });
          
          if (response.ok) {
            console.log("[Party] Party ended successfully");
            toast("Party ended");
          } else {
            console.warn("[Party] Failed to end party:", response.status);
          }
        }
      } catch (error) {
        console.error("[Party] Error ending party:", error);
      }
    }
    
    // Close WebSocket if connected
    if (state.ws) {
      state.ws.close(); 
    } else {
      // No WebSocket connection, navigate back to home manually
      showLanding();
    }
  };

  // Guest leave button handler
  const btnGuestLeave = el("btnGuestLeave");
  if (btnGuestLeave) {
    btnGuestLeave.onclick = async () => {
      // Call leave-party endpoint
      try {
        if (state.code && state.clientId) {
          const response = await fetch(API_BASE + "/api/leave-party", {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              partyCode: state.code,
              guestId: state.clientId
            })
          });
          
          if (response.ok) {
            console.log("[Party] Left party successfully");
            toast("Left party");
          } else {
            console.warn("[Party] Failed to leave party:", response.status);
          }
        }
      } catch (error) {
        console.error("[Party] Error leaving party:", error);
      }
      
      // Clear guest session from localStorage
      try {
        localStorage.removeItem('syncSpeakerGuestSession');
        console.log("[Guest] Session cleared from localStorage");
      } catch (error) {
        console.warn("[Guest] Failed to clear session from localStorage:", error);
      }
      
      // Close WebSocket if connected
      if (state.ws) {
        state.ws.close();
      } else {
        showLanding();
      }
    };
  }

  // Guest chat send button handler (Party Pass feature)
  const btnSendGuestChat = el("btnSendGuestChat");
  const guestChatInput = el("guestChatInput");
  if (btnSendGuestChat && guestChatInput) {
    const sendGuestChatMessage = () => {
      const message = guestChatInput.value.trim();
      if (!message) {
        toast("Please enter a message", "warning");
        return;
      }
      
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        toast("Not connected to server", "error");
        return;
      }
      
      // Send as GUEST_MESSAGE (server will enforce Party Pass)
      send({ t: "GUEST_MESSAGE", message: message, isEmoji: false });
      
      // Clear input
      guestChatInput.value = '';
      
      toast("Message sent!");
    };
    
    btnSendGuestChat.onclick = sendGuestChatMessage;
    
    // Also allow Enter key to send
    guestChatInput.onkeypress = (e) => {
      if (e.key === 'Enter') {
        sendGuestChatMessage();
      }
    };
  }

  // Guest resync button handler
  const btnGuestResync = el("btnGuestResync");
  if (btnGuestResync) {
    btnGuestResync.onclick = () => {
      manualResyncGuest();
    };
  }

  // Report out of sync button handler
  const btnReportOutOfSync = el("btnReportOutOfSync");
  if (btnReportOutOfSync) {
    btnReportOutOfSync.onclick = () => {
      reportOutOfSync();
    };
  }

  // Guest playback control buttons
  const btnGuestPlay = el("btnGuestPlay");
  if (btnGuestPlay) {
    btnGuestPlay.onclick = () => {
      // Handle autoplay recovery - if we have a pending expected position
      if (state.guestNeedsTap && state.pendingExpectedSec !== null && state.guestAudioElement) {
        console.log("[Guest] Recovering from autoplay block at position:", state.pendingExpectedSec);
        
        // Set position and play
        clampAndSeekAudio(state.guestAudioElement, state.pendingExpectedSec);
        state.guestAudioElement.play()
          .then(() => {
            console.log("[Guest] Audio unlocked and playing");
            unlockAudioPlayback();
            
            // Start drift correction if we have pending start info
            if (state.pendingStartAtServerMs !== null) {
              startDriftCorrection(state.pendingStartAtServerMs, state.pendingStartPositionSec || 0);
            }
            
            toast("▶️ Playing music");
          })
          .catch((err) => {
            console.error("[Guest] Still blocked:", err);
            toast(`❌ Play failed: ${err.message}`);
          });
        return;
      }
      
      // Handle case where audio is blocked but we have pending PLAY_AT info
      if (state.guestNeedsTap && state.pendingStartAtServerMs && state.guestAudioElement) {
        console.log("[Guest] Recovering from autoplay block using pending sync info");
        
        // Re-compute expected position from server time
        const nowServer = nowServerMs();
        const elapsed = (nowServer - state.pendingStartAtServerMs) / 1000;
        const targetSec = Math.max(0, (state.pendingStartPositionSec || 0) + elapsed);
        
        console.log(`[Guest] Computed position: ${targetSec.toFixed(2)}s`);
        
        clampAndSeekAudio(state.guestAudioElement, targetSec);
        state.guestAudioElement.play()
          .then(() => {
            console.log("[Guest] Audio unlocked and playing from sync");
            unlockAudioPlayback();
            
            // Start drift correction
            startDriftCorrection(state.pendingStartAtServerMs, state.pendingStartPositionSec || 0);
            
            toast("▶️ Synced and playing");
          })
          .catch((err) => {
            console.error("[Guest] Still blocked:", err);
            toast(`❌ Play failed: ${err.message}`);
          });
        return;
      }
      
      // Play local audio if available
      if (state.guestAudioElement && state.guestAudioElement.src) {
        state.guestAudioElement.play()
          .then(() => {
            console.log("[Guest] Audio playback started");
            unlockAudioPlayback();
            toast("▶️ Playing music");
          })
          .catch((err) => {
            console.error("[Guest] Audio play error:", err);
            toast(`❌ Play failed: ${err.message}`);
          });
      } else {
        console.log("[Guest] No audio loaded - requesting sync state");
        // Request sync state to get current playback info
        requestSyncState();
        toast("🔄 Requesting sync from DJ...");
      }
    };
  }

  const btnGuestPause = el("btnGuestPause");
  if (btnGuestPause) {
    btnGuestPause.onclick = () => {
      // Pause local audio if playing
      if (state.guestAudioElement && !state.guestAudioElement.paused) {
        state.guestAudioElement.pause();
        console.log("[Guest] Audio playback paused");
        toast("⏸️ Music paused");
      } else {
        console.log("[Guest] No audio playing - sending pause request to host");
        // Fallback: send request to host to pause music
        if (state.ws && state.connected) {
          send({ t: "GUEST_PAUSE_REQUEST" });
          toast("⏸️ Requested DJ to pause music");
        } else {
          toast("⚠️ No audio playing", "warning");
        }
      }
    };
  }

  const btnGuestStop = el("btnGuestStop");
  if (btnGuestStop) {
    btnGuestStop.onclick = () => {
      // Stop local audio playback and reset to beginning
      if (state.guestAudioElement) {
        state.guestAudioElement.pause();
        state.guestAudioElement.currentTime = 0;
        updateGuestPlaybackState("STOPPED");
        toast("⏹️ Stopped playback");
        console.log("[Guest] Stopped audio playback locally");
      } else {
        toast("No audio playing", "info");
      }
    };
  }

  const btnGuestSync = el("btnGuestSync");
  if (btnGuestSync) {
    btnGuestSync.onclick = () => {
      // Re-sync guest audio with host
      if (state.guestAudioElement && state.playing) {
        // Request current position from server or re-calculate based on last known state
        const audioEl = state.guestAudioElement;
        if (audioEl.src) {
          toast("🔄 Re-syncing audio...");
          console.log("[Guest] Manual sync requested");
          
          // Force a re-sync by adjusting current time based on drift
          if (state.lastPlayTimestamp && state.lastPlayPosition !== undefined) {
            const elapsed = (Date.now() - state.lastPlayTimestamp) / 1000;
            const expectedPosition = state.lastPlayPosition + elapsed;
            audioEl.currentTime = expectedPosition;
            console.log(`[Guest] Re-synced to position ${expectedPosition.toFixed(2)}s`);
            toast("✅ Audio re-synced", "success");
          }
        } else {
          toast("No audio loaded", "warning");
        }
      } else if (!state.playing) {
        toast("DJ is not playing", "info");
      } else {
        toast("No audio to sync", "warning");
      }
    };
  }

  const guestVolumeSlider = el("guestVolumeSlider");
  const guestVolumeValue = el("guestVolumeValue");
  if (guestVolumeSlider && guestVolumeValue) {
    guestVolumeSlider.oninput = () => {
      const volume = Number(guestVolumeSlider.value);
      guestVolumeValue.textContent = `${volume}%`;
      
      // Apply volume to guest audio element
      if (state.guestAudioElement) {
        state.guestAudioElement.volume = volume / 100;
        console.log(`[Guest] Volume set to ${volume}%`);
      }
    };
    
    // Set initial volume from slider's initial value
    if (state.guestAudioElement) {
      const initialVolume = Number(guestVolumeSlider.value);
      state.guestAudioElement.volume = initialVolume / 100;
    }
  }

  el("btnCopy").onclick = async () => {
    if (state.offlineMode) {
      toast("⚠️ Prototype mode - code won't work for joining from other devices");
      return;
    }
    
    // Create shareable join link
    const baseUrl = typeof getBaseUrl === 'function' ? getBaseUrl() : window.location.origin;
    const joinLink = `${baseUrl}${window.location.pathname}?code=${state.code || ""}`;
    
    // Try to use native share API if available (mobile devices)
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join Phone Party',
          text: `Join my Phone Party! Code: ${state.code}`,
          url: joinLink
        });
        toast("Shared successfully!");
        return;
      } catch (err) {
        // User cancelled or share failed, fall back to clipboard
        if (err.name !== 'AbortError') {
          console.log('Share failed, falling back to clipboard:', err);
        }
      }
    }
    
    // Fallback to clipboard
    try { 
      await navigator.clipboard.writeText(joinLink); 
      toast("Join link copied!");
    } catch { 
      // Final fallback - just copy the code
      try {
        await navigator.clipboard.writeText(state.code || "");
        toast("Party code copied");
      } catch {
        toast("Copy failed (permission)");
      }
    }
  };

  el("btnPlay").onclick = () => {
    if (state.adActive) return;
    
    // PHASE 1 & SECTION 1A: Client guard - prevent play if track not ready
    // Check 1: Prevent play if host track is still uploading
    if (state.isHost && musicState.currentTrack && musicState.currentTrack.uploadStatus !== 'ready') {
      const statusMsg = musicState.currentTrack.uploadStatus === 'uploading' 
        ? "⏳ Please wait - track is still uploading..." 
        : "⚠️ Upload failed - please select a new track";
      toast(statusMsg);
      updateMusicStatus(statusMsg);
      console.log("[Music] Play blocked - track not ready:", musicState.currentTrack.uploadStatus);
      return;
    }
    
    // Check 2: Prevent play if host has no trackUrl (especially critical when guests present)
    if (state.isHost && musicState.selectedFile && (!musicState.currentTrack || !musicState.currentTrack.trackUrl)) {
      const statusMsg = state.guestCount > 0 
        ? "⏳ Upload in progress - please wait before playing"
        : "⏳ Please wait - track is still preparing...";
      toast(statusMsg);
      updateMusicStatus(statusMsg);
      console.log("[Music] Play blocked - trackUrl not available, guestCount:", state.guestCount);
      return;
    }
    
    const audioEl = musicState.audioElement;
    if (audioEl && audioEl.src && musicState.selectedFile) {
      // Play from user gesture
      audioEl.play()
        .then(() => {
          state.playing = true;
          updateMusicStatus("Playing…");
          console.log("[Music] Playback started");
          
          // Track play for session stats (Feature 3)
          if (!state.sessionStats.tracksPlayed) {
            state.sessionStats.tracksPlayed = 1;
          }
          
          // Start beat-aware UI (Feature 8)
          startBeatPulse();
          
          // Show DJ screen for host
          if (state.isHost) {
            showDjScreen();
          }
          
          // Broadcast PLAY to guests
          if (state.isHost && state.ws) {
            // Use auto-uploaded track URL from musicState
            const trackId = musicState.currentTrack ? musicState.currentTrack.trackId : null;
            const trackUrl = musicState.currentTrack ? musicState.currentTrack.trackUrl : null;
            
            // PHASE 1: Final safety check - should never reach here without trackUrl due to checks above
            if (!trackUrl) {
              console.error("[Music] CRITICAL: Play reached broadcast without trackUrl", {
                hasCurrentTrack: !!musicState.currentTrack,
                uploadStatus: musicState.currentTrack?.uploadStatus,
                hasSelectedFile: !!musicState.selectedFile,
                trackId: trackId
              });
              return;
            }
            
            send({ 
              t: "HOST_PLAY",
              trackId: trackId,
              trackUrl: trackUrl,
              filename: musicState.selectedFile ? musicState.selectedFile.name : "Unknown",
              positionSec: audioEl.currentTime
            });
          }
          
          // Update back to DJ button visibility
          updateBackToDjButton();
        })
        .catch((error) => {
          console.error("[Music] Play failed:", error);
          let errorMsg = "Error: Playback failed";
          
          if (error.name === "NotAllowedError") {
            errorMsg = "⚠️ Your browser blocked autoplay. Tap Play to start audio.";
            showMusicWarning(errorMsg, false);
          } else if (error.name === "NotSupportedError") {
            errorMsg = "Error: File type not supported";
            showMusicWarning(errorMsg + ". Try MP3 or M4A.", true);
          } else {
            errorMsg = `Error: ${error.message || "Unable to play"}`;
            showMusicWarning(errorMsg, true);
          }
          
          updateMusicStatus(errorMsg, true);
          toast(errorMsg);
        });
    } else if (musicState.queuedFile && musicState.queuedObjectURL) {
      // If no current track but there's a queued track, play it
      console.log("[Music] No current track, playing queued track");
      playQueuedTrack();
    } else {
      state.playing = true;
      updateMusicStatus("Play (simulated - no music file loaded)");
      toast("Play (simulated)");
      
      // Track play for session stats (Feature 3)
      if (!state.sessionStats.tracksPlayed) {
        state.sessionStats.tracksPlayed = 1;
      }
      
      // Start beat-aware UI (Feature 8)
      startBeatPulse();
      
      // Show DJ screen for host even in simulated mode
      if (state.isHost) {
        showDjScreen();
      }
      
      // Broadcast PLAY to guests even in simulated mode
      if (state.isHost && state.ws) {
        send({ 
          t: "HOST_PLAY",
          trackUrl: null, // Simulated mode - no track URL
          filename: "Simulated Track",
          startPosition: 0
        });
      }
      
      // Update back to DJ button visibility
      updateBackToDjButton();
    }
  };
  
  el("btnPause").onclick = () => {
    if (state.adActive) return;
    
    const audioEl = musicState.audioElement;
    if (audioEl && audioEl.src && musicState.selectedFile) {
      audioEl.pause();
      state.playing = false;
      updateMusicStatus("Paused");
    } else {
      state.playing = false;
      updateMusicStatus("Pause (simulated)");
      toast("Pause (simulated)");
    }
    
    // Stop beat-aware UI (Feature 8)
    stopBeatPulse();
    
    // Broadcast PAUSE to guests
    if (state.isHost && state.ws) {
      send({ t: "HOST_PAUSE" });
    }
    
    // Update back to DJ button visibility (should hide when paused)
    updateBackToDjButton();
  };

  el("btnAd").onclick = () => {
    if (state.partyPro || state.partyPassActive || state.source === "mic") return;
    state.adActive = true; state.playing = false; updatePlaybackUI();
    toast("Ad (20s) — supporters remove ads");
    setTimeout(() => { state.adActive = false; updatePlaybackUI(); toast("Ad finished"); }, 20000);
  };

  // DJ Screen Controls
  const btnCloseDj = el("btnCloseDj");
  if (btnCloseDj) {
    btnCloseDj.onclick = () => {
      hideDjScreen();
    };
  }

  const btnDjPlay = el("btnDjPlay");
  if (btnDjPlay) {
    btnDjPlay.onclick = () => {
      // Trigger the main play button
      el("btnPlay").click();
    };
  }

  const btnDjPause = el("btnDjPause");
  if (btnDjPause) {
    btnDjPause.onclick = () => {
      // Trigger the main pause button
      el("btnPause").click();
    };
  }

  const btnDjStop = el("btnDjStop");
  if (btnDjStop) {
    btnDjStop.onclick = () => {
      if (state.adActive) return;
      
      state.playing = false;
      const audioEl = musicState.audioElement;
      if (audioEl && audioEl.src) {
        // Stop the audio and reset to beginning
        audioEl.pause();
        audioEl.currentTime = 0;
        updateMusicStatus("Stopped");
        console.log("[Music] Stopped and reset to beginning");
      } else {
        updateMusicStatus("Stop (simulated)");
        toast("Stop (simulated)");
      }
      
      // Stop beat-aware UI
      stopBeatPulse();
      
      // Broadcast STOP to guests
      if (state.isHost && state.ws) {
        send({ t: "HOST_STOP" });
        console.log("[DJ] Sent STOP to all guests");
      }
      
      // Update back to DJ button visibility
      updateBackToDjButton();
    };
  }

  const btnDjNext = el("btnDjNext");
  if (btnDjNext) {
    btnDjNext.onclick = () => {
      // Play queued track if available
      if (musicState.queuedFile) {
        playQueuedTrack();
      } else {
        toast("No track queued");
      }
    };
  }

  // Back to DJ View button
  const btnBackToDj = el("btnBackToDj");
  if (btnBackToDj) {
    btnBackToDj.onclick = () => {
      showDjScreen();
    };
  }

  // DJ Queue Track button
  const btnDjQueueTrack = el("btnDjQueueTrack");
  const djQueueFileInput = el("djQueueFileInput");
  if (btnDjQueueTrack && djQueueFileInput) {
    btnDjQueueTrack.onclick = () => {
      djQueueFileInput.click();
    };

    djQueueFileInput.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Validate file type
      const validTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-m4a', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/aac'];
      if (!validTypes.includes(file.type) && !file.name.match(/\.(mp3|wav|m4a|ogg|webm|aac)$/i)) {
        toast("⚠️ Invalid file type. Please select an audio file.");
        return;
      }

      // Clean up old queued file URL
      if (musicState.queuedObjectURL) {
        URL.revokeObjectURL(musicState.queuedObjectURL);
      }

      // Store queued file
      musicState.queuedFile = file;
      musicState.queuedObjectURL = URL.createObjectURL(file);

      toast(`✓ Queued: ${file.name}`);
      console.log(`[DJ Queue] Queued next track: ${file.name}`);
      
      // AUTO-UPLOAD queued file for guest streaming
      if (state.isHost) {
        uploadQueuedTrackToServer(file);
      }
      
      // Update DJ screen to show queued track
      updateDjScreen();

      // Clear the file input so the same file can be selected again
      djQueueFileInput.value = '';
    };
  }

  // DJ Short Message (Party Pass / Pro Monthly)
  const btnDjSendShortMessage = el("btnDjSendShortMessage");
  const djShortMessageInput = el("djShortMessageInput");
  if (btnDjSendShortMessage && djShortMessageInput) {
    // Send on button click
    btnDjSendShortMessage.onclick = () => {
      const text = djShortMessageInput.value;
      sendDjShortMessage(text);
      // Clear input after sending
      djShortMessageInput.value = '';
    };
    
    // Send on Enter key press
    djShortMessageInput.onkeypress = (e) => {
      if (e.key === 'Enter') {
        const text = djShortMessageInput.value;
        sendDjShortMessage(text);
        // Clear input after sending
        djShortMessageInput.value = '';
      }
    };
  }

  // Setup guest message buttons
  setupGuestMessageButtons();
  
  // Setup emoji reaction buttons
  setupEmojiReactionButtons();
  
  // Setup DJ preset message buttons
  setupDjPresetMessageButtons();
  
  // Setup DJ emoji reaction buttons
  setupDjEmojiReactionButtons();
  
  // Setup chat mode selector (for host)
  setupChatModeSelector();

  el("btnAddPhone").onclick = attemptAddPhone;

  el("btnSpeaker").onclick = () => { if (!state.partyPro && !state.partyPassActive) openPaywall(); else openSpeaker(); };
  
  // Music file upload handler
  const btnChooseMusicFile = el("btnChooseMusicFile");
  const musicFileInput = el("musicFileInput");
  
  if (btnChooseMusicFile && musicFileInput) {
    btnChooseMusicFile.onclick = () => {
      musicFileInput.click();
    };
    
    musicFileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      console.log("[Upload] File selected:", file.name, file.size, "bytes");
      
      // Show file info
      const uploadStatus = el("uploadStatus");
      const uploadFilename = el("uploadFilename");
      const uploadFileSize = el("uploadFileSize");
      const uploadStateBadge = el("uploadStateBadge");
      const uploadProgress = el("uploadProgress");
      const uploadProgressFill = el("uploadProgressFill");
      const uploadProgressText = el("uploadProgressText");
      
      if (uploadStatus) uploadStatus.classList.remove("hidden");
      if (uploadFilename) uploadFilename.textContent = file.name;
      if (uploadFileSize) uploadFileSize.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
      if (uploadStateBadge) {
        uploadStateBadge.textContent = "Uploading";
        uploadStateBadge.className = "status-badge uploading";
      }
      if (uploadProgress) uploadProgress.classList.remove("hidden");
      
      try {
        // Upload the file
        const formData = new FormData();
        formData.append('audio', file);
        
        const xhr = new XMLHttpRequest();
        
        // Track upload progress
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percentComplete = (e.loaded / e.total) * 100;
            if (uploadProgressFill) uploadProgressFill.style.width = `${percentComplete}%`;
            if (uploadProgressText) uploadProgressText.textContent = `Uploading... ${Math.round(percentComplete)}%`;
          }
        });
        
        // Handle upload completion
        xhr.addEventListener('load', async () => {
          if (xhr.status === 200) {
            try {
              const response = JSON.parse(xhr.responseText);
              console.log("[Upload] Track uploaded successfully:", response);
              
              // Hide progress, show ready status
              if (uploadProgress) uploadProgress.classList.add("hidden");
              if (uploadStateBadge) {
                uploadStateBadge.textContent = "Ready";
                uploadStateBadge.className = "status-badge ready";
              }
              
              // Extract title once to avoid duplication
              const trackTitle = response.title || file.name;
              
              // Update music state
              musicState.currentTrack = {
                trackId: response.trackId,
                trackUrl: response.trackUrl,
                title: trackTitle,
                uploadStatus: 'ready'
              };
              
              
              // Broadcast track to party members
              if (state.code) {
                try {
                  const broadcastResponse = await fetch(API_BASE + "/api/set-party-track", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      partyCode: state.code,
                      trackId: response.trackId,
                      trackUrl: response.trackUrl,
                      filename: trackTitle,
                      sizeBytes: response.sizeBytes,
                      contentType: response.contentType
                    })
                  });
                  
                  if (broadcastResponse.ok) {
                    const broadcastData = await broadcastResponse.json();
                    console.log("[Upload] Track broadcast to party:", broadcastData);
                    toast(`✅ Track ready for guests: ${file.name}`);
                  } else {
                    const errorText = await broadcastResponse.text();
                    console.error("[Upload] Failed to broadcast track:", broadcastResponse.status, errorText);
                    toast("⚠️ Track uploaded but failed to notify guests");
                  }
                } catch (err) {
                  console.error("[Upload] Error broadcasting track:", err);
                  toast("⚠️ Track uploaded but failed to notify guests");
                }
              }
            } catch (parseError) {
              console.error("[Upload] Failed to parse upload response:", parseError, xhr.responseText);
              if (uploadProgress) uploadProgress.classList.add("hidden");
              if (uploadStateBadge) {
                uploadStateBadge.textContent = "Error";
                uploadStateBadge.className = "status-badge error";
              }
              toast(`❌ Upload failed: Invalid server response`);
            }
          } else {
            console.error("[Upload] Upload failed:", xhr.status, xhr.responseText);
            if (uploadProgress) uploadProgress.classList.add("hidden");
            if (uploadStateBadge) {
              uploadStateBadge.textContent = "Error";
              uploadStateBadge.className = "status-badge error";
            }
            // Try to parse error message from response
            let errorMessage = `Upload failed (HTTP ${xhr.status})`;
            try {
              const errorData = JSON.parse(xhr.responseText);
              if (errorData.error) {
                errorMessage = errorData.error;
              }
            } catch (e) {
              // Use default error message
            }
            toast(`❌ ${errorMessage}`);
          }
        });
        
        xhr.addEventListener('error', () => {
          console.error("[Upload] Network error during upload");
          if (uploadProgress) uploadProgress.classList.add("hidden");
          if (uploadStateBadge) {
            uploadStateBadge.textContent = "Error";
            uploadStateBadge.className = "status-badge error";
          }
          toast("❌ Upload failed - network error");
        });
        
        xhr.open('POST', API_BASE + '/api/upload-track');
        xhr.send(formData);
        
      } catch (error) {
        console.error("[Upload] Error:", error);
        if (uploadProgress) uploadProgress.classList.add("hidden");
        if (uploadStateBadge) {
          uploadStateBadge.textContent = "Error";
          uploadStateBadge.className = "status-badge error";
        }
        toast("❌ Upload failed");
      }
    });
  }

  el("btnProYes").onclick = () => {
    el("togglePro").checked = true;
    state.isPro = true;
    send({ t: "SET_PRO", isPro: true });
    closePaywall();
    toast("Support mode on (this device)");
  };
  el("btnProNo").onclick = closePaywall;

  el("btnWarnCancel").onclick = closeWarn;
  el("btnWarnAnyway").onclick = () => { closeWarn(); toast("Okay — you chose to add more phones"); };

  el("btnSpeakerOk").onclick = closeSpeaker;

  // Party Pass activation buttons
  const btnActivateLanding = el("btnActivatePartyPassLanding");
  if (btnActivateLanding) {
    btnActivateLanding.onclick = () => {
      toast("Start a party to activate Party Pass");
      showHome();
    };
  }

  const btnActivateParty = el("btnActivatePartyPass");
  if (btnActivateParty) {
    btnActivateParty.onclick = () => {
      activatePartyPass();
    };
  }

  // Pro Monthly subscription button
  const btnSubscribeMonthly = el("btnSubscribeMonthly");
  if (btnSubscribeMonthly) {
    btnSubscribeMonthly.onclick = () => {
      console.log("[UI] Subscribe Monthly clicked");
      showHome();
    };
  }
})();


// ========================================
// FEATURE 1: CROWD ENERGY METER
// ========================================

function initCrowdEnergyMeter() {
  // Start decay interval
  if (state.crowdEnergyDecayInterval) {
    clearInterval(state.crowdEnergyDecayInterval);
  }
  
  state.crowdEnergyDecayInterval = setInterval(() => {
    if (state.crowdEnergy > 0) {
      state.crowdEnergy = Math.max(0, state.crowdEnergy - 1);
      updateCrowdEnergyDisplay();
    }
  }, 2000); // Decay by 1 every 2 seconds
}

function increaseCrowdEnergy(amount = 5) {
  state.crowdEnergy = Math.min(100, state.crowdEnergy + amount);
  if (state.crowdEnergy > state.crowdEnergyPeak) {
    state.crowdEnergyPeak = state.crowdEnergy;
    if (state.crowdEnergyPeak > state.sessionStats.peakEnergy) {
      state.sessionStats.peakEnergy = state.crowdEnergyPeak;
    }
  }
  updateCrowdEnergyDisplay();
}

function updateCrowdEnergyDisplay() {
  const valueEl = el("crowdEnergyValue");
  const fillEl = el("crowdEnergyFill");
  const peakEl = el("crowdEnergyPeakIndicator");
  const peakValueEl = el("crowdEnergyPeakValue");
  
  if (valueEl) valueEl.textContent = Math.round(state.crowdEnergy);
  if (fillEl) fillEl.style.width = `${state.crowdEnergy}%`;
  if (peakEl) peakEl.style.left = `${state.crowdEnergyPeak}%`;
  if (peakValueEl) peakValueEl.textContent = Math.round(state.crowdEnergyPeak);
  
  // Apply energy-based glow effects
  const card = el("crowdEnergyCard");
  if (card) {
    card.classList.remove("energy-glow-low", "energy-glow-medium", "energy-glow-high");
    if (state.crowdEnergy > 70) {
      card.classList.add("energy-glow-high");
    } else if (state.crowdEnergy > 40) {
      card.classList.add("energy-glow-medium");
    } else if (state.crowdEnergy > 10) {
      card.classList.add("energy-glow-low");
    }
  }
  
  // Update DJ screen crowd energy display
  const djValueEl = el("djCrowdEnergyValue");
  const djFillEl = el("djCrowdEnergyFill");
  const djPeakEl = el("djCrowdEnergyPeakIndicator");
  const djPeakValueEl = el("djCrowdEnergyPeakValue");
  
  if (djValueEl) djValueEl.textContent = Math.round(state.crowdEnergy);
  if (djFillEl) djFillEl.style.width = `${state.crowdEnergy}%`;
  if (djPeakEl) djPeakEl.style.left = `${state.crowdEnergyPeak}%`;
  if (djPeakValueEl) djPeakValueEl.textContent = Math.round(state.crowdEnergyPeak);
}

// ========================================
// FEATURE 2: DJ MOMENT BUTTONS
// ========================================

function initDJMoments() {
  const momentButtons = document.querySelectorAll(".btn-dj-moment, .btn-dj-moment-view");
  momentButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const moment = btn.dataset.moment;
      triggerDJMoment(moment);
    });
  });
}

function triggerDJMoment(moment) {
  // Clear previous moment
  if (state.momentTimeout) {
    clearTimeout(state.momentTimeout);
  }
  
  // Set current moment
  state.currentMoment = moment;
  
  // Update party view UI
  const currentMomentDisplay = el("currentMomentDisplay");
  const currentMomentValue = el("currentMomentValue");
  
  if (currentMomentDisplay) {
    currentMomentDisplay.classList.remove("hidden");
  }
  if (currentMomentValue) {
    currentMomentValue.textContent = moment.replace("_", " ");
  }
  
  // Update DJ screen UI
  const djCurrentMomentDisplay = el("djCurrentMomentDisplay");
  const djCurrentMomentValue = el("djCurrentMomentValue");
  
  if (djCurrentMomentDisplay) {
    djCurrentMomentDisplay.classList.remove("hidden");
  }
  if (djCurrentMomentValue) {
    djCurrentMomentValue.textContent = moment.replace("_", " ");
  }
  
  // Update button states (both party view and DJ view)
  document.querySelectorAll(".btn-dj-moment, .btn-dj-moment-view").forEach(btn => {
    if (btn.dataset.moment === moment) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
  
  // Apply visual effects
  applyMomentEffect(moment);
  
  // Auto-clear after 8 seconds
  state.momentTimeout = setTimeout(() => {
    state.currentMoment = null;
    if (currentMomentDisplay) {
      currentMomentDisplay.classList.add("hidden");
    }
    if (djCurrentMomentDisplay) {
      djCurrentMomentDisplay.classList.add("hidden");
    }
    document.querySelectorAll(".btn-dj-moment, .btn-dj-moment-view").forEach(btn => {
      btn.classList.remove("active");
    });
  }, 8000);
  
  toast(`DJ Moment: ${moment.replace("_", " ")}`);
}

function applyMomentEffect(moment) {
  const partyView = el("viewParty");
  if (!partyView) return;
  
  // Remove all effect classes
  partyView.classList.remove(
    "moment-effect-drop",
    "moment-effect-build", 
    "moment-effect-break",
    "moment-effect-hands-up"
  );
  
  // Add appropriate effect class
  const effectClass = `moment-effect-${moment.toLowerCase().replace("_", "-")}`;
  partyView.classList.add(effectClass);
  
  // Remove class after animation
  setTimeout(() => {
    partyView.classList.remove(effectClass);
  }, 1000);
}

// ========================================
// FEATURE 3: PARTY END RECAP
// ========================================

function initSessionStats() {
  state.sessionStats = {
    startTime: Date.now(),
    tracksPlayed: 0,
    totalReactions: 0,
    totalShoutouts: 0,
    totalMessages: 0,
    emojiCounts: {},
    peakEnergy: 0
  };
}

function trackReaction(emoji) {
  state.sessionStats.totalReactions++;
  if (emoji) {
    state.sessionStats.emojiCounts[emoji] = (state.sessionStats.emojiCounts[emoji] || 0) + 1;
  }
}

function trackMessage(isShoutout = false) {
  state.sessionStats.totalMessages++;
  if (isShoutout) {
    state.sessionStats.totalShoutouts++;
  }
}

function showPartyRecap() {
  const modal = el("modalPartyRecap");
  if (!modal) return;
  
  // Calculate duration
  const durationMs = Date.now() - (state.sessionStats.startTime || Date.now());
  const durationMin = Math.floor(durationMs / 60000);
  
  // Update recap values
  const recapDuration = el("recapDuration");
  const recapTracks = el("recapTracks");
  const recapPeakEnergy = el("recapPeakEnergy");
  const recapReactions = el("recapReactions");
  
  if (recapDuration) recapDuration.textContent = `${durationMin} min`;
  if (recapTracks) recapTracks.textContent = state.sessionStats.tracksPlayed;
  if (recapPeakEnergy) recapPeakEnergy.textContent = state.sessionStats.peakEnergy;
  if (recapReactions) recapReactions.textContent = state.sessionStats.totalReactions;
  
  // Show top emojis
  const topEmojisList = el("topEmojisList");
  if (topEmojisList) {
    const sortedEmojis = Object.entries(state.sessionStats.emojiCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    if (sortedEmojis.length > 0) {
      topEmojisList.innerHTML = sortedEmojis.map(([emoji, count]) => `
        <div class="top-emoji-item">
          <span class="top-emoji-icon">${emoji}</span>
          <span class="top-emoji-count">${count}</span>
        </div>
      `).join('');
    } else {
      topEmojisList.innerHTML = '<span class="muted tiny">No reactions yet</span>';
    }
  }
  
  modal.classList.remove("hidden");
}

function initPartyRecap() {
  const btnCloseRecap = el("btnCloseRecap");
  if (btnCloseRecap) {
    btnCloseRecap.onclick = () => {
      const modal = el("modalPartyRecap");
      if (modal) modal.classList.add("hidden");
      showLanding();
    };
  }
}

// ========================================
// FEATURE 4: SMART UPSELL TIMING
// ========================================

function checkSmartUpsell() {
  // Only show upsells at specific moments:
  // 1. When adding 3rd phone (already handled in existing code)
  // 2. After 3 tracks played and high energy
  // 3. After 10 minutes of party time
  
  if (state.partyPassActive || state.partyPro) {
    return; // Already upgraded
  }
  
  const partyDuration = Date.now() - (state.sessionStats.startTime || Date.now());
  const partyMinutes = partyDuration / 60000;
  
  // Show upsell after 10 minutes
  if (partyMinutes > 10 && state.sessionStats.tracksPlayed >= 2) {
    showSmartUpsell("You've been partying for 10+ minutes! Upgrade for the full experience.");
    return;
  }
  
  // Show upsell after 3 tracks with high energy
  if (state.sessionStats.tracksPlayed >= 3 && state.crowdEnergy > 60) {
    showSmartUpsell("The party's heating up! Unlock Pro features now.");
    return;
  }
}

function showSmartUpsell(message) {
  const banner = el("partyPassBanner");
  const upgrade = el("partyPassUpgrade");
  
  if (banner && upgrade) {
    banner.classList.remove("hidden");
    upgrade.classList.remove("hidden");
    
    // Update message if needed
    const tagline = upgrade.querySelector(".party-pass-upgrade-tagline");
    if (tagline && message) {
      tagline.textContent = message;
    }
  }
}

// ========================================
// FEATURE 5: HOST-GIFTED PARTY PASS
// ========================================

function initHostGiftPartyPass() {
  const btnGiftPartyPass = el("btnGiftPartyPass");
  if (btnGiftPartyPass) {
    btnGiftPartyPass.onclick = () => {
      // Simulate payment flow
      if (confirm("Purchase Party Pass for £3.99 to unlock Pro features for everyone in this party?")) { // GBP - Party Pass pricing
        activateGiftedPartyPass();
      }
    };
  }
}

function activateGiftedPartyPass() {
  state.partyPassActive = true;
  state.partyPro = true;
  state.partyPassEndTime = Date.now() + (2 * 60 * 60 * 1000); // 2 hours
  
  // Start timer
  startPartyPassTimer();
  
  // Update UI
  updatePartyPassUI();
  setPlanPill();
  
  // Hide gift section
  const giftSection = el("hostGiftSection");
  if (giftSection) giftSection.classList.add("hidden");
  
  toast("🎉 Party Pass activated! Everyone now has Pro features!");
  
  // In a real app, would broadcast this to all guests
}

// ========================================
// FEATURE 6: PARENT-FRIENDLY INFO TOGGLE
// ========================================

function initParentInfo() {
  // Debug panel removed - initialization code removed

  const btnParentInfo = el("btnParentInfo");
  const modalParentInfo = el("modalParentInfo");
  const btnCloseParentInfo = el("btnCloseParentInfo");
  
  if (btnParentInfo && modalParentInfo) {
    btnParentInfo.onclick = () => {
      modalParentInfo.classList.remove("hidden");
    };
  }
  
  if (btnCloseParentInfo && modalParentInfo) {
    btnCloseParentInfo.onclick = () => {
      modalParentInfo.classList.add("hidden");
    };
  }
}

// ========================================
// FEATURE 7: GUEST ANONYMITY BY DEFAULT
// ========================================

function getAnonymousGuestName() {
  const guestNum = state.nextGuestNumber++;
  return `Guest ${guestNum}`;
}

function applyGuestAnonymity() {
  // When creating or joining party, use anonymous name if no nickname provided
  const hostNameInput = el("hostName");
  const guestNameInput = el("guestName");
  
  if (hostNameInput && !hostNameInput.value.trim()) {
    const anonName = getAnonymousGuestName();
    state.name = anonName;
    state.guestNickname = null;
  } else if (hostNameInput) {
    state.name = hostNameInput.value.trim();
    state.guestNickname = state.name;
  }
  
  if (guestNameInput && !guestNameInput.value.trim()) {
    const anonName = getAnonymousGuestName();
    state.name = anonName;
    state.guestNickname = null;
  } else if (guestNameInput) {
    state.name = guestNameInput.value.trim();
    state.guestNickname = state.name;
  }
}

// ========================================
// FEATURE 8: BEAT-AWARE UI
// ========================================

function initBeatAwareUI() {
  // Start subtle pulse on playing state
  if (state.playing) {
    startBeatPulse();
  }
}

function startBeatPulse() {
  const partyView = el("viewParty");
  const crowdEnergyCard = el("crowdEnergyCard");
  
  // Add subtle pulse class based on energy level
  if (state.crowdEnergy > 50) {
    if (partyView) partyView.classList.add("beat-pulse-subtle");
    if (crowdEnergyCard) crowdEnergyCard.classList.add("beat-pulse-subtle");
  }
}

function stopBeatPulse() {
  const partyView = el("viewParty");
  const crowdEnergyCard = el("crowdEnergyCard");
  
  if (partyView) partyView.classList.remove("beat-pulse-subtle");
  if (crowdEnergyCard) crowdEnergyCard.classList.remove("beat-pulse-subtle");
}

function triggerBeatPulse() {
  // Trigger single pulse on reactions/moments
  const partyView = el("viewParty");
  if (partyView) {
    partyView.classList.add("beat-pulse");
    setTimeout(() => {
      partyView.classList.remove("beat-pulse");
    }, 600);
  }
}

// ========================================
// BOOST ADD-ONS
// ========================================

// Initialize Boost Add-ons
function initBoostAddons() {
  // Add-on 1: Extra Phones
  const btnExtraPhones = el("btnBuyExtraPhones");
  if (btnExtraPhones) {
    btnExtraPhones.addEventListener("click", () => {
      if (state.userTier === USER_TIER.FREE) {
        toast("Upgrade to Party Pass first to unlock extra phones!");
        return;
      }
      toast("Extra Phones add-on purchased! +2 phones added 🔊");
      updateBoostsUI();
    });
  }
  
  // Add-on 2: Extend Time
  const btnExtendTime = el("btnExtendTime");
  if (btnExtendTime) {
    btnExtendTime.addEventListener("click", () => {
      if (state.userTier !== USER_TIER.PARTY_PASS) {
        toast("Party Pass needed to extend time!");
        return;
      }
      if (!state.partyPassActive || !state.partyPassEndTime) {
        toast("Activate Party Pass first!");
        return;
      }
      // Add 1 hour to party pass
      const oneHour = 60 * 60 * 1000;
      state.partyPassEndTime += oneHour;
      
      // Update localStorage
      if (state.code) {
        localStorage.setItem(`partyPass_${state.code}`, JSON.stringify({
          endTime: state.partyPassEndTime,
          active: true
        }));
      }
      
      updatePartyPassTimer();
      toast("Party extended by 1 hour! Keep the vibes going! ⏰🎉");
      updateBoostsUI();
    });
  }
  
  // Add-on 3: Remove Ads
  const btnRemoveAds = el("btnRemoveAds");
  if (btnRemoveAds) {
    btnRemoveAds.addEventListener("click", () => {
      if (state.userTier !== USER_TIER.FREE) {
        toast("You're already ad-free – nice! 😎");
        return;
      }
      state.adActive = false;
      toast("Ads removed! Ad-free beats, non-stop vibes! 🎧✨");
      updateBoostsUI();
    });
  }
  
  // Add-on 4: Gift Party Pass
  const btnBoostGiftPartyPass = el("btnBoostGiftPartyPass");
  if (btnBoostGiftPartyPass) {
    btnBoostGiftPartyPass.addEventListener("click", () => {
      if (state.partyPassActive) {
        toast("Already in Party Pass mode! 🎉");
        return;
      }
      activatePartyPass();
      toast("Legend! You gifted Party Pass to everyone! 🎁🔥");
      updateBoostsUI();
    });
  }
  
  // Initial UI update
  updateBoostsUI();
}

// Update Boost Add-ons UI based on current tier
function updateBoostsUI() {
  const boostExtraPhones = el("boostExtraPhones");
  const boostExtendTime = el("boostExtendTime");
  const boostRemoveAds = el("boostRemoveAds");
  const boostGiftPartyPass = el("boostGiftPartyPass");
  
  // Extra Phones - only available with Party Pass or Pro
  if (boostExtraPhones) {
    const statusEl = el("boostExtraPhonesStatus");
    const reqEl = el("boostExtraPhonesReq");
    const btnEl = el("btnBuyExtraPhones");
    
    if (state.userTier === USER_TIER.FREE) {
      boostExtraPhones.setAttribute("data-status", "UPGRADE_REQUIRED");
      if (statusEl) statusEl.textContent = "UPGRADE REQUIRED";
      if (reqEl) reqEl.classList.remove("hidden");
      if (btnEl) btnEl.disabled = true;
    } else {
      boostExtraPhones.setAttribute("data-status", "AVAILABLE");
      if (statusEl) statusEl.textContent = "AVAILABLE";
      if (reqEl) reqEl.classList.add("hidden");
      if (btnEl) btnEl.disabled = false;
    }
  }
  
  // Extend Time - only for Party Pass
  if (boostExtendTime) {
    const statusEl = el("boostExtendTimeStatus");
    const reqEl = el("boostExtendTimeReq");
    const btnEl = el("btnExtendTime");
    
    if (state.userTier === USER_TIER.PARTY_PASS && state.partyPassActive) {
      boostExtendTime.setAttribute("data-status", "AVAILABLE");
      if (statusEl) statusEl.textContent = "AVAILABLE";
      if (reqEl) reqEl.classList.add("hidden");
      if (btnEl) btnEl.disabled = false;
    } else {
      boostExtendTime.setAttribute("data-status", "UPGRADE_REQUIRED");
      if (statusEl) statusEl.textContent = "UPGRADE REQUIRED";
      if (reqEl) reqEl.classList.remove("hidden");
      if (btnEl) btnEl.disabled = true;
    }
  }
  
  // Remove Ads - only for Free tier
  if (boostRemoveAds) {
    const statusEl = el("boostRemoveAdsStatus");
    const reqEl = el("boostRemoveAdsReq");
    const btnEl = el("btnRemoveAds");
    
    if (state.userTier === USER_TIER.FREE && state.adActive !== false) {
      boostRemoveAds.setAttribute("data-status", "AVAILABLE");
      if (statusEl) statusEl.textContent = "AVAILABLE";
      if (reqEl) reqEl.classList.add("hidden");
      if (btnEl) btnEl.disabled = false;
    } else {
      boostRemoveAds.setAttribute("data-status", "NOT_APPLICABLE");
      if (statusEl) statusEl.textContent = "NOT APPLICABLE";
      if (reqEl) reqEl.classList.remove("hidden");
      if (btnEl) btnEl.disabled = true;
    }
  }
  
  // Gift Party Pass - not available if already active
  if (boostGiftPartyPass) {
    const statusEl = el("boostGiftPartyPassStatus");
    const reqEl = el("boostGiftPartyPassReq");
    const btnEl = el("btnBoostGiftPartyPass");
    
    if (state.partyPassActive || state.userTier === USER_TIER.PARTY_PASS) {
      boostGiftPartyPass.setAttribute("data-status", "ACTIVE");
      if (statusEl) statusEl.textContent = "ACTIVE";
      if (reqEl) reqEl.classList.remove("hidden");
      if (btnEl) btnEl.disabled = true;
    } else {
      boostGiftPartyPass.setAttribute("data-status", "AVAILABLE");
      if (statusEl) statusEl.textContent = "AVAILABLE";
      if (reqEl) reqEl.classList.add("hidden");
      if (btnEl) btnEl.disabled = false;
    }
  }
}

// ========================================
// INITIALIZE ALL FEATURES
// ========================================

// ============================================================
// DEV/TEST MODE UTILITIES
// ============================================================

/**
 * Initialize dev/test mode with temporary user
 * NOTE: This function is no longer called in production. Kept for reference.
 */
function initializeDevMode() {
  console.log('[DEV MODE] Initializing...');
  
  // Generate temporary user credentials
  const tempUser = generateTempUser();
  
  // Store in localStorage as if user is logged in
  localStorage.setItem('devModeUser', JSON.stringify(tempUser));
  
  // Set user state
  state.userTier = tempUser.tier;
  state.isPro = tempUser.tier === USER_TIER.PRO;
  state.partyPassActive = tempUser.tier === USER_TIER.PARTY_PASS;
  
  console.log('[DEV MODE] Temp user created:', tempUser);
  
  // Show dev mode indicator
  showDevModeIndicator('DEV');
}

/**
 * Generate temporary user for dev/test mode
 * @returns {object} Temporary user object
 */
function generateTempUser() {
  const randomId = Math.random().toString(36).substring(2, 8);
  const tiers = [USER_TIER.FREE, USER_TIER.PARTY_PASS, USER_TIER.PRO];
  
  // Get tier from URL or random
  const urlParams = new URLSearchParams(window.location.search);
  let tier = urlParams.get('tier')?.toUpperCase();
  if (!tiers.includes(tier)) {
    tier = USER_TIER.PRO; // Default to PRO for dev/test
  }
  
  return {
    username: `dev_${randomId}`,
    email: `dev_${randomId}@example.com`, // Using example.com per RFC 2606
    tier: tier,
    userId: `dev_${randomId}`,
    createdAt: Date.now(),
    devMode: true
  };
}

/**
 * Show dev mode indicator in UI
 */
function showDevModeIndicator(mode) {
  const indicator = document.createElement('div');
  indicator.id = 'devModeIndicator';
  indicator.style.cssText = `
    position: fixed;
    top: 10px;
    left: 10px;
    background: rgba(255, 45, 149, 0.9);
    color: white;
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    z-index: 10000;
    box-shadow: 0 0 20px rgba(255, 45, 149, 0.6);
    animation: pulse 2s ease-in-out infinite;
  `;
  indicator.textContent = `${mode} MODE`;
  document.body.appendChild(indicator);
  
  // Show dev navigation panel
  showDevNavigationPanel();
}

/**
 * Show and initialize dev navigation panel
 */
function showDevNavigationPanel() {
  const devPanel = document.getElementById('devNavigationPanel');
  if (!devPanel) return;
  
  // Show the panel
  devPanel.classList.remove('hidden');
  
  // Use event delegation to handle navigation button clicks (prevents duplicate listeners)
  if (!devPanel.dataset.initialized) {
    devPanel.addEventListener('click', (e) => {
      const navBtn = e.target.closest('.dev-nav-btn');
      if (navBtn) {
        const viewId = navBtn.getAttribute('data-view');
        if (viewId) {
          console.log(`[DEV NAV] Navigating to: ${viewId}`);
          showView(viewId);
        }
      }
      
      // Handle close button
      if (e.target.id === 'btnCloseDevNav' || e.target.closest('#btnCloseDevNav')) {
        devPanel.classList.add('hidden');
      }
    });
    
    devPanel.dataset.initialized = 'true';
  }
  
  console.log('[DEV NAV] Dev navigation panel initialized');
}

/**
 * Auto-create and start a dev party
 */
async function autoCreateDevParty(user) {
  try {
    const djName = `DJ ${user.username}`;
    const response = await fetch(API_BASE + '/api/create-party', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        djName: djName,
        source: 'local'
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('[DEV MODE] Party created:', data.code);
      
      // Auto-navigate to party view
      state.code = data.code;
      state.hostId = data.hostId;
      state.isHost = true;
      state.djName = djName;
      
      showParty();
      connectWebSocket();
    } else {
      console.error('[DEV MODE] Failed to create party:', response.status);
    }
  } catch (error) {
    console.error('[DEV MODE] Error creating party:', error);
  }
}

function initializeAllFeatures() {
  console.log('[Features] Initializing all features');
  
  // Restore user entitlements if logged in
  if (typeof restoreUserEntitlements === 'function') {
    restoreUserEntitlements().catch(err => {
      console.log('[Features] Could not restore entitlements:', err.message);
    });
  }
  
  // Initialize network monitoring if available
  if (typeof initNetworkMonitoring === 'function') {
    initNetworkMonitoring();
  }
  
  // Initialize accessibility if available
  if (typeof initAccessibility === 'function') {
    initAccessibility();
  }
  
  // Initialize moderation if available
  if (typeof initModeration === 'function') {
    initModeration();
  }
  
  initCrowdEnergyMeter();
  initDJMoments();
  initPartyRecap();
  initHostGiftPartyPass();
  initParentInfo();
  initBeatAwareUI();
  initSessionStats();
  initBoostAddons();
  
  console.log("[Features] All features initialized");
  
  // Check for auto-reconnect after features are initialized
  checkAutoReconnect();
}

// Auto-reconnect functionality for guests
async function checkAutoReconnect() {
  try {
    const sessionData = localStorage.getItem('syncSpeakerGuestSession');
    if (!sessionData) {
      console.log("[Guest] No saved session found");
      return;
    }
    
    const session = JSON.parse(sessionData);
    const { partyCode, guestId, nickname, joinedAt } = session;
    
    // Validate required session properties
    if (!partyCode || !nickname || !joinedAt) {
      console.log("[Guest] Invalid session data, missing required properties");
      localStorage.removeItem('syncSpeakerGuestSession');
      return;
    }
    
    // Check if session is recent (within 24 hours)
    const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
    const sessionAge = Date.now() - joinedAt;
    
    if (sessionAge > SESSION_EXPIRY_MS) {
      console.log("[Guest] Session expired, clearing");
      localStorage.removeItem('syncSpeakerGuestSession');
      return;
    }
    
    console.log("[Guest] Found recent session:", session);
    
    // First check if party still exists
    const partyCheckResponse = await fetch(API_BASE + `/api/party?code=${encodeURIComponent(partyCode)}`);
    if (!partyCheckResponse.ok) {
      console.log("[Guest] Party no longer exists, clearing session");
      localStorage.removeItem('syncSpeakerGuestSession');
      return;
    }
    
    const partyData = await partyCheckResponse.json();
    if (!partyData.exists || partyData.status === 'ended' || partyData.status === 'expired') {
      console.log("[Guest] Party has ended or expired, clearing session");
      localStorage.removeItem('syncSpeakerGuestSession');
      return;
    }
    
    // Show reconnect prompt
    // Note: Using native confirm() for simplicity. Could be replaced with custom modal for better accessibility.
    const shouldReconnect = confirm(`Reconnect to party ${partyCode}?\n\nYou were previously in this party as "${nickname}".`);
    
    if (shouldReconnect) {
      console.log("[Guest] User chose to reconnect");
      state.isReconnecting = true;
      
      // Pre-fill the join code input
      const joinCodeInput = el("joinCode");
      if (joinCodeInput) {
        joinCodeInput.value = partyCode;
      }
      
      // Auto-trigger join
      try {
        const response = await fetch(API_BASE + "/api/join-party", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            partyCode: partyCode,
            nickname: nickname
          })
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: "Failed to parse error response" }));
          throw new Error(errorData.error || "Failed to reconnect");
        }
        
        const data = await response.json();
        console.log("[Guest] Reconnected successfully:", data);
        
        // Update state with fresh data from server
        if (data.guestId) {
          state.clientId = data.guestId;
        }
        if (data.nickname) {
          state.guestNickname = data.nickname;
        }
        state.code = partyCode;
        state.isHost = false;
        state.connected = true;
        
        // Save updated session with new values from server
        const updatedSession = {
          partyCode: partyCode,
          guestId: data.guestId,
          nickname: data.nickname,
          joinedAt: Date.now()
        };
        localStorage.setItem('syncSpeakerGuestSession', JSON.stringify(updatedSession));
        
        // Show guest view
        showGuest();
        toast(`Reconnected to party ${partyCode}`);
        
        // Try WebSocket connection (optional)
        try {
          send({ t: "JOIN", code: partyCode, name: nickname, isPro: state.isPro || false });
        } catch (wsError) {
          console.warn("[Guest] WebSocket not available, using polling only:", wsError);
        }
        
      } catch (error) {
        console.error("[Guest] Reconnect failed:", error);
        toast(error.message || "Failed to reconnect");
        localStorage.removeItem('syncSpeakerGuestSession');
        state.isReconnecting = false;
      }
    } else {
      console.log("[Guest] User declined to reconnect, clearing session");
      localStorage.removeItem('syncSpeakerGuestSession');
    }
    
  } catch (error) {
    console.error("[Guest] Error checking auto-reconnect:", error);
    // Clear potentially corrupted session data
    localStorage.removeItem('syncSpeakerGuestSession');
  }
}

// ============================================
// AUTHENTICATION INTEGRATION
// ============================================
// AUTHENTICATION INTEGRATION
// ============================================

/**
 * Show a specific view and hide all others
 */
function showView(viewId) {
  // Hide all main views
  ALL_VIEWS.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('hidden');
    }
  });
  
  // Show the requested view
  const targetView = document.getElementById(viewId);
  if (targetView) {
    targetView.classList.remove('hidden');
  }

  // Reset the page scroll so every new view starts at the top (instant, not smooth animated)
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
}

/**
 * Initialize authentication UI and state
 */
function initializeAuth() {
  console.log('[Auth] Initializing authentication system');
  
  // Use synchronous cache; getCurrentUser() is async and would return a Promise here
  const cachedData = getCachedUser();
  if (cachedData) {
    const userEmail = (cachedData.user && cachedData.user.email) || cachedData.email || '';
    console.log('[Auth] User logged in:', userEmail);
    state.userTier = cachedData.effectiveTier || cachedData.tier || USER_TIER.FREE;
    // Build a flat user object compatible with updateUIForLoggedInUser
    const flatUser = {
      email: userEmail,
      djName: (cachedData.user && cachedData.user.djName) || cachedData.djName || '',
      tier: cachedData.effectiveTier || cachedData.tier || USER_TIER.FREE
    };
    updateUIForLoggedInUser(flatUser);
  } else {
    console.log('[Auth] No user logged in');
  }
  
  // Set up event listeners for auth forms
  setupAuthEventListeners();
}

/**
 * Update UI for logged in user
 */
function updateUIForLoggedInUser(user) {
  const btnAccount = document.getElementById('btnAccount');
  if (btnAccount) {
    btnAccount.textContent = user.djName || '👤';
    btnAccount.title = user.email;
  }
  
  const planPill = document.getElementById('planPill');
  if (planPill) {
    const limits = {
      FREE: `${user.tier} · ${FREE_LIMIT} phones`,
      PARTY_PASS: `Party Pass · ${PARTY_PASS_LIMIT} phones`,
      PRO: `${user.tier} · ${PRO_LIMIT} phones`
    };
    planPill.textContent = limits[user.tier] || limits.FREE;
  }
  
  // Apply DJ name if hosting
  if (user.djName) {
    state.djName = user.djName;
  }
}

/**
 * Set up auth event listeners.
 * Guarded by _authListenersAttached so it can be called multiple times safely
 * without attaching duplicate handlers (which would double-fire auth requests).
 */
function setupAuthEventListeners() {
  if (_authListenersAttached) return;
  _authListenersAttached = true;

  // Account button
  const btnAccount = document.getElementById('btnAccount');
  if (btnAccount) {
    btnAccount.addEventListener('click', () => {
      if (isLoggedIn()) {
        showProfile();
      } else {
        setView('login');
      }
    });
  }
  
  // Login form
  const formLogin = document.getElementById('formLogin');
  if (formLogin) {
    formLogin.addEventListener('submit', (e) => {
      e.preventDefault();
      handleLogin();
    });
  }
  
  // Signup form
  const formSignup = document.getElementById('formSignup');
  if (formSignup) {
    formSignup.addEventListener('submit', (e) => {
      e.preventDefault();
      handleSignup();
    });
  }
  
  // Password reset request
  const formPasswordResetRequest = document.getElementById('formPasswordResetRequest');
  if (formPasswordResetRequest) {
    formPasswordResetRequest.addEventListener('submit', (e) => {
      e.preventDefault();
      handlePasswordResetRequest();
    });
  }
  
  // Password reset
  const formPasswordReset = document.getElementById('formPasswordReset');
  if (formPasswordReset) {
    formPasswordReset.addEventListener('submit', (e) => {
      e.preventDefault();
      handlePasswordReset();
    });
  }
  
  // Profile update
  const formProfileUpdate = document.getElementById('formProfileUpdate');
  if (formProfileUpdate) {
    formProfileUpdate.addEventListener('submit', (e) => {
      e.preventDefault();
      handleProfileUpdate();
    });
  }
  
  // Logout button
  const btnLogout = document.getElementById('btnLogout');
  if (btnLogout) {
    btnLogout.addEventListener('click', handleLogout);
  }
  
  // Close profile
  const btnCloseProfile = document.getElementById('btnCloseProfile');
  if (btnCloseProfile) {
    btnCloseProfile.addEventListener('click', () => setView('authHome'));
  }
  
  // Navigation links
  document.getElementById('linkToSignup')?.addEventListener('click', (e) => {
    e.preventDefault();
    setView('signup');
  });
  
  document.getElementById('linkToLogin')?.addEventListener('click', (e) => {
    e.preventDefault();
    setView('login');
  });
  
  document.getElementById('linkToLanding')?.addEventListener('click', (e) => {
    e.preventDefault();
    setView('landing');
  });
  
  document.getElementById('linkSignupToLanding')?.addEventListener('click', (e) => {
    e.preventDefault();
    setView('landing');
  });
  
  document.getElementById('linkForgotPassword')?.addEventListener('click', (e) => {
    e.preventDefault();
    setView('passwordReset');
  });
  
  document.getElementById('linkResetToLogin')?.addEventListener('click', (e) => {
    e.preventDefault();
    setView('login');
  });

  // Legal page links (signup form + footer)
  document.querySelectorAll('.link-to-terms').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      setView('terms');
    });
  });

  document.querySelectorAll('.link-to-privacy').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      setView('privacy');
    });
  });

  document.querySelectorAll('.link-to-landing-from-legal').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      // Go back to previous view or landing
      if (window.history.length > 1) {
        window.history.back();
      } else {
        setView('landing');
      }
    });
  });

  // Old account creation form (viewAccountCreation) — redirect to the new signup view.
  // The old form lacks a terms checkbox so we forward users to the canonical signup form.
  const btnCreateAccountSubmit = document.getElementById('btnCreateAccountSubmit');
  if (btnCreateAccountSubmit) {
    btnCreateAccountSubmit.addEventListener('click', (e) => {
      e.preventDefault();
      setView('signup');
    });
  }
}

/**
 * Handle login.
 * Protected by an inFlight guard and a client-side rate-limit cooldown so
 * the user can never fire more than one request at a time.
 */
async function handleLogin() {
  // Enforce client-side cooldown after a rate-limit error.
  if (Date.now() < _authRateLimitedUntil) {
    const secsLeft = Math.ceil((_authRateLimitedUntil - Date.now()) / 1000);
    const errorEl = document.getElementById('loginError');
    if (errorEl) {
      errorEl.textContent = `Too many attempts. Please wait ${secsLeft} second${secsLeft !== 1 ? 's' : ''} before trying again.`;
      errorEl.classList.remove('hidden');
    }
    return;
  }

  // Prevent duplicate concurrent requests.
  if (_loginInFlight) return;
  _loginInFlight = true;

  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  const submitBtn = document.querySelector('#formLogin button[type="submit"]');

  // Disable button and show loading state while request is in flight.
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.dataset.originalText = submitBtn.textContent;
    submitBtn.textContent = 'Logging in…';
  }
  if (errorEl) errorEl.classList.add('hidden');

  try {
    const result = await logIn(email, password);

    if (result.success) {
      // Save profile to localStorage for fast auth detection on next startup
      if (result.user) {
        state.userTier = result.user.tier;
        saveProfile({ djName: result.user.djName, email: result.user.email, tier: result.user.tier });
      }
      const sessionOk = await confirmAuthSession();
      if (sessionOk) {
        showToast('✅ Welcome back!');
      } else {
        // Login API succeeded but session could not be confirmed — show visible error toast.
        // The user remains in the authenticated flow (profile saved); they are NOT bounced
        // to the landing page. A retry or page refresh will complete session propagation.
        showToast('⚠️ Login succeeded but session could not be verified. Please try again or clear your cookies.');
      }
    } else {
      if (errorEl) {
        errorEl.textContent = mapAuthError(result.error, result.status);
        errorEl.classList.remove('hidden');
      }
      // Apply client-side cooldown when the server signals too many requests.
      if (result.status === 429 || (result.error && result.error.toLowerCase().includes('too many'))) {
        _authRateLimitedUntil = Date.now() + 60_000; // 60-second client cooldown
      }
    }
  } finally {
    _loginInFlight = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.originalText || 'Log In';
      delete submitBtn.dataset.originalText;
    }
  }
}

/**
 * Handle signup.
 * Protected by an inFlight guard and a client-side rate-limit cooldown so
 * the user can never fire more than one request at a time.
 */
async function handleSignup() {
  // Enforce client-side cooldown after a rate-limit error.
  if (Date.now() < _authRateLimitedUntil) {
    const secsLeft = Math.ceil((_authRateLimitedUntil - Date.now()) / 1000);
    const errorEl = document.getElementById('signupError');
    if (errorEl) {
      errorEl.textContent = `Too many attempts. Please wait ${secsLeft} second${secsLeft !== 1 ? 's' : ''} before trying again.`;
      errorEl.classList.remove('hidden');
    }
    return;
  }

  const email = document.getElementById('signupEmail').value;
  const password = document.getElementById('signupPassword').value;
  const djName = document.getElementById('signupDjName').value.trim();
  const termsCheckbox = document.getElementById('signupTermsAccept');
  const termsAccepted = termsCheckbox ? termsCheckbox.checked : false;
  const errorEl = document.getElementById('signupError');

  // Run synchronous validation before the inFlight guard so the user still sees
  // form errors even when a previous request is outstanding.
  if (!djName) {
    errorEl.textContent = 'DJ Name is required';
    errorEl.classList.remove('hidden');
    return;
  }

  if (!termsAccepted) {
    errorEl.textContent = 'You must accept the Terms & Conditions and Privacy Policy to create an account';
    errorEl.classList.remove('hidden');
    return;
  }

  // Prevent duplicate concurrent API requests (checked after validation so
  // the user still receives inline errors even while a request is in flight).
  if (_signupInFlight) return;
  _signupInFlight = true;

  const submitBtn = document.querySelector('#formSignup button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.dataset.originalText = submitBtn.textContent;
    submitBtn.textContent = 'Creating account…';
  }
  if (errorEl) errorEl.classList.add('hidden');

  try {
    const result = await signUp(email, password, djName, termsAccepted);

    if (result.success) {
      // Persist the profile locally for profile-completion UX, but keep access
      // to protected views gated on the server-confirmed auth session.
      if (result.user && result.user.djName) {
        saveProfile({ djName: result.user.djName, email: result.user.email || email, tier: USER_TIER.FREE });
      }

      // Attempt to register referral if the user arrived via an invite link
      try {
        const refCode = localStorage.getItem('referral_code');
        const clickId = localStorage.getItem('referral_click_id');
        if (refCode) {
          fetch(API_BASE + '/api/referral/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ referralCode: refCode, clickId: clickId || null })
          }).catch(() => {});
          // Don't clear yet — keep until profile-complete step fires
        }
      } catch (_) { /* ignore localStorage errors */ }

      // Show inline success message before navigating
      errorEl.textContent = 'Welcome to the party 🥳';
      errorEl.classList.remove('hidden');
      errorEl.classList.add('success');
      // Wait ~1.5s so the user sees the success message before the view transitions
      await new Promise((r) => setTimeout(r, 1500));
      const sessionOk = await confirmAuthSession();
      if (!sessionOk) {
        // Do not advance into authenticated views unless the server confirms the
        // session. Keep the user on auth screens and surface a clear recovery path.
        // NOTE: unlike initAuthFlow(), confirmAuthSession() does NOT redirect to
        // landing — the user's profile is still in localStorage so they remain in
        // the authenticated flow and can retry.
        if (errorEl) {
          errorEl.textContent = 'Account created, but we could not verify your session. Please log in to continue.';
          errorEl.classList.remove('success');
          errorEl.classList.remove('hidden');
        }
        showToast('⚠️ Account created, but your session could not be verified yet. Please log in.');
        setView('login');
      }
    } else {
      if (result.status === 409) {
        // Duplicate email — show "Account already exists" message and a "Log In Instead" link
        errorEl.textContent = 'Account already exists. ';
        const loginLink = document.createElement('a');
        loginLink.href = '#';
        loginLink.id = 'signupLoginInstead';
        loginLink.style.cssText = 'color:inherit;text-decoration:underline';
        loginLink.textContent = 'Log In Instead';
        loginLink.addEventListener('click', (e) => {
          e.preventDefault();
          setView('login');
        });
        errorEl.appendChild(loginLink);
      } else {
        errorEl.textContent = mapAuthError(result.error, result.status);
      }
      errorEl.classList.remove('hidden');
      // Apply client-side cooldown when the server signals too many requests.
      if (result.status === 429 || (result.error && result.error.toLowerCase().includes('too many'))) {
        _authRateLimitedUntil = Date.now() + 60_000; // 60-second client cooldown
      }
    }
  } finally {
    _signupInFlight = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.originalText || 'Create Account';
      delete submitBtn.dataset.originalText;
    }
  }
}

/**
 * Handle logout
 */
async function handleLogout() {
  await logOut();
  clearProfile();
  _currentUserIsAdmin = false;
  state.userTier = USER_TIER.FREE;
  const headerAuthButtons = document.getElementById('headerAuthButtons');
  if (headerAuthButtons) headerAuthButtons.style.display = 'none';
  window.AppStateMachine && window.AppStateMachine.transitionTo(window.AppStateMachine.STATES.LOGGED_OUT);
  setView('landing');
  showToast('👋 Logged out');
}

/**
 * Handle password reset request
 */
function handlePasswordResetRequest() {
  const email = document.getElementById('resetEmail').value;
  const errorEl = document.getElementById('resetRequestError');
  const successEl = document.getElementById('resetRequestSuccess');
  
  const result = requestPasswordReset(email);
  
  if (result.success) {
    successEl.textContent = result.message + (result.debugCode ? ` Code: ${result.debugCode}` : '');
    successEl.classList.remove('hidden');
    errorEl.classList.add('hidden');
    
    // Show reset form
    document.getElementById('formPasswordResetRequest').classList.add('hidden');
    document.getElementById('formPasswordReset').classList.remove('hidden');
  } else {
    errorEl.textContent = result.error;
    errorEl.classList.remove('hidden');
    successEl.classList.add('hidden');
  }
}

/**
 * Handle password reset
 */
function handlePasswordReset() {
  const email = document.getElementById('resetEmail').value;
  const code = document.getElementById('resetCode').value;
  const newPassword = document.getElementById('resetNewPassword').value;
  const errorEl = document.getElementById('resetError');
  
  const result = resetPassword(email, code, newPassword);
  
  if (result.success) {
    showView('viewLogin');
    showToast('✅ Password reset successfully! Please log in.');
  } else {
    errorEl.textContent = result.error;
    errorEl.classList.remove('hidden');
  }
}

/**
 * Handle profile update
 */
async function handleProfileUpdate() {
  const djName = document.getElementById('profileDjNameInput').value;
  
  const result = await updateUserProfile({ djName });
  
  if (result.success) {
    // Refresh the profile view with updated data
    showProfile();
    showToast('✅ Profile updated!');
  } else {
    showToast('❌ Failed to update profile');
  }
}

/**
 * Show profile view
 */
function showProfile() {
  const data = getCachedUser();
  if (!data) {
    setView('login');
    return;
  }

  const userData = data.user || {};
  const profile = data.profile || {};
  const tier = data.effectiveTier || data.tier || 'FREE';

  // Update profile display
  document.getElementById('profileAvatar').textContent = '🎧';
  document.getElementById('profileDjName').textContent = userData.djName || 'Set your DJ name';
  document.getElementById('profileEmail').textContent = userData.email || '';

  const tierBadge = document.getElementById('profileTierBadge');
  tierBadge.textContent = tier;
  tierBadge.className = 'tier-badge ' + tier;

  // Stats — not returned by /api/me; default to 0
  document.getElementById('statTotalParties').textContent = 0;
  document.getElementById('statTotalTracks').textContent = 0;
  document.getElementById('statTotalGuests').textContent = 0;

  // DJ Rank
  const rankBadge = document.getElementById('profileRankBadge');
  const djRank = profile.djRank || 'BEGINNER';
  const djScore = profile.djScore || 0;
  rankBadge.textContent = djRank;

  document.getElementById('profileScore').textContent = djScore;

  // Calculate rank progress
  const rankThresholds = {
    BEGINNER: 0,
    INTERMEDIATE: 100,
    ADVANCED: 500,
    EXPERT: 2000,
    MASTER: 5000,
    LEGEND: 10000
  };

  const currentRank = djRank;
  const score = djScore;
  const ranks = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT', 'MASTER', 'LEGEND'];
  const currentIndex = ranks.indexOf(currentRank);

  let progress = 0;
  let progressLabel = 'Keep hosting to rank up!';

  if (currentIndex < ranks.length - 1) {
    const nextRank = ranks[currentIndex + 1];
    const currentThreshold = rankThresholds[currentRank];
    const nextThreshold = rankThresholds[nextRank];
    progress = ((score - currentThreshold) / (nextThreshold - currentThreshold)) * 100;
    progressLabel = `${Math.floor(nextThreshold - score)} points to ${nextRank}`;
  } else {
    progress = 100;
    progressLabel = 'Maximum rank achieved!';
  }

  document.getElementById('profileRankProgress').style.width = progress + '%';
  document.getElementById('profileRankLabel').textContent = progressLabel;

  // Form inputs
  document.getElementById('profileDjNameInput').value = userData.djName || '';
  document.getElementById('profileGuestNameInput').value = '';

  showView('viewProfile');
}

// ============================================================================
// MONETIZATION FUNCTIONS
// ============================================================================

/**
 * Load monetization state from localStorage
 */
function loadMonetizationState() {
  const data = getCachedUser();
  if (!data) return;
  
  const email = (data.user && data.user.email) || data.email || '';
  const saved = localStorage.getItem(`monetization_${email}`);
  if (saved) {
    const savedData = JSON.parse(saved);
    monetizationState.ownedVisualPacks = savedData.ownedVisualPacks || [];
    monetizationState.ownedTitles = savedData.ownedTitles || [];
    monetizationState.ownedProfileUpgrades = savedData.ownedProfileUpgrades || [];
    monetizationState.activeVisualPack = savedData.activeVisualPack || null;
    monetizationState.activeTitle = savedData.activeTitle || null;
    monetizationState.proSubscriptionActive = savedData.proSubscriptionActive || false;
    monetizationState.proSubscriptionEndDate = savedData.proSubscriptionEndDate || null;
  }
}

/**
 * Save monetization state to localStorage
 */
function saveMonetizationState() {
  const data = getCachedUser();
  if (!data) return;
  
  const email = (data.user && data.user.email) || data.email || '';
  const stateData = {
    ownedVisualPacks: monetizationState.ownedVisualPacks,
    ownedTitles: monetizationState.ownedTitles,
    ownedProfileUpgrades: monetizationState.ownedProfileUpgrades,
    activeVisualPack: monetizationState.activeVisualPack,
    activeTitle: monetizationState.activeTitle,
    proSubscriptionActive: monetizationState.proSubscriptionActive,
    proSubscriptionEndDate: monetizationState.proSubscriptionEndDate
  };
  
  localStorage.setItem(`monetization_${email}`, JSON.stringify(stateData));
}

/**
 * Purchase a visual pack
 */
function purchaseVisualPack(packId) {
  const pack = VISUAL_PACKS[packId];
  if (!pack) return { success: false, error: 'Pack not found' };
  
  if (monetizationState.ownedVisualPacks.includes(packId)) {
    return { success: false, error: 'Already owned' };
  }
  
  // Simulate payment (in real app, this would call payment API)
  monetizationState.ownedVisualPacks.push(packId);
  
  // Auto-activate if it's the first pack
  if (!monetizationState.activeVisualPack) {
    monetizationState.activeVisualPack = packId;
  }
  
  saveMonetizationState();
  return { success: true, pack };
}

/**
 * Activate a visual pack (can only have one active at a time)
 */
function activateVisualPack(packId) {
  if (!monetizationState.ownedVisualPacks.includes(packId)) {
    return { success: false, error: 'Pack not owned' };
  }
  
  monetizationState.activeVisualPack = packId;
  saveMonetizationState();
  applyActiveVisualPack();
  return { success: true };
}

/**
 * Apply the active visual pack to the UI
 */
function applyActiveVisualPack() {
  const packId = monetizationState.activeVisualPack;
  if (!packId) return;
  
  const pack = VISUAL_PACKS[packId];
  if (!pack) return;
  
  // Apply visual pack styling to the body or main visual area
  document.documentElement.style.setProperty('--visual-pack-primary', pack.previewColor);
  
  // Update visual stage if present
  const visualStage = document.querySelector('.visual-stage');
  if (visualStage) {
    visualStage.setAttribute('data-pack', packId);
  }
}

/**
 * Purchase a DJ title
 */
function purchaseTitle(titleId) {
  const title = DJ_TITLES[titleId];
  if (!title) return { success: false, error: 'Title not found' };
  
  if (monetizationState.ownedTitles.includes(titleId)) {
    return { success: false, error: 'Already owned' };
  }
  
  monetizationState.ownedTitles.push(titleId);
  
  // Auto-activate if it's the first title
  if (!monetizationState.activeTitle) {
    monetizationState.activeTitle = titleId;
  }
  
  saveMonetizationState();
  return { success: true, title };
}

/**
 * Activate a title (can only have one active at a time)
 */
function activateTitle(titleId) {
  if (!monetizationState.ownedTitles.includes(titleId)) {
    return { success: false, error: 'Title not owned' };
  }
  
  monetizationState.activeTitle = titleId;
  saveMonetizationState();
  updateDJTitleDisplay();
  return { success: true };
}

/**
 * Update DJ title display
 */
function updateDJTitleDisplay() {
  const titleId = monetizationState.activeTitle;
  if (!titleId) return;
  
  const title = DJ_TITLES[titleId];
  if (!title) return;
  
  // Update DJ name display to include title
  const djTitleEl = document.getElementById('djTitle');
  if (djTitleEl) {
    djTitleEl.textContent = title.name;
  }
}

/**
 * Purchase a profile upgrade (stackable)
 */
function purchaseProfileUpgrade(upgradeId) {
  const upgrade = PROFILE_UPGRADES[upgradeId];
  if (!upgrade) return { success: false, error: 'Upgrade not found' };
  
  if (monetizationState.ownedProfileUpgrades.includes(upgradeId)) {
    return { success: false, error: 'Already owned' };
  }
  
  monetizationState.ownedProfileUpgrades.push(upgradeId);
  saveMonetizationState();
  applyProfileUpgrades();
  return { success: true, upgrade };
}

/**
 * Apply all owned profile upgrades to the UI
 */
function applyProfileUpgrades() {
  const profileHeader = document.querySelector('.profile-header');
  if (!profileHeader) return;
  
  // Remove existing upgrade badges
  const existingBadges = profileHeader.querySelectorAll('.upgrade-profile-badge');
  existingBadges.forEach(badge => badge.remove());
  
  // Add all owned upgrade badges
  monetizationState.ownedProfileUpgrades.forEach(upgradeId => {
    const upgrade = PROFILE_UPGRADES[upgradeId];
    if (!upgrade) return;
    
    const badge = document.createElement('span');
    badge.className = 'upgrade-profile-badge';
    badge.textContent = upgrade.icon;
    badge.title = upgrade.name;
    profileHeader.appendChild(badge);
  });
}

/**
 * Purchase party extension (applies to current party only)
 */
function purchasePartyExtension(extensionId) {
  const extension = PARTY_EXTENSIONS[extensionId];
  if (!extension) return { success: false, error: 'Extension not found' };
  
  if (extension.extensionMinutes) {
    monetizationState.partyTimeExtensionMins += extension.extensionMinutes;
    // Apply time extension to current party
    if (state.partyPassEndTime) {
      state.partyPassEndTime += extension.extensionMinutes * 60 * 1000;
    }
  }
  
  if (extension.extensionPhones) {
    monetizationState.partyPhoneExtensionCount += extension.extensionPhones;
  }
  
  return { success: true, extension };
}

/**
 * Purchase Hype Effect (consumable)
 */
function purchaseHypeEffect(hypeId) {
  const hypeEffect = HYPE_EFFECTS[hypeId];
  if (!hypeEffect) return { success: false, error: 'Hype effect not found' };
  
  // Initialize hypeEffects if not present
  if (!monetizationState.hypeEffects) {
    monetizationState.hypeEffects = {};
  }
  
  // Increment quantity for this hype effect
  if (!monetizationState.hypeEffects[hypeId]) {
    monetizationState.hypeEffects[hypeId] = 0;
  }
  monetizationState.hypeEffects[hypeId]++;
  
  saveMonetizationState();
  return { success: true, hypeEffect };
}

/**
 * Purchase Pro subscription
 */
function purchaseProSubscription() {
  monetizationState.proSubscriptionActive = true;
  // Set subscription end date to 30 days from now
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 30);
  monetizationState.proSubscriptionEndDate = endDate.toISOString();
  
  saveMonetizationState();
  updateUserTier();
  return { success: true };
}

/**
 * Purchase Party Pass (temporary, for current party)
 */
function purchasePartyPass() {
  monetizationState.partyPassActiveForCurrentParty = true;
  // Set Party Pass end time to 2 hours from now
  const endTime = Date.now() + (2 * 60 * 60 * 1000);
  monetizationState.partyPassEndTimeForCurrentParty = endTime;
  state.partyPassActive = true;
  state.partyPassEndTime = endTime;
  
  updateUserTier();
  return { success: true };
}

/**
 * Update user tier based on subscription/party pass status
 */
function updateUserTier() {
  if (monetizationState.proSubscriptionActive) {
    state.userTier = USER_TIER.PRO;
  } else if (monetizationState.partyPassActiveForCurrentParty) {
    state.userTier = USER_TIER.PARTY_PASS;
  } else {
    state.userTier = USER_TIER.FREE;
  }
  
  // Update UI
  updateTierDisplay();
}

/**
 * Update tier display in header
 */
function updateTierDisplay() {
  const planPill = document.getElementById('planPill');
  if (!planPill) return;
  
  const limits = {
    [USER_TIER.FREE]: `Free · ${FREE_LIMIT} phones`,
    [USER_TIER.PARTY_PASS]: `Party Pass · ${PARTY_PASS_LIMIT + monetizationState.partyPhoneExtensionCount} phones`,
    [USER_TIER.PRO]: `Pro · ${PRO_LIMIT} phones`
  };
  
  planPill.textContent = limits[state.userTier] || 'Free · 2 phones';
}

/**
 * Get current phone limit based on tier and extensions
 */
function getCurrentPhoneLimit() {
  let baseLimit;
  if (state.userTier === USER_TIER.PRO) {
    baseLimit = PRO_LIMIT;
  } else if (state.userTier === USER_TIER.PARTY_PASS) {
    baseLimit = PARTY_PASS_LIMIT;
  } else {
    baseLimit = FREE_LIMIT;
  }
  
  return baseLimit + monetizationState.partyPhoneExtensionCount;
}

/**
 * Reset party-specific monetization items
 */
function resetPartyMonetization() {
  monetizationState.partyPassActiveForCurrentParty = false;
  monetizationState.partyPassEndTimeForCurrentParty = null;
  monetizationState.partyTimeExtensionMins = 0;
  monetizationState.partyPhoneExtensionCount = 0;
  updateUserTier();
}

/**
 * Simple toast notification
 */
function showToast(message) {
  // Create toast element
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.9);
    color: white;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 14px;
    z-index: 10000;
    animation: slideDown 0.3s ease;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideUp 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ---- URL Query Parameter & Rejoin Memory Handling ----
// Support shareable join links with ?code=ABC123
// and restore last session from localStorage
function handleUrlParamsAndRejoin() {
  // Check for ?code= query parameter
  const urlParams = new URLSearchParams(window.location.search);
  const codeFromUrl = urlParams.get('code');
  
  // Try to restore last session from localStorage
  const lastCode = localStorage.getItem('lastPartyCode');
  const lastGuest = localStorage.getItem('lastGuestName');
  
  const joinCodeInput = document.getElementById('joinCode');
  const guestNameInput = document.getElementById('guestName');
  
  if (codeFromUrl) {
    // URL parameter takes priority
    // Validate code format (6 alphanumeric characters)
    const normalizedCode = codeFromUrl.trim().toUpperCase();
    if (normalizedCode.length === 6 && /^[A-Z0-9]{6}$/.test(normalizedCode)) {
      if (joinCodeInput) {
        joinCodeInput.value = normalizedCode;
        // Auto-focus the name input if code is provided
        if (guestNameInput) {
          guestNameInput.focus();
        }
      }
    } else {
      console.warn('[URL Param] Invalid party code format in URL:', codeFromUrl);
    }
  } else if (lastCode) {
    // Restore from localStorage if no URL param
    if (joinCodeInput && !joinCodeInput.value) {
      joinCodeInput.value = lastCode;
    }
    if (guestNameInput && lastGuest && !guestNameInput.value) {
      guestNameInput.value = lastGuest;
    }
  }
}

// Call initialization when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    initializeAllFeatures();
    handleUrlParamsAndRejoin();
  });
} else {
  initializeAllFeatures();
  handleUrlParamsAndRejoin();
}


// ---- Promo Code Logic (Server-Authoritative) ----
const promoBtn = document.getElementById("promoBtn");
const promoModal = document.getElementById("promoModal");
const promoApply = document.getElementById("promoApply");
const promoInput = document.getElementById("promoInput");
const promoClose = document.getElementById("promoClose");

if (promoBtn) {
  promoBtn.onclick = () => promoModal.classList.remove("hidden");
  promoClose.onclick = () => promoModal.classList.add("hidden");

  promoApply.onclick = async () => {
    const code = promoInput.value.trim().toUpperCase();
    if (!code) {
      toast("Please enter a promo code");
      return;
    }
    
    // Check if we have a party code
    if (!state.code) {
      toast("You must be in a party to use a promo code");
      return;
    }
    
    // Check if party already has promo applied (prevent multiple promo codes)
    if (state.partyPro || state.partyPassActive) {
      toast("⚠️ This party has already used a promo code");
      promoModal.classList.add("hidden");
      promoInput.value = "";
      return;
    }
    
    // Try WebSocket first (if connected), fallback to HTTP
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      // Send to server via WebSocket for validation
      send({ t: "APPLY_PROMO", code });
      promoModal.classList.add("hidden");
      promoInput.value = ""; // Clear input
    } else {
      // Use HTTP endpoint when WebSocket not available
      try {
        const response = await fetch(API_BASE + "/api/apply-promo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            partyCode: state.code,
            promoCode: code
          })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
          toast(data.error || "Failed to apply promo code");
        } else {
          // Success - update state and UI with clear messaging
          state.partyPro = true;
          state.partyPassActive = true;
          setPlanPill();
          updateTierDisplay();
          toast("🎉 This Phone Party is now Pro!");
          
          // Update party status banner
          const partyPassTitle = document.getElementById('partyPassTitle');
          if (partyPassTitle) {
            partyPassTitle.textContent = 'Party is now Pro';
          }
          
          // Hide upgrade prompts
          const partyPassUpgrade = document.getElementById('partyPassUpgrade');
          if (partyPassUpgrade) {
            partyPassUpgrade.classList.add('hidden');
          }
        }
      } catch (error) {
        console.error("[Promo] HTTP error:", error);
        toast("Failed to apply promo code");
      }
      
      promoModal.classList.add("hidden");
      promoInput.value = ""; // Clear input
    }
  };
}

// ============================================================================
// MONETIZATION UI INITIALIZATION
// ============================================================================

/**
 * Initialize monetization screens and event handlers
 */
function initMonetizationUI() {
  // Load saved monetization state
  loadMonetizationState();
  
  // Main Upgrade Hub button
  const btnUpgradeHub = document.getElementById('btnUpgradeHub');
  if (btnUpgradeHub) {
    btnUpgradeHub.addEventListener('click', showUpgradeHub);
  }
  
  // Add-ons buttons from various views
  document.getElementById('btnDjAddons')?.addEventListener('click', showUpgradeHub);
  document.getElementById('btnGuestAddons')?.addEventListener('click', showUpgradeHub);
  
  // Close buttons
  document.getElementById('btnCloseUpgradeHub')?.addEventListener('click', () => {
    showView('viewLanding');
  });
  
  document.getElementById('btnCloseVisualPacks')?.addEventListener('click', () => {
    showView('viewUpgradeHub');
  });
  
  document.getElementById('btnCloseProfileUpgrades')?.addEventListener('click', () => {
    showView('viewUpgradeHub');
  });
  
  document.getElementById('btnClosePartyExtensions')?.addEventListener('click', () => {
    showView('viewUpgradeHub');
  });
  
  document.getElementById('btnCloseDjTitles')?.addEventListener('click', () => {
    showView('viewUpgradeHub');
  });
  
  document.getElementById('btnCloseHypeEffects')?.addEventListener('click', () => {
    showView('viewUpgradeHub');
  });
  
  // Primary upgrade buttons
  document.getElementById('btnPurchaseProSub')?.addEventListener('click', () => {
    initiateCheckout('pro-subscription', 'Pro Subscription', 9.99); // GBP - Pro Monthly pricing
  });
  
  document.getElementById('btnPurchasePartyPass')?.addEventListener('click', () => {
    initiateCheckout('party-pass', 'Party Pass (2 hours)', 3.99); // GBP - Party Pass pricing
  });
  
  document.getElementById('btnContinueFree')?.addEventListener('click', () => {
    showToast('✅ Continuing with Free mode');
    showView('viewLanding');
  });
  
  // Add-ons store navigation buttons
  document.getElementById('btnOpenVisualPacks')?.addEventListener('click', () => {
    showVisualPackStore();
  });
  
  document.getElementById('btnOpenProfileUpgrades')?.addEventListener('click', () => {
    showProfileUpgradesStore();
  });
  
  document.getElementById('btnOpenDjTitles')?.addEventListener('click', () => {
    showDjTitleStore();
  });
  
  document.getElementById('btnOpenPartyExtensions')?.addEventListener('click', () => {
    showPartyExtensionsStore();
  });
  
  document.getElementById('btnOpenHypeEffects')?.addEventListener('click', () => {
    showHypeEffectsStore();
  });
  
  // Landing page, DJ and Guest addons buttons
  document.getElementById('btnDjAddons')?.addEventListener('click', () => {
    showView('viewUpgradeHub');
  });
  
  document.getElementById('btnGuestAddons')?.addEventListener('click', () => {
    showView('viewUpgradeHub');
  });
  
  // Visual Pack purchase buttons
  document.querySelectorAll('.btn-buy-pack').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const packId = e.target.dataset.packId;
      const pack = VISUAL_PACKS[packId];
      if (pack) {
        initiateCheckout('visual-pack', pack.name, pack.price, packId);
      }
    });
  });
  
  // Visual Pack activate buttons
  document.querySelectorAll('.btn-activate-pack').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const packId = e.target.dataset.packId;
      const result = activateVisualPack(packId);
      if (result.success) {
        showToast('✅ Visual pack activated!');
        updateVisualPackStore();
      }
    });
  });
  
  // Profile Upgrade purchase buttons
  document.querySelectorAll('.btn-buy-upgrade').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const upgradeId = e.target.dataset.upgradeId;
      const upgrade = PROFILE_UPGRADES[upgradeId];
      if (upgrade) {
        initiateCheckout('profile-upgrade', upgrade.name, upgrade.price, upgradeId);
      }
    });
  });
  
  // DJ Title purchase buttons
  document.querySelectorAll('.btn-buy-title').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const titleId = e.target.dataset.titleId;
      const title = DJ_TITLES[titleId];
      if (title) {
        initiateCheckout('dj-title', title.name, title.price, titleId);
      }
    });
  });
  
  // DJ Title activate buttons
  document.querySelectorAll('.btn-activate-title').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const titleId = e.target.dataset.titleId;
      const result = activateTitle(titleId);
      if (result.success) {
        showToast('✅ Title activated!');
        updateDjTitleStore();
      }
    });
  });
  
  // Party Extension purchase buttons
  document.querySelectorAll('.btn-buy-extension').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const extensionId = e.target.dataset.extensionId;
      const extension = PARTY_EXTENSIONS[extensionId];
      if (extension) {
        initiateCheckout('party-extension', extension.name, extension.price, extensionId);
      }
    });
  });
  
  // Hype Effects purchase buttons
  document.querySelectorAll('.btn-buy-hype').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const hypeId = e.target.dataset.hypeId;
      const hypeEffect = HYPE_EFFECTS[hypeId];
      if (hypeEffect) {
        initiateCheckout('hype-effect', hypeEffect.name, hypeEffect.price, hypeId);
      }
    });
  });
  
  // Checkout flow buttons
  document.getElementById('btnConfirmPurchase')?.addEventListener('click', () => {
    showCheckoutStep('checkoutPayment');
  });
  
  document.getElementById('btnCancelCheckout')?.addEventListener('click', () => {
    closeCheckout();
  });
  
  document.getElementById('btnBackToConfirm')?.addEventListener('click', () => {
    showCheckoutStep('checkoutConfirmation');
  });
  
  document.getElementById('btnProcessPayment')?.addEventListener('click', () => {
    processCheckoutPayment();
  });
  
  document.getElementById('btnCloseCheckoutSuccess')?.addEventListener('click', () => {
    closeCheckout();
  });
  
  // Upsell modal buttons
  document.getElementById('btnUpsellUpgrade')?.addEventListener('click', () => {
    closeUpsellModal();
    showUpgradeHub();
  });
  
  document.getElementById('btnUpsellClose')?.addEventListener('click', () => {
    closeUpsellModal();
  });
}

// Checkout state
let currentCheckout = null;

/**
 * Show Upgrade Hub
 */
function showUpgradeHub() {
  // Update current status card
  const isPro = monetizationState.proSubscriptionActive;
  document.getElementById('currentStatusFree').classList.toggle('hidden', isPro);
  document.getElementById('currentStatusPro').classList.toggle('hidden', !isPro);
  
  showView('viewUpgradeHub');
}

/**
 * Show Visual Pack Store
 */
function showVisualPackStore() {
  updateVisualPackStore();
  showView('viewVisualPackStore');
}

/**
 * Update Visual Pack Store UI
 */
function updateVisualPackStore() {
  document.querySelectorAll('.store-item[data-pack-id]').forEach(item => {
    const packId = item.dataset.packId;
    const owned = monetizationState.ownedVisualPacks.includes(packId);
    const active = monetizationState.activeVisualPack === packId;
    
    const buyBtn = item.querySelector('.btn-buy-pack');
    const activateBtn = item.querySelector('.btn-activate-pack');
    
    buyBtn.classList.toggle('hidden', owned);
    activateBtn.classList.toggle('hidden', !owned);
    
    if (active) {
      activateBtn.textContent = 'ACTIVE';
      activateBtn.disabled = true;
    } else {
      activateBtn.textContent = 'Set Active';
      activateBtn.disabled = false;
    }
  });
}

/**
 * Show Profile Upgrades Store
 */
function showProfileUpgradesStore() {
  updateProfileUpgradesStore();
  showView('viewProfileUpgrades');
}

/**
 * Update Profile Upgrades Store UI
 */
function updateProfileUpgradesStore() {
  document.querySelectorAll('.store-item[data-upgrade-id]').forEach(item => {
    const upgradeId = item.dataset.upgradeId;
    const owned = monetizationState.ownedProfileUpgrades.includes(upgradeId);
    
    const buyBtn = item.querySelector('.btn-buy-upgrade');
    const ownedBadge = item.querySelector('.owned-badge');
    
    buyBtn.classList.toggle('hidden', owned);
    ownedBadge.classList.toggle('hidden', !owned);
  });
}

/**
 * Show DJ Title Store
 */
function showDjTitleStore() {
  updateDjTitleStore();
  showView('viewDjTitleStore');
}

/**
 * Update DJ Title Store UI
 */
function updateDjTitleStore() {
  document.querySelectorAll('.store-item[data-title-id]').forEach(item => {
    const titleId = item.dataset.titleId;
    const owned = monetizationState.ownedTitles.includes(titleId);
    const active = monetizationState.activeTitle === titleId;
    
    const buyBtn = item.querySelector('.btn-buy-title');
    const activateBtn = item.querySelector('.btn-activate-title');
    
    buyBtn.classList.toggle('hidden', owned);
    activateBtn.classList.toggle('hidden', !owned);
    
    if (active) {
      activateBtn.textContent = 'ACTIVE';
      activateBtn.disabled = true;
    } else {
      activateBtn.textContent = 'Activate';
      activateBtn.disabled = false;
    }
  });
}

/**
 * Show Party Extensions Store
 */
function showPartyExtensionsStore() {
  showView('viewPartyExtensions');
}

/**
 * Show Hype Effects Store
 */
function showHypeEffectsStore() {
  showView('viewHypeEffects');
  updateHypeEffectsStore();
}

/**
 * Update Hype Effects Store display
 */
function updateHypeEffectsStore() {
  const items = document.querySelectorAll('#viewHypeEffects .store-item');
  items.forEach(item => {
    const hypeId = item.dataset.hypeId;
    const quantity = monetizationState.hypeEffects?.[hypeId] || 0;
    
    const quantityDiv = item.querySelector('.hype-quantity');
    const quantitySpan = quantityDiv?.querySelector('span');
    
    if (quantity > 0) {
      quantityDiv?.classList.remove('hidden');
      if (quantitySpan) {
        quantitySpan.textContent = quantity;
      }
    } else {
      quantityDiv?.classList.add('hidden');
    }
  });
}

/**
 * Initiate checkout flow
 */
function initiateCheckout(type, name, price, itemId = null) {
  currentCheckout = { type, name, price, itemId };
  
  // Update preview - sanitize name by using textContent
  const preview = document.getElementById('checkoutItemPreview');
  preview.innerHTML = '';
  
  const nameEl = document.createElement('h3');
  nameEl.textContent = name; // Safe: uses textContent instead of innerHTML
  preview.appendChild(nameEl);
  
  const priceEl = document.createElement('p');
  priceEl.className = 'checkout-price';
  priceEl.textContent = `£${price.toFixed(2)}`;
  preview.appendChild(priceEl);
  
  // Show checkout modal
  showCheckoutStep('checkoutConfirmation');
  document.getElementById('modalCheckout').classList.remove('hidden');
}

/**
 * Show checkout step
 */
function showCheckoutStep(stepId) {
  document.querySelectorAll('.checkout-step').forEach(step => {
    step.classList.add('hidden');
  });
  document.getElementById(stepId).classList.remove('hidden');
}

/**
 * Process checkout payment
 */
function processCheckoutPayment() {
  if (!currentCheckout) return;
  
  // Simulate payment processing
  setTimeout(() => {
    // Process the purchase based on type
    let result = { success: false };
    
    switch (currentCheckout.type) {
      case 'pro-subscription':
        result = purchaseProSubscription();
        break;
      case 'party-pass':
        result = purchasePartyPass();
        break;
      case 'visual-pack':
        result = purchaseVisualPack(currentCheckout.itemId);
        break;
      case 'dj-title':
        result = purchaseTitle(currentCheckout.itemId);
        break;
      case 'profile-upgrade':
        result = purchaseProfileUpgrade(currentCheckout.itemId);
        break;
      case 'party-extension':
        result = purchasePartyExtension(currentCheckout.itemId);
        break;
      case 'hype-effect':
        result = purchaseHypeEffect(currentCheckout.itemId);
        break;
    }
    
    if (result.success) {
      showCheckoutStep('checkoutSuccess');
      
      // Update relevant store UIs
      updateVisualPackStore();
      updateProfileUpgradesStore();
      updateDjTitleStore();
      updateHypeEffectsStore();
      
      // Apply changes immediately
      applyActiveVisualPack();
      applyProfileUpgrades();
      updateDJTitleDisplay();
      updateTierDisplay();
    } else {
      showToast('❌ Purchase failed: ' + (result.error || 'Unknown error'));
      closeCheckout();
    }
  }, 1000);
}

/**
 * Close checkout modal
 */
function closeCheckout() {
  document.getElementById('modalCheckout').classList.add('hidden');
  currentCheckout = null;
}

/**
 * Show upsell modal
 */
function showUpsellModal(title, message) {
  const titleEl = document.getElementById('upsellTitle');
  const messageEl = document.getElementById('upsellMessage');
  
  // Safe: using textContent
  titleEl.textContent = title;
  messageEl.textContent = message;
  
  document.getElementById('modalUpsell').classList.remove('hidden');
}

/**
 * Close upsell modal
 */
function closeUpsellModal() {
  document.getElementById('modalUpsell').classList.add('hidden');
}

/**
 * Add upsell to guest message attempt (when trying to send text in free mode)
 */
function checkGuestMessageUpsell() {
  if (state.userTier === USER_TIER.FREE) {
    showUpsellModal('Unlock Messages', 'Unlock messages with Pro!');
    return false; // Block the message
  }
  return true; // Allow the message
}

/**
 * Add upsell when phone limit reached
 */
function checkPhoneLimitUpsell(currentCount) {
  const limit = getCurrentPhoneLimit();
  if (currentCount >= limit) {
    showUpsellModal('Phone Limit Reached', `Upgrade to connect more phones! Current limit: ${limit}`);
    return false; // Block joining
  }
  return true; // Allow joining
}

/**
 * Show end-of-party upsell
 */
function showEndOfPartyUpsell() {
  showUpsellModal('Great Party!', 'Want more features next time? Check out our upgrade options!');
}

/**
 * Add upgrade button to profile page
 */
function addProfileUpgradeButton() {
  const data = getCachedUser();
  if (!data) return;
  
  if (!monetizationState.proSubscriptionActive) {
    // Add upgrade button to profile if not already present
    const profileContainer = document.querySelector('#viewProfile .profile-container');
    if (profileContainer && !document.getElementById('btnProfileUpgrade')) {
      const upgradeBtn = document.createElement('button');
      upgradeBtn.id = 'btnProfileUpgrade';
      upgradeBtn.className = 'btn primary full-width';
      upgradeBtn.textContent = '⭐ Upgrade to Pro';
      upgradeBtn.addEventListener('click', showUpgradeHub);
      
      const settingsCard = profileContainer.querySelector('.glass-card:last-child');
      if (settingsCard) {
        profileContainer.insertBefore(upgradeBtn, settingsCard);
      }
    }
  }
}

/**
 * Add upgrade button to host lobby
 */
function addHostLobbyUpgradeButton() {
  if (!monetizationState.proSubscriptionActive && !monetizationState.partyPassActiveForCurrentParty) {
    const hostView = document.getElementById('viewHome');
    if (hostView && !document.getElementById('btnHostUpgrade')) {
      const upgradeBtn = document.createElement('button');
      upgradeBtn.id = 'btnHostUpgrade';
      upgradeBtn.className = 'btn btn-party-pass';
      upgradeBtn.textContent = '🎉 Upgrade This Party';
      upgradeBtn.addEventListener('click', showUpgradeHub);
      
      // Insert after party code display
      const codeDisplay = hostView.querySelector('.party-code');
      if (codeDisplay && codeDisplay.parentElement) {
        codeDisplay.parentElement.insertBefore(upgradeBtn, codeDisplay.nextSibling);
      }
    }
  }
}

/**
 * Leaderboard and Profile functionality
 */

// Helper function to hide all views
function hideAllViews() {
  ALL_VIEWS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
}

// Show Leaderboard view
function showLeaderboard() {
  hideAllViews();
  
  const viewLeaderboard = document.getElementById('viewLeaderboard');
  if (viewLeaderboard) {
    viewLeaderboard.classList.remove('hidden');
  }
  
  // Load DJ leaderboard by default
  loadDjLeaderboard();
}

// Show My Profile view
function showMyProfile() {
  hideAllViews();
  
  const viewMyProfile = document.getElementById('viewMyProfile');
  if (viewMyProfile) {
    viewMyProfile.classList.remove('hidden');
  }
  
  // Load profile data
  loadMyProfile();
}

// Load DJ Leaderboard
async function loadDjLeaderboard() {
  const loadingDjs = document.getElementById('loadingDjs');
  const errorDjs = document.getElementById('errorDjs');
  const djsList = document.getElementById('djsList');
  
  // Show loading state
  if (loadingDjs) loadingDjs.classList.remove('hidden');
  if (errorDjs) errorDjs.classList.add('hidden');
  if (djsList) djsList.innerHTML = '';
  
  try {
    const response = await fetch(API_BASE + '/api/leaderboard/djs?limit=10');
    if (!response.ok) throw new Error('Failed to load DJ leaderboard');
    
    const data = await response.json();
    
    // Hide loading
    if (loadingDjs) loadingDjs.classList.add('hidden');
    
    // Render DJ list
    if (djsList && data.leaderboard && data.leaderboard.length > 0) {
      djsList.innerHTML = data.leaderboard.map((dj, index) => {
        const rank = index + 1;
        const rankClass = rank <= 3 ? `rank-${rank}` : '';
        const rankEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
        
        return `
          <div class="leaderboard-item">
            <div class="leaderboard-rank ${rankClass}">${rankEmoji} ${rank}</div>
            <div class="leaderboard-info">
              <div class="leaderboard-name">${escapeHtml(dj.dj_name || 'Anonymous DJ')}</div>
              <div class="leaderboard-subtitle">${dj.dj_rank || 'DJ'}</div>
            </div>
            <div class="leaderboard-score">${dj.dj_score || 0}</div>
          </div>
        `;
      }).join('');
    } else {
      djsList.innerHTML = '<p class="muted" style="text-align: center; padding: 40px;">No DJs yet</p>';
    }
  } catch (error) {
    console.error('[Leaderboard] Error loading DJ leaderboard:', error);
    if (loadingDjs) loadingDjs.classList.add('hidden');
    if (errorDjs) errorDjs.classList.remove('hidden');
  }
}

// Load Guest Leaderboard
async function loadGuestLeaderboard() {
  const loadingGuests = document.getElementById('loadingGuests');
  const errorGuests = document.getElementById('errorGuests');
  const guestsList = document.getElementById('guestsList');
  
  // Show loading state
  if (loadingGuests) loadingGuests.classList.remove('hidden');
  if (errorGuests) errorGuests.classList.add('hidden');
  if (guestsList) guestsList.innerHTML = '';
  
  try {
    const response = await fetch(API_BASE + '/api/leaderboard/guests?limit=10');
    if (!response.ok) throw new Error('Failed to load guest leaderboard');
    
    const data = await response.json();
    
    // Hide loading
    if (loadingGuests) loadingGuests.classList.add('hidden');
    
    // Render guest list
    if (guestsList && data.leaderboard && data.leaderboard.length > 0) {
      guestsList.innerHTML = data.leaderboard.map((guest, index) => {
        const rank = index + 1;
        const rankClass = rank <= 3 ? `rank-${rank}` : '';
        const rankEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
        
        return `
          <div class="leaderboard-item">
            <div class="leaderboard-rank ${rankClass}">${rankEmoji} ${rank}</div>
            <div class="leaderboard-info">
              <div class="leaderboard-name">${escapeHtml(guest.nickname || 'Guest')}</div>
              <div class="leaderboard-subtitle">${guest.parties_joined || 0} parties joined</div>
            </div>
            <div class="leaderboard-score">${guest.total_contribution_points || 0}</div>
          </div>
        `;
      }).join('');
    } else {
      guestsList.innerHTML = '<p class="muted" style="text-align: center; padding: 40px;">No guests yet</p>';
    }
  } catch (error) {
    console.error('[Leaderboard] Error loading guest leaderboard:', error);
    if (loadingGuests) loadingGuests.classList.add('hidden');
    if (errorGuests) errorGuests.classList.remove('hidden');
  }
}

// Load My Profile
async function loadMyProfile() {
  const loadingProfile = document.getElementById('loadingProfile');
  const errorProfile = document.getElementById('errorProfile');
  const profileContent = document.getElementById('profileContent');
  
  // Show loading state
  if (loadingProfile) loadingProfile.classList.remove('hidden');
  if (errorProfile) errorProfile.classList.add('hidden');
  if (profileContent) profileContent.classList.add('hidden');
  
  try {
    const response = await fetch(API_BASE + '/api/me', { credentials: 'include' });
    if (!response.ok) throw new Error('Failed to load profile');
    
    const data = await response.json();
    
    // Hide loading
    if (loadingProfile) loadingProfile.classList.add('hidden');
    if (profileContent) profileContent.classList.remove('hidden');
    
    // Update profile data
    const djName = document.getElementById('profileDjName');
    if (djName) djName.textContent = data.user.djName || 'Guest DJ';
    
    const tier = document.getElementById('profileTier');
    if (tier) tier.textContent = data.tier || 'FREE';
    
    const djScore = document.getElementById('profileDjScore');
    if (djScore) djScore.textContent = data.profile.djScore || 0;
    
    const djRank = document.getElementById('profileDjRank');
    if (djRank) djRank.textContent = data.profile.djRank || 'Bedroom DJ';
    
    // Update upgrades
    const upgradeVerifiedBadge = document.getElementById('upgradeVerifiedBadge');
    if (upgradeVerifiedBadge) upgradeVerifiedBadge.textContent = data.profile.verifiedBadge ? '✅' : '❌';
    
    const upgradeCrownEffect = document.getElementById('upgradeCrownEffect');
    if (upgradeCrownEffect) upgradeCrownEffect.textContent = data.profile.crownEffect ? '✅' : '❌';
    
    const upgradeAnimatedName = document.getElementById('upgradeAnimatedName');
    if (upgradeAnimatedName) upgradeAnimatedName.textContent = data.profile.animatedName ? '✅' : '❌';
    
    const upgradeReactionTrail = document.getElementById('upgradeReactionTrail');
    if (upgradeReactionTrail) upgradeReactionTrail.textContent = data.profile.reactionTrail ? '✅' : '❌';
    
    // Update active customizations
    const visualPack = document.getElementById('profileVisualPack');
    if (visualPack) visualPack.textContent = data.profile.activeVisualPack || 'None';
    
    const title = document.getElementById('profileTitle');
    if (title) title.textContent = data.profile.activeTitle || 'None';
    
    // Update entitlements
    const entitlementsList = document.getElementById('profileEntitlements');
    if (entitlementsList) {
      if (data.entitlements && data.entitlements.length > 0) {
        entitlementsList.innerHTML = data.entitlements.map(item => `
          <div class="entitlement-item">${escapeHtml(item.item_type)}: ${escapeHtml(item.item_key)}</div>
        `).join('');
      } else {
        entitlementsList.innerHTML = '<p class="muted">No items owned yet</p>';
      }
    }
  } catch (error) {
    console.error('[Profile] Error loading profile:', error);
    if (loadingProfile) loadingProfile.classList.add('hidden');
    if (errorProfile) errorProfile.classList.remove('hidden');
  }
}

// Initialize leaderboard and profile UI
function initLeaderboardProfileUI() {
  // Leaderboard button
  const btnLeaderboard = document.getElementById('btnLeaderboard');
  if (btnLeaderboard) {
    btnLeaderboard.addEventListener('click', showLeaderboard);
  }
  
  // Profile button
  const btnProfile = document.getElementById('btnProfile');
  if (btnProfile) {
    btnProfile.addEventListener('click', showMyProfile);
  }
  
  // Leaderboard tab buttons
  const btnTabDjs = document.getElementById('btnTabDjs');
  const btnTabGuests = document.getElementById('btnTabGuests');
  const leaderboardDjs = document.getElementById('leaderboardDjs');
  const leaderboardGuests = document.getElementById('leaderboardGuests');
  
  if (btnTabDjs) {
    btnTabDjs.addEventListener('click', () => {
      // Switch tabs
      btnTabDjs.classList.add('active');
      btnTabGuests.classList.remove('active');
      leaderboardDjs.classList.remove('hidden');
      leaderboardGuests.classList.add('hidden');
      
      // Load DJ leaderboard
      loadDjLeaderboard();
    });
  }
  
  if (btnTabGuests) {
    btnTabGuests.addEventListener('click', () => {
      // Switch tabs
      btnTabGuests.classList.add('active');
      btnTabDjs.classList.remove('active');
      leaderboardGuests.classList.remove('hidden');
      leaderboardDjs.classList.add('hidden');
      
      // Load guest leaderboard
      loadGuestLeaderboard();
    });
  }
  
  // Back buttons
  const btnBackFromLeaderboard = document.getElementById('btnBackFromLeaderboard');
  if (btnBackFromLeaderboard) {
    btnBackFromLeaderboard.addEventListener('click', () => {
      setView('landing');
    });
  }
  
  const btnBackFromProfile = document.getElementById('btnBackFromProfile');
  if (btnBackFromProfile) {
    btnBackFromProfile.addEventListener('click', () => {
      setView('authHome');
    });
  }
}

// HTML escape function
function escapeHtml(unsafe) {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// ADMIN DASHBOARD
// ============================================================
let _adminRefreshInterval = null;

async function loadAdminStats() {
  const errorEl = document.getElementById('adminError');
  try {
    const res = await fetch(API_BASE + '/api/admin/stats');
    if (res.status === 401 || res.status === 403) {
      // No longer admin — go back
      if (errorEl) { errorEl.textContent = 'Admin access denied.'; errorEl.classList.remove('hidden'); }
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (errorEl) errorEl.classList.add('hidden');

    // Health
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('adminHealthDb',      data.health?.db || '—');
    setText('adminHealthRedis',   data.health?.redis || '—');
    const uptime = data.health?.uptimeSec;
    setText('adminHealthUptime',  uptime != null ? Math.floor(uptime / 60) + 'm' : '—');
    setText('adminHealthVersion', data.health?.version || '—');

    // Users
    setText('adminUsersTotal',    data.users?.total ?? '—');
    setText('adminUsersProfiles', data.users?.profilesCompleted ?? '—');
    setText('adminUsersNew24h',   data.users?.newLast24h ?? '—');
    setText('adminUsersActive24h',data.users?.activeLast24h ?? '—');

    // Live
    setText('adminLiveOnline',  data.live?.onlineUsers ?? '—');
    setText('adminLiveParties', data.live?.activeParties ?? '—');
    setText('adminLiveHosts',   data.live?.activeHosts ?? '—');
    setText('adminLiveGuests',  data.live?.activeGuests ?? '—');

    // Tiers
    setText('adminTierFree',      data.tiers?.FREE ?? '—');
    setText('adminTierPartyPass', data.tiers?.PARTY_PASS ?? '—');
    setText('adminTierPro',       data.tiers?.PRO ?? '—');

    // Purchases
    const p = data.purchases || {};
    setText('adminPurchasesTiers',  p.tierPurchasesTotal ?? '—');
    setText('adminPurchasesAddons', p.addonPurchasesTotal ?? '—');
    const rev = p.revenueCentsLast30d != null ? '£' + (p.revenueCentsLast30d / 100).toFixed(2) : '—';
    setText('adminPurchasesRevenue', rev);
    const skuEl = document.getElementById('adminPurchasesBySku');
    if (skuEl && p.bySku) {
      const entries = Object.entries(p.bySku);
      skuEl.innerHTML = entries.length
        ? entries.map(([sku, cnt]) => `<span style="margin-right:12px">${escapeHtml(sku)}: <b>${cnt}</b></span>`).join('')
        : '<span style="opacity:0.6">No purchases yet</span>';
    }

    const lastEl = document.getElementById('adminLastRefreshed');
    if (lastEl) lastEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    if (errorEl) { errorEl.textContent = 'Failed to load admin data.'; errorEl.classList.remove('hidden'); }
  }
}

function initAdminDashboard() {
  // Load once immediately
  loadAdminStats();

  // Auto-refresh every 10 seconds
  if (_adminRefreshInterval) clearInterval(_adminRefreshInterval);
  _adminRefreshInterval = setInterval(loadAdminStats, 10000);

  const btnRefresh = document.getElementById('btnAdminRefresh');
  if (btnRefresh) {
    btnRefresh.onclick = loadAdminStats;
  }

  const btnBack = document.getElementById('btnBackFromAdmin');
  if (btnBack) {
    btnBack.onclick = () => {
      if (_adminRefreshInterval) { clearInterval(_adminRefreshInterval); _adminRefreshInterval = null; }
      setView('authHome');
    };
  }

  const btnLoadReports = document.getElementById('btnAdminLoadReports');
  if (btnLoadReports) {
    btnLoadReports.onclick = loadAdminModerationReports;
  }

  const btnLoadFlagged = document.getElementById('btnAdminLoadFlagged');
  if (btnLoadFlagged) {
    btnLoadFlagged.onclick = loadAdminFlaggedMessages;
  }
}

async function loadAdminModerationReports() {
  const el = document.getElementById('adminModerationReports');
  if (!el) return;
  el.textContent = 'Loading…';
  try {
    const res = await fetch(API_BASE + '/api/admin/moderation/reports');
    if (!res.ok) { el.textContent = 'Failed to load reports (' + res.status + ')'; return; }
    const data = await res.json();
    const reports = data.reports || [];
    if (!reports.length) { el.textContent = 'No reports found.'; return; }
    el.innerHTML = reports.map(r => {
      const rid = Number(r.id);
      const uid = r.reported_user_id != null ? String(r.reported_user_id) : '';
      return `
      <div style="border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:8px;margin-bottom:8px">
        <div><strong>${escapeHtml(r.type)}</strong> — <span style="opacity:0.7">${escapeHtml(r.reason || '')}</span>
          <span style="float:right;font-size:11px;opacity:0.5">${escapeHtml(r.status || 'pending')}</span></div>
        <div style="font-size:12px;opacity:0.7;margin:2px 0">Target: ${escapeHtml(String(r.target_id || '—'))}
          ${uid ? ' | User: ' + escapeHtml(uid) : ''}</div>
        ${r.description ? '<div style="font-size:12px;margin:2px 0">' + escapeHtml(r.description) + '</div>' : ''}
        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
          <button class="btn admin-mod-btn" style="padding:3px 10px;font-size:12px" data-report-id="${rid}" data-user-id="${escapeHtml(uid)}" data-action="ignore">Ignore</button>
          <button class="btn admin-mod-btn" style="padding:3px 10px;font-size:12px" data-report-id="${rid}" data-user-id="${escapeHtml(uid)}" data-action="warn">Warn User</button>
          <button class="btn admin-mod-btn" style="padding:3px 10px;font-size:12px" data-report-id="${rid}" data-user-id="${escapeHtml(uid)}" data-action="suspend">Suspend</button>
          <button class="btn admin-mod-btn" style="padding:3px 10px;font-size:12px;color:#f66" data-report-id="${rid}" data-user-id="${escapeHtml(uid)}" data-action="ban">Ban</button>
        </div>
      </div>`;
    }).join('');
    el.addEventListener('click', _adminModReportClickHandler);
  } catch (err) {
    el.textContent = 'Error loading reports.';
  }
}

function _adminModReportClickHandler(e) {
  const btn = e.target.closest('.admin-mod-btn[data-report-id]');
  if (!btn) return;
  const reportId = parseInt(btn.dataset.reportId, 10);
  const targetUserId = btn.dataset.userId || null;
  const action = btn.dataset.action;
  if (!action) return;
  adminModerationAction({ reportId, targetUserId: targetUserId || null }, action);
}

async function loadAdminFlaggedMessages() {
  const el = document.getElementById('adminFlaggedMessages');
  if (!el) return;
  el.textContent = 'Loading…';
  try {
    const res = await fetch(API_BASE + '/api/admin/moderation/flagged-messages');
    if (!res.ok) { el.textContent = 'Failed to load flagged messages (' + res.status + ')'; return; }
    const data = await res.json();
    const msgs = data.flaggedMessages || [];
    if (!msgs.length) { el.textContent = 'No flagged messages found.'; return; }
    el.innerHTML = '<strong>Flagged Messages</strong>' + msgs.map(m => {
      const mid = Number(m.id);
      const sid = m.sender_id != null ? String(m.sender_id) : '';
      return `
      <div style="border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:8px;margin-top:6px">
        <div style="font-size:12px;opacity:0.7">${escapeHtml(m.party_code || '')} — ${escapeHtml(sid)}</div>
        <div style="margin:2px 0">${escapeHtml(m.message_text || '')}</div>
        <div style="font-size:11px;opacity:0.5">${escapeHtml(m.reason || '')} | ${escapeHtml(m.status || 'pending')}</div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn admin-mod-flag-btn" style="padding:3px 10px;font-size:12px" data-flag-id="${mid}" data-sender-id="${escapeHtml(sid)}" data-action="dismiss">Dismiss</button>
          <button class="btn admin-mod-flag-btn" style="padding:3px 10px;font-size:12px" data-flag-id="${mid}" data-sender-id="${escapeHtml(sid)}" data-action="warn">Warn Sender</button>
        </div>
      </div>`;
    }).join('');
    el.addEventListener('click', _adminModFlagClickHandler);
  } catch (err) {
    el.textContent = 'Error loading flagged messages.';
  }
}

function _adminModFlagClickHandler(e) {
  const btn = e.target.closest('.admin-mod-flag-btn[data-flag-id]');
  if (!btn) return;
  const flaggedMessageId = parseInt(btn.dataset.flagId, 10);
  const targetUserId = btn.dataset.senderId || null;
  const action = btn.dataset.action;
  if (!action) return;
  adminModerationAction({ flaggedMessageId, targetUserId: targetUserId || null }, action);
}

async function adminModerationAction(ids, action) {
  try {
    const body = { action };
    if (ids.reportId != null) body.reportId = ids.reportId;
    if (ids.flaggedMessageId != null) body.flaggedMessageId = ids.flaggedMessageId;
    if (ids.targetUserId != null) body.targetUserId = ids.targetUserId;
    const res = await fetch(API_BASE + '/api/admin/moderation/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      // Reload whichever section was affected
      if (ids.reportId != null) loadAdminModerationReports();
      if (ids.flaggedMessageId != null) loadAdminFlaggedMessages();
    } else {
      console.warn('[Admin] Moderation action failed:', res.status);
    }
  } catch (err) {
    console.error('[Admin] Moderation action error:', err);
  }
}

function showAdminDashboard() {
  setView('adminDashboard');
}

/**
 * Wire up the admin nav button and show/hide based on isAdmin from /api/me.
 * Called during initAuthFlow so the button appears right after login.
 */
function initAdminNavUI() {
  const btnAdmin = document.getElementById('btnAdminDashboard');
  if (btnAdmin) {
    btnAdmin.addEventListener('click', showAdminDashboard);
  }
}

/**
 * Show or hide the admin nav button based on isAdmin flag from /api/me.
 * @param {boolean} isAdmin
 */
function setAdminNavVisible(isAdmin) {
  const btnAdmin = document.getElementById('btnAdminDashboard');
  if (btnAdmin) {
    btnAdmin.style.display = isAdmin ? '' : 'none';
  }
  // Show the admin dashboard button on the landing page for admins only
  const landingAuthButtons = document.getElementById('landingAuthButtons');
  if (landingAuthButtons) {
    landingAuthButtons.style.display = isAdmin ? '' : 'none';
  }
}

// Initialize monetization UI when DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initMonetizationUI();
    initLeaderboardProfileUI();
    initAdminNavUI();
    
    // Initialize production upgrade modules
    initProductionUpgradeModules();
    
    // Initialize Media Session API for background audio
    if (typeof initMediaSession === 'function') {
      initMediaSession();
    }
  });
} else {
  initMonetizationUI();
  initLeaderboardProfileUI();
  initAdminNavUI();
  
  // Initialize production upgrade modules
  initProductionUpgradeModules();
  
  // Initialize Media Session API for background audio
  if (typeof initMediaSession === 'function') {
    initMediaSession();
  }
}

/**
 * Initialize production upgrade UI modules
 */
function initProductionUpgradeModules() {
  console.log('[Init] Initializing production upgrade modules...');
  
  try {
    // Initialize sync status UI
    if (typeof SyncStatusUI !== 'undefined') {
      window.syncStatusUI = new SyncStatusUI();
      console.log('[Init] ✅ SyncStatusUI initialized');
    } else {
      console.warn('[Init] SyncStatusUI class not available');
    }

    // Initialize referral UI
    if (typeof ReferralUI !== 'undefined') {
      window.referralUI = new ReferralUI();
      window._referralUI = window.referralUI;
      console.log('[Init] ✅ ReferralUI initialized');
    } else {
      console.warn('[Init] ReferralUI class not available');
    }
  } catch (error) {
    console.error('[Init] Error initializing production upgrade modules:', error);
  }
}

/**
 * Update role UI elements based on host/listener status
 */
function updateRoleUI(isHost) {
  const roleBadge = document.getElementById('roleBadge');
  
  if (roleBadge) {
    if (isHost) {
      roleBadge.textContent = 'Host';
      roleBadge.classList.remove('listener', 'hidden');
    } else {
      roleBadge.textContent = 'Listener';
      roleBadge.classList.add('listener');
      roleBadge.classList.remove('hidden');
    }
  }
  
  // Show/hide referral button
  if (window.referralUI) {
    window.referralUI.setVisible(isHost);
  }
  
  console.log(`[UI] Role UI updated: ${isHost ? 'Host' : 'Listener'}`);
}

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================

/**
 * Keyboard shortcuts for DJ mode
 * Reference: IMPROVEMENT_SUGGESTIONS.md Section 5.3
 */
document.addEventListener('keydown', (e) => {
  // Don't trigger shortcuts when typing in input fields
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    return;
  }
  
  // Get active view
  const activeView = document.querySelector('section:not(.hidden)');
  const isPartyView = activeView && activeView.id === 'viewParty';
  const isDjMode = state.isHost;
  
  // Shortcuts only work in DJ/Party view
  if (!isPartyView || !isDjMode) {
    return;
  }
  
  // Handle shortcuts
  switch (e.key) {
    case ' ': // Space - Play/Pause
      e.preventDefault();
      const btnPlay = el('btnPlay');
      const btnPause = el('btnPause');
      if (btnPlay && !btnPlay.classList.contains('hidden')) {
        btnPlay.click();
      } else if (btnPause && !btnPause.classList.contains('hidden')) {
        btnPause.click();
      }
      break;
      
    case 'n':
    case 'N': // N - Next track
      e.preventDefault();
      const btnDjNext = el('btnDjNext');
      if (btnDjNext) {
        btnDjNext.click();
      }
      break;
      
    case 'q':
    case 'Q': // Q - Focus on queue/add track
      e.preventDefault();
      const btnDjQueueTrack = el('btnDjQueueTrack');
      if (btnDjQueueTrack) {
        btnDjQueueTrack.click();
      }
      break;
      
    case 'm':
    case 'M': // M - Mute/Unmute
      e.preventDefault();
      const audioEl = musicState.audioElement;
      if (audioEl) {
        audioEl.muted = !audioEl.muted;
        toast(audioEl.muted ? '🔇 Muted' : '🔊 Unmuted');
      }
      break;
      
    case 'Escape': // Esc - Exit to landing (end party)
      // Confirm before exiting
      if (confirm('End party and return to landing page?')) {
        const btnEndParty = el('btnEndParty');
        if (btnEndParty) {
          btnEndParty.click();
        }
      }
      break;
  }
});

// Handle tab visibility changes for sync recovery
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    console.log("[Visibility] Tab became visible - recovering sync");
    
    // Send TIME_PING to resync clock
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      sendTimePing();
    }
    
    // Refetch party state and resync if guest is in a party
    if (!state.isHost && state.code) {
      try {
        const response = await fetch(API_BASE + `/api/party-state?code=${state.code}`);
        const data = await response.json();
        
        if (data.exists && data.currentTrack) {
          const currentTrack = data.currentTrack;
          
          // If track is playing or preparing, sync to it
          if (currentTrack.status === 'playing' && currentTrack.startAtServerMs) {
            console.log("[Visibility] Resyncing to playing track:", currentTrack.title || currentTrack.filename);
            
            // Compute expected position
            const serverNow = nowServerMs();
            const elapsedSec = (serverNow - currentTrack.startAtServerMs) / 1000;
            const expectedSec = Math.max(0, (currentTrack.startPositionSec || 0) + elapsedSec);
            
            // If we have audio element, sync it
            if (state.guestAudioElement && state.guestAudioElement.src) {
              if (!state.guestAudioElement.paused) {
                // Already playing, just seek to correct position
                console.log(`[Visibility] Seeking to ${expectedSec.toFixed(2)}s`);
                clampAndSeekAudio(state.guestAudioElement, expectedSec);
              } else {
                // Not playing, start it
                clampAndSeekAudio(state.guestAudioElement, expectedSec);
                state.guestAudioElement.play().catch(err => {
                  console.warn("[Visibility] Autoplay blocked:", err);
                  state.pendingExpectedSec = expectedSec;
                  state.guestNeedsTap = true;
                  
                  // Show "Tap to Sync" overlay with sync info
                  handleAutoplayBlocked(state.guestAudioElement, currentTrack.title || currentTrack.filename, currentTrack.startAtServerMs, currentTrack.startPositionSec || 0);
                });
              }
              
              // Restart drift correction
              startDriftCorrection(currentTrack.startAtServerMs, currentTrack.startPositionSec || 0);
            }
          }
        }
      } catch (error) {
        console.error("[Visibility] Error fetching party state:", error);
      }
    }
  } else {
    console.log("[Visibility] Tab hidden");
  }
});

// ============================================================================
// PHASE 7: BLUETOOTH LATENCY CALIBRATION (Optional)
// ============================================================================

/**
 * Calibrate output latency (for Bluetooth devices)
 * Plays a click sound and measures user tap delay
 * Stores result in localStorage
 */
async function calibrateLatency() {
  return new Promise((resolve, reject) => {
    try {
      console.log('[Calibration] Starting latency calibration');
      
      // Create AudioContext for precise click sound
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      
      // Generate short click sound
      const clickBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.01, audioCtx.sampleRate);
      const channelData = clickBuffer.getChannelData(0);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = Math.random() * LATENCY_CLICK_AMPLITUDE - LATENCY_CLICK_OFFSET;
      }
      
      const clickSource = audioCtx.createBufferSource();
      clickSource.buffer = clickBuffer;
      clickSource.connect(audioCtx.destination);
      
      // Track click time
      const clickTime = Date.now();
      console.log('[Calibration] Playing click at:', clickTime);
      
      // Play click
      clickSource.start();
      
      // Show prompt to user (would be better in UI)
      toast('🎧 Tap the screen when you hear the click!');
      
      // Listen for tap
      const tapHandler = () => {
        const tapTime = Date.now();
        const latencyMs = tapTime - clickTime;
        
        console.log(`[Calibration] Tap detected at ${tapTime}, latency: ${latencyMs}ms`);
        
        // Clamp to reasonable range (0-500ms)
        const clampedLatency = Math.max(0, Math.min(500, latencyMs));
        
        // Store in localStorage
        localStorage.setItem('outputLatencyMs', clampedLatency.toString());
        
        toast(`✓ Latency calibrated: ${clampedLatency}ms`);
        
        // Remove listener
        document.removeEventListener('click', tapHandler);
        document.removeEventListener('touchstart', tapHandler);
        
        resolve(clampedLatency);
      };
      
      // Listen for click or touch
      document.addEventListener('click', tapHandler, { once: true });
      document.addEventListener('touchstart', tapHandler, { once: true });
      
      // Timeout after 5 seconds
      setTimeout(() => {
        document.removeEventListener('click', tapHandler);
        document.removeEventListener('touchstart', tapHandler);
        reject(new Error('Calibration timeout'));
      }, 5000);
      
    } catch (error) {
      console.error('[Calibration] Error:', error);
      reject(error);
    }
  });
}

/**
 * Get calibrated output latency from localStorage
 * @returns {number} Latency in milliseconds (0 if not calibrated)
 */
function getOutputLatency() {
  const stored = localStorage.getItem('outputLatencyMs');
  return stored ? parseInt(stored, 10) : 0;
}

/**
 * Apply latency compensation to PLAY_AT scheduling
 * Called in PLAY_AT handler to adjust start time for Bluetooth devices
 */
function applyLatencyCompensation(startAtServerMs) {
  const outputLatencyMs = getOutputLatency();
  
  if (outputLatencyMs > 0) {
    // Start earlier to compensate for output delay
    const compensatedMs = startAtServerMs - outputLatencyMs;
    const nowMs = Date.now();
    
    // Clamp to avoid negative (past) times
    const adjustedMs = Math.max(nowMs + 100, compensatedMs);
    
    console.log(`[Latency] Applied compensation: ${outputLatencyMs}ms, adjusted start: ${adjustedMs - startAtServerMs}ms offset`);
    
    return adjustedMs;
  }
  
  return startAtServerMs;
}

// Expose calibration function globally for console access or UI
window.calibrateLatency = calibrateLatency;
window.getOutputLatency = getOutputLatency;

console.log('[Calibration] Bluetooth latency calibration available. Call calibrateLatency() to calibrate.');

// ============================================================================
// Debug Panel - Hidden toggle for debugging sync issues
// ============================================================================
let debugPanelVisible = false;
let driftCorrectionsCount = 0;

// Toggle debug panel with Ctrl+Shift+D
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    debugPanelVisible = !debugPanelVisible;
    const panel = el('syncDebugPanel');
    if (panel) {
      panel.classList.toggle('hidden', !debugPanelVisible);
      if (debugPanelVisible) {
        updateDebugPanel();
      }
    }
  }
});

// Close button handler
const btnCloseDebug = el('btnCloseDebug');
if (btnCloseDebug) {
  btnCloseDebug.onclick = () => {
    debugPanelVisible = false;
    const panel = el('syncDebugPanel');
    if (panel) {
      panel.classList.add('hidden');
    }
  };
}

// Update debug panel with current sync info
function updateDebugPanel() {
  if (!debugPanelVisible) return;
  
  // Server offset
  const offsetEl = el('debugOffset');
  if (offsetEl) {
    offsetEl.textContent = `${serverOffsetMs.toFixed(1)}ms`;
  }
  
  // Last drift value
  const driftEl = el('debugDrift');
  if (driftEl) {
    driftEl.textContent = `${(lastDriftValue * 1000).toFixed(1)}ms`;
  }
  
  // Track ID
  const trackIdEl = el('debugTrackId');
  if (trackIdEl && state.currentTrack) {
    trackIdEl.textContent = state.currentTrack.trackId || '-';
  } else if (trackIdEl) {
    trackIdEl.textContent = '-';
  }
  
  // Drift corrections count
  const correctionsEl = el('debugCorrectionsCount');
  if (correctionsEl) {
    correctionsEl.textContent = driftCorrectionsCount.toString();
  }
}

// Update debug panel periodically when visible
setInterval(() => {
  if (debugPanelVisible) {
    updateDebugPanel();
  }
}, 1000);

// ============================================================
// Official App Sync Mode
// ============================================================

/**
 * Build a platform deep link and web fallback URL for a track reference.
 * Validates the platform strictly and never trusts raw URL input.
 *
 * NOTE: This logic is intentionally mirrored in official-app-link.js (Node.js
 * module) so that it can be unit-tested independently of the browser environment.
 * Keep both in sync when making changes.
 *
 * @param {string} platform - 'youtube' | 'spotify' | 'soundcloud' (case-insensitive)
 * @param {string} trackRef - Platform-specific track reference (URL, URI, or bare ID)
 * @returns {{ deepLink: string, webUrl: string }}
 * @throws {Error} If the platform is unsupported or trackRef is invalid
 */
function buildOfficialAppLink(platform, trackRef) {
  if (!platform || typeof platform !== 'string') {
    throw new Error('platform must be a non-empty string');
  }
  if (!trackRef || typeof trackRef !== 'string') {
    throw new Error('trackRef must be a non-empty string');
  }

  const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
  const SPOTIFY_URI_RE = /^spotify:track:([a-zA-Z0-9]+)$/;
  const SOUNDCLOUD_NUMERIC_RE = /^\d+$/;

  switch (platform.toLowerCase()) {
    case 'youtube': {
      let videoId = null;
      try {
        const url = new URL(trackRef);
        if (url.hostname === 'youtu.be') {
          const id = url.pathname.slice(1).split('?')[0].split('/')[0];
          if (YOUTUBE_ID_RE.test(id)) videoId = id;
        } else if (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com' ||
                   url.hostname === 'm.youtube.com' || url.hostname === 'youtube-nocookie.com' ||
                   url.hostname === 'www.youtube-nocookie.com') {
          const v = url.searchParams.get('v');
          if (v && YOUTUBE_ID_RE.test(v)) videoId = v;
          if (!videoId) {
            const m = url.pathname.match(/\/(?:shorts|embed|v)\/([a-zA-Z0-9_-]{11})/);
            if (m) videoId = m[1];
          }
        }
      } catch (_) { /* not a URL */ }
      if (!videoId && YOUTUBE_ID_RE.test(trackRef)) videoId = trackRef;
      if (!videoId) throw new Error(`Invalid YouTube trackRef: "${trackRef}"`);
      return {
        deepLink: `vnd.youtube://${videoId}`,
        webUrl: `https://www.youtube.com/watch?v=${videoId}`
      };
    }

    case 'spotify': {
      let uri = null;
      if (SPOTIFY_URI_RE.test(trackRef)) {
        uri = trackRef;
      } else {
        try {
          const url = new URL(trackRef);
          if (url.hostname === 'open.spotify.com' || url.hostname === 'spotify.com') {
            const m = url.pathname.match(/\/track\/([a-zA-Z0-9]+)/);
            if (m) uri = `spotify:track:${m[1]}`;
          }
        } catch (_) { /* not a URL */ }
        if (!uri) {
          const uriMatch = trackRef.match(/^spotify:track:([a-zA-Z0-9]+)$/);
          if (uriMatch) uri = `spotify:track:${uriMatch[1]}`;
        }
        if (!uri && /^[a-zA-Z0-9]{10,}$/.test(trackRef)) {
          uri = `spotify:track:${trackRef}`;
        }
      }
      if (!uri) throw new Error(`Invalid Spotify trackRef: "${trackRef}"`);
      const trackId = uri.split(':')[2];
      return {
        deepLink: uri,
        webUrl: `https://open.spotify.com/track/${trackId}`
      };
    }

    case 'soundcloud': {
      const ref = trackRef.trim();
      if (SOUNDCLOUD_NUMERIC_RE.test(ref)) {
        return {
          deepLink: `soundcloud://sounds:${ref}`,
          webUrl: `https://soundcloud.com/tracks/${ref}`
        };
      }
      const apiMatch = ref.match(/\/tracks\/(\d+)/);
      if (apiMatch) {
        return {
          deepLink: `soundcloud://sounds:${apiMatch[1]}`,
          webUrl: `https://soundcloud.com/tracks/${apiMatch[1]}`
        };
      }
      try {
        const url = new URL(ref);
        if (url.hostname === 'soundcloud.com' || url.hostname === 'www.soundcloud.com') {
          const canonicalUrl = `${url.origin}${url.pathname}`.replace(/\/$/, '');
          return {
            deepLink: `soundcloud://sounds:${encodeURIComponent(canonicalUrl)}`,
            webUrl: canonicalUrl
          };
        }
      } catch (_) { /* not a URL */ }
      throw new Error(`Invalid SoundCloud trackRef: "${trackRef}"`);
    }

    default:
      throw new Error(
        `Unsupported platform: "${platform}". Must be youtube, spotify, or soundcloud.`
      );
  }
}

// Allowed URI schemes for deep links (whitelist to prevent javascript: injection)
const ALLOWED_DEEP_LINK_SCHEMES = ['vnd.youtube:', 'spotify:', 'soundcloud:'];

/**
 * Safely navigate to a deep link, with a timed fallback to the web URL.
 * Used by both the manual button and mobile auto-launch.
 *
 * @param {string} deepLink - Platform deep link URI
 * @param {string} webUrl   - HTTPS web fallback URL
 */
function openInApp(deepLink, webUrl) {
  // Reject any deep link whose scheme is not on the allowlist
  const schemeOk = ALLOWED_DEEP_LINK_SCHEMES.some(function (s) {
    return deepLink.startsWith(s);
  });
  if (!schemeOk) {
    window.location = webUrl;
    return;
  }

  window.location = deepLink;

  const fallbackTimer = setTimeout(function () {
    if (document.visibilityState !== 'hidden') {
      window.location = webUrl;
    }
    document.removeEventListener('visibilitychange', onVisChange);
  }, 1000);

  function onVisChange() {
    if (document.visibilityState === 'hidden') {
      clearTimeout(fallbackTimer);
      document.removeEventListener('visibilitychange', onVisChange);
    }
  }
  document.addEventListener('visibilitychange', onVisChange);
}

// State for Official App Sync deep linking (guest side)
const officialAppSyncState = {
  deepLink: null,
  webUrl: null,
  platform: null,
  autoLaunchAttempted: false
};

/**
 * Attempt to auto-launch the deep link on mobile devices.
 * Delegates to openInApp() to prevent duplicate launch attempts.
 */
function attemptMobileAutoLaunch(deepLink, webUrl) {
  if (officialAppSyncState.autoLaunchAttempted) return;
  officialAppSyncState.autoLaunchAttempted = true;
  openInApp(deepLink, webUrl);
}

/**
 * Return true when the user agent looks like a mobile browser.
 */
function isMobileDevice() {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * Handle TRACK_SELECTED with mode=OFFICIAL_APP_SYNC from server.
 * Shows the "Now Syncing" info box and – for guests – opens the track
 * in the platform's official player/deep-link.
 */
function handleOfficialAppSyncTrackSelected(msg) {
  const { platform, trackRef, playing } = msg;

  // Update the host-side "Now Playing" box
  const nowPlayingBox = el('syncNowPlayingBox');
  const platformEl    = el('syncNowPlayingPlatform');
  const refEl         = el('syncNowPlayingRef');

  if (nowPlayingBox) nowPlayingBox.classList.remove('hidden');
  if (platformEl)    platformEl.textContent = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : '';
  if (refEl)         refEl.textContent = trackRef || '';

  // Update status label
  const statusEl = el('syncTrackStatus');
  if (statusEl) statusEl.textContent = playing ? '✅ Syncing…' : '⏸ Track queued';

  // Build deep link + web fallback for all users (host + guest)
  let links = null;
  try {
    links = buildOfficialAppLink(platform, trackRef);
  } catch (err) {
    toast(`🎵 Official App Sync: ${platform || 'unknown'} track — cannot open link`);
    return;
  }

  // Update host-side "Open in App" branded buttons
  if (state.isHost) {
    const openInAppContainer = el('openInAppButtons');
    if (openInAppContainer) {
      // Map platform names to their button element IDs
      const platformBtnIds = {
        youtube: 'btnOpenInYouTube',
        spotify: 'btnOpenInSpotify',
        soundcloud: 'btnOpenInSoundCloud'
      };
      const activePlatform = (platform || '').toLowerCase();
      Object.keys(platformBtnIds).forEach(function(p) {
        const btn = el(platformBtnIds[p]);
        if (btn) {
          if (p === activePlatform) {
            btn.style.display = 'flex';
            btn.onclick = function () { openInApp(links.deepLink, links.webUrl); };
          } else {
            btn.style.display = 'none';
          }
        }
      });
      openInAppContainer.classList.remove('hidden');
    }
    toast(`🎵 Official App Sync: ${platform} track synced`);
    return;
  }

  // Persist in module-level state (guests only)
  if (!state.isHost) {
    officialAppSyncState.deepLink = links.deepLink;
    officialAppSyncState.webUrl   = links.webUrl;
    officialAppSyncState.platform = platform;
    officialAppSyncState.autoLaunchAttempted = false;

    const platformLabel = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : 'App';

    // Render "Open in App" panel in guest view
    const guestSyncPanel = el('guestOfficialAppSyncPanel');
    const guestSyncLabel = el('guestOfficialAppSyncLabel');
    const openBtn        = el('btnGuestOpenInApp');

    if (guestSyncLabel) {
      guestSyncLabel.textContent = `Host selected a ${platformLabel} track`;
    }
    if (openBtn) {
      openBtn.textContent = `Open in ${platformLabel}`;
      openBtn.onclick = function () {
        openInApp(links.deepLink, links.webUrl);
      };
    }
    if (guestSyncPanel) guestSyncPanel.classList.remove('hidden');

    // Mobile: attempt auto-launch
    if (isMobileDevice()) {
      attemptMobileAutoLaunch(links.deepLink, links.webUrl);
    }

    // Fire streamingPartyTrackSelected event so Sync Coach activates for guests.
    // playbackStartMs is when playback began: serverTimestamp minus already-elapsed positionSeconds.
    var elapsedMs = (msg.positionSeconds || 0) * 1000;
    var playbackStartMs = msg.serverTimestampMs
      ? msg.serverTimestampMs - elapsedMs
      : Date.now() - elapsedMs;
    _streamingPartyState.playbackStartMs = playbackStartMs;
    document.dispatchEvent(new CustomEvent('streamingPartyTrackSelected', {
      detail: {
        platform: platform,
        trackRef: trackRef,
        playbackStartMs: playbackStartMs,
        playing: msg.playing !== false
      }
    }));
  }

  toast(`🎵 Official App Sync: ${platform} track synced`);
}

// Wire up the "Sync Track" button
(function initOfficialAppSync() {
  const btn = el('btnSyncTrack');
  if (!btn) return;

  // Auto-detect platform when user pastes a URL into the track ref input
  const trackRefInput = el('syncTrackRefInput');
  const platformSelect = el('syncPlatformSelect');
  if (trackRefInput && platformSelect) {
    // Known hostnames per platform (exact match to prevent host-spoofing false positives)
    const PLATFORM_HOSTS = {
      youtube:    ['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com'],
      spotify:    ['open.spotify.com', 'spotify.com'],
      soundcloud: ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'],
    };
    function _detectPlatform() {
      const raw = trackRefInput.value.trim();
      let hostname = '';
      try { hostname = new URL(raw).hostname.toLowerCase(); } catch (_) { /* not a full URL */ }
      const spotifyUri = raw.toLowerCase().startsWith('spotify:');
      if (PLATFORM_HOSTS.youtube.indexOf(hostname) !== -1) {
        platformSelect.value = 'youtube';
      } else if (PLATFORM_HOSTS.spotify.indexOf(hostname) !== -1 || spotifyUri) {
        platformSelect.value = 'spotify';
      } else if (PLATFORM_HOSTS.soundcloud.indexOf(hostname) !== -1) {
        platformSelect.value = 'soundcloud';
      }
    }
    // 'paste' fires after clipboard content is inserted; 'change' covers manual edits
    trackRefInput.addEventListener('paste', function () { setTimeout(_detectPlatform, 0); });
    trackRefInput.addEventListener('change', _detectPlatform);
  }

  btn.addEventListener('click', function () {
    const platform = (el('syncPlatformSelect')?.value || '').toLowerCase();
    const trackRef  = (el('syncTrackRefInput')?.value || '').trim();

    if (!platform || !trackRef) {
      toast('Please select a platform and enter a track URL or ID.');
      return;
    }

    const statusEl = el('syncTrackStatus');
    if (statusEl) statusEl.textContent = '⏳ Sending…';

    send({
      t: 'OFFICIAL_APP_SYNC_SELECT',
      platform,
      trackRef,
      positionSeconds: 0,
      playing: true
    });
  });

  // Wire up "Open in App" buttons using current track state
  const OPEN_BTN_IDS = {
    youtube: 'btnOpenYouTube',
    spotify: 'btnOpenSpotify',
    soundcloud: 'btnOpenSoundCloud'
  };
  Object.keys(OPEN_BTN_IDS).forEach(function (platform) {
    const openBtn = el(OPEN_BTN_IDS[platform]);
    if (!openBtn) return;
    openBtn.addEventListener('click', function () {
      const trackRef = (el('syncTrackRefInput')?.value || '').trim();
      if (!trackRef) {
        toast('Please enter a track URL or ID first.');
        return;
      }
      let links;
      try {
        links = buildOfficialAppLink(platform, trackRef);
      } catch (err) {
        toast('Invalid track reference for ' + platform + '.');
        return;
      }
      openInApp(links.deepLink, links.webUrl);
    });
  });
})();

// ============================================================================
// YOUTUBE PARTY PLAYER — Embedded IFrame player with sync engine integration
// ============================================================================

/**
 * State for the embedded YouTube Party Player.
 */
var _ytPlayer = {
  player: null,        // YT.Player instance (host)
  ready: false,        // IFrame API loaded
  videoId: null,       // Currently loaded videoId
  isPlaying: false,    // Local playing flag
  apiLoaded: false,    // Whether script tag was injected
  initPending: false,  // Whether init is queued
};

/**
 * State for the guest-side YouTube Player (separate instance from host player).
 */
var _ytGuestPlayer = {
  player: null,        // YT.Player instance (guest)
  videoId: null,       // Currently loaded videoId
  initPending: false,  // Whether init is queued
};

/**
 * Load the YouTube IFrame API once and call onYouTubeIframeAPIReady when ready.
 */
function loadYouTubeIframeAPI() {
  if (_ytPlayer.apiLoaded) return;
  _ytPlayer.apiLoaded = true;
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  const firstScriptTag = document.getElementsByTagName('script')[0];
  if (firstScriptTag && firstScriptTag.parentNode) {
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
  } else {
    document.head.appendChild(tag);
  }
}

/**
 * Called automatically by the YouTube IFrame API when it is ready.
 * Exposed on window so the YouTube SDK can call it.
 */
window.onYouTubeIframeAPIReady = function() {
  _ytPlayer.ready = true;
  console.log('[YouTubePlayer] IFrame API ready');
  if (_ytPlayer.initPending) {
    _ytPlayer.initPending = false;
    initYouTubePlayer();
  }
  if (_ytGuestPlayer.initPending) {
    _ytGuestPlayer.initPending = false;
    initYouTubeGuestPlayer();
  }
};

/**
 * Initialize the guest-side YT.Player instance (inside viewGuest).
 * Safe to call multiple times — only initialises once.
 */
function initYouTubeGuestPlayer() {
  if (_ytGuestPlayer.player) return; // Already initialised
  var container = document.getElementById('guestYoutubePlayer');
  if (!container) return;

  if (!_ytPlayer.ready) {
    _ytGuestPlayer.initPending = true;
    loadYouTubeIframeAPI();
    return;
  }

  if (typeof YT === 'undefined' || typeof YT.Player === 'undefined') {
    _ytGuestPlayer.initPending = true;
    return;
  }

  _ytGuestPlayer.player = new YT.Player('guestYoutubePlayer', {
    height: '100%',
    width: '100%',
    playerVars: {
      autoplay: 0,
      controls: 0,   // Host controls playback; guests just watch
      rel: 0,
      modestbranding: 1,
      playsinline: 1
    },
    events: {
      onReady: function() {
        console.log('[YouTubePlayer] Guest player ready');
        var ph = document.getElementById('guestYoutubePlayerPlaceholder');
        if (ph) ph.style.display = 'none';
        // If a video was pending, load it now
        if (_ytGuestPlayer.videoId) {
          _ytGuestPlayer.player.loadVideoById(_ytGuestPlayer.videoId);
          setTimeout(function() {
            if (_ytGuestPlayer.player && typeof _ytGuestPlayer.player.pauseVideo === 'function') {
              _ytGuestPlayer.player.pauseVideo();
            }
          }, 1000);
        }
      },
      onStateChange: function(event) {
        var statusEl = document.getElementById('guestYoutubePlayerStatus');
        if (statusEl) {
          if (event.data === YT.PlayerState.PLAYING) statusEl.textContent = 'Playing';
          else if (event.data === YT.PlayerState.PAUSED) statusEl.textContent = 'Paused';
          else if (event.data === YT.PlayerState.BUFFERING) statusEl.textContent = 'Buffering…';
          else if (event.data === YT.PlayerState.ENDED) statusEl.textContent = 'Ended';
        }
      },
      onError: function(event) {
        console.error('[YouTubePlayer] Guest player error:', event.data);
        var statusEl = document.getElementById('guestYoutubePlayerStatus');
        if (statusEl) statusEl.textContent = 'Playback error';
      }
    }
  });
}

/**
 * Initialize the YT.Player instance.
 * Safe to call multiple times — only initialises once.
 */
function initYouTubePlayer() {
  if (_ytPlayer.player) return; // Already initialised
  const container = document.getElementById('youtubePlayer');
  if (!container) return;

  if (!_ytPlayer.ready) {
    // API not ready yet — defer
    _ytPlayer.initPending = true;
    loadYouTubeIframeAPI();
    return;
  }

  if (typeof YT === 'undefined' || typeof YT.Player === 'undefined') {
    // YT global not available yet
    _ytPlayer.initPending = true;
    return;
  }

  _ytPlayer.player = new YT.Player('youtubePlayer', {
    height: '100%',
    width: '100%',
    playerVars: {
      autoplay: 0,
      controls: 0,        // Host controls via our UI
      rel: 0,
      modestbranding: 1,
      playsinline: 1
    },
    events: {
      onReady: function(event) {
        console.log('[YouTubePlayer] Player ready');
        var ph = document.getElementById('youtubePlayerPlaceholder');
        if (ph) ph.style.display = 'none';
      },
      onStateChange: function(event) {
        _ytPlayer.isPlaying = (event.data === YT.PlayerState.PLAYING);
        var statusEl = document.getElementById('youtubePlayerStatus');
        if (statusEl) {
          if (event.data === YT.PlayerState.PLAYING) statusEl.textContent = 'Playing';
          else if (event.data === YT.PlayerState.PAUSED) statusEl.textContent = 'Paused';
          else if (event.data === YT.PlayerState.BUFFERING) statusEl.textContent = 'Buffering…';
          else if (event.data === YT.PlayerState.ENDED) statusEl.textContent = 'Ended';
        }
      },
      onError: function(event) {
        console.error('[YouTubePlayer] Player error:', event.data);
        var statusEl = document.getElementById('youtubePlayerStatus');
        if (statusEl) statusEl.textContent = 'Playback error — check the video ID';
      }
    }
  });
}

/**
 * Extract an 11-character YouTube video ID from a URL or raw ID.
 * Returns null if the input is not a valid YouTube reference.
 * @param {string} ref
 * @returns {string|null}
 */
function extractYouTubeVideoId(ref) {
  if (!ref || typeof ref !== 'string') return null;
  var trimmed = ref.trim();
  try {
    var url = new URL(trimmed);
    if (url.hostname === 'youtu.be') {
      var id = url.pathname.slice(1).split('?')[0].split('/')[0];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }
    if (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com' ||
        url.hostname === 'm.youtube.com' || url.hostname === 'youtube-nocookie.com' ||
        url.hostname === 'www.youtube-nocookie.com') {
      var v = url.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      var m = url.pathname.match(/\/(?:shorts|embed|v)\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch (_) {
    // Not a URL — fall through
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Load a YouTube video into the embedded player and broadcast to guests.
 * @param {string} videoId  - 11-char YouTube video ID
 * @param {string} [title]  - Optional display title
 */
function ytLoadVideo(videoId, title) {
  _ytPlayer.videoId = videoId;

  console.log('[YouTubePlayer] Loading video:', videoId, title || '');

  // Show player UI elements
  var container = document.getElementById('youtubePlayerContainer');
  var controls = document.getElementById('youtubePlayerControls');
  var nowPlaying = document.getElementById('youtubeNowPlaying');
  var titleEl = document.getElementById('youtubeNowPlayingTitle');
  var statusEl = document.getElementById('youtubePlayerStatus');
  var ph = document.getElementById('youtubePlayerPlaceholder');

  if (container) container.style.display = '';
  if (controls) controls.classList.remove('hidden');
  if (nowPlaying && title) {
    nowPlaying.classList.remove('hidden');
    if (titleEl) titleEl.textContent = title;
  }
  if (statusEl) statusEl.textContent = 'Loading…';
  if (ph) ph.style.display = 'none';

  // Ensure player exists before loading
  if (_ytPlayer.player && typeof _ytPlayer.player.loadVideoById === 'function') {
    _ytPlayer.player.loadVideoById(videoId);
  } else {
    // Player not initialised yet — init it and load after ready
    if (!_ytPlayer.player) {
      initYouTubePlayer();
    }
    // Will auto-load once player is ready via the stored videoId
    // We store it and rely on initYouTubePlayer + onReady
  }

  // Broadcast video change to guests (host only)
  if (state.isHost) {
    send({
      t: 'HOST_YOUTUBE_VIDEO',
      videoId: videoId,
      title: title || null
    });
    console.log('[YouTubePlayer] Broadcast HOST_YOUTUBE_VIDEO:', videoId);
  }
}

/**
 * Host: play the YouTube video and broadcast play event to guests.
 */
function ytHostPlay() {
  if (!_ytPlayer.player || !_ytPlayer.videoId) return;
  var currentTime = 0;
  try {
    currentTime = _ytPlayer.player.getCurrentTime() || 0;
  } catch (_) { /* ignore */ }

  _ytPlayer.player.playVideo();

  // Broadcast to guests
  if (state.isHost) {
    send({
      t: 'HOST_YOUTUBE_PLAY',
      videoId: _ytPlayer.videoId,
      currentTime: currentTime
    });
    console.log('[YouTubePlayer] Broadcast HOST_YOUTUBE_PLAY at', currentTime);
  }
}

/**
 * Host: pause the YouTube video and broadcast pause event to guests.
 */
function ytHostPause() {
  if (!_ytPlayer.player || !_ytPlayer.videoId) return;
  var currentTime = 0;
  try {
    currentTime = _ytPlayer.player.getCurrentTime() || 0;
  } catch (_) { /* ignore */ }

  _ytPlayer.player.pauseVideo();

  // Broadcast to guests
  if (state.isHost) {
    send({
      t: 'HOST_YOUTUBE_PAUSE',
      videoId: _ytPlayer.videoId,
      currentTime: currentTime
    });
    console.log('[YouTubePlayer] Broadcast HOST_YOUTUBE_PAUSE at', currentTime);
  }
}

/**
 * Guest: receive a youtube video change and load it.
 * @param {string} videoId
 * @param {string|null} title
 */
function ytGuestLoadVideo(videoId, title) {
  _ytGuestPlayer.videoId = videoId;

  console.log('[YouTubePlayer] Guest loading video:', videoId, title || '');

  // Show the guest YouTube section
  var section = document.getElementById('guestYoutubeSection');
  if (section) section.classList.remove('hidden');

  var ph = document.getElementById('guestYoutubePlayerPlaceholder');
  var nowPlaying = document.getElementById('guestYoutubeNowPlaying');
  var titleEl = document.getElementById('guestYoutubeNowPlayingTitle');
  var statusEl = document.getElementById('guestYoutubePlayerStatus');

  if (ph) ph.style.display = 'none';
  if (nowPlaying && title) {
    nowPlaying.style.display = '';
    if (titleEl) titleEl.textContent = title;
  }
  if (statusEl) statusEl.textContent = 'Loading…';

  if (_ytGuestPlayer.player && typeof _ytGuestPlayer.player.loadVideoById === 'function') {
    _ytGuestPlayer.player.loadVideoById(videoId);
    // Pause after ~1s: loadVideoById triggers autoplay; hold on first frame
    // until HOST_YOUTUBE_PLAY is received.
    setTimeout(function() {
      if (_ytGuestPlayer.player && typeof _ytGuestPlayer.player.pauseVideo === 'function') {
        _ytGuestPlayer.player.pauseVideo();
      }
    }, 1000);
  } else {
    // Player not ready yet — init it (onReady will load videoId)
    initYouTubeGuestPlayer();
  }
}

/**
 * Guest: receive host play command and sync playback.
 * @param {number} hostTime - Host's current playback position in seconds
 */
function ytGuestPlay(hostTime) {
  if (!_ytGuestPlayer.player) return;
  var seekTarget = (typeof hostTime === 'number' && hostTime >= 0) ? hostTime : 0;
  // Add ~0.3s to compensate for typical WebSocket round-trip latency so the
  // guest video position roughly aligns with the host's current position when
  // the message was sent. Adjust if measured drift is consistently higher/lower.
  seekTarget += 0.3;
  try {
    _ytGuestPlayer.player.seekTo(seekTarget, true);
    _ytGuestPlayer.player.playVideo();
    var statusEl = document.getElementById('guestYoutubePlayerStatus');
    if (statusEl) statusEl.textContent = 'Playing';
    console.log('[YouTubePlayer] Guest synced play at', seekTarget);
  } catch (e) {
    console.error('[YouTubePlayer] Guest play error:', e);
  }
}

/**
 * Guest: receive host pause command and pause playback.
 */
function ytGuestPause() {
  if (!_ytGuestPlayer.player) return;
  try {
    _ytGuestPlayer.player.pauseVideo();
    var statusEl = document.getElementById('guestYoutubePlayerStatus');
    if (statusEl) statusEl.textContent = 'Paused';
    console.log('[YouTubePlayer] Guest paused');
  } catch (e) {
    console.error('[YouTubePlayer] Guest pause error:', e);
  }
}

/**
 * Show / hide the YouTube Party Player section based on user role.
 * Called from showParty(). All users (hosts and guests) can use the player.
 */
function updateYoutubePartySection() {
  var section = document.getElementById('youtubePartySection');
  if (!section) return;

  var playerBox = document.getElementById('youtubePartyPlayerBox');
  var upgradeBox = document.getElementById('youtubePartyUpgradeBox');

  // Always show the section — YouTube Party is a core feature
  section.classList.remove('hidden');

  // Show player box for all users; hide upgrade prompt
  if (playerBox) playerBox.classList.remove('hidden');
  if (upgradeBox) upgradeBox.classList.add('hidden');

  initYouTubePlayer();
  loadYouTubeIframeAPI();
}

/**
 * Initialise the YouTube search/URL input inside the party view.
 * Called once when the party view is first shown.
 */
function initYoutubePartyControls() {
  var searchBtn = document.getElementById('btnYoutubeSearch');
  var searchInput = document.getElementById('youtubeSearchInput');
  var playBtn = document.getElementById('btnYoutubePlay');
  var pauseBtn = document.getElementById('btnYoutubePause');
  var closeBtn = document.getElementById('btnCloseYoutubePlayer');
  var openYtBtn = document.getElementById('btnOpenYoutubeParty');

  if (searchBtn && searchBtn._ytInitDone) return; // Already wired

  // Wire "Play from YouTube" quick access button
  if (openYtBtn && !openYtBtn._ytInitDone) {
    openYtBtn._ytInitDone = true;
    openYtBtn.addEventListener('click', function() {
      var section = document.getElementById('youtubePartySection');
      if (section) {
        section.classList.remove('hidden');
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      var input = document.getElementById('youtubeSearchInput');
      if (input) {
        setTimeout(function() { input.focus(); }, 400);
      }
    });
  }

  if (searchBtn) {
    searchBtn._ytInitDone = true;
    searchBtn.addEventListener('click', function() {
      var query = searchInput ? searchInput.value.trim() : '';
      if (!query) return;

      // Try to extract a direct video ID from URL first
      var videoId = extractYouTubeVideoId(query);
      if (videoId) {
        ytLoadVideo(videoId, query.startsWith('http') ? null : query);
        var resultsEl = document.getElementById('youtubeSearchResults');
        if (resultsEl) resultsEl.classList.add('hidden');
        return;
      }

      // Otherwise search via API
      performYoutubeSearch(query);
    });
  }

  if (searchInput) {
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        if (searchBtn) searchBtn.click();
      }
    });
  }

  if (playBtn) {
    playBtn.addEventListener('click', function() {
      ytHostPlay();
    });
  }

  if (pauseBtn) {
    pauseBtn.addEventListener('click', function() {
      ytHostPause();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', function() {
      var section = document.getElementById('youtubePartySection');
      if (section) section.classList.add('hidden');
    });
  }
}

/**
 * Search YouTube for videos via /api/streaming/search and render results.
 * @param {string} query
 */
function performYoutubeSearch(query) {
  var statusEl = document.getElementById('youtubeSearchStatus');
  var resultsEl = document.getElementById('youtubeSearchResults');
  var listEl = document.getElementById('youtubeResultsList');

  console.log('[YouTubeSearch] Search triggered:', query);

  if (statusEl) {
    statusEl.textContent = 'Searching…';
    statusEl.classList.remove('hidden');
  }
  if (resultsEl) resultsEl.classList.add('hidden');

  fetch(API_BASE + '/api/streaming/search?provider=youtube&q=' + encodeURIComponent(query))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (statusEl) statusEl.classList.add('hidden');

      if (data.warning || !data.results || data.results.length === 0) {
        if (statusEl) {
          statusEl.textContent = data.warning
            ? 'YouTube search is unavailable right now. Paste a YouTube link or video ID.'
            : 'No results found.';
          statusEl.classList.remove('hidden');
        }
        console.log('[YouTubeSearch] No results or warning:', data.warning || 'no results');
        return;
      }

      console.log('[YouTubeSearch] Got', data.results.length, 'results');

      // Render results
      if (listEl) {
        listEl.innerHTML = '';
        data.results.forEach(function(item) {
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:0.5rem;padding:0.4rem;background:rgba(255,255,255,0.05);border-radius:6px;cursor:pointer;';
          row.setAttribute('data-testid', 'youtube-result-item');
          row.setAttribute('data-video-id', item.id);

          if (item.artwork) {
            var thumb = document.createElement('img');
            thumb.src = item.artwork;
            thumb.alt = '';
            thumb.style.cssText = 'width:48px;height:36px;object-fit:cover;border-radius:4px;flex-shrink:0;';
            row.appendChild(thumb);
          }

          var info = document.createElement('div');
          info.style.cssText = 'flex:1;min-width:0;';
          var titleDiv = document.createElement('div');
          titleDiv.style.cssText = 'font-size:0.8rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
          titleDiv.textContent = item.title || 'Unknown';
          var artistDiv = document.createElement('div');
          artistDiv.className = 'tiny muted';
          artistDiv.textContent = item.artist || '';
          info.appendChild(titleDiv);
          info.appendChild(artistDiv);
          row.appendChild(info);

          var playBtn = document.createElement('button');
          playBtn.className = 'btn primary';
          playBtn.style.cssText = 'font-size:0.75rem;padding:4px 10px;flex-shrink:0;';
          playBtn.textContent = '▶ Play';
          playBtn.setAttribute('data-testid', 'youtube-result-play');
          row.appendChild(playBtn);

          row.addEventListener('click', function() {
            console.log('[YouTubeSearch] Result selected:', item.id, item.title);
            ytLoadVideo(item.id, item.title);
            if (resultsEl) resultsEl.classList.add('hidden');
            var searchInput = document.getElementById('youtubeSearchInput');
            if (searchInput) searchInput.value = item.title || item.id;
          });

          listEl.appendChild(row);
        });
      }

      if (resultsEl) resultsEl.classList.remove('hidden');
    })
    .catch(function(err) {
      console.error('[YouTubeSearch] Error:', err);
      if (statusEl) {
        statusEl.textContent = 'Search failed. Paste a YouTube link or video ID instead.';
        statusEl.classList.remove('hidden');
      }
    });
}

/**
 * Show the YouTube Service selection screen (post-party-creation interstitial).
 * Called right after showParty() completes when a party is first created.
 * All users are eligible — YouTube Party is a core feature.
 */
function showYoutubeServiceView() {
  var eligibleBox = document.getElementById('ytServiceEligible');
  var upgradeBox = document.getElementById('ytServiceUpgrade');

  // Always show the eligible/player box — no tier gate
  if (eligibleBox) eligibleBox.classList.remove('hidden');
  if (upgradeBox) upgradeBox.classList.add('hidden');

  // Wire buttons once
  var useBtn = document.getElementById('btnUseYoutubePlayer');
  var skipBtn = document.getElementById('btnSkipYoutubeService');
  var skipUpgradeBtn = document.getElementById('btnSkipYoutubeServiceUpgrade');

  if (useBtn && !useBtn._ytServiceWired) {
    useBtn._ytServiceWired = true;
    useBtn.addEventListener('click', function() {
      setView('party');
      // Open the YouTube player section
      setTimeout(function() {
        var section = document.getElementById('youtubePartySection');
        if (section) section.classList.remove('hidden');
        var searchInput = document.getElementById('youtubeSearchInput');
        if (searchInput) {
          searchInput.focus();
          searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 300);
    });
  }

  if (skipBtn && !skipBtn._ytServiceWired) {
    skipBtn._ytServiceWired = true;
    skipBtn.addEventListener('click', function() {
      setView('party');
    });
  }

  if (skipUpgradeBtn && !skipUpgradeBtn._ytServiceWired) {
    skipUpgradeBtn._ytServiceWired = true;
    skipUpgradeBtn.addEventListener('click', function() {
      setView('party');
    });
  }
}

// ============================================================================
// END YOUTUBE PARTY PLAYER
// ============================================================================



/**
 * TrackDescriptor model — describes a track from any source.
 * @typedef {Object} TrackDescriptor
 * @property {'upload'|'youtube'|'spotify'|'soundcloud'} source
 * @property {string} id
 * @property {string|null} title
 * @property {string|null} artist
 * @property {string|null} artwork
 * @property {string|null} deepLink
 */

/**
 * Create a TrackDescriptor from provider and track reference.
 * @param {string} source - 'upload' | 'youtube' | 'spotify' | 'soundcloud'
 * @param {string} id - Track ID or URL
 * @param {Object} [meta] - Optional metadata { title, artist, artwork }
 * @returns {TrackDescriptor}
 */
function createTrackDescriptor(source, id, meta) {
  const validSources = ['upload', 'youtube', 'spotify', 'soundcloud'];
  const normalizedSource = (source || '').toLowerCase();
  if (!validSources.includes(normalizedSource)) {
    throw new Error('Invalid source: ' + source + '. Must be one of: ' + validSources.join(', '));
  }

  let deepLink = null;
  if (normalizedSource === 'youtube') {
    deepLink = 'https://www.youtube.com/watch?v=' + encodeURIComponent(id);
  } else if (normalizedSource === 'spotify') {
    deepLink = 'spotify:track:' + id;
  } else if (normalizedSource === 'soundcloud') {
    deepLink = id; // SoundCloud uses the full URL
  }

  return {
    source: normalizedSource,
    id: id,
    title: (meta && meta.title) || null,
    artist: (meta && meta.artist) || null,
    artwork: (meta && meta.artwork) || null,
    deepLink: deepLink
  };
}

// Streaming Party state
var _streamingPartyState = {
  activeProvider: null,
  trackDescriptor: null,
  syncCoachInterval: null,
  playbackStartMs: null
};

/**
 * Open the Sync Information Modal for the given provider.
 * Called when host clicks "Use Provider" on a provider card.
 * @param {string} provider - 'youtube' | 'spotify' | 'soundcloud'
 */
function openSyncModal(provider) {
  var modal = el('modalSyncInfo');
  if (!modal) return;

  _streamingPartyState.activeProvider = provider;

  // Update badge
  var badge = el('syncInfoProviderBadge');
  if (badge) {
    var labels = { youtube: '▶ YouTube', spotify: '💚 Spotify', soundcloud: '☁ SoundCloud' };
    badge.textContent = labels[provider] || provider;
  }

  // Show provider-specific section
  ['YouTube', 'Spotify', 'SoundCloud'].forEach(function(p) {
    var sec = el('syncInfo' + p);
    if (sec) {
      sec.classList[p.toLowerCase() === provider ? 'remove' : 'add']('hidden');
    }
  });

  // Wire up Continue button
  var continueBtn = el('btnSyncInfoContinue');
  if (continueBtn) {
    continueBtn.onclick = function() {
      closeSyncModal();
      showStreamingTrackInput(provider);
    };
  }

  modal.classList.remove('hidden');
}

/** Close the Sync Information Modal. */
function closeSyncModal() {
  var modal = el('modalSyncInfo');
  if (modal) modal.classList.add('hidden');
}

/**
 * Show the track input section pre-set to the chosen provider.
 * @param {string} provider
 */
function showStreamingTrackInput(provider) {
  var trackInput = el('streamingTrackInput');
  var platformSelect = el('syncPlatformSelect');
  var providerLabel = el('selectedProviderLabel');
  var providerCards = el('streamingProviderCards');

  if (providerCards) providerCards.classList.add('hidden');

  if (platformSelect) platformSelect.value = provider;
  if (providerLabel) {
    var names = { youtube: 'YouTube', spotify: 'Spotify', soundcloud: 'SoundCloud' };
    providerLabel.textContent = '🎵 ' + (names[provider] || provider);
  }
  if (trackInput) trackInput.classList.remove('hidden');

  // Update state for TrackDescriptor
  _streamingPartyState.activeProvider = provider;
}

/** Reset the streaming track input UI to show provider cards. */
function closeStreamingTrackInput() {
  var trackInput = el('streamingTrackInput');
  var providerCards = el('streamingProviderCards');
  if (trackInput) trackInput.classList.add('hidden');
  if (providerCards) providerCards.classList.remove('hidden');
}

// ============================================================================
// SYNC COACH — guides guests to sync playback in external apps
// ============================================================================

/**
 * Open the Sync Coach modal.
 * @param {string} platform - e.g. 'youtube', 'spotify', 'soundcloud'
 * @param {number} expectedPositionMs - Expected playback position in ms
 */
function openSyncCoach(platform, expectedPositionMs) {
  var modal = el('modalSyncCoach');
  if (!modal) return;

  var platformLabel = el('syncCoachPlatformLabel');
  if (platformLabel) {
    var names = { youtube: 'YouTube', spotify: 'Spotify', soundcloud: 'SoundCloud' };
    platformLabel.textContent = 'Syncing with ' + (names[platform] || platform);
  }

  // Set timestamp display
  updateSyncCoachTimestamp(expectedPositionMs);

  modal.classList.remove('hidden');

  // Start updating timestamp every second
  if (_streamingPartyState.syncCoachInterval) {
    clearInterval(_streamingPartyState.syncCoachInterval);
  }
  if (_streamingPartyState.playbackStartMs) {
    _streamingPartyState.syncCoachInterval = setInterval(function() {
      var elapsed = Date.now() - _streamingPartyState.playbackStartMs;
      updateSyncCoachTimestamp(elapsed);
    }, 1000);
  }
}

/** Update the Sync Coach timestamp display. */
function updateSyncCoachTimestamp(ms) {
  var el_ = el('syncCoachTimestamp');
  if (!el_) return;
  var totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
  var mins = Math.floor(totalSec / 60);
  var secs = totalSec % 60;
  el_.textContent = mins + ':' + (secs < 10 ? '0' : '') + secs;
}

/** Close the Sync Coach modal. */
function closeSyncCoach() {
  var modal = el('modalSyncCoach');
  if (modal) modal.classList.add('hidden');
  if (_streamingPartyState.syncCoachInterval) {
    clearInterval(_streamingPartyState.syncCoachInterval);
    _streamingPartyState.syncCoachInterval = null;
  }
}

/**
 * Handle a Sync Coach action button click.
 * @param {'sync'|'playing'|'notplaying'} action
 */
function handleSyncCoachAction(action) {
  var instructions = el('syncCoachInstructions');
  if (!instructions) return;

  if (action === 'sync') {
    var driftSec = 3;
    instructions.innerHTML =
      '<strong>To sync:</strong><br>' +
      '1. Pause playback.<br>' +
      '2. Skip forward ~' + driftSec + ' seconds.<br>' +
      '3. Resume — you should now be in sync.';
    instructions.classList.remove('hidden');
  } else if (action === 'playing') {
    instructions.innerHTML = '<strong>Great!</strong> Stay at the displayed timestamp.';
    instructions.classList.remove('hidden');
  } else if (action === 'notplaying') {
    instructions.innerHTML =
      '<strong>To start:</strong><br>' +
      '1. Open the track in your app.<br>' +
      '2. Skip to the displayed timestamp.<br>' +
      '3. Press play.';
    instructions.classList.remove('hidden');
  }
}

// ============================================================================
// STREAMING PARTY — party playback state integration
// ============================================================================

/**
 * PartyPlaybackState extended to include trackDescriptor for streaming providers.
 * This supplements the existing OFFICIAL_APP_SYNC message handler.
 */
function buildStreamingPartyPlaybackState(trackDescriptor, startedAtPartyMs, status) {
  return {
    trackDescriptor: trackDescriptor || null,
    startedAtPartyMs: startedAtPartyMs || null,
    status: status || 'idle'
  };
}

// Wire Sync Coach for guests when TRACK_SELECTED arrives with OFFICIAL_APP_SYNC mode
(function patchSyncCoachOnTrackSelected() {
  // Listen for streamingPartyTrackSelected — fired when host selects a streaming track.
  // Augments the existing OFFICIAL_APP_SYNC handler: guests get a Sync Coach prompt.
  document.addEventListener('streamingPartyTrackSelected', function(evt) {
    var detail = evt.detail || {};
    if (!state.isHost && detail.platform) {
      _streamingPartyState.playbackStartMs = detail.playbackStartMs || Date.now();
      setTimeout(function() {
        var elapsed = Date.now() - _streamingPartyState.playbackStartMs;
        openSyncCoach(detail.platform, elapsed);
      }, 800);
    }
  });
})();

// ============================================================================
// END STREAMING PARTY
// ============================================================================

// ============================================================================
// COPYRIGHT REPORTING
// ============================================================================

// Tracks the trackId currently targeted for a copyright report
let _copyrightReportTrackId = null;

/**
 * Opens the copyright report modal for the currently playing track (guest now-playing button).
 */
function openCopyrightReportModal() {
  // Use the stored guest track ID from the now-playing state
  const trackId = (el("btnGuestReportCopyright") && el("btnGuestReportCopyright").dataset.trackId) || state.guestTrackId || '';
  openCopyrightReportModalForTrack(trackId);
}

/**
 * Opens the copyright report modal targeting a specific track (queue item).
 * @param {string} trackId
 */
function openCopyrightReportModalForTrack(trackId) {
  _copyrightReportTrackId = trackId || null;

  // Reset form
  const reasonEl = el("copyrightReportReason");
  const descEl = el("copyrightReportDescription");
  if (reasonEl) reasonEl.value = '';
  if (descEl) descEl.value = '';

  const modal = el("modalCopyrightReport");
  if (modal) modal.classList.remove("hidden");
}

/**
 * Closes the copyright report modal without submitting.
 */
function closeCopyrightReportModal() {
  const modal = el("modalCopyrightReport");
  if (modal) modal.classList.add("hidden");
  _copyrightReportTrackId = null;
}

/**
 * Submits the copyright report to the server.
 */
async function submitCopyrightReport() {
  const reasonEl = el("copyrightReportReason");
  const descEl = el("copyrightReportDescription");
  const submitBtn = el("btnCopyrightReportSubmit");

  const reason = reasonEl ? reasonEl.value : '';
  if (!reason) {
    toast("Please select a reason for the report.");
    return;
  }

  const description = descEl ? descEl.value.trim() : '';
  const trackId = _copyrightReportTrackId || state.guestTrackId || null;
  const partyId = state.partyCode || null;

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
  }

  try {
    const response = await fetch(API_BASE + '/api/report-copyright', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trackId,
        partyId,
        reason,
        description,
        timestamp: new Date().toISOString()
      })
    });

    if (response.ok) {
      closeCopyrightReportModal();
      toast("Copyright report submitted. Thank you.");
    } else {
      const data = await response.json().catch(() => ({}));
      toast(data.error || "Failed to submit report. Please try again.");
    }
  } catch (err) {
    console.error("[CopyrightReport] Submit error:", err);
    toast("Network error. Please try again.");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Report";
    }
  }
}

// ============================================================================
// END COPYRIGHT REPORTING
// ============================================================================

// Test/module exports (for Jest) — allows require() in tests; not reached in browsers.
// In the browser this block is never reached (no `module` global).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VIEWS,
    HASH_TO_VIEW,
    ALL_VIEWS,
    PROFILE_SCHEMA_VERSION,
    getSavedProfile,
    saveProfile,
    clearProfile,
    hasValidProfile,
    setView,
    showView,
    showHome,
    showLanding,
    showParty,
    showGuest,
    initAuthFlow,
    confirmAuthSession,
    handleLogout,
    state,
    USER_TIER,
    createTrackDescriptor,
    buildStreamingPartyPlaybackState,
    openSyncModal,
    closeSyncModal,
    openSyncCoach,
    closeSyncCoach,
    handleSyncCoachAction,
    extractYouTubeVideoId,
    ytLoadVideo,
    ytHostPlay,
    ytHostPause,
    ytGuestLoadVideo,
    ytGuestPlay,
    ytGuestPause,
    updateYoutubePartySection,
    showYoutubeServiceView,
    openCopyrightReportModal,
    openCopyrightReportModalForTrack,
    closeCopyrightReportModal,
    submitCopyrightReport,
  };
}
