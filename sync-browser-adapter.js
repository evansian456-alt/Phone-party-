/**
 * Sync Browser Adapter
 *
 * Browser-specific sync optimizations layered on top of the shared sync core.
 *
 * Responsibilities:
 *  - Apply browser platform config overrides
 *  - Handle autoplay restrictions cleanly
 *  - Handle tab visibility / backgrounding recovery
 *  - Handle reconnect / reload state recovery
 *  - Manage audio unlock flow without losing pending scheduled playback
 *  - Expose Bluetooth / manual output-latency compensation input
 *
 * This module is intended to run in a browser environment.
 * It is NOT required by server.js or any Node.js module.
 *
 * @module sync-browser-adapter
 */

/* global document, localStorage, performance */

// ============================================================
// Platform config (browser overrides)
// ============================================================

// When loaded in a browser, config constants are inlined via the
// build step or accessed from window.SYNC_CONFIG.  When loaded in
// Node (e.g. during tests) we fall back to the server-side config.
let _cfg;
try {
  _cfg = require('./sync-config').getPlatformConfig('browser');
} catch (_) {
  _cfg = {}; // browser environment: values available on window
}

const CFG = _cfg;

// ============================================================
// Browser state machine states (mirrors ClientSyncState)
// ============================================================

const BrowserSyncState = Object.freeze({
  DISCONNECTED:  'disconnected',
  SYNCING_CLOCK: 'syncing_clock',
  LOADING:       'loading',
  BUFFERING:     'buffering',
  READY:         'ready',
  SCHEDULED:     'scheduled',
  PLAYING:       'playing',
  CORRECTING:    'correcting',
  RECOVERING:    'recovering',
  RESYNCING:     'resyncing',
  ERRORED:       'errored',
});

// ============================================================
// Audio unlock helper
// ============================================================

/**
 * BrowserAudioUnlock
 *
 * Handles the browser autoplay restriction by requiring a user gesture
 * before audio can play.  Stores any pending scheduled playback across
 * the unlock flow so playback starts correctly after the gesture.
 */
class BrowserAudioUnlock {
  constructor() {
    this.unlocked = false;
    this._pendingPlayback = null;
    this._listeners = [];
  }

  /**
   * Register a callback to invoke once audio is unlocked.
   * @param {Function} fn
   */
  onUnlocked(fn) {
    if (this.unlocked) {
      fn();
    } else {
      this._listeners.push(fn);
    }
  }

  /**
   * Store pending scheduled playback details to be applied after unlock.
   * @param {{ startAtServerMs: number, startPositionSec: number }} schedule
   */
  setPendingPlayback(schedule) {
    this._pendingPlayback = schedule;
  }

  /** @returns {{ startAtServerMs, startPositionSec }|null} */
  getPendingPlayback() {
    return this._pendingPlayback;
  }

  clearPendingPlayback() {
    this._pendingPlayback = null;
  }

  /**
   * Attempt to unlock audio by playing and immediately pausing a silent
   * AudioContext node.  Call this from a user-gesture event handler.
   *
   * @param {AudioContext} [ctx] - optional existing AudioContext
   * @returns {Promise<boolean>} true if unlock succeeded
   */
  async unlock(ctx) {
    if (this.unlocked) return true;

    try {
      const audioCtx = ctx || new AudioContext();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      // Play a zero-length silent buffer to unlock in older browsers
      const buf = audioCtx.createBuffer(1, 1, 22050);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      src.start(0);
      src.stop(audioCtx.currentTime + 0.001);
    } catch (_) {
      // Ignore – some browsers don't need this
    }

    this.unlocked = true;
    this._listeners.forEach(fn => { try { fn(); } catch (_) {} });
    this._listeners = [];
    return true;
  }
}

// ============================================================
// Browser output latency profile
// ============================================================

/**
 * BrowserOutputLatencyProfile
 *
 * Persists learned per-device/per-output-mode latency compensation bias
 * to localStorage so it survives page reloads.
 *
 * Output modes tracked: 'speaker' | 'wired' | 'bluetooth' | 'external'
 */
