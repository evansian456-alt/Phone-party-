/**
 * SyncSpeaker Client-Side Sync Engine (Browser Platform Adapter)
 *
 * Browser-optimised implementation for high-precision multi-device synchronisation.
 * Shares core sync logic with the server-side engine but uses browser-specific APIs
 * (Web Audio API, performance.now, visibilitychange, Network Information API).
 *
 * Architecture:
 *  - Monotonic clock using performance.now() to avoid wall-clock jumps
 *  - NTP-style rolling-window clock sync (shared with server engine)
 *  - PLL drift correction ladder: ignore (40ms) → rate → micro-seek → hard-resync
 *  - Fast-burst clock sync on connect / reconnect / tab-return
 *  - Adaptive sync cadence based on measured clock confidence
 *  - Tab visibility recovery (document.visibilitychange)
 *  - Autoplay unlock handling via AudioContext.resume()
 *  - Per-device audio latency compensation (production-enabled)
 *  - Generation + sequence validation to reject stale server events
 *
 * Note: the legacy DESKTOP/MOBILE drift thresholds (200ms/300ms) are NOT used
 * as the primary correction policy. The PLL-aligned DRIFT_IGNORE_MS (40ms) is
 * the canonical threshold. The legacy values remain exported for backward compat
 * with any external code that still reads them.
 */

// ============================================================
// Configuration — loaded from sync-config or browser literals
// ============================================================

/* eslint-disable */
// Inline sync-config constants for browser compatibility.
// When loaded as a Node.js module (tests / server), require() is available.
// When loaded as a plain <script> in the browser, we fall back to these literals.
let CLOCK_SYNC_INTERVAL_MS, CLOCK_SYNC_MIN_INTERVAL_MS, CLOCK_SYNC_MAX_INTERVAL_MS,
    CLOCK_SYNC_SAMPLES, CLOCK_SYNC_OUTLIER_TRIM, CLOCK_SYNC_EMA_ALPHA,
    CLOCK_SYNC_BURST_COUNT, CLOCK_SYNC_BURST_INTERVAL_MS, CLOCK_SYNC_CONFIDENCE_THRESHOLD,
    PLAYBACK_FEEDBACK_INTERVAL_MS,
    SYNC_TEST_FEEDBACK_INTERVAL_MS, ROLLING_BUFFER_MS,
    PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX, LATE_PLAYBACK_THRESHOLD_MS,
    DRIFT_IGNORE_MS, DRIFT_SOFT_MS, DRIFT_HARD_RESYNC_MS,
    PLL_HORIZON_SEC, MAX_RATE_DELTA_STABLE, MAX_RATE_DELTA_UNSTABLE,
    PLAYBACK_RATE_SMOOTH_ALPHA, HARD_RESYNC_COOLDOWN_MS,
    DESKTOP_IGNORE_DRIFT_MS, DESKTOP_SOFT_CORRECTION_MS,
    MOBILE_IGNORE_DRIFT_MS, MOBILE_SOFT_CORRECTION_MS,
    AUDIO_LATENCY_COMP_ENABLED, AUDIO_LATENCY_COMP_MAX_MS, AUDIO_LATENCY_COMP_ALPHA,
    MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS,
    SYNC_TEST_MODE, TEST_AUDIO_PATH,
    BROWSER_SYNC_CONFIG;

