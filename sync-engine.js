/**
 * SyncSpeaker Ultimate AmpSync+ Engine
 * 
 * High-precision multi-device audio/video synchronization system
 * Features:
 * - Monotonic master clock (process.hrtime.bigint)
 * - NTP-style rolling-window clock sync with outlier rejection + EMA
 * - PLL-style drift correction (deadband + horizon + smoothing + caps)
 * - Safe hard-seek resync with cooldown protection
 * - Per-device audio-latency compensation (test mode)
 * - Rich per-client metrics for observability
 */

// ============================================================
// Configuration
// ============================================================

const {
  CLOCK_SYNC_INTERVAL_MS,
  CLOCK_SYNC_MIN_INTERVAL_MS,
  CLOCK_SYNC_MAX_INTERVAL_MS,
  CLOCK_SYNC_SAMPLES,
  CLOCK_SYNC_OUTLIER_TRIM,
  CLOCK_SYNC_EMA_ALPHA,
  PLAYBACK_FEEDBACK_INTERVAL_MS,
  DRIFT_CORRECTION_INTERVAL_MS,
  ROLLING_BUFFER_MS,
  PLAYBACK_RATE_MIN,
  PLAYBACK_RATE_MAX,
  DRIFT_IGNORE_MS,
  DRIFT_SOFT_MS,
  DRIFT_HARD_RESYNC_MS,
  PLL_HORIZON_SEC,
  MAX_RATE_DELTA_STABLE,
  MAX_RATE_DELTA_UNSTABLE,
  PLAYBACK_RATE_SMOOTH_ALPHA,
  HARD_RESYNC_COOLDOWN_MS,
  DRIFT_THRESHOLD_MS,
  DESYNC_THRESHOLD_MS,
  PREDICTION_FACTOR,
  NETWORK_STABILITY_SAMPLES,
  NETWORK_STABILITY_NORMALIZATION_FACTOR,
  DEFAULT_START_DELAY_MS,
  AUDIO_LATENCY_COMP_ENABLED,
  AUDIO_LATENCY_COMP_MAX_MS,
  AUDIO_LATENCY_COMP_ALPHA,
} = require('./sync-config');

// ============================================================
// Monotonic clock helpers (server-side)
// ============================================================

/**
 * Build a monotonic-time function anchored to process.hrtime.bigint().
 * Avoids NTP jumps during a session.
 * @returns {function(): number}
 */
function buildMonotonicClock() {
  const baseWall = Date.now();
  const baseMono = process.hrtime.bigint();
  return function nowMs() {
    const deltaNs = process.hrtime.bigint() - baseMono;
    return baseWall + Number(deltaNs) / 1e6;
  };
}

// ============================================================
// Math helpers
// ============================================================

/** Compute the median of a numeric array (returns 0 on empty). */
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Compute the p-th percentile (0-100) of a numeric array. */
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

/** Compute the mean of a numeric array. */
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** Compute the population standard deviation of a numeric array. */
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// ============================================================
// Client Metadata Structure
// ============================================================

/**
 * Represents a connected client in the sync system.
 * Enhanced with rolling-window NTP, EMA clock offset, PLL drift control,
 * and per-client metrics for observability.
 *
 * @class SyncClient
 * @property {WebSocket} ws - WebSocket connection to the client
 * @property {string} clientId - Unique identifier for the client
 * @property {number} clockOffset - EMA-smoothed clock offset from server (ms)
 * @property {number} latency - Round-trip network latency / 2 (ms)
 * @property {number} lastDrift - Most recent measured drift (ms)
 * @property {Array<{time: number, drift: number}>} driftHistory - Historical drift measurements
 * @property {string|null} peerId - P2P peer ID (unused)
 * @property {number|null} lastPingTime - Timestamp of last clock sync
 * @property {number} networkStability - Network stability score (0-1, higher is better)
 * @property {Array<number>} latencyHistory - Recent latency measurements
 * @property {number} playbackRate - Current playback rate adjustment factor
 * @property {number|null} lastFeedbackTime - Timestamp of last playback feedback
 * @property {number} playbackPosition - Current playback position (seconds)
 * @property {number} predictedDrift - Predicted future drift (ms)
 */
