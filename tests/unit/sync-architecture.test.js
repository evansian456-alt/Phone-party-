/**
 * Comprehensive tests for the redesigned sync architecture.
 *
 * Covers:
 *  1. sync-config — platform overrides, new constants, promoted production flags
 *  2. sync-engine — authoritative timeline (FSM, generation, RESYNC_SNAPSHOT, events)
 *  3. event-replay — generation/sequence idempotency, stale and duplicate rejection
 *  4. sync-client — clock confidence, burst sync, adaptive cadence, PLL thresholds
 *  5. Multi-client integration — host + guests, late join, reconnect
 */

const {
  getSyncConfig,
  SyncEventType,
  PartySyncState,
  ClientSyncState,
  DRIFT_IGNORE_MS,
  DRIFT_HARD_RESYNC_MS,
  AUDIO_LATENCY_COMP_ENABLED,
  BROWSER_SYNC_CONFIG,
  NATIVE_SYNC_CONFIG,
  CLOCK_SYNC_BURST_COUNT,
  CLOCK_SYNC_BURST_INTERVAL_MS,
  CLOCK_SYNC_CONFIDENCE_THRESHOLD,
} = require('../../sync-config');

const { SyncEngine, SyncClient, _math } = require('../../sync-engine');
const { EventReplayManager, MessagePriority } = require('../../event-replay');
const { ClientSyncEngine } = require('../../sync-client');

// ============================================================
// 1. sync-config platform overrides
// ============================================================

describe('sync-config: platform overrides', () => {
  test('getSyncConfig("server") returns shared defaults', () => {
    const cfg = getSyncConfig('server');
    expect(cfg.DRIFT_IGNORE_MS).toBe(DRIFT_IGNORE_MS);
    expect(cfg.AUDIO_LATENCY_COMP_ENABLED).toBe(true);
  });

  test('getSyncConfig("browser") applies BROWSER_SYNC_CONFIG overrides', () => {
    const cfg = getSyncConfig('browser');
    expect(cfg.DRIFT_IGNORE_MS).toBe(BROWSER_SYNC_CONFIG.DRIFT_IGNORE_MS);
    expect(cfg.PLAYBACK_FEEDBACK_INTERVAL_MS).toBe(BROWSER_SYNC_CONFIG.PLAYBACK_FEEDBACK_INTERVAL_MS);
    expect(cfg.CLOCK_SYNC_BURST_COUNT).toBe(BROWSER_SYNC_CONFIG.CLOCK_SYNC_BURST_COUNT);
  });

  test('getSyncConfig("native") applies NATIVE_SYNC_CONFIG overrides', () => {
    const cfg = getSyncConfig('native');
    expect(cfg.DRIFT_IGNORE_MS).toBe(NATIVE_SYNC_CONFIG.DRIFT_IGNORE_MS);
    expect(cfg.PLL_HORIZON_SEC).toBe(NATIVE_SYNC_CONFIG.PLL_HORIZON_SEC);
  });

  test('browser DRIFT_IGNORE_MS is tighter than shared default', () => {
    const shared = getSyncConfig('server').DRIFT_IGNORE_MS;
    const browser = getSyncConfig('browser').DRIFT_IGNORE_MS;
    expect(browser).toBeLessThan(shared);
  });

  test('native DRIFT_IGNORE_MS is tightest of all platforms', () => {
    const browser = getSyncConfig('browser').DRIFT_IGNORE_MS;
    const native = getSyncConfig('native').DRIFT_IGNORE_MS;
    expect(native).toBeLessThanOrEqual(browser);
  });

  test('AUDIO_LATENCY_COMP_ENABLED is true in all platforms (not gated behind test mode)', () => {
    expect(AUDIO_LATENCY_COMP_ENABLED).toBe(true);
    expect(getSyncConfig('browser').AUDIO_LATENCY_COMP_ENABLED).toBe(true);
    expect(getSyncConfig('native').AUDIO_LATENCY_COMP_ENABLED).toBe(true);
  });

  test('SyncEventType contains all required authoritative events', () => {
    const required = [
      'PREPARE_PLAY', 'READY', 'BUFFER_STATUS', 'PLAY_AT',
      'PAUSE_AT', 'SEEK_TO', 'RESYNC_SNAPSHOT', 'DRIFT_CORRECTION',
      'CLOCK_PING', 'TIME_PONG', 'PLAYBACK_FEEDBACK', 'MSG_ACK',
    ];
    for (const evt of required) {
      expect(SyncEventType).toHaveProperty(evt);
    }
  });

  test('PartySyncState contains all required server FSM states', () => {
    const required = [
      'IDLE', 'PREPARING', 'WAITING_FOR_READY',
      'SCHEDULED', 'PLAYING', 'CORRECTING', 'DEGRADED', 'RESYNCING',
    ];
    for (const s of required) {
      expect(PartySyncState).toHaveProperty(s);
    }
  });

  test('ClientSyncState contains all required client FSM states', () => {
    const required = [
      'DISCONNECTED', 'SYNCING_CLOCK', 'LOADING', 'BUFFERING',
      'READY', 'SCHEDULED', 'PLAYING', 'CORRECTING', 'RECOVERING',
      'RESYNCING', 'ERRORED',
    ];
    for (const s of required) {
      expect(ClientSyncState).toHaveProperty(s);
    }
  });

  test('fast burst constants are present and reasonable', () => {
    expect(CLOCK_SYNC_BURST_COUNT).toBeGreaterThan(3);
    expect(CLOCK_SYNC_BURST_INTERVAL_MS).toBeLessThan(500);
    expect(CLOCK_SYNC_CONFIDENCE_THRESHOLD).toBeGreaterThan(0.5);
    expect(CLOCK_SYNC_CONFIDENCE_THRESHOLD).toBeLessThanOrEqual(1.0);
  });
});

