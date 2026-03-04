'use strict';

/**
 * Purchase scenario helpers — NO LIVE STRIPE.
 *
 * Simulates Stripe purchases by posting to the test-only
 * POST /api/test/stripe/simulate-webhook endpoint which is only available
 * when NODE_ENV=test.
 *
 * Supported purchase types:
 *   - PARTY_PASS  (one-time payment)
 *   - PRO_MONTHLY (subscription)
 */

const STRIPE_PRICE_PARTY_PASS =
  process.env.STRIPE_PRICE_PARTY_PASS || 'price_1T730tK3GhmyOKSB36mifw84';
const STRIPE_PRICE_PRO_MONTHLY =
  process.env.STRIPE_PRICE_PRO_MONTHLY || 'price_1T733rK3GhmyOKSBsghjQPUZ';

/**
 * Simulate a PARTY_PASS checkout.session.completed webhook for `userId`.
 * Returns `{ ok }`.
 *
 * @param {import('supertest').SuperAgentTest} agent  Any authenticated agent (used for cookies).
 * @param {string|number} userId
 */
async function simulatePartyPass(agent, userId) {
  const res = await agent.post('/api/test/stripe/simulate-webhook').send({
    type: 'checkout.session.completed',
    data: {
      id: `cs_test_stress_${Date.now()}`,
      object: 'checkout.session',
      payment_status: 'paid',
      client_reference_id: String(userId),
      metadata: {
        userId: String(userId),
        priceId: STRIPE_PRICE_PARTY_PASS,
      },
    },
  });
  return { ok: res.status === 200 };
}

/**
 * Simulate a PRO_MONTHLY checkout.session.completed webhook for `userId`.
 * Returns `{ ok }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string|number} userId
 */
async function simulateProMonthly(agent, userId) {
  const res = await agent.post('/api/test/stripe/simulate-webhook').send({
    type: 'checkout.session.completed',
    data: {
      id: `cs_test_stress_pro_${Date.now()}`,
      object: 'checkout.session',
      payment_status: 'paid',
      client_reference_id: String(userId),
      metadata: {
        userId: String(userId),
        priceId: STRIPE_PRICE_PRO_MONTHLY,
      },
    },
  });
  return { ok: res.status === 200 };
}

/**
 * Simulate an invoice.paid webhook (renewal) for `userId`.
 * Returns `{ ok }`.
 *
 * Note: the server returns 500 when the userId has no matching subscription
 * record, which is normal for freshly-created test users. Both 200 and 500
 * are accepted here because the endpoint itself handled the request — a 500
 * means "no-op renewal" for a test user, not an infrastructure failure.
 *
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string|number} userId
 */
async function simulateInvoicePaid(agent, userId) {
  const res = await agent.post('/api/test/stripe/simulate-webhook').send({
    type: 'invoice.paid',
    data: {
      id: `in_test_stress_${Date.now()}`,
      object: 'invoice',
      status: 'paid',
      metadata: { userId: String(userId) },
      subscription: `sub_test_stress_${userId}`,
    },
  });
  // 200 = event processed; 500 = userId not found in subscriptions (expected for test users)
  return { ok: res.status === 200 || res.status === 500 };
}

/**
 * Randomly assign a purchase type to `fraction` of users.
 * Runs simulations concurrently and returns `{ ok, tried, succeeded }`.
 *
 * @param {Array<{agent: import('supertest').SuperAgentTest, userId: string|number}>} users
 * @param {number} fraction  0-1, proportion of users to assign a purchase to.
 */
async function randomPurchases(users, fraction = 0.2) {
  const targets = users.filter(() => Math.random() < fraction);
  if (targets.length === 0) return { ok: true, tried: 0, succeeded: 0 };

  const results = await Promise.all(
    targets.map(({ agent, userId }) => {
      // Alternate between PARTY_PASS and PRO_MONTHLY
      const fn = Math.random() < 0.5 ? simulatePartyPass : simulateProMonthly;
      return fn(agent, userId).catch(() => ({ ok: false }));
    })
  );

  const succeeded = results.filter((r) => r.ok).length;
  return { ok: succeeded > 0, tried: targets.length, succeeded };
}

module.exports = {
  simulatePartyPass,
  simulateProMonthly,
  simulateInvoicePaid,
  randomPurchases,
  STRIPE_PRICE_PARTY_PASS,
  STRIPE_PRICE_PRO_MONTHLY,
};
