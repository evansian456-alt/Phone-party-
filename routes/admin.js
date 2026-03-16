'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');

/**
 * Generate a random promo code string: e.g. "PROMO-A3K7BZ2Q"
 */
function generatePromoCodeString() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  let result = 'PROMO-';
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

module.exports = function createAdminRouter(deps) {
  const {
    db, redis, authMiddleware, metricsService, referralSystem,
    apiLimiter, parties, INSTANCE_ID, _heartbeatStore
  } = deps;

  const router = express.Router();

  const APP_VERSION = process.env.APP_VERSION || 'unknown';

  // Use the heartbeat store passed via deps, or a local fallback Map
  const heartbeatStore = _heartbeatStore instanceof Map ? _heartbeatStore : new Map();

  function isRedisReady() {
    try {
      return redis && redis.status === 'ready';
    } catch (_) {
      return false;
    }
  }

  // ============================================================================
  // ADMIN & ANALYTICS ENDPOINTS
  // ============================================================================

  // Admin metrics dashboard — protected by requireAdmin (JWT with isAdmin flag)
  router.get("/admin/metrics", rateLimit({ windowMs: 60000, max: 30 }), authMiddleware.requireAdmin, async (req, res) => {
    try {
      if (!metricsService) {
        return res.status(503).json({ error: 'Metrics service not available' });
      }

      const metrics = await metricsService.getMetrics();

      return res.json({
        timestamp: new Date().toISOString(),
        metrics
      });
    } catch (error) {
      console.error('[Admin] Error getting metrics:', error.message);
      return res.status(500).json({ error: 'Failed to retrieve metrics' });
    }
  });

  /**
   * GET /api/admin/stats
   * Live admin dashboard stats — protected with requireAdmin middleware.
   */
  router.get("/api/admin/stats", rateLimit({ windowMs: 60000, max: 60 }), authMiddleware.requireAdmin, async (req, res) => {
    const startTime = Date.now();
    let dbHealth = 'ok';
    let redisHealth = 'ok';

    try {
      // DB health ping
      try { await db.query('SELECT 1'); } catch (_) { dbHealth = 'down'; }

      // Redis health ping
      try { await redis.ping(); } catch (_) { redisHealth = 'down'; }

      // ── User stats ──────────────────────────────────────────────────────────
      const usersResult = await db.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE profile_completed = true) AS profiles_completed,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS new_last_24h,
          COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '24 hours') AS active_last_24h
        FROM users
      `);
      const ur = usersResult.rows[0];

      // ── Tier breakdown ──────────────────────────────────────────────────────
      const tiersResult = await db.query(`
        SELECT tier, COUNT(*) AS cnt FROM users GROUP BY tier
      `);
      const tiers = { FREE: 0, PARTY_PASS: 0, PRO: 0 };
      for (const row of tiersResult.rows) {
        const k = row.tier || 'FREE';
        tiers[k] = (tiers[k] || 0) + parseInt(row.cnt, 10);
      }

      // ── Purchases ───────────────────────────────────────────────────────────
      let purchasesData = {
        tierPurchasesTotal: 0,
        addonPurchasesTotal: 0,
        bySku: {},
        revenueCentsLast30d: 0
      };
      try {
        const purchResult = await db.query(`
          SELECT
            COALESCE(type, purchase_kind) AS ptype,
            COALESCE(sku, item_key) AS psku,
            COUNT(*) AS cnt,
            COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN amount_cents ELSE 0 END), 0) AS rev30d
          FROM purchases
          GROUP BY 1, 2
        `);
        for (const row of purchResult.rows) {
          const cnt = parseInt(row.cnt, 10);
          const sku = row.psku || 'unknown';
          purchasesData.bySku[sku] = (purchasesData.bySku[sku] || 0) + cnt;
          purchasesData.revenueCentsLast30d += parseInt(row.rev30d, 10) || 0;
          if (row.ptype === 'tier') purchasesData.tierPurchasesTotal += cnt;
          else purchasesData.addonPurchasesTotal += cnt;
        }
      } catch (_) { /* purchases table may have different schema */ }

      // ── Live presence (Redis) ───────────────────────────────────────────────
      let onlineUsers = 0;
      let activeParties = 0;
      let activeHosts = 0;
      let activeGuests = 0;
      try {
        // Use SCAN instead of KEYS to avoid blocking Redis in production
        const presenceKeys = [];
        let cursor = '0';
        do {
          const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'presence:user:*', 'COUNT', 100);
          cursor = nextCursor;
          presenceKeys.push(...keys);
        } while (cursor !== '0');

        onlineUsers = presenceKeys.length;
        const partyCodes = new Set();
        for (const k of presenceKeys) {
          try {
            const raw = await redis.get(k);
            if (raw) {
              const data = JSON.parse(raw);
              if (data.partyCode) {
                partyCodes.add(data.partyCode);
                if (data.isHost) activeHosts++;
                else activeGuests++;
              }
            }
          } catch (_) { /* skip bad keys */ }
        }
        activeParties = partyCodes.size;
      } catch (_) { /* Redis may be unavailable */ }

      // ── Active users (heartbeat – last 5 minutes) ───────────────────────────
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      let activeUsersNow = 0;
      try {
        for (const ts of heartbeatStore.values()) {
          if (ts instanceof Date && ts.getTime() > fiveMinAgo) activeUsersNow++;
          else if (typeof ts === 'number' && ts > fiveMinAgo) activeUsersNow++;
        }
        // Also check Redis heartbeat keys if available
        if (isRedisReady()) {
          const hbKeys = [];
          let cur = '0';
          do {
            const [next, keys] = await redis.scan(cur, 'MATCH', 'heartbeat:*', 'COUNT', 100);
            cur = next;
            hbKeys.push(...keys);
          } while (cur !== '0');
          // Count unique users (may overlap with in-memory store – use a Set)
          const seen = new Set(Array.from(heartbeatStore.entries())
            .filter(([, ts]) => (ts instanceof Date ? ts.getTime() : ts) > fiveMinAgo)
            .map(([uid]) => uid));
          for (const k of hbKeys) {
            const uid = k.replace('heartbeat:', '');
            if (!seen.has(uid)) {
              const val = await redis.get(k);
              if (val && Number(val) > fiveMinAgo) { seen.add(uid); activeUsersNow++; }
            }
          }
        }
      } catch (_) { /* non-fatal */ }

      // ── Revenue stats ───────────────────────────────────────────────────────
      let revenueTotal = 0;
      let revenueToday = 0;
      let topProducts = [];
      let recentPurchases = [];
      try {
        const revTotalResult = await db.query(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM purchases`
        );
        revenueTotal = parseInt(revTotalResult.rows[0]?.total || 0, 10);
      } catch (_) { /* table may not have amount_cents */ }
      try {
        const revTodayResult = await db.query(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM purchases WHERE created_at >= CURRENT_DATE`
        );
        revenueToday = parseInt(revTodayResult.rows[0]?.total || 0, 10);
      } catch (_) { /* non-fatal */ }
      try {
        const topResult = await db.query(
          `SELECT COALESCE(sku, item_key, product_key) AS key, COUNT(*) AS cnt
           FROM purchases GROUP BY 1 ORDER BY cnt DESC LIMIT 10`
        );
        topProducts = topResult.rows.map(r => ({ key: r.key, count: parseInt(r.cnt, 10) }));
      } catch (_) { /* non-fatal */ }
      try {
        const recentResult = await db.query(
          `SELECT id, user_id, COALESCE(sku, item_key, product_key) AS key,
                  provider, created_at
           FROM purchases ORDER BY created_at DESC LIMIT 20`
        );
        recentPurchases = recentResult.rows.map(r => ({
          id: r.id,
          userId: r.user_id,
          key: r.key,
          provider: r.provider,
          createdAt: r.created_at
        }));
      } catch (_) { /* non-fatal */ }

      // ── Referral stats ──────────────────────────────────────────────────────
      let referralStats = {};
      try {
        if (referralSystem) {
          referralStats = await referralSystem.getAdminStats();
        }
      } catch (_) { /* non-fatal */ }

      return res.json({
        serverTime: new Date().toISOString(),
        // Flat fields required by the spec
        totalUsers: parseInt(ur.total, 10),
        activeUsersNow,
        partyPassUsers: tiers.PARTY_PASS || 0,
        proUsers: tiers.PRO || 0,
        revenueTotal,
        revenueToday,
        topProducts,
        recentPurchases,
        // Existing nested fields (kept for backwards compatibility)
        users: {
          total: parseInt(ur.total, 10),
          profilesCompleted: parseInt(ur.profiles_completed, 10),
          newLast24h: parseInt(ur.new_last_24h, 10),
          activeLast24h: parseInt(ur.active_last_24h, 10)
        },
        live: {
          onlineUsers,
          activeParties,
          activeHosts,
          activeGuests
        },
        tiers,
        purchases: purchasesData,
        referrals: referralStats,
        health: {
          db: dbHealth,
          redis: redisHealth,
          uptimeSec: Math.floor(process.uptime()),
          version: APP_VERSION
        }
      });
    } catch (error) {
      console.error('[Admin] Error getting stats:', error.message);
      return res.status(500).json({ error: 'Failed to retrieve admin stats' });
    }
  });

  /**
   * GET /api/admin/recent
   * Recent signups and logins — protected with requireAdmin middleware.
   * Returns only non-PII data (user IDs and timestamps, no emails).
   */
  router.get("/api/admin/recent", rateLimit({ windowMs: 60000, max: 60 }), authMiddleware.requireAdmin, async (req, res) => {
    try {
      const signupsResult = await db.query(
        `SELECT id, created_at FROM users ORDER BY created_at DESC LIMIT 25`
      );
      const loginsResult = await db.query(
        `SELECT id, last_login AS last_login_at FROM users WHERE last_login IS NOT NULL ORDER BY last_login DESC LIMIT 25`
      );

      return res.json({
        signups: signupsResult.rows.map(r => ({ id: r.id, createdAt: r.created_at })),
        logins: loginsResult.rows.map(r => ({ id: r.id, lastLoginAt: r.last_login_at }))
      });
    } catch (error) {
      console.error('[Admin] Error getting recent activity:', error.message);
      return res.status(500).json({ error: 'Failed to retrieve recent activity' });
    }
  });

  // ============================================================================
  // MODERATION ENDPOINTS
  // ============================================================================

  /**
   * POST /api/report
   * Submit a user report (track, message, user, party).
   * Any authenticated or guest user can submit a report.
   */
  router.post('/api/report', apiLimiter, authMiddleware.optionalAuth, async (req, res) => {
    try {
      const { type, targetId, partyId, reportedUserId, reason, description, evidence } = req.body;

      if (!type || !['track', 'message', 'user', 'party'].includes(type)) {
        return res.status(400).json({ error: 'Invalid report type' });
      }
      if (!targetId) return res.status(400).json({ error: 'targetId is required' });
      if (!reason) return res.status(400).json({ error: 'reason is required' });

      const reporterUserId = req.user ? req.user.id : null;

      await db.query(
        `INSERT INTO reports
           (type, target_id, party_id, reporter_user_id, reported_user_id, reason, description, evidence_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          type,
          String(targetId).slice(0, 500),
          partyId ? String(partyId).slice(0, 20) : null,
          reporterUserId,
          reportedUserId ? String(reportedUserId).slice(0, 500) : null,
          String(reason).slice(0, 200),
          description ? String(description).slice(0, 2000) : null,
          evidence ? JSON.stringify(evidence) : null
        ]
      );

      console.log(`[Moderation] Report submitted: type=${type} target=${targetId} reason=${reason}`);
      return res.json({ success: true, message: 'Report submitted. Our team will review it.' });
    } catch (error) {
      console.error('[Moderation] Error submitting report:', error.message);
      return res.status(500).json({ error: 'Failed to submit report' });
    }
  });

  /**
   * POST /api/moderation/flag-message
   * Internal endpoint: abuse filter flags a message for admin review.
   * No auth required (called from client-side filter).
   */
  router.post('/api/moderation/flag-message', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
    try {
      const { userId, partyId, messageText, filterReason, severity } = req.body;

      if (!filterReason) return res.status(400).json({ error: 'filterReason is required' });

      await db.query(
        `INSERT INTO message_moderation_events
           (user_id, party_id, message_text, filter_reason, severity)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          userId ? String(userId).slice(0, 500) : null,
          partyId ? String(partyId).slice(0, 20) : null,
          messageText ? String(messageText).slice(0, 2000) : null,
          String(filterReason).slice(0, 100),
          severity && ['mild', 'severe'].includes(severity) ? severity : 'mild'
        ]
      );

      return res.json({ success: true });
    } catch (error) {
      console.error('[Moderation] Error flagging message:', error.message);
      return res.status(500).json({ error: 'Failed to flag message' });
    }
  });

  /**
   * GET /api/admin/moderation/reports
   * Admin: view all reports with optional status/type filter.
   */
  router.get('/api/admin/moderation/reports', rateLimit({ windowMs: 60000, max: 60 }), authMiddleware.requireAdmin, async (req, res) => {
    try {
      const { status, type, limit = 50, offset = 0 } = req.query;
      const conditions = [];
      const params = [];

      if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status); }
      if (type) { conditions.push(`type = $${params.length + 1}`); params.push(type); }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await db.query(
        `SELECT r.*,
                umh.warning_count, umh.suspension_count, umh.ban_status
         FROM reports r
         LEFT JOIN user_moderation_history umh ON umh.user_id = r.reported_user_id
         ${where}
         ORDER BY r.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, parseInt(limit, 10) || 50, parseInt(offset, 10) || 0]
      );

      return res.json({ reports: result.rows });
    } catch (error) {
      console.error('[Moderation] Error fetching reports:', error.message);
      return res.status(500).json({ error: 'Failed to fetch reports' });
    }
  });

  /**
   * GET /api/admin/moderation/flagged-messages
   * Admin: view auto-flagged messages.
   */
  router.get('/api/admin/moderation/flagged-messages', rateLimit({ windowMs: 60000, max: 60 }), authMiddleware.requireAdmin, async (req, res) => {
    try {
      const { status, severity, limit = 50, offset = 0 } = req.query;
      const conditions = [];
      const params = [];

      if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status); }
      if (severity) { conditions.push(`severity = $${params.length + 1}`); params.push(severity); }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await db.query(
        `SELECT * FROM message_moderation_events
         ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, parseInt(limit, 10) || 50, parseInt(offset, 10) || 0]
      );

      return res.json({ flaggedMessages: result.rows });
    } catch (error) {
      console.error('[Moderation] Error fetching flagged messages:', error.message);
      return res.status(500).json({ error: 'Failed to fetch flagged messages' });
    }
  });

  /**
   * GET /api/admin/moderation/user-history/:userId
   * Admin: view moderation history for a specific user.
   */
  router.get('/api/admin/moderation/user-history/:userId', rateLimit({ windowMs: 60000, max: 60 }), authMiddleware.requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const histResult = await db.query(
        `SELECT * FROM user_moderation_history WHERE user_id = $1`, [userId]
      );
      const reportsResult = await db.query(
        `SELECT * FROM reports WHERE reported_user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]
      );

      return res.json({
        history: histResult.rows[0] || null,
        reports: reportsResult.rows
      });
    } catch (error) {
      console.error('[Moderation] Error fetching user history:', error.message);
      return res.status(500).json({ error: 'Failed to fetch user history' });
    }
  });

  /**
   * POST /api/admin/moderation/action
   * Admin: take action on a report or user.
   * Actions: dismiss, warn, suspend, ban, remove_track, delete_message, mark_resolved
   */
  router.post('/api/admin/moderation/action', rateLimit({ windowMs: 60000, max: 60 }), authMiddleware.requireAdmin, async (req, res) => {
    try {
      const { reportId, flaggedMessageId, targetUserId, action, reason } = req.body;
      const adminId = req.user.id;

      const validActions = ['dismiss', 'warn', 'suspend', 'ban', 'remove_track', 'delete_message', 'mark_resolved'];
      if (!action || !validActions.includes(action)) {
        return res.status(400).json({ error: 'Invalid action' });
      }

      // Update report status if reportId provided
      if (reportId) {
        await db.query(
          `UPDATE reports SET status = $1, reviewed_by = $2, reviewed_at = NOW(), admin_action = $3 WHERE id = $4`,
          [
            ['dismiss'].includes(action) ? 'dismissed' : 'actioned',
            adminId,
            action,
            reportId
          ]
        );
      }

      // Update flagged message status if provided
      if (flaggedMessageId) {
        await db.query(
          `UPDATE message_moderation_events SET status = $1 WHERE id = $2`,
          [action === 'dismiss' ? 'dismissed' : 'reviewed', flaggedMessageId]
        );
      }

      // Apply user-level action (warn/suspend/ban) — admin only
      if (targetUserId && ['warn', 'suspend', 'ban'].includes(action)) {
        // Upsert moderation history
        await db.query(
          `INSERT INTO user_moderation_history (user_id, warning_count, suspension_count, ban_status, ban_reason, last_action_at, last_action_by)
           VALUES ($1,
             CASE WHEN $2 = 'warn' THEN 1 ELSE 0 END,
             CASE WHEN $2 = 'suspend' THEN 1 ELSE 0 END,
             CASE WHEN $2 = 'ban' THEN 'banned' WHEN $2 = 'suspend' THEN 'suspended' ELSE 'none' END,
             $3, NOW(), $4)
           ON CONFLICT (user_id) DO UPDATE SET
             warning_count = user_moderation_history.warning_count + CASE WHEN $2 = 'warn' THEN 1 ELSE 0 END,
             suspension_count = user_moderation_history.suspension_count + CASE WHEN $2 = 'suspend' THEN 1 ELSE 0 END,
             ban_status = CASE WHEN $2 = 'ban' THEN 'banned' WHEN $2 = 'suspend' THEN 'suspended' ELSE user_moderation_history.ban_status END,
             ban_reason = COALESCE($3, user_moderation_history.ban_reason),
             last_action_at = NOW(),
             last_action_by = $4,
             updated_at = NOW()`,
          [targetUserId, action, reason ? String(reason).slice(0, 500) : null, adminId]
        );
      }

      const messages = {
        dismiss: 'Report dismissed',
        warn: 'User warned',
        suspend: 'User suspended',
        ban: 'User banned',
        remove_track: 'Track removed',
        delete_message: 'Message deleted',
        mark_resolved: 'Report marked as resolved'
      };

      console.log(`[Moderation] Admin action: ${action} on report=${reportId || '-'} user=${targetUserId || '-'} by admin=${adminId}`);
      return res.json({ success: true, message: messages[action] || 'Action completed' });
    } catch (error) {
      console.error('[Moderation] Error applying admin action:', error.message);
      return res.status(500).json({ error: 'Failed to apply action' });
    }
  });

  // ─── Admin Promo Code Endpoints ───────────────────────────────────────────────

  /**
   * POST /api/admin/promo-codes
   * Generate a new one-time-use promo code (party_pass or pro_monthly).
   * Body: { type: 'party_pass' | 'pro_monthly' }
   */
  router.post('/api/admin/promo-codes', rateLimit({ windowMs: 60000, max: 60 }), authMiddleware.requireAdmin, async (req, res) => {
    try {
      const { type } = req.body;
      if (!type || !['party_pass', 'pro_monthly'].includes(type)) {
        return res.status(400).json({ error: "type must be 'party_pass' or 'pro_monthly'" });
      }

      const code = generatePromoCodeString();
      const adminId = req.user.id || req.user.userId;

      await db.query(
        `INSERT INTO promo_codes (code, type, created_by) VALUES ($1, $2, $3)`,
        [code, type, adminId || null]
      );

      console.log(`[Admin] Promo code generated: ${code} (${type}) by admin ${adminId}`);
      return res.status(201).json({ ok: true, code, type });
    } catch (error) {
      console.error('[Admin] Error generating promo code:', error.message);
      return res.status(500).json({ error: 'Failed to generate promo code' });
    }
  });

  /**
   * GET /api/admin/promo-codes
   * List all admin-generated promo codes with their usage status.
   */
  router.get('/api/admin/promo-codes', rateLimit({ windowMs: 60000, max: 60 }), authMiddleware.requireAdmin, async (req, res) => {
    try {
      const result = await db.query(
        `SELECT pc.id, pc.code, pc.type, pc.is_used, pc.used_at, pc.created_at,
                creator.email AS created_by_email,
                usedby.email  AS used_by_email
         FROM promo_codes pc
         LEFT JOIN users creator ON creator.id = pc.created_by
         LEFT JOIN users usedby  ON usedby.id  = pc.used_by
         ORDER BY pc.created_at DESC
         LIMIT 200`
      );
      return res.json({ ok: true, promoCodes: result.rows });
    } catch (error) {
      console.error('[Admin] Error listing promo codes:', error.message);
      return res.status(500).json({ error: 'Failed to list promo codes' });
    }
  });

  return router;
};
