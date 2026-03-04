'use strict';

/**
 * Lightweight in-process metrics collector for stress tests.
 *
 * Records call durations and outcomes, then computes p50 / p95 / p99
 * latency percentiles and per-endpoint error rates.
 */

class MetricsCollector {
  constructor() {
    /** @type {Map<string, number[]>} endpoint → sorted latency array (ms) */
    this._latencies = new Map();
    /** @type {Map<string, {ok: number, err: number}>} endpoint → counts */
    this._counts = new Map();
  }

  /**
   * Record a single API call outcome.
   *
   * @param {string} endpoint  A short label such as 'signup' or 'join-party'.
   * @param {number} durationMs  Elapsed time in milliseconds.
   * @param {boolean} ok  Whether the call succeeded.
   */
  record(endpoint, durationMs, ok) {
    if (!this._latencies.has(endpoint)) {
      this._latencies.set(endpoint, []);
      this._counts.set(endpoint, { ok: 0, err: 0 });
    }
    this._latencies.get(endpoint).push(durationMs);
    const c = this._counts.get(endpoint);
    if (ok) c.ok += 1;
    else c.err += 1;
  }

  /** Compute p-th percentile from an unsorted array of numbers. */
  static _percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  /**
   * Aggregate all recorded metrics into a report object.
   *
   * @returns {{
   *   totals: {ok: number, err: number, errorRatePercent: number},
   *   byEndpoint: Record<string, {ok, err, errorRatePct, p50, p95, p99, calls}>,
   *   p95LatencyMs: number
   * }}
   */
  summarise() {
    let totalOk = 0;
    let totalErr = 0;
    const byEndpoint = {};
    let allLatencies = [];

    for (const [ep, latencies] of this._latencies) {
      const counts = this._counts.get(ep);
      const calls = counts.ok + counts.err;
      const errorRatePct = calls === 0 ? 0 : (counts.err / calls) * 100;
      const p50 = MetricsCollector._percentile(latencies, 50);
      const p95 = MetricsCollector._percentile(latencies, 95);
      const p99 = MetricsCollector._percentile(latencies, 99);
      byEndpoint[ep] = { ok: counts.ok, err: counts.err, errorRatePct, p50, p95, p99, calls };
      totalOk += counts.ok;
      totalErr += counts.err;
      allLatencies = allLatencies.concat(latencies);
    }

    const total = totalOk + totalErr;
    const errorRatePercent = total === 0 ? 0 : (totalErr / total) * 100;
    const p95LatencyMs = MetricsCollector._percentile(allLatencies, 95);

    return {
      totals: { ok: totalOk, err: totalErr, errorRatePercent },
      byEndpoint,
      p95LatencyMs,
    };
  }

  /** Reset all collected data (call between stages). */
  reset() {
    this._latencies.clear();
    this._counts.clear();
  }
}

/**
 * Time a single async call, record the result, and return the full function
 * return value alongside the metrics data.
 *
 * @param {MetricsCollector} collector
 * @param {string} endpoint
 * @param {() => Promise<object>} fn  Should resolve to an object with an optional `ok` boolean.
 * @returns {Promise<object & {ok: boolean, durationMs: number}>}
 */
async function timed(collector, endpoint, fn) {
  const t0 = Date.now();
  let ok = false;
  let result = {};
  try {
    result = await fn();
    ok = result === null || result === undefined || result.ok !== false;
  } catch (_) {
    ok = false;
  }
  const durationMs = Date.now() - t0;
  collector.record(endpoint, durationMs, ok);
  return Object.assign({}, result, { ok, durationMs });
}

module.exports = { MetricsCollector, timed };
