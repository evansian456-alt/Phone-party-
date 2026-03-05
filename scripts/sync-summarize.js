#!/usr/bin/env node
/**
 * scripts/sync-summarize.js
 *
 * Reads artifacts/sync/*.json and prints a human-readable summary:
 * - drift p50/p95/max
 * - RTT p50/p95
 * - correction counts
 * - hard resync counts
 * - offset stddev
 *
 * Usage:
 *   node scripts/sync-summarize.js
 *   node scripts/sync-summarize.js [--json]  (machine-readable output)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ARTIFACTS_DIR = path.resolve(__dirname, '..', 'artifacts', 'sync');
const isJson = process.argv.includes('--json');

// ── helpers ────────────────────────────────────────────────────────────────────

function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmt(n, decimals = 1) {
  if (n == null || !isFinite(n)) return 'N/A';
  return Number(n).toFixed(decimals);
}

function loadArtifacts() {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    console.error(`[sync-summarize] Artifacts directory not found: ${ARTIFACTS_DIR}`);
    console.error('  Run the sync metrics harness first: npm run test:e2e (with SYNC_TEST_MODE=true)');
    process.exit(1);
  }

  const files = fs.readdirSync(ARTIFACTS_DIR)
    .filter(f => f.endsWith('.json') && f !== '.gitkeep')
    .sort();

  if (files.length === 0) {
    console.error('[sync-summarize] No artifact files found in', ARTIFACTS_DIR);
    console.error('  Run: SYNC_TEST_MODE=true npm run test:e2e');
    process.exit(1);
  }

  return files.map(f => {
    try {
      const content = fs.readFileSync(path.join(ARTIFACTS_DIR, f), 'utf-8');
      return { file: f, data: JSON.parse(content) };
    } catch (e) {
      console.warn(`[sync-summarize] Could not parse ${f}: ${e.message}`);
      return null;
    }
  }).filter(Boolean);
}

// ── main ───────────────────────────────────────────────────────────────────────

function summarize(artifact) {
  const { file, data } = artifact;

  const summary = {
    file,
    label: data.label || file.replace('.json', ''),
    timestamp: data.timestamp || 'unknown',
    sampleCount: data.sampleCount || 0,
    note: data.note || null
  };

  if (data.sampleCount === 0 || data.note) {
    summary.status = 'NO_DATA';
    return summary;
  }

  summary.status = 'OK';
  summary.uptimeSec = data.uptimeSec;
  summary.totalClients = data.totalClients;

  // Party-level drift
  summary.avgDriftP50Ms = data.avgDriftP50Ms;
  summary.avgDriftP95Ms = data.avgDriftP95Ms;
  summary.maxDriftMs = data.maxDriftMs;

  // Corrections
  summary.finalCorrectionCount = data.finalCorrectionCount;
  summary.finalHardResyncCount = data.finalHardResyncCount;

  // Per-client details (if available)
  if (data.clients && data.clients.length > 0) {
    summary.clients = data.clients.map(c => ({
      clientId: c.clientId,
      rttMedianMs: c.rttMedianMs,
      rttP95Ms: c.rttP95Ms,
      clockOffsetMs: c.clockOffsetMs,
      clockOffsetStdDev: c.clockOffsetStdDev,
      driftP50Ms: c.driftP50Ms,
      driftP95Ms: c.driftP95Ms,
      correctionCount: c.correctionCount,
      hardResyncCount: c.hardResyncCount,
      networkStability: c.networkStability
    }));

    // Aggregate RTT from client data
    const rttMedians = data.clients.map(c => c.rttMedianMs).filter(v => v != null && v > 0);
    const rttP95s = data.clients.map(c => c.rttP95Ms).filter(v => v != null && v > 0);
    summary.avgRttMedianMs = avg(rttMedians);
    summary.avgRttP95Ms = avg(rttP95s);
    summary.avgClockOffsetStdDev = avg(data.clients.map(c => c.clockOffsetStdDev).filter(v => v != null));
  }

  return summary;
}

function printSummary(summary) {
  console.log('');
  console.log(`┌─────────────────────────────────────────────────────`);
  console.log(`│  ${summary.label.toUpperCase()}  (${summary.timestamp})`);
  console.log(`└─────────────────────────────────────────────────────`);

  if (summary.status === 'NO_DATA') {
    console.log(`  ⚠  No data: ${summary.note || 'no samples collected'}`);
    return;
  }

  console.log(`  Uptime:        ${fmt(summary.uptimeSec, 0)}s  |  Clients: ${summary.totalClients}`);
  console.log(`  Samples:       ${summary.sampleCount}`);
  console.log('');
  console.log('  Drift:');
  console.log(`    p50:         ${fmt(summary.avgDriftP50Ms)}ms`);
  console.log(`    p95:         ${fmt(summary.avgDriftP95Ms)}ms`);
  console.log(`    max:         ${fmt(summary.maxDriftMs)}ms`);
  console.log('');
  console.log('  Corrections:');
  console.log(`    Rate:        ${summary.finalCorrectionCount}`);
  console.log(`    Hard resync: ${summary.finalHardResyncCount}`);

  if (summary.avgRttMedianMs != null) {
    console.log('');
    console.log('  RTT (across clients):');
    console.log(`    median:      ${fmt(summary.avgRttMedianMs)}ms`);
    console.log(`    p95:         ${fmt(summary.avgRttP95Ms)}ms`);
    console.log(`    offset σ:    ${fmt(summary.avgClockOffsetStdDev)}ms`);
  }

  if (summary.clients && summary.clients.length > 0) {
    console.log('');
    console.log('  Per-client:');
    summary.clients.forEach(c => {
      console.log(`    [${c.clientId?.substring(0, 12) || '?'}]  RTT=${fmt(c.rttMedianMs)}ms  driftP95=${fmt(c.driftP95Ms)}ms  corrections=${c.correctionCount}  resyncs=${c.hardResyncCount}  stability=${fmt(c.networkStability, 2)}`);
    });
  }

  // Quality indicator
  console.log('');
  const p95 = summary.avgDriftP95Ms;
  let quality = '✅ GOOD';
  if (p95 > 200) quality = '⚠️  WARN (p95 > 200ms)';
  if (p95 > 500) quality = '❌ POOR (p95 > 500ms)';
  console.log(`  Quality:       ${quality}`);
}

// ── run ────────────────────────────────────────────────────────────────────────

const artifacts = loadArtifacts();
const summaries = artifacts.map(summarize);

if (isJson) {
  console.log(JSON.stringify(summaries, null, 2));
} else {
  console.log('\n=== Sync Engine Measurement Summary ===');
  console.log('=== Generated by scripts/sync-summarize.js ===');
  summaries.forEach(printSummary);
  console.log('');
  console.log('Run with --json for machine-readable output.');
  console.log('');
}
