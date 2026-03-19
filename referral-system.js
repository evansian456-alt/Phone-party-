/**
 * Referral Growth System
 *
 * Tracks invite referrals, enforces anti-fraud rules, and grants
 * temporary Party Pass / Pro rewards when milestones are reached.
 *
 * Milestone table:
 *  3  → 30 min Party Pass   (1800 seconds)
 *  5  → 1 hr  Party Pass   (3600 seconds)
 * 10  → 1 Party Pass session
 * 20  → 3 Party Pass sessions
 * 50  → 1 month Pro
 */

const crypto = require('crypto');
const { customAlphabet } = require('nanoid');

// Always use the canonical production domain for invite links.
// Never use window.location.origin, Railway URLs, or run.app URLs.
function getPublicBaseUrl() {
  return process.env.PUBLIC_BASE_URL || 'https://www.phone-party.com';
}

/**
 * Build an invite link in the canonical format:
 *   https://www.phone-party.com/signup?code=INVITE_CODE&inviter=USER_ID
 */
function buildInviteLink(inviteCode, inviterUserId) {
  const base = getPublicBaseUrl().replace(/\/$/, '');
  return `${base}/signup?code=${encodeURIComponent(inviteCode)}&inviter=${encodeURIComponent(inviterUserId)}`;
}

const generateCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 10);

// Milestones ordered ascending; each entry fires once per user.
const MILESTONES = [
  { at: 3,  type: 'PARTY_PASS_SECONDS',  seconds: 1800 },
  { at: 5,  type: 'PARTY_PASS_SECONDS',  seconds: 3600 },
  { at: 10, type: 'PARTY_PASS_SESSION',  sessions: 1   },
  { at: 20, type: 'PARTY_PASS_SESSION',  sessions: 3   },
  { at: 50, type: 'PRO_UNTIL',           proMonths: 1  },
];

const NEXT_MILESTONES = MILESTONES.map(m => m.at);

function nextMilestone(completed) {
  return NEXT_MILESTONES.find(m => m > completed) || null;
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 64);
}

/**
 * Resolve a user's display name from a DB row.
 * Priority: dj_name → email username → "Someone"
 */
function _resolveDisplayName(row) {
  if (!row) return 'Someone';
  if (row.dj_name && row.dj_name.trim()) return row.dj_name.trim();
  if (row.email && row.email.includes('@')) return row.email.split('@')[0];
  return 'Someone';
}

class ReferralSystem {
  constructor(db, redis) {
    this.db    = db;
    this.redis = redis;
  }

  // ─── Code management ───────────────────────────────────────────────────────

  /**
   * Return the user's referral code, creating one if necessary.
   */
  async getOrCreateCode(userId) {
    // Fast-path: code already stored on user row
    if (this.db) {
      const r = await this.db.query(
        'SELECT referral_code FROM users WHERE id = $1', [userId]
      );
      if (r.rows[0]?.referral_code) return r.rows[0].referral_code;
    }

    const code = generateCode();
    if (this.db) {
      await this.db.query(
        `UPDATE users SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL`,
        [code, userId]
      );
      // Re-read in case of concurrent update (idempotent)
      const r2 = await this.db.query(
        'SELECT referral_code FROM users WHERE id = $1', [userId]
      );
      return r2.rows[0]?.referral_code || code;
    }
    return code;
  }

  /**
   * Resolve a referral code → userId (DB lookup).
   */
  async codeToUserId(code) {
    if (!this.db) return null;
    const r = await this.db.query(
      'SELECT id FROM users WHERE referral_code = $1', [code]
    );
    return r.rows[0]?.id || null;
  }

  // ─── Click tracking ─────────────────────────────────────────────────────────

