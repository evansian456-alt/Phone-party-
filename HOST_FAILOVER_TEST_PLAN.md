# Host Failover - Manual Test Plan

## Overview
This document provides a manual testing procedure to verify that host failover works correctly when the host disconnects from a party.

## What Was Implemented

### Backend (server.js) - Already Complete
- **Host Election Logic** (lines 5923-6000): When host disconnects, first remaining member is elected as new host
- **HOST_CHANGED Event**: Broadcasts to all remaining members with `{ t: 'HOST_CHANGED', newHostId, newHostName, reason: 'host_disconnected' }`
- **Redis State Update**: Updates `partyData.hostId` in Redis for persistence
- **Permission Checks**: Existing `validateHostAuthority` automatically works with new host

### Client (app.js) - Newly Added
- **HOST_CHANGED Handler** (lines 1562-1590): Processes HOST_CHANGED events
- **State Update**: Sets `state.isHost = true` for the new host
- **UI Update**: Calls `showParty()` to switch from guest view to host view
- **Toast Notification**: Shows "🎉 You are now the host!" or "Host changed to {name}"

## Test Scenarios

### Scenario 1: Host Disconnect with One Guest
**Setup:**
1. Open two browser windows/tabs
2. Window 1: Create a party as host
3. Window 2: Join as guest

**Test Steps:**
1. Host: Upload a track and start playing
2. Guest: Verify you can hear the music and see the playback
3. Host: Close the browser window/tab (simulate disconnect)
4. Guest: Should see toast "🎉 You are now the host!"
5. Guest: UI should switch from guest view to host view
6. Guest (now host): Verify you can control playback (play/pause)
7. Guest (now host): Verify you can upload new tracks

**Expected Results:**
- ✅ Guest becomes host automatically
- ✅ UI switches from guest to host interface
- ✅ Toast notification appears
- ✅ New host has full playback controls
- ✅ Party continues without interruption

### Scenario 2: Host Disconnect with Multiple Guests
**Setup:**
1. Open three browser windows/tabs
2. Window 1: Create a party as host
3. Window 2: Join as Guest A (first to join)
4. Window 3: Join as Guest B (second to join)

**Test Steps:**
1. Host: Upload a track and start playing
2. All guests: Verify playback
3. Host: Close the browser window (simulate disconnect)
4. Guest A: Should see toast "🎉 You are now the host!" (first member becomes host)
5. Guest B: Should see toast "Host changed to Guest A"
6. Guest A: Verify UI switched to host view
7. Guest B: Should remain in guest view
8. Guest A (now host): Test playback controls
9. Guest A (now host): Try kicking Guest B

**Expected Results:**
- ✅ First guest (Guest A) becomes host
- ✅ Guest A sees host UI
- ✅ Guest B remains in guest view
- ✅ Both see appropriate toast notifications
- ✅ New host can control party
- ✅ Party continues for all members

### Scenario 3: Host Disconnect with No Guests
**Setup:**
1. Open one browser window
2. Create a party as host
3. DO NOT have any guests join

**Test Steps:**
1. Host: Upload a track and start playing
2. Host: Close the browser window

**Expected Results:**
- ✅ Party is cleaned up from server memory
- ✅ No errors in server console
- ✅ Party state removed from Redis

### Scenario 4: Cascading Failover
**Setup:**
1. Open three browser windows
2. Window 1: Create party as host
3. Window 2: Join as Guest A
4. Window 3: Join as Guest B

**Test Steps:**
1. Host: Close browser (Guest A becomes host)
2. Wait for failover to complete
3. Guest A (now host): Close browser (Guest B should become host)
4. Guest B: Verify they are now the host
5. Guest B: Test playback controls

**Expected Results:**
- ✅ First failover: Guest A becomes host
- ✅ Second failover: Guest B becomes host
- ✅ Party continues throughout both failovers
- ✅ No errors or crashes

### Scenario 5: Host Disconnect During Playback
**Setup:**
1. Open two browser windows
2. Window 1: Create party as host
3. Window 2: Join as guest

**Test Steps:**
1. Host: Upload a track and start playing (let it play for a few seconds)
2. Guest: Verify audio is playing and synced
3. Host: Close browser while track is playing
4. Guest (now host): Verify audio continues playing
5. Guest (now host): Try pausing and resuming
6. Guest (now host): Try seeking to different position

**Expected Results:**
- ✅ Audio continues playing during failover
- ✅ New host can pause/resume
- ✅ New host can seek
- ✅ No audio glitches or interruptions

## Console Verification

### Expected Server Logs
When host disconnects:
```
[Party] Host disconnected from party ABC123, attempting failover, instanceId: xxx
[Party] New host elected: guest-1-id for party ABC123
[Party] HOST_CHANGED broadcast to 1 members in party ABC123
[Party] Broadcasting room state to 1 members
```

### Expected Client Logs (New Host)
```
[HOST_CHANGED] New host: GuestName ID: guest-1-id
[HOST_CHANGED] You are now the host!
```

### Expected Client Logs (Other Guests)
```
[HOST_CHANGED] New host: GuestName ID: guest-1-id
[HOST_CHANGED] Host changed to: GuestName
```

## Network Tab Verification

### WebSocket Message (HOST_CHANGED event)
In browser DevTools > Network > WS > Messages, you should see:
```json
{
  "t": "HOST_CHANGED",
  "newHostId": "client-xyz-123",
  "newHostName": "Guest Name",
  "reason": "host_disconnected"
}
```

### ROOM State Update
After HOST_CHANGED, a ROOM state update should be broadcast:
```json
{
  "t": "ROOM",
  "snapshot": {
    "members": [
      {
        "id": "client-xyz-123",
        "name": "Guest Name",
        "isHost": true
      }
    ],
    ...
  }
}
```

## Edge Cases to Verify

1. **Rapid Succession Disconnects**: Multiple members disconnect quickly
2. **Host Rejoins**: Original host tries to rejoin after disconnecting
3. **Permission Checks**: New host can perform all host-only operations
4. **Redis Persistence**: Party state survives server restart (if Redis configured)

## Rollback Procedure

If host failover causes issues, revert the following:

### Client Changes (app.js)
Remove lines 1562-1590 (HOST_CHANGED handler)

```bash
git checkout HEAD~1 app.js
```

### Server Changes (Already Present)
The server-side implementation was completed in Phase 8. To disable:
1. Comment out lines 5936-5982 in server.js (host failover logic)
2. Restore original behavior: party ends when host leaves

```javascript
// In handleDisconnect function, replace host failover with:
if (member?.isHost) {
  // Original behavior: end party when host leaves
  console.log(`[Party] Host disconnected, ending party ${client.party}`);
  parties.delete(client.party);
  // ... cleanup code
}
```

## Success Criteria

All test scenarios pass with:
- ✅ No JavaScript errors in console
- ✅ No server crashes or errors
- ✅ Toast notifications appear correctly
- ✅ UI updates appropriately
- ✅ New host can control playback
- ✅ Party continues without interruption
- ✅ WebSocket messages match expected format

## Additional Notes

- **Security**: Host authority is validated server-side using `validateHostAuthority()` which checks `party.hostId` and `party.host`
- **Minimal Changes**: Only 30 lines added to app.js, no changes to existing functionality
- **No Breaking Changes**: Existing WebSocket message types unchanged, HOST_CHANGED is a new type
- **Logging**: All host changes are logged but no secrets (JWT_SECRET, DATABASE_URL, etc.) are logged
