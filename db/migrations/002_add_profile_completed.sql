-- Migration: Add profile_completed field to users
-- Date: 2026-03-03
-- Description: Track whether a user has completed their profile setup (onboarding)

ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_completed BOOLEAN NOT NULL DEFAULT FALSE;
