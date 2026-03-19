-- Migration 011: Referral Tracking Enhancements
-- Adds invite_code_used, referral_source, and invited_at columns to users table
-- for richer referral attribution and abuse prevention.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS invite_code_used VARCHAR(12),
  ADD COLUMN IF NOT EXISTS referral_source VARCHAR(50),
  ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_invite_code_used ON users(invite_code_used);
