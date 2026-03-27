'use strict';

/**
 * upload-config.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single authoritative source of truth for all upload and addon configuration.
 *
 * ALL upload limits, file-size caps, allowed MIME types, addon bundle definitions,
 * and Stripe price IDs are declared here.  Every other module must import from
 * this file — never hardcode these values inline.
 *
 * Tiers:
 *   FREE        – uploads not allowed
 *   PARTY_PASS  – limited uploads per party; can buy extra-song addon bundles
 *   PRO/MONTHLY – premium access; "unlimited uploads" messaging is fine
 */

// ── Per-tier upload limits ────────────────────────────────────────────────────

/** Party Pass base upload allowance per party session */
const PARTY_PASS_UPLOAD_LIMIT = 15;

/** Party Pass per-file size cap (MB and bytes) */
const PARTY_PASS_MAX_FILE_MB = 15;
const PARTY_PASS_MAX_FILE_BYTES = PARTY_PASS_MAX_FILE_MB * 1024 * 1024;

/** Monthly (PRO) per-file size cap (MB and bytes) */
const MONTHLY_MAX_FILE_MB = 50;
const MONTHLY_MAX_FILE_BYTES = MONTHLY_MAX_FILE_MB * 1024 * 1024;

/**
 * Monthly fair-usage upload ceiling (per calendar month).
 * "Unlimited uploads" can still be marketed — this is an anti-abuse back-end
 * guard only.  Normal users will never approach it.
 */
const MONTHLY_FAIR_USAGE_LIMIT = 200;

/**
 * Monthly per-session safety cap.  Prevents a single runaway session from
 * consuming the entire monthly allowance.
 */
const MONTHLY_SESSION_LIMIT = 100;

// ── Allowed file types ────────────────────────────────────────────────────────

const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',
  'audio/webm',
];

const ALLOWED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.webm'];

// ── Addon bundle definitions ──────────────────────────────────────────────────

/**
 * Extra-song addon bundles available for Party Pass holders.
 * Each bundle adds `songs` uploads to the party's allowance.
 * Stripe price IDs fall back to placeholder strings when env vars are absent.
 */
const ADDON_BUNDLES = {
  extra_songs_5: {
    key: 'extra_songs_5',
    label: '+5 Songs',
    description: 'Add 5 more songs to this party',
    songs: 5,
    priceGBP: 0.99,
    stripePriceId:
      process.env.STRIPE_PRICE_EXTRA_SONGS_5 || 'price_extra_songs_5_placeholder',
  },
  extra_songs_10: {
    key: 'extra_songs_10',
    label: '+10 Songs',
    description: 'Add 10 more songs to this party',
    songs: 10,
    priceGBP: 1.49,
    stripePriceId:
      process.env.STRIPE_PRICE_EXTRA_SONGS_10 || 'price_extra_songs_10_placeholder',
  },
  extra_songs_20: {
    key: 'extra_songs_20',
    label: '+20 Songs',
    description: 'Add 20 more songs to this party',
    songs: 20,
    priceGBP: 1.99,
    stripePriceId:
      process.env.STRIPE_PRICE_EXTRA_SONGS_20 || 'price_extra_songs_20_placeholder',
  },
};

/** Set of valid addon keys for fast membership tests */
const VALID_ADDON_KEYS = new Set(Object.keys(ADDON_BUNDLES));

/**
 * Resolve an addon bundle by its Stripe price ID.
 * Returns null if the price ID is not recognised.
 *
 * @param {string} stripePriceId
 * @returns {{ key: string, songs: number, priceGBP: number }|null}
 */
function getAddonBundleByStripePriceId(stripePriceId) {
  for (const bundle of Object.values(ADDON_BUNDLES)) {
    if (bundle.stripePriceId === stripePriceId) return bundle;
  }
  return null;
}

/**
 * Resolve an addon bundle by its key (e.g. 'extra_songs_5').
 *
 * @param {string} key
 * @returns {{ key: string, songs: number, priceGBP: number }|null}
 */
function getAddonBundle(key) {
  return ADDON_BUNDLES[key] || null;
}

// ── Anti-abuse limits ─────────────────────────────────────────────────────────

/**
 * Maximum number of addon bundles a Party Pass holder may buy for a single
 * party.  Prevents runaway purchases (e.g. buying 50 bundles of +20 = 1 000
 * songs on one party).
 */
const MAX_ADDON_BUNDLES_PER_PARTY = 5;

// ── Retention / cleanup ───────────────────────────────────────────────────────

/** Days before uploaded audio files are eligible for cleanup */
const UPLOAD_RETENTION_DAYS = 7;

// ── Aggregate per-party safeguard ─────────────────────────────────────────────

/**
 * Hard ceiling on total uploads per party across all entitlement sources.
 * Base + all addons combined will never exceed this value.
 */
const MAX_UPLOADS_PER_PARTY = PARTY_PASS_UPLOAD_LIMIT + MAX_ADDON_BUNDLES_PER_PARTY * 20; // 15 + 100 = 115

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Per-tier limits
  PARTY_PASS_UPLOAD_LIMIT,
  PARTY_PASS_MAX_FILE_MB,
  PARTY_PASS_MAX_FILE_BYTES,
  MONTHLY_MAX_FILE_MB,
  MONTHLY_MAX_FILE_BYTES,
  MONTHLY_FAIR_USAGE_LIMIT,
  MONTHLY_SESSION_LIMIT,

  // File type validation
  ALLOWED_AUDIO_MIME_TYPES,
  ALLOWED_AUDIO_EXTENSIONS,

  // Addon bundles
  ADDON_BUNDLES,
  VALID_ADDON_KEYS,
  getAddonBundle,
  getAddonBundleByStripePriceId,

  // Anti-abuse
  MAX_ADDON_BUNDLES_PER_PARTY,
  MAX_UPLOADS_PER_PARTY,

  // Retention
  UPLOAD_RETENTION_DAYS,
};
