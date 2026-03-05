/**
 * SyncSpeaker Client-Side Sync Engine
 * 
 * Client-side implementation for high-precision multi-device synchronization
 * Features:
 * - Monotonic clock using performance.now() to avoid wall-clock jumps
 * - Clock synchronization with server using NTP-style rolling window
 * - Timestamped playback scheduling (near-target rAF loop)
 * - PLL drift correction via playback rate adjustment
 * - Hard-seek resync support (server-directed)
 * - Rolling buffer management
 * - Playback feedback loop
 * - Network-aware sync (adaptive thresholds for mobile)
 */

// ============================================================
// Configuration
// ============================================================

/* eslint-disable */
// Inline sync-config constants for browser compatibility.
// When loaded as a Node.js module (tests / server), require() is available.
// When loaded as a plain <script> in the browser, we fall back to these literals.
let CLOCK_SYNC_INTERVAL_MS, PLAYBACK_FEEDBACK_INTERVAL_MS,
    SYNC_TEST_FEEDBACK_INTERVAL_MS, ROLLING_BUFFER_MS,
    PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX, LATE_PLAYBACK_THRESHOLD_MS,
    DESKTOP_IGNORE_DRIFT_MS, DESKTOP_SOFT_CORRECTION_MS,
    MOBILE_IGNORE_DRIFT_MS, MOBILE_SOFT_CORRECTION_MS,
    MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS,
    SYNC_TEST_MODE, TEST_AUDIO_PATH;

if (typeof require !== 'undefined') {
  ({
    CLOCK_SYNC_INTERVAL_MS,
    PLAYBACK_FEEDBACK_INTERVAL_MS,
    SYNC_TEST_FEEDBACK_INTERVAL_MS,
    ROLLING_BUFFER_MS,
    PLAYBACK_RATE_MIN,
    PLAYBACK_RATE_MAX,
    LATE_PLAYBACK_THRESHOLD_MS,
    DESKTOP_IGNORE_DRIFT_MS,
    DESKTOP_SOFT_CORRECTION_MS,
    MOBILE_IGNORE_DRIFT_MS,
    MOBILE_SOFT_CORRECTION_MS,
    MAX_RECONNECT_ATTEMPTS,
    RECONNECT_DELAY_MS,
    MAX_RECONNECT_DELAY_MS,
    SYNC_TEST_MODE,
    TEST_AUDIO_PATH,
  } = require('./sync-config'));
} else {
  // Browser fallback — mirrors sync-config.js defaults
  CLOCK_SYNC_INTERVAL_MS = 5000;
  PLAYBACK_FEEDBACK_INTERVAL_MS = 100;
  SYNC_TEST_FEEDBACK_INTERVAL_MS = 500;
  ROLLING_BUFFER_MS = 150;
  PLAYBACK_RATE_MIN = 0.95;
  PLAYBACK_RATE_MAX = 1.05;
  LATE_PLAYBACK_THRESHOLD_MS = -1000;
  DESKTOP_IGNORE_DRIFT_MS = 200;
  DESKTOP_SOFT_CORRECTION_MS = 800;
  MOBILE_IGNORE_DRIFT_MS = 300;
  MOBILE_SOFT_CORRECTION_MS = 1000;
  MAX_RECONNECT_ATTEMPTS = 10;
  RECONNECT_DELAY_MS = 1000;
  MAX_RECONNECT_DELAY_MS = 30000;
  SYNC_TEST_MODE = false;
  TEST_AUDIO_PATH = '/test-audio.wav';
}
/* eslint-enable */

// Load psychoacoustic masking helpers (browser: attached to window; Node: required)
const _PsychoacousticMaskingSync = (typeof PsychoacousticMasking !== 'undefined')
  ? PsychoacousticMasking
  : (() => {
    try { return require('./psychoacoustic-masking').PsychoacousticMasking; } catch (_) { return null; }
  })();

// ============================================================
// Monotonic clock (client-side)
// ============================================================

/**
 * Build a monotonic time source anchored to performance.now().
 * Avoids wall-clock jumps from NTP corrections on the device.
 * Falls back to Date.now() in environments without performance.now().
 * @returns {function(): number} nowMs() – current time in ms
 */
function buildClientClock() {
  // In Node.js test environments performance may not exist
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    const baseWall = Date.now();
    const basePerf = performance.now();
    return function nowMs() {
      return baseWall + (performance.now() - basePerf);
    };
  }
  return function nowMs() { return Date.now(); };
}

