'use strict';
const express = require('express');

module.exports = function createReferralRouter(deps) {
  const {
    referralSystem,
    authMiddleware,
    apiLimiter
  } = deps;

  const router = express.Router();

  router.get('/me', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
      const stats = await referralSystem.getStats(req.user.id);
      return res.json(stats);
    } catch (err) {
      console.error('[Referral] /me error:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve referral stats' });
    }
  });

  // Keep old /stats alias for backward compatibility
  router.get('/stats', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
      const stats = await referralSystem.getStats(req.user.id);
      return res.json(stats);
    } catch (err) {
      console.error('[Referral] /stats error:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve referral stats' });
    }
  });

  router.post('/click', apiLimiter, async (req, res) => {
    try {
      if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
      const { referralCode } = req.body;
      if (!referralCode || typeof referralCode !== 'string' || referralCode.length > 20) {
        return res.status(400).json({ error: 'referralCode is required' });
      }
      const ip        = req.ip || req.connection?.remoteAddress;
      const userAgent = req.headers['user-agent'];
      const clickId   = await referralSystem.recordClick(referralCode, ip, userAgent);
      if (!clickId) return res.status(400).json({ error: 'Invalid referral code or rate limited' });
      return res.json({ clickId });
    } catch (err) {
      console.error('[Referral] /click error:', err.message);
      return res.status(500).json({ error: 'Failed to record click' });
    }
  });

  router.post('/register', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
      const { referralCode, clickId } = req.body;
      if (!referralCode) return res.status(400).json({ error: 'referralCode is required' });
      const ip    = req.ip || req.connection?.remoteAddress;
      const email = req.user.email || null;
      const result = await referralSystem.registerReferral(
        referralCode, clickId || null, req.user.id, email, ip
      );
      return res.json(result);
    } catch (err) {
      console.error('[Referral] /register error:', err.message);
      return res.status(500).json({ error: 'Failed to register referral' });
    }
  });

  router.post('/profile-complete', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
      await referralSystem.markProfileDone(req.user.id);
      return res.json({ ok: true });
    } catch (err) {
      console.error('[Referral] /profile-complete error:', err.message);
      return res.status(500).json({ error: 'Failed to update referral stage' });
    }
  });

  router.post('/party-first-join', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
      const result = await referralSystem.markPartyJoined(req.user.id);
      return res.json(result);
    } catch (err) {
      console.error('[Referral] /party-first-join error:', err.message);
      return res.status(500).json({ error: 'Failed to complete referral' });
    }
  });

  router.get('/rewards', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
      const stats = await referralSystem.getStats(req.user.id);
      return res.json({ rewards: stats.rewards || [] });
    } catch (err) {
      console.error('[Referral] /rewards error:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve rewards' });
    }
  });

  // Keep old /track alias for backward compatibility
  router.post('/track', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
      const { referralCode } = req.body;
      if (!referralCode) return res.status(400).json({ error: 'referralCode is required' });
      const result = await referralSystem.registerReferral(
        referralCode, null, req.user.id, req.user.email || null, req.ip
      );
      return res.json({ success: result.ok });
    } catch (err) {
      console.error('[Referral] /track error:', err.message);
      return res.status(500).json({ error: 'Failed to track referral' });
    }
  });

  // GET /inviter-name?code=CODE — public endpoint for the signup page invite banner.
  // Returns only the display name of the user who owns the given referral code.
  router.get('/inviter-name', apiLimiter, async (req, res) => {
    try {
      if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
      const code = (req.query.code || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code || code.length > 20) return res.status(400).json({ error: 'code is required' });
      const name = await referralSystem.getInviterName(code);
      if (!name) return res.status(404).json({ error: 'Invite code not found' });
      return res.json({ name });
    } catch (err) {
      console.error('[Referral] /inviter-name error:', err.message);
      return res.status(500).json({ error: 'Failed to look up inviter name' });
    }
  });

  return router;
};
