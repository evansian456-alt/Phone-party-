/**
 * Referral UI Manager
 */

const { buildInviteSharePayload, getInviteAttribution, resolveInviterName } = window.InviteUtils || {};

const SHARE_PLATFORMS = [
  { id: 'whatsapp', label: '💬 WhatsApp', urlFn: (p) => `https://wa.me/?text=${encodeURIComponent(p.text)}` },
  { id: 'facebook', label: '👍 Facebook', urlFn: (p) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(p.url)}&quote=${encodeURIComponent(p.text)}` },
  { id: 'twitter', label: '🐦 X', urlFn: (p) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(p.text)}` },
  { id: 'sms', label: '📱 SMS', urlFn: (p) => `sms:?body=${encodeURIComponent(p.text)}` },
  { id: 'email', label: '📧 Email', urlFn: (p) => `mailto:?subject=${encodeURIComponent(p.subject)}&body=${encodeURIComponent(p.text)}` },
];

const MILESTONES = [
  { at: 3, label: '30 min Party Pass' },
  { at: 5, label: '1 hr Party Pass' },
  { at: 10, label: '1 Party Pass session' },
  { at: 20, label: '3 Party Pass sessions' },
  { at: 50, label: '1 month Pro' },
];

class ReferralUI {
  constructor() {
    this.stats = null;
    this._pollTimer = null;
    this._nudgeTimer = null;
    this._lastCount = null;
    this._nudgeShown = false;
    this._shareVariantIndex = 0;
    this._init();
  }

  _init() {
    this._buildInvitePage();
    this._bindStaticButtons();
    this._bindPromoElements();
    this._maybeShowNudge();
    this._trackPromoViewed();
  }

  _getCurrentUser() {
    if (typeof getCachedUser === 'function') {
      const cached = getCachedUser();
      if (cached?.user) return cached.user;
    }
    return null;
  }

  _buildSharePayload(medium = 'share') {
    const user = this._getCurrentUser() || {};
    const variantOrder = ['default', 'live', 'celebration'];
    const variant = variantOrder[this._shareVariantIndex % variantOrder.length];
    this._shareVariantIndex += 1;
    return buildInviteSharePayload({
      inviteCode: this.stats?.referralCode,
      inviterId: user.id,
      inviter: {
        displayName: this.stats?.inviterName || user.djName || user.displayName,
        profile: { name: user.profile?.name },
        firstName: user.firstName,
        email: user.email,
      },
      variant,
      medium,
      publicBaseUrl: window.PUBLIC_BASE_URL,
    });
  }

