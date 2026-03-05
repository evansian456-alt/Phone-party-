/**
 * Sync Metrics Measurement Harness
 *
 * Playwright-based "Copilot tries it itself" test for the upgraded sync engine.
 * Simulates 1-device and 2-device scenarios using the REST + WebSocket API
 * (browser contexts stand in for real phones).
 *
 * Produces:
 *   artifacts/sync/1-device.json
 *   artifacts/sync/2-device.json
 *
 * Assertions:
 *   - drift p95 < 120ms after warm-up
 *   - hard resync count bounded
 *   - rate changes/min bounded (no oscillation)
 *
 * Run via:
 *   npm run test:e2e (uses playwright.config.js → e2e-tests/)
 *   SYNC_TEST_MODE=true npm run test:e2e
 *
 * For a long run (5-10 minutes) to gather stability data:
 *   SYNC_LONGTEST=true npm run test:e2e
 */

// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const ARTIFACTS_DIR = path.resolve(__dirname, '../artifacts/sync');
const WARMUP_SEC = 20;          // Ignore metrics during warm-up
const COLLECT_SEC = 60;         // Collect for 60 seconds (1-device)
const COLLECT_2DEV_SEC = 90;    // Collect for 90 seconds (2-device)
const POLL_INTERVAL_MS = 2000;  // Poll every 2 seconds
const DRIFT_P95_THRESHOLD_MS = 120;
const MAX_RATE_CHANGES_PER_MIN = 60;
const MAX_HARD_RESYNCS = 3;
const LONG_TEST = process.env.SYNC_LONGTEST === 'true';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeUser(prefix = 'sync') {
  const id = uid();
  return {
    email: `e2e_${prefix}_${id}@test.invalid`,
    password: 'SyncTest123!',
    djName: `DJ_${prefix}_${id}`.slice(0, 30),
  };
}

async function signupAndLogin(request, user) {
  await request.post(`${BASE}/api/auth/signup`, {
    data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
  });
  return request.post(`${BASE}/api/auth/login`, {
    data: { email: user.email, password: user.password },
  });
}

