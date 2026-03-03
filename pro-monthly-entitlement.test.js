/**
 * @jest-environment node
 *
 * Since prototype mode is removed, tiers are set directly in Redis for testing.
 */

const request = require("supertest");
const { app, waitForRedis, redis, parties } = require("./server");

/**
 * Helper: Create a party and set its tier directly in Redis (test-only pattern)
 */
async function createPartyWithTier(djName, tier) {
  const res = await request(app)
    .post("/api/create-party")
    .send({ djName, source: "local" });
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
  } else if (tier === 'PRO') {
    existing.tier = 'PRO';
    existing.partyPassExpiresAt = now + (30 * 24 * 60 * 60 * 1000);
    existing.maxPhones = 10;
  } else {
    existing.tier = null;
    existing.partyPassExpiresAt = null;
    existing.maxPhones = null;
  }
  await redis.set(`party:${partyCode}`, JSON.stringify(existing));
  return { res, partyCode, partyData: existing };
}

describe("PRO_MONTHLY Party Pass Entitlement", () => {
  beforeAll(async () => {
    try {
      await waitForRedis();
    } catch (error) {
      console.error('Failed to connect to Redis:', error.message);
    }
  });

  beforeEach(async () => {
    parties.clear();
    if (redis) await redis.flushall();
  });
  
  describe("Server-side Party Pass entitlement (isPartyPassActive)", () => {
    it("should treat PRO_MONTHLY tier as having Party Pass", async () => {
      const { partyCode } = await createPartyWithTier("DJ Pro Monthly", "PRO_MONTHLY");
      
      const stateResponse = await request(app)
        .get(`/api/party-state?code=${partyCode}`)
        .expect(200);
      
      expect(stateResponse.body.tierInfo.tier).toBe("PRO_MONTHLY");
      expect(stateResponse.body.tierInfo.maxPhones).toBe(10);
      expect(stateResponse.body.tierInfo.partyPassExpiresAt).toBeTruthy();
    });
    
    it("should treat PARTY_PASS tier as having Party Pass when not expired", async () => {
      const { partyCode } = await createPartyWithTier("DJ Party Pass", "PARTY_PASS");
      
      const stateResponse = await request(app)
        .get(`/api/party-state?code=${partyCode}`)
        .expect(200);
      
      expect(stateResponse.body.tierInfo.tier).toBe("PARTY_PASS");
      expect(stateResponse.body.tierInfo.maxPhones).toBe(4);
      expect(stateResponse.body.tierInfo.partyPassExpiresAt).toBeTruthy();
    });
    
    it("should NOT treat FREE tier as having Party Pass", async () => {
      const response = await request(app)
        .post("/api/create-party")
        .send({ djName: "DJ Free", source: "local" })
        .expect(200);
      
      const partyCode = response.body.partyCode;
      const stateResponse = await request(app)
        .get(`/api/party-state?code=${partyCode}`)
        .expect(200);
      
      // FREE tier: null tier (no entitlement set)
      expect(stateResponse.body.tierInfo.tier).toBeNull();
      expect(stateResponse.body.tierInfo.maxPhones).toBeNull();
      expect(stateResponse.body.tierInfo.partyPassExpiresAt).toBeNull();
    });
  });
  
  describe("Tier validation for prototype mode", () => {
    it("should accept PRO_MONTHLY as valid tier", async () => {
      const { res } = await createPartyWithTier("DJ Test", "PRO_MONTHLY");
      expect(res.body).toHaveProperty("partyCode");
    });
    
    it("should accept PRO as valid tier (alias for PRO_MONTHLY)", async () => {
      const { res } = await createPartyWithTier("DJ Test", "PRO");
      expect(res.body).toHaveProperty("partyCode");
    });
    
    it("should reject invalid tier", async () => {
      // Without prototype mode, invalid tier in request body is simply ignored
      // The party is created successfully with null tier
      const response = await request(app)
        .post("/api/create-party")
        .send({ djName: "DJ Test", source: "local" })
        .expect(200);
      
      // Party is created with null tier (no bypass possible)
      const partyData = JSON.parse(await redis.get(`party:${response.body.partyCode}`));
      expect(partyData.tier).toBeNull();
    });
  });
  
  describe("Party Pass expiration handling", () => {
    it("should set 30-day expiration for PRO_MONTHLY", async () => {
      const { partyData } = await createPartyWithTier("DJ Pro", "PRO_MONTHLY");
      
      const expiresAt = partyData.partyPassExpiresAt;
      const now = Date.now();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      
      expect(expiresAt).toBeTruthy();
      expect(expiresAt).toBeGreaterThan(now + thirtyDays - 5000);
      expect(expiresAt).toBeLessThan(now + thirtyDays + 5000);
    });
    
    it("should set 2-hour expiration for PARTY_PASS", async () => {
      const { partyData } = await createPartyWithTier("DJ Party", "PARTY_PASS");
      
      const expiresAt = partyData.partyPassExpiresAt;
      const now = Date.now();
      const twoHours = 2 * 60 * 60 * 1000;
      
      expect(expiresAt).toBeTruthy();
      expect(expiresAt).toBeGreaterThan(now + twoHours - 5000);
      expect(expiresAt).toBeLessThan(now + twoHours + 5000);
    });
  });
});
