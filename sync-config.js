/**
 * SyncSpeaker Synchronization Configuration
 *
 * Single source of truth for all sync timing, threshold, and performance
 * constants. Platform-specific overrides (browser / native) are layered on
 * top of the shared defaults via the exported platform config helpers.
 *
 * Sections:
 *   1. Authoritative timeline event types
 *   2. Finite state machine state names (server + client)
 *   3. Clock synchronization constants
 *   4. Drift correction ladder
 *   5. Playback scheduling
 *   6. Network stability
 *   7. WebSocket reconnection
 *   8. Per-device latency learning
 *   9. Telemetry / observability
 *  10. Platform overrides (browser / native)
 *  11. Legacy constants (kept for backward compat)
 *
 * @module sync-config
 */

// ============================================================
// 0. Test / Debug Mode
// ============================================================

/** Enable deterministic sync-test mode (set SYNC_TEST_MODE=true in env) */
const SYNC_TEST_MODE = process.env.SYNC_TEST_MODE === 'true';
/** URL path for the built-in test audio file (served from /public) */
const TEST_AUDIO_PATH = '/test-audio.wav';
/** Polling interval used in SYNC_TEST_MODE (ms) */
const SYNC_TEST_FEEDBACK_INTERVAL_MS = 500;

// ============================================================
// 1. Authoritative Timeline Event Types
// ============================================================

/**
 * All critical sync events.  Every critical event MUST carry:
 *   eventId, partyId, generation, seq, serverTs, trackId,
 *   anchorPositionSec, [startAtServerMs]
 */
const SyncEventType = Object.freeze({
  // Server → clients
  PREPARE_PLAY:     'PREPARE_PLAY',     // Pre-buffer a track before scheduled start
  PLAY_AT:          'PLAY_AT',          // Scheduled play with future startAtServerMs
  PAUSE_AT:         'PAUSE_AT',         // Scheduled pause
  SEEK_TO:          'SEEK_TO',          // Seek with new anchor position + generation bump
  RESYNC_SNAPSHOT:  'RESYNC_SNAPSHOT',  // Full state snapshot for reconnect / late join
  DRIFT_CORRECTION: 'DRIFT_CORRECTION', // Per-client rate or seek correction
  TIME_PONG:        'TIME_PONG',        // Clock sync reply

  // Client → server
  TIME_PING:        'TIME_PING',        // Clock sync request
  PLAYBACK_FEEDBACK:'PLAYBACK_FEEDBACK',// Periodic position report
  READY:            'READY',            // Client buffered and ready to play
  BUFFER_STATUS:    'BUFFER_STATUS',    // Buffering progress update
  MSG_ACK:          'MSG_ACK',          // Acknowledge a critical event
});

// ============================================================
// 2. Finite State Machine State Names
// ============================================================

/** Server / party sync states. */
const ServerSyncState = Object.freeze({
  IDLE:                'idle',
  PREPARING:           'preparing',
  WAITING_FOR_READINESS:'waiting_for_readiness',
  SCHEDULED:           'scheduled',
  PLAYING:             'playing',
  CORRECTING:          'correcting',
  DEGRADED:            'degraded',
  RESYNCING:           'resyncing',
});

/** Client sync states (browser and native). */
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
// 3. Clock Synchronization Constants
// ============================================================

const CLOCK_SYNC_INTERVAL_MS = 5000;        // Base interval for clock sync (5s)
const CLOCK_SYNC_MIN_INTERVAL_MS = 3000;    // Minimum sync interval (3s)
const CLOCK_SYNC_MAX_INTERVAL_MS = 7000;    // Maximum sync interval (7s)
/** Fast cadence used during join / reconnect (ms) */
const CLOCK_SYNC_FAST_INTERVAL_MS = 1000;
/** After this many fast samples the engine switches to normal cadence */
const CLOCK_SYNC_FAST_BURST_COUNT = 5;

/** Number of ping-pong samples kept in rolling window */
const CLOCK_SYNC_SAMPLES = 15;
/** Fraction of highest-RTT samples to discard as outliers (0–1) */
const CLOCK_SYNC_OUTLIER_TRIM = 0.2;
/** RTT above this is always rejected as an outlier, ms */
const CLOCK_SYNC_MAX_RTT_MS = 800;
/** EMA smoothing factor for clock offset (lower = smoother, slower) */
const CLOCK_SYNC_EMA_ALPHA = 0.15;

