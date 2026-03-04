-- Migration: 005_add_admin_purchases_columns.sql
-- Adds type, sku, amount_cents columns to purchases table for admin stats.
-- These columns supplement (not replace) the existing purchase_kind / item_key columns.

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS type          TEXT NULL,         -- 'tier' | 'addon'
  ADD COLUMN IF NOT EXISTS sku           TEXT NULL,         -- e.g. 'party_pass', 'pro', 'addon_visual_pack_1'
  ADD COLUMN IF NOT EXISTS amount_cents  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id   TEXT NULL,
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_purchases_sku ON purchases(sku);
CREATE INDEX IF NOT EXISTS idx_purchases_type ON purchases(type);
