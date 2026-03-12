#!/usr/bin/env node
'use strict';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8080';

class Client {
  constructor(name) {
    this.name = name;
    this.cookie = '';
  }

  async request(path, { method = 'GET', body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;

    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}

    if (res.status === 429) {
      let lastText = text;
      for (let attempt = 1; attempt <= 20; attempt++) {
        await new Promise((r) => setTimeout(r, 1500));
        const retryRes = await fetch(`${BASE_URL}${path}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        const retryText = await retryRes.text();
        lastText = retryText;
        if (retryRes.ok) {
          let retryJson = null;
          try { retryJson = retryText ? JSON.parse(retryText) : null; } catch (_) {}
          return retryJson;
        }
        if (retryRes.status !== 429) {
          throw new Error(`${this.name} ${method} ${path} -> ${retryRes.status} ${retryText}`);
        }
      }
      throw new Error(`${this.name} ${method} ${path} -> 429 ${lastText}`);
    }

    if (!res.ok) {
      throw new Error(`${this.name} ${method} ${path} -> ${res.status} ${text}`);
    }
    return json;
  }
}

async function main() {
  const email = `fullflow_${Date.now()}@example.com`;
  const password = 'TestPassword123!';

  const host = new Client('host');
  const guestA = new Client('guestA');
  const guestB = new Client('guestB');

  console.log('[flow] signup');
  await host.request('/api/auth/signup', {
    method: 'POST',
    body: { email, password, djName: 'FlowDJ', termsAccepted: true }
  });

  console.log('[flow] complete profile + logout + login');
  await host.request('/api/complete-profile', { method: 'POST', body: { djName: 'FlowDJ Prime' } });
  await host.request('/api/auth/logout', { method: 'POST', body: {} });
  await host.request('/api/auth/login', { method: 'POST', body: { email, password } });

  console.log('[flow] fetch me + store');
  await host.request('/api/me');
  const store = await host.request('/api/store');

  console.log('[flow] create party');
  const created = await host.request('/api/create-party', {
    method: 'POST',
    body: { djName: 'FlowDJ Prime', source: 'local' }
  });
  const partyCode = created.partyCode || created.code;
  if (!partyCode) throw new Error('missing partyCode from create-party response');

  console.log('[flow] upgrade party tier before multi-guest join');
  await host.request('/api/purchase', {
    method: 'POST',
    body: { itemId: 'party_pass', partyCode }
  });

  console.log('[flow] guests join');
  const g1 = await guestA.request('/api/join-party', { method: 'POST', body: { partyCode, nickname: 'Guest A' } });
  const g2 = await guestB.request('/api/join-party', { method: 'POST', body: { partyCode, nickname: 'Guest B' } });
  if (!g1.guestId || !g2.guestId) throw new Error('guest join did not return guestId');

  console.log('[flow] buy all remaining store items');
  const allItems = [
    ...(store.visualPacks || []),
    ...(store.djTitles || []),
    ...(store.profileUpgrades || []),
    ...(store.partyExtensions || []),
    ...(store.hypeEffects || []),
    ...(store.subscriptions || []),
  ];

  for (const item of allItems) {
    if (item.id === 'party_pass') continue;
    await host.request('/api/purchase', {
      method: 'POST',
      body: { itemId: item.id, partyCode }
    });
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('[flow] verify entitlements and party state');
  await host.request('/api/user/entitlements');
  await host.request(`/api/party/${partyCode}`);
  await host.request(`/api/party/${partyCode}/members`);

  console.log('[flow] guests leave, host ends party');
  await guestA.request('/api/leave-party', { method: 'POST', body: { partyCode, guestId: g1.guestId } });
  await guestB.request('/api/leave-party', { method: 'POST', body: { partyCode, guestId: g2.guestId } });
  await host.request('/api/end-party', { method: 'POST', body: { partyCode, hostId: created.hostId } });

  console.log(`[flow] COMPLETE partyCode=${partyCode} email=${email} itemsPurchased=${allItems.length}`);
}

main().catch((err) => {
  console.error('[flow] FAILED', err.message);
  process.exit(1);
});
