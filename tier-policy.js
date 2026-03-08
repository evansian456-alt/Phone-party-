/**
 * TierPolicy - Single source of truth for tier limits.
 *
 * FREE:        maxDevices=2, no session time limit (2h party TTL applies to all), no uploads
 * PARTY_PASS:  maxDevices=4, maxSessionMinutes=120 (2h), 10 uploads/session, Official App Sync
 * PRO /
 * PRO_MONTHLY: maxDevices=10, unlimited time, 100 uploads/month, Official App Sync
 */

const TIER_POLICY = {
  FREE: {
    maxDevices: 2,
    maxSessionMinutes: null, // no per-user session enforcement; all parties share 2h party TTL
    uploadsAllowed: false,
    officialAppSync: false
  },
  PARTY_PASS: {
    maxDevices: 4,
    maxSessionMinutes: 120, // 2-hour party session
    uploadsAllowed: true,
    maxUploadsPerSession: 10,
    maxUploadMB: 15,
    officialAppSync: true
  },
  // PRO_MONTHLY is the legacy alias used throughout the codebase
  PRO_MONTHLY: {
    maxDevices: 10,
    maxSessionMinutes: null, // unlimited
    uploadsAllowed: true,
    maxUploadsPerMonth: 100,
    maxUploadMB: 15,
    maxUploadsPerSession: 50, // safety cap per session
    officialAppSync: true
  },
  // PRO is a shorthand alias
  PRO: {
    maxDevices: 10,
    maxSessionMinutes: null, // unlimited
    uploadsAllowed: true,
    maxUploadsPerMonth: 100,
    maxUploadMB: 15,
    maxUploadsPerSession: 50,
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
