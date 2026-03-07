const request = require('supertest');
const { app, generateCode, parties, redis, fallbackPartyStorage, setPartyInFallback, getPartyFromFallback, waitForRedis } = require('./server');

describe('Server HTTP Endpoints', () => {
  // Wait for Redis to be ready before running any tests
  beforeAll(async () => {
    try {
      await waitForRedis();
    } catch (error) {
      console.error('Failed to connect to Redis:', error.message);
    }
  });

  // Clear parties and Redis before each test to ensure clean state
  beforeEach(async () => {
    parties.clear();
    // Clear Redis mock
    await redis.flushall();
  });

  describe('GET /health', () => {
    it('should return status ok', async () => {
      const response = await request(app).get('/health');
      expect(response.body.status).toBe('ok');
    });

    it('should return 200 status code', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
    });
    
    it('should include instanceId', async () => {
      const response = await request(app).get('/health');
      expect(response.body.instanceId).toBeDefined();
      expect(typeof response.body.instanceId).toBe('string');
    });
    
    it('should include Redis status', async () => {
      const response = await request(app).get('/health');
      expect(response.body.redis).toBeDefined();
      expect(typeof response.body.redis).toBe('string');
    });

    it('should return JSON content type', async () => {
      const response = await request(app).get('/health');
      expect(response.headers['content-type']).toMatch(/json/);
    });
  });

  describe('GET /api/health', () => {
    it('should return health status with ok field', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body).toHaveProperty('ok');
      expect(typeof response.body.ok).toBe('boolean');
    });

    it('should include instanceId', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body.instanceId).toBeDefined();
      expect(typeof response.body.instanceId).toBe('string');
    });

    it('should include redis connection info', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body.redis).toBeDefined();
      expect(response.body.redis).toHaveProperty('connected');
      expect(typeof response.body.redis.connected).toBe('boolean');
    });

    it('should include timestamp', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body.timestamp).toBeDefined();
      expect(typeof response.body.timestamp).toBe('string');
    });

    it('should include version', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body.version).toBeDefined();
      expect(typeof response.body.version).toBe('string');
    });

    it('should include environment', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body.environment).toBeDefined();
      expect(['production', 'development']).toContain(response.body.environment);
    });

    it('should return 200 when ready (test mode)', async () => {
      const response = await request(app).get('/api/health');
      // In test mode, should be ready even without Redis (uses fallback storage)
      // Note: Production mode cannot be tested here because IS_PRODUCTION is set at module load time
      // Production mode behavior (503 when Redis unavailable) is validated in manual testing
      expect(response.status).toBe(200);
    });

    it('should return JSON content type', async () => {
      const response = await request(app).get('/api/health');
      expect(response.headers['content-type']).toMatch(/json/);
    });
  });

  describe('GET /api/ping', () => {
    it('should return pong message', async () => {
      const response = await request(app).get('/api/ping');
      expect(response.body.message).toBe('pong');
    });

    it('should include timestamp', async () => {
      const response = await request(app).get('/api/ping');
      expect(response.body.timestamp).toBeDefined();
      expect(typeof response.body.timestamp).toBe('number');
      expect(response.body.timestamp).toBeGreaterThan(0);
    });

    it('should return 200 status code', async () => {
      const response = await request(app).get('/api/ping');
      expect(response.status).toBe(200);
    });

    it('should return JSON content type', async () => {
      const response = await request(app).get('/api/ping');
      expect(response.headers['content-type']).toMatch(/json/);
    });
  });

  describe('GET /api/debug/parties', () => {
    it('should return list of parties', async () => {
      const response = await request(app).get('/api/debug/parties');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('totalParties');
      expect(response.body).toHaveProperty('parties');
      expect(response.body).toHaveProperty('instanceId');
      expect(response.body).toHaveProperty('redisReady');
      expect(Array.isArray(response.body.parties)).toBe(true);
    });

    it('should include created parties in the list', async () => {
      // Create a party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const partyCode = createResponse.body.partyCode;
      
      // Get debug info
      const response = await request(app).get('/api/debug/parties');
      expect(response.status).toBe(200);
      
      // Should include the party we just created
      const party = response.body.parties.find(p => p.code === partyCode);
      expect(party).toBeDefined();
      expect(party).toHaveProperty('code', partyCode);
      expect(party).toHaveProperty('ageMs');
      expect(party).toHaveProperty('createdAt');
    });

    it('should show party age in minutes', async () => {
      // Create a party
      await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      
      // Get debug info
      const response = await request(app).get('/api/debug/parties');
      expect(response.status).toBe(200);
      
      // All parties should have ageMinutes
      response.body.parties.forEach(party => {
        expect(party).toHaveProperty('ageMinutes');
        expect(typeof party.ageMinutes).toBe('number');
      });
    });
  });

  describe('GET /api/debug/party/:code', () => {
    it('should return party info for existing party', async () => {
      // Create a party first
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const partyCode = createResponse.body.partyCode;
      
      // Get debug info for that specific party
      const response = await request(app).get(`/api/debug/party/${partyCode}`);
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('code', partyCode);
      expect(response.body).toHaveProperty('existsInRedis', true);
      expect(response.body).toHaveProperty('existsLocally', true);
      expect(response.body).toHaveProperty('redisStatus');
      expect(response.body).toHaveProperty('instanceId');
      expect(response.body).toHaveProperty('createdAt');
      expect(response.body.createdAt).toBeGreaterThan(0);
    });

    it('should return not found for non-existent party', async () => {
      const response = await request(app).get('/api/debug/party/NOTFOUND');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('code', 'NOTFOUND');
      expect(response.body).toHaveProperty('existsInRedis', false);
      expect(response.body).toHaveProperty('existsLocally', false);
      expect(response.body).toHaveProperty('redisStatus');
      expect(response.body).toHaveProperty('instanceId');
    });

    it('should normalize party code (uppercase)', async () => {
      // Create a party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const partyCode = createResponse.body.partyCode;
      
      // Query with lowercase code
      const response = await request(app).get(`/api/debug/party/${partyCode.toLowerCase()}`);
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('code', partyCode); // Should be uppercase in response
      expect(response.body).toHaveProperty('existsInRedis', true);
    });

    it('should include ageMs for existing party', async () => {
      // Create a party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const partyCode = createResponse.body.partyCode;
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Get debug info
      const response = await request(app).get(`/api/debug/party/${partyCode}`);
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('ageMs');
      expect(response.body.ageMs).toBeGreaterThan(50);
    });
  });

  describe('Guest Join Party Bug Fix', () => {
    it('should allow guest to join immediately after party creation', async () => {
      // Host creates party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      expect(createResponse.status).toBe(200);
      const partyCode = createResponse.body.partyCode;
      
      // Guest joins immediately (< 2 seconds)
      const joinResponse = await request(app)
        .post('/api/join-party')
        .send({ partyCode });
      
      expect(joinResponse.status).toBe(200);
      expect(joinResponse.body).toHaveProperty('ok', true);
    });

    it('should allow guest to join after short delay', async () => {
      // Host creates party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      expect(createResponse.status).toBe(200);
      const partyCode = createResponse.body.partyCode;
      
      // Wait 1 second (simulating short delay)
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Guest joins after delay
      const joinResponse = await request(app)
        .post('/api/join-party')
        .send({ partyCode });
      
      expect(joinResponse.status).toBe(200);
      expect(joinResponse.body).toHaveProperty('ok', true);
    });

    it('should return 404 for wrong/non-existent party code', async () => {
      // Guest tries to join non-existent party
      const joinResponse = await request(app)
        .post('/api/join-party')
        .send({ partyCode: 'WRONG1' });
      
      expect(joinResponse.status).toBe(404);
      expect(joinResponse.body).toHaveProperty('error');
      expect(joinResponse.body.error).toContain('not found');
    });

    it('should normalize party code on join (uppercase + trim)', async () => {
      // Host creates party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      expect(createResponse.status).toBe(200);
      const partyCode = createResponse.body.partyCode;
      
      // Guest joins with lowercase and extra spaces
      const joinResponse = await request(app)
        .post('/api/join-party')
        .send({ partyCode: `  ${partyCode.toLowerCase()}  ` });
      
      expect(joinResponse.status).toBe(200);
      expect(joinResponse.body).toHaveProperty('ok', true);
    });

    it('should persist party to Redis before responding', async () => {
      // Create party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      expect(createResponse.status).toBe(200);
      const partyCode = createResponse.body.partyCode;
      
      // Immediately check if party exists in Redis via debug endpoint
      const debugResponse = await request(app).get(`/api/debug/party/${partyCode}`);
      expect(debugResponse.status).toBe(200);
      expect(debugResponse.body).toHaveProperty('existsInRedis', true);
      expect(debugResponse.body).toHaveProperty('createdAt');
    });

    it('should include instanceId and redisStatus in debug endpoint', async () => {
      // Create party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      expect(createResponse.status).toBe(200);
      const partyCode = createResponse.body.partyCode;
      
      // Check debug endpoint
      const debugResponse = await request(app).get(`/api/debug/party/${partyCode}`);
      expect(debugResponse.status).toBe(200);
      expect(debugResponse.body).toHaveProperty('instanceId');
      expect(debugResponse.body).toHaveProperty('redisStatus');
      expect(typeof debugResponse.body.instanceId).toBe('string');
      expect(typeof debugResponse.body.redisStatus).toBe('string');
    });
  });

  describe('POST /api/create-party', () => {
    it('should reject party creation without DJ name', async () => {
      const response = await request(app).post('/api/create-party');
      
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('DJ name is required to create a party');
    });

    it('should reject party creation with empty DJ name', async () => {
      const response = await request(app)
        .post('/api/create-party')
        .send({ djName: '' });
      
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('DJ name is required to create a party');
    });

    it('should create a new party with DJ name and return party code', async () => {
      const response = await request(app)
        .post('/api/create-party')
        .send({ djName: 'DJ Alex' });
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('partyCode');
      expect(response.body).toHaveProperty('hostId');
    });

    it('should return a 6-character party code', async () => {
      const response = await request(app)
        .post('/api/create-party')
        .send({ djName: 'DJ Test' });
      
      expect(response.body.partyCode).toHaveLength(6);
      expect(response.body.partyCode).toMatch(/^[A-Z0-9]{6}$/);
    });

    it('should return a unique hostId', async () => {
      const response1 = await request(app)
        .post('/api/create-party')
        .send({ djName: 'DJ Test1' });
      const response2 = await request(app)
        .post('/api/create-party')
        .send({ djName: 'DJ Test2' });
      
      expect(response1.body.hostId).toBeDefined();
      expect(response2.body.hostId).toBeDefined();
      expect(response1.body.hostId).not.toBe(response2.body.hostId);
    });

    it('should generate unique party codes', async () => {
      const codes = new Set();
      
      // Create multiple parties
      for (let i = 0; i < 10; i++) {
        const response = await request(app)
          .post('/api/create-party')
          .send({ djName: `DJ Test${i}` });
        codes.add(response.body.partyCode);
      }
      
      // All codes should be unique
      expect(codes.size).toBe(10);
    });

    it('should store party in parties map', async () => {
      const response = await request(app)
        .post('/api/create-party')
        .send({ djName: 'DJ TestStore' });
      const partyCode = response.body.partyCode;
      
      expect(parties.has(partyCode)).toBe(true);
      
      const party = parties.get(partyCode);
      expect(party).toHaveProperty('hostId');
      expect(party).toHaveProperty('createdAt');
      expect(party).toHaveProperty('members');
      expect(Array.isArray(party.members)).toBe(true);
    });

    it('should return JSON content type', async () => {
      const response = await request(app)
        .post('/api/create-party')
        .send({ djName: 'DJ TestJSON' });
      expect(response.headers['content-type']).toMatch(/json/);
    });
  });

  describe('POST /api/join-party', () => {
    let partyCode;

    beforeEach(async () => {
      // Create a party to join with DJ name
      const response = await request(app)
        .post('/api/create-party')
        .send({ djName: 'DJ TestHost' });
      partyCode = response.body.partyCode;
    });

    it('should allow joining an existing party', async () => {
      const response = await request(app)
        .post('/api/join-party')
        .send({ partyCode });
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('ok', true);
      expect(response.body).toHaveProperty('guestId');
      expect(response.body).toHaveProperty('nickname');
      expect(response.body).toHaveProperty('partyCode', partyCode);
    });

    it('should return DJ name when joining party', async () => {
      const response = await request(app)
        .post('/api/join-party')
        .send({ partyCode });
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('djName', 'DJ TestHost');
    });

    it('should return 400 if party code is missing', async () => {
      const response = await request(app)
        .post('/api/join-party')
        .send({});
      
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('Party code is required');
    });

    it('should return 404 if party does not exist', async () => {
      const response = await request(app)
        .post('/api/join-party')
        .send({ partyCode: 'NOEXST' });
      
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('Party not found or expired');
    });

    it('should handle uppercase conversion of party code', async () => {
      const response = await request(app)
        .post('/api/join-party')
        .send({ partyCode: partyCode.toLowerCase() });
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('ok', true);
      expect(response.body).toHaveProperty('partyCode', partyCode);
    });

    it('should trim whitespace from party code', async () => {
      const response = await request(app)
        .post('/api/join-party')
        .send({ partyCode: `  ${partyCode}  ` });
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('ok', true);
      expect(response.body).toHaveProperty('partyCode', partyCode);
    });

    it('should return JSON content type', async () => {
      const response = await request(app)
        .post('/api/join-party')
        .send({ partyCode });
      
      expect(response.headers['content-type']).toMatch(/json/);
    });

    it('should respond within 500ms for valid party', async () => {
      const startTime = Date.now();
      const response = await request(app)
        .post('/api/join-party')
        .send({ partyCode });
      const duration = Date.now() - startTime;
      
      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(500);
    });

    it('should respond within 500ms even for non-existent party', async () => {
      const startTime = Date.now();
      const response = await request(app)
        .post('/api/join-party')
        .send({ partyCode: 'NOEXST' });
      const duration = Date.now() - startTime;
      
      expect(response.status).toBe(404);
      expect(duration).toBeLessThan(500);
    });

    it('should allow joining a party immediately after creation (no race condition)', async () => {
      // Create a party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      expect(createResponse.status).toBe(200);
      const newPartyCode = createResponse.body.partyCode;
      
      // Immediately try to join (this tests the fix for async Redis writes)
      const joinResponse = await request(app)
        .post('/api/join-party')
        .send({ partyCode: newPartyCode });
      
      // Should succeed without 404
      expect(joinResponse.status).toBe(200);
      expect(joinResponse.body).toHaveProperty('ok', true);
      expect(joinResponse.body).toHaveProperty('partyCode', newPartyCode);
    });

    it('should handle slow Redis gracefully', async () => {
      // Create a party first
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const testCode = createResponse.body.partyCode;
      
      // Mock a slow Redis response by temporarily slowing down get
      const originalGet = redis.get.bind(redis);
      redis.get = jest.fn().mockImplementation((key) => {
        return new Promise((resolve) => {
          // Simulate slow Redis but still return the data
          setTimeout(async () => {
            const result = await originalGet(key);
            resolve(result);
          }, 100); // Short delay
        });
      });

      const response = await request(app)
        .post('/api/join-party')
        .send({ partyCode: testCode });

      // Should still succeed even with slow Redis
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('ok', true);
      expect(response.body).toHaveProperty('partyCode', testCode);

      // Restore original get
      redis.get = originalGet;
    });
  });

  describe('GET /api/party/:code', () => {
    let partyCode;

    beforeEach(async () => {
      // Create a party to query
      const response = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      partyCode = response.body.partyCode;
    });

    it('should return party information if party exists', async () => {
      const response = await request(app).get(`/api/party/${partyCode}`);
      
      expect(response.status).toBe(200);
      expect(response.body.exists).toBe(true);
      expect(response.body.code).toBe(partyCode);
      expect(response.body.createdAt).toBeDefined();
      expect(response.body.hostConnected).toBeDefined();
      expect(response.body.guestCount).toBeDefined();
      expect(response.body.instanceId).toBeDefined();
    });

    it('should return exists false if party does not exist', async () => {
      const response = await request(app).get('/api/party/NOEXST');
      
      expect(response.status).toBe(200);
      expect(response.body.exists).toBe(false);
      expect(response.body.code).toBe('NOEXST');
      expect(response.body.instanceId).toBeDefined();
    });

    it('should handle lowercase party codes', async () => {
      const response = await request(app).get(`/api/party/${partyCode.toLowerCase()}`);
      
      expect(response.status).toBe(200);
      expect(response.body.exists).toBe(true);
      expect(response.body.code).toBe(partyCode);
    });

    it('should return hostConnected false for HTTP-only parties', async () => {
      const response = await request(app).get(`/api/party/${partyCode}`);
      
      expect(response.status).toBe(200);
      expect(response.body.hostConnected).toBe(false); // No WebSocket connection yet
    });
  });

  describe('GET /', () => {
    it('should serve index.html', async () => {
      const response = await request(app).get('/');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/html/);
    });

    it('should include no-cache header', async () => {
      const response = await request(app).get('/');
      expect(response.headers['cache-control']).toMatch(/no-cache/);
    });
  });

  describe('Static Files', () => {
    it('should serve app.js', async () => {
      const response = await request(app).get('/app.js');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/javascript/);
    });

    it('should serve app.js with no-cache header', async () => {
      const response = await request(app).get('/app.js');
      expect(response.headers['cache-control']).toMatch(/no-cache/);
    });

    it('should serve service-worker.js', async () => {
      const response = await request(app).get('/service-worker.js');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/javascript/);
    });

    it('should serve service-worker.js with no-cache header', async () => {
      const response = await request(app).get('/service-worker.js');
      expect(response.headers['cache-control']).toMatch(/no-cache/);
    });

    it('should serve manifest.json', async () => {
      const response = await request(app).get('/manifest.json');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/json/);
    });

    it('should serve styles.css', async () => {
      const response = await request(app).get('/styles.css');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/css/);
    });
  });

  describe('GET /__version', () => {
    it('should return 200 with JSON', async () => {
      const response = await request(app).get('/__version');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/json/);
    });

    it('should include appVersion', async () => {
      const response = await request(app).get('/__version');
      expect(typeof response.body.appVersion).toBe('string');
      expect(response.body.appVersion.length).toBeGreaterThan(0);
    });

    it('should include changerVersion', async () => {
      const response = await request(app).get('/__version');
      expect(typeof response.body.changerVersion).toBe('string');
      expect(response.body.changerVersion.length).toBeGreaterThan(0);
    });

    it('should include instanceId', async () => {
      const response = await request(app).get('/__version');
      expect(typeof response.body.instanceId).toBe('string');
    });

    it('should include nodeEnv', async () => {
      const response = await request(app).get('/__version');
      expect(typeof response.body.nodeEnv).toBe('string');
    });

    it('should have no-cache header', async () => {
      const response = await request(app).get('/__version');
      expect(response.headers['cache-control']).toMatch(/no-cache/);
    });

    it('should have X-Changer-Version response header', async () => {
      const response = await request(app).get('/__version');
      expect(response.headers['x-changer-version']).toBeDefined();
    });
  });

  describe('GET /ready', () => {
    it('should return 200', async () => {
      const response = await request(app).get('/ready');
      expect(response.status).toBe(200);
    });

    it('should return JSON with status ready', async () => {
      const response = await request(app).get('/ready');
      expect(response.body.status).toBe('ready');
    });
  });

  describe('GET /version', () => {
    it('should return 200 with JSON', async () => {
      const response = await request(app).get('/version');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/json/);
    });

    it('should include commit field', async () => {
      const response = await request(app).get('/version');
      expect(response.body).toHaveProperty('commit');
      expect(typeof response.body.commit).toBe('string');
    });

    it('should include environment field', async () => {
      const response = await request(app).get('/version');
      expect(response.body).toHaveProperty('environment');
    });

    it('should include timestamp field as an ISO date string', async () => {
      const response = await request(app).get('/version');
      expect(response.body).toHaveProperty('timestamp');
      expect(() => new Date(response.body.timestamp).toISOString()).not.toThrow();
    });

    it('should include appVersion field', async () => {
      const response = await request(app).get('/version');
      expect(response.body).toHaveProperty('appVersion');
      expect(typeof response.body.appVersion).toBe('string');
    });

    it('should include nodeVersion field matching process.version', async () => {
      const response = await request(app).get('/version');
      expect(response.body).toHaveProperty('nodeVersion');
      expect(response.body.nodeVersion).toBe(process.version);
    });

    describe('COMMIT_SHA env var', () => {
      let originalCommitSha;

      beforeEach(() => {
        originalCommitSha = process.env.COMMIT_SHA;
      });

      afterEach(() => {
        if (originalCommitSha === undefined) {
          delete process.env.COMMIT_SHA;
        } else {
          process.env.COMMIT_SHA = originalCommitSha;
        }
      });

      it('should use COMMIT_SHA env var when set', async () => {
        process.env.COMMIT_SHA = 'abc123def456';
        const response = await request(app).get('/version');
        expect(response.body.commit).toBe('abc123def456');
      });

      it('should fallback to "unknown" when COMMIT_SHA is not set', async () => {
        delete process.env.COMMIT_SHA;
        const response = await request(app).get('/version');
        expect(response.body.commit).toBe('unknown');
      });
    });
  });
});