class SyncClient {
  /**
   * Create a new sync client
   * @param {WebSocket} ws - WebSocket connection
   * @param {string} clientId - Unique client identifier
   */
  constructor(ws, clientId) {
    this.ws = ws;
    this.clientId = clientId;

    // ── Clock sync state ──────────────────────────────────────
    this.clockOffset = 0;           // EMA-smoothed clock offset (ms)
    this.latency = 0;               // Latest one-way latency estimate (ms)
    this.lastPingTime = null;       // Server time of last ping
    this.peerId = null;             // Legacy P2P peer ID
    /** Rolling window of {rtt, offset} samples */
    this.clockSamples = [];

    // ── Network stability ─────────────────────────────────────
    this.networkStability = 1.0;    // 0-1 (higher = more stable)
    this.latencyHistory = [];       // Recent RTT half-values (ms)

    // ── Drift / playback ──────────────────────────────────────
    this.lastDrift = 0;             // Most recent drift measurement (ms)
    this.driftHistory = [];         // [{time, drift}] for trend analysis
    this.predictedDrift = 0;        // Predicted drift (legacy)
    this.playbackRate = 1.0;        // Current target playback rate
    /** EMA-smoothed rate actually commanded to the client */
    this.smoothedRate = 1.0;
    this.playbackPosition = 0;      // Last reported playback position (s)
    this.lastFeedbackTime = null;   // Server time of last feedback

    // ── Hard-resync state ─────────────────────────────────────
    this.lastHardResyncTime = 0;    // Server time of last seek-resync
    this.hardResyncCount = 0;       // Total hard resyncs performed

    // ── Audio latency compensation (phase 6) ─────────────────
    this.audioLatencyCompMs = 0;    // Learned output-latency compensation
    this._biasSamples = [];         // Recent drift bias samples

    // ── Metrics ───────────────────────────────────────────────
    this.correctionCount = 0;       // Total drift corrections issued
    this.rateChanges = [];          // Timestamps of rate change events (last 60s)
    this.joinTime = Date.now();     // When client was added
    this.clockQuality = 'unknown';  // 'excellent'|'good'|'fair'|'poor'|'unknown'
  }

  // ──────────────────────────────────────────────────────────
  // Phase 1+2: Rolling-window NTP + EMA clock sync
  // ──────────────────────────────────────────────────────────

  /**
   * Record a new clock-sync sample and update the EMA clock offset.
   * Uses a rolling window of CLOCK_SYNC_SAMPLES, discards the top
   * CLOCK_SYNC_OUTLIER_TRIM fraction by RTT, then applies EMA smoothing.
   *
   * @param {number} sentTime      - client nowMs when ping was sent
   * @param {number} serverNowMs   - server nowMs when pong was sent
   * @param {number} receivedTime  - server nowMs (or client nowMs) when pong was received
   */
  updateClockSync(sentTime, serverNowMs, receivedTime) {
    const rtt = receivedTime - sentTime;
    const rttMs = Math.max(0, rtt);
    this.latency = rttMs / 2;

    // Legacy latency history (network stability)
    this.latencyHistory.push(this.latency);
    if (this.latencyHistory.length > NETWORK_STABILITY_SAMPLES) {
      this.latencyHistory.shift();
    }
    this._updateNetworkStability();

    // Rolling window of NTP samples
    this.clockSamples.push({ rtt: rttMs, offset: sentTime + rttMs / 2 - serverNowMs });
    if (this.clockSamples.length > CLOCK_SYNC_SAMPLES) {
      this.clockSamples.shift();
    }

    // Outlier rejection: sort by RTT ascending, keep lowest fraction
    const sorted = [...this.clockSamples].sort((a, b) => a.rtt - b.rtt);
    const keepN = Math.max(1, Math.floor(sorted.length * (1 - CLOCK_SYNC_OUTLIER_TRIM)));
    const kept = sorted.slice(0, keepN);

    // Best estimate: sample with minimum RTT
    const bestOffset = kept[0].offset;

    // EMA smoothing to reduce jitter
    this.clockOffset = this.clockOffset * (1 - CLOCK_SYNC_EMA_ALPHA) + bestOffset * CLOCK_SYNC_EMA_ALPHA;

    this.lastPingTime = Date.now();
    this._updateClockQuality();
  }

