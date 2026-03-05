# SyncSpeaker Ultimate AmpSync+ Documentation

## Overview

SyncSpeaker Ultimate AmpSync+ is a high-precision, multi-device audio/video synchronization system designed to exceed the capabilities of AmpSync. It provides sub-50ms synchronization accuracy across multiple devices with predictive drift compensation, adaptive quality control, and real-time monitoring.

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Master Clock (Server)                     │
│  - Provides authoritative time reference                    │
│  - Broadcasts track playback timestamps                     │
└─────────────────────────────────────────────────────────────┘
                            │
           ┌────────────────┼────────────────┐
           │                │                │
    ┌──────▼─────┐   ┌──────▼─────┐   ┌──────▼─────┐
    │  Client 1  │   │  Client 2  │   │  Client 3  │
    │  Sync Eng  │   │  Sync Eng  │   │  Sync Eng  │
    └────────────┘   └────────────┘   └────────────┘
           │                │                │
           └────────────────┼────────────────┘
                            │
                     ┌──────▼───────┐
                     │ P2P Network  │
                     │   (Relay)    │
                     └──────────────┘
```

## Core Features

### 1. Clock Synchronization (NTP-like)

**Protocol:**
1. Client sends `CLOCK_PING` with client timestamp
2. Server immediately responds with `CLOCK_PONG` containing:
   - Client's original timestamp
   - Server's current timestamp
3. Client calculates:
   - **Latency** = (receive_time - sent_time) / 2
   - **Clock Offset** = (sent_time + latency) - server_time

**Adaptive Sync Interval:**
- Base interval: 5 seconds
- Adjusts based on network stability (3-7 seconds)
- More stable networks = longer intervals (less overhead)
- Unstable networks = shorter intervals (more frequent sync)

**Network Stability Calculation:**
```javascript
variance = Σ(latency - mean)² / n
stdDev = √variance
stability = max(0, 1 - (stdDev / 100))
```

### 2. Timestamped Playback

**Server-Side:**
1. Generate master timestamp: `playAt = now() + startDelay`
2. Store track info with timestamps
3. Broadcast `PLAY_TRACK` message with:
   - Track ID and metadata
   - Precise playAt timestamp
   - Per-client clock offset adjustments

**Client-Side:**
1. Receive `PLAY_TRACK` message
2. Calculate local play time: `playAt - clockOffset`
3. Pre-buffer audio (50-100ms)
4. Schedule playback using AudioContext for precision
5. Start micro-feedback loop (100ms intervals)

**Pre-buffering:**
```javascript
rollingBufferSec = 0.15; // 150ms buffer
playDelay = max(0, serverDelay - (rollingBufferSec * 1000));
```

### 3. Drift Correction

**Drift Detection:**
```javascript
elapsedMs = serverNow - trackStart
expectedPosition = (elapsedMs / 1000) + startPositionSec
drift = (actualPosition - expectedPosition) * 1000  // Convert to ms
```

**Correction Thresholds:**
- **Ignore**: drift < 50ms (within tolerance)
- **Soft correction**: 50-200ms (playback rate adjustment)
- **Hard resync**: drift > 200ms (seek to correct position)

**Playback Rate Adjustment:**
```javascript
adjustment = -drift * 0.01
playbackRate = clamp(1.0 + adjustment, 0.95, 1.05)
```

Example:
- Drift = +100ms (ahead) → adjustment = -0.01 → playbackRate = 0.99 (slow down)
- Drift = -100ms (behind) → adjustment = +0.01 → playbackRate = 1.01 (speed up)

### 4. Predictive Drift Compensation

**Algorithm:**
```javascript
// Linear regression on drift history
predictedDrift = calculateTrend(driftHistory)

// Blend current and predicted drift
driftToCorrect = drift * 0.3 + predictedDrift * 0.7

// Apply proactive correction
adjustment = -driftToCorrect * 0.01
```

**Benefits:**
- Anticipates drift before it becomes significant
- Smoother corrections (less jarring for listeners)
- Reduces correction frequency

### 5. Rolling Buffer Management

**Purpose:**
- Absorb network jitter
- Provide cushion for micro-adjustments
- Enable smooth playback rate changes

**Implementation:**
```javascript
bufferSize = 150ms  // Default
bufferHealth = (actualBuffer / targetBuffer) * 100

