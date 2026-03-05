/**
 * Stress and Network Jitter Tests for House Party Sync System
 * 
 * Tests network jitter simulation, stress scenarios, and error recovery
 */

const {
  SyncEngine,
  SyncClient
} = require('./sync-engine');

const {
  DRIFT_THRESHOLD_MS,
  DESYNC_THRESHOLD_MS
} = require('./sync-config');

describe('Network Jitter Simulation', () => {
  let syncEngine;
  let mockClients;

  beforeEach(() => {
    syncEngine = new SyncEngine();
    mockClients = [];
    
    // Create multiple mock clients
    for (let i = 0; i < 5; i++) {
      const mockWs = { 
        readyState: 1,
        send: jest.fn()
      };
      mockClients.push(mockWs);
      syncEngine.addClient(mockWs, `client-${i}`);
    }
  });

  test('should handle clients with varying latency', () => {
    // Simulate different latencies for each client
    const latencies = [10, 50, 100, 200, 500];
    
    mockClients.forEach((ws, index) => {
      const client = syncEngine.getClient(`client-${index}`);
      const sentTime = 1000;
      const serverNowMs = 1050;
      const receivedTime = sentTime + (latencies[index] * 2);
      
      client.updateClockSync(sentTime, serverNowMs, receivedTime);
      expect(client.latency).toBe(latencies[index]);
    });

    // Verify all clients are tracked
    const stats = syncEngine.getSyncStats();
    expect(stats.totalClients).toBe(5);
  });

  test('should handle network jitter (varying latency)', () => {
    const client = syncEngine.getClient('client-0');
    
    // Simulate jittery network with varying latencies
    const jitterPattern = [50, 80, 40, 90, 45, 85, 42];
    
    jitterPattern.forEach((latency, index) => {
      const sentTime = 1000 + (index * 1000);
      const serverNowMs = sentTime + 25;
      const receivedTime = sentTime + (latency * 2);
      
      client.updateClockSync(sentTime, serverNowMs, receivedTime);
    });

    // Network stability should be lower due to jitter
    expect(client.networkStability).toBeLessThan(0.9);
    expect(client.latencyHistory.length).toBe(7);
  });

  test('should handle packet loss simulation (missing pongs)', () => {
    const client = syncEngine.getClient('client-0');
    
    // Simulate some successful syncs with packet loss in between
    client.updateClockSync(1000, 1050, 1100); // Success
    // ... packet lost (no update)
    client.updateClockSync(3000, 3050, 3100); // Success
    // ... packet lost
    client.updateClockSync(5000, 5050, 5100); // Success

    expect(client.latencyHistory.length).toBe(3);
    expect(client.clockOffset).toBe(0);
  });

  test('should recover from network spike', () => {
    const client = syncEngine.getClient('client-0');
    
    // Normal conditions - need multiple samples to calculate stability
    client.updateClockSync(1000, 1050, 1100); // latency = 50
    client.updateClockSync(1500, 1550, 1600); // latency = 50
    client.updateClockSync(2000, 2050, 2100); // latency = 50
    const normalStability = client.networkStability;
    
    // Network spike
    client.updateClockSync(3000, 3050, 3400); // latency = 200
    const spikeStability = client.networkStability;
    expect(spikeStability).toBeLessThan(normalStability);
    
    // Recovery
    client.updateClockSync(4000, 4050, 4100); // latency = 50
    client.updateClockSync(5000, 5050, 5100); // latency = 50
    client.updateClockSync(6000, 6050, 6100); // latency = 50
    
    // Stability should improve
    expect(client.networkStability).toBeGreaterThan(spikeStability);
  });
});

