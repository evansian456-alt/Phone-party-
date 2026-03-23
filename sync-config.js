/**
 * SyncSpeaker Synchronization Configuration
 *
 * Single source of truth for all sync timing, threshold, and tuning constants.
 * Shared defaults are defined here; browser- and native-specific overrides are
 * exported as separate objects so platform adapters can spread/merge them.
 *
 * Design:
 *  - All shared constants are defined and exported individually (backward compat).
 *  - BROWSER_SYNC_CONFIG / NATIVE_SYNC_CONFIG hold platform override objects.
 *  - Call getSyncConfig(platform) to get the merged config for a given platform.
 *
 * @module sync-config
 */

// ============================================================
// Test / Debug Mode
// ============================================================

/** Enable deterministic sync-test mode (set SYNC_TEST_MODE=true in env) */
const SYNC_TEST_MODE = process.env.SYNC_TEST_MODE === 'true';
/** URL path for the built-in test audio file (served from /public) */
const TEST_AUDIO_PATH = '/test-audio.wav';
/** Feedback interval when in SYNC_TEST_MODE (faster for deterministic tests) */
const SYNC_TEST_FEEDBACK_INTERVAL_MS = 500;

// ============================================================
// Authoritative Timeline Event Types
// ============================================================

/**
 * Canonical set of scheduled-timeline event type strings.
 * Both server and clients MUST use these constants — no magic strings.
 */
const SyncEventType = Object.freeze({
  PREPARE_PLAY:     'PREPARE_PLAY',       // Host intent: get ready
  READY:            'READY',              // Client ack: buffered and ready
  BUFFER_STATUS:    'BUFFER_STATUS',      // Client: buffering progress update
  PLAY_AT:          'PLAY_AT',            // Scheduled play at serverMs anchor
  PAUSE_AT:         'PAUSE_AT',           // Scheduled pause
  SEEK_TO:          'SEEK_TO',            // Seek to position + new generation
  RESYNC_SNAPSHOT:  'RESYNC_SNAPSHOT',    // Full state for reconnect / late-join
  DRIFT_CORRECTION: 'DRIFT_CORRECTION',   // Server → client drift correction
  CLOCK_PING:       'CLOCK_PING',         // Client clock-sync request
  TIME_PONG:        'TIME_PONG',          // Server clock-sync response
  PLAYBACK_FEEDBACK:'PLAYBACK_FEEDBACK',  // Client position report
  MSG_ACK:          'MSG_ACK',            // Client message acknowledgment
});

// ============================================================
// Server-side FSM States (party / session level)
// ============================================================

/**
 * Valid states for the server-side party sync FSM.
 * The engine enforces legal transitions; illegal ones are logged and rejected.
 */
const PartySyncState = Object.freeze({
  IDLE:               'idle',
  PREPARING:          'preparing',
  WAITING_FOR_READY:  'waiting_for_ready',
  SCHEDULED:          'scheduled',
  PLAYING:            'playing',
  CORRECTING:         'correcting',
  DEGRADED:           'degraded',
  RESYNCING:          'resyncing',
});

// ============================================================
// Client-side FSM States
// ============================================================

/**
 * Valid states for the client (browser or native) sync FSM.
 */
const ClientSyncState = Object.freeze({
  DISCONNECTED:   'disconnected',
  SYNCING_CLOCK:  'syncing_clock',
  LOADING:        'loading',
  BUFFERING:      'buffering',
  READY:          'ready',
  SCHEDULED:      'scheduled',
  PLAYING:        'playing',
  CORRECTING:     'correcting',
  RECOVERING:     'recovering',
  RESYNCING:      'resyncing',
  ERRORED:        'errored',
});

// ============================================================
// Clock Synchronization — Shared Defaults
// ============================================================

const CLOCK_SYNC_INTERVAL_MS = 5000;        // Steady-state clock sync interval (5 s)
const CLOCK_SYNC_MIN_INTERVAL_MS = 3000;    // Minimum sync interval (3 s)
const CLOCK_SYNC_MAX_INTERVAL_MS = 7000;    // Maximum sync interval (7 s)