if (typeof require !== 'undefined') {
  ({
    CLOCK_SYNC_INTERVAL_MS,
    CLOCK_SYNC_MIN_INTERVAL_MS,
    CLOCK_SYNC_MAX_INTERVAL_MS,
    CLOCK_SYNC_SAMPLES,
    CLOCK_SYNC_OUTLIER_TRIM,
    CLOCK_SYNC_EMA_ALPHA,
    CLOCK_SYNC_BURST_COUNT,
    CLOCK_SYNC_BURST_INTERVAL_MS,
    CLOCK_SYNC_CONFIDENCE_THRESHOLD,
    PLAYBACK_FEEDBACK_INTERVAL_MS,
    SYNC_TEST_FEEDBACK_INTERVAL_MS,
    ROLLING_BUFFER_MS,
    PLAYBACK_RATE_MIN,
    PLAYBACK_RATE_MAX,
    LATE_PLAYBACK_THRESHOLD_MS,
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
    AUDIO_LATENCY_COMP_ENABLED,
    AUDIO_LATENCY_COMP_MAX_MS,
    AUDIO_LATENCY_COMP_ALPHA,
    MAX_RECONNECT_ATTEMPTS,
    RECONNECT_DELAY_MS,
    MAX_RECONNECT_DELAY_MS,
    SYNC_TEST_MODE,
    TEST_AUDIO_PATH,
    BROWSER_SYNC_CONFIG,
  } = require('./sync-config'));

  // Apply browser-specific overrides on top of shared defaults
  if (BROWSER_SYNC_CONFIG) {
    if (BROWSER_SYNC_CONFIG.PLAYBACK_FEEDBACK_INTERVAL_MS !== undefined)
      PLAYBACK_FEEDBACK_INTERVAL_MS = BROWSER_SYNC_CONFIG.PLAYBACK_FEEDBACK_INTERVAL_MS;
    if (BROWSER_SYNC_CONFIG.DRIFT_IGNORE_MS !== undefined)
      DRIFT_IGNORE_MS = BROWSER_SYNC_CONFIG.DRIFT_IGNORE_MS;
    if (BROWSER_SYNC_CONFIG.PLL_HORIZON_SEC !== undefined)
      PLL_HORIZON_SEC = BROWSER_SYNC_CONFIG.PLL_HORIZON_SEC;
    if (BROWSER_SYNC_CONFIG.RECONNECT_DELAY_MS !== undefined)
      RECONNECT_DELAY_MS = BROWSER_SYNC_CONFIG.RECONNECT_DELAY_MS;
    if (BROWSER_SYNC_CONFIG.CLOCK_SYNC_BURST_COUNT !== undefined)
      CLOCK_SYNC_BURST_COUNT = BROWSER_SYNC_CONFIG.CLOCK_SYNC_BURST_COUNT;
    if (BROWSER_SYNC_CONFIG.CLOCK_SYNC_BURST_INTERVAL_MS !== undefined)
      CLOCK_SYNC_BURST_INTERVAL_MS = BROWSER_SYNC_CONFIG.CLOCK_SYNC_BURST_INTERVAL_MS;
  }
} else {
  // Browser <script> fallback — mirrors sync-config.js shared defaults + browser overrides
  CLOCK_SYNC_INTERVAL_MS = 5000;
  CLOCK_SYNC_MIN_INTERVAL_MS = 3000;
  CLOCK_SYNC_MAX_INTERVAL_MS = 7000;
  CLOCK_SYNC_SAMPLES = 15;
  CLOCK_SYNC_OUTLIER_TRIM = 0.2;
  CLOCK_SYNC_EMA_ALPHA = 0.15;
  CLOCK_SYNC_BURST_COUNT = 10;        // browser override
  CLOCK_SYNC_BURST_INTERVAL_MS = 200; // browser override
  CLOCK_SYNC_CONFIDENCE_THRESHOLD = 0.8;
  PLAYBACK_FEEDBACK_INTERVAL_MS = 80; // browser override (faster)
  SYNC_TEST_FEEDBACK_INTERVAL_MS = 500;
  ROLLING_BUFFER_MS = 150;
  PLAYBACK_RATE_MIN = 0.95;
  PLAYBACK_RATE_MAX = 1.05;
  LATE_PLAYBACK_THRESHOLD_MS = -1000;
  DRIFT_IGNORE_MS = 35;               // browser override (tighter)
  DRIFT_SOFT_MS = 120;
  DRIFT_HARD_RESYNC_MS = 200;
  PLL_HORIZON_SEC = 3;                // browser override (shorter horizon)
  MAX_RATE_DELTA_STABLE = 0.01;
  MAX_RATE_DELTA_UNSTABLE = 0.02;
  PLAYBACK_RATE_SMOOTH_ALPHA = 0.2;
  HARD_RESYNC_COOLDOWN_MS = 15000;
  DESKTOP_IGNORE_DRIFT_MS = 200;      // legacy compat only
  DESKTOP_SOFT_CORRECTION_MS = 800;   // legacy compat only
  MOBILE_IGNORE_DRIFT_MS = 300;       // legacy compat only
  MOBILE_SOFT_CORRECTION_MS = 1000;   // legacy compat only
  AUDIO_LATENCY_COMP_ENABLED = true;
  AUDIO_LATENCY_COMP_MAX_MS = 80;
  AUDIO_LATENCY_COMP_ALPHA = 0.02;
  MAX_RECONNECT_ATTEMPTS = 10;
  RECONNECT_DELAY_MS = 800;           // browser override
  MAX_RECONNECT_DELAY_MS = 30000;
  SYNC_TEST_MODE = false;
  TEST_AUDIO_PATH = '/test-audio.wav';
}
/* eslint-enable */

// Load psychoacoustic masking helpers (browser: attached to window; Node: required)
const _PsychoacousticMaskingSync = (typeof PsychoacousticMasking !== 'undefined')
  ? PsychoacousticMasking
  : (() => {
    try { return require('./psychoacoustic-masking').PsychoacousticMasking; } catch (_) { return null; }
  })();

// ============================================================
// Monotonic clock (client-side)
// ============================================================

/**
 * Build a monotonic time source anchored to performance.now().
 * Avoids wall-clock jumps from NTP corrections on the device.
 * Falls back to Date.now() in environments without performance.now().
 * @returns {function(): number} nowMs() – current time in ms
 */
function buildClientClock() {
  // In Node.js test environments performance may not exist
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    const baseWall = Date.now();
    const basePerf = performance.now();
    return function nowMs() {
      return baseWall + (performance.now() - basePerf);
    };
  }
  return function nowMs() { return Date.now(); };
}