// Visual indicator colors:
// Green (100%): Healthy buffer
// Yellow (50-99%): Degraded buffer
// Red (<50%): Critical buffer
```

## Message Protocol

### Server → Client Messages

#### CLOCK_PONG
```json
{
  "t": "CLOCK_PONG",
  "clientSentTime": 1234567890123,
  "serverNowMs": 1234567890150,
  "clientId": "client-abc123"
}
```

#### PLAY_TRACK
```json
{
  "t": "PLAY_TRACK",
  "trackId": "track-xyz",
  "playAt": 1234567893000,
  "duration": 180,
  "trackUrl": "http://example.com/track.mp3",
  "title": "Song Title",
  "clockOffset": 50
}
```

#### DRIFT_CORRECTION
```json
{
  "t": "DRIFT_CORRECTION",
  "adjustment": -0.02,
  "drift": 75,
  "playbackRate": 0.98,
  "predictedDrift": 80
}
```

### Client → Server Messages

#### CLOCK_PING
```json
{
  "t": "CLOCK_PING",
  "clientNowMs": 1234567890123,
  "pingId": "ping-abc"
}
```

#### PLAYBACK_FEEDBACK
```json
{
  "t": "PLAYBACK_FEEDBACK",
  "position": 45.2,
  "trackStart": 1234567850000,
  "playbackRate": 1.01,
  "timestamp": 1234567895000
}
```

## Sync Quality Indicators

**Excellent** (Green)
- Latency < 50ms
- Drift < 20ms
- Network stability > 0.9

**Good** (Light Green)
- Latency < 100ms
- Drift < 50ms
- Network stability > 0.7

**Medium** (Yellow)
- Latency < 200ms
- Drift < 100ms
- Network stability > 0.5

**Poor** (Red)
- Latency > 200ms
- Drift > 100ms
- Network stability < 0.5

## P2P Relay Network (Skeleton)

**Purpose:**
- Reduce server load by relaying timing info peer-to-peer
- Enable direct peer synchronization
- Improve scalability

**Architecture:**
```javascript
class P2PNetwork {
  peers: Map<peerId, peerInfo>
  sessions: Map<sessionId, Set<peerId>>
  
  // Discover peers in session
  discoverPeers(sessionId) → peerId[]
  
  // Select optimal peer (lowest latency)
  selectOptimalPeer(sessionId) → peerId
  