describe('Multi-Device Stress Tests', () => {
  let syncEngine;
  
  beforeEach(() => {
    syncEngine = new SyncEngine();
  });

  test('should handle 50 concurrent clients', () => {
    const clientCount = 50;
    
    for (let i = 0; i < clientCount; i++) {
      const mockWs = { 
        readyState: 1,
        send: jest.fn()
      };
      syncEngine.addClient(mockWs, `client-${i}`);
    }

    const stats = syncEngine.getSyncStats();
    expect(stats.totalClients).toBe(clientCount);
    expect(stats.clients.length).toBe(clientCount);
  });

  test('should handle 100 concurrent clients', () => {
    const clientCount = 100;
    
    for (let i = 0; i < clientCount; i++) {
      const mockWs = { 
        readyState: 1,
        send: jest.fn()
      };
      syncEngine.addClient(mockWs, `client-${i}`);
    }

    const stats = syncEngine.getSyncStats();
    expect(stats.totalClients).toBe(clientCount);
  });

  test('should detect desynced clients under stress', () => {
    // Create 20 clients
    for (let i = 0; i < 20; i++) {
      const mockWs = { 
        readyState: 1,
        send: jest.fn()
      };
      syncEngine.addClient(mockWs, `client-${i}`);
    }

    // Set up a track
    const { broadcast } = syncEngine.broadcastTrack('test-track', 180, 3000);
    
    // Simulate playback feedback with some clients desynced
    for (let i = 0; i < 20; i++) {
      const client = syncEngine.getClient(`client-${i}`);
      const drift = i < 10 ? 20 : 150; // Half are desynced
      client.updateDrift(drift);
    }

    const desyncedClients = syncEngine.getDesyncedClients();
    expect(desyncedClients.length).toBeGreaterThan(0);
    
    // Should detect clients with drift > DESYNC_THRESHOLD_MS
    desyncedClients.forEach(dc => {
      expect(Math.abs(dc.drift)).toBeGreaterThan(DESYNC_THRESHOLD_MS);
    });
  });

  test('should handle rapid client connect/disconnect', () => {
    const cycles = 50;
    
    for (let i = 0; i < cycles; i++) {
      const mockWs = { 
        readyState: 1,
        send: jest.fn()
      };
      const clientId = `client-${i}`;
      
      // Add client
      syncEngine.addClient(mockWs, clientId);
      expect(syncEngine.getClient(clientId)).toBeTruthy();
      
      // Remove client
      syncEngine.removeClient(clientId);
      expect(syncEngine.getClient(clientId)).toBeNull();
    }
    
    // All clients should be gone
    const stats = syncEngine.getSyncStats();
    expect(stats.totalClients).toBe(0);
  });
});

describe('Drift Correction Under Stress', () => {
  let syncEngine;
  let client;

  beforeEach(() => {
    syncEngine = new SyncEngine();
    const mockWs = { 
      readyState: 1,
      send: jest.fn()
    };
    syncEngine.addClient(mockWs, 'test-client');
    client = syncEngine.getClient('test-client');
    
    // Set up sync
    client.updateClockSync(1000, 1050, 1100);
  });

  test('should correct gradually increasing drift', () => {
    // Simulate gradually increasing drift
    const drifts = [10, 25, 40, 55, 70, 85];
    
    drifts.forEach(drift => {
      client.updateDrift(drift);
    });

    // Should predict increasing trend
    expect(client.predictedDrift).toBeGreaterThan(60);
    
    // Should calculate correction
    const adjustment = client.calculateDriftCorrection();
    expect(adjustment).toBeLessThan(0); // Should slow down (negative adjustment)
  });

  test('should handle oscillating drift', () => {
    // Simulate oscillating drift pattern
    const drifts = [50, -30, 40, -25, 35, -20];
    
    drifts.forEach(drift => {
      client.updateDrift(drift);
    });

    // Should smooth out oscillations
    const adjustment = client.calculateDriftCorrection();
    expect(Math.abs(adjustment)).toBeLessThan(0.5);
  });

  test('should handle sudden large drift', () => {
    // Normal drift
    client.updateDrift(10);
    client.updateDrift(12);
    client.updateDrift(11);
    
    // Sudden large drift (network issue)
    client.updateDrift(150);
    
    // Should detect desync
    expect(Math.abs(client.lastDrift)).toBeGreaterThan(DESYNC_THRESHOLD_MS);
    
    // PLL produces a bounded correction (negative for positive/ahead drift)
    // Rate delta is capped to ±1% (stable) or ±2% (unstable), then EMA-smoothed.
    const adjustment = client.calculateDriftCorrection();
    expect(adjustment).toBeLessThan(0); // Negative: slow down to catch up
    expect(Math.abs(adjustment)).toBeGreaterThan(0); // Non-zero correction
  });

  test('should not over-correct small drift', () => {
    // Small drift below threshold
    client.updateDrift(30);
    
    const adjustment = client.calculateDriftCorrection();
    
    // Should apply minimal or no correction
    expect(Math.abs(adjustment)).toBeLessThan(0.05);
  });
});