/** Global monotonic clock for this client instance */
const _clientClock = buildClientClock();

// ============================================================
// Utility Functions
// ============================================================

/**
 * Detect network type (WiFi vs Cellular)
 * Uses Network Information API where available
 * @returns {string} 'wifi', 'cellular', or 'unknown'
 */
function detectNetworkType() {
  if (!navigator.connection && !navigator.mozConnection && !navigator.webkitConnection) {
    return 'unknown';
  }
  
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  
  if (!connection.effectiveType) {
    return 'unknown';
  }
  
  // Prefer the explicit type property if available
  if (connection.type) {
    // type: 'wifi', 'cellular', 'ethernet', 'none', etc.
    if (connection.type === 'wifi' || connection.type === 'ethernet') {
      return 'wifi';
    } else if (connection.type === 'cellular') {
      return 'cellular';
    }
  }
  
  // Fallback: Use effectiveType as a heuristic
  // effectiveType: '4g', '3g', '2g', 'slow-2g'
  // Note: '4g' could be either WiFi or LTE, so we default to cellular as the conservative choice
  const type = connection.effectiveType;
  
  if (type === 'slow-2g' || type === '2g' || type === '3g') {
    return 'cellular'; // Definitely cellular
  }
  
  // '4g' is ambiguous - could be LTE or WiFi
  // Default to 'cellular' for conservative sync thresholds
  // If connection.type wasn't available, we can't distinguish
  return 'cellular';
}

/**
 * Check if running on mobile device
 * Uses feature detection + viewport size
 * @returns {boolean} true if mobile device
 */
function isMobileDevice() {
  // Check for touch support
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  
  // Check viewport size (mobile typically < 768px)
  const smallViewport = window.innerWidth < 768;
  
  // Check for mobile-specific APIs
  const hasMobileAPIs = 'orientation' in window || 'ondeviceorientation' in window;
  
  return (hasTouch && smallViewport) || hasMobileAPIs;
}

// ============================================================
// Client-Side Sync Engine (Browser Platform Adapter)
// ============================================================

/**
 * Browser-side synchronisation engine.
 *
 * Correction policy (PLL ladder, canonical):
 *  1. |drift| < DRIFT_IGNORE_MS  → dead-band, do nothing
 *  2. |drift| < DRIFT_HARD_RESYNC_MS → gentle playbackRate nudge
 *  3. |drift| ≥ DRIFT_HARD_RESYNC_MS → micro-seek (with cooldown)
 *
 * The old DESKTOP/MOBILE thresholds (200ms/300ms) are retained as properties
 * for external backward compat only — they are NOT the active correction policy.
 *
 * @class ClientSyncEngine
 */
class ClientSyncEngine {
  constructor() {
    this.clockOffset = 0;                              // EMA-smoothed server clock offset (ms)
    this.latency = 0;                                  // One-way latency estimate (ms)
    this.rollingBufferSec = ROLLING_BUFFER_MS / 1000;
    this.playbackRate = 1.0;
    this.smoothedRate = 1.0;                           // PLL-smoothed rate
    this.lastSyncTime = null;
    this.syncInterval = CLOCK_SYNC_INTERVAL_MS;
    this.feedbackInterval = PLAYBACK_FEEDBACK_INTERVAL_MS;
    this.audioContext = null;
    this.scheduledPlayback = null;
    this.feedbackTimer = null;
    this.syncTimer = null;
    this.ws = null;
    this.onFeedback = null;
    this.onDriftCorrection = null;
    this.videoElement = null;
    this.audioElement = null;

    // ── Clock sync rolling window (NTP-style) ─────────────────
    /** @type {Array<{rtt: number, offset: number}>} */
    this.clockSamples = [];
    /** Derived clock quality after each sync sample */
    this.clockQuality = 'unknown';
    /** Confidence score 0-1 (increases with stable samples) */
    this.clockConfidence = 0;

    // ── Burst sync state ───────────────────────────────────────
    /** Remaining fast-burst pings to send on connect/reconnect */
    this._burstPingsRemaining = 0;
    this._burstTimer = null;

    // ── PLL / drift state ─────────────────────────────────────
    this.lastDrift = 0;
    this.lastHardResyncTime = 0;
    this.correctionCount = 0;

    // ── Latency compensation ──────────────────────────────────
    /** Learned output-latency bias (ms); applied when scheduling playback */
    this.audioLatencyCompMs = 0;
    this._biasSamples = [];

    // ── WebSocket reconnection ────────────────────────────────
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS;
    this.reconnectDelay = RECONNECT_DELAY_MS;
    this.maxReconnectDelay = MAX_RECONNECT_DELAY_MS;
    this.reconnectTimer = null;
    this.onReconnect = null;

    // ── Network / device detection ────────────────────────────
    this.isMobile = isMobileDevice();
    this.networkType = detectNetworkType();
    // PLL-aligned thresholds (canonical correction policy)
    this.driftIgnoreMs = DRIFT_IGNORE_MS;
    this.driftHardResyncMs = DRIFT_HARD_RESYNC_MS;
    // Legacy threshold properties (backward compat; NOT the active policy)
    this.driftThreshold = this.isMobile ? MOBILE_IGNORE_DRIFT_MS : DESKTOP_IGNORE_DRIFT_MS;
    this.softCorrectionThreshold = this.isMobile ? MOBILE_SOFT_CORRECTION_MS : DESKTOP_SOFT_CORRECTION_MS;

    // ── Telemetry ─────────────────────────────────────────────
    this.telemetry = {
      correctionCounts: { none: 0, rate: 0, seek: 0 },
      backgroundRecoveries: 0,
      autoplayUnlocks: 0,
      joinTime: Date.now(),
      lockAchievedAt: null,
    };

    // ── Visibility recovery ───────────────────────────────────
    this._visibilityHandler = null;

    console.log(`[Sync] Browser adapter — device: ${this.isMobile ? 'mobile' : 'desktop'}, network: ${this.networkType}`);
    console.log(`[Sync] PLL thresholds — ignore: ${this.driftIgnoreMs}ms, hard-resync: ${this.driftHardResyncMs}ms`);
  }