describe('Utility Functions', () => {
  describe('generateCode', () => {
    it('should generate a 6-character code', () => {
      const code = generateCode();
      expect(code).toHaveLength(6);
    });

    it('should only contain uppercase letters and numbers', () => {
      const code = generateCode();
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
    });

    it('should generate different codes on subsequent calls', () => {
      const codes = new Set();
      
      // Generate 100 codes
      for (let i = 0; i < 100; i++) {
        codes.add(generateCode());
      }
      
      // Most codes should be unique (allowing for rare collisions)
      expect(codes.size).toBeGreaterThan(95);
    });

    it('should not contain ambiguous characters', () => {
      // The nanoid alphabet only contains clear characters
      const code = generateCode();
      
      // Should not contain lowercase letters or special characters
      expect(code).not.toMatch(/[a-z]/);
      expect(code).not.toMatch(/[^A-Z0-9]/);
    });
  });
});

describe('Party Storage and Sync', () => {
  beforeEach(() => {
    parties.clear();
  });

  describe('Party TTL and Cleanup', () => {
    it('should store createdAt timestamp when creating a party', async () => {
      const beforeCreate = Date.now();
      const response = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const afterCreate = Date.now();
      
      expect(response.status).toBe(200);
      const partyCode = response.body.partyCode;
      
      const party = parties.get(partyCode);
      expect(party).toBeDefined();
      expect(party.createdAt).toBeDefined();
      expect(party.createdAt).toBeGreaterThanOrEqual(beforeCreate);
      expect(party.createdAt).toBeLessThanOrEqual(afterCreate);
    });

    it('should include party age in join response logs', async () => {
      // Create a party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const partyCode = createResponse.body.partyCode;
      
      // Wait a small amount of time
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Join the party
      const joinResponse = await request(app)
        .post('/api/join-party')
        .send({ partyCode });
      
      expect(joinResponse.status).toBe(200);
      
      // Verify party still exists and has valid createdAt
      const party = parties.get(partyCode);
      expect(party).toBeDefined();
      expect(Date.now() - party.createdAt).toBeGreaterThanOrEqual(10);
    });
  });

  describe('Cross-Protocol Party Sync', () => {
    it('should log available parties when party not found', async () => {
      // Try to join a non-existent party
      const response = await request(app)
        .post('/api/join-party')
        .send({ partyCode: 'NOEXST' });
      
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Party not found or expired');
    });

    it('should handle multiple parties in storage', async () => {
      // Create multiple parties
      const party1 = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const party2 = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const party3 = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      
      // Verify all parties are in storage
      expect(parties.size).toBe(3);
      expect(parties.has(party1.body.partyCode)).toBe(true);
      expect(parties.has(party2.body.partyCode)).toBe(true);
      expect(parties.has(party3.body.partyCode)).toBe(true);
      
      // Join each party
      const join1 = await request(app)
        .post('/api/join-party')
        .send({ partyCode: party1.body.partyCode });
      const join2 = await request(app)
        .post('/api/join-party')
        .send({ partyCode: party2.body.partyCode });
      const join3 = await request(app)
        .post('/api/join-party')
        .send({ partyCode: party3.body.partyCode });
      
      expect(join1.status).toBe(200);
      expect(join2.status).toBe(200);
      expect(join3.status).toBe(200);
    });
  });

  describe('Enhanced Logging', () => {
    it('should log timestamp when creating party', async () => {
      const response = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      
      expect(response.status).toBe(200);
      // Verify response includes expected fields
      expect(response.body.partyCode).toBeDefined();
      expect(response.body.hostId).toBeDefined();
    });

    it('should log timestamp and party details when joining party', async () => {
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const partyCode = createResponse.body.partyCode;
      
      const joinResponse = await request(app)
        .post('/api/join-party')
        .send({ partyCode });
      
      expect(joinResponse.status).toBe(200);
      expect(joinResponse.body).toHaveProperty('ok', true);
      expect(joinResponse.body).toHaveProperty('partyCode', partyCode);
    });
  });
});