/** Global monotonic clock for this client instance */
const _clientClock = buildClientClock();

// ============================================================
// Utility Functions
// ============================================================

/**
 * Detect network type (WiFi vs Cellular)
 * Uses Network Information API where available
 * @returns {string} 'wifi', 'cellular', or 'unknown'
 */
function detectNetworkType() {
  if (!navigator.connection && !navigator.mozConnection && !navigator.webkitConnection) {
    return 'unknown';
  }
  
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  
  if (!connection.effectiveType) {
    return 'unknown';
  }
  
  // Prefer the explicit type property if available
  if (connection.type) {
    // type: 'wifi', 'cellular', 'ethernet', 'none', etc.
    if (connection.type === 'wifi' || connection.type === 'ethernet') {
      return 'wifi';
    } else if (connection.type === 'cellular') {
      return 'cellular';
    }
  }
  
  // Fallback: Use effectiveType as a heuristic
  // effectiveType: '4g', '3g', '2g', 'slow-2g'
  // Note: '4g' could be either WiFi or LTE, so we default to cellular as the conservative choice
  const type = connection.effectiveType;
  
  if (type === 'slow-2g' || type === '2g' || type === '3g') {
    return 'cellular'; // Definitely cellular
  }
  
  // '4g' is ambiguous - could be LTE or WiFi
  // Default to 'cellular' for conservative sync thresholds
  // If connection.type wasn't available, we can't distinguish
  return 'cellular';
}

/**
 * Check if running on mobile device
 * Uses feature detection + viewport size
 * @returns {boolean} true if mobile device
 */
function isMobileDevice() {
  // Check for touch support
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  
  // Check viewport size (mobile typically < 768px)
  const smallViewport = window.innerWidth < 768;
  
  // Check for mobile-specific APIs
  const hasMobileAPIs = 'orientation' in window || 'ondeviceorientation' in window;
  
  return (hasTouch && smallViewport) || hasMobileAPIs;
}

// ============================================================
// Client-Side Sync Engine
// ============================================================

/**
 * Client-side synchronization engine for high-precision multi-device audio/video sync
 * Handles clock synchronization with server, drift detection and correction,
 * and coordinated playback scheduling
 * 
 * @class ClientSyncEngine
 * @property {number} clockOffset - Offset from server clock in milliseconds
 * @property {number} latency - Round-trip network latency in milliseconds
 * @property {number} rollingBufferSec - Rolling buffer size in seconds
 * @property {number} playbackRate - Current playback rate (1.0 = normal speed)
 * @property {number|null} lastSyncTime - Timestamp of last clock synchronization
 * @property {number} syncInterval - Clock synchronization interval in milliseconds
 * @property {number} feedbackInterval - Playback feedback interval in milliseconds
 * @property {AudioContext|null} audioContext - Web Audio API context for precise timing
 * @property {object|null} scheduledPlayback - Scheduled playback information
 * @property {number|null} feedbackTimer - Interval timer for playback feedback
 * @property {number|null} syncTimer - Interval timer for clock synchronization
 * @property {WebSocket|null} ws - WebSocket connection to server
 * @property {Function|null} onFeedback - Callback for playback feedback events
 * @property {Function|null} onDriftCorrection - Callback for drift correction events
 * @property {HTMLVideoElement|null} videoElement - Optional video element for A/V sync
 * @property {HTMLAudioElement|null} audioElement - Audio element for playback
 * @property {number} reconnectAttempts - Current number of reconnection attempts
 * @property {number} maxReconnectAttempts - Maximum allowed reconnection attempts
 * @property {number} reconnectDelay - Current reconnection delay in milliseconds
 * @property {number} maxReconnectDelay - Maximum reconnection delay in milliseconds
 * @property {number|null} reconnectTimer - Timer for reconnection attempts
 * @property {Function|null} onReconnect - Callback for reconnection events
 * @property {boolean} isMobile - True if running on mobile device
 * @property {string} networkType - Detected network type ('wifi', 'cellular', 'unknown')
 * @property {number} driftThreshold - Threshold for ignoring small drift (ms)
 * @property {number} softCorrectionThreshold - Threshold for soft drift correction (ms)
 */