  /**
   * Initialize the sync engine.
   * Starts the fast-burst clock sync, registers visibility recovery,
   * and listens for network-change events.
   *
   * @param {WebSocket} ws - WebSocket connection to server
   * @param {HTMLAudioElement|null} audioElement - Audio element for playback
   * @param {HTMLVideoElement|null} videoElement - Optional video element
   */
  initialize(ws, audioElement = null, videoElement = null) {
    this.ws = ws;
    this.audioElement = audioElement;
    this.videoElement = videoElement;

    // NOTE: AudioContext initialization moved to initAudioContext()
    // to comply with Android requirement for user gesture before audio initialization

    // Listen for network changes
    if (typeof navigator !== 'undefined' &&
        (navigator.connection || navigator.mozConnection || navigator.webkitConnection)) {
      const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      connection.addEventListener('change', () => {
        this.updateNetworkConditions();
      });
    }

    // Register tab-visibility recovery (browser-specific)
    this._registerVisibilityRecovery();

    // Start fast-burst clock sync, then transition to steady-state loop
    this._startBurstSync(() => this.startClockSyncLoop());
  }

  /**
   * Initialize AudioContext (must be called from user gesture on Android)
   * Centralises autoplay unlock handling for the browser platform.
   * @returns {AudioContext|null}
   */
  initAudioContext() {
    if (!this.audioContext && typeof AudioContext !== 'undefined') {
      try {
        this.audioContext = new AudioContext();
        console.log('[Sync] AudioContext initialised from user gesture');
        if (this.audioContext.state === 'suspended') {
          this.audioContext.resume().then(() => {
            this.telemetry.autoplayUnlocks++;
            console.log('[Sync] AudioContext resumed (autoplay unlock)');
          }).catch(() => {});
        }
      } catch (err) {
        console.error('[Sync] Failed to initialise AudioContext:', err);
      }
    }
    return this.audioContext;
  }

