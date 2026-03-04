'use strict';

/**
 * PartyRoomManager
 *
 * Centralised WebSocket "room" abstraction for party isolation, backpressure,
 * and memory-safe cleanup. Designed to support ~5,000 concurrent sockets by
 * keeping per-room bookkeeping lightweight and by removing dead sockets eagerly.
 *
 * Usage:
 *   const mgr = new PartyRoomManager();
 *   mgr.join(partyCode, ws);
 *   mgr.broadcast(partyCode, { t: 'PLAY_AT', ... });
 *   mgr.leave(partyCode, ws);
 *   mgr.dissolve(partyCode);         // host left / party ended
 *   mgr.pruneDeadSockets();          // called by the heartbeat interval
 *
 * Message-rate limiting per socket:
 *   Each socket is allowed at most MAX_MESSAGES_PER_WINDOW messages per
 *   RATE_WINDOW_MS window. Sockets that exceed this are dropped with an ERROR
 *   frame before being terminated.
 */

const WebSocket = require('ws');

// ─── Tuneable constants ───────────────────────────────────────────────────────

/** Max sockets that may be buffered before we apply backpressure (bytes). */
const BACKPRESSURE_BYTES = 64 * 1024; // 64 KB

/** Inbound rate-limit: messages allowed per socket per window. */
const MAX_MESSAGES_PER_WINDOW = 60;

/** Duration of the inbound rate-limit window in milliseconds. */
const RATE_WINDOW_MS = 1_000; // 1 second

// ─── PartyRoomManager ────────────────────────────────────────────────────────