  /** Compute and store network stability score from latency variance. */
  _updateNetworkStability() {
    if (this.latencyHistory.length >= 3) {
      const m = mean(this.latencyHistory);
      const variance = this.latencyHistory.reduce((s, v) => s + (v - m) ** 2, 0) / this.latencyHistory.length;
      const sd = Math.sqrt(variance);
      this.networkStability = Math.max(0, 1 - sd / NETWORK_STABILITY_NORMALIZATION_FACTOR);
    }
  }

  /** Derive a clock quality rating from RTT p95 and offset stddev. */
  _updateClockQuality() {
    if (this.clockSamples.length < 3) {
      this.clockQuality = 'unknown';
      return;
    }
    const rtts = this.clockSamples.map(s => s.rtt);
    const p95rtt = percentile(rtts, 95);
    const offsets = this.clockSamples.map(s => s.offset);
    const sd = stddev(offsets);

    if (p95rtt < 60 && sd < 10) {
      this.clockQuality = 'excellent';
    } else if (p95rtt < 120 && sd < 25) {
      this.clockQuality = 'good';
    } else if (p95rtt < 250 && sd < 60) {
      this.clockQuality = 'fair';
    } else {
      this.clockQuality = 'poor';
    }
  }

  /**
   * Get adaptive sync interval based on network stability.
   * More stable network = longer interval (less frequent syncs).
   */
  getAdaptiveSyncInterval() {
    const stabilityFactor = this.networkStability || 1.0;
    const interval = CLOCK_SYNC_INTERVAL_MS + stabilityFactor * 2000;
    return Math.min(Math.max(interval, CLOCK_SYNC_MIN_INTERVAL_MS), CLOCK_SYNC_MAX_INTERVAL_MS);
  }

  // ──────────────────────────────────────────────────────────
  // Phase 3: PLL-style drift correction
  // ──────────────────────────────────────────────────────────

  /**
   * Record a new drift measurement and update predictions.
   * @param {number} drift - measured drift in milliseconds
   */
  updateDrift(drift) {
    this.lastDrift = drift;
    this.driftHistory.push({ time: Date.now(), drift });
    if (this.driftHistory.length > 20) this.driftHistory.shift();
    if (this.driftHistory.length >= 3) this.predictedDrift = this.calculatePredictedDrift();
  }

  /**
   * Weighted moving-average drift prediction (legacy, kept for compat).
   * @returns {number}
   */
  calculatePredictedDrift() {
    const n = this.driftHistory.length;
    if (n < 3) return this.lastDrift;
    let weightedSum = 0, weightSum = 0;
    for (let i = 0; i < n; i++) {
      const w = (i + 1) / n;
      weightedSum += this.driftHistory[i].drift * w;
      weightSum += w;
    }
    return this.lastDrift * 0.7 + (weightedSum / weightSum) * 0.3;
  }

  /**
   * PLL-style drift-correction computation.
   * Returns { mode, rateDelta, seekToSec }:
   *  - mode='none' : within dead-band
   *  - mode='rate' : gentle rate correction
   *  - mode='seek' : hard seek (caller checks cooldown)
   *
   * @param {number} nowMs          - current server time (ms)
   * @param {number} expectedPosSec - ideal playback position at nowMs (s)
   * @returns {{ mode: string, rateDelta: number, seekToSec: number|null }}
   */
  computePLLCorrection(nowMs, expectedPosSec) {
    const drift = this.lastDrift;
    const absDrift = Math.abs(drift);

    if (absDrift < DRIFT_IGNORE_MS) {
      return { mode: 'none', rateDelta: 0, seekToSec: null };
    }

    if (absDrift >= DRIFT_HARD_RESYNC_MS) {
      return { mode: 'seek', rateDelta: 0, seekToSec: expectedPosSec };
    }

    // Soft rate correction
    const isStable = this.networkStability >= 0.7;
    const maxDelta = isStable ? MAX_RATE_DELTA_STABLE : MAX_RATE_DELTA_UNSTABLE;

    const driftSec = drift / 1000;
    let rawDelta = -(driftSec / PLL_HORIZON_SEC);
    rawDelta = Math.max(-maxDelta, Math.min(maxDelta, rawDelta));

    // EMA smooth the delta to prevent oscillation
    const currentDelta = this.smoothedRate - 1.0;
    const smoothedDelta = currentDelta * (1 - PLAYBACK_RATE_SMOOTH_ALPHA) + rawDelta * PLAYBACK_RATE_SMOOTH_ALPHA;

    return { mode: 'rate', rateDelta: smoothedDelta, seekToSec: null };
  }

