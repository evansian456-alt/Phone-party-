/**
 * Unit tests for SyncSpeaker Ultimate AmpSync+ Engine
 * 
 * Tests clock synchronization, drift correction, and predictive compensation
 */

const {
  SyncEngine,
  SyncClient,
  TrackInfo,
  P2PNetwork
} = require('./sync-engine');

const {
  CLOCK_SYNC_INTERVAL_MS,
  DRIFT_THRESHOLD_MS,
  DESYNC_THRESHOLD_MS
} = require('./sync-config');

describe('SyncClient', () => {
  let client;
  let mockWs;

  beforeEach(() => {
    mockWs = { readyState: 1 }; // OPEN
    client = new SyncClient(mockWs, 'test-client-1');
  });

  describe('Clock Sync', () => {
    test('should calculate clock offset correctly', () => {
      const sentTime = 1000;
      const serverNowMs = 1050;
      const receivedTime = 1100;

      client.updateClockSync(sentTime, serverNowMs, receivedTime);

      // Latency = (receivedTime - sentTime) / 2 = 50ms
      expect(client.latency).toBe(50);

      // Clock offset = (sentTime + latency) - serverNowMs
      // = (1000 + 50) - 1050 = 0
      expect(client.clockOffset).toBe(0);
    });

    test('should handle positive clock offset', () => {
      const sentTime = 1000;
      const serverNowMs = 1000;
      const receivedTime = 1100;

      client.updateClockSync(sentTime, serverNowMs, receivedTime);

      // Latency = 50ms
      expect(client.latency).toBe(50);

      // With EMA smoothing (alpha=0.15) starting from 0:
      // rawOffset = (1000 + 50) - 1000 = 50
      // emaOffset = 0 * (1-0.15) + 50 * 0.15 = 7.5
      expect(client.clockOffset).toBeCloseTo(7.5, 1);
    });

    test('should handle negative clock offset', () => {
      const sentTime = 1000;
      const serverNowMs = 1100;
      const receivedTime = 1100;

      client.updateClockSync(sentTime, serverNowMs, receivedTime);

      // Latency = 50ms
      // rawOffset = (1000 + 50) - 1100 = -50
      // emaOffset = 0 * 0.85 + (-50) * 0.15 = -7.5
      expect(client.clockOffset).toBeCloseTo(-7.5, 1);
    });

    test('should track latency history', () => {
      client.updateClockSync(1000, 1050, 1100); // latency = 50
      client.updateClockSync(2000, 2060, 2120); // latency = 60
      client.updateClockSync(3000, 3070, 3140); // latency = 70

      expect(client.latencyHistory).toHaveLength(3);
      expect(client.latencyHistory).toEqual([50, 60, 70]);
    });

    test('should calculate network stability from latency variance', () => {
      // Low variance = high stability
      client.updateClockSync(1000, 1050, 1100); // latency = 50
      client.updateClockSync(2000, 2052, 2104); // latency = 52
      client.updateClockSync(3000, 3051, 3102); // latency = 51

      expect(client.networkStability).toBeGreaterThan(0.9); // Very stable
    });

    test('should calculate lower stability for high latency variance', () => {
      // High variance = low stability
      client.updateClockSync(1000, 1050, 1100); // latency = 50
      client.updateClockSync(2000, 2100, 2200); // latency = 100
      client.updateClockSync(3000, 3075, 3150); // latency = 75

      expect(client.networkStability).toBeLessThan(0.9); // Less stable
    });

    test('should adapt sync interval based on network stability', () => {
      client.networkStability = 1.0; // Perfect stability
      const interval1 = client.getAdaptiveSyncInterval();
      expect(interval1).toBeGreaterThan(CLOCK_SYNC_INTERVAL_MS);
      expect(interval1).toBeLessThanOrEqual(7000); // Clamped to max

      client.networkStability = 0.5; // Medium stability
      const interval2 = client.getAdaptiveSyncInterval();
      expect(interval2).toBeGreaterThanOrEqual(3000); // Clamped to min
      expect(interval2).toBeLessThanOrEqual(7000); // Clamped to max

      client.networkStability = 0.0; // Poor stability
      const interval3 = client.getAdaptiveSyncInterval();
      expect(interval3).toBeGreaterThanOrEqual(3000); // Clamped to minimum
      expect(interval3).toBeLessThanOrEqual(7000); // Clamped to maximum
    });
  });

  describe('Drift Tracking', () => {
    test('should update drift history', () => {
      client.updateDrift(10);
      client.updateDrift(15);
      client.updateDrift(12);

      expect(client.driftHistory).toHaveLength(3);
      expect(client.lastDrift).toBe(12);
    });

    test('should limit drift history to 20 entries', () => {
      for (let i = 0; i < 25; i++) {
        client.updateDrift(i);
      }

      expect(client.driftHistory).toHaveLength(20);
      expect(client.driftHistory[0].drift).toBe(5); // First 5 dropped
    });

    test('should calculate predicted drift from history', () => {
      client.updateDrift(10);
      client.updateDrift(15);
      client.updateDrift(20);

      const predicted = client.calculatePredictedDrift();
      
      // Should be influenced by trend (increasing drift)
      expect(predicted).toBeGreaterThan(0);
      expect(predicted).toBeLessThanOrEqual(30); // Reasonable bound
    });

    test('should blend current and predicted drift in correction', () => {
      client.updateDrift(50);  // Above threshold
      client.updateDrift(55);
      client.updateDrift(60);

      const adjustment = client.calculateDriftCorrection();
      
      // Should provide correction for positive drift
      expect(adjustment).toBeLessThan(0); // Negative adjustment speeds up
    });

    test('should not correct drift below threshold', () => {
      client.updateDrift(30); // Below DRIFT_THRESHOLD_MS (50)
      
      const adjustment = client.calculateDriftCorrection();
      expect(adjustment).toBe(0);
    });
  });

  describe('Playback Rate Adjustment', () => {
    test('should clamp playback rate to valid range', () => {
      client.updatePlaybackRate(-0.10); // Would be 0.90, below min
      expect(client.playbackRate).toBe(0.95);

      client.updatePlaybackRate(0.15); // Would be 1.15, above max
      expect(client.playbackRate).toBe(1.05);
    });

    test('should allow playback rate within range', () => {
      client.updatePlaybackRate(0.02); // 1.02
      expect(client.playbackRate).toBe(1.02);

      client.updatePlaybackRate(-0.03); // 0.97
      expect(client.playbackRate).toBe(0.97);
    });

    test('should handle invalid clock sync data gracefully', () => {
      // Test negative latency (receivedTime < sentTime - invalid)
      const sentTime = 1000;
      const serverNowMs = 1050;
      const receivedTime = 999; // Invalid: before sent time

      // New behavior: negative RTT is clamped to 0 (so latency = 0)
      client.updateClockSync(sentTime, serverNowMs, receivedTime);
      
      // RTT is clamped to max(0, -1) = 0, so latency = 0
      expect(client.latency).toBe(0);
      
      // Clock offset calculation should still work
      expect(typeof client.clockOffset).toBe('number');
    });

    test('should handle NaN values in clock sync', () => {
      const initialOffset = client.clockOffset;
      const initialLatency = client.latency;

      // Try to update with NaN
      client.updateClockSync(NaN, 1000, 1100);
      
      // Should not crash, values may be NaN
      expect(typeof client.clockOffset).toBe('number');
      expect(typeof client.latency).toBe('number');
    });

    test('should handle very large time differences', () => {
      const sentTime = 1000;
      const serverNowMs = 1000000; // Huge difference
      const receivedTime = 1100;

      client.updateClockSync(sentTime, serverNowMs, receivedTime);
      
      // Should calculate offset, even if very large
      expect(typeof client.clockOffset).toBe('number');
      expect(client.latency).toBe(50);
    });
  });

  describe('Error Handling', () => {
    test('should handle zero latency', () => {
      client.updateClockSync(1000, 1000, 1000);
      expect(client.latency).toBe(0);
      expect(client.clockOffset).toBe(0);
    });

    test('should handle empty latency history for stability', () => {
      client.latencyHistory = [];
      const interval = client.getAdaptiveSyncInterval();
      
      // Should not crash, should return valid interval
      expect(interval).toBeGreaterThanOrEqual(3000);
      expect(interval).toBeLessThanOrEqual(7000);
    });

    test('should handle empty drift history for prediction', () => {
      client.driftHistory = [];
      const predicted = client.calculatePredictedDrift();
      
      // Should return lastDrift or 0
      expect(typeof predicted).toBe('number');
    });
  });
});