/** Number of ping-pong samples kept in rolling window */
const CLOCK_SYNC_SAMPLES = 15;
/** Fraction of highest-RTT samples to discard as outliers (0–1) */
const CLOCK_SYNC_OUTLIER_TRIM = 0.2;
/** EMA smoothing factor for clock offset (lower = smoother / slower) */
const CLOCK_SYNC_EMA_ALPHA = 0.15;

// Fast-burst clock sync on join / reconnect / late-join
/** Number of rapid pings sent at startup before settling into steady state */
const CLOCK_SYNC_BURST_COUNT = 8;
/** Interval between burst pings (ms) — fast to converge quickly */
const CLOCK_SYNC_BURST_INTERVAL_MS = 250;
/** Confidence threshold (0–1) required before exiting burst mode */
const CLOCK_SYNC_CONFIDENCE_THRESHOLD = 0.8;

// ============================================================
// Playback and Feedback Constants
// ============================================================

const PLAYBACK_FEEDBACK_INTERVAL_MS = 100;  // Client sends position every 100 ms
const DRIFT_CORRECTION_INTERVAL_MS = 200;   // Server checks drift every 200 ms
const ROLLING_BUFFER_MS = 150;              // Rolling buffer size (100–200 ms)
const DEFAULT_START_DELAY_MS = 3000;        // Default scheduled-play lead time (ms)
const LATE_PLAYBACK_THRESHOLD_MS = -1000;   // "Too late to schedule" boundary (ms)

// ============================================================
// Playback Rate Adjustment
// ============================================================

const PLAYBACK_RATE_MIN = 0.95;             // Hard floor on playback rate
const PLAYBACK_RATE_MAX = 1.05;             // Hard ceiling on playback rate

// ============================================================
// PLL-Style Drift Correction Ladder (primary correction policy)
// ============================================================

/** Drift below this is inside the dead-band — do nothing (ms) */
const DRIFT_IGNORE_MS = 40;
/** Drift below this is corrected via playbackRate nudging (ms) */
const DRIFT_SOFT_MS = 120;
/** Drift at or above this triggers a hard seek as last resort (ms) */
const DRIFT_HARD_RESYNC_MS = 200;
/** Time horizon over which drift is corrected via rate change (seconds) */
const PLL_HORIZON_SEC = 4;
/** Max rate delta on stable networks (fraction of 1.0) */
const MAX_RATE_DELTA_STABLE = 0.01;
/** Max rate delta on unstable networks (fraction of 1.0) */
const MAX_RATE_DELTA_UNSTABLE = 0.02;
/** EMA alpha for smoothing playback-rate commands (lower = smoother) */
const PLAYBACK_RATE_SMOOTH_ALPHA = 0.2;

// ============================================================
// Hard-Resync Cooldown
// ============================================================

/** Minimum time between consecutive hard-seek resyncs (ms) */
const HARD_RESYNC_COOLDOWN_MS = 15000;

// ============================================================
// Legacy / Compat Drift Constants
// (kept for backward compatibility; new code should use PLL constants above)
// ============================================================

const DRIFT_THRESHOLD_MS = 50;              // Server-side ignore threshold (legacy)
const DESYNC_THRESHOLD_MS = 50;             // Legacy desync detection threshold
const PREDICTION_FACTOR = 0.8;              // Legacy predictive drift weight

// Desktop and mobile fallback thresholds (used only if PLL path is unavailable)
const DESKTOP_IGNORE_DRIFT_MS = 200;
const DESKTOP_SOFT_CORRECTION_MS = 800;
const MOBILE_IGNORE_DRIFT_MS = 300;
const MOBILE_SOFT_CORRECTION_MS = 1000;

// ============================================================
// Network Stability
// ============================================================

const NETWORK_STABILITY_SAMPLES = 10;
const NETWORK_STABILITY_NORMALIZATION_FACTOR = 100;

// ============================================================
// WebSocket Reconnection
// ============================================================

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

