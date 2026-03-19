-- Migration 012: Add tier activation timestamps for accurate status tracking
-- Adds party_pass_started_at to user_upgrades so we can display
-- "when it started" in addition to "when it expires".

ALTER TABLE user_upgrades
  ADD COLUMN IF NOT EXISTS party_pass_started_at TIMESTAMPTZ;
