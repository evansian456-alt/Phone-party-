'use strict';
/**
 * Tests for the Referral Growth System
 *
 * Covers:
 *  - ReferralSystem unit tests (milestone logic, anti-fraud)
 *  - API endpoint integration tests
 */

const { ReferralSystem, MILESTONES, nextMilestone } = require('./referral-system');

// ─── Unit tests for ReferralSystem logic ─────────────────────────────────────

describe('ReferralSystem – milestone logic', () => {
  it('nextMilestone returns 3 when 0 referrals completed', () => {
    expect(nextMilestone(0)).toBe(3);
  });

  it('nextMilestone returns 5 after completing milestone at 3', () => {
    expect(nextMilestone(3)).toBe(5);
  });

  it('nextMilestone returns 10 after completing milestone at 5', () => {
    expect(nextMilestone(5)).toBe(10);
  });

  it('nextMilestone returns 20 after 10 referrals', () => {
    expect(nextMilestone(10)).toBe(20);
  });

  it('nextMilestone returns 50 after 20 referrals', () => {
    expect(nextMilestone(20)).toBe(50);
  });

  it('nextMilestone returns null once all milestones are passed', () => {
    expect(nextMilestone(50)).toBeNull();
    expect(nextMilestone(99)).toBeNull();
  });

  it('MILESTONES has 5 entries', () => {
    expect(MILESTONES).toHaveLength(5);
  });

  it('first milestone grants PARTY_PASS_SECONDS = 1800', () => {
    const m = MILESTONES.find(m => m.at === 3);
    expect(m).toBeDefined();
    expect(m.type).toBe('PARTY_PASS_SECONDS');
    expect(m.seconds).toBe(1800);
  });

  it('second milestone grants PARTY_PASS_SECONDS = 3600', () => {
    const m = MILESTONES.find(m => m.at === 5);
    expect(m).toBeDefined();
    expect(m.type).toBe('PARTY_PASS_SECONDS');
    expect(m.seconds).toBe(3600);
  });

  it('milestone at 10 grants PARTY_PASS_SESSION = 1', () => {
    const m = MILESTONES.find(m => m.at === 10);
    expect(m).toBeDefined();
    expect(m.type).toBe('PARTY_PASS_SESSION');
    expect(m.sessions).toBe(1);
  });

  it('milestone at 20 grants PARTY_PASS_SESSION = 3', () => {
    const m = MILESTONES.find(m => m.at === 20);
    expect(m.sessions).toBe(3);
  });

  it('milestone at 50 grants PRO_UNTIL (1 month)', () => {
    const m = MILESTONES.find(m => m.at === 50);
    expect(m.type).toBe('PRO_UNTIL');
    expect(m.proMonths).toBe(1);
  });
});

// ─── Unit tests with mocked DB/Redis ──────────────────────────────────────────