  /**
   * Record an invite-link click.  Returns the click_id UUID.
   */
  async recordClick(referralCode, ip, userAgent) {
    if (!this.db) return null;

    const ipHash       = ip        ? hashValue(ip)        : null;
    const uaHash       = userAgent ? hashValue(userAgent) : null;
    const inviterUserId = await this.codeToUserId(referralCode);
    if (!inviterUserId) return null;

    // Rate-limit: max 20 clicks per code per hour
    if (this.redis) {
      const key = `refclick:${referralCode}`;
      const cnt = await this.redis.incr(key);
      if (cnt === 1) await this.redis.expire(key, 3600);
      if (cnt > 20) return null;
    }

    const r = await this.db.query(
      `INSERT INTO referral_clicks (referral_code, ip_hash, user_agent_hash)
       VALUES ($1, $2, $3) RETURNING click_id`,
      [referralCode, ipHash, uaHash]
    );
    const clickId = r.rows[0]?.click_id;

    // Create a CLICKED referral record (no referred user yet)
    if (clickId) {
      await this.db.query(
        `INSERT INTO referrals (inviter_user_id, click_id, status, ip_hash)
         VALUES ($1, $2, 'CLICKED', $3)`,
        [inviterUserId, clickId, ipHash]
      );
    }
    return clickId;
  }

  // ─── Signup link ────────────────────────────────────────────────────────────

  /**
   * Called after a new user completes signup.
   * Links them to the inviter (at most once per account).
   * Returns false on abuse detection.
   */
  async registerReferral(referralCode, clickId, newUserId, newUserEmail, newUserIp) {
    if (!this.db) return { ok: false, reason: 'db_unavailable' };

    // Idempotency: each user can only be referred once
    const already = await this.db.query(
      'SELECT referred_by_user_id FROM users WHERE id = $1', [newUserId]
    );
    if (already.rows[0]?.referred_by_user_id) {
      return { ok: false, reason: 'already_registered' };
    }

    const inviterUserId = await this.codeToUserId(referralCode);
    if (!inviterUserId) return { ok: false, reason: 'invalid_code' };

    // Anti-fraud: no self-referral
    if (String(inviterUserId) === String(newUserId)) {
      return { ok: false, reason: 'self_referral' };
    }

    // Anti-fraud: check email match with inviter
    const inviterRow = await this.db.query(
      'SELECT email FROM users WHERE id = $1', [inviterUserId]
    );
    if (inviterRow.rows[0]?.email === newUserEmail) {
      return { ok: false, reason: 'same_email' };
    }

    // Anti-fraud: IP duplicate check (max 3 accounts per IP)
    const ipHash = newUserIp ? hashValue(newUserIp) : null;
    if (ipHash) {
      const ipCount = await this.db.query(
        `SELECT COUNT(*) FROM referrals
         WHERE inviter_user_id = $1 AND ip_hash = $2 AND status != 'REJECTED'`,
        [inviterUserId, ipHash]
      );
      if (parseInt(ipCount.rows[0].count, 10) >= 3) {
        return { ok: false, reason: 'ip_abuse' };
      }
    }

    // Anti-fraud: rate-limit per inviter (max 50 signups in 24h)
    if (this.redis) {
      const rKey = `refsignup:${inviterUserId}`;
      const cnt  = await this.redis.incr(rKey);
      if (cnt === 1) await this.redis.expire(rKey, 86400);
      if (cnt > 50)  return { ok: false, reason: 'rate_limited' };
    }

    // Link the referred_by on the new user and store attribution metadata
    await this.db.query(
      `UPDATE users
         SET referred_by_user_id = $1,
             invite_code_used    = $2,
             referral_source     = 'friend_invite',
             invited_at          = NOW()
       WHERE id = $3`,
      [inviterUserId, referralCode, newUserId]
    );

    // Update the referral row (CLICKED → SIGNED_UP)
    if (clickId) {
      await this.db.query(
        `UPDATE referrals
         SET referred_user_id = $1, status = 'SIGNED_UP'
         WHERE click_id = $2 AND inviter_user_id = $3`,
        [newUserId, clickId, inviterUserId]
      );
    } else {
      await this.db.query(
        `INSERT INTO referrals (inviter_user_id, referred_user_id, status, ip_hash)
         VALUES ($1, $2, 'SIGNED_UP', $3)`,
        [inviterUserId, newUserId, ipHash]
      );
    }

    return { ok: true, inviterUserId };
  }

