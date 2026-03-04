'use strict';

/**
 * Stripe live-key safety guard.
 *
 * HARD REQUIREMENT: Tests must NEVER hit live Stripe endpoints.
 * Call assertStripeTestMode() at the top of any test suite that touches
 * Stripe config — or let the global setup call it once.
 *
 * If STRIPE_SECRET_KEY starts with "sk_live" or STRIPE_WEBHOOK_SECRET
 * starts with "whsec_" but looks like a live value (no "_test_" segment),
 * this function throws immediately so tests never run with real keys.
 */
function assertStripeTestMode() {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  if (secretKey.startsWith('sk_live')) {
    throw new Error(
      '[STRIPE-GUARD] HARD STOP: STRIPE_SECRET_KEY starts with "sk_live". ' +
        'Tests must not run with live Stripe credentials. ' +
        'Set STRIPE_SECRET_KEY=sk_test_xxx in your test environment.'
    );
  }

  // whsec_ values from live webhooks do not contain "_test_"
  if (webhookSecret.startsWith('whsec_') && webhookSecret.length > 10) {
    const looksLive =
      !webhookSecret.startsWith('whsec_test') && !webhookSecret.startsWith('whsec_xxx');
    if (looksLive) {
      throw new Error(
        '[STRIPE-GUARD] HARD STOP: STRIPE_WEBHOOK_SECRET appears to be a live webhook secret. ' +
          'Set STRIPE_WEBHOOK_SECRET=whsec_test_xxx in your test environment.'
      );
    }
  }
}

module.exports = { assertStripeTestMode };
