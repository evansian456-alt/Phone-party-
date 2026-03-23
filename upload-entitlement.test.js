'use strict';
/**
 * upload-entitlement.test.js
 *
 * Comprehensive unit tests for the upload entitlement system.
 * Covers: access rules, file validation, Party Pass limits, monthly fair-usage,
 *         add-on grants, upsell payload, admin stats, DB error resilience.
 *
 * Does NOT require a live DB — all DB interactions are mocked inline.
 */

const uploadEntitlement = require('./upload-entitlement');
const cfg               = require('./upload-config');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal mock db with configurable query responses */
function makeDb(queryImpl) {
  return { query: queryImpl || jest.fn().mockResolvedValue({ rows: [] }) };
}

/** Build a db that returns the given rows for every query */
function dbReturning(rows) {
  return makeDb(jest.fn().mockResolvedValue({ rows }));
}

/** Build a db whose query always rejects */
function dbFailing(msg = 'DB error') {
  return makeDb(jest.fn().mockRejectedValue(new Error(msg)));
}

// ─── 1. checkUploadAccess ────────────────────────────────────────────────────

describe('checkUploadAccess', () => {
  it('blocks free-tier users (null entitlements)', () => {
    const result = uploadEntitlement.checkUploadAccess(null);
    expect(result.allowed).toBe(false);
    expect(result.tier).toBe('FREE');
    expect(result.reason).toBe('free_tier');
  });

  it('blocks free-tier users (no flags set)', () => {
    const result = uploadEntitlement.checkUploadAccess({ hasPartyPass: false, hasPro: false });
    expect(result.allowed).toBe(false);
    expect(result.tier).toBe('FREE');
    expect(result.upgradeMessage).toMatch(/party pass|monthly/i);
  });

  it('allows Party Pass users', () => {
    const result = uploadEntitlement.checkUploadAccess({ hasPartyPass: true, hasPro: false });
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe('PARTY_PASS');
  });

  it('allows Monthly (Pro) users', () => {
    const result = uploadEntitlement.checkUploadAccess({ hasPartyPass: false, hasPro: true });
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe('PRO_MONTHLY');
  });

  it('treats hasPro=true as PRO_MONTHLY even if hasPartyPass is false', () => {
    const result = uploadEntitlement.checkUploadAccess({ hasPartyPass: false, hasPro: true });
    expect(result.tier).toBe('PRO_MONTHLY');
  });
});

// ─── 2. validateUploadFile ───────────────────────────────────────────────────