  /**
   * Legacy drift correction (used for backward-compat adjustment field).
   * @returns {number} adjustment to add to 1.0 for playbackRate
   */
  calculateDriftCorrection() {
    if (Math.abs(this.lastDrift) < DRIFT_THRESHOLD_MS) return 0;
    const driftToCorrect = this.lastDrift * (1 - PREDICTION_FACTOR) + this.predictedDrift * PREDICTION_FACTOR;
    return -driftToCorrect * 0.01;
  }

  /**
   * Update playback rate (legacy path).
   * @param {number} adjustment
   */
  updatePlaybackRate(adjustment) {
    const newRate = 1.0 + adjustment;
    this.playbackRate = Math.max(PLAYBACK_RATE_MIN, Math.min(PLAYBACK_RATE_MAX, newRate));
    this.smoothedRate = this.playbackRate;
  }

  /**
   * Apply PLL rate delta and update smoothed rate.
   * @param {number} rateDelta
   */
  applyPLLRate(rateDelta) {
    const newRate = 1.0 + rateDelta;
    this.smoothedRate = Math.max(PLAYBACK_RATE_MIN, Math.min(PLAYBACK_RATE_MAX, newRate));
    this.playbackRate = this.smoothedRate;
    this.correctionCount++;
    this.rateChanges.push(Date.now());
    const cutoff = Date.now() - 60000;
    this.rateChanges = this.rateChanges.filter(t => t > cutoff);
  }

  // ──────────────────────────────────────────────────────────
  // Phase 6: Audio latency compensation (optional, test-mode)
  // ──────────────────────────────────────────────────────────

  /**
   * Slowly learn the device's audio output latency bias.
   * Only active when AUDIO_LATENCY_COMP_ENABLED is true.
   * @param {number} driftMs
   */
  updateLatencyComp(driftMs) {
    if (!AUDIO_LATENCY_COMP_ENABLED) return;
    this._biasSamples.push(driftMs);
    if (this._biasSamples.length > 30) this._biasSamples.shift();
    if (this._biasSamples.length >= 10) {
      const bias = mean(this._biasSamples);
      this.audioLatencyCompMs += AUDIO_LATENCY_COMP_ALPHA * bias;
      this.audioLatencyCompMs = Math.max(
        -AUDIO_LATENCY_COMP_MAX_MS,
        Math.min(AUDIO_LATENCY_COMP_MAX_MS, this.audioLatencyCompMs)
      );
    }
  }

  // ──────────────────────────────────────────────────────────
  // Metrics
  // ──────────────────────────────────────────────────────────

  /** Return rich per-client metrics snapshot. */
  getMetrics() {
    const rtts = this.clockSamples.map(s => s.rtt);
    const offsets = this.clockSamples.map(s => s.offset);
    const drifts = this.driftHistory.map(d => d.drift);
    return {
      clientId: this.clientId,
      clockQuality: this.clockQuality,
      clockOffsetMs: this.clockOffset,
      clockOffsetStddev: stddev(offsets),
      rttMedianMs: median(rtts),
      rttP95Ms: percentile(rtts, 95),
      networkStability: this.networkStability,
      lastDriftMs: this.lastDrift,
      driftP50Ms: percentile(drifts.map(Math.abs), 50),
      driftP95Ms: percentile(drifts.map(Math.abs), 95),
      playbackRate: this.playbackRate,
      correctionCount: this.correctionCount,
      rateChangesPerMin: this.rateChanges.length,
      hardResyncCount: this.hardResyncCount,
      audioLatencyCompMs: this.audioLatencyCompMs,
      joinTime: this.joinTime,
    };
  }
}

// ============================================================
// Track Metadata Structure
// ============================================================

/**
 * Represents metadata for a music track in the sync system
 * 
 * @class TrackInfo
 * @property {string} trackId - Unique identifier for the track
 * @property {number} duration - Track duration in seconds
 * @property {number} startTimestamp - Master clock timestamp when track started (ms)
 * @property {number} startPositionSec - Starting position in track for seek/resume (seconds)
 * @property {string} status - Current playback status ('preparing', 'playing', 'paused', 'stopped')
 */