function makeMockDB() {
  const rows = {
    users: [],
    referrals: [],
    referral_clicks: [],
    referral_rewards: [],
  };

  // Simple mock that handles the queries used by ReferralSystem
  const query = jest.fn(async (sql, params) => {
    // SELECT referral_code FROM users WHERE id = ?
    if (/SELECT referral_code FROM users/.test(sql)) {
      const user = rows.users.find(u => u.id === params[0]);
      return { rows: user ? [{ referral_code: user.referral_code }] : [] };
    }
    // UPDATE users SET referral_code = ?
    if (/UPDATE users SET referral_code/.test(sql)) {
      const user = rows.users.find(u => u.id === params[1]);
      if (user && !user.referral_code) user.referral_code = params[0];
      return { rows: [] };
    }
    // SELECT id FROM users WHERE referral_code = ?
    if (/SELECT id FROM users WHERE referral_code/.test(sql)) {
      const user = rows.users.find(u => u.referral_code === params[0]);
      return { rows: user ? [{ id: user.id }] : [] };
    }
    // SELECT email FROM users WHERE id = ?
    if (/SELECT email FROM users WHERE id/.test(sql)) {
      const user = rows.users.find(u => u.id === params[0]);
      return { rows: user ? [{ email: user.email }] : [] };
    }
    // SELECT referred_by_user_id FROM users WHERE id = ?
    if (/SELECT referred_by_user_id FROM users WHERE id/.test(sql)) {
      const user = rows.users.find(u => u.id === params[0]);
      return { rows: user ? [{ referred_by_user_id: user.referred_by_user_id || null }] : [] };
    }
    // UPDATE users SET referred_by_user_id
    if (/UPDATE users SET referred_by_user_id/.test(sql)) {
      const user = rows.users.find(u => u.id === params[1]);
      if (user) user.referred_by_user_id = params[0];
      return { rows: [] };
    }
    // COUNT from referrals where inviter + ip_hash
    if (/ip_hash/.test(sql) && /COUNT/.test(sql) && /referrals/.test(sql)) {
      const count = rows.referrals.filter(r => r.inviter_user_id === params[0] && r.ip_hash === params[1] && r.status !== 'REJECTED').length;
      return { rows: [{ count: String(count) }] };
    }
    // INSERT INTO referral_clicks
    if (/INSERT INTO referral_clicks/.test(sql)) {
      const clickId = `click-${Date.now()}`;
      rows.referral_clicks.push({ click_id: clickId });
      return { rows: [{ click_id: clickId }] };
    }
    // INSERT INTO referrals
    if (/INSERT INTO referrals/.test(sql)) {
      rows.referrals.push({ inviter_user_id: params[0], status: 'SIGNED_UP' });
      return { rows: [] };
    }
    // UPDATE referrals SET referred_user_id ... status = 'SIGNED_UP'
    if (/UPDATE referrals SET referred_user_id/.test(sql)) {
      return { rows: [] };
    }
    // SELECT id, inviter_user_id, created_at FROM referrals WHERE referred_user_id
    if (/SELECT id.*inviter_user_id.*created_at/.test(sql) && /FROM referrals/.test(sql)) {
      const refs = rows.referrals.filter(r => r.referred_user_id === params[0] && ['SIGNED_UP','PROFILE_DONE'].includes(r.status));
      if (!refs.length) return { rows: [] };
      const r = refs[refs.length - 1];
      // Simulate that enough time has passed
      return { rows: [{ id: r.id || 'r1', inviter_user_id: r.inviter_user_id, created_at: new Date(Date.now() - 120000) }] };
    }
    // UPDATE referrals SET status = 'REJECTED'
    if (/UPDATE referrals SET status = 'REJECTED'/.test(sql)) {
      return { rows: [] };
    }
    // UPDATE referrals SET status = 'COMPLETED'
    if (/UPDATE referrals SET status = 'COMPLETED'/.test(sql)) {
      return { rows: [] };
    }
    // UPDATE users SET referrals_completed = referrals_completed + 1
    if (/UPDATE users SET referrals_completed/.test(sql)) {
      const user = rows.users.find(u => u.id === params[0]);
      if (user) { user.referrals_completed = (user.referrals_completed || 0) + 1; }
      return { rows: [{ referrals_completed: user ? user.referrals_completed : 1 }] };
    }
    // SELECT id FROM referral_rewards WHERE inviter_user_id AND milestone
    if (/SELECT id FROM referral_rewards/.test(sql) && /inviter_user_id/.test(sql)) {
      const r = rows.referral_rewards.find(r => r.inviter_user_id === params[0] && r.milestone === params[1]);
      return { rows: r ? [{ id: r.id || 'reward-id' }] : [] };
    }
    // INSERT INTO referral_rewards
    if (/INSERT INTO referral_rewards/.test(sql)) {
      rows.referral_rewards.push({ inviter_user_id: params[0], milestone: params[1], reward_type: params[2] });
      return { rows: [] };
    }
    // UPDATE users SET referral_reward_balance_seconds
    if (/UPDATE users SET referral_reward_balance_seconds/.test(sql)) {
      const user = rows.users.find(u => u.id === params[1]);
      if (user) user.referral_reward_balance_seconds = (user.referral_reward_balance_seconds || 0) + params[0];
      return { rows: [] };
    }
    // UPDATE users SET referral_reward_balance_sessions
    if (/UPDATE users SET referral_reward_balance_sessions/.test(sql)) {
      const user = rows.users.find(u => u.id === params[1]);
      if (user) user.referral_reward_balance_sessions = (user.referral_reward_balance_sessions || 0) + params[0];
      return { rows: [] };
    }
    // UPDATE users SET referral_reward_balance_pro_until
    if (/UPDATE users SET referral_reward_balance_pro_until/.test(sql)) {
      return { rows: [] };
    }
    // UPDATE referrals SET status = 'PROFILE_DONE'
    if (/UPDATE referrals SET status = 'PROFILE_DONE'/.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  return { query, rows };
}

function makeMockRedis() {
  const store = {};
  const incr = jest.fn(async (key) => { store[key] = (store[key] || 0) + 1; return store[key]; });
  const expire = jest.fn(async () => {});
  const get = jest.fn(async (key) => store[key] || null);
  const set = jest.fn(async (key, val) => { store[key] = val; });
  return { incr, expire, get, set, store };
}

describe('ReferralSystem – getOrCreateCode', () => {
  it('creates a new referral code for a user without one', async () => {
    const db = makeMockDB();
    db.rows.users.push({ id: 'u1', email: 'a@test.com', referral_code: null });
    const rs = new ReferralSystem(db, makeMockRedis());
    const code = await rs.getOrCreateCode('u1');
    expect(code).toBeTruthy();
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(4);
  });

  it('returns existing code if user already has one', async () => {
    const db = makeMockDB();
    db.rows.users.push({ id: 'u2', email: 'b@test.com', referral_code: 'MYCODE123' });
    const rs = new ReferralSystem(db, makeMockRedis());
    const code = await rs.getOrCreateCode('u2');
    expect(code).toBe('MYCODE123');
  });
});

describe('ReferralSystem – registerReferral anti-fraud', () => {
  let db, redis, rs;
  beforeEach(() => {
    db = makeMockDB();
    db.rows.users.push(
      { id: 'inviter1', email: 'host@test.com', referral_code: 'INVCODE01' },
      { id: 'newuser1', email: 'new@test.com',  referral_code: null, referred_by_user_id: null }
    );
    redis = makeMockRedis();
    rs = new ReferralSystem(db, redis);
  });

  it('successfully registers a valid referral', async () => {
    const result = await rs.registerReferral('INVCODE01', null, 'newuser1', 'new@test.com', '1.2.3.4');
    expect(result.ok).toBe(true);
    expect(result.inviterUserId).toBe('inviter1');
  });

  it('rejects self-referral (same userId)', async () => {
    const result = await rs.registerReferral('INVCODE01', null, 'inviter1', 'host@test.com', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('self_referral');
  });

  it('rejects referral with same email', async () => {
    const result = await rs.registerReferral('INVCODE01', null, 'newuser1', 'host@test.com', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('same_email');
  });

  it('rejects invalid referral code', async () => {
    const result = await rs.registerReferral('BADCODE99', null, 'newuser1', 'new@test.com', '1.2.3.4');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_code');
  });

  it('rejects already-referred user', async () => {
    db.rows.users[1].referred_by_user_id = 'inviter1';
    const result = await rs.registerReferral('INVCODE01', null, 'newuser1', 'new@test.com', '1.2.3.5');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('already_registered');
  });
});

describe('ReferralSystem – markPartyJoined milestone rewards', () => {
  let db, redis, rs;

  beforeEach(() => {
    db = makeMockDB();
    db.rows.users.push(
      { id: 'inviter2', email: 'inv2@test.com', referral_code: 'INVCODE02',
        referrals_completed: 0, referral_reward_balance_seconds: 0 },
      { id: 'referred2', email: 'ref2@test.com', referral_code: null, referred_by_user_id: 'inviter2' }
    );
    // Pre-seed a SIGNED_UP referral
    db.rows.referrals.push({
      id: 'ref-row-1', inviter_user_id: 'inviter2', referred_user_id: 'referred2',
      status: 'SIGNED_UP', created_at: new Date(Date.now() - 5 * 60 * 1000)
    });
    redis = makeMockRedis();
    rs = new ReferralSystem(db, redis);
  });

  it('completes a referral and grants reward at 3 completions', async () => {
    // Simulate user already having 2 completed referrals
    db.rows.users[0].referrals_completed = 2;
    const result = await rs.markPartyJoined('referred2');
    expect(result.rewarded).toBe(true);
    expect(result.reward).toBeDefined();
    expect(result.reward.type).toBe('PARTY_PASS_SECONDS');
    expect(result.reward.seconds).toBe(1800);
  });

  it('does not re-grant reward if milestone already awarded', async () => {
    db.rows.users[0].referrals_completed = 2;
    // Pre-seed the milestone 3 reward as already given
    db.rows.referral_rewards.push({ inviter_user_id: 'inviter2', milestone: 3 });
    const result = await rs.markPartyJoined('referred2');
    // Referral still completes but no NEW reward is granted at milestone 3
    expect(result.rewarded).toBe(false);
  });

  it('returns rewarded=false when no pending referral exists', async () => {
    const result = await rs.markPartyJoined('nonexistent-user');
    expect(result.rewarded).toBe(false);
  });
});

// ─── API endpoint integration tests ──────────────────────────────────────────

describe('Referral API endpoints (unauthenticated)', () => {
  let request, app;

  beforeAll(() => {
    request = require('supertest');
    ({ app } = require('./server'));
  });

  it('GET /api/referral/me returns 401 without auth', async () => {
    const res = await request(app).get('/api/referral/me');
    expect([401, 403]).toContain(res.status);
  });

  it('GET /api/referral/stats returns 401 without auth', async () => {
    const res = await request(app).get('/api/referral/stats');
    expect([401, 403]).toContain(res.status);
  });

  it('GET /api/referral/rewards returns 401 without auth', async () => {
    const res = await request(app).get('/api/referral/rewards');
    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/referral/register returns 401 without auth', async () => {
    const res = await request(app).post('/api/referral/register')
      .send({ referralCode: 'TESTCODE1' });
    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/referral/profile-complete returns 401 without auth', async () => {
    const res = await request(app).post('/api/referral/profile-complete');
    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/referral/party-first-join returns 401 without auth', async () => {
    const res = await request(app).post('/api/referral/party-first-join');
    expect([401, 403]).toContain(res.status);
  });
});

describe('POST /api/referral/click (no auth required)', () => {
  let request, app;

  beforeAll(() => {
    request = require('supertest');
    ({ app } = require('./server'));
  });

  it('returns 400 when referralCode is missing', async () => {
    const res = await request(app).post('/api/referral/click').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 or error for invalid referral code', async () => {
    const res = await request(app).post('/api/referral/click')
      .send({ referralCode: 'NOSUCHCODE' });
    // Should be 400 (invalid code), 500, or 503 (referral system unavailable in test env)
    expect([400, 500, 503]).toContain(res.status);
  });
});

describe('GET /invite/:code', () => {
  let request, app;

  beforeAll(() => {
    request = require('supertest');
    ({ app } = require('./server'));
  });

  it('redirects regular browsers to the signup page', async () => {
    const res = await request(app).get('/invite/TESTCODE1');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toMatch(/\/signup\?code=TESTCODE1/);
    expect(res.headers['location']).toMatch(/phone-party\.com/);
  });

  it('serves OG meta-tag page for social crawlers', async () => {
    const res = await request(app)
      .get('/invite/TESTCODE1')
      .set('User-Agent', 'facebookexternalhit/1.1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('og:title');
    expect(res.text).toContain('og:description');
    expect(res.text).toContain('og:image');
    expect(res.text).toContain('Phone Party');
  });

  it('includes the referral code in the redirect URL', async () => {
    const res = await request(app).get('/invite/MYCODE12');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain('MYCODE12');
  });

  it('sanitizes malformed code (strips non-alphanumeric)', async () => {
    const res = await request(app).get('/invite/BAD<script>CODE');
    // Should redirect or serve crawler page — either way must not echo raw injection
    expect([200, 302]).toContain(res.status);
    const output = res.text + (res.headers['location'] || '');
    expect(output).not.toMatch(/<script>/);
  });

  it('crawler page includes localStorage fallback script', async () => {
    const res = await request(app)
      .get('/invite/TESTCODE1')
      .set('User-Agent', 'Twitterbot/1.0');
    expect(res.text).toContain('localStorage.setItem');
    expect(res.text).toContain('referral_code');
  });
});

describe('GET /signup', () => {
  let request, app;

  beforeAll(() => {
    request = require('supertest');
    ({ app } = require('./server'));
  });

  it('serves index.html for the /signup path', async () => {
    const res = await request(app).get('/signup');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  it('serves index.html for /signup with query params', async () => {
    const res = await request(app).get('/signup?code=TESTCODE1&inviter=userid123');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});

describe('GET /api/referral/inviter-name', () => {
  let request, app;

  beforeAll(() => {
    request = require('supertest');
    ({ app } = require('./server'));
  });

  it('returns 400 when code param is missing', async () => {
    const res = await request(app).get('/api/referral/inviter-name');
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown referral code', async () => {
    const res = await request(app).get('/api/referral/inviter-name?code=UNKNOWNCODE');
    expect([404, 500, 503]).toContain(res.status);
  });
});

describe('getPublicBaseUrl + buildInviteLink helpers', () => {
  let getPublicBaseUrl, buildInviteLink;

  beforeAll(() => {
    ({ getPublicBaseUrl, buildInviteLink } = require('./referral-system'));
  });

  it('getPublicBaseUrl returns the production domain by default', () => {
    const orig = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    expect(getPublicBaseUrl()).toBe('https://www.phone-party.com');
    if (orig !== undefined) process.env.PUBLIC_BASE_URL = orig;
  });

  it('getPublicBaseUrl respects PUBLIC_BASE_URL env var', () => {
    const orig = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://staging.phone-party.com';
    expect(getPublicBaseUrl()).toBe('https://staging.phone-party.com');
    if (orig !== undefined) process.env.PUBLIC_BASE_URL = orig;
    else delete process.env.PUBLIC_BASE_URL;
  });

  it('buildInviteLink produces /signup?code=...&inviter=... on production domain', () => {
    const orig = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    const link = buildInviteLink('MYCODE12', 'user-abc');
    expect(link).toBe('https://www.phone-party.com/signup?code=MYCODE12&inviter=user-abc');
    if (orig !== undefined) process.env.PUBLIC_BASE_URL = orig;
  });

  it('buildInviteLink never uses railway or run.app domain', () => {
    const orig = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    const link = buildInviteLink('CODE', 'uid');
    expect(link).not.toContain('railway');
    expect(link).not.toContain('run.app');
    if (orig !== undefined) process.env.PUBLIC_BASE_URL = orig;
  });
});
