-- Migration: 008_add_users_tier_index.sql
-- Adds index on users.tier for subscription-based queries and admin stats.

CREATE INDEX IF NOT EXISTS idx_users_tier ON users(tier);
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));
