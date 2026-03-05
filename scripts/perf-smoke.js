#!/usr/bin/env node
/**
 * perf-smoke.js — lightweight performance regression guard.
 *
 * Usage:
 *   npm run perf:smoke          # compare against perf/baseline.json (fails on regression)
 *   npm run perf:baseline       # (re)generate perf/baseline.json
 *   PERF_WRITE_BASELINE=1 node scripts/perf-smoke.js  # same as perf:baseline
 *
 * Design goals:
 *   - Zero flakiness: only tests /healthz + /api/ping (no DB required)
 *   - Relaxed thresholds: absolute ceiling (800 ms p95) + 30% above baseline
 *   - Warm-up requests excluded from measurements
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../server');

const WRITE_BASELINE = process.env.PERF_WRITE_BASELINE === '1';
const BASELINE_PATH = path.resolve(__dirname, '..', 'perf', 'baseline.json');

// How many warm-up + measured requests to send
const WARMUP = 5;
const SAMPLES = 30;

// Absolute ceiling (ms) — even with no baseline, p95 must be under this
const ABSOLUTE_CEILING_MS = 800;

// Tolerance over baseline before failure (0.30 = 30%)
const TOLERANCE = 0.30;

async function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      res.resume(); // drain
      res.on('end', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        resolve(durationMs);
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function measureEndpoint(port, urlPath, label) {
  // warm-up
  for (let i = 0; i < WARMUP; i++) {
    await httpGet(port, urlPath).catch(() => {});
  }
  // measured
  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    try {
      times.push(await httpGet(port, urlPath));
    } catch {
      // count failures as a large latency so they don't silently disappear
      times.push(5000);
    }
  }
  times.sort((a, b) => a - b);
  const p50 = percentile(times, 50);
  const p95 = percentile(times, 95);
  console.log(`  [perf] ${label}: p50=${p50.toFixed(1)}ms  p95=${p95.toFixed(1)}ms`);
  return { p50, p95 };
}

async function main() {
  // Start a server on a random available port
  process.env.PORT = '0'; // let OS pick a port
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';

  console.log('[perf:smoke] Starting server…');
  const server = await startServer();

  // Retrieve the actual listening port
  const port = server.address().port;
  console.log(`[perf:smoke] Server listening on port ${port}`);

  let failed = false;
  const results = {};

  // Give server a moment to be fully ready
  await new Promise(r => setTimeout(r, 200));

  try {
    results.healthz = await measureEndpoint(port, '/healthz', 'GET /healthz');
    results.api_ping = await measureEndpoint(port, '/api/ping', 'GET /api/ping');
  } finally {
    server.close();
  }

  if (WRITE_BASELINE) {
    const baseline = {
      _comment: 'Perf smoke baseline — regenerate with: npm run perf:baseline',
      _updatedAt: new Date().toISOString(),
      ...results
    };
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`[perf:baseline] Written to ${BASELINE_PATH}`);
    return;
  }

  // Compare against committed baseline
  let baseline = null;
  if (fs.existsSync(BASELINE_PATH)) {
    try { baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch { /* ignore */ }
  }

  for (const [key, measured] of Object.entries(results)) {
    // Absolute ceiling check
    if (measured.p95 > ABSOLUTE_CEILING_MS) {
      console.error(`[perf:smoke] FAIL ${key} p95 ${measured.p95.toFixed(1)}ms > ceiling ${ABSOLUTE_CEILING_MS}ms`);
      failed = true;
    }

    // Baseline regression check
    if (baseline && baseline[key]) {
      const allowedP95 = baseline[key].p95 * (1 + TOLERANCE);
      if (measured.p95 > allowedP95) {
        console.error(`[perf:smoke] FAIL ${key} p95 ${measured.p95.toFixed(1)}ms > baseline+30% (${allowedP95.toFixed(1)}ms)`);
        failed = true;
      }
    }
  }

  if (failed) {
    process.exit(1);
  }

  console.log('[perf:smoke] ✅ All checks passed.');
}

main().catch((err) => {
  console.error('[perf:smoke] Error:', err.message);
  process.exit(1);
});
