-- Migration 007: Referral Growth System
-- Adds comprehensive referral tracking tables and user reward columns

-- Add referral columns to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referral_code VARCHAR(12) UNIQUE,
  ADD COLUMN IF NOT EXISTS referred_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referrals_completed INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS referral_reward_balance_seconds INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS referral_reward_balance_sessions INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS referral_reward_balance_pro_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by_user_id);

-- referral_clicks: tracks each time an invite link is opened
CREATE TABLE IF NOT EXISTS referral_clicks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referral_code VARCHAR(12) NOT NULL,
  click_id UUID NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
  ip_hash VARCHAR(64),
  user_agent_hash VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_clicks_code ON referral_clicks(referral_code);
CREATE INDEX IF NOT EXISTS idx_referral_clicks_click_id ON referral_clicks(click_id);
CREATE INDEX IF NOT EXISTS idx_referral_clicks_created ON referral_clicks(created_at);

-- referrals: tracks each referral relationship and its status
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  inviter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  click_id UUID,
  status VARCHAR(20) NOT NULL DEFAULT 'CLICKED'
    CHECK (status IN ('CLICKED','SIGNED_UP','PROFILE_DONE','COMPLETED','REJECTED')),
  rejection_reason VARCHAR(100),
  ip_hash VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referrals_inviter ON referrals(inviter_user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_click_id ON referrals(click_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- referral_rewards: tracks milestones earned by each user
CREATE TABLE IF NOT EXISTS referral_rewards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  inviter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  milestone INT NOT NULL,
  reward_type VARCHAR(30) NOT NULL
    CHECK (reward_type IN ('PARTY_PASS_SECONDS','PARTY_PASS_SESSION','PRO_UNTIL')),
  amount_seconds INT,
  amount_sessions INT,
  pro_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(inviter_user_id, milestone)
);

CREATE INDEX IF NOT EXISTS idx_referral_rewards_inviter ON referral_rewards(inviter_user_id);