class ClientSyncEngine {
  /**
   * Create a new client sync engine with adaptive thresholds based on device and network
   */
  constructor() {
    this.clockOffset = 0;                              // Offset from server clock (ms)
    this.latency = 0;                                  // Round-trip latency (ms)
    this.rollingBufferSec = ROLLING_BUFFER_MS / 1000;  // Rolling buffer size (convert ms to seconds)
    this.playbackRate = 1.0;                           // Current playback rate
    this.lastSyncTime = null;                          // Last clock sync timestamp
    this.syncInterval = CLOCK_SYNC_INTERVAL_MS;        // Clock sync interval
    this.feedbackInterval = PLAYBACK_FEEDBACK_INTERVAL_MS; // Playback feedback interval
    this.audioContext = null;                          // Web Audio API context
    this.scheduledPlayback = null;                     // Scheduled playback info
    this.feedbackTimer = null;                         // Feedback loop timer
    this.syncTimer = null;                             // Clock sync timer
    this.ws = null;                                    // WebSocket connection
    this.onFeedback = null;                            // Callback for playback feedback
    this.onDriftCorrection = null;                     // Callback for drift correction
    this.videoElement = null;                          // Optional video element for video sync
    this.audioElement = null;                          // Audio element for playback
    
    // WebSocket reconnection state
    this.reconnectAttempts = 0;                        // Number of reconnection attempts
    this.maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Maximum reconnection attempts
    this.reconnectDelay = RECONNECT_DELAY_MS;          // Initial reconnection delay
    this.maxReconnectDelay = MAX_RECONNECT_DELAY_MS;   // Maximum reconnection delay
    this.reconnectTimer = null;                        // Reconnection timer
    this.onReconnect = null;                           // Callback for reconnection
    
    // Network and device detection
    this.isMobile = isMobileDevice();                  // Is mobile device
    this.networkType = detectNetworkType();            // Current network type
    this.driftThreshold = this.isMobile ? MOBILE_IGNORE_DRIFT_MS : DESKTOP_IGNORE_DRIFT_MS;
    this.softCorrectionThreshold = this.isMobile ? MOBILE_SOFT_CORRECTION_MS : DESKTOP_SOFT_CORRECTION_MS;
    
    // Log device and network info
    console.log(`[Sync] Device: ${this.isMobile ? 'Mobile' : 'Desktop'}, Network: ${this.networkType}`);
    console.log(`[Sync] Thresholds: Ignore=${this.driftThreshold}ms, Soft=${this.softCorrectionThreshold}ms`);
  }

  /**
   * Initialize the sync engine
   * @param {WebSocket} ws - WebSocket connection to server
   * @param {HTMLAudioElement|null} audioElement - Audio element for playback
   * @param {HTMLVideoElement|null} videoElement - Optional video element
   */
  initialize(ws, audioElement = null, videoElement = null) {
    this.ws = ws;
    this.audioElement = audioElement;
    this.videoElement = videoElement;

    // NOTE: AudioContext initialization moved to initAudioContext()
    // to comply with Android requirement for user gesture before audio initialization

    // Listen for network changes
    if (navigator.connection || navigator.mozConnection || navigator.webkitConnection) {
      const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      connection.addEventListener('change', () => {
        this.updateNetworkConditions();
      });
    }

    // Start clock sync loop
    this.startClockSyncLoop();
  }

  /**
   * Initialize AudioContext (must be called from user gesture on Android)
   * This should be called when user first interacts with audio (e.g., play button)
   * @returns {AudioContext|null} The initialized AudioContext or null
   */
  initAudioContext() {
    if (!this.audioContext && typeof AudioContext !== 'undefined') {
      try {
        this.audioContext = new AudioContext();
        console.log('[Sync] AudioContext initialized from user gesture');
        
        // Resume if suspended (Android Chrome auto-suspends)
        if (this.audioContext.state === 'suspended') {
          this.audioContext.resume();
        }
      } catch (err) {
        console.error('[Sync] Failed to initialize AudioContext:', err);
      }
    }
    return this.audioContext;
  }

  /**
   * Update network detection and adjust thresholds
   * Call this when network conditions change (e.g., WiFi to LTE transition)
   */
  updateNetworkConditions() {
    const previousNetwork = this.networkType;
    this.networkType = detectNetworkType();
    
    // Adjust thresholds based on network type
    if (this.networkType === 'cellular' || this.isMobile) {
      this.driftThreshold = MOBILE_IGNORE_DRIFT_MS;
      this.softCorrectionThreshold = MOBILE_SOFT_CORRECTION_MS;
    } else {
      this.driftThreshold = DESKTOP_IGNORE_DRIFT_MS;
      this.softCorrectionThreshold = DESKTOP_SOFT_CORRECTION_MS;
    }
    
    if (previousNetwork !== this.networkType) {
      console.log(`[Sync] Network changed: ${previousNetwork} → ${this.networkType}`);
      console.log(`[Sync] Updated thresholds: Ignore=${this.driftThreshold}ms, Soft=${this.softCorrectionThreshold}ms`);
    }
  }