// ============================================================
// Per-Device Output Latency Compensation
//
// Enabled in production (not gated behind SYNC_TEST_MODE).
// The cap (AUDIO_LATENCY_COMP_MAX_MS) ensures corrections are safe and subtle.
// The slow EMA alpha prevents thrashing.
// ============================================================

/** Enable learned audio-output latency compensation */
const AUDIO_LATENCY_COMP_ENABLED = true;
/** Maximum magnitude of learned compensation (ms) — capped for safety */
const AUDIO_LATENCY_COMP_MAX_MS = 80;
/** EMA alpha for slowly learning the compensation bias */
const AUDIO_LATENCY_COMP_ALPHA = 0.02;

// ============================================================
// Browser-Specific Overrides
// ============================================================

/**
 * Merged config overrides for the browser (Web) platform.
 * Spread over the shared defaults when running in a browser context.
 * Browser advantages: Web Audio API for gain ramps, visibility API.
 * Browser limitations: tab throttling, autoplay restrictions.
 */
const BROWSER_SYNC_CONFIG = Object.freeze({
  // Faster feedback on browser — audio.currentTime is synchronous
  PLAYBACK_FEEDBACK_INTERVAL_MS: 80,
  // Slightly tighter ignore band for browser (WiFi-first assumption)
  DRIFT_IGNORE_MS: 35,
  // Browser correction horizon — slightly shorter for quicker convergence
  PLL_HORIZON_SEC: 3,
  // Browser reconnect: faster initial attempt
  RECONNECT_DELAY_MS: 800,
  // Burst sync on join (browser tabs can lag behind on cold start)
  CLOCK_SYNC_BURST_COUNT: 10,
  CLOCK_SYNC_BURST_INTERVAL_MS: 200,
});

// ============================================================
// Native-Specific Overrides
// ============================================================

/**
 * Merged config overrides for the native (iOS/Android) platform.
 * Native apps have stronger background scheduling, more reliable audio sessions,
 * and more accurate timing hooks.
 */
const NATIVE_SYNC_CONFIG = Object.freeze({
  // Native has more reliable audio scheduling — tighter ignore band
  DRIFT_IGNORE_MS: 25,
  // Longer PLL horizon: native can make very gentle corrections
  PLL_HORIZON_SEC: 5,
  // Native reconnect: slightly more patient (background recovery is stronger)
  RECONNECT_DELAY_MS: 1200,
  MAX_RECONNECT_DELAY_MS: 45000,
  // Native can afford more latency compensation learning
  AUDIO_LATENCY_COMP_ALPHA: 0.015,
  AUDIO_LATENCY_COMP_MAX_MS: 120,
  // Burst sync — native clock is more stable, fewer bursts needed
  CLOCK_SYNC_BURST_COUNT: 6,
  CLOCK_SYNC_BURST_INTERVAL_MS: 300,
});

// ============================================================
// Config Merger
// ============================================================

/**
 * Return a merged sync config for the given platform.
 * @param {'browser'|'native'|'server'} platform
 * @returns {object} Flat config object with all constants
 */
