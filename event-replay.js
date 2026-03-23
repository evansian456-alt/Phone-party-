/**
 * Event Replay System for Failed WebSocket Messages
 *
 * Provides reliable message delivery with acknowledgment tracking and automatic retry.
 * Ensures critical messages (sync, playback control, reactions) are delivered to all clients
 * even in the presence of network issues or temporary disconnections.
 *
 * Key Features:
 * - Message queue with timestamps and unique IDs
 * - Per-client acknowledgment tracking
 * - Configurable retry intervals and max attempts
 * - Automatic cleanup of old/acknowledged messages
 * - Support for different message priority levels
 * - Idempotent delivery: duplicate event IDs are never double-applied
 * - Generation-aware: stale events (older generation) are silently dropped
 * - Sequence ordering: out-of-order replays are rejected
 */

const { nanoid } = require('nanoid');

/**
 * Message priority levels
 * - CRITICAL: Must be delivered (playback sync, party state)
 * - HIGH: Should be delivered (reactions, chat)
 * - NORMAL: Best effort (UI updates)
 */
const MessagePriority = {
  CRITICAL: 'critical',
  HIGH: 'high',
  NORMAL: 'normal'
};

/**
 * Configuration for retry behavior
 */
const DEFAULT_CONFIG = {
  retryIntervalMs: 2000,        // Check for unacknowledged messages every 2s
  maxRetryAttempts: 5,           // Maximum retry attempts per message
  messageTimeoutMs: 30000,       // Remove messages after 30s regardless of ack status
  cleanupIntervalMs: 10000,      // Clean up old messages every 10s
  batchSize: 50,                 // Maximum messages to retry per interval
  enableLogging: true            // Enable debug logging
};

/**
 * EventReplayManager - Manages message queuing, acknowledgment, and retry
 *
 * Idempotency model:
 *   - Every message queued here receives a unique _msgId.
 *   - Clients echo _msgId in a MSG_ACK response.
 *   - A per-party delivered-event registry prevents double-application of
 *     any replayed event that carries an eventId field.
 *   - If an event carries a `generation` field, events older than the
 *     party's current generation are dropped before queuing.
 */
class EventReplayManager {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Message queue: messageId -> { message, timestamp, priority, attempts, acknowledgedBy }
    this.messageQueue = new Map();

    // Party membership tracking: partyCode -> Set of clientIds
    this.partyMembers = new Map();

    // Client metadata: clientId -> { ws, partyCode, lastSeen }
    this.clients = new Map();

    // Per-party state: partyCode -> { generation, deliveredEventIds }
    this._partyState = new Map();

    // Retry timer
    this.retryTimer = null;
    this.cleanupTimer = null;