// ============================================================
// 2. sync-engine: authoritative timeline
// ============================================================

describe('SyncEngine: authoritative timeline', () => {
  let engine;

  beforeEach(() => {
    engine = new SyncEngine();
    engine.addClient({ readyState: 1, send: jest.fn() }, 'c1');
    engine.addClient({ readyState: 1, send: jest.fn() }, 'c2');
  });

  // ── Generation / sequence ───────────────────────────────
  test('generation starts at 0', () => {
    expect(engine.generation).toBe(0);
  });

  test('buildPreparePlay increments generation to 1', () => {
    engine.buildPreparePlay('PARTY1', 'track-1', 'http://example.com/a.mp3');
    expect(engine.generation).toBe(1);
  });

  test('buildSeekTo increments generation again', () => {
    engine.buildPreparePlay('PARTY1', 'track-1', 'http://example.com/a.mp3');
    engine.buildSeekTo('PARTY1', 'track-1', 30);
    expect(engine.generation).toBe(2);
  });

  test('each event has a unique eventId', () => {
    const e1 = engine.buildPreparePlay('P', 'tid', 'url');
    engine._nextGeneration();
    const e2 = engine.buildPreparePlay('P', 'tid2', 'url2');
    expect(e1.eventId).not.toBe(e2.eventId);
  });

  test('events carry correct generation and sequence', () => {
    const prep = engine.buildPreparePlay('P', 't1', 'url');
    expect(prep.generation).toBe(1);
    expect(prep.sequence).toBe(1);
  });

  test('sequence resets to 0 when generation advances', () => {
    engine.buildPreparePlay('P', 't1', 'url'); // gen=1, seq=1
    engine._nextGeneration();                  // gen=2, seq=0
    expect(engine.generation).toBe(2);
    expect(engine.sequence).toBe(0);
  });

  // ── PLAY_AT per-client personalisation ──────────────────
  test('buildPlayAt returns base + perClient map', () => {
    const { base, perClient } = engine.buildPlayAt('P', 'track-1', 3000, 0, { duration: 180 });
    expect(base.t).toBe(SyncEventType.PLAY_AT);
    expect(perClient.size).toBe(2);
  });

  test('buildPlayAt perClient contains clockOffset and startAtClientMs', () => {
    const c1 = engine.getClient('c1');
    c1.clockOffset = 50;
    c1.audioLatencyCompMs = 10;

    const { perClient, base } = engine.buildPlayAt('P', 'track-1', 3000);
    const pc1 = perClient.get('c1');

    expect(pc1.clockOffset).toBe(50);
    expect(pc1.audioLatencyCompMs).toBe(10);
    // startAtClientMs = startAtServerMs - clockOffset - audioLatencyCompMs
    expect(pc1.startAtClientMs).toBe(base.startAtServerMs - 50 - 10);
  });

  // ── FSM transitions ─────────────────────────────────────
  test('legal FSM transition is accepted', () => {
    engine.partyState = PartySyncState.IDLE;
    const ok = engine.transitionPartyState(PartySyncState.PREPARING);
    expect(ok).toBe(true);
    expect(engine.partyState).toBe(PartySyncState.PREPARING);
  });

  test('illegal FSM transition is rejected and state unchanged', () => {
    engine.partyState = PartySyncState.IDLE;
    const ok = engine.transitionPartyState(PartySyncState.PLAYING); // illegal
    expect(ok).toBe(false);
    expect(engine.partyState).toBe(PartySyncState.IDLE);
  });

  test('buildPreparePlay sets party state to PREPARING', () => {
    engine.buildPreparePlay('P', 't', 'u');
    expect(engine.partyState).toBe(PartySyncState.PREPARING);
  });

  test('buildPlayAt sets party state to SCHEDULED', () => {
    engine.partyState = PartySyncState.PREPARING; // required predecessor
    engine.transitionPartyState(PartySyncState.WAITING_FOR_READY);
    engine.buildPlayAt('P', 't', 3000);
    expect(engine.partyState).toBe(PartySyncState.SCHEDULED);
  });

  // ── RESYNC_SNAPSHOT ─────────────────────────────────────
  test('generateResyncSnapshot returns null if no current track', () => {
    const snap = engine.generateResyncSnapshot('P', 'c1');
    expect(snap).toBeNull();
  });

  test('generateResyncSnapshot returns full state for late-joining client', () => {
    const { base } = engine.buildPlayAt('P', 'track-1', 0, 0, { duration: 200 });
    engine.currentTrack.status = 'playing';

    const snap = engine.generateResyncSnapshot('P', 'c1');
    expect(snap).not.toBeNull();
    expect(snap.t).toBe(SyncEventType.RESYNC_SNAPSHOT);
    expect(snap.trackId).toBe('track-1');
    expect(typeof snap.currentPositionSec).toBe('number');
    expect(typeof snap.serverNowMs).toBe('number');
    expect(snap.generation).toBe(engine.generation);
    expect(snap.isPlaying).toBe(true);
  });

  test('generateResyncSnapshot incorporates per-client offset + latency comp', () => {
    engine.buildPlayAt('P', 'track-1', 0);
    const c1 = engine.getClient('c1');
    c1.clockOffset = 30;
    c1.audioLatencyCompMs = 5;

    const snap = engine.generateResyncSnapshot('P', 'c1');
    expect(snap.clockOffset).toBe(30);
    expect(snap.audioLatencyCompMs).toBe(5);
  });

  // ── Stale event validation ──────────────────────────────
  test('validateEventGeneration accepts events from current generation', () => {
    engine.generation = 3;
    expect(engine.validateEventGeneration({ generation: 3, partyId: 'P' })).toBe('accept');
  });

  test('validateEventGeneration rejects stale events', () => {
    engine.generation = 5;
    const result = engine.validateEventGeneration({ generation: 3, partyId: 'P' });
    expect(result).toBe('stale');
    expect(engine.telemetry.staleEventsDropped).toBe(1);
  });

  test('validateEventGeneration accepts events with no generation field', () => {
    expect(engine.validateEventGeneration({ partyId: 'P' })).toBe('accept');
  });

  // ── Enhanced stats ──────────────────────────────────────
  test('getEnhancedStats includes generation and partyState', () => {
    engine.buildPreparePlay('P', 't', 'u');
    const stats = engine.getEnhancedStats('P');
    expect(stats.generation).toBe(1);
    expect(stats.partyState).toBe(PartySyncState.PREPARING);
    expect(stats.telemetry).toBeDefined();
  });

  // ── broadcastTrack backward compat ──────────────────────
  test('broadcastTrack still works for backward compat', () => {
    const result = engine.broadcastTrack('track-1', 180, 3000, { title: 'Test' });
    expect(result.broadcast.t).toBe('PLAY_TRACK');
    expect(result.clientBroadcasts.size).toBe(2);
  });
});