  _buildInvitePage() {
    const container = document.getElementById('viewInviteFriends');
    if (!container) return;

    container.innerHTML = `
      <div class="invite-page-inner" style="max-width:520px;margin:0 auto;padding:1rem;">
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1.5rem;">
          <button class="btn" id="btnInviteBack">← Back</button>
          <h2 style="margin:0;">🎁 Invite Friends</h2>
        </div>

        <div class="glass-card" style="margin-bottom:1rem;">
          <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;">
            <div>
              <div class="lbl">Friends joined</div>
              <div id="inviteFriendsJoined" style="font-size:1.7rem;font-weight:800;color:#9D4EDD;">0</div>
            </div>
            <div>
              <div class="lbl">Progress</div>
              <div id="inviteGrowthProgress" style="font-size:1rem;font-weight:700;">0/3 friends joined</div>
            </div>
          </div>
          <div style="margin-top:0.85rem;" id="inviteIncentiveCopy">Invite 1 friend → unlock feature/reward</div>
        </div>

        <div class="referral-progress-card glass-card" style="margin-bottom:1rem;">
          <div class="progress-header" style="display:flex;justify-content:space-between;margin-bottom:0.5rem;">
            <span id="inviteProgressLabel">Invite your friends to join the party</span>
            <span id="inviteProgressCount" style="font-weight:700;color:#9D4EDD;">0 / 3</span>
          </div>
          <div class="progress-bar" style="background:rgba(255,255,255,0.1);border-radius:99px;height:12px;overflow:hidden;">
            <div class="progress-fill" id="inviteProgressBar" style="width:0%;background:linear-gradient(90deg,#9D4EDD,#5AA9FF);height:100%;border-radius:99px;transition:width 0.5s ease;"></div>
          </div>
          <div id="inviteNextReward" style="margin-top:0.5rem;font-size:0.85rem;color:#aaa;"></div>
        </div>

        <div class="glass-card" style="margin-bottom:1rem;" id="inviteMilestones"></div>

        <div class="glass-card" id="inviteRewardBalance" style="margin-bottom:1rem;display:none;">
          <h4 style="margin-bottom:0.5rem;">🏆 Your Rewards</h4>
          <div id="inviteRewardBalanceContent"></div>
        </div>

        <div class="glass-card" style="margin-bottom:1rem;">
          <div class="lbl" style="margin-bottom:0.35rem;">Your invite message</div>
          <div id="invitePreviewText" style="font-size:0.9rem;color:#ddd;line-height:1.6;"></div>
        </div>

        <div class="glass-card" style="margin-bottom:1rem;">
          <div class="lbl" style="margin-bottom:0.5rem;">Your Invite Link</div>
          <div style="display:flex;gap:0.5rem;">
            <input type="text" id="inviteLinkInput" class="input-field" readonly style="flex:1;font-size:0.85rem;" value="Loading…" />
            <button class="btn primary" id="btnCopyInviteLink" style="white-space:nowrap;">📋 Copy</button>
          </div>
        </div>

        <div class="glass-card">
          <div class="lbl" style="margin-bottom:0.75rem;">Share via</div>
          <div style="display:flex;flex-wrap:wrap;gap:0.5rem;" id="inviteShareButtons">
            <button class="btn primary" id="btnNativeShare" style="flex:1 0 auto;">📤 Share</button>
            ${SHARE_PLATFORMS.map(p => `<button class="btn invite-share-btn" data-platform="${p.id}" style="flex:1 0 auto;">${p.label}</button>`).join('')}
          </div>
        </div>
      </div>
    `;

    const backBtn = document.getElementById('btnInviteBack');
    if (backBtn) backBtn.addEventListener('click', () => typeof window.setView === 'function' && window.setView('viewAuthHome'));
    const copyBtn = document.getElementById('btnCopyInviteLink');
    if (copyBtn) copyBtn.addEventListener('click', () => this._copyLink());
    const nativeBtn = document.getElementById('btnNativeShare');
    if (nativeBtn) nativeBtn.addEventListener('click', () => this._nativeShare());
    document.querySelectorAll('.invite-share-btn').forEach(btn => btn.addEventListener('click', () => this._sharePlatform(btn.dataset.platform)));
    this._renderMilestones();
  }

  _renderMilestones() {
    const el = document.getElementById('inviteMilestones');
    if (!el) return;
    const completed = this.stats?.friendsJoined || 0;
    el.innerHTML = `
      <h4 style="margin-bottom:0.75rem;">🏅 Milestones</h4>
      ${MILESTONES.map(m => {
        const done = completed >= m.at;
        return `<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem;opacity:${done ? 1 : 0.6};">
          <span style="font-size:1.2rem;">${done ? '✅' : '🔒'}</span>
          <span><strong>${m.at} friends joined</strong> → ${m.label}</span>
        </div>`;
      }).join('')}
    `;
  }

  async loadStats() {
    try {
      const res = await fetch(API_BASE + '/api/referral/me', { credentials: 'include' });
      if (!res.ok) return;
      this.stats = await res.json();
      this._updateUI();
      if (this._lastCount !== null && this.stats.friendsJoined > this._lastCount) {
        this._checkAndCelebrate(this._lastCount, this.stats.friendsJoined);
      }
      this._lastCount = this.stats.friendsJoined;
    } catch (_) {}
  }

