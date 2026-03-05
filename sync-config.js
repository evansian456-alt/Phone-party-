/**
 * SyncSpeaker Synchronization Configuration
 * 
 * Centralized configuration for sync engine and client.
 * Contains all timing, threshold, and performance constants used
 * across the synchronization system.
 * 
 * This configuration enables fine-tuning of sync behavior without
 * modifying core logic, and provides a single source of truth for
 * all synchronization parameters.
 * 
 * @module sync-config
 */

// ============================================================
// Clock Synchronization Constants
// ============================================================

const CLOCK_SYNC_INTERVAL_MS = 5000;        // Base interval for clock sync (5s)
const CLOCK_SYNC_MIN_INTERVAL_MS = 3000;    // Minimum sync interval (3s)
const CLOCK_SYNC_MAX_INTERVAL_MS = 7000;    // Maximum sync interval (7s)

// Rolling-window NTP clock estimation (Phase 2)
const CLOCK_SYNC_SAMPLES = 15;              // Rolling window size
const CLOCK_SYNC_OUTLIER_TRIM = 0.2;        // Top fraction of RTT outliers to discard
const CLOCK_SYNC_EMA_ALPHA = 0.15;          // EMA smoothing factor for clock offset

// ============================================================
// Playback and Feedback Constants
// ============================================================

const PLAYBACK_FEEDBACK_INTERVAL_MS = 100;  // Client sends position every 100ms
const DRIFT_CORRECTION_INTERVAL_MS = 200;   // Server checks drift every 200ms
const ROLLING_BUFFER_MS = 150;              // Rolling buffer size (100-200ms)
const DEFAULT_START_DELAY_MS = 3000;        // Default delay before playback starts
const LATE_PLAYBACK_THRESHOLD_MS = -1000;   // Threshold for "too late" playback (1 second)

// ============================================================
// Playback Rate Adjustment Constants
// ============================================================

const PLAYBACK_RATE_MIN = 0.95;             // Minimum playback rate
const PLAYBACK_RATE_MAX = 1.05;             // Maximum playback rate

// ============================================================
// Drift Detection and Correction Constants
// ============================================================

const DRIFT_THRESHOLD_MS = 50;              // Ignore drift below 50ms (server-side, kept for backward compat)
const DESYNC_THRESHOLD_MS = 50;             // Resync if desync exceeds 50ms
const PREDICTION_FACTOR = 0.8;              // Predictive drift factor (0-1)

// PLL-style drift correction (Phase 3)
const DRIFT_IGNORE_MS = 40;                 // Deadband: ignore drift below this value
const DRIFT_SOFT_MS = 120;                  // Soft correction range upper bound
const DRIFT_HARD_RESYNC_MS = 200;           // Hard resync (seek) threshold
const PLL_HORIZON_SEC = 4;                  // Correction horizon in seconds
const MAX_RATE_DELTA_STABLE = 0.01;         // Max rate adjustment on stable network (±1%)
const MAX_RATE_DELTA_UNSTABLE = 0.02;       // Max rate adjustment on unstable network (±2%)
const PLAYBACK_RATE_SMOOTH_ALPHA = 0.2;     // EMA alpha for smoothing rate changes
const HARD_RESYNC_COOLDOWN_MS = 15000;      // Minimum ms between hard resyncs

// Per-device output latency compensation (Phase 6, test-mode gated)
const AUDIO_LATENCY_COMP_MAX_MS = 80;       // Max learned audio latency compensation
const AUDIO_LATENCY_COMP_LEARN_ALPHA = 0.02; // Learning rate for latency compensation

// Desktop sync thresholds
const DESKTOP_IGNORE_DRIFT_MS = 200;        // Ignore drift below 200ms on desktop
const DESKTOP_SOFT_CORRECTION_MS = 800;     // Soft correction threshold on desktop

// Mobile-optimized thresholds (looser for cellular networks)
const MOBILE_IGNORE_DRIFT_MS = 300;         // Ignore drift below 300ms on mobile
const MOBILE_SOFT_CORRECTION_MS = 1000;     // Soft correction threshold on mobile

// ============================================================
// Network Stability Constants
// ============================================================

const NETWORK_STABILITY_SAMPLES = 10;       // Sample count for network stability
const NETWORK_STABILITY_NORMALIZATION_FACTOR = 100; // Normalization factor for stability calculation

// ============================================================
// WebSocket Reconnection Constants
// ============================================================

const MAX_RECONNECT_ATTEMPTS = 10;          // Maximum reconnection attempts
const RECONNECT_DELAY_MS = 1000;            // Initial reconnection delay (ms)
const MAX_RECONNECT_DELAY_MS = 30000;       // Maximum reconnection delay (30s)

// ============================================================
// Test Mode
// ============================================================

// Feature flag for sync measurement test mode
const SYNC_TEST_MODE = process.env.SYNC_TEST_MODE === 'true';

// ============================================================
// Exports
// ============================================================

module.exports = {
  // Clock sync
  CLOCK_SYNC_INTERVAL_MS,
  CLOCK_SYNC_MIN_INTERVAL_MS,
  CLOCK_SYNC_MAX_INTERVAL_MS,
  CLOCK_SYNC_SAMPLES,
  CLOCK_SYNC_OUTLIER_TRIM,
  CLOCK_SYNC_EMA_ALPHA,
  
  // Playback and feedback
  PLAYBACK_FEEDBACK_INTERVAL_MS,
  DRIFT_CORRECTION_INTERVAL_MS,
  ROLLING_BUFFER_MS,
  DEFAULT_START_DELAY_MS,
  LATE_PLAYBACK_THRESHOLD_MS,
  
  // Playback rate
  PLAYBACK_RATE_MIN,
  PLAYBACK_RATE_MAX,
  
  // Drift detection (legacy + PLL)
  DRIFT_THRESHOLD_MS,
  DESYNC_THRESHOLD_MS,
  PREDICTION_FACTOR,
  DRIFT_IGNORE_MS,
  DRIFT_SOFT_MS,
  DRIFT_HARD_RESYNC_MS,
  PLL_HORIZON_SEC,
  MAX_RATE_DELTA_STABLE,
  MAX_RATE_DELTA_UNSTABLE,
  PLAYBACK_RATE_SMOOTH_ALPHA,
  HARD_RESYNC_COOLDOWN_MS,
  DESKTOP_IGNORE_DRIFT_MS,
  DESKTOP_SOFT_CORRECTION_MS,
  MOBILE_IGNORE_DRIFT_MS,
  MOBILE_SOFT_CORRECTION_MS,
  
  // Audio latency compensation
  AUDIO_LATENCY_COMP_MAX_MS,
  AUDIO_LATENCY_COMP_LEARN_ALPHA,
  
  // Network stability
  NETWORK_STABILITY_SAMPLES,
  NETWORK_STABILITY_NORMALIZATION_FACTOR,
  
  // WebSocket reconnection
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS,

  // Test mode
  SYNC_TEST_MODE
};