describe('Error Recovery Scenarios', () => {
  let syncEngine;

  beforeEach(() => {
    syncEngine = new SyncEngine();
  });

  test('should handle missing playback feedback gracefully', () => {
    const mockWs = { 
      readyState: 1,
      send: jest.fn()
    };
    syncEngine.addClient(mockWs, 'test-client');
    
    // Set up track
    syncEngine.broadcastTrack('test-track', 180, 3000);
    
    // Try to process feedback with no track
    syncEngine.currentTrack = null;
    const correction = syncEngine.handlePlaybackFeedback('test-client', 10, Date.now());
    
    expect(correction).toBeNull();
  });

  test('should handle feedback from unknown client', () => {
    const correction = syncEngine.handlePlaybackFeedback('unknown-client', 10, Date.now());
    expect(correction).toBeNull();
  });

  test('should handle clock ping from unknown client', () => {
    const pong = syncEngine.handleClockPing('unknown-client', Date.now());
    expect(pong).toBeNull();
  });

  test('should recover from disconnected client', () => {
    const mockWs1 = { readyState: 1, send: jest.fn() };
    const mockWs2 = { readyState: 1, send: jest.fn() };
    
    syncEngine.addClient(mockWs1, 'client-1');
    syncEngine.addClient(mockWs2, 'client-2');
    
    expect(syncEngine.getSyncStats().totalClients).toBe(2);
    
    // Simulate client-1 disconnect
    syncEngine.removeClient('client-1');
    
    expect(syncEngine.getSyncStats().totalClients).toBe(1);
    expect(syncEngine.getClient('client-2')).toBeTruthy();
  });

  test('should handle all clients disconnecting', () => {
    // Add multiple clients
    for (let i = 0; i < 10; i++) {
      const mockWs = { readyState: 1, send: jest.fn() };
      syncEngine.addClient(mockWs, `client-${i}`);
    }
    
    expect(syncEngine.getSyncStats().totalClients).toBe(10);
    
    // Remove all clients
    for (let i = 0; i < 10; i++) {
      syncEngine.removeClient(`client-${i}`);
    }
    
    expect(syncEngine.getSyncStats().totalClients).toBe(0);
  });
});

