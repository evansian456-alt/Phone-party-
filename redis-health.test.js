const request = require('supertest');

// Mock ioredis before importing server
jest.mock('ioredis');

/**
 * Helper: generate an admin JWT cookie for the given server module so that
 * admin-protected endpoints (like /api/debug/redis) can be called in tests.
 */
function makeAdminCookie(serverModule) {
  const authMW = require('./auth-middleware');
  const token = authMW.generateToken({ userId: 'test-admin', email: 'admin@example.com', isAdmin: true });
  return `auth_token=${token}`;
}

describe('Redis Health and Diagnostics', () => {
  let app;
  let redis;
  let originalEnv;
  
  beforeAll(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });
  
  afterAll(() => {
    // Restore original environment
    process.env = originalEnv;
  });
  
  beforeEach(() => {
    // Clear module cache to allow fresh imports with different env vars
    jest.resetModules();
  });
  
  describe('GET /api/health - Redis Ready', () => {
    beforeEach(() => {
      // Set test environment (not production)
      process.env.NODE_ENV = 'test';
      delete process.env.REDIS_URL;
      delete process.env.RAILWAY_ENVIRONMENT;
      
      // Import fresh module
      const server = require('./server');
      app = server.app;
      redis = server.redis;
    });
    
    it('should return 200 when Redis is ready in test mode', async () => {
      const response = await request(app).get('/api/health');
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
    
    it('should include redis connection info', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body.redis).toBeDefined();
      expect(response.body.redis.connected).toBeDefined();
      expect(response.body.redis.status).toBeDefined();
      expect(response.body.redis.mode).toBe('optional'); // Test mode
      expect(response.body.redis.configSource).toBeDefined();
    });
    
    it('should include redisConfigured, redisReady, fallbackMode, and strictProductionMode fields', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body).toHaveProperty('redisConfigured');
      expect(typeof response.body.redisConfigured).toBe('boolean');
      expect(response.body).toHaveProperty('redisReady');
      expect(typeof response.body.redisReady).toBe('boolean');
      expect(response.body).toHaveProperty('fallbackMode');
      expect(typeof response.body.fallbackMode).toBe('boolean');
      expect(response.body).toHaveProperty('strictProductionMode');
      expect(typeof response.body.strictProductionMode).toBe('boolean');
      // In test mode, strictProductionMode must be false
      expect(response.body.strictProductionMode).toBe(false);
    });
    
    it('should include uptimeSeconds', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body.uptimeSeconds).toBeDefined();
      expect(typeof response.body.uptimeSeconds).toBe('number');
      expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
    
    it('should include timestamp', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body.timestamp).toBeDefined();
      expect(typeof response.body.timestamp).toBe('string');
    });
  });
  
  describe('GET /api/debug/redis', () => {
    let adminCookie;

    beforeEach(() => {
      // Set test environment
      process.env.NODE_ENV = 'test';
      delete process.env.REDIS_URL;
      
      const server = require('./server');
      app = server.app;
      adminCookie = makeAdminCookie(server);
    });
    
    it('should return 401 without authentication', async () => {
      const response = await request(app).get('/api/debug/redis');
      expect(response.status).toBe(401);
    });

    it('should return Redis debug information to admin users', async () => {
      const response = await request(app).get('/api/debug/redis').set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });
    
    it('should include instanceId and version', async () => {
      const response = await request(app).get('/api/debug/redis').set('Cookie', adminCookie);
      expect(response.body.instanceId).toBeDefined();
      expect(response.body.version).toBeDefined();
    });
    
    it('should include redis details', async () => {
      const response = await request(app).get('/api/debug/redis').set('Cookie', adminCookie);
      expect(response.body.redis).toBeDefined();
      expect(response.body.redis.clientCreated).toBeDefined();
      expect(response.body.redis.ready).toBeDefined();
      expect(response.body.redis.status).toBeDefined();
      expect(response.body.redis.configSource).toBeDefined();
    });
    
    it('should include TLS configuration', async () => {
      const response = await request(app).get('/api/debug/redis').set('Cookie', adminCookie);
      expect(response.body.redis.usesTls).toBeDefined();
      expect(response.body.redis.rejectUnauthorized).toBeDefined();
    });
    
    it('should include ping test results', async () => {
      const response = await request(app).get('/api/debug/redis').set('Cookie', adminCookie);
      expect(response.body.redis.ping).toBeDefined();
      expect(response.body.redis.ping.result).toBeDefined();
    });
    
    it('should include fallback mode status', async () => {
      const response = await request(app).get('/api/debug/redis').set('Cookie', adminCookie);
      expect(response.body.fallbackMode).toBeDefined();
      expect(response.body.allowFallbackInProduction).toBeDefined();
    });
  });
  
  describe('GET /health - Simple health check', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
      const server = require('./server');
      app = server.app;
    });
    
    it('should include uptimeSeconds', async () => {
      const response = await request(app).get('/health');
      expect(response.body.uptimeSeconds).toBeDefined();
      expect(typeof response.body.uptimeSeconds).toBe('number');
    });
    
    it('should include redisLastErrorAt when error exists', async () => {
      const response = await request(app).get('/health');
      // This may or may not be present depending on Redis state
      if (response.body.redisError) {
        expect(response.body.redisErrorType).toBeDefined();
      }
    });
  });
  
  describe('POST /api/create-party - Redis handling', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
      const server = require('./server');
      app = server.app;
      redis = server.redis;
    });
    
    it('should succeed in test mode even if Redis not ready', async () => {
      const response = await request(app)
        .post('/api/create-party')
        .send({ djName: 'Test DJ' });
      
      expect(response.status).toBe(200);
      expect(response.body.partyCode).toBeDefined();
      expect(response.body.hostId).toBeDefined();
    });
  });
  
  describe('POST /api/join-party - Redis handling', () => {
    let partyCode;
    
    beforeEach(async () => {
      process.env.NODE_ENV = 'test';
      const server = require('./server');
      app = server.app;
      
      // Create a party first
      const createResponse = await request(app)
        .post('/api/create-party')
        .send({ djName: 'Test DJ' });
      
      partyCode = createResponse.body.partyCode;
    });
    
    it('should succeed in test mode even if Redis not ready', async () => {
      const response = await request(app)
        .post('/api/join-party')
        .send({ 
          partyCode: partyCode,
          nickname: 'Test Guest'
        });
      
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.guestId).toBeDefined();
    });
  });
});

