/**
 * Time Synchronisation Module (Client-Side)
 *
 * Implements NTP-style clock synchronisation for accurate server-time authority.
 *
 * Features:
 * - Multi-sample clock sync with RTT filtering
 * - Exponentially weighted moving average (EWMA) for stability
 * - Fast-burst sync on initial connect / reconnect (many rapid pings)
 * - Adaptive periodic resync: slow when stable, fast when jitter worsens
 * - Confidence / stability score (0–1) exposed as metrics
 * - RTT p95 exposed for observability
 * - Quality metrics and monitoring
 *
 * Architecture:
 * - On connect: fast burst (BURST_SAMPLES pings, 200ms apart) → steady state
 * - Steady state: resync every resyncIntervalMs (adaptive: 15-60s)
 * - Quality tracking: confidence score drives cadence
 */

class TimeSync {
  constructor() {
    // Server clock offset: serverTime = localTime + offset
    this.serverOffsetMs = 0;

    // Sync state
    this.isInitialized = false;
    this.syncInProgress = false;
    this.lastSyncTime = 0;

    // Sample tracking for multi-sample sync
    this.sampleCount = 0;
    this.targetSamples = 5;    // Samples for initial burst
    this.samples = [];         // Array of { offset, rtt, timestamp }

    // Pending ping tracking
    this.pendingPings = new Map(); // pingId -> { clientSendMs, callback }
    this.pingIdCounter = 0;

    // Resync interval management
    this.resyncInterval = null;
    this.resyncIntervalMs = 30000; // 30 seconds (adjusted adaptively)
    this._minResyncIntervalMs = 15000;  // Fastest: 15 s
    this._maxResyncIntervalMs = 60000;  // Slowest: 60 s

    // Quality metrics
    this.metrics = {
      totalSyncs: 0,
      failedSyncs: 0,
      avgRtt: 0,
      maxRtt: 0,
      minRtt: Infinity,
      offsetStdDev: 0,
      rttP95Ms: 0,
      confidence: 0,          // 0–1 stability score
      lastSyncQuality: 'unknown', // excellent, good, fair, poor
    };

    // Configuration
    this.config = {
      maxRttMs: 800,           // Reject samples with RTT > 800ms
      excellentRttMs: 100,     // RTT < 100ms = excellent
      goodRttMs: 200,          // RTT < 200ms = good
      fairRttMs: 400,          // RTT < 400ms = fair
      ewmaAlpha: 0.2,          // Weight for new samples (0–1)
      minSamplesForInit: 3,    // Minimum successful samples for initialisation
      burstSamples: 8,         // Rapid pings on connect/reconnect
      burstIntervalMs: 200,    // Interval between burst pings
    };

    // Debug mode
    this.debug = typeof localStorage !== 'undefined' &&
      localStorage.getItem('DEBUG_TIME_SYNC') === 'true';
  }

  /**
   * Get current server time using synchronised offset.
   * @returns {number} Server timestamp in milliseconds
   */
  now() {
    return Date.now() + this.serverOffsetMs;
  }

  /**
   * Start initial multi-sample synchronisation (fast burst).
   * @param {WebSocket} ws - WebSocket connection
   * @returns {Promise<boolean>} Success status
   */
  async initialize(ws) {
    if (this.syncInProgress) {
      console.warn('[TimeSync] Sync already in progress');
      return false;
    }

    if (this.debug) {
      console.log('[TimeSync] Starting initial synchronisation (burst mode)...');
    }

    this.syncInProgress = true;
    this.samples = [];
    this.sampleCount = 0;

    return new Promise((resolve) => {
      const sampleInterval = setInterval(() => {
        if (this.sampleCount >= this.targetSamples) {
          clearInterval(sampleInterval);
          this.syncInProgress = false;

          const success = this._processSamples();
          if (success) {
            this.isInitialized = true;
            this.lastSyncTime = Date.now();
            this._scheduleNextResync(ws);

            if (this.debug) {
              console.log('[TimeSync] Initialisation complete:', {
                offset: this.serverOffsetMs.toFixed(2),
                samples: this.samples.length,
                quality: this.metrics.lastSyncQuality,
                confidence: this.metrics.confidence.toFixed(2),
              });
            }
          }

          resolve(success);
          return;
        }

        this._sendPing(ws, (success) => {
          if (success) this.sampleCount++;
        });
      }, this.config.burstIntervalMs);
    });
  }

  /**
   * Perform a single synchronisation sample.
   * @param {WebSocket} ws - WebSocket connection
   * @returns {Promise<boolean>} Success status
   */
  async sync(ws) {
    return new Promise((resolve) => {
      this._sendPing(ws, (success) => {
        if (success) {
          this.lastSyncTime = Date.now();
          this.metrics.totalSyncs++;
          this._updateAdaptiveCadence(ws);
        } else {
          this.metrics.failedSyncs++;
        }
        resolve(success);
      });
    });
  }

