/**
 * TierPolicy - Single source of truth for tier limits.
 *
 * Upload limits are sourced from upload-config.js so they remain configurable
 * via environment variables without touching this file.
 *
 * FREE:        maxDevices=2, maxSessionMinutes=30, no uploads, no Official App Sync
 * PARTY_PASS:  maxDevices=6, maxSessionMinutes=60, configurable uploads/party, Official App Sync
 * PRO /
 * PRO_MONTHLY: maxDevices=6, unlimited time, unlimited uploads (fair-usage), Official App Sync
 */

const {
  PARTY_PASS_UPLOAD_LIMIT,
  PARTY_PASS_MAX_FILE_MB,
  MONTHLY_MAX_FILE_MB,
  MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW,
} = require('./upload-config');

const TIER_POLICY = {
  FREE: {
    maxDevices: 2,
    maxSessionMinutes: 30,
    uploadsAllowed: false,
    officialAppSync: false
  },
  PARTY_PASS: {
    maxDevices: 6,
    maxSessionMinutes: 60,
    uploadsAllowed: true,
    maxUploadsPerParty: PARTY_PASS_UPLOAD_LIMIT,
    maxUploadMB: PARTY_PASS_MAX_FILE_MB,
    officialAppSync: true
  },
  // PRO_MONTHLY is the legacy alias used throughout the codebase
  PRO_MONTHLY: {
    maxDevices: 6,
    maxSessionMinutes: null, // unlimited
    uploadsAllowed: true,
    maxUploadsPerMonth: null, // unlimited (fair-usage applied server-side)
    fairUsageUploadsPerWindow: MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW,
    maxUploadMB: MONTHLY_MAX_FILE_MB,
    officialAppSync: true
  },
  // PRO is a shorthand alias
  PRO: {
    maxDevices: 6,
    maxSessionMinutes: null, // unlimited
    uploadsAllowed: true,
    maxUploadsPerMonth: null,
    fairUsageUploadsPerWindow: MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW,
    maxUploadMB: MONTHLY_MAX_FILE_MB,
    officialAppSync: true
  }
};

/**
 * Get policy for a tier. Falls back to FREE for unknown tiers.
 * @param {string} tier
 * @returns {Object} tier policy
 */
function getPolicyForTier(tier) {
  return TIER_POLICY[tier] || TIER_POLICY.FREE;
}

/**
 * Whether the given tier grants access to Official App Sync mode.
 * @param {string} tier - 'FREE' | 'PARTY_PASS' | 'PRO_MONTHLY' | 'PRO'
 * @returns {boolean}
 */
function isPaidForOfficialAppSync(tier) {
  return getPolicyForTier(tier).officialAppSync === true;
}

/**
 * Whether the given user object has access to Streaming Party features.
 * Streaming Party is available for Party Pass and Pro tiers only.
 *
 * Accepts a user object that may include any of:
 *   { tier, effectiveTier, entitlements: { hasPartyPass, hasPro } }
 *
 * @param {Object} user - User object or entitlement descriptor
 * @returns {boolean}
 */
function hasStreamingAccess(user) {
  if (!user) return false;

  // Check entitlements object (from /api/me)
  if (user.entitlements) {
    if (user.entitlements.hasPartyPass || user.entitlements.hasPro) return true;
  }

  // Check effectiveTier (admin-resolved tier)
  const effectiveTier = (user.effectiveTier || '').toUpperCase();
  if (effectiveTier === 'PARTY_PASS' || effectiveTier === 'PRO' || effectiveTier === 'PRO_MONTHLY') {
    return true;
  }

  // Check tier field directly
  const tier = (user.tier || '').toUpperCase();
  return isPaidForOfficialAppSync(tier);
}

module.exports = { TIER_POLICY, getPolicyForTier, isPaidForOfficialAppSync, hasStreamingAccess };
