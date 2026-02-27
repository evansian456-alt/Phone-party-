/**
 * Platform Track Reference Normalizer
 *
 * Parses and normalizes track references for all three supported platforms:
 *   - YouTube  : URL or videoId  -> canonical 11-char videoId
 *   - Spotify  : URL or URI or ID -> canonical spotify:track:XXXX URI
 *   - SoundCloud: URL or numeric ID -> normalized URL path or numeric ID
 */

/**
 * Extract YouTube videoId from a URL or validate a raw ID.
 * @param {string} ref - YouTube URL or videoId
 * @returns {string} videoId
 */
function normalizeYouTubeRef(ref) {
  if (!ref || typeof ref !== 'string') throw new Error('YouTube trackRef must be a non-empty string');

  // Try URL parsing first
  try {
    const url = new URL(ref);
    // youtu.be/ID
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1).split('?')[0].split('/')[0];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }
    if (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com' ||
        url.hostname === 'm.youtube.com' || url.hostname === 'youtube-nocookie.com' ||
        url.hostname === 'www.youtube-nocookie.com') {
      // /watch?v=ID
      const v = url.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      // /shorts/ID or /embed/ID or /v/ID
      const m = url.pathname.match(/\/(?:shorts|embed|v)\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch (_) {
    // Not a URL – fall through to raw ID check
  }

  // Bare videoId (exactly 11 base64url characters)
  if (/^[a-zA-Z0-9_-]{11}$/.test(ref)) return ref;

  throw new Error(`Invalid YouTube trackRef: "${ref}"`);
}

/**
 * Normalize a Spotify reference to canonical URI format: spotify:track:ID
 * @param {string} ref - Spotify URL, URI (spotify:track:ID), or bare track ID
 * @returns {string} canonical spotify:track:ID URI
 */
function normalizeSpotifyRef(ref) {
  if (!ref || typeof ref !== 'string') throw new Error('Spotify trackRef must be a non-empty string');

  // Already a canonical URI
  if (/^spotify:track:[a-zA-Z0-9]{22}$/.test(ref)) return ref;

  // open.spotify.com/track/ID
  try {
    const url = new URL(ref);
    if (url.hostname === 'open.spotify.com' || url.hostname === 'spotify.com') {
      const m = url.pathname.match(/\/track\/([a-zA-Z0-9]+)/);
      if (m) return `spotify:track:${m[1]}`;
    }
  } catch (_) {
    // Not a URL
  }

  // spotify:track:ID (any length variation)
  const uriMatch = ref.match(/^spotify:track:([a-zA-Z0-9]+)$/);
  if (uriMatch) return `spotify:track:${uriMatch[1]}`;

  // Bare track ID (alphanumeric, 10+ chars)
  if (/^[a-zA-Z0-9]{10,}$/.test(ref)) return `spotify:track:${ref}`;

  throw new Error(`Invalid Spotify trackRef: "${ref}"`);
}

/**
 * Normalize a SoundCloud reference to either a numeric track ID or a canonical URL path.
 * @param {string} ref - SoundCloud URL, numeric ID, or api path
 * @returns {string} numeric ID or normalized URL path
 */
function normalizeSoundCloudRef(ref) {
  if (!ref || typeof ref !== 'string') throw new Error('SoundCloud trackRef must be a non-empty string');

  // Numeric ID
  if (/^\d+$/.test(ref.trim())) return ref.trim();

  // api.soundcloud.com/tracks/ID
  const apiMatch = ref.match(/\/tracks\/(\d+)/);
  if (apiMatch) return apiMatch[1];

  // soundcloud.com URL – normalize to origin + pathname (drop query/hash)
  try {
    const url = new URL(ref);
    if (url.hostname === 'soundcloud.com' || url.hostname === 'www.soundcloud.com') {
      // /artist/track-slug is the canonical form
      const normalized = `${url.origin}${url.pathname}`.replace(/\/$/, '');
      return normalized;
    }
  } catch (_) {
    // Not a URL
  }

  throw new Error(`Invalid SoundCloud trackRef: "${ref}"`);
}

/**
 * Normalize a platform-specific track reference.
 *
 * @param {string} platform - 'youtube' | 'spotify' | 'soundcloud'
 * @param {string} ref      - Raw track reference (URL, URI, or ID)
 * @returns {string} Normalized canonical reference
 * @throws {Error} If the platform is unsupported or the reference is invalid
 */
function normalizePlatformTrackRef(platform, ref) {
  if (!platform || typeof platform !== 'string') throw new Error('platform must be a non-empty string');
  switch (platform.toLowerCase()) {
    case 'youtube':    return normalizeYouTubeRef(ref);
    case 'spotify':    return normalizeSpotifyRef(ref);
    case 'soundcloud': return normalizeSoundCloudRef(ref);
    default: throw new Error(`Unsupported platform: "${platform}". Must be youtube, spotify, or soundcloud.`);
  }
}

module.exports = {
  normalizePlatformTrackRef,
  normalizeYouTubeRef,
  normalizeSpotifyRef,
  normalizeSoundCloudRef
};
