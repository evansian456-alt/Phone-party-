/**
 * Stripe Client
 *
 * Reads STRIPE_SECRET_KEY and exports a Stripe instance.
 * If STRIPE_SECRET_KEY is missing the module exports null and
 * callers should return 503 with a helpful error message.
 *
 * SAFETY GUARD: If NODE_ENV=test and a live Stripe key is detected,
 * this module throws immediately to prevent accidental charges.
 */

// ── Hard guard: never hit live Stripe in test mode ──────────────────────────
const _key = process.env.STRIPE_SECRET_KEY || '';
const _webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

if (process.env.NODE_ENV === 'test') {
  if (_key.startsWith('sk_live')) {
    throw new Error(
      '[StripeClient] HARD STOP: STRIPE_SECRET_KEY starts with "sk_live" while NODE_ENV=test. ' +
        'Tests must not run with live Stripe credentials.'
    );
  }
  const _webhookLooksLive =
    _webhookSecret.startsWith('whsec_') &&
    !_webhookSecret.includes('_test_') &&
    !/^whsec_xxx/.test(_webhookSecret) &&
    _webhookSecret.length > 10;
  if (_webhookLooksLive) {
    throw new Error(
      '[StripeClient] HARD STOP: STRIPE_WEBHOOK_SECRET appears to be a live webhook secret ' +
        'while NODE_ENV=test. Set STRIPE_WEBHOOK_SECRET=whsec_test_xxx for testing.'
    );
  }
}
// ────────────────────────────────────────────────────────────────────────────

let stripe = null;

if (_key) {
  const Stripe = require('stripe');
  stripe = Stripe(_key);
} else {
  console.warn('[BillingClient] STRIPE_SECRET_KEY not set – billing endpoints will return 503');
}

module.exports = stripe;
