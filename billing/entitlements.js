/**
 * billing/entitlements.js
 * Unified entitlement application layer.
 * Supports PostgreSQL (when DATABASE_URL is configured) and in-memory
 * fallback for Cloud Run / environments without a DB.
 */

'use strict';

const { getProduct } = require('./products');
const {
  MAX_ADDON_PURCHASES_PER_PARTY,
  MAX_EXTRA_UPLOADS_PER_PARTY
} = require('./addon-config');

// Duration for a party pass entitlement
const PARTY_PASS_INTERVAL = '2 hours'; // PostgreSQL interval
const PARTY_PASS_DURATION_MS = 2 * 60 * 60 * 1000; // milliseconds

// ── In-memory fallback storage ────────────────────────────────────────────────
// Used when DB is not available. Keyed by providerTransactionId for idempotency.
const _memPurchases = new Map();   // transactionId -> purchase record
const _memUserTiers = new Map();   // userId -> { userTier, partyPassActive, subscriptionStatus }

// Addon entitlements (party-scoped, in-memory fallback)
// Key: `${userId}:${partyCode}` -> array of { productKey, songsGranted, transactionId, createdAt }
const _memAddonEntitlements = new Map();

let _dbAvailable = null; // null = not yet tested, true/false = cached result

async function _checkDb(db) {
  if (_dbAvailable !== null) return _dbAvailable;
  try {
    await db.query('SELECT 1');
    _dbAvailable = true;
  } catch (_) {
    _dbAvailable = false;
    console.warn('[Entitlements] Database not available – using in-memory storage');
  }
  return _dbAvailable;
}

// Exposed for testing only
function _resetMemStore() {
  _memPurchases.clear();
  _memUserTiers.clear();
  _memAddonEntitlements.clear();
  _dbAvailable = null;
}

// ── Ensure purchases table exists ─────────────────────────────────────────────
async function _ensurePurchasesTable(db) {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS unified_purchases (
        id              SERIAL PRIMARY KEY,
        user_id         TEXT NOT NULL,
        product_key     TEXT NOT NULL,
        provider        TEXT NOT NULL,
        transaction_id  TEXT NOT NULL UNIQUE,
        raw             JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.warn('[Entitlements] Could not create unified_purchases table:', err.message);
  }
}