  /**
   * Get server time adjusted for clock offset (using monotonic clock)
   * @returns {number} Server time in milliseconds
   */
  getServerTime() {
    return _clientClock() - this.clockOffset;
  }

  /**
   * Start clock synchronization loop
   */
  startClockSyncLoop() {
    // Initial sync
    this.sendClockPing();

    // Set up periodic sync
    this.syncTimer = setInterval(() => {
      this.sendClockPing();
    }, this.syncInterval);
  }

  /**
   * Stop clock synchronization loop
   */
  stopClockSyncLoop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Send clock ping to server
   */
  sendClockPing() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Use monotonic clock for sync-critical timestamps
    const clientNowMs = _clientClock();
    const pingMessage = {
      t: 'CLOCK_PING',
      clientNowMs: clientNowMs,
      pingId: Math.random().toString(36).substring(7)
    };

    this.ws.send(JSON.stringify(pingMessage));
  }

  /**
   * Handle clock pong response from server
   * @param {object} msg - Pong message from server
   */
  handleClockPong(msg) {
    // Use monotonic clock for receive timestamp
    const receivedTime = _clientClock();
    const sentTime = msg.clientSentTime || msg.clientNowMs;
    const serverNowMs = msg.serverNowMs;

    // Calculate round-trip latency
    const roundTripMs = receivedTime - sentTime;
    this.latency = Math.max(0, roundTripMs) / 2;

    // Calculate clock offset
    // Server time at midpoint = serverNowMs + latency
    // Client time at midpoint = sentTime + latency
    // Offset = client time - server time
    this.clockOffset = (sentTime + this.latency) - serverNowMs;
    this.lastSyncTime = _clientClock();

    console.log(`[Sync] Clock synced - Offset: ${this.clockOffset.toFixed(2)}ms, Latency: ${this.latency.toFixed(2)}ms`);
  }

  /**
   * Schedule track playback at specific server timestamp
   * @param {object} trackData - Track data from server
   * @returns {boolean} Success status
   */
  scheduleTrackPlayback(trackData) {
    if (!this.audioElement) {
      console.error('[Sync] No audio element available for playback');
      return false;
    }

    const playAtServer = trackData.playAt || trackData.startAtServerMs;
    const trackUrl = trackData.trackUrl;
    const startPositionSec = trackData.startPositionSec || 0;

    // Calculate when to start playback in local time
    const serverNow = this.getServerTime();
    const delayMs = playAtServer - serverNow;

    console.log(`[Sync] Scheduling playback - Server time: ${serverNow}, Play at: ${playAtServer}, Delay: ${delayMs}ms`);

    if (delayMs < LATE_PLAYBACK_THRESHOLD_MS) {
      console.warn('[Sync] Playback time has already passed, starting immediately');
    }

    // Store scheduled playback info
    this.scheduledPlayback = {
      playAtServer: playAtServer,
      trackUrl: trackUrl,
      startPositionSec: startPositionSec,
      trackData: trackData
    };

    // Pre-buffer audio
    this.preBufferAudio(trackUrl, startPositionSec);

    // Schedule playback
    const playDelay = Math.max(0, delayMs - (this.rollingBufferSec * 1000));
    setTimeout(() => {
      this.executeScheduledPlayback();
    }, playDelay);

    return true;
  }

  /**
   * Pre-buffer audio for smooth playback
   * @param {string} trackUrl - URL of the track
   * @param {number} startPositionSec - Starting position in seconds
   */
  preBufferAudio(trackUrl, startPositionSec = 0) {
    if (!this.audioElement) return;

    // Load audio
    this.audioElement.src = trackUrl;
    this.audioElement.currentTime = startPositionSec;
    this.audioElement.playbackRate = this.playbackRate;

    // Pre-load audio data
    this.audioElement.load();

    console.log(`[Sync] Pre-buffering audio from ${startPositionSec}s`);
  }

  /**
   * Execute scheduled playback
   */
  executeScheduledPlayback() {
    if (!this.audioElement || !this.scheduledPlayback) {
      console.error('[Sync] Cannot execute playback - missing audio element or schedule');
      return;
    }

    const serverNow = this.getServerTime();
    const playAtServer = this.scheduledPlayback.playAtServer;
    const startPositionSec = this.scheduledPlayback.startPositionSec;

    // Calculate exact position to start based on current server time
    const elapsedSec = (serverNow - playAtServer) / 1000;
    const actualStartPosition = startPositionSec + elapsedSec;

    console.log(`[Sync] Executing playback - Expected start: ${startPositionSec}s, Actual: ${actualStartPosition.toFixed(3)}s`);

    // Set position and play
    this.audioElement.currentTime = actualStartPosition;
    this.audioElement.playbackRate = this.playbackRate;
    
    // Play audio
    this.audioElement.play().then(() => {
      console.log('[Sync] Playback started successfully');

      // Technique 1 — Soft-Start Ramp:
      // Ramp volume from 0 → 1 over ~100ms to mask tiny inter-device start differences.
      if (_PsychoacousticMaskingSync) {
        _PsychoacousticMaskingSync.softStartRamp(this.audioElement);
      }
      
      // Start feedback loop
      this.startPlaybackFeedbackLoop();
      
      // Sync video if available
      if (this.videoElement) {
        this.syncVideo();
      }
    }).catch(err => {
      console.error('[Sync] Playback failed:', err);
    });
  }

  /**
   * Start playback feedback loop
   */
  startPlaybackFeedbackLoop() {
    // Clear existing timer
    this.stopPlaybackFeedbackLoop();

    // Send feedback every 100ms
    this.feedbackTimer = setInterval(() => {
      this.sendPlaybackFeedback();
    }, this.feedbackInterval);
  }

  /**
   * Stop playback feedback loop
   */
  stopPlaybackFeedbackLoop() {
    if (this.feedbackTimer) {
      clearInterval(this.feedbackTimer);
      this.feedbackTimer = null;
    }
  }

  /**
   * Send playback position feedback to server
   */
  sendPlaybackFeedback() {
    if (!this.audioElement || !this.scheduledPlayback || !this.ws) {
      return;
    }

    const position = this.audioElement.currentTime;
    const trackStart = this.scheduledPlayback.playAtServer;

    const feedbackMessage = {
      t: 'PLAYBACK_FEEDBACK',
      position: position,
      trackStart: trackStart,
      playbackRate: this.playbackRate,
      // Use monotonic clock for feedback timestamp
      timestamp: _clientClock()
    };

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(feedbackMessage));
    }

    // Callback for local feedback handling
    if (this.onFeedback) {
      this.onFeedback(position, trackStart);
    }
  }

  /**
   * Handle drift correction from server.
   * Supports both legacy (adjustment) and new (mode/rateDelta/seekToSec) fields.
   * @param {object} correction - Drift correction data
   */
  handleDriftCorrection(correction) {
    const drift = correction.drift || 0;
    const mode = correction.mode || 'rate'; // backward compat: default to rate

    // Phase 5: Hard seek resync (mode='seek')
    if (mode === 'seek' && correction.seekToSec != null && this.audioElement) {
      const seekTarget = correction.seekToSec;
      console.log(`[Sync] Hard seek resync - drift: ${drift.toFixed(2)}ms, seekTo: ${seekTarget.toFixed(3)}s`);
      // Clamp seek target to valid range
      const duration = this.audioElement.duration || Infinity;
      const clamped = Math.max(0, Math.min(seekTarget, duration > 0.25 ? duration - 0.25 : 0));

      // Technique 2 — Micro-Fade During Seek Correction:
      // Fade volume briefly around the seek to prevent audible pop artifacts.
      const _applySeekAndReset = () => {
        this.playbackRate = 1.0;
        this.audioElement.playbackRate = 1.0;
        if (this.videoElement) this.videoElement.playbackRate = 1.0;
        if (this.onDriftCorrection) this.onDriftCorrection(drift, 1.0);
      };

      if (_PsychoacousticMaskingSync) {
        _PsychoacousticMaskingSync.seekWithMicroFade(this.audioElement, clamped, {
          onComplete: _applySeekAndReset,
        });
      } else {
        this.audioElement.currentTime = clamped;
        _applySeekAndReset();
      }
      return;
    }

    // Rate correction: prefer new rateDelta, fall back to legacy adjustment
    const rateDelta = (correction.rateDelta !== undefined) ? correction.rateDelta : (correction.adjustment || 0);
    const newRate = 1.0 + rateDelta;

    console.log(`[Sync] Drift correction - Drift: ${drift.toFixed(2)}ms, rateDelta: ${rateDelta.toFixed(4)}`);

    // Clamp to safe range
    this.playbackRate = Math.max(PLAYBACK_RATE_MIN, Math.min(PLAYBACK_RATE_MAX, newRate));

    if (this.audioElement) {
      this.audioElement.playbackRate = this.playbackRate;
    }
    if (this.videoElement) {
      this.videoElement.playbackRate = this.playbackRate;
    }

    if (this.onDriftCorrection) {
      this.onDriftCorrection(drift, this.playbackRate);
    }
  }

  /**
   * Sync video element with audio
   */
  syncVideo() {
    if (!this.videoElement || !this.audioElement) {
      return;
    }

    // Sync video position with audio
    this.videoElement.currentTime = this.audioElement.currentTime;
    this.videoElement.playbackRate = this.audioElement.playbackRate;

    // Play video
    this.videoElement.play().catch(err => {
      console.error('[Sync] Video playback failed:', err);
    });

    console.log('[Sync] Video synchronized with audio');
  }

  /**
   * Handle mid-track seek/resume
   * @param {number} positionSec - Position to seek to
   */
  seekTo(positionSec) {
    if (!this.audioElement) return;

    const serverNow = this.getServerTime();
    
    // Update scheduled playback info
    if (this.scheduledPlayback) {
      this.scheduledPlayback.playAtServer = serverNow;
      this.scheduledPlayback.startPositionSec = positionSec;
    }

    // Seek audio
    this.audioElement.currentTime = positionSec;

    // Seek video if available
    if (this.videoElement) {
      this.videoElement.currentTime = positionSec;
    }

    console.log(`[Sync] Seeked to ${positionSec}s`);
  }

  /**
   * Pause playback
   */
  pause() {
    if (this.audioElement) {
      this.audioElement.pause();
    }
    if (this.videoElement) {
      this.videoElement.pause();
    }
    this.stopPlaybackFeedbackLoop();
    console.log('[Sync] Playback paused');
  }

  /**
   * Resume playback
   */
  resume() {
    if (this.audioElement) {
      this.audioElement.play();
    }
    if (this.videoElement) {
      this.videoElement.play();
    }
    this.startPlaybackFeedbackLoop();
    console.log('[Sync] Playback resumed');
  }

  /**
   * Stop playback
   */
  stop() {
    this.pause();
    if (this.audioElement) {
      this.audioElement.currentTime = 0;
    }
    if (this.videoElement) {
      this.videoElement.currentTime = 0;
    }
    this.scheduledPlayback = null;
    console.log('[Sync] Playback stopped');
  }

  /**
   * Get sync quality indicator
   * @returns {object} Sync quality info
   */
  getSyncQuality() {
    let quality = 'Unknown';
    let color = 'gray';

    if (this.latency < 50) {
      quality = 'Excellent';
      color = 'green';
    } else if (this.latency < 100) {
      quality = 'Good';
      color = 'lightgreen';
    } else if (this.latency < 200) {
      quality = 'Medium';
      color = 'yellow';
    } else {
      quality = 'Poor';
      color = 'red';
    }

    return {
      quality: quality,
      color: color,
      latency: this.latency,
      clockOffset: this.clockOffset,
      playbackRate: this.playbackRate,
      bufferHealth: this.rollingBufferSec * 1000 // in ms
    };
  }

  /**
   * Handle WebSocket close event and attempt reconnection
   * Uses exponential backoff for reconnection attempts
   */
  handleWebSocketClose() {
    if (this.reconnectTimer) {
      return; // Reconnection already in progress
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Sync] Max reconnection attempts reached');
      return;
    }

    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    console.log(`[Sync] WebSocket closed. Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.reconnectTimer = null;
      
      // Call reconnect callback if provided
      if (this.onReconnect) {
        this.onReconnect();
      }
    }, delay);
  }

  /**
   * Reset reconnection state after successful connection
   */
  resetReconnectionState() {
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    console.log('[Sync] Reconnection state reset');
  }

  /**
   * Update WebSocket reference (for reconnection)
   * @param {WebSocket} ws - New WebSocket connection
   */
  updateWebSocket(ws) {
    this.ws = ws;
    this.resetReconnectionState();
  }

  /**
   * Cleanup and destroy engine
   */
  destroy() {
    this.stopClockSyncLoop();
    this.stopPlaybackFeedbackLoop();
    this.stop();
    
    // Clear reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    console.log('[Sync] Client sync engine destroyed');
  }
}

// ============================================================
// Export for browser usage
// ============================================================

if (typeof window !== 'undefined') {
  window.ClientSyncEngine = ClientSyncEngine;
}

// Export for Node.js usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ClientSyncEngine };
}
