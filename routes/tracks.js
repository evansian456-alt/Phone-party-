const { Router } = require('express');
const fs = require('fs');

module.exports = function createTracksRouter(context) {
  const {
    db, redis, storageProvider, upload, getPlaybackUrl,
    uploadLimiter, apiLimiter, normalizePlatformTrackRef,
    TRACK_MAX_BYTES, safeJsonParse, IS_PRODUCTION, parties
  } = context;
  const router = Router();
  const { customAlphabet } = require('nanoid');
  const WebSocket = require('ws');

  // POST /api/tracks/presign-put - Generate presigned URL for direct-to-R2 upload
  router.post('/api/tracks/presign-put', async (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[HTTP] POST /api/tracks/presign-put at ${timestamp}`);

    try {
      const { filename, contentType, sizeBytes } = req.body;

      if (!filename || typeof filename !== 'string' || filename.trim() === '') {
        return res.status(400).json({ error: 'filename is required and must be a non-empty string' });
      }

      if (!contentType || typeof contentType !== 'string') {
        return res.status(400).json({ error: 'contentType is required and must be a string' });
      }

      if (!contentType.startsWith('audio/')) {
        return res.status(400).json({ error: 'contentType must start with "audio/"' });
      }

      if (sizeBytes === undefined || sizeBytes === null) {
        return res.status(400).json({ error: 'sizeBytes is required' });
      }

      if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes)) {
        return res.status(400).json({ error: 'sizeBytes must be a finite number' });
      }

      if (sizeBytes <= 0) {
        return res.status(400).json({ error: 'sizeBytes must be greater than 0' });
      }

      if (sizeBytes > TRACK_MAX_BYTES) {
        return res.status(400).json({ error: `sizeBytes exceeds maximum allowed size of ${TRACK_MAX_BYTES} bytes` });
      }

      // Validate storage provider is ready and supports presigned URLs
      if (!storageProvider) {
        return res.status(503).json({ error: 'Storage provider not ready' });
      }

      // Check if storage provider supports presigned URLs (S3 only)
      if (typeof storageProvider.generatePresignedPutUrl !== 'function') {
        return res.status(400).json({
          error: 'Presigned uploads not supported',
          message: 'Presigned uploads require S3-compatible storage. Use the standard upload endpoint instead.'
        });
      }

      // Generate unique track ID
      const trackId = customAlphabet('1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', 12)();

      // Generate presigned PUT URL
      const { putUrl, key } = await storageProvider.generatePresignedPutUrl(trackId, {
        contentType,
        originalName: filename
      });

      // Generate playback URL using PHASE 1 helper
      const trackUrl = getPlaybackUrl(trackId, key);

      console.log(`[HTTP] Presigned PUT URL generated for trackId: ${trackId}, key: ${key}`);

      res.json({
        ok: true,
        trackId,
        key,
        putUrl,
        trackUrl
      });
    } catch (error) {
      console.error(`[HTTP] Error generating presigned URL:`, error);
      res.status(500).json({
        error: 'Failed to generate presigned URL',
        details: error.message
      });
    }
  });

  // POST /api/upload-track - Upload audio file from host (DEPRECATED: Use presign-put for production)
  router.post('/api/upload-track', uploadLimiter, upload.single('audio'), async (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[HTTP] POST /api/upload-track at ${timestamp}`);

    let tempFilePath = null;

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' });
      }

      // Check storage provider is ready
      if (!storageProvider) {
        console.error('[HTTP] Storage provider not initialized');
        // Clean up temp file if present
        if (req.file.path) {
          try {
            fs.unlinkSync(req.file.path);
          } catch (cleanupError) {
            console.warn(`[HTTP] Warning: Failed to cleanup temp file ${req.file.path}:`, cleanupError.message);
          }
        }
        return res.status(503).json({ error: 'Storage service not available' });
      }

      // Generate unique track ID
      const trackId = customAlphabet('1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', 12)();

      // Get file info - handle both memory and disk storage
      const originalName = req.file.originalname;
      const sizeBytes = req.file.size;
      const contentType = req.file.mimetype;

      // For disk storage, use file path; for memory storage, use buffer
      tempFilePath = req.file.path;
      const fileData = req.file.buffer || fs.createReadStream(tempFilePath);

      // Upload to storage provider
      const uploadResult = await storageProvider.upload(trackId, fileData, {
        contentType,
        originalName,
        size: sizeBytes
      });

      // Clean up temp file after successful upload
      if (tempFilePath) {
        try {
          fs.unlinkSync(tempFilePath);
          tempFilePath = null;
        } catch (cleanupError) {
          console.warn(`[HTTP] Warning: Failed to cleanup temp file ${tempFilePath}:`, cleanupError.message);
        }
      }

      // PHASE 1: Use helper to determine best playback URL (CDN/R2 direct or proxy)
      let trackUrl = getPlaybackUrl(trackId, uploadResult.key);

      // In development (no PUBLIC_BASE_URL), use the request's origin for a full URL
      if (trackUrl.startsWith('/') && !process.env.PUBLIC_BASE_URL) {
        trackUrl = `${req.protocol}://${req.get('host')}${trackUrl}`;
      }

      console.log(`[HTTP] Track uploaded: ${trackId}, file: ${originalName}, size: ${sizeBytes} bytes, storage: ${uploadResult.key}`);
      console.log(`[HTTP] Track will be accessible at: ${trackUrl}`);

      // For now, we can't easily get duration without audio processing library
      // We'll set it to null and let the client determine it
      const durationMs = null;

      res.json({
        ok: true,
        trackId,
        trackUrl,
        title: originalName,
        sizeBytes: uploadResult.size,
        contentType: uploadResult.contentType,
        durationMs,
        filename: originalName
      });
    } catch (error) {
      console.error(`[HTTP] Error uploading track:`, error);

      // Clean up temp file on error
      if (tempFilePath) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupError) {
          console.warn(`[HTTP] Warning: Failed to cleanup temp file ${tempFilePath}:`, cleanupError.message);
        }
      }

      res.status(500).json({
        error: 'Failed to upload track',
        details: error.message
      });
    }
  });

  // POST /api/set-party-track - Set current track for a party and broadcast to guests
  router.post('/api/set-party-track', async (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[HTTP] POST /api/set-party-track at ${timestamp}`);

    try {
      const { partyCode, trackId, trackUrl, filename, sizeBytes, contentType } = req.body;

      if (!partyCode) {
        return res.status(400).json({ error: 'Party code is required' });
      }

      if (!trackUrl) {
        return res.status(400).json({ error: 'Track URL is required' });
      }

      // Find party in local memory
      const party = parties.get(partyCode);
      if (!party) {
        return res.status(404).json({ error: 'Party not found' });
      }

      // Update party state with track info
      party.currentTrack = {
        trackId,
        trackUrl,
        filename,
        sizeBytes,
        contentType,
        setAt: Date.now()
      };

      console.log(`[HTTP] Track set for party ${partyCode}: ${filename}`);

      // Broadcast TRACK_READY to all party members
      const message = JSON.stringify({
        t: "TRACK_READY",
        track: {
          trackId,
          trackUrl,
          filename,
          sizeBytes,
          contentType
        }
      });

      let broadcastCount = 0;
      party.members.forEach(m => {
        if (m.ws.readyState === WebSocket.OPEN) {
          m.ws.send(message);
          broadcastCount++;
        }
      });

      console.log(`[HTTP] TRACK_READY broadcast to ${broadcastCount} members in party ${partyCode}`);

      res.json({
        ok: true,
        broadcastCount
      });
    } catch (error) {
      console.error(`[HTTP] Error setting party track:`, error);
      res.status(500).json({
        error: 'Failed to set party track',
        details: error.message
      });
    }
  });

  // Endpoint to stream audio tracks with Range support (required for seeking and mobile playback)
  router.get('/api/track/:trackId', async (req, res) => {
    const timestamp = new Date().toISOString();
    const trackId = req.params.trackId;
    console.log(`[HTTP] GET /api/track/${trackId} at ${timestamp}`);

    try {
      // Check storage provider is ready
      if (!storageProvider) {
        console.error('[HTTP] Storage provider not initialized');
        return res.status(503).json({ error: 'Storage service not available' });
      }

      // Get metadata
      const metadata = await storageProvider.getMetadata(trackId);
      if (!metadata) {
        console.log(`[HTTP] Track not found: ${trackId}`);
        return res.status(404).json({ error: 'Track not found' });
      }

      const fileSize = metadata.size;
      const contentType = metadata.contentType || 'audio/mpeg';

      // Parse Range header
      const range = req.headers.range;

      if (range) {
        // Parse range header (e.g., "bytes=0-1023")
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        // Validate range
        if (start >= fileSize || end >= fileSize || start > end) {
          console.log(`[HTTP] Invalid range for track ${trackId}: ${start}-${end}/${fileSize}`);
          res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
          return res.end();
        }

        const chunksize = (end - start) + 1;

        // Stream from storage provider with range
        const streamResult = await storageProvider.stream(trackId, { start, end });
        if (!streamResult) {
          return res.status(404).json({ error: 'Track not found' });
        }

        const head = {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': contentType,
        };

        console.log(`[HTTP] Streaming track ${trackId} with range: ${start}-${end}/${fileSize}`);
        res.writeHead(206, head);
        streamResult.stream.pipe(res);
      } else {
        // No range header - send entire file
        const streamResult = await storageProvider.stream(trackId);
        if (!streamResult) {
          return res.status(404).json({ error: 'Track not found' });
        }

        const head = {
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
        };

        console.log(`[HTTP] Streaming entire track ${trackId}, size: ${fileSize}`);
        res.writeHead(200, head);
        streamResult.stream.pipe(res);
      }
    } catch (error) {
      console.error(`[HTTP] Error streaming track ${trackId}:`, error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Failed to stream track',
          details: error.message
        });
      }
    }
  });

  return router;
};