  /**
   * Send a TIME_PING to the server.
   * @private
   */
  _sendPing(ws, callback) {
    const pingId = this.pingIdCounter++;
    const clientSendMs = Date.now();

    this.pendingPings.set(pingId, { clientSendMs, callback });

    setTimeout(() => {
      if (this.pendingPings.has(pingId)) {
        this.pendingPings.delete(pingId);
        callback(false);
        if (this.debug) console.warn('[TimeSync] Ping timeout:', pingId);
      }
    }, 5000);

    const msg = { t: 'TIME_PING', clientNowMs: clientSendMs, pingId };

    const OPEN = (typeof WebSocket !== 'undefined') ? WebSocket.OPEN : 1;
    if (ws.readyState === OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      this.pendingPings.delete(pingId);
      callback(false);
    }
  }

  /**
   * Handle TIME_PONG response from server.
   * @param {object} msg - TIME_PONG message
   */
  handlePong(msg) {
    const clientReceiveMs = Date.now();

    const pingData = this.pendingPings.get(msg.pingId);
    if (!pingData) {
      if (this.debug) console.warn('[TimeSync] Unknown ping ID:', msg.pingId);
      return;
    }

    this.pendingPings.delete(msg.pingId);

    const clientSendMs = pingData.clientSendMs;
    const rttMs = clientReceiveMs - clientSendMs;

    if (rttMs > this.config.maxRttMs) {
      if (this.debug) console.log('[TimeSync] Rejecting sample — RTT too high:', rttMs);
      pingData.callback(false);
      return;
    }

    const estimatedServerNowMs = msg.serverNowMs + rttMs / 2;
    const offset = estimatedServerNowMs - clientReceiveMs;

    const sample = { offset, rtt: rttMs, timestamp: Date.now() };
    this.samples.push(sample);
    if (this.samples.length > 20) this.samples.shift();

    this._updateMetrics(rttMs);

    if (!this.isInitialized) {
      this.serverOffsetMs = offset;
    } else {
      const alpha = this.config.ewmaAlpha;
      this.serverOffsetMs = (1 - alpha) * this.serverOffsetMs + alpha * offset;
    }

    this._updateConfidence();

    if (this.debug) {
      console.log('[TimeSync] Sample:', {
        offset: offset.toFixed(2),
        smoothed: this.serverOffsetMs.toFixed(2),
        rtt: rttMs.toFixed(2),
        quality: this._getQuality(rttMs),
        confidence: this.metrics.confidence.toFixed(2),
      });
    }

    pingData.callback(true, offset, rttMs);
  }

  /**
   * Process collected samples to determine best offset.
   * @private
   * @returns {boolean} Success status
   */
  _processSamples() {
    if (this.samples.length < this.config.minSamplesForInit) {
      console.error('[TimeSync] Insufficient samples:', this.samples.length);
      return false;
    }

    const sortedSamples = this.samples.slice().sort((a, b) => a.rtt - b.rtt);
    const bestCount = Math.max(1, Math.floor(sortedSamples.length * 0.6));
    const bestSamples = sortedSamples.slice(0, bestCount);

    const offsets = bestSamples.map(s => s.offset).sort((a, b) => a - b);
    const medianIndex = Math.floor(offsets.length / 2);
    const medianOffset = offsets.length % 2 === 0
      ? (offsets[medianIndex - 1] + offsets[medianIndex]) / 2
      : offsets[medianIndex];

    this.serverOffsetMs = medianOffset;

    const mean = offsets.reduce((sum, o) => sum + o, 0) / offsets.length;
    const variance = offsets.reduce((sum, o) => sum + (o - mean) ** 2, 0) / offsets.length;
    this.metrics.offsetStdDev = Math.sqrt(variance);

    const avgRtt = bestSamples.reduce((sum, s) => sum + s.rtt, 0) / bestSamples.length;
    this.metrics.lastSyncQuality = this._getQuality(avgRtt);

    this._updateConfidence();

    if (this.debug) {
      console.log('[TimeSync] Processed samples:', {
        total: this.samples.length,
        used: bestSamples.length,
        offset: this.serverOffsetMs.toFixed(2),
        stdDev: this.metrics.offsetStdDev.toFixed(2),
        avgRtt: avgRtt.toFixed(2),
        quality: this.metrics.lastSyncQuality,
        confidence: this.metrics.confidence.toFixed(2),
      });
    }

    return true;
  }

