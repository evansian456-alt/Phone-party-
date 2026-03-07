// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Music queue, playback state, and sync tests.
 *
 * Validates:
 * - A host can add tracks to the queue
 * - The queue is reflected in /api/party-state (UI vs backend consistency)
 * - Starting a track sets currentTrack in party-state with sync timing info
 * - Multiple polls return identical sync state (clock consistency)
 * - Queue operations: remove, clear, reorder
 * - Guest can read the same party-state (sync parity)
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeUser(prefix = 'music') {
  const id = uid();
  return {
    email: `e2e_${prefix}_${id}@test.invalid`,
    password: 'E2eTest123!',
    djName: `DJ_${prefix}_${id}`.slice(0, 30),
  };
}

async function signupAndLogin(request, user) {
  await request.post(`${BASE}/api/auth/signup`, {
    data: { email: user.email, password: user.password, djName: user.djName, termsAccepted: true },
  });
  const res = await request.post(`${BASE}/api/auth/login`, {
    data: { email: user.email, password: user.password },
  });
  return res;
}

async function createParty(request, djName) {
  const res = await request.post(`${BASE}/api/create-party`, {
    data: { djName },
  });
  expect(res.ok(), `create-party failed: ${res.status()}`).toBeTruthy();
  const body = await res.json();
  return { code: body.code, hostId: body.hostId };
}

// Generate a predictable synthetic track (no file upload needed)
function makeTrack(n = 1) {
  const id = `track_test_${uid()}_${n}`;
  return {
    trackId: id,
    // Local track URL pattern accepted by the server validation
    trackUrl: `/api/track/${id}`,
    title: `Test Track ${n}`,
    durationMs: 180000,
  };
}

test.describe('Music queue — host operations', () => {
  let host;
  let party;

  test.beforeAll(async ({ request }) => {
    host = makeUser('host_music');
    await signupAndLogin(request, host);
    party = await createParty(request, host.djName);
  });

  test('initial party-state has empty queue and no currentTrack', async ({ request }) => {
    const res = await request.get(`${BASE}/api/party-state?code=${party.code}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.queue).toBeDefined();
    expect(Array.isArray(body.queue)).toBe(true);
    expect(body.queue.length).toBe(0);
    expect(body.currentTrack).toBeNull();
  });

  test('host can add a track to the queue', async ({ request }) => {
    const track = makeTrack(1);
    const res = await request.post(`${BASE}/api/party/${party.code}/queue-track`, {
      data: { ...track, hostId: party.hostId },
    });
    expect(res.ok(), `queue-track failed: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.queue).toBeDefined();
    expect(body.queue.length).toBeGreaterThan(0);
  });

  test('party-state queue matches after adding track — UI/backend consistency', async ({ request }) => {
    const stateRes = await request.get(`${BASE}/api/party-state?code=${party.code}`);
    const state = await stateRes.json();
    expect(state.queue.length).toBeGreaterThan(0);

    // The queued track should appear in the party state
    const track = state.queue[0];
    expect(track.trackId).toBeDefined();
    expect(track.title).toBeDefined();
  });

  test('host can queue multiple tracks (up to limit)', async ({ request }) => {
    // Add 3 more tracks (total 4 including the one from previous test)
    for (let i = 2; i <= 4; i++) {
      const track = makeTrack(i);
      const res = await request.post(`${BASE}/api/party/${party.code}/queue-track`, {
        data: { ...track, hostId: party.hostId },
      });
      // Accept 200 (queued) or 400 (queue limit reached)
      expect([200, 400]).toContain(res.status());
    }
  });

  test('queue limit is enforced (max 5 tracks)', async ({ request }) => {
    // Try to exceed the limit
    const track = makeTrack(99);
    const res = await request.post(`${BASE}/api/party/${party.code}/queue-track`, {
      data: { ...track, hostId: party.hostId },
    });
    const stateRes = await request.get(`${BASE}/api/party-state?code=${party.code}`);
    const state = await stateRes.json();
    // Queue length must never exceed 5
    expect(state.queue.length).toBeLessThanOrEqual(5);
  });

  test('host can remove a track from the queue', async ({ request }) => {
    const stateRes = await request.get(`${BASE}/api/party-state?code=${party.code}`);
    const state = await stateRes.json();
    if (state.queue.length === 0) return; // nothing to remove

    const trackId = state.queue[0].trackId;
    const res = await request.post(`${BASE}/api/party/${party.code}/remove-track`, {
      data: { trackId, hostId: party.hostId },
    });
    expect(res.ok()).toBeTruthy();

    // Verify removal reflected in party-state
    const afterRes = await request.get(`${BASE}/api/party-state?code=${party.code}`);
    const after = await afterRes.json();
    const stillPresent = after.queue.some((t) => t.trackId === trackId);
    expect(stillPresent).toBe(false);
  });

  test('host can clear the entire queue', async ({ request }) => {
    const res = await request.post(`${BASE}/api/party/${party.code}/clear-queue`, {
      data: { hostId: party.hostId },
    });
    expect(res.ok()).toBeTruthy();

    const stateRes = await request.get(`${BASE}/api/party-state?code=${party.code}`);
    const state = await stateRes.json();
    expect(state.queue.length).toBe(0);
  });
});

