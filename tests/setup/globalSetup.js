'use strict';

/**
 * Playwright / Jest global test setup.
 *
 * Responsibilities:
 *   1. HARD GUARD — abort immediately if Stripe live keys are detected.
 *   2. Start ephemeral PostgreSQL container (Testcontainers).
 *   3. Start ephemeral Redis container (Testcontainers).
 *   4. Run database migrations (db/schema.sql + db/migrations/*.sql).
 *   5. Seed canonical test users (admin, host, guest).
 *   6. Start the app server bound to a random free port.
 *   7. Export APP_PORT and container handles to global state for teardown.
 *
 * Usage in playwright.tests.config.js:
 *   globalSetup:  './tests/setup/globalSetup.js'
 *   globalTeardown: './tests/setup/globalTeardown.js'
 *
 * Usage in jest.config.js / package.json jest config:
 *   "globalSetup": "./tests/setup/globalSetup.js"
 *   "globalTeardown": "./tests/setup/globalTeardown.js"
 */

const path = require('path');
const fs = require('fs');
const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { RedisContainer } = require('@testcontainers/redis');
const { Client } = require('pg');
const { assertStripeTestMode } = require('../helpers/stripe-guard');
const { SEED_USERS, SEED_USER_SQL } = require('../fixtures/seed');

// ─── State shared with globalTeardown via a temp JSON file ─────────────────

const STATE_FILE = path.resolve(__dirname, '../../.e2e-container-state.json');

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Read all SQL files for migrations in sorted order. */
async function collectMigrationSql() {
  const schemaFile = path.resolve(__dirname, '../../db/schema.sql');
  const migrationsDir = path.resolve(__dirname, '../../db/migrations');

  const parts = [];

  if (fs.existsSync(schemaFile)) {
    parts.push(fs.readFileSync(schemaFile, 'utf8'));
  }

  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      parts.push(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
    }
  }

  return parts.join('\n');
}

/** Hash a password using the same bcrypt settings as the app. */
async function hashPassword(plain) {
  // Use dynamic require so it only loads when the module is available.
  const bcrypt = require('bcrypt');
  return bcrypt.hash(plain, 12);
}

// ─── Main ──────────────────────────────────────────────────────────────────

module.exports = async function globalSetup() {
  // ── 1. Stripe live-key hard guard ──────────────────────────────────────
  assertStripeTestMode();

  // ── 2. Ensure NODE_ENV=test ────────────────────────────────────────────
  process.env.NODE_ENV = 'test';

  // ── 3. PostgreSQL — reuse existing service or start a container ────────
  //
  // When DATABASE_URL is already set (e.g. a CI service container or an
  // e2e-runner-managed server), skip starting a Testcontainer so we avoid
  // double-initialization and seed users into the wrong database.
  let pgContainer = null;
  let DATABASE_URL = process.env.DATABASE_URL || null;

  if (DATABASE_URL) {
    let safeUrl = DATABASE_URL;
    try {
      const u = new URL(DATABASE_URL);
      if (u.password) { u.password = '***'; }
      safeUrl = u.toString();
    } catch (_) {}
    console.log(`[globalSetup] Reusing existing PostgreSQL at ${safeUrl}`);
  } else {
    console.log('[globalSetup] Starting PostgreSQL container…');
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('houseparty_test')
      .withUsername('testuser')
      .withPassword('testpass')
      .start();
    DATABASE_URL = pgContainer.getConnectionUri();
    process.env.DATABASE_URL = DATABASE_URL;
    console.log(`[globalSetup] PostgreSQL ready: ${DATABASE_URL}`);
  }

  // ── 4. Redis — reuse existing service or start a container ────────────
  let redisContainer = null;
  let REDIS_URL = process.env.REDIS_URL || null;

  if (REDIS_URL) {
    console.log(`[globalSetup] Reusing existing Redis at ${REDIS_URL}`);
  } else {
    console.log('[globalSetup] Starting Redis container…');
    redisContainer = await new RedisContainer('redis:7-alpine').start();
    REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    process.env.REDIS_URL = REDIS_URL;
    console.log(`[globalSetup] Redis ready: ${REDIS_URL}`);
  }

  // ── 5. Run DB migrations ───────────────────────────────────────────────
  console.log('[globalSetup] Running database migrations…');
  const migrationSql = await collectMigrationSql();
  const pgClient = new Client({ connectionString: DATABASE_URL });
  await pgClient.connect();
  await pgClient.query(migrationSql);
  console.log('[globalSetup] Migrations applied.');

  // ── 6. Seed canonical test users ───────────────────────────────────────
  console.log('[globalSetup] Seeding test users…');
  const seededIds = {};
  for (const [role, u] of Object.entries(SEED_USERS)) {
    const hash = await hashPassword(u.password);
    const result = await pgClient.query(SEED_USER_SQL, [
      u.email,
      hash,
      u.djName,
      u.isAdmin,
    ]);
    seededIds[role] = result.rows[0]?.id;
    console.log(`[globalSetup]   seeded ${role}: ${u.email} (id=${seededIds[role]})`);
  }
  await pgClient.end();

  // ── 7. Persist container state for teardown ────────────────────────────
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      pgContainerId: pgContainer ? pgContainer.getId() : null,
      redisContainerId: redisContainer ? redisContainer.getId() : null,
      DATABASE_URL,
      REDIS_URL,
    })
  );

  // ── 8. Expose env vars for child processes (e.g. app server) ──────────
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.REDIS_URL = REDIS_URL;

  // Store container references on globalThis so teardown can access them
  // when running in the same Node process (Playwright / Jest --runInBand).
  globalThis.__testcontainers = { pgContainer, redisContainer };

  console.log('[globalSetup] ✅ Setup complete.');
};
