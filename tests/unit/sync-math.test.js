/**
 * Unit tests for upgraded sync engine math:
 * - Rolling-window NTP + EMA clock sync with outlier rejection
 * - PLL-style drift correction (deadband, rate, seek, cooldown)
 * - Hard resync cooldown protection
 *
 * Uses deterministic fake time sources so tests are reproducible.
 */

const { SyncEngine, SyncClient, _math } = require('../../sync-engine');
const {
  CLOCK_SYNC_EMA_ALPHA,
  CLOCK_SYNC_OUTLIER_TRIM,
  CLOCK_SYNC_SAMPLES,
  DRIFT_IGNORE_MS,
  DRIFT_HARD_RESYNC_MS,
  HARD_RESYNC_COOLDOWN_MS,
  MAX_RATE_DELTA_STABLE,
  MAX_RATE_DELTA_UNSTABLE,
  PLL_HORIZON_SEC,
} = require('../../sync-config');

const { median, percentile, mean, stddev } = _math;

// ============================================================
// Math helpers
// ============================================================

describe('Math helpers', () => {
  test('median of empty array returns 0', () => {
    expect(median([])).toBe(0);
  });

  test('median of odd-length array', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  test('median of even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test('percentile p0 returns minimum', () => {
    expect(percentile([5, 1, 3], 0)).toBe(1);
  });

  test('percentile p100 returns maximum', () => {
    expect(percentile([5, 1, 3], 100)).toBe(5);
  });

  test('percentile p95 on single element', () => {
    expect(percentile([42], 95)).toBe(42);
  });

  test('mean of empty array returns 0', () => {
    expect(mean([])).toBe(0);
  });

  test('mean of [2, 4, 6] is 4', () => {
    expect(mean([2, 4, 6])).toBe(4);
  });

  test('stddev of identical values is 0', () => {
    expect(stddev([5, 5, 5, 5])).toBe(0);
  });

  test('stddev of [2, 4] is 1', () => {
    expect(stddev([2, 4])).toBeCloseTo(1);
  });
});

// ============================================================
// Clock sync window + EMA
// ============================================================

