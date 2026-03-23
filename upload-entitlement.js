'use strict';

/**
 * Upload Entitlement Service
 *
 * Server-side enforcement of all upload access rules.
 * NEVER trust client-supplied tier information.
 *
 * Tiers:
 *   FREE        → no uploads; show upgrade prompt
 *   PARTY_PASS  → limited uploads per party (base + add-ons); 15 MB per file
 *   PRO_MONTHLY → "unlimited" uploads (fair-usage safeguards applied internally)
 */

const cfg = require('./upload-config');

const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

// ─── File validation ──────────────────────────────────────────────────────────

/**
 * Validate that a file is an acceptable audio upload.
 *
 * @param {object} opts
 * @param {string}  opts.filename    - Original filename
 * @param {string}  opts.mimeType    - Declared MIME type
 * @param {number}  opts.sizeBytes   - File size in bytes
 * @param {string}  opts.tier        - 'FREE' | 'PARTY_PASS' | 'PRO_MONTHLY' | 'PRO'
 * @returns {{ valid: boolean, error?: string }}
 */
function validateUploadFile({ filename, mimeType, sizeBytes, tier }) {
  // Must have a filename
  if (!filename || typeof filename !== 'string' || !filename.trim()) {
    return { valid: false, error: 'Filename is required.' };
  }

  // Extension check
  const ext = ('.' + filename.trim().split('.').pop()).toLowerCase();
  if (!cfg.ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error: `File type "${ext}" is not allowed. Supported formats: ${[...cfg.ALLOWED_AUDIO_EXTENSIONS].join(', ')}.`,
    };
  }

  // MIME type check
  if (!mimeType || typeof mimeType !== 'string') {
    return { valid: false, error: 'MIME type is required.' };
  }
  const lowerMime = mimeType.trim().toLowerCase();
  if (!cfg.ALLOWED_AUDIO_MIME_TYPES.has(lowerMime)) {
    return {
      valid: false,
      error: `MIME type "${mimeType}" is not allowed. File must be a supported audio format.`,
    };
  }

  // Non-empty
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { valid: false, error: 'File must not be empty.' };
  }

  // Per-tier size cap
  const maxBytes = getMaxFileBytesForTier(tier);
  if (sizeBytes > maxBytes) {
    const maxMB = maxBytes / 1024 / 1024;
    return {
      valid: false,
      error: `File is too large. Maximum file size for your plan is ${maxMB} MB.`,
    };
  }

  return { valid: true };
}

/**
 * Return the per-file byte cap for a given tier.
 * @param {string} tier
 * @returns {number}
 */
function getMaxFileBytesForTier(tier) {
  const t = (tier || 'FREE').toUpperCase();
  if (t === 'PRO_MONTHLY' || t === 'PRO') return cfg.MONTHLY_MAX_FILE_BYTES;
  if (t === 'PARTY_PASS')                 return cfg.PARTY_PASS_MAX_FILE_BYTES;
  // FREE tier should never reach here, but cap defensively
  return cfg.PARTY_PASS_MAX_FILE_BYTES;
}

// ─── Access check ─────────────────────────────────────────────────────────────

/**
 * Check whether a user (by entitlements) is allowed to upload at all.
 *
 * @param {{ hasPartyPass: boolean, hasPro: boolean }} entitlements
 * @returns {{ allowed: boolean, tier: string, reason?: string }}
 */
function checkUploadAccess(entitlements) {
  if (!entitlements) {
    return { allowed: false, tier: 'FREE', reason: 'free_tier' };
  }
  if (entitlements.hasPro) {
    return { allowed: true, tier: 'PRO_MONTHLY' };
  }
  if (entitlements.hasPartyPass) {
    return { allowed: true, tier: 'PARTY_PASS' };
  }
  return {
    allowed: false,
    tier: 'FREE',
    reason: 'free_tier',
    upgradeMessage:
      'Music uploads are available for Party Pass and Monthly subscribers. Upgrade to unlock this feature.',
  };
}

// ─── Party Pass upload counting ───────────────────────────────────────────────

/**
 * Return the total number of uploads already made for a party by any user.
 *
 * @param {object} db         - Database client (from database.js)
 * @param {string} partyCode  - Party code
 * @returns {Promise<number>}
 */
async function getPartyUploadCount(db, partyCode) {
  const result = await db.query(
    `SELECT COUNT(*) AS cnt FROM party_uploads
     WHERE party_code = $1 AND deleted_at IS NULL`,
    [partyCode]
  );
  return parseInt(result.rows[0]?.cnt ?? '0', 10);
}