// Confidence thresholds – RTT p95 / offset stddev (ms)
const CLOCK_CONF_EXCELLENT_RTT = 60;
const CLOCK_CONF_EXCELLENT_SD  = 10;
const CLOCK_CONF_GOOD_RTT      = 120;
const CLOCK_CONF_GOOD_SD       = 25;
const CLOCK_CONF_FAIR_RTT      = 250;
const CLOCK_CONF_FAIR_SD       = 60;

// ============================================================
// 4. Drift Correction Ladder
// ============================================================

/**
 * Priority order (smallest → largest drift):
 *   1. IGNORE:      |drift| < DRIFT_IGNORE_MS
 *   2. RATE:        DRIFT_IGNORE_MS ≤ |drift| < DRIFT_MICRO_SEEK_MS  (playbackRate nudge)
 *   3. MICRO_SEEK:  DRIFT_MICRO_SEEK_MS ≤ |drift| < DRIFT_HARD_RESYNC_MS  (faded seek)
 *   4. HARD_RESYNC: |drift| ≥ DRIFT_HARD_RESYNC_MS (hard seek, cooldown protected)
 */

/** Dead-band: drifts below this are silently ignored (ms) */
const DRIFT_IGNORE_MS = 40;
/** Rate-correction upper bound; above this a micro-seek is preferred (ms) */
const DRIFT_MICRO_SEEK_MS = 120;
/** Below DRIFT_SOFT_MS alias – kept so existing references compile */
const DRIFT_SOFT_MS = DRIFT_MICRO_SEEK_MS;
/** Hard seek threshold (ms) */
const DRIFT_HARD_RESYNC_MS = 200;

/** PLL horizon: time over which rate correction is spread (seconds) */
const PLL_HORIZON_SEC = 4;
/** Max rate delta on stable network (fraction of 1.0) */
const MAX_RATE_DELTA_STABLE = 0.01;
/** Max rate delta on unstable network (fraction of 1.0) */
const MAX_RATE_DELTA_UNSTABLE = 0.02;
/** EMA alpha for smoothing playback-rate changes (lower = smoother) */
const PLAYBACK_RATE_SMOOTH_ALPHA = 0.2;
/** Hysteresis: do not re-enter rate correction unless drift > DRIFT_IGNORE_MS + this */
const DRIFT_HYSTERESIS_MS = 10;

/** Minimum time between consecutive hard-seek resyncs (ms) */
const HARD_RESYNC_COOLDOWN_MS = 15000;
/** Maximum consecutive hard resyncs before entering DEGRADED state */
const MAX_CONSECUTIVE_HARD_RESYNCS = 5;

const PLAYBACK_RATE_MIN = 0.95;
const PLAYBACK_RATE_MAX = 1.05;

// ============================================================
// 5. Playback Scheduling
// ============================================================

/** Client sends position feedback every N ms */
const PLAYBACK_FEEDBACK_INTERVAL_MS = 100;
/** Server evaluates drift corrections every N ms */
const DRIFT_CORRECTION_INTERVAL_MS = 200;
/** Default scheduling lead time (host broadcasts track this many ms before start) */
const DEFAULT_START_DELAY_MS = 3000;
/** If scheduled play is already this far in the past, start immediately */
const LATE_PLAYBACK_THRESHOLD_MS = -1000;
/** Rolling audio buffer target (ms) */
const ROLLING_BUFFER_MS = 150;

// ============================================================
// 6. Network Stability
// ============================================================

const NETWORK_STABILITY_SAMPLES = 10;
const NETWORK_STABILITY_NORMALIZATION_FACTOR = 100;

// ============================================================
// 7. WebSocket Reconnection
// ============================================================

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
/** Re-accelerate clock sync cadence after reconnect for this many seconds */
const RECONNECT_FAST_SYNC_SEC = 15;

// ============================================================
// 8. Per-device Latency Learning
// ============================================================

/**
 * Audio output latency compensation is now enabled in production.
 * The learning rate (ALPHA) is intentionally slow to avoid instability.
 * A hard cap (MAX_MS) prevents runaway compensation.
 */
const AUDIO_LATENCY_COMP_ENABLED = true;   // enabled for all platforms
const AUDIO_LATENCY_COMP_MAX_MS  = 80;
const AUDIO_LATENCY_COMP_ALPHA   = 0.02;
/** Minimum samples before learned compensation is applied */
const AUDIO_LATENCY_COMP_MIN_SAMPLES = 10;
/** Max manual output-latency override the user/host may configure (ms) */
const OUTPUT_LATENCY_OVERRIDE_MAX_MS = 200;

