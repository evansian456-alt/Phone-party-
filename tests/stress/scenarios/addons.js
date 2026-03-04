'use strict';

/**
 * Add-ons / basket scenario helpers.
 *
 * Simulates the basket add → remove → checkout flow using the in-memory
 * basket endpoints.  Checkout is intentionally pointed at /api/basket/checkout
 * rather than the Stripe redirect endpoint — the server returns 400/503 when
 * Stripe is not configured, which is expected and accepted as a safe outcome.
 */

const PRICE_IDS = [
  'price_stress_addon_lighting',
  'price_stress_addon_fog_machine',
  'price_stress_addon_confetti',
];

/**
 * Add an item to the basket.
 * Returns `{ ok }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string} priceId
 */
async function addToBasket(agent, priceId) {
  const res = await agent.post('/api/basket/add').send({ priceId });
  return { ok: res.status === 200 };
}

/**
 * Remove an item from the basket.
 * Returns `{ ok }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string} priceId
 */
async function removeFromBasket(agent, priceId) {
  const res = await agent.delete(`/api/basket/item/${encodeURIComponent(priceId)}`);
  return { ok: res.status === 200 };
}

/**
 * Fetch the current basket.
 * Returns `{ ok, body }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 */
async function getBasket(agent) {
  const res = await agent.get('/api/basket');
  return { ok: res.status === 200, body: res.body };
}

/**
 * Simulate a full basket round-trip: add N items, read basket, remove them all.
 * Returns `{ ok, addOk, removeOk }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 * @param {number} [itemCount=2]  Number of items to add.
 */
async function basketRoundTrip(agent, itemCount = 2) {
  const items = PRICE_IDS.slice(0, Math.min(itemCount, PRICE_IDS.length));
  let addOk = 0;
  let removeOk = 0;

  for (const priceId of items) {
    const { ok } = await addToBasket(agent, priceId).catch(() => ({ ok: false }));
    if (ok) addOk += 1;
  }

  await getBasket(agent).catch(() => {});

  for (const priceId of items) {
    const { ok } = await removeFromBasket(agent, priceId).catch(() => ({ ok: false }));
    if (ok) removeOk += 1;
  }

  return { ok: addOk > 0, addOk, removeOk };
}

/**
 * Simulate basket checkout (safe — no real payment initiated).
 * The server will return:
 *   - 503: Stripe not configured (STRIPE_SECRET_KEY absent) — expected in test environments
 *   - 400: basket is empty (items were removed in the prior round-trip) — expected
 *   - 200: checkout session URL returned (only if Stripe is configured)
 *   - 401: authentication failure — should not happen if agent is authenticated
 * Returns `{ ok }` where ok=true for expected no-cost outcomes (200/400/503).
 *
 * @param {import('supertest').SuperAgentTest} agent
 */
async function simulateCheckout(agent) {
  const res = await agent.post('/api/basket/checkout').send({});
  return { ok: res.status === 200 || res.status === 400 || res.status === 503 };
}

module.exports = { addToBasket, removeFromBasket, getBasket, basketRoundTrip, simulateCheckout };