  // ─── Stage progression ──────────────────────────────────────────────────────

  async markProfileDone(newUserId) {
    if (!this.db) return;
    await this.db.query(
      `UPDATE referrals SET status = 'PROFILE_DONE'
       WHERE referred_user_id = $1 AND status = 'SIGNED_UP'`,
      [newUserId]
    );
  }

  /**
   * Called when the referred user joins/creates their first party.
   * This is the final step that triggers the reward check.
   * Returns { rewarded, reward } if a new milestone was hit.
   */
  async markPartyJoined(newUserId) {
    if (!this.db) return { rewarded: false };

    // Anti-fraud: minimum time check – link must have been opened >= 60 seconds ago
    const referralRow = await this.db.query(
      `SELECT id, inviter_user_id, created_at
       FROM referrals
       WHERE referred_user_id = $1 AND status IN ('SIGNED_UP','PROFILE_DONE')
       ORDER BY created_at DESC LIMIT 1`,
      [newUserId]
    );
    if (!referralRow.rows.length) return { rewarded: false };

    const row = referralRow.rows[0];
    const ageSec = (Date.now() - new Date(row.created_at).getTime()) / 1000;
    if (ageSec < 60) {
      await this.db.query(
        `UPDATE referrals SET status = 'REJECTED', rejection_reason = 'too_fast'
         WHERE id = $1`, [row.id]
      );
      return { rewarded: false, reason: 'too_fast' };
    }

    // Mark completed
    await this.db.query(
      `UPDATE referrals SET status = 'COMPLETED', completed_at = NOW()
       WHERE id = $1`, [row.id]
    );

    // Increment inviter's referrals_completed atomically
    const updResult = await this.db.query(
      `UPDATE users SET referrals_completed = referrals_completed + 1
       WHERE id = $1 RETURNING referrals_completed`,
      [row.inviter_user_id]
    );
    const total = parseInt(updResult.rows[0]?.referrals_completed || 0, 10);

    // Check milestones and grant any newly reached ones
    const reward = await this._grantMilestoneRewards(row.inviter_user_id, total);
    return { rewarded: !!reward, reward, total };
  }

  // ─── Milestone rewards ──────────────────────────────────────────────────────

  async _grantMilestoneRewards(inviterUserId, totalCompleted) {
    let lastReward = null;
    for (const m of MILESTONES) {
      if (totalCompleted < m.at) continue;

      // Skip if already granted
      const existing = await this.db.query(
        `SELECT id FROM referral_rewards
         WHERE inviter_user_id = $1 AND milestone = $2`,
        [inviterUserId, m.at]
      );
      if (existing.rows.length) continue;

      // Grant the reward
      let insertQuery;
      if (m.type === 'PARTY_PASS_SECONDS') {
        insertQuery = this.db.query(
          `INSERT INTO referral_rewards
             (inviter_user_id, milestone, reward_type, amount_seconds)
           VALUES ($1,$2,$3,$4)`,
          [inviterUserId, m.at, m.type, m.seconds]
        );
        await this.db.query(
          `UPDATE users
           SET referral_reward_balance_seconds = referral_reward_balance_seconds + $1
           WHERE id = $2`,
          [m.seconds, inviterUserId]
        );
      } else if (m.type === 'PARTY_PASS_SESSION') {
        insertQuery = this.db.query(
          `INSERT INTO referral_rewards
             (inviter_user_id, milestone, reward_type, amount_sessions)
           VALUES ($1,$2,$3,$4)`,
          [inviterUserId, m.at, m.type, m.sessions]
        );
        await this.db.query(
          `UPDATE users
           SET referral_reward_balance_sessions = referral_reward_balance_sessions + $1
           WHERE id = $2`,
          [m.sessions, inviterUserId]
        );
      } else if (m.type === 'PRO_UNTIL') {
        // Use days-based calculation to avoid setMonth() edge cases near month boundaries
        const proUntil = new Date(Date.now() + m.proMonths * 30 * 24 * 60 * 60 * 1000);
        insertQuery = this.db.query(
          `INSERT INTO referral_rewards
             (inviter_user_id, milestone, reward_type, pro_until)
           VALUES ($1,$2,$3,$4)`,
          [inviterUserId, m.at, m.type, proUntil]
        );
        await this.db.query(
          `UPDATE users
           SET referral_reward_balance_pro_until =
             CASE
               WHEN referral_reward_balance_pro_until IS NULL OR
                    referral_reward_balance_pro_until < $1
               THEN $1
               ELSE referral_reward_balance_pro_until + interval '1 month'
             END
           WHERE id = $2`,
          [proUntil, inviterUserId]
        );
      }
      await insertQuery;
      lastReward = { milestone: m.at, type: m.type, ...m };
    }
    return lastReward;
  }

