/**
 * Tests for POST /api/tracks/presign-put hardening
 * Covers: input validation, extension normalization, prefix normalization, success response
 */

const request = require('supertest');
const {
  app, waitForRedis, _setStorageProvider, TRACK_MAX_BYTES,
} = require('./server');
const { generateToken } = require('./auth-middleware');

// Helper: make a valid auth cookie for a test user
function makeAuthCookie(overrides = {}) {
  const token = generateToken({ userId: 'test-user-id', email: 'test@example.com', ...overrides });
  return `auth_token=${token}`;
}

describe('POST /api/tracks/presign-put', () => {
  const VALID_BODY = {
    filename: 'song.mp3',
    contentType: 'audio/mpeg',
    sizeBytes: 1024 * 1024 // 1MB
  };

  // Set up a mock storage provider with generatePresignedPutUrl support
  let mockProvider;
  let authCookie;

  beforeAll(async () => {
    try {
      await waitForRedis();
    } catch (_) {
      // Redis mock may not be ready; that's fine for these tests
    }
  });

  beforeEach(() => {
    authCookie = makeAuthCookie();

    mockProvider = {
      generatePresignedPutUrl: jest.fn().mockResolvedValue({
        putUrl: 'https://r2.example.com/signed-put-url',
        key: 'tracks/TESTTRACK001.mp3'
      })
    };
    _setStorageProvider(mockProvider);
  });

  afterEach(() => {
    _setStorageProvider(null);
  });

  // ── auth gate ─────────────────────────────────────────────────────────────

  it('returns 401 when no auth cookie is provided', async () => {
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  // ── contentType validation ────────────────────────────────────────────────

  it('returns 400 when contentType is missing', async () => {
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send({ filename: 'song.mp3', sizeBytes: 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mime.?type|content.?type/i);
  });

  it('returns 400 when contentType is not audio/*', async () => {
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send({ ...VALID_BODY, contentType: 'video/mp4' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed|audio|unsupported/i);
  });

  it('returns 400 when contentType is application/octet-stream', async () => {
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send({ ...VALID_BODY, contentType: 'application/octet-stream' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed|audio|unsupported/i);
  });

  // ── sizeBytes validation ──────────────────────────────────────────────────

  it('returns 400 when sizeBytes is missing', async () => {
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send({ filename: 'song.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty|size/i);
  });

  it('returns 400 when sizeBytes is 0', async () => {
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send({ ...VALID_BODY, sizeBytes: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty|size/i);
  });

  it('returns 400 when sizeBytes is negative', async () => {
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send({ ...VALID_BODY, sizeBytes: -100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty|size/i);
  });

  it('returns 400 when sizeBytes is Infinity', async () => {
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send({ ...VALID_BODY, sizeBytes: Infinity });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty|size/i);
  });

  it('returns 400 when sizeBytes exceeds maximum allowed', async () => {
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send({ ...VALID_BODY, sizeBytes: TRACK_MAX_BYTES + 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large|size/i);
  });

  // ── filename validation ───────────────────────────────────────────────────

  it('returns 400 when filename is missing', async () => {
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send({ contentType: 'audio/mpeg', sizeBytes: 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/filename/i);
  });

  it('returns 400 when filename is empty string', async () => {
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send({ ...VALID_BODY, filename: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/filename/i);
  });

  // ── success path ─────────────────────────────────────────────────────────

  it('returns 200 with putUrl, key, and trackUrl on valid input', async () => {
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.putUrl).toBeDefined();
    expect(res.body.key).toBeDefined();
    expect(res.body.trackUrl).toBeDefined();
    expect(res.body.trackId).toBeDefined();
  });

  // ── extension normalization ───────────────────────────────────────────────

  it('key uses lowercase extension when contentType maps to extension', async () => {
    mockProvider.generatePresignedPutUrl.mockResolvedValue({
      putUrl: 'https://r2.example.com/signed',
      key: 'tracks/TESTTRACK001.mp3'
    });
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send({ ...VALID_BODY, contentType: 'audio/mpeg', filename: 'SONG.MP3' });
    expect(res.status).toBe(200);
    // Verify the key returned has a lowercase extension
    expect(res.body.key).toMatch(/\.mp3$/);
  });

  // ── prefix normalization (via S3Provider constructor) ────────────────────

  it('accepts audio/wav content type', async () => {
    mockProvider.generatePresignedPutUrl.mockResolvedValue({
      putUrl: 'https://r2.example.com/signed',
      key: 'tracks/TESTTRACK001.wav'
    });
    const res = await request(app)
      .post('/api/tracks/presign-put')
      .set('Cookie', authCookie)
      .send({ ...VALID_BODY, contentType: 'audio/wav', filename: 'song.wav' });
    expect(res.status).toBe(200);
    expect(res.body.key).toBeDefined();
  });
});

// ── Storage utility: extension normalization ──────────────────────────────

describe('storage/utils getExtensionFromFilename', () => {
  const { getExtensionFromFilename } = require('./storage/utils');

  it('returns lowercase extension', () => {
    expect(getExtensionFromFilename('SONG.MP3')).toBe('.mp3');
  });

  it('returns lowercase for mixed case', () => {
    expect(getExtensionFromFilename('Track.M4A')).toBe('.m4a');
  });

  it('returns null for no extension', () => {
    expect(getExtensionFromFilename('noext')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(getExtensionFromFilename('')).toBeNull();
  });
});

// ── S3Provider: prefix normalization ────────────────────────────────────

describe('S3Provider prefix normalization', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function makeProvider(prefixValue) {
    const S3Provider = require('./storage/s3');
    if (prefixValue === undefined) {
      delete process.env.S3_PREFIX;
    } else {
      process.env.S3_PREFIX = prefixValue;
    }
    return new S3Provider();
  }

  it('defaults to "tracks/" when S3_PREFIX not set', () => {
    const provider = makeProvider(undefined);
    expect(provider.prefix).toBe('tracks/');
  });

  it('appends "/" when S3_PREFIX is set without trailing slash', () => {
    const provider = makeProvider('tracks');
    expect(provider.prefix).toBe('tracks/');
  });

  it('keeps prefix as-is when it already ends with "/"', () => {
    const provider = makeProvider('tracks/');
    expect(provider.prefix).toBe('tracks/');
  });

  it('uses empty string when S3_PREFIX is ""', () => {
    const provider = makeProvider('');
    expect(provider.prefix).toBe('');
  });
});
