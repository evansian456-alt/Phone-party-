/**
 * Referral Growth System
 *
 * Tracks invite referrals, enforces anti-fraud rules, and grants
 * temporary Party Pass / Pro rewards when milestones are reached.
 */

const crypto = require('crypto');
const { customAlphabet } = require('nanoid');
const {
  getPublicBaseUrl,
  buildInviteLink,
  resolveInviterName,
} = require('./invite-utils');

const generateCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 10);

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

class ReferralSystem {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
  }

  async getOrCreateCode(userId) {
    if (this.db) {
      const r = await this.db.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
      if (r.rows[0]?.referral_code) return r.rows[0].referral_code;
    }

    const code = generateCode();
    if (this.db) {
      await this.db.query(
        'UPDATE users SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL',
        [code, userId]
      );
      const r2 = await this.db.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
      return r2.rows[0]?.referral_code || code;
    }
    return code;
  }

  async codeToUserId(code) {
    if (!this.db) return null;
    const r = await this.db.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    return r.rows[0]?.id || null;
  }

  async getInviteDetails(referralCode, inviterId) {
    if (!this.db || !referralCode) return null;
    const params = [referralCode];
    let sql = `SELECT u.id, u.email, u.dj_name, dp.active_title
               FROM users u
               LEFT JOIN dj_profiles dp ON dp.user_id = u.id
               WHERE u.referral_code = $1`;
    if (inviterId) {
      params.push(inviterId);
      sql += ' AND u.id = $2';
    }
    const r = await this.db.query(sql, params);
    const inviter = r.rows[0];
    if (!inviter) return null;
    const inviterName = resolveInviterName({
      displayName: inviter.dj_name,
      profile: { name: inviter.active_title || '' },
      firstName: null,
      email: inviter.email,
    });
    return {
      inviterId: inviter.id,
      inviterName,
      inviteCode: referralCode,
      inviteUrl: buildInviteLink(referralCode, inviter.id, { publicBaseUrl: process.env.PUBLIC_BASE_URL }),
    };
  }

  async recordClick(referralCode, ip, userAgent) {
    if (!this.db) return null;

    const ipHash = ip ? hashValue(ip) : null;
    const uaHash = userAgent ? hashValue(userAgent) : null;
    const inviterUserId = await this.codeToUserId(referralCode);
    if (!inviterUserId) return null;

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

    if (clickId) {
      await this.db.query(
        `INSERT INTO referrals (inviter_user_id, click_id, status, ip_hash)
         VALUES ($1, $2, 'CLICKED', $3)`,
        [inviterUserId, clickId, ipHash]
      );
    }
    return clickId;
  }

  async registerReferral(referralCode, clickId, newUserId, newUserEmail, newUserIp, options = {}) {
    if (!this.db) return { ok: false, reason: 'db_unavailable' };

    const normalizedCode = String(referralCode || '').trim().toUpperCase();
    if (!normalizedCode) return { ok: false, reason: 'invalid_code' };

    const already = await this.db.query(
      'SELECT referred_by_user_id FROM users WHERE id = $1',
      [newUserId]
    );
    if (already.rows[0]?.referred_by_user_id) {
      return { ok: false, reason: 'already_registered' };
    }

    const inviterUserId = await this.codeToUserId(normalizedCode);
    if (!inviterUserId) return { ok: false, reason: 'invalid_code' };
    if (options.inviterId && String(options.inviterId) !== String(inviterUserId)) {
      return { ok: false, reason: 'inviter_mismatch' };
    }
    if (String(inviterUserId) === String(newUserId)) {
      return { ok: false, reason: 'self_referral' };
    }

    const inviterRow = await this.db.query('SELECT email FROM users WHERE id = $1', [inviterUserId]);
    if (inviterRow.rows[0]?.email === newUserEmail) {
      return { ok: false, reason: 'same_email' };
    }

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

    const deviceHash = options.deviceFingerprint ? hashValue(options.deviceFingerprint) : null;
    if (deviceHash) {
      const deviceDup = await this.db.query(
        `SELECT COUNT(*) FROM users
         WHERE referred_by_user_id = $1 AND signup_device_fingerprint = $2`,
        [inviterUserId, deviceHash]
      );
      if (parseInt(deviceDup.rows[0]?.count || 0, 10) >= 1) {
        return { ok: false, reason: 'device_abuse' };
      }
    }

    if (this.redis) {
      const rKey = `refsignup:${inviterUserId}`;
      const cnt = await this.redis.incr(rKey);
      if (cnt === 1) await this.redis.expire(rKey, 86400);
      if (cnt > 50) return { ok: false, reason: 'rate_limited' };
    }

    await this.db.query(
      `UPDATE users
       SET referred_by_user_id = $1,
           invite_code_used = $2,
           referral_source = 'friend_invite',
           invited_at = NOW(),
           signup_device_fingerprint = COALESCE(signup_device_fingerprint, $3)
       WHERE id = $4`,
      [inviterUserId, normalizedCode, deviceHash, newUserId]
    );

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

    const counts = await this.db.query(
      `UPDATE users
       SET referral_count = COALESCE(referral_count, 0) + 1
       WHERE id = $1
       RETURNING referral_count`,
      [inviterUserId]
    );

    return {
      ok: true,
      inviterUserId,
      referralCount: parseInt(counts.rows[0]?.referral_count || 0, 10),
    };
  }

  async markProfileDone(newUserId) {
    if (!this.db) return;
    await this.db.query(
      `UPDATE referrals SET status = 'PROFILE_DONE'
       WHERE referred_user_id = $1 AND status = 'SIGNED_UP'`,
      [newUserId]
    );
  }

  async markPartyJoined(newUserId) {
    if (!this.db) return { rewarded: false };

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

    await this.db.query(
      `UPDATE referrals SET status = 'COMPLETED', completed_at = NOW()
       WHERE id = $1`, [row.id]
    );

    const updResult = await this.db.query(
      `UPDATE users SET referrals_completed = referrals_completed + 1
       WHERE id = $1 RETURNING referrals_completed`,
      [row.inviter_user_id]
    );
    await this.db.query(
      `UPDATE users SET successful_invites = COALESCE(successful_invites, 0) + 1
       WHERE id = $1`,
      [row.inviter_user_id]
    );
    const total = parseInt(updResult.rows[0]?.referrals_completed || 0, 10);
    const successfulInvites = total;

    const reward = await this._grantMilestoneRewards(row.inviter_user_id, total);
    return {
      rewarded: !!reward,
      reward,
      total,
      successfulInvites,
      activity: 'A friend joined your invite and counted toward your progress.'
    };
  }

  async _grantMilestoneRewards(inviterUserId, totalCompleted) {
    let lastReward = null;
    for (const m of MILESTONES) {
      if (totalCompleted < m.at) continue;

      const existing = await this.db.query(
        `SELECT id FROM referral_rewards
         WHERE inviter_user_id = $1 AND milestone = $2`,
        [inviterUserId, m.at]
      );
      if (existing.rows.length) continue;

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

  async getStats(userId) {
    const code = await this.getOrCreateCode(userId);
    const userSummary = await this.db?.query(
      `SELECT id, email, dj_name, referrals_completed,
              referral_count, successful_invites,
              referral_reward_balance_seconds,
              referral_reward_balance_sessions,
              referral_reward_balance_pro_until
       FROM users WHERE id = $1`,
      [userId]
    );
    const u = userSummary?.rows?.[0] || {};
    const completed = parseInt(u.referrals_completed || 0, 10);
    const nm = nextMilestone(completed);
    const prev = nm ? (MILESTONES[MILESTONES.findIndex(m => m.at === nm) - 1]?.at || 0) : MILESTONES[MILESTONES.length - 1].at;
    const progressTarget = nm || MILESTONES[MILESTONES.length - 1].at;
    const progressRange = Math.max(1, progressTarget - prev);
    const progressCurrent = completed - prev;
    const progressPercent = Math.min(100, Math.round((progressCurrent / progressRange) * 100));
    const inviterName = resolveInviterName({ displayName: u.dj_name, email: u.email });
    const inviteUrl = buildInviteLink(code, userId, { publicBaseUrl: process.env.PUBLIC_BASE_URL });

    if (!this.db) {
      return {
        referralCode: code,
        inviteUrl,
        inviterName,
        referralsCompleted: 0,
        referralCount: 0,
        successfulInvites: 0,
        friendsJoined: 0,
        nextMilestone: MILESTONES[0].at,
        progressCurrent: 0,
        progressTarget: MILESTONES[0].at,
        progressPercent: 0,
        rewardBalanceSeconds: 0,
        rewardBalanceSessions: 0,
        proUntil: null,
        rewards: [],
        recentReferrals: []
      };
    }

    const rewardsResult = await this.db.query(
      `SELECT milestone, reward_type, amount_seconds, amount_sessions, pro_until, created_at
       FROM referral_rewards WHERE inviter_user_id = $1 ORDER BY created_at`,
      [userId]
    );
    const recentReferrals = await this.db.query(
      `SELECT status, completed_at, created_at
       FROM referrals
       WHERE inviter_user_id = $1
       ORDER BY COALESCE(completed_at, created_at) DESC
       LIMIT 5`,
      [userId]
    );

    return {
      referralCode: code,
      inviteUrl,
      inviterName,
      referralsCompleted: completed,
      referralCount: parseInt(u.referral_count || 0, 10),
      successfulInvites: parseInt(u.successful_invites || completed, 10),
      friendsJoined: parseInt(u.successful_invites || completed, 10),
      nextMilestone: nm,
      progressCurrent: completed,
      progressTarget,
      progressPercent,
      rewardBalanceSeconds: parseInt(u.referral_reward_balance_seconds || 0, 10),
      rewardBalanceSessions: parseInt(u.referral_reward_balance_sessions || 0, 10),
      proUntil: u.referral_reward_balance_pro_until || null,
      rewards: rewardsResult.rows,
      recentReferrals: recentReferrals.rows,
      inviteIncentive: 'Invite 1 friend → unlock feature/reward',
      progressLabel: `${completed}/${progressTarget} friends joined`
    };
  }

  async getAdminStats() {
    if (!this.db) return {};
    try {
      const [total, today, topReferrers, rewardsToday, rewardsTotal, conversion] =
        await Promise.all([
          this.db.query(`SELECT COUNT(*) FROM referrals WHERE status = 'COMPLETED'`),
          this.db.query(`SELECT COUNT(*) FROM referrals WHERE status = 'COMPLETED' AND completed_at >= CURRENT_DATE`),
          this.db.query(`SELECT inviter_user_id, COUNT(*) AS cnt FROM referrals WHERE status = 'COMPLETED' GROUP BY inviter_user_id ORDER BY cnt DESC LIMIT 10`),
          this.db.query(`SELECT COUNT(*) FROM referral_rewards WHERE created_at >= CURRENT_DATE`),
          this.db.query(`SELECT COUNT(*) FROM referral_rewards`),
          this.db.query(
            `SELECT
               COUNT(*) FILTER (WHERE status != 'CLICKED') * 100.0 / NULLIF(COUNT(*),0) AS click_to_signup,
               COUNT(*) FILTER (WHERE status IN ('PROFILE_DONE','COMPLETED')) * 100.0 / NULLIF(COUNT(*) FILTER (WHERE status != 'CLICKED'),0) AS signup_to_profile,
               COUNT(*) FILTER (WHERE status = 'COMPLETED') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE status IN ('PROFILE_DONE','COMPLETED')),0) AS profile_to_complete
             FROM referrals`
          ),
        ]);
      return {
        totalReferrals: parseInt(total.rows[0].count, 10),
        referralsToday: parseInt(today.rows[0].count, 10),
        topReferrers: topReferrers.rows,
        rewardsGrantedToday: parseInt(rewardsToday.rows[0].count, 10),
        rewardsGrantedTotal: parseInt(rewardsTotal.rows[0].count, 10),
        referralConversionRates: {
          clickToSignup: parseFloat(conversion.rows[0].click_to_signup || 0).toFixed(1),
          signupToProfile: parseFloat(conversion.rows[0].signup_to_profile || 0).toFixed(1),
          profileToComplete: parseFloat(conversion.rows[0].profile_to_complete || 0).toFixed(1),
        }
      };
    } catch (err) {
      console.error('[Referral] getAdminStats error:', err.message);
      return {};
    }
  }

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

    const proUntil = u.referral_reward_balance_pro_until;
    const seconds = parseInt(u.referral_reward_balance_seconds || 0, 10);
    const sessions = parseInt(u.referral_reward_balance_sessions || 0, 10);

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

module.exports = { ReferralSystem, MILESTONES, nextMilestone };