class PartyRoomManager {
  constructor() {
    /**
     * rooms: Map<partyCode, Set<WebSocket>>
     * Each Set holds only the live sockets for that party.
     */
    this._rooms = new Map();

    /**
     * socketRoom: Map<WebSocket, partyCode>
     * Reverse-lookup so leave() / pruneDeadSockets() run in O(1).
     */
    this._socketRoom = new Map();

    /**
     * msgCount: Map<WebSocket, { count, windowStart }>
     * Per-socket inbound message counters for rate limiting.
     */
    this._msgCount = new Map();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Add a WebSocket to a party room.
   * If the room does not yet exist it is created.
   *
   * @param {string} partyCode
   * @param {WebSocket} ws
   */
  join(partyCode, ws) {
    if (!partyCode || !ws) return;

    if (!this._rooms.has(partyCode)) {
      this._rooms.set(partyCode, new Set());
    }
    this._rooms.get(partyCode).add(ws);
    this._socketRoom.set(ws, partyCode);
    this._msgCount.set(ws, { count: 0, windowStart: Date.now() });
  }

  /**
   * Remove a WebSocket from its party room.
   * Cleans up per-socket state and removes empty rooms.
   *
   * @param {string} partyCode
   * @param {WebSocket} ws
   */
  leave(partyCode, ws) {
    const room = this._rooms.get(partyCode);
    if (room) {
      room.delete(ws);
      if (room.size === 0) {
        this._rooms.delete(partyCode);
      }
    }
    this._socketRoom.delete(ws);
    this._msgCount.delete(ws);
  }

  /**
   * Remove ALL sockets from a party room (e.g. host left).
   * Sends an ENDED frame to every open socket before closing.
   *
   * @param {string} partyCode
   * @param {object} [message]  Optional override for the termination message.
   */
  dissolve(partyCode, message = { t: 'ENDED' }) {
    const room = this._rooms.get(partyCode);
    if (!room) return;

    const payload = JSON.stringify(message);
    for (const ws of room) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload); } catch (_) { /* best-effort */ }
      }
      this._socketRoom.delete(ws);
      this._msgCount.delete(ws);
    }

    this._rooms.delete(partyCode);
  }

  /**
   * Broadcast a message to every open socket in a party room.
   * Sockets with a full send buffer (backpressure) are skipped and logged.
   *
   * @param {string} partyCode
   * @param {object|string} message  Plain object (auto-serialised) or a pre-serialised string.
   * @param {Set<WebSocket>} [exclude]  Optional set of sockets to skip.
   * @returns {number} Number of sockets the message was sent to.
   */
  broadcast(partyCode, message, exclude = new Set()) {
    const room = this._rooms.get(partyCode);
    if (!room) return 0;

    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    let sent = 0;

    for (const ws of room) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (exclude.has(ws)) continue;

      // Backpressure: skip sockets with a full write buffer
      if (ws.bufferedAmount > BACKPRESSURE_BYTES) {
        console.warn(`[PartyRoomManager] Backpressure on socket in party ${partyCode} — buffered ${ws.bufferedAmount} bytes, skipping`);
        continue;
      }

      try {
        ws.send(payload);
        sent++;
      } catch (err) {
        console.warn(`[PartyRoomManager] Send error in party ${partyCode}: ${err.message}`);
      }
    }

    return sent;
  }

  /**
   * Send a message to a single socket, with backpressure check.
   *
   * @param {WebSocket} ws
   * @param {object|string} message
   * @returns {boolean} true if sent successfully.
   */
  sendTo(ws, message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    if (ws.bufferedAmount > BACKPRESSURE_BYTES) {
      console.warn('[PartyRoomManager] Backpressure: cannot send to socket with full buffer');
      return false;
    }

    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    try {
      ws.send(payload);
      return true;
    } catch (err) {
      console.warn(`[PartyRoomManager] sendTo error: ${err.message}`);
      return false;
    }
  }

  /**
   * Rate-limit check for an inbound message from a socket.
   * Call this before processing each incoming WS message.
   *
   * @param {WebSocket} ws
   * @returns {boolean}  true if the message is allowed, false if rate-limited.
   */
  checkRateLimit(ws) {
    let entry = this._msgCount.get(ws);
    if (!entry) {
      entry = { count: 0, windowStart: Date.now() };
      this._msgCount.set(ws, entry);
    }

    const now = Date.now();
    if (now - entry.windowStart >= RATE_WINDOW_MS) {
      // New window
      entry.count = 1;
      entry.windowStart = now;
      return true;
    }

    entry.count++;
    return entry.count <= MAX_MESSAGES_PER_WINDOW;
  }

  /**
   * Remove dead sockets (readyState !== OPEN) from all rooms.
   * Should be called periodically (e.g. every 30 s) from the heartbeat loop.
   *
   * @returns {number} Number of dead sockets removed.
   */
  pruneDeadSockets() {
    let pruned = 0;

    for (const [partyCode, room] of this._rooms) {
      for (const ws of room) {
        if (ws.readyState !== WebSocket.OPEN) {
          room.delete(ws);
          this._socketRoom.delete(ws);
          this._msgCount.delete(ws);
          pruned++;
        }
      }
      if (room.size === 0) {
        this._rooms.delete(partyCode);
      }
    }

    if (pruned > 0) {
      console.log(`[PartyRoomManager] Pruned ${pruned} dead socket(s)`);
    }

    return pruned;
  }

  // ─── Introspection helpers ─────────────────────────────────────────────────

  /** Number of sockets in a party room. */
  roomSize(partyCode) {
    return this._rooms.get(partyCode)?.size ?? 0;
  }

  /** Total number of active rooms. */
  get roomCount() {
    return this._rooms.size;
  }

  /** Total number of tracked sockets across all rooms. */
  get socketCount() {
    return this._socketRoom.size;
  }

  /** Party code that a given socket belongs to (or undefined). */
  partyOf(ws) {
    return this._socketRoom.get(ws);
  }

  /** Snapshot of room sizes for observability / metrics. */
  snapshot() {
    const rooms = {};
    for (const [code, room] of this._rooms) {
      rooms[code] = room.size;
    }
    return {
      roomCount: this._rooms.size,
      socketCount: this._socketRoom.size,
      rooms,
    };
  }
}

module.exports = { PartyRoomManager, BACKPRESSURE_BYTES, MAX_MESSAGES_PER_WINDOW, RATE_WINDOW_MS };