// ── Ensure party_song_addons table exists ─────────────────────────────────────
async function _ensureAddonTable(db) {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS party_song_addons (
        id                  SERIAL PRIMARY KEY,
        user_id             TEXT NOT NULL,
        party_code          TEXT NOT NULL,
        product_key         TEXT NOT NULL,
        addon_type          TEXT NOT NULL DEFAULT 'extra_uploads',
        songs_granted       INTEGER NOT NULL,
        provider            TEXT NOT NULL,
        provider_session_id TEXT NOT NULL UNIQUE,
        idempotency_key     TEXT UNIQUE,
        status              TEXT NOT NULL DEFAULT 'active',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_party_song_addons_user_party
        ON party_song_addons (user_id, party_code)
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_party_song_addons_party
        ON party_song_addons (party_code)
    `);
  } catch (err) {
    console.warn('[Entitlements] Could not create party_song_addons table:', err.message);
  }
}

/**
 * Apply a purchase to a user.
 *
 * @param {object} opts
 * @param {string} opts.userId               - Internal user ID
 * @param {string} opts.productKey           - Key from billing/products.js
 * @param {string} opts.provider             - 'stripe' | 'apple' | 'google'
 * @param {string} opts.providerTransactionId - Unique transaction ID from provider
 * @param {object} [opts.raw]                - Raw provider payload (for audit)
 * @param {object} [opts.db]                 - Optional db module (defaults to require('../database'))
 * @returns {Promise<{applied: boolean, alreadyApplied: boolean, tier: string}>}
 */
async function applyPurchaseToUser({ userId, productKey, provider, providerTransactionId, raw, db: dbOverride } = {}) {
  // ── Input validation ──────────────────────────────────────────────────────
  if (!userId) throw new Error('applyPurchaseToUser: userId is required');
  if (!productKey) throw new Error('applyPurchaseToUser: productKey is required');
  if (!provider) throw new Error('applyPurchaseToUser: provider is required');
  if (!providerTransactionId) throw new Error('applyPurchaseToUser: providerTransactionId is required');

  const product = getProduct(productKey);
  if (!product) throw new Error(`applyPurchaseToUser: unknown productKey "${productKey}"`);

  const tier = product.entitlement.tier; // 'PARTY_PASS' or 'PRO'

  // ── Try database path ─────────────────────────────────────────────────────
  let db;
  try {
    db = dbOverride || require('../database');
  } catch (_) {
    db = null;
  }

  const useDb = db && (await _checkDb(db));

  if (useDb) {
    return _applyWithDb({ db, userId, productKey, provider, providerTransactionId, raw, tier });
  }

  return _applyInMemory({ userId, productKey, provider, providerTransactionId, raw, tier });
}

// ── DB-backed path ────────────────────────────────────────────────────────────
async function _applyWithDb({ db, userId, productKey, provider, providerTransactionId, raw, tier }) {
  await _ensurePurchasesTable(db);

  // Idempotency check
  try {
    const existing = await db.query(
      'SELECT id FROM unified_purchases WHERE transaction_id = $1',
      [providerTransactionId]
    );
    if (existing.rows.length > 0) {
      return { applied: false, alreadyApplied: true, tier };
    }
  } catch (err) {
    console.warn('[Entitlements] Idempotency check failed:', err.message);
  }

  // Write purchase record
  try {
    await db.query(
      `INSERT INTO unified_purchases (user_id, product_key, provider, transaction_id, raw)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (transaction_id) DO NOTHING`,
      [userId, productKey, provider, providerTransactionId, JSON.stringify(raw || {})]
    );
  } catch (err) {
    console.warn('[Entitlements] Failed to write purchase record:', err.message);
  }

  // Update user tier
  await _updateUserTierDb({ db, userId, tier });

  console.log(`[Entitlements] Applied ${productKey} (${provider}) to user ${userId} → tier=${tier}`);
  return { applied: true, alreadyApplied: false, tier };
}

async function _updateUserTierDb({ db, userId, tier }) {
  if (tier === 'PARTY_PASS') {
    try {
      // Update users table if it has tier column
      await db.query(
        `UPDATE users SET tier = $1 WHERE id = $2`,
        ['PARTY_PASS', userId]
      );
    } catch (_) { /* column may not exist yet */ }
    try {
      // Update user_upgrades table
      await db.query(
        `INSERT INTO user_upgrades (user_id, party_pass_expires_at, updated_at)
         VALUES ($1, NOW() + INTERVAL '${PARTY_PASS_INTERVAL}', NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET party_pass_expires_at = NOW() + INTERVAL '${PARTY_PASS_INTERVAL}', updated_at = NOW()`,
        [userId]
      );
    } catch (err) {
      console.warn('[Entitlements] Could not update user_upgrades for PARTY_PASS:', err.message);
    }
  } else if (tier === 'PRO') {
    try {
      await db.query(
        `UPDATE users SET tier = $1, subscription_status = 'active' WHERE id = $2`,
        ['PRO', userId]
      );
    } catch (_) { /* column may not exist */ }
    try {
      await db.query(
        `INSERT INTO user_upgrades (user_id, pro_monthly_active, pro_monthly_started_at, updated_at)
         VALUES ($1, TRUE, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET pro_monthly_active = TRUE, pro_monthly_started_at = COALESCE(user_upgrades.pro_monthly_started_at, NOW()), updated_at = NOW()`,
        [userId]
      );
    } catch (err) {
      console.warn('[Entitlements] Could not update user_upgrades for PRO:', err.message);
    }
  }
}

// ── In-memory path ────────────────────────────────────────────────────────────
function _applyInMemory({ userId, productKey, provider, providerTransactionId, raw, tier }) {
  // Idempotency check
  if (_memPurchases.has(providerTransactionId)) {
    return Promise.resolve({ applied: false, alreadyApplied: true, tier });
  }

  // Write purchase record
  _memPurchases.set(providerTransactionId, {
    userId,
    productKey,
    provider,
    providerTransactionId,
    raw: raw || {},
    createdAt: new Date().toISOString()
  });

  // Update user tier
  const current = _memUserTiers.get(userId) || {};
  if (tier === 'PARTY_PASS') {
    _memUserTiers.set(userId, {
      ...current,
      userTier: 'PARTY_PASS',
      partyPassActive: true,
      partyPassExpiresAt: new Date(Date.now() + PARTY_PASS_DURATION_MS).toISOString()
    });
  } else if (tier === 'PRO') {
    _memUserTiers.set(userId, {
      ...current,
      userTier: 'PRO',
      subscriptionStatus: 'active'
    });
  }

  console.log(`[Entitlements] Applied ${productKey} (${provider}) to user ${userId} → tier=${tier} [in-memory]`);
  return Promise.resolve({ applied: true, alreadyApplied: false, tier });
}

// ═════════════════════════════════════════════════════════════════════════════
// PARTY-SCOPED ADDON ENTITLEMENTS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Grant a party-scoped extra-upload addon entitlement.
 *
 * Idempotent: if the same providerSessionId has already been processed, returns
 * { applied: false, alreadyApplied: true } without creating a duplicate record.
 *
 * @param {object} opts
 * @param {string} opts.userId              - Authenticated user ID
 * @param {string} opts.partyCode           - Normalised party code (upper-case)
 * @param {string} opts.productKey          - e.g. 'extra_songs_5'
 * @param {number} opts.songsGranted        - Number of extra uploads to grant
 * @param {string} opts.provider            - Payment provider ('stripe')
 * @param {string} opts.providerSessionId   - Unique checkout/payment session ID
 * @param {string} [opts.idempotencyKey]    - Optional additional idempotency token
 * @param {object} [opts.db]               - Optional db override (for testing)
 * @returns {Promise<{applied: boolean, alreadyApplied: boolean, songsGranted: number}>}
 */
async function applyAddonEntitlement({
  userId, partyCode, productKey, songsGranted, provider, providerSessionId, idempotencyKey, db: dbOverride
} = {}) {
  if (!userId) throw new Error('applyAddonEntitlement: userId is required');
  if (!partyCode) throw new Error('applyAddonEntitlement: partyCode is required');
  if (!productKey) throw new Error('applyAddonEntitlement: productKey is required');
  if (!songsGranted || songsGranted < 1) throw new Error('applyAddonEntitlement: songsGranted must be >= 1');
  if (!provider) throw new Error('applyAddonEntitlement: provider is required');
  if (!providerSessionId) throw new Error('applyAddonEntitlement: providerSessionId is required');

  const product = getProduct(productKey);
  if (!product) throw new Error(`applyAddonEntitlement: unknown productKey "${productKey}"`);
  if (product.type !== 'addon') throw new Error(`applyAddonEntitlement: "${productKey}" is not an addon product`);

  let db;
  try {
    db = dbOverride || require('../database');
  } catch (_) {
    db = null;
  }

  const useDb = db && (await _checkDb(db));

  if (useDb) {
    return _applyAddonWithDb({ db, userId, partyCode, productKey, songsGranted, provider, providerSessionId, idempotencyKey });
  }

  return _applyAddonInMemory({ userId, partyCode, productKey, songsGranted, provider, providerSessionId, idempotencyKey });
}

async function _applyAddonWithDb({ db, userId, partyCode, productKey, songsGranted, provider, providerSessionId, idempotencyKey }) {
  await _ensureAddonTable(db);

  // Idempotency: check by providerSessionId (and optionally idempotencyKey)
  try {
    const existing = await db.query(
      'SELECT id, songs_granted FROM party_song_addons WHERE provider_session_id = $1',
      [providerSessionId]
    );
    if (existing.rows.length > 0) {
      console.log(`[Entitlements] Addon already applied: session ${providerSessionId}`);
      return { applied: false, alreadyApplied: true, songsGranted: existing.rows[0].songs_granted };
    }
  } catch (err) {
    console.warn('[Entitlements] Addon idempotency check failed:', err.message);
  }

  // Check per-party purchase count safeguard
  if (MAX_ADDON_PURCHASES_PER_PARTY != null) {
    try {
      const countResult = await db.query(
        `SELECT COUNT(*) AS cnt FROM party_song_addons
         WHERE user_id = $1 AND party_code = $2 AND status = 'active'`,
        [userId, partyCode]
      );
      const count = parseInt(countResult.rows[0]?.cnt || '0', 10);
      if (count >= MAX_ADDON_PURCHASES_PER_PARTY) {
        throw new Error(`Maximum addon purchases (${MAX_ADDON_PURCHASES_PER_PARTY}) reached for this party`);
      }
    } catch (err) {
      if (err.message.startsWith('Maximum addon purchases')) throw err;
      console.warn('[Entitlements] Could not check addon purchase count:', err.message);
    }
  }

  // Check aggregate extra-uploads cap
  if (MAX_EXTRA_UPLOADS_PER_PARTY != null) {
    try {
      const sumResult = await db.query(
        `SELECT COALESCE(SUM(songs_granted), 0) AS total FROM party_song_addons
         WHERE party_code = $1 AND status = 'active'`,
        [partyCode]
      );
      const currentTotal = parseInt(sumResult.rows[0]?.total || '0', 10);
      if (currentTotal + songsGranted > MAX_EXTRA_UPLOADS_PER_PARTY) {
        throw new Error(`Addon would exceed maximum extra uploads (${MAX_EXTRA_UPLOADS_PER_PARTY}) for this party`);
      }
    } catch (err) {
      if (err.message.startsWith('Addon would exceed')) throw err;
      console.warn('[Entitlements] Could not check aggregate upload cap:', err.message);
    }
  }

  // Insert addon record
  try {
    await db.query(
      `INSERT INTO party_song_addons
         (user_id, party_code, product_key, addon_type, songs_granted, provider, provider_session_id, idempotency_key, status)
       VALUES ($1, $2, $3, 'extra_uploads', $4, $5, $6, $7, 'active')
       ON CONFLICT (provider_session_id) DO NOTHING`,
      [userId, partyCode, productKey, songsGranted, provider, providerSessionId, idempotencyKey || null]
    );
  } catch (err) {
    console.warn('[Entitlements] Failed to insert addon record:', err.message);
  }

  console.log(`[Entitlements] Addon granted: ${songsGranted} extra uploads for party ${partyCode} (user ${userId})`);
  return { applied: true, alreadyApplied: false, songsGranted };
}

function _applyAddonInMemory({ userId, partyCode, productKey, songsGranted, provider, providerSessionId, idempotencyKey }) {
  // Idempotency check
  for (const grants of _memAddonEntitlements.values()) {
    for (const g of grants) {
      if (g.providerSessionId === providerSessionId) {
        return Promise.resolve({ applied: false, alreadyApplied: true, songsGranted: g.songsGranted });
      }
    }
  }

  const partyKey = `${userId}:${partyCode}`;
  const existing = _memAddonEntitlements.get(partyKey) || [];

  // Check per-party purchase count safeguard
  if (MAX_ADDON_PURCHASES_PER_PARTY != null && existing.length >= MAX_ADDON_PURCHASES_PER_PARTY) {
    return Promise.reject(new Error(`Maximum addon purchases (${MAX_ADDON_PURCHASES_PER_PARTY}) reached for this party`));
  }

  // Check aggregate cap across all users for this party
  if (MAX_EXTRA_UPLOADS_PER_PARTY != null) {
    let partyTotal = 0;
    for (const [key, grants] of _memAddonEntitlements) {
      if (key.endsWith(`:${partyCode}`)) {
        partyTotal += grants.reduce((s, g) => s + g.songsGranted, 0);
      }
    }
    if (partyTotal + songsGranted > MAX_EXTRA_UPLOADS_PER_PARTY) {
      return Promise.reject(new Error(`Addon would exceed maximum extra uploads (${MAX_EXTRA_UPLOADS_PER_PARTY}) for this party`));
    }
  }

  existing.push({ userId, partyCode, productKey, songsGranted, provider, providerSessionId, idempotencyKey, createdAt: new Date().toISOString() });
  _memAddonEntitlements.set(partyKey, existing);

  console.log(`[Entitlements] Addon granted: ${songsGranted} extra uploads for party ${partyCode} (user ${userId}) [in-memory]`);
  return Promise.resolve({ applied: true, alreadyApplied: false, songsGranted });
}

/**
 * Get the total extra uploads granted by addons for a specific party.
 * Aggregates across all users who have purchased addons for this party.
 *
 * @param {object} opts
 * @param {string} opts.partyCode - Normalised party code
 * @param {string} [opts.userId]  - If provided, sum only this user's addons
 * @param {object} [opts.db]     - Optional db override
 * @returns {Promise<number>} Total extra uploads granted
 */
async function getPartyAddonUploads({ partyCode, userId, db: dbOverride } = {}) {
  if (!partyCode) throw new Error('getPartyAddonUploads: partyCode is required');

  let db;
  try {
    db = dbOverride || require('../database');
  } catch (_) {
    db = null;
  }

  const useDb = db && (await _checkDb(db));

  if (useDb) {
    try {
      await _ensureAddonTable(db);
      const params = userId ? [partyCode, userId] : [partyCode];
      const whereClause = userId
        ? `WHERE party_code = $1 AND user_id = $2 AND status = 'active'`
        : `WHERE party_code = $1 AND status = 'active'`;
      const result = await db.query(
        `SELECT COALESCE(SUM(songs_granted), 0) AS total FROM party_song_addons ${whereClause}`,
        params
      );
      return parseInt(result.rows[0]?.total || '0', 10);
    } catch (err) {
      console.warn('[Entitlements] Could not query addon uploads from DB:', err.message);
      return 0;
    }
  }

  // In-memory fallback
  let total = 0;
  for (const [key, grants] of _memAddonEntitlements) {
    const keyPartyCode = key.split(':').pop();
    if (keyPartyCode !== partyCode) continue;
    if (userId && !key.startsWith(`${userId}:`)) continue;
    total += grants.reduce((s, g) => s + g.songsGranted, 0);
  }
  return total;
}

/**
 * Get all in-memory purchases (for admin stats / testing)
 * @returns {object[]}
 */
function getMemPurchases() {
  return Array.from(_memPurchases.values());
}

/**
 * Get user tier from in-memory store (for testing/fallback)
 * @param {string} userId
 * @returns {object|null}
 */
function getMemUserTier(userId) {
  return _memUserTiers.get(userId) || null;
}

/**
 * Get all in-memory addon entitlements (for testing)
 * @returns {object[]}
 */
function getMemAddonEntitlements() {
  const all = [];
  for (const grants of _memAddonEntitlements.values()) {
    all.push(...grants);
  }
  return all;
}

module.exports = {
  applyPurchaseToUser,
  applyAddonEntitlement,
  getPartyAddonUploads,
  getMemPurchases,
  getMemUserTier,
  getMemAddonEntitlements,
  _resetMemStore
};
