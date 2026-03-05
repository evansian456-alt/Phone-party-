# Sync Engine Testing Guide

This document explains how to test and tune the sync engine on real devices and in CI.

## Overview

The sync engine uses a **PLL (Phase-Locked Loop)** style approach to keep all connected devices playing audio at the same position:

1. **Monotonic clocks** – server uses `process.hrtime.bigint()`, client uses `performance.now()`, both anchored to wall-clock at startup. This avoids NTP jumps.
2. **Rolling-window NTP** – 15-sample rolling window, top 20% RTT outliers discarded, EMA-smoothed clock offset (α=0.15).
3. **PLL drift correction** – dead-band (ignore <40ms), rate-correction (40–200ms), hard seek (≥200ms).
4. **Hard-seek cooldown** – prevents seek oscillation (15s minimum between seeks per client).
5. **Audio latency compensation** – optional, learns device output latency bias slowly (enabled in SYNC_TEST_MODE).

---

## Configurable Knobs (`sync-config.js`)

| Constant | Default | Description |
|---|---|---|
| `CLOCK_SYNC_SAMPLES` | 15 | NTP rolling window size |
| `CLOCK_SYNC_OUTLIER_TRIM` | 0.2 | Fraction of highest-RTT samples to discard |
| `CLOCK_SYNC_EMA_ALPHA` | 0.15 | EMA smoothing factor for clock offset |
| `DRIFT_IGNORE_MS` | 40 | Dead-band – drift below this is ignored |
| `DRIFT_SOFT_MS` | 120 | Soft correction range upper bound |
| `DRIFT_HARD_RESYNC_MS` | 200 | Threshold for hard seek resync |
| `PLL_HORIZON_SEC` | 4 | Time horizon for rate correction |
| `MAX_RATE_DELTA_STABLE` | 0.01 | Max rate change on stable network (±1%) |
| `MAX_RATE_DELTA_UNSTABLE` | 0.02 | Max rate change on unstable network (±2%) |
| `PLAYBACK_RATE_SMOOTH_ALPHA` | 0.2 | EMA alpha for rate changes |
| `HARD_RESYNC_COOLDOWN_MS` | 15000 | Min time between hard resyncs per client |
| `SYNC_TEST_MODE` | false | Enable test metrics, auto-load test audio |

---

## Running the Automated Harness

### Prerequisites

```bash
# Install dependencies
npm install

# Start the server locally
SYNC_TEST_MODE=true npm run dev
```

### 1-device and 2-device baseline

```bash
# Standard harness (60s / 90s runs)
SYNC_TEST_MODE=true npm run test:e2e

# Artifacts are saved to:
#   artifacts/sync/1-device.json
#   artifacts/sync/2-device.json
```

### Long run (5–10 minutes, for stability analysis)

```bash
SYNC_TEST_MODE=true SYNC_LONGTEST=true npm run sync:longtest
```

### View summary of results

```bash
node scripts/sync-summarize.js

# Machine-readable output:
node scripts/sync-summarize.js --json
```

---

## Metrics Endpoint

When `SYNC_TEST_MODE=true` is set (or outside production), a metrics snapshot is available:

```
GET /api/sync/metrics?partyId=PARTY_CODE
```

Response shape:

```json
{
  "partyId": "ABC123",
  "serverTimeMs": 1700000000000,
  "totalClients": 2,
  "party": {
    "driftP50Ms": 5.2,
    "driftP95Ms": 28.4,
    "maxDriftMs": 55.1
  },
  "clients": [
    {
      "clientId": "...",
      "clockQuality": "good",
      "clockOffsetMs": -12.3,
      "clockOffsetStddev": 4.1,
      "rttMedianMs": 45.0,
      "rttP95Ms": 72.0,
      "networkStability": 0.93,
      "lastDriftMs": 15.0,
      "driftP50Ms": 8.0,
      "driftP95Ms": 22.0,
      "playbackRate": 1.002,
      "correctionCount": 12,
      "rateChangesPerMin": 4,
      "hardResyncCount": 0,
      "audioLatencyCompMs": 0,
      "joinTime": 1700000000000
    }
  ]
}
```

---

## Testing on Real Phones

### Setup

1. Both phones must be on the **same Wi-Fi network** as the server.
2. Start the server with `SYNC_TEST_MODE=true npm run dev` (or `npm start`).
3. Note the server's LAN IP (e.g. `192.168.1.100:8080`).

### 1-phone test

1. Open `http://192.168.1.100:8080` on Phone 1.
2. Sign up / log in.
3. Tap **Start Party** → note the party code.
4. Tap **Add Track** → select or paste the test audio URL (`/test-audio.wav`).
5. Tap **Play** to start playback.
6. Poll the metrics endpoint from any browser:
   ```
   http://192.168.1.100:8080/api/sync/metrics?partyId=YOUR_CODE
   ```
7. Watch `driftP95Ms` drop over 30–60 seconds as the clock sync stabilizes.
8. **Good result**: `driftP95Ms < 50ms` after 60 seconds.

### 2-phone test

1. Follow steps 1–5 above for Phone 1 (host).
2. Open `http://192.168.1.100:8080` on Phone 2 (guest).
3. Sign in / join as guest using the party code from Phone 1.
4. Both phones should now be playing the same audio.
5. Poll metrics — you'll see 2 entries in `clients[]`.
6. Watch for:
   - `driftP95Ms < 80ms` after 60 seconds warm-up.
   - `hardResyncCount` stays at 0–1.
   - `rateChangesPerMin` stays under 20.

### What to look for

| Metric | Green | Yellow | Red |
|---|---|---|---|
| `driftP95Ms` (after 60s) | < 50ms | 50–120ms | > 120ms |
| `hardResyncCount` (per 5min) | 0–1 | 2–3 | > 3 |
| `rateChangesPerMin` | < 10 | 10–30 | > 30 |
| `clockQuality` | excellent/good | fair | poor |
| `rttP95Ms` | < 80ms | 80–200ms | > 200ms |

### Interpreting poor results

- **High drift + high RTT**: Network is congested. Try moving closer to the router.
- **Oscillating playbackRate**: PLL is hunting. Lower `PLAYBACK_RATE_SMOOTH_ALPHA` (e.g. 0.1) or increase `DRIFT_IGNORE_MS`.
- **Frequent hard resyncs**: Clock offset estimation is poor. Check if `clockQuality` is 'poor'. May need better Wi-Fi.
- **Clock quality 'poor'**: RTT variance is high. The EMA will take longer to converge. Wait 2–3 minutes before judging.

---

## How the PLL Works (Brief)

1. Client reports `audioElement.currentTime` every 100ms.
2. Server computes `expectedPosition = (now - trackStart) / 1000`.
3. `drift = (reportedPosition - expectedPosition) * 1000` (ms).
4. If `|drift| < 40ms`: do nothing.
5. If `40 ≤ |drift| < 200ms`: adjust `playbackRate` by `-(drift_sec / 4s)`, capped at ±1–2%.
6. If `|drift| ≥ 200ms`: hard seek to `expectedPosition` (if cooldown allows).
7. Client receives `DRIFT_CORRECTION { mode, rateDelta, seekToSec }`.

---

## Test Audio File

A 10-second 440Hz sine wave WAV is included at `public/test-audio.wav`.  
It is served as a static file at `/test-audio.wav`.

To use a longer file, replace `public/test-audio.wav` with any WAV file.
