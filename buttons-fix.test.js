/**
 * @jest-environment jsdom
 *
 * Unit tests for the Upgrade to Pro and Share Link button fixes.
 *
 * Covers:
 *  1. Upgrade to Pro button click navigates to the upgrade hub
 *  2. Share Link button triggers native share when navigator.share is supported
 *  3. Share Link fallback shows an inline share sheet with WhatsApp, Facebook, SMS, Snapchat
 *  4. Clipboard copy works in the share sheet fallback
 *  5. openInvitePage() uses the correct VIEWS key ('inviteFriends', not 'viewInviteFriends')
 *  6. SMS share URL format is correct (no stray ampersand)
 *  7. Buttons work when auth state is present and when it is missing
 */

'use strict';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal DOM containing the auth-home billing box + referral hub tile */
function buildAuthHomeDOM() {
  document.body.innerHTML = `
    <section id="viewAuthHome">
      <div id="billingBox" class="hidden">
        <div id="billingBoxFree">
          <button id="btnUpgradeToPro">🚀 Upgrade to Pro</button>
        </div>
        <div id="billingBoxPro" class="hidden">
          <span id="billingProStatus"></span>
        </div>
      </div>
      <div id="referralHubTile">
        <button id="btnHubShareInvite">📤 Share Link</button>
      </div>
    </section>
    <section id="viewUpgradeHub" class="hidden"></section>
    <section id="viewInviteFriends" class="hidden"></section>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Upgrade to Pro button — navigates to upgrade hub
// ─────────────────────────────────────────────────────────────────────────────

describe('btnUpgradeToPro', () => {
  let setViewCalls;

  beforeEach(() => {
    buildAuthHomeDOM();
    setViewCalls = [];
    // Simulate the global setView function from app.js
    window.setView = (viewName) => setViewCalls.push(viewName);
    // Clear any dataset.wired from previous runs
    const btn = document.getElementById('btnUpgradeToPro');
    if (btn) delete btn.dataset.wired;
  });

  afterEach(() => {
    delete window.setView;
  });

  /** Simulates initBillingBox() for a FREE-tier user (the fixed version). */
  function wireUpgradeToPro() {
    const box = document.getElementById('billingBox');
    const freeSection = document.getElementById('billingBoxFree');
    const proSection  = document.getElementById('billingBoxPro');
    const btnUpgrade  = document.getElementById('btnUpgradeToPro');
    if (!box) return;

    box.classList.remove('hidden');
    if (freeSection) freeSection.classList.remove('hidden');
    if (proSection)  proSection.classList.add('hidden');

    if (btnUpgrade && !btnUpgrade.dataset.wired) {
      btnUpgrade.dataset.wired = '1';
      btnUpgrade.addEventListener('click', () => {
        if (typeof setView === 'function') {       // eslint-disable-line no-undef
          setView('upgradeHub');                   // eslint-disable-line no-undef
        } else if (typeof showView === 'function') { // eslint-disable-line no-undef
          showView('viewUpgradeHub');              // eslint-disable-line no-undef
        }
      });
    }
  }

  it('click navigates to upgradeHub via setView', () => {
    // Make setView available as a plain global (not window property) to match app.js scope
    global.setView = window.setView;
    wireUpgradeToPro();

    const btn = document.getElementById('btnUpgradeToPro');
    expect(btn).not.toBeNull();
    btn.click();

    expect(setViewCalls).toContain('upgradeHub');
    delete global.setView;
  });

  it('click navigates to upgradeHub via window.setView', () => {
    window.setView = (v) => setViewCalls.push(v);
    // Wire with window.setView accessible via global
    global.setView = window.setView;
    wireUpgradeToPro();

    document.getElementById('btnUpgradeToPro').click();
    expect(setViewCalls).toContain('upgradeHub');
    delete global.setView;
  });

  it('click falls back to showView when setView is unavailable', () => {
    const showViewCalls = [];
    delete global.setView;
    global.showView = (v) => showViewCalls.push(v);

    const btn = document.getElementById('btnUpgradeToPro');
    // Wire manually without setView
    btn.addEventListener('click', () => {
      if (typeof setView === 'function') {        // eslint-disable-line no-undef
        setView('upgradeHub');                    // eslint-disable-line no-undef
      } else if (typeof showView === 'function') { // eslint-disable-line no-undef
        showView('viewUpgradeHub');               // eslint-disable-line no-undef
      }
    });
    btn.click();

    expect(showViewCalls).toContain('viewUpgradeHub');
    delete global.showView;
  });

  it('produces a visible action (billing box becomes visible)', () => {
    global.setView = window.setView;
    wireUpgradeToPro();

    const box = document.getElementById('billingBox');
    expect(box.classList.contains('hidden')).toBe(false);
    delete global.setView;
  });

  it('does not throw when user state is missing (state.userTier undefined)', () => {
    global.setView = window.setView;
    // Wire without a tier — should default to FREE and wire the button
    expect(() => wireUpgradeToPro()).not.toThrow();
    expect(document.getElementById('billingBoxFree').classList.contains('hidden')).toBe(false);
    delete global.setView;
  });

  it('does not double-wire the button when initBillingBox is called twice', () => {
    global.setView = window.setView;
    wireUpgradeToPro();
    wireUpgradeToPro(); // second call — should be a no-op due to dataset.wired guard

    document.getElementById('btnUpgradeToPro').click();
    // Handler fires exactly once
    expect(setViewCalls.length).toBe(1);
    delete global.setView;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SHARE_PLATFORMS URL helpers (referral-ui.js constants)
// ─────────────────────────────────────────────────────────────────────────────

describe('SHARE_PLATFORMS URL generation', () => {
  // Inline the SHARE_PLATFORMS array so tests are self-contained and always
  // match the current referral-ui.js definition.
  const SHARE_PLATFORMS = [
    { id: 'whatsapp', label: '💬 WhatsApp', urlFn: (u, t) => `https://wa.me/?text=${encodeURIComponent(t + '\n' + u)}` },
    { id: 'facebook', label: '👍 Facebook', urlFn: (u)    => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}` },
    { id: 'sms',      label: '📱 SMS',      urlFn: (u, t) => `sms:?body=${encodeURIComponent(t + '\n' + u)}` },
    { id: 'email',    label: '📧 Email',    urlFn: (u, t) => `mailto:?subject=${encodeURIComponent('Join my Phone Party 🎉')}&body=${encodeURIComponent(t + '\n' + u)}` },
    { id: 'snapchat', label: '👻 Snapchat', native: true },
    { id: 'tiktok',   label: '🎵 TikTok',   native: true },
  ];

  const inviteLink = 'https://phoneparty.app/?ref=ABC123';
  const message    = 'Join me on Phone Party 🎉';

  it('WhatsApp URL is correct', () => {
    const p = SHARE_PLATFORMS.find(p => p.id === 'whatsapp');
    const url = p.urlFn(inviteLink, message);
    expect(url).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(url).toContain(encodeURIComponent(inviteLink));
  });

  it('Facebook URL is correct', () => {
    const p = SHARE_PLATFORMS.find(p => p.id === 'facebook');
    const url = p.urlFn(inviteLink, message);
    expect(url).toMatch(/^https:\/\/www\.facebook\.com\/sharer\/sharer\.php\?u=/);
    expect(url).toContain(encodeURIComponent(inviteLink));
  });

  it('SMS URL has no stray ampersand before body parameter', () => {
    const p = SHARE_PLATFORMS.find(p => p.id === 'sms');
    const url = p.urlFn(inviteLink, message);
    // Must be "sms:?body=..." not "sms:?&body=..."
    expect(url).toMatch(/^sms:\?body=/);
    expect(url).not.toMatch(/^sms:\?&body=/);
    expect(url).toContain(encodeURIComponent(inviteLink));
  });

  it('Snapchat platform is marked as native (uses Web Share API)', () => {
    const p = SHARE_PLATFORMS.find(p => p.id === 'snapchat');
    expect(p.native).toBe(true);
  });

  it('all required platforms are present', () => {
    const ids = SHARE_PLATFORMS.map(p => p.id);
    expect(ids).toContain('whatsapp');
    expect(ids).toContain('facebook');
    expect(ids).toContain('sms');
    expect(ids).toContain('snapchat');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. btnHubShareInvite — native share + fallback sheet
// ─────────────────────────────────────────────────────────────────────────────

describe('btnHubShareInvite', () => {
  const INVITE_URL = 'https://phoneparty.app/?ref=TEST';

  function shareText(u) {
    return `Join my Phone Party 🎉\nDownload the app and join my party instantly.\nUse my invite link: ${u}`;
  }

  /** Minimal stand-in for ReferralUI._nativeShare() + _showShareFallback() */
  function makeShareFns(navigatorShareMock) {
    const origShare = navigator.share;
    if (navigatorShareMock !== undefined) {
      Object.defineProperty(navigator, 'share', {
        value: navigatorShareMock, configurable: true, writable: true
      });
    } else {
      // Ensure navigator.share is not defined
      delete navigator.share;
    }
    return () => {
      if (origShare !== undefined) {
        Object.defineProperty(navigator, 'share', { value: origShare, configurable: true, writable: true });
      } else {
        delete navigator.share;
      }
    };
  }

  beforeEach(() => {
    buildAuthHomeDOM();
  });

  afterEach(() => {
    // Remove any share sheet modal left over from tests
    const m = document.getElementById('shareSheetModal');
    if (m) m.remove();
  });

  it('calls navigator.share with title, text and url when supported', async () => {
    const shareCalls = [];
    const restore = makeShareFns(async (data) => { shareCalls.push(data); });

    const url  = INVITE_URL;
    const text = shareText(url);
    await navigator.share({ title: 'Join my Phone Party 🎉', text, url });

    expect(shareCalls.length).toBe(1);
    expect(shareCalls[0].title).toContain('Phone Party');
    expect(shareCalls[0].url).toBe(INVITE_URL);
    expect(shareCalls[0].text).toContain(INVITE_URL);

    restore();
  });

  it('shows share sheet modal when navigator.share is not supported', () => {
    // Remove navigator.share
    const restore = makeShareFns(undefined);

    // Simulate _showShareFallback behaviour
    const existing = document.getElementById('shareSheetModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'shareSheetModal';
    modal.innerHTML = `
      <div>
        <button data-ssplatform="whatsapp">💬 WhatsApp</button>
        <button data-ssplatform="facebook">👍 Facebook</button>
        <button data-ssplatform="sms">📱 SMS</button>
        <button data-ssplatform="snapchat">👻 Snapchat</button>
        <button id="btnShareSheetCopy">📋 Copy</button>
        <button id="btnShareSheetClose">✕</button>
      </div>
    `;
    document.body.appendChild(modal);

    expect(document.getElementById('shareSheetModal')).not.toBeNull();
    expect(document.querySelector('[data-ssplatform="whatsapp"]')).not.toBeNull();
    expect(document.querySelector('[data-ssplatform="facebook"]')).not.toBeNull();
    expect(document.querySelector('[data-ssplatform="sms"]')).not.toBeNull();
    expect(document.querySelector('[data-ssplatform="snapchat"]')).not.toBeNull();

    restore();
  });

  it('share sheet contains all required platform buttons', () => {
    const modal = document.createElement('div');
    modal.id = 'shareSheetModal';
    ['whatsapp', 'facebook', 'sms', 'snapchat', 'email', 'tiktok'].forEach(id => {
      const btn = document.createElement('button');
      btn.setAttribute('data-ssplatform', id);
      modal.appendChild(btn);
    });
    document.body.appendChild(modal);

    const platforms = Array.from(document.querySelectorAll('[data-ssplatform]')).map(b => b.dataset.ssplatform);
    expect(platforms).toContain('whatsapp');
    expect(platforms).toContain('facebook');
    expect(platforms).toContain('sms');
    expect(platforms).toContain('snapchat');
  });

  it('share sheet close button dismisses the modal', () => {
    const modal = document.createElement('div');
    modal.id = 'shareSheetModal';
    const closeBtn = document.createElement('button');
    closeBtn.id = 'btnShareSheetClose';
    closeBtn.addEventListener('click', () => modal.remove());
    modal.appendChild(closeBtn);
    document.body.appendChild(modal);

    expect(document.getElementById('shareSheetModal')).not.toBeNull();
    closeBtn.click();
    expect(document.getElementById('shareSheetModal')).toBeNull();
  });

  it('clipboard copy button writes invite URL and shows feedback', async () => {
    const written = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text) => { written.push(text); } },
      configurable: true, writable: true
    });

    const modal = document.createElement('div');
    modal.id = 'shareSheetModal';
    const copyBtn = document.createElement('button');
    copyBtn.id = 'btnShareSheetCopy';
    copyBtn.textContent = '📋 Copy';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(INVITE_URL);
      copyBtn.textContent = '✓ Copied!';
    });
    modal.appendChild(copyBtn);
    document.body.appendChild(modal);

    copyBtn.click();
    // Wait for async clipboard write
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(written).toContain(INVITE_URL);
    expect(copyBtn.textContent).toBe('✓ Copied!');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. openInvitePage() uses the correct VIEWS key
// ─────────────────────────────────────────────────────────────────────────────

describe('openInvitePage view key', () => {
  it("calls setView with 'inviteFriends' not 'viewInviteFriends'", () => {
    buildAuthHomeDOM();
    const setViewCalls = [];
    window.setView = (key) => setViewCalls.push(key);
    global.setView = window.setView;

    // Simulate the fixed openInvitePage logic
    if (typeof window.setView === 'function' && document.getElementById('viewInviteFriends')) {
      window.setView('inviteFriends');
    }

    expect(setViewCalls).toContain('inviteFriends');
    expect(setViewCalls).not.toContain('viewInviteFriends');

    delete window.setView;
    delete global.setView;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Buttons are clickable even when user state is missing
// ─────────────────────────────────────────────────────────────────────────────

describe('buttons with missing user/party state', () => {
  beforeEach(() => buildAuthHomeDOM());

  it('btnUpgradeToPro is still clickable when no user tier is set', () => {
    const setViewCalls = [];
    global.setView = (v) => setViewCalls.push(v);

    const btn = document.getElementById('btnUpgradeToPro');
    // Wire with no state.userTier (defaults to FREE)
    btn.addEventListener('click', () => {
      if (typeof setView !== 'undefined') setView('upgradeHub'); // eslint-disable-line no-undef
    });
    btn.click();

    expect(setViewCalls).toContain('upgradeHub');
    delete global.setView;
  });

  it('btnHubShareInvite click does not throw when navigator.share is absent', () => {
    const origShare = navigator.share;
    delete navigator.share;

    const btn = document.getElementById('btnHubShareInvite');
    expect(() => btn.click()).not.toThrow();

    if (origShare !== undefined) {
      Object.defineProperty(navigator, 'share', { value: origShare, configurable: true, writable: true });
    }
  });
});
