# Ready Gating Manual Test Plan

## Overview
This document provides a manual test plan to verify the ready gating feature for synchronized playback.

## Test Environment Setup
1. **Server**: Start the server locally with `npm start`
2. **Browsers**: Use 3 separate browser instances (or browser profiles)
   - Browser A: Host (normal network)
   - Browser B: Guest 1 (normal network)
   - Browser C: Guest 2 (throttled network - simulates slow loading)

## Test Prerequisites
- Server is running on `http://localhost:8080`
- All browsers can access the server
- Have a test audio file ready to upload/play

## Test Case 1: Normal Conditions - All Guests Ready Quickly

### Steps:
1. **Browser A (Host)**:
   - Create a new party
   - Note the party code
   - Upload a test audio file

2. **Browser B & C (Guests)**:
   - Join the party using the code
   - Wait for connection confirmation

3. **Browser A (Host)**:
   - Click "Play" to start the track
   - Observe server logs

### Expected Results:
- ✅ All browsers receive `PREPARE_PLAY` message
- ✅ Server logs show: `[Ready] Client X ready for track Y: buffered=...s, readyState=...`
- ✅ Server logs show ready gating completion: `[Party] Ready gating party=XXXX track=YYYY ready=3/3 timeout=false avgBuffered=...s`
- ✅ All browsers receive `PLAY_AT` message shortly after becoming ready (< 1 second)
- ✅ All browsers start playback in tight synchronization (< 100ms drift)
- ✅ No timeout occurs (timeout=false in logs)

### How to Verify:
- Open browser console in all 3 browsers to see client-side logs
- Monitor server terminal for ready gating logs
- Listen to the audio - it should sound like one unified playback

---

## Test Case 2: Throttled Guest - Server Waits for Ready

### Steps:
1. **Browser C (Guest 2)**: 
   - Open Chrome DevTools (F12)
   - Go to Network tab
   - Enable "Network throttling" → Select "Slow 3G" or "Fast 3G"

2. **Browser A (Host)**:
   - Create a new party
   - Upload a test audio file

3. **Browser B & C (Guests)**:
   - Join the party

4. **Browser A (Host)**:
   - Click "Play" to start the track
   - Observe server logs carefully

### Expected Results:
- ✅ All browsers receive `PREPARE_PLAY` message
- ✅ Server logs show Browser A & B become ready quickly
- ✅ Server logs show Browser C takes longer to load (slower `[Ready]` log)
- ✅ Server waits for Browser C to reach threshold (80% of members = 3 members)
- ✅ Once threshold reached or buffer quality is good, server sends `PLAY_AT`
- ✅ Server logs: `[Party] Ready gating party=XXXX track=YYYY ready=3/3 timeout=false avgBuffered=...s`
- ✅ Playback starts synchronized across all browsers despite Browser C's slow network

### How to Verify:
- Check timestamps in server logs - there should be a noticeable delay between first `[Ready]` log and `PLAY_AT` broadcast
- Browser C should not start late despite network throttling
- All browsers should be within ~100ms of each other

---

## Test Case 3: Timeout Scenario - Guest Never Becomes Ready

### Steps:
1. **Browser C (Guest 2)**:
   - Open Chrome DevTools (F12)
   - Go to Network tab
   - Enable "Network throttling" → Select "Offline" **OR**
   - Close the browser tab **after** joining the party but **before** host plays

2. **Browser A (Host)**:
   - Create a new party
   - Upload a test audio file

3. **Browser B & C (Guests)**:
   - Join the party

4. **Make Browser C unavailable** (offline or close tab)

5. **Browser A (Host)**:
   - Click "Play" to start the track
   - Wait and observe server logs for ~8 seconds

### Expected Results:
- ✅ Browsers A & B receive `PREPARE_PLAY` and become ready
- ✅ Server logs show only 2 out of 3 members become ready
- ✅ Server waits for 8000ms (maxWaitMs timeout)
- ✅ After timeout, server sends `PLAY_AT` anyway
- ✅ Server logs: `[Party] Ready gating party=XXXX track=YYYY ready=2/3 timeout=true avgBuffered=...s`
- ✅ Browsers A & B start playback together despite Browser C not being ready

### How to Verify:
- Measure time between "Play" click and actual playback start - should be ~8 seconds
- Server log should show `timeout=true`
- Playback should proceed for ready members without waiting forever

