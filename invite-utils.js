(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.InviteUtils = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PRODUCTION_PUBLIC_BASE_URL = 'https://www.phone-party.com';

  function trimTrailingSlash(value) {
    return String(value || '').replace(/\/$/, '');
  }

  function isLocalhostHost(hostname) {
    return /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(String(hostname || ''));
  }

  function getPublicBaseUrl(options = {}) {
    const explicit = trimTrailingSlash(options.publicBaseUrl || options.baseUrl || '');
    const hostname = options.hostname
      || (typeof window !== 'undefined' && window.location ? window.location.hostname : '');
    const isLocal = isLocalhostHost(hostname);
    if (!isLocal) return PRODUCTION_PUBLIC_BASE_URL;
    if (explicit) return explicit;
    if (typeof window !== 'undefined' && window.location && window.location.origin) {
      return trimTrailingSlash(window.location.origin);
    }
    return PRODUCTION_PUBLIC_BASE_URL;
  }

  function buildInviteLink(inviteCode, inviterId, options = {}) {
    const baseUrl = getPublicBaseUrl(options);
    const params = new URLSearchParams();
    if (inviteCode) params.set('code', String(inviteCode).trim().toUpperCase());
    if (inviterId) params.set('inviter', String(inviterId).trim());
    return `${baseUrl}/signup?${params.toString()}`;
  }

  function resolveInviterName(inviter) {
    if (!inviter || typeof inviter !== 'object') return 'Someone';
    const displayName = inviter.displayName || inviter.djName || inviter.dj_name;
    const profileName = inviter.profile && inviter.profile.name;
    const firstName = inviter.firstName || inviter.first_name;
    const email = inviter.email || '';
    const emailFallback = email.includes('@') ? email.split('@')[0] : '';
    const name = [displayName, profileName, firstName, emailFallback].find((value) => typeof value === 'string' && value.trim());
    return name ? name.trim() : 'Someone';
  }

  const MESSAGE_VARIANTS = {
    default: (name, url) => `${name} invited you to join her on Phone Party: ${url}`,
    live: (name, url) => `${name} just invited you to a live Phone Party 👀 Tap to join: ${url}`,
    celebration: (name, url) => `You're invited 🎉 Join ${name} on Phone Party now: ${url}`
  };

  function buildInviteMessage(inviter, inviteUrl, variant = 'default') {
    const inviterName = typeof inviter === 'string' ? inviter : resolveInviterName(inviter);
    const formatter = MESSAGE_VARIANTS[variant] || MESSAGE_VARIANTS.default;
    return formatter(inviterName, inviteUrl);
  }

  function buildInviteSharePayload({ inviteCode, inviterId, inviter, variant = 'default', medium = 'share', publicBaseUrl } = {}) {
    const url = buildInviteLink(inviteCode, inviterId, { publicBaseUrl });
    const inviterName = resolveInviterName(inviter);
    const text = buildInviteMessage(inviterName, url, variant);
    return {
      title: `${inviterName} invited you to Phone Party`,
      subject: `${inviterName} invited you to Phone Party`,
      inviterName,
      url,
      text,
      medium,
      variant
    };
  }

  function getInviteAttribution({ search, storage } = {}) {
    const query = new URLSearchParams(
      typeof search === 'string'
        ? search
        : (typeof window !== 'undefined' && window.location ? window.location.search : '')
    );
    const safeStorage = storage || (typeof window !== 'undefined' ? window.localStorage : null);
    const inviteCode = (query.get('code') || (safeStorage && safeStorage.getItem('referral_code')) || '').trim().toUpperCase();
    const inviterId = (query.get('inviter') || (safeStorage && safeStorage.getItem('referral_inviter_id')) || '').trim();
    const inviterName = (query.get('inviterName') || (safeStorage && safeStorage.getItem('referral_inviter_name')) || '').trim();
    const clickId = (safeStorage && safeStorage.getItem('referral_click_id')) || null;
    return {
      inviteCode: inviteCode || null,
      inviterId: inviterId || null,
      inviterName: inviterName || null,
      clickId
    };
  }

  return {
    PRODUCTION_PUBLIC_BASE_URL,
    getPublicBaseUrl,
    buildInviteLink,
    resolveInviterName,
    buildInviteMessage,
    buildInviteSharePayload,
    getInviteAttribution
  };
}));