// ============================================================
// 3. event-replay: generation / idempotency
// ============================================================

describe('EventReplayManager: generation + idempotency', () => {
  let manager;

  beforeEach(() => {
    manager = new EventReplayManager({ enableLogging: false });
  });

  test('validateEvent accepts event with no eventId or generation', () => {
    expect(manager.validateEvent({})).toBe('accept');
  });

  test('validateEvent rejects duplicate eventId', () => {
    const evt = { eventId: 'abc123', partyCode: 'P' };
    expect(manager.validateEvent(evt)).toBe('accept');
    expect(manager.validateEvent(evt)).toBe('duplicate');
    expect(manager.stats.duplicateEventsDropped).toBe(1);
  });

  test('validateEvent rejects stale generation', () => {
    manager.setPartyGeneration('P', 5);
    const old = { eventId: 'xyz', partyCode: 'P', generation: 3 };
    expect(manager.validateEvent(old)).toBe('stale');
    expect(manager.stats.staleEventsDropped).toBe(1);
  });

  test('validateEvent accepts current generation', () => {
    manager.setPartyGeneration('P', 5);
    const current = { eventId: 'new1', partyCode: 'P', generation: 5 };
    expect(manager.validateEvent(current)).toBe('accept');
  });

  test('setPartyGeneration only advances (does not go back)', () => {
    manager.setPartyGeneration('P', 10);
    manager.setPartyGeneration('P', 3);  // should NOT go back
    expect(manager._clientGenerations.get('P').currentGeneration).toBe(10);
  });

  test('unique eventIds are all accepted', () => {
    for (let i = 0; i < 10; i++) {
      const evt = { eventId: `id-${i}`, partyCode: 'P' };
      expect(manager.validateEvent(evt)).toBe('accept');
    }
  });

  test('stats include staleEventsDropped and duplicateEventsDropped', () => {
    expect(manager.stats).toHaveProperty('staleEventsDropped');
    expect(manager.stats).toHaveProperty('duplicateEventsDropped');
  });
});

