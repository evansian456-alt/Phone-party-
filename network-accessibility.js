/**
 * Network Stability and Accessibility Features
 * Connection monitoring, auto-reconnect, low bandwidth mode, accessibility options
 */

const NETWORK = {
  connectionQuality: 'good', // good, fair, poor, offline
  lastPingTime: 0,
  pingInterval: null,
  reconnectAttempts: 0,
  maxReconnectAttempts: 5,
  reconnectDelay: 1000,
  isReconnecting: false,
  lowBandwidthMode: false,
  offlineGracePeriodMs: 5000
};

const ACCESSIBILITY = {
  darkMode: true,
  reducedAnimations: false,
  largeText: false,
  highContrast: false
};

/**
 * Initialize network monitoring
 */
function initNetworkMonitoring() {
  console.log('[Network] Initializing network stability features');
  
  // Monitor online/offline events
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  
  // Pause ping when tab is hidden; resume when visible again.
  // This avoids needless network traffic while the user is in another tab.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (NETWORK.pingInterval) {
        clearInterval(NETWORK.pingInterval);
        NETWORK.pingInterval = null;
      }
    } else {
      // Tab became visible — restart ping if not already running
      if (!NETWORK.pingInterval) {
        startPingMonitoring();
      }
    }
  });
  
  // Start ping monitoring
  startPingMonitoring();
  
  // Check initial connection
  updateConnectionStatus();
}

/**
 * Start ping monitoring
 */
function startPingMonitoring() {
  if (NETWORK.pingInterval) {
    clearInterval(NETWORK.pingInterval);
  }
  
  NETWORK.pingInterval = setInterval(async () => {
    try {
      const startTime = Date.now();
      const response = await fetch(API_BASE + '/api/ping', {
        method: 'GET',
        cache: 'no-cache'
      });
      
      const pingTime = Date.now() - startTime;
      NETWORK.lastPingTime = pingTime;
      
      if (response.ok) {
        // Determine connection quality based on ping time
        if (pingTime < 100) {
          NETWORK.connectionQuality = 'good';
        } else if (pingTime < 300) {
          NETWORK.connectionQuality = 'fair';
        } else {
          NETWORK.connectionQuality = 'poor';
        }
        
        updateConnectionIndicator();
      }
    } catch (error) {
      NETWORK.connectionQuality = 'offline';
      updateConnectionIndicator();
      handleConnectionLost();
    }
  }, 5000); // Ping every 5 seconds (reduced from 3s to save background network traffic)
}

/**
 * Handle online event
 */
function handleOnline() {
  console.log('[Network] Connection restored');
  NETWORK.connectionQuality = 'good';
  updateConnectionIndicator();
  
  // Attempt to reconnect if needed
  if (NETWORK.isReconnecting) {
    attemptReconnect();
  }
}

/**
 * Handle offline event
 */
function handleOffline() {
  console.log('[Network] Connection lost');
  NETWORK.connectionQuality = 'offline';
  updateConnectionIndicator();
  handleConnectionLost();
}

/**
 * Handle connection lost
 */
function handleConnectionLost() {
  if (NETWORK.isReconnecting) return;
  
  console.log('[Network] Starting offline grace period');
  
  // Wait for grace period before showing reconnect prompt
  setTimeout(() => {
    if (NETWORK.connectionQuality === 'offline' && !NETWORK.isReconnecting) {
      promptReconnect();
    }
  }, NETWORK.offlineGracePeriodMs);
}

/**
 * Prompt user to reconnect
 */
function promptReconnect() {
  NETWORK.isReconnecting = true;
  
  // Show reconnecting message
  showConnectionBanner('Reconnecting...', 'warning');
  
  // Start reconnection attempts
  attemptReconnect();
}

/**
 * Attempt to reconnect
 */
async function attemptReconnect() {
  if (NETWORK.reconnectAttempts >= NETWORK.maxReconnectAttempts) {
    console.error('[Network] Max reconnect attempts reached');
    showConnectionBanner('Connection lost. Please refresh the page.', 'error');
    NETWORK.isReconnecting = false;
    return;
  }
  
  NETWORK.reconnectAttempts++;
  console.log(`[Network] Reconnect attempt ${NETWORK.reconnectAttempts}/${NETWORK.maxReconnectAttempts}`);
  
  try {
    const response = await fetch(API_BASE + '/api/ping');
    if (response.ok) {
      console.log('[Network] Reconnection successful');
      NETWORK.connectionQuality = 'good';
      NETWORK.reconnectAttempts = 0;
      NETWORK.isReconnecting = false;
      hideConnectionBanner();
      updateConnectionIndicator();
      return;
    }
  } catch (error) {
    // Failed, try again
  }
  
  // Exponential backoff
  const delay = NETWORK.reconnectDelay * Math.pow(2, NETWORK.reconnectAttempts - 1);
  setTimeout(attemptReconnect, Math.min(delay, 10000));
}

/**
 * Update connection status indicator
 */
function updateConnectionStatus() {
  updateConnectionIndicator();
}

/**
 * Update connection indicator in UI
 */
function updateConnectionIndicator() {
  const indicator = document.getElementById('connectionIndicator');
  if (!indicator) return;
  
  const indicators = {
    good: { text: '● Connected', color: '#69db7c' },
    fair: { text: '● Fair', color: '#ffd43b' },
    poor: { text: '● Poor', color: '#ff8787' },
    offline: { text: '● Offline', color: '#ff6b6b' }
  };
  
  const status = indicators[NETWORK.connectionQuality] || indicators.offline;
  indicator.textContent = status.text;
  indicator.style.color = status.color;
}

/**
 * Show connection banner
 */
