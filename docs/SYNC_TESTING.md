# Sync Engine Testing Guide

This document explains how to measure, tune, and validate the sync engine on real devices and in automated CI.

---

## Architecture Overview

The upgraded sync engine uses:

| Phase | Feature | File |
|-------|---------|------|
| 1 | Monotonic clocks (`hrtime.bigint` / `performance.now()`) | `sync-engine.js`, `sync-client.js` |
| 2 | NTP-style rolling-window offset estimation (outlier rejection + EMA) | `sync-engine.js` |
| 3 | PLL-style drift correction (deadband, horizon, rate smoothing, caps) | `sync-engine.js` |
| 4 | Safe hard resync (seek) with cooldown protection | `sync-engine.js` |
| 5 | Precise scheduling near playback target | `sync-client.js` |
| 6 | Per-device learned audio latency compensation (test-mode only) | `sync-engine.js` |

### Key Tuning Knobs (`sync-config.js`)

| Constant | Default | Description |
|----------|---------|-------------|
| `CLOCK_SYNC_SAMPLES` | 15 | Rolling window size for NTP offset estimation |
| `CLOCK_SYNC_OUTLIER_TRIM` | 0.2 | Fraction of highest-RTT samples to discard (20%) |
| `CLOCK_SYNC_EMA_ALPHA` | 0.15 | EMA smoothing factor for clock offset (lower = more stable, slower) |
| `DRIFT_IGNORE_MS` | 40 | Deadband: ignore drift smaller than this (ms) |
| `DRIFT_SOFT_MS` | 120 | Upper bound for soft (rate) correction zone (ms) |
| `DRIFT_HARD_RESYNC_MS` | 200 | Threshold for hard resync (seek) (ms) |
| `PLL_HORIZON_SEC` | 4 | Correction horizon: spread correction over this many seconds |
| `MAX_RATE_DELTA_STABLE` | 0.01 | Max playback rate change on stable network (±1%) |
| `MAX_RATE_DELTA_UNSTABLE` | 0.02 | Max playback rate change on unstable network (±2%) |
| `PLAYBACK_RATE_SMOOTH_ALPHA` | 0.2 | EMA smoothing for rate changes |
| `HARD_RESYNC_COOLDOWN_MS` | 15000 | Minimum time between hard resyncs (15s) |
| `AUDIO_LATENCY_COMP_MAX_MS` | 80 | Max learned audio latency compensation (test-mode only) |

---

## SYNC_TEST_MODE

Enable test mode by setting the environment variable:

```bash
SYNC_TEST_MODE=true node server.js
```

When enabled:
- Structured JSON metrics are logged to stdout per correction/resync
- `GET /api/sync/metrics?partyId=<code>` is available for real-time metric polling
- Per-device audio latency compensation is activated

**⚠️ Do NOT enable in production.** Gate with `process.env.SYNC_TEST_MODE === 'true'`.

---

## Automated Harness (Playwright)

### Run the harness

```bash
# Start the server in test mode first (requires Redis or NODE_ENV=test):
SYNC_TEST_MODE=true npm run test:e2e -- --grep "Sync Metrics"

# Or via the e2e runner directly:
SYNC_TEST_MODE=true node scripts/e2e-runner.js --grep "sync-metrics"
```

This runs:
1. **1-device baseline** (`e2e-tests/sync-metrics.spec.js`) — 30s collection
2. **2-device comparison** — 45s collection

Artifacts are written to:
- `artifacts/sync/1-device.json`
- `artifacts/sync/2-device.json`

### Summarize results

```bash
node scripts/sync-summarize.js
# or for machine-readable output:
node scripts/sync-summarize.js --json
```

### Long run (optional, for detailed drift distribution)

```bash
npm run sync:longtest
```

Runs a 10-minute 2-device test and saves extended drift distribution data.

---

## Testing on Real Phones

### Prerequisites

- Both phones on the **same Wi-Fi network** (or hotspot)
- Server running and accessible from phones (note the IP, e.g. `192.168.1.100:8080`)
- SYNC_TEST_MODE enabled on the server
- A test audio file available at `/test-audio.wav` (included in `public/`)

### Steps

#### 1. Start the server in test mode

```bash
SYNC_TEST_MODE=true node server.js
# Note the IP address shown in the startup output
```

#### 2. Phone 1 — Create a party

1. Open `http://<server-ip>:8080` in Chrome/Safari on Phone 1
2. Sign up or log in
3. Tap **Create Party**
4. Note the party code shown (e.g. `AB12CD`)
5. Tap the audio URL field and enter: `http://<server-ip>:8080/test-audio.wav`
6. Tap **Start Party / Play**

#### 3. Phone 2 — Join the party

1. Open `http://<server-ip>:8080` on Phone 2
2. Enter the party code from Phone 1
3. Tap **Join Party**
4. Audio should begin playing in sync within a few seconds

#### 4. Collect metrics

While both phones are playing, open a browser tab (on a laptop or Phone 1) and visit:

```
http://<server-ip>:8080/api/sync/metrics?partyId=<party-code>
```

Refresh every 5–10 seconds to observe:
- `driftP95Ms` — should stabilize below 120ms after ~30s
- `totalHardResyncCount` — should be 0 or 1 in normal conditions
- `clients[*].correctionCount` — correction rate (typically 1–5/minute is good)
- `clients[*].rttMedianMs` — round-trip latency (< 20ms on local Wi-Fi is excellent)

#### 5. What to look for

| Metric | Target | Warning |
|--------|--------|---------|
| `driftP95Ms` (after 30s) | < 120ms | > 200ms |
| `totalHardResyncCount` | 0–1 | > 3 |
| `clients[*].rttMedianMs` | < 30ms | > 80ms |
| `clients[*].networkStability` | > 0.7 | < 0.5 |
| `clients[*].clockOffsetStdDev` | < 10ms | > 30ms |

#### 6. Duration

Run for at least **2 minutes**. The first 30 seconds are the "warm-up" period where the clock converges. Drift p95 typically drops significantly after 30–60 seconds.

---

## Interpreting Results

### Good sync (after stabilization)
```
driftP95Ms:     45ms  ✅
maxDriftMs:     89ms
hardResyncs:    0
corrections:    12
rttMedian:      8ms
```

### Needs tuning
```
driftP95Ms:     250ms  ⚠️
maxDriftMs:     520ms
hardResyncs:    3
corrections:    47
rttMedian:      42ms
```

If drift p95 is high:
1. Lower `DRIFT_IGNORE_MS` to 20ms (triggers corrections sooner)
2. Lower `DRIFT_HARD_RESYNC_MS` to 150ms (resync sooner)
3. Check `rttMedianMs` — if > 50ms, the Wi-Fi path has high latency; increase `PLL_HORIZON_SEC` to 6

If correction rate is too high (> 10/minute):
1. Increase `DRIFT_IGNORE_MS` to 60ms (larger deadband)
2. Increase `HARD_RESYNC_COOLDOWN_MS` to 20000ms

---

## Test Audio

A 10-second 440Hz sine wave is included at `public/test-audio.wav`.  
It's served at `http://<server>/test-audio.wav` without CORS restrictions (same-origin).

To use a different audio file for testing, place it in `public/` and reference it by URL.

---

## Comparing Before/After

```bash
# Before upgrade: copy existing artifacts
cp artifacts/sync/1-device.json artifacts/sync/1-device-baseline.json

# Run new upgrade and save
# (re-run the harness after changes)
node scripts/sync-summarize.js
```

The summary script reads all `*.json` files in `artifacts/sync/` and prints them side-by-side.