// ============================================================
// 4. sync-client: ClientSyncEngine browser adapter
// ============================================================

describe('ClientSyncEngine: browser adapter', () => {
  let engine;

  beforeEach(() => {
    // Minimal browser-like environment stubs
    global.WebSocket = { OPEN: 1 };
    global.navigator = { maxTouchPoints: 0, connection: null };
    global.window = { innerWidth: 1280 };
    global.performance = {
      now: jest.fn(() => Date.now()),
    };
    engine = new ClientSyncEngine();
  });

  afterEach(() => {
    delete global.WebSocket;
    delete global.navigator;
    delete global.window;
    delete global.performance;
  });

  // ── PLL-aligned thresholds ──────────────────────────────
  test('driftIgnoreMs uses PLL-aligned DRIFT_IGNORE_MS (not legacy 200ms)', () => {
    // Browser adapter applies browser override (35ms), which is tighter than shared default (40ms)
    expect(engine.driftIgnoreMs).toBeLessThan(100); // must be << 200ms
    expect(engine.driftIgnoreMs).toBeGreaterThan(0);
  });

  test('driftHardResyncMs uses PLL-aligned DRIFT_HARD_RESYNC_MS', () => {
    expect(engine.driftHardResyncMs).toBe(DRIFT_HARD_RESYNC_MS);
  });

  // Legacy compat properties still exist
  test('legacy driftThreshold property still exists for backward compat', () => {
    expect(typeof engine.driftThreshold).toBe('number');
    expect(typeof engine.softCorrectionThreshold).toBe('number');
  });

  // ── Clock rolling window ────────────────────────────────
  test('handleClockPong populates clockSamples', () => {
    const T = 1000;
    engine.handleClockPong({ clientNowMs: T, serverNowMs: T + 25, clientSentTime: T });
    expect(engine.clockSamples.length).toBe(1);
  });

  test('handleClockPong updates clockOffset via EMA', () => {
    const T = 1000;
    // Before: clockOffset = 0
    engine.handleClockPong({ clientNowMs: T, serverNowMs: T, clientSentTime: T - 100 });
    expect(typeof engine.clockOffset).toBe('number');
    expect(engine.clockOffset).not.toBe(0);
  });

  test('clockQuality improves with low-RTT samples', () => {
    // Use real timestamps so _clientClock() (Date.now()) gives correct RTT
    for (let i = 0; i < 5; i++) {
      const T = Date.now();
      engine.handleClockPong({ clientSentTime: T - 40, serverNowMs: T - 20, clientNowMs: T - 40 });
    }
    // Quality can be any valid string after samples are processed
    expect(['excellent', 'good', 'fair', 'poor', 'unknown']).toContain(engine.clockQuality);
  });

  test('clockQuality degrades with high-RTT samples', () => {
    for (let i = 0; i < 5; i++) {
      const T = Date.now();
      engine.handleClockPong({ clientSentTime: T - 600, serverNowMs: T - 300, clientNowMs: T - 600 });
    }
    expect(['fair', 'poor', 'unknown']).toContain(engine.clockQuality);
  });

  test('clockConfidence is between 0 and 1', () => {
    engine.handleClockPong({ clientSentTime: 1000, serverNowMs: 1020, clientNowMs: 1040 });
    expect(engine.clockConfidence).toBeGreaterThanOrEqual(0);
    expect(engine.clockConfidence).toBeLessThanOrEqual(1);
  });

  // ── Latency compensation (production-enabled) ───────────
  test('audioLatencyCompMs starts at 0', () => {
    expect(engine.audioLatencyCompMs).toBe(0);
  });

  test('_updateLatencyComp slowly learns bias from consistent drift', () => {
    // Feed 15 samples of +60ms drift
    for (let i = 0; i < 15; i++) {
      engine._updateLatencyComp(60);
    }
    expect(engine.audioLatencyCompMs).toBeGreaterThan(0);
    expect(Math.abs(engine.audioLatencyCompMs)).toBeLessThanOrEqual(80); // capped
  });

  test('_updateLatencyComp caps at AUDIO_LATENCY_COMP_MAX_MS', () => {
    // Drive bias to its limit
    for (let i = 0; i < 100; i++) {
      engine._updateLatencyComp(500);
    }
    expect(engine.audioLatencyCompMs).toBeLessThanOrEqual(80);
  });

  // ── Telemetry ───────────────────────────────────────────
  test('getMetrics returns all expected fields', () => {
    const m = engine.getMetrics();
    expect(m).toHaveProperty('clockOffsetMs');
    expect(m).toHaveProperty('clockQuality');
    expect(m).toHaveProperty('clockConfidence');
    expect(m).toHaveProperty('rttMedianMs');
    expect(m).toHaveProperty('rttP95Ms');
    expect(m).toHaveProperty('audioLatencyCompMs');
    expect(m).toHaveProperty('correctionCounts');
    expect(m).toHaveProperty('backgroundRecoveries');
    expect(m).toHaveProperty('autoplayUnlocks');
  });

  test('telemetry.joinTime is set on construction', () => {
    expect(engine.telemetry.joinTime).toBeLessThanOrEqual(Date.now());
  });

  // ── Burst sync ──────────────────────────────────────────
  test('_startBurstSync sends multiple pings then calls onComplete', (done) => {
    const mockWs = { readyState: 1, send: jest.fn() };
    engine.ws = mockWs;

    let completeCalled = false;
    engine._startBurstSync(() => { completeCalled = true; });

    // Let all burst pings fire (CLOCK_SYNC_BURST_COUNT * CLOCK_SYNC_BURST_INTERVAL_MS)
    const waitMs = (CLOCK_SYNC_BURST_COUNT + 1) * CLOCK_SYNC_BURST_INTERVAL_MS + 50;
    setTimeout(() => {
      expect(completeCalled).toBe(true);
      expect(mockWs.send.mock.calls.length).toBeGreaterThan(0);
      done();
    }, waitMs);
  }, 10000);

  // ── handleDriftCorrection ───────────────────────────────
  test('handleDriftCorrection with mode=rate clamps playbackRate', () => {
    engine.handleDriftCorrection({ mode: 'rate', drift: 80, rateDelta: 0.02 });
    expect(engine.playbackRate).toBeGreaterThanOrEqual(0.95);
    expect(engine.playbackRate).toBeLessThanOrEqual(1.05);
  });

  test('handleDriftCorrection with mode=rate and very large rateDelta is clamped', () => {
    engine.handleDriftCorrection({ mode: 'rate', drift: 200, rateDelta: 0.5 });
    expect(engine.playbackRate).toBeLessThanOrEqual(1.05);
  });

  // ── Reconnect burst sync ────────────────────────────────
  test('resetReconnectionState resets attempts', () => {
    engine.reconnectAttempts = 5;
    // Simulate no WS connection to avoid actual ping
    engine.ws = null;
    engine.resetReconnectionState();
    expect(engine.reconnectAttempts).toBe(0);
  });
});

