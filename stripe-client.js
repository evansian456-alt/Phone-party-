/**
 * Stripe Client
 *
 * Reads STRIPE_SECRET_KEY and exports a Stripe instance.
 * If STRIPE_SECRET_KEY is missing the module exports null and
 * callers should return 503 with a helpful error message.
 */

let stripe = null;

if (process.env.STRIPE_SECRET_KEY) {
  const Stripe = require('stripe');
  stripe = Stripe(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn('[BillingClient] STRIPE_SECRET_KEY not set – billing endpoints will return 503');
}

module.exports = stripe;
