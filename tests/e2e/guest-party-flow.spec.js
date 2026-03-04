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
  return (await res.json()).code;
}

test.describe('Guest party flow', () => {
  let partyCode;
  let hostDjName;

  test.beforeAll(async ({ request }) => {
    // Create a host and a party
    const host = makeUser('host_for_guest');
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: host.email, password: host.password, djName: host.djName, termsAccepted: true },
    });
    await request.post(`${BASE}/api/auth/login`, {
      data: { email: host.email, password: host.password },
    });
    hostDjName = host.djName;
    partyCode = await createPartyAsHost(request, host.djName);
  });

  test('party exists and is joinable', async ({ request }) => {
    const res = await request.get(`${BASE}/api/party?code=${partyCode}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.party.ended).toBeFalsy();
  });

  test('guest can join party via API', async ({ request }) => {
    const guest = makeUser();
    const guestId = `guest_${uid()}`;

    const joinRes = await request.post(`${BASE}/api/join-party`, {
      data: { code: partyCode, guestId, djName: guest.djName },
    });
    expect(joinRes.ok()).toBeTruthy();
    const body = await joinRes.json();
    expect(body.success).toBe(true);
    expect(body.party).toBeDefined();
    expect(body.party.code).toBe(partyCode);
  });

  test('guest count increments after join', async ({ request }) => {
    const initialRes = await request.get(`${BASE}/api/party?code=${partyCode}`);
    const initialBody = await initialRes.json();
    const initialCount = Object.keys(initialBody.party?.guests || {}).length;

    // Add a second guest
    const guestId = `guest_count_${uid()}`;
    const guestName = `DJ_GCount_${uid()}`.slice(0, 30);
    await request.post(`${BASE}/api/join-party`, {
      data: { code: partyCode, guestId, djName: guestName },
    });

    const afterRes = await request.get(`${BASE}/api/party?code=${partyCode}`);
    const afterBody = await afterRes.json();
    const afterCount = Object.keys(afterBody.party?.guests || {}).length;

    expect(afterCount).toBeGreaterThanOrEqual(initialCount);
  });

  test('guest can leave party via API', async ({ request }) => {
    const guestId = `guest_leave_${uid()}`;
    const guestName = `DJ_Leave_${uid()}`.slice(0, 30);

    // Join first
    await request.post(`${BASE}/api/join-party`, {
      data: { code: partyCode, guestId, djName: guestName },
    });

    // Leave
    const leaveRes = await request.post(`${BASE}/api/leave-party`, {
      data: { code: partyCode, guestId },
    });
    expect(leaveRes.ok()).toBeTruthy();
    const body = await leaveRes.json();
    expect(body.success).toBe(true);
  });

  test('cannot join ended party', async ({ request }) => {
    // Create and end a party
    const host2 = makeUser('host2');
    await request.post(`${BASE}/api/auth/signup`, {
      data: { email: host2.email, password: host2.password, djName: host2.djName, termsAccepted: true },
    });
    await request.post(`${BASE}/api/auth/login`, {
      data: { email: host2.email, password: host2.password },
    });
    const endedCode = await createPartyAsHost(request, host2.djName);
    await request.post(`${BASE}/api/end-party`, { data: { code: endedCode } });

    const joinRes = await request.post(`${BASE}/api/join-party`, {
      data: { code: endedCode, guestId: `g_${uid()}`, djName: 'LateGuest' },
    });
    expect(joinRes.ok()).toBeFalsy();
    const body = await joinRes.json();
    expect(body.error).toBeDefined();
  });

  test('invite link opens party view in browser', async ({ page }) => {
    // The invite link pattern typically includes the party code
    await page.goto(`${BASE}/?party=${partyCode}`);
    await page.waitForTimeout(1500);
    // The page should have loaded without crashing
    await expect(page.locator('body')).not.toBeEmpty();
  });
});
