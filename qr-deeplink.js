/**
 * QR Code and Deep Link Features
 * Generate QR codes and shareable links for easy party joining
 */

const QR_CODE = {
  apiUrl: 'https://api.qrserver.com/v1/create-qr-code/'
};

/**
 * Generate QR code for party
 */
function generatePartyQRCode(partyCode) {
  const joinUrl = getPartyJoinUrl(partyCode);
  
  // Use QR code API service
  const qrUrl = `${QR_CODE.apiUrl}?size=300x300&data=${encodeURIComponent(joinUrl)}`;
  
  return qrUrl;
}

/**
 * Get party join URL
 */
function getPartyJoinUrl(partyCode) {
  const baseUrl = window.location.origin;
  return `${baseUrl}?join=${partyCode}`;
}

/**
 * Display QR code in UI
 */
function displayQRCode(partyCode, containerId = 'qrCodeContainer') {
  const container = document.getElementById(containerId);
  if (!container) {
    console.warn('[QRCode] Container not found:', containerId);
    return;
  }
  
  const qrUrl = generatePartyQRCode(partyCode);
  
  container.innerHTML = `
    <div style="text-align: center; padding: 20px;">
      <h3>Scan to Join Party</h3>
      <img src="${qrUrl}" alt="QR Code for party ${partyCode}" style="max-width: 300px; border-radius: 12px; background: white; padding: 10px;" />
      <p style="margin-top: 16px; font-size: 14px; color: rgba(255, 255, 255, 0.7);">
        Or share this link:<br/>
        <input type="text" value="${getPartyJoinUrl(partyCode)}" readonly 
               style="width: 100%; margin-top: 8px; padding: 8px; border-radius: 4px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2); color: white; text-align: center;"
               onclick="this.select()" />
      </p>
      <button class="btn primary" onclick="copyPartyLink('${partyCode}')" style="margin-top: 12px;">
        📋 Copy Link
      </button>
    </div>
  `;
}

/**
 * Copy party link to clipboard
 */
function copyPartyLink(partyCode) {
  const url = getPartyJoinUrl(partyCode);
  
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => {
        showToast('✅ Link copied to clipboard!');
      })
      .catch(err => {
        console.error('[QRCode] Failed to copy:', err);
        fallbackCopyToClipboard(url);
      });
  } else {
    fallbackCopyToClipboard(url);
  }
}

/**
 * Fallback copy method for older browsers
 */
function fallbackCopyToClipboard(text) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  
  try {
    document.execCommand('copy');
    showToast('✅ Link copied!');
  } catch (err) {
    showToast('❌ Failed to copy. Please copy manually.');
  }
  
  document.body.removeChild(textArea);
}

/**
 * Check for party join link in URL on page load
 */
function checkForJoinLink() {
  const urlParams = new URLSearchParams(window.location.search);
  const joinCode = urlParams.get('join');
  
  if (joinCode) {
    console.log('[QRCode] Join link detected:', joinCode);
    
    // Auto-populate join code field — target whichever input exists in the active layout.
    // index.html uses 'partyJoinCode' (authenticated view) and 'joinCode' (logged-out view).
    const joinCodeInput = document.getElementById('partyJoinCode') || document.getElementById('joinCode');
    if (joinCodeInput) {
      joinCodeInput.value = joinCode.toUpperCase();
    }
    
    // Show join view
    if (typeof showView === 'function') {
      setTimeout(() => {
        showView('viewHome');
        // Could auto-trigger join if desired
      }, 500);
    }
    
    return joinCode;
  }
  
  return null;
}

/**
 * Share party via Web Share API (mobile)
 */
function shareParty(partyCode) {
  const url = getPartyJoinUrl(partyCode);
  const title = 'Join my Phone Party!';
  const text = `Join party ${partyCode} on Phone Party`;
  
  if (navigator.share) {
    navigator.share({
      title: title,
      text: text,
      url: url
    })
    .then(() => {
      console.log('[QRCode] Share successful');
    })
    .catch(err => {
      console.log('[QRCode] Share failed:', err);
      // Fall back to copy link
      copyPartyLink(partyCode);
    });
  } else {
    // Web Share API not supported, copy link instead
    copyPartyLink(partyCode);
  }
}

// Auto-check for join link on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkForJoinLink);
} else {
  checkForJoinLink();
}

// Export functions if in module environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    generatePartyQRCode,
    getPartyJoinUrl,
    displayQRCode,
    copyPartyLink,
    shareParty,
    checkForJoinLink
  };
}
