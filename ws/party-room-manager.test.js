'use strict';

/**
 * Unit tests for ws/party-room-manager.js
 *
 * All tests run with a lightweight mock WebSocket so no actual network
 * connections are made.
 */

const { PartyRoomManager, BACKPRESSURE_BYTES, MAX_MESSAGES_PER_WINDOW, RATE_WINDOW_MS } = require('./party-room-manager');

// ─── Mock WebSocket ───────────────────────────────────────────────────────────

const WS_OPEN = 1;
const WS_CLOSED = 3;

function mockWs(opts = {}) {
  return {
    readyState: opts.readyState ?? WS_OPEN,
    bufferedAmount: opts.bufferedAmount ?? 0,
    _sent: [],
    send(data) {
      this._sent.push(data);
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PartyRoomManager', () => {
  let mgr;

  beforeEach(() => {
    mgr = new PartyRoomManager();
  });

  // ── join / leave / roomSize ───────────────────────────────────────────────

  describe('join()', () => {
    test('creates a room on first join', () => {
      const ws = mockWs();
      mgr.join('AAAA', ws);
      expect(mgr.roomSize('AAAA')).toBe(1);
    });

    test('adds multiple sockets to the same room', () => {
      mgr.join('BBBB', mockWs());
      mgr.join('BBBB', mockWs());
      expect(mgr.roomSize('BBBB')).toBe(2);
    });

    test('keeps rooms isolated', () => {
      mgr.join('R1', mockWs());
      mgr.join('R1', mockWs());
      mgr.join('R2', mockWs());
      expect(mgr.roomSize('R1')).toBe(2);
      expect(mgr.roomSize('R2')).toBe(1);
    });

    test('partyOf() returns the correct code', () => {
      const ws = mockWs();
      mgr.join('CCCC', ws);
      expect(mgr.partyOf(ws)).toBe('CCCC');
    });

    test('noops on null inputs', () => {
      expect(() => mgr.join(null, null)).not.toThrow();
    });
  });

  describe('leave()', () => {
    test('reduces room size', () => {
      const ws = mockWs();
      mgr.join('DDDD', ws);
      mgr.join('DDDD', mockWs());
      mgr.leave('DDDD', ws);
      expect(mgr.roomSize('DDDD')).toBe(1);
    });

    test('removes empty room', () => {
      const ws = mockWs();
      mgr.join('EEEE', ws);
      mgr.leave('EEEE', ws);
      expect(mgr.roomSize('EEEE')).toBe(0);
      expect(mgr.roomCount).toBe(0);
    });

    test('clears partyOf mapping', () => {
      const ws = mockWs();
      mgr.join('FFFF', ws);
      mgr.leave('FFFF', ws);
      expect(mgr.partyOf(ws)).toBeUndefined();
    });
  });

  // ── broadcast ─────────────────────────────────────────────────────────────

  describe('broadcast()', () => {
    test('sends to all open sockets in the room', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      mgr.join('GG', ws1);
      mgr.join('GG', ws2);

      const sent = mgr.broadcast('GG', { t: 'PLAY_AT' });
      expect(sent).toBe(2);
      expect(ws1._sent).toHaveLength(1);
      expect(ws2._sent).toHaveLength(1);
    });

    test('skips closed sockets', () => {
      const wsOpen = mockWs();
      const wsClosed = mockWs({ readyState: WS_CLOSED });
      mgr.join('HH', wsOpen);
      mgr.join('HH', wsClosed);

      const sent = mgr.broadcast('HH', { t: 'PING' });
      expect(sent).toBe(1);
      expect(wsOpen._sent).toHaveLength(1);
      expect(wsClosed._sent).toHaveLength(0);
    });

    test('respects the exclude set', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      mgr.join('II', ws1);
      mgr.join('II', ws2);

      const sent = mgr.broadcast('II', { t: 'MSG' }, new Set([ws2]));
      expect(sent).toBe(1);
      expect(ws1._sent).toHaveLength(1);
      expect(ws2._sent).toHaveLength(0);
    });

    test('skips sockets over the backpressure threshold', () => {
      const wsNormal = mockWs();
      const wsStalled = mockWs({ bufferedAmount: BACKPRESSURE_BYTES + 1 });
      mgr.join('JJ', wsNormal);
      mgr.join('JJ', wsStalled);

      const sent = mgr.broadcast('JJ', { t: 'DATA' });
      expect(sent).toBe(1);
      expect(wsNormal._sent).toHaveLength(1);
      expect(wsStalled._sent).toHaveLength(0);
    });

    test('returns 0 for unknown party', () => {
      expect(mgr.broadcast('NOPE', { t: 'X' })).toBe(0);
    });

    test('accepts a pre-serialised string', () => {
      const ws = mockWs();
      mgr.join('KK', ws);
      mgr.broadcast('KK', '{"t":"RAW"}');
      expect(ws._sent[0]).toBe('{"t":"RAW"}');
    });
  });

  // ── dissolve ──────────────────────────────────────────────────────────────

  describe('dissolve()', () => {
    test('sends ENDED to all open sockets', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      mgr.join('LL', ws1);
      mgr.join('LL', ws2);

      mgr.dissolve('LL');
      expect(JSON.parse(ws1._sent[0]).t).toBe('ENDED');
      expect(JSON.parse(ws2._sent[0]).t).toBe('ENDED');
    });

    test('removes the room entirely', () => {
      mgr.join('MM', mockWs());
      mgr.dissolve('MM');
      expect(mgr.roomSize('MM')).toBe(0);
      expect(mgr.roomCount).toBe(0);
    });

    test('clears partyOf for all members', () => {
      const ws = mockWs();
      mgr.join('NN', ws);
      mgr.dissolve('NN');
      expect(mgr.partyOf(ws)).toBeUndefined();
    });

    test('noops for unknown party', () => {
      expect(() => mgr.dissolve('UNKNOWN')).not.toThrow();
    });
  });

  // ── pruneDeadSockets ──────────────────────────────────────────────────────

  describe('pruneDeadSockets()', () => {
    test('removes closed sockets and returns count', () => {
      const wsAlive = mockWs();
      const wsDead = mockWs({ readyState: WS_CLOSED });
      mgr.join('OO', wsAlive);
      mgr.join('OO', wsDead);

      const pruned = mgr.pruneDeadSockets();
      expect(pruned).toBe(1);
      expect(mgr.roomSize('OO')).toBe(1);
    });

    test('removes room when all sockets are dead', () => {
      mgr.join('PP', mockWs({ readyState: WS_CLOSED }));
      mgr.pruneDeadSockets();
      expect(mgr.roomCount).toBe(0);
    });

    test('returns 0 when no dead sockets exist', () => {
      mgr.join('QQ', mockWs());
      expect(mgr.pruneDeadSockets()).toBe(0);
    });
  });

  // ── checkRateLimit ────────────────────────────────────────────────────────

  describe('checkRateLimit()', () => {
    test('allows messages up to the limit', () => {
      const ws = mockWs();
      mgr.join('RR', ws);
      for (let i = 0; i < MAX_MESSAGES_PER_WINDOW; i++) {
        expect(mgr.checkRateLimit(ws)).toBe(true);
      }
    });

    test('blocks the (limit + 1)th message within the same window', () => {
      const ws = mockWs();
      mgr.join('SS', ws);
      for (let i = 0; i < MAX_MESSAGES_PER_WINDOW; i++) {
        mgr.checkRateLimit(ws);
      }
      expect(mgr.checkRateLimit(ws)).toBe(false);
    });

    test('resets counter after the window expires', () => {
      const ws = mockWs();
      mgr.join('TT', ws);

      // Exhaust the window
      const entry = { count: MAX_MESSAGES_PER_WINDOW, windowStart: Date.now() - RATE_WINDOW_MS - 1 };
      mgr._msgCount.set(ws, entry);

      // Next call should open a new window
      expect(mgr.checkRateLimit(ws)).toBe(true);
    });

    test('works for sockets not yet joined (graceful fallback)', () => {
      const ws = mockWs();
      expect(mgr.checkRateLimit(ws)).toBe(true);
    });
  });

  // ── sendTo ────────────────────────────────────────────────────────────────

  describe('sendTo()', () => {
    test('sends to an open socket', () => {
      const ws = mockWs();
      expect(mgr.sendTo(ws, { t: 'PING' })).toBe(true);
      expect(ws._sent).toHaveLength(1);
    });

    test('returns false for a closed socket', () => {
      const ws = mockWs({ readyState: WS_CLOSED });
      expect(mgr.sendTo(ws, { t: 'PING' })).toBe(false);
      expect(ws._sent).toHaveLength(0);
    });

    test('returns false when buffer is full', () => {
      const ws = mockWs({ bufferedAmount: BACKPRESSURE_BYTES + 1 });
      expect(mgr.sendTo(ws, { t: 'DATA' })).toBe(false);
    });

    test('returns false for null input', () => {
      expect(mgr.sendTo(null, { t: 'X' })).toBe(false);
    });
  });

  // ── snapshot / introspection ──────────────────────────────────────────────

  describe('snapshot()', () => {
    test('reflects current room state', () => {
      mgr.join('A1', mockWs());
      mgr.join('A1', mockWs());
      mgr.join('B2', mockWs());

      const snap = mgr.snapshot();
      expect(snap.roomCount).toBe(2);
      expect(snap.socketCount).toBe(3);
      expect(snap.rooms['A1']).toBe(2);
      expect(snap.rooms['B2']).toBe(1);
    });
  });
});