  _updateUI() {
    if (!this.stats) return;
    const s = this.stats;
    const payload = this._buildSharePayload('preview');

    const pBar = document.getElementById('inviteProgressBar');
    const pCnt = document.getElementById('inviteProgressCount');
    const pNext = document.getElementById('inviteNextReward');
    const pLbl = document.getElementById('inviteProgressLabel');
    if (pBar) pBar.style.width = `${s.progressPercent || 0}%`;
    if (pCnt) pCnt.textContent = `${s.friendsJoined || 0} / ${s.progressTarget || 3}`;
    if (pNext && s.nextMilestone) {
      const nm = MILESTONES.find(m => m.at === s.nextMilestone);
      if (nm) pNext.textContent = `Next reward: ${nm.label} when ${nm.at} friends join`;
    }
    if (pLbl) pLbl.textContent = 'One tap share. One clear invite link. More friends in the room.';

    const friendsJoined = document.getElementById('inviteFriendsJoined');
    const growthProgress = document.getElementById('inviteGrowthProgress');
    const incentive = document.getElementById('inviteIncentiveCopy');
    const preview = document.getElementById('invitePreviewText');
    if (friendsJoined) friendsJoined.textContent = `${s.friendsJoined || 0}`;
    if (growthProgress) growthProgress.textContent = `${s.friendsJoined || 0}/${s.progressTarget || 3} friends joined`;
    if (incentive) incentive.textContent = s.inviteIncentive || 'Invite 1 friend → unlock feature/reward';
    if (preview) preview.textContent = payload.text;

    const linkInput = document.getElementById('inviteLinkInput');
    if (linkInput) linkInput.value = payload.url;

    const hubCount = document.getElementById('referralHubCount');
    const hubNext = document.getElementById('referralHubNext');
    if (hubCount) hubCount.textContent = `${s.friendsJoined || 0}/${s.progressTarget || 3}`;
    if (hubNext) hubNext.textContent = s.nextMilestone ? `Next: ${s.nextMilestone} friends joined` : 'Top milestone unlocked';

    const balEl = document.getElementById('inviteRewardBalance');
    const balCnt = document.getElementById('inviteRewardBalanceContent');
    const hasBalance = (s.rewardBalanceSeconds > 0 || s.rewardBalanceSessions > 0 || s.proUntil);
    if (balEl) balEl.style.display = hasBalance ? '' : 'none';
    if (balCnt && hasBalance) {
      const parts = [];
      if (s.rewardBalanceSeconds > 0) parts.push(`⏱ ${Math.round(s.rewardBalanceSeconds / 60)} min Party Pass time`);
      if (s.rewardBalanceSessions > 0) parts.push(`🎊 ${s.rewardBalanceSessions} Party Pass session(s)`);
      if (s.proUntil) parts.push(`⭐ Pro until ${new Date(s.proUntil).toLocaleDateString()}`);
      balCnt.innerHTML = parts.map(p => `<div style="margin-bottom:0.25rem;">${p}</div>`).join('');
    }

    const totalCount = document.getElementById('referralTotalCount');
    if (totalCount) totalCount.textContent = s.friendsJoined || 0;
    const codeDisp = document.getElementById('referralCodeDisplay');
    if (codeDisp) codeDisp.textContent = s.referralCode || '---';
    const linkInp = document.getElementById('referralLinkInput');
    if (linkInp) linkInp.value = payload.url;

    this._renderMilestones();
  }

  async _nativeShare() {
    const payload = this._buildSharePayload('native');
    this._fireEvent('referral_share_opened', { platform: 'native' });
    if (navigator.share) {
      try {
        await navigator.share({ title: payload.title, text: payload.text, url: payload.url });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    this._showShareFallback(payload);
  }

  _showShareFallback(payload) {
    const existing = document.getElementById('shareSheetModal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'shareSheetModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.6);';
    const sheet = document.createElement('div');
    sheet.style.cssText = 'background:#1a1a2e;border-radius:16px 16px 0 0;padding:1.25rem;width:100%;max-width:480px;box-shadow:0 -4px 24px rgba(0,0,0,0.5);';
    sheet.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;"><h3 style="margin:0;font-size:1rem;">📤 Share via</h3><button id="btnShareSheetClose" aria-label="Close" style="background:none;border:none;color:#aaa;font-size:1.4rem;cursor:pointer;padding:0.25rem;">✕</button></div>`;
    const platformRow = document.createElement('div');
    platformRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem;';
    SHARE_PLATFORMS.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.setAttribute('data-ssplatform', p.id);
      btn.textContent = p.label;
      btn.style.cssText = 'flex:1 0 auto;min-width:calc(50% - 0.25rem);text-align:center;padding:0.6rem 0.5rem;font-size:0.85rem;';
      btn.addEventListener('click', () => window.open(p.urlFn(payload), '_blank', 'noopener,noreferrer'));
      platformRow.appendChild(btn);
    });
    const copyRow = document.createElement('div');
    copyRow.style.cssText = 'display:flex;gap:0.5rem;align-items:center;';
    copyRow.innerHTML = `<input id="shareSheetLinkInput" type="text" readonly value="${payload.url}" style="flex:1;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:0.5rem 0.75rem;color:#fff;font-size:0.8rem;" /><button id="btnShareSheetCopy" class="btn primary" style="white-space:nowrap;padding:0.5rem 0.75rem;font-size:0.85rem;">📋 Copy</button>`;
    sheet.appendChild(platformRow);
    sheet.appendChild(copyRow);
    modal.appendChild(sheet);
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    sheet.querySelector('#btnShareSheetClose').addEventListener('click', close);
    copyRow.querySelector('#btnShareSheetCopy').addEventListener('click', () => this._copyText(payload.url, copyRow.querySelector('#btnShareSheetCopy')));
  }