describe('P2P Network Stress Tests', () => {
  const { P2PNetwork } = require('./sync-engine');
  let p2pNetwork;

  beforeEach(() => {
    p2pNetwork = new P2PNetwork();
  });

  test('should handle multiple sessions with multiple peers', () => {
    const sessionCount = 10;
    const peersPerSession = 5;
    
    for (let s = 0; s < sessionCount; s++) {
      const sessionId = `session-${s}`;
      
      for (let p = 0; p < peersPerSession; p++) {
        const peerId = `peer-${s}-${p}`;
        p2pNetwork.addPeerToSession(sessionId, peerId);
      }
    }
    
    // Verify each session has correct peer count
    for (let s = 0; s < sessionCount; s++) {
      const sessionId = `session-${s}`;
      const peers = p2pNetwork.discoverPeers(sessionId);
      expect(peers.length).toBe(peersPerSession);
    }
  });

  test('should handle peer churn (rapid add/remove)', () => {
    const sessionId = 'test-session';
    
    // Rapidly add and remove peers
    for (let i = 0; i < 50; i++) {
      const peerId = `peer-${i}`;
      p2pNetwork.addPeerToSession(sessionId, peerId);
      
      if (i % 3 === 0) {
        // Remove every third peer
        p2pNetwork.removePeerFromSession(sessionId, peerId);
      }
    }
    
    const peers = p2pNetwork.discoverPeers(sessionId);
    expect(peers.length).toBeGreaterThan(0);
    expect(peers.length).toBeLessThan(50);
  });

  test('should clean up empty sessions', () => {
    const sessionId = 'test-session';
    const peerId = 'test-peer';
    
    p2pNetwork.addPeerToSession(sessionId, peerId);
    expect(p2pNetwork.discoverPeers(sessionId).length).toBe(1);
    
    // Remove the only peer
    p2pNetwork.removePeerFromSession(sessionId, peerId);
    
    // Session should be cleaned up
    expect(p2pNetwork.discoverPeers(sessionId).length).toBe(0);
  });

  test('should select optimal peer based on latency', () => {
    const sessionId = 'test-session';
    
    // Add peers with different latencies
    const peersData = [
      { id: 'peer-1', latency: 100 },
      { id: 'peer-2', latency: 50 },  // Optimal
      { id: 'peer-3', latency: 200 }
    ];
    
    peersData.forEach(pd => {
      p2pNetwork.addPeerToSession(sessionId, pd.id);
      const peerInfo = p2pNetwork.peers.get(pd.id);
      peerInfo.latency = pd.latency;
    });
    
    const optimal = p2pNetwork.selectOptimalPeer(sessionId);
    expect(optimal).toBe('peer-2');
  });

  test('should handle session with no peers', () => {
    const optimal = p2pNetwork.selectOptimalPeer('empty-session');
    expect(optimal).toBeNull();
  });
});

describe('Predictive Drift Algorithm', () => {
  let client;

  beforeEach(() => {
    const mockWs = { readyState: 1 };
    client = new SyncClient(mockWs, 'test-client');
  });

  test('should predict constant drift', () => {
    // Constant drift pattern
    const constantDrift = 50;
    for (let i = 0; i < 10; i++) {
      client.updateDrift(constantDrift);
    }
    
    expect(client.predictedDrift).toBeCloseTo(constantDrift, 1);
  });

  test('should predict linear increasing drift', () => {
    // Linear increase: 10, 20, 30, 40, 50
    for (let i = 1; i <= 5; i++) {
      client.updateDrift(i * 10);
    }
    
    // Should predict continuation of trend
    expect(client.predictedDrift).toBeGreaterThan(40);
  });

  test('should predict linear decreasing drift', () => {
    // Linear decrease: 50, 40, 30, 20, 10
    for (let i = 5; i >= 1; i--) {
      client.updateDrift(i * 10);
    }
    
    // Should predict continuation of decreasing trend
    expect(client.predictedDrift).toBeLessThan(20);
  });

  test('should weight recent samples more heavily', () => {
    // Old samples: high drift
    client.updateDrift(100);
    client.updateDrift(95);
    client.updateDrift(90);
    
    // Recent samples: low drift
    client.updateDrift(20);
    client.updateDrift(15);
    client.updateDrift(10);
    
    // Predicted drift should be closer to recent values
    expect(client.predictedDrift).toBeLessThan(50);
  });

  test('should handle insufficient history gracefully', () => {
    client.updateDrift(50);
    
    // Should return last drift when history is insufficient
    expect(client.predictedDrift).toBe(0); // Not enough samples yet
  });
});
