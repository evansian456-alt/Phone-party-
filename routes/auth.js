'use strict';
const express = require('express');
const DJ_NAME_MAX_LENGTH = 50;

module.exports = function createAuthRouter(deps) {
  const {
    db, authMiddleware, storeCatalog, apiLimiter, authLimiter,
    isStreamingPartyEnabled, isHttpsRequest, buildLocalFallbackMePayload,
    ErrorMessages, setSecureCookie, parties, paymentProvider
  } = deps;
  const router = express.Router();

  router.post("/auth/signup", authLimiter, async (req, res) => {
    let dbClient = null;
    try {
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'Invalid request: JSON body required' });
      }
      const { email, password, djName, termsAccepted } = req.body;

      if (typeof email !== 'string' || typeof password !== 'string' || typeof djName !== 'string') {
        return res.status(400).json({ error: 'Invalid request: email, password, and djName must be strings' });
      }

      if (!authMiddleware.isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }

      if (!authMiddleware.isValidPassword(password)) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }

      if (!djName || djName.trim().length === 0) {
        return res.status(400).json({ error: 'DJ name is required' });
      }

      if (!termsAccepted) {
        return res.status(400).json({ error: 'You must accept the Terms & Conditions and Privacy Policy to create an account' });
      }

      if (deps.canUseLocalAuthFallback()) {
        const normalizedEmail = email.toLowerCase();
        if (deps.localFallbackUsersByEmail.has(normalizedEmail)) {
          return res.status(409).json({ error: 'Account already exists' });
        }

        const passwordHash = await authMiddleware.hashPassword(password);
        const user = {
          id: deps.localFallbackUserIdSeq++,
          email: normalizedEmail,
          djName: djName.trim(),
          passwordHash,
          createdAt: new Date().toISOString(),
          profileCompleted: true,
          upgrades: { party_pass_active: false, pro_monthly_active: false },
          entitlements: [],
          profile: {
            activeVisualPack: null,
            activeTitle: null,
            verifiedBadge: false,
            crownEffect: false,
            animatedName: false,
            reactionTrail: false,
          }
        };

        deps.localFallbackUsersByEmail.set(normalizedEmail, user);
        deps.localFallbackUsersById.set(user.id, user);

        const token = authMiddleware.generateToken({ userId: user.id, email: user.email });
        res.cookie('auth_token', token, {
          httpOnly: true,
          path: '/',
          secure: isHttpsRequest(req),
          maxAge: 7 * 24 * 60 * 60 * 1000,
          sameSite: 'lax'
        });

        return res.status(201).json({
          success: true,
          user: {
            id: user.id,
            email: user.email,
            djName: user.djName,
            profileCompleted: true,
            createdAt: user.createdAt
          }
        });
      }

      const existingUser = await db.query(
        'SELECT id FROM users WHERE email = $1',
        [email.toLowerCase()]
      );

      if (existingUser.rows.length > 0) {
        return res.status(409).json({ error: 'Account already exists' });
      }

      const passwordHash = await authMiddleware.hashPassword(password);

      dbClient = await db.getClient();
      await dbClient.query('BEGIN');

      const result = await dbClient.query(
        `INSERT INTO users (email, password_hash, dj_name, profile_completed, terms_accepted_at)
         VALUES ($1, $2, $3, TRUE, NOW())
         RETURNING id, email, dj_name, created_at`,
        [email.toLowerCase(), passwordHash, djName.trim()]
      );

      const user = result.rows[0];

      await dbClient.query(
        `INSERT INTO dj_profiles (user_id, dj_score, dj_rank)
         VALUES ($1, 0, 'Bedroom DJ')`,
        [user.id]
      );

      await dbClient.query('COMMIT');
      dbClient.release();
      dbClient = null;

      const token = authMiddleware.generateToken({
        userId: user.id,
        email: user.email
      });

      res.cookie('auth_token', token, {
        httpOnly: true,
        path: '/',
        secure: isHttpsRequest(req),
        maxAge: 7 * 24 * 60 * 60 * 1000,
        sameSite: 'lax'
      });

      res.status(201).json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          djName: user.dj_name,
          profileCompleted: true,
          createdAt: user.created_at
        }
      });
    } catch (error) {
      if (dbClient) {
        try { await dbClient.query('ROLLBACK'); } catch (rollbackErr) {
          console.error('[Auth] Signup transaction rollback failed:', rollbackErr.message);
        }
        dbClient.release();
        dbClient = null;
      }
      console.error('[Auth] Signup error:', error.code || error.message);
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Account already exists' });
      }
      const requestId = require('crypto').randomUUID();
      res.status(500).json({ error: 'Failed to create account', requestId });
    }
  });

  router.post("/auth/login", authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!authMiddleware.isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }

      if (deps.canUseLocalAuthFallback()) {
        const user = deps.localFallbackUsersByEmail.get(email.toLowerCase());
        if (!user) {
          return res.status(401).json({ error: 'Invalid email or password' });
        }

        const isValid = await authMiddleware.verifyPassword(password, user.passwordHash);
        if (!isValid) {
          return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = authMiddleware.generateToken({ userId: user.id, email: user.email, isAdmin: false });
        res.cookie('auth_token', token, {
          httpOnly: true,
          path: '/',
          secure: isHttpsRequest(req),
          maxAge: 7 * 24 * 60 * 60 * 1000,
          sameSite: 'lax'
        });

        return res.json({
          success: true,
          user: {
            id: user.id,
            email: user.email,
            djName: user.djName,
            isAdmin: false
          }
        });
      }

      const result = await db.query(
        'SELECT id, email, password_hash, dj_name, is_admin FROM users WHERE email = $1',
        [email.toLowerCase()]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const user = result.rows[0];

      const isValid = await authMiddleware.verifyPassword(password, user.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      await db.query(
        'UPDATE users SET last_login = NOW() WHERE id = $1',
        [user.id]
      );

      const isAdminByAllowlist = authMiddleware.isAdminEmail(user.email);
      const legacyBootstrapEmail = process.env.ADMIN_BOOTSTRAP_EMAIL
        ? process.env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase()
        : null;
      const shouldBeAdmin = isAdminByAllowlist || (legacyBootstrapEmail && user.email === legacyBootstrapEmail);
      if (shouldBeAdmin && !user.is_admin) {
        await db.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [user.id]);
        user.is_admin = true;
      }

      const token = authMiddleware.generateToken({
        userId: user.id,
        email: user.email,
        isAdmin: user.is_admin || false
      });

      res.cookie('auth_token', token, {
        httpOnly: true,
        path: '/',
        secure: isHttpsRequest(req),
        maxAge: 7 * 24 * 60 * 60 * 1000,
        sameSite: 'lax'
      });

      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          djName: user.dj_name,
          isAdmin: user.is_admin
        }
      });
    } catch (error) {
      console.error('[Auth] Login error:', error);
      res.status(500).json({ error: 'Failed to log in' });
    }
  });

  router.post("/auth/logout", apiLimiter, (req, res) => {
    res.clearCookie('auth_token', {
      path: '/',
      secure: isHttpsRequest(req),
      sameSite: 'lax',
      httpOnly: true
    });
    res.json({ success: true });
  });

  router.get('/feature-flags', apiLimiter, (req, res) => {
    return res.json({
      STREAMING_PARTY_ENABLED: isStreamingPartyEnabled()
    });
  });

  router.get("/me", apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      const userId = req.user.userId;

      if (deps.canUseLocalAuthFallback()) {
        const user = deps.localFallbackUsersById.get(userId);
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }
        return res.json(buildLocalFallbackMePayload(user));
      }

      const userResult = await db.query(
        `SELECT id, email, dj_name, created_at, profile_completed,
                tier, subscription_status, current_period_end,
                stripe_customer_id, stripe_subscription_id, is_admin
         FROM users WHERE id = $1`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult.rows[0];

      try {
        const presenceKey = `presence:user:${userId}`;
        await deps.redis.set(presenceKey, JSON.stringify({ lastSeen: Date.now(), tier: user.tier || 'FREE' }), 'EX', 120);
      } catch (_) { /* non-fatal */ }

      const profileResult = await db.query(
        `SELECT dj_score, dj_rank, active_visual_pack, active_title,
                verified_badge, crown_effect, animated_name, reaction_trail
         FROM dj_profiles WHERE user_id = $1`,
        [userId]
      );

      const profile = profileResult.rows[0] || {
        dj_score: 0,
        dj_rank: 'Bedroom DJ',
        active_visual_pack: null,
        active_title: null,
        verified_badge: false,
        crown_effect: false,
        animated_name: false,
        reaction_trail: false
      };

      const subResult = await db.query(
        `SELECT status, current_period_end
         FROM subscriptions
         WHERE user_id = $1 AND status = 'active'
         ORDER BY current_period_end DESC
         LIMIT 1`,
        [userId]
      );

      const hasProSubscription = subResult.rows.length > 0 &&
        new Date(subResult.rows[0].current_period_end) > new Date();

      const entitlementsResult = await db.query(
        'SELECT item_type, item_key FROM entitlements WHERE user_id = $1 AND owned = true',
        [userId]
      );

      const entitlements = entitlementsResult.rows;

      const upgrades = await db.getOrCreateUserUpgrades(userId);
      const { hasPartyPass, hasPro } = db.resolveEntitlements(upgrades);

      let tier = 'FREE';
      if (user.tier === 'PRO') {
        tier = 'PRO';
      } else if (hasPro) {
        tier = 'PRO_MONTHLY';
      } else if (hasPartyPass) {
        tier = 'PARTY_PASS';
      } else if (hasProSubscription) {
        tier = 'PRO';
      }

      const isAdmin = user.is_admin || req.user.isAdmin || false;
      const effectiveTier = isAdmin ? 'PRO' : tier;

      res.json({
        user: {
          id: user.id,
          email: user.email,
          djName: user.dj_name,
          createdAt: user.created_at,
          profileCompleted: user.profile_completed || false
        },
        isAdmin,
        tier,
        effectiveTier,
        upgrades: {
          partyPass: {
            expiresAt: upgrades.party_pass_expires_at
          },
          proMonthly: {
            active: upgrades.pro_monthly_active,
            startedAt: upgrades.pro_monthly_started_at,
            renewalProvider: upgrades.pro_monthly_renewal_provider
          }
        },
        entitlements: {
          hasPartyPass: isAdmin || hasPartyPass || tier === 'PRO',
          hasPro: isAdmin || hasPro || tier === 'PRO'
        },
        billing: {
          tier: user.tier || 'FREE',
          subscriptionStatus: user.subscription_status || null,
          currentPeriodEnd: user.current_period_end || null,
          stripeCustomerId: user.stripe_customer_id || null,
          stripeSubscriptionId: user.stripe_subscription_id || null
        },
        profile: {
          djScore: profile.dj_score,
          djRank: profile.dj_rank,
          activeVisualPack: profile.active_visual_pack,
          activeTitle: profile.active_title,
          verifiedBadge: profile.verified_badge,
          crownEffect: profile.crown_effect,
          animatedName: profile.animated_name,
          reactionTrail: profile.reaction_trail
        },
        ownedItems: entitlements.map(e => ({
          type: e.item_type,
          key: e.item_key
        }))
      });
    } catch (error) {
      console.error('[Auth] Get user error:', error);
      res.status(500).json({ error: 'Failed to get user info' });
    }
  });

  router.post("/complete-profile", apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { djName } = req.body;

      if (deps.canUseLocalAuthFallback()) {
        const user = deps.localFallbackUsersById.get(userId);
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }
        user.profileCompleted = true;
        if (djName && djName.trim()) {
          user.djName = djName.trim().substring(0, 50);
        }
        return res.json({ success: true, profileCompleted: true });
      }

      if (djName && djName.trim()) {
        await db.query(
          'UPDATE users SET profile_completed = TRUE, dj_name = $2 WHERE id = $1',
          [userId, djName.trim().substring(0, 50)]
        );
      } else {
        await db.query(
          'UPDATE users SET profile_completed = TRUE WHERE id = $1',
          [userId]
        );
      }

      res.json({ success: true, profileCompleted: true });
    } catch (error) {
      console.error('[Auth] Complete profile error:', error);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });

  router.post("/profile/update", apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { djName } = req.body;

      if (deps.canUseLocalAuthFallback()) {
        const user = deps.localFallbackUsersById.get(userId);
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }
        const trimmedLocal = typeof djName === 'string' ? djName.trim() : '';
        if (!trimmedLocal) {
          return res.status(400).json({ error: 'DJ name is required' });
        }
        if (trimmedLocal.length > DJ_NAME_MAX_LENGTH) {
          return res.status(400).json({ error: `DJ name must be ${DJ_NAME_MAX_LENGTH} characters or less` });
        }
        user.djName = trimmedLocal;
        user.profileCompleted = true;
        return res.json({ success: true, djName: trimmedLocal, profileCompleted: true });
      }

      const trimmed = typeof djName === 'string' ? djName.trim() : '';
      if (!trimmed) {
        return res.status(400).json({ error: 'DJ name is required' });
      }
      if (trimmed.length > DJ_NAME_MAX_LENGTH) {
        return res.status(400).json({ error: `DJ name must be ${DJ_NAME_MAX_LENGTH} characters or fewer` });
      }

      await db.query(
        'UPDATE users SET dj_name = $2 WHERE id = $1',
        [userId, trimmed]
      );

      res.json({ success: true, djName: trimmed });
    } catch (error) {
      console.error('[Auth] Profile update error:', error);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });

  router.get("/store", authMiddleware.optionalAuth, (req, res) => {
    const catalog = storeCatalog.getStoreCatalog();
    res.json(catalog);
  });

  router.get("/tier-info", (req, res) => {
    res.json({
      appName: "Phone Party",
      tiers: {
        FREE: {
          label: "Free",
          chatEnabled: false,
          autoMessages: false,
          guestQuickReplies: false,
          hostQuickMessages: false,
          systemAutoMessages: false,
          messageTtlMs: 0,
          maxTextLength: 0,
          queueLimit: 5,
          phoneLimit: 2,
          notes: [
            "2 phones maximum",
            "No chat or messaging features",
            "Basic DJ controls only",
            "Unlimited party time"
          ]
        },
        PARTY_PASS: {
          label: "Party Pass",
          price: "£3.99",
          chatEnabled: true,
          autoMessages: true,
          quickMessages: true,
          guestQuickReplies: true,
          hostQuickMessages: true,
          systemAutoMessages: true,
          messageTtlMs: 12000,
          maxTextLength: 60,
          maxEmojiLength: 10,
          queueLimit: 5,
          phoneLimit: 4,
          hostRateLimit: { minIntervalMs: 2000, maxPerMinute: 10 },
          guestRateLimit: { minIntervalMs: 2000, maxPerMinute: 15 },
          notes: [
            "Up to 4 phones",
            "2 hours duration",
            "Full messaging suite enabled",
            "Guest chat + emoji reactions",
            "DJ quick messages + emojis",
            "Auto party prompts",
            "Messages auto-disappear (12s)"
          ]
        },
        PRO_MONTHLY: {
          label: "Pro Monthly",
          price: "£9.99/mo",
          chatEnabled: true,
          autoMessages: true,
          quickMessages: true,
          cosmetics: true,
          profilePerks: true,
          phoneLimit: 10,
          queueLimit: 5,
          tierAvailable: true,
          notes: [
            "Up to 10 phones",
            "Unlimited party time",
            "Visual packs + DJ titles",
            "Profile upgrades",
            "All messaging features",
            "Priority support"
          ]
        }
      }
    });
  });

  /**
   * POST /api/auth/request-reset
   * Request a password reset code sent to the user's email.
   * Always returns a success-like message to avoid leaking whether an account exists.
   */
  router.post("/auth/request-reset", authLimiter, async (req, res) => {
    const crypto = require('crypto');
    // Generate a cryptographically secure 6-digit code.
    const generateResetCode = () => String(crypto.randomInt(100000, 1000000));

    try {
      const { email } = req.body || {};
      if (typeof email !== 'string' || !authMiddleware.isValidEmail(email)) {
        return res.status(400).json({ error: 'Please provide a valid email address.' });
      }

      const normalizedEmail = email.toLowerCase().trim();
      const RESET_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

      if (deps.canUseLocalAuthFallback()) {
        const user = deps.localFallbackUsersByEmail.get(normalizedEmail);
        if (user) {
          const code = generateResetCode();
          user.resetCode = code;
          user.resetCodeExpiry = Date.now() + RESET_CODE_TTL_MS;
          // In local/dev mode, surface the code directly so the flow can be tested.
          return res.json({
            success: true,
            message: 'If an account with that email exists, a reset code has been sent.',
            debugCode: code
          });
        }
        return res.json({
          success: true,
          message: 'If an account with that email exists, a reset code has been sent.'
        });
      }

      // Production path: look up the user and store a reset code.
      const userResult = await db.query(
        'SELECT id FROM users WHERE email = $1',
        [normalizedEmail]
      );

      if (userResult.rows.length > 0) {
        const userId = userResult.rows[0].id;
        const code = generateResetCode();
        const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS);

        await db.query(
          `UPDATE users SET reset_password_token = $1, reset_password_expires = $2 WHERE id = $3`,
          [code, expiresAt, userId]
        );

        // If an email service is configured, send the code here.
        // For now, log it (dev-only) and return a neutral message.
        const isProduction = process.env.NODE_ENV === 'production';
        if (!isProduction) {
          console.log(`[Auth] Password reset code for ${normalizedEmail}: ${code}`);
          return res.json({
            success: true,
            message: 'If an account with that email exists, a reset code has been sent.',
            debugCode: code
          });
        }

        // TODO: integrate email service to deliver the code to the user's inbox.
        console.log(`[Auth] Password reset requested for user ${userId} (email service not configured)`);
      }

      // Always return the same response whether or not the account was found.
      res.json({
        success: true,
        message: 'If an account with that email exists, a reset code has been sent.'
      });
    } catch (error) {
      console.error('[Auth] Request reset error:', error);
      res.status(500).json({ error: 'Failed to process reset request.' });
    }
  });

  /**
   * POST /api/auth/reset-password
   * Complete password reset using the code sent to the user.
   */
  router.post("/auth/reset-password", authLimiter, async (req, res) => {
    try {
      const { email, code, newPassword } = req.body || {};

      if (typeof email !== 'string' || !authMiddleware.isValidEmail(email)) {
        return res.status(400).json({ error: 'Please provide a valid email address.' });
      }
      if (typeof code !== 'string' || code.trim().length === 0) {
        return res.status(400).json({ error: 'Reset code is required.' });
      }
      if (!authMiddleware.isValidPassword(newPassword)) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
      }

      const normalizedEmail = email.toLowerCase().trim();
      const trimmedCode = code.trim();

      if (deps.canUseLocalAuthFallback()) {
        const user = deps.localFallbackUsersByEmail.get(normalizedEmail);
        if (!user || user.resetCode !== trimmedCode || !user.resetCodeExpiry || Date.now() > user.resetCodeExpiry) {
          return res.status(400).json({ error: 'Invalid or expired reset code.' });
        }

        const passwordHash = await authMiddleware.hashPassword(newPassword);
        user.passwordHash = passwordHash;
        delete user.resetCode;
        delete user.resetCodeExpiry;

        return res.json({ success: true });
      }

      const userResult = await db.query(
        `SELECT id, reset_password_token, reset_password_expires FROM users WHERE email = $1`,
        [normalizedEmail]
      );

      if (userResult.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid or expired reset code.' });
      }

      const user = userResult.rows[0];

      if (
        !user.reset_password_token ||
        user.reset_password_token !== trimmedCode ||
        !user.reset_password_expires ||
        new Date(user.reset_password_expires) < new Date()
      ) {
        return res.status(400).json({ error: 'Invalid or expired reset code.' });
      }

      const passwordHash = await authMiddleware.hashPassword(newPassword);

      // Update password and clear reset code atomically.
      await db.query(
        `UPDATE users SET password_hash = $1, reset_password_token = NULL, reset_password_expires = NULL WHERE id = $2`,
        [passwordHash, user.id]
      );

      res.json({ success: true });
    } catch (error) {
      console.error('[Auth] Reset password error:', error);
      res.status(500).json({ error: 'Failed to reset password.' });
    }
  });

  return router;
};
