'use strict';

/**
 * Host scenario helpers.
 *
 * Provides functions that simulate a host user's lifecycle:
 *   1. signupAndLogin
 *   2. createParty
 *   3. queueTrack (stub — no real file upload required)
 *   4. startTrack
 *
 * All functions accept a supertest `agent` (already authenticated) and return
 * `{ ok: boolean, data?: any }` so callers can check success uniformly.
 */

/**
 * Sign up then log in using the provided supertest `request` module and `app`.
 * Returns `{ ok, agent, user }`.
 */
async function signupAndLogin(request, app, user) {
  const agent = request.agent(app);

  const signupRes = await agent
    .post('/api/auth/signup')
    .send({ email: user.email, password: user.password, djName: user.djName });

  if (signupRes.status !== 201 && signupRes.status !== 200) {
    return { ok: false, agent, user };
  }

  const loginRes = await agent
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password });

  const ok = loginRes.status === 200;
  return { ok, agent, user };
}

/**
 * Create a party.  Returns `{ ok, code }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string} djName
 */
async function createParty(agent, djName) {
  const res = await agent.post('/api/create-party').send({ djName });
  const ok = res.status === 200 || res.status === 201;
  return { ok, code: res.body?.partyCode || res.body?.code || null, hostId: res.body?.hostId || null };
}

/**
 * Add a stub track to the party queue (no real audio file required).
 * Returns `{ ok }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string} partyCode
 * @param {number|string} hostId  The numeric hostId returned by create-party.
 */
async function queueTrack(agent, partyCode, hostId) {
  const trackId = `STRESS_TRK_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  // Use /api/track/ URL format so the server's trackUrl validation passes (local source)
  const trackUrl = `/api/track/${trackId}`;
  const res = await agent.post(`/api/party/${partyCode}/queue-track`).send({
    hostId,
    trackId,
    trackUrl,
    title: `Stress Track ${trackId}`,
    durationMs: 180000,
    filename: `${trackId}.mp3`,
    contentType: 'audio/mpeg',
    sizeBytes: 1024,
  });
  const ok = res.status === 200 || res.status === 201;
  return { ok, trackId, trackUrl };
}

/**
 * Start playback of a previously queued track.
 * Returns `{ ok }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string} partyCode
 * @param {string} trackId
 * @param {string} [trackUrl]
 */
async function startTrack(agent, partyCode, trackId, trackUrl) {
  const url = trackUrl || `/api/track/${trackId}`;
  const res = await agent.post(`/api/party/${partyCode}/start-track`).send({
    trackId,
    trackUrl: url,
    title: `Stress Track ${trackId}`,
    durationMs: 180000,
    startPositionSec: 0,
  });
  const ok = res.status === 200;
  return { ok };
}

/**
 * Poll party state (as host).
 * Returns `{ ok, body }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string} partyCode
 */
async function getPartyState(agent, partyCode) {
  const res = await agent.get(`/api/party-state?code=${partyCode}`);
  const ok = res.status === 200;
  return { ok, body: res.body };
}

/** Known test promo code that unlocks partyPro on any party. */
const STRESS_PROMO_CODE = 'SS-PARTY-A9K2';

/**
 * Apply a promo code to unlock partyPro (unlimited guests) for the party.
 * Returns `{ ok }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string} partyCode
 */
async function applyPromo(agent, partyCode) {
  const res = await agent.post('/api/apply-promo').send({
    partyCode,
    promoCode: STRESS_PROMO_CODE,
  });
  return { ok: res.status === 200 };
}

module.exports = { signupAndLogin, createParty, queueTrack, startTrack, getPartyState, applyPromo };
