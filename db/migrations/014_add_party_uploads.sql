-- Migration 014: Party Uploads and Upload Add-ons
-- Tracks per-party audio uploads with entitlement metadata,
-- and add-on bundles that extend a Party Pass upload allowance.

-- ── party_uploads ─────────────────────────────────────────────────────────────
-- Records every completed audio upload tied to a party.

CREATE TABLE IF NOT EXISTS party_uploads (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  party_code        TEXT        NOT NULL,
  uploader_user_id  UUID        REFERENCES users(id) ON DELETE SET NULL,
  track_id          TEXT        NOT NULL,
  storage_key       TEXT        NOT NULL,
  original_filename TEXT        NOT NULL,
  size_bytes        BIGINT      NOT NULL DEFAULT 0,
  mime_type         TEXT        NOT NULL,
  -- 'PARTY_PASS' | 'PRO_MONTHLY' | 'ADDON'
  entitlement_type  TEXT        NOT NULL DEFAULT 'PARTY_PASS',
  upload_status     TEXT        NOT NULL DEFAULT 'complete',   -- 'pending' | 'complete' | 'failed'
  expires_at        TIMESTAMPTZ,          -- NULL = no expiry (Monthly); set for Party Pass
  deleted_at        TIMESTAMPTZ,          -- soft-delete / lifecycle cleanup
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_party_uploads_party_code
  ON party_uploads (party_code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_party_uploads_uploader
  ON party_uploads (uploader_user_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_party_uploads_expires_at
  ON party_uploads (expires_at)
  WHERE deleted_at IS NULL AND expires_at IS NOT NULL;

-- ── party_upload_addons ────────────────────────────────────────────────────────
-- Records extra-song add-on bundles purchased/granted for a specific party.
-- Multiple add-ons per party are fully supported.

CREATE TABLE IF NOT EXISTS party_upload_addons (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  party_code    TEXT        NOT NULL,
  user_id       UUID        REFERENCES users(id) ON DELETE SET NULL,
  extra_songs   INT         NOT NULL DEFAULT 0 CHECK (extra_songs > 0),
  -- 'active' | 'revoked'
  status        TEXT        NOT NULL DEFAULT 'active',
  purchase_ref  TEXT,                     -- Stripe charge / payment reference (nullable)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_party_upload_addons_party_code
  ON party_upload_addons (party_code)
  WHERE status = 'active';