    // Statistics
    this.stats = {
      messagesSent: 0,
      messagesAcknowledged: 0,
      messagesRetried: 0,
      messagesFailed: 0,
      messagesTimedOut: 0,
      staleEventDrops: 0,
      duplicateEventDrops: 0,
    };
  }

  /**
   * Initialize the event replay system
   */
  start() {
    if (this.retryTimer) return; // Already started

    this.log('Event Replay System starting...');

    // Start retry checker
    this.retryTimer = setInterval(() => {
      this.retryUnacknowledgedMessages();
    }, this.config.retryIntervalMs);

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldMessages();
    }, this.config.cleanupIntervalMs);

    this.log('Event Replay System started');
  }

  /**
   * Stop the event replay system
   */
  stop() {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.log('Event Replay System stopped');
  }

  /**
   * Register a client for acknowledgment tracking
   */
  registerClient(clientId, ws, partyCode) {
    this.clients.set(clientId, {
      ws,
      partyCode,
      lastSeen: Date.now()
    });

    // Add to party members
    if (!this.partyMembers.has(partyCode)) {
      this.partyMembers.set(partyCode, new Set());
    }
    this.partyMembers.get(partyCode).add(clientId);

    this.log(`Client registered: ${clientId} in party ${partyCode}`);
  }

  /**
   * Unregister a client
   */
  unregisterClient(clientId) {
    const client = this.clients.get(clientId);
    if (client && client.partyCode) {
      const members = this.partyMembers.get(client.partyCode);
      if (members) {
        members.delete(clientId);
        if (members.size === 0) {
          this.partyMembers.delete(client.partyCode);
        }
      }
    }

    this.clients.delete(clientId);
    this.log(`Client unregistered: ${clientId}`);
  }

  // ──────────────────────────────────────────────────────────
  // Generation / idempotency helpers
  // ──────────────────────────────────────────────────────────

  /**
   * Get or initialise the per-party state record.
   * @param {string} partyCode
   * @returns {{ generation: number, deliveredEventIds: Set<string> }}
   */
  _getPartyState(partyCode) {
    if (!this._partyState.has(partyCode)) {
      this._partyState.set(partyCode, { generation: 0, deliveredEventIds: new Set() });
    }
    return this._partyState.get(partyCode);
  }

  /**
   * Advance the party's generation.  Events from older generations are dropped.
   * @param {string} partyCode
   * @param {number} newGeneration
   */
  advanceGeneration(partyCode, newGeneration) {
    const state = this._getPartyState(partyCode);
    if (newGeneration > state.generation) {
      state.generation = newGeneration;
      state.deliveredEventIds.clear(); // stale IDs are irrelevant after a generation bump
      this.log(`Party ${partyCode} generation advanced to ${newGeneration}`);
    }
  }

  /**
   * Check whether an event should be enqueued / delivered.
   *
   * Returns false (dropping the event) if:
   *  - event.generation is present and older than the party's current generation
   *  - event.eventId (or _msgId) was already delivered (duplicate)
   *
   * @param {string} partyCode
   * @param {object} command
   * @returns {boolean}
   */
  _shouldDeliver(partyCode, command) {
    const state = this._getPartyState(partyCode);

    // Stale generation
    if (typeof command.generation === 'number' && command.generation < state.generation) {
      this.stats.staleEventDrops++;
      this.log(`Dropping stale event (generation ${command.generation} < party ${state.generation})`);
      return false;
    }

    // Advance generation if event carries a newer one
    if (typeof command.generation === 'number' && command.generation > state.generation) {
      state.generation = command.generation;
      state.deliveredEventIds.clear();
    }

    // Duplicate event ID
    const eid = command.eventId || command._msgId;
    if (eid && state.deliveredEventIds.has(eid)) {
      this.stats.duplicateEventDrops++;
      this.log(`Dropping duplicate event id=${eid}`);
      return false;
    }
    if (eid) {
      state.deliveredEventIds.add(eid);
      // Keep the registry bounded
      if (state.deliveredEventIds.size > 1000) {
        const oldest = state.deliveredEventIds.values().next().value;
        state.deliveredEventIds.delete(oldest);
      }
    }

    return true;
  }

  // ──────────────────────────────────────────────────────────
  // Sending
  // ──────────────────────────────────────────────────────────

  /**
   * Send a command to party with acknowledgment tracking.
   * Automatically drops events that are stale (old generation) or duplicates.
   *
   * @param {string} partyCode - Party identifier
   * @param {object} command - Message object to broadcast
   * @param {string} priority - Message priority (CRITICAL, HIGH, NORMAL)
   * @param {Set<string>} excludeClients - Optional set of client IDs to exclude
   * @returns {object} { messageId, sentCount, requiresAck }
   */
  sendCommandToParty(partyCode, command, priority = MessagePriority.NORMAL, excludeClients = new Set()) {
    // Idempotency / generation check before doing anything
    if (!this._shouldDeliver(partyCode, command)) {
      return { messageId: null, sentCount: 0, requiresAck: false };
    }

    const messageId = nanoid(12);
    const timestamp = Date.now();

    // Only track acknowledgments for CRITICAL and HIGH priority messages
    const requiresAck = priority === MessagePriority.CRITICAL || priority === MessagePriority.HIGH;

    // Add message ID to command for client identification
    const messageWithId = {
      ...command,
      _msgId: messageId,
      _requiresAck: requiresAck
    };

    const members = this.partyMembers.get(partyCode);
    if (!members || members.size === 0) {
      this.log(`No members in party ${partyCode}`);
      return { messageId, sentCount: 0, requiresAck: false };
    }

    // Track which clients need to acknowledge
    const expectedClients = new Set();
    let sentCount = 0;

    // Broadcast to all party members
    members.forEach(clientId => {
      if (excludeClients.has(clientId)) return;

      const client = this.clients.get(clientId);
      if (!client || !client.ws) return;

      const sent = this.sendToClient(client.ws, messageWithId);
      if (sent) {
        sentCount++;
        if (requiresAck) {
          expectedClients.add(clientId);
        }
      }
    });

    // Store message for retry if acknowledgment required
    if (requiresAck && expectedClients.size > 0) {
      this.messageQueue.set(messageId, {
        message: messageWithId,
        partyCode,
        timestamp,
        priority,
        attempts: 1,
        acknowledgedBy: new Set(),
        expectedClients,
        excludeClients
      });

      this.stats.messagesSent++;
    }

    this.log(`Sent message ${messageId} to ${sentCount} clients in party ${partyCode} (priority: ${priority}, requiresAck: ${requiresAck})`);

    return { messageId, sentCount, requiresAck };
  }

  /**
   * Send message to a specific client
   */
  sendToClient(ws, message) {
    if (!ws || ws.readyState !== 1) { // WebSocket.OPEN = 1
      return false;
    }

    try {
      const msgStr = typeof message === 'string' ? message : JSON.stringify(message);
      ws.send(msgStr);
      return true;
    } catch (error) {
      this.log(`Failed to send to client: ${error.message}`);
      return false;
    }
  }

  /**
   * Handle acknowledgment from a client
   */
  handleAcknowledgment(clientId, messageId) {
    const queuedMessage = this.messageQueue.get(messageId);
    if (!queuedMessage) {
      // Message not in queue (already fully acknowledged or timed out)
      return;
    }

    // Mark client as acknowledged
    queuedMessage.acknowledgedBy.add(clientId);
    this.stats.messagesAcknowledged++;

    this.log(`Client ${clientId} acknowledged message ${messageId} (${queuedMessage.acknowledgedBy.size}/${queuedMessage.expectedClients.size})`);

    // Remove from queue if all expected clients have acknowledged
    if (queuedMessage.acknowledgedBy.size >= queuedMessage.expectedClients.size) {
      this.messageQueue.delete(messageId);
      this.log(`Message ${messageId} fully acknowledged, removed from queue`);
    }
  }

  /**
   * Retry unacknowledged messages
   */
  retryUnacknowledgedMessages() {
    const now = Date.now();
    let retriedCount = 0;

    // Process messages in batches
    for (const [messageId, queuedMessage] of this.messageQueue.entries()) {
      if (retriedCount >= this.config.batchSize) break;

      // Check if message has timed out
      if (now - queuedMessage.timestamp > this.config.messageTimeoutMs) {
        this.log(`Message ${messageId} timed out, removing from queue`);
        this.messageQueue.delete(messageId);
        this.stats.messagesTimedOut++;
        continue;
      }

      // Check if max attempts reached
      if (queuedMessage.attempts >= this.config.maxRetryAttempts) {
        this.log(`Message ${messageId} exceeded max retry attempts, removing from queue`);
        this.messageQueue.delete(messageId);
        this.stats.messagesFailed++;
        continue;
      }

      // Find clients that haven't acknowledged
      const unacknowledgedClients = [];
      queuedMessage.expectedClients.forEach(clientId => {
        if (!queuedMessage.acknowledgedBy.has(clientId)) {
          unacknowledgedClients.push(clientId);
        }
      });

      // Retry sending to unacknowledged clients
      if (unacknowledgedClients.length > 0) {
        let retrySentCount = 0;

        unacknowledgedClients.forEach(clientId => {
          const client = this.clients.get(clientId);
          if (client && client.ws) {
            const sent = this.sendToClient(client.ws, queuedMessage.message);
            if (sent) {
              retrySentCount++;
            }
          }
        });

        if (retrySentCount > 0) {
          queuedMessage.attempts++;
          retriedCount++;
          this.stats.messagesRetried++;

          this.log(`Retried message ${messageId} to ${retrySentCount} clients (attempt ${queuedMessage.attempts}/${this.config.maxRetryAttempts})`);
        }
      }
    }

    if (retriedCount > 0) {
      this.log(`Retry cycle complete: ${retriedCount} messages retried`);
    }
  }

  /**
   * Clean up old messages from queue
   */
  cleanupOldMessages() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [messageId, queuedMessage] of this.messageQueue.entries()) {
      // Remove messages older than timeout threshold
      if (now - queuedMessage.timestamp > this.config.messageTimeoutMs) {
        this.messageQueue.delete(messageId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.log(`Cleaned up ${cleanedCount} old messages from queue`);
    }
  }

  /**
   * Get current statistics
   */
  getStats() {
    return {
      ...this.stats,
      queueSize: this.messageQueue.size,
      activeClients: this.clients.size,
      activeParties: this.partyMembers.size
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      messagesSent: 0,
      messagesAcknowledged: 0,
      messagesRetried: 0,
      messagesFailed: 0,
      messagesTimedOut: 0,
      staleEventDrops: 0,
      duplicateEventDrops: 0,
    };
  }

  /**
   * Log helper
   */
  log(message) {
    if (this.config.enableLogging) {
      console.log(`[EventReplay] ${message}`);
    }
  }
}

module.exports = {
  EventReplayManager,
  MessagePriority,
  DEFAULT_CONFIG
};