describe('Redis Health - Production Mode Simulation', () => {
  let app;
  let originalEnv;
  
  beforeAll(() => {
    originalEnv = { ...process.env };
  });
  
  afterAll(() => {
    process.env = originalEnv;
  });
  
  beforeEach(() => {
    jest.resetModules();
  });
  
  describe('Production without Redis (503 responses)', () => {
    beforeEach(() => {
      // Simulate production without Redis
      process.env.NODE_ENV = 'production';
      delete process.env.REDIS_URL;
      delete process.env.REDIS_HOST;
      delete process.env.ALLOW_FALLBACK_IN_PRODUCTION;
      
      // Mock ioredis to fail
      jest.doMock('ioredis', () => {
        return jest.fn().mockImplementation(() => {
          const EventEmitter = require('events');
          const mock = new EventEmitter();
          mock.status = 'wait';
          // Don't emit ready, simulate connection failure
          setTimeout(() => {
            mock.emit('error', new Error('ECONNREFUSED'));
          }, 10);
          return mock;
        });
      });
      
      const server = require('./server');
      app = server.app;
    });
    
    it('should return 503 for /api/health in production when Redis unavailable', async () => {
      const response = await request(app).get('/api/health');
      expect(response.status).toBe(503);
      expect(response.body.ok).toBe(false);
      expect(response.body.redis.mode).toBe('required');
    });
    
    it('should include error details in health response', async () => {
      const response = await request(app).get('/api/health');
      expect(response.body.redis.lastError).toBeDefined();
      expect(response.body.redis.errorType).toBeDefined();
    });
  });
  
  describe('Production with fallback mode enabled', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_FALLBACK_IN_PRODUCTION = 'true';
      delete process.env.REDIS_URL;
      delete process.env.REDIS_HOST;
      
      const server = require('./server');
      app = server.app;
    });
    
    it('should allow create-party with warning when fallback enabled', async () => {
      const response = await request(app)
        .post('/api/create-party')
        .send({ djName: 'Test DJ' });
      
      // Should succeed but include warning
      expect(response.status).toBe(200);
      expect(response.body.partyCode).toBeDefined();
      expect(response.body.warning).toBe('fallback_mode_single_instance');
    });
    
    it('should allow join-party with warning when fallback enabled', async () => {
      // Create party first
      const createResponse = await request(app)
        .post('/api/create-party')
        .send({ djName: 'Test DJ' });
      
      const partyCode = createResponse.body.partyCode;
      
      // Join party
      const joinResponse = await request(app)
        .post('/api/join-party')
        .send({ 
          partyCode: partyCode,
          nickname: 'Guest'
        });
      
      expect(joinResponse.status).toBe(200);
      expect(joinResponse.body.ok).toBe(true);
      expect(joinResponse.body.warning).toBe('fallback_mode_single_instance');
    });
  });
});