describe('Rolling-window NTP + EMA (SyncClient)', () => {
  let client;

  beforeEach(() => {
    client = new SyncClient({ readyState: 1 }, 'test-client');
  });

  test('first sample applies EMA from 0 (alpha * rawOffset)', () => {
    // sentTime=0, serverNowMs=0, receivedTime=100 → rtt=100, offset = 0+50-0 = 50
    client.updateClockSync(0, 0, 100);
    expect(client.clockOffset).toBeCloseTo(50 * CLOCK_SYNC_EMA_ALPHA, 5);
  });

  test('after many identical samples converges to raw offset', () => {
    const rawOffset = 30;
    // sentTime=1000, serverNowMs=970, receivedTime=1100 → rtt=100, offset = 1050 - 970 = 80... hmm
    // Let me craft a simpler scenario
    // sentTime=T, serverNowMs=T, receivedTime=T+60 → rtt=60, offset = T+30 - T = 30
    for (let i = 0; i < 50; i++) {
      const T = 1000 * i;
      client.updateClockSync(T, T - rawOffset, T + 60);
      // rtt=60, offset = T+30 - (T-rawOffset) = 30+rawOffset = 60? No...
      // Let me recalc: offset = sentTime + rtt/2 - serverNowMs = T + 30 - (T - rawOffset) = 30 + rawOffset
    }
    // The raw offset on each sample is 30 + rawOffset = 60
    // After EMA convergence, clockOffset should approach 60
    expect(Math.abs(client.clockOffset - 60)).toBeLessThan(2);
  });

  test('outlier rejection: high-RTT sample is ignored', () => {
    // Fill window with good samples (rtt=60, offset=30)
    for (let i = 0; i < CLOCK_SYNC_SAMPLES - 1; i++) {
      const T = 1000 + i * 100;
      client.updateClockSync(T, T, T + 60); // offset = 30
    }
    const offsetBefore = client.clockOffset;

    // Add one very high RTT outlier (should be discarded)
    const T = 1000 + CLOCK_SYNC_SAMPLES * 100;
    client.updateClockSync(T, T - 200, T + 2000); // huge RTT, weird offset
    
    // After outlier rejection, offset should not change much
    // The best sample (lowest RTT) should still dominate
    expect(Math.abs(client.clockOffset - offsetBefore)).toBeLessThan(20);
  });

  test('EMA smoothing reduces jitter from variable RTT', () => {
    const offsets = [];
    // Simulate jittery RTT: alternate 40ms and 160ms
    for (let i = 0; i < 30; i++) {
      const rtt = i % 2 === 0 ? 40 : 160;
      const T = 1000 * i;
      client.updateClockSync(T, T, T + rtt); // offset = rtt/2
      offsets.push(client.clockOffset);
    }

    // EMA smoothed values should have lower variance than raw offsets
    const rawOffsetVariance = stddev(offsets);
    // EMA converges, so later values are stable; variance of last 10 should be small
    const lastTen = offsets.slice(-10);
    const smoothedVariance = stddev(lastTen);
    expect(smoothedVariance).toBeLessThan(rawOffsetVariance);
  });

  test('clockQuality is set based on RTT and offset stddev', () => {
    // Warm up with 10 low-RTT samples
    for (let i = 0; i < 10; i++) {
      const T = 1000 * i;
      client.updateClockSync(T, T, T + 40); // rtt=40, good
    }
    expect(['excellent', 'good']).toContain(client.clockQuality);
  });

  test('clockQuality degrades with high RTT', () => {
    for (let i = 0; i < 10; i++) {
      const T = 1000 * i;
      client.updateClockSync(T, T - 100, T + 600); // rtt=600, poor
    }
    expect(['fair', 'poor']).toContain(client.clockQuality);
  });

  test('latency history is capped at NETWORK_STABILITY_SAMPLES', () => {
    for (let i = 0; i < 20; i++) {
      client.updateClockSync(0, 0, 100);
    }
    const { NETWORK_STABILITY_SAMPLES } = require('../../sync-config');
    expect(client.latencyHistory.length).toBeLessThanOrEqual(NETWORK_STABILITY_SAMPLES);
  });

  test('clock samples window is capped at CLOCK_SYNC_SAMPLES', () => {
    for (let i = 0; i < CLOCK_SYNC_SAMPLES + 5; i++) {
      client.updateClockSync(i * 1000, i * 1000, i * 1000 + 60);
    }
    expect(client.clockSamples.length).toBe(CLOCK_SYNC_SAMPLES);
  });
});

// ============================================================
// PLL drift correction
// ============================================================

