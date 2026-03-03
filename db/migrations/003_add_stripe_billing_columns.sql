-- Migration: 003_add_stripe_billing_columns.sql
-- Adds Stripe billing fields to the users table and an in-table tier column.

-- Stripe billing columns
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT NULL,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT NULL,
  ADD COLUMN IF NOT EXISTS subscription_status     TEXT NULL,
  ADD COLUMN IF NOT EXISTS current_period_end      TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS tier                    TEXT NOT NULL DEFAULT 'FREE';

-- Indexes for efficient webhook lookups
CREATE INDEX IF NOT EXISTS users_stripe_customer_id_idx
  ON users (stripe_customer_id);

CREATE INDEX IF NOT EXISTS users_stripe_subscription_id_idx
  ON users (stripe_subscription_id);
