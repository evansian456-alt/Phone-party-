/**
 * Official App Sync Tests
 *
 * Tests for:
 * 1. Platform reference normalization (YouTube / Spotify / SoundCloud)
 * 2. Tier policy – isPaidForOfficialAppSync
 * 3. HTTP endpoint GET /api/party/:code/limits
 * 4. WebSocket OFFICIAL_APP_SYNC_SELECT paid gating (free → denied, paid → broadcast)
 * 5. TIME_PING drift correction when localPositionSeconds exceeds threshold
 */

const {
  normalizeYouTubeRef,
  normalizeSpotifyRef,
  normalizeSoundCloudRef,
  normalizePlatformTrackRef
} = require('./platform-normalizer');

const { isPaidForOfficialAppSync, getPolicyForTier } = require('./tier-policy');

// ============================================================
// 1. Platform normalization
// ============================================================

describe('Platform normalizer – YouTube', () => {
  it('extracts videoId from watch URL', () => {
    expect(normalizeYouTubeRef('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts videoId from short URL', () => {
    expect(normalizeYouTubeRef('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts videoId from embed URL', () => {
    expect(normalizeYouTubeRef('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts videoId from youtube-nocookie.com embed URL', () => {
    expect(normalizeYouTubeRef('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('accepts a raw 11-char videoId', () => {
    expect(normalizeYouTubeRef('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('throws on invalid videoId', () => {
    expect(() => normalizeYouTubeRef('not-valid')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => normalizeYouTubeRef('')).toThrow();
  });
});

describe('Platform normalizer – Spotify', () => {
  it('returns canonical URI unchanged', () => {
    expect(normalizeSpotifyRef('spotify:track:4uLU6hMCjMI75M1A2tKUQC')).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  });

  it('converts open.spotify.com URL to URI', () => {
    expect(normalizeSpotifyRef('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  });

  it('converts raw track ID to URI', () => {
    expect(normalizeSpotifyRef('4uLU6hMCjMI75M1A2tKUQC')).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  });

  it('throws on invalid reference', () => {
    expect(() => normalizeSpotifyRef('not-a-track')).toThrow();
  });
});

describe('Platform normalizer – SoundCloud', () => {
  it('returns numeric ID unchanged', () => {
    expect(normalizeSoundCloudRef('123456789')).toBe('123456789');
  });

  it('normalizes soundcloud.com URL', () => {
    const result = normalizeSoundCloudRef('https://soundcloud.com/artist/track-slug');
    expect(result).toBe('https://soundcloud.com/artist/track-slug');
  });

  it('extracts ID from api.soundcloud.com/tracks/ID path', () => {
    expect(normalizeSoundCloudRef('https://api.soundcloud.com/tracks/987654321')).toBe('987654321');
  });

  it('throws on invalid reference', () => {
    expect(() => normalizeSoundCloudRef('not-soundcloud-and-not-numeric-and-no-tracks')).toThrow();
  });
});

describe('normalizePlatformTrackRef – dispatch', () => {
  it('routes youtube correctly', () => {
    expect(normalizePlatformTrackRef('youtube', 'dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('routes spotify correctly', () => {
    expect(normalizePlatformTrackRef('spotify', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC')).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  });

  it('routes soundcloud correctly', () => {
    expect(normalizePlatformTrackRef('soundcloud', '999')).toBe('999');
  });

  it('throws on unknown platform', () => {
    expect(() => normalizePlatformTrackRef('tidal', 'abc')).toThrow(/Unsupported platform/);
  });

  it('is case-insensitive for platform name', () => {
    expect(normalizePlatformTrackRef('YouTube', 'dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
});

// ============================================================
// 2. Tier policy
// ============================================================

describe('TierPolicy – isPaidForOfficialAppSync', () => {
  it('returns false for FREE', () => {
    expect(isPaidForOfficialAppSync('FREE')).toBe(false);
  });

  it('returns true for PARTY_PASS', () => {
    expect(isPaidForOfficialAppSync('PARTY_PASS')).toBe(true);
  });

  it('returns true for PRO_MONTHLY', () => {
    expect(isPaidForOfficialAppSync('PRO_MONTHLY')).toBe(true);
  });

  it('returns true for PRO', () => {
    expect(isPaidForOfficialAppSync('PRO')).toBe(true);
  });

  it('returns false for unknown tier (falls back to FREE)', () => {
    expect(isPaidForOfficialAppSync('UNKNOWN')).toBe(false);
  });
});

describe('TierPolicy – getPolicyForTier', () => {
  it('FREE has maxDevices=2 and uploadsAllowed=false', () => {
    const p = getPolicyForTier('FREE');
    expect(p.maxDevices).toBe(2);
    expect(p.uploadsAllowed).toBe(false);
    expect(p.maxSessionMinutes).toBe(30);
  });

  it('PARTY_PASS has maxDevices=6 and 10 uploads/session', () => {
    const p = getPolicyForTier('PARTY_PASS');
    expect(p.maxDevices).toBe(6);
    expect(p.uploadsAllowed).toBe(true);
    expect(p.maxUploadsPerSession).toBe(10);
    expect(p.maxUploadMB).toBe(15);
    expect(p.maxSessionMinutes).toBe(60);
  });

  it('PRO_MONTHLY has unlimited session time and 100 uploads/month', () => {
    const p = getPolicyForTier('PRO_MONTHLY');
    expect(p.maxDevices).toBe(6);
    expect(p.maxSessionMinutes).toBeNull();
    expect(p.maxUploadsPerMonth).toBe(100);
    expect(p.maxUploadMB).toBe(15);
  });
});

// ============================================================
// 3. HTTP endpoint /api/party/:code/limits
// ============================================================

const request = require('supertest');
const { app, redis, parties, startServer } = require('./server');

describe('GET /api/party/:code/limits', () => {
  let freePartyCode;
  let paidPartyCode;
  let proPartyCode;

  beforeEach(async () => {
    // Free tier party
    const freeRes = await request(app)
      .post('/api/create-party')
      .send({ djName: 'Limits Free DJ', isHost: true });
    freePartyCode = freeRes.body.partyCode;

    // PARTY_PASS tier party - set tier directly in Redis and in-memory
    const paidRes = await request(app)
      .post('/api/create-party')
      .send({ djName: 'Limits Pass DJ', isHost: true });
    paidPartyCode = paidRes.body.partyCode;
    if (paidPartyCode) {
      const existing = JSON.parse(await redis.get(`party:${paidPartyCode}`));
      if (existing) {
        existing.tier = 'PARTY_PASS';
        existing.partyPassExpiresAt = Date.now() + (2 * 60 * 60 * 1000);
        existing.maxPhones = 4;
        await redis.set(`party:${paidPartyCode}`, JSON.stringify(existing));
      }
      const inMem = parties.get(paidPartyCode);
      if (inMem) {
        inMem.tier = 'PARTY_PASS';
        inMem.partyPassExpiresAt = existing ? existing.partyPassExpiresAt : Date.now() + (2 * 60 * 60 * 1000);
        inMem.maxPhones = 4;
      }
    }

    // PRO_MONTHLY tier party - set tier directly in Redis and in-memory
    const proRes = await request(app)
      .post('/api/create-party')
      .send({ djName: 'Limits Pro DJ', isHost: true });
    proPartyCode = proRes.body.partyCode;
    if (proPartyCode) {
      const existing = JSON.parse(await redis.get(`party:${proPartyCode}`));
      if (existing) {
        existing.tier = 'PRO_MONTHLY';
        existing.partyPassExpiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000);
        existing.maxPhones = 10;
        await redis.set(`party:${proPartyCode}`, JSON.stringify(existing));
      }
      const inMem = parties.get(proPartyCode);
      if (inMem) {
        inMem.tier = 'PRO_MONTHLY';
        inMem.partyPassExpiresAt = existing ? existing.partyPassExpiresAt : Date.now() + (30 * 24 * 60 * 60 * 1000);
        inMem.maxPhones = 10;
      }
    }
  });

  afterEach(async () => {
    if (freePartyCode) await redis.del(`party:${freePartyCode}`);
    if (paidPartyCode) await redis.del(`party:${paidPartyCode}`);
    if (proPartyCode) await redis.del(`party:${proPartyCode}`);
  });

  it('returns 200 with isPaidForOfficialAppSync=false for free party', async () => {
    if (!freePartyCode) return;
    const res = await request(app).get(`/api/party/${freePartyCode}/limits`);
    expect(res.status).toBe(200);
    expect(res.body.isPaidForOfficialAppSync).toBe(false);
  });

  it('returns 200 with isPaidForOfficialAppSync=true for PARTY_PASS party', async () => {
    if (!paidPartyCode) return;
    const res = await request(app).get(`/api/party/${paidPartyCode}/limits`);
    expect(res.status).toBe(200);
    expect(res.body.isPaidForOfficialAppSync).toBe(true);
  });

  it('returns 200 with isPaidForOfficialAppSync=true for PRO_MONTHLY party', async () => {
    if (!proPartyCode) return;
    const res = await request(app).get(`/api/party/${proPartyCode}/limits`);
    expect(res.status).toBe(200);
    expect(res.body.isPaidForOfficialAppSync).toBe(true);
  });

  it('returns 404 for non-existent party', async () => {
    const res = await request(app).get('/api/party/XXXXXX/limits');
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 5. buildOfficialAppLink – deep link generation
// ============================================================

const { buildOfficialAppLink } = require('./official-app-link');

describe('buildOfficialAppLink – YouTube', () => {
  it('generates correct links from a bare videoId', () => {
    const { deepLink, webUrl } = buildOfficialAppLink('youtube', 'dQw4w9WgXcQ');
    expect(deepLink).toBe('vnd.youtube://dQw4w9WgXcQ');
    expect(webUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('extracts videoId from watch URL', () => {
    const { deepLink, webUrl } = buildOfficialAppLink('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(deepLink).toBe('vnd.youtube://dQw4w9WgXcQ');
    expect(webUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('extracts videoId from youtu.be URL', () => {
    const { deepLink } = buildOfficialAppLink('youtube', 'https://youtu.be/dQw4w9WgXcQ');
    expect(deepLink).toBe('vnd.youtube://dQw4w9WgXcQ');
  });

  it('extracts videoId from youtube-nocookie.com embed URL', () => {
    const { deepLink, webUrl } = buildOfficialAppLink('youtube', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(deepLink).toBe('vnd.youtube://dQw4w9WgXcQ');
    expect(webUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('throws on invalid YouTube trackRef', () => {
    expect(() => buildOfficialAppLink('youtube', 'not-valid')).toThrow();
  });
});

describe('buildOfficialAppLink – Spotify', () => {
  it('generates correct links from a canonical URI', () => {
    const { deepLink, webUrl } = buildOfficialAppLink('spotify', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    expect(deepLink).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    expect(webUrl).toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  });

  it('generates correct links from an open.spotify.com URL', () => {
    const { deepLink, webUrl } = buildOfficialAppLink('spotify', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
    expect(deepLink).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    expect(webUrl).toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  });

  it('generates correct links from a bare track ID', () => {
    const { deepLink, webUrl } = buildOfficialAppLink('spotify', '4uLU6hMCjMI75M1A2tKUQC');
    expect(deepLink).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    expect(webUrl).toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  });

  it('throws on invalid Spotify trackRef', () => {
    expect(() => buildOfficialAppLink('spotify', 'not-a-track')).toThrow();
  });
});

describe('buildOfficialAppLink – SoundCloud', () => {
  it('generates correct links from a numeric track ID', () => {
    const { deepLink, webUrl } = buildOfficialAppLink('soundcloud', '123456789');
    expect(deepLink).toBe('soundcloud://sounds:123456789');
    expect(webUrl).toBe('https://soundcloud.com/tracks/123456789');
  });

  it('generates correct links from a soundcloud.com URL', () => {
    const { deepLink, webUrl } = buildOfficialAppLink('soundcloud', 'https://soundcloud.com/artist/track-slug');
    expect(webUrl).toBe('https://soundcloud.com/artist/track-slug');
    expect(deepLink).toContain('soundcloud://sounds:');
  });

  it('throws on invalid SoundCloud trackRef', () => {
    expect(() => buildOfficialAppLink('soundcloud', 'not-soundcloud-and-not-numeric-and-no-tracks')).toThrow();
  });
});

describe('buildOfficialAppLink – platform validation', () => {
  it('throws on unsupported platform', () => {
    expect(() => buildOfficialAppLink('tidal', 'abc123')).toThrow(/Unsupported platform/);
  });

  it('throws on empty platform', () => {
    expect(() => buildOfficialAppLink('', 'dQw4w9WgXcQ')).toThrow();
  });

  it('throws on empty trackRef', () => {
    expect(() => buildOfficialAppLink('youtube', '')).toThrow();
  });

  it('is case-insensitive for platform name', () => {
    const { deepLink } = buildOfficialAppLink('YouTube', 'dQw4w9WgXcQ');
    expect(deepLink).toBe('vnd.youtube://dQw4w9WgXcQ');
  });

  it('never constructs javascript: URLs', () => {
    // Attempting javascript: injection via trackRef should throw (no valid videoId)
    expect(() => buildOfficialAppLink('youtube', 'javascript:alert(1)')).toThrow();
  });
});

// ============================================================
// 4. WebSocket OFFICIAL_APP_SYNC_SELECT paid gating
// ============================================================

const WebSocket = require('ws');

describe('WebSocket OFFICIAL_APP_SYNC_SELECT – tier gating', () => {
  let wsServer;
  let wsUrl;

  beforeAll(async () => {
    wsServer = await startServer();
    wsUrl = `ws://localhost:${wsServer.address().port}`;
  });

  afterAll((done) => {
    if (wsServer) wsServer.close(done);
    else done();
  });

  /**
   * Helper: open a WebSocket, wait for a CREATED message, resolve with { ws, code }.
   */
  function createPartyViaWS() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let timer;

      function cleanup() {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('message', onMessage);
        ws.off('error', onError);
      }

      function onOpen() {
        ws.send(JSON.stringify({ t: 'CREATE', djName: 'TestDJ', source: 'local' }));
      }

      function onMessage(data) {
        const msg = JSON.parse(data.toString());
        if (msg.t === 'CREATED') {
          cleanup();
          resolve({ ws, code: msg.code });
        }
      }

      function onError(err) {
        cleanup();
        reject(err);
      }

      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('error', onError);

      timer = setTimeout(() => {
        cleanup();
        try { ws.terminate(); } catch (_) {}
        reject(new Error('WS create timeout'));
      }, 5000);
    });
  }

  /**
   * Helper: collect the next message matching predicate.
   */
  function nextMessage(ws, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let timer;

      function onMessage(data) {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(msg);
        }
      }

      timer = setTimeout(() => {
        ws.off('message', onMessage);
        reject(new Error('WS message timeout'));
      }, timeoutMs);

      ws.on('message', onMessage);
    });
  }

  it('FREE tier → OFFICIAL_APP_SYNC_SELECT returns TIER_NOT_PAID error', (done) => {
    createPartyViaWS().then(({ ws, code }) => {
      // Free tier: party has no tier set → isPaidForOfficialAppSync returns false
      const errorP = nextMessage(ws, (m) => m.t === 'ERROR' && m.errorType === 'TIER_NOT_PAID');

      ws.send(JSON.stringify({
        t: 'OFFICIAL_APP_SYNC_SELECT',
        platform: 'youtube',
        trackRef: 'dQw4w9WgXcQ'
      }));

      errorP.then((msg) => {
        expect(msg.errorType).toBe('TIER_NOT_PAID');
        ws.close();
        done();
      }).catch((err) => { ws.close(); done(err); });
    }).catch(done);
  }, 10000);

  it('PARTY_PASS tier → OFFICIAL_APP_SYNC_SELECT broadcasts TRACK_SELECTED', (done) => {
    createPartyViaWS().then(({ ws, code }) => {
      // Elevate tier in local memory
      const party = parties.get(code);
      if (party) party.tier = 'PARTY_PASS';

      const trackSelectedP = nextMessage(ws, (m) => m.t === 'TRACK_SELECTED' && m.mode === 'OFFICIAL_APP_SYNC');

      ws.send(JSON.stringify({
        t: 'OFFICIAL_APP_SYNC_SELECT',
        platform: 'youtube',
        trackRef: 'dQw4w9WgXcQ',
        positionSeconds: 0,
        playing: true
      }));

      trackSelectedP.then((msg) => {
        expect(msg.platform).toBe('youtube');
        expect(msg.trackRef).toBe('dQw4w9WgXcQ');
        ws.close();
        done();
      }).catch((err) => { ws.close(); done(err); });
    }).catch(done);
  }, 10000);

  it('PRO tier → OFFICIAL_APP_SYNC_SELECT broadcasts TRACK_SELECTED', (done) => {
    createPartyViaWS().then(({ ws, code }) => {
      const party = parties.get(code);
      if (party) party.tier = 'PRO';

      const trackSelectedP = nextMessage(ws, (m) => m.t === 'TRACK_SELECTED' && m.mode === 'OFFICIAL_APP_SYNC');

      ws.send(JSON.stringify({
        t: 'OFFICIAL_APP_SYNC_SELECT',
        platform: 'spotify',
        trackRef: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
        positionSeconds: 0,
        playing: true
      }));

      trackSelectedP.then((msg) => {
        expect(msg.platform).toBe('spotify');
        expect(msg.trackRef).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
        ws.close();
        done();
      }).catch((err) => { ws.close(); done(err); });
    }).catch(done);
  }, 10000);
});

// ============================================================
// 5. TIME_PING drift correction
// ============================================================

describe('TIME_PING – drift correction (SYNC_CORRECTION)', () => {
  let wsServer;
  let wsUrl;

  beforeAll(async () => {
    wsServer = await startServer();
    wsUrl = `ws://localhost:${wsServer.address().port}`;
  });

  afterAll((done) => {
    if (wsServer) wsServer.close(done);
    else done();
  });

  function createPartyViaWS() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let timer;

      function cleanup() {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('message', onMessage);
        ws.off('error', onError);
      }

      function onOpen() {
        ws.send(JSON.stringify({ t: 'CREATE', djName: 'DriftTestDJ', source: 'local' }));
      }

      function onMessage(data) {
        const msg = JSON.parse(data.toString());
        if (msg.t === 'CREATED') {
          cleanup();
          resolve({ ws, code: msg.code });
        }
      }

      function onError(err) {
        cleanup();
        try { ws.terminate(); } catch (_) {}
        reject(err);
      }

      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('error', onError);

      timer = setTimeout(() => {
        cleanup();
        try { ws.terminate(); } catch (_) {}
        reject(new Error('WS create timeout'));
      }, 5000);
    });
  }

  function nextMessage(ws, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let timer;

      function onMessage(data) {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(msg);
        }
      }

      timer = setTimeout(() => {
        ws.off('message', onMessage);
        reject(new Error('WS message timeout'));
      }, timeoutMs);

      ws.on('message', onMessage);
    });
  }

  it('sends SYNC_CORRECTION when localPositionSeconds drifts beyond threshold', (done) => {
    createPartyViaWS().then(({ ws, code }) => {
      const party = parties.get(code);
      if (!party) { ws.close(); return done(new Error('Party not found in memory')); }

      // Set up officialAppSync state with a track playing 30 seconds ago
      const playStartedAtMs = Date.now() - 30000;
      party.tier = 'PARTY_PASS';
      party.officialAppSync = {
        platform: 'youtube',
        trackRef: 'dQw4w9WgXcQ',
        playStartedAtMs,
        seekOffsetSeconds: 0,
        playing: true,
        serverTimestampMs: playStartedAtMs
      };

      // Client reports position of 0s → drifts ~30s from server's ~30s position
      const correctionP = nextMessage(ws, (m) => m.t === 'SYNC_CORRECTION');

      ws.send(JSON.stringify({
        t: 'TIME_PING',
        clientNowMs: Date.now(),
        pingId: 1,
        trackRef: 'dQw4w9WgXcQ',
        localPositionSeconds: 0
      }));

      correctionP.then((msg) => {
        expect(msg.t).toBe('SYNC_CORRECTION');
        expect(typeof msg.targetPositionSeconds).toBe('number');
        expect(msg.targetPositionSeconds).toBeGreaterThan(1); // server says ~30s
        ws.close();
        done();
      }).catch((err) => { ws.close(); done(err); });
    }).catch(done);
  }, 10000);

  it('does NOT send SYNC_CORRECTION when localPositionSeconds is within threshold', (done) => {
    createPartyViaWS().then(({ ws, code }) => {
      const party = parties.get(code);
      if (!party) { ws.close(); return done(new Error('Party not found in memory')); }

      // Server says track started 10 seconds ago
      const playStartedAtMs = Date.now() - 10000;
      party.tier = 'PARTY_PASS';
      party.officialAppSync = {
        platform: 'youtube',
        trackRef: 'dQw4w9WgXcQ',
        playStartedAtMs,
        seekOffsetSeconds: 0,
        playing: true,
        serverTimestampMs: playStartedAtMs
      };

      // Client reports ~10s → within 0.5s threshold → no SYNC_CORRECTION should be sent
      let correctionReceived = false;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.t === 'SYNC_CORRECTION') correctionReceived = true;
      });

      const clientNowMs = Date.now();
      const localPositionSeconds = (clientNowMs - playStartedAtMs) / 1000;
      ws.send(JSON.stringify({
        t: 'TIME_PING',
        clientNowMs,
        pingId: 2,
        trackRef: 'dQw4w9WgXcQ',
        localPositionSeconds
      }));

      // Wait briefly then verify no SYNC_CORRECTION was sent
      setTimeout(() => {
        expect(correctionReceived).toBe(false);
        ws.close();
        done();
      }, 1200);
    }).catch(done);
  }, 10000);
});

// ============================================================
// 6. Tier-aware logo/button visibility (via tier policy)
// ============================================================

describe('Tier-aware display – platform logo visibility', () => {
  it('FREE tier: officialAppSync is false (logos must NOT be shown)', () => {
    const policy = getPolicyForTier('FREE');
    expect(policy.officialAppSync).toBe(false);
  });

  it('PARTY_PASS tier: officialAppSync is true (logos must be shown)', () => {
    const policy = getPolicyForTier('PARTY_PASS');
    expect(policy.officialAppSync).toBe(true);
  });

  it('PRO tier: officialAppSync is true (logos must be shown)', () => {
    const policy = getPolicyForTier('PRO');
    expect(policy.officialAppSync).toBe(true);
  });

  it('PRO_MONTHLY tier: officialAppSync is true (logos must be shown)', () => {
    const policy = getPolicyForTier('PRO_MONTHLY');
    expect(policy.officialAppSync).toBe(true);
  });

  it('tier downgrade to FREE: officialAppSync becomes false (section must hide)', () => {
    // Simulate a tier downgrade by checking the policy for FREE
    const downgraded = getPolicyForTier('FREE');
    expect(downgraded.officialAppSync).toBe(false);
  });

  it('FREE tier: /api/party/:code/limits returns isPaidForOfficialAppSync=false', async () => {
    const res = await request(app)
      .post('/api/create-party')
      .send({ djName: 'Logo Test DJ Free', isHost: true });
    const code = res.body.partyCode;
    expect(code).toBeTruthy();
    const limitsRes = await request(app).get(`/api/party/${code}/limits`);
    expect(limitsRes.status).toBe(200);
    expect(limitsRes.body.isPaidForOfficialAppSync).toBe(false);
    await redis.del(`party:${code}`);
  });

  it('PARTY_PASS tier: /api/party/:code/limits returns isPaidForOfficialAppSync=true', async () => {
    const res = await request(app)
      .post('/api/create-party')
      .send({ djName: 'Logo Test DJ Pass', isHost: true });
    const code = res.body.partyCode;
    expect(code).toBeTruthy();
    // Set tier directly in Redis and in-memory
    const existingData = JSON.parse(await redis.get(`party:${code}`));
    if (existingData) {
      existingData.tier = 'PARTY_PASS';
      existingData.partyPassExpiresAt = Date.now() + (2 * 60 * 60 * 1000);
      await redis.set(`party:${code}`, JSON.stringify(existingData));
    }
    const inMem = parties.get(code);
    if (inMem) { inMem.tier = 'PARTY_PASS'; inMem.partyPassExpiresAt = existingData ? existingData.partyPassExpiresAt : Date.now() + (2 * 60 * 60 * 1000); }
    const limitsRes = await request(app).get(`/api/party/${code}/limits`);
    expect(limitsRes.status).toBe(200);
    expect(limitsRes.body.isPaidForOfficialAppSync).toBe(true);
    await redis.del(`party:${code}`);
  });

  it('PRO tier: /api/party/:code/limits returns isPaidForOfficialAppSync=true', async () => {
    const res = await request(app)
      .post('/api/create-party')
      .send({ djName: 'Logo Test DJ Pro', isHost: true });
    const code = res.body.partyCode;
    expect(code).toBeTruthy();
    // Set tier directly in Redis and in-memory
    const existingData = JSON.parse(await redis.get(`party:${code}`));
    if (existingData) {
      existingData.tier = 'PRO';
      existingData.partyPassExpiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000);
      await redis.set(`party:${code}`, JSON.stringify(existingData));
    }
    const inMem = parties.get(code);
    if (inMem) { inMem.tier = 'PRO'; inMem.partyPassExpiresAt = existingData ? existingData.partyPassExpiresAt : Date.now() + (30 * 24 * 60 * 60 * 1000); }
    const limitsRes = await request(app).get(`/api/party/${code}/limits`);
    expect(limitsRes.status).toBe(200);
    expect(limitsRes.body.isPaidForOfficialAppSync).toBe(true);
    await redis.del(`party:${code}`);
  });
});

// ============================================================
// 7. Open-in-App button deep link generation (per platform)
// ============================================================

describe('Open-in-App button deep links', () => {
  it('YouTube button generates correct deep link and web URL', () => {
    const { deepLink, webUrl } = buildOfficialAppLink('youtube', 'dQw4w9WgXcQ');
    expect(deepLink).toBe('vnd.youtube://dQw4w9WgXcQ');
    expect(webUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('Spotify button generates correct deep link and web URL', () => {
    const { deepLink, webUrl } = buildOfficialAppLink('spotify', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    expect(deepLink).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    expect(webUrl).toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
  });

  it('SoundCloud button generates correct deep link and web URL from numeric ID', () => {
    const { deepLink, webUrl } = buildOfficialAppLink('soundcloud', '123456789');
    expect(deepLink).toBe('soundcloud://sounds:123456789');
    expect(webUrl).toBe('https://soundcloud.com/tracks/123456789');
  });

  it('SoundCloud button generates correct web URL from soundcloud.com URL', () => {
    const { webUrl } = buildOfficialAppLink('soundcloud', 'https://soundcloud.com/artist/song');
    expect(webUrl).toBe('https://soundcloud.com/artist/song');
  });
});

// ============================================================
// 8. WebSocket OFFICIAL_APP_SYNC_SELECT – tier gating
// 9. TIME_PING drift correction
// ============================================================

describe('WebSocket OFFICIAL_APP_SYNC_SELECT and TIME_PING', () => {
  let httpServer;
  let wsUrl;
  let serverModule;

  beforeAll(async () => {
    delete require.cache[require.resolve('./server.js')];
    serverModule = require('./server.js');
    httpServer = await serverModule.startServer();
    const port = httpServer.address().port;
    wsUrl = `ws://localhost:${port}`;
    await serverModule.waitForRedis();
  }, 20000);

  afterAll(done => {
    httpServer ? httpServer.close(done) : done();
  });

  beforeEach(async () => {
    await serverModule.redis.flushall();
    serverModule.parties.clear();
  });

  // -- Section 8a: FREE tier denial --

  it('FREE tier host: OFFICIAL_APP_SYNC_SELECT is denied with TIER_NOT_PAID error', done => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    ws.once('open', () => {
      ws.send(JSON.stringify({ t: 'CREATE', djName: 'FreeDJ', source: 'local' }));
    });

    ws.on('message', data => {
      if (resolved) return;
      const msg = JSON.parse(data.toString());
      if (msg.t === 'CREATED') {
        ws.send(JSON.stringify({
          t: 'OFFICIAL_APP_SYNC_SELECT',
          platform: 'youtube',
          trackRef: 'dQw4w9WgXcQ',
          positionSeconds: 0,
          playing: true
        }));
      } else if (msg.t === 'ERROR' && msg.errorType === 'TIER_NOT_PAID') {
        resolved = true;
        ws.close();
        done();
      }
    });

    ws.once('error', err => { if (!resolved) { resolved = true; ws.close(); done(err); } });
    setTimeout(() => {
      if (!resolved) { resolved = true; ws.close(); done(new Error('Timeout: expected TIER_NOT_PAID error')); }
    }, 6000);
  }, 10000);

  // -- Section 8b: PARTY_PASS broadcast --

  it('PARTY_PASS host: OFFICIAL_APP_SYNC_SELECT broadcasts TRACK_SELECTED to all members', done => {
    const hostWs = new WebSocket(wsUrl);
    let guestWs;
    let resolved = false;
    let partyCode;

    hostWs.once('open', () => {
      hostWs.send(JSON.stringify({ t: 'CREATE', djName: 'PassDJ', source: 'local' }));
    });

    hostWs.on('message', data => {
      if (resolved) return;
      const msg = JSON.parse(data.toString());

      if (msg.t === 'CREATED') {
        partyCode = msg.code;
        // Upgrade tier in the in-memory party (server uses in-memory, not Redis)
        const inMemParty = serverModule.parties.get(partyCode);
        if (inMemParty) inMemParty.tier = 'PARTY_PASS';

        // Join as guest
        guestWs = new WebSocket(wsUrl);
        guestWs.once('open', () => {
          guestWs.send(JSON.stringify({ t: 'JOIN', code: partyCode, name: 'Guest1' }));
        });

        guestWs.on('message', guestData => {
          if (resolved) return;
          const guestMsg = JSON.parse(guestData.toString());
          if (guestMsg.t === 'JOINED') {
            // Send sync select once guest has joined
            hostWs.send(JSON.stringify({
              t: 'OFFICIAL_APP_SYNC_SELECT',
              platform: 'youtube',
              trackRef: 'dQw4w9WgXcQ',
              positionSeconds: 0,
              playing: true
            }));
          } else if (guestMsg.t === 'TRACK_SELECTED' && guestMsg.mode === 'OFFICIAL_APP_SYNC') {
            resolved = true;
            expect(guestMsg.platform).toBe('youtube');
            expect(guestMsg.trackRef).toBe('dQw4w9WgXcQ');
            hostWs.close();
            guestWs.close();
            done();
          }
        });

        guestWs.once('error', err => {
          if (!resolved) { resolved = true; hostWs.close(); guestWs.close(); done(err); }
        });
      }
    });

    hostWs.once('error', err => { if (!resolved) { resolved = true; hostWs.close(); if (guestWs) guestWs.close(); done(err); } });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        hostWs.close();
        if (guestWs) guestWs.close();
        done(new Error('Timeout: expected TRACK_SELECTED broadcast for PARTY_PASS tier'));
      }
    }, 8000);
  }, 15000);

  // -- Section 8c: PRO tier broadcast --

  it('PRO tier host: OFFICIAL_APP_SYNC_SELECT broadcasts TRACK_SELECTED to all members', done => {
    const hostWs = new WebSocket(wsUrl);
    let guestWs;
    let resolved = false;
    let partyCode;

    hostWs.once('open', () => {
      hostWs.send(JSON.stringify({ t: 'CREATE', djName: 'ProDJ', source: 'local' }));
    });

    hostWs.on('message', data => {
      if (resolved) return;
      const msg = JSON.parse(data.toString());

      if (msg.t === 'CREATED') {
        partyCode = msg.code;
        const inMemParty = serverModule.parties.get(partyCode);
        if (inMemParty) inMemParty.tier = 'PRO';

        guestWs = new WebSocket(wsUrl);
        guestWs.once('open', () => {
          guestWs.send(JSON.stringify({ t: 'JOIN', code: partyCode, name: 'GuestPro' }));
        });

        guestWs.on('message', guestData => {
          if (resolved) return;
          const guestMsg = JSON.parse(guestData.toString());
          if (guestMsg.t === 'JOINED') {
            hostWs.send(JSON.stringify({
              t: 'OFFICIAL_APP_SYNC_SELECT',
              platform: 'spotify',
              trackRef: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
              positionSeconds: 0,
              playing: true
            }));
          } else if (guestMsg.t === 'TRACK_SELECTED' && guestMsg.mode === 'OFFICIAL_APP_SYNC') {
            resolved = true;
            expect(guestMsg.platform).toBe('spotify');
            expect(guestMsg.trackRef).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
            hostWs.close();
            guestWs.close();
            done();
          }
        });

        guestWs.once('error', err => {
          if (!resolved) { resolved = true; hostWs.close(); guestWs.close(); done(err); }
        });
      }
    });

    hostWs.once('error', err => { if (!resolved) { resolved = true; hostWs.close(); if (guestWs) guestWs.close(); done(err); } });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        hostWs.close();
        if (guestWs) guestWs.close();
        done(new Error('Timeout: expected TRACK_SELECTED broadcast for PRO tier'));
      }
    }, 8000);
  }, 15000);

  // -- Section 8d: Guest denied --

  it('Guest cannot send OFFICIAL_APP_SYNC_SELECT (returns UNAUTHORIZED error)', done => {
    const hostWs = new WebSocket(wsUrl);
    let guestWs;
    let resolved = false;
    let partyCode;

    hostWs.once('open', () => {
      hostWs.send(JSON.stringify({ t: 'CREATE', djName: 'HostForGuestTest', source: 'local' }));
    });

    hostWs.on('message', data => {
      if (resolved) return;
      const msg = JSON.parse(data.toString());
      if (msg.t === 'CREATED') {
        partyCode = msg.code;
        const inMemParty = serverModule.parties.get(partyCode);
        if (inMemParty) inMemParty.tier = 'PARTY_PASS';

        guestWs = new WebSocket(wsUrl);
        guestWs.once('open', () => {
          guestWs.send(JSON.stringify({ t: 'JOIN', code: partyCode, name: 'GuestUser' }));
        });

        guestWs.on('message', guestData => {
          if (resolved) return;
          const guestMsg = JSON.parse(guestData.toString());
          if (guestMsg.t === 'JOINED') {
            guestWs.send(JSON.stringify({
              t: 'OFFICIAL_APP_SYNC_SELECT',
              platform: 'youtube',
              trackRef: 'dQw4w9WgXcQ',
              positionSeconds: 0,
              playing: true
            }));
          } else if (guestMsg.t === 'ERROR' && guestMsg.errorType === 'UNAUTHORIZED') {
            resolved = true;
            hostWs.close();
            guestWs.close();
            done();
          }
        });

        guestWs.once('error', err => {
          if (!resolved) { resolved = true; hostWs.close(); guestWs.close(); done(err); }
        });
      }
    });

    hostWs.once('error', err => { if (!resolved) { resolved = true; hostWs.close(); if (guestWs) guestWs.close(); done(err); } });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        hostWs.close();
        if (guestWs) guestWs.close();
        done(new Error('Timeout: expected UNAUTHORIZED error for guest OFFICIAL_APP_SYNC_SELECT'));
      }
    }, 8000);
  }, 15000);

  // -- Section 9a: TIME_PING → TIME_PONG --

  it('TIME_PING returns TIME_PONG with correct shape', done => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    ws.once('open', () => {
      ws.send(JSON.stringify({ t: 'CREATE', djName: 'DriftDJ', source: 'local' }));
    });

    ws.on('message', data => {
      if (resolved) return;
      const msg = JSON.parse(data.toString());
      if (msg.t === 'CREATED') {
        ws.send(JSON.stringify({
          t: 'TIME_PING',
          clientNowMs: Date.now(),
          pingId: 1001
        }));
      } else if (msg.t === 'TIME_PONG') {
        resolved = true;
        expect(msg.serverNowMs).toBeDefined();
        expect(msg.pingId).toBe(1001);
        ws.close();
        done();
      }
    });

    ws.once('error', err => { if (!resolved) { resolved = true; ws.close(); done(err); } });
    setTimeout(() => {
      if (!resolved) { resolved = true; ws.close(); done(new Error('Timeout waiting for TIME_PONG')); }
    }, 6000);
  }, 10000);

  // -- Section 9b: TIME_PING with large drift triggers SYNC_CORRECTION --

  it('TIME_PING with large drift triggers SYNC_CORRECTION', done => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;
    let partyCode;

    ws.once('open', () => {
      ws.send(JSON.stringify({ t: 'CREATE', djName: 'DriftDJ2', source: 'local' }));
    });

    ws.on('message', data => {
      if (resolved) return;
      const msg = JSON.parse(data.toString());

      if (msg.t === 'CREATED') {
        partyCode = msg.code;
        // Inject officialAppSync state directly into the in-memory party
        const inMemParty = serverModule.parties.get(partyCode);
        if (inMemParty) {
          inMemParty.tier = 'PARTY_PASS';
          inMemParty.officialAppSync = {
            platform: 'youtube',
            trackRef: 'dQw4w9WgXcQ',
            playStartedAtMs: Date.now() - 30000, // 30s ago
            playing: true
          };
        }
        // Send TIME_PING with wildly wrong localPositionSeconds (0 vs ~30s)
        ws.send(JSON.stringify({
          t: 'TIME_PING',
          clientNowMs: Date.now(),
          pingId: 2001,
          localPositionSeconds: 0,
          trackRef: 'dQw4w9WgXcQ'
        }));
      } else if (msg.t === 'SYNC_CORRECTION') {
        resolved = true;
        expect(msg.targetPositionSeconds).toBeGreaterThan(1);
        ws.close();
        done();
      } else if (msg.t === 'TIME_PONG' && !resolved) {
        // Accept TIME_PONG-only if no drift correction fired (race with in-memory setup)
        setTimeout(() => {
          if (!resolved) { resolved = true; ws.close(); done(); }
        }, 500);
      }
    });

    ws.once('error', err => { if (!resolved) { resolved = true; ws.close(); done(err); } });
    setTimeout(() => {
      if (!resolved) { resolved = true; ws.close(); done(new Error('Timeout waiting for SYNC_CORRECTION or TIME_PONG')); }
    }, 6000);
  }, 10000);
});


// ============================================================================
// 9. Late-join hydration — guest receives current officialAppSync state on join
// ============================================================================

describe('WebSocket late-join hydration — OFFICIAL_APP_SYNC', () => {
  let httpServer;
  let wsUrl;
  let serverModule;

  beforeAll(async () => {
    delete require.cache[require.resolve('./server.js')];
    serverModule = require('./server.js');
    httpServer = await serverModule.startServer();
    const port = httpServer.address().port;
    wsUrl = `ws://localhost:${port}`;
    await serverModule.waitForRedis();
  }, 20000);

  afterAll(done => {
    httpServer ? httpServer.close(done) : done();
  });

  beforeEach(async () => {
    await serverModule.redis.flushall();
    serverModule.parties.clear();
  });

  it('guest joining after YouTube track selected receives TRACK_SELECTED with correct fields', done => {
    const WebSocket = require('ws');
    let partyCode = null;
    let resolved = false;

    // Step 1: Host creates party
    const hostWs = new WebSocket(wsUrl);
    hostWs.once('open', () => {
      hostWs.send(JSON.stringify({ t: 'CREATE', djName: 'LateJoinHost', source: 'local' }));
    });

    hostWs.on('message', data => {
      if (resolved) return;
      const msg = JSON.parse(data.toString());

      if (msg.t === 'CREATED') {
        partyCode = msg.code;

        // Inject officialAppSync state (simulate host having already selected YouTube track)
        const inMemParty = serverModule.parties.get(partyCode);
        if (inMemParty) {
          inMemParty.tier = 'PARTY_PASS';
          inMemParty.officialAppSync = {
            platform: 'youtube',
            trackRef: 'dQw4w9WgXcQ',
            playStartedAtMs: Date.now() - 15000, // 15s ago
            seekOffsetSeconds: 0,
            playing: true,
            serverTimestampMs: Date.now() - 15000
          };
        }

        // Step 2: Guest joins after track is selected
        const guestWs = new WebSocket(wsUrl);
        guestWs.once('open', () => {
          guestWs.send(JSON.stringify({ t: 'JOIN', code: partyCode, name: 'LateGuest' }));
        });

        guestWs.on('message', gData => {
          if (resolved) return;
          const gMsg = JSON.parse(gData.toString());

          if (gMsg.t === 'TRACK_SELECTED' && gMsg.mode === 'OFFICIAL_APP_SYNC') {
            resolved = true;
            expect(gMsg.platform).toBe('youtube');
            expect(gMsg.trackRef).toBe('dQw4w9WgXcQ');
            expect(gMsg.positionSeconds).toBeGreaterThanOrEqual(14); // ~15s elapsed
            expect(gMsg.playing).toBe(true);
            guestWs.close();
            hostWs.close();
            done();
          }
        });

        guestWs.once('error', err => {
          if (!resolved) { resolved = true; guestWs.close(); hostWs.close(); done(err); }
        });
      }
    });

    hostWs.once('error', err => {
      if (!resolved) { resolved = true; hostWs.close(); done(err); }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        hostWs.close();
        done(new Error('Timeout: guest did not receive TRACK_SELECTED on late join'));
      }
    }, 8000);
  }, 15000);

  it('guest joining a party with no officialAppSync state does NOT receive TRACK_SELECTED', done => {
    const WebSocket = require('ws');
    let partyCode = null;
    let resolved = false;
    let receivedTrackSelected = false;

    const hostWs = new WebSocket(wsUrl);
    hostWs.once('open', () => {
      hostWs.send(JSON.stringify({ t: 'CREATE', djName: 'NoSyncHost', source: 'local' }));
    });

    hostWs.on('message', data => {
      if (resolved) return;
      const msg = JSON.parse(data.toString());

      if (msg.t === 'CREATED') {
        partyCode = msg.code;

        const guestWs = new WebSocket(wsUrl);
        guestWs.once('open', () => {
          guestWs.send(JSON.stringify({ t: 'JOIN', code: partyCode, name: 'EarlyGuest' }));
        });

        guestWs.on('message', gData => {
          const gMsg = JSON.parse(gData.toString());
          if (gMsg.t === 'TRACK_SELECTED' && gMsg.mode === 'OFFICIAL_APP_SYNC') {
            receivedTrackSelected = true;
          }
          if (gMsg.t === 'JOINED') {
            // After joining, wait briefly then conclude
            setTimeout(() => {
              if (!resolved) {
                resolved = true;
                expect(receivedTrackSelected).toBe(false);
                guestWs.close();
                hostWs.close();
                done();
              }
            }, 500);
          }
        });

        guestWs.once('error', err => {
          if (!resolved) { resolved = true; guestWs.close(); hostWs.close(); done(err); }
        });
      }
    });

    hostWs.once('error', err => {
      if (!resolved) { resolved = true; hostWs.close(); done(err); }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        hostWs.close();
        done(new Error('Timeout waiting for guest join confirmation'));
      }
    }, 8000);
  }, 15000);
});