// ============================================================
// 9. Telemetry / Observability
// ============================================================

/** How often to emit a telemetry snapshot (ms) */
const TELEMETRY_EMIT_INTERVAL_MS = 10000;
/** Maximum join-to-lock time before telemetry flags a warning (ms) */
const TELEMETRY_JOIN_LOCK_WARN_MS = 8000;

// ============================================================
// 10. Platform-Specific Config Overrides
// ============================================================

/**
 * Browser platform overrides applied on top of the shared defaults.
 * These account for browser constraints:
 *  - Autoplay restrictions
 *  - Tab throttling / backgrounding
 *  - Less precise scheduling
 *  - Bluetooth/manual latency via user setting
 */
const BROWSER_OVERRIDES = Object.freeze({
  CLOCK_SYNC_FAST_INTERVAL_MS:  800,
  DRIFT_IGNORE_MS:              50,   // slightly looser dead-band for browser jitter
  DRIFT_MICRO_SEEK_MS:          130,
  DRIFT_HARD_RESYNC_MS:         220,
  DEFAULT_START_DELAY_MS:       3500, // extra buffer for autoplay/buffering
  AUDIO_LATENCY_COMP_MAX_MS:    80,
  PLAYBACK_FEEDBACK_INTERVAL_MS:150,
});

/**
 * Native (Capacitor/iOS/Android) platform overrides.
 * Native has stronger scheduling hooks, reliable background and audio sessions.
 */
const NATIVE_OVERRIDES = Object.freeze({
  CLOCK_SYNC_FAST_INTERVAL_MS:  600,
  DRIFT_IGNORE_MS:              30,   // tighter dead-band: native timing is more accurate
  DRIFT_MICRO_SEEK_MS:          100,
  DRIFT_HARD_RESYNC_MS:         180,
  DEFAULT_START_DELAY_MS:       2500,
  AUDIO_LATENCY_COMP_MAX_MS:    120,  // native can learn a wider compensation range
  PLAYBACK_FEEDBACK_INTERVAL_MS:80,
});

/**
 * Return a merged config for a given platform.
 * @param {'browser'|'native'|'server'} platform
 * @returns {object}
 */
function getPlatformConfig(platform) {
  const base = {
    CLOCK_SYNC_INTERVAL_MS,
    CLOCK_SYNC_MIN_INTERVAL_MS,
    CLOCK_SYNC_MAX_INTERVAL_MS,
    CLOCK_SYNC_FAST_INTERVAL_MS,
    CLOCK_SYNC_FAST_BURST_COUNT,
    CLOCK_SYNC_SAMPLES,
    CLOCK_SYNC_OUTLIER_TRIM,
    CLOCK_SYNC_MAX_RTT_MS,
    CLOCK_SYNC_EMA_ALPHA,
    DRIFT_IGNORE_MS,
    DRIFT_MICRO_SEEK_MS,
    DRIFT_SOFT_MS,
    DRIFT_HARD_RESYNC_MS,
    PLL_HORIZON_SEC,
    MAX_RATE_DELTA_STABLE,
    MAX_RATE_DELTA_UNSTABLE,
    PLAYBACK_RATE_SMOOTH_ALPHA,
    DRIFT_HYSTERESIS_MS,
    HARD_RESYNC_COOLDOWN_MS,
    MAX_CONSECUTIVE_HARD_RESYNCS,
    PLAYBACK_RATE_MIN,
    PLAYBACK_RATE_MAX,
    PLAYBACK_FEEDBACK_INTERVAL_MS,
    DRIFT_CORRECTION_INTERVAL_MS,
    DEFAULT_START_DELAY_MS,
    LATE_PLAYBACK_THRESHOLD_MS,
    ROLLING_BUFFER_MS,
    AUDIO_LATENCY_COMP_ENABLED,
    AUDIO_LATENCY_COMP_MAX_MS,
    AUDIO_LATENCY_COMP_ALPHA,
    AUDIO_LATENCY_COMP_MIN_SAMPLES,
    OUTPUT_LATENCY_OVERRIDE_MAX_MS,
    NETWORK_STABILITY_SAMPLES,
    NETWORK_STABILITY_NORMALIZATION_FACTOR,
    MAX_RECONNECT_ATTEMPTS,
    RECONNECT_DELAY_MS,
    MAX_RECONNECT_DELAY_MS,
    RECONNECT_FAST_SYNC_SEC,
  };

  if (platform === 'browser') return { ...base, ...BROWSER_OVERRIDES };
  if (platform === 'native')  return { ...base, ...NATIVE_OVERRIDES };
  return base; // 'server' uses shared defaults
}