/**
 * Return the total approved add-on upload allowance for a party.
 *
 * @param {object} db
 * @param {string} partyCode
 * @returns {Promise<number>}
 */
async function getPartyAddonAllowance(db, partyCode) {
  const result = await db.query(
    `SELECT COALESCE(SUM(extra_songs), 0) AS total FROM party_upload_addons
     WHERE party_code = $1 AND status = 'active'`,
    [partyCode]
  );
  return parseInt(result.rows[0]?.total ?? '0', 10);
}

/**
 * Return the effective upload limit for a Party Pass party (base + add-ons).
 *
 * @param {object} db
 * @param {string} partyCode
 * @returns {Promise<{ limit: number, base: number, addons: number }>}
 */
async function getEffectivePartyLimit(db, partyCode) {
  const base   = cfg.PARTY_PASS_UPLOAD_LIMIT;
  const addons = await getPartyAddonAllowance(db, partyCode);
  return { limit: base + addons, base, addons };
}

/**
 * Check whether a Party Pass party can accept one more upload.
 *
 * @param {object} db
 * @param {string} partyCode
 * @returns {Promise<{
 *   allowed:    boolean,
 *   used:       number,
 *   limit:      number,
 *   remaining:  number,
 *   addons:     number,
 *   upsell?:    object
 * }>}
 */
async function checkPartyPassUploadLimit(db, partyCode) {
  const [used, { limit, base, addons }] = await Promise.all([
    getPartyUploadCount(db, partyCode),
    getEffectivePartyLimit(db, partyCode),
  ]);

  const remaining = Math.max(0, limit - used);

  if (used >= limit) {
    return {
      allowed: false,
      used,
      limit,
      remaining: 0,
      addons,
      upsell: buildUpsellPayload(used, limit),
    };
  }

  return { allowed: true, used, limit, remaining, addons };
}

/**
 * Build the upsell payload shown when a Party Pass user hits their upload limit.
 *
 * @param {number} used
 * @param {number} limit
 * @returns {object}
 */
function buildUpsellPayload(used, limit) {
  return {
    limitReachedMessage: `You've used all ${limit} uploads for this party.`,
    promptMessage: 'Add more songs for this party, or upgrade to Monthly for unlimited uploads.',
    addOnBundles: cfg.EXTRA_SONG_BUNDLE_SIZES.map(size => ({
      extraSongs: size,
      label: `+${size} songs for this party`,
    })),
    monthlyUpgrade: {
      label: 'Upgrade to Monthly',
      description: 'Unlimited uploads. Best for hosts who party regularly.',
    },
  };
}

// ─── Monthly fair-usage check ─────────────────────────────────────────────────

/**
 * Check whether a Monthly user has hit a fair-usage threshold.
 * Visible product message remains "Unlimited uploads".
 *
 * @param {object} db
 * @param {string} userId
 * @returns {Promise<{ allowed: boolean, flaggedForReview?: boolean, reason?: string }>}
 */
async function checkMonthlyFairUsage(db, userId) {
  const windowMs  = cfg.MONTHLY_FAIR_USAGE_WINDOW_HOURS * 60 * 60 * 1000;
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  const countResult = await db.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(size_bytes), 0) AS total_bytes
     FROM party_uploads
     WHERE uploader_user_id = $1
       AND deleted_at IS NULL
       AND created_at >= $2`,
    [userId, windowStart]
  );

  const row          = countResult.rows[0] || {};
  const uploadCount  = parseInt(row.cnt ?? '0', 10);
  const totalMB      = parseInt(row.total_bytes ?? '0', 10) / (1024 * 1024);

  const countExceeded   = uploadCount >= cfg.MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW;
  const storageExceeded = totalMB     >= cfg.MONTHLY_FAIR_USAGE_STORAGE_MB;

  if (countExceeded || storageExceeded) {
    const reason = countExceeded
      ? `Upload limit reached for this period (${uploadCount} uploads in ${cfg.MONTHLY_FAIR_USAGE_WINDOW_HOURS}h). Please try again later or contact support.`
      : `Storage usage is unusually high. Please contact support if you need assistance.`;

    if (DEBUG) {
      console.warn('[UploadEntitlement] Monthly fair-usage flag:', { userId, uploadCount, totalMB });
    }
    return { allowed: false, flaggedForReview: true, reason };
  }

  return { allowed: true };
}

// ─── Upload record management ─────────────────────────────────────────────────

/**
 * Record a completed upload in `party_uploads`.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string}  opts.partyCode
 * @param {string}  opts.uploaderUserId
 * @param {string}  opts.trackId
 * @param {string}  opts.storageKey
 * @param {string}  opts.originalFilename
 * @param {number}  opts.sizeBytes
 * @param {string}  opts.mimeType
 * @param {string}  opts.entitlementType  - 'PARTY_PASS' | 'PRO_MONTHLY' | 'ADDON'
 * @returns {Promise<object>} inserted row
 */
async function recordUpload(db, {
  partyCode,
  uploaderUserId,
  trackId,
  storageKey,
  originalFilename,
  sizeBytes,
  mimeType,
  entitlementType,
}) {
  const expiresAt = entitlementType === 'PARTY_PASS' || entitlementType === 'ADDON'
    ? new Date(Date.now() + cfg.PARTY_UPLOAD_RETENTION_HOURS * 60 * 60 * 1000).toISOString()
    : null; // Monthly uploads don't auto-expire

  const result = await db.query(
    `INSERT INTO party_uploads
       (party_code, uploader_user_id, track_id, storage_key,
        original_filename, size_bytes, mime_type, entitlement_type, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [partyCode, uploaderUserId, trackId, storageKey,
     originalFilename, sizeBytes, mimeType, entitlementType, expiresAt]
  );
  return result.rows[0];
}

