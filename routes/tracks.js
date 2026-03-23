'use strict';
const express = require('express');
const fs = require('fs');
const WebSocket = require('ws');

const uploadEntitlement = require('../upload-entitlement');
const uploadConfig      = require('../upload-config');

module.exports = function createTracksRouter(deps) {
  const {
    db, redis, authMiddleware, upload, uploadLimiter, apiLimiter,
    getPlaybackUrl, parties, partySyncEngines, TEST_MODE, DEBUG_MODE,
    INSTANCE_ID, validatePayload, logValidationFailure, normalizePlatformTrackRef,
    safeJsonParse, normalizePartyCode, loadPartyState, savePartyState,
    TRACK_MAX_BYTES, fallbackPartyStorage,
    getPartyFromRedis, setPartyInRedis, PARTY_KEY_PREFIX,
    SYNC_TEST_MODE, customAlphabet,
    checkUserEntitlements,
  } = deps;

  const router = express.Router();

  // Access mutable variables via deps
  const redisReady = deps.redisReady;
  const redisConnectionError = deps.redisConnectionError;

  // ── GET /api/uploads/status?partyCode=XXX ─────────────────────────────────
  // Returns the caller's upload entitlement state for a party.
  // Used by the frontend to render the correct upload CTA / locked state.
  router.get("/uploads/status", authMiddleware.requireAuth, async (req, res) => {
    try {
      const userId    = req.user?.id || req.user?.userId;
      const partyCode = (req.query.partyCode || '').toUpperCase().trim();

      const entitlements = await checkUserEntitlements(userId);
      const access       = uploadEntitlement.checkUploadAccess(entitlements);

      if (!access.allowed) {
        return res.json({
          allowed: false,
          tier: 'FREE',
          message: access.upgradeMessage,
          uiState: 'locked',
        });
      }

      if (access.tier === 'PRO_MONTHLY') {
        return res.json({
          allowed: true,
          tier: 'PRO_MONTHLY',
          uiState: 'premium',
          maxFileMB: uploadConfig.MONTHLY_MAX_FILE_MB,
          message: 'Unlimited uploads',
        });
      }

      // PARTY_PASS — return count remaining
      if (!partyCode) {
        return res.json({
          allowed: true,
          tier: 'PARTY_PASS',
          uiState: 'limited',
          maxFileMB: uploadConfig.PARTY_PASS_MAX_FILE_MB,
          message: `Upload up to ${uploadConfig.PARTY_PASS_UPLOAD_LIMIT} songs for this party`,
        });
      }

      const limitCheck = await uploadEntitlement.checkPartyPassUploadLimit(db, partyCode);
      return res.json({
        allowed:    limitCheck.allowed,
        tier:       'PARTY_PASS',
        used:       limitCheck.used,
        limit:      limitCheck.limit,
        remaining:  limitCheck.remaining,
        addons:     limitCheck.addons,
        maxFileMB:  uploadConfig.PARTY_PASS_MAX_FILE_MB,
        uiState:    limitCheck.allowed ? 'limited' : 'limit_reached',
        message:    limitCheck.allowed
          ? `${limitCheck.remaining} of ${limitCheck.limit} uploads remaining for this party`
          : `You've used all ${limitCheck.limit} uploads for this party`,
        upsell:     limitCheck.upsell || null,
      });
    } catch (err) {
      console.error('[HTTP] GET /api/uploads/status error:', err);
      res.status(500).json({ error: 'Failed to get upload status' });
    }
  });

  // ── POST /api/uploads/grant-addon ─────────────────────────────────────────
  // Grant an extra-song add-on for a party (called after billing confirms purchase).
  router.post("/uploads/grant-addon", authMiddleware.requireAdmin, async (req, res) => {
    try {
      const { partyCode, userId, extraSongs, purchaseRef } = req.body;
      if (!partyCode || !userId || !extraSongs) {
        return res.status(400).json({ error: 'partyCode, userId, and extraSongs are required' });
      }
      const bundleSizes = uploadConfig.EXTRA_SONG_BUNDLE_SIZES;
      if (!bundleSizes.includes(Number(extraSongs))) {
        return res.status(400).json({
          error: `extraSongs must be one of: ${bundleSizes.join(', ')}`,
        });
      }
      const row = await uploadEntitlement.grantUploadAddon(db, {
        partyCode: partyCode.toUpperCase().trim(),
        userId,
        extraSongs: Number(extraSongs),
        purchaseRef: purchaseRef || null,
      });
      console.log(`[HTTP] Upload add-on granted: party=${partyCode} user=${userId} extra=${extraSongs}`);
      res.json({ ok: true, addon: row });
    } catch (err) {
      console.error('[HTTP] POST /api/uploads/grant-addon error:', err);
      res.status(500).json({ error: 'Failed to grant upload add-on' });
    }
  });

  // ── GET /admin/uploads/stats ──────────────────────────────────────────────
  // Admin-only: upload counts and storage by user and party.
  router.get("/admin/uploads/stats", authMiddleware.requireAdmin, async (req, res) => {
    try {
      const [byUser, byParty, suspicious] = await Promise.all([
        uploadEntitlement.getUploadStatsByUser(db),
        uploadEntitlement.getUploadStatsByParty(db),
        uploadEntitlement.getSuspiciousUploaders(db),
      ]);
      res.json({ byUser, byParty, suspicious });
    } catch (err) {
      console.error('[HTTP] GET /admin/uploads/stats error:', err);
      res.status(500).json({ error: 'Failed to get upload stats' });
    }
  });

  router.post("/tracks/presign-put", authMiddleware.requireAuth, uploadLimiter, async (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[HTTP] POST /api/tracks/presign-put at ${timestamp}`);
    
    try {
      const { filename, contentType, sizeBytes, partyCode: rawPartyCode } = req.body;
      const userId    = req.user?.id || req.user?.userId;
      const partyCode = rawPartyCode ? rawPartyCode.toUpperCase().trim() : null;

      // ── Entitlement gate ─────────────────────────────────────────────────
      const entitlements = await checkUserEntitlements(userId);
      const access       = uploadEntitlement.checkUploadAccess(entitlements);

      if (!access.allowed) {
        return res.status(403).json({
          error: 'Uploads require a Party Pass or Monthly subscription.',
          code:  'UPLOAD_NOT_ENTITLED',
          upgradeMessage: access.upgradeMessage,
        });
      }

      const tier = access.tier; // 'PARTY_PASS' | 'PRO_MONTHLY'

      // ── File validation (extension + MIME + size) ────────────────────────
      const fileValidation = uploadEntitlement.validateUploadFile({
        filename,
        mimeType: contentType,
        sizeBytes,
        tier,
      });
      if (!fileValidation.valid) {
        return res.status(400).json({ error: fileValidation.error });
      }

      // ── Party Pass upload-count gate ─────────────────────────────────────
      if (tier === 'PARTY_PASS') {
        if (!partyCode) {
          return res.status(400).json({ error: 'partyCode is required for Party Pass uploads.' });
        }
        const limitCheck = await uploadEntitlement.checkPartyPassUploadLimit(db, partyCode);
        if (!limitCheck.allowed) {
          return res.status(403).json({
            error: `Upload limit reached for this party (${limitCheck.limit} songs).`,
            code:  'PARTY_UPLOAD_LIMIT_REACHED',
            used:  limitCheck.used,
            limit: limitCheck.limit,
            upsell: limitCheck.upsell,
          });
        }
      }

      // ── Monthly fair-usage gate ──────────────────────────────────────────
      if (tier === 'PRO_MONTHLY') {
        const fairUsage = await uploadEntitlement.checkMonthlyFairUsage(db, userId);
        if (!fairUsage.allowed) {
          console.warn(`[HTTP] Monthly fair-usage hit: userId=${userId}`);
          return res.status(429).json({
            error: fairUsage.reason,
            code:  'MONTHLY_FAIR_USAGE_EXCEEDED',
          });
        }
      }

      // ── Storage provider checks ──────────────────────────────────────────
      if (!deps.storageProvider) {
        return res.status(503).json({ error: 'Storage provider not ready' });
      }
      
      if (typeof deps.storageProvider.generatePresignedPutUrl !== 'function') {
        return res.status(400).json({ 
          error: 'Presigned uploads not supported',
          message: 'Presigned uploads require S3-compatible storage. Use the standard upload endpoint instead.'
        });
      }
      
      // ── Generate presigned URL ───────────────────────────────────────────
      const { customAlphabet } = require('nanoid');
      const trackId = customAlphabet('1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', 12)();
      
      const { putUrl, key } = await deps.storageProvider.generatePresignedPutUrl(trackId, {
        contentType,
        originalName: filename
      });
      
      const trackUrl = getPlaybackUrl(trackId, key);
      
      console.log(`[HTTP] Presigned PUT URL generated for trackId: ${trackId}, key: ${key}`);

      // ── Record the pending upload (to count against limits) ──────────────
      try {
        const entitlementType = tier === 'PRO_MONTHLY' ? 'PRO_MONTHLY' : 'PARTY_PASS';
        await uploadEntitlement.recordUpload(db, {
          partyCode:         partyCode || 'PRESIGN',
          uploaderUserId:    userId,
          trackId,
          storageKey:        key,
          originalFilename:  filename,
          sizeBytes,
          mimeType:          contentType,
          entitlementType,
        });
      } catch (recordErr) {
        // Non-fatal: log but don't block the upload
        console.error('[HTTP] Warning: failed to record upload metadata:', recordErr.message);
      }
      
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

  // POST /upload-track - Upload audio file from host (DEPRECATED: Use presign-put for production)
  router.post("/upload-track", authMiddleware.requireAuth, uploadLimiter, upload.single('audio'), async (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[HTTP] POST /api/upload-track at ${timestamp}`);
    
    let tempFilePath = null;
    
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' });
      }

      const userId    = req.user?.id || req.user?.userId;
      const partyCode = req.body.partyCode ? req.body.partyCode.toUpperCase().trim() : null;

      // ── Entitlement gate ─────────────────────────────────────────────────
      const entitlements = await checkUserEntitlements(userId);
      const access       = uploadEntitlement.checkUploadAccess(entitlements);
      if (!access.allowed) {
        if (req.file.path) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
        return res.status(403).json({
          error: 'Uploads require a Party Pass or Monthly subscription.',
          code:  'UPLOAD_NOT_ENTITLED',
          upgradeMessage: access.upgradeMessage,
        });
      }

      const tier = access.tier;

      // ── File validation ──────────────────────────────────────────────────
      const fileValidation = uploadEntitlement.validateUploadFile({
        filename:  req.file.originalname,
        mimeType:  req.file.mimetype,
        sizeBytes: req.file.size,
        tier,
      });
      if (!fileValidation.valid) {
        if (req.file.path) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
        return res.status(400).json({ error: fileValidation.error });
      }

      // ── Party Pass upload-count gate ─────────────────────────────────────
      if (tier === 'PARTY_PASS') {
        if (!partyCode) {
          if (req.file.path) {
            try { fs.unlinkSync(req.file.path); } catch (_) {}
          }
          return res.status(400).json({ error: 'partyCode is required for Party Pass uploads.' });
        }
        const limitCheck = await uploadEntitlement.checkPartyPassUploadLimit(db, partyCode);
        if (!limitCheck.allowed) {
          if (req.file.path) {
            try { fs.unlinkSync(req.file.path); } catch (_) {}
          }
          return res.status(403).json({
            error: `Upload limit reached for this party (${limitCheck.limit} songs).`,
            code:  'PARTY_UPLOAD_LIMIT_REACHED',
            used:  limitCheck.used,
            limit: limitCheck.limit,
            upsell: limitCheck.upsell,
          });
        }
      }

      // ── Monthly fair-usage gate ──────────────────────────────────────────
      if (tier === 'PRO_MONTHLY') {
        const fairUsage = await uploadEntitlement.checkMonthlyFairUsage(db, userId);
        if (!fairUsage.allowed) {
          if (req.file.path) {
            try { fs.unlinkSync(req.file.path); } catch (_) {}
          }
          console.warn(`[HTTP] Monthly fair-usage hit: userId=${userId}`);
          return res.status(429).json({
            error: fairUsage.reason,
            code:  'MONTHLY_FAIR_USAGE_EXCEEDED',
          });
        }
      }

      // Check storage provider is ready
      if (!deps.storageProvider) {
        console.error('[HTTP] Storage provider not initialized');
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
      const uploadResult = await deps.storageProvider.upload(trackId, fileData, {
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

      // ── Record upload metadata ───────────────────────────────────────────
      try {
        const entitlementType = tier === 'PRO_MONTHLY' ? 'PRO_MONTHLY' : 'PARTY_PASS';
        await uploadEntitlement.recordUpload(db, {
          partyCode:         partyCode || 'DIRECT',
          uploaderUserId:    userId,
          trackId,
          storageKey:        uploadResult.key,
          originalFilename:  originalName,
          sizeBytes,
          mimeType:          contentType,
          entitlementType,
        });
      } catch (recordErr) {
        console.error('[HTTP] Warning: failed to record upload metadata:', recordErr.message);
      }
      
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

  // POST /set-party-track - Set current track for a party and broadcast to guests
  router.post("/set-party-track", async (req, res) => {
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
  router.get("/track/:trackId", async (req, res) => {
    const timestamp = new Date().toISOString();
    const trackId = req.params.trackId;
    console.log(`[HTTP] GET /api/track/${trackId} at ${timestamp}`);
    
    try {
      // Check storage provider is ready
      if (!deps.storageProvider) {
        console.error('[HTTP] Storage provider not initialized');
        return res.status(503).json({ error: 'Storage service not available' });
      }

      // Get metadata
      const metadata = await deps.storageProvider.getMetadata(trackId);
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
        const streamResult = await deps.storageProvider.stream(trackId, { start, end });
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
        const streamResult = await deps.storageProvider.stream(trackId);
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

  // GET /api/sync/metrics is defined later in this file (see below) with support for
  // both partyId and code parameters and environment gating. Duplicate removed.

  // Debug endpoint to list active parties
  // WARNING: This endpoint is for debugging purposes only and should be
  // protected by authentication or disabled in production environments
  // to prevent abuse and information disclosure
  router.get("/debug/parties", async (req, res) => {
    try {
      const now = Date.now();
      const parties_list = [];
      
      // Collect from local memory
      for (const [code, party] of parties.entries()) {
        const ageMs = now - (party.createdAt || 0);
        const ageMinutes = Math.floor(ageMs / 60000);
        const memberCount = party.members ? party.members.length : 0;
        
        parties_list.push({
          code,
          ageMs,
          ageMinutes,
          createdAt: party.createdAt,
          hostId: party.hostId,
          memberCount,
          chatMode: party.chatMode,
          source: "local"
        });
      }
      
      // Also check Redis for parties not in local memory
      if (redis && deps.redisReady) {
        try {
          const keys = await redis.keys(`${PARTY_KEY_PREFIX}*`);
          for (const key of keys) {
            const code = key.replace(PARTY_KEY_PREFIX, "");
            
            // Skip if already in local memory
            if (parties.has(code)) continue;
            
            const data = await redis.get(key);
            if (data) {
              const partyData = JSON.parse(data);
              const ageMs = now - (partyData.createdAt || 0);
              const ageMinutes = Math.floor(ageMs / 60000);
              
              parties_list.push({
                code,
                ageMs,
                ageMinutes,
                createdAt: partyData.createdAt,
                hostId: partyData.hostId,
                guestCount: partyData.guestCount,
                chatMode: partyData.chatMode,
                source: "redis_only"
              });
            }
          }
        } catch (err) {
          console.error("[debug/parties] Error fetching from Redis:", err.message);
        }
      }
      
      // Also include fallback storage
      for (const [code, party] of fallbackPartyStorage.entries()) {
        // Skip if already in parties list
        if (parties_list.some(p => p.code === code)) continue;
        
        const ageMs = now - (party.createdAt || 0);
        const ageMinutes = Math.floor(ageMs / 60000);
        
        parties_list.push({
          code,
          ageMs,
          ageMinutes,
          createdAt: party.createdAt,
          hostId: party.hostId,
          guestCount: party.guestCount,
          chatMode: party.chatMode,
          source: "fallback"
        });
      }
      
      // Sort by age (oldest first)
      parties_list.sort((a, b) => a.ageMs - b.ageMs);
      
      res.json({
        totalParties: parties_list.length,
        parties: parties_list,
        instanceId: INSTANCE_ID,
        redisReady: deps.redisReady,
        timestamp: now
      });
    } catch (error) {
      console.error("[debug/parties] Error:", error);
      res.status(500).json({ error: "Failed to list parties", details: error.message });
    }
  });

  // Debug endpoint to check a specific party's status
  // GET /debug/party/:code - Returns party existence and status info
  router.get("/debug/party/:code", async (req, res) => {
    try {
      const code = req.params.code.trim().toUpperCase();
      const now = Date.now();
      
      // Get Redis status
      let redisStatus;
      if (!redis || deps.redisConnectionError || !deps.redisReady) {
        redisStatus = "unavailable";
      } else if (redis.status === "ready" && deps.redisReady) {
        redisStatus = "ready";
      } else {
        redisStatus = "error";
      }
      
      // Check if party exists in Redis
      let existsInRedis = false;
      let redisData = null;
      if (redis && deps.redisReady) {
        try {
          redisData = await getPartyFromRedis(code);
          existsInRedis = !!redisData;
        } catch (error) {
          console.error(`[debug/party] Redis error for ${code}:`, error.message);
        }
      }
      
      // Check local memory
      const existsLocally = parties.has(code);
      const localParty = parties.get(code);
      
      res.json({
        code,
        existsInRedis,
        existsLocally,
        redisStatus,
        instanceId: INSTANCE_ID,
        createdAt: redisData?.createdAt || localParty?.createdAt || null,
        ageMs: redisData?.createdAt ? now - redisData.createdAt : null,
        hostId: redisData?.hostId || localParty?.hostId || null,
        guestCount: redisData?.guestCount || 0,
        chatMode: redisData?.chatMode || localParty?.chatMode || null,
        timestamp: now
      });
    } catch (error) {
      console.error("[debug/party] Error:", error);
      res.status(500).json({ error: "Failed to get party info", details: error.message });
    }
  });

  // GET /sync/metrics - Sync metrics snapshot for a party (test mode only)
  // Returns enhanced per-client metrics for the Playwright harness and dashboard.
  // Enabled in SYNC_TEST_MODE or DEBUG mode; returns 404 in production.
  router.get("/sync/metrics", async (req, res) => {
    if (!SYNC_TEST_MODE && process.env.NODE_ENV === 'production') {
      return res.status(404).json({ error: 'Not found' });
    }
    const partyId = req.query.partyId || req.query.code;
    if (!partyId) {
      return res.status(400).json({ error: 'partyId query parameter required' });
    }
    const code = partyId.trim().toUpperCase();
    const syncEngine = partySyncEngines.get(code);
    if (!syncEngine) {
      return res.status(404).json({ error: 'No sync engine found for party', code });
    }
    const stats = syncEngine.getEnhancedStats(code);
    if (SYNC_TEST_MODE) {
      console.log(`[SyncMetrics] ${JSON.stringify(stats)}`);
    }
    return res.json(stats);
  });

  return router;
};
