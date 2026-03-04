'use strict';

/**
 * Stress-test ramp configuration.
 *
 * CI runs only stages 1-2 (smaller load) to keep wall-clock time under
 * control. Local runs additionally run stage 3. Set STRESS_STAGES env to a
 * comma-separated list of stage indices (1-based) to run specific stages.
 * Set STRESS_MAX_STAGE env to a number to cap the stage count.
 */

const path = require('path');

const IS_CI = process.env.CI === 'true' || process.env.CI === '1';

// Default max stage: 2 in CI, 3 locally.
const DEFAULT_MAX_STAGE = IS_CI ? 2 : 3;
const MAX_STAGE = parseInt(process.env.STRESS_MAX_STAGE || String(DEFAULT_MAX_STAGE), 10);

/** Ramp stages. Each stage must complete cleanly before the next begins. */
const ALL_STAGES = [
  // Stage 1 — warm-up
  { stage: 1, parties: 1, hostsPerParty: 1, guestsPerParty: 2 },
  // Stage 2 — moderate
  { stage: 2, parties: 5, hostsPerParty: 1, guestsPerParty: 5 },
  // Stage 3 — high (local only by default)
  { stage: 3, parties: 20, hostsPerParty: 1, guestsPerParty: 10 },
];

const STAGES = ALL_STAGES.slice(0, MAX_STAGE);

/**
 * Failure thresholds that cause the run to be declared unhealthy.
 * The orchestrator stops progressing to the next stage when any threshold
 * is breached.
 */
const THRESHOLDS = {
  /** Maximum acceptable error rate (%) across all calls in a stage. */
  errorRatePercent: parseFloat(process.env.STRESS_ERROR_RATE_PCT || '1'),
  /**
   * p95 response-time ceiling (ms).
   * Tighter locally; relaxed in CI due to shared runners.
   */
  p95LatencyMs: parseInt(
    process.env.STRESS_P95_LATENCY_MS || (IS_CI ? '1500' : '500'),
    10
  ),
  /**
   * Maximum WebSocket disconnect rate (%).
   * Currently HTTP-only simulation so this is unused but modelled for future
   * WebSocket probing.
   */
  wsDisconnectPercent: parseFloat(process.env.STRESS_WS_DISCONNECT_PCT || '5'),
};

/** Directory where JSON reports are written after each run. */
const REPORTS_DIR = path.resolve(__dirname, 'reports');

module.exports = { STAGES, THRESHOLDS, REPORTS_DIR, IS_CI };