describe('validateUploadFile', () => {
  const BASE = {
    filename:  'song.mp3',
    mimeType:  'audio/mpeg',
    sizeBytes: 1024 * 1024, // 1 MB
    tier:      'PRO_MONTHLY',
  };

  describe('filename validation', () => {
    it('rejects missing filename', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, filename: '' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/filename/i);
    });

    it('rejects whitespace-only filename', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, filename: '   ' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/filename/i);
    });

    it('rejects null filename', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, filename: null });
      expect(r.valid).toBe(false);
    });
  });

  describe('extension validation', () => {
    it('rejects non-audio extension (.exe)', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, filename: 'malware.exe' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/not allowed/i);
    });

    it('rejects .mp4 extension', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, filename: 'video.mp4', mimeType: 'audio/mp4' });
      expect(r.valid).toBe(false);
    });

    it('accepts .mp3 extension', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, filename: 'track.mp3' });
      expect(r.valid).toBe(true);
    });

    it('accepts .wav extension', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, filename: 'track.wav', mimeType: 'audio/wav' });
      expect(r.valid).toBe(true);
    });

    it('accepts .flac extension', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, filename: 'track.flac', mimeType: 'audio/flac' });
      expect(r.valid).toBe(true);
    });

    it('accepts .m4a extension', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, filename: 'track.m4a', mimeType: 'audio/mp4' });
      expect(r.valid).toBe(true);
    });
  });

  describe('MIME type validation', () => {
    it('rejects missing mimeType', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, mimeType: null });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/mime/i);
    });

    it('rejects video/mp4 mimeType', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, mimeType: 'video/mp4' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/not allowed/i);
    });

    it('rejects application/octet-stream mimeType', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, mimeType: 'application/octet-stream' });
      expect(r.valid).toBe(false);
    });

    it('accepts audio/mpeg', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, mimeType: 'audio/mpeg' });
      expect(r.valid).toBe(true);
    });

    it('accepts audio/ogg', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, filename: 'track.ogg', mimeType: 'audio/ogg' });
      expect(r.valid).toBe(true);
    });
  });

  describe('size validation', () => {
    it('rejects zero-byte file', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, sizeBytes: 0 });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/empty/i);
    });

    it('rejects negative sizeBytes', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, sizeBytes: -1 });
      expect(r.valid).toBe(false);
    });

    it('rejects Infinity sizeBytes', () => {
      const r = uploadEntitlement.validateUploadFile({ ...BASE, sizeBytes: Infinity });
      expect(r.valid).toBe(false);
    });

    it('rejects file exceeding PRO_MONTHLY cap', () => {
      const r = uploadEntitlement.validateUploadFile({
        ...BASE,
        tier:      'PRO_MONTHLY',
        sizeBytes: cfg.MONTHLY_MAX_FILE_BYTES + 1,
      });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/too large/i);
    });

    it('rejects file exceeding PARTY_PASS cap', () => {
      const r = uploadEntitlement.validateUploadFile({
        ...BASE,
        tier:      'PARTY_PASS',
        sizeBytes: cfg.PARTY_PASS_MAX_FILE_BYTES + 1,
      });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/too large/i);
    });

    it('accepts file at exactly PARTY_PASS cap', () => {
      const r = uploadEntitlement.validateUploadFile({
        ...BASE,
        tier:      'PARTY_PASS',
        sizeBytes: cfg.PARTY_PASS_MAX_FILE_BYTES,
      });
      expect(r.valid).toBe(true);
    });

    it('PARTY_PASS cap is lower than PRO_MONTHLY cap', () => {
      expect(cfg.PARTY_PASS_MAX_FILE_BYTES).toBeLessThan(cfg.MONTHLY_MAX_FILE_BYTES);
    });
  });
});

// ─── 3. getMaxFileBytesForTier ───────────────────────────────────────────────

describe('getMaxFileBytesForTier', () => {
  it('returns MONTHLY cap for PRO_MONTHLY', () => {
    expect(uploadEntitlement.getMaxFileBytesForTier('PRO_MONTHLY')).toBe(cfg.MONTHLY_MAX_FILE_BYTES);
  });

  it('returns MONTHLY cap for PRO alias', () => {
    expect(uploadEntitlement.getMaxFileBytesForTier('PRO')).toBe(cfg.MONTHLY_MAX_FILE_BYTES);
  });

  it('returns PARTY_PASS cap for PARTY_PASS', () => {
    expect(uploadEntitlement.getMaxFileBytesForTier('PARTY_PASS')).toBe(cfg.PARTY_PASS_MAX_FILE_BYTES);
  });

  it('falls back to PARTY_PASS cap for FREE (defensive)', () => {
    expect(uploadEntitlement.getMaxFileBytesForTier('FREE')).toBe(cfg.PARTY_PASS_MAX_FILE_BYTES);
  });
});

// ─── 4. Party Pass upload counting & limit ───────────────────────────────────