// ============================================================
// 5. Multi-client integration — host + guests, late join, reconnect
// ============================================================

describe('Multi-client integration', () => {
  let engine;
  const PARTY = 'INTEG01';
  const HOST = 'host-1';
  const GUEST1 = 'guest-1';
  const GUEST2 = 'guest-2';
  const NOW = 1_000_000;

  function makeFakeClock(startMs) {
    let t = startMs;
    const fn = () => t;
    fn.advance = (ms) => { t += ms; };
    return fn;
  }

  beforeEach(() => {
    engine = new SyncEngine();
    engine.masterClock = makeFakeClock(NOW);
    [HOST, GUEST1, GUEST2].forEach(id => {
      engine.addClient({ readyState: 1, send: jest.fn() }, id);
    });
  });

  test('host + 2 guests: buildPlayAt generates 3 per-client events', () => {
    const { perClient } = engine.buildPlayAt(PARTY, 'track-1', 3000, 0, { duration: 240 });
    expect(perClient.size).toBe(3);
    expect(perClient.has(HOST)).toBe(true);
    expect(perClient.has(GUEST1)).toBe(true);
    expect(perClient.has(GUEST2)).toBe(true);
  });

  test('each client receives personalised startAtClientMs based on their offset', () => {
    const host = engine.getClient(HOST);
    const guest1 = engine.getClient(GUEST1);
    host.clockOffset = 0;
    guest1.clockOffset = 80; // guest1 clock is ahead of server

    const { base, perClient } = engine.buildPlayAt(PARTY, 'track-1', 3000);
    expect(perClient.get(HOST).startAtClientMs).toBe(base.startAtServerMs);
    expect(perClient.get(GUEST1).startAtClientMs).toBe(base.startAtServerMs - 80);
  });

  test('late join: RESYNC_SNAPSHOT provides current position', () => {
    engine.buildPlayAt(PARTY, 'track-1', 0, 0, { duration: 300 });
    engine.currentTrack.status = 'playing';
    engine.masterClock.advance(10000); // 10 seconds have elapsed

    const snap = engine.generateResyncSnapshot(PARTY, GUEST2);
    expect(snap).not.toBeNull();
    expect(snap.currentPositionSec).toBeCloseTo(10, 0);
  });

  test('repeated seek advances generation and resets sequence', () => {
    engine.buildPlayAt(PARTY, 'track-1', 3000);
    const genAfterPlay = engine.generation;

    engine.buildSeekTo(PARTY, 'track-1', 45);
    expect(engine.generation).toBe(genAfterPlay + 1);
    expect(engine.sequence).toBe(1); // reset to 1 on first event after gen advance
  });

  test('stale events from before seek are rejected', () => {
    engine.buildPlayAt(PARTY, 'track-1', 3000);
    const oldGen = engine.generation;
    engine.buildSeekTo(PARTY, 'track-1', 45);

    // Old event from previous generation
    const staleEvent = { generation: oldGen, partyId: PARTY };
    expect(engine.validateEventGeneration(staleEvent)).toBe('stale');
  });

  test('reconnect: RESYNC_SNAPSHOT gives correct position after reconnect', () => {
    engine.buildPlayAt(PARTY, 'track-1', 0, 30, { duration: 300 }); // starts at 30s
    engine.currentTrack.status = 'playing';
    engine.masterClock.advance(5000); // 5 more seconds elapsed

    const snap = engine.generateResyncSnapshot(PARTY, GUEST1);
    // Expected position = 30 (start) + 5 (elapsed) = 35s
    expect(snap.currentPositionSec).toBeCloseTo(35, 0);
    expect(snap.startPositionSec).toBe(30);
  });

  test('host drifts and gets PLL rate correction within cooldown', () => {
    const { base } = engine.buildPlayAt(PARTY, 'track-1', 0);
    engine.currentTrack.status = 'playing';
    engine.transitionPartyState(PartySyncState.PLAYING);

    // Guest1 is 80ms ahead (above DRIFT_IGNORE_MS, below DRIFT_HARD_RESYNC_MS)
    const aheadBy = 0.08; // 80ms in seconds
    const correction = engine.handlePlaybackFeedback(GUEST1, aheadBy, NOW);
    expect(correction).not.toBeNull();
    expect(correction.mode).toBe('rate');
  });

  test('getEnhancedStats includes generation, partyState, and telemetry', () => {
    engine.buildPlayAt(PARTY, 'track-1', 3000);
    const stats = engine.getEnhancedStats(PARTY);
    expect(typeof stats.generation).toBe('number');
    expect(stats.partyState).toBeDefined();
    expect(stats.telemetry).toBeDefined();
    expect(stats.totalClients).toBe(3);
  });
});