  // ─── Stats ──────────────────────────────────────────────────────────────────

  async getStats(userId) {
    const code = await this.getOrCreateCode(userId);
    const inviteUrl = buildInviteLink(code, userId);

    if (!this.db) {
      return {
        referralCode: code, inviteUrl, inviterName: null,
        referralsCompleted: 0,
        nextMilestone: MILESTONES[0].at,
        progressCurrent: 0, progressTarget: MILESTONES[0].at,
        progressPercent: 0,
        rewardBalanceSeconds: 0, rewardBalanceSessions: 0,
        proUntil: null, rewards: []
      };
    }

    const userRow = await this.db.query(
      `SELECT referrals_completed,
              referral_reward_balance_seconds,
              referral_reward_balance_sessions,
              referral_reward_balance_pro_until,
              dj_name,
              email
       FROM users WHERE id = $1`,
      [userId]
    );
    const u = userRow.rows[0] || {};
    const completed = parseInt(u.referrals_completed || 0, 10);
    const nm = nextMilestone(completed);
    const prev = nm ? (MILESTONES.find(m => m.at === nm)
      ? (MILESTONES[MILESTONES.findIndex(m => m.at === nm) - 1]?.at || 0)
      : 0) : MILESTONES[MILESTONES.length - 1].at;
    const progressTarget = nm || MILESTONES[MILESTONES.length - 1].at;
    const progressCurrent = completed - prev;
    const progressRange  = progressTarget - prev;
    const progressPercent = progressRange > 0
      ? Math.min(100, Math.round((progressCurrent / progressRange) * 100))
      : 100;

    // Resolve display name for invite messages
    const inviterName = _resolveDisplayName(u);

    const rewardsResult = await this.db.query(
      `SELECT milestone, reward_type, amount_seconds, amount_sessions, pro_until, created_at
       FROM referral_rewards WHERE inviter_user_id = $1 ORDER BY created_at`,
      [userId]
    );

    return {
      referralCode: code, inviteUrl, inviterName,
      referralsCompleted: completed,
      nextMilestone: nm,
      progressCurrent: completed,
      progressTarget,
      progressPercent,
      rewardBalanceSeconds:  parseInt(u.referral_reward_balance_seconds  || 0, 10),
      rewardBalanceSessions: parseInt(u.referral_reward_balance_sessions || 0, 10),
      proUntil: u.referral_reward_balance_pro_until || null,
      rewards:  rewardsResult.rows
    };
  }

  /**
   * Resolve the display name of an inviter given a referral code.
   * Returns { name, inviterUserId } or null if not found.
   */
  async resolveInviter(referralCode) {
    if (!this.db) return null;
    const r = await this.db.query(
      `SELECT id, dj_name, email FROM users WHERE referral_code = $1`,
      [referralCode]
    );
    if (!r.rows[0]) return null;
    return {
      inviterUserId: r.rows[0].id,
      name: _resolveDisplayName(r.rows[0]),
    };
  }