describe('checkPartyPassUploadLimit', () => {
  const PARTY = 'TESTPARTY';

  function makeCountDb(count, addons = 0) {
    return makeDb(jest.fn()
      .mockResolvedValueOnce({ rows: [{ cnt: String(count) }] })         // getPartyUploadCount
      .mockResolvedValueOnce({ rows: [{ total: String(addons) }] })      // getPartyAddonAllowance
    );
  }

  it('allows when under the base limit', async () => {
    const db = makeCountDb(cfg.PARTY_PASS_UPLOAD_LIMIT - 1);
    const result = await uploadEntitlement.checkPartyPassUploadLimit(db, PARTY);
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(cfg.PARTY_PASS_UPLOAD_LIMIT - 1);
    expect(result.remaining).toBe(1);
  });

  it('blocks when at the base limit (no add-ons)', async () => {
    const db = makeCountDb(cfg.PARTY_PASS_UPLOAD_LIMIT);
    const result = await uploadEntitlement.checkPartyPassUploadLimit(db, PARTY);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.upsell).toBeDefined();
  });

  it('add-on extends the limit correctly', async () => {
    const EXTRA = cfg.EXTRA_SONG_BUNDLE_SIZES[0]; // e.g. 5
    // Used all base slots, but has add-on
    const db = makeCountDb(cfg.PARTY_PASS_UPLOAD_LIMIT, EXTRA);
    const result = await uploadEntitlement.checkPartyPassUploadLimit(db, PARTY);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(cfg.PARTY_PASS_UPLOAD_LIMIT + EXTRA);
    expect(result.addons).toBe(EXTRA);
  });

  it('blocks when used exceeds base+addons', async () => {
    const EXTRA = cfg.EXTRA_SONG_BUNDLE_SIZES[0];
    const db = makeCountDb(cfg.PARTY_PASS_UPLOAD_LIMIT + EXTRA, EXTRA);
    const result = await uploadEntitlement.checkPartyPassUploadLimit(db, PARTY);
    expect(result.allowed).toBe(false);
  });

  it('returns remaining = 0 when exactly at limit', async () => {
    const db = makeCountDb(cfg.PARTY_PASS_UPLOAD_LIMIT);
    const result = await uploadEntitlement.checkPartyPassUploadLimit(db, PARTY);
    expect(result.remaining).toBe(0);
  });

  it('handles DB failure gracefully (fail-safe counts as 0)', async () => {
    const db = dbFailing('relation "party_uploads" does not exist');
    const result = await uploadEntitlement.checkPartyPassUploadLimit(db, PARTY);
    // count=0, addons=0 → allowed
    expect(result.allowed).toBe(true);
  });
});

// ─── 5. buildUpsellPayload ───────────────────────────────────────────────────

describe('buildUpsellPayload', () => {
  it('contains limitReachedMessage mentioning the limit', () => {
    const p = uploadEntitlement.buildUpsellPayload(15, 15);
    expect(p.limitReachedMessage).toMatch(/15/);
  });

  it('lists all configured bundle sizes', () => {
    const p = uploadEntitlement.buildUpsellPayload(15, 15);
    const sizes = p.addOnBundles.map(b => b.extraSongs);
    expect(sizes).toEqual(cfg.EXTRA_SONG_BUNDLE_SIZES);
  });

  it('includes a monthly upgrade option', () => {
    const p = uploadEntitlement.buildUpsellPayload(15, 15);
    expect(p.monthlyUpgrade).toBeDefined();
    expect(p.monthlyUpgrade.label).toMatch(/monthly/i);
  });

  it('each bundle has a positive extraSongs count', () => {
    const p = uploadEntitlement.buildUpsellPayload(15, 15);
    p.addOnBundles.forEach(b => expect(b.extraSongs).toBeGreaterThan(0));
  });
});

// ─── 6. Monthly fair-usage ───────────────────────────────────────────────────

describe('checkMonthlyFairUsage', () => {
  it('allows when under count threshold', async () => {
    const db = dbReturning([{ cnt: '1', total_bytes: '1000000' }]);
    const result = await uploadEntitlement.checkMonthlyFairUsage(db, 'user-1');
    expect(result.allowed).toBe(true);
  });

  it('blocks when upload count hits the fair-usage cap', async () => {
    const db = dbReturning([{ cnt: String(cfg.MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW), total_bytes: '0' }]);
    const result = await uploadEntitlement.checkMonthlyFairUsage(db, 'user-1');
    expect(result.allowed).toBe(false);
    expect(result.flaggedForReview).toBe(true);
    expect(result.reason).toMatch(/limit/i);
  });

  it('blocks when storage threshold is exceeded', async () => {
    const highBytes = cfg.MONTHLY_FAIR_USAGE_STORAGE_MB * 1024 * 1024 + 1;
    const db = dbReturning([{ cnt: '1', total_bytes: String(highBytes) }]);
    const result = await uploadEntitlement.checkMonthlyFairUsage(db, 'user-1');
    expect(result.allowed).toBe(false);
    expect(result.flaggedForReview).toBe(true);
  });

  it('fails open when DB is unavailable (soft check)', async () => {
    const db = dbFailing('DB connection error');
    const result = await uploadEntitlement.checkMonthlyFairUsage(db, 'user-1');
    expect(result.allowed).toBe(true);
  });
});

