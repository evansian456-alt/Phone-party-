/**
 * Tests for Payment and Upgrade System
 * 
 * Note: These tests require a running PostgreSQL database.
 * Set DATABASE_URL or DB_* environment variables to connect.
 * Tests will be skipped if database is not available.
 */

const request = require('supertest');
const db = require('./database');

// Mock server setup
let server;
let app;
let dbAvailable = false;

// A nested beforeAll throws (FAIL, not skip) when the database is unavailable,
// satisfying the zero-skip mandate: tests either pass or fail, never skip.
const describeIfDb = (name, fn) => {
  describe(name, () => {
    beforeAll(() => {
      if (!dbAvailable) {
        throw new Error(
          `Database not available — "${name}" tests cannot run. ` +
          'Ensure DATABASE_URL is set and PostgreSQL is running.'
        );
      }
    });
    fn();
  });
};

beforeAll(async () => {
  // Set test environment
  process.env.NODE_ENV = 'test';
  process.env.TEST_MODE = 'true';
  
  // Check if database is available
  try {
    const healthResult = await db.healthCheck();
    dbAvailable = healthResult.healthy;
    
    if (dbAvailable) {
      // Initialize database schema only if DB is available
      await db.initializeSchema();
      console.log('[Test] Database connected - running payment integration tests');
      
      // Start server
      const serverModule = require('./server');
      app = serverModule.app || serverModule;
      server = app.listen(0); // Use random port for testing
    } else {
      console.log('[Test] Database not healthy - skipping payment integration tests');
    }
  } catch (error) {
    dbAvailable = false;
    console.log('[Test] Database not available - skipping payment integration tests:', error.message);
  }
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (dbAvailable) {
    await db.pool.end();
  }
});

