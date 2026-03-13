/**
 * Moderation System Tests
 *
 * Tests for:
 * 1. Abuse message filter (mild / severe / repeat spam)
 * 2. Report submission API (/api/report)
 * 3. Flag message API (/api/moderation/flag-message)
 * 4. Admin moderation endpoints (protected by requireAdmin)
 * 5. Terms and Conditions include moderation section
 * 6. moderation.js exports and helper functions
 */

'use strict';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

// ── Database mock ─────────────────────────────────────────────────────────────
const mockDbQuery = jest.fn();
jest.mock('./database', () => ({
  query: mockDbQuery,
  getOrCreateUserUpgrades: jest.fn().mockResolvedValue({
    party_pass_expires_at: null,
    pro_monthly_active: false,
    pro_monthly_started_at: null,
    pro_monthly_renewal_provider: null
  }),
  resolveEntitlements: jest.fn().mockReturnValue({ hasPartyPass: false, hasPro: false }),
  pool: { end: jest.fn() }
}));

// ── Redis mock ────────────────────────────────────────────────────────────────
jest.mock('ioredis', () => {
  const Redis = jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue('PONG'),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    keys: jest.fn().mockResolvedValue([]),
    scan: jest.fn().mockResolvedValue(['0', []]),
    flushall: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
    status: 'ready'
  }));
  return Redis;
});

// ── Stripe mock ───────────────────────────────────────────────────────────────
jest.mock('./stripe-client', () => null);

// ────────────────────────────────────────────────────────────────────────────
// PART 1: moderation.js unit tests
// ────────────────────────────────────────────────────────────────────────────

