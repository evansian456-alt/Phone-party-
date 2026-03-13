-- Migration: 008_moderation_tables.sql
-- Adds moderation/reporting tables: reports, message_moderation_events, user_moderation_history

-- REPORTS TABLE: tracks all user-submitted reports (track, message, user, party)
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type TEXT NOT NULL CHECK (type IN ('track', 'message', 'user', 'party')),
  target_id TEXT NOT NULL,
  party_id TEXT,
  reporter_user_id TEXT,
  reported_user_id TEXT,
  reason TEXT NOT NULL,
  description TEXT,
  evidence_json JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed', 'actioned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  admin_action TEXT
);

CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(type);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_party ON reports(party_id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

-- MESSAGE MODERATION EVENTS: auto-flagged messages from abuse filter
CREATE TABLE IF NOT EXISTS message_moderation_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id TEXT,
  user_id TEXT,
  party_id TEXT,
  message_text TEXT,
  filter_reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'mild' CHECK (severity IN ('mild', 'severe')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS idx_msg_mod_party ON message_moderation_events(party_id);
CREATE INDEX IF NOT EXISTS idx_msg_mod_user ON message_moderation_events(user_id);
CREATE INDEX IF NOT EXISTS idx_msg_mod_status ON message_moderation_events(status);
CREATE INDEX IF NOT EXISTS idx_msg_mod_severity ON message_moderation_events(severity);
CREATE INDEX IF NOT EXISTS idx_msg_mod_created ON message_moderation_events(created_at DESC);

-- USER MODERATION HISTORY: tracks per-user enforcement actions
CREATE TABLE IF NOT EXISTS user_moderation_history (
  user_id TEXT PRIMARY KEY,
  warning_count INT NOT NULL DEFAULT 0,
  suspension_count INT NOT NULL DEFAULT 0,
  ban_status TEXT NOT NULL DEFAULT 'none' CHECK (ban_status IN ('none', 'suspended', 'banned')),
  ban_reason TEXT,
  last_action_at TIMESTAMPTZ,
  last_action_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_mod_history_ban ON user_moderation_history(ban_status);
