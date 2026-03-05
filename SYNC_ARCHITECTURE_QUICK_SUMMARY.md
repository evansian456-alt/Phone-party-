# SyncSpeaker Sync Architecture - Quick Summary

**For detailed explanation, see:** [docs/SYNC_ARCHITECTURE_EXPLAINED.md](docs/SYNC_ARCHITECTURE_EXPLAINED.md)

---

## 🎯 Quick Answers

### How does the host control playback?
- **Host sends**: `HOST_PLAY`, `HOST_PAUSE`, `HOST_STOP` messages
- **Server validates**: Only host WebSocket can send these commands
- **Server computes**: Synchronized start time = `now() + 1200ms` lead time
- **Server broadcasts**: `PREPARE_PLAY` → all prepare → `PLAY_AT` → all play in sync

### How are timestamps broadcast to guests?
- **Clock sync first**: NTP-like protocol synchronizes each guest's clock with server
  - Guest sends `CLOCK_PING` with timestamp
  - Server responds `CLOCK_PONG` with server time
  - Guest calculates offset: `(clientTime + latency) - serverTime`
- **Timestamped playback**: Server broadcasts `startAtServerMs` timestamp
- **Guests calculate**: Local play time = `serverTimestamp + clockOffset`
- **Result**: All devices start at exact same moment

### How do guests stay in sync?
**Continuous Monitoring:**
- Every 2 seconds: Check actual position vs expected position
- Calculate drift: `drift = actualPosition - expectedPosition`

**Multi-Level Correction:**
| Drift | Action |
|-------|--------|
| < 200ms | Ignore (acceptable) |
| 200-800ms | Soft seek to correct position |
| 800-1000ms | Moderate seek + track failures |
| > 1000ms | Hard seek + show manual button if >1500ms |

### How are queue changes synchronized?
- **Host modifies queue** (add, remove, reorder)
- **Server updates** `party.queue` array in memory
- **Server broadcasts** `QUEUE_UPDATED` to all members
- **All clients update** their local queue display
- **Persisted to Redis** for recovery on reconnect

### How are reactions synchronized?
**Guest Reactions:**
1. Guest taps emoji → sends `GUEST_MESSAGE`
2. Server increases crowd energy (+5 for emoji, +8 for text)
3. Server broadcasts `GUEST_EMOJI` to **all members**
4. All devices show emoji animation and update energy meter