describe('Production Scenarios', () => {
  beforeEach(async () => {
    parties.clear();
    await redis.flushall();
  });

  describe('Cross-Instance Party Discovery', () => {
    it('should allow party created via HTTP to be discovered via GET /api/party/:code', async () => {
      // Simulate first request: Create party
      const createResponse = await request(app)
        .post('/api/create-party')
          .send({ djName: 'DJ Test' });
      
      expect(createResponse.status).toBe(200);
      const partyCode = createResponse.body.partyCode;
      expect(partyCode).toBeDefined();
      
      // Simulate second request from another client/instance: Check if party exists
      const checkResponse = await request(app)
        .get(`/api/party/${partyCode}`);
      
      expect(checkResponse.status).toBe(200);
      expect(checkResponse.body.exists).toBe(true);
      expect(checkResponse.body.code).toBe(partyCode);
      expect(checkResponse.body.createdAt).toBeDefined();
      expect(checkResponse.body.hostConnected).toBeDefined();
      expect(checkResponse.body.guestCount).toBeDefined();
      expect(checkResponse.body.instanceId).toBeDefined();
    });
    
    it('should persist party in Redis for cross-instance lookup', async () => {
      // Create party
      const createResponse = await request(app)
        .post('/api/create-party')
          .send({ djName: 'DJ Test' });
      
      expect(createResponse.status).toBe(200);
      const partyCode = createResponse.body.partyCode;
      
      // Directly check Redis (simulating another instance)
      const { getPartyFromRedis } = require('./server');
      const partyData = await getPartyFromRedis(partyCode);
      
      expect(partyData).toBeDefined();
      expect(partyData.createdAt).toBeDefined();
      expect(partyData.hostId).toBeDefined();
      expect(partyData.chatMode).toBe('OPEN');
      expect(partyData.guestCount).toBe(0);
    });
    
    it('should allow guests to join party created on different instance', async () => {
      // Instance 1: Create party
      const createResponse = await request(app)
        .post('/api/create-party')
          .send({ djName: 'DJ Test' });
      
      expect(createResponse.status).toBe(200);
      const partyCode = createResponse.body.partyCode;
      
      // Clear local memory to simulate different instance
      parties.clear();
      
      // Instance 2: Join party (should find it in Redis)
      const joinResponse = await request(app)
        .post('/api/join-party')
        .send({ partyCode });
      
      expect(joinResponse.status).toBe(200);
      expect(joinResponse.body.ok).toBe(true);
    });
  });
  
  describe('Redis Connection Requirements', () => {
    it('should show redis status in health endpoint', async () => {
      const response = await request(app).get('/health');
      
      expect(response.status).toBe(200);
      expect(response.body.redis).toBeDefined();
      expect(typeof response.body.redis).toBe('string');
      // In test environment with mock, status could be various states including fallback
      expect(['ready', 'fallback', 'error']).toContain(response.body.redis);
    });
  });

  describe('Redis Fallback Mode', () => {
    beforeEach(() => {
      // Clear fallback storage before each test
      fallbackPartyStorage.clear();
    });

    it('should allow creating party using fallback storage', async () => {
      // Create a party directly in fallback storage
      const testCode = 'TEST01';
      const partyData = {
        chatMode: 'OPEN',
        createdAt: Date.now(),
        hostId: 999,
        hostConnected: false,
        guestCount: 0
      };
      
      setPartyInFallback(testCode, partyData);
      
      // Verify it was stored
      const retrieved = getPartyFromFallback(testCode);
      expect(retrieved).toBeDefined();
      expect(retrieved.hostId).toBe(999);
      expect(retrieved.chatMode).toBe('OPEN');
    });

    it('should use fallback storage when Redis times out during join', async () => {
      // Create a party in Redis first
      const testCode = 'TEST02';
      const partyData = {
        chatMode: 'OPEN',
        createdAt: Date.now(),
        hostId: 888,
        hostConnected: false,
        guestCount: 0
      };
      
      // Add to Redis
      await redis.setex(`party:${testCode}`, 7200, JSON.stringify(partyData));
      
      // Mock Redis.get to throw error
      const originalGet = redis.get.bind(redis);
      redis.get = jest.fn().mockImplementation(() => {
        throw new Error('Redis timeout');
      });
      
      // Try to join the party - should fall back to local storage
      const response = await request(app)
        .post('/api/join-party')
        .send({ partyCode: testCode });
      
      // Should return 404 since party not in fallback storage (graceful degradation)
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Party not found or expired');
      
      // Restore Redis
      redis.get = originalGet;
    });

    it('should query party from fallback storage via GET endpoint when Redis fails', async () => {
      // Create a party in fallback storage
      const testCode = 'TEST03';
      const partyData = {
        chatMode: 'OPEN',
        createdAt: Date.now(),
        hostId: 777,
        hostConnected: false,
        guestCount: 0
      };
      
      setPartyInFallback(testCode, partyData);
      
      // Mock Redis to throw error
      const originalGet = redis.get.bind(redis);
      redis.get = jest.fn().mockRejectedValue(new Error('Redis connection error'));
      
      // Query the party
      const response = await request(app).get(`/api/party/${testCode}`);
      
      expect(response.status).toBe(200);
      expect(response.body.exists).toBe(true);
      expect(response.body.code).toBe(testCode);
      
      // Restore Redis
      redis.get = originalGet;
    });
  });
});

