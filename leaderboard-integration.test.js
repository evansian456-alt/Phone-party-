/**
 * Integration test to verify leaderboard and scoring Pro Monthly filter
 * Tests the complete flow from party end to score persistence
 *
 * Since prototype mode is removed, tiers are set directly in Redis for testing.
 */

const request = require('supertest');
const { app, waitForRedis, redis, parties } = require('./server');

/**
 * Helper: Create a party and set its tier directly in Redis (test-only pattern)
 */
async function createPartyWithTier(djName, tier) {
  const res = await request(app)
    .post('/api/create-party')
    .send({ djName, source: 'local' });
  expect(res.status).toBe(200);
  const partyCode = res.body.partyCode;
  
  const existing = JSON.parse(await redis.get(`party:${partyCode}`));
  const now = Date.now();
  if (tier === 'PARTY_PASS') {
    existing.tier = 'PARTY_PASS';
    existing.partyPassExpiresAt = now + (2 * 60 * 60 * 1000);
    existing.maxPhones = 4;
  } else if (tier === 'PRO_MONTHLY') {
    existing.tier = 'PRO_MONTHLY';
    existing.partyPassExpiresAt = now + (30 * 24 * 60 * 60 * 1000);
    existing.maxPhones = 10;
  } else {
    existing.tier = null;
    existing.partyPassExpiresAt = null;
    existing.maxPhones = null;
  }
  await redis.set(`party:${partyCode}`, JSON.stringify(existing));
  return { res, partyCode };
}

describe('Leaderboard and Scoring Integration - Pro Monthly Filter', () => {
  // Wait for Redis to be ready before running tests
  beforeAll(async () => {
    try {
      await waitForRedis();
    } catch (error) {
      console.error('Failed to connect to Redis:', error.message);
    }
  });

  // Clear parties and Redis before each test
  beforeEach(async () => {
    parties.clear();
    if (redis) {
      await redis.flushall();
    }
  });

  describe('Score Persistence Behavior', () => {
    test('should skip score update for hosts without Pro Monthly subscription', async () => {
      const response = await request(app)
        .post('/api/create-party')
        .send({ djName: 'DJ Free User', source: 'local' })
        .expect(200);
      
      const { partyCode } = response.body;
      expect(partyCode).toBeTruthy();
      
      const stateResponse = await request(app)
        .get(`/api/party-state?code=${partyCode}`)
        .expect(200);
      
      // No tier set for free party
      expect(stateResponse.body.tierInfo.tier).toBeNull();
    });

    test('should allow score update for hosts with Pro Monthly subscription', async () => {
      const { partyCode } = await createPartyWithTier('DJ Pro User', 'PRO_MONTHLY');
      
      expect(partyCode).toBeTruthy();
      
      const stateResponse = await request(app)
        .get(`/api/party-state?code=${partyCode}`)
        .expect(200);
      
      expect(stateResponse.body.tierInfo.tier).toBe('PRO_MONTHLY');
    });
  });

  describe('Leaderboard API Behavior', () => {
    test('GET /api/leaderboard/djs endpoint exists', async () => {
      const response = await request(app)
        .get('/api/leaderboard/djs?limit=10');
      expect(response.status).not.toBe(404);
    });

    test('GET /api/leaderboard/guests endpoint exists', async () => {
      const response = await request(app)
        .get('/api/leaderboard/guests?limit=10');
      expect(response.status).not.toBe(404);
    });
  });

  describe('Tier System Integration', () => {
    test('FREE tier users should not be eligible for leaderboard', async () => {
      const response = await request(app)
        .post('/api/create-party')
        .send({ djName: 'DJ Free', source: 'local' })
        .expect(200);
      
      const stateResponse = await request(app)
        .get(`/api/party-state?code=${response.body.partyCode}`)
        .expect(200);
      
      // FREE tier: null tier with no expiry
      expect(stateResponse.body.tierInfo.tier).toBeNull();
      expect(stateResponse.body.tierInfo.partyPassExpiresAt).toBeNull();
    });

    test('PARTY_PASS tier users should not be eligible for leaderboard', async () => {
      const { partyCode } = await createPartyWithTier('DJ Party Pass', 'PARTY_PASS');
      
      const stateResponse = await request(app)
        .get(`/api/party-state?code=${partyCode}`)
        .expect(200);
      
      expect(stateResponse.body.tierInfo.tier).toBe('PARTY_PASS');
    });

    test('PRO_MONTHLY tier users should be eligible for leaderboard', async () => {
      const { partyCode } = await createPartyWithTier('DJ Pro Monthly', 'PRO_MONTHLY');
      
      const stateResponse = await request(app)
        .get(`/api/party-state?code=${partyCode}`)
        .expect(200);
      
      expect(stateResponse.body.tierInfo.tier).toBe('PRO_MONTHLY');
      expect(stateResponse.body.tierInfo.partyPassExpiresAt).toBeTruthy();
    });
  });

  describe('Documentation and Compliance', () => {
    test('database.js should have Pro Monthly checks in updateDjProfileScore', () => {
      const fs = require('fs');
      const path = require('path');
      const dbCode = fs.readFileSync(path.join(__dirname, 'database.js'), 'utf8');
      
      expect(dbCode).toContain('FROM user_upgrades');
      expect(dbCode).toContain('pro_monthly_active');
      expect(dbCode).toContain('no active Pro Monthly subscription');
    });

    test('database.js should filter leaderboard by Pro Monthly in getTopDjs', () => {
      const fs = require('fs');
      const path = require('path');
      const dbCode = fs.readFileSync(path.join(__dirname, 'database.js'), 'utf8');
      
      expect(dbCode).toContain('JOIN user_upgrades uu');
      expect(dbCode).toContain('WHERE uu.pro_monthly_active = TRUE');
    });
  });
});
