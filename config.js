/**
 * Central backend configuration.
 *
 * API_BASE is the root URL used for all frontend API calls and WebSocket
 * connections.
 *
 * - Capacitor (native iOS / Android): the HTML is loaded from the local
 *   device (capacitor://localhost), so we need the explicit production URL.
 * - Web browser (local dev, CI, production Cloud Run): the page is served by
 *   the same Express server that handles the API, so an empty string works —
 *   fetch('/api/...') automatically targets the correct origin.
 *
 * The server also serves this file dynamically via a /config.js route (see
 * server.js), which returns the same logic.  The static file is used only
 * when loading directly from the dist/ folder (Capacitor build).
 */
const API_BASE = (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform())
  ? 'https://syncspeaker-262593928124.us-central1.run.app'
  : '';
