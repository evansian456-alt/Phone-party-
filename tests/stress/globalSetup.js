'use strict';

/**
 * Global setup for stress tests.
 *
 * If DATABASE_URL is already set in the environment (e.g. CI provides a
 * Postgres service), this just runs migrations and exits — no Docker needed.
 *
 * If DATABASE_URL is NOT set, it spins up ephemeral Testcontainers for both
 * Postgres and Redis so the suite is self-contained on local machines.
 */

const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
const { assertStripeTestMode } = require('../helpers/stripe-guard');

const STATE_FILE = path.resolve(__dirname, '../../.stress-container-state.json');

async function collectMigrationSql() {
  const schemaFile = path.resolve(__dirname, '../../db/schema.sql');
  const migrationsDir = path.resolve(__dirname, '../../db/migrations');
  const parts = [];
  if (fs.existsSync(schemaFile)) parts.push(fs.readFileSync(schemaFile, 'utf8'));
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) parts.push(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  return parts.join('\n');
}

module.exports = async function stressGlobalSetup() {
  assertStripeTestMode();
  process.env.NODE_ENV = 'test';

  let pgContainer = null;
  let redisContainer = null;

  if (process.env.DATABASE_URL) {
    // ── CI / pre-configured environment ─────────────────────────────────
    console.log('[stressSetup] DATABASE_URL already set — skipping container startup.');
  } else {
    // ── Local environment — start containers ─────────────────────────────
    console.log('[stressSetup] Starting PostgreSQL container…');
    const { PostgreSqlContainer } = require('@testcontainers/postgresql');
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('houseparty_stress')
      .withUsername('stressuser')
      .withPassword('stresspass')
      .start();
    process.env.DATABASE_URL = pgContainer.getConnectionUri();
    console.log(`[stressSetup] PostgreSQL ready: ${process.env.DATABASE_URL}`);

    console.log('[stressSetup] Starting Redis container…');
    const { RedisContainer } = require('@testcontainers/redis');
    redisContainer = await new RedisContainer('redis:7-alpine').start();
    process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    console.log(`[stressSetup] Redis ready: ${process.env.REDIS_URL}`);
  }

  // ── Run migrations ───────────────────────────────────────────────────────
  console.log('[stressSetup] Applying migrations…');
  const sql = await collectMigrationSql();
  if (sql.trim()) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(sql);
    await client.end();
    console.log('[stressSetup] Migrations applied.');
  } else {
    console.log('[stressSetup] No migrations found — skipping.');
  }

  // Persist container IDs for teardown
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      pgContainerId: pgContainer?.getId() || null,
      redisContainerId: redisContainer?.getId() || null,
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL || null,
    })
  );

  if (pgContainer || redisContainer) {
    globalThis.__stressContainers = { pgContainer, redisContainer };
  }

  console.log('[stressSetup] ✅ Stress global setup complete.');
};
