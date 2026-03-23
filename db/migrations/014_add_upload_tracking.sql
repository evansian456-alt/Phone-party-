-- Migration 014: Add upload tracking tables for the unified upload commerce system
-- Adds:
--   party_upload_usage   – per-user per-party upload count
--   party_addon_grants   – addon bundle grants, idempotent on transaction_id

CREATE TABLE IF NOT EXISTS party_upload_usage (
  id           SERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL,
  party_code   TEXT NOT NULL,
  upload_count INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, party_code)
);

CREATE INDEX IF NOT EXISTS idx_party_upload_usage_user_party
  ON party_upload_usage(user_id, party_code);

CREATE TABLE IF NOT EXISTS party_addon_grants (
  id             SERIAL PRIMARY KEY,
  user_id        TEXT NOT NULL,
  party_code     TEXT NOT NULL,
  addon_key      TEXT NOT NULL,
  extra_songs    INT NOT NULL DEFAULT 0,
  transaction_id TEXT NOT NULL UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_party_addon_grants_user_party
  ON party_addon_grants(user_id, party_code);

CREATE INDEX IF NOT EXISTS idx_party_addon_grants_transaction
  ON party_addon_grants(transaction_id);
