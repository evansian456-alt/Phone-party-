-- Migration 007: Invite growth hardening + attribution
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS invite_code_used VARCHAR(12),
  ADD COLUMN IF NOT EXISTS referral_source TEXT,
  ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS referral_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS successful_invites INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS signup_device_fingerprint VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_users_invite_code_used ON users(invite_code_used);
CREATE INDEX IF NOT EXISTS idx_users_signup_device_fingerprint ON users(signup_device_fingerprint);
