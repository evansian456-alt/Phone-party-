/**
 * SyncSpeaker Ultimate AmpSync+ Engine
 * 
 * High-precision multi-device audio/video synchronization system
 * Features:
 * - Monotonic server clock (process.hrtime.bigint-based)
 * - NTP-style rolling-window clock offset estimation with outlier rejection + EMA
 * - PLL-style drift correction (deadband, horizon, rate smoothing, caps)
 * - Safe hard resync (seek) with cooldown protection
 * - Per-device learned audio latency compensation (test-mode gated)
 * - Per-party sync metrics collection
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
  AUDIO_LATENCY_COMP_MAX_MS,
  AUDIO_LATENCY_COMP_LEARN_ALPHA,
  NETWORK_STABILITY_SAMPLES,
  NETWORK_STABILITY_NORMALIZATION_FACTOR,
  DEFAULT_START_DELAY_MS,
  SYNC_TEST_MODE
} = require('./sync-config');

// ============================================================
// Monotonic clock (Phase 1)
// ============================================================

function createMonotonicClock() {
  const baseWall = Date.now();
  const baseMono = process.hrtime.bigint();
  return function nowMs() {
    const deltaNs = process.hrtime.bigint() - baseMono;
    return baseWall + Number(deltaNs) / 1e6;
  };
}

// ============================================================
// NTP math helpers (Phase 2)
// ============================================================

function computeBestOffset(samples) {
  if (!samples || samples.length === 0) return null;
  if (samples.length === 1) return samples[0].offset;
  const sorted = [...samples].sort((a, b) => a.rtt - b.rtt);
  const keepCount = Math.max(1, Math.ceil(sorted.length * (1 - CLOCK_SYNC_OUTLIER_TRIM)));
  const kept = sorted.slice(0, keepCount);
  return kept[0].offset;
}

function computeP95(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.95);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function computeMedian(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function computeStdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// ============================================================
// Client Metadata Structure
// ============================================================

class SyncClient {
  constructor(ws, clientId) {
    this.ws = ws;
    this.clientId = clientId;
    this.clockOffset = 0;
    this.latency = 0;
    this.lastDrift = 0;
    this.driftHistory = [];
    this.peerId = null;
    this.lastPingTime = null;
    this.networkStability = 1.0;
    this.latencyHistory = [];
    this.playbackRate = 1.0;
    this.lastFeedbackTime = null;
    this.playbackPosition = 0;
    this.predictedDrift = 0;

    // Phase 2: Rolling-window NTP
    this._clockSamples = [];
    this._clockOffsetEmaInit = false;

    // Phase 3: PLL state
    this._playbackRateEma = 1.0;
    this._lastRateFlipTime = 0;

    // Phase 4: Hard-resync state
    this.lastHardResync = 0;
    this.hardResyncCount = 0;

    // Phase 6: Learned audio latency compensation
    this.audioLatencyCompMs = 0;
    this._driftBiasSum = 0;
    this._driftBiasCount = 0;

    // Metrics
    this.correctionCount = 0;
    this._rttHistory = [];
  }

  updateClockSync(sentTime, serverNowMs, receivedTime) {
    const roundTripMs = receivedTime - sentTime;
    this.latency = roundTripMs / 2;
    const rawOffset = sentTime + this.latency - serverNowMs;

    this.latencyHistory.push(this.latency);
    if (this.latencyHistory.length > NETWORK_STABILITY_SAMPLES) {
      this.latencyHistory.shift();
    }

    this._rttHistory.push(roundTripMs);
    if (this._rttHistory.length > CLOCK_SYNC_SAMPLES) {
      this._rttHistory.shift();
    }

    if (this.latencyHistory.length >= 3) {
      const mean = this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length;
      const variance = this.latencyHistory.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / this.latencyHistory.length;
      const stdDev = Math.sqrt(variance);
      this.networkStability = Math.max(0, 1 - (stdDev / NETWORK_STABILITY_NORMALIZATION_FACTOR));
    }

    this._clockSamples.push({ rtt: roundTripMs, offset: rawOffset });
    if (this._clockSamples.length > CLOCK_SYNC_SAMPLES) {
      this._clockSamples.shift();
    }

    const bestOffset = computeBestOffset(this._clockSamples);

    if (!this._clockOffsetEmaInit) {
      this.clockOffset = bestOffset !== null ? bestOffset : rawOffset;
      this._clockOffsetEmaInit = true;
    } else {
      this.clockOffset = CLOCK_SYNC_EMA_ALPHA * (bestOffset !== null ? bestOffset : rawOffset)
        + (1 - CLOCK_SYNC_EMA_ALPHA) * this.clockOffset;
    }

    this.lastPingTime = Date.now();
  }

  getAdaptiveSyncInterval() {
    const baseInterval = CLOCK_SYNC_INTERVAL_MS;
    const stabilityFactor = this.networkStability || 1.0;
    const interval = baseInterval + (stabilityFactor * 2000);
    return Math.min(Math.max(interval, CLOCK_SYNC_MIN_INTERVAL_MS), CLOCK_SYNC_MAX_INTERVAL_MS);
  }

  updateDrift(drift) {
    this.lastDrift = drift;
    this.driftHistory.push({ time: Date.now(), drift });
    if (this.driftHistory.length > 20) {
      this.driftHistory.shift();
    }
    if (this.driftHistory.length >= 3) {
      this.predictedDrift = this.calculatePredictedDrift();
    }
    if (SYNC_TEST_MODE) {
      this._driftBiasSum += drift;
      this._driftBiasCount++;
    }
  }

  calculatePredictedDrift() {
    const n = this.driftHistory.length;
    if (n < 3) return this.lastDrift;
    let weightedSum = 0;
    let weightSum = 0;
    for (let i = 0; i < n; i++) {
      const weight = (i + 1) / n;
      weightedSum += this.driftHistory[i].drift * weight;
      weightSum += weight;
    }
    const avgDrift = weightedSum / weightSum;
    return this.lastDrift * 0.7 + avgDrift * 0.3;
  }

  calculateDriftCorrection() {
    const absDrift = Math.abs(this.lastDrift);
    if (absDrift < DRIFT_IGNORE_MS) {
      return 0;
    }
    if (absDrift >= DRIFT_HARD_RESYNC_MS) {
      return 0;
    }
    const driftSec = this.lastDrift / 1000;
    let rateDelta = -(driftSec / PLL_HORIZON_SEC);
    const maxDelta = this.networkStability >= 0.6
      ? MAX_RATE_DELTA_STABLE
      : MAX_RATE_DELTA_UNSTABLE;
    rateDelta = Math.max(-maxDelta, Math.min(maxDelta, rateDelta));
    const now = Date.now();
    const prevSign = Math.sign(this._playbackRateEma - 1.0);
    const newSign = Math.sign(rateDelta);
    if (prevSign !== 0 && newSign !== prevSign && (now - this._lastRateFlipTime) < 2000) {
      rateDelta *= 0.5;
    } else if (prevSign !== newSign) {
      this._lastRateFlipTime = now;
    }
    const targetRate = 1.0 + rateDelta;
    this._playbackRateEma = PLAYBACK_RATE_SMOOTH_ALPHA * targetRate
      + (1 - PLAYBACK_RATE_SMOOTH_ALPHA) * this._playbackRateEma;
    return this._playbackRateEma - 1.0;
  }

  updatePlaybackRate(adjustment) {
    const newRate = 1.0 + adjustment;
    this.playbackRate = Math.max(PLAYBACK_RATE_MIN, Math.min(PLAYBACK_RATE_MAX, newRate));
  }

  getRttP95() { return computeP95(this._rttHistory); }
  getRttMedian() { return computeMedian(this._rttHistory); }
  getClockOffsetStdDev() {
    return computeStdDev(this._clockSamples.map(s => s.offset));
  }

  updateAudioLatencyComp() {
    if (!SYNC_TEST_MODE || this._driftBiasCount < 10) return;
    const avgBias = this._driftBiasSum / this._driftBiasCount;
    const delta = AUDIO_LATENCY_COMP_LEARN_ALPHA * avgBias;
    this.audioLatencyCompMs = Math.max(
      -AUDIO_LATENCY_COMP_MAX_MS,
      Math.min(AUDIO_LATENCY_COMP_MAX_MS, this.audioLatencyCompMs + delta)
    );
    this._driftBiasSum = 0;
    this._driftBiasCount = 0;
  }
}

// ============================================================
// Track Metadata Structure
// ============================================================

class TrackInfo {
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

class SyncEngine {
  constructor() {
    this.clients = new Map();
    this.currentTrack = null;
    this.p2pNetwork = new Map();
    this.masterClock = createMonotonicClock();
    this._metrics = {
      partyStartMs: Date.now(),
      correctionCount: 0,
      hardResyncCount: 0,
      driftSamples: [],
      rateChanges: []
    };
  }

  addClient(ws, clientId) {
    const client = new SyncClient(ws, clientId);
    this.clients.set(clientId, client);
    return client;
  }

  removeClient(clientId) {
    this.clients.delete(clientId);
  }

  getClient(clientId) {
    return this.clients.get(clientId) || null;
  }

  handleClockPing(clientId, clientNowMs) {
    const client = this.getClient(clientId);
    if (!client) return null;
    const serverNowMs = this.masterClock();
    return {
      t: 'TIME_PONG',
      clientSentTime: clientNowMs,
      serverNowMs: serverNowMs,
      clientId: clientId
    };
  }

  processClockPong(clientId, sentTime, serverNowMs) {
    const client = this.getClient(clientId);
    if (!client) return;
    const receivedTime = this.masterClock();
    client.updateClockSync(sentTime, serverNowMs, receivedTime);
  }

  handlePlaybackFeedback(clientId, position, trackStart) {
    const client = this.getClient(clientId);
    if (!client || !this.currentTrack) return null;

    client.playbackPosition = position;
    client.lastFeedbackTime = this.masterClock();

    const elapsedMs = this.masterClock() - trackStart;
    const expectedPosition = (elapsedMs / 1000) + (this.currentTrack.startPositionSec || 0);
    const drift = (position - expectedPosition) * 1000;

    client.updateDrift(drift);

    this._metrics.driftSamples.push({ ts: Date.now(), clientId, driftMs: drift });
    if (this._metrics.driftSamples.length > 500) {
      this._metrics.driftSamples.shift();
    }

    const absDrift = Math.abs(drift);
    const now = Date.now();

    if (absDrift >= DRIFT_HARD_RESYNC_MS) {
      const cooldownElapsed = (now - client.lastHardResync) >= HARD_RESYNC_COOLDOWN_MS;
      if (cooldownElapsed) {
        client.lastHardResync = now;
        client.hardResyncCount++;
        this._metrics.hardResyncCount++;
        const elapsedSec = (this.masterClock() - trackStart) / 1000;
        const seekToSec = (this.currentTrack.startPositionSec || 0) + elapsedSec;
        if (SYNC_TEST_MODE) {
          console.log(JSON.stringify({ level: 'info', event: 'hard_resync', clientId, driftMs: drift, seekToSec }));
        }
        return {
          t: 'DRIFT_CORRECTION',
          mode: 'seek',
          seekToSec: seekToSec,
          drift: drift,
          adjustment: 0,
          playbackRate: 1.0,
          predictedDrift: client.predictedDrift
        };
      }
    }

    const adjustment = client.calculateDriftCorrection();
    client.updatePlaybackRate(adjustment);

    if (SYNC_TEST_MODE) {
      client.updateAudioLatencyComp();
    }

    if (absDrift >= DRIFT_IGNORE_MS) {
      client.correctionCount++;
      this._metrics.correctionCount++;
      this._metrics.rateChanges.push({ ts: now, clientId, rate: client.playbackRate });
      if (this._metrics.rateChanges.length > 500) {
        this._metrics.rateChanges.shift();
      }
      if (SYNC_TEST_MODE) {
        console.log(JSON.stringify({ level: 'info', event: 'drift_correction', clientId, driftMs: drift, playbackRate: client.playbackRate, adjustment }));
      }
      return {
        t: 'DRIFT_CORRECTION',
        mode: 'rate',
        rateDelta: adjustment,
        adjustment: adjustment,
        drift: drift,
        playbackRate: client.playbackRate,
        predictedDrift: client.predictedDrift
      };
    }

    return null;
  }

  broadcastTrack(trackId, duration, startDelay = DEFAULT_START_DELAY_MS, additionalData = {}) {
    const masterTimestamp = this.masterClock();
    const playAt = masterTimestamp + startDelay;

    this.currentTrack = new TrackInfo(trackId, duration, playAt);
    Object.assign(this.currentTrack, additionalData);

    const broadcast = {
      t: 'PLAY_TRACK',
      trackId: trackId,
      playAt: playAt,
      duration: duration,
      startDelay: startDelay,
      ...additionalData
    };

    const clientBroadcasts = new Map();
    this.clients.forEach((client, clientId) => {
      const latencyComp = SYNC_TEST_MODE ? (client.audioLatencyCompMs || 0) : 0;
      clientBroadcasts.set(clientId, {
        ...broadcast,
        clockOffset: client.clockOffset,
        playAtClient: playAt - client.clockOffset - latencyComp
      });
    });

    return { broadcast, clientBroadcasts };
  }

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
        playbackPosition: client.playbackPosition
      });
    });
    return stats;
  }

  getPartyMetrics() {
    const now = Date.now();
    const allDriftMs = this._metrics.driftSamples.map(s => s.driftMs);
    const clientMetrics = [];
    this.clients.forEach((client, clientId) => {
      const clientDrifts = this._metrics.driftSamples
        .filter(s => s.clientId === clientId)
        .map(s => s.driftMs);
      clientMetrics.push({
        clientId,
        rttMedianMs: client.getRttMedian(),
        rttP95Ms: client.getRttP95(),
        clockOffsetMs: client.clockOffset,
        clockOffsetStdDev: client.getClockOffsetStdDev(),
        lastDriftMs: client.lastDrift,
        driftP50Ms: computeMedian(clientDrifts.map(Math.abs)),
        driftP95Ms: computeP95(clientDrifts.map(Math.abs)),
        playbackRate: client.playbackRate,
        correctionCount: client.correctionCount,
        hardResyncCount: client.hardResyncCount,
        networkStability: client.networkStability,
        audioLatencyCompMs: client.audioLatencyCompMs
      });
    });
    const driftAbs = allDriftMs.map(Math.abs);
    return {
      snapshotTs: now,
      uptimeSec: (now - this._metrics.partyStartMs) / 1000,
      totalClients: this.clients.size,
      totalCorrectionCount: this._metrics.correctionCount,
      totalHardResyncCount: this._metrics.hardResyncCount,
      driftP50Ms: computeMedian(driftAbs),
      driftP95Ms: computeP95(driftAbs),
      maxDriftMs: driftAbs.length > 0 ? Math.max(...driftAbs) : 0,
      clients: clientMetrics
    };
  }

  getDesyncedClients() {
    const desynced = [];
    this.clients.forEach((client, clientId) => {
      if (Math.abs(client.lastDrift) > DESYNC_THRESHOLD_MS) {
        desynced.push({
          clientId,
          drift: client.lastDrift,
          severity: Math.abs(client.lastDrift) > 200 ? 'critical' : 'warning'
        });
      }
    });
    return desynced;
  }

  calculateAdaptiveLeadTime(p90Ms = 0) {
    let leadTime = p90Ms;
    const jitterMargin = Math.max(300, leadTime * 0.2);
    leadTime += jitterMargin;
    let avgNetworkStability = 1.0;
    if (this.clients.size > 0) {
      const totalStability = Array.from(this.clients.values())
        .reduce((sum, client) => sum + client.networkStability, 0);
      avgNetworkStability = totalStability / this.clients.size;
    }
    if (avgNetworkStability < 0.7) {
      leadTime += (1.0 - avgNetworkStability) * 1000;
    }
    leadTime = Math.max(1500, Math.min(5000, leadTime));
    return Math.round(leadTime);
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

  discoverPeers(sessionId) {
    const peers = this.sessions.get(sessionId);
    return peers ? Array.from(peers) : [];
  }

  addPeerToSession(sessionId, peerId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Set());
    }
    this.sessions.get(sessionId).add(peerId);
    this.peers.set(peerId, { sessionId, latency: 0, lastSeen: Date.now(), status: 'connected' });
  }

  removePeerFromSession(sessionId, peerId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.delete(peerId);
      if (session.size === 0) this.sessions.delete(sessionId);
    }
    this.peers.delete(peerId);
  }

  selectOptimalPeer(sessionId) {
    const peers = this.discoverPeers(sessionId);
    if (peers.length === 0) return null;
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
  computeBestOffset,
  computeP95,
  computeMedian,
  computeStdDev,
  createMonotonicClock
};