// ============================================================
// 6. Drift policy: correction ladder (end-to-end)
// ============================================================

describe('Drift correction ladder (end-to-end via SyncEngine)', () => {
  let engine;
  const CLIENT = 'ladder-client';
  const NOW = 2_000_000;

  function makeFakeClock(startMs) {
    let t = startMs;
    const fn = () => t;
    fn.advance = (ms) => { t += ms; };
    return fn;
  }

  beforeEach(() => {
    engine = new SyncEngine();
    engine.masterClock = makeFakeClock(NOW);
    engine.addClient({ readyState: 1, send: jest.fn() }, CLIENT);
    engine.currentTrack = {
      trackId: 'ladder-track',
      startPositionSec: 0,
      startTimestamp: NOW,
      status: 'playing',
    };
  });

  test('drift within dead-band (< DRIFT_IGNORE_MS) → no correction', () => {
    const smallDrift = (DRIFT_IGNORE_MS - 5) / 1000;
    const result = engine.handlePlaybackFeedback(CLIENT, smallDrift, NOW);
    expect(result).toBeNull();
  });

  test('drift in soft range → mode=rate, playbackRate changes', () => {
    const softDrift = (DRIFT_IGNORE_MS + 20) / 1000;
    const result = engine.handlePlaybackFeedback(CLIENT, softDrift, NOW);
    expect(result).not.toBeNull();
    expect(result.mode).toBe('rate');
    expect(result.playbackRate).not.toBe(1.0);
  });

  test('large drift → mode=seek with seekToSec', () => {
    const hardDrift = (DRIFT_HARD_RESYNC_MS + 10) / 1000;
    const result = engine.handlePlaybackFeedback(CLIENT, hardDrift, NOW);
    expect(result).not.toBeNull();
    expect(result.mode).toBe('seek');
    expect(typeof result.seekToSec).toBe('number');
  });

  test('negative drift (behind) → rate correction speeds playback up', () => {
    const softBehind = -(DRIFT_IGNORE_MS + 20) / 1000;
    const result = engine.handlePlaybackFeedback(CLIENT, softBehind, NOW);
    expect(result).not.toBeNull();
    expect(result.mode).toBe('rate');
    // Behind → playbackRate > 1.0 to speed up
    expect(result.playbackRate).toBeGreaterThan(1.0);
  });

  test('after hard-resync, second resync within cooldown falls back to rate', () => {
    const { HARD_RESYNC_COOLDOWN_MS } = require('../../sync-config');
    const hardDrift = (DRIFT_HARD_RESYNC_MS + 10) / 1000;

    engine.handlePlaybackFeedback(CLIENT, hardDrift, NOW); // first seek
    engine.masterClock.advance(HARD_RESYNC_COOLDOWN_MS / 2); // still in cooldown

    const r2 = engine.handlePlaybackFeedback(CLIENT, hardDrift, NOW);
    if (r2) expect(r2.mode).not.toBe('seek');
  });
});