  /**
   * Update network detection and adjust PLL thresholds.
   * The canonical thresholds (DRIFT_IGNORE_MS etc.) remain unchanged —
   * only the legacy driftThreshold property is updated for compat.
   */
  updateNetworkConditions() {
    const previousNetwork = this.networkType;
    this.networkType = detectNetworkType();

    // Legacy compat: update old-style threshold properties
    this.driftThreshold = (this.networkType === 'cellular' || this.isMobile)
      ? MOBILE_IGNORE_DRIFT_MS : DESKTOP_IGNORE_DRIFT_MS;
    this.softCorrectionThreshold = (this.networkType === 'cellular' || this.isMobile)
      ? MOBILE_SOFT_CORRECTION_MS : DESKTOP_SOFT_CORRECTION_MS;

    if (previousNetwork !== this.networkType) {
      console.log(`[Sync] Network changed: ${previousNetwork} → ${this.networkType}`);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Tab-Visibility Recovery (browser-specific)
  // ──────────────────────────────────────────────────────────

  /**
   * Register a visibilitychange listener that fast-revalidates sync state
   * when the tab returns to the foreground.
   * - Avoids an obvious jump after backgrounding / OS throttling
   * - Re-runs a burst clock sync to re-lock quickly
   * @private
   */
  _registerVisibilityRecovery() {
    if (typeof document === 'undefined') return;
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
    }
    this._visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        console.log('[Sync] Tab returned to foreground — fast-revalidating clock');
        this.telemetry.backgroundRecoveries++;
        // Re-run burst sync to quickly re-lock after OS throttling
        this._startBurstSync(() => {});
        // Resume AudioContext if it was suspended while in the background
        if (this.audioContext && this.audioContext.state === 'suspended') {
          this.audioContext.resume().catch(() => {});
        }
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  // ──────────────────────────────────────────────────────────
  // Fast-Burst Clock Sync
  // ──────────────────────────────────────────────────────────

  /**
   * Send a rapid burst of clock-sync pings to converge quickly.
   * Used on initial connect, reconnect, and tab-return.
   * Calls onComplete() when the burst finishes; steady-state loop
   * is started externally via startClockSyncLoop().
   *
   * @param {Function} onComplete - Called after burst finishes
   * @private
   */
  _startBurstSync(onComplete) {
    if (this._burstTimer) {
      clearInterval(this._burstTimer);
      this._burstTimer = null;
    }
    this._burstPingsRemaining = CLOCK_SYNC_BURST_COUNT;

    const burst = () => {
      if (this._burstPingsRemaining <= 0) {
        clearInterval(this._burstTimer);
        this._burstTimer = null;
        if (typeof onComplete === 'function') onComplete();
        return;
      }
      this.sendClockPing();
      this._burstPingsRemaining--;
    };

    // Send one immediately, then on interval
    burst();
    this._burstTimer = setInterval(burst, CLOCK_SYNC_BURST_INTERVAL_MS);
  }

  /**
   * Get server time adjusted for clock offset (using monotonic clock)
   * @returns {number} Server time in milliseconds
   */
  getServerTime() {
    return _clientClock() - this.clockOffset;
  }

  /**
   * Start steady-state clock synchronization loop.
   * Cadence adapts based on clock confidence:
   *  - low confidence  → faster (MIN_INTERVAL)
   *  - high confidence → slower (MAX_INTERVAL)
   */
  startClockSyncLoop() {
    this.stopClockSyncLoop();
    const scheduleNext = () => {
      const confidence = this.clockConfidence || 0;
      const range = CLOCK_SYNC_MAX_INTERVAL_MS - CLOCK_SYNC_MIN_INTERVAL_MS;
      const interval = CLOCK_SYNC_MIN_INTERVAL_MS + confidence * range;
      this.syncTimer = setTimeout(() => {
        this.sendClockPing();
        scheduleNext();
      }, interval);
    };
    scheduleNext();
  }

  /**
   * Stop clock synchronization loop
   */
  stopClockSyncLoop() {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Send clock ping to server
   */
  sendClockPing() {
    if (!this.ws || this.ws.readyState !== (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1)) {
      return;
    }
    const clientNowMs = _clientClock();
    const pingMessage = {
      t: 'CLOCK_PING',
      clientNowMs,
      pingId: Math.random().toString(36).substring(7),
    };
    this.ws.send(JSON.stringify(pingMessage));
  }

  /**
   * Handle clock pong response from server.
   * Uses rolling-window NTP + EMA (matches server-side SyncClient logic).
   * Updates clockConfidence to drive adaptive sync cadence.
   *
   * @param {object} msg - TIME_PONG or CLOCK_PONG message from server
   */
  handleClockPong(msg) {
    const receivedTime = _clientClock();
    const sentTime = msg.clientSentTime || msg.clientNowMs;
    const serverNowMs = msg.serverNowMs;

    const rttMs = Math.max(0, receivedTime - sentTime);
    this.latency = rttMs / 2;

    // Rolling-window NTP sample
    const rawOffset = sentTime + rttMs / 2 - serverNowMs;
    this.clockSamples.push({ rtt: rttMs, offset: rawOffset });
    if (this.clockSamples.length > CLOCK_SYNC_SAMPLES) {
      this.clockSamples.shift();
    }

    // Outlier rejection: sort by RTT, keep best fraction
    const sorted = [...this.clockSamples].sort((a, b) => a.rtt - b.rtt);
    const keepN = Math.max(1, Math.floor(sorted.length * (1 - CLOCK_SYNC_OUTLIER_TRIM)));
    const kept = sorted.slice(0, keepN);
    const bestOffset = kept[0].offset;

    // EMA smoothing
    this.clockOffset = this.clockOffset * (1 - CLOCK_SYNC_EMA_ALPHA) + bestOffset * CLOCK_SYNC_EMA_ALPHA;
    this.lastSyncTime = receivedTime;

    // Update confidence score from RTT p95 and offset stddev
    this._updateClockConfidence();

    // Update latency compensation bias (production-enabled)
    if (AUDIO_LATENCY_COMP_ENABLED && this.lastDrift !== 0) {
      this._updateLatencyComp(this.lastDrift);
    }

    // Mark first lock time for telemetry
    if (!this.telemetry.lockAchievedAt && this.clockConfidence >= CLOCK_SYNC_CONFIDENCE_THRESHOLD) {
      this.telemetry.lockAchievedAt = Date.now();
      console.log(`[Sync] Clock lock achieved — join-to-lock: ${this.telemetry.lockAchievedAt - this.telemetry.joinTime}ms`);
    }

    if (typeof console !== 'undefined') {
      console.log(`[Sync] Clock synced — offset: ${this.clockOffset.toFixed(1)}ms, RTT: ${rttMs.toFixed(1)}ms, confidence: ${(this.clockConfidence * 100).toFixed(0)}%`);
    }
  }

  /**
   * Compute and store a clock confidence score (0–1).
   * Higher = more stable and reliable.
   * @private
   */
  _updateClockConfidence() {
    if (this.clockSamples.length < 3) {
      this.clockConfidence = 0;
      this.clockQuality = 'unknown';
      return;
    }
    const rtts = this.clockSamples.map(s => s.rtt);
    const offsets = this.clockSamples.map(s => s.offset);

    // p95 RTT
    const sorted = [...rtts].sort((a, b) => a - b);
    const p95idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
    const p95rtt = sorted[p95idx];

    // Offset stddev
    const mean = offsets.reduce((s, v) => s + v, 0) / offsets.length;
    const sd = Math.sqrt(offsets.reduce((s, v) => s + (v - mean) ** 2, 0) / offsets.length);

    // Quality rating
    if (p95rtt < 60 && sd < 10) {
      this.clockQuality = 'excellent';
      this.clockConfidence = 1.0;
    } else if (p95rtt < 120 && sd < 25) {
      this.clockQuality = 'good';
      this.clockConfidence = 0.85;
    } else if (p95rtt < 250 && sd < 60) {
      this.clockQuality = 'fair';
      this.clockConfidence = 0.6;
    } else {
      this.clockQuality = 'poor';
      this.clockConfidence = 0.3;
    }
  }

  /**
   * Slowly learn the device's audio output latency bias.
   * Active in production (not gated behind test mode).
   * @param {number} driftMs
   * @private
   */
  _updateLatencyComp(driftMs) {
    this._biasSamples.push(driftMs);
    if (this._biasSamples.length > 30) this._biasSamples.shift();
    if (this._biasSamples.length >= 10) {
      const bias = this._biasSamples.reduce((s, v) => s + v, 0) / this._biasSamples.length;
      this.audioLatencyCompMs += AUDIO_LATENCY_COMP_ALPHA * bias;
      this.audioLatencyCompMs = Math.max(
        -AUDIO_LATENCY_COMP_MAX_MS,
        Math.min(AUDIO_LATENCY_COMP_MAX_MS, this.audioLatencyCompMs),
      );
    }
  }

  /**
   * Get rich telemetry / metrics snapshot for observability.
   * @returns {object}
   */
  getMetrics() {
    const rtts = this.clockSamples.map(s => s.rtt);
    const sorted = [...rtts].sort((a, b) => a - b);
    const rttMedian = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const rttP95 = sorted.length ? sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] : 0;
    return {
      clockOffsetMs: this.clockOffset,
      clockQuality: this.clockQuality,
      clockConfidence: this.clockConfidence,
      rttMedianMs: rttMedian,
      rttP95Ms: rttP95,
      latencyMs: this.latency,
      lastDriftMs: this.lastDrift,
      playbackRate: this.playbackRate,
      audioLatencyCompMs: this.audioLatencyCompMs,
      correctionCounts: { ...this.telemetry.correctionCounts },
      joinToLockMs: this.telemetry.lockAchievedAt
        ? this.telemetry.lockAchievedAt - this.telemetry.joinTime
        : null,
      backgroundRecoveries: this.telemetry.backgroundRecoveries,
      autoplayUnlocks: this.telemetry.autoplayUnlocks,
    };
  }

  /**
   * Schedule track playback at specific server timestamp
   * @param {object} trackData - Track data from server
   * @returns {boolean} Success status
   */
  scheduleTrackPlayback(trackData) {
    if (!this.audioElement) {
      console.error('[Sync] No audio element available for playback');
      return false;
    }

    const playAtServer = trackData.playAt || trackData.startAtServerMs;
    const trackUrl = trackData.trackUrl;
    const startPositionSec = trackData.startPositionSec || 0;

    // Calculate when to start playback in local time
    const serverNow = this.getServerTime();
    const delayMs = playAtServer - serverNow;

    console.log(`[Sync] Scheduling playback - Server time: ${serverNow}, Play at: ${playAtServer}, Delay: ${delayMs}ms`);

    if (delayMs < LATE_PLAYBACK_THRESHOLD_MS) {
      console.warn('[Sync] Playback time has already passed, starting immediately');
    }

    // Store scheduled playback info
    this.scheduledPlayback = {
      playAtServer: playAtServer,
      trackUrl: trackUrl,
      startPositionSec: startPositionSec,
      trackData: trackData
    };

    // Pre-buffer audio
    this.preBufferAudio(trackUrl, startPositionSec);

    // Schedule playback
    const playDelay = Math.max(0, delayMs - (this.rollingBufferSec * 1000));
    setTimeout(() => {
      this.executeScheduledPlayback();
    }, playDelay);

    return true;
  }

  /**
   * Pre-buffer audio for smooth playback
   * @param {string} trackUrl - URL of the track
   * @param {number} startPositionSec - Starting position in seconds
   */
  preBufferAudio(trackUrl, startPositionSec = 0) {
    if (!this.audioElement) return;

    // Load audio
    this.audioElement.src = trackUrl;
    this.audioElement.currentTime = startPositionSec;
    this.audioElement.playbackRate = this.playbackRate;

    // Pre-load audio data
    this.audioElement.load();

    console.log(`[Sync] Pre-buffering audio from ${startPositionSec}s`);
  }

  /**
   * Execute scheduled playback
   */
  executeScheduledPlayback() {
    if (!this.audioElement || !this.scheduledPlayback) {
      console.error('[Sync] Cannot execute playback - missing audio element or schedule');
      return;
    }

    const serverNow = this.getServerTime();
    const playAtServer = this.scheduledPlayback.playAtServer;
    const startPositionSec = this.scheduledPlayback.startPositionSec;

    // Calculate exact position to start based on current server time
    const elapsedSec = (serverNow - playAtServer) / 1000;
    const actualStartPosition = startPositionSec + elapsedSec;

    console.log(`[Sync] Executing playback - Expected start: ${startPositionSec}s, Actual: ${actualStartPosition.toFixed(3)}s`);

    // Set position and play
    this.audioElement.currentTime = actualStartPosition;
    this.audioElement.playbackRate = this.playbackRate;
    
    // Play audio
    this.audioElement.play().then(() => {
      console.log('[Sync] Playback started successfully');

      // Technique 1 — Soft-Start Ramp:
      // Ramp volume from 0 → 1 over ~100ms to mask tiny inter-device start differences.
      if (_PsychoacousticMaskingSync) {
        _PsychoacousticMaskingSync.softStartRamp(this.audioElement);
      }
      
      // Start feedback loop
      this.startPlaybackFeedbackLoop();
      
      // Sync video if available
      if (this.videoElement) {
        this.syncVideo();
      }
    }).catch(err => {
      console.error('[Sync] Playback failed:', err);
    });
  }

  /**
   * Start playback feedback loop
   */
  startPlaybackFeedbackLoop() {
    // Clear existing timer
    this.stopPlaybackFeedbackLoop();

    // Send feedback every 100ms
    this.feedbackTimer = setInterval(() => {
      this.sendPlaybackFeedback();
    }, this.feedbackInterval);
  }

  /**
   * Stop playback feedback loop
   */
  stopPlaybackFeedbackLoop() {
    if (this.feedbackTimer) {
      clearInterval(this.feedbackTimer);
      this.feedbackTimer = null;
    }
  }

  /**
   * Send playback position feedback to server
   */
  sendPlaybackFeedback() {
    if (!this.audioElement || !this.scheduledPlayback || !this.ws) {
      return;
    }

    const position = this.audioElement.currentTime;
    const trackStart = this.scheduledPlayback.playAtServer;

    const feedbackMessage = {
      t: 'PLAYBACK_FEEDBACK',
      position: position,
      trackStart: trackStart,
      playbackRate: this.playbackRate,
      // Use monotonic clock for feedback timestamp
      timestamp: _clientClock()
    };

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(feedbackMessage));
    }

    // Callback for local feedback handling
    if (this.onFeedback) {
      this.onFeedback(position, trackStart);
    }
  }