function getSyncConfig(platform = 'server') {
  const base = {
    SYNC_TEST_MODE, TEST_AUDIO_PATH, SYNC_TEST_FEEDBACK_INTERVAL_MS,
    CLOCK_SYNC_INTERVAL_MS, CLOCK_SYNC_MIN_INTERVAL_MS, CLOCK_SYNC_MAX_INTERVAL_MS,
    CLOCK_SYNC_SAMPLES, CLOCK_SYNC_OUTLIER_TRIM, CLOCK_SYNC_EMA_ALPHA,
    CLOCK_SYNC_BURST_COUNT, CLOCK_SYNC_BURST_INTERVAL_MS, CLOCK_SYNC_CONFIDENCE_THRESHOLD,
    PLAYBACK_FEEDBACK_INTERVAL_MS, DRIFT_CORRECTION_INTERVAL_MS,
    ROLLING_BUFFER_MS, DEFAULT_START_DELAY_MS, LATE_PLAYBACK_THRESHOLD_MS,
    PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX,
    DRIFT_IGNORE_MS, DRIFT_SOFT_MS, DRIFT_HARD_RESYNC_MS,
    PLL_HORIZON_SEC, MAX_RATE_DELTA_STABLE, MAX_RATE_DELTA_UNSTABLE,
    PLAYBACK_RATE_SMOOTH_ALPHA, HARD_RESYNC_COOLDOWN_MS,
    DRIFT_THRESHOLD_MS, DESYNC_THRESHOLD_MS, PREDICTION_FACTOR,
    DESKTOP_IGNORE_DRIFT_MS, DESKTOP_SOFT_CORRECTION_MS,
    MOBILE_IGNORE_DRIFT_MS, MOBILE_SOFT_CORRECTION_MS,
    NETWORK_STABILITY_SAMPLES, NETWORK_STABILITY_NORMALIZATION_FACTOR,
    MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS,
    AUDIO_LATENCY_COMP_ENABLED, AUDIO_LATENCY_COMP_MAX_MS, AUDIO_LATENCY_COMP_ALPHA,
  };
  if (platform === 'browser') return { ...base, ...BROWSER_SYNC_CONFIG };
  if (platform === 'native')  return { ...base, ...NATIVE_SYNC_CONFIG };
  return base;
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  // Test mode
  SYNC_TEST_MODE,
  TEST_AUDIO_PATH,
  SYNC_TEST_FEEDBACK_INTERVAL_MS,

  // Event type constants
  SyncEventType,

  // FSM state constants
  PartySyncState,
  ClientSyncState,

  // Clock sync
  CLOCK_SYNC_INTERVAL_MS,
  CLOCK_SYNC_MIN_INTERVAL_MS,
  CLOCK_SYNC_MAX_INTERVAL_MS,
  CLOCK_SYNC_SAMPLES,
  CLOCK_SYNC_OUTLIER_TRIM,
  CLOCK_SYNC_EMA_ALPHA,
  CLOCK_SYNC_BURST_COUNT,
  CLOCK_SYNC_BURST_INTERVAL_MS,
  CLOCK_SYNC_CONFIDENCE_THRESHOLD,

  // Playback and feedback
  PLAYBACK_FEEDBACK_INTERVAL_MS,
  DRIFT_CORRECTION_INTERVAL_MS,
  ROLLING_BUFFER_MS,
  DEFAULT_START_DELAY_MS,
  LATE_PLAYBACK_THRESHOLD_MS,

  // Playback rate
  PLAYBACK_RATE_MIN,
  PLAYBACK_RATE_MAX,

  // PLL drift correction (primary policy)
  DRIFT_IGNORE_MS,
  DRIFT_SOFT_MS,
  DRIFT_HARD_RESYNC_MS,
  PLL_HORIZON_SEC,
  MAX_RATE_DELTA_STABLE,
  MAX_RATE_DELTA_UNSTABLE,
  PLAYBACK_RATE_SMOOTH_ALPHA,

  // Hard resync cooldown
  HARD_RESYNC_COOLDOWN_MS,

  // Legacy drift detection (backward compat — prefer PLL constants above)
  DRIFT_THRESHOLD_MS,
  DESYNC_THRESHOLD_MS,
  PREDICTION_FACTOR,
  DESKTOP_IGNORE_DRIFT_MS,
  DESKTOP_SOFT_CORRECTION_MS,
  MOBILE_IGNORE_DRIFT_MS,
  MOBILE_SOFT_CORRECTION_MS,

  // Network stability
  NETWORK_STABILITY_SAMPLES,
  NETWORK_STABILITY_NORMALIZATION_FACTOR,

  // WebSocket reconnection
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS,

  // Audio latency compensation (production-enabled)
  AUDIO_LATENCY_COMP_ENABLED,
  AUDIO_LATENCY_COMP_MAX_MS,
  AUDIO_LATENCY_COMP_ALPHA,

  // Platform config bundles
  BROWSER_SYNC_CONFIG,
  NATIVE_SYNC_CONFIG,
  getSyncConfig,
};
