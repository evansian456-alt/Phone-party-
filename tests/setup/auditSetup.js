'use strict';

/**
 * Playwright global setup for the audit suite.
 *
 * Starts a full ephemeral stack:
 *   1. Guard against Stripe live keys.
 *   2. Start PostgreSQL container (Testcontainers).
 *   3. Start Redis container (Testcontainers).
 *   4. Run DB migrations.
 *   5. Seed canonical test users.
 *   6. Start the app server on a free port.
 *   7. Write state file for auditTeardown.js.
 *   8. Set process.env.BASE_URL and APP_PORT for tests.
 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { RedisContainer } = require('@testcontainers/redis');
const { Client } = require('pg');
const { assertStripeTestMode } = require('../helpers/stripe-guard');
const { SEED_USERS, SEED_USER_SQL } = require('../fixtures/seed');

const STATE_FILE = path.resolve(__dirname, '../../.audit-state.json');

// ── helpers ────────────────────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`);
}

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

async function hashPassword(plain) {
  const bcrypt = require('bcrypt');
  return bcrypt.hash(plain, 10);
}

// ── main ───────────────────────────────────────────────────────────────────

module.exports = async function auditSetup() {
  assertStripeTestMode();
  process.env.NODE_ENV = 'test';

  // 1. PostgreSQL
  console.log('[auditSetup] Starting PostgreSQL container…');
  const pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('houseparty_audit')
    .withUsername('audituser')
    .withPassword('auditpass')
    .start();
  const DATABASE_URL = pgContainer.getConnectionUri();
  process.env.DATABASE_URL = DATABASE_URL;
  console.log(`[auditSetup] PostgreSQL ready at ${DATABASE_URL}`);

  // 2. Redis
  console.log('[auditSetup] Starting Redis container…');
  const redisContainer = await new RedisContainer('redis:7-alpine').start();
  const REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.REDIS_URL = REDIS_URL;
  console.log(`[auditSetup] Redis ready at ${REDIS_URL}`);

  // 3. Migrations
  console.log('[auditSetup] Running migrations…');
  const sql = await collectMigrationSql();
  const pgClient = new Client({ connectionString: DATABASE_URL });
  await pgClient.connect();
  await pgClient.query(sql);

  // 4. Seed users
  console.log('[auditSetup] Seeding test users…');
  for (const [role, u] of Object.entries(SEED_USERS)) {
    const hash = await hashPassword(u.password);
    const result = await pgClient.query(SEED_USER_SQL, [u.email, hash, u.djName, u.isAdmin]);
    console.log(`[auditSetup]   seeded ${role}: ${u.email} id=${result.rows[0]?.id}`);
  }
  await pgClient.end();

  // 5. Start app server
  const port = await getFreePort();
  console.log(`[auditSetup] Starting app server on port ${port}…`);
  const serverLog = fs.createWriteStream(path.resolve(__dirname, '../../audit-server.log'));
  const serverProc = spawn('node', [path.resolve(__dirname, '../../server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL,
      REDIS_URL,
      JWT_SECRET: 'audit-test-secret-32-chars-padded!!',
      NODE_ENV: 'test',
      ALLOW_LOCAL_DISK_IN_PROD: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.pipe(serverLog);
  serverProc.stderr.pipe(serverLog);
  serverProc.on('error', (err) => console.error('[auditSetup] server error:', err));

  const BASE_URL = `http://127.0.0.1:${port}`;
  await waitForHttp(`${BASE_URL}/api/health`, 60_000);
  console.log(`[auditSetup] App server ready at ${BASE_URL}`);

  // 6. Save state
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    pgContainerId: pgContainer.getId(),
    redisContainerId: redisContainer.getId(),
    serverPid: serverProc.pid,
    DATABASE_URL,
    REDIS_URL,
    BASE_URL,
    port,
  }));

  // 7. Expose for tests
  process.env.BASE_URL = BASE_URL;
  process.env.APP_PORT = String(port);

  globalThis.__auditStack = { pgContainer, redisContainer, serverProc };
  console.log('[auditSetup] ✅ Full stack ready.');
};