// ─── 7. recordUpload ─────────────────────────────────────────────────────────

describe('recordUpload', () => {
  const BASE_UPLOAD = {
    partyCode:        'TESTPARTY',
    uploaderUserId:   'user-123',
    trackId:          'TRACK001',
    storageKey:       'tracks/TRACK001.mp3',
    originalFilename: 'song.mp3',
    sizeBytes:        1024 * 1024,
    mimeType:         'audio/mpeg',
    entitlementType:  'PARTY_PASS',
  };

  it('inserts a row and returns it', async () => {
    const fakeRow = { id: 'uuid-1', ...BASE_UPLOAD, created_at: new Date().toISOString() };
    const db = dbReturning([fakeRow]);
    const row = await uploadEntitlement.recordUpload(db, BASE_UPLOAD);
    expect(row).toEqual(fakeRow);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO party_uploads/i);
    expect(params).toContain('TESTPARTY');
    expect(params).toContain('user-123');
    expect(params).toContain('TRACK001');
  });

  it('sets expires_at for PARTY_PASS uploads', async () => {
    const fakeRow = { id: 'uuid-2', expires_at: new Date().toISOString() };
    const db = dbReturning([fakeRow]);
    await uploadEntitlement.recordUpload(db, { ...BASE_UPLOAD, entitlementType: 'PARTY_PASS' });
    const params = db.query.mock.calls[0][1];
    const expiresAt = params.find(p => p instanceof Date || (typeof p === 'string' && p.includes('T')));
    expect(expiresAt).toBeTruthy();
  });

  it('sets expires_at to null for PRO_MONTHLY uploads', async () => {
    const fakeRow = { id: 'uuid-3', expires_at: null };
    const db = dbReturning([fakeRow]);
    await uploadEntitlement.recordUpload(db, { ...BASE_UPLOAD, entitlementType: 'PRO_MONTHLY' });
    const params = db.query.mock.calls[0][1];
    // The 9th param is expiresAt — should be null for PRO_MONTHLY
    const expiresAt = params[8];
    expect(expiresAt).toBeNull();
  });
});

// ─── 8. grantUploadAddon ────────────────────────────────────────────────────

describe('grantUploadAddon', () => {
  it('inserts an addon row and returns it', async () => {
    const fakeRow = { id: 'addon-uuid-1', party_code: 'PARTY1', user_id: 'user-1', extra_songs: 5, status: 'active' };
    const db = dbReturning([fakeRow]);
    const row = await uploadEntitlement.grantUploadAddon(db, {
      partyCode:   'PARTY1',
      userId:      'user-1',
      extraSongs:  5,
      purchaseRef: 'stripe-ch-123',
    });
    expect(row).toEqual(fakeRow);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO party_upload_addons/i);
    expect(params).toContain('PARTY1');
    expect(params).toContain(5);
    expect(params).toContain('stripe-ch-123');
  });

  it('sets purchaseRef to null when not provided', async () => {
    const db = dbReturning([{ id: 'addon-2' }]);
    await uploadEntitlement.grantUploadAddon(db, {
      partyCode:  'PARTY1',
      userId:     'user-1',
      extraSongs: 10,
    });
    const params = db.query.mock.calls[0][1];
    expect(params).toContain(null); // purchaseRef
  });
});

