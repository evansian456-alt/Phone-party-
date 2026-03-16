const { Router } = require('express');

module.exports = function createReferralRouter(context) {
  const { authMiddleware, referralSystem, apiLimiter } = context;
  const router = Router();

  router.get('/api/referral/me', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
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
  router.get('/api/referral/stats', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
      const stats = await referralSystem.getStats(req.user.id);
      return res.json(stats);
    } catch (err) {
      console.error('[Referral] /stats error:', err.message);
      return res.status(500).json({ error: 'Failed to retrieve referral stats' });
    }
  });

  /**
   * POST /api/referral/click
   * Body: { referralCode }
   * Records a link click and returns { clickId }.
   * No auth required (called on invite landing page before signup).
   */
  router.post('/api/referral/click', apiLimiter, async (req, res) => {
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

  /**
   * POST /api/referral/register
   * Body: { referralCode, clickId }
   * Links the currently-authenticated new user to an inviter (once only).
   */
  router.post('/api/referral/register', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
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

  /**
   * POST /api/referral/profile-complete
   * Advances the referral stage to PROFILE_DONE.
   */
  router.post('/api/referral/profile-complete', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
      await referralSystem.markProfileDone(req.user.id);
      return res.json({ ok: true });
    } catch (err) {
      console.error('[Referral] /profile-complete error:', err.message);
      return res.status(500).json({ error: 'Failed to update referral stage' });
    }
  });

  /**
   * POST /api/referral/party-first-join
   * Final step – marks referral COMPLETED and checks milestones.
   */
  router.post('/api/referral/party-first-join', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
      const result = await referralSystem.markPartyJoined(req.user.id);
      return res.json(result);
    } catch (err) {
      console.error('[Referral] /party-first-join error:', err.message);
      return res.status(500).json({ error: 'Failed to complete referral' });
    }
  });

  /**
   * GET /api/referral/rewards
   * Returns the user's earned reward history.
   */
  router.get('/api/referral/rewards', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
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
  router.post('/api/referral/track', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
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

  return router;
};