class TrackInfo {
  /**
   * Create track metadata
   * @param {string} trackId - Unique track identifier
   * @param {number} duration - Track duration in seconds
   * @param {number} startTimestamp - Master clock start timestamp (ms)
   */
  constructor(trackId, duration, startTimestamp) {
    this.trackId = trackId;
    this.duration = duration;
    this.startTimestamp = startTimestamp;
    this.startPositionSec = 0;
    this.status = 'preparing';
  }
}

// ============================================================
// Sync Engine
// ============================================================

/**
 * High-precision multi-device audio synchronization engine.
 * Manages clock synchronization, PLL drift correction, and playback coordination.
 *
 * @class SyncEngine
 * @property {Map<string, SyncClient>} clients - Map of client IDs to SyncClient instances
 * @property {TrackInfo|null} currentTrack - Currently playing track metadata
 * @property {Map} p2pNetwork - Legacy P2P network placeholder
 * @property {Function} masterClock - Monotonic master clock function (returns ms)
 */
class SyncEngine {
  /**
   * Create a new sync engine instance
   */
  constructor() {
    this.clients = new Map();
    this.currentTrack = null;
    this.p2pNetwork = new Map();     // legacy placeholder
    this.masterClock = buildMonotonicClock();
  }

  // ──────────────────────────────────────────────────────────
  // Client management
  // ──────────────────────────────────────────────────────────

  /**
   * Add a new client to the sync engine
   * @param {WebSocket} ws - WebSocket connection
   * @param {string} clientId - Unique client identifier
   * @returns {SyncClient} Created sync client
   */
  addClient(ws, clientId) {
    const client = new SyncClient(ws, clientId);
    this.clients.set(clientId, client);
    return client;
  }

  /**
   * Remove a client from the sync engine
   * @param {string} clientId - Client identifier
   */
  removeClient(clientId) {
    this.clients.delete(clientId);
  }

  /**
   * Get a client by ID
   * @param {string} clientId - Client identifier
   * @returns {SyncClient|null}
   */
  getClient(clientId) {
    return this.clients.get(clientId) || null;
  }

  // ──────────────────────────────────────────────────────────
  // Clock synchronization
  // ──────────────────────────────────────────────────────────

  /**
   * Handle clock sync ping from client
   * @param {string} clientId - Client identifier
   * @param {number} clientNowMs - Client timestamp
   * @returns {object|null} Pong response data
   */
  handleClockPing(clientId, clientNowMs) {
    const client = this.getClient(clientId);
    if (!client) return null;
    const serverNowMs = this.masterClock();
    return {
      t: 'TIME_PONG',
      clientSentTime: clientNowMs,
      serverNowMs,
      clientId,
    };
  }

  /**
   * Process clock sync pong response on client side
   * @param {string} clientId - Client identifier
   * @param {number} sentTime - Original client timestamp when ping was sent
   * @param {number} serverNowMs - Server timestamp from pong
   */
  processClockPong(clientId, sentTime, serverNowMs) {
    const client = this.getClient(clientId);
    if (!client) return;
    const receivedTime = this.masterClock();
    client.updateClockSync(sentTime, serverNowMs, receivedTime);
  }

  // ──────────────────────────────────────────────────────────
  // Playback feedback + PLL drift correction
  // ──────────────────────────────────────────────────────────