---

## Test Case 4: Buffering Quality Check

### Steps:
1. **Browser C (Guest 2)**:
   - Open Chrome DevTools (F12)
   - Go to Network tab
   - Enable "Network throttling" → Select "Fast 3G" (not too slow, but not instant)

2. **Browser A (Host)**:
   - Create a party
   - Upload a **large audio file** (> 5MB) to test buffering

3. **Browser B & C (Guests)**:
   - Join the party

4. **Browser A (Host)**:
   - Click "Play"
   - Watch server logs for buffering info

### Expected Results:
- ✅ Server logs show `bufferedSec` values for each client
- ✅ Server waits until 70% of ready clients have `bufferedSec >= 3.0` OR `readyState >= 3`
- ✅ Server log shows: `[Ready] Client X ready for track Y: buffered=X.Xs, readyState=X`
- ✅ Adequate buffering before playback starts

---

## Log Analysis Guide

### Key Server Logs to Monitor:

1. **Client Ready Status**:
   ```
   [Ready] Client XXXX ready for track YYYY: buffered=5.2s, readyState=4
   ```
   - `buffered`: Seconds of audio buffered ahead
   - `readyState`: HTML5 audio readyState (4 = HAVE_ENOUGH_DATA)

2. **Ready Gating Decision**:
   ```
   [Party] Ready gating party=XXXX track=YYYY ready=3/3 timeout=false avgBuffered=4.5s
   ```
   - `ready=X/Y`: X members ready out of Y total
   - `timeout=true/false`: Whether decision was forced by timeout
   - `avgBuffered`: Average buffered seconds across ready clients

### Thresholds:
- **Ready Threshold**: 80% of members (ceil)
  - 1 member: requires 1 (100%)
  - 2 members: requires 2 (100%)
  - 3 members: requires 3 (100% due to ceiling)
  - 4 members: requires 4 (100% due to ceiling)
  - 5 members: requires 4 (80%)

- **Buffer Quality**: 70% of ready clients must have:
  - `bufferedSec >= 3.0` **OR**
  - `readyState >= 3`

- **Timeout**: 8000ms (8 seconds) maximum wait

---

## Rollback Note

### If Ready Gating Causes Issues:

The ready gating feature can be quickly disabled by reverting to the previous fixed-delay approach:

1. **Locate the changes**: The changes are in `server.js` (2 locations) and `app.js` (1 location)

2. **Server changes**: 
   - Lines ~3850-3960 in HTTP `/api/start-track` endpoint
   - Lines ~6355-6465 in WebSocket `handleHostPlay` function

3. **Revert strategy**:
   ```bash
   git revert <commit-hash>
   ```
   Or manually replace the ready gating logic with:
   ```javascript
   setTimeout(() => {
     // Send PLAY_AT immediately after fixed delay
     // (original logic)
   }, leadTimeMs);
   ```

4. **Client changes**:
   - Lines ~1649-1673 in `app.js`
   - Revert the additional fields in `TRACK_LOAD_SUCCESS` message
   - Remove `bufferedSec` and `readyState` fields

5. **Verification after rollback**:
   - Server should send `PLAY_AT` after fixed delay (no waiting for clients)
   - Clients should still send `TRACK_LOAD_SUCCESS` (backwards compatible)
   - Synchronization will be less tight but more predictable

---

## Success Criteria

The ready gating feature is working correctly if:
1. ✅ Server waits for most clients (80%) to be ready before sending `PLAY_AT`
2. ✅ Server checks buffering quality (70% with >=3s buffered OR readyState>=3)
3. ✅ Server times out after 8 seconds and proceeds anyway
4. ✅ Synchronization is tighter than before (< 100ms drift vs previous ~500ms)
5. ✅ No secrets are logged in server output
6. ✅ Feature degrades gracefully (timeout ensures playback always starts)

---

## Additional Notes

- **Development Mode**: Logs are verbose. Set `DEBUG_MODE=true` to see detailed ready tracking.
- **Production Mode**: Logs are concise. Only `[Party] Ready gating` summary is logged.
- **No Breaking Changes**: 
  - Existing WebSocket message types unchanged
  - `PREPARE_PLAY` and `PLAY_AT` retain same structure
  - `TRACK_LOAD_SUCCESS` enhanced with optional fields (backwards compatible)
