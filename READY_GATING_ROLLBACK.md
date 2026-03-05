# Ready Gating Rollback Guide

## Quick Rollback Instructions

If the ready gating feature causes issues in production, follow this guide to quickly revert to the previous behavior.

## Option 1: Git Revert (Recommended)

```bash
# Find the commit hash for ready gating implementation
git log --oneline | grep -i "ready gating"

# Revert the commit (creates a new revert commit)
git revert <commit-hash>

# Push the revert
git push origin main
```

## Option 2: Manual Revert (If needed)

### Files Modified:
1. `server.js` - 2 locations
2. `app.js` - 1 location

### Changes to Revert:

#### 1. server.js - Remove ready tracking data structure

**Line ~2234**: Remove the partyReadiness Map
```javascript
// DELETE THIS:
// Ready gating: track client readiness per party for current track
// code -> { ready: Set<socketId>, readyInfo: Map<socketId, {bufferedSec, readyState}>, playSent: boolean, trackId: string }
const partyReadiness = new Map();
```

#### 2. server.js - Remove WebSocket message handlers

**Lines ~5159-5165**: Remove TRACK_LOAD_SUCCESS and TRACK_LOAD_FAILED cases
```javascript
// DELETE THESE CASES:
case "TRACK_LOAD_SUCCESS":
  handleTrackLoadSuccess(ws, sanitizedMsg);
  break;
case "TRACK_LOAD_FAILED":
  handleTrackLoadFailed(ws, sanitizedMsg);
  break;
```

**Lines ~5274-5328**: Remove handler functions
```javascript
// DELETE THESE FUNCTIONS:
function handleTrackLoadSuccess(ws, msg) { ... }
function handleTrackLoadFailed(ws, msg) { ... }
```

#### 3. server.js - Revert HTTP /api/start-track endpoint

**Lines ~3848-3960**: Replace ready gating logic with simple setTimeout
```javascript
// REPLACE WITH:
// Broadcast PREPARE_PLAY to all members
const prepareMessage = JSON.stringify({
  t: 'PREPARE_PLAY',
  trackId,
  trackUrl: trackUrl || null,
  title: title || 'Unknown Track',
  durationMs: durationMs || null,
  startAtServerMs: startAtServerMs,
  startPositionSec: startPositionSec || 0
});

party.members.forEach(m => {
  if (m.ws.readyState === WebSocket.OPEN) {
    m.ws.send(prepareMessage);
  }
});

// After leadTimeMs, set status to playing and broadcast PLAY_AT
setTimeout(() => {
  // Re-check party still exists
  const updatedParty = parties.get(code);
  if (!updatedParty || !updatedParty.currentTrack) return;
  
  // Update status to playing
  updatedParty.currentTrack.status = 'playing';
  
  console.log(`[HTTP] Track playing: ${trackId} at server time ${startAtServerMs}`);
  
  // Persist updated status
  persistPlaybackToRedis(code, updatedParty.currentTrack, updatedParty.queue || []);
  
  // Broadcast PLAY_AT to all members
  const playAtMessage = JSON.stringify({
    t: 'PLAY_AT',
    trackId,
    trackUrl: trackUrl || null,
    title: title || 'Unknown Track',
    durationMs: durationMs || null,
    startAtServerMs: startAtServerMs,
    startPositionSec: startPositionSec || 0
  });
  
  updatedParty.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(playAtMessage);
    }
  });
}, leadTimeMs);
```

#### 4. server.js - Revert WebSocket handleHostPlay

**Lines ~6355-6465**: Replace ready gating logic with simple setTimeout (same as above but use broadcastToPartyWithAck)

```javascript
// REPLACE WITH:
// Broadcast PREPARE_PLAY to ALL members with acknowledgment tracking (CRITICAL)
broadcastToPartyWithAck(
  client.party,
  { 
    t: "PREPARE_PLAY",
    trackId,
    trackUrl,
    title,
    filename,
    durationMs,
    startAtServerMs: startAtServerMs,
    startPositionSec: startPosition
  },
  MessagePriority.CRITICAL
);

// After leadTimeMs, set status to playing and broadcast PLAY_AT
setTimeout(() => {
  // Re-check party still exists
  const updatedParty = parties.get(client.party);
  if (!updatedParty || !updatedParty.currentTrack) return;
  
  // Update status to playing
  updatedParty.currentTrack.status = 'playing';
  
  console.log(`[Party] Track playing: ${filename} at server time ${startAtServerMs}`);
  
  // Persist updated status
  persistPlaybackToRedis(client.party, updatedParty.currentTrack, updatedParty.queue || []);
  
  // Broadcast PLAY_AT to all members with acknowledgment tracking (CRITICAL)
  broadcastToPartyWithAck(
    client.party,
    { 
      t: "PLAY_AT",
      trackId,
      trackUrl,
      title,
      filename,
      durationMs,
      startAtServerMs: startAtServerMs,
      startPositionSec: startPosition
    },
    MessagePriority.CRITICAL
  );
}, leadTimeMs);
```

#### 5. app.js - Revert client-side TRACK_LOAD_SUCCESS

**Lines ~1649-1673**: Remove buffering calculation
```javascript
// REPLACE WITH:
TrackLoader.loadWithRetry(audioEl, msg.trackUrl, trackId)
  .then(() => {
    console.log("[PREPARE_PLAY] Track loaded successfully:", msg.title);
    state.guestAudioReady = true;
    
    // Notify server of successful load
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        t: 'TRACK_LOAD_SUCCESS',
        trackId: trackId
      }));
    }
  })
```

## Verification After Rollback

1. **Restart server** (if needed)
2. **Test basic playback**:
   - Create a party
   - Join with 2 guests
   - Start playback
   - Verify it works (even if sync is less tight)

3. **Check logs**:
   - Should NOT see `[Party] Ready gating` logs
   - Should see `[HTTP] Track playing` or `[Party] Track playing` after fixed delay

4. **Monitor for issues**:
   - No JavaScript errors in browser console
   - No server crashes
   - Playback starts after predictable delay (~1-2 seconds)

## Expected Behavior After Rollback

- **Playback starts** after fixed `leadTimeMs` delay (typically 1200-2000ms)
- **No waiting** for clients to be ready
- **Synchronization** will be **less tight** than with ready gating (~200-500ms drift possible)
- **Clients** will still send `TRACK_LOAD_SUCCESS` messages (ignored by server after rollback)
- **No breaking changes** - all other features continue working

## Post-Rollback Actions

1. **Notify team** that ready gating has been disabled
2. **Document the issue** that caused the rollback
3. **Create a fix** if needed
4. **Re-test** in staging before re-deploying

## Testing the Rollback

```bash
# In one terminal, start the server
npm start

# In another terminal or browser
# 1. Open http://localhost:8080
# 2. Create party
# 3. Join with another browser
# 4. Start playback
# 5. Verify it works
```

## Support

If rollback doesn't resolve the issue:
1. Check server logs for errors
2. Review recent commits: `git log --oneline -10`
3. Consider reverting additional commits if needed
4. Check client browser console for errors

## Minimal Diff Guarantee

The ready gating feature was implemented with **minimal changes**:
- 3 files modified (server.js, app.js, and docs)
- No existing WebSocket message types renamed
- No route paths changed
- All existing behavior preserved
- Backward compatible (clients without buffering info still work)

Rolling back these changes is **safe and straightforward**.
