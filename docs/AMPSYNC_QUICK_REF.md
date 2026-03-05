# SyncSpeaker AmpSync+ Quick Reference

## Quick Start

### Dev Mode Testing
```
http://localhost:8080/?devmode=true&autostart=true&tier=PRO
```

### Production URLs
```
# Standard mode
http://localhost:8080/

# With sync monitor enabled
http://localhost:8080/?syncmonitor=true
```

## Key Constants

```javascript
// Sync Timing
CLOCK_SYNC_INTERVAL_MS = 5000          // Base sync interval
PLAYBACK_FEEDBACK_INTERVAL_MS = 100    // Feedback loop rate
DRIFT_CORRECTION_INTERVAL_MS = 200     // Drift check rate
ROLLING_BUFFER_MS = 150                // Buffer size

// Thresholds
DRIFT_THRESHOLD_MS = 50                // Minimum drift to correct
DESYNC_THRESHOLD_MS = 50               // Resync threshold
PLAYBACK_RATE_MIN = 0.95               // Min playback speed
PLAYBACK_RATE_MAX = 1.05               // Max playback speed
```

## Message Types

### Server → Client
- `CLOCK_PONG` - Clock sync response
- `PLAY_TRACK` - Start track playback
- `DRIFT_CORRECTION` - Apply drift correction
- `SYNC_STATE` - Full sync state (for late joiners)

### Client → Server
- `CLOCK_PING` - Request clock sync
- `PLAYBACK_FEEDBACK` - Report playback position

## Testing Commands

### Run All Tests
```bash
npm test
```

### Run Sync Engine Tests Only
```bash
npm test sync-engine.test.js
```

### Run Tests with Coverage
```bash
npm test -- --coverage
```

## Debugging

### Enable Verbose Logging
```javascript
// In browser console
localStorage.setItem('syncDebug', 'true');
```

### View Sync Stats
```javascript
// Server-side (in server.js)
const syncEngine = partySyncEngines.get(partyCode);
console.log(syncEngine.getSyncStats());

// Client-side (in browser console)
console.log(clientSyncEngine.getSyncQuality());
```

### Monitor Network Stability
```javascript
// Client-side
const client = syncEngine.getClient(clientId);
console.log('Network stability:', client.networkStability);
console.log('Latency history:', client.latencyHistory);
```

## Common Workflows

### Adding New Message Type
1. Add to server.js `handleMessage()` switch
2. Create handler function
3. Update client handler in app.js
4. Add to protocol documentation

### Adjusting Sync Thresholds
1. Modify constants in sync-engine.js
2. Update tests in sync-engine.test.js
3. Test with multiple clients
4. Update documentation

### Adding Sync Metric
1. Add to SyncClient class
2. Update getSyncStats()
3. Add UI element in index.html
4. Style in styles.css
5. Wire up in app.js

## Performance Tuning

### Reduce Server Load
- Increase CLOCK_SYNC_INTERVAL_MS
- Reduce PLAYBACK_FEEDBACK_INTERVAL_MS
- Enable P2P relay

### Improve Sync Accuracy
- Decrease DRIFT_THRESHOLD_MS
- Increase PLAYBACK_FEEDBACK_INTERVAL_MS
- Reduce ROLLING_BUFFER_MS

### Handle High Latency
- Increase ROLLING_BUFFER_MS
- Widen playback rate range
- Implement adaptive buffering

## Troubleshooting Checklist

- [ ] Check network latency (<200ms ideal)
- [ ] Verify clock sync is working (check logs)
- [ ] Confirm playback feedback is being sent
- [ ] Check drift values in monitor
- [ ] Verify audio element is playing
- [ ] Test with single client first
- [ ] Check server console for errors
- [ ] Review sync stats for anomalies

## Code Snippets

### Initialize Sync Engine (Server)
```javascript
const syncEngine = new SyncEngine();
partySyncEngines.set(partyCode, syncEngine);
syncEngine.addClient(ws, clientId);
```

### Initialize Sync Engine (Client)
```javascript
const clientEngine = new ClientSyncEngine();
clientEngine.initialize(ws, audioElement);
```

### Handle Clock Sync
```javascript
// Server
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.t === 'CLOCK_PING') {
    const response = syncEngine.handleClockPing(clientId, msg.clientNowMs);
    ws.send(JSON.stringify(response));
  }
});

// Client
if (msg.t === 'CLOCK_PONG') {
  clientEngine.handleClockPong(msg);
}
```

### Broadcast Track
```javascript
const result = syncEngine.broadcastTrack(
  trackId,
  duration,
  3000,  // 3 second delay
  { trackUrl, title }
);

// Send to each client
result.clientBroadcasts.forEach((broadcast, clientId) => {
  const client = syncEngine.getClient(clientId);
  client.ws.send(JSON.stringify(broadcast));
});
```

## File Structure

```
syncspeaker-prototype/
├── sync-engine.js           # Server-side sync logic
├── sync-client.js           # Client-side sync logic
├── sync-engine.test.js      # Unit tests
├── server.js                # Server integration
├── app.js                   # Client integration
├── index.html               # UI (sync monitor)
├── styles.css               # Styling
└── SYNCSPEAKER_AMPSYNC_DOCS.md  # Full documentation
```

## URLs & Flags

```
?devmode=true       - Enable dev mode
?testmode=true      - Enable test mode
?autostart=true     - Auto-create party
?tier=PRO           - Set tier (FREE|PARTY_PASS|PRO)
?syncmonitor=true   - Show sync monitor
```

## Git Commands

```bash
# See what you've changed
git status
git diff

# Commit changes
git add .
git commit -m "Description"
git push

# Create feature branch
git checkout -b feature/sync-improvements
```

## Useful Links

- Main README: `README.md`
- Full Docs: `SYNCSPEAKER_AMPSYNC_DOCS.md`
- Tests: `sync-engine.test.js`
- Server Code: `server.js` (search for "Sync")
- Client Code: `app.js` (search for "sync")

## Support

For questions or issues:
1. Check SYNCSPEAKER_AMPSYNC_DOCS.md
2. Review test cases in sync-engine.test.js
3. Check console logs (server and client)
4. File an issue on GitHub
