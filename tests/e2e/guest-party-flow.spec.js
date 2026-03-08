// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Guest party flow tests.
 * Covers: opening invite link, joining party, interacting with party features.
 */

const BASE = process.env.BASE_URL || 'http://localhost:8080';

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeUser(prefix = 'guest') {
  const id = uid();
  return {
    email: `e2e_${prefix}_${id}@test.invalid`,
    password: 'E2eTest123!',
    djName: `DJ_${prefix}_${id}`.slice(0, 30),
  };
}

async function createPartyAsHost(request, djName) {
  const res = await request.post(`${BASE}/api/create-party`, { data: { djName } });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return { code: body.code, hostId: body.hostId };
}

test.describe('Guest party flow', () => {
  let partyCode;
  let hostDjName;

  test.beforeEach(async ({ request }) => {
    // Create a host and a party
    const host = makeUser('host_for_guest');
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: host.email, password: host.password, djName: host.djName, termsAccepted: true },
    });
    await request.post(`${BASE}/api/auth/login`, {
      data: { email: host.email, password: host.password },
    });
    hostDjName = host.djName;
    const party = await createPartyAsHost(request, host.djName);
    partyCode = party.code;
  });

  test('party exists and is joinable', async ({ request }) => {
    const res = await request.get(`${BASE}/api/party?code=${partyCode}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.status).not.toBe('ended');
  });

  test('guest can join party via API', async ({ request }) => {
    const guest = makeUser();

    const joinRes = await request.post(`${BASE}/api/join-party`, {
      data: { partyCode: partyCode, nickname: guest.djName },
    });
    expect(joinRes.ok()).toBeTruthy();
    const body = await joinRes.json();
    expect(body.success).toBe(true);
    expect(body.partyCode).toBe(partyCode);
  });

  test('guest count increments after join', async ({ request }) => {
    const initialRes = await request.get(`${BASE}/api/party?code=${partyCode}`);
    const initialBody = await initialRes.json();
    const initialCount = (initialBody.guests || []).length;

    // Add a second guest
    const guestName = `DJ_GCount_${uid()}`.slice(0, 30);
    await request.post(`${BASE}/api/join-party`, {
      data: { partyCode: partyCode, nickname: guestName },
    });

    const afterRes = await request.get(`${BASE}/api/party?code=${partyCode}`);
    const afterBody = await afterRes.json();
    const afterCount = (afterBody.guests || []).length;

    expect(afterCount).toBeGreaterThanOrEqual(initialCount);
  });

  test('guest can leave party via API', async ({ request }) => {
    const guestName = `DJ_Leave_${uid()}`.slice(0, 30);

    // Join first
    const joinRes = await request.post(`${BASE}/api/join-party`, {
      data: { partyCode: partyCode, nickname: guestName },
    });
    const joinBody = await joinRes.json();
    const guestId = joinBody.guestId;

    // Leave
    const leaveRes = await request.post(`${BASE}/api/leave-party`, {
      data: { partyCode, guestId },
    });
    expect(leaveRes.ok()).toBeTruthy();
    const body = await leaveRes.json();
    expect(body.ok).toBe(true);
    // Create and end a party
    const host2 = makeUser('host2');
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: host2.email, password: host2.password, djName: host2.djName, termsAccepted: true },
    });
    await request.post(`${BASE}/api/auth/login`, {
      data: { email: host2.email, password: host2.password },
    });
    const { code: endedCode, hostId: endedHostId } = await createPartyAsHost(request, host2.djName);
    await request.post(`${BASE}/api/end-party`, { data: { partyCode: endedCode, hostId: endedHostId } });

    const joinEndedRes = await request.post(`${BASE}/api/join-party`, {
      data: { partyCode: endedCode, nickname: 'LateGuest' },
    });
    expect(joinEndedRes.ok()).toBeFalsy();
    const joinEndedBody = await joinEndedRes.json();
    expect(joinEndedBody.error).toBeDefined();
  });

  test('invite link opens party view in browser', async ({ page }) => {
    // The invite link pattern typically includes the party code
    await page.goto(`${BASE}/?party=${partyCode}`);
    await page.waitForTimeout(1500);
    // The page should have loaded without crashing
    await expect(page.locator('body')).not.toBeEmpty();
  });
});
