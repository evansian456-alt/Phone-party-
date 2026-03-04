#!/usr/bin/env node
'use strict';

/**
 * E2E Test Bootstrap Runner
 *
 * Orchestrates the full E2E test lifecycle:
 *   1. Ensure Redis is reachable (start via Docker locally if needed)
 *   2. Start the app server in test mode on a free port
 *   3. Wait for readiness — Redis PING + server /health (no sleeps, polling only)
 *   4. Run Playwright E2E tests
 *   5. Tear everything down cleanly (even on test failure or Ctrl-C)
 *
 * Usage:
 *   npm run test:e2e                         # headless (default)
 *   npm run test:e2e -- --headed             # visible browser
 *   npm run test:e2e -- --ui                 # Playwright interactive UI
 *   SERVER_PORT=9090 npm run test:e2e        # pin the app port
 *   REDIS_URL=redis://myhost:6379 npm run test:e2e
 */

const { execSync, spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

// ─── Configuration ─────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
let DATABASE_URL = process.env.DATABASE_URL || null;
const SERVER_PORT = process.env.SERVER_PORT || null; // null → pick a free port
const POLL_INTERVAL_MS = 500;
const REDIS_TIMEOUT_MS = 30_000;
const PG_TIMEOUT_MS = 30_000;
const SERVER_TIMEOUT_MS = 60_000;
const WS_TIMEOUT_MS = 10_000;
const SERVER_LOG_FILE = path.resolve(__dirname, '..', 'server.log');
const DIAGNOSTIC_TAIL_LINES = 200;

// Default test JWT secret – only used when none is already set in the environment
const DEFAULT_TEST_JWT_SECRET = 'e2e-test-runner-secret-do-not-use-in-production-32chars+';

// ─── State ─────────────────────────────────────────────────────────────────────

let serverProcess = null;
let redisContainerName = null;
let pgContainerName = null;
let shuttingDown = false;
let serverLogStream = null;

// ─── Teardown ──────────────────────────────────────────────────────────────────

function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (serverProcess) {
    try {
      serverProcess.kill('SIGTERM');
    } catch (_) {}
    serverProcess = null;
    console.log('[E2E] Server process terminated.');
  }

  if (serverLogStream) {
    try { serverLogStream.end(); } catch (_) {}
    serverLogStream = null;
  }

  if (redisContainerName) {
    console.log(`[E2E] Stopping Redis container: ${redisContainerName}`);
    try {
      execSync(`docker stop ${redisContainerName} && docker rm ${redisContainerName}`, {
        stdio: 'ignore',
      });
    } catch (_) {}
    redisContainerName = null;
    console.log('[E2E] Redis container removed.');
  }

  if (pgContainerName) {
    console.log(`[E2E] Stopping Postgres container: ${pgContainerName}`);
    try {
      execSync(`docker stop ${pgContainerName} && docker rm ${pgContainerName}`, {
        stdio: 'ignore',
      });
    } catch (_) {}
    pgContainerName = null;
    console.log('[E2E] Postgres container removed.');
  }
}

function cleanupAndExit(code) {
  cleanup();
  // Give child processes a moment to flush before hard exit
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => { console.log('\n[E2E] SIGINT received – tearing down…'); cleanupAndExit(130); });
process.on('SIGTERM', () => { console.log('\n[E2E] SIGTERM received – tearing down…'); cleanupAndExit(143); });
process.on('uncaughtException', (err) => {
  console.error('[E2E] Uncaught exception:', err);
  cleanupAndExit(1);
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Find an ephemeral free TCP port on the loopback interface. */
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

/** Repeatedly call `fn` until it resolves truthy, or throw on timeout. */
async function pollUntil(fn, timeoutMs, label) {
  const startMs = Date.now();
  const deadline = startMs + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  throw new Error(
    `Timed out after ${elapsed}s (limit ${(timeoutMs / 1000).toFixed(1)}s) waiting for ${label}` +
      (lastErr ? `: ${lastErr.message}` : '')
  );
}

/** Return ISO timestamp prefix for log lines. */
function ts() {
  return new Date().toISOString();
}

/** Parse host + port out of a redis:// URL. */
function parseRedisUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname || 'localhost', port: parseInt(u.port || '6379', 10) };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

/**
 * Check Redis readiness by opening a raw TCP connection and sending PING.
 * Returns true if Redis replies with +PONG.
 */
function checkRedis() {
  return new Promise((resolve, reject) => {
    const { host, port } = parseRedisUrl(REDIS_URL);
    const socket = net.createConnection({ host, port }, () => {
      socket.write('*1\r\n$4\r\nPING\r\n'); // RESP inline: array[1] = bulk-string "PING"
    });
    socket.setTimeout(2000);
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('+PONG') || data.includes('PONG')) {
        socket.destroy();
        resolve(true);
      }
    });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Redis TCP timeout')); });
    socket.on('error', (e) => reject(e));
  });
}

