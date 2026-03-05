#!/usr/bin/env node
/**
 * scripts/sync-summarize.js
 *
 * Reads artifacts/sync/*.json and prints a summary table:
 *   - drift p50/p95/max
 *   - RTT p50/p95 (from first snapshot client metrics)
 *   - correction counts
 *   - hard resync counts
 *   - offset stddev
 *
 * Usage:
 *   node scripts/sync-summarize.js
 *   node scripts/sync-summarize.js --json       (machine-readable output)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ARTIFACTS_DIR = path.resolve(__dirname, '../artifacts/sync');
const isJson = process.argv.includes('--json');

// ─── Helpers ────────────────────────────────────────────────────────────────────

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function fmt(v, decimals = 1) {
  if (v === null || v === undefined) return 'n/a';
  return typeof v === 'number' ? v.toFixed(decimals) : String(v);
}

// ─── Read artifacts ─────────────────────────────────────────────────────────────

if (!fs.existsSync(ARTIFACTS_DIR)) {
  console.error(`[sync-summarize] Artifacts directory not found: ${ARTIFACTS_DIR}`);
  console.error('Run the sync metrics harness first: npm run test:e2e');
  process.exit(1);
}

const files = fs.readdirSync(ARTIFACTS_DIR)
  .filter(f => f.endsWith('.json') && f !== '.gitkeep');

if (!files.length) {
  console.error('[sync-summarize] No JSON artifact files found in', ARTIFACTS_DIR);
  console.error('Run the sync metrics harness first: npm run test:e2e');
  process.exit(1);
}

const results = [];

for (const file of files.sort()) {
  const fullPath = path.join(ARTIFACTS_DIR, file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (err) {
    console.warn(`[sync-summarize] Skipping ${file}: ${err.message}`);
    continue;
  }

  // Handle both "raw artifact" format and pre-summarized format
  const scenario = data.scenario || file.replace('.json', '');
  const summary = data.summary || {};
  const rawSnapshots = summary.rawSnapshots || data.rawSnapshots || [];

  // Collect per-client metrics across snapshots
  const rttMedians = [];
  const rttP95s = [];
  const clockOffsetStddevs = [];
  const driftP95s = [];
  const correctionCounts = [];
  const hardResyncCounts = [];

  for (const snap of rawSnapshots) {
    // Party-level metrics
    if (typeof snap.party?.driftP95Ms === 'number') driftP95s.push(snap.party.driftP95Ms);

    // Per-client metrics
    for (const c of snap.clients || []) {
      if (typeof c.rttMedianMs === 'number') rttMedians.push(c.rttMedianMs);
      if (typeof c.rttP95Ms === 'number') rttP95s.push(c.rttP95Ms);
      if (typeof c.clockOffsetStddev === 'number') clockOffsetStddevs.push(c.clockOffsetStddev);
      if (typeof c.correctionCount === 'number') correctionCounts.push(c.correctionCount);
      if (typeof c.hardResyncCount === 'number') hardResyncCounts.push(c.hardResyncCount);
    }
  }

  const totalHardResyncs = hardResyncCounts.reduce((s, v) => s + v, 0);
  const totalCorrections = correctionCounts.reduce((s, v) => s + v, 0);

  results.push({
    scenario,
    file,
    snapshotCount: summary.snapshotCount || rawSnapshots.length,
    stableSnapshotCount: summary.stableSnapshotCount || rawSnapshots.length,
    drift: {
      p50Ms: pct(driftP95s, 50),
      p95Ms: pct(driftP95s, 95),
      maxMs: summary.driftMaxMs || (driftP95s.length ? Math.max(...driftP95s) : null),
    },
    rtt: {
      medianMs: pct(rttMedians, 50),
      p95Ms: pct(rttP95s, 95),
    },
    clockOffsetStddev: {
      meanMs: mean(clockOffsetStddevs),
      maxMs: clockOffsetStddevs.length ? Math.max(...clockOffsetStddevs) : null,
    },
    corrections: {
      total: totalCorrections,
      hardResyncs: totalHardResyncs,
      maxRateChangesPerMin: summary.maxRateChangesPerMin || null,
    },
    collectedAt: data.collectedAt,
    durationMs: data.durationMs,
  });
}

// ─── Output ─────────────────────────────────────────────────────────────────────

if (isJson) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║              Sync Engine Metrics Summary                         ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

for (const r of results) {
  console.log(`┌─ Scenario: ${r.scenario} (${r.file})`);
  console.log(`│  Collected: ${r.collectedAt || 'n/a'}  Duration: ${r.durationMs ? (r.durationMs / 1000).toFixed(0) + 's' : 'n/a'}`);
  console.log(`│  Snapshots: ${r.snapshotCount} (stable: ${r.stableSnapshotCount})`);
  console.log('│');
  console.log(`│  Drift:   p50=${fmt(r.drift.p50Ms)}ms  p95=${fmt(r.drift.p95Ms)}ms  max=${fmt(r.drift.maxMs)}ms`);
  console.log(`│  RTT:     median=${fmt(r.rtt.medianMs)}ms  p95=${fmt(r.rtt.p95Ms)}ms`);
  console.log(`│  Offset stddev: mean=${fmt(r.clockOffsetStddev.meanMs)}ms  max=${fmt(r.clockOffsetStddev.maxMs)}ms`);
  console.log(`│  Corrections: total=${r.corrections.total}  hardResyncs=${r.corrections.hardResyncs}  maxRate/min=${fmt(r.corrections.maxRateChangesPerMin, 0)}`);
  console.log('└─────────────────────────────────────────────────────────────────\n');
}

if (results.length === 0) {
  console.log('No results to display.');
}
