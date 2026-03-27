/**
 * billing/addon-config.js
 * Centralized configuration for extra-song upload addons.
 *
 * This is the single source of truth for:
 *  - feature flags
 *  - bundle definitions (sizes, prices, identifiers)
 *  - per-party purchase safeguards
 *
 * Do NOT scatter these values across UI and backend separately.
 */

'use strict';

// ─── Feature flag ─────────────────────────────────────────────────────────────

/**
 * Master switch for the extra-song addon feature.
 * Set EXTRA_SONG_ADDON_ENABLED=false in env to disable the flow entirely.
 */
const EXTRA_SONG_ADDON_ENABLED =
  process.env.EXTRA_SONG_ADDON_ENABLED !== 'false'; // default: enabled

// ─── Bundle definitions ───────────────────────────────────────────────────────

/**
 * Ordered list of purchasable extra-song bundles.
 * Each bundle entry is the canonical definition consumed by both backend routes
 * and (via API) the frontend UI.
 *
 * Fields:
 *  key          – product key (matches billing/products.js)
 *  songs        – number of extra uploads granted
 *  priceGBP     – price in pounds sterling (display + billing)
 *  stripePriceId – Stripe price ID (env-overridable)
 *  label        – short display label for UI CTAs
 *  description  – longer description for confirmation messages
 */
const EXTRA_SONG_BUNDLE_OPTIONS = [
  {
    key: 'extra_songs_5',
    songs: 5,
    priceGBP: parseFloat(process.env.EXTRA_SONGS_5_PRICE_GBP || '1.99'),
    stripePriceId:
      process.env.STRIPE_PRICE_ID_EXTRA_SONGS_5 || 'price_extra_songs_5_placeholder',
    label: 'Add 5 songs',
    description: '+5 uploads for this party'
  },
  {
    key: 'extra_songs_10',
    songs: 10,
    priceGBP: parseFloat(process.env.EXTRA_SONGS_10_PRICE_GBP || '2.99'),
    stripePriceId:
      process.env.STRIPE_PRICE_ID_EXTRA_SONGS_10 || 'price_extra_songs_10_placeholder',
    label: 'Add 10 songs',
    description: '+10 uploads for this party'
  }
];

// ─── Per-party safeguards ─────────────────────────────────────────────────────

/**
 * Maximum number of addon bundles a single user may purchase for one party.
 * Prevents accidental runaway purchases.  Set to null to disable.
 */
const MAX_ADDON_PURCHASES_PER_PARTY =
  process.env.MAX_ADDON_PURCHASES_PER_PARTY != null
    ? parseInt(process.env.MAX_ADDON_PURCHASES_PER_PARTY, 10)
    : 5;

/**
 * Hard ceiling on total extra uploads (from addons) for one party.
 * Even if a user buys multiple bundles, they cannot exceed this.
 * Set to null to disable the cap.
 */
const MAX_EXTRA_UPLOADS_PER_PARTY =
  process.env.MAX_EXTRA_UPLOADS_PER_PARTY != null
    ? parseInt(process.env.MAX_EXTRA_UPLOADS_PER_PARTY, 10)
    : 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Look up a bundle definition by its product key.
 * @param {string} key
 * @returns {object|null}
 */
function getBundleByKey(key) {
  return EXTRA_SONG_BUNDLE_OPTIONS.find(b => b.key === key) || null;
}

/**
 * Look up a bundle definition by its Stripe price ID.
 * @param {string} priceId
 * @returns {object|null}
 */
function getBundleByStripePriceId(priceId) {
  return EXTRA_SONG_BUNDLE_OPTIONS.find(b => b.stripePriceId === priceId) || null;
}

module.exports = {
  EXTRA_SONG_ADDON_ENABLED,
  EXTRA_SONG_BUNDLE_OPTIONS,
  MAX_ADDON_PURCHASES_PER_PARTY,
  MAX_EXTRA_UPLOADS_PER_PARTY,
  getBundleByKey,
  getBundleByStripePriceId
};
