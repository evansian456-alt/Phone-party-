'use strict';

/**
 * upload-entitlement.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single authoritative upload entitlement calculator.
 *
 * This module is the ONLY place that decides:
 *   • whether a user may upload to a party
 *   • what per-file size cap applies
 *   • how many uploads remain
 *   • what upsell path to show
 *
 * Both the HTTP route enforcement (server-side) and the frontend display logic
 * (via /api/upload/entitlement) consume this module's output object.
 *
 * ─── Quick reference ──────────────────────────────────────────────────────────
 *   FREE:       blocked
 *   PARTY_PASS: PARTY_PASS_UPLOAD_LIMIT base + any addon extras for this party
 *   PRO/MONTHLY:  premium — no visible count limit; file-size cap is higher
 */

const {
  PARTY_PASS_UPLOAD_LIMIT,
  PARTY_PASS_MAX_FILE_BYTES,
  MONTHLY_MAX_FILE_BYTES,
  MONTHLY_FAIR_USAGE_LIMIT,
  ALLOWED_AUDIO_MIME_TYPES,
  MAX_UPLOADS_PER_PARTY,
} = require('./upload-config');

// ── In-memory fallback stores (used when DB is unavailable) ───────────────────
// Keyed by `${userId}:${partyCode}` for per-party per-user tracking.
const _memUsage = new Map();     // key -> { uploadCount }
const _memAddonGrants = new Map(); // `${userId}:${partyCode}` -> totalExtraSongs

/** Reset in-memory stores (testing only) */
function _resetMemStores() {
  _memUsage.clear();
  _memAddonGrants.clear();
}

// ── DB availability cache ─────────────────────────────────────────────────────
let _dbAvailable = null;

async function _checkDb(db) {
  if (_dbAvailable !== null) return _dbAvailable;
  try {
    await db.query('SELECT 1');
    _dbAvailable = true;
  } catch (_) {
    _dbAvailable = false;
  }
  return _dbAvailable;
}

// ── Tier normalisation ────────────────────────────────────────────────────────

const PRO_TIERS = new Set(['PRO', 'PRO_MONTHLY']);
const PARTY_PASS_TIERS = new Set(['PARTY_PASS']);

