/**
 * Client-Side Payment Handler
 * Manages purchase flow for upgrades (Party Pass, Pro Monthly)
 */

// Payment methods
const PAYMENT_METHOD = {
  APPLE_PAY: 'apple_pay',
  GOOGLE_PAY: 'google_pay',
  CARD: 'card'
};

// Platform detection (using feature detection instead of user-agent sniffing)
function detectPlatform() {
  // Check for iOS-specific features
  if (window.ApplePaySession && typeof window.ApplePaySession.canMakePayments === 'function') {
    return 'ios';
  }
  
  // Check for Android-specific features (Google Pay API)
  if (window.PaymentRequest && /android/i.test(navigator.userAgent)) {
    return 'android';
  }
  
  // Fallback to user-agent for broader compatibility
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  if (/iPad|iPhone|iPod/.test(userAgent) && !window.MSStream) {
    return 'ios';
  } else if (/android/i.test(userAgent)) {
    return 'android';
  }
  
  return 'web';
}

/**
 * Purchase an upgrade (Party Pass or Pro Monthly)
 * @param {string} productId - 'party_pass' or 'pro_monthly'
 * @param {string} paymentMethod - Payment method to use
 * @returns {Promise<Object>} Purchase result
 */
async function purchaseUpgrade(productId, paymentMethod = PAYMENT_METHOD.CARD) {
  try {
    const platform = detectPlatform();
    
    console.log(`[Payment] Starting purchase: ${productId} via ${paymentMethod} on ${platform}`);
    
    // Step 1: Initiate payment intent
    const initiateResponse = await fetch(API_BASE + '/api/payment/initiate', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        productId,
        platform,
        paymentMethod
      })
    });
    
    if (!initiateResponse.ok) {
      const error = await initiateResponse.json();
      throw new Error(error.error || 'Failed to initiate payment');
    }
    
    const { paymentIntent } = await initiateResponse.json();
    console.log(`[Payment] Payment intent created: ${paymentIntent.intentId}`);
    
    // Step 2: Show payment UI and collect payment
    let paymentToken;
    try {
      paymentToken = await showPaymentUI(paymentMethod, platform, paymentIntent);
    } catch (err) {
      console.log('[Payment] Payment UI cancelled or failed:', err.message);
      return {
        success: false,
        cancelled: true,
        error: 'Payment cancelled'
      };
    }
    
    // Step 3: Confirm payment with server
    const confirmResponse = await fetch(API_BASE + '/api/payment/confirm', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intentId: paymentIntent.intentId,
        paymentToken,
        productId,
        platform,
        paymentMethod
      })
    });
    
    if (!confirmResponse.ok) {
      const error = await confirmResponse.json();
      throw new Error(error.error || 'Payment confirmation failed');
    }
    
    const result = await confirmResponse.json();
    console.log(`[Payment] Purchase successful: ${result.transactionId}`);
    
    return {
      success: true,
      transactionId: result.transactionId,
      upgrades: result.upgrades,
      entitlements: result.entitlements
    };
  } catch (error) {
    console.error('[Payment] Purchase error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Show platform-appropriate payment UI
 * @returns {Promise<string>} Payment token
 */
async function showPaymentUI(paymentMethod, platform, paymentIntent) {
  if (platform === 'ios' && paymentMethod === PAYMENT_METHOD.APPLE_PAY) {
    return showApplePayUI(paymentIntent);
  } else if (platform === 'android' && paymentMethod === PAYMENT_METHOD.GOOGLE_PAY) {
    return showGooglePayUI(paymentIntent);
  } else {
    return showCardPaymentUI(paymentIntent);
  }
}

/**
 * Show Apple Pay UI (iOS)
 * Apple Pay integration is not yet implemented.
 */
async function showApplePayUI(paymentIntent) {
  console.log('[Payment] Apple Pay not yet implemented');
  throw new Error('Apple Pay is not yet available. Please use another payment method.');
}

/**
 * Show Google Pay UI (Android)
 * Google Pay integration is not yet implemented.
 */
async function showGooglePayUI(paymentIntent) {
  console.log('[Payment] Google Pay not yet implemented');
  throw new Error('Google Pay is not yet available. Please use another payment method.');
}

/**
 * Show card payment UI (Web)
 * Direct card payment is not yet implemented — purchases are handled via Stripe Checkout.
 */
async function showCardPaymentUI(paymentIntent) {
  console.log('[Payment] Direct card payment not yet implemented');
  throw new Error('Direct card payment is not yet available. Please use the Checkout button to upgrade.');
}

/**
 * Fetch current user entitlements
 * @returns {Promise<Object>} User entitlements
 */
async function fetchUserEntitlements() {
  try {
    const response = await fetch(API_BASE + '/api/user/entitlements', {
      credentials: 'include'
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch entitlements');
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[Payment] Fetch entitlements error:', error);
    return null;
  }
}

/**
 * Check if Party Pass is active for current user
 */
function isPartyPassActive(upgrades) {
  if (!upgrades || !upgrades.partyPass) return false;
  
  const expiresAt = upgrades.partyPass.expiresAt;
  if (!expiresAt) return false;
  
  return new Date(expiresAt) > new Date();
}

/**
 * Check if Pro Monthly is active for current user
 */
function isProMonthlyActive(upgrades) {
  if (!upgrades || !upgrades.proMonthly) return false;
  return upgrades.proMonthly.active === true;
}

/**
 * Apply entitlements to app state
 */
function applyEntitlementsToState(entitlements, upgrades) {
  if (!window.state) return;
  
  const { hasPartyPass, hasPro } = entitlements;
  
  // Update state based on entitlements
  if (hasPro) {
    state.userTier = USER_TIER.PRO;
    state.partyPro = true;
    state.isPro = true;
    state.partyPassActive = true; // Pro includes Party Pass
  } else if (hasPartyPass) {
    state.userTier = USER_TIER.PARTY_PASS;
    state.partyPassActive = true;
    state.partyPro = false;
    state.isPro = false;
    
    // Set Party Pass expiry time
    if (upgrades && upgrades.partyPass && upgrades.partyPass.expiresAt) {
      state.partyPassEndTime = new Date(upgrades.partyPass.expiresAt).getTime();
    }
  } else {
    state.userTier = USER_TIER.FREE;
    state.partyPassActive = false;
    state.partyPro = false;
    state.isPro = false;
    state.partyPassEndTime = null;
  }
  
  console.log(`[Payment] Applied entitlements to state: tier=${state.userTier}, hasPartyPass=${hasPartyPass}, hasPro=${hasPro}`);
}

/**
 * Restore user entitlements on app load
 */
async function restoreUserEntitlements() {
  try {
    console.log('[Payment] Restoring user entitlements...');
    
    const data = await fetchUserEntitlements();
    if (!data) {
      console.log('[Payment] No entitlements to restore (user not logged in or error)');
      return false;
    }
    
    const { entitlements, upgrades } = data;
    
    // Apply to state
    applyEntitlementsToState(entitlements, upgrades);
    
    // Update UI
    if (window.updatePartyPassUI) {
      updatePartyPassUI();
    }
    if (window.setPlanPill) {
      setPlanPill();
    }
    if (window.updatePlaybackUI) {
      updatePlaybackUI();
    }
    
    console.log('[Payment] Entitlements restored successfully');
    return true;
  } catch (error) {
    console.error('[Payment] Restore entitlements error:', error);
    return false;
  }
}