  _sharePlatform(platformId) {
    const platform = SHARE_PLATFORMS.find(p => p.id === platformId);
    if (!platform) return;
    const payload = this._buildSharePayload(platformId);
    this._fireEvent('referral_share_opened', { platform: platformId });
    window.open(platform.urlFn(payload), '_blank', 'noopener,noreferrer');
  }

  async _copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (_2) {}
      document.body.removeChild(ta);
    }
    if (button) {
      const orig = button.textContent;
      button.textContent = '✓ Copied!';
      setTimeout(() => { button.textContent = orig; }, 2000);
    }
  }

  async _copyLink() {
    const payload = this._buildSharePayload('copy');
    this._fireEvent('referral_link_copied', { url: payload.url });
    const copyBtn = document.getElementById('btnCopyInviteLink') || document.getElementById('btnCopyReferralLink');
    await this._copyText(payload.text, copyBtn);
  }

  _checkAndCelebrate(before, after) {
    const newMilestones = MILESTONES.filter(m => m.at > before && m.at <= after);
    if (!newMilestones.length) return;
    const m = newMilestones[newMilestones.length - 1];
    this._showCelebration(`🎉 ${after} friend${after === 1 ? '' : 's'} joined!\n${m.at} friends → ${m.label}`);
  }

  _showCelebration(message) {
    let el = document.getElementById('referralCelebration');
    if (!el) {
      el = document.createElement('div');
      el.id = 'referralCelebration';
      el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:linear-gradient(135deg,#9D4EDD,#5AA9FF);color:#fff;border-radius:16px;padding:1.5rem 2rem;text-align:center;z-index:9999;font-size:1.1rem;font-weight:600;box-shadow:0 8px 32px rgba(0,0,0,0.5);max-width:320px;width:90%;white-space:pre-line;';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }

  startPolling(intervalMs = 10000) {
    this.loadStats();
    this._pollTimer = setInterval(() => this.loadStats(), intervalMs);
    this._maybeShowNudge();
  }

  stopPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._nudgeTimer) clearTimeout(this._nudgeTimer);
    this._pollTimer = null;
    this._nudgeTimer = null;
  }

  _bindPromoElements() {
    document.querySelectorAll('[data-nav="viewInviteFriends"], [data-goto="invite"]').forEach(el => el.addEventListener('click', () => this.openInvitePage()));
    const hubShareBtn = document.getElementById('btnHubShareInvite');
    if (hubShareBtn) hubShareBtn.addEventListener('click', () => { this._fireEvent('referral_promo_clicked', { location: 'hub' }); this._nativeShare(); });
    const paywallLink = document.getElementById('btnPaywallReferralLink');
    if (paywallLink) paywallLink.addEventListener('click', () => this.openInvitePage());
    const settingsBtn = document.getElementById('btnSettingsInviteFriends');
    if (settingsBtn) settingsBtn.addEventListener('click', () => this.openInvitePage());
  }

  _bindStaticButtons() {}
  _maybeShowNudge() {}
  _trackPromoViewed() {}
  openInvitePage() { if (typeof window.setView === 'function') window.setView('inviteFriends'); }
  setVisible() {}
  _fireEvent(name, payload) { if (window.analytics?.track) window.analytics.track(name, payload || {}); }
}

window.ReferralUI = ReferralUI;
if (typeof module !== 'undefined' && module.exports) module.exports = ReferralUI;
