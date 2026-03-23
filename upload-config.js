'use strict';

/**
 * Upload Configuration
 *
 * Single source of truth for all upload-related limits and settings.
 * Values can be overridden via environment variables for operational tuning
 * without code changes.
 *
 * Product rules:
 *   FREE        → uploads NOT allowed (show upgrade prompt)
 *   PARTY_PASS  → up to PARTY_PASS_UPLOAD_LIMIT songs per party, PARTY_PASS_MAX_FILE_MB per file
 *   PRO_MONTHLY → "Unlimited uploads" (fair-usage safeguards applied server-side)
 */

// ─── Helper ──────────────────────────────────────────────────────────────────

function envInt(key, defaultVal) {
  const raw = process.env[key];
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

// ─── Tier upload limits ───────────────────────────────────────────────────────

/** Songs per party for Party Pass users (base allowance, before any add-ons). */
const PARTY_PASS_UPLOAD_LIMIT = envInt('PARTY_PASS_UPLOAD_LIMIT', 15);

/** Max file size in MB for Party Pass uploads. */
const PARTY_PASS_MAX_FILE_MB = envInt('PARTY_PASS_MAX_FILE_MB', 15);

/** Max file size in MB for Monthly (Pro) uploads. */
const MONTHLY_MAX_FILE_MB = envInt('MONTHLY_MAX_FILE_MB', 50);

// ─── Monthly fair-usage safeguards (hidden from product UI) ──────────────────

/**
 * Maximum uploads a Monthly user may make within the rolling fair-usage
 * window.  Visible product message stays "Unlimited uploads".
 */
const MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW = envInt(
  'MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW',
  200
);

/**
 * Rolling window (hours) for the fair-usage upload count above.
 */
const MONTHLY_FAIR_USAGE_WINDOW_HOURS = envInt('MONTHLY_FAIR_USAGE_WINDOW_HOURS', 24);

/**
 * Aggregate storage cap (MB) that triggers a fair-usage flag.
 * This is a soft limit — the upload is still allowed but flagged for review.
 */
const MONTHLY_FAIR_USAGE_STORAGE_MB = envInt('MONTHLY_FAIR_USAGE_STORAGE_MB', 2048);

// ─── Extra-song add-on bundles (Party Pass upsell) ───────────────────────────

/**
 * Available add-on bundle sizes (number of extra songs).
 * Configurable via comma-separated env var, e.g. "5,10,20".
 */
const EXTRA_SONG_BUNDLE_SIZES = (() => {
  const raw = process.env.EXTRA_SONG_BUNDLE_SIZES;
  if (raw) {
    const parsed = raw
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n) && n > 0);
    if (parsed.length > 0) return parsed;
  }
  return [5, 10];
})();

// ─── Upload retention (party-scoped lifecycle) ────────────────────────────────

/**
 * How long (hours) party-scoped uploads are retained after the party ends.
 * After this period they become eligible for storage cleanup.
 */
const PARTY_UPLOAD_RETENTION_HOURS = envInt('PARTY_UPLOAD_RETENTION_HOURS', 48);

// ─── Allowed audio types ──────────────────────────────────────────────────────

/** Approved audio MIME types. */
const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/mpeg',       // .mp3
  'audio/mp3',        // alt MIME for mp3
  'audio/wav',        // .wav
  'audio/wave',       // alt MIME for wav
  'audio/x-wav',      // alt MIME for wav
  'audio/ogg',        // .ogg
  'audio/flac',       // .flac
  'audio/x-flac',     // alt MIME for flac
  'audio/aac',        // .aac
  'audio/mp4',        // .m4a
  'audio/x-m4a',      // alt MIME for m4a
  'audio/webm',       // .webm (audio)
]);

/** Approved file extensions (lower-cased, with dot). */
const ALLOWED_AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.webm',
]);

// ─── Rate limiting for upload endpoints ──────────────────────────────────────

/**
 * Max upload attempts per IP per window.
 * Used by the HTTP upload rate limiter in server.js.
 */
const UPLOAD_RATE_LIMIT_MAX = envInt('UPLOAD_RATE_LIMIT_MAX', 10);

/**
 * Rate-limit window in minutes.
 */
const UPLOAD_RATE_LIMIT_WINDOW_MINUTES = envInt('UPLOAD_RATE_LIMIT_WINDOW_MINUTES', 15);

// ─── Derived byte limits (convenience) ───────────────────────────────────────

const PARTY_PASS_MAX_FILE_BYTES = PARTY_PASS_MAX_FILE_MB * 1024 * 1024;
const MONTHLY_MAX_FILE_BYTES    = MONTHLY_MAX_FILE_MB    * 1024 * 1024;

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Tier limits
  PARTY_PASS_UPLOAD_LIMIT,
  PARTY_PASS_MAX_FILE_MB,
  PARTY_PASS_MAX_FILE_BYTES,
  MONTHLY_MAX_FILE_MB,
  MONTHLY_MAX_FILE_BYTES,

  // Monthly fair-usage
  MONTHLY_FAIR_USAGE_UPLOADS_PER_WINDOW,
  MONTHLY_FAIR_USAGE_WINDOW_HOURS,
  MONTHLY_FAIR_USAGE_STORAGE_MB,

  // Add-on upsell
  EXTRA_SONG_BUNDLE_SIZES,

  // Retention
  PARTY_UPLOAD_RETENTION_HOURS,

  // Validation
  ALLOWED_AUDIO_MIME_TYPES,
  ALLOWED_AUDIO_EXTENSIONS,

  // Rate limiting
  UPLOAD_RATE_LIMIT_MAX,
  UPLOAD_RATE_LIMIT_WINDOW_MINUTES,
};