describe('SyncEngine', () => {
  let engine;
  let mockWs1, mockWs2;

  beforeEach(() => {
    engine = new SyncEngine();
    mockWs1 = { readyState: 1, send: jest.fn() };
    mockWs2 = { readyState: 1, send: jest.fn() };
  });

  describe('Client Management', () => {
    test('should add clients', () => {
      const client1 = engine.addClient(mockWs1, 'client-1');
      const client2 = engine.addClient(mockWs2, 'client-2');

      expect(client1).toBeInstanceOf(SyncClient);
      expect(client2).toBeInstanceOf(SyncClient);
      expect(engine.clients.size).toBe(2);
    });

    test('should retrieve clients by ID', () => {
      engine.addClient(mockWs1, 'client-1');
      const client = engine.getClient('client-1');

      expect(client).not.toBeNull();
      expect(client.clientId).toBe('client-1');
    });

    test('should remove clients', () => {
      engine.addClient(mockWs1, 'client-1');
      expect(engine.clients.size).toBe(1);

      engine.removeClient('client-1');
      expect(engine.clients.size).toBe(0);
    });

    test('should return null for non-existent client', () => {
      const client = engine.getClient('non-existent');
      expect(client).toBeNull();
    });
  });

  describe('Clock Synchronization', () => {
    test('should handle clock ping', () => {
      engine.addClient(mockWs1, 'client-1');
      const response = engine.handleClockPing('client-1', 1000);

      expect(response).not.toBeNull();
      expect(response.t).toBe('TIME_PONG');
      expect(response.clientSentTime).toBe(1000);
      expect(response.serverNowMs).toBeGreaterThan(0);
      expect(response.clientId).toBe('client-1');
    });

    test('should return null for non-existent client ping', () => {
      const response = engine.handleClockPing('non-existent', 1000);
      expect(response).toBeNull();
    });
  });

  describe('Playback Feedback and Drift Correction', () => {
    beforeEach(() => {
      engine.addClient(mockWs1, 'client-1');
      
      // Set up a current track
      engine.currentTrack = new TrackInfo('track-1', 180, Date.now());
      engine.currentTrack.status = 'playing';
    });

    test('should calculate drift from playback feedback', () => {
      const trackStart = Date.now() - 5000; // Started 5 seconds ago
      const position = 4.9; // Playing at 4.9 seconds (0.1s behind)

      const correction = engine.handlePlaybackFeedback('client-1', position, trackStart);

      const client = engine.getClient('client-1');
      
      // Drift should be negative (behind)
      expect(client.lastDrift).toBeLessThan(0);
    });

    test('should not return correction for small drift', () => {
      const trackStart = Date.now() - 5000;
      const position = 5.02; // Only 20ms ahead

      const correction = engine.handlePlaybackFeedback('client-1', position, trackStart);

      expect(correction).toBeNull(); // Below threshold
    });

    test('should return correction for significant drift', () => {
      const trackStart = Date.now() - 5000;
      const position = 5.2; // 200ms ahead

      const correction = engine.handlePlaybackFeedback('client-1', position, trackStart);

      expect(correction).not.toBeNull();
      expect(correction.t).toBe('DRIFT_CORRECTION');
      expect(correction.drift).toBeGreaterThan(DRIFT_THRESHOLD_MS);
      expect(correction.adjustment).toBeDefined();
      expect(correction.playbackRate).toBeDefined();
    });

    test('should handle multiple clients with different drift', () => {
      engine.addClient(mockWs2, 'client-2');
      
      const trackStart = Date.now() - 5000;

      // Client 1: ahead
      const correction1 = engine.handlePlaybackFeedback('client-1', 5.15, trackStart);
      
      // Client 2: behind
      const correction2 = engine.handlePlaybackFeedback('client-2', 4.85, trackStart);

      const client1 = engine.getClient('client-1');
      const client2 = engine.getClient('client-2');

      expect(client1.lastDrift).toBeGreaterThan(0); // Ahead
      expect(client2.lastDrift).toBeLessThan(0); // Behind
    });
  });

  describe('Track Broadcasting', () => {
    test('should broadcast track with timestamps', () => {
      engine.addClient(mockWs1, 'client-1');
      engine.addClient(mockWs2, 'client-2');

      const result = engine.broadcastTrack('track-1', 180, 3000, {
        trackUrl: 'http://example.com/track.mp3',
        title: 'Test Track'
      });

      expect(result.broadcast).toBeDefined();
      expect(result.broadcast.t).toBe('PLAY_TRACK');
      expect(result.broadcast.trackId).toBe('track-1');
      expect(result.broadcast.duration).toBe(180);
      expect(result.broadcast.playAt).toBeGreaterThan(Date.now());

      expect(result.clientBroadcasts.size).toBe(2);
    });

    test('should include per-client clock offsets', () => {
      const client1 = engine.addClient(mockWs1, 'client-1');
      const client2 = engine.addClient(mockWs2, 'client-2');

      client1.clockOffset = 50;
      client2.clockOffset = -30;

      const result = engine.broadcastTrack('track-1', 180);

      const client1Broadcast = result.clientBroadcasts.get('client-1');
      const client2Broadcast = result.clientBroadcasts.get('client-2');

      expect(client1Broadcast.clockOffset).toBe(50);
      expect(client2Broadcast.clockOffset).toBe(-30);
    });

    test('should set current track info', () => {
      engine.broadcastTrack('track-1', 180);

      expect(engine.currentTrack).not.toBeNull();
      expect(engine.currentTrack.trackId).toBe('track-1');
      expect(engine.currentTrack.duration).toBe(180);
      expect(engine.currentTrack.status).toBe('preparing');
    });
  });

  describe('Sync Statistics', () => {
    test('should provide sync stats for all clients', () => {
      const client1 = engine.addClient(mockWs1, 'client-1');
      const client2 = engine.addClient(mockWs2, 'client-2');

      client1.clockOffset = 10;
      client1.latency = 50;
      client1.lastDrift = 75;

      client2.clockOffset = -20;
      client2.latency = 60;
      client2.lastDrift = -40;

      const stats = engine.getSyncStats();

      expect(stats.totalClients).toBe(2);
      expect(stats.clients).toHaveLength(2);
      expect(stats.clients[0].clientId).toBe('client-1');
      expect(stats.clients[0].latency).toBe(50);
    });
  });

  describe('Desync Detection', () => {
    test('should detect clients with significant desync', () => {
      const client1 = engine.addClient(mockWs1, 'client-1');
      const client2 = engine.addClient(mockWs2, 'client-2');

      client1.lastDrift = 80; // Above threshold
      client2.lastDrift = 30; // Below threshold

      const desynced = engine.getDesyncedClients();

      expect(desynced).toHaveLength(1);
      expect(desynced[0].clientId).toBe('client-1');
      expect(desynced[0].severity).toBe('warning');
    });

    test('should classify critical desync', () => {
      const client = engine.addClient(mockWs1, 'client-1');
      client.lastDrift = 250; // Critical threshold

      const desynced = engine.getDesyncedClients();

      expect(desynced[0].severity).toBe('critical');
    });

    test('should handle negative drift in desync detection', () => {
      const client = engine.addClient(mockWs1, 'client-1');
      client.lastDrift = -100; // Behind by 100ms

      const desynced = engine.getDesyncedClients();

      expect(desynced).toHaveLength(1);
      expect(desynced[0].drift).toBe(-100);
    });
  });
});