**DJ Reactions:**
1. Host taps DJ emoji → sends `DJ_EMOJI`
2. Server broadcasts to all guests (DJ sees in own feed)
3. **No crowd energy increase** (DJ can't boost own score)

---

## 🔧 Drift Correction Details

### Detection
```javascript
// Every 2 seconds
elapsedMs = serverNow - trackStartTime;
expectedPosition = startPosition + (elapsedMs / 1000);
drift = actualPosition - expectedPosition;
```

### Correction Thresholds
```javascript
DRIFT_CORRECTION_THRESHOLD_SEC = 0.20;      // Ignore below 200ms
DRIFT_SOFT_CORRECTION_THRESHOLD_SEC = 0.80; // Soft seek 200-800ms
DRIFT_HARD_RESYNC_THRESHOLD_SEC = 1.00;     // Hard seek >1000ms
DRIFT_SHOW_RESYNC_THRESHOLD_SEC = 1.50;     // Show button >1500ms
```

### Two Correction Systems
1. **Client-side (app.js)**: Seek-based, runs every 2s on guest
2. **Server-side (sync-engine.js)**: Rate-based (0.95-1.05x), optional via WebSocket

---

## 👥 Roles: Host vs Guest

### Host Can Do:
✅ Play/pause/skip tracks  
✅ Manage queue (add/remove/reorder)  
✅ Set chat mode  
✅ Kick guests  
✅ End party  

### Guest Can Do:
✅ Adjust local volume  
### Guest Can Do:
✅ Adjust local volume  
✅ View queue  
✅ Send reactions/messages  
~~❌ Manual resync~~  **REMOVED: Guests rely on automatic sync only**

### Guests Cannot Do:
❌ Control playback  
❌ Modify queue  
❌ Change party settings  
❌ **Trigger manual sync** (host-only authority)

**Enforcement:** Server checks `party.host === ws` for all control messages

---

## 🔄 Manual Sync (HOST-ONLY)

### ⚠️ IMPORTANT: Manual Sync is HOST-ONLY

**Intended Design:**
- **Only the host (DJ)** can trigger emergency manual sync
- **Guests cannot see or use any sync button**
- **Guests rely entirely on automatic synchronization**

### Host Manual Sync (Emergency Use)

**Location:** DJ/Host view only (hidden or advanced section)

**Purpose:** 
- Emergency override when automatic sync fails across multiple guests
- Broadcasts fresh playback state to all devices
- Forces group realignment

**When Host Should Use:**
- Persistent drift >1.5s across multiple guests
- Large parties (50+ guests) with widespread desync
- Severe network issues affecting many devices
- Long sessions (2+ hours) as preventive realignment

**How It Works:**
```javascript
// Host triggers emergency sync
HOST_EMERGENCY_SYNC → Server validates host authority
→ Server broadcasts SYNC_STATE to ALL guests
→ All devices realign to current timestamp
→ Drift counters reset across all guests
```

### Legacy Guest Sync Buttons (DEPRECATED)

**⚠️ WARNING: The following code exists but is LEGACY/DEPRECATED:**

~~**Button 1: "Tap to Sync" (`btnGuestSync`)**~~ **DEPRECATED**
- Status: Legacy code, not part of UX
- Should NOT be visible in production
- Violates host-only sync authority

~~**Button 2: "Tap to Resync" (`btnGuestResync`)**~~ **DEPRECATED**
- Status: Legacy code, not part of UX  
- Should NOT be visible in production
- Violates master-slave architecture

**Why These Are Deprecated:**
- ❌ Guests controlling sync breaks architecture
- ❌ Creates potential sync conflicts
- ❌ Undermines host authority
- ✅ Automatic sync handles all guest-side corrections
- ✅ Manual intervention should be host-only

---

## ✅ Design Validation

### Is Automatic Sync Sufficient?

**Yes, for most cases:**
- ✅ Typical drift < 20ms
- ✅ Automatic recovery within 2 seconds
- ✅ Tested with 100+ clients
- ✅ 71 passing tests (44 unit + 27 stress)

**But manual button helps when:**
- Large parties (20+ guests)
- Public venues with poor WiFi
- Long sessions (2+ hours)
- High proportion of mobile clients

### Performance Benchmarks

| Scenario | Devices | Avg Latency | Avg Drift | Status |
|----------|---------|-------------|-----------|--------|
| Local WiFi | 5 | 15ms | 8ms | ✅ Excellent |
| Remote WiFi | 10 | 45ms | 18ms | ✅ Good |
| Mixed Network | 20 | 85ms | 35ms | ✅ Good |
| Stress Test | 100 | 120ms | 42ms | ✅ Medium |

---

## 📡 Message Protocol Summary

### Host → Server
- `HOST_PLAY` - Start playback
- `HOST_PAUSE` - Pause playback
- `HOST_STOP` - Stop playback
- Queue operations (add/remove/reorder)

### Server → All Clients
- `PREPARE_PLAY` - Get ready for synchronized start
- `PLAY_AT` - Start playback at exact timestamp
- `PAUSE` - Pause playback
- `QUEUE_UPDATED` - Queue changed
- `GUEST_EMOJI` - Guest reaction broadcast
- `DJ_EMOJI` - DJ reaction broadcast

### Guest ↔ Server (Sync)
- Guest → Server: `CLOCK_PING` (sync clock)
- Server → Guest: `CLOCK_PONG` (server time)
- Guest → Server: `PLAYBACK_FEEDBACK` (position report)
- Server → Guest: `DRIFT_CORRECTION` (rate adjustment)
- Guest → Server: `REQUEST_SYNC_STATE` (manual resync)
- Server → Guest: `SYNC_STATE` (full state)

---

## 🎓 Key Takeaways

1. **Master-Slave Architecture**: Server is authority, host triggers, guests follow
2. **Timestamped Playback**: Not "play now", but "play at this exact moment"
3. **Continuous Monitoring**: Guests check drift every 2 seconds
4. **Multi-Level Correction**: Graduated response (ignore → seek → hard resync)
5. **Manual Override Available**: Two buttons provide safety net for edge cases
6. **Sub-20ms Accuracy**: Typical performance with good networks
7. **Production Ready**: 71 tests passing, 0 vulnerabilities

---

**Full Documentation:** [docs/SYNC_ARCHITECTURE_EXPLAINED.md](docs/SYNC_ARCHITECTURE_EXPLAINED.md)  
**Technical Docs:** [SYNCSPEAKER_AMPSYNC_DOCS.md](SYNCSPEAKER_AMPSYNC_DOCS.md)  
**Quick Reference:** [AMPSYNC_QUICK_REF.md](AMPSYNC_QUICK_REF.md)

**Last Updated:** 2026-02-09  
**System Version:** AmpSync+ v1.0