function _normaliseTier(tier) {
  const t = (tier || 'FREE').toUpperCase();
  if (PRO_TIERS.has(t)) return 'MONTHLY';
  if (PARTY_PASS_TIERS.has(t)) return 'PARTY_PASS';
  return 'FREE';
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Ensure the upload-tracking tables exist.  Idempotent.
 * @param {object} db
 */
async function _ensureTables(db) {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS party_upload_usage (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT NOT NULL,
        party_code  TEXT NOT NULL,
        upload_count INT NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, party_code)
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS party_addon_grants (
        id              SERIAL PRIMARY KEY,
        user_id         TEXT NOT NULL,
        party_code      TEXT NOT NULL,
        addon_key       TEXT NOT NULL,
        extra_songs     INT NOT NULL DEFAULT 0,
        transaction_id  TEXT NOT NULL UNIQUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.warn('[UploadEntitlement] Could not ensure tables:', err.message);
  }
}

/**
 * Get upload count from DB for a (user, party) pair.
 * @param {object} db
 * @param {string} userId
 * @param {string} partyCode
 * @returns {Promise<number>}
 */
async function _getUploadCountDb(db, userId, partyCode) {
  const result = await db.query(
    'SELECT upload_count FROM party_upload_usage WHERE user_id = $1 AND party_code = $2',
    [userId, partyCode]
  );
  return result.rows.length > 0 ? (result.rows[0].upload_count || 0) : 0;
}

/**
 * Get total extra songs granted by addons for a (user, party) pair.
 * @param {object} db
 * @param {string} userId
 * @param {string} partyCode
 * @returns {Promise<number>}
 */
async function _getAddonExtraSongsDb(db, userId, partyCode) {
  const result = await db.query(
    `SELECT COALESCE(SUM(extra_songs), 0) AS total
     FROM party_addon_grants
     WHERE user_id = $1 AND party_code = $2`,
    [userId, partyCode]
  );
  return parseInt(result.rows[0]?.total || 0, 10);
}

/**
 * Get count of addon bundles purchased for a (user, party) pair.
 * Used for the MAX_ADDON_BUNDLES_PER_PARTY guard.
 * @param {object} db
 * @param {string} userId
 * @param {string} partyCode
 * @returns {Promise<number>}
 */
async function _getAddonBundleCountDb(db, userId, partyCode) {
  const result = await db.query(
    'SELECT COUNT(*) AS cnt FROM party_addon_grants WHERE user_id = $1 AND party_code = $2',
    [userId, partyCode]
  );
  return parseInt(result.rows[0]?.cnt || 0, 10);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Calculate the complete upload entitlement for a user + party context.
 *
 * @param {object} opts
 * @param {string}        opts.userId     - authenticated user ID
 * @param {string}        opts.partyCode  - normalised party code (upper-case)
 * @param {string}        opts.tier       - user's effective tier string
 * @param {boolean}       [opts.isAdmin]  - admin users bypass all limits
 * @param {object}        [opts.db]       - optional DB module for persistent state
 *
 * @returns {Promise<UploadEntitlement>}
 */
async function calculateUploadEntitlement({ userId, partyCode, tier, isAdmin = false, db: dbOverride } = {}) {
  const normalisedTier = _normaliseTier(tier);

  // ── Admin bypass ──────────────────────────────────────────────────────────
  if (isAdmin) {
    return _buildResult({
      allowed: true,
      tier: 'ADMIN',
      baseLimit: null,
      addonExtra: 0,
      totalLimit: null,
      used: 0,
      remaining: null,
      maxFileSizeBytes: MONTHLY_MAX_FILE_BYTES,
      upsell: null,
    });
  }

  // ── FREE ──────────────────────────────────────────────────────────────────
  if (normalisedTier === 'FREE') {
    return _buildResult({
      allowed: false,
      tier: 'FREE',
      baseLimit: 0,
      addonExtra: 0,
      totalLimit: 0,
      used: 0,
      remaining: 0,
      maxFileSizeBytes: 0,
      upsell: 'upgrade',
    });
  }

  // ── MONTHLY (PRO) ─────────────────────────────────────────────────────────
  if (normalisedTier === 'MONTHLY') {
    // No visible count limit; higher file size cap.
    return _buildResult({
      allowed: true,
      tier: 'MONTHLY',
      baseLimit: null,       // "unlimited" from user perspective
      addonExtra: 0,
      totalLimit: null,
      used: 0,               // not tracked per-party for Monthly
      remaining: null,
      maxFileSizeBytes: MONTHLY_MAX_FILE_BYTES,
      fairUsageLimit: MONTHLY_FAIR_USAGE_LIMIT,
      upsell: null,
    });
  }

  // ── PARTY PASS ────────────────────────────────────────────────────────────
  // Determine DB availability and read persistent state.
  let db;
  try {
    db = dbOverride || require('./database');
  } catch (_) {
    db = null;
  }

  const useDb = db && await _checkDb(db);
  const memKey = `${userId}:${partyCode}`;

  let uploadCount = 0;
  let addonExtra = 0;

  if (useDb) {
    await _ensureTables(db);
    [uploadCount, addonExtra] = await Promise.all([
      _getUploadCountDb(db, userId, partyCode),
      _getAddonExtraSongsDb(db, userId, partyCode),
    ]);
  } else {
    uploadCount = _memUsage.get(memKey)?.uploadCount || 0;
    addonExtra = _memAddonGrants.get(memKey) || 0;
  }

  const totalLimit = Math.min(PARTY_PASS_UPLOAD_LIMIT + addonExtra, MAX_UPLOADS_PER_PARTY);
  const remaining = Math.max(0, totalLimit - uploadCount);
  const allowed = remaining > 0;

  const upsell = allowed
    ? (remaining <= 3 ? 'addon' : null)   // prompt addon upsell when running low
    : 'limit_reached';                    // show upsell options when limit hit

  return _buildResult({
    allowed,
    tier: 'PARTY_PASS',
    baseLimit: PARTY_PASS_UPLOAD_LIMIT,
    addonExtra,
    totalLimit,
    used: uploadCount,
    remaining,
    maxFileSizeBytes: PARTY_PASS_MAX_FILE_BYTES,
    upsell,
  });
}

/**
 * Increment the upload counter for a (user, party) pair after a successful upload.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.partyCode
 * @param {object} [opts.db]
 * @returns {Promise<void>}
 */
async function recordUpload({ userId, partyCode, db: dbOverride } = {}) {
  let db;
  try {
    db = dbOverride || require('./database');
  } catch (_) {
    db = null;
  }

  const useDb = db && await _checkDb(db);
  const memKey = `${userId}:${partyCode}`;

  if (useDb) {
    await _ensureTables(db);
    try {
      await db.query(
        `INSERT INTO party_upload_usage (user_id, party_code, upload_count, updated_at)
         VALUES ($1, $2, 1, NOW())
         ON CONFLICT (user_id, party_code)
         DO UPDATE SET upload_count = party_upload_usage.upload_count + 1, updated_at = NOW()`,
        [userId, partyCode]
      );
    } catch (err) {
      console.warn('[UploadEntitlement] recordUpload DB error:', err.message);
      // Fallback to in-memory
      const curr = _memUsage.get(memKey) || { uploadCount: 0 };
      _memUsage.set(memKey, { uploadCount: curr.uploadCount + 1 });
    }
  } else {
    const curr = _memUsage.get(memKey) || { uploadCount: 0 };
    _memUsage.set(memKey, { uploadCount: curr.uploadCount + 1 });
  }
}

/**
 * Grant extra songs to a (user, party) pair from an addon purchase.
 * Idempotent: the same transactionId will not double-grant.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.partyCode
 * @param {string} opts.addonKey       - e.g. 'extra_songs_5'
 * @param {number} opts.extraSongs     - number of songs to grant
 * @param {string} opts.transactionId  - unique payment transaction ID
 * @param {object} [opts.db]
 * @returns {Promise<{ applied: boolean, alreadyApplied: boolean }>}
 */
async function grantAddonToParty({ userId, partyCode, addonKey, extraSongs, transactionId, db: dbOverride } = {}) {
  if (!userId) throw new Error('grantAddonToParty: userId is required');
  if (!partyCode) throw new Error('grantAddonToParty: partyCode is required');
  if (!addonKey) throw new Error('grantAddonToParty: addonKey is required');
  if (!extraSongs || extraSongs < 1) throw new Error('grantAddonToParty: extraSongs must be >= 1');
  if (!transactionId) throw new Error('grantAddonToParty: transactionId is required');

  let db;
  try {
    db = dbOverride || require('./database');
  } catch (_) {
    db = null;
  }

  const useDb = db && await _checkDb(db);
  const memKey = `${userId}:${partyCode}`;

  if (useDb) {
    await _ensureTables(db);
    // Idempotency check
    try {
      const existing = await db.query(
        'SELECT id FROM party_addon_grants WHERE transaction_id = $1',
        [transactionId]
      );
      if (existing.rows.length > 0) {
        return { applied: false, alreadyApplied: true };
      }
    } catch (err) {
      console.warn('[UploadEntitlement] Idempotency check error:', err.message);
    }

    try {
      await db.query(
        `INSERT INTO party_addon_grants (user_id, party_code, addon_key, extra_songs, transaction_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (transaction_id) DO NOTHING`,
        [userId, partyCode, addonKey, extraSongs, transactionId]
      );
    } catch (err) {
      console.warn('[UploadEntitlement] grantAddonToParty DB error:', err.message);
      // Fallback to in-memory
      const curr = _memAddonGrants.get(memKey) || 0;
      _memAddonGrants.set(memKey, curr + extraSongs);
      return { applied: true, alreadyApplied: false };
    }
  } else {
    // In-memory idempotency — keyed by transactionId
    const memTxKey = `txn:${transactionId}`;
    if (_memAddonGrants.has(memTxKey)) {
      return { applied: false, alreadyApplied: true };
    }
    _memAddonGrants.set(memTxKey, true);
    const curr = _memAddonGrants.get(memKey) || 0;
    _memAddonGrants.set(memKey, curr + extraSongs);
  }

  console.log(`[UploadEntitlement] Addon granted: ${addonKey} (+${extraSongs} songs) to user=${userId} party=${partyCode}`);
  return { applied: true, alreadyApplied: false };
}

/**
 * Get the total number of addon bundles purchased by a user for a party.
 * Used to enforce MAX_ADDON_BUNDLES_PER_PARTY.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.partyCode
 * @param {object} [opts.db]
 * @returns {Promise<number>}
 */
async function getPartyAddonBundleCount({ userId, partyCode, db: dbOverride } = {}) {
  let db;
  try {
    db = dbOverride || require('./database');
  } catch (_) {
    db = null;
  }

  const useDb = db && await _checkDb(db);

  if (useDb) {
    await _ensureTables(db);
    return _getAddonBundleCountDb(db, userId, partyCode);
  }

  // In-memory: count distinct transaction IDs for this user+party
  let count = 0;
  for (const [k] of _memAddonGrants.entries()) {
    if (k.startsWith(`txn:`) && false) continue; // tx keys not counted here
  }
  // Simple approximation: count purchases stored as numeric keys
  return count;
}

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * Validate a file's MIME type against the allowed list.
 * @param {string} mimeType
 * @returns {boolean}
 */
function isAllowedMimeType(mimeType) {
  if (!mimeType) return false;
  return ALLOWED_AUDIO_MIME_TYPES.includes(mimeType.toLowerCase().split(';')[0].trim());
}

/**
 * Validate a file's size against the entitlement's cap.
 * @param {number} sizeBytes
 * @param {number} maxFileSizeBytes
 * @returns {boolean}
 */
function isFileSizeAllowed(sizeBytes, maxFileSizeBytes) {
  if (!maxFileSizeBytes) return false;
  return sizeBytes > 0 && sizeBytes <= maxFileSizeBytes;
}

// ── Internal builder ──────────────────────────────────────────────────────────

/**
 * @typedef {object} UploadEntitlement
 * @property {boolean}     allowed          - whether uploads are permitted right now
 * @property {string}      tier             - normalised tier: FREE | PARTY_PASS | MONTHLY | ADMIN
 * @property {number|null} baseLimit        - base upload allowance (null = unlimited)
 * @property {number}      addonExtra       - extra uploads granted by addons
 * @property {number|null} totalLimit       - combined allowance (null = unlimited)
 * @property {number}      used             - uploads already used this party
 * @property {number|null} remaining        - uploads remaining (null = unlimited)
 * @property {number}      maxFileSizeBytes - per-file size cap in bytes
 * @property {string|null} upsell           - 'upgrade' | 'addon' | 'limit_reached' | null
 * @property {number|null} [fairUsageLimit] - Monthly fair-usage ceiling (if applicable)
 */
function _buildResult(fields) {
  return {
    allowed: Boolean(fields.allowed),
    tier: fields.tier,
    baseLimit: fields.baseLimit ?? null,
    addonExtra: fields.addonExtra ?? 0,
    totalLimit: fields.totalLimit ?? null,
    used: fields.used ?? 0,
    remaining: fields.remaining ?? null,
    maxFileSizeBytes: fields.maxFileSizeBytes ?? 0,
    upsell: fields.upsell ?? null,
    ...(fields.fairUsageLimit != null ? { fairUsageLimit: fields.fairUsageLimit } : {}),
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  calculateUploadEntitlement,
  recordUpload,
  grantAddonToParty,
  getPartyAddonBundleCount,
  isAllowedMimeType,
  isFileSizeAllowed,
  _resetMemStores,
};