  // ─── Admin stats ────────────────────────────────────────────────────────────

  async getAdminStats() {
    if (!this.db) return {};
    try {
      const [total, today, topReferrers, rewardsToday, rewardsTotal, conversion] =
        await Promise.all([
          this.db.query(`SELECT COUNT(*) FROM referrals WHERE status = 'COMPLETED'`),
          this.db.query(
            `SELECT COUNT(*) FROM referrals
             WHERE status = 'COMPLETED' AND completed_at >= CURRENT_DATE`
          ),
          this.db.query(
            `SELECT inviter_user_id, COUNT(*) AS cnt
             FROM referrals WHERE status = 'COMPLETED'
             GROUP BY inviter_user_id ORDER BY cnt DESC LIMIT 10`
          ),
          this.db.query(
            `SELECT COUNT(*) FROM referral_rewards WHERE created_at >= CURRENT_DATE`
          ),
          this.db.query(`SELECT COUNT(*) FROM referral_rewards`),
          this.db.query(
            `SELECT
               COUNT(*) FILTER (WHERE status != 'CLICKED') * 100.0
                 / NULLIF(COUNT(*),0)                         AS click_to_signup,
               COUNT(*) FILTER (WHERE status IN ('PROFILE_DONE','COMPLETED')) * 100.0
                 / NULLIF(COUNT(*) FILTER (WHERE status != 'CLICKED'),0) AS signup_to_profile,
               COUNT(*) FILTER (WHERE status = 'COMPLETED') * 100.0
                 / NULLIF(COUNT(*) FILTER (WHERE status IN ('PROFILE_DONE','COMPLETED')),0)
                                                              AS profile_to_complete
             FROM referrals`
          ),
        ]);
      return {
        totalReferrals:        parseInt(total.rows[0].count, 10),
        referralsToday:        parseInt(today.rows[0].count, 10),
        topReferrers:          topReferrers.rows,
        rewardsGrantedToday:   parseInt(rewardsToday.rows[0].count, 10),
        rewardsGrantedTotal:   parseInt(rewardsTotal.rows[0].count, 10),
        referralConversionRates: {
          clickToSignup:     parseFloat(conversion.rows[0].click_to_signup   || 0).toFixed(1),
          signupToProfile:   parseFloat(conversion.rows[0].signup_to_profile || 0).toFixed(1),
          profileToComplete: parseFloat(conversion.rows[0].profile_to_complete || 0).toFixed(1),
        }
      };
    } catch (err) {
      console.error('[Referral] getAdminStats error:', err.message);
      return {};
    }
  }

  // ─── Reward consumption (called on party start) ─────────────────────────────

  /**
   * Consume referral reward seconds/sessions for a user starting a party.
   * Returns the tier they're entitled to (or null if none).
   */
  async consumeRewardForPartyStart(userId) {
    if (!this.db) return null;
    const r = await this.db.query(
      `SELECT referral_reward_balance_seconds,
              referral_reward_balance_sessions,
              referral_reward_balance_pro_until
       FROM users WHERE id = $1 FOR UPDATE`, [userId]
    );
    const u = r.rows[0];
    if (!u) return null;

    const proUntil   = u.referral_reward_balance_pro_until;
    const seconds    = parseInt(u.referral_reward_balance_seconds  || 0, 10);
    const sessions   = parseInt(u.referral_reward_balance_sessions || 0, 10);

    if (proUntil && new Date(proUntil) > new Date()) return 'pro';
    if (seconds > 0) return 'party_pass_timed';
    if (sessions > 0) {
      await this.db.query(
        `UPDATE users SET referral_reward_balance_sessions = referral_reward_balance_sessions - 1
         WHERE id = $1`, [userId]
      );
      return 'party_pass_session';
    }
    return null;
  }
}

module.exports = { ReferralSystem, MILESTONES, nextMilestone, getPublicBaseUrl, buildInviteLink };