class BrowserOutputLatencyProfile {
  constructor() {
    this._storageKey = 'syncSpeaker_latencyProfile';
    this._data = this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(this._storageKey);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  _save() {
    try {
      localStorage.setItem(this._storageKey, JSON.stringify(this._data));
    } catch (_) {}
  }

  /**
   * Return the stored compensation for a given output mode (ms).
   * @param {'speaker'|'wired'|'bluetooth'|'external'} mode
   * @returns {number}
   */
  getCompensation(mode) {
    return this._data[mode] || 0;
  }

  /**
   * Update stored compensation with a new learned value (slow EMA).
   * @param {'speaker'|'wired'|'bluetooth'|'external'} mode
   * @param {number} learnedMs
   * @param {number} [alpha=0.05]
   */
  updateCompensation(mode, learnedMs, alpha = 0.05) {
    const current = this._data[mode] || 0;
    const maxMs = CFG.AUDIO_LATENCY_COMP_MAX_MS || 80;
    const updated = current * (1 - alpha) + learnedMs * alpha;
    this._data[mode] = Math.max(-maxMs, Math.min(maxMs, updated));
    this._save();
  }

  /**
   * Load the stored compensation into a SyncClient-compatible object.
   * @param {'speaker'|'wired'|'bluetooth'|'external'} mode
   * @returns {{ audioLatencyCompMs: number }}
   */
  toClientComp(mode) {
    return { audioLatencyCompMs: this.getCompensation(mode) };
  }

  /** Clear all stored profiles. */
  clear() {
    this._data = {};
    this._save();
  }
}

// ============================================================
// Browser sync adapter
// ============================================================

/**
 * BrowserSyncAdapter
 *
 * Thin adapter that wires the shared sync core to the browser environment.
 * It tracks:
 *  - Audio unlock state
 *  - Tab visibility changes (triggers fast clock re-sync on return)
 *  - Reconnect recovery (requests RESYNC_SNAPSHOT on WS reconnect)
 *  - Scheduled playback across unlock / background
 *  - Per-device latency profile (persisted to localStorage)
 */
class BrowserSyncAdapter {
  /**
   * @param {object} opts
   * @param {Function} opts.getServerTime - () => number (server ms)
   * @param {Function} opts.sendMessage   - (msg: object) => void
   * @param {Function} [opts.onStateChange] - (state: string) => void
   */
  constructor({ getServerTime, sendMessage, onStateChange } = {}) {
    this.getServerTime = getServerTime || (() => Date.now());
    this.sendMessage   = sendMessage   || (() => {});
    this.onStateChange = onStateChange || (() => {});

    this.state = BrowserSyncState.DISCONNECTED;

    this.audioUnlock     = new BrowserAudioUnlock();
    this.latencyProfile  = new BrowserOutputLatencyProfile();
    this.outputMode      = 'speaker';   // default

    /** Scheduled playback details (server time + position) */
    this._scheduledPlay  = null;

    /** Whether tab is currently visible */
    this._visible = true;

    /** Timer for fast re-sync burst on tab return */
    this._visibilityBurstTimer = null;

    /** Generation last seen from server */
    this.generation = 0;

    // Wire up visibility listener
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => this._onVisibilityChange());
    }
  }

  // ──────────────────────────────────────────────────────────
  // State machine
  // ──────────────────────────────────────────────────────────

  _setState(newState) {
    if (newState === this.state) return;
    this.state = newState;
    this.onStateChange(newState);
  }

  // ──────────────────────────────────────────────────────────
  // Connection lifecycle
  // ──────────────────────────────────────────────────────────

  /** Call when the WebSocket connects (or reconnects). */
  onConnected() {
    this._setState(BrowserSyncState.SYNCING_CLOCK);
    // Request RESYNC_SNAPSHOT so we can recover any in-progress playback
    this.sendMessage({ t: 'REQUEST_RESYNC' });
  }

  /** Call when the WebSocket disconnects. */
  onDisconnected() {
    this._setState(BrowserSyncState.DISCONNECTED);
  }

  // ──────────────────────────────────────────────────────────
  // Scheduled playback
  // ──────────────────────────────────────────────────────────

  /**
   * Store an incoming PLAY_AT / PREPARE_PLAY schedule.
   * If audio is not yet unlocked, the schedule is held until unlock.
   *
   * @param {object} event - PLAY_AT or PREPARE_PLAY event from server
   */
  schedulePlayback(event) {
    const schedule = {
      startAtServerMs: event.startAtServerMs,
      startPositionSec: event.startPositionSec || 0,
      generation: event.generation,
    };

    if (!this.audioUnlock.unlocked) {
      this.audioUnlock.setPendingPlayback(schedule);
      this._setState(BrowserSyncState.READY);
    } else {
      this._scheduledPlay = schedule;
      this._setState(BrowserSyncState.SCHEDULED);
    }
  }

  /**
   * Call from a user-gesture event handler to unlock audio.
   * Applies any pending scheduled playback.
   *
   * @param {AudioContext} [ctx]
   * @returns {Promise<object|null>} the pending schedule if one was stored
   */
  async unlockAndResume(ctx) {
    await this.audioUnlock.unlock(ctx);
    const pending = this.audioUnlock.getPendingPlayback();
    if (pending) {
      this.audioUnlock.clearPendingPlayback();
      this._scheduledPlay = pending;
      this._setState(BrowserSyncState.SCHEDULED);
      return pending;
    }
    return null;
  }

  /**
   * Calculate the local audio element currentTime to start at for a
   * scheduled playback event, accounting for clock offset.
   *
   * @param {number} clockOffsetMs - learned server-client offset
   * @returns {{ startPositionSec: number, delayMs: number }|null}
   */
  computeLocalSchedule(clockOffsetMs) {
    if (!this._scheduledPlay) return null;
    const { startAtServerMs, startPositionSec } = this._scheduledPlay;
    const serverNow = this.getServerTime();
    const delayMs   = startAtServerMs - serverNow;
    // Advance position if we're already past the start time
    const adjustedPos = startPositionSec + Math.max(0, -delayMs) / 1000;
    return {
      startPositionSec: adjustedPos,
      delayMs: Math.max(0, delayMs),
    };
  }

  clearScheduledPlayback() {
    this._scheduledPlay = null;
  }

  // ──────────────────────────────────────────────────────────
  // Output latency profile
  // ──────────────────────────────────────────────────────────

  /** Set the current output mode (used for latency profile lookup). */
  setOutputMode(mode) {
    this.outputMode = mode;
  }

  /** Get the stored compensation for the current output mode (ms). */
  getStoredCompensation() {
    return this.latencyProfile.getCompensation(this.outputMode);
  }

  /**
   * Feed a measured drift sample into the latency profile learner.
   * @param {number} driftMs
   */
  learnLatency(driftMs) {
    this.latencyProfile.updateCompensation(this.outputMode, driftMs);
  }

  // ──────────────────────────────────────────────────────────
  // Visibility / backgrounding
  // ──────────────────────────────────────────────────────────

  _onVisibilityChange() {
    if (typeof document === 'undefined') return;
    const nowVisible = document.visibilityState === 'visible';
    if (nowVisible && !this._visible) {
      this._onTabReturn();
    }
    this._visible = nowVisible;
  }

  _onTabReturn() {
    this._setState(BrowserSyncState.RECOVERING);
    // Request a fast re-sync burst to revalidate clock after backgrounding
    this.sendMessage({ t: 'TIME_PING', clientNowMs: Date.now(), pingId: 'vis-return' });
    // Request server snapshot in case playback state changed
    this.sendMessage({ t: 'REQUEST_RESYNC' });
  }

  // ──────────────────────────────────────────────────────────
  // RESYNC_SNAPSHOT handler
  // ──────────────────────────────────────────────────────────

  /**
   * Handle a RESYNC_SNAPSHOT event from the server.
   * Updates internal state and returns actionable playback instruction.
   *
   * @param {object} snapshot - RESYNC_SNAPSHOT event
   * @returns {{ action: 'play'|'seek'|'pause'|'idle', positionSec?: number, serverTs?: number }}
   */
  handleResyncSnapshot(snapshot) {
    if (typeof snapshot.generation === 'number') {
      this.generation = snapshot.generation;
    }

    const { trackStatus, currentPositionSec, startTimestamp } = snapshot;

    if (trackStatus === 'playing') {
      const serverNow = this.getServerTime();
      const elapsedSec = (serverNow - startTimestamp) / 1000;
      const expectedPos = currentPositionSec + elapsedSec;
      this._setState(BrowserSyncState.PLAYING);
      return { action: 'play', positionSec: expectedPos, serverTs: serverNow };
    }

    if (trackStatus === 'paused') {
      this._setState(BrowserSyncState.READY);
      return { action: 'pause', positionSec: currentPositionSec };
    }

    this._setState(BrowserSyncState.IDLE);
    return { action: 'idle' };
  }

  // ──────────────────────────────────────────────────────────
  // Drift correction handler
  // ──────────────────────────────────────────────────────────

  /**
   * Apply a DRIFT_CORRECTION event to an HTMLAudioElement.
   * Handles 'rate', 'micro_seek', and 'seek' modes.
   *
   * @param {object} correction - DRIFT_CORRECTION event
   * @param {HTMLAudioElement} audioEl
   * @param {{ fade?: Function }} [opts]
   */
  applyDriftCorrection(correction, audioEl, opts = {}) {
    if (!audioEl) return;
    const { mode, rateDelta, seekToSec, playbackRate } = correction;

    this._setState(BrowserSyncState.CORRECTING);

    if (mode === 'rate') {
      audioEl.playbackRate = playbackRate || (1.0 + (rateDelta || 0));
    } else if (mode === 'micro_seek' && typeof seekToSec === 'number') {
      // Psychoacoustically masked micro-seek: small seek with optional gain ramp
      if (typeof opts.fade === 'function') {
        opts.fade(() => { audioEl.currentTime = seekToSec; });
      } else {
        audioEl.currentTime = seekToSec;
      }
      audioEl.playbackRate = 1.0;
    } else if (mode === 'seek' && typeof seekToSec === 'number') {
      // Hard seek
      audioEl.currentTime = seekToSec;
      audioEl.playbackRate = 1.0;
    }
  }
}

// ============================================================
// Exports
// ============================================================

// Export for Node.js (tests) and as a named export for browser bundles
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BrowserSyncAdapter,
    BrowserAudioUnlock,
    BrowserOutputLatencyProfile,
    BrowserSyncState,
  };
}