  /**
   * Handle playback position feedback from client.
   * Returns a DRIFT_CORRECTION message with backward-compatible fields
   * PLUS new optional fields: { mode, rateDelta, seekToSec }.
   *
   * @param {string} clientId - Client identifier
   * @param {number} position - Current audio.currentTime (seconds)
   * @param {number} trackStart - Server-ms timestamp when track was scheduled
   * @returns {object|null} Drift correction if needed
   */
  handlePlaybackFeedback(clientId, position, trackStart) {
    const client = this.getClient(clientId);
    if (!client || !this.currentTrack) return null;

    client.playbackPosition = position;
    const nowMs = this.masterClock();
    client.lastFeedbackTime = nowMs;

    // Calculate drift: actual position vs expected
    const elapsedMs = nowMs - trackStart;
    const expectedPositionSec = (elapsedMs / 1000) + (this.currentTrack.startPositionSec || 0);
    const drift = (position - expectedPositionSec) * 1000; // ms

    client.updateDrift(drift);
    client.updateLatencyComp(drift);

    // PLL correction decision
    const pll = client.computePLLCorrection(nowMs, expectedPositionSec);

    if (pll.mode === 'none') {
      // Gently return rate to 1.0 if it was correcting
      if (Math.abs(client.smoothedRate - 1.0) > 0.001) {
        const gentleDelta = (client.smoothedRate - 1.0) * (1 - PLAYBACK_RATE_SMOOTH_ALPHA) - (client.smoothedRate - 1.0);
        client.applyPLLRate(gentleDelta + (client.smoothedRate - 1.0));
      }
      return null;
    }

    if (pll.mode === 'seek') {
      // Phase 4: Hard resync with cooldown
      const sinceLastResync = nowMs - client.lastHardResyncTime;
      if (sinceLastResync < HARD_RESYNC_COOLDOWN_MS) {
        // Cooldown active: use rate correction as fallback
        const absDrift = Math.abs(drift);
        const fallbackDelta = absDrift < DRIFT_SOFT_MS ? 0 :
          Math.max(-MAX_RATE_DELTA_UNSTABLE, Math.min(MAX_RATE_DELTA_UNSTABLE, -(drift / 1000 / PLL_HORIZON_SEC)));
        client.applyPLLRate(fallbackDelta);
        return {
          t: 'DRIFT_CORRECTION',
          adjustment: client.playbackRate - 1.0,
          drift,
          playbackRate: client.playbackRate,
          predictedDrift: client.predictedDrift,
          mode: 'rate',
          rateDelta: client.playbackRate - 1.0,
          seekToSec: null,
        };
      }
      // Perform hard seek
      client.lastHardResyncTime = nowMs;
      client.hardResyncCount++;
      client.correctionCount++;
      client.smoothedRate = 1.0;
      client.playbackRate = 1.0;
      return {
        t: 'DRIFT_CORRECTION',
        adjustment: 0,
        drift,
        playbackRate: 1.0,
        predictedDrift: client.predictedDrift,
        mode: 'seek',
        rateDelta: 0,
        seekToSec: pll.seekToSec,
      };
    }

    // mode === 'rate'
    client.applyPLLRate(pll.rateDelta);
    const legacyAdjustment = client.calculateDriftCorrection();

    return {
      t: 'DRIFT_CORRECTION',
      adjustment: legacyAdjustment,
      drift,
      playbackRate: client.playbackRate,
      predictedDrift: client.predictedDrift,
      mode: 'rate',
      rateDelta: pll.rateDelta,
      seekToSec: null,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Track broadcasting
  // ──────────────────────────────────────────────────────────

  /**
   * Broadcast track with precise timestamp.
   * Per-client playAtClient values incorporate learned audioLatencyCompMs.
   *
   * @param {string} trackId - Track identifier
   * @param {number} duration - Track duration in seconds
   * @param {number} startDelay - Delay before playback starts (ms)
   * @param {object} additionalData - Additional track data (url, title, etc.)
   * @returns {object} Broadcast message
   */
  broadcastTrack(trackId, duration, startDelay = DEFAULT_START_DELAY_MS, additionalData = {}) {
    const masterTimestamp = this.masterClock();
    const playAt = masterTimestamp + startDelay;

    this.currentTrack = new TrackInfo(trackId, duration, playAt);
    Object.assign(this.currentTrack, additionalData);

    const broadcast = {
      t: 'PLAY_TRACK',
      trackId,
      playAt,
      duration,
      startDelay,
      ...additionalData,
    };

    // Add per-client clock offset for accurate scheduling
    const clientBroadcasts = new Map();
    this.clients.forEach((client, clientId) => {
      clientBroadcasts.set(clientId, {
        ...broadcast,
        clockOffset: client.clockOffset,
        // Phase 6: incorporate learned latency compensation
        playAtClient: playAt - client.clockOffset - client.audioLatencyCompMs,
      });
    });

    return { broadcast, clientBroadcasts };
  }

  // ──────────────────────────────────────────────────────────
  // Statistics & metrics
  // ──────────────────────────────────────────────────────────

  /**
   * Get sync statistics for monitoring (legacy format, backward compat).
   * @returns {object} Sync statistics
   */
  getSyncStats() {
    const stats = { totalClients: this.clients.size, clients: [] };
    this.clients.forEach((client, clientId) => {
      stats.clients.push({
        clientId,
        clockOffset: client.clockOffset,
        latency: client.latency,
        lastDrift: client.lastDrift,
        predictedDrift: client.predictedDrift,
        networkStability: client.networkStability,
        playbackRate: client.playbackRate,
        playbackPosition: client.playbackPosition,
      });
    });
    return stats;
  }

  /**
   * Get enhanced per-client metrics for /api/sync/metrics endpoint.
   * Includes party-wide drift aggregates.
   *
   * @param {string|null} partyId - Optional party identifier for labeling
   * @returns {object} Enhanced metrics snapshot
   */
  getEnhancedStats(partyId = null) {
    const clientMetrics = [];
    const allDriftAbs = [];

    this.clients.forEach((client) => {
      const m = client.getMetrics();
      clientMetrics.push(m);
      if (typeof m.lastDriftMs === 'number') allDriftAbs.push(Math.abs(m.lastDriftMs));
    });

    return {
      partyId,
      serverTimeMs: this.masterClock(),
      totalClients: this.clients.size,
      party: {
        driftP50Ms: percentile(allDriftAbs, 50),
        driftP95Ms: percentile(allDriftAbs, 95),
        maxDriftMs: allDriftAbs.length ? Math.max(...allDriftAbs) : 0,
      },
      clients: clientMetrics,
    };
  }

  /**
   * Detect clients with significant desync (legacy, backward compat).
   * @returns {Array<{clientId, drift, severity}>}
   */
  getDesyncedClients() {
    const desynced = [];
    this.clients.forEach((client, clientId) => {
      if (Math.abs(client.lastDrift) > DESYNC_THRESHOLD_MS) {
        desynced.push({
          clientId,
          drift: client.lastDrift,
          severity: Math.abs(client.lastDrift) > 200 ? 'critical' : 'warning',
        });
      }
    });
    return desynced;
  }

  /**
   * Calculate adaptive lead time based on network conditions (Phase 9).
   * @param {number} p90Ms - P90 of time_to_ready from metrics (ms)
   * @returns {number} Calculated lead time in milliseconds
   */
  calculateAdaptiveLeadTime(p90Ms = 0) {
    let leadTime = p90Ms;
    const jitterMargin = Math.max(300, leadTime * 0.2);
    leadTime += jitterMargin;

    let avgNetworkStability = 1.0;
    if (this.clients.size > 0) {
      const total = Array.from(this.clients.values())
        .reduce((s, c) => s + c.networkStability, 0);
      avgNetworkStability = total / this.clients.size;
    }

    if (avgNetworkStability < 0.7) {
      leadTime += (1.0 - avgNetworkStability) * 1000;
    }

    return Math.round(Math.max(1500, Math.min(5000, leadTime)));
  }
}

// ============================================================
// P2P Network Management (Skeleton)
// ============================================================

class P2PNetwork {
  constructor() {
    this.peers = new Map();
    this.sessions = new Map();
  }

  /**
   * Discover peers for a session
   * @param {string} sessionId
   * @returns {Array}
   */
  discoverPeers(sessionId) {
    const peers = this.sessions.get(sessionId);
    return peers ? Array.from(peers) : [];
  }

  /**
   * Add peer to session
   * @param {string} sessionId
   * @param {string} peerId
   */
  addPeerToSession(sessionId, peerId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Set());
    }
    this.sessions.get(sessionId).add(peerId);
    this.peers.set(peerId, {
      sessionId,
      latency: 0,
      lastSeen: Date.now(),
      status: 'connected',
    });
  }

  /**
   * Remove peer from session
   * @param {string} sessionId
   * @param {string} peerId
   */
  removePeerFromSession(sessionId, peerId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.delete(peerId);
      if (session.size === 0) this.sessions.delete(sessionId);
    }
    this.peers.delete(peerId);
  }

  /**
   * Select optimal peer based on latency
   * @param {string} sessionId
   * @returns {string|null}
   */
  selectOptimalPeer(sessionId) {
    const peers = this.discoverPeers(sessionId);
    if (!peers.length) return null;
    let optimalPeer = peers[0];
    let minLatency = this.peers.get(optimalPeer)?.latency || Infinity;
    peers.forEach(peerId => {
      const peer = this.peers.get(peerId);
      if (peer && peer.latency < minLatency) {
        minLatency = peer.latency;
        optimalPeer = peerId;
      }
    });
    return optimalPeer;
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  SyncEngine,
  SyncClient,
  TrackInfo,
  P2PNetwork,
  // Export math helpers for unit tests
  _math: { median, percentile, mean, stddev },
};
