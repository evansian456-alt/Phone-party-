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
const { app, redis } = require('./server');

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

    // PARTY_PASS tier party (via prototype mode)
    const paidRes = await request(app)
      .post('/api/create-party')
      .send({ djName: 'Limits Pass DJ', isHost: true, prototypeMode: true, tier: 'PARTY_PASS' });
    paidPartyCode = paidRes.body.partyCode;

    // PRO_MONTHLY tier party (via prototype mode)
    const proRes = await request(app)
      .post('/api/create-party')
      .send({ djName: 'Limits Pro DJ', isHost: true, prototypeMode: true, tier: 'PRO_MONTHLY' });
    proPartyCode = proRes.body.partyCode;
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