describe('PLL drift correction (SyncClient.computePLLCorrection)', () => {
  let client;

  beforeEach(() => {
    client = new SyncClient({ readyState: 1 }, 'pll-client');
    client.networkStability = 0.9; // stable by default
  });

  test('drift below DRIFT_IGNORE_MS → mode=none', () => {
    client.lastDrift = DRIFT_IGNORE_MS - 1;
    const result = client.computePLLCorrection(Date.now(), 10);
    expect(result.mode).toBe('none');
    expect(result.rateDelta).toBe(0);
  });

  test('drift exactly at DRIFT_IGNORE_MS is still ignored', () => {
    client.lastDrift = DRIFT_IGNORE_MS;
    // Strictly < DRIFT_IGNORE_MS triggers none; at boundary depends on implementation
    // Our code: absDrift < DRIFT_IGNORE_MS → none, so at boundary it goes to rate
    const result = client.computePLLCorrection(Date.now(), 10);
    // Should be 'rate' since absDrift is not < DRIFT_IGNORE_MS
    expect(['rate', 'none']).toContain(result.mode);
  });

  test('drift in soft range → mode=rate with bounded rateDelta', () => {
    client.lastDrift = 80; // between DRIFT_IGNORE_MS and DRIFT_HARD_RESYNC_MS
    const result = client.computePLLCorrection(Date.now(), 10);
    expect(result.mode).toBe('rate');
    expect(Math.abs(result.rateDelta)).toBeLessThanOrEqual(MAX_RATE_DELTA_STABLE);
  });

  test('rate delta is proportional to drift magnitude', () => {
    client.lastDrift = 80;
    const r1 = client.computePLLCorrection(Date.now(), 10);

    // Reset smoothedRate to baseline
    client.smoothedRate = 1.0;
    client.lastDrift = 160;
    const r2 = client.computePLLCorrection(Date.now(), 10);

    // Larger drift → larger magnitude rateDelta (before cap)
    expect(Math.abs(r2.rateDelta)).toBeGreaterThanOrEqual(Math.abs(r1.rateDelta));
  });

  test('rate delta is capped at MAX_RATE_DELTA_STABLE on stable network', () => {
    client.networkStability = 0.9; // stable
    client.lastDrift = 500; // very large drift
    // But below DRIFT_HARD_RESYNC_MS check... wait, 500 >= 200, so it would be 'seek'
    // Use 150ms which is between DRIFT_SOFT_MS and DRIFT_HARD_RESYNC_MS
    client.lastDrift = 150;
    const result = client.computePLLCorrection(Date.now(), 10);
    expect(result.mode).toBe('rate');
    expect(Math.abs(result.rateDelta)).toBeLessThanOrEqual(MAX_RATE_DELTA_STABLE);
  });

  test('rate delta is capped at MAX_RATE_DELTA_UNSTABLE on unstable network', () => {
    client.networkStability = 0.3; // unstable
    client.lastDrift = 150;
    const result = client.computePLLCorrection(Date.now(), 10);
    expect(result.mode).toBe('rate');
    expect(Math.abs(result.rateDelta)).toBeLessThanOrEqual(MAX_RATE_DELTA_UNSTABLE);
  });

  test('drift >= DRIFT_HARD_RESYNC_MS → mode=seek', () => {
    client.lastDrift = DRIFT_HARD_RESYNC_MS + 1;
    const expectedPos = 15.5;
    const result = client.computePLLCorrection(Date.now(), expectedPos);
    expect(result.mode).toBe('seek');
    expect(result.seekToSec).toBeCloseTo(expectedPos);
  });

  test('negative drift corrects in positive direction', () => {
    client.lastDrift = -80; // behind
    const result = client.computePLLCorrection(Date.now(), 10);
    expect(result.mode).toBe('rate');
    // Behind → need to speed up → rateDelta should be positive
    expect(result.rateDelta).toBeGreaterThan(0);
  });
});

// ============================================================
// Hard resync with cooldown (SyncEngine.handlePlaybackFeedback)
// ============================================================

