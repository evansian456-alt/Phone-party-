'use strict';

/**
 * Playwright / Jest global teardown.
 *
 * Stops the PostgreSQL and Redis Testcontainers that were started in
 * globalSetup.js. If the containers are available on globalThis (same
 * process), they are stopped directly. Otherwise the container IDs are
 * read from the temp state file and the containers are stopped via the
 * Testcontainers API.
 *
 * This ensures:
 *   - No hanging Docker containers after tests complete or fail.
 *   - Works in both in-process (Jest --runInBand) and spawned-worker modes.
 */

const path = require('path');
const fs = require('fs');

const STATE_FILE = path.resolve(__dirname, '../../.e2e-container-state.json');

module.exports = async function globalTeardown() {
  console.log('[globalTeardown] Stopping test containers…');

  // ── Prefer in-process references (same Node process) ──────────────────
  if (globalThis.__testcontainers) {
    const { pgContainer, redisContainer } = globalThis.__testcontainers;
    if (pgContainer) {
      try {
        await pgContainer.stop();
        console.log('[globalTeardown] PostgreSQL container stopped.');
      } catch (err) {
        console.warn('[globalTeardown] Could not stop PG container:', err.message);
      }
    }
    if (redisContainer) {
      try {
        await redisContainer.stop();
        console.log('[globalTeardown] Redis container stopped.');
      } catch (err) {
        console.warn('[globalTeardown] Could not stop Redis container:', err.message);
      }
    }
    globalThis.__testcontainers = null;
  } else {
    // ── Fallback: read container IDs from state file ─────────────────────
    if (!fs.existsSync(STATE_FILE)) {
      console.warn('[globalTeardown] No container state file found — nothing to tear down.');
      return;
    }

    let state;
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (err) {
      console.warn('[globalTeardown] Could not read state file:', err.message);
      return;
    }

    // Use the Docker CLI as a last resort (Testcontainers node API requires the
    // original container object, which is not available across process restarts).
    const { execSync } = require('child_process');
    for (const [label, id] of [
      ['PostgreSQL', state.pgContainerId],
      ['Redis', state.redisContainerId],
    ]) {
      if (!id) continue;
      try {
        execSync(`docker stop ${id} && docker rm -f ${id}`, { stdio: 'ignore' });
        console.log(`[globalTeardown] ${label} container stopped (${id.slice(0, 12)}).`);
      } catch (err) {
        console.warn(`[globalTeardown] Could not stop ${label} container ${id}: ${err.message}`);
      }
    }
  }

  // ── Remove state file ──────────────────────────────────────────────────
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  } catch (_) {}

  console.log('[globalTeardown] ✅ Teardown complete.');
};