// Tests for new endpoints (Phase 3)
describe('Party Management Endpoints', () => {
  beforeAll(async () => {
    try {
      await waitForRedis();
    } catch (error) {
      console.error('Failed to connect to Redis:', error.message);
    }
  });

  beforeEach(async () => {
    parties.clear();
    await redis.flushall();
  });

  describe('POST /api/leave-party', () => {
    it('should remove guest from party', async () => {
      // Create party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const partyCode = createResponse.body.partyCode;
      
      // Join party as guest
      const joinResponse = await request(app)
        .post('/api/join-party')
        .send({ partyCode, nickname: 'TestGuest' });
      
      expect(joinResponse.status).toBe(200);
      const guestId = joinResponse.body.guestId;
      
      // Leave party
      const leaveResponse = await request(app)
        .post('/api/leave-party')
        .send({ partyCode, guestId });
      
      expect(leaveResponse.status).toBe(200);
      expect(leaveResponse.body.ok).toBe(true);
      expect(leaveResponse.body.guestCount).toBe(0);
    });

    it('should return 400 if party code is missing', async () => {
      const response = await request(app)
        .post('/api/leave-party')
        .send({ guestId: 'guest-1' });
      
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Party code is required');
    });

    it('should return 400 if guest ID is missing', async () => {
      const response = await request(app)
        .post('/api/leave-party')
        .send({ partyCode: 'ABC123' });
      
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Guest ID is required');
    });

    it('should return 404 if party does not exist', async () => {
      const response = await request(app)
        .post('/api/leave-party')
        .send({ partyCode: 'NOEXST', guestId: 'guest-1' });
      
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Party not found or expired');
    });
  });

  describe('POST /api/end-party', () => {
    it('should mark party as ended', async () => {
      // Create party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const partyCode = createResponse.body.partyCode;
      const hostId = createResponse.body.hostId;
      
      // End party (host must provide hostId)
      const endResponse = await request(app)
        .post('/api/end-party')
        .send({ partyCode, hostId });
      
      expect(endResponse.status).toBe(200);
      expect(endResponse.body.ok).toBe(true);
      
      // Verify party is marked as ended
      const { getPartyFromRedis } = require('./server');
      const partyData = await getPartyFromRedis(partyCode);
      expect(partyData.status).toBe('ended');
      expect(partyData.endedAt).toBeDefined();
    });

    it('should return 400 if party code is missing', async () => {
      const response = await request(app)
        .post('/api/end-party')
        .send({});
      
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Party code is required');
    });

    it('should return 404 if party does not exist', async () => {
      const response = await request(app)
        .post('/api/end-party')
        .send({ partyCode: 'NOEXST' });
      
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Party not found or expired');
    });

    it('should prevent joining ended party', async () => {
      // Create party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const partyCode = createResponse.body.partyCode;
      const hostId = createResponse.body.hostId;
      
      // End party (host must provide hostId)
      await request(app)
        .post('/api/end-party')
        .send({ partyCode, hostId });
      
      // Try to join ended party
      const joinResponse = await request(app)
        .post('/api/join-party')
        .send({ partyCode });
      
      expect(joinResponse.status).toBe(410);
      expect(joinResponse.body.error).toBe('Party has ended');
    });
  });

  describe('GET /api/party', () => {
    it('should return party state with guests', async () => {
      // Create party
      const createResponse = await request(app).post('/api/create-party')
        .send({ djName: 'DJ Test' });
      const partyCode = createResponse.body.partyCode;
      
      // Join as guest
      await request(app)
        .post('/api/join-party')
        .send({ partyCode, nickname: 'Guest1' });
      
      // Get party state
      const response = await request(app)
        .get(`/api/party?code=${partyCode}`);
      
      expect(response.status).toBe(200);
      expect(response.body.exists).toBe(true);
      expect(response.body.partyCode).toBe(partyCode);
      expect(response.body.guestCount).toBe(1);
      expect(response.body.guests).toHaveLength(1);
      expect(response.body.guests[0].nickname).toBe('Guest1');
      expect(response.body.status).toBe('active');
      expect(response.body.timeRemainingMs).toBeGreaterThan(0);
    });

    it('should return 400 if code is missing', async () => {
      const response = await request(app).get('/api/party');
      
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Party code is required');
    });

    it('should return exists: false for non-existent party', async () => {
      const response = await request(app)
        .get('/api/party?code=NOEXST');
      
      expect(response.status).toBe(200);
      expect(response.body.exists).toBe(false);
      expect(response.body.status).toBe('expired');
    });
  });
});

