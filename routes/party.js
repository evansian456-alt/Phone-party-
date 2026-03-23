'use strict';
const express = require('express');
const WebSocket = require('ws');

// Helper functions for promo code flow (only used by party routes)
async function _getPartyDataForPromo(code, useRedis, getPartyFromRedis, getPartyFromFallback) {
  if (useRedis) {
    try {
      return await getPartyFromRedis(code);
    } catch (_) {
      return getPartyFromFallback(code);
    }
  }
  return getPartyFromFallback(code);
}

async function _savePartyDataForPromo(code, partyData, useRedis, setPartyInRedis, setPartyInFallback) {
  if (useRedis) {
    try {
      await setPartyInRedis(code, partyData);
    } catch (_) {
      setPartyInFallback(code, partyData);
    }
  } else {
    setPartyInFallback(code, partyData);
  }
}

function _updateWsPartyForPromo(code, parties, broadcastRoomState) {
  const wsParty = parties.get(code);
  if (wsParty) {
    wsParty.promoUsed = true;
    wsParty.partyPro = true;
    broadcastRoomState(code);
  }
}

module.exports = function createPartyRouter(deps) {
  const {
    db, redis, authMiddleware, partyCreationLimiter, apiLimiter,
    parties, normalizePartyCode, ErrorMessages, INSTANCE_ID,
    IS_PRODUCTION, ALLOW_FALLBACK_IN_PRODUCTION,
    getRedisErrorType, redisConfigSource, createPartyCommon,
    getPartyFromRedis, getPartyFromFallback, setPartyInRedis, setPartyInFallback,
    normalizePartyData, getMaxAllowedPhones, loadPartyState, savePartyState,
    broadcastRoomState, nanoid, PROMO_CODES, validateHostAuth,
    getPartyMaxPhones, checkUserEntitlements, getTierLimits, storageProvider,
    normalizePlatformTrackRef, normalizeTrack, broadcastToParty, trackPartyEvent,
    persistPlaybackToRedis, metricsService, persistPartyScoreboard,
    PARTY_TTL_MS, PARTY_KEY_PREFIX, getPolicyForTier, isPaidForOfficialAppSyncParty
  } = deps;

  const router = express.Router();

  // Mutable counters — persist in closure for the lifetime of the router instance.
  // The factory is called once at server startup, so these reliably increment.
  // Optional getter/setter hooks allow the parent to share state if needed.
  let nextHostId = deps.getNextHostId ? deps.getNextHostId() : 1;
  let nextHttpGuestSeq = deps.getNextHttpGuestSeq ? deps.getNextHttpGuestSeq() : 1;

  // POST /create-party - Create a new party
  router.post("/create-party", partyCreationLimiter, authMiddleware.optionalAuth, async (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[HTTP] POST /api/create-party at ${timestamp}, instanceId: ${INSTANCE_ID}`, req.body);

    // PHASE 6: Check idempotency key
    const idempotencyKey = req.headers['idempotency-key'];
    if (idempotencyKey) {
      console.log(`[HTTP] Idempotency key received: ${idempotencyKey}`);
    }
    if (idempotencyKey && redis) {
      const cacheKey = `idempotency:create-party:${idempotencyKey}`;

      try {
        // Check if we've seen this request before
        const cachedResponse = await redis.get(cacheKey);
        if (cachedResponse) {
          console.log(`[HTTP] Idempotent request detected, returning cached response for key: ${idempotencyKey}`);
          return res.json(JSON.parse(cachedResponse));
        }
      } catch (err) {
        console.warn('[HTTP] Idempotency check failed, continuing:', err.message);
      }
    } else if (idempotencyKey && (!redis || !deps.redisReady)) {
      // Warn when idempotency key is provided but Redis is unavailable
      console.warn(`[Idempotency] Redis unavailable, proceeding without idempotency`);
    }

    // Extract DJ name and source from request body
    const { djName, source } = req.body;

    // Validate DJ name is provided
    if (!djName || !djName.trim()) {
      console.log("[HTTP] Party creation rejected: DJ name is required");
      return res.status(400).json({ error: "DJ name is required to create a party" });
    }

    // Validate and set source (default to "local" if not provided or invalid)
    const validSources = ["local", "external", "mic"];
    const partySource = validSources.includes(source) ? source : "local";

    // Determine storage backend: prefer Redis, fallback to local storage if Redis unavailable
    const useRedis = redis && deps.redisReady;
    const storageBackend = useRedis ? 'redis' : 'fallback';

    // In production mode, Redis is required UNLESS fallback mode is explicitly allowed
    if (IS_PRODUCTION && !useRedis && !ALLOW_FALLBACK_IN_PRODUCTION) {
      console.error(`[HTTP] Redis required in production but not available, instanceId: ${INSTANCE_ID}`);
      return res.status(503).json({
        error: "Server not ready - Redis unavailable",
        details: "Multi-device party sync requires Redis. Please retry in 20 seconds.",
        instanceId: INSTANCE_ID,
        redisErrorType: deps.redisConnectionError ? getRedisErrorType(deps.redisConnectionError) : 'not_configured',
        redisConfigSource: redisConfigSource,
        timestamp: new Date().toISOString()
      });
    }

    if (!useRedis) {
      console.warn(`[HTTP] Redis not ready, using fallback storage for party creation, instanceId: ${INSTANCE_ID}`);
    }

    try {
      // Use shared party creation function
      const hostId = nextHostId++;
      if (deps.setNextHostId) deps.setNextHostId(nextHostId);
      const { code, partyData } = await createPartyCommon({
        djName: djName,
        source: partySource,
        hostId: hostId,
        hostConnected: false,
        hostUserId: req.user ? req.user.userId : null
      });

      console.log(`[HTTP] Party persisted to ${storageBackend}: ${code}`);

      // Also store in local memory for WebSocket connections
      parties.set(code, {
        host: null, // No WebSocket connection (HTTP-created party)
        members: [],
        chatMode: partyData.chatMode,
        createdAt: partyData.createdAt,
        hostId: partyData.hostId,
        source: partyData.source, // IMPORTANT: Store source in local memory
        partyPro: partyData.partyPro,
        promoUsed: partyData.promoUsed,
        tier: partyData.tier, // IMPORTANT: Store tier in local memory
        partyPassExpiresAt: partyData.partyPassExpiresAt, // IMPORTANT: Store expiry for tier enforcement
        maxPhones: partyData.maxPhones, // IMPORTANT: Store max phones for capacity checks
        djMessages: [],
        currentTrack: null,
        queue: [],
        timeoutWarningTimer: null,
        scoreState: {
          dj: {
            djUserId: null,
            djIdentifier: hostId,
            djName: partyData.djName,
            sessionScore: 0,
            lifetimeScore: 0
          },
          guests: {},
          totalReactions: 0,
          totalMessages: 0,
          currentCrowdEnergy: 0, // Current crowd energy (0-100, guest reactions only)
          peakCrowdEnergy: 0 // Peak crowd energy (guest reactions only)
        },
        reactionHistory: [] // For storing recent emoji/messages
      });

      const totalParties = parties.size;
      const timestamp2 = new Date().toISOString();
      console.log(`[HTTP] Party created: ${code}, hostId: ${hostId}, timestamp: ${timestamp2}, instanceId: ${INSTANCE_ID}, createdAt: ${partyData.createdAt}, totalParties: ${totalParties}, storageBackend: ${storageBackend}`);

      const response = {
        code: code,
        partyCode: code,
        hostId: hostId
      };

      // Add warning if using fallback mode in production
      if (IS_PRODUCTION && !useRedis && ALLOW_FALLBACK_IN_PRODUCTION) {
        response.warning = "fallback_mode_single_instance";
      }

      // PHASE 6: Cache response for idempotency (60s TTL)
      if (idempotencyKey && redis) {
        try {
          const cacheKey = `idempotency:create-party:${idempotencyKey}`;
          await redis.setex(cacheKey, 60, JSON.stringify(response));
        } catch (err) {
          console.warn('[HTTP] Failed to cache idempotent response:', err.message);
        }
      }

      res.json(response);
    } catch (error) {
      console.error(`[HTTP] Error creating party, instanceId: ${INSTANCE_ID}:`, error);
      res.status(500).json({
        error: "Failed to create party",
        details: error.message
      });
    }
  });

  // POST /join-party - Join an existing party
  router.post("/join-party", async (req, res) => {
    const startTime = Date.now();
    console.log("[join-party] start");

    try {
      const timestamp = new Date().toISOString();
      console.log(`[HTTP] POST /api/join-party at ${timestamp}, instanceId: ${INSTANCE_ID}`, req.body);

      // Accept either 'code' or 'partyCode' for backward and forward compatibility
      const partyCode = req.body.partyCode || req.body.code;
      const nickname = req.body.nickname;

      if (!partyCode) {
        console.log("[join-party] end (missing party code)");
        return res.status(400).json({ error: "Party code is required" });
      }

      // Normalize party code: trim and uppercase
      const code = normalizePartyCode(partyCode);

      // Validate party code length
      if (code.length !== 6) {
        console.log(`[join-party] Invalid party code length: ${code.length}`);
        return res.status(400).json({ error: "Party code must be 6 characters" });
      }

      // Generate guest ID and use provided nickname or generate default
      // Use nanoid for HTTP guests to avoid collision with WS client IDs
      const guestId = `guest_${nanoid(10)}`;
      const guestNumber = nextHttpGuestSeq++;
      if (deps.setNextHttpGuestSeq) deps.setNextHttpGuestSeq(nextHttpGuestSeq);
      const guestNickname = nickname || `Guest ${guestNumber}`;

      console.log(`[join-party] Attempting to join party: ${code}, guestId: ${guestId}, nickname: ${guestNickname}, timestamp: ${timestamp}`);

      // Determine storage backend: prefer Redis, fallback to local storage if Redis unavailable
      const useRedis = redis && deps.redisReady;
      const storageBackend = useRedis ? 'redis' : 'fallback';

      // In production mode, Redis is required UNLESS fallback mode is explicitly allowed
      if (IS_PRODUCTION && !useRedis && !ALLOW_FALLBACK_IN_PRODUCTION) {
        console.error(`[join-party] Redis required in production but not available, instanceId: ${INSTANCE_ID}`);
        return res.status(503).json({
          error: "Server not ready - Redis unavailable",
          details: "Multi-device party sync requires Redis. Please retry in 20 seconds.",
          instanceId: INSTANCE_ID,
          redisErrorType: deps.redisConnectionError ? getRedisErrorType(deps.redisConnectionError) : 'not_configured',
          redisConfigSource: redisConfigSource,
          timestamp: new Date().toISOString()
        });
      }

      if (!useRedis) {
        console.warn(`[join-party] Redis not ready, using fallback storage for party lookup, instanceId: ${INSTANCE_ID}`);
      }

      // Read from Redis or fallback storage
      let partyData;
      if (useRedis) {
        try {
          partyData = await getPartyFromRedis(code);
        } catch (error) {
          console.warn(`[join-party] Redis error for party ${code}, trying fallback: ${error.message}`);
          partyData = getPartyFromFallback(code);
        }
      } else {
        partyData = getPartyFromFallback(code);
      }

      const storeReadResult = partyData ? "found" : "not_found";

      if (!partyData) {
        const totalParties = parties.size;
        const localPartyExists = parties.has(code);
        const redisStatusMsg = deps.redisReady ? "ready" : "not_ready";
        const rejectionReason = `Party ${code} not found in ${storageBackend}. Local parties count: ${totalParties}, exists locally: ${localPartyExists}, redisStatus: ${redisStatusMsg}`;
        console.log(`[HTTP] Party join rejected: ${code}, timestamp: ${timestamp}, instanceId: ${INSTANCE_ID}, partyCode: ${code}, exists: false, rejectionReason: ${rejectionReason}, storageBackend: ${storageBackend}, redisStatus: ${redisStatusMsg}`);
        console.log("[join-party] end (party not found)");
        return res.status(404).json({ error: "Party not found or expired" });
      }

      // Check if party has expired or ended
      if (partyData.status === "ended") {
        console.log(`[join-party] Party ${code} has ended`);
        return res.status(410).json({ error: "Party has ended" });
      }

      const now = Date.now();
      if (partyData.expiresAt && now > partyData.expiresAt) {
        console.log(`[join-party] Party ${code} has expired`);
        partyData.status = "expired";
        return res.status(410).json({ error: "Party has expired" });
      }

      // Normalize party data to ensure all fields exist
      const normalizedPartyData = normalizePartyData(partyData);

      // Enforce party capacity limits based on partyPro/partyPass
      const maxAllowed = await getMaxAllowedPhones(code, normalizedPartyData);
      const currentGuestCount = normalizedPartyData.guestCount || 0;

      // Count total devices (host + guests) - host counts as 1 device
      const totalDevices = 1 + currentGuestCount;

      if (totalDevices >= maxAllowed) {
        console.log(`[join-party] Party limit reached: ${code}, current: ${totalDevices}, max: ${maxAllowed}`);
        return res.status(403).json({
          error: `Party limit reached (${maxAllowed} ${maxAllowed === 2 ? 'phones' : 'devices'})`,
          details: maxAllowed === 2 ? "Free parties are limited to 2 phones" : undefined
        });
      }

      // Add guest to party
      if (!partyData.guests) {
        partyData.guests = [];
      }

      // Check if guest already exists (by guestId) and update, otherwise add new
      const existingGuestIndex = partyData.guests.findIndex(g => g.guestId === guestId);
      if (existingGuestIndex >= 0) {
        // Update existing guest
        partyData.guests[existingGuestIndex].nickname = guestNickname;
        partyData.guests[existingGuestIndex].joinedAt = now;
      } else {
        // Add new guest
        partyData.guests.push({
          guestId,
          nickname: guestNickname,
          joinedAt: now
        });
      }

      partyData.guestCount = partyData.guests.length;

      // Save updated party data
      if (useRedis) {
        try {
          await setPartyInRedis(code, partyData);
        } catch (error) {
          console.warn(`[join-party] Redis write failed for ${code}, using fallback: ${error.message}`);
          setPartyInFallback(code, partyData);
        }
      } else {
        setPartyInFallback(code, partyData);
      }

      // Get local party reference (non-blocking)
      const localParty = parties.get(code);

      const partyAge = Date.now() - partyData.createdAt;
      const guestCount = partyData.guestCount || 0;
      const totalParties = parties.size;
      const duration = Date.now() - startTime;

      console.log(`[HTTP] Party joined: ${code}, timestamp: ${timestamp}, instanceId: ${INSTANCE_ID}, partyCode: ${code}, guestId: ${guestId}, exists: true, storeReadResult: ${storeReadResult}, partyAge: ${partyAge}ms, guestCount: ${guestCount}, totalParties: ${totalParties}, duration: ${duration}ms, storageBackend: ${storageBackend}`);

      // Respond with success and guest info
      const response = {
        ok: true,
        success: true, // Backward compatibility with tests
        guestId,
        nickname: guestNickname,
        partyCode: code,
        djName: partyData.djName || "DJ", // Fallback for backward compatibility with old parties
        chatMode: partyData.chatMode || "OPEN" // Include chat mode for initial setup
      };

      // Add warning if using fallback mode in production
      if (IS_PRODUCTION && !useRedis && ALLOW_FALLBACK_IN_PRODUCTION) {
        response.warning = "fallback_mode_single_instance";
      }

      res.json(response);
      console.log("[join-party] end (success)");

      // Fire-and-forget: Update local state asynchronously (non-blocking)
      // This ensures HTTP response is sent immediately
      if (partyData && !localParty) {
        setImmediate(() => {
          try {
            // Re-check if party was created by another request in the meantime
            if (!parties.has(code)) {
              parties.set(code, {
                host: null,
                members: [],
                chatMode: partyData.chatMode || "OPEN",
                createdAt: partyData.createdAt,
                hostId: partyData.hostId
              });
            }
          } catch (err) {
            console.error(`[join-party] Async state update error:`, err);
          }
        });
      }

    } catch (error) {
      console.error(`[HTTP] Error joining party, instanceId: ${INSTANCE_ID}:`, error);
      console.log("[join-party] end (error)");

      if (!res.headersSent) {
        res.status(500).json({
          error: "Failed to join party",
          details: error.message
        });
      }
    }
  });

  // GET /party - Get party state (supports query parameter ?code=XXX)
  router.get("/party", async (req, res) => {
    const timestamp = new Date().toISOString();
    const code = req.query.code ? req.query.code.trim().toUpperCase() : null;

    if (!code) {
      return res.status(400).json({
        error: "Party code is required",
        exists: false
      });
    }

    // Validate party code length
    if (code.length !== 6) {
      return res.status(400).json({
        error: "Party code must be 6 characters",
        exists: false
      });
    }

    console.log(`[HTTP] GET /api/party?code=${code} at ${timestamp}, instanceId: ${INSTANCE_ID}`);

    // Determine storage backend
    const useRedis = redis && deps.redisReady;
    const storageBackend = useRedis ? 'redis' : 'fallback';

    try {
      // Read from Redis or fallback storage
      let partyData;
      if (useRedis) {
        try {
          partyData = await getPartyFromRedis(code);
        } catch (error) {
          console.warn(`[HTTP] Redis error for party ${code}, trying fallback: ${error.message}`);
          partyData = getPartyFromFallback(code);
        }
      } else {
        partyData = getPartyFromFallback(code);
      }

      if (!partyData) {
        console.log(`[HTTP] Party not found: ${code}, storageBackend: ${storageBackend}`);
        return res.json({
          exists: false,
          status: "expired",
          partyCode: code
        });
      }

      // Check if party has expired
      const now = Date.now();
      let status = partyData.status || "active";
      let timeRemainingMs = 0;

      if (partyData.expiresAt) {
        timeRemainingMs = Math.max(0, partyData.expiresAt - now);
        if (timeRemainingMs === 0 && status === "active") {
          status = "expired";
          partyData.status = "expired";
          // Update status in storage
          if (useRedis) {
            try {
              await setPartyInRedis(code, partyData);
            } catch (err) {
              console.warn(`[HTTP] Failed to update expired status in Redis: ${err.message}`);
            }
          } else {
            setPartyInFallback(code, partyData);
          }
        }
      } else {
        // Legacy support for parties without expiresAt
        timeRemainingMs = Math.max(0, (partyData.createdAt + PARTY_TTL_MS) - now);
      }

      console.log(`[HTTP] Party found: ${code}, status: ${status}, guestCount: ${partyData.guestCount || 0}, timeRemainingMs: ${timeRemainingMs}`);

      // Return full party state
      // Includes both flat fields (backward compat) and a nested `party` object
      // so that tests and newer clients can use party.ended, party.status, etc.
      const partyObj = {
        code,
        status,
        guestCount: partyData.guestCount || 0,
        ended: partyData.status === 'ended',
        expiresAt: partyData.expiresAt || (partyData.createdAt + PARTY_TTL_MS),
        timeRemainingMs,
        chatMode: partyData.chatMode || "OPEN",
        createdAt: partyData.createdAt,
        partyPro: !!partyData.partyPro,
        source: partyData.source || "local"
      };
      res.json({
        exists: true,
        partyCode: code,
        status,
        expiresAt: partyData.expiresAt || (partyData.createdAt + PARTY_TTL_MS),
        timeRemainingMs,
        guestCount: partyData.guestCount || 0,
        guests: partyData.guests || [],
        chatMode: partyData.chatMode || "OPEN",
        createdAt: partyData.createdAt,
        partyPro: !!partyData.partyPro, // Party-wide Pro status
        source: partyData.source || "local", // Host-selected source
        // Nested party object for clients that use party.*
        party: partyObj
      });

    } catch (error) {
      console.error(`[HTTP] Error fetching party ${code}:`, error);
      res.status(500).json({
        error: "Failed to fetch party state",
        details: error.message,
        exists: false
      });
    }
  });

  // GET /party-state - Enhanced party state endpoint with playback info for polling
  router.get("/party-state", async (req, res) => {
    const timestamp = new Date().toISOString();
    const code = req.query.code ? req.query.code.trim().toUpperCase() : null;

    if (!code) {
      return res.status(400).json({
        error: "Party code is required",
        exists: false
      });
    }

    // Validate party code length
    if (code.length !== 6) {
      return res.status(400).json({
        error: "Party code must be 6 characters",
        exists: false
      });
    }

    console.log(`[HTTP] GET /api/party-state?code=${code} at ${timestamp}, instanceId: ${INSTANCE_ID}`);

    // Determine storage backend
    const useRedis = redis && deps.redisReady;
    const storageBackend = useRedis ? 'redis' : 'fallback';

    try {
      // Read from Redis or fallback storage
      let partyData;
      if (useRedis) {
        try {
          partyData = await getPartyFromRedis(code);
        } catch (error) {
          console.warn(`[HTTP] Redis error for party ${code}, trying fallback: ${error.message}`);
          partyData = getPartyFromFallback(code);
        }
      } else {
        partyData = getPartyFromFallback(code);
      }

      if (!partyData) {
        console.log(`[HTTP] Party not found: ${code}, storageBackend: ${storageBackend}`);
        return res.json({
          exists: false,
          status: "expired",
          partyCode: code
        });
      }

      // Check if party has expired
      const now = Date.now();
      let status = partyData.status || "active";
      let timeRemainingMs = 0;

      if (partyData.expiresAt) {
        timeRemainingMs = Math.max(0, partyData.expiresAt - now);
        if (timeRemainingMs === 0 && status === "active") {
          status = "expired";
        }
      } else {
        // Legacy support for parties without expiresAt
        timeRemainingMs = Math.max(0, (partyData.createdAt + PARTY_TTL_MS) - now);
      }

      // PHASE 6: Get queue and currentTrack from STORAGE (source of truth)
      // Only fall back to in-memory if storage doesn't have them
      const party = parties.get(code);
      const currentTrack = partyData.currentTrack || party?.currentTrack || null;
      const queue = partyData.queue || party?.queue || [];
      const djMessages = party?.djMessages || [];
      // YouTube sync state — in-memory only (transient; not persisted to Redis)
      const youtubeSync = party?.youtubeSync || null;
      // SoundCloud sync state — in-memory only (transient; not persisted to Redis)
      const scSync = party?.scSync || null;

      console.log(`[HTTP] Party state: ${code}, status: ${status}, track: ${currentTrack?.filename || currentTrack?.title || 'none'}, queue length: ${queue.length}`);

      // Return enhanced party state with playback info
      // Includes both nested "party" object and top-level flat fields for backward compatibility
      const tierInfo = {
        tier: partyData.tier || null,
        partyPassExpiresAt: partyData.partyPassExpiresAt || null,
        maxPhones: partyData.maxPhones || null
      };
      const currentTrackObj = currentTrack ? {
        trackId: currentTrack.trackId,
        url: currentTrack.url || currentTrack.trackUrl,
        filename: currentTrack.filename || currentTrack.title,
        title: currentTrack.title,
        durationMs: currentTrack.durationMs,
        startAtServerMs: currentTrack.startAtServerMs,
        startPosition: currentTrack.startPosition || currentTrack.startPositionSec,
        startPositionSec: currentTrack.startPositionSec || currentTrack.startPosition,
        status: currentTrack.status || 'playing',
        pausedPositionSec: currentTrack.pausedPositionSec,
        pausedAtServerMs: currentTrack.pausedAtServerMs
      } : null;
      res.json({
        exists: true,
        // Backward-compatible top-level flat fields
        partyCode: code,
        status,
        guestCount: partyData.guestCount || 0,
        tierInfo,
        currentTrack: currentTrackObj,
        queue,
        youtubeSync,
        scSync,
        // Nested party object for clients that use party.*
        party: {
          code: code,
          status,
          expiresAt: partyData.expiresAt || (partyData.createdAt + PARTY_TTL_MS),
          timeRemainingMs,
          guestCount: partyData.guestCount || 0,
          guests: partyData.guests || [],
          chatMode: partyData.chatMode || "OPEN",
          createdAt: partyData.createdAt,
          serverTime: now,
          tierInfo,
          currentTrack: currentTrackObj,
          queue,
          youtubeSync,
          scSync,
          djMessages: djMessages
        }
      });

    } catch (error) {
      console.error(`[HTTP] Error fetching party state ${code}:`, error);
      res.status(500).json({
        error: "Failed to fetch party state",
        details: error.message,
        exists: false
      });
    }
  });

  // POST /leave-party - Remove guest from party
  router.post("/leave-party", async (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[HTTP] POST /api/leave-party at ${timestamp}, instanceId: ${INSTANCE_ID}`, req.body);

    try {
      const { partyCode, guestId } = req.body;

      if (!partyCode) {
        return res.status(400).json({ error: "Party code is required" });
      }

      if (!guestId) {
        return res.status(400).json({ error: "Guest ID is required" });
      }

      // Normalize party code
      const code = partyCode.trim().toUpperCase();

      // Validate party code length
      if (code.length !== 6) {
        return res.status(400).json({ error: "Party code must be 6 characters" });
      }

      // Determine storage backend
      const useRedis = redis && deps.redisReady;
      const storageBackend = useRedis ? 'redis' : 'fallback';

      // In production mode, Redis is required
      if (IS_PRODUCTION && !useRedis) {
        return res.status(503).json({
          error: "Server not ready - Redis unavailable",
          instanceId: INSTANCE_ID
        });
      }

      // Read party data
      let partyData;
      if (useRedis) {
        try {
          partyData = await getPartyFromRedis(code);
        } catch (error) {
          console.warn(`[leave-party] Redis error for party ${code}, trying fallback: ${error.message}`);
          partyData = getPartyFromFallback(code);
        }
      } else {
        partyData = getPartyFromFallback(code);
      }

      if (!partyData) {
        return res.status(404).json({ error: "Party not found or expired" });
      }

      // Remove guest from party
      if (partyData.guests) {
        const initialCount = partyData.guests.length;
        partyData.guests = partyData.guests.filter(g => g.guestId !== guestId);
        partyData.guestCount = partyData.guests.length;

        console.log(`[leave-party] Guest ${guestId} left party ${code}, count: ${initialCount} → ${partyData.guestCount}`);
      }

      // Save updated party data
      if (useRedis) {
        try {
          await setPartyInRedis(code, partyData);
        } catch (error) {
          console.warn(`[leave-party] Redis write failed for ${code}, using fallback: ${error.message}`);
          setPartyInFallback(code, partyData);
        }
      } else {
        setPartyInFallback(code, partyData);
      }

      res.json({
        ok: true,
        guestCount: partyData.guestCount
      });

    } catch (error) {
      console.error(`[HTTP] Error leaving party, instanceId: ${INSTANCE_ID}:`, error);
      res.status(500).json({
        error: "Failed to leave party",
        details: error.message
      });
    }
  });

  // POST /end-party - End party early (host only)
  router.post("/end-party", apiLimiter, authMiddleware.optionalAuth, async (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[HTTP] POST /api/end-party at ${timestamp}, instanceId: ${INSTANCE_ID}`, req.body);

    try {
      // Accept either 'code' or 'partyCode' for backward and forward compatibility
      const partyCode = req.body.partyCode || req.body.code;

      if (!partyCode) {
        return res.status(400).json({ error: "Party code is required" });
      }

      // Normalize party code
      const code = partyCode.trim().toUpperCase();

      // Validate party code length
      if (code.length !== 6) {
        return res.status(400).json({ error: "Party code must be 6 characters" });
      }

      // Determine storage backend
      const useRedis = redis && deps.redisReady;
      const storageBackend = useRedis ? 'redis' : 'fallback';

      // In production mode, Redis is required
      if (IS_PRODUCTION && !useRedis) {
        return res.status(503).json({
          error: "Server not ready - Redis unavailable",
          instanceId: INSTANCE_ID
        });
      }

      // Read party data
      let partyData;
      if (useRedis) {
        try {
          partyData = await getPartyFromRedis(code);
        } catch (error) {
          console.warn(`[end-party] Redis error for party ${code}, trying fallback: ${error.message}`);
          partyData = getPartyFromFallback(code);
        }
      } else {
        partyData = getPartyFromFallback(code);
      }

      if (!partyData) {
        return res.status(404).json({ error: "Party not found or expired" });
      }

      // Authorization: if the party was created by an authenticated user, only that user
      // (or an unauthenticated fallback when the party has no stored hostUserId) may end it.
      if (partyData.hostUserId) {
        if (!req.user || req.user.userId !== partyData.hostUserId) {
          return res.status(403).json({ error: "Only the host can end the party" });
        }
      }

      // Mark party as ended
      partyData.status = "ended";
      partyData.endedAt = Date.now();

      console.log(`[end-party] Party ${code} ended by host`);

      // Track session end in metrics
      if (metricsService) {
        const durationMs = partyData.endedAt - partyData.createdAt;
        const participantCount = partyData.guestCount || 0;
        await metricsService.trackSessionEnded(code, durationMs, participantCount);
      }

      // Persist scoreboard before marking party as ended
      try {
        await persistPartyScoreboard(code, partyData);
      } catch (err) {
        console.error(`[end-party] Failed to persist scoreboard for ${code}:`, err.message);
      }

      // Save updated party data (or delete it)
      // Option 1: Mark as ended but keep in storage for a short time
      if (useRedis) {
        try {
          // Set shorter TTL for ended parties (e.g., 5 minutes)
          const data = JSON.stringify(partyData);
          await redis.setex(`${PARTY_KEY_PREFIX}${code}`, 300, data); // 5 minutes
        } catch (error) {
          console.warn(`[end-party] Redis write failed for ${code}, using fallback: ${error.message}`);
          setPartyInFallback(code, partyData);
        }
      } else {
        setPartyInFallback(code, partyData);
      }

      // Removed dead code - parties now marked ended with TTL instead of immediate deletion

      // Remove from local memory
      if (parties.has(code)) {
        parties.delete(code);
      }

      res.json({ success: true, ok: true });

    } catch (error) {
      console.error(`[HTTP] Error ending party, instanceId: ${INSTANCE_ID}:`, error);
      res.status(500).json({
        error: "Failed to end party",
        details: error.message
      });
    }
  });

  // POST /apply-promo - Apply promo code to unlock party-wide Pro
  router.post("/apply-promo", apiLimiter, authMiddleware.optionalAuth, async (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[HTTP] POST /api/apply-promo at ${timestamp}, instanceId: ${INSTANCE_ID}`, req.body);

    try {
      const { partyCode, promoCode } = req.body;

      if (!partyCode || !promoCode) {
        return res.status(400).json({ error: "Party code and promo code are required" });
      }

      // Normalize codes
      const code = partyCode.trim().toUpperCase();
      const promo = promoCode.trim().toUpperCase();

      // Validate party code length
      if (code.length !== 6) {
        return res.status(400).json({ error: "Party code must be 6 characters" });
      }

      // Determine storage backend
      const useRedis = redis && deps.redisReady;

      // In production mode, Redis is required
      if (IS_PRODUCTION && !useRedis) {
        return res.status(503).json({
          error: "Server not ready - Redis unavailable",
          details: "Multi-device features require Redis"
        });
      }

      // ── Check DB-backed admin-generated promo codes first ─────────────────────
      let dbPromo = null;
      try {
        const dbResult = await db.query(
          `SELECT id, code, type, is_used FROM promo_codes WHERE code = $1`,
          [promo]
        );
        if (dbResult.rows.length > 0) {
          dbPromo = dbResult.rows[0];
        }
      } catch (dbErr) { console.warn('[Promo] DB lookup unavailable, falling back to legacy codes:', dbErr.message); }

      if (dbPromo) {
        // Found in DB — enforce one-time-use
        if (dbPromo.is_used) {
          console.log(`[Promo] DB promo code already used: ${promo}, partyCode: ${code}`);
          return res.status(400).json({ error: "This promo code has already been used." });
        }

        const userId = req.user ? (req.user.id || req.user.userId) : null;

        // Mark as used atomically
        const updated = await db.query(
          `UPDATE promo_codes SET is_used = TRUE, used_at = NOW(), used_by = $1
           WHERE id = $2 AND is_used = FALSE
           RETURNING id`,
          [userId || null, dbPromo.id]
        );
        if (updated.rows.length === 0) {
          // Race condition — another request beat us to it
          return res.status(400).json({ error: "This promo code has already been used." });
        }

        // Apply the benefit based on promo type
        if (dbPromo.type === 'pro_monthly' && userId) {
          // Activate pro monthly subscription for the authenticated user (no expiry — provider-managed)
          await db.activateProMonthly(userId, 'promo', promo);
          console.log(`[Promo] DB promo ${promo} (pro_monthly) applied for user ${userId}`);
          return res.json({ ok: true, type: 'pro_monthly', message: "Pro Monthly activated!" });
        }

        if (dbPromo.type === 'monthly_subscription_one_time' && userId) {
          // Grant exactly 1 month of Pro from the moment of redemption
          await db.activateProMonthlyWithExpiry(userId, 'promo_one_time', promo, new Date());
          console.log(`[Promo] DB promo ${promo} (monthly_subscription_one_time) granted 1 month for user ${userId}`);
          return res.json({ ok: true, type: 'monthly_subscription_one_time', message: "1-Month Pro Subscription activated!" });
        }

        if (dbPromo.type === 'party_pass_one_time' && userId) {
          // Grant a Party Pass entitlement to the user's account (2 hours from redemption)
          const partyPassExpiry = new Date();
          partyPassExpiry.setHours(partyPassExpiry.getHours() + 2);
          await db.updatePartyPassExpiry(userId, partyPassExpiry);
          console.log(`[Promo] DB promo ${promo} (party_pass_one_time) granted party pass to user ${userId}`);
          return res.json({ ok: true, type: 'party_pass_one_time', message: "Party Pass activated!" });
        }

        // Default: party_pass — unlock party-wide Pro (same as legacy flow)
        // (also used for pro_monthly / one-time codes when user is not logged in)
        const partyData = await _getPartyDataForPromo(code, useRedis, getPartyFromRedis, getPartyFromFallback);
        if (!partyData) {
          return res.status(404).json({ error: ErrorMessages.partyNotFound() });
        }

        if (partyData.promoUsed) {
          return res.status(400).json({ error: "This party already used a promo code." });
        }

        partyData.promoUsed = true;
        partyData.partyPro = true;
        await _savePartyDataForPromo(code, partyData, useRedis, setPartyInRedis, setPartyInFallback);
        _updateWsPartyForPromo(code, parties, broadcastRoomState);

        console.log(`[Promo] DB promo ${promo} (${dbPromo.type}) unlocked party ${code}`);
        return res.json({ ok: true, type: dbPromo.type, partyPro: true, message: "Pro unlocked for this party!" });
      }

      // ── Fall back to legacy hardcoded promo codes ──────────────────────────────

      // Get party data
      const partyData = await _getPartyDataForPromo(code, useRedis, getPartyFromRedis, getPartyFromFallback);

      if (!partyData) {
        return res.status(404).json({ error: ErrorMessages.partyNotFound() });
      }

      // Check if promo already used
      if (partyData.promoUsed) {
        console.log(`[Promo] Attempt to reuse promo in party ${code}`);
        return res.status(400).json({ error: "This party already used a promo code." });
      }

      // Validate promo code (using constant from top of file)
      if (!PROMO_CODES.includes(promo)) {
        console.log(`[Promo] Invalid promo code attempt: ${promo}, partyCode: ${code}`);
        return res.status(400).json({ error: "Invalid or expired promo code." });
      }

      // Valid and unused - unlock party-wide Pro
      partyData.promoUsed = true;
      partyData.partyPro = true;
      console.log(`[Promo] Party ${code} unlocked with promo code ${promo} via HTTP`);

      await _savePartyDataForPromo(code, partyData, useRedis, setPartyInRedis, setPartyInFallback);
      _updateWsPartyForPromo(code, parties, broadcastRoomState);

      res.json({
        ok: true,
        partyPro: true,
        message: "Pro unlocked for this party!"
      });

    } catch (error) {
      console.error(`[HTTP] Error applying promo, instanceId: ${INSTANCE_ID}:`, error);
      res.status(500).json({
        error: "Failed to apply promo code",
        details: error.message
      });
    }
  });

  // GET /party/:code/debug - Enhanced debug endpoint with Redis TTL info
  router.get("/party/:code/debug", async (req, res) => {
    const timestamp = new Date().toISOString();
    const code = req.params.code.toUpperCase().trim();

    // Validate party code length
    if (code.length !== 6) {
      return res.json({
        exists: false,
        ttlSeconds: -1,
        redisConnected: redis && deps.redisReady,
        instanceId: INSTANCE_ID,
        error: "Invalid party code length"
      });
    }

    console.log(`[HTTP] GET /api/party/${code}/debug at ${timestamp}, instanceId: ${INSTANCE_ID}`);

    let exists = false;
    let ttlSeconds = -1;
    const redisConnected = redis && deps.redisReady;

    try {
      if (redisConnected) {
        // Check if party exists in Redis
        const partyData = await getPartyFromRedis(code);
        exists = !!partyData;

        // Get TTL from Redis
        if (exists) {
          ttlSeconds = await redis.ttl(`${PARTY_KEY_PREFIX}${code}`);
        }
      }
    } catch (error) {
      console.error(`[HTTP] Error in debug endpoint for ${code}:`, error.message);
    }

    res.json({
      exists,
      ttlSeconds,
      redisConnected,
      instanceId: INSTANCE_ID
    });
  });

  // GET /party/:code - Debug endpoint to check if a party exists
  router.get("/party/:code", async (req, res) => {
    const timestamp = new Date().toISOString();
    const code = req.params.code.toUpperCase().trim();

    console.log(`[HTTP] GET /api/party/${code} at ${timestamp}, instanceId: ${INSTANCE_ID}`);

    // Read from Redis or fallback storage
    let partyData;
    const usingFallback = !redis || !deps.redisReady;

    try {
      if (usingFallback) {
        partyData = getPartyFromFallback(code);
      } else {
        partyData = await getPartyFromRedis(code);
      }
    } catch (error) {
      console.warn(`[HTTP] Error reading party ${code}, trying fallback:`, error.message);
      partyData = getPartyFromFallback(code);
    }

    if (!partyData) {
      const totalParties = parties.size;
      console.log(`[HTTP] Debug query - Party not found: ${code}, instanceId: ${INSTANCE_ID}, localParties: ${totalParties}, usingFallback: ${usingFallback}`);
      return res.json({
        exists: false,
        code: code,
        instanceId: INSTANCE_ID
      });
    }

    // Check local memory for WebSocket connection status
    const localParty = parties.get(code);
    const hostConnected = localParty ? (localParty.host !== null && localParty.host !== undefined) : partyData.hostConnected || false;
    const guestCount = localParty ? localParty.members.filter(m => !m.isHost).length : partyData.guestCount || 0;

    console.log(`[HTTP] Debug query - Party found: ${code}, instanceId: ${INSTANCE_ID}, hostConnected: ${hostConnected}, guestCount: ${guestCount}, usingFallback: ${usingFallback}`);

    res.json({
      exists: true,
      code: code,
      createdAt: new Date(partyData.createdAt).toISOString(),
      hostConnected: hostConnected,
      guestCount: guestCount,
      instanceId: INSTANCE_ID
    });
  });

  // POST /party/:code/start-track - Start playing a track with scheduled sync
  router.post("/party/:code/start-track", async (req, res) => {
    const timestamp = new Date().toISOString();
    const code = req.params.code ? req.params.code.toUpperCase() : null;
    const { trackId, startPositionSec, trackUrl, title, durationMs } = req.body;

    console.log(`[HTTP] POST /api/party/${code}/start-track at ${timestamp}`);

    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'Invalid party code' });
    }

    if (!trackId) {
      return res.status(400).json({ error: 'trackId is required' });
    }

    try {
      // Get party from memory (for WebSocket)
      const party = parties.get(code);
      if (!party) {
        return res.status(404).json({ error: 'Party not found' });
      }

      // Compute lead time for scheduled start (configurable 800-1500ms, default 1200ms)
      const leadTimeMs = 1200;
      const nowMs = Date.now();
      const startAtServerMs = nowMs + leadTimeMs;

      // Update currentTrack in party state to "preparing"
      party.currentTrack = {
        trackId,
        trackUrl: trackUrl || null,
        title: title || 'Unknown Track',
        durationMs: durationMs || null,
        startAtServerMs: startAtServerMs,
        startPositionSec: startPositionSec || 0,
        status: 'preparing'
      };

      console.log(`[HTTP] Track scheduled ${trackId} in party ${code}, position: ${startPositionSec}s, start in ${leadTimeMs}ms`);

      // Persist to Redis (best-effort)
      persistPlaybackToRedis(code, party.currentTrack, party.queue || []);

      // Broadcast PREPARE_PLAY to all members
      const prepareMessage = JSON.stringify({
        t: 'PREPARE_PLAY',
        trackId,
        trackUrl: trackUrl || null,
        title: title || 'Unknown Track',
        durationMs: durationMs || null,
        startAtServerMs: startAtServerMs,
        startPositionSec: startPositionSec || 0
      });

      party.members.forEach(m => {
        if (m.ws.readyState === WebSocket.OPEN) {
          m.ws.send(prepareMessage);
        }
      });

      // Log PREPARE_PLAY broadcast (observability)
      console.log(`[Sync] PREPARE_PLAY broadcast: partyCode=${code}, trackId=${trackId}`);

      // After leadTimeMs, set status to playing and broadcast PLAY_AT
      setTimeout(() => {
        // Re-check party still exists
        const updatedParty = parties.get(code);
        if (!updatedParty || !updatedParty.currentTrack) return;

        // Update status to playing
        updatedParty.currentTrack.status = 'playing';

        console.log(`[HTTP] Track playing: ${trackId} at server time ${startAtServerMs}`);

        // Persist updated status
        persistPlaybackToRedis(code, updatedParty.currentTrack, updatedParty.queue || []);

        // Broadcast PLAY_AT to all members
        const playAtMessage = JSON.stringify({
          t: 'PLAY_AT',
          trackId,
          trackUrl: trackUrl || null,
          title: title || 'Unknown Track',
          durationMs: durationMs || null,
          startAtServerMs: startAtServerMs,
          startPositionSec: startPositionSec || 0
        });

        updatedParty.members.forEach(m => {
          if (m.ws.readyState === WebSocket.OPEN) {
            m.ws.send(playAtMessage);
          }
        });

        // Log PLAY_AT broadcast (observability)
        const readyCount = updatedParty.members.filter(m => m.ws.readyState === WebSocket.OPEN).length;
        const totalCount = updatedParty.members.length;
        console.log(`[Sync] PLAY_AT broadcast: partyCode=${code}, trackId=${trackId}, readyCount=${readyCount}/${totalCount}, startAtServerMs=${startAtServerMs}`);
      }, leadTimeMs);

      res.json({
        success: true,
        currentTrack: party.currentTrack
      });
    } catch (error) {
      console.error(`[HTTP] Error starting track:`, error);
      res.status(500).json({
        error: 'Failed to start track',
        details: error.message
      });
    }
  });

  // POST /party/:code/queue-track - Add track to queue (HOST-ONLY)
  router.post("/party/:code/queue-track", apiLimiter, async (req, res) => {
    const timestamp = new Date().toISOString();
    const code = req.params.code ? req.params.code.toUpperCase() : null;
    const { hostId, trackId, trackUrl, title, durationMs, filename, contentType, sizeBytes } = req.body;

    console.log(`[HTTP] POST /api/party/${code}/queue-track at ${timestamp}`);

    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'Invalid party code' });
    }

    if (!trackId || !trackUrl) {
      return res.status(400).json({ error: 'trackId and trackUrl are required' });
    }

    try {
      // Load party state from storage
      const partyData = await loadPartyState(code);
      if (!partyData) {
        return res.status(404).json({ error: 'Party not found' });
      }

      // PHASE 2: Validate host-only auth
      const authCheck = validateHostAuth(hostId, partyData);
      if (!authCheck.valid) {
        console.log(`[HTTP] Queue operation denied for ${code}: ${authCheck.error}`);
        return res.status(403).json({ error: authCheck.error });
      }

      // Initialize queue if it doesn't exist
      if (!partyData.queue) {
        partyData.queue = [];
      }

      // Check queue limit (default 5, configurable)
      const queueLimit = 5;
      if (partyData.queue.length >= queueLimit) {
        return res.status(400).json({ error: `Queue is full (max ${queueLimit} tracks)` });
      }

      // PHASE 4: Validate trackUrl security (prototype: allow /api/track/* or external if source=="external")
      const isLocalTrack = trackUrl.includes(`/api/track/`);
      const source = partyData.source || 'local';

      if (!isLocalTrack && source !== 'external') {
        return res.status(400).json({ error: 'Invalid trackUrl: only local tracks are allowed for this party' });
      }

      // PHASE 1: Normalize track to canonical shape
      const normalizedTrack = normalizeTrack({
        trackId,
        trackUrl,
        title,
        filename,
        durationMs,
        contentType,
        sizeBytes,
        source
      }, {
        addedBy: { id: partyData.hostId, name: partyData.djName }
      });

      // Add to queue
      partyData.queue.push(normalizedTrack);

      // PHASE 3: Persist to storage
      await savePartyState(code, partyData);

      // Mirror to local party for WS broadcast
      const party = parties.get(code);
      if (party) {
        party.queue = partyData.queue;
        party.currentTrack = partyData.currentTrack;

        // PHASE 5: Broadcast QUEUE_UPDATED to all members
        const message = JSON.stringify({
          t: 'QUEUE_UPDATED',
          queue: partyData.queue,
          currentTrack: partyData.currentTrack
        });

        party.members.forEach(m => {
          if (m.ws.readyState === WebSocket.OPEN) {
            m.ws.send(message);
          }
        });

        // Pre-load next track in queue for seamless transitions
        if (partyData.queue && partyData.queue.length > 0) {
          const nextTrack = partyData.queue[0];
          if (nextTrack && nextTrack.trackUrl) {
            const preloadMessage = JSON.stringify({
              t: 'PRELOAD_NEXT_TRACK',
              trackUrl: nextTrack.trackUrl,
              trackId: nextTrack.trackId,
              title: nextTrack.title || nextTrack.filename,
              filename: nextTrack.filename,
              priority: 'low'
            });

            party.members.forEach(m => {
              if (m.ws.readyState === WebSocket.OPEN) {
                m.ws.send(preloadMessage);
              }
            });

            console.log(`[Preload] Notified guests to preload next track: ${nextTrack.title || nextTrack.trackId}`);
          }
        }
      }

      console.log(`[HTTP] Queued track ${trackId} in party ${code}, queue length: ${partyData.queue.length}`);

      res.json({
        success: true,
        queue: partyData.queue,
        currentTrack: partyData.currentTrack
      });
    } catch (error) {
      console.error(`[HTTP] Error queueing track:`, error);
      res.status(500).json({
        error: 'Failed to queue track',
        details: error.message
      });
    }
  });

  // POST /party/:code/play-next - Play next track from queue (HOST-ONLY)
  router.post("/party/:code/play-next", apiLimiter, async (req, res) => {
    const timestamp = new Date().toISOString();
    const code = req.params.code ? req.params.code.toUpperCase() : null;
    const { hostId } = req.body;

    console.log(`[HTTP] POST /api/party/${code}/play-next at ${timestamp}`);

    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'Invalid party code' });
    }

    try {
      // Load party state from storage
      const partyData = await loadPartyState(code);
      if (!partyData) {
        return res.status(404).json({ error: 'Party not found' });
      }

      // PHASE 2: Validate host-only auth
      const authCheck = validateHostAuth(hostId, partyData);
      if (!authCheck.valid) {
        console.log(`[HTTP] Play-next operation denied for ${code}: ${authCheck.error}`);
        return res.status(403).json({ error: authCheck.error });
      }

      // Initialize queue if it doesn't exist
      if (!partyData.queue) {
        partyData.queue = [];
      }

      // Check if queue has tracks
      if (partyData.queue.length === 0) {
        return res.status(400).json({ error: 'Queue is empty' });
      }

      // Get first track from queue
      const nextTrack = partyData.queue.shift();

      // Set as currentTrack with playback state
      partyData.currentTrack = {
        ...nextTrack,
        startAtServerMs: Date.now(),
        startPositionSec: 0,
        status: 'playing'
      };

      // PHASE 3: Persist to storage
      await savePartyState(code, partyData);

      console.log(`[HTTP] Playing next track ${nextTrack.trackId} in party ${code}`);

      // Mirror to local party for WS broadcast
      const party = parties.get(code);
      if (party) {
        party.currentTrack = partyData.currentTrack;
        party.queue = partyData.queue;

        // PHASE 5: Broadcast TRACK_CHANGED to all members
        const message = JSON.stringify({
          t: 'TRACK_CHANGED',
          currentTrack: partyData.currentTrack,
          trackId: nextTrack.trackId,
          trackUrl: nextTrack.trackUrl,
          title: nextTrack.title,
          durationMs: nextTrack.durationMs,
          startAtServerMs: partyData.currentTrack.startAtServerMs,
          startPositionSec: 0,
          queue: partyData.queue
        });

        party.members.forEach(m => {
          if (m.ws.readyState === WebSocket.OPEN) {
            m.ws.send(message);
          }
        });
      }

      res.json({
        success: true,
        currentTrack: partyData.currentTrack,
        queue: partyData.queue
      });
    } catch (error) {
      console.error(`[HTTP] Error playing next track:`, error);
      res.status(500).json({
        error: 'Failed to play next track',
        details: error.message
      });
    }
  });

  // POST /party/:code/remove-track - Remove a track from queue (HOST-ONLY)
  router.post("/party/:code/remove-track", apiLimiter, async (req, res) => {
    const timestamp = new Date().toISOString();
    const code = req.params.code ? req.params.code.toUpperCase() : null;
    const { hostId, trackId } = req.body;

    console.log(`[HTTP] POST /api/party/${code}/remove-track at ${timestamp}`);

    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'Invalid party code' });
    }

    if (!trackId) {
      return res.status(400).json({ error: 'trackId is required' });
    }

    try {
      // Load party state from storage
      const partyData = await loadPartyState(code);
      if (!partyData) {
        return res.status(404).json({ error: 'Party not found' });
      }

      // PHASE 2: Validate host-only auth
      const authCheck = validateHostAuth(hostId, partyData);
      if (!authCheck.valid) {
        console.log(`[HTTP] Remove-track operation denied for ${code}: ${authCheck.error}`);
        return res.status(403).json({ error: authCheck.error });
      }

      // Initialize queue if it doesn't exist
      if (!partyData.queue) {
        partyData.queue = [];
      }

      // Find and remove FIRST matching trackId
      const trackIndex = partyData.queue.findIndex(t => t.trackId === trackId);

      if (trackIndex === -1) {
        return res.status(404).json({ error: 'Track not found in queue' });
      }

      partyData.queue.splice(trackIndex, 1);

      // PHASE 3: Persist to storage
      await savePartyState(code, partyData);

      console.log(`[HTTP] Removed track ${trackId} from party ${code}, queue length: ${partyData.queue.length}`);

      // Mirror to local party for WS broadcast
      const party = parties.get(code);
      if (party) {
        party.queue = partyData.queue;

        // PHASE 5: Broadcast QUEUE_UPDATED to all members
        const message = JSON.stringify({
          t: 'QUEUE_UPDATED',
          queue: partyData.queue,
          currentTrack: partyData.currentTrack
        });

        party.members.forEach(m => {
          if (m.ws.readyState === WebSocket.OPEN) {
            m.ws.send(message);
          }
        });
      }

      res.json({
        success: true,
        queue: partyData.queue,
        currentTrack: partyData.currentTrack
      });
    } catch (error) {
      console.error(`[HTTP] Error removing track:`, error);
      res.status(500).json({
        error: 'Failed to remove track',
        details: error.message
      });
    }
  });

  // POST /party/:code/clear-queue - Clear all tracks from queue (HOST-ONLY)
  router.post("/party/:code/clear-queue", apiLimiter, async (req, res) => {
    const timestamp = new Date().toISOString();
    const code = req.params.code ? req.params.code.toUpperCase() : null;
    const { hostId } = req.body;

    console.log(`[HTTP] POST /api/party/${code}/clear-queue at ${timestamp}`);

    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'Invalid party code' });
    }

    try {
      // Load party state from storage
      const partyData = await loadPartyState(code);
      if (!partyData) {
        return res.status(404).json({ error: 'Party not found' });
      }

      // PHASE 2: Validate host-only auth
      const authCheck = validateHostAuth(hostId, partyData);
      if (!authCheck.valid) {
        console.log(`[HTTP] Clear-queue operation denied for ${code}: ${authCheck.error}`);
        return res.status(403).json({ error: authCheck.error });
      }

      // Clear queue
      partyData.queue = [];

      // PHASE 3: Persist to storage
      await savePartyState(code, partyData);

      console.log(`[HTTP] Cleared queue for party ${code}`);

      // Mirror to local party for WS broadcast
      const party = parties.get(code);
      if (party) {
        party.queue = partyData.queue;

        // PHASE 5: Broadcast QUEUE_UPDATED to all members
        const message = JSON.stringify({
          t: 'QUEUE_UPDATED',
          queue: partyData.queue,
          currentTrack: partyData.currentTrack
        });

        party.members.forEach(m => {
          if (m.ws.readyState === WebSocket.OPEN) {
            m.ws.send(message);
          }
        });
      }

      res.json({
        success: true,
        queue: partyData.queue,
        currentTrack: partyData.currentTrack
      });
    } catch (error) {
      console.error(`[HTTP] Error clearing queue:`, error);
      res.status(500).json({
        error: 'Failed to clear queue',
        details: error.message
      });
    }
  });

  // POST /party/:code/reorder-queue - Reorder tracks in queue (HOST-ONLY)
  router.post("/party/:code/reorder-queue", apiLimiter, async (req, res) => {
    const timestamp = new Date().toISOString();
    const code = req.params.code ? req.params.code.toUpperCase() : null;
    const { hostId, fromIndex, toIndex } = req.body;

    console.log(`[HTTP] POST /api/party/${code}/reorder-queue at ${timestamp}`);

    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'Invalid party code' });
    }

    if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') {
      return res.status(400).json({ error: 'fromIndex and toIndex are required and must be numbers' });
    }

    try {
      // Load party state from storage
      const partyData = await loadPartyState(code);
      if (!partyData) {
        return res.status(404).json({ error: 'Party not found' });
      }

      // PHASE 2: Validate host-only auth
      const authCheck = validateHostAuth(hostId, partyData);
      if (!authCheck.valid) {
        console.log(`[HTTP] Reorder-queue operation denied for ${code}: ${authCheck.error}`);
        return res.status(403).json({ error: authCheck.error });
      }

      // Initialize queue if it doesn't exist
      if (!partyData.queue) {
        partyData.queue = [];
      }

      // Validate indices
      if (fromIndex < 0 || fromIndex >= partyData.queue.length) {
        return res.status(400).json({ error: 'Invalid fromIndex' });
      }

      if (toIndex < 0 || toIndex >= partyData.queue.length) {
        return res.status(400).json({ error: 'Invalid toIndex' });
      }

      // Reorder: remove from fromIndex and insert at toIndex
      const [movedTrack] = partyData.queue.splice(fromIndex, 1);
      partyData.queue.splice(toIndex, 0, movedTrack);

      // PHASE 3: Persist to storage
      await savePartyState(code, partyData);

      console.log(`[HTTP] Reordered queue for party ${code}: moved track from ${fromIndex} to ${toIndex}`);

      // Mirror to local party for WS broadcast
      const party = parties.get(code);
      if (party) {
        party.queue = partyData.queue;

        // PHASE 5: Broadcast QUEUE_UPDATED to all members
        const message = JSON.stringify({
          t: 'QUEUE_UPDATED',
          queue: partyData.queue,
          currentTrack: partyData.currentTrack
        });

        party.members.forEach(m => {
          if (m.ws.readyState === WebSocket.OPEN) {
            m.ws.send(message);
          }
        });
      }

      res.json({
        success: true,
        queue: partyData.queue,
        currentTrack: partyData.currentTrack
      });
    } catch (error) {
      console.error(`[HTTP] Error reordering queue:`, error);
      res.status(500).json({
        error: 'Failed to reorder queue',
        details: error.message
      });
    }
  });

  // GET /party/:code/members - Get party members for polling
  router.get("/party/:code/members", async (req, res) => {
    const timestamp = new Date().toISOString();
    const code = req.params.code.toUpperCase().trim();

    console.log(`[HTTP] GET /api/party/${code}/members at ${timestamp}, instanceId: ${INSTANCE_ID}`);

    // Check local WebSocket party state first
    const localParty = parties.get(code);

    if (localParty) {
      // Return current members from WebSocket state
      const snapshot = {
        members: localParty.members.map(m => ({
          id: m.id,
          name: m.name,
          isPro: m.isPro || false,
          isHost: m.isHost
        })),
        chatMode: localParty.chatMode || "OPEN"
      };

      console.log(`[HTTP] Party members found locally: ${code}, memberCount: ${snapshot.members.length}`);
      return res.json({ exists: true, snapshot });
    }

    // If not in local state, check Redis/fallback
    const usingFallback = !redis || !deps.redisReady;
    let partyData;

    try {
      if (usingFallback) {
        partyData = getPartyFromFallback(code);
      } else {
        partyData = await getPartyFromRedis(code);
      }
    } catch (error) {
      console.warn(`[HTTP] Error reading party ${code}, trying fallback:`, error.message);
      partyData = getPartyFromFallback(code);
    }

    if (!partyData) {
      console.log(`[HTTP] Party not found: ${code}`);
      return res.json({ exists: false });
    }

    // Party exists but no WebSocket connections yet - return empty members list
    console.log(`[HTTP] Party exists but no active connections: ${code}`);
    res.json({
      exists: true,
      snapshot: {
        members: [],
        chatMode: partyData.chatMode || "OPEN"
      }
    });
  });

  // GET /party/:code/limits - Get party tier limits and feature access
  router.get("/party/:code/limits", async (req, res) => {
    const code = normalizePartyCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid party code' });

    let partyData;
    try {
      partyData = parties.get(code) || await getPartyFromRedis(code) || getPartyFromFallback(code);
    } catch (_) {
      partyData = getPartyFromFallback(code);
    }

    if (!partyData) return res.status(404).json({ error: 'Party not found' });

    const tier = partyData.tier || 'FREE';
    const policy = getPolicyForTier(tier);

    return res.json({
      tier,
      maxDevices: policy.maxDevices,
      maxSessionMinutes: policy.maxSessionMinutes,
      uploadsAllowed: policy.uploadsAllowed,
      isPaidForOfficialAppSync: isPaidForOfficialAppSyncParty(partyData)
    });
  });

  // GET /party/:code/scoreboard - Get party scoreboard (live or historical)
  router.get("/party/:code/scoreboard", async (req, res) => {
    const timestamp = new Date().toISOString();
    const code = req.params.code.toUpperCase().trim();

    console.log(`[HTTP] GET /api/party/${code}/scoreboard at ${timestamp}, instanceId: ${INSTANCE_ID}`);

    try {
      // Check if party is currently active
      const localParty = parties.get(code);

      if (localParty && localParty.scoreState) {
        // Return live scoreboard
        const guestList = Object.values(localParty.scoreState.guests)
          .sort((a, b) => b.points - a.points)
          .map((guest, index) => ({
            ...guest,
            rank: index + 1
          }));

        return res.json({
          live: true,
          partyCode: code,
          dj: {
            djName: localParty.scoreState.dj.djName,
            sessionScore: localParty.scoreState.dj.sessionScore,
            lifetimeScore: localParty.scoreState.dj.lifetimeScore
          },
          guests: guestList.slice(0, 10),
          totalReactions: localParty.scoreState.totalReactions,
          totalMessages: localParty.scoreState.totalMessages,
          peakCrowdEnergy: localParty.scoreState.peakCrowdEnergy,
          partyDuration: localParty.createdAt
            ? Math.floor((Date.now() - localParty.createdAt) / 60000)
            : 0
        });
      }

      // Party not active, check database for historical scoreboard
      const historicalScoreboard = await db.getPartyScoreboard(code);

      if (historicalScoreboard) {
        return res.json({
          live: false,
          partyCode: code,
          dj: {
            // DJ name stored in host_identifier - could look up from users/dj_profiles if needed
            djName: "DJ",
            sessionScore: historicalScoreboard.dj_session_score,
            lifetimeScore: 0
          },
          guests: historicalScoreboard.guest_scores,
          totalReactions: historicalScoreboard.total_reactions,
          totalMessages: historicalScoreboard.total_messages,
          peakCrowdEnergy: historicalScoreboard.peak_crowd_energy,
          partyDuration: historicalScoreboard.party_duration_minutes,
          createdAt: historicalScoreboard.created_at
        });
      }

      // No scoreboard found
      return res.status(404).json({
        error: "Scoreboard not found for this party code"
      });

    } catch (error) {
      console.error(`[HTTP] Error getting scoreboard for party ${code}:`, error.message);
      return res.status(500).json({
        error: "Failed to retrieve scoreboard"
      });
    }
  });

  // GET /leaderboard/djs - Get top DJs leaderboard
  router.get("/leaderboard/djs", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const topDjs = await db.getTopDjs(limit);

      return res.json({
        leaderboard: topDjs,
        count: topDjs.length
      });
    } catch (error) {
      console.error(`[HTTP] Error getting DJ leaderboard:`, error.message);
      return res.status(500).json({
        error: "Failed to retrieve DJ leaderboard"
      });
    }
  });

  // GET /leaderboard/guests - Get top guests leaderboard
  router.get("/leaderboard/guests", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const topGuests = await db.getTopGuests(limit);

      return res.json({
        leaderboard: topGuests,
        count: topGuests.length
      });
    } catch (error) {
      console.error(`[HTTP] Error getting guest leaderboard:`, error.message);
      return res.status(500).json({
        error: "Failed to retrieve guest leaderboard"
      });
    }
  });

  return router;
};