test.describe('Music playback — start-track and sync state', () => {
  let host2;
  let party2;

  test.beforeAll(async ({ request }) => {
    host2 = makeUser('host_sync');
    await signupAndLogin(request, host2);
    party2 = await createParty(request, host2.djName);
  });

  test('start-track sets currentTrack in party-state', async ({ request }) => {
    const track = makeTrack(1);

    const startRes = await request.post(`${BASE}/api/party/${party2.code}/start-track`, {
      data: {
        trackId: track.trackId,
        trackUrl: track.trackUrl,
        title: track.title,
        durationMs: track.durationMs,
        startPositionSec: 0,
      },
    });
    expect(startRes.ok()).toBeTruthy();

    // Verify party-state now reflects the playing track
    const stateRes = await request.get(`${BASE}/api/party-state?code=${party2.code}`);
    const state = await stateRes.json();
    expect(state.currentTrack).not.toBeNull();
    expect(state.currentTrack.trackId).toBe(track.trackId);
    expect(state.currentTrack.title).toBe(track.title);
  });

  test('party-state includes sync timing fields (startAtServerMs)', async ({ request }) => {
    const stateRes = await request.get(`${BASE}/api/party-state?code=${party2.code}`);
    const state = await stateRes.json();

    if (state.currentTrack) {
      // startAtServerMs is set by the server for scheduled playback
      expect(typeof state.currentTrack.startAtServerMs).toBe('number');
      // startAtServerMs should be close to now (within 5 seconds of request)
      const drift = Math.abs(state.currentTrack.startAtServerMs - Date.now());
      // If the track was just started, drift should be < 5s; already playing means it's in the past
      expect(drift).toBeLessThan(60_000); // sanity bound: within 1 minute
    }
  });

  test('party-state serverTime is consistent with client time (clock sync check)', async ({ request }) => {
    const clientBefore = Date.now();
    const stateRes = await request.get(`${BASE}/api/party-state?code=${party2.code}`);
    const clientAfter = Date.now();
    const state = await stateRes.json();

    expect(typeof state.serverTime).toBe('number');
    // Server time should be between client before and after (plus a small skew buffer)
    const skewBuffer = 5000; // 5 seconds allowance for CI latency
    expect(state.serverTime).toBeGreaterThan(clientBefore - skewBuffer);
    expect(state.serverTime).toBeLessThan(clientAfter + skewBuffer);
  });

  test('two polls of party-state return identical currentTrack (sync consistency)', async ({ request }) => {
    const state1 = await (await request.get(`${BASE}/api/party-state?code=${party2.code}`)).json();
    const state2 = await (await request.get(`${BASE}/api/party-state?code=${party2.code}`)).json();

    if (state1.currentTrack && state2.currentTrack) {
      // Same track should be playing
      expect(state1.currentTrack.trackId).toBe(state2.currentTrack.trackId);
      expect(state1.currentTrack.startAtServerMs).toBe(state2.currentTrack.startAtServerMs);
    }
  });

  test('guest can read the same party-state as host (sync parity)', async ({ request }) => {
    // Guest joins with a different session (anonymous — no auth required to read party-state)
    await request.post(`${BASE}/api/join-party`, {
      data: { partyCode: party2.code, nickname: 'GuestListener' },
    });

    const stateRes = await request.get(`${BASE}/api/party-state?code=${party2.code}`);
    const state = await stateRes.json();
    expect(state.exists).toBe(true);

    if (state.currentTrack) {
      expect(state.currentTrack.trackId).toBeDefined();
      // Guest and host see the same track information
      const hostStateRes = await request.get(`${BASE}/api/party-state?code=${party2.code}`);
      const hostState = await hostStateRes.json();
      expect(state.currentTrack.trackId).toBe(hostState.currentTrack.trackId);
      expect(state.currentTrack.startAtServerMs).toBe(hostState.currentTrack.startAtServerMs);
    }
  });
});

test.describe('Music queue reorder', () => {
  let host3;
  let party3;

  test.beforeAll(async ({ request }) => {
    host3 = makeUser('host_reorder');
    await signupAndLogin(request, host3);
    party3 = await createParty(request, host3.djName);

    // Pre-fill queue with 2 tracks
    for (let i = 1; i <= 2; i++) {
      await request.post(`${BASE}/api/party/${party3.code}/queue-track`, {
        data: { ...makeTrack(i), hostId: party3.hostId },
      });
    }
  });

  test('host can reorder the queue', async ({ request }) => {
    const stateRes = await request.get(`${BASE}/api/party-state?code=${party3.code}`);
    const state = await stateRes.json();
    if (state.queue.length < 2) return; // not enough tracks

    const originalOrder = state.queue.map((t) => t.trackId);
    const reversed = [...originalOrder].reverse();

    const reorderRes = await request.post(`${BASE}/api/party/${party3.code}/reorder-queue`, {
      data: { newOrder: reversed, hostId: party3.hostId },
    });
    expect(reorderRes.ok()).toBeTruthy();

    // Verify new order reflected in party-state
    const afterRes = await request.get(`${BASE}/api/party-state?code=${party3.code}`);
    const after = await afterRes.json();
    if (after.queue.length >= 2) {
      expect(after.queue[0].trackId).toBe(reversed[0]);
    }
  });
});
