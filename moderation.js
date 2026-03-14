/**
 * Moderation and Safety Features
 * Kick, mute, block guests; spam prevention; safety controls;
 * abuse/profanity filtering; report submission.
 */

const MODERATION = {
  mutedGuests: new Set(),
  blockedGuests: new Set(),
  kickedGuests: new Set(),
  lastMessageTimestamps: new Map(),
  repeatMessageCounts: new Map(),
  cooldownMs: 2000 // 2 second cooldown between messages
};

const SAFETY = {
  profanityFilter: null,
  volumeLimitPercent: 90,
  safeVolumeStartPercent: 30,
  reportedUsers: new Set()
};

// Mild/moderate abuse keywords (replaced with asterisks).
// This is a minimal starter list; expand or replace with a vetted word list for production.
const MILD_ABUSE_WORDS = [
  'spam', 'scam', 'hack',
  'stupid', 'idiot', 'loser', 'moron'
];

// Severe abuse patterns (content blocked + moderation event created)
const SEVERE_ABUSE_PATTERNS = [
  /\b(f+u+c+k+|sh+i+t+|b+i+t+c+h+|a+s+s+h+o+l+e+)\b/i,
  /\b(n+i+g+g+e+r+|c+u+n+t+|f+a+g+g+o+t+)\b/i,
  /\b(k+i+l+l\s+your?self|go\s+die|kys)\b/i,
  /\b(hate\s+you|you\s+suck)\b/i
];

// Spam: same message repeated quickly
const MAX_REPEAT_MESSAGES = 3;
const REPEAT_WINDOW_MS = 10000;

/**
 * Initialize moderation system
 */
function initModeration() {
  console.log('[Moderation] Initializing moderation and safety features');
  initProfanityFilter();
}

/**
 * Kick a guest from the party (host only)
 */
function kickGuest(guestId) {
  if (typeof state !== 'undefined' && !state.isHost) {
    console.warn('[Moderation] Only host can kick guests');
    return false;
  }

  MODERATION.kickedGuests.add(guestId);
  console.log(`[Moderation] Guest kicked: ${guestId}`);

  if (typeof state !== 'undefined' && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'KICK', guestId }));
  }

  return true;
}

/**
 * Mute a guest (prevents them from sending messages)
 */
function muteGuest(guestId) {
  if (typeof state !== 'undefined' && !state.isHost) {
    console.warn('[Moderation] Only host can mute guests');
    return false;
  }

  MODERATION.mutedGuests.add(guestId);
  console.log(`[Moderation] Guest muted: ${guestId}`);
  return true;
}

/**
 * Unmute a guest
 */
function unmuteGuest(guestId) {
  if (typeof state !== 'undefined' && !state.isHost) {
    console.warn('[Moderation] Only host can unmute guests');
    return false;
  }

  MODERATION.mutedGuests.delete(guestId);
  console.log(`[Moderation] Guest unmuted: ${guestId}`);
  return true;
}

/**
 * Block a guest (party-level only — not a platform ban)
 */
function blockGuest(guestId) {
  if (typeof state !== 'undefined' && !state.isHost) {
    console.warn('[Moderation] Only host can block guests');
    return false;
  }

  MODERATION.blockedGuests.add(guestId);
  MODERATION.mutedGuests.add(guestId);
  console.log(`[Moderation] Guest blocked: ${guestId}`);
  kickGuest(guestId);
  return true;
}

/**
 * Check if guest is muted
 */
function isGuestMuted(guestId) {
  return MODERATION.mutedGuests.has(guestId);
}

/**
 * Check if guest is blocked
 */
function isGuestBlocked(guestId) {
  return MODERATION.blockedGuests.has(guestId);
}

/**
 * Check spam cooldown for a guest
 */
function checkSpamCooldown(guestId) {
  const now = Date.now();
  const lastMessageTime = MODERATION.lastMessageTimestamps.get(guestId) || 0;
  const timeSinceLastMessage = now - lastMessageTime;

  if (timeSinceLastMessage < MODERATION.cooldownMs) {
    console.warn(`[Moderation] Spam from ${guestId}, cooldown: ${MODERATION.cooldownMs - timeSinceLastMessage}ms remaining`);
    return false;
  }

  MODERATION.lastMessageTimestamps.set(guestId, now);
  return true;
}

/**
 * Check for repeated identical messages (spam detection)
 * @returns {boolean} true if allowed, false if spam
 */
