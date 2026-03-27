'use strict';
/**
 * upload-entitlement.test.js
 *
 * Unit tests for the upload entitlement system.
 * Tests calculateUploadEntitlement, isAllowedMimeType, isFileSizeAllowed,
 * recordUpload, grantAddonToParty, and upload-config sanity.
 */

const {
  calculateUploadEntitlement,
  recordUpload,
  grantAddonToParty,
  getPartyAddonBundleCount,
  isAllowedMimeType,
  isFileSizeAllowed,
  _resetMemStores,
} = require('./upload-entitlement');

const cfg = require('./upload-config');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(queryImpl) {
  return { query: queryImpl || jest.fn().mockResolvedValue({ rows: [] }) };
}

function dbReturning(rows) {
  return makeDb(jest.fn().mockResolvedValue({ rows }));
}

function dbFailing(msg = 'DB error') {
  return makeDb(jest.fn().mockRejectedValue(new Error(msg)));
}

beforeEach(() => {
  _resetMemStores();
});

// ─── 1. isAllowedMimeType ─────────────────────────────────────────────────────

describe('isAllowedMimeType', () => {
  it('accepts audio/mpeg', () => {
    expect(isAllowedMimeType('audio/mpeg')).toBe(true);
  });

  it('accepts audio/wav', () => {
    expect(isAllowedMimeType('audio/wav')).toBe(true);
  });

  it('accepts audio/flac', () => {
    expect(isAllowedMimeType('audio/flac')).toBe(true);
  });

  it('accepts audio/ogg', () => {
    expect(isAllowedMimeType('audio/ogg')).toBe(true);
  });

  it('rejects video/mp4', () => {
    expect(isAllowedMimeType('video/mp4')).toBe(false);
  });

  it('rejects application/octet-stream', () => {
    expect(isAllowedMimeType('application/octet-stream')).toBe(false);
  });

  it('rejects null/undefined', () => {
    expect(isAllowedMimeType(null)).toBe(false);
    expect(isAllowedMimeType(undefined)).toBe(false);
    expect(isAllowedMimeType('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isAllowedMimeType('AUDIO/MPEG')).toBe(true);
  });

  it('strips charset suffix (audio/mpeg; charset=utf-8)', () => {
    expect(isAllowedMimeType('audio/mpeg; charset=utf-8')).toBe(true);
  });
});

// ─── 2. isFileSizeAllowed ────────────────────────────────────────────────────

describe('isFileSizeAllowed', () => {
  const MAX = cfg.PARTY_PASS_MAX_FILE_BYTES;

  it('allows file at exactly the cap', () => {
    expect(isFileSizeAllowed(MAX, MAX)).toBe(true);
  });

  it('rejects file exceeding the cap', () => {
    expect(isFileSizeAllowed(MAX + 1, MAX)).toBe(false);
  });

  it('rejects zero bytes', () => {
    expect(isFileSizeAllowed(0, MAX)).toBe(false);
  });

  it('rejects negative bytes', () => {
    expect(isFileSizeAllowed(-1, MAX)).toBe(false);
  });

  it('rejects when maxFileSizeBytes is 0 (FREE tier)', () => {
    expect(isFileSizeAllowed(1024, 0)).toBe(false);
  });

  it('allows PRO file under monthly cap', () => {
    expect(isFileSizeAllowed(cfg.PARTY_PASS_MAX_FILE_BYTES + 1, cfg.MONTHLY_MAX_FILE_BYTES)).toBe(true);
  });
});

// ─── 3. upload-config sanity ─────────────────────────────────────────────────

describe('upload-config defaults', () => {
  it('PARTY_PASS_UPLOAD_LIMIT is a positive integer', () => {
    expect(Number.isInteger(cfg.PARTY_PASS_UPLOAD_LIMIT)).toBe(true);
    expect(cfg.PARTY_PASS_UPLOAD_LIMIT).toBeGreaterThan(0);
  });

  it('PARTY_PASS_MAX_FILE_MB is positive', () => {
    expect(cfg.PARTY_PASS_MAX_FILE_MB).toBeGreaterThan(0);
  });

  it('MONTHLY_MAX_FILE_MB >= PARTY_PASS_MAX_FILE_MB', () => {
    expect(cfg.MONTHLY_MAX_FILE_MB).toBeGreaterThanOrEqual(cfg.PARTY_PASS_MAX_FILE_MB);
  });

  it('MONTHLY_MAX_FILE_BYTES = MONTHLY_MAX_FILE_MB * 1024 * 1024', () => {
    expect(cfg.MONTHLY_MAX_FILE_BYTES).toBe(cfg.MONTHLY_MAX_FILE_MB * 1024 * 1024);
  });

  it('PARTY_PASS_MAX_FILE_BYTES = PARTY_PASS_MAX_FILE_MB * 1024 * 1024', () => {
    expect(cfg.PARTY_PASS_MAX_FILE_BYTES).toBe(cfg.PARTY_PASS_MAX_FILE_MB * 1024 * 1024);
  });

  it('ALLOWED_AUDIO_MIME_TYPES includes common types', () => {
    expect(cfg.ALLOWED_AUDIO_MIME_TYPES).toContain('audio/mpeg');
    expect(cfg.ALLOWED_AUDIO_MIME_TYPES).toContain('audio/wav');
    expect(cfg.ALLOWED_AUDIO_MIME_TYPES).toContain('audio/flac');
  });

  it('ALLOWED_AUDIO_EXTENSIONS includes common extensions', () => {
    expect(cfg.ALLOWED_AUDIO_EXTENSIONS).toContain('.mp3');
    expect(cfg.ALLOWED_AUDIO_EXTENSIONS).toContain('.wav');
    expect(cfg.ALLOWED_AUDIO_EXTENSIONS).toContain('.flac');
  });

  it('ADDON_BUNDLES has at least one bundle', () => {
    expect(Object.keys(cfg.ADDON_BUNDLES).length).toBeGreaterThan(0);
  });

  it('each addon bundle has songs > 0', () => {
    Object.values(cfg.ADDON_BUNDLES).forEach(b => {
      expect(b.songs).toBeGreaterThan(0);
    });
  });

  it('MONTHLY_FAIR_USAGE_LIMIT is positive', () => {
    expect(cfg.MONTHLY_FAIR_USAGE_LIMIT).toBeGreaterThan(0);
  });
});

// ─── 4. calculateUploadEntitlement — FREE tier ────────────────────────────────

describe('calculateUploadEntitlement — FREE tier', () => {
  it('blocks FREE users', async () => {
    const result = await calculateUploadEntitlement({
      userId: 'u1', partyCode: 'P1', tier: 'FREE',
    });
    expect(result.allowed).toBe(false);
    expect(result.tier).toBe('FREE');
    expect(result.upsell).toBe('upgrade');
  });

  it('returns 0 maxFileSizeBytes for FREE', async () => {
    const result = await calculateUploadEntitlement({
      userId: 'u1', partyCode: 'P1', tier: 'FREE',
    });
    expect(result.maxFileSizeBytes).toBe(0);
  });
});

// ─── 5. calculateUploadEntitlement — MONTHLY/PRO tier ────────────────────────

describe('calculateUploadEntitlement — MONTHLY tier', () => {
  it('allows PRO_MONTHLY users without a count limit', async () => {
    const result = await calculateUploadEntitlement({
      userId: 'u1', partyCode: 'P1', tier: 'PRO_MONTHLY',
    });
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe('MONTHLY');
    expect(result.totalLimit).toBeNull();
    expect(result.remaining).toBeNull();
  });

  it('allows PRO alias', async () => {
    const result = await calculateUploadEntitlement({
      userId: 'u1', partyCode: 'P1', tier: 'PRO',
    });
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe('MONTHLY');
  });

  it('uses MONTHLY_MAX_FILE_BYTES for file size cap', async () => {
    const result = await calculateUploadEntitlement({
      userId: 'u1', partyCode: 'P1', tier: 'PRO_MONTHLY',
    });
    expect(result.maxFileSizeBytes).toBe(cfg.MONTHLY_MAX_FILE_BYTES);
  });

  it('includes fairUsageLimit', async () => {
    const result = await calculateUploadEntitlement({
      userId: 'u1', partyCode: 'P1', tier: 'PRO_MONTHLY',
    });
    expect(result.fairUsageLimit).toBe(cfg.MONTHLY_FAIR_USAGE_LIMIT);
  });
});

// ─── 6. calculateUploadEntitlement — ADMIN bypass ────────────────────────────

describe('calculateUploadEntitlement — ADMIN bypass', () => {
  it('allows admin regardless of tier', async () => {
    const result = await calculateUploadEntitlement({
      userId: 'admin1', partyCode: 'P1', tier: 'FREE', isAdmin: true,
    });
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe('ADMIN');
    expect(result.totalLimit).toBeNull();
  });
});

// ─── 7. calculateUploadEntitlement — PARTY_PASS (in-memory fallback) ─────────

describe('calculateUploadEntitlement — PARTY_PASS (memory fallback)', () => {
  it('allows when no uploads used yet', async () => {
    const result = await calculateUploadEntitlement({
      userId: 'u1', partyCode: 'PARTY1', tier: 'PARTY_PASS', db: null,
    });
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe('PARTY_PASS');
    expect(result.used).toBe(0);
    expect(result.baseLimit).toBe(cfg.PARTY_PASS_UPLOAD_LIMIT);
  });

  it('blocks when base limit reached via recordUpload', async () => {
    const userId = 'u2';
    const partyCode = 'PARTY2';

    // Fill up the limit using recordUpload with null db (memory fallback)
    for (let i = 0; i < cfg.PARTY_PASS_UPLOAD_LIMIT; i++) {
      await recordUpload({ userId, partyCode, db: null });
    }

    const result = await calculateUploadEntitlement({
      userId, partyCode, tier: 'PARTY_PASS', db: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.upsell).toBe('limit_reached');
  });

  it('shows upsell=addon when running low (<=3 remaining)', async () => {
    const userId = 'u3';
    const partyCode = 'PARTY3';
    const uploadCount = cfg.PARTY_PASS_UPLOAD_LIMIT - 2; // 2 remaining

    for (let i = 0; i < uploadCount; i++) {
      await recordUpload({ userId, partyCode, db: null });
    }

    const result = await calculateUploadEntitlement({
      userId, partyCode, tier: 'PARTY_PASS', db: null,
    });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
    expect(result.upsell).toBe('addon');
  });

  it('uses PARTY_PASS_MAX_FILE_BYTES for size cap', async () => {
    const result = await calculateUploadEntitlement({
      userId: 'u4', partyCode: 'PARTY4', tier: 'PARTY_PASS', db: null,
    });
    expect(result.maxFileSizeBytes).toBe(cfg.PARTY_PASS_MAX_FILE_BYTES);
  });
});

// ─── 8. recordUpload — in-memory ─────────────────────────────────────────────

describe('recordUpload (memory fallback)', () => {
  it('increments upload count', async () => {
    await recordUpload({ userId: 'u1', partyCode: 'P1', db: null });
    await recordUpload({ userId: 'u1', partyCode: 'P1', db: null });

    const result = await calculateUploadEntitlement({
      userId: 'u1', partyCode: 'P1', tier: 'PARTY_PASS', db: null,
    });
    expect(result.used).toBe(2);
  });

  it('tracks counts per (userId, partyCode) independently', async () => {
    await recordUpload({ userId: 'u1', partyCode: 'P1', db: null });
    await recordUpload({ userId: 'u1', partyCode: 'P2', db: null });
    await recordUpload({ userId: 'u2', partyCode: 'P1', db: null });

    const r1 = await calculateUploadEntitlement({ userId: 'u1', partyCode: 'P1', tier: 'PARTY_PASS', db: null });
    const r2 = await calculateUploadEntitlement({ userId: 'u1', partyCode: 'P2', tier: 'PARTY_PASS', db: null });
    const r3 = await calculateUploadEntitlement({ userId: 'u2', partyCode: 'P1', tier: 'PARTY_PASS', db: null });

    expect(r1.used).toBe(1);
    expect(r2.used).toBe(1);
    expect(r3.used).toBe(1);
  });
});

// ─── 9. grantAddonToParty — validation ───────────────────────────────────────

describe('grantAddonToParty — input validation', () => {
  const validArgs = {
    userId: 'u1',
    partyCode: 'P1',
    addonKey: 'extra_songs_5',
    extraSongs: 5,
    transactionId: 'stripe-ch-123',
    db: null,
  };

  it('throws if userId is missing', async () => {
    await expect(grantAddonToParty({ ...validArgs, userId: '' })).rejects.toThrow(/userId/i);
  });

  it('throws if partyCode is missing', async () => {
    await expect(grantAddonToParty({ ...validArgs, partyCode: '' })).rejects.toThrow(/partyCode/i);
  });

  it('throws if addonKey is missing', async () => {
    await expect(grantAddonToParty({ ...validArgs, addonKey: '' })).rejects.toThrow(/addonKey/i);
  });

  it('throws if extraSongs < 1', async () => {
    await expect(grantAddonToParty({ ...validArgs, extraSongs: 0 })).rejects.toThrow(/extraSongs/i);
  });

  it('throws if transactionId is missing', async () => {
    await expect(grantAddonToParty({ ...validArgs, transactionId: '' })).rejects.toThrow(/transactionId/i);
  });
});

// ─── 10. grantAddonToParty — in-memory extension ─────────────────────────────

describe('grantAddonToParty (memory fallback)', () => {
  it('extends the limit after grant', async () => {
    const userId = 'u1';
    const partyCode = 'P10';

    // Use all base slots
    for (let i = 0; i < cfg.PARTY_PASS_UPLOAD_LIMIT; i++) {
      await recordUpload({ userId, partyCode, db: null });
    }

    // Without addon: blocked
    const before = await calculateUploadEntitlement({ userId, partyCode, tier: 'PARTY_PASS', db: null });
    expect(before.allowed).toBe(false);

    // Grant 5 extra
    await grantAddonToParty({
      userId, partyCode,
      addonKey: 'extra_songs_5',
      extraSongs: 5,
      transactionId: 'txn-001',
      db: null,
    });

    // Now allowed with 5 remaining
    const after = await calculateUploadEntitlement({ userId, partyCode, tier: 'PARTY_PASS', db: null });
    expect(after.allowed).toBe(true);
    expect(after.addonExtra).toBe(5);
    expect(after.remaining).toBe(5);
  });
});
