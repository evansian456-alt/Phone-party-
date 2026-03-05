'use strict';

/**
 * Playwright global teardown for the audit suite.
 * Stops server process and Testcontainers.
 */

const path = require('path');
const fs = require('fs');

const STATE_FILE = path.resolve(__dirname, '../../.audit-state.json');

module.exports = async function auditTeardown() {
  console.log('[auditTeardown] Stopping audit stack…');

  if (globalThis.__auditStack) {
    const { pgContainer, redisContainer, serverProc } = globalThis.__auditStack;
    try { serverProc.kill('SIGTERM'); } catch (_) {}
    console.log('[auditTeardown] App server stopped.');
    try { await pgContainer.stop(); console.log('[auditTeardown] PostgreSQL stopped.'); } catch (e) { console.warn(e.message); }
    try { await redisContainer.stop(); console.log('[auditTeardown] Redis stopped.'); } catch (e) { console.warn(e.message); }
    globalThis.__auditStack = null;
  } else if (fs.existsSync(STATE_FILE)) {
    const { execSync } = require('child_process');
    let state;
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { state = {}; }
    if (state.serverPid) {
      try { process.kill(state.serverPid, 'SIGTERM'); } catch (_) {}
    }
    for (const [label, id] of [['PostgreSQL', state.pgContainerId], ['Redis', state.redisContainerId]]) {
      if (!id) continue;
      try { execSync(`docker stop ${id} && docker rm -f ${id}`, { stdio: 'ignore' }); console.log(`[auditTeardown] ${label} stopped.`); } catch (_) {}
    }
  }

  try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch (_) {}
  try { const logFile = path.resolve(__dirname, '../../audit-server.log'); if (fs.existsSync(logFile)) {} } catch (_) {}
  console.log('[auditTeardown] ✅ Done.');
};