/** HTTP GET the /health endpoint; returns true on 200. */
function checkServerHealth(baseUrl) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/health`, { timeout: 3000 }, (res) => {
      // Drain response so socket is released
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Server /health timeout')); });
    req.on('error', reject);
  });
}

/**
 * Verify PostgreSQL is reachable by running SELECT 1.
 * Returns true on success, rejects on any error.
 */
function checkPostgres() {
  return new Promise((resolve, reject) => {
    if (!DATABASE_URL) {
      reject(new Error('DATABASE_URL is not set'));
      return;
    }
    // eslint-disable-next-line global-require
    const { Client } = require('pg');
    const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
    client.connect()
      .then(() => client.query('SELECT 1'))
      .then(() => client.end())
      .then(() => resolve(true))
      .catch((e) => { client.end().catch(() => {}); reject(e); });
  });
}

/**
 * Verify the app WebSocket server accepts connections on the given port.
 * Opens a WS connection and closes it cleanly on success.
 */
function checkWebSocket(port) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line global-require
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://localhost:${port}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WS handshake timeout'));
    }, 3000);
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Attempt to start a Redis container via Docker; throws on failure. */
function startRedisViaDocker() {
  const name = `e2e-redis-${process.pid}`;
  console.log(`[E2E] Starting Redis via Docker (container: ${name})…`);
  execSync(`docker run -d --name ${name} -p 6379:6379 redis:6-alpine`, { stdio: 'inherit' });
  redisContainerName = name;
  return name;
}

/**
 * Start a Postgres container via Docker and run schema migrations.
 * Sets the module-level DATABASE_URL so the app server picks it up.
 * Only called when DATABASE_URL is not already set in the environment.
 */
async function startPostgresViaDocker() {
  const name = `e2e-postgres-${process.pid}`;
  const pgPort = 15432; // use a non-standard port to avoid conflicts
  const pgUser = 'e2e';
  const pgPassword = 'e2e_pass';
  const pgDb = 'houseparty_e2e';

  console.log(`[E2E] Starting Postgres via Docker (container: ${name}, port: ${pgPort})…`);
  execSync(
    `docker run -d --name ${name} ` +
    `-p ${pgPort}:5432 ` +
    `-e POSTGRES_USER=${pgUser} ` +
    `-e POSTGRES_PASSWORD=${pgPassword} ` +
    `-e POSTGRES_DB=${pgDb} ` +
    `postgres:16-alpine`,
    { stdio: 'inherit' }
  );
  pgContainerName = name;

  const connStr = `postgres://${pgUser}:${pgPassword}@localhost:${pgPort}/${pgDb}`;

  // Wait for Postgres to be ready
  process.stdout.write('[E2E] Waiting for Postgres to accept connections');
  await pollUntil(async () => {
    process.stdout.write('.');
    const { Client } = require('pg');
    const client = new Client({ connectionString: connStr, connectionTimeoutMillis: 2000 });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  }, PG_TIMEOUT_MS, 'Postgres ready');
  process.stdout.write('\n');
  console.log('[E2E] ✅ Postgres is ready.');

  // Run migrations
  console.log('[E2E] Running database migrations…');
  const { Client } = require('pg');
  const schemaFile = path.resolve(__dirname, '..', 'db', 'schema.sql');
  const migrationsDir = path.resolve(__dirname, '..', 'db', 'migrations');
  const sqlParts = [];
  if (fs.existsSync(schemaFile)) sqlParts.push(fs.readFileSync(schemaFile, 'utf8'));
  if (fs.existsSync(migrationsDir)) {
    const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const mf of migrationFiles) {
      sqlParts.push(fs.readFileSync(path.join(migrationsDir, mf), 'utf8'));
    }
  }
  const pgClient = new Client({ connectionString: connStr });
  await pgClient.connect();
  await pgClient.query(sqlParts.join('\n'));
  await pgClient.end();
  console.log('[E2E] ✅ Migrations applied.');

  // Expose to the rest of the runner and to child processes
  DATABASE_URL = connStr;
  process.env.DATABASE_URL = connStr;
}