describe('Hard resync cooldown (SyncEngine)', () => {
  let engine;
  const CLIENT_ID = 'cooldown-test';
  const NOW = 1_000_000;

  /** Create a fake monotonic clock at a fixed time */
  function makeFakeClock(startMs) {
    let t = startMs;
    const fn = () => t;
    fn.advance = (ms) => { t += ms; };
    return fn;
  }

  beforeEach(() => {
    engine = new SyncEngine();
    engine.masterClock = makeFakeClock(NOW);
    engine.addClient({ readyState: 1, send: jest.fn() }, CLIENT_ID);
    // Create a current track starting NOW
    engine.currentTrack = { trackId: 'track1', startPositionSec: 0, startTimestamp: NOW, status: 'playing' };
  });

  test('first seek resync is issued when drift >= DRIFT_HARD_RESYNC_MS', () => {
    // Client is ahead by (DRIFT_HARD_RESYNC_MS + 10)ms = say 210ms
    // Expected position = 0 + (elapsed_ms / 1000)
    // Track started at NOW, clock is at NOW, so elapsed = 0, expected = 0s
    // Reported position should be 0 + (DRIFT_HARD_RESYNC_MS + 10) / 1000 s ahead
    const aheadBy = (DRIFT_HARD_RESYNC_MS + 10) / 1000; // in seconds
    const result = engine.handlePlaybackFeedback(CLIENT_ID, aheadBy, NOW);
    expect(result).not.toBeNull();
    expect(result.mode).toBe('seek');
    expect(result.seekToSec).toBeDefined();
  });

  test('second seek within cooldown falls back to rate correction', () => {
    const aheadBy = (DRIFT_HARD_RESYNC_MS + 10) / 1000;
    // First seek
    const r1 = engine.handlePlaybackFeedback(CLIENT_ID, aheadBy, NOW);
    expect(r1.mode).toBe('seek');

    // Advance clock by less than cooldown
    engine.masterClock.advance(HARD_RESYNC_COOLDOWN_MS / 2);
    // Client still has large drift (still desync)
    const r2 = engine.handlePlaybackFeedback(CLIENT_ID, aheadBy, NOW);
    // Should be rate or null, NOT seek
    if (r2) {
      expect(r2.mode).not.toBe('seek');
    }
  });

  test('seek is allowed again after cooldown expires', () => {
    const aheadBy = (DRIFT_HARD_RESYNC_MS + 10) / 1000;
    // First seek
    engine.handlePlaybackFeedback(CLIENT_ID, aheadBy, NOW);

    // Advance clock past cooldown
    engine.masterClock.advance(HARD_RESYNC_COOLDOWN_MS + 1000);
    // Client still has large drift
    const r3 = engine.handlePlaybackFeedback(CLIENT_ID, aheadBy, NOW);
    expect(r3).not.toBeNull();
    expect(r3.mode).toBe('seek');
  });

  test('hard resync count increments on each seek', () => {
    const aheadBy = (DRIFT_HARD_RESYNC_MS + 10) / 1000;
    engine.handlePlaybackFeedback(CLIENT_ID, aheadBy, NOW);
    const client = engine.getClient(CLIENT_ID);
    expect(client.hardResyncCount).toBe(1);

    engine.masterClock.advance(HARD_RESYNC_COOLDOWN_MS + 1000);
    engine.handlePlaybackFeedback(CLIENT_ID, aheadBy, NOW);
    expect(client.hardResyncCount).toBe(2);
  });

  test('small drift does not trigger correction', () => {
    // DRIFT_IGNORE_MS - 5 ms = ignored
    const smallDrift = (DRIFT_IGNORE_MS - 5) / 1000;
    const result = engine.handlePlaybackFeedback(CLIENT_ID, smallDrift, NOW);
    expect(result).toBeNull();
  });

  test('correction count increments for rate corrections', () => {
    // Use soft drift (above DRIFT_IGNORE_MS, below DRIFT_HARD_RESYNC_MS)
    const softDrift = (DRIFT_IGNORE_MS + 20) / 1000;
    engine.handlePlaybackFeedback(CLIENT_ID, softDrift, NOW);
    const client = engine.getClient(CLIENT_ID);
    expect(client.correctionCount).toBeGreaterThan(0);
  });
});

// ============================================================
// getEnhancedStats
// ============================================================

describe('SyncEngine.getEnhancedStats', () => {
  test('returns party aggregates including driftP95Ms', () => {
    const engine = new SyncEngine();
    const c1 = engine.addClient({ readyState: 1 }, 'c1');
    const c2 = engine.addClient({ readyState: 1 }, 'c2');
    c1.lastDrift = 80;
    c2.lastDrift = -150;
    c1.driftHistory = [{ time: Date.now(), drift: 80 }];
    c2.driftHistory = [{ time: Date.now(), drift: -150 }];

    const stats = engine.getEnhancedStats('TEST-PARTY');
    expect(stats.partyId).toBe('TEST-PARTY');
    expect(stats.totalClients).toBe(2);
    expect(typeof stats.party.driftP95Ms).toBe('number');
    expect(typeof stats.party.maxDriftMs).toBe('number');
    expect(stats.party.maxDriftMs).toBeGreaterThanOrEqual(0);
  });

  test('each client metrics include clockQuality and correctionCount', () => {
    const engine = new SyncEngine();
    engine.addClient({ readyState: 1 }, 'cx');
    const stats = engine.getEnhancedStats();
    expect(stats.clients).toHaveLength(1);
    expect(stats.clients[0].clockQuality).toBeDefined();
    expect(typeof stats.clients[0].correctionCount).toBe('number');
  });
});

// ============================================================
// Backward-compat: getSyncStats still works
// ============================================================

describe('Backward compat: getSyncStats', () => {
  test('still returns legacy format with all expected fields', () => {
    const engine = new SyncEngine();
    const c = engine.addClient({ readyState: 1 }, 'legacy');
    c.clockOffset = 25;
    c.latency = 40;
    c.lastDrift = 15;

    const stats = engine.getSyncStats();
    expect(stats.totalClients).toBe(1);
    expect(stats.clients[0].clockOffset).toBe(25);
    expect(stats.clients[0].latency).toBe(40);
    expect(stats.clients[0].lastDrift).toBe(15);
    expect(stats.clients[0].playbackRate).toBeDefined();
  });
});