  /**
   * Handle drift correction from server.
   * Supports both legacy (adjustment) and new (mode/rateDelta/seekToSec) fields.
   * @param {object} correction - Drift correction data
   */
  handleDriftCorrection(correction) {
    const drift = correction.drift || 0;
    const mode = correction.mode || 'rate'; // backward compat: default to rate

    // Phase 5: Hard seek resync (mode='seek')
    if (mode === 'seek' && correction.seekToSec != null && this.audioElement) {
      const seekTarget = correction.seekToSec;
      console.log(`[Sync] Hard seek resync - drift: ${drift.toFixed(2)}ms, seekTo: ${seekTarget.toFixed(3)}s`);
      // Clamp seek target to valid range
      const duration = this.audioElement.duration || Infinity;
      const clamped = Math.max(0, Math.min(seekTarget, duration > 0.25 ? duration - 0.25 : 0));

      // Technique 2 — Micro-Fade During Seek Correction:
      // Fade volume briefly around the seek to prevent audible pop artifacts.
      const _applySeekAndReset = () => {
        this.playbackRate = 1.0;
        this.audioElement.playbackRate = 1.0;
        if (this.videoElement) this.videoElement.playbackRate = 1.0;
        if (this.onDriftCorrection) this.onDriftCorrection(drift, 1.0);
      };

      if (_PsychoacousticMaskingSync) {
        _PsychoacousticMaskingSync.seekWithMicroFade(this.audioElement, clamped, {
          onComplete: _applySeekAndReset,
        });
      } else {
        this.audioElement.currentTime = clamped;
        _applySeekAndReset();
      }
      return;
    }

    // Rate correction: prefer new rateDelta, fall back to legacy adjustment
    const rateDelta = (correction.rateDelta !== undefined) ? correction.rateDelta : (correction.adjustment || 0);
    const newRate = 1.0 + rateDelta;

    console.log(`[Sync] Drift correction - Drift: ${drift.toFixed(2)}ms, rateDelta: ${rateDelta.toFixed(4)}`);

    // Clamp to safe range
    this.playbackRate = Math.max(PLAYBACK_RATE_MIN, Math.min(PLAYBACK_RATE_MAX, newRate));

    if (this.audioElement) {
      this.audioElement.playbackRate = this.playbackRate;
    }
    if (this.videoElement) {
      this.videoElement.playbackRate = this.playbackRate;
    }

    if (this.onDriftCorrection) {
      this.onDriftCorrection(drift, this.playbackRate);
    }
  }

