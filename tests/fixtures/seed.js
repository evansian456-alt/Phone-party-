'use strict';

/**
 * Test seed fixtures.
 *
 * Provides deterministic user objects and helper functions for seeding the
 * test database. Used by globalSetup and individual test suites.
 */

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ianevans2023@outlook.com';
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD || 'ChangeMe123!';

/**
 * Canonical seed users available in every test run.
 * Passwords are set from TEST_USER_PASSWORD env (default: ChangeMe123!).
 */
const SEED_USERS = {
  admin: {
    email: ADMIN_EMAIL,
    password: TEST_PASSWORD,
    djName: 'AdminDJ',
    isAdmin: true,
  },
  host: {
    email: 'host@test.com',
    password: TEST_PASSWORD,
    djName: 'HostDJ',
    isAdmin: false,
  },
  guest: {
    email: 'guest@test.com',
    password: TEST_PASSWORD,
    djName: 'GuestDJ',
    isAdmin: false,
  },
};

/**
 * Minimal SQL to insert a seed user.
 * Assumes bcrypt hash of TEST_PASSWORD is pre-computed by globalSetup using the
 * actual bcrypt module — this file only provides the structure.
 */
const SEED_USER_SQL = `
  INSERT INTO users (email, password_hash, dj_name, profile_completed, is_admin)
  VALUES ($1, $2, $3, TRUE, $4)
  ON CONFLICT (email) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        dj_name       = EXCLUDED.dj_name,
        profile_completed = TRUE,
        is_admin      = EXCLUDED.is_admin
  RETURNING id;
`;

module.exports = { SEED_USERS, SEED_USER_SQL };
