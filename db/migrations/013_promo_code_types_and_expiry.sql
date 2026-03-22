-- Migration 013: Add new one-time promo code types and monthly expiry tracking
-- Adds party_pass_one_time and monthly_subscription_one_time to promo_codes.type.
-- Adds pro_monthly_expires_at to user_upgrades for promo-based 1-month subscriptions.

-- Extend the allowed types on promo_codes
ALTER TABLE promo_codes DROP CONSTRAINT IF EXISTS promo_codes_type_check;
ALTER TABLE promo_codes
  ADD CONSTRAINT promo_codes_type_check
    CHECK (type IN ('party_pass', 'pro_monthly', 'party_pass_one_time', 'monthly_subscription_one_time'));

-- Track expiry for promo-granted monthly subscriptions (1 month from redemption)
ALTER TABLE user_upgrades
  ADD COLUMN IF NOT EXISTS pro_monthly_expires_at TIMESTAMPTZ;