  /**
   * Compute confidence score (0–1) from current samples.
   * Higher confidence = lower RTT variance and smaller offset stddev.
   * @private
   */
  _updateConfidence() {
    if (this.samples.length < 3) {
      this.metrics.confidence = 0;
      return;
    }

    // RTT p95
    const rtts = this.samples.map(s => s.rtt).sort((a, b) => a - b);
    const p95idx = Math.max(0, Math.ceil(0.95 * rtts.length) - 1);
    this.metrics.rttP95Ms = rtts[p95idx];

    const avgRtt = rtts.reduce((s, v) => s + v, 0) / rtts.length;
    const offsets = this.samples.map(s => s.offset);
    const meanOff = offsets.reduce((s, v) => s + v, 0) / offsets.length;
    const sd = Math.sqrt(offsets.reduce((s, v) => s + (v - meanOff) ** 2, 0) / offsets.length);

    this.metrics.offsetStdDev = sd;

    // Score: penalise for high RTT and high offset variance
    const rttScore = Math.max(0, 1 - avgRtt / this.config.maxRttMs);
    const sdScore = Math.max(0, 1 - sd / 100);
    this.metrics.confidence = Math.min(1, (rttScore * 0.6 + sdScore * 0.4));
    this.metrics.lastSyncQuality = this._getQuality(avgRtt);
  }

  /**
   * Schedule the next periodic resync using adaptive cadence.
   * Confidence ≥ 0.9 → slow (max interval); confidence < 0.5 → fast (min interval).
   * @private
   */
  _scheduleNextResync(ws) {
    if (this.resyncInterval) {
      clearInterval(this.resyncInterval);
      this.resyncInterval = null;
    }

    this._adaptAndSchedule(ws);
  }

  /**
   * Compute and apply the next resync delay.
   * @private
   */
  _adaptAndSchedule(ws) {
    if (this.resyncInterval) {
      clearInterval(this.resyncInterval);
      this.resyncInterval = null;
    }

    const confidence = this.metrics.confidence || 0;
    const range = this._maxResyncIntervalMs - this._minResyncIntervalMs;
    this.resyncIntervalMs = Math.round(this._minResyncIntervalMs + confidence * range);

    this.resyncInterval = setInterval(() => {
      if (!this.syncInProgress) {
        this.sync(ws).then(() => this._adaptAndSchedule(ws)).catch(() => {});
        clearInterval(this.resyncInterval);
        this.resyncInterval = null;
      }
    }, this.resyncIntervalMs);

    if (this.debug) {
      console.log(`[TimeSync] Next resync in ${(this.resyncIntervalMs / 1000).toFixed(1)}s (confidence: ${confidence.toFixed(2)})`);
    }
  }

  /**
   * Update adaptive cadence after each successful sync.
   * Re-accelerates cadence if confidence drops.
   * @private
   */
  _updateAdaptiveCadence(ws) {
    // If confidence degraded, re-schedule at shorter interval
    if (this.metrics.confidence < 0.5) {
      this._adaptAndSchedule(ws);
    }
  }

  /**
   * Update quality metrics.
   * @private
   */
  _updateMetrics(rttMs) {
    this.metrics.maxRtt = Math.max(this.metrics.maxRtt, rttMs);
    this.metrics.minRtt = Math.min(this.metrics.minRtt, rttMs);
    this.metrics.avgRtt = this.metrics.avgRtt === 0
      ? rttMs
      : 0.9 * this.metrics.avgRtt + 0.1 * rttMs;
  }

  /**
   * Determine sync quality based on RTT.
   * @private
   */
  _getQuality(rttMs) {
    if (rttMs < this.config.excellentRttMs) return 'excellent';
    if (rttMs < this.config.goodRttMs) return 'good';
    if (rttMs < this.config.fairRttMs) return 'fair';
    return 'poor';
  }

  /**
   * Get current metrics including confidence and RTT p95.
   * @returns {object} Sync metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      isInitialized: this.isInitialized,
      serverOffsetMs: this.serverOffsetMs,
      resyncIntervalMs: this.resyncIntervalMs,
      lastSyncAgo: Date.now() - this.lastSyncTime,
      sampleCount: this.samples.length,
    };
  }

  /**
   * Stop periodic resync.
   */
  stop() {
    if (this.resyncInterval) {
      clearInterval(this.resyncInterval);
      this.resyncInterval = null;
    }
  }

  /**
   * Reset all state.
   */
  reset() {
    this.stop();
    this.serverOffsetMs = 0;
    this.isInitialized = false;
    this.syncInProgress = false;
    this.samples = [];
    this.pendingPings.clear();
    this.sampleCount = 0;
    this.metrics.confidence = 0;
    this.metrics.rttP95Ms = 0;
  }
}

// Export singleton instance
const timeSync = new TimeSync();
