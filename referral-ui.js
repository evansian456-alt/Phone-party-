/**
 * Referral UI Manager
 *
 * Handles the Invite Friends page/modal:
 * - Displays referral stats and milestone progress
 * - Social share buttons (Web Share API + explicit platform links)
 * - Live polling every 10 s to refresh progress
 * - Celebration popup when a milestone is newly unlocked
 *
 * Analytics events fired (if window.analytics exists):
 *   referral_promo_viewed, referral_promo_clicked,
 *   referral_share_opened, referral_link_copied
 */

const SHARE_PLATFORMS = [
  { id: 'whatsapp',  label: '💬 WhatsApp',  urlFn: (u, t) => `https://wa.me/?text=${encodeURIComponent(t + '\n' + u)}` },
  { id: 'facebook',  label: '👍 Facebook',  urlFn: (u)    => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}` },
  { id: 'sms',       label: '📱 SMS',       urlFn: (u, t) => `sms:?body=${encodeURIComponent(t + '\n' + u)}` },
  { id: 'email',     label: '📧 Email',     urlFn: (u, t) => `mailto:?subject=${encodeURIComponent('Join my Phone Party 🎉')}&body=${encodeURIComponent(t + '\n' + u)}` },
  { id: 'snapchat',  label: '👻 Snapchat',  native: true  },
  { id: 'tiktok',    label: '🎵 TikTok',    native: true  },
];

const MILESTONES = [
  { at: 3,  label: '30 min Party Pass' },
  { at: 5,  label: '1 hr Party Pass'   },
  { at: 10, label: '1 Party Pass session' },
  { at: 20, label: '3 Party Pass sessions' },
  { at: 50, label: '1 month Pro'       },
];

function shareText(inviteUrl) {
  return `Join my Phone Party 🎉\nDownload the app and join my party instantly.\nUse my invite link: ${inviteUrl}`;
}

function buildUrl(platform, inviteUrl) {
  const text = shareText(inviteUrl);
  if (platform.urlFn) return platform.urlFn(inviteUrl, text);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

class ReferralUI {
  constructor() {
    this.stats        = null;
    this._pollTimer   = null;
    this._nudgeTimer  = null;
    this._lastCount   = null;
    this._nudgeShown  = false;
    this._init();
  }

  _init() {
    // Build the Invite Friends view if the container exists
    this._buildInvitePage();
    this._bindStaticButtons();
    this._bindPromoElements();
    this._maybeShowNudge();
    this._trackPromoViewed();
  }

  // ─── Invite Friends page ───────────────────────────────────────────────────

  _buildInvitePage() {
    const container = document.getElementById('viewInviteFriends');
    if (!container) return;

    container.innerHTML = `
      <div class="invite-page-inner" style="max-width:480px;margin:0 auto;padding:1rem;">
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1.5rem;">
          <button class="btn" id="btnInviteBack">← Back</button>
          <h2 style="margin:0;">🎁 Invite Friends</h2>
        </div>

        <!-- Progress bar -->
        <div class="referral-progress-card glass-card" style="margin-bottom:1rem;">
          <div class="progress-header" style="display:flex;justify-content:space-between;margin-bottom:0.5rem;">
            <span id="inviteProgressLabel">Invite friends to earn rewards</span>
            <span id="inviteProgressCount" style="font-weight:700;color:#9D4EDD;">0 / 3</span>
          </div>
          <div class="progress-bar" style="background:rgba(255,255,255,0.1);border-radius:99px;height:12px;overflow:hidden;">
            <div class="progress-fill" id="inviteProgressBar" style="width:0%;background:linear-gradient(90deg,#9D4EDD,#5AA9FF);height:100%;border-radius:99px;transition:width 0.5s ease;"></div>
          </div>
          <div id="inviteNextReward" style="margin-top:0.5rem;font-size:0.85rem;color:#aaa;"></div>
        </div>

        <!-- Milestones list -->
        <div class="glass-card" style="margin-bottom:1rem;" id="inviteMilestones"></div>

        <!-- Rewards balance -->
        <div class="glass-card" id="inviteRewardBalance" style="margin-bottom:1rem;display:none;">
          <h4 style="margin-bottom:0.5rem;">🏆 Your Rewards</h4>
          <div id="inviteRewardBalanceContent"></div>
        </div>

        <!-- Invite link -->
        <div class="glass-card" style="margin-bottom:1rem;">
          <div class="lbl" style="margin-bottom:0.5rem;">Your Invite Link</div>
          <div style="display:flex;gap:0.5rem;">
            <input type="text" id="inviteLinkInput" class="input-field" readonly
                   style="flex:1;font-size:0.85rem;" value="Loading…" />
            <button class="btn primary" id="btnCopyInviteLink" style="white-space:nowrap;">📋 Copy</button>
          </div>
        </div>

        <!-- Share buttons -->
        <div class="glass-card">
          <div class="lbl" style="margin-bottom:0.75rem;">Share via</div>
          <div style="display:flex;flex-wrap:wrap;gap:0.5rem;" id="inviteShareButtons">
            <button class="btn primary" id="btnNativeShare" style="flex:1 0 auto;">📤 Share</button>
            ${SHARE_PLATFORMS.map(p => `
              <button class="btn invite-share-btn" data-platform="${p.id}"
                      style="flex:1 0 auto;">${p.label}</button>
            `).join('')}
          </div>
        </div>

        <!-- How it works -->
        <div class="glass-card" style="margin-top:1rem;font-size:0.85rem;color:#aaa;">
          <h4 style="color:#fff;margin-bottom:0.5rem;">✅ What counts as a valid referral?</h4>
          <ol style="padding-left:1.2rem;line-height:1.8;">
            <li>Friend opens your invite link</li>
            <li>Friend creates an account</li>
            <li>Friend completes their DJ profile</li>
            <li>Friend creates or joins a party</li>
          </ol>
        </div>
      </div>
    `;

    // Back button
    const backBtn = document.getElementById('btnInviteBack');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        if (typeof window.setView === 'function') window.setView('viewAuthHome');
      });
    }

    // Copy link button
    const copyBtn = document.getElementById('btnCopyInviteLink');
    if (copyBtn) copyBtn.addEventListener('click', () => this._copyLink());

    // Native share button
    const nativeBtn = document.getElementById('btnNativeShare');
    if (nativeBtn) nativeBtn.addEventListener('click', () => this._nativeShare());

    // Platform share buttons
    document.querySelectorAll('.invite-share-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const platformId = btn.dataset.platform;
        this._sharePlatform(platformId);
      });
    });

    // Render milestones
    this._renderMilestones();
  }

  _renderMilestones() {
    const el = document.getElementById('inviteMilestones');
    if (!el) return;
    const completed = this.stats?.referralsCompleted || 0;
    el.innerHTML = `
      <h4 style="margin-bottom:0.75rem;">🏅 Milestones</h4>
      ${MILESTONES.map(m => {
        const done = completed >= m.at;
        return `<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem;opacity:${done ? 1 : 0.6};">
          <span style="font-size:1.2rem;">${done ? '✅' : '🔒'}</span>
          <span><strong>${m.at} referrals</strong> → ${m.label}</span>
        </div>`;
      }).join('')}
    `;
  }

  // ─── Stats loading & UI update ─────────────────────────────────────────────

  async loadStats() {
    try {
      const res = await fetch(API_BASE + '/api/referral/me', { credentials: 'include' });
      if (!res.ok) return;
      this.stats = await res.json();
      this._updateUI();

      // Celebrate if a new milestone was just unlocked
      if (this._lastCount !== null && this.stats.referralsCompleted > this._lastCount) {
        this._checkAndCelebrate(this._lastCount, this.stats.referralsCompleted);
      }
      this._lastCount = this.stats.referralsCompleted;
    } catch (_) { /* silent */ }
  }

  _updateUI() {
    if (!this.stats) return;
    const s = this.stats;

    // Progress bar
    const pBar  = document.getElementById('inviteProgressBar');
    const pCnt  = document.getElementById('inviteProgressCount');
    const pNext = document.getElementById('inviteNextReward');
    const pLbl  = document.getElementById('inviteProgressLabel');
    if (pBar) pBar.style.width = `${s.progressPercent || 0}%`;
    if (pCnt) pCnt.textContent = `${s.progressCurrent || 0} / ${s.progressTarget || 3}`;
    if (pNext && s.nextMilestone) {
      const nm = MILESTONES.find(m => m.at === s.nextMilestone);
      if (nm) pNext.textContent = `Next: ${nm.label} at ${nm.at} referrals`;
    }
    if (pLbl) pLbl.textContent = 'Invite friends to earn rewards';

    // Invite link
    const linkInput = document.getElementById('inviteLinkInput');
    if (linkInput && s.inviteUrl) linkInput.value = s.inviteUrl;

    // Hub promo tile
    const hubCount = document.getElementById('referralHubCount');
    const hubNext  = document.getElementById('referralHubNext');
    if (hubCount) hubCount.textContent = `${s.referralsCompleted || 0}/${s.progressTarget || 3}`;
    if (hubNext  && s.nextMilestone) {
      const nm = MILESTONES.find(m => m.at === s.nextMilestone);
      if (nm) hubNext.textContent = `Next: ${nm.label}`;
    }

    // Reward balance
    const balEl  = document.getElementById('inviteRewardBalance');
    const balCnt = document.getElementById('inviteRewardBalanceContent');
    const hasBalance = (s.rewardBalanceSeconds > 0 || s.rewardBalanceSessions > 0 || s.proUntil);
    if (balEl) balEl.style.display = hasBalance ? '' : 'none';
    if (balCnt && hasBalance) {
      const parts = [];
      if (s.rewardBalanceSeconds  > 0) parts.push(`⏱ ${Math.round(s.rewardBalanceSeconds / 60)} min Party Pass time`);
      if (s.rewardBalanceSessions > 0) parts.push(`🎊 ${s.rewardBalanceSessions} Party Pass session(s)`);
      if (s.proUntil) parts.push(`⭐ Pro until ${new Date(s.proUntil).toLocaleDateString()}`);
      balCnt.innerHTML = parts.map(p => `<div style="margin-bottom:0.25rem;">${p}</div>`).join('');
    }

    // Modal / old UI elements (backward compat)
    const totalCount = document.getElementById('referralTotalCount');
    if (totalCount) totalCount.textContent = s.referralsCompleted || 0;
    const codeDisp = document.getElementById('referralCodeDisplay');
    if (codeDisp) codeDisp.textContent = s.referralCode || '---';
    const linkInp = document.getElementById('referralLinkInput');
    if (linkInp && s.inviteUrl) linkInp.value = s.inviteUrl;

    // Re-render milestones
    this._renderMilestones();
  }

  // ─── Sharing ───────────────────────────────────────────────────────────────

  _getInviteUrl(platform) {
    const base = this.stats?.inviteUrl || window.location.origin;
    return `${base}?utm_source=share&utm_medium=${platform}&utm_campaign=referral`;
  }

  async _nativeShare() {
    const url  = this._getInviteUrl('native');
    const text = shareText(url);
    this._fireEvent('referral_share_opened', { platform: 'native' });
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Join my Phone Party 🎉', text, url });
      } catch (e) {
        if (e.name !== 'AbortError') this._showShareFallback(url);
      }
    } else {
      this._showShareFallback(url);
    }
  }

  _showShareFallback(url) {
    const text = shareText(url);
    // Remove any existing share fallback modal
    const existing = document.getElementById('shareSheetModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'shareSheetModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Share options');
    modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.6);';

    const sheet = document.createElement('div');
    sheet.style.cssText = 'background:#1a1a2e;border-radius:16px 16px 0 0;padding:1.25rem;width:100%;max-width:480px;box-shadow:0 -4px 24px rgba(0,0,0,0.5);';

    // Header row
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;';

    const title = document.createElement('h3');
    title.textContent = '📤 Share via';
    title.style.cssText = 'margin:0;font-size:1rem;';

    const closeBtn = document.createElement('button');
    closeBtn.id = 'btnShareSheetClose';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;color:#aaa;font-size:1.4rem;cursor:pointer;padding:0.25rem;';

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Platform buttons row
    const platformRow = document.createElement('div');
    platformRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem;';

    SHARE_PLATFORMS.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.setAttribute('data-ssplatform', p.id);
      btn.textContent = p.label;
      btn.style.cssText = 'flex:1 0 auto;min-width:calc(50% - 0.25rem);text-align:center;padding:0.6rem 0.5rem;font-size:0.85rem;';

      if (p.native) {
        // Snapchat / TikTok: try Web Share API, fallback to copy
        btn.addEventListener('click', () => {
          if (navigator.share) {
            navigator.share({ title: 'Join my Phone Party 🎉', text, url })
              .catch(() => {
                navigator.clipboard && navigator.clipboard.writeText(url).catch(() => {});
                const orig = btn.textContent;
                btn.textContent = '✓ Copied! Paste in app';
                setTimeout(() => { btn.textContent = orig; }, 2000);
              });
          } else {
            navigator.clipboard && navigator.clipboard.writeText(url).catch(() => {});
            const orig = btn.textContent;
            btn.textContent = '✓ Copied! Paste in app';
            setTimeout(() => { btn.textContent = orig; }, 2000);
          }
        });
      } else if (p.urlFn) {
        const platformUrl = p.urlFn(url, text);
        btn.addEventListener('click', () => window.open(platformUrl, '_blank', 'noopener,noreferrer'));
      }

      platformRow.appendChild(btn);
    });

    // Copy-link row
    const copyRow = document.createElement('div');
    copyRow.style.cssText = 'display:flex;gap:0.5rem;align-items:center;';

    const linkInput = document.createElement('input');
    linkInput.id = 'shareSheetLinkInput';
    linkInput.type = 'text';
    linkInput.readOnly = true;
    linkInput.value = url;
    linkInput.style.cssText = 'flex:1;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:0.5rem 0.75rem;color:#fff;font-size:0.8rem;';

    const copyBtn = document.createElement('button');
    copyBtn.id = 'btnShareSheetCopy';
    copyBtn.className = 'btn primary';
    copyBtn.textContent = '📋 Copy';
    copyBtn.style.cssText = 'white-space:nowrap;padding:0.5rem 0.75rem;font-size:0.85rem;';

    copyRow.appendChild(linkInput);
    copyRow.appendChild(copyBtn);

    sheet.appendChild(header);
    sheet.appendChild(platformRow);
    sheet.appendChild(copyRow);
    modal.appendChild(sheet);
    document.body.appendChild(modal);

    const close = () => modal.remove();

    // Close when clicking the backdrop
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    closeBtn.addEventListener('click', close);

    // Keyboard dismiss
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    // Copy link button
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
      } catch (_) {
        // execCommand fallback
        const ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (_2) { /* ignore */ }
        document.body.removeChild(ta);
      }
      copyBtn.textContent = '✓ Copied!';
      copyBtn.style.background = 'rgba(0,255,0,0.3)';
      setTimeout(() => { copyBtn.textContent = '📋 Copy'; copyBtn.style.background = ''; }, 2000);
    });
  }

  _sharePlatform(platformId) {
    const platform = SHARE_PLATFORMS.find(p => p.id === platformId);
    if (!platform) return;
    this._fireEvent('referral_share_opened', { platform: platformId });

    if (platform.native) {
      // Snapchat / TikTok: try Web Share API, fallback to copy
      if (navigator.share) {
        const url  = this._getInviteUrl(platformId);
        const text = shareText(url);
        navigator.share({ title: 'Join my Phone Party 🎉', text, url })
          .catch(e => { if (e.name !== 'AbortError') this._copyLink(); });
      } else {
        this._copyLink();
        const btn = document.querySelector(`[data-platform="${platformId}"]`);
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = '✓ Link copied! Paste in app';
          setTimeout(() => { btn.textContent = orig; }, 3000);
        }
      }
      return;
    }

    const url  = this._getInviteUrl(platformId);
    const link = buildUrl(platform, url);
    if (link) window.open(link, '_blank', 'noopener,noreferrer');
  }

  async _copyLink() {
    const url = this._getInviteUrl('copy');
    this._fireEvent('referral_link_copied', { url });
    const copyBtn = document.getElementById('btnCopyInviteLink') ||
                    document.getElementById('btnCopyReferralLink');
    try {
      await navigator.clipboard.writeText(url);
    } catch (_) {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (_2) { /* ignore */ }
      document.body.removeChild(ta);
    }
    if (copyBtn) {
      const orig = copyBtn.textContent;
      copyBtn.textContent = '✓ Copied!';
      copyBtn.style.background = 'rgba(0,255,0,0.3)';
      setTimeout(() => { copyBtn.textContent = orig; copyBtn.style.background = ''; }, 2000);
    }
  }

  // ─── Celebration popup ─────────────────────────────────────────────────────

  _checkAndCelebrate(before, after) {
    const newMilestones = MILESTONES.filter(m => m.at > before && m.at <= after);
    if (!newMilestones.length) return;
    const m = newMilestones[newMilestones.length - 1];
    this._showCelebration(`🎉 Milestone unlocked!\n${m.at} referrals → ${m.label}`);
  }

  _showCelebration(message) {
    let el = document.getElementById('referralCelebration');
    if (!el) {
      el = document.createElement('div');
      el.id = 'referralCelebration';
      el.style.cssText = `
        position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
        background:linear-gradient(135deg,#9D4EDD,#5AA9FF);color:#fff;
        border-radius:16px;padding:1.5rem 2rem;text-align:center;
        z-index:9999;font-size:1.1rem;font-weight:600;
        box-shadow:0 8px 32px rgba(0,0,0,0.5);max-width:320px;width:90%;
        white-space:pre-line;
      `;
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  startPolling(intervalMs = 10000) {
    this.loadStats();
    this._pollTimer = setInterval(() => this.loadStats(), intervalMs);
    // Attempt to show the nudge now that the user is authenticated.
    // Safe to call repeatedly — internally guarded by 'referral_nudge_shown' flag.
    this._maybeShowNudge();
  }

  stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    // Cancel any pending nudge timer so it doesn't fire after the session ends
    if (this._nudgeTimer) { clearTimeout(this._nudgeTimer); this._nudgeTimer = null; }
  }

  // ─── Promo elements ────────────────────────────────────────────────────────

  _bindPromoElements() {
    // Any element with data-nav="viewInviteFriends"
    document.querySelectorAll('[data-nav="viewInviteFriends"], [data-goto="invite"]').forEach(el => {
      el.addEventListener('click', () => this.openInvitePage());
    });

    // Hub promo "Share Invite Link" button — triggers native share directly,
    // then falls back to an inline share sheet with platform-specific buttons.
    const hubShareBtn = document.getElementById('btnHubShareInvite');
    if (hubShareBtn) {
      hubShareBtn.addEventListener('click', () => {
        this._fireEvent('referral_promo_clicked', { location: 'hub' });
        this._nativeShare();
      });
    }

    // Paywall cross-promo link
    const paywallLink = document.getElementById('btnPaywallReferralLink');
    if (paywallLink) {
      paywallLink.addEventListener('click', () => {
        this._fireEvent('referral_promo_clicked', { location: 'paywall' });
        this.openInvitePage();
      });
    }

    // Settings menu entry
    const settingsBtn = document.getElementById('btnSettingsInviteFriends');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        this._fireEvent('referral_promo_clicked', { location: 'settings' });
        this.openInvitePage();
      });
    }
  }

  _bindStaticButtons() {
    // Old modal "Share" button
    const btnShare = document.getElementById('btnShareReferralLink');
    if (btnShare) btnShare.addEventListener('click', () => this._nativeShare());

    // Old modal "Copy" button
    const btnCopy = document.getElementById('btnCopyReferralLink');
    if (btnCopy) btnCopy.addEventListener('click', () => this._copyLink());

    // Old modal open button
    const btnReferral = document.getElementById('btnReferral');
    if (btnReferral) btnReferral.addEventListener('click', () => this.openInvitePage());

    // Old modal close button
    const btnClose = document.getElementById('btnCloseReferralModal');
    if (btnClose) btnClose.addEventListener('click', () => {
      const modal = document.getElementById('modalReferral');
      if (modal) modal.classList.add('hidden');
    });
  }

  openInvitePage() {
    this._fireEvent('referral_promo_clicked', { location: 'direct' });
    if (typeof window.setView === 'function' &&
        document.getElementById('viewInviteFriends')) {
      window.setView('inviteFriends');
      this.startPolling();
    } else {
      // Fallback: show old modal
      const modal = document.getElementById('modalReferral');
      if (modal) { modal.classList.remove('hidden'); this.loadStats(); }
    }
  }

  // ─── One-time nudge modal ──────────────────────────────────────────────────

  /** Returns true when a logged-in user's session data exists in localStorage. */
  _isAuthenticated() {
    try {
      return typeof localStorage !== 'undefined' &&
             !!localStorage.getItem('syncspeaker_current_user');
    } catch (_) { return false; }
  }

  _maybeShowNudge() {
    // Only show once per browser
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem('referral_nudge_shown')) return;
    // Only show to authenticated users — the nudge is about inviting friends after
    // signup. Showing it on the landing page blocks the "GET STARTED" button.
    if (!this._isAuthenticated()) return;
    // Delay to avoid cluttering the first login moment; store the ID so
    // stopPolling() can cancel it if the user logs out before it fires.
    this._nudgeTimer = setTimeout(() => this._showNudge(), 3000);
  }

  _showNudge() {
    this._nudgeTimer = null;
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem('referral_nudge_shown')) return;
    // Double-check auth state at display time (user may have logged out in the 3 s window)
    if (!this._isAuthenticated()) return;

    const modal = document.getElementById('modalReferralNudge');
    if (!modal) return;
    modal.classList.remove('hidden');
    localStorage.setItem('referral_nudge_shown', '1');

    const inviteBtn = document.getElementById('btnNudgeInvite');
    if (inviteBtn) inviteBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
      this.openInvitePage();
    });
    const laterBtn = document.getElementById('btnNudgeLater');
    if (laterBtn) laterBtn.addEventListener('click', () => modal.classList.add('hidden'));
  }

  // ─── Analytics ─────────────────────────────────────────────────────────────

  _fireEvent(name, props = {}) {
    try {
      if (window.analytics?.track) window.analytics.track(name, props);
    } catch (_) { /* ignore */ }
  }

  _trackPromoViewed() {
    const obs = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          this._fireEvent('referral_promo_viewed', { element: e.target.id });
          obs.unobserve(e.target);
        }
      });
    }, { threshold: 0.5 });
    ['referralLandingBanner', 'referralHubTile'].forEach(id => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
  }

  // ─── Visibility helpers ────────────────────────────────────────────────────

  setVisible(isAuthenticated) {
    const btn = document.getElementById('btnReferral');
    if (btn) btn.classList.toggle('hidden', !isAuthenticated);
    const tile = document.getElementById('referralHubTile');
    if (tile) tile.classList.toggle('hidden', !isAuthenticated);
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

window.ReferralUI = ReferralUI;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ReferralUI;
}
