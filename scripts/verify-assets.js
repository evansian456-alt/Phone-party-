#!/usr/bin/env node
/**
 * verify-assets.js
 *
 * Automated check that platform SVG routes and response headers are correct.
 * Uses supertest (already a dev-dependency) to hit the Express app without
 * binding to a real port, so no Redis / DB is required.
 *
 * Usage:
 *   npm run verify-assets
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 */

'use strict';

const supertest = require('supertest');

// Silence noisy server startup logging (env-validator, Redis warnings, etc.)
const originalLog  = console.log;
const originalWarn = console.warn;
const originalInfo = console.info;
console.log  = () => {};
console.warn = () => {};
console.info = () => {};

let app;
try {
  ({ app } = require('../server'));
} catch (err) {
  console.log  = originalLog;
  console.warn = originalWarn;
  console.info = originalInfo;
  console.error('[verify-assets] Could not load server:', err.message);
  process.exit(1);
}

console.log  = originalLog;
console.warn = originalWarn;
console.info = originalInfo;

// ─── helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`✅  ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`❌  ${label}`);
  if (detail) console.error(`    → ${detail}`);
  failed++;
}

// ─── checks ─────────────────────────────────────────────────────────────────

async function runChecks() {
  const agent = supertest(app);

  console.log('[verify-assets] Running platform-asset checks…\n');

  // 1. Platform SVG routes — status, Content-Type, Cache-Control, body
  const platforms = ['youtube', 'spotify', 'soundcloud'];
  for (const p of platforms) {
    const path = `/public/assets/platform-logos/${p}.svg`;
    let res;
    try {
      res = await agent.get(path);
    } catch (err) {
      fail(`GET ${path}`, `request failed: ${err.message}`);
      continue;
    }

    if (res.status !== 200) {
      fail(`GET ${path}`, `expected 200, got ${res.status}`);
      continue;
    }

    const ct = (res.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('svg')) {
      fail(`GET ${path}`, `Content-Type "${ct}" (expected image/svg+xml)`);
      continue;
    }

    const cc = (res.headers['cache-control'] || '').toLowerCase();
    if (!cc.includes('no-cache')) {
      fail(`GET ${path}`, `Cache-Control "${cc}" (expected no-cache)`);
      continue;
    }

    const body = typeof res.text === 'string' ? res.text : String(res.body || '');
    if (!body.trim().startsWith('<svg')) {
      fail(`GET ${path}`, 'body does not start with <svg');
      continue;
    }

    ok(`GET ${path.padEnd(50)}  ${res.status}  ${ct.split(';')[0].trim()}  ${cc.split(',')[0].trim()}`);
  }

  // 2. Unknown platform must return 404 (allowlist enforcement)
  {
    const path = '/public/assets/platform-logos/unknown.svg';
    let res;
    try {
      res = await agent.get(path);
    } catch (err) {
      fail(`GET ${path}`, `request failed: ${err.message}`);
    }
    if (res) {
      if (res.status === 404) {
        ok(`GET ${path.padEnd(50)}  404  (allowlist blocks unknown platform)`);
      } else {
        fail(`GET ${path}`, `expected 404, got ${res.status}`);
      }
    }
  }

  // 3. /__version — JSON with appVersion + changerVersion
  {
    const path = '/__version';
    let res;
    try {
      res = await agent.get(path);
    } catch (err) {
      fail(`GET ${path}`, `request failed: ${err.message}`);
    }
    if (res) {
      if (res.status !== 200) {
        fail(`GET ${path}`, `expected 200, got ${res.status}`);
      } else {
        const data = res.body || {};
        if (!data.appVersion || !data.changerVersion) {
          fail(`GET ${path}`, 'missing appVersion or changerVersion in response');
        } else {
          ok(`GET ${path.padEnd(50)}  200  appVersion="${data.appVersion}"  changerVersion="${data.changerVersion}"`);
        }
      }
    }
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  await runChecks();

  console.log('');
  if (failed === 0) {
    console.log(`All ${passed} check(s) passed.`);
    process.exit(0);
  } else {
    console.error(`${failed} check(s) FAILED (${passed} passed).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[verify-assets] Unexpected error:', err);
  process.exit(1);
});