// ─── 9. Admin stats helpers ─────────────────────────────────────────────────

describe('getUploadStatsByUser', () => {
  it('runs the aggregation query and returns rows', async () => {
    const fakeRows = [
      { uploader_user_id: 'u1', entitlement_type: 'PRO_MONTHLY', upload_count: '5', total_bytes: '5242880' },
    ];
    const db = dbReturning(fakeRows);
    const rows = await uploadEntitlement.getUploadStatsByUser(db);
    expect(rows).toEqual(fakeRows);
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/GROUP BY uploader_user_id/i);
  });
});

describe('getUploadStatsByParty', () => {
  it('runs the aggregation query and returns rows', async () => {
    const fakeRows = [{ party_code: 'PARTY1', upload_count: '3', total_bytes: '3145728' }];
    const db = dbReturning(fakeRows);
    const rows = await uploadEntitlement.getUploadStatsByParty(db);
    expect(rows).toEqual(fakeRows);
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/GROUP BY party_code/i);
  });
});

describe('getSuspiciousUploaders', () => {
  it('returns uploaders above the fair-usage threshold', async () => {
    const fakeRows = [{ uploader_user_id: 'u99', upload_count: '999', total_bytes: '999000000' }];
    const db = dbReturning(fakeRows);
    const rows = await uploadEntitlement.getSuspiciousUploaders(db);
    expect(rows).toEqual(fakeRows);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/HAVING COUNT/i);
    expect(params[1]).toBe(cfg.MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW);
  });
});

// ─── 10. upload-config sanity checks ────────────────────────────────────────

describe('upload-config defaults', () => {
  it('PARTY_PASS_UPLOAD_LIMIT is a positive integer', () => {
    expect(Number.isInteger(cfg.PARTY_PASS_UPLOAD_LIMIT)).toBe(true);
    expect(cfg.PARTY_PASS_UPLOAD_LIMIT).toBeGreaterThan(0);
  });

  it('PARTY_PASS_MAX_FILE_MB is a positive integer', () => {
    expect(cfg.PARTY_PASS_MAX_FILE_MB).toBeGreaterThan(0);
  });

  it('MONTHLY_MAX_FILE_MB >= PARTY_PASS_MAX_FILE_MB', () => {
    expect(cfg.MONTHLY_MAX_FILE_MB).toBeGreaterThanOrEqual(cfg.PARTY_PASS_MAX_FILE_MB);
  });

  it('EXTRA_SONG_BUNDLE_SIZES is a non-empty array of positive integers', () => {
    expect(Array.isArray(cfg.EXTRA_SONG_BUNDLE_SIZES)).toBe(true);
    expect(cfg.EXTRA_SONG_BUNDLE_SIZES.length).toBeGreaterThan(0);
    cfg.EXTRA_SONG_BUNDLE_SIZES.forEach(n => {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    });
  });

  it('ALLOWED_AUDIO_MIME_TYPES includes common audio types', () => {
    expect(cfg.ALLOWED_AUDIO_MIME_TYPES.has('audio/mpeg')).toBe(true);
    expect(cfg.ALLOWED_AUDIO_MIME_TYPES.has('audio/wav')).toBe(true);
    expect(cfg.ALLOWED_AUDIO_MIME_TYPES.has('audio/flac')).toBe(true);
  });

  it('ALLOWED_AUDIO_EXTENSIONS includes common extensions', () => {
    expect(cfg.ALLOWED_AUDIO_EXTENSIONS.has('.mp3')).toBe(true);
    expect(cfg.ALLOWED_AUDIO_EXTENSIONS.has('.wav')).toBe(true);
    expect(cfg.ALLOWED_AUDIO_EXTENSIONS.has('.flac')).toBe(true);
  });

  it('MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW is positive', () => {
    expect(cfg.MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW).toBeGreaterThan(0);
  });

  it('PARTY_UPLOAD_RETENTION_HOURS is positive', () => {
    expect(cfg.PARTY_UPLOAD_RETENTION_HOURS).toBeGreaterThan(0);
  });
});
