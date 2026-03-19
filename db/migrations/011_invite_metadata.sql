-- Migration 011: Invite metadata on users table
-- Adds columns to record which invite code was used, the referral source,
-- and the timestamp when the invitation was accepted at signup.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS invite_code_used VARCHAR(12),
  ADD COLUMN IF NOT EXISTS referral_source  VARCHAR(30),
  ADD COLUMN IF NOT EXISTS invited_at       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_invite_code_used ON users(invite_code_used);
