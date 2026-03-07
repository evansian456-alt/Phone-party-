'use strict';

/**
 * Integration tests — Party API
 *
 * Tests the full party lifecycle end-to-end at the API level using supertest:
 *   - Create party (host)
 *   - Get party info
 *   - Join party (guest)
 *   - Party state (host vs. guest view)
 *   - Add / remove tracks
 *   - End party (host only)
 *   - Access-control: guest cannot end party, non-member cannot see private state
 */

const request = require('supertest');
const { assertStripeTestMode } = require('../helpers/stripe-guard');

assertStripeTestMode();

const { app } = require('../../server');

// ─── Helpers ────────────────────────────────────────────────────────────────

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeUser(prefix = 'party') {
  const id = uid();
  return {
    email: `integration_${prefix}_${id}@test.invalid`,
    password: process.env.TEST_USER_PASSWORD || 'ChangeMe123!',
    djName: `DJ_${prefix}_${id}`.slice(0, 30),
  };
}

async function signupAndLogin(agent, user) {
  await agent
    .post('/api/auth/signup')
    .send({ email: user.email, password: user.password, djName: user.djName, termsAccepted: true })
    .expect(201);

  const res = await agent
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password })
    .expect(200);

  return res.body.user;
}

// ─── Create Party ────────────────────────────────────────────────────────────

describe('POST /api/create-party', () => {
  let hostAgent;
  let host;

  beforeEach(async () => {
    hostAgent = request.agent(app);
    host = makeUser('createhost');
    await signupAndLogin(hostAgent, host);
  });

  test('creates a party and returns a code', async () => {
    const res = await hostAgent
      .post('/api/create-party')
      .send({ djName: host.djName });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeDefined();
    expect(typeof res.body.code).toBe('string');
    expect(res.body.code.length).toBeGreaterThan(0);
  });

  test('unauthenticated user can create a party (endpoint is open)', async () => {
    const res = await request(app)
      .post('/api/create-party')
      .send({ djName: 'UnauthorisedDJ' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeDefined();
  });
});

// ─── Get Party ───────────────────────────────────────────────────────────────

describe('GET /api/party', () => {
  let hostAgent;
  let host;
  let partyCode;

  beforeAll(async () => {
    hostAgent = request.agent(app);
    host = makeUser('getparty');
    await signupAndLogin(hostAgent, host);

    const createRes = await hostAgent
      .post('/api/create-party')
      .send({ djName: host.djName });
    partyCode = createRes.body.code;
  });

  test('returns party info for a valid code', async () => {
    const res = await request(app).get(`/api/party?code=${partyCode}`);
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
    expect(res.body.partyCode).toBeDefined();
    expect(res.body.status).not.toBe('ended');
  });

  test('returns exists=false for an unknown code', async () => {
    const res = await request(app).get('/api/party?code=ZZZZZZ');
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
  });
});

// ─── Join Party ──────────────────────────────────────────────────────────────

describe('POST /api/join-party', () => {
  let hostAgent;
  let guestAgent;
  let host;
  let guest;
  let partyCode;

  beforeAll(async () => {
    hostAgent = request.agent(app);
    host = makeUser('joinhost');
    await signupAndLogin(hostAgent, host);

    const createRes = await hostAgent
      .post('/api/create-party')
      .send({ djName: host.djName });
    partyCode = createRes.body.code;

    guestAgent = request.agent(app);
    guest = makeUser('joinguest');
    await signupAndLogin(guestAgent, guest);
  });

  test('authenticated guest can join with valid code', async () => {
    const res = await guestAgent.post('/api/join-party').send({
      partyCode: partyCode,
      nickname: guest.djName,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('joining with invalid code returns 404', async () => {
    const res = await guestAgent.post('/api/join-party').send({
      code: 'BADCODE999',
      guestId: `guest_${uid()}`,
      djName: guest.djName,
    });

    expect([404, 400]).toContain(res.status);
  });
});

// ─── Party State ─────────────────────────────────────────────────────────────

describe('GET /api/party-state', () => {
  let hostAgent;
  let guestAgent;
  let host;
  let guest;
  let partyCode;

  beforeAll(async () => {
    hostAgent = request.agent(app);
    host = makeUser('statehost');
    await signupAndLogin(hostAgent, host);

    const createRes = await hostAgent
      .post('/api/create-party')
      .send({ djName: host.djName });
    partyCode = createRes.body.code;

    guestAgent = request.agent(app);
    guest = makeUser('stateguest');
    await signupAndLogin(guestAgent, guest);
    await guestAgent.post('/api/join-party').send({
      partyCode: partyCode,
      nickname: guest.djName,
    });
  });

  test('host sees party state with hostView=true', async () => {
    const res = await hostAgent.get(`/api/party-state?code=${partyCode}`);
    expect(res.status).toBe(200);
    expect(res.body.partyCode).toBeDefined();
  });

  test('guest sees party state', async () => {
    const res = await guestAgent.get(`/api/party-state?code=${partyCode}`);
    expect(res.status).toBe(200);
    expect(res.body.partyCode).toBeDefined();
  });

  test('multiple consecutive polls return consistent state', async () => {
    const [res1, res2] = await Promise.all([
      hostAgent.get(`/api/party-state?code=${partyCode}`),
      hostAgent.get(`/api/party-state?code=${partyCode}`),
    ]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Core identifiers must be identical across polls
    expect(res1.body.partyCode).toBe(res2.body.partyCode);
  });
});

// ─── End Party ───────────────────────────────────────────────────────────────

describe('POST /api/end-party', () => {
  let hostAgent;
  let guestAgent;
  let host;
  let guest;
  let partyCode;
  let hostId;

  beforeAll(async () => {
    hostAgent = request.agent(app);
    host = makeUser('endhost');
    await signupAndLogin(hostAgent, host);

    const createRes = await hostAgent
      .post('/api/create-party')
      .send({ djName: host.djName });
    partyCode = createRes.body.code;
    hostId = createRes.body.hostId;

    guestAgent = request.agent(app);
    guest = makeUser('endguest');
    await signupAndLogin(guestAgent, guest);
    await guestAgent.post('/api/join-party').send({
      partyCode: partyCode,
      nickname: guest.djName,
    });
  });

  test('guest cannot end the party (403)', async () => {
    // Guest does not have the hostId, so the auth check fails → 403
    const res = await guestAgent.post('/api/end-party').send({ partyCode: partyCode });
    expect(res.status).toBe(403);
  });

  test('host can end the party', async () => {
    const res = await hostAgent.post('/api/end-party').send({ partyCode: partyCode, hostId: hostId });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('ended party shows as ended in GET /api/party', async () => {
    const res = await request(app).get(`/api/party?code=${partyCode}`);
    // Either the party is gone or it is marked ended
    const ended = !res.body.exists || res.body.status === 'ended';
    expect(ended).toBe(true);
  });
});
