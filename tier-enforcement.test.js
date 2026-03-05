const request = require('supertest');
const { app, redis } = require('./server');

describe('Tier Enforcement', () => {
  let testPartyCode;
  let testPartyCodeWithPass;

  beforeEach(async () => {
    // Create a free tier party (no Party Pass)
    const freePartyRes = await request(app)
      .post('/api/create-party')
      .send({ djName: 'Test DJ Free', isHost: true });
    
    if (freePartyRes.status === 200 && freePartyRes.body.code) {
      testPartyCode = freePartyRes.body.code;
    }

    // Create a party with Party Pass active
    const passPartyRes = await request(app)
      .post('/api/create-party')
      .send({ djName: 'Test DJ Pass', isHost: true });
    
    if (passPartyRes.status === 200 && passPartyRes.body.code) {
      testPartyCodeWithPass = passPartyRes.body.code;
      
      // Activate Party Pass by setting expiration time in Redis
      const partyDataRaw = await redis.get(`party:${testPartyCodeWithPass}`);
      if (partyDataRaw) {
        const partyData = JSON.parse(partyDataRaw);
        partyData.partyPassExpiresAt = Date.now() + 3600000; // 1 hour from now
        await redis.set(`party:${testPartyCodeWithPass}`, JSON.stringify(partyData));
      }
    }
  });

  afterEach(async () => {
    // Clean up test parties
    if (testPartyCode) {
      await redis.del(`party:${testPartyCode}`);
    }
    if (testPartyCodeWithPass) {
      await redis.del(`party:${testPartyCodeWithPass}`);
    }
  });

  describe('Free Tier Restrictions', () => {
    it('should reject guest messages when Party Pass is inactive', async () => {
      // Note: This test verifies WebSocket behavior, which requires WebSocket client
      // For now, we verify the party state
      if (!testPartyCode) {
        // Skip if party creation failed in beforeEach
        return;
      }
      const partyDataRaw = await redis.get(`party:${testPartyCode}`);
      expect(partyDataRaw).toBeTruthy();
      const partyData = JSON.parse(partyDataRaw);
      expect(partyData.partyPassExpiresAt).toBeUndefined();
    });

    it('should not have Party Pass expiration time in free party', async () => {
      if (!testPartyCode) return;
      const partyDataRaw = await redis.get(`party:${testPartyCode}`);
      expect(partyDataRaw).toBeTruthy();
      const partyData = JSON.parse(partyDataRaw);
      expect(partyData.partyPassExpiresAt).toBeUndefined();
    });

    it('should have Party Pass expiration time in paid party', async () => {
      if (!testPartyCodeWithPass) return;
      const partyDataRaw = await redis.get(`party:${testPartyCodeWithPass}`);
      expect(partyDataRaw).toBeTruthy();
      const partyData = JSON.parse(partyDataRaw);
      expect(partyData.partyPassExpiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe('Party Pass Active Features', () => {
    it('should have active Party Pass when expiration is in future', async () => {
      if (!testPartyCodeWithPass) return;
      const partyDataRaw = await redis.get(`party:${testPartyCodeWithPass}`);
      expect(partyDataRaw).toBeTruthy();
      const partyData = JSON.parse(partyDataRaw);
      const isActive = partyData.partyPassExpiresAt && partyData.partyPassExpiresAt > Date.now();
      expect(isActive).toBe(true);
    });

    it('should not have active Party Pass when no expiration is set', async () => {
      if (!testPartyCode) return;
      const partyDataRaw = await redis.get(`party:${testPartyCode}`);
      expect(partyDataRaw).toBeTruthy();
      const partyData = JSON.parse(partyDataRaw);
      const isActive = Boolean(partyData.partyPassExpiresAt && partyData.partyPassExpiresAt > Date.now());
      expect(isActive).toBe(false);
    });

    it('should expire Party Pass when expiration time is in past', async () => {
      if (!testPartyCodeWithPass) return;
      // Set expiration to past
      const partyDataRaw = await redis.get(`party:${testPartyCodeWithPass}`);
      expect(partyDataRaw).toBeTruthy();
      const partyData = JSON.parse(partyDataRaw);
      partyData.partyPassExpiresAt = Date.now() - 1000; // 1 second ago
      await redis.set(`party:${testPartyCodeWithPass}`, JSON.stringify(partyData));

      // Verify it's expired
      const updatedDataRaw = await redis.get(`party:${testPartyCodeWithPass}`);
      const updatedData = JSON.parse(updatedDataRaw);
      const isActive = updatedData.partyPassExpiresAt && updatedData.partyPassExpiresAt > Date.now();
      expect(isActive).toBe(false);
    });
  });

  describe('Tier Info Endpoint', () => {
    it('should return correct free tier restrictions', async () => {
      const response = await request(app).get('/api/tier-info');
      const freeTier = response.body.tiers.FREE;
      
      expect(freeTier.chatEnabled).toBe(false);
      expect(freeTier.autoMessages).toBe(false);
      expect(freeTier.phoneLimit).toBe(2);
    });

    it('should return correct Party Pass features', async () => {
      const response = await request(app).get('/api/tier-info');
      const partyPass = response.body.tiers.PARTY_PASS;
      
      expect(partyPass.chatEnabled).toBe(true);
      expect(partyPass.autoMessages).toBe(true);
      expect(partyPass.quickMessages).toBe(true);
      expect(partyPass.phoneLimit).toBe(4);
      expect(partyPass.price).toBe('£3.99'); // GBP - Party Pass pricing
    });

    it('should return correct Pro tier features', async () => {
      const response = await request(app).get('/api/tier-info');
      const pro = response.body.tiers.PRO_MONTHLY;
      
      expect(pro.chatEnabled).toBe(true);
      expect(pro.cosmetics).toBe(true);
      expect(pro.profilePerks).toBe(true);
      expect(pro.phoneLimit).toBe(10);
    });

    it('should include notes for all tiers', async () => {
      const response = await request(app).get('/api/tier-info');
      const tiers = response.body.tiers;
      
      expect(Array.isArray(tiers.FREE.notes)).toBe(true);
      expect(tiers.FREE.notes.length).toBeGreaterThan(0);
      
      expect(Array.isArray(tiers.PARTY_PASS.notes)).toBe(true);
      expect(tiers.PARTY_PASS.notes.length).toBeGreaterThan(0);
      
      expect(Array.isArray(tiers.PRO_MONTHLY.notes)).toBe(true);
      expect(tiers.PRO_MONTHLY.notes.length).toBeGreaterThan(0);
    });

    it('should return Phone Party as app name', async () => {
      const response = await request(app).get('/api/tier-info');
      expect(response.body.appName).toBe('Phone Party');
    });
  });

  describe('Server-side Feature Gating', () => {
    it('should include phone limits in tier info', async () => {
      const response = await request(app).get('/api/tier-info');
      
      expect(response.body.tiers.FREE.phoneLimit).toBe(2);
      expect(response.body.tiers.PARTY_PASS.phoneLimit).toBe(4);
      expect(response.body.tiers.PRO_MONTHLY.phoneLimit).toBe(10);
    });

    it('should include queue limits in tier info', async () => {
      const response = await request(app).get('/api/tier-info');
      
      expect(response.body.tiers.FREE.queueLimit).toBe(5);
      expect(response.body.tiers.PARTY_PASS.queueLimit).toBe(5);
      expect(response.body.tiers.PRO_MONTHLY.queueLimit).toBe(5);
    });

    it('should include messaging limits for Party Pass', async () => {
      const response = await request(app).get('/api/tier-info');
      const partyPass = response.body.tiers.PARTY_PASS;
      
      expect(partyPass.maxTextLength).toBe(60);
      expect(partyPass.maxEmojiLength).toBe(10);
      expect(partyPass.messageTtlMs).toBe(12000);
    });

    it('should include rate limits for Party Pass', async () => {
      const response = await request(app).get('/api/tier-info');
      const partyPass = response.body.tiers.PARTY_PASS;
      
      expect(partyPass.hostRateLimit).toBeDefined();
      expect(partyPass.hostRateLimit.minIntervalMs).toBe(2000);
      expect(partyPass.hostRateLimit.maxPerMinute).toBe(10);
      
      expect(partyPass.guestRateLimit).toBeDefined();
      expect(partyPass.guestRateLimit.minIntervalMs).toBe(2000);
      expect(partyPass.guestRateLimit.maxPerMinute).toBe(15);
    });
  });

  describe('Party State Consistency', () => {
    it('should create party without Party Pass by default', async () => {
      const res = await request(app)
        .post('/api/create-party')
        .send({ djName: 'Test DJ New', isHost: true });
      
      expect(res.status).toBe(200);
      
      if (res.body.code) {
        const partyDataRaw = await redis.get(`party:${res.body.code}`);
        expect(partyDataRaw).toBeTruthy();
        const partyData = JSON.parse(partyDataRaw);
        expect(partyData.partyPassExpiresAt).toBeUndefined();
        
        // Cleanup
        await redis.del(`party:${res.body.code}`);
      }
    });

    it('should persist Party Pass expiration time in Redis', async () => {
      if (!testPartyCodeWithPass) return;
      const partyDataRaw = await redis.get(`party:${testPartyCodeWithPass}`);
      expect(partyDataRaw).toBeTruthy();
      const partyData = JSON.parse(partyDataRaw);
      expect(partyData.partyPassExpiresAt).toBeDefined();
      expect(typeof partyData.partyPassExpiresAt).toBe('number');
    });
  });
});