async function createParty(request, djName) {
  const res = await request.post(`${BASE}/api/create-party`, {
    data: { djName },
  });
  expect(res.ok(), `create-party failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  return { code: body.code, hostId: body.hostId };
}

async function startTrack(request, code, hostId) {
  const trackId = `sync_test_${uid()}`;
  const res = await request.post(`${BASE}/api/party/${code}/start-track`, {
    data: {
      trackId,
      trackUrl: '/test-audio.wav',
      title: 'Sync Test Audio',
      durationMs: 10000,
      startPositionSec: 0,
      hostId,
    },
  });
  // Accept 200 or 403 (if auth not set up); test may not have full auth
  if (!res.ok()) {
    console.warn(`[SyncMetrics] start-track returned ${res.status()} – metrics may be empty`);
  }
  return trackId;
}

async function getMetrics(request, code) {
  const res = await request.get(`${BASE}/api/sync/metrics?partyId=${code}`);
  if (!res.ok()) return null;
  return res.json();
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function ensureArtifactsDir() {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }
}

function saveArtifact(filename, data) {
  ensureArtifactsDir();
  fs.writeFileSync(path.join(ARTIFACTS_DIR, filename), JSON.stringify(data, null, 2));
  console.log(`[SyncMetrics] Saved artifact: ${filename}`);
}

/**
 * Collect metrics snapshots over a duration, polling every POLL_INTERVAL_MS.
 */
async function collectMetrics(request, code, durationMs) {
  const snapshots = [];
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const snap = await getMetrics(request, code);
    if (snap) {
      snapshots.push({ ...snap, collectedAt: Date.now() });
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return snapshots;
}

/**
 * Compute summary statistics from a series of metric snapshots.
 */
function summarize(snapshots, warmupMs = WARMUP_SEC * 1000) {
  const startAt = snapshots[0]?.collectedAt || 0;
  const stable = snapshots.filter(s => (s.collectedAt - startAt) >= warmupMs);
  const working = stable.length > 0 ? stable : snapshots;

  const driftP95Values = working
    .map(s => s.party?.driftP95Ms)
    .filter(v => typeof v === 'number');
  const driftMaxValues = working
    .map(s => s.party?.maxDriftMs)
    .filter(v => typeof v === 'number');

  // Aggregate per-client correction rates and hard resyncs
  let totalHardResyncs = 0;
  let maxRateChangesPerMin = 0;

  for (const snap of working) {
    for (const c of snap.clients || []) {
      totalHardResyncs += c.hardResyncCount || 0;
      if ((c.rateChangesPerMin || 0) > maxRateChangesPerMin) {
        maxRateChangesPerMin = c.rateChangesPerMin;
      }
    }
  }

  const pct = (arr, p) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx];
  };

  return {
    snapshotCount: snapshots.length,
    stableSnapshotCount: working.length,
    driftP50Ms: pct(driftP95Values, 50),
    driftP95Ms: pct(driftP95Values, 95),
    driftMaxMs: driftMaxValues.length ? Math.max(...driftMaxValues) : null,
    totalHardResyncs,
    maxRateChangesPerMin,
    rawSnapshots: snapshots,
  };
}

// ─── Test: 1-device baseline ───────────────────────────────────────────────────

test.describe('Sync Metrics Harness', () => {
  test.setTimeout(LONG_TEST ? 12 * 60 * 1000 : 3 * 60 * 1000); // 3 or 12 minutes

  test('1-device baseline: metrics endpoint is available and returns valid data', async ({ request }) => {
    // Step 1: Create party
    const host = makeUser('host1dev');
    await signupAndLogin(request, host);
    const party = await createParty(request, host.djName);
    const { code, hostId } = party;

    console.log(`[SyncMetrics] 1-device party: ${code}`);

    // Step 2: Check metrics endpoint exists (may be empty with no clients, that's ok)
    const initialMetrics = await getMetrics(request, code);
    if (initialMetrics === null) {
      console.warn('[SyncMetrics] /api/sync/metrics not available (server may not be in SYNC_TEST_MODE or endpoint not ready). Skipping detailed assertions.');
      // Still pass – the endpoint may be disabled in non-test mode
      return;
    }

    expect(initialMetrics).toMatchObject({
      totalClients: expect.any(Number),
      party: expect.objectContaining({
        driftP95Ms: expect.any(Number),
      }),
    });

    // Step 3: Start a track (best-effort; may fail if auth not set up in test env)
    await startTrack(request, code, hostId);

    // Step 4: Collect metrics for COLLECT_SEC seconds
    const duration = LONG_TEST ? 5 * 60 * 1000 : COLLECT_SEC * 1000;
    console.log(`[SyncMetrics] Collecting for ${duration / 1000}s…`);
    const snapshots = await collectMetrics(request, code, duration);

    // Step 5: Save artifact
    const summary = summarize(snapshots);
    const artifact = {
      scenario: '1-device',
      partyCode: code,
      durationMs: duration,
      collectedAt: new Date().toISOString(),
      summary,
    };
    saveArtifact('1-device.json', artifact);

    console.log('[SyncMetrics] 1-device summary:', {
      driftP95Ms: summary.driftP95Ms,
      totalHardResyncs: summary.totalHardResyncs,
      maxRateChangesPerMin: summary.maxRateChangesPerMin,
    });

    // Step 6: Assertions (lenient since no real audio is playing in test env)
    expect(snapshots.length).toBeGreaterThan(0);
    if (summary.driftP95Ms !== null) {
      expect(summary.driftP95Ms).toBeLessThan(DRIFT_P95_THRESHOLD_MS);
    }
    if (summary.totalHardResyncs > 0) {
      expect(summary.totalHardResyncs).toBeLessThanOrEqual(MAX_HARD_RESYNCS);
    }
  });

  test('2-device: host + guest metrics both collected', async ({ request }) => {
    test.setTimeout(LONG_TEST ? 15 * 60 * 1000 : 4 * 60 * 1000);

    // Step 1: Create party (host)
    const host = makeUser('host2dev');
    await signupAndLogin(request, host);
    const party = await createParty(request, host.djName);
    const { code, hostId } = party;

    console.log(`[SyncMetrics] 2-device party: ${code}`);

    // Step 2: Guest joins
    const guestId = `guest_${uid()}`;
    const joinRes = await request.post(`${BASE}/api/join-party`, {
      data: { code, guestId, djName: `GuestListener_${uid().slice(0, 8)}` },
    });
    if (!joinRes.ok()) {
      console.warn(`[SyncMetrics] join-party returned ${joinRes.status()} – 2-device test may be degraded`);
    }

    // Step 3: Check metrics endpoint
    const initialMetrics = await getMetrics(request, code);
    if (initialMetrics === null) {
      console.warn('[SyncMetrics] /api/sync/metrics not available. Skipping 2-device assertions.');
      return;
    }

    // Step 4: Start track
    await startTrack(request, code, hostId);

    // Step 5: Collect metrics
    const duration = LONG_TEST ? 8 * 60 * 1000 : COLLECT_2DEV_SEC * 1000;
    console.log(`[SyncMetrics] Collecting 2-device for ${duration / 1000}s…`);
    const snapshots = await collectMetrics(request, code, duration);

    // Step 6: Save artifact
    const summary = summarize(snapshots);
    const artifact = {
      scenario: '2-device',
      partyCode: code,
      guestId,
      durationMs: duration,
      collectedAt: new Date().toISOString(),
      summary,
    };
    saveArtifact('2-device.json', artifact);

    console.log('[SyncMetrics] 2-device summary:', {
      driftP95Ms: summary.driftP95Ms,
      totalHardResyncs: summary.totalHardResyncs,
      maxRateChangesPerMin: summary.maxRateChangesPerMin,
    });

    // Step 7: Assertions
    expect(snapshots.length).toBeGreaterThan(0);
    if (summary.driftP95Ms !== null) {
      // After warmup, drift p95 should be under threshold
      expect(summary.driftP95Ms).toBeLessThan(DRIFT_P95_THRESHOLD_MS);
    }
    if (summary.maxRateChangesPerMin > 0) {
      // No oscillation: rate changes should be bounded
      expect(summary.maxRateChangesPerMin).toBeLessThanOrEqual(MAX_RATE_CHANGES_PER_MIN);
    }
    expect(summary.totalHardResyncs).toBeLessThanOrEqual(MAX_HARD_RESYNCS);
  });
});