// ============================================================
// 11. Legacy Constants (kept for backward compatibility)
// ============================================================

const DRIFT_THRESHOLD_MS = 50;
const DESYNC_THRESHOLD_MS = 50;
const PREDICTION_FACTOR = 0.8;
const DESKTOP_IGNORE_DRIFT_MS = 200;
const DESKTOP_SOFT_CORRECTION_MS = 800;
const MOBILE_IGNORE_DRIFT_MS = 300;
const MOBILE_SOFT_CORRECTION_MS = 1000;

// ============================================================
// Exports
// ============================================================

module.exports = {
  // Test mode
  SYNC_TEST_MODE,
  TEST_AUDIO_PATH,
  SYNC_TEST_FEEDBACK_INTERVAL_MS,

  // Event types & FSM states
  SyncEventType,
  ServerSyncState,
  ClientSyncState,

  // Clock sync
  CLOCK_SYNC_INTERVAL_MS,
  CLOCK_SYNC_MIN_INTERVAL_MS,
  CLOCK_SYNC_MAX_INTERVAL_MS,
  CLOCK_SYNC_FAST_INTERVAL_MS,
  CLOCK_SYNC_FAST_BURST_COUNT,
  CLOCK_SYNC_SAMPLES,
  CLOCK_SYNC_OUTLIER_TRIM,
  CLOCK_SYNC_MAX_RTT_MS,
  CLOCK_SYNC_EMA_ALPHA,
  CLOCK_CONF_EXCELLENT_RTT,
  CLOCK_CONF_EXCELLENT_SD,
  CLOCK_CONF_GOOD_RTT,
  CLOCK_CONF_GOOD_SD,
  CLOCK_CONF_FAIR_RTT,
  CLOCK_CONF_FAIR_SD,

  // Drift correction ladder
  DRIFT_IGNORE_MS,
  DRIFT_MICRO_SEEK_MS,
  DRIFT_SOFT_MS,
  DRIFT_HARD_RESYNC_MS,
  PLL_HORIZON_SEC,
  MAX_RATE_DELTA_STABLE,
  MAX_RATE_DELTA_UNSTABLE,
  PLAYBACK_RATE_SMOOTH_ALPHA,
  DRIFT_HYSTERESIS_MS,
  HARD_RESYNC_COOLDOWN_MS,
  MAX_CONSECUTIVE_HARD_RESYNCS,
  PLAYBACK_RATE_MIN,
  PLAYBACK_RATE_MAX,

  // Playback scheduling
  PLAYBACK_FEEDBACK_INTERVAL_MS,
  DRIFT_CORRECTION_INTERVAL_MS,
  DEFAULT_START_DELAY_MS,
  LATE_PLAYBACK_THRESHOLD_MS,
  ROLLING_BUFFER_MS,

  // Network stability
  NETWORK_STABILITY_SAMPLES,
  NETWORK_STABILITY_NORMALIZATION_FACTOR,

  // Reconnection
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS,
  RECONNECT_FAST_SYNC_SEC,

  // Latency learning
  AUDIO_LATENCY_COMP_ENABLED,
  AUDIO_LATENCY_COMP_MAX_MS,
  AUDIO_LATENCY_COMP_ALPHA,
  AUDIO_LATENCY_COMP_MIN_SAMPLES,
  OUTPUT_LATENCY_OVERRIDE_MAX_MS,

  // Telemetry
  TELEMETRY_EMIT_INTERVAL_MS,
  TELEMETRY_JOIN_LOCK_WARN_MS,

  // Platform configs
  BROWSER_OVERRIDES,
  NATIVE_OVERRIDES,
  getPlatformConfig,

  // Legacy (backward compat)
  DRIFT_THRESHOLD_MS,
  DESYNC_THRESHOLD_MS,
  PREDICTION_FACTOR,
  DESKTOP_IGNORE_DRIFT_MS,
  DESKTOP_SOFT_CORRECTION_MS,
  MOBILE_IGNORE_DRIFT_MS,
  MOBILE_SOFT_CORRECTION_MS,
};