function showConnectionBanner(message, type = 'info') {
  let banner = document.getElementById('connectionBanner');
  
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'connectionBanner';
    banner.style.cssText = `
      position: fixed;
      top: 60px;
      left: 0;
      right: 0;
      padding: 12px;
      text-align: center;
      z-index: 9999;
      font-size: 14px;
      animation: slideDown 0.3s ease;
    `;
    document.body.appendChild(banner);
  }
  
  const colors = {
    info: '#5AA9FF',
    warning: '#ffd43b',
    error: '#ff6b6b'
  };
  
  banner.style.backgroundColor = colors[type] || colors.info;
  banner.style.color = type === 'warning' ? '#000' : '#fff';
  banner.textContent = message;
  banner.style.display = 'block';
}

/**
 * Hide connection banner
 */
function hideConnectionBanner() {
  const banner = document.getElementById('connectionBanner');
  if (banner) {
    banner.style.display = 'none';
  }
}

/**
 * Enable low bandwidth mode
 */
function enableLowBandwidthMode() {
  NETWORK.lowBandwidthMode = true;
  console.log('[Network] Low bandwidth mode enabled');
  
  // Reduce polling frequency
  if (state.partyStatusPollingInterval) {
    clearInterval(state.partyStatusPollingInterval);
    // Poll less frequently in low bandwidth mode (6 seconds instead of 3)
    state.partyStatusPollingInterval = setInterval(pollPartyStatus, 6000);
  }
  
  // Disable animations if enabled
  if (!ACCESSIBILITY.reducedAnimations) {
    enableReducedAnimations();
  }
  
  showToast('📶 Low bandwidth mode enabled');
}

/**
 * Disable low bandwidth mode
 */
function disableLowBandwidthMode() {
  NETWORK.lowBandwidthMode = false;
  console.log('[Network] Low bandwidth mode disabled');
  
  showToast('📶 Normal mode restored');
}

// ============================================
// ACCESSIBILITY FEATURES
// ============================================

/**
 * Initialize accessibility features
 */
function initAccessibility() {
  console.log('[Accessibility] Initializing accessibility features');
  
  // Load saved preferences
  loadAccessibilityPreferences();
  
  // Apply saved preferences
  applyAccessibilitySettings();
  
  // Set up accessibility controls
  setupAccessibilityControls();
}

/**
 * Load accessibility preferences from localStorage
 */
function loadAccessibilityPreferences() {
  try {
    const prefs = localStorage.getItem('accessibilityPreferences');
    if (prefs) {
      const parsed = JSON.parse(prefs);
      Object.assign(ACCESSIBILITY, parsed);
    }
  } catch (e) {
    console.error('[Accessibility] Error loading preferences:', e);
  }
}

/**
 * Save accessibility preferences
 */
function saveAccessibilityPreferences() {
  try {
    localStorage.setItem('accessibilityPreferences', JSON.stringify(ACCESSIBILITY));
  } catch (e) {
    console.error('[Accessibility] Error saving preferences:', e);
  }
}

/**
 * Apply accessibility settings
 */
function applyAccessibilitySettings() {
  document.body.classList.toggle('reduced-animations', ACCESSIBILITY.reducedAnimations);
  document.body.classList.toggle('large-text', ACCESSIBILITY.largeText);
  document.body.classList.toggle('high-contrast', ACCESSIBILITY.highContrast);
}

/**
 * Setup accessibility controls
 */
function setupAccessibilityControls() {
  // These controls would be added to a settings menu
  // For now, they can be called programmatically
}

/**
 * Toggle dark mode
 */
function toggleDarkMode() {
  ACCESSIBILITY.darkMode = !ACCESSIBILITY.darkMode;
  document.body.classList.toggle('light-mode', !ACCESSIBILITY.darkMode);
  saveAccessibilityPreferences();
  
  console.log(`[Accessibility] Dark mode: ${ACCESSIBILITY.darkMode ? 'ON' : 'OFF'}`);
}

/**
 * Enable reduced animations
 */
function enableReducedAnimations() {
  ACCESSIBILITY.reducedAnimations = true;
  document.body.classList.add('reduced-animations');
  saveAccessibilityPreferences();
  
  console.log('[Accessibility] Reduced animations enabled');
}

/**
 * Disable reduced animations
 */
function disableReducedAnimations() {
  ACCESSIBILITY.reducedAnimations = false;
  document.body.classList.remove('reduced-animations');
  saveAccessibilityPreferences();
  
  console.log('[Accessibility] Reduced animations disabled');
}

/**
 * Toggle large text
 */
function toggleLargeText() {
  ACCESSIBILITY.largeText = !ACCESSIBILITY.largeText;
  document.body.classList.toggle('large-text', ACCESSIBILITY.largeText);
  saveAccessibilityPreferences();
  
  console.log(`[Accessibility] Large text: ${ACCESSIBILITY.largeText ? 'ON' : 'OFF'}`);
}

/**
 * Toggle high contrast
 */
function toggleHighContrast() {
  ACCESSIBILITY.highContrast = !ACCESSIBILITY.highContrast;
  document.body.classList.toggle('high-contrast', ACCESSIBILITY.highContrast);
  saveAccessibilityPreferences();
  
  console.log(`[Accessibility] High contrast: ${ACCESSIBILITY.highContrast ? 'ON' : 'OFF'}`);
}

// Export functions if in module environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initNetworkMonitoring,
    enableLowBandwidthMode,
    disableLowBandwidthMode,
    initAccessibility,
    toggleDarkMode,
    enableReducedAnimations,
    disableReducedAnimations,
    toggleLargeText,
    toggleHighContrast
  };
}