function checkRepeatSpam(guestId, message) {
  const key = `${guestId}:${message}`;
  const now = Date.now();
  const entry = MODERATION.repeatMessageCounts.get(key) || { count: 0, firstSeen: now };

  if (now - entry.firstSeen > REPEAT_WINDOW_MS) {
    MODERATION.repeatMessageCounts.set(key, { count: 1, firstSeen: now });
    return true;
  }

  entry.count += 1;
  MODERATION.repeatMessageCounts.set(key, entry);

  if (entry.count > MAX_REPEAT_MESSAGES) {
    console.warn(`[Moderation] Repeat spam from ${guestId}: "${message}" (${entry.count}x)`);
    return false;
  }

  return true;
}

/**
 * Initialize profanity filter with common words
 */
function initProfanityFilter() {
  SAFETY.profanityFilter = new RegExp(
    MILD_ABUSE_WORDS.map(w => `\\b${w}\\b`).join('|'),
    'gi'
  );
  console.log('[Safety] Profanity filter initialized');
}

/**
 * Check if message contains severe abuse
 */
function containsSevereAbuse(message) {
  if (!message) return false;
  return SEVERE_ABUSE_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Check if message contains mild profanity
 */
function containsMildAbuse(message) {
  if (!message || !SAFETY.profanityFilter) return false;
  SAFETY.profanityFilter.lastIndex = 0;
  return SAFETY.profanityFilter.test(message);
}

/**
 * Filter message for profanity (replace with asterisks)
 */
function filterProfanity(message) {
  if (!message || !SAFETY.profanityFilter) return message;
  return message.replace(SAFETY.profanityFilter, (match) => '*'.repeat(match.length));
}

/**
 * Filter and flag a message — main abuse-filter entry point.
 *
 * @param {string} message
 * @param {string} userId
 * @param {string} partyId
 * @returns {{ allowed: boolean, filtered?: string, reason?: string, severity?: string }}
 */
function filterAndFlagMessage(message, userId, partyId) {
  if (!message) return { allowed: true, filtered: message };

  if (containsSevereAbuse(message)) {
    _createModerationEvent({ userId, partyId, messageText: message, filterReason: 'severe_abuse', severity: 'severe' });
    return { allowed: false, reason: 'This message violates community guidelines.', severity: 'severe' };
  }

  if (!checkRepeatSpam(userId, message)) {
    _createModerationEvent({ userId, partyId, messageText: message, filterReason: 'repeat_spam', severity: 'severe' });
    return { allowed: false, reason: 'This message violates community guidelines.', severity: 'severe' };
  }

  if (containsMildAbuse(message)) {
    const filtered = filterProfanity(message);
    return { allowed: true, filtered, severity: 'mild' };
  }

  return { allowed: true, filtered: message };
}

/**
 * Create a server-side moderation event (via API) — internal helper.
 */
function _createModerationEvent({ userId, partyId, messageText, filterReason, severity }) {
  if (typeof fetch === 'function') {
    fetch(API_BASE + '/api/moderation/flag-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, partyId, messageText, filterReason, severity })
    }).catch(err => console.warn('[Moderation] Flag message error:', err.message));
  }
  console.warn(`[Moderation] Flagged message from ${userId} (${severity}): ${filterReason}`);
}

/**
 * Validate message before sending
 */
function validateMessage(message, guestId, userTier) {
  if (userTier === 'FREE') {
    return { allowed: false, reason: 'Free tier users can only send emoji reactions' };
  }

  if (userTier === 'PARTY_PASS') {
    const presetMessages = [
      '🔥 Drop it!', '👏 Amazing!', '❤️ Love this!', '🎉 Party time!',
      '🙌 Yes!', '⚡ Energy!', '💯 Perfect!', '🎵 Great track!'
    ];
    if (!presetMessages.includes(message)) {
      return { allowed: false, reason: 'Party Pass users can only send preset messages' };
    }
  }

  if (isGuestMuted(guestId)) {
    return { allowed: false, reason: 'You have been muted by the host' };
  }

  if (!checkSpamCooldown(guestId)) {
    return { allowed: false, reason: 'Please wait before sending another message' };
  }

  const partyId = (typeof state !== 'undefined' && state.partyCode) ? state.partyCode : null;
  const filterResult = filterAndFlagMessage(message, guestId, partyId);
  if (!filterResult.allowed) {
    return { allowed: false, reason: filterResult.reason };
  }

  return { allowed: true, message: filterResult.filtered || message };
}

/**
 * Set safe volume start (gradual ramp-up)
 */
