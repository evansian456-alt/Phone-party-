'use strict';

/**
 * Guest scenario helpers.
 *
 * Provides functions that simulate a guest user's lifecycle:
 *   1. signupAndLogin
 *   2. joinParty
 *   3. pollPartyState (simulates "listening" by polling the state endpoint)
 *   4. getMe (verify profile/tier data)
 *
 * All functions return `{ ok: boolean, data?: any }`.
 */

/**
 * Sign up then log in using the provided supertest `request` module and `app`.
 * Returns `{ ok, agent, user }`.
 */
async function signupAndLogin(request, app, user) {
  const agent = request.agent(app);

  const signupRes = await agent
    .post('/api/auth/signup')
    .send({ email: user.email, password: user.password, djName: user.djName, termsAccepted: true });

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
 * Join a party as guest.
 * Returns `{ ok, guestId }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string} partyCode
 * @param {string} djName
 */
async function joinParty(agent, partyCode, djName) {
  const guestId = `g_stress_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const res = await agent.post('/api/join-party').send({
    partyCode,
    nickname: djName,
  });
  const ok = res.status === 200 || res.status === 201;
  return { ok, guestId };
}

/**
 * Poll party state once (simulates a single "receive" event).
 * Returns `{ ok, body }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string} partyCode
 */
async function pollPartyState(agent, partyCode) {
  const res = await agent.get(`/api/party-state?code=${partyCode}`);
  const ok = res.status === 200;
  return { ok, body: res.body };
}

/**
 * Fetch /api/me to verify the guest's own data is consistent.
 * Returns `{ ok, body, status }`.
 *
 * @param {import('supertest').SuperAgentTest} agent
 */
async function getMe(agent) {
  const res = await agent.get('/api/me');
  const ok = res.status === 200;
  return { ok, body: res.body, status: res.status };
}

module.exports = { signupAndLogin, joinParty, pollPartyState, getMe };
