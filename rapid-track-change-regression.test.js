/**
 * Regression tests for playback race conditions
 *
 * Bug 1: Rapid track-change race condition
 *   When the host issues HOST_PLAY for Track A then immediately HOST_PLAY for Track B,
 *   the stale checkReadiness callback for Track A must NOT broadcast PLAY_AT carrying
 *   Track A's identifiers — those stale frames would desync every guest.
 *
 * Bug 2: SYNC_TICK absent after HOST_TRACK_CHANGED
 *   handleHostTrackChanged sets currentTrack.status = 'playing' but previously never
 *   called startSyncTick, so drift-correction ticks were absent for that code path.
 */

// Must be set before requiring server.js so server uses a random port
process.env.PORT = '0';

const WebSocket = require('ws');
const {
  app,
  startServer,
  parties,
  redis,
  waitForRedis,
} = require('./server');

let server;
let testPort;
let testClients = [];
let serverAvailable = false;

const REDIS_TIMEOUT = 2000;
const SERVER_STARTUP_TIMEOUT = 5000;

// ─── helpers ────────────────────────────────────────────────────────────────

function createClient() {
  const ws = new WebSocket(`ws://localhost:${testPort}`);
  testClients.push(ws);
  return ws;
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once('open', resolve);
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS open timeout')), 5000);
  });
}

function waitForMessage(ws, messageType, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${messageType}`)),
      timeoutMs
    );
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.t === messageType) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch (_) {}
    };
    ws.on('message', handler);
  });
}

/** Collect every message of a given type for `durationMs`. */
function collectMessages(ws, messageType, durationMs = 3000) {
  return new Promise((resolve) => {
    const collected = [];
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.t === messageType) collected.push(msg);
      } catch (_) {}
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(collected);
    }, durationMs);
  });
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.TEST_MODE = 'true';

  try {
    await Promise.race([
      waitForRedis(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Redis timeout')), REDIS_TIMEOUT)),
    ]);
  } catch {
    return; // Redis not available – tests will fail in their own beforeAll
  }

  try {
    server = await Promise.race([
      startServer(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Server startup timeout')), SERVER_STARTUP_TIMEOUT)),
    ]);
    testPort = server.address().port;
    serverAvailable = true;
  } catch {
    serverAvailable = false;
  }
}, REDIS_TIMEOUT + SERVER_STARTUP_TIMEOUT + 2000);

afterEach(async () => {
  testClients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });
  testClients = [];
  parties.clear();
  await new Promise((r) => setTimeout(r, 300));
});

afterAll(async () => {
  if (server) server.close();
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe('Rapid track-change regression (Bug 1 + Bug 2)', () => {
  // A beforeAll that throws causes FAIL (not skip) when server is unavailable,
  // satisfying the zero-skip mandate.
  beforeAll(() => {
    if (!serverAvailable) {
      throw new Error(
        'Server not available for regression tests. ' +
        'Ensure Redis and startServer() succeeded in the outer beforeAll.'
      );
    }
  });

  // ── Bug 1 ─────────────────────────────────────────────────────────────────
  it(
    'stale PLAY_AT for superseded track is suppressed during rapid track change',
    async () => {
      // ── Setup: host creates party ──────────────────────────────────────────
      const hostWs = createClient();
      await waitForOpen(hostWs);

      const createProm = waitForMessage(hostWs, 'CREATED');
      hostWs.send(
        JSON.stringify({ t: 'CREATE', djName: 'RapidDJ', source: 'local' })
      );
      const { code: partyCode } = await createProm;
      expect(partyCode).toBeTruthy();

      // ── Guest joins ────────────────────────────────────────────────────────
      const guestWs = createClient();
      await waitForOpen(guestWs);

      const joinedProm = waitForMessage(guestWs, 'JOINED');
      guestWs.send(
        JSON.stringify({ t: 'JOIN', code: partyCode, name: 'Listener' })
      );
      await joinedProm;

      // ── Collect all PLAY_AT frames that the guest receives ─────────────────
      const playAtFrames = collectMessages(guestWs, 'PLAY_AT', 6000);

      // ── Host plays Track A then immediately Track B ────────────────────────
      const trackA = 'track-alpha';
      const trackB = 'track-beta';

      hostWs.send(
        JSON.stringify({
          t: 'HOST_PLAY',
          trackId: trackA,
          trackUrl: 'https://cdn.example.com/alpha.mp3',
          filename: 'alpha.mp3',
        })
      );

      // Immediately supersede with Track B (within the 1200 ms lead time window)
      await new Promise((r) => setTimeout(r, 50));
      hostWs.send(
        JSON.stringify({
          t: 'HOST_PLAY',
          trackId: trackB,
          trackUrl: 'https://cdn.example.com/beta.mp3',
          filename: 'beta.mp3',
        })
      );

      // Allow PREPARE_PLAY frames to arrive, then satisfy the readiness gate for
      // Track B so checkReadiness fires PLAY_AT within the collection window.
      // CLIENT_READY for trackA is intentionally omitted — its stale checkReadiness
      // will abort because currentTrack.trackId has changed to trackB.
      await new Promise((r) => setTimeout(r, 200));
      guestWs.send(JSON.stringify({ t: 'CLIENT_READY', trackId: trackB, bufferedSec: 5, readyState: 4 }));
      hostWs.send(JSON.stringify({ t: 'CLIENT_READY', trackId: trackB, bufferedSec: 5, readyState: 4 }));

      const frames = await playAtFrames;

      // Every PLAY_AT that reaches the guest must be for Track B (the final track).
      // A frame for Track A means the stale checkReadiness fired — regression.
      const staleFrames = frames.filter((f) => f.trackId === trackA);
      expect(staleFrames).toHaveLength(0);

      // At least one PLAY_AT for Track B must arrive (normal playback).
      const validFrames = frames.filter((f) => f.trackId === trackB);
      expect(validFrames.length).toBeGreaterThan(0);
    },
    15000
  );

  // ── Bug 2 ─────────────────────────────────────────────────────────────────
  it(
    'SYNC_TICK is emitted after HOST_TRACK_CHANGED',
    async () => {
      // ── Setup ──────────────────────────────────────────────────────────────
      const hostWs = createClient();
      await waitForOpen(hostWs);

      const createProm = waitForMessage(hostWs, 'CREATED');
      hostWs.send(
        JSON.stringify({ t: 'CREATE', djName: 'SyncDJ', source: 'local' })
      );
      const { code: partyCode } = await createProm;

      const guestWs = createClient();
      await waitForOpen(guestWs);

      const joinedProm = waitForMessage(guestWs, 'JOINED');
      guestWs.send(
        JSON.stringify({ t: 'JOIN', code: partyCode, name: 'Listener2' })
      );
      await joinedProm;

      // ── Collect SYNC_TICK frames over 3 seconds ────────────────────────────
      const syncTickFrames = collectMessages(guestWs, 'SYNC_TICK', 3000);

      // ── Host fires TRACK_CHANGED (the code path that was missing startSyncTick)
      hostWs.send(
        JSON.stringify({
          t: 'HOST_TRACK_CHANGED',
          trackId: 'track-gamma',
          trackUrl: 'https://cdn.example.com/gamma.mp3',
          filename: 'gamma.mp3',
          positionSec: 0,
        })
      );

      const ticks = await syncTickFrames;

      // At least one SYNC_TICK must be delivered within the observation window.
      expect(ticks.length).toBeGreaterThan(0);
      // Each tick must carry the new trackId.
      ticks.forEach((tick) => {
        expect(tick.trackId).toBe('track-gamma');
      });
    },
    10000
  );
});