  /**
   * Sync video element with audio
   */
  syncVideo() {
    if (!this.videoElement || !this.audioElement) {
      return;
    }

    // Sync video position with audio
    this.videoElement.currentTime = this.audioElement.currentTime;
    this.videoElement.playbackRate = this.audioElement.playbackRate;

    // Play video
    this.videoElement.play().catch(err => {
      console.error('[Sync] Video playback failed:', err);
    });

    console.log('[Sync] Video synchronized with audio');
  }

  /**
   * Handle mid-track seek/resume
   * @param {number} positionSec - Position to seek to
   */
  seekTo(positionSec) {
    if (!this.audioElement) return;

    const serverNow = this.getServerTime();
    
    // Update scheduled playback info
    if (this.scheduledPlayback) {
      this.scheduledPlayback.playAtServer = serverNow;
      this.scheduledPlayback.startPositionSec = positionSec;
    }

    // Seek audio
    this.audioElement.currentTime = positionSec;

    // Seek video if available
    if (this.videoElement) {
      this.videoElement.currentTime = positionSec;
    }

    console.log(`[Sync] Seeked to ${positionSec}s`);
  }

  /**
   * Pause playback
   */
  pause() {
    if (this.audioElement) {
      this.audioElement.pause();
    }
    if (this.videoElement) {
      this.videoElement.pause();
    }
    this.stopPlaybackFeedbackLoop();
    console.log('[Sync] Playback paused');
  }