describeIfDb('Payment System', () => {
  let userId;
  let authToken;
  
  beforeEach(async () => {
    // Create test user
    const email = `test-${Date.now()}@example.com`;
    const signupResponse = await request(app)
      .post('/api/auth/signup')
      .send({
        email,
        password: 'testpass123',
        djName: 'Test DJ',
        termsAccepted: true
      });
    
    expect(signupResponse.status).toBe(201);
    expect(signupResponse.body.user).toBeDefined();
    expect(signupResponse.body.user.id).toBeDefined();
    
    userId = signupResponse.body.user.id;
    
    // Get auth token
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({
        email,
        password: 'testpass123'
      });
    
    // Extract token from cookie
    const cookies = loginResponse.headers['set-cookie'];
    authToken = cookies ? cookies[0].split(';')[0].split('=')[1] : null;
  });
  
  describe('Payment Initiation', () => {
    test('should create payment intent for Party Pass', async () => {
      const response = await request(app)
        .post('/api/payment/initiate')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          productId: 'party_pass',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.paymentIntent).toBeDefined();
      expect(response.body.paymentIntent.productId).toBe('party_pass');
      expect(response.body.paymentIntent.amount).toBeGreaterThan(0);
    });
    
    test('should create payment intent for Pro Monthly', async () => {
      const response = await request(app)
        .post('/api/payment/initiate')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          productId: 'pro_monthly',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.paymentIntent.productId).toBe('pro_monthly');
    });
    
    test('should reject invalid product ID', async () => {
      const response = await request(app)
        .post('/api/payment/initiate')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          productId: 'invalid_product',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      expect(response.status).toBe(400);
    });
  });
  
  describe('Payment Confirmation', () => {
    test('should confirm Party Pass purchase and grant entitlement', async () => {
      // Initiate payment
      const initiateResponse = await request(app)
        .post('/api/payment/initiate')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          productId: 'party_pass',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      const { paymentIntent } = initiateResponse.body;
      
      // Confirm payment
      const confirmResponse = await request(app)
        .post('/api/payment/confirm')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          intentId: paymentIntent.intentId,
          paymentToken: 'test_token',
          productId: 'party_pass',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      expect(confirmResponse.status).toBe(200);
      expect(confirmResponse.body.success).toBe(true);
      expect(confirmResponse.body.transactionId).toBeDefined();
      expect(confirmResponse.body.upgrades).toBeDefined();
      expect(confirmResponse.body.upgrades.partyPass.expiresAt).toBeDefined();
      expect(confirmResponse.body.entitlements.hasPartyPass).toBe(true);
    });
    
    test('should confirm Pro Monthly purchase and activate subscription', async () => {
      const initiateResponse = await request(app)
        .post('/api/payment/initiate')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          productId: 'pro_monthly',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      const { paymentIntent } = initiateResponse.body;
      
      const confirmResponse = await request(app)
        .post('/api/payment/confirm')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          intentId: paymentIntent.intentId,
          paymentToken: 'test_token',
          productId: 'pro_monthly',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      expect(confirmResponse.status).toBe(200);
      expect(confirmResponse.body.success).toBe(true);
      expect(confirmResponse.body.upgrades.proMonthly.active).toBe(true);
      expect(confirmResponse.body.entitlements.hasPro).toBe(true);
      expect(confirmResponse.body.entitlements.hasPartyPass).toBe(true); // Pro includes Party Pass
    });
  });
  
  describe('Entitlement Resolution', () => {
    test('Party Pass should expire after expiry time', () => {
      const pastExpiry = new Date(Date.now() - 1000); // 1 second ago
      const upgrades = {
        party_pass_expires_at: pastExpiry,
        pro_monthly_active: false
      };
      
      const { hasPartyPass, hasPro } = db.resolveEntitlements(upgrades);
      
      expect(hasPartyPass).toBe(false);
      expect(hasPro).toBe(false);
    });
    
    test('Party Pass should be active before expiry time', () => {
      const futureExpiry = new Date(Date.now() + 60000); // 1 minute from now
      const upgrades = {
        party_pass_expires_at: futureExpiry,
        pro_monthly_active: false
      };
      
      const { hasPartyPass, hasPro } = db.resolveEntitlements(upgrades);
      
      expect(hasPartyPass).toBe(true);
      expect(hasPro).toBe(false);
    });
    
    test('Pro Monthly should include Party Pass entitlement', () => {
      const upgrades = {
        party_pass_expires_at: null,
        pro_monthly_active: true
      };
      
      const { hasPartyPass, hasPro } = db.resolveEntitlements(upgrades);
      
      expect(hasPartyPass).toBe(true);
      expect(hasPro).toBe(true);
    });
    
    test('Pro Monthly should override expired Party Pass', () => {
      const pastExpiry = new Date(Date.now() - 1000);
      const upgrades = {
        party_pass_expires_at: pastExpiry,
        pro_monthly_active: true
      };
      
      const { hasPartyPass, hasPro } = db.resolveEntitlements(upgrades);
      
      expect(hasPartyPass).toBe(true);
      expect(hasPro).toBe(true);
    });
  });
  
  describe('Entitlement Fetch', () => {
    test('should fetch current user entitlements', async () => {
      // First purchase Party Pass
      const initiateResponse = await request(app)
        .post('/api/payment/initiate')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          productId: 'party_pass',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      await request(app)
        .post('/api/payment/confirm')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          intentId: initiateResponse.body.paymentIntent.intentId,
          paymentToken: 'test_token',
          productId: 'party_pass',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      // Now fetch entitlements
      const response = await request(app)
        .get('/api/user/entitlements')
        .set('Cookie', [`auth_token=${authToken}`]);
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.entitlements.hasPartyPass).toBe(true);
      expect(response.body.upgrades.partyPass.expiresAt).toBeDefined();
    });
  });
  
  describe('Upgrade Persistence', () => {
    test('Party Pass should persist across sessions', async () => {
      // Purchase Party Pass
      const initiateResponse = await request(app)
        .post('/api/payment/initiate')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          productId: 'party_pass',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      await request(app)
        .post('/api/payment/confirm')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          intentId: initiateResponse.body.paymentIntent.intentId,
          paymentToken: 'test_token',
          productId: 'party_pass',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      // Fetch /api/me to simulate reload
      const meResponse = await request(app)
        .get('/api/me')
        .set('Cookie', [`auth_token=${authToken}`]);
      
      expect(meResponse.status).toBe(200);
      expect(meResponse.body.tier).toBe('PARTY_PASS');
      expect(meResponse.body.entitlements.hasPartyPass).toBe(true);
      expect(meResponse.body.upgrades.partyPass.expiresAt).toBeDefined();
    });
    
    test('Pro Monthly should persist across sessions', async () => {
      const initiateResponse = await request(app)
        .post('/api/payment/initiate')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          productId: 'pro_monthly',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      await request(app)
        .post('/api/payment/confirm')
        .set('Cookie', [`auth_token=${authToken}`])
        .send({
          intentId: initiateResponse.body.paymentIntent.intentId,
          paymentToken: 'test_token',
          productId: 'pro_monthly',
          platform: 'web',
          paymentMethod: 'card'
        });
      
      const meResponse = await request(app)
        .get('/api/me')
        .set('Cookie', [`auth_token=${authToken}`]);
      
      expect(meResponse.status).toBe(200);
      expect(meResponse.body.tier).toBe('PRO_MONTHLY');
      expect(meResponse.body.entitlements.hasPro).toBe(true);
      expect(meResponse.body.entitlements.hasPartyPass).toBe(true);
      expect(meResponse.body.upgrades.proMonthly.active).toBe(true);
    });
  });
});

describe('Payment Provider Routing', () => {
  const paymentProvider = require('./payment-provider');
  
  test('should route iOS to Apple IAP', () => {
    const provider = paymentProvider.getProviderForPayment('ios', 'apple_pay');
    expect(provider).toBe('apple_iap');
  });
  
  test('should route Android to Google Play', () => {
    const provider = paymentProvider.getProviderForPayment('android', 'google_pay');
    expect(provider).toBe('google_play');
  });
  
  test('should route Web to Stripe', () => {
    const provider = paymentProvider.getProviderForPayment('web', 'card');
    expect(provider).toBe('stripe');
  });
  
  test('should route Web Apple Pay to Stripe', () => {
    const provider = paymentProvider.getProviderForPayment('web', 'apple_pay');
    expect(provider).toBe('stripe');
  });
  
  test('should route Web Google Pay to Stripe', () => {
    const provider = paymentProvider.getProviderForPayment('web', 'google_pay');
    expect(provider).toBe('stripe');
  });
});
