/**
 * Official App Deep Link Builder
 *
 * Generates platform-specific deep links and web fallback URLs for
 * YouTube, Spotify, and SoundCloud tracks.
 *
 * Used by:
 *  - Frontend (app.js) for auto-launch and "Open in App" buttons
 *  - Unit tests (official-app-sync.test.js)
 */

const {
  normalizeYouTubeRef,
  normalizeSpotifyRef,
  normalizeSoundCloudRef
} = require('./platform-normalizer');

/**
 * Build a platform deep link and web fallback URL for a track reference.
 *
 * @param {string} platform - 'youtube' | 'spotify' | 'soundcloud' (case-insensitive)
 * @param {string} trackRef - Platform-specific track reference (URL, URI, or ID)
 * @returns {{ deepLink: string, webUrl: string }}
 * @throws {Error} If the platform is unsupported or trackRef is invalid
 */
function buildOfficialAppLink(platform, trackRef) {
  if (!platform || typeof platform !== 'string') {
    throw new Error('platform must be a non-empty string');
  }
  if (!trackRef || typeof trackRef !== 'string') {
    throw new Error('trackRef must be a non-empty string');
  }

  switch (platform.toLowerCase()) {
    case 'youtube': {
      const videoId = normalizeYouTubeRef(trackRef);
      return {
        deepLink: `vnd.youtube://${videoId}`,
        webUrl: `https://www.youtube.com/watch?v=${videoId}`
      };
    }

    case 'spotify': {
      const uri = normalizeSpotifyRef(trackRef);
      // uri is "spotify:track:XXXX" – extract the track ID portion
      const trackId = uri.split(':')[2];
      return {
        deepLink: uri,
        webUrl: `https://open.spotify.com/track/${trackId}`
      };
    }

    case 'soundcloud': {
      const ref = normalizeSoundCloudRef(trackRef);
      // Numeric ID: construct a deep link with the numeric ID
      if (/^\d+$/.test(ref)) {
        return {
          deepLink: `soundcloud://sounds:${ref}`,
          webUrl: `https://soundcloud.com/tracks/${ref}`
        };
      }
      // Canonical URL: use the URL as the web fallback; deep link uses the URL path
      return {
        deepLink: `soundcloud://sounds:${encodeURIComponent(ref)}`,
        webUrl: ref
      };
    }

    default:
      throw new Error(
        `Unsupported platform: "${platform}". Must be youtube, spotify, or soundcloud.`
      );
  }
}

module.exports = { buildOfficialAppLink };
