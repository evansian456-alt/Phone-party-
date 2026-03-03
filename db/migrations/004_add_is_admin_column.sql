-- Migration: 004_add_is_admin_column.sql
-- Adds is_admin flag to the users table for server-side admin authorization.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