// ─── Add-on management ────────────────────────────────────────────────────────

/**
 * Grant an extra-song add-on for a party (e.g. after purchase).
 *
 * @param {object} db
 * @param {object} opts
 * @param {string}  opts.partyCode
 * @param {string}  opts.userId         - Purchasing user
 * @param {number}  opts.extraSongs     - Number of songs in bundle
 * @param {string}  [opts.purchaseRef]  - Billing reference (optional)
 * @returns {Promise<object>} inserted row
 */
async function grantUploadAddon(db, { partyCode, userId, extraSongs, purchaseRef = null }) {
  const result = await db.query(
    `INSERT INTO party_upload_addons
       (party_code, user_id, extra_songs, status, purchase_ref)
     VALUES ($1, $2, $3, 'active', $4)
     RETURNING *`,
    [partyCode, userId, extraSongs, purchaseRef]
  );
  return result.rows[0];
}

// ─── Admin / observability helpers ───────────────────────────────────────────

/**
 * Summarise upload counts and storage usage by user (admin use only).
 *
 * @param {object} db
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<object[]>}
 */
async function getUploadStatsByUser(db, { limit = 100 } = {}) {
  const result = await db.query(
    `SELECT
       uploader_user_id,
       entitlement_type,
       COUNT(*)                        AS upload_count,
       COALESCE(SUM(size_bytes), 0)    AS total_bytes,
       MAX(created_at)                 AS last_upload_at
     FROM party_uploads
     WHERE deleted_at IS NULL
     GROUP BY uploader_user_id, entitlement_type
     ORDER BY upload_count DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Summarise upload counts per party (admin use only).
 *
 * @param {object} db
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<object[]>}
 */
async function getUploadStatsByParty(db, { limit = 100 } = {}) {
  const result = await db.query(
    `SELECT
       party_code,
       COUNT(*)                        AS upload_count,
       COALESCE(SUM(size_bytes), 0)    AS total_bytes,
       MAX(created_at)                 AS last_upload_at
     FROM party_uploads
     WHERE deleted_at IS NULL
     GROUP BY party_code
     ORDER BY upload_count DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Return uploads flagged as suspicious (for admin review).
 * Criteria: more than MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW uploads
 * in the rolling window from a single user.
 *
 * @param {object} db
 * @returns {Promise<object[]>}
 */
async function getSuspiciousUploaders(db) {
  const windowMs    = cfg.MONTHLY_FAIR_USAGE_WINDOW_HOURS * 60 * 60 * 1000;
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  const result = await db.query(
    `SELECT
       uploader_user_id,
       COUNT(*)                     AS upload_count,
       COALESCE(SUM(size_bytes), 0) AS total_bytes
     FROM party_uploads
     WHERE deleted_at IS NULL
       AND created_at >= $1
     GROUP BY uploader_user_id
     HAVING COUNT(*) >= $2
     ORDER BY upload_count DESC`,
    [windowStart, cfg.MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW]
  );
  return result.rows;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  validateUploadFile,
  getMaxFileBytesForTier,
  checkUploadAccess,
  checkPartyPassUploadLimit,
  getPartyUploadCount,
  getPartyAddonAllowance,
  getEffectivePartyLimit,
  buildUpsellPayload,
  checkMonthlyFairUsage,
  recordUpload,
  grantUploadAddon,
  getUploadStatsByUser,
  getUploadStatsByParty,
  getSuspiciousUploaders,
};
