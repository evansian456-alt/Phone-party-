'use strict';
const express = require('express');

module.exports = function createStreamingRouter(deps) {
  const {
    apiLimiter,
    authMiddleware,
    requireStreamingEnabled,
    requireStreamingEntitled,
    normalizePlatformTrackRef,
    hasStreamingAccess,
    db
  } = deps;

  const router = express.Router();

  router.get('/providers', apiLimiter, requireStreamingEnabled, authMiddleware.requireAuth, requireStreamingEntitled, async (req, res) => {
    try {
      return res.json({
        providers: [
          {
            id: 'youtube',
            name: 'YouTube',
            description: 'Playback starts together using party clock.',
            deepLinkTemplate: 'https://www.youtube.com/watch?v={id}',
            accuracy: '40–150ms',
            syncBadge: 'In-app Sync'
          },
          {
            id: 'spotify',
            name: 'Spotify',
            description: 'Playback occurs in the Spotify app. The app will guide synchronization.',
            deepLinkTemplate: 'spotify:track:{id}',
            webFallback: 'https://open.spotify.com/track/{id}',
            accuracy: 'variable',
            syncBadge: 'External (Best effort)'
          },
          {
            id: 'soundcloud',
            name: 'SoundCloud',
            description: 'Plays inside the app using the SoundCloud widget. Widget playback may require manual resync.',
            widgetUrlTemplate: 'https://w.soundcloud.com/player/?url={url}',
            accuracy: '40–150ms',
            syncBadge: 'In-app Sync'
          }
        ]
      });
    } catch (error) {
      console.error('[StreamingParty] Get providers error:', error.message);
      return res.status(500).json({ error: 'Failed to get providers' });
    }
  });

  router.post('/select-track', apiLimiter, requireStreamingEnabled, authMiddleware.requireAuth, requireStreamingEntitled, async (req, res) => {
    try {
      const { partyCode, provider, trackId, title, artist, artwork } = req.body;

      if (!partyCode || !provider || !trackId) {
        return res.status(400).json({ error: 'partyCode, provider, and trackId are required' });
      }

      const validProviders = ['youtube', 'spotify', 'soundcloud'];
      const providerLower = (provider || '').toLowerCase();
      if (!validProviders.includes(providerLower)) {
        return res.status(400).json({ error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
      }

      // Normalize trackId using platform normalizer (handles URLs, URIs, raw IDs)
      let normalizedId;
      try {
        normalizedId = normalizePlatformTrackRef(providerLower, trackId);
      } catch (err) {
        return res.status(400).json({ error: `Invalid trackId for ${providerLower}: ${err.message}` });
      }

      // Build deep link from the normalized ID
      let deepLink;
      if (providerLower === 'youtube') {
        deepLink = `https://www.youtube.com/watch?v=${encodeURIComponent(normalizedId)}`;
      } else if (providerLower === 'spotify') {
        // normalizedId is already "spotify:track:XXX"
        deepLink = normalizedId;
      } else {
        deepLink = normalizedId; // SoundCloud: numeric ID or canonical URL
      }

      const trackDescriptor = {
        source: providerLower,
        id: normalizedId,
        title: title || null,
        artist: artist || null,
        artwork: artwork || null,
        deepLink
      };

      return res.json({ success: true, trackDescriptor });
    } catch (error) {
      console.error('[StreamingParty] Select track error:', error.message);
      return res.status(500).json({ error: 'Failed to select track' });
    }
  });

  router.get('/search', apiLimiter, requireStreamingEnabled, authMiddleware.requireAuth, requireStreamingEntitled, async (req, res) => {
    try {
      const provider = (req.query.provider || '').toLowerCase();
      const q = (req.query.q || '').trim();

      if (!provider || !q) {
        return res.status(400).json({ error: 'provider and q query parameters are required' });
      }

      if (provider !== 'youtube') {
        return res.status(400).json({ error: `Search is not supported for provider "${provider}". Only youtube is supported.` });
      }

      const apiKey = process.env.YOUTUBE_API_KEY;
      if (!apiKey) {
        // Return empty results when API key is not configured (CI / local dev)
        return res.json({ provider: 'youtube', results: [], warning: 'YOUTUBE_API_KEY not configured' });
      }

      // Call YouTube Data API v3 search endpoint
      const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
      searchUrl.searchParams.set('part', 'snippet');
      searchUrl.searchParams.set('type', 'video');
      searchUrl.searchParams.set('maxResults', '10');
      searchUrl.searchParams.set('q', q);
      searchUrl.searchParams.set('key', apiKey);

      const https = require('https');
      const rawBody = await new Promise((resolve, reject) => {
        https.get(searchUrl.toString(), (resp) => {
          let data = '';
          resp.on('data', chunk => { data += chunk; });
          resp.on('end', () => resolve(data));
          resp.on('error', reject);
        }).on('error', reject);
      });

      const ytResponse = JSON.parse(rawBody);

      if (ytResponse.error) {
        console.error('[StreamingSearch] YouTube API error:', ytResponse.error.message);
        return res.status(502).json({ error: 'YouTube search failed', detail: ytResponse.error.message });
      }

      const results = (ytResponse.items || []).map(item => {
        const videoId = item.id && item.id.videoId ? item.id.videoId : null;
        if (!videoId) return null;
        const snippet = item.snippet || {};
        return {
          id: videoId,
          title: snippet.title || '',
          artist: snippet.channelTitle || '',
          artwork: (snippet.thumbnails && snippet.thumbnails.default && snippet.thumbnails.default.url) || null,
          deepLink: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
        };
      }).filter(Boolean);

      return res.json({ provider: 'youtube', results });
    } catch (error) {
      console.error('[StreamingSearch] Search error:', error.message);
      return res.status(500).json({ error: 'Search failed' });
    }
  });

  router.get('/access', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
    try {
      const featureEnabled = deps.isStreamingPartyEnabled();
      const userId = req.user.userId;
      const upgrades = await db.getOrCreateUserUpgrades(userId);
      const { hasPartyPass, hasPro } = db.resolveEntitlements(upgrades);
      const userObj = { entitlements: { hasPartyPass, hasPro } };
      const entitled = hasStreamingAccess(userObj);
      const allowed = featureEnabled && entitled;

      return res.json({
        allowed,
        featureEnabled,
        entitled,
        reason: !featureEnabled
          ? 'Streaming Party is not available at this time.'
          : !entitled
            ? 'Streaming Party requires Party Pass or Pro.'
            : null
      });
    } catch (error) {
      console.error('[StreamingParty] Access check error:', error.message);
      return res.status(500).json({ error: 'Failed to check streaming access' });
    }
  });

  return router;
};