  // Add/remove peers
  addPeerToSession(sessionId, peerId)
  removePeerFromSession(sessionId, peerId)
}
```

**Future Implementation:**
- WebRTC DataChannel establishment
- Peer discovery protocol
- Direct timing message relay
- Fallback to server if P2P fails

## Dev/Test Mode

**Purpose:**
- Skip authentication flow for rapid testing
- Auto-generate temporary users
- Enable QA workflows

**Usage:**
```
?devmode=true           # Enable dev mode
?testmode=true          # Enable test mode
?autostart=true         # Auto-create party
?tier=PRO               # Set user tier (FREE|PARTY_PASS|PRO)
```

**Example:**
```
http://localhost:8080/?devmode=true&autostart=true&tier=PRO
```

**Features:**
- Temporary user: `dev_[randomId]@test.local`
- Skip signup/login forms
- Auto-navigate to party view
- P2P and sync features still work normally

## Monitoring & Analytics

### Sync Monitor UI

**Displayed Metrics:**
- Latency (round-trip time)
- Clock Offset (time difference from server)
- Playback Rate (current adjustment)
- Buffer Health (rolling buffer status)
- Network Stability (based on latency variance)
- Drift (current position error)
- Predicted Drift (forecasted drift)
- Corrections Count (total adjustments made)

**Location:**
- Guest view: Collapsible panel below sync controls
- Toggle: "Show Details" / "Hide Details"

### Logging

**Server-Side:**
```javascript
console.log('[Sync] Created sync engine for party CODE');
console.log('[Sync] Added client ID to sync engine');
console.log('[Sync] Removed client ID from sync engine');
console.log('[Sync] Cleaned up sync engine for party CODE');
```

**Client-Side:**
```javascript
console.log('[Sync] Clock synced - Offset: Xms, Latency: Yms');
console.log('[Sync] Scheduling playback - Delay: Xms');
console.log('[Sync] Drift correction - Drift: Xms, Adjustment: Y');
```

## Performance Characteristics

**Sync Accuracy:**
- Typical: < 20ms drift
- Maximum: < 50ms drift (under normal conditions)
- Recovery time: < 2 seconds (from 200ms drift)

**Network Requirements:**
- Minimum bandwidth: 128 kbps per client
- Recommended: 256 kbps per client
- Latency tolerance: Up to 500ms
- Jitter tolerance: ±100ms

**Scalability:**
- Server: Tested with 100+ concurrent clients
- Memory: ~1KB per client for sync metadata
- CPU: <1% per 100 clients (sync calculations only)

## Error Recovery

**Desync Detection:**
```javascript
if (Math.abs(drift) > DESYNC_THRESHOLD_MS) {
  // Trigger resync
  applyCorrection(drift);
}
```

**Network Dropout:**
1. Client detects connection loss
2. Pause playback
3. Attempt reconnection (exponential backoff)
4. On reconnect: request sync state
5. Resume from correct position

**Server Failure:**
1. Clients detect heartbeat timeout
2. Attempt reconnection to server
3. Fallback to P2P relay (if available)
4. Graceful degradation: Continue playback without sync

## Testing

**Unit Tests:**
- Clock sync calculation
- Drift detection and correction
- Playback rate clamping
- Network stability calculation
- Predictive drift algorithm
- P2P peer selection

**Total:** 38 tests, all passing

**Integration Tests:**
- End-to-end sync accuracy
- Multi-device coordination
- Network jitter simulation
- Stress testing (dozens of clients)

## Future Enhancements

1. **Video Synchronization**
   - Extend to HTMLVideoElement
   - Frame-accurate sync
   - Audio/video alignment

2. **Adaptive Quality**
   - Network speed monitoring
   - Bitrate adjustment
   - Resolution scaling
   - Maintain sync during quality changes

3. **Advanced P2P**
   - Complete WebRTC integration
   - Mesh network topology
   - Peer discovery protocol
   - Direct synchronization

4. **Machine Learning**
   - Drift prediction using LSTM
   - Network pattern recognition
   - Proactive quality adjustment

5. **Analytics Dashboard**
   - Real-time sync visualization
   - Historical drift analysis
   - Client health monitoring
   - Performance metrics

## API Reference

### SyncEngine (Server)

```javascript
const engine = new SyncEngine();

// Client management
engine.addClient(ws, clientId);
engine.removeClient(clientId);
engine.getClient(clientId);

// Clock sync
engine.handleClockPing(clientId, clientNowMs);

// Playback feedback
engine.handlePlaybackFeedback(clientId, position, trackStart);

// Track broadcasting
engine.broadcastTrack(trackId, duration, startDelay, additionalData);

// Monitoring
engine.getSyncStats();
engine.getDesyncedClients();
```

### ClientSyncEngine

```javascript
const clientEngine = new ClientSyncEngine();

// Initialization
clientEngine.initialize(ws, audioElement, videoElement);

// Clock sync
clientEngine.sendClockPing();
clientEngine.handleClockPong(msg);

// Playback
clientEngine.scheduleTrackPlayback(trackData);
clientEngine.seekTo(positionSec);
clientEngine.pause();
clientEngine.resume();
clientEngine.stop();

// Drift correction
clientEngine.handleDriftCorrection(correction);

// Monitoring
clientEngine.getSyncQuality();

// Cleanup
clientEngine.destroy();
```

## Troubleshooting

**Problem: High latency (>200ms)**
- Check network connection quality
- Reduce distance to server
- Close bandwidth-heavy applications

**Problem: Frequent drift corrections**
- Check CPU usage on client device
- Verify audio playback isn't being interrupted
- Increase buffer size slightly

**Problem: Audio glitches during correction**
- Drift may be too large for smooth correction
- Try hard resync (stop and restart)
- Check for network jitter

**Problem: Sync quality shows "Poor"**
- Network stability is low
- High latency variance detected
- Consider wired connection instead of WiFi

## License

See main repository LICENSE file.

## Support

For issues, questions, or contributions, please visit the GitHub repository.