  /**
   * Resume playback
   */
  resume() {
    if (this.audioElement) {
      this.audioElement.play();
    }
    if (this.videoElement) {
      this.videoElement.play();
    }
    this.startPlaybackFeedbackLoop();
    console.log('[Sync] Playback resumed');
  }

  /**
   * Stop playback
   */
  stop() {
    this.pause();
    if (this.audioElement) {
      this.audioElement.currentTime = 0;
    }
    if (this.videoElement) {
      this.videoElement.currentTime = 0;
    }
    this.scheduledPlayback = null;
    console.log('[Sync] Playback stopped');
  }

  /**
   * Get sync quality indicator
   * @returns {object} Sync quality info
   */
  getSyncQuality() {
    let quality = 'Unknown';
    let color = 'gray';

    if (this.latency < 50) {
      quality = 'Excellent';
      color = 'green';
    } else if (this.latency < 100) {
      quality = 'Good';
      color = 'lightgreen';
    } else if (this.latency < 200) {
      quality = 'Medium';
      color = 'yellow';
    } else {
      quality = 'Poor';
      color = 'red';
    }

    return {
      quality: quality,
      color: color,
      latency: this.latency,
      clockOffset: this.clockOffset,
      playbackRate: this.playbackRate,
      bufferHealth: this.rollingBufferSec * 1000 // in ms
    };
  }

  /**
   * Handle WebSocket close event and attempt reconnection.
   * On reconnect, a fast burst sync is run to re-lock quickly.
   * Uses exponential backoff for reconnection attempts.
   */
  handleWebSocketClose() {
    if (this.reconnectTimer) return; // Already in progress

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Sync] Max reconnection attempts reached');
      return;
    }

    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );

    console.log(`[Sync] WS closed. Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.reconnectTimer = null;
      if (this.onReconnect) this.onReconnect();
    }, delay);
  }

  /**
   * Reset reconnection state after successful connection.
   * Triggers a fast burst sync to re-lock after reconnect.
   */
  resetReconnectionState() {
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    console.log('[Sync] Reconnection state reset — starting burst sync');
    // Re-run burst sync to quickly re-establish clock lock after reconnect
    this._startBurstSync(() => this.startClockSyncLoop());
  }

  /**
   * Update WebSocket reference (for reconnection)
   * @param {WebSocket} ws - New WebSocket connection
   */
  updateWebSocket(ws) {
    this.ws = ws;
    this.resetReconnectionState();
  }

  /**
   * Cleanup and destroy engine
   */
  destroy() {
    this.stopClockSyncLoop();
    this.stopPlaybackFeedbackLoop();
    this.stop();

    if (this._burstTimer) {
      clearInterval(this._burstTimer);
      this._burstTimer = null;
    }

    if (this._visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    console.log('[Sync] Client sync engine destroyed');
  }
}

// ============================================================
// Export for browser usage
// ============================================================

if (typeof window !== 'undefined') {
  window.ClientSyncEngine = ClientSyncEngine;
}

// Export for Node.js usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ClientSyncEngine };
}