function setSafeVolumeStart(audioElement) {
  if (!audioElement) return;
  audioElement.volume = SAFETY.safeVolumeStartPercent / 100;
  console.log(`[Safety] Audio starting at safe volume: ${SAFETY.safeVolumeStartPercent}%`);
}

/**
 * Apply volume limiter
 */
function applyVolumeLimiter(volume) {
  const limitedVolume = Math.min(volume, SAFETY.volumeLimitPercent);
  if (volume > SAFETY.volumeLimitPercent) {
    console.warn(`[Safety] Volume limited from ${volume}% to ${SAFETY.volumeLimitPercent}%`);
  }
  return limitedVolume;
}

/**
 * Report a user for abuse (sends to backend)
 */
function reportUser(guestId, reason, description) {
  console.log(`[Safety] User reported: ${guestId}, reason: ${reason}`);
  SAFETY.reportedUsers.add(guestId);

  if (typeof fetch === 'function') {
    const partyId = (typeof state !== 'undefined' && state.partyCode) ? state.partyCode : null;
    fetch(API_BASE + '/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ type: 'user', targetId: guestId, partyId, reason, description: description || '' })
    }).catch(err => console.warn('[Report] Submit error:', err.message));
  }

  return { success: true, message: 'Report submitted. Our team will review it.' };
}

/**
 * Report a track for copyright or inappropriate content
 */
function reportTrack(trackInfo, reason, description) {
  console.log(`[Safety] Track reported: ${JSON.stringify(trackInfo)}, reason: ${reason}`);

  if (typeof fetch === 'function') {
    const partyId = (typeof state !== 'undefined' && state.partyCode) ? state.partyCode : null;
    // Evidence snapshot: metadata only, no media copy
    const evidence = {
      trackId: trackInfo.id || null,
      provider: trackInfo.provider || null,
      providerRef: trackInfo.providerRef || null,
      title: trackInfo.title || null,
      artist: trackInfo.artist || null,
      queuePosition: trackInfo.queuePosition || null,
      playbackTimestamp: trackInfo.playbackTimestamp || null,
      sourceUrl: trackInfo.sourceUrl || null
    };

    fetch(API_BASE + '/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        type: 'track',
        targetId: trackInfo.id || trackInfo.title || 'unknown',
        partyId, reason, description: description || '', evidence
      })
    }).catch(err => console.warn('[Report] Submit error:', err.message));
  }

  return { success: true, message: 'Track report submitted.' };
}

/**
 * Report a message
 */
function reportMessage(messageId, messageText, senderId, reason, description) {
  console.log(`[Safety] Message reported: ${messageId}, reason: ${reason}`);

  if (typeof fetch === 'function') {
    const partyId = (typeof state !== 'undefined' && state.partyCode) ? state.partyCode : null;
    fetch(API_BASE + '/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        type: 'message', targetId: messageId, partyId,
        reportedUserId: senderId, reason, description: description || '',
        evidence: { messageText }
      })
    }).catch(err => console.warn('[Report] Submit error:', err.message));
  }

  return { success: true, message: 'Message report submitted.' };
}

/**
 * Report a party
 */
function reportParty(partyId, hostId, reason, description) {
  console.log(`[Safety] Party reported: ${partyId}, reason: ${reason}`);

  if (typeof fetch === 'function') {
    fetch(API_BASE + '/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        type: 'party', targetId: partyId, partyId,
        reportedUserId: hostId || null, reason, description: description || ''
      })
    }).catch(err => console.warn('[Report] Submit error:', err.message));
  }

  return { success: true, message: 'Party report submitted.' };
}

/**
 * Get moderation status for display
 */
function getModerationStatus() {
  return {
    mutedCount: MODERATION.mutedGuests.size,
    blockedCount: MODERATION.blockedGuests.size,
    kickedCount: MODERATION.kickedGuests.size,
    reportedCount: SAFETY.reportedUsers.size
  };
}

// Export functions if in module environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initModeration,
    kickGuest,
    muteGuest,
    unmuteGuest,
    blockGuest,
    isGuestMuted,
    isGuestBlocked,
    checkSpamCooldown,
    checkRepeatSpam,
    filterProfanity,
    filterAndFlagMessage,
    containsSevereAbuse,
    containsMildAbuse,
    validateMessage,
    setSafeVolumeStart,
    applyVolumeLimiter,
    reportUser,
    reportTrack,
    reportMessage,
    reportParty,
    getModerationStatus,
    MODERATION,
    SAFETY,
    MILD_ABUSE_WORDS,
    SEVERE_ABUSE_PATTERNS,
    MAX_REPEAT_MESSAGES
  };
}