describe('P2PNetwork', () => {
  let network;

  beforeEach(() => {
    network = new P2PNetwork();
  });

  test('should add peers to sessions', () => {
    network.addPeerToSession('session-1', 'peer-1');
    network.addPeerToSession('session-1', 'peer-2');

    const peers = network.discoverPeers('session-1');
    expect(peers).toHaveLength(2);
    expect(peers).toContain('peer-1');
    expect(peers).toContain('peer-2');
  });

  test('should remove peers from sessions', () => {
    network.addPeerToSession('session-1', 'peer-1');
    network.addPeerToSession('session-1', 'peer-2');

    network.removePeerFromSession('session-1', 'peer-1');

    const peers = network.discoverPeers('session-1');
    expect(peers).toHaveLength(1);
    expect(peers).toContain('peer-2');
  });

  test('should clean up empty sessions', () => {
    network.addPeerToSession('session-1', 'peer-1');
    network.removePeerFromSession('session-1', 'peer-1');

    const peers = network.discoverPeers('session-1');
    expect(peers).toHaveLength(0);
  });

  test('should select optimal peer based on latency', () => {
    network.addPeerToSession('session-1', 'peer-1');
    network.addPeerToSession('session-1', 'peer-2');
    network.addPeerToSession('session-1', 'peer-3');

    network.peers.get('peer-1').latency = 100;
    network.peers.get('peer-2').latency = 50; // Lowest
    network.peers.get('peer-3').latency = 75;

    const optimal = network.selectOptimalPeer('session-1');
    expect(optimal).toBe('peer-2');
  });

  test('should handle session with no peers', () => {
    const peers = network.discoverPeers('non-existent');
    expect(peers).toHaveLength(0);

    const optimal = network.selectOptimalPeer('non-existent');
    expect(optimal).toBeNull();
  });
});

describe('TrackInfo', () => {
  test('should create track with correct properties', () => {
    const track = new TrackInfo('track-1', 180, 1000);

    expect(track.trackId).toBe('track-1');
    expect(track.duration).toBe(180);
    expect(track.startTimestamp).toBe(1000);
    expect(track.startPositionSec).toBe(0);
    expect(track.status).toBe('preparing');
  });

  test('should allow updating track properties', () => {
    const track = new TrackInfo('track-1', 180, 1000);
    track.status = 'playing';
    track.startPositionSec = 30;

    expect(track.status).toBe('playing');
    expect(track.startPositionSec).toBe(30);
  });
});