/**
 * Print server diagnostics: last N lines of server.log + listening ports.
 * Safe to call even if server.log does not exist.
 */
function printServerDiagnostics() {
  console.error('\n[E2E] ─── Server Diagnostics ───────────────────────────────');
  if (fs.existsSync(SERVER_LOG_FILE)) {
    const lines = fs.readFileSync(SERVER_LOG_FILE, 'utf8').split('\n');
    const tail = lines.slice(-DIAGNOSTIC_TAIL_LINES).join('\n');
    console.error(`[E2E] Last ${DIAGNOSTIC_TAIL_LINES} lines of ${path.basename(SERVER_LOG_FILE)}:`);
    console.error(tail);
  } else {
    console.error(`[E2E] No server.log found at ${SERVER_LOG_FILE}`);
  }
  // Show listening ports if lsof is available
  try {
    const ports = execSync('lsof -iTCP -sTCP:LISTEN -Pn 2>/dev/null', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      shell: true,
    }).toString().trim();
    if (ports) {
      console.error('\n[E2E] Listening TCP ports:');
      console.error(ports);
    }
  } catch (_) {
    // lsof not available; try ss
    try {
      const ports = execSync('ss -tlnp 2>/dev/null | head -20', {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        shell: true,
      }).toString().trim();
      if (ports) {
        console.error('\n[E2E] Listening TCP ports:');
        console.error(ports);
      }
    } catch (_2) { /* best-effort */ }
  }
  console.error('[E2E] ────────────────────────────────────────────────────────\n');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const extraPlaywrightArgs = process.argv.slice(2);

  console.log('\n[E2E] ═══════════════════════════════════════════════');
  console.log('[E2E]  SyncSpeaker E2E Bootstrap Runner');
  console.log(`[E2E]  Started at ${ts()}`);
  console.log('[E2E] ═══════════════════════════════════════════════');

  // ── Fast-path: skip boot when stack is pre-started (e.g. by scripts/ci/e2e-up.js) ──
  if (process.env.E2E_SKIP_BOOT === '1') {
    if (!process.env.BASE_URL) {
      console.error('[E2E] E2E_SKIP_BOOT=1 requires BASE_URL to be set (e.g. http://localhost:34155)');
      cleanupAndExit(1);
      return;
    }
    const preStartedUrl = process.env.BASE_URL;
    console.log(`[E2E] ${ts()} E2E_SKIP_BOOT=1 — using pre-started server at ${preStartedUrl}`);

    const pwArgs = ['playwright', 'test', ...extraPlaywrightArgs];
    const pw = spawn('npx', pwArgs, {
      env: {
        ...process.env,
        BASE_URL: preStartedUrl,
        NODE_ENV: 'test',
      },
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    });
    const exitCode = await new Promise((resolve) => pw.on('close', resolve));
    if (exitCode !== 0) printServerDiagnostics();
    cleanupAndExit(exitCode || 0);
    return;
  }

  // ── Step 1: Redis ────────────────────────────────────────────────────────────
  console.log(`\n[E2E] ${ts()} Step 1/5 – Redis (${REDIS_URL})`);

  let redisReady = false;
  try {
    await checkRedis();
    redisReady = true;
    console.log(`[E2E] ${ts()} ✅ Redis already reachable.`);
  } catch (connErr) {
    if (process.env.REDIS_URL) {
      // Caller explicitly set REDIS_URL → fail fast instead of silently spawning Docker
      console.error(
        `[E2E] ${ts()} ❌ REDIS_URL is set to "${REDIS_URL}" but Redis is not reachable.`
      );
      console.error(`[E2E]    Error: ${connErr.message}`);
      console.error('[E2E]    Fix: ensure Redis is running at the configured URL.');
      cleanupAndExit(1);
      return;
    }

    // No REDIS_URL env var → try Docker
    console.log(`[E2E] ${ts()} Redis not reachable on default port. Attempting to start via Docker…`);
    try {
      startRedisViaDocker();
    } catch (dockerErr) {
      console.error(`[E2E] ${ts()} ❌ Could not start Redis via Docker:`, dockerErr.message);
      console.error('[E2E]    Quick fix — run Redis manually:');
      console.error('[E2E]      docker run -d -p 6379:6379 redis:7-alpine');
      console.error('[E2E]    Or set REDIS_URL to an existing Redis instance.');
      cleanupAndExit(1);
      return;
    }
  }

  if (!redisReady) {
    process.stdout.write(`[E2E] ${ts()} Waiting for Redis to accept connections`);
    try {
      await pollUntil(async () => {
        process.stdout.write('.');
        return checkRedis();
      }, REDIS_TIMEOUT_MS, 'Redis PING');
      process.stdout.write('\n');
      console.log(`[E2E] ${ts()} ✅ Redis is ready.`);
    } catch (e) {
      process.stdout.write('\n');
      console.error(`[E2E] ${ts()} ❌ Redis did not become ready in time: ${e.message}`);
      cleanupAndExit(1);
      return;
    }
  }

  // ── Step 2: PostgreSQL ───────────────────────────────────────────────────────
  if (DATABASE_URL) {
    console.log(`\n[E2E] ${ts()} Step 2/5 – PostgreSQL (${DATABASE_URL.replace(/:[^:@]+@/, ':***@')})`);
    try {
      await pollUntil(async () => checkPostgres(), PG_TIMEOUT_MS, 'PostgreSQL SELECT 1');
      console.log(`[E2E] ${ts()} ✅ PostgreSQL is ready.`);
    } catch (e) {
      console.error(`[E2E] ${ts()} ❌ PostgreSQL did not become ready in time: ${e.message}`);
      console.error('[E2E]    Fix: ensure DATABASE_URL points to a running PostgreSQL instance.');
      cleanupAndExit(1);
      return;
    }
  } else {
    console.log(`\n[E2E] ${ts()} Step 2/5 – PostgreSQL (DATABASE_URL not set — starting via Docker…)`);
    try {
      await startPostgresViaDocker();
      console.log(`[E2E] ${ts()} ✅ PostgreSQL container ready: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
    } catch (e) {
      console.error(`[E2E] ${ts()} ❌ Failed to start Postgres via Docker: ${e.message}`);
      console.error('[E2E]    Fix: install Docker or set DATABASE_URL to an existing PostgreSQL instance.');
      cleanupAndExit(1);
      return;
    }
  }

  // ── Step 3: App Server ───────────────────────────────────────────────────────
  const port = SERVER_PORT ? parseInt(SERVER_PORT, 10) : await getFreePort();
  const baseUrl = `http://localhost:${port}`;

  console.log(`\n[E2E] ${ts()} Step 3/5 – Starting app server on port ${port}…`);

  // Load .env.test if it exists (provides sensible local defaults)
  const envTestPath = path.resolve(__dirname, '..', '.env.test');
  const dotenvVars = {};
  if (fs.existsSync(envTestPath)) {
    fs.readFileSync(envTestPath, 'utf8')
      .split('\n')
      .forEach((line) => {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(["']?)(.*)(\2)$/);
        if (m) dotenvVars[m[1]] = m[3]; // strip surrounding quotes if present
      });
  }

  serverProcess = spawn('node', [path.resolve(__dirname, '..', 'server.js')], {
    env: {
      ...dotenvVars,   // .env.test defaults (lowest priority)
      ...process.env,  // real env overrides (includes CI secrets)
      NODE_ENV: 'test',
      TEST_MODE: 'true',
      PORT: String(port),
      REDIS_URL,
      ...(DATABASE_URL ? { DATABASE_URL } : {}),
      JWT_SECRET: process.env.JWT_SECRET || DEFAULT_TEST_JWT_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Tee server stdout/stderr → terminal + server.log
  serverLogStream = fs.createWriteStream(SERVER_LOG_FILE, { flags: 'w' });
  serverProcess.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    serverLogStream.write(chunk);
  });
  serverProcess.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    serverLogStream.write(chunk);
  });
  console.log(`[E2E] ${ts()} Server logs → ${SERVER_LOG_FILE}`);

  serverProcess.on('error', (e) => {
    console.error(`[E2E] ${ts()} ❌ Failed to start server process: ${e.message}`);
    printServerDiagnostics();
    cleanupAndExit(1);
  });

  let serverExitedEarly = false;
  serverProcess.on('exit', (code, signal) => {
    if (!shuttingDown && code !== 0 && code !== null) {
      serverExitedEarly = true;
      console.error(`[E2E] ${ts()} ❌ Server exited unexpectedly (code=${code}, signal=${signal})`);
      printServerDiagnostics();
      cleanupAndExit(1);
    }
  });

  // ── Step 4: Readiness gating (HTTP + WebSocket) ──────────────────────────────
  console.log(`\n[E2E] ${ts()} Step 4/5 – Waiting for server at ${baseUrl}/health…`);
  process.stdout.write('[E2E] ');
  try {
    await pollUntil(async () => {
      if (serverExitedEarly) throw new Error('Server process has already exited');
      process.stdout.write('.');
      return checkServerHealth(baseUrl);
    }, SERVER_TIMEOUT_MS, 'server /health');
    process.stdout.write('\n');
    console.log(`[E2E] ${ts()} ✅ HTTP server is ready at ${baseUrl}`);
  } catch (e) {
    process.stdout.write('\n');
    console.error(`[E2E] ${ts()} ❌ Server did not become ready in time: ${e.message}`);
    printServerDiagnostics();
    cleanupAndExit(1);
    return;
  }

  console.log(`[E2E] ${ts()}    Verifying WebSocket handshake on ws://localhost:${port}…`);
  try {
    await pollUntil(async () => checkWebSocket(port), WS_TIMEOUT_MS, 'WebSocket handshake');
    console.log(`[E2E] ${ts()} ✅ WebSocket server is ready on port ${port}`);
  } catch (e) {
    console.error(`[E2E] ${ts()} ❌ WebSocket handshake failed: ${e.message}`);
    printServerDiagnostics();
    cleanupAndExit(1);
    return;
  }

  // ── Step 5: Run Playwright ───────────────────────────────────────────────────
  console.log(`\n[E2E] ${ts()} Step 5/5 – Running Playwright E2E tests…`);
  console.log(`[E2E] BASE_URL=${baseUrl}`);
  console.log(`[E2E] WS_URL=ws://localhost:${port}`);
  console.log(`[E2E] REDIS_URL=${REDIS_URL}`);
  if (DATABASE_URL) console.log(`[E2E] DATABASE_URL=${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log('');

  const pwArgs = ['playwright', 'test', ...extraPlaywrightArgs];

  const pw = spawn('npx', pwArgs, {
    env: {
      ...process.env,
      BASE_URL: baseUrl,
      WS_URL: `ws://localhost:${port}`,
      REDIS_URL,
      ...(DATABASE_URL ? { DATABASE_URL } : {}),
      NODE_ENV: 'test',
    },
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
  });

  const exitCode = await new Promise((resolve) => pw.on('close', resolve));

  // ── Teardown ─────────────────────────────────────────────────────────────────
  console.log('\n[E2E] ═══════════════════════════════════════════════');
  if (exitCode === 0) {
    console.log(`[E2E] ${ts()} ✅ All E2E tests passed.`);
  } else {
    console.log(`[E2E] ${ts()} ❌ E2E tests finished with exit code ${exitCode}.`);
    printServerDiagnostics();
  }
  console.log('[E2E] Tearing down…');
  cleanupAndExit(exitCode || 0);
}

main().catch((err) => {
  console.error(`[E2E] ${ts()} Fatal error:`, err);
  cleanupAndExit(1);
});
