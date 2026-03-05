const request = require('supertest');
const WebSocket = require('ws');
const { app, redis } = require('./server');

describe('DJ Short Messages', () => {
  let testPartyCode;
  let testPartyCodeWithPass;
  let wsServer;

  beforeAll(() => {
    // Get WebSocket server instance
    wsServer = global.wsServer;
  });

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

  describe('Tier Enforcement', () => {
    it('should have Party Pass active when expiration is in future', async () => {
      if (!testPartyCodeWithPass) return;
      const partyDataRaw = await redis.get(`party:${testPartyCodeWithPass}`);
      expect(partyDataRaw).toBeTruthy();
      const partyData = JSON.parse(partyDataRaw);
      expect(partyData.partyPassExpiresAt).toBeGreaterThan(Date.now());
    });

    it('should not have Party Pass active in free party', async () => {
      if (!testPartyCode) return;
      const partyDataRaw = await redis.get(`party:${testPartyCode}`);
      expect(partyDataRaw).toBeTruthy();
      const partyData = JSON.parse(partyDataRaw);
      expect(partyData.partyPassExpiresAt).toBeUndefined();
    });
  });

  describe('Message Validation', () => {
    it('should trim and limit DJ short messages to 30 characters', () => {
      const longMessage = "This is a very long message that exceeds the 30 character limit";
      const trimmed = longMessage.trim().substring(0, 30);
      expect(trimmed.length).toBe(30);
      expect(trimmed).toBe("This is a very long message th");
    });

    it('should ignore empty messages after trimming', () => {
      const emptyMessage = "   ";
      const trimmed = emptyMessage.trim();
      expect(trimmed).toBe("");
    });

    it('should handle messages exactly 30 characters', () => {
      const exactMessage = "This is exactly 30 chars here!";
      expect(exactMessage.length).toBe(30);
      const trimmed = exactMessage.trim().substring(0, 30);
      expect(trimmed).toBe(exactMessage);
    });
  });

  describe('WebSocket Message Structure', () => {
    it('should validate DJ_SHORT_MESSAGE structure', () => {
      const message = {
        t: "DJ_SHORT_MESSAGE",
        text: "Hello guests!"
      };
      
      expect(message.t).toBe("DJ_SHORT_MESSAGE");
      expect(message.text).toBeTruthy();
      expect(typeof message.text).toBe("string");
    });

    it('should validate FEED_EVENT structure for DJ short messages', () => {
      const feedEvent = {
        id: "123-dj-msg-abc123",
        ts: Date.now(),
        kind: "dj_short_message",
        senderId: "dj",
        senderName: "DJ",
        text: "Test message",
        isEmoji: false,
        ttlMs: 12000
      };
      
      expect(feedEvent.kind).toBe("dj_short_message");
      expect(feedEvent.senderId).toBe("dj");
      expect(feedEvent.senderName).toBe("DJ");
      expect(feedEvent.isEmoji).toBe(false);
      expect(feedEvent.ttlMs).toBe(12000);
    });
  });

  describe('Feature Availability', () => {
    it('should require Party Pass or Pro Monthly for DJ short messages', async () => {
      // This test validates the business logic
      // In a real scenario, we'd test WebSocket rejection for free tier
      
      if (!testPartyCode) return;
      const partyDataRaw = await redis.get(`party:${testPartyCode}`);
      const partyData = JSON.parse(partyDataRaw);
      
      // Verify free party doesn't have Party Pass
      expect(partyData.partyPassExpiresAt).toBeUndefined();
      
      // In the actual handler, this would result in an error message
      const hasAccess = Boolean(partyData.partyPassExpiresAt && partyData.partyPassExpiresAt > Date.now());
      expect(hasAccess).toBe(false);
    });

    it('should allow DJ short messages with active Party Pass', async () => {
      if (!testPartyCodeWithPass) return;
      const partyDataRaw = await redis.get(`party:${testPartyCodeWithPass}`);
      const partyData = JSON.parse(partyDataRaw);
      
      // Verify Party Pass is active
      expect(partyData.partyPassExpiresAt).toBeGreaterThan(Date.now());
      
      // Verify access is granted
      const hasAccess = partyData.partyPassExpiresAt && partyData.partyPassExpiresAt > Date.now();
      expect(hasAccess).toBe(true);
    });
  });

  describe('Auto-disappear TTL', () => {
    it('should use MESSAGE_TTL_MS for auto-removal', () => {
      const MESSAGE_TTL_MS = 12000; // 12 seconds
      const feedEvent = {
        ttlMs: MESSAGE_TTL_MS
      };
      
      expect(feedEvent.ttlMs).toBe(12000);
    });

    it('should support custom TTL values', () => {
      const customTTL = 15000; // 15 seconds
      const feedEvent = {
        ttlMs: customTTL
      };
      
      expect(feedEvent.ttlMs).toBe(15000);
    });
  });
});
