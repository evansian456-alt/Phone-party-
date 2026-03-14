-- Migration 010: Add promo_codes table for admin-generated one-time promo codes
-- Admin can generate codes redeemable for a party_pass or pro_monthly subscription.

CREATE TABLE IF NOT EXISTS promo_codes (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  code          TEXT        NOT NULL UNIQUE,
  type          TEXT        NOT NULL CHECK (type IN ('party_pass', 'pro_monthly')),
  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  used_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  used_at       TIMESTAMPTZ,
  is_used       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_code    ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_is_used ON promo_codes(is_used);