describe('moderation.js', () => {
  let mod;

  beforeEach(() => {
    jest.resetModules();
    mod = require('./moderation');
    mod.initModeration();
    // Reset MODERATION state
    mod.MODERATION.mutedGuests.clear();
    mod.MODERATION.blockedGuests.clear();
    mod.MODERATION.kickedGuests.clear();
    mod.MODERATION.lastMessageTimestamps.clear();
    mod.MODERATION.repeatMessageCounts.clear();
  });

  // ── filterAndFlagMessage ──────────────────────────────────────────────────
  describe('filterAndFlagMessage()', () => {
    it('allows clean message', () => {
      const result = mod.filterAndFlagMessage('Hello party!', 'user1', 'PARTY1');
      expect(result.allowed).toBe(true);
      expect(result.filtered).toBe('Hello party!');
    });

    it('filters mild profanity but allows message', () => {
      const result = mod.filterAndFlagMessage('You are such an idiot', 'user1', 'PARTY1');
      expect(result.allowed).toBe(true);
      expect(result.filtered).toMatch(/\*+/);
      expect(result.filtered).not.toContain('idiot');
    });

    it('blocks severe abuse', () => {
      // Mild-safe test using a severe pattern keyword
      const result = mod.filterAndFlagMessage('go die you moron', 'user1', 'PARTY1');
      // 'go die' matches the severe pattern
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/community guidelines/i);
      expect(result.severity).toBe('severe');
    });

    it('blocks repeated identical messages (spam)', () => {
      const userId = 'spammer1';
      const msg = 'spam message repeat repeat repeat';
      // Reset repeat tracking
      mod.MODERATION.repeatMessageCounts.clear();

      // Send message MAX_REPEAT_MESSAGES + 1 times within window
      for (let i = 0; i < mod.MAX_REPEAT_MESSAGES; i++) {
        mod.filterAndFlagMessage(msg, userId, 'PARTY1');
      }
      // One more should be blocked
      const result = mod.filterAndFlagMessage(msg, userId, 'PARTY1');
      expect(result.allowed).toBe(false);
    });

    it('allows message after spam window resets', () => {
      const userId = 'user2';
      const msg = 'fresh message';
      // Simulate an old entry outside the repeat window
      mod.MODERATION.repeatMessageCounts.set(`${userId}:${msg}`, {
        count: 10,
        firstSeen: Date.now() - 20000 // 20 seconds ago > REPEAT_WINDOW_MS
      });
      const result = mod.filterAndFlagMessage(msg, userId, 'PARTY1');
      expect(result.allowed).toBe(true);
    });
  });

  // ── containsSevereAbuse ───────────────────────────────────────────────────
  describe('containsSevereAbuse()', () => {
    it('returns false for clean text', () => {
      expect(mod.containsSevereAbuse('I love this track!')).toBe(false);
    });

    it('returns false for empty/null', () => {
      expect(mod.containsSevereAbuse('')).toBe(false);
      expect(mod.containsSevereAbuse(null)).toBe(false);
    });

    it('returns true for kys pattern', () => {
      expect(mod.containsSevereAbuse('kys loser')).toBe(true);
    });
  });

  // ── containsMildAbuse ─────────────────────────────────────────────────────
  describe('containsMildAbuse()', () => {
    it('returns false for clean message', () => {
      expect(mod.containsMildAbuse('Amazing music!')).toBe(false);
    });

    it('returns true for mild abuse word', () => {
      expect(mod.containsMildAbuse('What an idiot')).toBe(true);
    });
  });

  // ── filterProfanity ───────────────────────────────────────────────────────
  describe('filterProfanity()', () => {
    it('replaces mild abuse with asterisks', () => {
      const result = mod.filterProfanity('You moron!');
      expect(result).toContain('*');
      expect(result).not.toContain('moron');
    });

    it('returns message unchanged if no profanity', () => {
      expect(mod.filterProfanity('Great track!')).toBe('Great track!');
    });

    it('returns null/undefined unchanged', () => {
      expect(mod.filterProfanity(null)).toBeNull();
      expect(mod.filterProfanity(undefined)).toBeUndefined();
    });
  });

  // ── checkRepeatSpam ───────────────────────────────────────────────────────
  describe('checkRepeatSpam()', () => {
    it('allows message below repeat limit', () => {
      for (let i = 0; i < mod.MAX_REPEAT_MESSAGES; i++) {
        expect(mod.checkRepeatSpam('u1', 'same')).toBe(true);
      }
    });

    it('blocks message above repeat limit', () => {
      for (let i = 0; i < mod.MAX_REPEAT_MESSAGES; i++) {
        mod.checkRepeatSpam('u2', 'repeat');
      }
      expect(mod.checkRepeatSpam('u2', 'repeat')).toBe(false);
    });
  });

  // ── reportUser / reportTrack / reportMessage / reportParty ───────────────
  describe('report helpers', () => {
    it('reportUser returns success', () => {
      const r = mod.reportUser('guest1', 'harassment', 'Harassing others');
      expect(r.success).toBe(true);
    });

    it('reportTrack returns success', () => {
      const r = mod.reportTrack({ id: 't1', title: 'Test Track' }, 'copyright_infringement', '');
      expect(r.success).toBe(true);
    });

    it('reportMessage returns success', () => {
      const r = mod.reportMessage('msg1', 'Bad content', 'sender1', 'abuse', '');
      expect(r.success).toBe(true);
    });

    it('reportParty returns success', () => {
      const r = mod.reportParty('PARTY1', 'host1', 'inappropriate_content', '');
      expect(r.success).toBe(true);
    });
  });

  // ── host-only actions ─────────────────────────────────────────────────────
  describe('host-only functions', () => {
    it('muteGuest adds to mutedGuests', () => {
      // Override state check — no state defined in test env
      mod.muteGuest('g1');
      expect(mod.MODERATION.mutedGuests.has('g1')).toBe(true);
    });

    it('isGuestMuted returns true after mute', () => {
      mod.muteGuest('g2');
      expect(mod.isGuestMuted('g2')).toBe(true);
    });

    it('unmuteGuest removes from mutedGuests', () => {
      mod.muteGuest('g3');
      mod.unmuteGuest('g3');
      expect(mod.isGuestMuted('g3')).toBe(false);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PART 2: /api/report endpoint tests
// ────────────────────────────────────────────────────────────────────────────

describe('POST /api/report', () => {
  let app;

  beforeAll(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret-1234567890';
    process.env.ADMIN_EMAILS = 'admin@example.com';
  });

  beforeEach(() => {
    mockDbQuery.mockResolvedValue({ rows: [] });
    // Require auth middleware fresh
    const authMiddleware = require('./auth-middleware');

    app = express();
    app.use(express.json());
    app.use(cookieParser());

    const apiLimiter = (req, res, next) => next();

    // Mount /api/report inline
    app.post('/api/report', apiLimiter, authMiddleware.optionalAuth, async (req, res) => {
      const { type, targetId, partyId, reportedUserId, reason, description, evidence } = req.body;
      if (!type || !['track', 'message', 'user', 'party'].includes(type)) {
        return res.status(400).json({ error: 'Invalid report type' });
      }
      if (!targetId) return res.status(400).json({ error: 'targetId is required' });
      if (!reason) return res.status(400).json({ error: 'reason is required' });
      const db = require('./database');
      await db.query('INSERT INTO reports VALUES', [type, targetId, partyId, null, reportedUserId, reason, description, evidence ? JSON.stringify(evidence) : null]);
      return res.json({ success: true, message: 'Report submitted. Our team will review it.' });
    });
  });

  it('rejects invalid type', async () => {
    const resp = await request(app)
      .post('/api/report')
      .send({ type: 'invalid', targetId: 'x', reason: 'test' });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/invalid report type/i);
  });

  it('rejects missing targetId', async () => {
    const resp = await request(app)
      .post('/api/report')
      .send({ type: 'track', reason: 'copyright' });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/targetId/i);
  });

  it('rejects missing reason', async () => {
    const resp = await request(app)
      .post('/api/report')
      .send({ type: 'track', targetId: 'track1' });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/reason/i);
  });

  it('accepts valid track report', async () => {
    const resp = await request(app)
      .post('/api/report')
      .send({ type: 'track', targetId: 'track1', reason: 'copyright_infringement', description: 'Test' });
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);
    expect(resp.body.message).toMatch(/submitted/i);
  });

  it('accepts valid message report', async () => {
    const resp = await request(app)
      .post('/api/report')
      .send({ type: 'message', targetId: 'msg1', reason: 'abuse' });
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);
  });

  it('accepts valid user report', async () => {
    const resp = await request(app)
      .post('/api/report')
      .send({ type: 'user', targetId: 'user1', reason: 'harassment' });
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);
  });

  it('accepts valid party report', async () => {
    const resp = await request(app)
      .post('/api/report')
      .send({ type: 'party', targetId: 'PARTY1', partyId: 'PARTY1', reason: 'spam' });
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PART 3: /api/moderation/flag-message endpoint tests
// ────────────────────────────────────────────────────────────────────────────

describe('POST /api/moderation/flag-message', () => {
  let app;

  beforeEach(() => {
    mockDbQuery.mockResolvedValue({ rows: [] });

    app = express();
    app.use(express.json());

    app.post('/api/moderation/flag-message', async (req, res) => {
      const { userId, partyId, messageText, filterReason, severity } = req.body;
      if (!filterReason) return res.status(400).json({ error: 'filterReason is required' });
      const db = require('./database');
      await db.query('INSERT INTO message_moderation_events VALUES', [userId, partyId, messageText, filterReason, severity || 'mild']);
      return res.json({ success: true });
    });
  });

  it('rejects missing filterReason', async () => {
    const resp = await request(app)
      .post('/api/moderation/flag-message')
      .send({ userId: 'u1', partyId: 'P1', messageText: 'bad text' });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toMatch(/filterReason/i);
  });

  it('accepts valid flag event', async () => {
    const resp = await request(app)
      .post('/api/moderation/flag-message')
      .send({ userId: 'u1', partyId: 'P1', messageText: 'offensive', filterReason: 'severe_abuse', severity: 'severe' });
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PART 4: Admin moderation endpoints are protected
// ────────────────────────────────────────────────────────────────────────────

describe('Admin moderation endpoints require admin auth', () => {
  let app;

  beforeAll(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret-1234567890';
    process.env.ADMIN_EMAILS = 'admin@example.com';
  });

  beforeEach(() => {
    mockDbQuery.mockResolvedValue({ rows: [] });
    const authMiddleware = require('./auth-middleware');

    app = express();
    app.use(express.json());
    app.use(cookieParser());

    app.get('/api/admin/moderation/reports', authMiddleware.requireAdmin, async (req, res) => {
      const db = require('./database');
      const result = await db.query('SELECT * FROM reports ORDER BY created_at DESC LIMIT 50');
      return res.json({ reports: result.rows });
    });

    app.post('/api/admin/moderation/action', authMiddleware.requireAdmin, async (req, res) => {
      return res.json({ success: true, message: 'Action completed' });
    });
  });

  it('GET /api/admin/moderation/reports returns 401 without auth', async () => {
    const resp = await request(app).get('/api/admin/moderation/reports');
    expect([401, 403]).toContain(resp.status);
  });

  it('POST /api/admin/moderation/action returns 401 without auth', async () => {
    const resp = await request(app)
      .post('/api/admin/moderation/action')
      .send({ action: 'dismiss', reportId: 'r1' });
    expect([401, 403]).toContain(resp.status);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PART 5: Terms and Conditions include moderation section
// ────────────────────────────────────────────────────────────────────────────

describe('Terms and Conditions', () => {
  const fs = require('fs');
  const path = require('path');

  let termsContent;

  beforeAll(() => {
    termsContent = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  });

  it('includes "User Content, Copyright, and Moderation" section heading', () => {
    expect(termsContent).toContain('User Content, Copyright, and Moderation');
  });

  it('mentions copyright complaints via in-app reporting', () => {
    expect(termsContent).toMatch(/copyright.*report|report.*copyright/i);
  });

  it('mentions abusive behaviour consequences', () => {
    expect(termsContent).toMatch(/warn|suspend|ban/i);
  });

  it('states host moderation is party-level only', () => {
    expect(termsContent).toMatch(/host.*party.*level|party.*session.*level|host.*session/i);
  });

  it('states platform-wide bans are admin-only', () => {
    expect(termsContent).toMatch(/admin.*only|admin-only/i);
  });

  it('mentions automatic message filter', () => {
    expect(termsContent).toMatch(/filter|automatic/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PART 6: DB migration file exists
// ────────────────────────────────────────────────────────────────────────────

describe('DB migration 008_moderation_tables.sql', () => {
  const fs = require('fs');
  const path = require('path');
  let migrationContent;

  beforeAll(() => {
    migrationContent = fs.readFileSync(
      path.join(__dirname, 'db', 'migrations', '008_moderation_tables.sql'),
      'utf-8'
    );
  });

  it('creates reports table', () => {
    expect(migrationContent).toContain('CREATE TABLE IF NOT EXISTS reports');
  });

  it('creates message_moderation_events table', () => {
    expect(migrationContent).toContain('CREATE TABLE IF NOT EXISTS message_moderation_events');
  });

  it('creates user_moderation_history table', () => {
    expect(migrationContent).toContain('CREATE TABLE IF NOT EXISTS user_moderation_history');
  });

  it('reports table has required columns', () => {
    expect(migrationContent).toContain('type TEXT');
    expect(migrationContent).toContain('evidence_json');
    expect(migrationContent).toContain('admin_action');
    expect(migrationContent).toContain('reporter_user_id');
    expect(migrationContent).toContain('reported_user_id');
  });

  it('user_moderation_history has ban_status', () => {
    expect(migrationContent).toContain('ban_status');
    expect(migrationContent).toContain('warning_count');
    expect(migrationContent).toContain('suspension_count');
  });
});
