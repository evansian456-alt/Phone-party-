// ============================================================================
// ENVIRONMENT VALIDATION - Must run FIRST before any other imports
// ============================================================================
// Validates critical environment variables at startup
// - In PRODUCTION: Fails fast with clear error messages
// - In DEVELOPMENT: Warns but allows startup
const { validateAndFailFast } = require('./env-validator');
validateAndFailFast(); // This will exit process if critical errors in production

// ============================================================================
// Core Dependencies
// ============================================================================
const express = require("express");
const path = require("path");
const WebSocket = require("ws");
const { customAlphabet } = require("nanoid");
const Redis = require("ioredis");
const { URL } = require("url");
const multer = require("multer");
const fs = require("fs");
const { nanoid } = require('nanoid');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

// Initialize Sentry for error tracking (only in production)
if (process.env.NODE_ENV === 'production' && process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    // Performance Monitoring
    tracesSampleRate: 0.1, // Capture 10% of transactions for performance monitoring
    // Profiling (built-in to @sentry/node v7+)
    profilesSampleRate: 0.1, // Capture 10% of profiles
  });
}

// Import auth and database modules
const db = require('./database');
const authMiddleware = require('./auth-middleware');
const storeCatalog = require('./store-catalog');
const paymentProvider = require('./payment-provider');

// Import sync engine for advanced multi-device synchronization
// Removed P2PNetwork import - unused class (only SyncEngine is used)
const { SyncEngine } = require('./sync-engine');
const { SYNC_TEST_MODE } = require('./sync-config');

// Import event replay system for reliable message delivery
const { EventReplayManager, MessagePriority } = require('./event-replay');

// Import security modules for production-grade protection
const { validateHostAuthority, validateHostAuthorityHTTP, createUnauthorizedError } = require('./host-authority');
const { validatePayload, logValidationFailure } = require('./payload-validator');
const { initRateLimiter, checkRateLimit, clearClientRateLimit } = require('./rate-limiter');

// Import entitlement validator for strict tier enforcement
const { validateSessionCreation, validateSessionJoin, validateFeatureAccess, getTierLimits, isPartyPassActive: checkPartyPassActive } = require('./entitlement-validator');

// Import tier policy (single source of truth for tier limits)
const { isPaidForOfficialAppSync: tierPolicyIsPaidForOfficialAppSync, getPolicyForTier, hasStreamingAccess } = require('./tier-policy');

// Import platform normalizer for Official App Sync track references
const { normalizePlatformTrackRef } = require('./platform-normalizer');

// Changer version – bump whenever platform detection / URL transformation logic changes.
// Logged at startup so production logs confirm the new changer build is running.
const CHANGER_VERSION = '2026-02-27-a';

// Import production services
const { MetricsService } = require('./metrics-service');
const { ReferralSystem } = require('./referral-system');
const { verifyStripeSignature, processStripeWebhook } = require('./stripe-webhook');

// Stripe billing client (null when STRIPE_SECRET_KEY is unset)
const stripeClient = require('./stripe-client');

// Unified billing modules
const { PRODUCTS, getProductByPlatformId } = require('./billing/products');
const { applyPurchaseToUser } = require('./billing/entitlements');


const app = express();
const PORT = parseInt(process.env.PORT || "8080", 10);
const APP_VERSION = "0.1.0-party-fix"; // Version identifier for debugging and version display

// Early boot log so Cloud Run logs confirm the process reached this point
console.log("[Boot] commit=" + (process.env.COMMIT_SHA || "unknown") + " port=" + PORT + " node=" + process.version);

// Generate unique instance ID for this server instance
const INSTANCE_ID = `server-${Math.random().toString(36).substring(2, 9)}`;

// Promo codes for party-wide Pro unlock (moved to top for visibility)
const PROMO_CODES = ["SS-PARTY-A9K2", "SS-PARTY-QM7L", "SS-PARTY-Z8P3"];

// Party capacity limits
const FREE_PARTY_LIMIT = 2; // Free parties limited to 2 phones
const FREE_DEFAULT_MAX_PHONES = 2; // Alias for clarity in new code
const MAX_PRO_PARTY_DEVICES = 100; // Practical limit for Pro parties

// Upgrade durations
const PARTY_PASS_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours for Party Pass

// Messaging rate limits (Party Pass feature)
const HOST_RATE_LIMIT = { minIntervalMs: 2000, maxPerMinute: 10 };
const GUEST_RATE_LIMIT = { minIntervalMs: 2000, maxPerMinute: 15 };
const MESSAGE_TTL_MS = 12000; // Messages auto-disappear after 12 seconds


// Host quick message mappings (DJ buttons)
const HOST_QUICK_MESSAGES = {
  WELCOME: "Welcome to Phone Party 🎉",
  MAKE_NOISE: "Make some noise 🔥",
  HANDS_UP: "Hands up 🙌",
  NEXT_UP: "Next track coming up ⏭️",
  THANKS: "Thanks for joining ❤️"
};

// Guest quick reply mappings
const GUEST_QUICK_REPLIES = {
  LOVE_THIS: "🔥 Love this",
  TURN_IT_UP: "🙌 Turn it up",
  WOW: "😮 Wow",
  DANCE: "💃 Dance break",
  BIG_VIBE: "🫶 Big vibe"
};

// Test mode flag - enables Pro checkbox, promo codes, demo ads in testing
const TEST_MODE = process.env.TEST_MODE === 'true' || process.env.NODE_ENV !== 'production';

// Debug mode flag - enables verbose logging for operations, drift, and security events
const DEBUG_MODE = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

// Feature flags for phased rollout
const ENABLE_PUBSUB = process.env.ENABLE_PUBSUB !== 'false'; // Default ON
const ENABLE_REACTION_HISTORY = process.env.ENABLE_REACTION_HISTORY !== 'false'; // Default ON
const STREAMING_PARTY_ENABLED = process.env.STREAMING_PARTY_ENABLED === 'true'; // Default OFF — must be explicitly enabled

/**
 * Returns true if the Streaming Party feature flag is enabled.
 * @returns {boolean}
 */
function isStreamingPartyEnabled() {
  return STREAMING_PARTY_ENABLED;
}

/**
 * Express middleware — rejects with 503 if Streaming Party feature flag is off.
 */
function requireStreamingEnabled(req, res, next) {
  if (!isStreamingPartyEnabled()) {
    return res.status(503).json({
      error: 'Streaming Party is not available at this time.',
      featureDisabled: true
    });
  }
  next();
}

/**
 * Express middleware — rejects with 403 if the authenticated user does not have
 * Party Pass or Pro entitlements.  Must be used after requireAuth.
 */
async function requireStreamingEntitled(req, res, next) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    const upgrades = await db.getOrCreateUserUpgrades(userId);
    const { hasPartyPass, hasPro } = db.resolveEntitlements(upgrades);
    const userObj = { entitlements: { hasPartyPass, hasPro } };
    if (!hasStreamingAccess(userObj)) {
      return res.status(403).json({
        error: 'Streaming Party requires Party Pass or Pro.',
        upgradeRequired: true
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Helper function to classify Redis error types
function getRedisErrorType(errorMessage) {
  if (!errorMessage) return 'unknown';
  
  if (errorMessage.includes('ECONNREFUSED')) return 'connection_refused';
  if (errorMessage.includes('ETIMEDOUT')) return 'timeout';
  if (errorMessage.includes('ENOTFOUND')) return 'host_not_found';
  if (errorMessage.includes('authentication') || errorMessage.includes('NOAUTH')) return 'auth_failed';
  if (errorMessage.includes('TLS') || errorMessage.includes('SSL')) return 'tls_error';
  
  return 'unknown';
}

// Helper function to sanitize Redis URL (hide password)
function sanitizeRedisUrl(redisUrl) {
  try {
    const url = new URL(redisUrl);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch (err) {
    // If URL parsing fails, fall back to simple regex
    return redisUrl.replace(/:[^:@]+@/, ':***@');
  }
}

// Helper function to sanitize text input (prevent XSS)
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  // Remove HTML tags and special characters that could be used for injection
  return text
    .replace(/[<>]/g, '') // Remove angle brackets
    .replace(/[^\w\s\u{1F000}-\u{1F9FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}.,!?'"€£$%&()[\]{}:;@#+=\-*/]/gu, '') // Keep alphanumeric, whitespace, common emojis, and safe punctuation
    .trim();
}

// Helper function to normalize party codes (trim and uppercase)
function normalizePartyCode(code) {
  if (!code || typeof code !== 'string') return '';
  return code.trim().toUpperCase();
}

/**
 * Improved error messages for better UX
 * Reference: IMPROVEMENT_SUGGESTIONS.md Section 5.2
 */
const ErrorMessages = {
  /**
   * Get descriptive error message for party not found
   * @param {Object} partyData - Party data if available
   * @returns {string} User-friendly error message
   */
  partyNotFound(partyData = null) {
    if (partyData) {
      if (partyData.status === 'expired') {
        return 'This party has expired. Parties last 2 hours. Please create a new party.';
      }
      if (partyData.status === 'ended') {
        return 'The host ended this party. Please join another party or create your own.';
      }
    }
    return 'Party code not found. Please check for typos and try again.';
  },
  
  /**
   * Get descriptive error message for connection issues
   * @param {string} errorType - Type of connection error
   * @returns {string} User-friendly error message
   */
  connectionFailed(errorType = 'unknown') {
    switch (errorType) {
      case 'network':
        return 'Connection failed. Please check your internet connection and try again.';
      case 'server_down':
        return 'Server temporarily unavailable. Please try again in a few moments.';
      case 'rate_limit':
        return 'Too many requests. Please wait a moment and try again.';
      case 'timeout':
        return 'Connection timeout. Please check your connection and try again.';
      default:
        return 'Connection failed. Please check your internet connection.';
    }
  },
  
  /**
   * Get descriptive error message for party full
   * @param {number} maxCapacity - Maximum party capacity
   * @param {string} tier - Party tier
   * @returns {string} User-friendly error message
   */
  partyFull(maxCapacity, tier = 'Free') {
    if (tier === 'Free' || tier === 'Prototype') {
      return `Party is full (${maxCapacity} phones max on ${tier} tier). Host can upgrade to Pro for up to 100 phones.`;
    }
    return `Party has reached maximum capacity of ${maxCapacity} phones.`;
  },
  
  /**
   * Get descriptive error message for invalid party code
   * @returns {string} User-friendly error message
   */
  invalidPartyCode() {
    return 'Invalid party code format. Party codes are 6 characters (letters and numbers only).';
  }
};

// Helper function to safely parse JSON with fallback
function safeJsonParse(str, fallback = null) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch (err) {
    console.warn('[safeJsonParse] Failed to parse JSON:', err.message);
    return fallback;
  }
}

// Detect production mode - Railway sets NODE_ENV or we can detect by presence of RAILWAY_ENVIRONMENT
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT || !!process.env.REDIS_URL;

// Track server startup time for uptime calculation
const SERVER_START_TIME = Date.now();

// Optional fallback mode flag (for emergency use in production)
const ALLOW_FALLBACK_IN_PRODUCTION = process.env.ALLOW_FALLBACK_IN_PRODUCTION === 'true';

// ============================================================================
// SECTION 8: FAIL-FAST CONFIG VALIDATION (PRODUCTION ONLY)
// ============================================================================
function validateProductionConfig() {
  if (!IS_PRODUCTION || process.env.NODE_ENV === 'test' || process.env.TEST_MODE === 'true') {
    console.log('[Config] Development mode - skipping strict validation');
    return;
  }

  const warnings = [];

  // Strongly recommended in production (but not blocking startup)
  if (!process.env.PUBLIC_BASE_URL) {
    warnings.push('PUBLIC_BASE_URL not set – proxy-based URL generation will use request host');
  }

  if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
    warnings.push('REDIS_URL not set – running in single-instance fallback mode (multi-device sync disabled)');
  }

  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    warnings.push('DATABASE_URL not set – user auth and subscriptions will not work');
  }

  // JWT_SECRET check
  if (process.env.JWT_SECRET === 'your-secret-key-here' || !process.env.JWT_SECRET) {
    warnings.push('JWT_SECRET not set – authentication is disabled');
  }

  // S3 storage check
  const hasS3Config = !!(
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY
  );

  if (!hasS3Config && process.env.ALLOW_LOCAL_DISK_IN_PROD !== 'true') {
    warnings.push('S3 storage not configured – file uploads will use local disk (not recommended in production)');
  }

  if (hasS3Config && !process.env.S3_ENDPOINT) {
    warnings.push('S3_ENDPOINT not set - assuming AWS S3');
  }

  // Report warnings (server always starts regardless)
  if (warnings.length > 0) {
    console.warn('');
    console.warn('═══════════════════════════════════════════════════════════');
    console.warn('  ⚠️  PRODUCTION CONFIGURATION WARNINGS');
    console.warn('═══════════════════════════════════════════════════════════');
    warnings.forEach((warn, i) => {
      console.warn(`  ${i + 1}. ${warn}`);
    });
    console.warn('  Server will start; affected features will be degraded.');
    console.warn('═══════════════════════════════════════════════════════════');
    console.warn('');
  }
}

// Run config validation
validateProductionConfig();

// ============================================================================
// STARTUP DIAGNOSTIC LOG BLOCK
// ============================================================================
console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  📊 STARTUP DIAGNOSTICS');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  APP_VERSION:          ${APP_VERSION}`);
console.log(`  CHANGER_VERSION:      ${CHANGER_VERSION}`);
console.log(`  INSTANCE_ID:          ${INSTANCE_ID}`);
console.log(`  NODE_ENV:             ${process.env.NODE_ENV || 'not set'}`);
console.log(`  IS_PRODUCTION:        ${IS_PRODUCTION}`);
console.log(`  RAILWAY_ENVIRONMENT:  ${process.env.RAILWAY_ENVIRONMENT || 'not set'}`);
console.log(`  ALLOW_FALLBACK:       ${ALLOW_FALLBACK_IN_PRODUCTION}`);
console.log(`  PUBLIC_BASE_URL:      ${process.env.PUBLIC_BASE_URL || 'not set (dev auto-detect)'}`);
console.log('═══════════════════════════════════════════════════════════');
console.log('');

// Redis configuration check - REDIS_URL is REQUIRED in production
// This ensures we fail loudly if Redis is not properly configured
let redisConfig;
let redisConnectionError = null;
let redisLastErrorAt = null; // Track when last error occurred
let redisConfigSource = null;
let usesTls = false; // Track if using TLS for later reference
let rejectUnauthorized = false; // Track TLS verification setting

if (process.env.REDIS_URL) {
  // Railway/production: Use REDIS_URL
  const redisUrl = process.env.REDIS_URL;
  redisConfigSource = 'REDIS_URL';
  
  // Check if URL uses TLS (rediss://)
  usesTls = redisUrl.startsWith('rediss://');
  
  if (usesTls) {
    // Parse URL to extract components for TLS configuration
    // ioredis can handle rediss:// URLs, but we need to ensure TLS is configured
    
    // Security Note: Railway Redis and many managed Redis services use self-signed certificates.
    // For production deployments, you can enable strict TLS verification by setting:
    // REDIS_TLS_REJECT_UNAUTHORIZED=true
    // Default is 'false' to work with Railway and similar services out-of-the-box.
    rejectUnauthorized = process.env.REDIS_TLS_REJECT_UNAUTHORIZED === 'true';
    
    redisConfig = {
      // ioredis will parse the URL automatically
      // but we explicitly set TLS options for Railway compatibility
      tls: {
        rejectUnauthorized: rejectUnauthorized,
      },
      retryStrategy(times) {
        // Limit retries to prevent infinite reconnect spam
        if (times > 10) {
          console.error('[Redis] Max reconnection attempts (10) reached. Stopping retries.');
          return null; // Stop retrying
        }
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      connectTimeout: 10000,
    };
    console.log(`[Startup] Redis config: Using REDIS_URL with TLS (rediss://)`);
    console.log(`[Startup] TLS certificate verification: ${rejectUnauthorized ? 'ENABLED (strict)' : 'DISABLED (Railway-compatible)'}`);
  } else {
    // Standard redis:// URL - create config with retry options
    redisConfig = {
      retryStrategy(times) {
        // Limit retries to prevent infinite reconnect spam
        if (times > 10) {
          console.error('[Redis] Max reconnection attempts (10) reached. Stopping retries.');
          return null; // Stop retrying
        }
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      connectTimeout: 10000,
    };
    console.log(`[Startup] Redis config: Using REDIS_URL without TLS (redis://)`);
  }
  
  // Log sanitized connection info (hide password)
  const sanitizedUrl = sanitizeRedisUrl(redisUrl);
  console.log(`[Startup] Redis URL (sanitized): ${sanitizedUrl}`);
  console.log(`[Startup] redisConfigSource: ${redisConfigSource}, usesTls: ${usesTls}, rejectUnauthorized: ${rejectUnauthorized}`);
} else if (process.env.REDIS_HOST || process.env.NODE_ENV === 'test') {
  // Development/test: Use individual Redis settings or test environment
  redisConfigSource = process.env.NODE_ENV === 'test' ? 'test_mode' : 'REDIS_HOST';
  redisConfig = {
    host: process.env.REDIS_HOST || "localhost",
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    retryStrategy(times) {
      // Limit retries to prevent infinite reconnect spam
      if (times > 10) {
        console.error('[Redis] Max reconnection attempts (10) reached. Stopping retries.');
        return null; // Stop retrying
      }
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    connectTimeout: 10000,
  };
  console.log(`[Startup] Redis config: Using REDIS_HOST=${redisConfig.host}:${redisConfig.port}`);
} else {
  // No Redis configuration found - this is a critical error in production
  redisConfigSource = 'none';
  console.error("❌ CRITICAL: Redis configuration missing!");
  console.error("   Set REDIS_URL environment variable for production.");
  console.error("   For development, set REDIS_HOST (defaults to localhost).");
  redisConnectionError = "Redis configuration missing - no REDIS_URL or REDIS_HOST provided";
  redisLastErrorAt = Date.now();
  
  if (IS_PRODUCTION) {
    console.error("");
    console.error("╔═══════════════════════════════════════════════════════════════╗");
    console.error("║  ❌ FATAL: Cannot run in production mode without Redis!       ║");
    console.error("╟───────────────────────────────────────────────────────────────╢");
    console.error("║  Server will start but will NOT be ready (503 responses)     ║");
    console.error("║                                                               ║");
    console.error("║  TO FIX:                                                      ║");
    console.error("║  1. Set REDIS_URL environment variable                       ║");
    console.error("║  2. Ensure URL format: rediss://user:pass@host:port           ║");
    console.error("║  3. Verify Redis service is running                          ║");
    console.error("║  4. Check /api/health and /api/debug/redis for diagnostics   ║");
    console.error("║                                                               ║");
    console.error("║  EMERGENCY FALLBACK (not recommended):                       ║");
    console.error("║  Set ALLOW_FALLBACK_IN_PRODUCTION=true                       ║");
    console.error("╚═══════════════════════════════════════════════════════════════╝");
    console.error("");
  }
}

// Redis client setup
let redis = null;
if (redisConfig) {
  try {
    // For rediss:// URLs with object config, we need to parse the URL
    if (typeof redisConfig === 'object' && usesTls) {
      redis = new Redis(process.env.REDIS_URL, redisConfig);
      console.log(`[Startup] Redis client created with TLS from URL + options`);
    } else if (typeof redisConfig === 'object') {
      // Non-TLS with object config (redis:// or REDIS_HOST)
      if (process.env.REDIS_URL) {
        redis = new Redis(process.env.REDIS_URL, redisConfig);
        console.log(`[Startup] Redis client created from URL + options (source: ${redisConfigSource})`);
      } else {
        redis = new Redis(redisConfig);
        console.log(`[Startup] Redis client created from config (source: ${redisConfigSource})`);
      }
    } else {
      // String config (legacy path)
      redis = new Redis(redisConfig);
      console.log(`[Startup] Redis client created from config string (source: ${redisConfigSource})`);
    }
  } catch (err) {
    console.error(`[Startup] Failed to create Redis client:`, err.message);
    redisConnectionError = err.message;
    redisLastErrorAt = Date.now();
  }
}

// Track Redis connection state
let redisReady = false;
let useFallbackMode = false;

// Track DB readiness (set in startServer; used by /readyz)
let dbReady = false;

if (redis) {
  redis.on("connect", () => {
    console.log(`[Redis] TCP connection established (instance: ${INSTANCE_ID}, source: ${redisConfigSource})`);
    redisConnectionError = null;
  });

  redis.on("error", (err) => {
    const errorType = err.code || err.name || 'unknown';
    console.error(`[Redis] Error [${errorType}] (instance: ${INSTANCE_ID}):`, err.message || '(no message)');
    
    // Provide actionable error messages for common issues - check err.code
    if (err.code === 'ECONNREFUSED' || err.message.includes('ECONNREFUSED')) {
      console.error(`   → Redis server not reachable. Check REDIS_URL or REDIS_HOST.`);
    } else if (err.code === 'ETIMEDOUT' || err.message.includes('ETIMEDOUT')) {
      console.error(`   → Connection timeout. Check network/firewall settings.`);
    } else if (err.code === 'ENOTFOUND' || err.message.includes('ENOTFOUND')) {
      console.error(`   → Redis host not found. Verify REDIS_URL hostname.`);
    } else if (err.message.includes('authentication') || err.message.includes('NOAUTH')) {
      console.error(`   → Authentication failed. Check Redis password in REDIS_URL.`);
    } else if (err.message.includes('TLS') || err.message.includes('SSL')) {
      console.error(`   → TLS/SSL error. Ensure rediss:// URL is used for TLS connections.`);
    }
    
    redisConnectionError = err.message || err.code || 'Unknown error';
    redisLastErrorAt = Date.now();
    redisReady = false; // IMPORTANT: Mark as not ready on any error
    if (!useFallbackMode) {
      console.warn(`⚠️  Redis unavailable — using fallback mode (instance: ${INSTANCE_ID})`);
      useFallbackMode = true;
    }
  });

  redis.on("ready", () => {
    console.log(`✅ Redis READY (instance: ${INSTANCE_ID}, source: ${redisConfigSource})`);
    console.log(`   → Multi-device party sync enabled`);
    redisReady = true;
    redisConnectionError = null;
    redisLastErrorAt = null;
    useFallbackMode = false;
  });
  
  redis.on("close", () => {
    console.warn(`⚠️  [Redis] Connection closed (instance: ${INSTANCE_ID})`);
    redisReady = false;
  });
  
  redis.on("reconnecting", (delay) => {
    console.log(`[Redis] Reconnecting in ${delay}ms (instance: ${INSTANCE_ID})...`);
  });
} else {
  console.warn("⚠️  Redis client not created — using fallback mode");
  console.warn(`   → Parties stored in memory only (single-instance mode)`);
  useFallbackMode = true;
}

// Redis Pub/Sub for multi-instance support (Phase 8)
let redisPub = null;
let redisSub = null;
let pubsubEnabled = false;
let pubsubFailureCount = 0;
const PUBSUB_MAX_FAILURES = 5; // Disable after 5 consecutive failures
const PUBSUB_CHANNEL = "party:broadcast";

if (ENABLE_PUBSUB && redisConfig) {
  try {
    // Create separate connections for pub and sub
    // CRITICAL FIX: Always use process.env.REDIS_URL when available to avoid localhost fallback
    if (process.env.REDIS_URL) {
      // Use REDIS_URL with appropriate config options (TLS if needed)
      redisPub = new Redis(process.env.REDIS_URL, redisConfig);
      redisSub = new Redis(process.env.REDIS_URL, redisConfig);
    } else if (typeof redisConfig === 'object' && redisConfig.host) {
      // Fallback to host/port config (development only)
      redisPub = new Redis(redisConfig);
      redisSub = new Redis(redisConfig);
    } else {
      throw new Error('No valid Redis configuration for PubSub');
    }
    
    console.log(`[PubSub] Publisher and subscriber clients created (instance: ${INSTANCE_ID})`);
    
    // Add ready handlers to track connection state
    let pubReady = false;
    let subReady = false;
    
    redisPub.on('ready', () => {
      pubReady = true;
      if (subReady) {
        pubsubEnabled = true;
        pubsubFailureCount = 0; // Reset failure count on successful connection
        console.log(`[PubSub] Both clients ready - PubSub enabled`);
      }
    });
    
    redisSub.on('ready', () => {
      subReady = true;
      if (pubReady) {
        pubsubEnabled = true;
        pubsubFailureCount = 0; // Reset failure count on successful connection
        console.log(`[PubSub] Both clients ready - PubSub enabled`);
      }
    });
    
    // Subscribe to broadcast channel
    redisSub.subscribe(PUBSUB_CHANNEL, (err, count) => {
      if (err) {
        console.error(`[PubSub] Failed to subscribe to ${PUBSUB_CHANNEL}:`, err.message);
        pubsubEnabled = false;
      } else {
        console.log(`[PubSub] Subscribed to ${PUBSUB_CHANNEL} (${count} active subscriptions)`);
      }
    });
    
    // Handle incoming messages from other instances
    redisSub.on('message', (channel, message) => {
      if (channel !== PUBSUB_CHANNEL) return;
      
      try {
        const data = safeJsonParse(message);
        if (!data || !data.code || !data.kind || !data.payload) {
          console.warn(`[PubSub] Invalid message format from ${channel}`);
          return;
        }
        
        // Don't forward messages from this instance
        if (data.instanceId === INSTANCE_ID) return;
        
        const { code, kind, payload } = data;
        const party = parties.get(code);
        
        if (!party) {
          // Party doesn't exist locally - that's OK, means no local clients
          return;
        }
        
        console.log(`[PubSub] Received ${kind} for party ${code} from instance ${data.instanceId}`);
        
        // Forward to all local members of this party
        const messageStr = JSON.stringify(payload);
        party.members.forEach(m => {
          if (m.ws.readyState === WebSocket.OPEN) {
            m.ws.send(messageStr);
          }
        });
      } catch (err) {
        console.error(`[PubSub] Error handling message:`, err.message);
      }
    });
    
    // Error handlers with connection state management
    redisSub.on('error', (err) => {
      console.error(`[PubSub] Subscriber error:`, err.message);
      pubsubEnabled = false;
    });
    
    redisPub.on('error', (err) => {
      console.error(`[PubSub] Publisher error:`, err.message);
      pubsubEnabled = false;
    });
    
    // Prevent infinite reconnect spam
    redisSub.on('close', () => {
      pubsubEnabled = false;
      console.log(`[PubSub] Subscriber connection closed`);
    });
    
    redisPub.on('close', () => {
      pubsubEnabled = false;
      console.log(`[PubSub] Publisher connection closed`);
    });
  } catch (err) {
    console.error(`[PubSub] Failed to create pub/sub clients:`, err.message);
    pubsubEnabled = false;
    redisPub = null;
    redisSub = null;
  }
} else {
  console.log(`[PubSub] Disabled (ENABLE_PUBSUB=${ENABLE_PUBSUB}, redisConfig=${!!redisConfig})`);
}

// Initialize production services
let metricsService = null;
let referralSystem = null;

// Initialize services after Redis is available
if (redis) {
  try {
    metricsService = new MetricsService(db, redis);
    referralSystem = new ReferralSystem(db, redis);
    console.log('[Services] ✅ MetricsService and ReferralSystem initialized');
  } catch (err) {
    console.error('[Services] Failed to initialize production services:', err.message);
  }
} else {
  console.warn('[Services] ⚠️  Production services disabled (Redis not available)');
}

// SECTION 6: HTTP Security Baseline
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

// Disable X-Powered-By header
app.disable('x-powered-by');

// Configure helmet with safe defaults
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP to avoid breaking inline scripts
  crossOriginEmbedderPolicy: false // Allow loading resources from other origins
}));

// Enable response compression
app.use(compression());

// Configure CORS
const corsOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(o => o.trim()) : [];
const corsOptions = {
  origin: corsOrigins.length > 0 ? corsOrigins : false, // Deny CORS by default unless explicitly configured
  credentials: true
};
app.use(cors(corsOptions));

// Body size limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// Helper to set secure cookies in production
function setSecureCookie(res, name, value, options = {}) {
  const defaultOptions = process.env.NODE_ENV === 'production' ? {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    ...options
  } : options;
  
  res.cookie(name, value, defaultOptions);
}

// Export for use in route handlers
app.locals.setSecureCookie = setSecureCookie;

// SECTION 2: Trust proxy for Railway deployment (behind HTTPS proxy)
app.set('trust proxy', 1);

// Helper function to detect HTTPS for cookie secure flag
// With trust proxy enabled, req.secure and req.protocol correctly handle X-Forwarded-Proto
// including comma-separated values like 'https,http'
function isHttpsRequest(req) {
  return req.secure || req.protocol === 'https';
}

// Parse cookies for JWT authentication
app.use(cookieParser());

// Sentry request handler must be the first middleware on the app
if (process.env.NODE_ENV === 'production' && process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.tracingHandler());
}

// Cache-Control value used for all assets that must re-validate on every deploy.
const NO_CACHE = 'no-cache, must-revalidate';

// Loose rate limiter for explicit static asset routes (1200 req / 15 min per IP).
// Prevents abuse of the sendFile file-system reads on these routes.
const staticLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1200 });

// Add version header to all responses
app.use((req, res, next) => {
  res.setHeader("X-App-Version", APP_VERSION);
  res.setHeader("X-Changer-Version", CHANGER_VERSION);
  next();
});

// Serve static files from the repo root.
// HTML, JS, and CSS files use no-cache so browsers always revalidate after a deploy.
app.use(express.static(__dirname, {
  setHeaders(res, filePath) {
    if (/\.(html|js|css|svg)$/.test(filePath)) {
      res.setHeader('Cache-Control', NO_CACHE);
    }
  }
}));

// Serve uploaded files from the uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// SECTION 3: Initialize storage provider (S3 or local disk)
const { initStorage } = require('./storage');
let storageProvider = null;
let storageReady = false;

// Storage initialization function (called from startServer)
async function initializeStorage() {
  try {
    storageProvider = await initStorage();
    storageReady = true;
    console.log('[Storage] Storage provider ready');
  } catch (err) {
    console.error('[Storage] Failed to initialize storage provider:', err.message);
    console.warn('[Storage] Continuing without storage provider – file uploads will be unavailable');
  }
}

// PHASE 1: Helper to determine best playback URL (CDN/R2 direct or proxy fallback)
function getPlaybackUrl(trackId, key) {
  if (trackId == null) {
    throw new Error('trackId must not be null or undefined in getPlaybackUrl');
  }

  // Normalize key to avoid double slashes when joining with base URLs
  const normalizedKey = String(key || '').replace(/^\/+/, '');
  
  // Priority 1: CDN URL (best performance)
  if (process.env.CDN_BASE_URL && normalizedKey) {
    const cdnBase = process.env.CDN_BASE_URL.replace(/\/$/, '');
    return `${cdnBase}/${normalizedKey}`;
  }
  
  // Priority 2: S3 Public URL (direct R2 access)
  if (process.env.S3_PUBLIC_BASE_URL && normalizedKey) {
    const s3Base = process.env.S3_PUBLIC_BASE_URL.replace(/\/$/, '');
    return `${s3Base}/${normalizedKey}`;
  }
  
  // Priority 3: Proxy route fallback (works without CDN/R2 config)
  if (process.env.PUBLIC_BASE_URL) {
    const baseUrl = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
    return `${baseUrl}/api/track/${trackId}`;
  }
  
  // Fallback for local dev (no PUBLIC_BASE_URL set)
  return `/api/track/${trackId}`;
}

// Configure TRACK_MAX_BYTES from environment (default 50MB)
const DEFAULT_TRACK_MAX_BYTES = 50 * 1024 * 1024; // 50MB
const TRACK_MAX_BYTES = (() => {
  const raw = process.env.TRACK_MAX_BYTES;
  
  if (!raw) {
    console.log(`[Config] TRACK_MAX_BYTES not set. Using default ${DEFAULT_TRACK_MAX_BYTES} bytes (${DEFAULT_TRACK_MAX_BYTES / 1024 / 1024}MB)`);
    return DEFAULT_TRACK_MAX_BYTES;
  }
  
  const parsed = parseInt(raw, 10);
  
  if (isNaN(parsed) || parsed <= 0) {
    console.warn(`[Config] Invalid TRACK_MAX_BYTES value: "${raw}". Using default ${DEFAULT_TRACK_MAX_BYTES} bytes`);
    return DEFAULT_TRACK_MAX_BYTES;
  }

  console.log(`[Config] TRACK_MAX_BYTES set to ${parsed} bytes (${(parsed / 1024 / 1024).toFixed(2)}MB)`);
  return parsed;
})();

// Configure multer for file uploads - use disk storage to avoid memory buffering
const multerStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Use temp directory for uploaded files
    const uploadTempDir = path.join(__dirname, 'uploads-temp');
    if (!fs.existsSync(uploadTempDir)) {
      fs.mkdirSync(uploadTempDir, { recursive: true });
    }
    cb(null, uploadTempDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename to avoid collisions using crypto.randomUUID for better uniqueness
    const uniqueId = require('crypto').randomUUID();
    cb(null, 'upload-' + uniqueId + '-' + file.originalname);
  }
});

const upload = multer({
  storage: multerStorage,
  limits: {
    fileSize: TRACK_MAX_BYTES
  },
  fileFilter: function (req, file, cb) {
    // Accept audio files only
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }
});

// Helper function to extract registered routes from Express app
// Returns: Array of objects with {path: string, methods: string} properties
// Note: Uses Express internal _router property - may break in future Express versions
// Includes guard checks to gracefully handle API changes; returns empty array if unavailable
function getRegisteredRoutes() {
  const routes = [];
  
  // Guard check for Express internal API
  if (!app._router || !app._router.stack) {
    console.warn('[getRegisteredRoutes] Warning: Express _router not available');
    return routes;
  }
  
  // Extract routes from Express app
  app._router.stack.forEach((middleware) => {
    // Guard check for middleware existence
    if (!middleware) return;
    
    if (middleware.route) {
      // Routes registered directly on the app
      const methods = Object.keys(middleware.route.methods)
        .map(m => m.toUpperCase())
        .join(', ');
      routes.push({
        path: middleware.route.path,
        methods: methods
      });
    } else if (middleware.name === 'router' && middleware.handle && middleware.handle.stack) {
      // Router middleware
      middleware.handle.stack.forEach((handler) => {
        // Guard check for handler existence
        if (!handler || !handler.route) return;
        
        const methods = Object.keys(handler.route.methods)
          .map(m => m.toUpperCase())
          .join(', ');
        routes.push({
          path: handler.route.path,
          methods: methods
        });
      });
    }
  });
  
  return routes;
}

// Explicit static asset routes — must come BEFORE any SPA catch-all so these
// files are never shadowed by a wildcard route, even if one is added later.
// Express sets Content-Type automatically via sendFile.
app.get("/app.js", staticLimiter, (req, res) => {
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(__dirname, "app.js"));
});

app.get("/service-worker.js", staticLimiter, (req, res) => {
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(__dirname, "service-worker.js"));
});

app.get("/manifest.json", staticLimiter, (req, res) => {
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(__dirname, "manifest.json"));
});

// Platform logo SVG assets — single parameterized route with allowlist validation
// and no-cache headers so service-worker caches never serve a stale logo after
// a brand-asset update.
const ALLOWED_PLATFORM_LOGOS = new Set(['youtube', 'spotify', 'soundcloud']);
app.get("/public/assets/platform-logos/:platform.svg", staticLimiter, (req, res) => {
  if (!ALLOWED_PLATFORM_LOGOS.has(req.params.platform)) return res.status(404).end();
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(__dirname, "public/assets/platform-logos", `${req.params.platform}.svg`));
});

// Streaming Party provider SVG assets — identical allowlist, served from providers/ directory
app.get("/public/assets/providers/:platform.svg", staticLimiter, (req, res) => {
  if (!ALLOWED_PLATFORM_LOGOS.has(req.params.platform)) return res.status(404).end();
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(__dirname, "public/assets/providers", `${req.params.platform}.svg`));
});

// Diagnostic endpoint — returns version info so you can confirm which build is
// running from a mobile browser without any CLI access.
// Does NOT expose secrets; only uses constants already logged at startup.
app.get("/__version", (req, res) => {
  res.setHeader('Cache-Control', NO_CACHE);
  res.json({
    appVersion: APP_VERSION,
    changerVersion: CHANGER_VERSION,
    instanceId: INSTANCE_ID,
    nodeEnv: process.env.NODE_ENV || 'development'
  });
});

// GET /version – returns build metadata for Cloud Run / pipeline verification
app.get("/version", (req, res) => {
  res.setHeader('Cache-Control', NO_CACHE);
  res.json({
    commit: process.env.COMMIT_SHA || 'unknown',
    environment: process.env.NODE_ENV,
    appVersion: APP_VERSION,
    timestamp: new Date().toISOString(),
    nodeVersion: process.version
  });
});

// GET /ready – confirms the app is up and ready to serve traffic
app.get("/ready", (req, res) => {
  res.status(200).json({ status: 'ready' });
});

// Route for serving index.html at root "/"
app.get("/", (req, res) => {
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(__dirname, "index.html"));
});

// ─── Invite Landing Page ───────────────────────────────────────────────────────
app.get('/invite/:code', async (req, res) => {
  const code    = (req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const inviteUrl = `${baseUrl}/invite/${code}`;

  // Record the click (fire-and-forget, don't delay the page response)
  if (referralSystem) {
    referralSystem.recordClick(code, req.ip, req.headers['user-agent']).catch(() => {});
  }

  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>You're invited to Phone Party 🎉</title>
<!-- Open Graph -->
<meta property="og:title" content="Join my Phone Party 🎉" />
<meta property="og:description" content="Turn phones into one massive speaker system. Download the app and join my party instantly!" />
<meta property="og:image" content="${baseUrl}/icons/icon-512.png" />
<meta property="og:url" content="${inviteUrl}" />
<meta property="og:type" content="website" />
<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Join my Phone Party 🎉" />
<meta name="twitter:description" content="Turn phones into one massive speaker system." />
<meta name="twitter:image" content="${baseUrl}/icons/icon-512.png" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #0a0a0f; color: #fff; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; padding: 1rem; }
  .card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
          border-radius: 16px; padding: 2rem; max-width: 420px; width: 100%; text-align: center; }
  h1 { font-size: 2rem; margin-bottom: 0.5rem; }
  p  { color: #aaa; margin-bottom: 1.5rem; }
  .btn { display: block; width: 100%; padding: 0.9rem 1.5rem; border: none;
         border-radius: 12px; font-size: 1rem; font-weight: 600; cursor: pointer;
         text-decoration: none; margin-bottom: 0.75rem; }
  .btn-primary { background: linear-gradient(135deg,#9D4EDD,#5AA9FF); color: #fff; }
  .code { font-family: monospace; font-size: 1.4rem; letter-spacing: 4px;
          color: #9D4EDD; background: rgba(157,78,221,0.1);
          border-radius: 8px; padding: 0.75rem 1rem; margin: 1rem 0; }
</style>
</head>
<body>
<div class="card">
  <h1>🎉 Phone Party</h1>
  <p>You've been invited to join a Phone Party!<br>
     Turn your phones into one massive speaker system.</p>
  <div class="code">${code}</div>
  <a class="btn btn-primary" href="${baseUrl}/?ref=${code}&clickSource=invite_page">
    🚀 Open Phone Party
  </a>
  <p style="font-size:0.8rem;color:#666;">
    Your referral code is saved automatically.
  </p>
</div>
<script>
  // Store referral info so the app can pick it up after install / first launch
  try {
    localStorage.setItem('referral_code', ${JSON.stringify(code)});
    localStorage.setItem('referral_ts',   Date.now().toString());
  } catch(_) {}
</script>
</body>
</html>`);
});

// Health check endpoint with detailed Redis status
app.get("/health", async (req, res) => {
  let redisStatus;
  
  if (!redis || redisConnectionError || !redisReady) {
    redisStatus = "fallback";
  } else if (redis.status === "ready" && redisReady) {
    redisStatus = "ready";
  } else {
    redisStatus = "error";
  }
  
  const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
  
  const health = { 
    status: "ok", 
    instanceId: INSTANCE_ID,
    redis: redisStatus,
    version: APP_VERSION,
    configSource: redisConfigSource,
    uptimeSeconds: uptimeSeconds
  };
  
  // Include error details if Redis has issues
  if (redisConnectionError) {
    health.redisError = redisConnectionError;
    health.redisErrorType = getRedisErrorType(redisConnectionError);
    if (redisLastErrorAt) {
      health.redisLastErrorAt = new Date(redisLastErrorAt).toISOString();
    }
  }
  
  res.json(health);
});

// Liveness probe: always returns 200 so Cloud Run knows the process is alive
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

// Readiness probe: returns 200 only when the database is ready, else 503
app.get("/readyz", async (_req, res) => {
  try {
    const check = await db.healthCheck();
    if (check.healthy) {
      res.status(200).json({ ok: true, db: "ready" });
    } else {
      res.status(503).json({ ok: false, db: "unavailable" });
    }
  } catch (_err) {
    res.status(503).json({ ok: false, db: "unavailable" });
  }
});

// API health endpoint with full spec - returns ok: true/false based on readiness
// In production mode, server is NOT ready if Redis is unavailable
// In development mode, server is always ready (uses fallback storage)
app.get("/api/health", async (req, res) => {
  let redisConnected = !!(redis && redisReady && !redisConnectionError);
  let redisPingResult = null;
  let redisPingError = null;
  
  // If Redis appears ready, perform an actual ping test with timeout
  if (redisConnected && redis) {
    try {
      const pingPromise = redis.ping();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Ping timeout')), 1000)
      );
      
      redisPingResult = await Promise.race([pingPromise, timeoutPromise]);
      
      if (redisPingResult !== 'PONG') {
        redisConnected = false;
        redisPingError = `Unexpected ping response: ${redisPingResult}`;
      }
    } catch (err) {
      redisConnected = false;
      redisPingError = err.message;
      console.error(`[Health] Redis ping failed: ${err.message}`);
    }
  }
  
  // Check database health (best effort)
  let dbConnected = false;
  try {
    const dbHealth = await db.healthCheck();
    dbConnected = dbHealth.healthy;
  } catch (err) {
    console.error(`[Health] Database check failed: ${err.message}`);
  }
  
  // Determine storage mode based on S3 configuration
  const hasS3 = !!(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
  const storageMode = hasS3 ? 's3' : 'local';
  
  // Get version from GIT_SHA env or default to "unknown"
  const version = process.env.GIT_SHA || 'unknown';
  
  // In production, we require Redis to be ready
  // In development, we allow fallback mode
  const isReady = IS_PRODUCTION ? redisConnected : true;
  
  const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
  
  const health = {
    ok: isReady,
    redisConnected,
    dbConnected,
    storageMode,
    version,
    instanceId: INSTANCE_ID,
    redis: {
      connected: redisConnected,
      status: redisConnected ? 'ready' : (redisConnectionError || 'not_connected'),
      mode: IS_PRODUCTION ? 'required' : 'optional',
      configSource: redisConfigSource
    },
    uptimeSeconds: uptimeSeconds,
    timestamp: new Date().toISOString(),
    app: {
      version: APP_VERSION,
      gitSha: version
    },
    environment: IS_PRODUCTION ? 'production' : 'development'
  };
  
  // Add detailed error type and last error info if Redis has issues
  if (redisConnectionError) {
    health.redis.errorType = getRedisErrorType(redisConnectionError);
    health.redis.lastError = redisConnectionError;
    if (redisLastErrorAt) {
      health.redis.lastErrorAt = new Date(redisLastErrorAt).toISOString();
    }
  }
  
  // Add ping error if applicable
  if (redisPingError) {
    health.redis.pingError = redisPingError;
  }
  
  // Return 503 if not ready (production mode without Redis)
  const statusCode = isReady ? 200 : 503;
  res.status(statusCode).json(health);
});

// Simple ping endpoint for testing client->server
app.get("/api/ping", (req, res) => {
  res.json({ message: "pong", timestamp: Date.now() });
});

// Debug endpoint for Redis diagnostics
// Provides detailed Redis connection status and configuration info (no secrets)
app.get("/api/debug/redis", async (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
  
  // Perform a ping test if Redis is available
  let pingResult = null;
  let pingError = null;
  let pingLatencyMs = null;
  
  if (redis) {
    try {
      const startTime = Date.now();
      const pingPromise = redis.ping();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Ping timeout (1000ms)')), 1000)
      );
      
      pingResult = await Promise.race([pingPromise, timeoutPromise]);
      pingLatencyMs = Date.now() - startTime;
    } catch (err) {
      pingError = err.message;
    }
  }
  
  const debug = {
    instanceId: INSTANCE_ID,
    version: APP_VERSION,
    environment: IS_PRODUCTION ? 'production' : 'development',
    uptimeSeconds: uptimeSeconds,
    timestamp: new Date().toISOString(),
    redis: {
      clientCreated: !!redis,
      ready: redisReady,
      status: redis ? redis.status : 'not_created',
      configSource: redisConfigSource,
      usesTls: usesTls,
      rejectUnauthorized: rejectUnauthorized,
      connectionError: redisConnectionError,
      lastErrorAt: redisLastErrorAt ? new Date(redisLastErrorAt).toISOString() : null,
      errorType: redisConnectionError ? getRedisErrorType(redisConnectionError) : null,
      ping: {
        result: pingResult,
        error: pingError,
        latencyMs: pingLatencyMs
      }
    },
    fallbackMode: useFallbackMode,
    allowFallbackInProduction: ALLOW_FALLBACK_IN_PRODUCTION
  };
  
  res.json(debug);
});

// Debug endpoint to list all registered routes
// This endpoint helps verify which routes are registered at runtime
// Useful for production debugging when routes appear to be missing
// NOTE: This endpoint is intentionally enabled for production debugging and verification
// WARNING: Exposes application structure. Consider adding authentication in future versions
// if this becomes a security concern
app.get("/api/routes", (req, res) => {
  const routes = getRegisteredRoutes();
  
  res.json({
    instanceId: INSTANCE_ID,
    version: APP_VERSION,
    routes: routes,
    totalRoutes: routes.length
  });
});

// ============================================================================
// RATE LIMITERS
// ============================================================================

/**
 * Returns true when rate limiting should be bypassed.
 * Bypassed in test mode (NODE_ENV=test) and when DISABLE_RATE_LIMIT=true
 * (for CI/E2E audit runs). Evaluated at request time so env changes
 * made after module load (e.g. in integration tests) are respected.
 */
function shouldBypassRateLimit() {
  return process.env.NODE_ENV === 'test' || process.env.DISABLE_RATE_LIMIT === 'true';
}

/** No-op middleware used when rate limiting is bypassed. */
const rateLimitBypass = (req, res, next) => next();

/**
 * Custom rate-limit handler that always returns application/json so clients
 * (including the frontend auth.js) can reliably parse the error body.
 */
function jsonRateLimitHandler(req, res, next, options) {
  res.status(options.statusCode).json(options.message);
}

// Rate limiter for auth endpoints (stricter)
// Returns JSON so the frontend can display a proper error message (not "Server returned non-JSON error").
const authLimiter = shouldBypassRateLimit()
  ? rateLimitBypass
  : rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 10, // Limit each IP to 10 requests per windowMs (allows for typos)
      // JSON message so clients always get a parseable error body
      message: { error: 'Too many authentication attempts, please try again later' },
      standardHeaders: true,
      legacyHeaders: false,
      handler: jsonRateLimitHandler,
    });

// Rate limiter for general API endpoints
// Skip in test/CI mode to prevent E2E test suites from exhausting the per-IP budget
// (many tests call /api/me repeatedly from the same loopback address).
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // Limit each IP to 30 requests per minute
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: shouldBypassRateLimit,
  handler: jsonRateLimitHandler,
});

// Rate limiter for purchase endpoints
const purchaseLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Limit each IP to 10 requests per minute
  message: { error: 'Too many purchase requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: shouldBypassRateLimit,
  handler: jsonRateLimitHandler,
});

// Rate limiter for party creation (security: prevent abuse)
const partyCreationLimiter = shouldBypassRateLimit()
  ? rateLimitBypass
  : rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5, // Limit each IP to 5 party creations per 15 minutes
      message: { error: 'Too many party creation attempts, please try again later' },
      standardHeaders: true,
      legacyHeaders: false,
      handler: jsonRateLimitHandler,
    });

// Rate limiter for upload endpoints (security: prevent abuse)
const uploadLimiter = shouldBypassRateLimit()
  ? rateLimitBypass
  : rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 10, // Limit each IP to 10 uploads per 15 minutes
      message: { error: 'Too many upload requests, please try again later' },
      standardHeaders: true,
      legacyHeaders: false,
      handler: jsonRateLimitHandler,
    });

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

/**
 * POST /api/auth/signup
 * Create new user account
 */
app.post("/api/auth/signup", authLimiter, async (req, res) => {
  try {
    const { email, password, djName, termsAccepted } = req.body;

    // Validate input
    if (!authMiddleware.isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    if (!authMiddleware.isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (!djName || djName.trim().length === 0) {
      return res.status(400).json({ error: 'DJ name is required' });
    }

    if (!termsAccepted) {
      return res.status(400).json({ error: 'You must accept the Terms & Conditions and Privacy Policy to create an account' });
    }

    // Check if email already exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Account already exists' });
    }

    // Hash password
    const passwordHash = await authMiddleware.hashPassword(password);

    // Create user — set profile_completed immediately since djName is collected at signup
    const result = await db.query(
      `INSERT INTO users (email, password_hash, dj_name, profile_completed, terms_accepted_at)
       VALUES ($1, $2, $3, TRUE, NOW())
       RETURNING id, email, dj_name, created_at`,
      [email.toLowerCase(), passwordHash, djName.trim()]
    );

    const user = result.rows[0];

    // Create DJ profile for user
    await db.query(
      `INSERT INTO dj_profiles (user_id, dj_score, dj_rank)
       VALUES ($1, 0, 'Bedroom DJ')`,
      [user.id]
    );

    // Generate JWT token
    const token = authMiddleware.generateToken({
      userId: user.id,
      email: user.email
    });

    // Set HTTP-only cookie — use HTTPS detection that works behind proxies
    res.cookie('auth_token', token, {
      httpOnly: true,
      path: '/',
      secure: isHttpsRequest(req),
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'lax'
    });

    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        djName: user.dj_name,
        createdAt: user.created_at
      }
    });
  } catch (error) {
    console.error('[Auth] Signup error:', error.code || error.message);
    // 23505 = Postgres unique-constraint violation (race condition: two concurrent signups)
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Account already exists' });
    }
    const requestId = require('crypto').randomUUID();
    res.status(500).json({ error: 'Failed to create account', requestId });
  }
});

/**
 * POST /api/auth/login
 * Log in existing user
 */
app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!authMiddleware.isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Find user
    const result = await db.query(
      'SELECT id, email, password_hash, dj_name, is_admin FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    // Verify password
    const isValid = await authMiddleware.verifyPassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login
    await db.query(
      'UPDATE users SET last_login = NOW() WHERE id = $1',
      [user.id]
    );

    // Admin bootstrap: promote user on first successful login if email is in ADMIN_EMAILS allowlist
    // or legacy ADMIN_BOOTSTRAP_EMAIL env var (kept for backwards compatibility)
    const isAdminByAllowlist = authMiddleware.isAdminEmail(user.email);
    const legacyBootstrapEmail = process.env.ADMIN_BOOTSTRAP_EMAIL
      ? process.env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase()
      : null;
    const shouldBeAdmin = isAdminByAllowlist || (legacyBootstrapEmail && user.email === legacyBootstrapEmail);
    if (shouldBeAdmin && !user.is_admin) {
      await db.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [user.id]);
      user.is_admin = true;
    }

    // Generate JWT token — include isAdmin so requireAdmin middleware works without a DB query
    const token = authMiddleware.generateToken({
      userId: user.id,
      email: user.email,
      isAdmin: user.is_admin || false
    });

    // Set HTTP-only cookie — use HTTPS detection that works behind proxies
    res.cookie('auth_token', token, {
      httpOnly: true,
      path: '/',
      secure: isHttpsRequest(req),
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'lax'
    });

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        djName: user.dj_name,
        isAdmin: user.is_admin
      }
    });
  } catch (error) {
    console.error('[Auth] Login error:', error);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

/**
 * POST /api/auth/logout
 * Log out current user
 */
app.post("/api/auth/logout", apiLimiter, (req, res) => {
  // Clear cookie with IDENTICAL options to the cookie that was set, otherwise clearing fails
  res.clearCookie('auth_token', {
    path: '/',
    secure: isHttpsRequest(req),
    sameSite: 'lax',
    httpOnly: true
  });
  res.json({ success: true });
});

/**
 * GET /api/feature-flags
 * Returns public feature flag values for the client to use.
 * No authentication required — flag values are not secrets.
 */
app.get('/api/feature-flags', apiLimiter, (req, res) => {
  return res.json({
    STREAMING_PARTY_ENABLED: isStreamingPartyEnabled()
  });
});

/**
 * GET /api/me
 * Get current user info with tier and entitlements
 */
app.get("/api/me", apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Get user basic info (including Stripe billing fields added by migration 003)
    const userResult = await db.query(
      `SELECT id, email, dj_name, created_at, profile_completed,
              tier, subscription_status, current_period_end,
              stripe_customer_id, stripe_subscription_id, is_admin
       FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Refresh presence TTL in Redis (120s) so admin live-user count is accurate
    try {
      const presenceKey = `presence:user:${userId}`;
      await redis.set(presenceKey, JSON.stringify({ lastSeen: Date.now(), tier: user.tier || 'FREE' }), 'EX', 120);
    } catch (_) { /* non-fatal */ }

    // Get DJ profile
    const profileResult = await db.query(
      `SELECT dj_score, dj_rank, active_visual_pack, active_title,
              verified_badge, crown_effect, animated_name, reaction_trail
       FROM dj_profiles WHERE user_id = $1`,
      [userId]
    );

    const profile = profileResult.rows[0] || {
      dj_score: 0,
      dj_rank: 'Bedroom DJ',
      active_visual_pack: null,
      active_title: null,
      verified_badge: false,
      crown_effect: false,
      animated_name: false,
      reaction_trail: false
    };

    // Get active subscription
    const subResult = await db.query(
      `SELECT status, current_period_end
       FROM subscriptions
       WHERE user_id = $1 AND status = 'active'
       ORDER BY current_period_end DESC
       LIMIT 1`,
      [userId]
    );

    const hasProSubscription = subResult.rows.length > 0 &&
      new Date(subResult.rows[0].current_period_end) > new Date();

    // Get owned entitlements
    const entitlementsResult = await db.query(
      'SELECT item_type, item_key FROM entitlements WHERE user_id = $1 AND owned = true',
      [userId]
    );

    const entitlements = entitlementsResult.rows;

    // Get user upgrades (Party Pass and Pro Monthly)
    const upgrades = await db.getOrCreateUserUpgrades(userId);
    const { hasPartyPass, hasPro } = db.resolveEntitlements(upgrades);

    // Determine tier
    // Priority: Stripe billing tier (PRO) > legacy upgrades > FREE
    let tier = 'FREE';
    if (user.tier === 'PRO') {
      // Stripe billing says PRO
      tier = 'PRO';
    } else if (hasPro) {
      tier = 'PRO_MONTHLY';
    } else if (hasPartyPass) {
      tier = 'PARTY_PASS';
    } else if (hasProSubscription) {
      // Legacy subscription support
      tier = 'PRO';
    }

    // Admin users get effective PRO tier and bypass all paywalls
    const isAdmin = user.is_admin || req.user.isAdmin || false;
    const effectiveTier = isAdmin ? 'PRO' : tier;

    res.json({
      user: {
        id: user.id,
        email: user.email,
        djName: user.dj_name,
        createdAt: user.created_at,
        profileCompleted: user.profile_completed || false
      },
      isAdmin,
      tier,
      effectiveTier,
      upgrades: {
        partyPass: {
          expiresAt: upgrades.party_pass_expires_at
        },
        proMonthly: {
          active: upgrades.pro_monthly_active,
          startedAt: upgrades.pro_monthly_started_at,
          renewalProvider: upgrades.pro_monthly_renewal_provider
        }
      },
      entitlements: {
        hasPartyPass: isAdmin || hasPartyPass || tier === 'PRO',
        hasPro: isAdmin || hasPro || tier === 'PRO'
      },
      billing: {
        tier: user.tier || 'FREE',
        subscriptionStatus: user.subscription_status || null,
        currentPeriodEnd: user.current_period_end || null,
        stripeCustomerId: user.stripe_customer_id || null,
        stripeSubscriptionId: user.stripe_subscription_id || null
      },
      profile: {
        djScore: profile.dj_score,
        djRank: profile.dj_rank,
        activeVisualPack: profile.active_visual_pack,
        activeTitle: profile.active_title,
        verifiedBadge: profile.verified_badge,
        crownEffect: profile.crown_effect,
        animatedName: profile.animated_name,
        reactionTrail: profile.reaction_trail
      },
      ownedItems: entitlements.map(e => ({
        type: e.item_type,
        key: e.item_key
      }))
    });
  } catch (error) {
    console.error('[Auth] Get user error:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// ============================================================================
// STORE ENDPOINTS
// ============================================================================

/**
 * POST /api/complete-profile
 * Mark user profile as completed after onboarding, optionally updating DJ name
 */
app.post("/api/complete-profile", apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { djName } = req.body;

    if (djName && djName.trim()) {
      await db.query(
        'UPDATE users SET profile_completed = TRUE, dj_name = $2 WHERE id = $1',
        [userId, djName.trim().substring(0, 50)]
      );
    } else {
      await db.query(
        'UPDATE users SET profile_completed = TRUE WHERE id = $1',
        [userId]
      );
    }

    res.json({ success: true, profileCompleted: true });
  } catch (error) {
    console.error('[Auth] Complete profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * POST /api/profile/update
 * Update the logged-in user's DJ name.
 */
const DJ_NAME_MAX_LENGTH = 50;

app.post("/api/profile/update", apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { djName } = req.body;

    const trimmed = typeof djName === 'string' ? djName.trim() : '';
    if (!trimmed) {
      return res.status(400).json({ error: 'DJ name is required' });
    }
    if (trimmed.length > DJ_NAME_MAX_LENGTH) {
      return res.status(400).json({ error: `DJ name must be ${DJ_NAME_MAX_LENGTH} characters or fewer` });
    }

    await db.query(
      'UPDATE users SET dj_name = $2 WHERE id = $1',
      [userId, trimmed]
    );

    res.json({ success: true, djName: trimmed });
  } catch (error) {
    console.error('[Auth] Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * GET /api/store
 * Get store catalog
 */
app.get("/api/store", authMiddleware.optionalAuth, (req, res) => {
  const catalog = storeCatalog.getStoreCatalog();
  res.json(catalog);
});

/**
 * GET /api/tier-info
 * Get tier definitions and feature information (single source of truth)
 */
app.get("/api/tier-info", (req, res) => {
  res.json({
    appName: "Phone Party",
    tiers: {
      FREE: {
        label: "Free",
        chatEnabled: false,
        autoMessages: false,
        guestQuickReplies: false,
        hostQuickMessages: false,
        systemAutoMessages: false,
        messageTtlMs: 0,
        maxTextLength: 0,
        queueLimit: 5,
        phoneLimit: 2,
        notes: [
          "2 phones maximum",
          "No chat or messaging features",
          "Basic DJ controls only",
          "Unlimited party time"
        ]
      },
      PARTY_PASS: {
        label: "Party Pass",
        price: "£3.99", // GBP - Party Pass one-time purchase for 2-hour party session
        chatEnabled: true,
        autoMessages: true,
        quickMessages: true,
        guestQuickReplies: true,
        hostQuickMessages: true,
        systemAutoMessages: true,
        messageTtlMs: 12000,
        maxTextLength: 60,
        maxEmojiLength: 10,
        queueLimit: 5,
        phoneLimit: 4,
        hostRateLimit: { minIntervalMs: 2000, maxPerMinute: 10 },
        guestRateLimit: { minIntervalMs: 2000, maxPerMinute: 15 },
        notes: [
          "Up to 4 phones",
          "2 hours duration",
          "Full messaging suite enabled",
          "Guest chat + emoji reactions",
          "DJ quick messages + emojis",
          "Auto party prompts",
          "Messages auto-disappear (12s)"
        ]
      },
      PRO_MONTHLY: {
        label: "Pro Monthly",
        price: "£9.99/mo", // GBP - Monthly subscription for unlimited access
        chatEnabled: true,
        autoMessages: true,
        quickMessages: true,
        cosmetics: true,
        profilePerks: true,
        phoneLimit: 10,
        queueLimit: 5,
        tierAvailable: true,
        notes: [
          "Up to 10 phones",
          "Unlimited party time",
          "Visual packs + DJ titles",
          "Profile upgrades",
          "All messaging features",
          "Priority support"
        ]
      }
    }
  });
});

/**
 * POST /api/purchase
 * Process a purchase
 */
app.post("/api/purchase", purchaseLimiter, authMiddleware.requireAuth, async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { itemId, partyCode } = req.body;
    const userId = req.user.userId;

    // Get item from catalog
    const item = storeCatalog.getItemById(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    await client.query('BEGIN');

    // Record purchase
    const expiresAt = item.duration ?
      new Date(Date.now() + item.duration * 1000) : null;

    const purchaseKind = item.permanent ? 'permanent' :
      (item.type === storeCatalog.STORE_CATEGORIES.SUBSCRIPTIONS ? 'subscription' : 'party_temp');

    await client.query(
      `INSERT INTO purchases (user_id, purchase_kind, item_type, item_key, price_gbp, party_code, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, purchaseKind, item.type, item.id, item.price, partyCode || null, expiresAt] // GBP - Prices in pounds
    );

    // Grant entitlement for permanent items
    if (item.permanent) {
      await client.query(
        `INSERT INTO entitlements (user_id, item_type, item_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, item_type, item_key) DO NOTHING`,
        [userId, item.type, item.id]
      );
    }

    // Apply item effect based on type
    if (item.type === storeCatalog.STORE_CATEGORIES.VISUAL_PACKS) {
      // Replace active visual pack
      await client.query(
        'UPDATE dj_profiles SET active_visual_pack = $1, updated_at = NOW() WHERE user_id = $2',
        [item.id, userId]
      );
    } else if (item.type === storeCatalog.STORE_CATEGORIES.DJ_TITLES) {
      // Replace active title
      await client.query(
        'UPDATE dj_profiles SET active_title = $1, updated_at = NOW() WHERE user_id = $2',
        [item.id, userId]
      );
    } else if (item.type === storeCatalog.STORE_CATEGORIES.PROFILE_UPGRADES) {
      // Stack profile upgrades
      const updates = {};
      if (item.id === 'verified_badge') updates.verified_badge = true;
      if (item.id === 'crown_effect') updates.crown_effect = true;
      if (item.id === 'animated_name') updates.animated_name = true;
      if (item.id === 'reaction_trail') updates.reaction_trail = true;

      if (Object.keys(updates).length > 0) {
        const setClause = Object.keys(updates).map((key, i) => `${key} = $${i + 1}`).join(', ');
        const values = [...Object.values(updates), userId];
        await client.query(
          `UPDATE dj_profiles SET ${setClause}, updated_at = NOW() WHERE user_id = $${values.length}`,
          values
        );
      }
    } else if (item.type === storeCatalog.STORE_CATEGORIES.SUBSCRIPTIONS) {
      // Handle subscription
      if (item.id === 'party_pass') {
        // Party Pass is handled per-party - update the JSON party data in Redis
        if (partyCode && redis) {
          try {
            const partyData = await getPartyFromRedis(partyCode);
            if (partyData) {
              const partyPassExpires = Date.now() + item.duration * 1000;
              partyData.partyPassExpiresAt = partyPassExpires;
              partyData.maxPhones = item.maxPhones;
              await setPartyInRedis(partyCode, partyData);
              
              // Also update local party if it exists
              const localParty = parties.get(partyCode);
              if (localParty) {
                localParty.partyPassExpiresAt = partyPassExpires;
                localParty.maxPhones = item.maxPhones;
              }
            }
          } catch (err) {
            console.error(`[Purchase] Error updating party ${partyCode} with party pass:`, err.message);
          }
        }
      } else if (item.id === 'pro_monthly') {
        // Create/update Pro subscription
        const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
        
        // Check if user already has an active subscription
        const existingSub = await client.query(
          'SELECT id FROM subscriptions WHERE user_id = $1 AND status = \'active\'',
          [userId]
        );
        
        if (existingSub.rows.length > 0) {
          // Update existing subscription
          await client.query(
            `UPDATE subscriptions SET
              current_period_start = NOW(),
              current_period_end = $1,
              updated_at = NOW()
             WHERE user_id = $2 AND status = 'active'`,
            [periodEnd, userId]
          );
        } else {
          // Create new subscription
          await client.query(
            `INSERT INTO subscriptions (user_id, status, current_period_start, current_period_end)
             VALUES ($1, 'active', NOW(), $2)`,
            [userId, periodEnd]
          );
        }
      }
    } else if (item.type === storeCatalog.STORE_CATEGORIES.PARTY_EXTENSIONS) {
      // Party extensions - apply to Redis party using JSON storage
      if (partyCode && redis) {
        try {
          const partyData = await getPartyFromRedis(partyCode);
          if (partyData) {
            if (item.id === 'add_30min') {
              const currentExpiry = partyData.partyPassExpiresAt || Date.now();
              partyData.partyPassExpiresAt = currentExpiry + 30 * 60 * 1000;
            } else if (item.id === 'add_5phones') {
              const currentMax = partyData.maxPhones || 2;
              partyData.maxPhones = currentMax + 5;
            }
            await setPartyInRedis(partyCode, partyData);
            
            // Also update local party if it exists
            const localParty = parties.get(partyCode);
            if (localParty) {
              if (item.id === 'add_30min') {
                localParty.partyPassExpiresAt = partyData.partyPassExpiresAt;
              } else if (item.id === 'add_5phones') {
                localParty.maxPhones = partyData.maxPhones;
              }
            }
          }
        } catch (err) {
          console.error(`[Purchase] Error updating party ${partyCode} with extension:`, err.message);
        }
      }
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Purchase successful',
      item: {
        id: item.id,
        name: item.name,
        type: item.type
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Store] Purchase error:', error);
    res.status(500).json({ error: 'Failed to process purchase' });
  } finally {
    client.release();
  }
});

// ============================================================================
// PAYMENT ENDPOINTS
// ============================================================================

/**
 * POST /api/payment/initiate
 * Initiate a purchase (returns payment intent)
 */
app.post("/api/payment/initiate", purchaseLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    const { productId, platform, paymentMethod } = req.body;
    const userId = req.user.userId;

    // Validate input
    if (!productId || !platform || !paymentMethod) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate product
    const validProducts = ['party_pass', 'pro_monthly'];
    if (!validProducts.includes(productId)) {
      return res.status(400).json({ error: 'Invalid product ID' });
    }

    // Get product details from catalog
    const product = storeCatalog.getItemById(productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found in catalog' });
    }

    // Create payment intent with cryptographically secure ID
    const crypto = require('crypto');
    const paymentIntent = {
      intentId: `intent_${Date.now()}_${crypto.randomUUID()}`,
      userId,
      productId,
      amount: Math.floor(product.price * 100), // GBP - Convert price to pence, use floor to avoid rounding up
      currency: product.currency || 'GBP', // Default to GBP currency
      platform,
      paymentMethod,
      createdAt: Date.now()
    };

    console.log(`[Payment] Created payment intent ${paymentIntent.intentId} for ${productId}`);

    res.json({
      success: true,
      paymentIntent
    });
  } catch (error) {
    console.error('[Payment] Initiate payment error:', error);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
});

/**
 * POST /api/payment/confirm
 * Confirm payment and grant entitlement
 */
app.post("/api/payment/confirm", purchaseLimiter, authMiddleware.requireAuth, async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { intentId, paymentToken, productId, platform, paymentMethod } = req.body;
    const userId = req.user.userId;

    // Validate input
    if (!intentId || !productId || !platform || !paymentMethod) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get product details
    const product = storeCatalog.getItemById(productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Process payment through provider
    const paymentResult = await paymentProvider.processPayment({
      userId,
      productId,
      paymentMethod,
      platform,
      paymentToken,
      amount: Math.round(product.price * 100), // GBP - Convert price to pence (smallest currency unit)
      currency: product.currency || 'GBP'
    });

    if (!paymentResult.success) {
      return res.status(402).json({ 
        error: 'Payment failed', 
        details: paymentResult.error 
      });
    }

    console.log(`[Payment] Payment confirmed for ${productId}: ${paymentResult.transactionId}`);

    await client.query('BEGIN');

    // Record purchase in database
    await client.query(
      `INSERT INTO purchases (user_id, purchase_kind, item_type, item_key, price_gbp, provider, provider_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId, 
        'subscription', 
        product.type, 
        product.id, 
        product.price, // GBP - Price stored in pounds (e.g., 3.99 for Party Pass, 9.99 for Pro Monthly)
        paymentResult.provider,
        paymentResult.providerTransactionId
      ]
    );

    // Grant entitlement based on product
    if (productId === 'party_pass') {
      // Set Party Pass expiration
      const expiresAt = new Date(Date.now() + PARTY_PASS_DURATION_MS);
      await db.updatePartyPassExpiry(userId, expiresAt);
    } else if (productId === 'pro_monthly') {
      // Activate Pro Monthly subscription
      await db.activateProMonthly(userId, paymentResult.provider, paymentResult.providerTransactionId);
    }

    // Get updated upgrades and entitlements
    const upgrades = await db.getOrCreateUserUpgrades(userId);
    const entitlements = db.resolveEntitlements(upgrades);

    await client.query('COMMIT');

    res.json({
      success: true,
      transactionId: paymentResult.transactionId,
      upgrades: {
        partyPass: {
          expiresAt: upgrades.party_pass_expires_at
        },
        proMonthly: {
          active: upgrades.pro_monthly_active,
          startedAt: upgrades.pro_monthly_started_at,
          renewalProvider: upgrades.pro_monthly_renewal_provider
        }
      },
      entitlements
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Payment] Confirm payment error:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/user/entitlements
 * Get current user entitlements (for restoration on app load)
 */
app.get("/api/user/entitlements", apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get user upgrades
    const upgrades = await db.getOrCreateUserUpgrades(userId);
    const entitlements = db.resolveEntitlements(upgrades);

    res.json({
      success: true,
      upgrades: {
        partyPass: {
          expiresAt: upgrades.party_pass_expires_at
        },
        proMonthly: {
          active: upgrades.pro_monthly_active,
          startedAt: upgrades.pro_monthly_started_at,
          renewalProvider: upgrades.pro_monthly_renewal_provider
        }
      },
      entitlements
    });
  } catch (error) {
    console.error('[Payment] Get entitlements error:', error);
    res.status(500).json({ error: 'Failed to get entitlements' });
  }
});

// Track file registry for TTL cleanup
// Map of trackId -> { filename, originalName, uploadedAt, filepath, contentType, sizeBytes }
// SECTION 3: Removed uploadedTracks Map - now handled by storage provider
// const uploadedTracks = new Map();
// const TRACK_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// PHASE 2: POST /api/tracks/presign-put - Generate presigned URL for direct-to-R2 upload
app.post("/api/tracks/presign-put", async (req, res) => {
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
        message: 'Direct uploads require S3-compatible storage. Use /api/upload-track instead.'
      });
    }
    
    // Generate unique track ID
    const { customAlphabet } = require('nanoid');
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
app.post("/api/upload-track", uploadLimiter, upload.single('audio'), async (req, res) => {
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
app.post("/api/set-party-track", async (req, res) => {
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
app.get("/api/track/:trackId", async (req, res) => {
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

// Sync metrics endpoint — enabled only in SYNC_TEST_MODE
// Returns a live metrics snapshot for a party (Playwright harness + manual testing)
app.get("/api/sync/metrics", (req, res) => {
  if (process.env.SYNC_TEST_MODE !== 'true') {
    return res.status(404).json({ error: 'Not available outside test mode' });
  }
  const partyId = req.query.partyId;
  if (!partyId) {
    return res.status(400).json({ error: 'partyId query parameter required' });
  }
  const syncEngine = partySyncEngines.get(partyId);
  if (!syncEngine) {
    return res.status(404).json({ error: 'Party not found or no sync engine' });
  }
  return res.json(syncEngine.getPartyMetrics());
});

// Debug endpoint to list active parties
// WARNING: This endpoint is for debugging purposes only and should be
// protected by authentication or disabled in production environments
// to prevent abuse and information disclosure
app.get("/api/debug/parties", async (req, res) => {
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
    if (redis && redisReady) {
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
      redisReady,
      timestamp: now
    });
  } catch (error) {
    console.error("[debug/parties] Error:", error);
    res.status(500).json({ error: "Failed to list parties", details: error.message });
  }
});

// Debug endpoint to check a specific party's status
// GET /api/debug/party/:code - Returns party existence and status info
app.get("/api/debug/party/:code", async (req, res) => {
  try {
    const code = req.params.code.trim().toUpperCase();
    const now = Date.now();
    
    // Get Redis status
    let redisStatus;
    if (!redis || redisConnectionError || !redisReady) {
      redisStatus = "unavailable";
    } else if (redis.status === "ready" && redisReady) {
      redisStatus = "ready";
    } else {
      redisStatus = "error";
    }
    
    // Check if party exists in Redis
    let existsInRedis = false;
    let redisData = null;
    if (redis && redisReady) {
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

// GET /api/sync/metrics - Sync metrics snapshot for a party (test mode only)
// Returns enhanced per-client metrics for the Playwright harness and dashboard.
// Enabled in SYNC_TEST_MODE or DEBUG mode; returns 404 in production.
app.get("/api/sync/metrics", async (req, res) => {
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

// Generate party codes (6 chars, uppercase letters/numbers)
const generateCode = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 6);

// Party TTL configuration
// TTL set to 2 hours (minimum requirement is 30 minutes)
const PARTY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (7200000 ms)
const PARTY_TTL_SECONDS = Math.floor(PARTY_TTL_MS / 1000); // 7200 seconds
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Track TTL configuration (uploaded audio files)
// Note: Track cleanup is handled by storage provider TTL, but constant is used for logging
const DEFAULT_TRACK_TTL_MS = 300000; // 5 minutes default

const TRACK_TTL_MS = (() => {
  const raw = process.env.TRACK_TTL_MS;
  
  if (!raw) {
    console.warn(`[Config] TRACK_TTL_MS not set. Using default ${DEFAULT_TRACK_TTL_MS}ms`);
    return DEFAULT_TRACK_TTL_MS;
  }
  
  const parsed = parseInt(raw, 10);
  
  if (isNaN(parsed) || parsed <= 0) {
    console.warn(`[Config] Invalid TRACK_TTL_MS value: "${raw}". Using default ${DEFAULT_TRACK_TTL_MS}ms`);
    return DEFAULT_TRACK_TTL_MS;
  }

  return parsed;
})();

// Redis key prefixes
const PARTY_KEY_PREFIX = "party:";
const PARTY_META_KEY_PREFIX = "party_meta:";

// In-memory storage for WebSocket connections (cannot be stored in Redis)
// code -> { host, members: [{ ws, id, name, isPro, isHost }] }
const parties = new Map();
const clients = new Map(); // ws -> { id, party }

// PHASE 3: Ready gating - track client readiness per party+trackId
// partyCode:trackId -> { readySockets: Set, readyPayloads: Map(ws -> {bufferedSec, readyState, canPlayThrough}) }
const readinessMap = new Map();

// PHASE 4: Drift correction - SYNC_TICK interval per party
// partyCode -> intervalId
const syncTickIntervals = new Map();
const SYNC_TICK_INTERVAL_MS = 1000; // Broadcast sync tick every second

// PHASE 4: Start SYNC_TICK broadcasting for drift correction
function startSyncTick(partyCode) {
  if (syncTickIntervals.has(partyCode)) return;
  const intervalId = setInterval(() => {
    const party = parties.get(partyCode);
    if (!party || !party.currentTrack || party.currentTrack.status !== 'playing') {
      stopSyncTick(partyCode);
      return;
    }
    const { trackId, startAtServerMs, startPositionSec } = party.currentTrack;
    const expectedPositionSec = (startPositionSec || 0) + (Date.now() - startAtServerMs) / 1000;
    // Client expects field name "startedAtServerMs" (see app.js SYNC_TICK handler)
    const msg = JSON.stringify({ t: 'SYNC_TICK', trackId, startedAtServerMs: startAtServerMs, expectedPositionSec });
    party.members.forEach(m => {
      if (m.ws.readyState === WebSocket.OPEN) {
        try { m.ws.send(msg); } catch (_) { /* ignore transient send errors */ }
      }
    });
  }, SYNC_TICK_INTERVAL_MS);
  syncTickIntervals.set(partyCode, intervalId);
}

// PHASE 4: Stop SYNC_TICK broadcasting
function stopSyncTick(partyCode) {
  const intervalId = syncTickIntervals.get(partyCode);
  if (intervalId !== undefined) {
    clearInterval(intervalId);
    syncTickIntervals.delete(partyCode);
  }
}

// PHASE 5: Event replay - per-party event history for RESUME
// partyCode -> { eventId: number, events: [{eventId, timestamp, message}] }
const partyEventHistory = new Map();
const MAX_EVENT_HISTORY = 200; // Keep last 200 events per party

// Control event types that should be tracked with eventId for RESUME
const CONTROL_EVENT_TYPES = ['TRACK_READY', 'PREPARE_PLAY', 'PLAY_AT', 'PAUSE', 'SEEK', 'STOP'];

// PHASE 3: Readiness thresholds
const READY_MIN_BUFFERED_SEC = 3.0; // Minimum buffered seconds to prevent stuttering
const READY_MIN_READYSTATE = 3; // HTMLMediaElement.HAVE_FUTURE_DATA

// Helper: Mask party code for logging (security)
function maskPartyCode(code) {
  if (!code || code.length < 3) return '***';
  return code.substring(0, 3) + '***';
}

// Advanced sync engines per party
// code -> SyncEngine instance
const partySyncEngines = new Map();

// Event Replay Manager for reliable message delivery
const eventReplayManager = new EventReplayManager({
  retryIntervalMs: 2000,
  maxRetryAttempts: 5,
  messageTimeoutMs: 30000,
  cleanupIntervalMs: 10000,
  enableLogging: true
});
// Removed P2PNetwork instantiation - unused (peer-to-peer not implemented)

// PHASE 5: Event tracking helpers for RESUME functionality
function initializePartyEventHistory(partyCode) {
  if (!partyEventHistory.has(partyCode)) {
    partyEventHistory.set(partyCode, {
      nextEventId: 1,
      events: []
    });
  }
}

function trackPartyEvent(partyCode, message) {
  initializePartyEventHistory(partyCode);
  const history = partyEventHistory.get(partyCode);
  
  const eventId = history.nextEventId++;
  const messageWithEventId = { ...message, eventId };
  
  history.events.push({
    eventId,
    timestamp: Date.now(),
    message: messageWithEventId
  });
  
  // Keep only last N events
  if (history.events.length > MAX_EVENT_HISTORY) {
    history.events.shift();
  }
  
  return messageWithEventId;
}

function getEventsSince(partyCode, lastEventId) {
  const history = partyEventHistory.get(partyCode);
  if (!history) return [];
  
  return history.events
    .filter(event => event.eventId > lastEventId)
    .map(event => event.message);
}

// ============================================================================
// Helper: Broadcast to all party members
// Consolidates repeated broadcast pattern used 30+ times across server.js
// ============================================================================
function broadcastToParty(partyCode, message) {
  const party = parties.get(partyCode);
  if (!party) return 0;
  
  const msgStr = typeof message === 'string' ? message : JSON.stringify(message);
  let sentCount = 0;
  
  party.members.forEach(member => {
    if (member.ws && member.ws.readyState === WebSocket.OPEN) {
      try {
        member.ws.send(msgStr);
        sentCount++;
      } catch (error) {
        console.warn(`[broadcast] Failed to send to member: ${error.message}`);
      }
    }
  });
  
  return sentCount;
}

/**
 * Broadcast to party with acknowledgment tracking and retry
 * Use for critical messages that must be delivered
 * @param {string} partyCode - Party identifier
 * @param {object} message - Message object to broadcast
 * @param {string} priority - MessagePriority.CRITICAL, HIGH, or NORMAL
 * @param {Set<string>} excludeClients - Optional set of client IDs to exclude
 * @returns {object} { messageId, sentCount, requiresAck }
 */
function broadcastToPartyWithAck(partyCode, message, priority = MessagePriority.CRITICAL, excludeClients = new Set()) {
  // PHASE 5: Track control events with eventId for RESUME
  const isControlEvent = CONTROL_EVENT_TYPES.includes(message.t);
  
  let messageToSend = message;
  if (isControlEvent) {
    messageToSend = trackPartyEvent(partyCode, message);
  }
  
  return eventReplayManager.sendCommandToParty(partyCode, messageToSend, priority, excludeClients);
}

// Separate counters to avoid ID collisions between HTTP and WS
let nextWsClientId = 1;      // For WebSocket client IDs
let nextHttpGuestSeq = 1;    // For HTTP-generated guest IDs
let nextHostId = 1;

// Fallback storage for party metadata when Redis is unavailable
// code -> { chatMode, createdAt, hostId, hostConnected, guestCount }
const fallbackPartyStorage = new Map();

// Heartbeat store: userId -> Date (last seen)
const _heartbeatStore = new Map();
// Basket store: userId -> Set<productKey>
const _baskets = new Map();

// Helper function to wrap promises with timeout
function promiseWithTimeout(promise, timeoutMs, errorMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage || `Timeout after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

// Redis party storage helpers
async function getPartyFromRedis(code) {
  if (!redis) {
    throw new Error("Redis not configured. Set REDIS_URL environment variable for production or REDIS_HOST for development.");
  }
  try {
    const data = await redis.get(`${PARTY_KEY_PREFIX}${code}`);
    if (!data) return null;
    return JSON.parse(data);
  } catch (err) {
    console.error(`[Redis] Error getting party ${code}:`, err.message);
    throw err;
  }
}

async function setPartyInRedis(code, partyData) {
  if (!redis) {
    throw new Error("Redis not configured. Set REDIS_URL environment variable for production or REDIS_HOST for development.");
  }
  try {
    const data = JSON.stringify(partyData);
    await redis.setex(`${PARTY_KEY_PREFIX}${code}`, PARTY_TTL_SECONDS, data);
    return true;
  } catch (err) {
    console.error(`[Redis] Error setting party ${code}:`, err.message);
    throw err;
  }
}

async function deletePartyFromRedis(code) {
  if (!redis) {
    throw new Error("Redis not configured. Set REDIS_URL environment variable for production or REDIS_HOST for development.");
  }
  try {
    await redis.del(`${PARTY_KEY_PREFIX}${code}`);
    return true;
  } catch (err) {
    console.error(`[Redis] Error deleting party ${code}:`, err.message);
    throw err;
  }
}

// Fallback storage helpers
function getPartyFromFallback(code) {
  return fallbackPartyStorage.get(code) || null;
}

function setPartyInFallback(code, partyData) {
  fallbackPartyStorage.set(code, partyData);
}

function deletePartyFromFallback(code) {
  return fallbackPartyStorage.delete(code);
}

// Helper function to persist reaction history to Redis (best-effort)
async function persistReactionHistoryToRedis(code, reactionHistory) {
  if (!ENABLE_REACTION_HISTORY || !redis || !redisReady) return;
  
  try {
    const partyData = await getPartyFromRedis(code);
    if (partyData) {
      partyData.reactionHistory = reactionHistory;
      await setPartyInRedis(code, partyData);
    }
  } catch (err) {
    // Best-effort - don't throw, just log
    console.warn(`[ReactionHistory] Failed to persist to Redis for ${code}:`, err.message);
  }
}

// Helper function to persist playback state to Redis (best-effort)
async function persistPlaybackToRedis(code, currentTrack, queue) {
  if (!redis || !redisReady) return;
  
  try {
    const partyData = await getPartyFromRedis(code);
    if (partyData) {
      partyData.currentTrack = currentTrack;
      partyData.queue = queue ? queue.slice(0, 5) : []; // Keep only first 5 queue items
      await setPartyInRedis(code, partyData);
    }
  } catch (err) {
    // Best-effort - don't throw, just log
    console.warn(`[Playback] Failed to persist to Redis for ${code}:`, err.message);
  }
}

// Helper function to publish events to other instances (Phase 8)
async function publishToOtherInstances(code, kind, payload) {
  // Guard: Only publish if PubSub is enabled and clients are ready
  if (!ENABLE_PUBSUB || !pubsubEnabled || !redisPub) return;
  
  try {
    const message = JSON.stringify({
      code,
      kind,
      payload,
      instanceId: INSTANCE_ID,
      ts: Date.now()
    });
    await redisPub.publish(PUBSUB_CHANNEL, message);
    // Reset failure count on successful publish
    pubsubFailureCount = 0;
  } catch (err) {
    // Best-effort - don't throw, just log
    console.warn(`[PubSub] Failed to publish ${kind} for ${code}:`, err.message);
    
    // Increment failure count and disable after consecutive failures
    pubsubFailureCount++;
    if (pubsubFailureCount >= PUBSUB_MAX_FAILURES) {
      console.error(`[PubSub] Disabling PubSub after ${PUBSUB_MAX_FAILURES} consecutive failures`);
      pubsubEnabled = false;
    }
  }
}

// Helper function to normalize party data - ensures all required fields exist
// This prevents issues when parties are created via different paths or when Redis data is incomplete
function normalizePartyData(partyData) {
  if (!partyData) return null;
  
  return {
    partyCode: partyData.partyCode || partyData.code,
    djName: partyData.djName || "Host",
    source: partyData.source || "local",
    partyPro: partyData.partyPro || false,
    promoUsed: partyData.promoUsed || false,
    chatMode: partyData.chatMode || "OPEN",
    createdAt: partyData.createdAt || Date.now(),
    hostId: partyData.hostId,
    hostConnected: partyData.hostConnected !== undefined ? partyData.hostConnected : false,
    guestCount: partyData.guestCount || 0,
    guests: partyData.guests || [],
    status: partyData.status || "active",
    expiresAt: partyData.expiresAt || (Date.now() + PARTY_TTL_MS),
    // Tier field from backend entitlement validation
    tier: partyData.tier || null,
    // Optional fields from purchases
    partyPassExpiresAt: partyData.partyPassExpiresAt || null,
    maxPhones: partyData.maxPhones || null,
    // Reaction and playback history for late joiners
    reactionHistory: partyData.reactionHistory || [],
    currentTrack: partyData.currentTrack || null,
    queue: partyData.queue || []
  };
}

// Helper function to calculate max allowed phones/devices based on party state
async function getMaxAllowedPhones(code, partyData) {
  // If party is Pro, allow practical maximum
  if (partyData.partyPro) {
    return MAX_PRO_PARTY_DEVICES;
  }
  
  // Check if party pass is active and not expired
  if (partyData.partyPassExpiresAt && Date.now() < partyData.partyPassExpiresAt) {
    const maxPhones = parseInt(partyData.maxPhones);
    return isNaN(maxPhones) ? FREE_PARTY_LIMIT : maxPhones;
  }
  
  // Default free limit
  return FREE_DEFAULT_MAX_PHONES;
}

// Helper function to check if Party Pass is active (source of truth)
function isPartyPassActive(partyData, now = Date.now()) {
  // PRO_MONTHLY implicitly includes Party Pass features
  if (partyData.tier === 'PRO_MONTHLY' || partyData.tier === 'PRO') {
    return true;
  }
  // PARTY_PASS tier: check expiration
  const expires = Number(partyData.partyPassExpiresAt || 0);
  return expires > now;
}

/**
 * Check if user has Party Pass or Pro Monthly entitlement
 * @param {string} userId - User ID to check
 * @returns {Promise<Object>} { hasPartyPass, hasPro, source }
 */
async function checkUserEntitlements(userId) {
  try {
    // Anonymous users have no entitlements
    if (!userId || userId.startsWith('anonymous-')) {
      return { hasPartyPass: false, hasPro: false, source: 'anonymous' };
    }
    
    // Get user upgrades from database
    const upgrades = await db.getOrCreateUserUpgrades(userId);
    const entitlements = db.resolveEntitlements(upgrades);
    
    return {
      hasPartyPass: entitlements.hasPartyPass,
      hasPro: entitlements.hasPro,
      source: 'database',
      upgrades
    };
  } catch (error) {
    console.error('[Entitlements] Error checking user entitlements:', error.message);
    // On error, return no entitlements (fail-safe)
    return { hasPartyPass: false, hasPro: false, source: 'error' };
  }
}

/**
 * Check if Party Pass features are available
 * Checks both party-level tier AND user-level upgrades
 * @param {Object} partyData - Party data from Redis
 * @param {string} userId - User ID (optional, for user-level check)
 * @returns {Promise<boolean>}
 */
async function hasPartyPassAccess(partyData, userId = null) {
  // Check party-level tier first
  if (isPartyPassActive(partyData)) {
    return true;
  }
  
  // Check user-level entitlements if userId provided
  if (userId) {
    const { hasPartyPass } = await checkUserEntitlements(userId);
    return hasPartyPass;
  }
  
  return false;
}

/**
 * Check if Pro Monthly features are available
 * Checks both party-level tier AND user-level upgrades
 * @param {Object} partyData - Party data from Redis
 * @param {string} userId - User ID (optional, for user-level check)
 * @returns {Promise<boolean>}
 */
async function hasProAccess(partyData, userId = null) {
  // Check party-level tier first
  if (partyData.tier === 'PRO_MONTHLY' || partyData.tier === 'PRO') {
    return true;
  }
  
  // Check user-level entitlements if userId provided
  if (userId) {
    const { hasPro } = await checkUserEntitlements(userId);
    return hasPro;
  }
  
  return false;
}

// Helper function to get party max phones based on current state
function getPartyMaxPhones(partyData) {
  const max = parseInt(partyData.maxPhones, 10);
  return Number.isFinite(max) ? max : 2;
}

// Rate limiting storage: Map<partyCode, Map<userId, Array<timestamp>>>
const messagingRateLimits = new Map();

// Helper function to check and enforce rate limits for messaging
// NOTE: This is for in-party messaging rate limits (Party Pass feature)
// WebSocket-level rate limiting is handled by rate-limiter.js module
function checkMessageRateLimit(partyCode, userId, isHost) {
  const now = Date.now();
  const limits = isHost ? HOST_RATE_LIMIT : GUEST_RATE_LIMIT;
  
  // Get or create party rate limit map
  if (!messagingRateLimits.has(partyCode)) {
    messagingRateLimits.set(partyCode, new Map());
  }
  const partyLimits = messagingRateLimits.get(partyCode);
  
  // Get or create user timestamps array
  if (!partyLimits.has(userId)) {
    partyLimits.set(userId, []);
  }
  const timestamps = partyLimits.get(userId);
  
  // Clean up old timestamps (older than 1 minute)
  const oneMinuteAgo = now - 60000;
  const recentTimestamps = timestamps.filter(ts => ts > oneMinuteAgo);
  partyLimits.set(userId, recentTimestamps);
  
  // Check minimum interval (anti-spam)
  if (recentTimestamps.length > 0) {
    const lastTimestamp = recentTimestamps[recentTimestamps.length - 1];
    if (now - lastTimestamp < limits.minIntervalMs) {
      return { allowed: false, reason: `Please wait ${Math.ceil((limits.minIntervalMs - (now - lastTimestamp)) / 1000)}s before sending another message` };
    }
  }
  
  // Check max per minute
  if (recentTimestamps.length >= limits.maxPerMinute) {
    return { allowed: false, reason: `Rate limit exceeded. Maximum ${limits.maxPerMinute} messages per minute` };
  }
  
  // Add current timestamp
  recentTimestamps.push(now);
  partyLimits.set(userId, recentTimestamps);
  
  return { allowed: true };
}

// Helper function to clean up rate limit data for ended parties
function cleanupRateLimitData(partyCode) {
  messagingRateLimits.delete(partyCode);
}

// ========================================
// PHASE 1: Canonical Track Data Shape
// ========================================

/**
 * Normalize track input to canonical track object shape
 * @param {Object} input - Track data from various sources
 * @param {Object} options - Additional context (e.g., addedBy)
 * @returns {Object} Normalized track object
 */
function normalizeTrack(input, options = {}) {
  if (!input || !input.trackId || !input.trackUrl) {
    throw new Error('Track must have trackId and trackUrl');
  }
  
  // Determine source from input or options
  const source = input.source || options.source || 'upload';
  
  // Determine title: prefer title, then filename, then default
  let title = input.title;
  if (!title && input.filename) {
    title = input.filename;
  }
  if (!title) {
    title = 'Unknown Track';
  }
  
  return {
    trackId: String(input.trackId),
    trackUrl: String(input.trackUrl),
    title: String(title).trim(),
    filename: input.filename || null,
    durationMs: typeof input.durationMs === 'number' ? input.durationMs : null,
    contentType: input.contentType || null,
    sizeBytes: typeof input.sizeBytes === 'number' ? input.sizeBytes : null,
    source: source,
    addedAt: Date.now(),
    addedBy: options.addedBy || null
  };
}

// ========================================
// SECURITY: Host Authority Validation (HTTP Wrapper)
// ========================================

/**
 * Validate that the requester is the party host (HTTP version)
 * @deprecated Use validateHostAuthorityHTTP from host-authority.js instead
 * @param {string} providedHostId - Host ID from request
 * @param {Object} partyData - Party data from storage
 * @returns {Object} { valid: boolean, error?: string }
 */
function validateHostAuth(providedHostId, partyData) {
  // Delegate to the new centralized validation module
  return validateHostAuthorityHTTP(providedHostId, partyData, 'HTTP operation');
}

// ========================================
// PHASE 3: Persist Queue + Current Track
// ========================================

/**
 * Load party state from Redis or fallback storage
 * @param {string} code - Party code
 * @returns {Promise<Object|null>} Party data or null if not found
 */
async function loadPartyState(code) {
  const useRedis = redis && redisReady;
  let partyData;
  
  if (useRedis) {
    try {
      partyData = await getPartyFromRedis(code);
    } catch (error) {
      console.warn(`[loadPartyState] Redis error for ${code}, trying fallback:`, error.message);
      partyData = getPartyFromFallback(code);
    }
  } else {
    partyData = getPartyFromFallback(code);
  }
  
  return partyData;
}

/**
 * Save party state to Redis or fallback storage, preserving TTL
 * @param {string} code - Party code
 * @param {Object} partyData - Party data to save
 * @returns {Promise<boolean>} Success status
 */
async function savePartyState(code, partyData) {
  const useRedis = redis && redisReady;
  
  if (useRedis) {
    try {
      // Use setex with full TTL for simplicity in prototype
      await setPartyInRedis(code, partyData);
      return true;
    } catch (error) {
      console.warn(`[savePartyState] Redis error for ${code}, using fallback:`, error.message);
      setPartyInFallback(code, partyData);
      return true;
    }
  } else {
    setPartyInFallback(code, partyData);
    return true;
  }
}

// Shared party creation function used by both HTTP and WS paths
// This ensures consistent party data structure across all creation methods
async function createPartyCommon({ djName, source, hostId, hostConnected }) {
  // Check if we should use Redis or fallback
  const useRedis = redis && redisReady;
  
  // Generate unique party code
  let code;
  let attempts = 0;
  do {
    code = generateCode();
    // Check both local and storage for uniqueness
    const existsLocally = parties.has(code);
    let existsInStorage;
    if (useRedis) {
      existsInStorage = await getPartyFromRedis(code);
    } else {
      existsInStorage = getPartyFromFallback(code);
    }
    if (!existsLocally && !existsInStorage) break;
    attempts++;
  } while (attempts < 10);
  
  if (attempts >= 10) {
    throw new Error("Failed to generate unique party code after 10 attempts");
  }
  
  const createdAt = Date.now();
  
  // Create full party data with all required fields
  const partyData = {
    partyCode: code,
    djName: djName.trim().substring(0, 50),
    source: source || "local",
    partyPro: false,
    promoUsed: false,
    chatMode: "OPEN",
    createdAt,
    hostId,
    hostConnected,
    guestCount: 0,
    guests: [],
    status: "active",
    expiresAt: createdAt + PARTY_TTL_MS,
    // Tier-based fields (set by backend entitlement validation only)
    tier: null,
    partyPassExpiresAt: null,
    maxPhones: null,
    // History fields for late joiners
    reactionHistory: [],
    currentTrack: null,
    queue: []
  };
  
  // Write to storage (Redis or fallback)
  if (useRedis) {
    await setPartyInRedis(code, partyData);
  } else {
    setPartyInFallback(code, partyData);
  }

  // Initialize sync engine for this party
  const syncEngine = new SyncEngine();
  partySyncEngines.set(code, syncEngine);
  console.log(`[Sync] Created sync engine for party ${code}`);
  
  // Track session creation in metrics
  if (metricsService) {
    await metricsService.trackSessionCreated(code, hostId || 'anonymous', 'FREE');
  }
  
  return { code, partyData };
}

// POST /api/create-party - Create a new party
app.post("/api/create-party", partyCreationLimiter, async (req, res) => {
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
  } else if (idempotencyKey && (!redis || !redisReady)) {
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
  const useRedis = redis && redisReady;
  const storageBackend = useRedis ? 'redis' : 'fallback';
  
  // In production mode, Redis is required UNLESS fallback mode is explicitly allowed
  if (IS_PRODUCTION && !useRedis && !ALLOW_FALLBACK_IN_PRODUCTION) {
    console.error(`[HTTP] Redis required in production but not available, instanceId: ${INSTANCE_ID}`);
    return res.status(503).json({ 
      error: "Server not ready - Redis unavailable",
      details: "Multi-device party sync requires Redis. Please retry in 20 seconds.",
      instanceId: INSTANCE_ID,
      redisErrorType: redisConnectionError ? getRedisErrorType(redisConnectionError) : 'not_configured',
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
    const { code, partyData } = await createPartyCommon({
      djName: djName,
      source: partySource,
      hostId: hostId,
      hostConnected: false
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
    const timestamp = new Date().toISOString();
    console.log(`[HTTP] Party created: ${code}, hostId: ${hostId}, timestamp: ${timestamp}, instanceId: ${INSTANCE_ID}, createdAt: ${partyData.createdAt}, totalParties: ${totalParties}, storageBackend: ${storageBackend}`);
    
    const response = {
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

// POST /api/join-party - Join an existing party
app.post("/api/join-party", async (req, res) => {
  const startTime = Date.now();
  console.log("[join-party] start");
  
  try {
    const timestamp = new Date().toISOString();
    console.log(`[HTTP] POST /api/join-party at ${timestamp}, instanceId: ${INSTANCE_ID}`, req.body);
    
    const { partyCode, nickname } = req.body;
    
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
    const guestNickname = nickname || `Guest ${guestNumber}`;
    
    console.log(`[join-party] Attempting to join party: ${code}, guestId: ${guestId}, nickname: ${guestNickname}, timestamp: ${timestamp}`);
    
    // Determine storage backend: prefer Redis, fallback to local storage if Redis unavailable
    const useRedis = redis && redisReady;
    const storageBackend = useRedis ? 'redis' : 'fallback';
    
    // In production mode, Redis is required UNLESS fallback mode is explicitly allowed
    if (IS_PRODUCTION && !useRedis && !ALLOW_FALLBACK_IN_PRODUCTION) {
      console.error(`[join-party] Redis required in production but not available, instanceId: ${INSTANCE_ID}`);
      return res.status(503).json({ 
        error: "Server not ready - Redis unavailable",
        details: "Multi-device party sync requires Redis. Please retry in 20 seconds.",
        instanceId: INSTANCE_ID,
        redisErrorType: redisConnectionError ? getRedisErrorType(redisConnectionError) : 'not_configured',
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
      const redisStatusMsg = redisReady ? "ready" : "not_ready";
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

// GET /api/party - Get party state (supports query parameter ?code=XXX)
app.get("/api/party", async (req, res) => {
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
  const useRedis = redis && redisReady;
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
      source: partyData.source || "local" // Host-selected source
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

// GET /api/party-state - Enhanced party state endpoint with playback info for polling
app.get("/api/party-state", async (req, res) => {
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
  const useRedis = redis && redisReady;
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
    
    console.log(`[HTTP] Party state: ${code}, status: ${status}, track: ${currentTrack?.filename || currentTrack?.title || 'none'}, queue length: ${queue.length}`);
    
    // Return enhanced party state with playback info
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
      serverTime: now,
      // Tier information (from backend entitlement validation)
      tierInfo: {
        tier: partyData.tier || null,
        partyPassExpiresAt: partyData.partyPassExpiresAt || null,
        maxPhones: partyData.maxPhones || null
      },
      // Playback state
      currentTrack: currentTrack ? {
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
      } : null,
      // Queue
      queue: queue,
      // DJ auto-messages
      djMessages: djMessages
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

// POST /api/leave-party - Remove guest from party
app.post("/api/leave-party", async (req, res) => {
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
    const useRedis = redis && redisReady;
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

// POST /api/end-party - End party early (host only)
app.post("/api/end-party", async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[HTTP] POST /api/end-party at ${timestamp}, instanceId: ${INSTANCE_ID}`, req.body);
  
  try {
    const { partyCode } = req.body;
    
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
    const useRedis = redis && redisReady;
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
    
    res.json({ ok: true });
    
  } catch (error) {
    console.error(`[HTTP] Error ending party, instanceId: ${INSTANCE_ID}:`, error);
    res.status(500).json({ 
      error: "Failed to end party",
      details: error.message 
    });
  }
});

// POST /api/apply-promo - Apply promo code to unlock party-wide Pro
app.post("/api/apply-promo", async (req, res) => {
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
    const useRedis = redis && redisReady;
    
    // In production mode, Redis is required
    if (IS_PRODUCTION && !useRedis) {
      return res.status(503).json({ 
        error: "Server not ready - Redis unavailable",
        details: "Multi-device features require Redis"
      });
    }
    
    // Get party data
    let partyData;
    if (useRedis) {
      try {
        partyData = await getPartyFromRedis(code);
      } catch (error) {
        console.warn(`[HTTP] Redis error, trying fallback: ${error.message}`);
        partyData = getPartyFromFallback(code);
      }
    } else {
      partyData = getPartyFromFallback(code);
    }
    
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
    
    // Save updated party data
    if (useRedis) {
      try {
        await setPartyInRedis(code, partyData);
      } catch (error) {
        console.warn(`[HTTP] Redis write failed for ${code}, using fallback: ${error.message}`);
        setPartyInFallback(code, partyData);
      }
    } else {
      setPartyInFallback(code, partyData);
    }
    
    // Also update WebSocket party if it exists
    const wsParty = parties.get(code);
    if (wsParty) {
      wsParty.promoUsed = true;
      wsParty.partyPro = true;
      // Broadcast to all WebSocket members
      broadcastRoomState(code);
    }
    
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

// GET /api/party/:code/debug - Enhanced debug endpoint with Redis TTL info
app.get("/api/party/:code/debug", async (req, res) => {
  const timestamp = new Date().toISOString();
  const code = req.params.code.toUpperCase().trim();
  
  // Validate party code length
  if (code.length !== 6) {
    return res.json({
      exists: false,
      ttlSeconds: -1,
      redisConnected: redis && redisReady,
      instanceId: INSTANCE_ID,
      error: "Invalid party code length"
    });
  }
  
  console.log(`[HTTP] GET /api/party/${code}/debug at ${timestamp}, instanceId: ${INSTANCE_ID}`);
  
  let exists = false;
  let ttlSeconds = -1;
  const redisConnected = redis && redisReady;
  
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

// GET /api/party/:code - Debug endpoint to check if a party exists
app.get("/api/party/:code", async (req, res) => {
  const timestamp = new Date().toISOString();
  const code = req.params.code.toUpperCase().trim();
  
  console.log(`[HTTP] GET /api/party/${code} at ${timestamp}, instanceId: ${INSTANCE_ID}`);
  
  // Read from Redis or fallback storage
  let partyData;
  const usingFallback = !redis || !redisReady;
  
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

// POST /api/party/:code/start-track - Start playing a track with scheduled sync
app.post("/api/party/:code/start-track", async (req, res) => {
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

// POST /api/party/:code/queue-track - Add track to queue (HOST-ONLY)
app.post("/api/party/:code/queue-track", async (req, res) => {
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
    const host = req.get('host');
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

// POST /api/party/:code/play-next - Play next track from queue (HOST-ONLY)
app.post("/api/party/:code/play-next", async (req, res) => {
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

// POST /api/party/:code/remove-track - Remove a track from queue (HOST-ONLY)
app.post("/api/party/:code/remove-track", async (req, res) => {
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
    const initialLength = partyData.queue.length;
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

// POST /api/party/:code/clear-queue - Clear all tracks from queue (HOST-ONLY)
app.post("/api/party/:code/clear-queue", async (req, res) => {
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

// POST /api/party/:code/reorder-queue - Reorder tracks in queue (HOST-ONLY)
app.post("/api/party/:code/reorder-queue", async (req, res) => {
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

// GET /api/party/:code/members - Get party members for polling
app.get("/api/party/:code/members", async (req, res) => {
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
  const usingFallback = !redis || !redisReady;
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

// GET /api/party/:code/limits - Get party tier limits and feature access
app.get("/api/party/:code/limits", async (req, res) => {
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

// Get party scoreboard (live or historical)
app.get("/api/party/:code/scoreboard", async (req, res) => {
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

// Get top DJs leaderboard
app.get("/api/leaderboard/djs", async (req, res) => {
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

// Get top guests leaderboard
app.get("/api/leaderboard/guests", async (req, res) => {
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

// ============================================================================
// ADMIN & ANALYTICS ENDPOINTS
// ============================================================================

// Admin metrics dashboard (secured with basic admin check)
app.get("/admin/metrics", rateLimit({ windowMs: 60000, max: 30 }), authMiddleware.requireAuth, async (req, res) => {
  try {
    // Check if user is admin (you can add admin role check in database)
    // For now, only allow in development or with ADMIN_SECRET
    // Only accept via header for security (no query parameter)
    const adminSecret = req.headers['x-admin-secret'];
    const isAdmin = process.env.NODE_ENV === 'development' || 
                    (process.env.ADMIN_SECRET && adminSecret === process.env.ADMIN_SECRET);
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Unauthorized - Admin access required' });
    }

    if (!metricsService) {
      return res.status(503).json({ error: 'Metrics service not available' });
    }

    const metrics = await metricsService.getMetrics();
    
    return res.json({
      timestamp: new Date().toISOString(),
      metrics
    });
  } catch (error) {
    console.error('[Admin] Error getting metrics:', error.message);
    return res.status(500).json({ error: 'Failed to retrieve metrics' });
  }
});

// ============================================================================
// REFERRAL ENDPOINTS
// ============================================================================

/**
 * GET /api/admin/stats
 * Live admin dashboard stats — protected with requireAdmin middleware.
 */
app.get("/api/admin/stats", rateLimit({ windowMs: 60000, max: 60 }), authMiddleware.requireAdmin, async (req, res) => {
  const startTime = Date.now();
  let dbHealth = 'ok';
  let redisHealth = 'ok';

  try {
    // DB health ping
    try { await db.query('SELECT 1'); } catch (_) { dbHealth = 'down'; }

    // Redis health ping
    try { await redis.ping(); } catch (_) { redisHealth = 'down'; }

    // ── User stats ──────────────────────────────────────────────────────────
    const usersResult = await db.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE profile_completed = true) AS profiles_completed,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS new_last_24h,
        COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '24 hours') AS active_last_24h
      FROM users
    `);
    const ur = usersResult.rows[0];

    // ── Tier breakdown ──────────────────────────────────────────────────────
    const tiersResult = await db.query(`
      SELECT tier, COUNT(*) AS cnt FROM users GROUP BY tier
    `);
    const tiers = { FREE: 0, PARTY_PASS: 0, PRO: 0 };
    for (const row of tiersResult.rows) {
      const k = row.tier || 'FREE';
      tiers[k] = (tiers[k] || 0) + parseInt(row.cnt, 10);
    }

    // ── Purchases ───────────────────────────────────────────────────────────
    let purchasesData = {
      tierPurchasesTotal: 0,
      addonPurchasesTotal: 0,
      bySku: {},
      revenueCentsLast30d: 0
    };
    try {
      const purchResult = await db.query(`
        SELECT
          COALESCE(type, purchase_kind) AS ptype,
          COALESCE(sku, item_key) AS psku,
          COUNT(*) AS cnt,
          COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN amount_cents ELSE 0 END), 0) AS rev30d
        FROM purchases
        GROUP BY 1, 2
      `);
      for (const row of purchResult.rows) {
        const cnt = parseInt(row.cnt, 10);
        const sku = row.psku || 'unknown';
        purchasesData.bySku[sku] = (purchasesData.bySku[sku] || 0) + cnt;
        purchasesData.revenueCentsLast30d += parseInt(row.rev30d, 10) || 0;
        if (row.ptype === 'tier') purchasesData.tierPurchasesTotal += cnt;
        else purchasesData.addonPurchasesTotal += cnt;
      }
    } catch (_) { /* purchases table may have different schema */ }

    // ── Live presence (Redis) ───────────────────────────────────────────────
    let onlineUsers = 0;
    let activeParties = 0;
    let activeHosts = 0;
    let activeGuests = 0;
    try {
      // Use SCAN instead of KEYS to avoid blocking Redis in production
      const presenceKeys = [];
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'presence:user:*', 'COUNT', 100);
        cursor = nextCursor;
        presenceKeys.push(...keys);
      } while (cursor !== '0');

      onlineUsers = presenceKeys.length;
      const partyCodes = new Set();
      for (const k of presenceKeys) {
        try {
          const raw = await redis.get(k);
          if (raw) {
            const data = JSON.parse(raw);
            if (data.partyCode) {
              partyCodes.add(data.partyCode);
              if (data.isHost) activeHosts++;
              else activeGuests++;
            }
          }
        } catch (_) { /* skip bad keys */ }
      }
      activeParties = partyCodes.size;
    } catch (_) { /* Redis may be unavailable */ }

    // ── Active users (heartbeat – last 5 minutes) ───────────────────────────
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    let activeUsersNow = 0;
    try {
      for (const ts of _heartbeatStore.values()) {
        if (ts instanceof Date && ts.getTime() > fiveMinAgo) activeUsersNow++;
        else if (typeof ts === 'number' && ts > fiveMinAgo) activeUsersNow++;
      }
      // Also check Redis heartbeat keys if available
      if (isRedisReady()) {
        const hbKeys = [];
        let cur = '0';
        do {
          const [next, keys] = await redis.scan(cur, 'MATCH', 'heartbeat:*', 'COUNT', 100);
          cur = next;
          hbKeys.push(...keys);
        } while (cur !== '0');
        // Count unique users (may overlap with in-memory store – use a Set)
        const seen = new Set(Array.from(_heartbeatStore.entries())
          .filter(([, ts]) => (ts instanceof Date ? ts.getTime() : ts) > fiveMinAgo)
          .map(([uid]) => uid));
        for (const k of hbKeys) {
          const uid = k.replace('heartbeat:', '');
          if (!seen.has(uid)) {
            const val = await redis.get(k);
            if (val && Number(val) > fiveMinAgo) { seen.add(uid); activeUsersNow++; }
          }
        }
      }
    } catch (_) { /* non-fatal */ }

    // ── Revenue stats ───────────────────────────────────────────────────────
    let revenueTotal = 0;
    let revenueToday = 0;
    let topProducts = [];
    let recentPurchases = [];
    try {
      const revTotalResult = await db.query(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM purchases`
      );
      revenueTotal = parseInt(revTotalResult.rows[0]?.total || 0, 10);
    } catch (_) { /* table may not have amount_cents */ }
    try {
      const revTodayResult = await db.query(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM purchases WHERE created_at >= CURRENT_DATE`
      );
      revenueToday = parseInt(revTodayResult.rows[0]?.total || 0, 10);
    } catch (_) { /* non-fatal */ }
    try {
      const topResult = await db.query(
        `SELECT COALESCE(sku, item_key, product_key) AS key, COUNT(*) AS cnt
         FROM purchases GROUP BY 1 ORDER BY cnt DESC LIMIT 10`
      );
      topProducts = topResult.rows.map(r => ({ key: r.key, count: parseInt(r.cnt, 10) }));
    } catch (_) { /* non-fatal */ }
    try {
      const recentResult = await db.query(
        `SELECT id, user_id, COALESCE(sku, item_key, product_key) AS key,
                provider, created_at
         FROM purchases ORDER BY created_at DESC LIMIT 20`
      );
      recentPurchases = recentResult.rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        key: r.key,
        provider: r.provider,
        createdAt: r.created_at
      }));
    } catch (_) { /* non-fatal */ }

    // ── Referral stats ──────────────────────────────────────────────────────
    let referralStats = {};
    try {
      if (referralSystem) {
        referralStats = await referralSystem.getAdminStats();
      }
    } catch (_) { /* non-fatal */ }

    return res.json({
      serverTime: new Date().toISOString(),
      // Flat fields required by the spec
      totalUsers: parseInt(ur.total, 10),
      activeUsersNow,
      partyPassUsers: tiers.PARTY_PASS || 0,
      proUsers: tiers.PRO || 0,
      revenueTotal,
      revenueToday,
      topProducts,
      recentPurchases,
      // Existing nested fields (kept for backwards compatibility)
      users: {
        total: parseInt(ur.total, 10),
        profilesCompleted: parseInt(ur.profiles_completed, 10),
        newLast24h: parseInt(ur.new_last_24h, 10),
        activeLast24h: parseInt(ur.active_last_24h, 10)
      },
      live: {
        onlineUsers,
        activeParties,
        activeHosts,
        activeGuests
      },
      tiers,
      purchases: purchasesData,
      referrals: referralStats,
      health: {
        db: dbHealth,
        redis: redisHealth,
        uptimeSec: Math.floor(process.uptime()),
        version: APP_VERSION
      }
    });
  } catch (error) {
    console.error('[Admin] Error getting stats:', error.message);
    return res.status(500).json({ error: 'Failed to retrieve admin stats' });
  }
});

/**
 * GET /api/admin/recent
 * Recent signups and logins — protected with requireAdmin middleware.
 * Returns only non-PII data (user IDs and timestamps, no emails).
 */
app.get("/api/admin/recent", rateLimit({ windowMs: 60000, max: 60 }), authMiddleware.requireAdmin, async (req, res) => {
  try {
    const signupsResult = await db.query(
      `SELECT id, created_at FROM users ORDER BY created_at DESC LIMIT 25`
    );
    const loginsResult = await db.query(
      `SELECT id, last_login AS last_login_at FROM users WHERE last_login IS NOT NULL ORDER BY last_login DESC LIMIT 25`
    );

    return res.json({
      signups: signupsResult.rows.map(r => ({ id: r.id, createdAt: r.created_at })),
      logins: loginsResult.rows.map(r => ({ id: r.id, lastLoginAt: r.last_login_at }))
    });
  } catch (error) {
    console.error('[Admin] Error getting recent activity:', error.message);
    return res.status(500).json({ error: 'Failed to retrieve recent activity' });
  }
});

// ─── Referral Growth System Endpoints ─────────────────────────────────────────

/**
 * GET /api/referral/me
 * Returns the user's referral stats and invite link.
 */
app.get('/api/referral/me', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
    const stats = await referralSystem.getStats(req.user.id);
    return res.json(stats);
  } catch (err) {
    console.error('[Referral] /me error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve referral stats' });
  }
});

// Keep old /stats alias for backward compatibility
app.get('/api/referral/stats', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
    const stats = await referralSystem.getStats(req.user.id);
    return res.json(stats);
  } catch (err) {
    console.error('[Referral] /stats error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve referral stats' });
  }
});

/**
 * POST /api/referral/click
 * Body: { referralCode }
 * Records a link click and returns { clickId }.
 * No auth required (called on invite landing page before signup).
 */
app.post('/api/referral/click', apiLimiter, async (req, res) => {
  try {
    if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
    const { referralCode } = req.body;
    if (!referralCode || typeof referralCode !== 'string' || referralCode.length > 20) {
      return res.status(400).json({ error: 'referralCode is required' });
    }
    const ip        = req.ip || req.connection?.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const clickId   = await referralSystem.recordClick(referralCode, ip, userAgent);
    if (!clickId) return res.status(400).json({ error: 'Invalid referral code or rate limited' });
    return res.json({ clickId });
  } catch (err) {
    console.error('[Referral] /click error:', err.message);
    return res.status(500).json({ error: 'Failed to record click' });
  }
});

/**
 * POST /api/referral/register
 * Body: { referralCode, clickId }
 * Links the currently-authenticated new user to an inviter (once only).
 */
app.post('/api/referral/register', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
    const { referralCode, clickId } = req.body;
    if (!referralCode) return res.status(400).json({ error: 'referralCode is required' });
    const ip    = req.ip || req.connection?.remoteAddress;
    const email = req.user.email || null;
    const result = await referralSystem.registerReferral(
      referralCode, clickId || null, req.user.id, email, ip
    );
    return res.json(result);
  } catch (err) {
    console.error('[Referral] /register error:', err.message);
    return res.status(500).json({ error: 'Failed to register referral' });
  }
});

/**
 * POST /api/referral/profile-complete
 * Advances the referral stage to PROFILE_DONE.
 */
app.post('/api/referral/profile-complete', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
    await referralSystem.markProfileDone(req.user.id);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Referral] /profile-complete error:', err.message);
    return res.status(500).json({ error: 'Failed to update referral stage' });
  }
});

/**
 * POST /api/referral/party-first-join
 * Final step – marks referral COMPLETED and checks milestones.
 */
app.post('/api/referral/party-first-join', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
    const result = await referralSystem.markPartyJoined(req.user.id);
    return res.json(result);
  } catch (err) {
    console.error('[Referral] /party-first-join error:', err.message);
    return res.status(500).json({ error: 'Failed to complete referral' });
  }
});

/**
 * GET /api/referral/rewards
 * Returns the user's earned reward history.
 */
app.get('/api/referral/rewards', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
    const stats = await referralSystem.getStats(req.user.id);
    return res.json({ rewards: stats.rewards || [] });
  } catch (err) {
    console.error('[Referral] /rewards error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve rewards' });
  }
});

// Keep old /track alias for backward compatibility
app.post('/api/referral/track', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    if (!referralSystem) return res.status(503).json({ error: 'Referral system not available' });
    const { referralCode } = req.body;
    if (!referralCode) return res.status(400).json({ error: 'referralCode is required' });
    const result = await referralSystem.registerReferral(
      referralCode, null, req.user.id, req.user.email || null, req.ip
    );
    return res.json({ success: result.ok });
  } catch (err) {
    console.error('[Referral] /track error:', err.message);
    return res.status(500).json({ error: 'Failed to track referral' });
  }
});

// ============================================================================
// STREAMING PARTY ENDPOINTS
// ============================================================================

/**
 * GET /api/streaming/providers
 * Returns the list of supported streaming providers.
 * Requires: feature flag ON + Party Pass or Pro tier.
 */
app.get('/api/streaming/providers', apiLimiter, requireStreamingEnabled, authMiddleware.requireAuth, requireStreamingEntitled, async (req, res) => {
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
          description: 'Direct streams behave similar to uploads.',
          deepLinkTemplate: '{url}',
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

/**
 * POST /api/streaming/select-track
 * Host selects a track from a streaming provider.
 * Requires: feature flag ON + Party Pass or Pro tier.
 *
 * Body: { partyCode, provider, trackId, title?, artist?, artwork? }
 */
app.post('/api/streaming/select-track', apiLimiter, requireStreamingEnabled, authMiddleware.requireAuth, requireStreamingEntitled, async (req, res) => {
  try {
    const { partyCode, provider, trackId, title, artist, artwork } = req.body;

    if (!partyCode || !provider || !trackId) {
      return res.status(400).json({ error: 'partyCode, provider, and trackId are required' });
    }

    const validProviders = ['youtube', 'spotify', 'soundcloud'];
    if (!validProviders.includes((provider || '').toLowerCase())) {
      return res.status(400).json({ error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
    }

    // Build deep link
    const providerLower = provider.toLowerCase();
    let deepLink;
    if (providerLower === 'youtube') {
      deepLink = `https://www.youtube.com/watch?v=${encodeURIComponent(trackId)}`;
    } else if (providerLower === 'spotify') {
      deepLink = `spotify:track:${trackId}`;
    } else {
      deepLink = trackId; // SoundCloud uses the full URL as trackId
    }

    const trackDescriptor = {
      source: providerLower,
      id: trackId,
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

/**
 * GET /api/streaming/access
 * Check if the authenticated user has Streaming Party access.
 * Returns featureEnabled flag and entitlement status.
 */
app.get('/api/streaming/access', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    const featureEnabled = isStreamingPartyEnabled();
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


const STRIPE_PRICE_PARTY_PASS = process.env.STRIPE_PRICE_PARTY_PASS || 'price_1T730tK3GhmyOKSB36mifw84';
const STRIPE_PRICE_PRO_MONTHLY = process.env.STRIPE_PRICE_PRO_MONTHLY || 'price_1T733rK3GhmyOKSBsghjQPUZ';
const STRIPE_SERVICE_URL = 'https://syncspeaker-262593928124.us-central1.run.app';
const STRIPE_SUCCESS_URL = (process.env.PUBLIC_BASE_URL || STRIPE_SERVICE_URL) + '/payment-success';
const STRIPE_CANCEL_URL = (process.env.PUBLIC_BASE_URL || STRIPE_SERVICE_URL) + '/payment-cancel';

// ============================================================================
// BASKET / CART SYSTEM
// ============================================================================

// In-memory basket store (keyed by userId). Cleared after successful checkout.
const userBaskets = new Map();

app.get('/api/basket', apiLimiter, authMiddleware.requireAuth, (req, res) => {
  const userId = req.user.userId;
  return res.json({ basket: userBaskets.get(userId) || [] });
});

app.post('/api/basket/add', apiLimiter, authMiddleware.requireAuth, (req, res) => {
  const userId = req.user.userId;
  const { priceId } = req.body;
  if (!priceId) return res.status(400).json({ error: 'priceId is required' });
  const basket = userBaskets.get(userId) || [];
  if (!basket.includes(priceId)) basket.push(priceId);
  userBaskets.set(userId, basket);
  return res.json({ basket });
});

app.delete('/api/basket/item/:priceId', apiLimiter, authMiddleware.requireAuth, (req, res) => {
  const userId = req.user.userId;
  const priceId = req.params.priceId;
  const basket = (userBaskets.get(userId) || []).filter(p => p !== priceId);
  userBaskets.set(userId, basket);
  return res.json({ basket });
});

app.post('/api/basket/checkout', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  if (!stripeClient) return res.status(503).json({ error: 'Billing not configured. STRIPE_SECRET_KEY is missing.' });
  const userId = req.user.userId;
  const basket = userBaskets.get(userId) || [];
  if (basket.length === 0) return res.status(400).json({ error: 'Basket is empty' });
  const hasSubscription = basket.some(p => p === STRIPE_PRICE_PRO_MONTHLY);
  const mode = hasSubscription ? 'subscription' : 'payment';
  try {
    const session = await stripeClient.checkout.sessions.create({
      mode,
      line_items: basket.map(priceId => ({ price: priceId, quantity: 1 })),
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      metadata: { userId }
    });
    userBaskets.delete(userId);
    return res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('[BasketCheckout] Error:', error.message);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ============================================================================
// STRIPE CHECKOUT SESSION ENDPOINT
// ============================================================================

/**
 * POST /api/stripe/create-checkout-session
 * Creates a Stripe Checkout Session for a specific price.
 * mode: "payment" for Party Pass, "subscription" for Pro.
 */
app.post('/api/stripe/create-checkout-session', apiLimiter, authMiddleware.optionalAuth, async (req, res) => {
  if (!stripeClient) {
    return res.status(503).json({ error: 'Billing not configured. STRIPE_SECRET_KEY is missing.' });
  }
  const { priceId, userId } = req.body;
  if (!priceId || !userId) {
    return res.status(400).json({ error: 'priceId and userId are required' });
  }
  // If authenticated, userId in body must match the authenticated user
  if (req.user && req.user.userId && req.user.userId !== String(userId)) {
    return res.status(403).json({ error: 'userId does not match authenticated user' });
  }
  const mode = priceId === STRIPE_PRICE_PARTY_PASS ? 'payment' : 'subscription';
  try {
    const session = await stripeClient.checkout.sessions.create({
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      metadata: { userId: String(userId), priceId }
    });
    return res.json({ sessionId: session.id });
  } catch (error) {
    console.error('[StripeCheckout] Error creating session:', error.message);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ============================================================================
// ADMIN STATS ENDPOINT
// ============================================================================

/**
 * GET /api/admin/stats
 * Returns live platform statistics. Restricted to the admin email.
 */
app.get('/api/admin/stats', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  if (req.user.email !== 'ianevans2023@outlook.com') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const [totalRes, activeRes, passRes, proRes, todayRes, totalRevRes] = await Promise.all([
      db.query('SELECT COUNT(*) AS count FROM users'),
      db.query("SELECT COUNT(*) AS count FROM users WHERE last_login > NOW() - INTERVAL '30 days'"),
      db.query('SELECT COUNT(*) AS count FROM user_upgrades WHERE party_pass_expires_at > NOW()'),
      db.query('SELECT COUNT(*) AS count FROM user_upgrades WHERE pro_monthly_active = true'),
      db.query('SELECT COALESCE(SUM(amount), 0) AS total FROM revenue_metrics WHERE created_at >= CURRENT_DATE'),
      db.query('SELECT COALESCE(SUM(amount), 0) AS total FROM revenue_metrics')
    ]);
    return res.json({
      totalUsers: parseInt(totalRes.rows[0].count, 10),
      activeUsers: parseInt(activeRes.rows[0].count, 10),
      partyPassUsers: parseInt(passRes.rows[0].count, 10),
      proUsers: parseInt(proRes.rows[0].count, 10),
      revenueToday: parseFloat(todayRes.rows[0].total),
      revenueTotal: parseFloat(totalRevRes.rows[0].total)
    });
  } catch (error) {
    console.error('[AdminStats] Error:', error.message);
    return res.status(500).json({ error: 'Failed to retrieve stats' });
  }
});

// ============================================================================
// BILLING ENDPOINTS (Stripe Checkout subscriptions)
// ============================================================================

/**
 * POST /api/billing/create-checkout-session
 * Creates a Stripe Checkout Session for a PRO monthly subscription.
 * Does NOT grant tier here — the webhook does that.
 */
app.post('/api/billing/create-checkout-session', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  if (!stripeClient) {
    return res.status(503).json({ error: 'Billing not configured. STRIPE_SECRET_KEY is missing.' });
  }
  const priceId = process.env.STRIPE_PRICE_ID_PRO_MONTHLY;
  if (!priceId) {
    return res.status(503).json({ error: 'Billing not configured. STRIPE_PRICE_ID_PRO_MONTHLY is missing.' });
  }
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const userId = req.user.userId;

    // Fetch user email and current stripe_customer_id
    const userResult = await db.query(
      'SELECT email, stripe_customer_id FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];
    let customerId = user.stripe_customer_id;

    // Create Stripe customer if not yet linked
    if (!customerId) {
      const customer = await stripeClient.customers.create({
        email: user.email,
        metadata: { userId }
      });
      customerId = customer.id;
      await db.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, userId]
      );
    }

    // Create Checkout Session
    const session = await stripeClient.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${publicBaseUrl}/?billing=success`,
      cancel_url: `${publicBaseUrl}/?billing=cancel`,
      client_reference_id: String(userId)
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error('[BillingCheckout] Error creating session:', error.message);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * GET /api/billing/status
 * Returns the authenticated user's current billing/subscription state.
 */
app.get('/api/billing/status', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await db.query(
      `SELECT tier, subscription_status, current_period_end, stripe_customer_id, stripe_subscription_id
       FROM users WHERE id = $1`,
      [userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const row = result.rows[0];
    return res.json({
      tier: row.tier || 'FREE',
      subscription_status: row.subscription_status || null,
      current_period_end: row.current_period_end || null,
      stripe_customer_id: row.stripe_customer_id || null,
      stripe_subscription_id: row.stripe_subscription_id || null
    });
  } catch (error) {
    console.error('[BillingStatus] Error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch billing status' });
  }
});

/**
 * Derive tier string from subscription status.
 * Policy: PRO when active or trialing; FREE otherwise.
 * past_due keeps FREE (conservative).
 */
function tierFromSubscriptionStatus(status) {
  if (status === 'active' || status === 'trialing') return 'PRO';
  return 'FREE';
}

/**
 * POST /api/billing/webhook
 * Stripe webhook endpoint. Uses raw body for signature verification.
 * IMPORTANT: this route must be registered BEFORE the JSON body-parser middleware
 * applies to it, so we attach express.raw() directly on this route.
 */
app.post(
  '/api/billing/webhook',
  rateLimit({ windowMs: 60000, max: 200 }),
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[BillingWebhook] STRIPE_WEBHOOK_SECRET not configured');
      return res.status(500).json({ error: 'Webhook not configured' });
    }
    if (!stripeClient) {
      console.error('[BillingWebhook] Stripe client not available');
      return res.status(503).json({ error: 'Billing not configured' });
    }

    let event;
    try {
      event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
    } catch (err) {
      console.error('[BillingWebhook] Signature verification failed:', err.message);
      return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    }

    // Respond 200 quickly; process asynchronously
    res.json({ received: true });

    try {
      await handleBillingWebhookEvent(event);
    } catch (err) {
      console.error('[BillingWebhook] Handler error:', err.message);
    }
  }
);

/**
 * Handle a verified billing webhook event and update the DB.
 */
async function handleBillingWebhookEvent(event) {
  const { type, data } = event;
  const obj = data.object;

  console.log(`[BillingWebhook] Received event: ${type}`);

  switch (type) {
    case 'checkout.session.completed': {
      const userId = obj.client_reference_id;
      const customerId = obj.customer;
      const subscriptionId = obj.subscription;
      if (!userId) {
        console.error('[BillingWebhook] checkout.session.completed: missing client_reference_id');
        return;
      }
      await db.query(
        'UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, $1), stripe_subscription_id = $2 WHERE id = $3',
        [customerId, subscriptionId, userId]
      );
      // Fetch subscription to get status + period end
      if (subscriptionId && stripeClient) {
        try {
          const sub = await stripeClient.subscriptions.retrieve(subscriptionId);
          const newTier = tierFromSubscriptionStatus(sub.status);
          await db.query(
            `UPDATE users SET subscription_status = $1, current_period_end = $2, tier = $3
             WHERE id = $4`,
            [sub.status, new Date(sub.current_period_end * 1000), newTier, userId]
          );
          console.log(`[BillingWebhook] checkout.session.completed: userId=${userId} tier=${newTier}`);
        } catch (fetchErr) {
          console.error('[BillingWebhook] Failed to fetch subscription after checkout:', fetchErr.message);
        }
      }
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscriptionId = obj.id;
      const customerId = obj.customer;
      const status = obj.status;
      const periodEnd = new Date(obj.current_period_end * 1000);
      const newTier = tierFromSubscriptionStatus(status);

      // Prefer metadata.userId; fall back to stripe_customer_id lookup
      let userId = obj.metadata?.userId;
      if (!userId) {
        const r = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
        if (r.rows.length > 0) userId = r.rows[0].id;
      }
      if (!userId) {
        console.error(`[BillingWebhook] ${type}: no userId for customer ${customerId}`);
        return;
      }

      await db.query(
        `UPDATE users SET stripe_subscription_id = $1, subscription_status = $2,
         current_period_end = $3, tier = $4 WHERE id = $5`,
        [subscriptionId, status, periodEnd, newTier, userId]
      );
      console.log(`[BillingWebhook] ${type}: userId=${userId} status=${status} tier=${newTier}`);
      break;
    }

    case 'customer.subscription.deleted': {
      const subscriptionId = obj.id;
      const customerId = obj.customer;
      const status = obj.status;

      let userId = obj.metadata?.userId;
      if (!userId) {
        const r = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
        if (r.rows.length > 0) userId = r.rows[0].id;
      }
      if (!userId) {
        const r = await db.query('SELECT id FROM users WHERE stripe_subscription_id = $1', [subscriptionId]);
        if (r.rows.length > 0) userId = r.rows[0].id;
      }
      if (!userId) {
        console.error(`[BillingWebhook] customer.subscription.deleted: no userId found`);
        return;
      }

      await db.query(
        `UPDATE users SET subscription_status = $1, tier = 'FREE' WHERE id = $2`,
        [status || 'canceled', userId]
      );
      console.log(`[BillingWebhook] customer.subscription.deleted: userId=${userId} tier=FREE`);
      break;
    }

    case 'invoice.payment_succeeded': {
      const subscriptionId = obj.subscription;
      if (!subscriptionId) return;
      const periodEnd = new Date(obj.period_end * 1000);
      await db.query(
        `UPDATE users SET subscription_status = 'active', current_period_end = $1, tier = 'PRO'
         WHERE stripe_subscription_id = $2`,
        [periodEnd, subscriptionId]
      );
      console.log(`[BillingWebhook] invoice.payment_succeeded: subscription=${subscriptionId} tier=PRO`);
      break;
    }

    case 'invoice.payment_failed': {
      const subscriptionId = obj.subscription;
      if (!subscriptionId) return;
      // Keep subscription_status as past_due; conservative: set tier to FREE
      await db.query(
        `UPDATE users SET subscription_status = 'past_due', tier = 'FREE'
         WHERE stripe_subscription_id = $1`,
        [subscriptionId]
      );
      console.log(`[BillingWebhook] invoice.payment_failed: subscription=${subscriptionId} tier=FREE`);
      break;
    }

    default:
      console.log(`[BillingWebhook] Unhandled event type: ${type}`);
  }
}

// ============================================================================
// STRIPE WEBHOOK ENDPOINT
// ============================================================================

// Stripe webhook handler (raw body required for signature verification)
// Note: Webhooks should have lenient rate limiting as they're externally triggered
app.post("/api/stripe/webhook", rateLimit({ windowMs: 60000, max: 100 }), express.raw({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Stripe] Webhook secret not configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }
  if (!stripeClient) {
    console.error('[Stripe] Stripe client not available');
    return res.status(503).json({ error: 'Billing not configured' });
  }

  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.error('[Stripe] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  // Respond 200 immediately; process asynchronously
  res.json({ received: true });

  try {
    await handleStripeWebhookEvent(event);
  } catch (err) {
    console.error('[Stripe] Webhook handler error:', err.message);
  }
});

/**
 * POST /api/test/stripe/simulate-webhook
 * Test-only endpoint to simulate Stripe webhook events without needing a real
 * Stripe signature. Only available when NODE_ENV === 'test'.
 *
 * Supported events:
 *   checkout.session.completed
 *   invoice.paid
 *   invoice.payment_failed
 *   customer.subscription.deleted
 */
if (process.env.NODE_ENV === 'test') {
  app.post('/api/test/stripe/simulate-webhook', express.json(), async (req, res) => {
    const { type, data } = req.body || {};
    if (!type || !data) {
      return res.status(400).json({ error: 'type and data are required' });
    }
    const allowed = [
      'checkout.session.completed',
      'invoice.paid',
      'invoice.payment_failed',
      'customer.subscription.deleted'
    ];
    if (!allowed.includes(type)) {
      return res.status(400).json({ error: `Unsupported event type: ${type}` });
    }
    try {
      await handleStripeWebhookEvent({ type, data: { object: data } });
      res.json({ received: true, type });
    } catch (err) {
      console.error('[Stripe/Test] simulate-webhook error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

/**
 * Handle a verified Stripe webhook event.
 */
async function handleStripeWebhookEvent(event) {
  const { type, data } = event;
  const obj = data.object;
  console.log(`[Stripe] Processing webhook event: ${type}`);

  switch (type) {
    case 'checkout.session.completed': {
      const userId = obj.metadata?.userId || obj.client_reference_id;
      if (!userId) {
        console.error('[Stripe] checkout.session.completed: no userId in metadata');
        return;
      }
      // Get price ID from metadata (set at session creation) or expand line_items
      let priceId = obj.metadata?.priceId;
      if (!priceId) {
        try {
          const expanded = await stripeClient.checkout.sessions.retrieve(obj.id, { expand: ['line_items'] });
          priceId = expanded.line_items?.data?.[0]?.price?.id;
        } catch (err) {
          console.error('[Stripe] Failed to retrieve line_items:', err.message);
        }
      }
      if (priceId === STRIPE_PRICE_PARTY_PASS) {
        const expiresAt = new Date(Date.now() + PARTY_PASS_DURATION_MS);
        await db.query(
          `INSERT INTO user_upgrades (user_id, party_pass_expires_at)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET party_pass_expires_at = $2, updated_at = NOW()`,
          [userId, expiresAt]
        );
        await db.query(`UPDATE users SET tier = 'PARTY_PASS' WHERE id = $1`, [userId]);
        console.log(`[Stripe] Party Pass activated for user ${userId} (expires ${expiresAt.toISOString()})`);
      } else if (priceId === STRIPE_PRICE_PRO_MONTHLY) {
        await db.query(
          `INSERT INTO user_upgrades (user_id, pro_monthly_active, pro_monthly_started_at, pro_monthly_renewal_provider)
           VALUES ($1, true, NOW(), 'stripe')
           ON CONFLICT (user_id) DO UPDATE SET pro_monthly_active = true, pro_monthly_started_at = NOW(),
             pro_monthly_renewal_provider = 'stripe', updated_at = NOW()`,
          [userId]
        );
        await db.query(
          `UPDATE users SET tier = 'PRO', subscription_status = 'active' WHERE id = $1`,
          [userId]
        );
        console.log(`[Stripe] Pro subscription activated for user ${userId}`);
      } else {
        console.log(`[Stripe] checkout.session.completed: unrecognised priceId=${priceId}`);
      }
      break;
    }

    case 'invoice.paid': {
      const subscriptionId = obj.subscription;
      if (!subscriptionId) return;
      const periodEnd = obj.period_end ? new Date(obj.period_end * 1000) : null;
      await db.query(
        `UPDATE users SET subscription_status = 'active', tier = 'PRO'${periodEnd ? ', current_period_end = $2' : ''}
         WHERE stripe_subscription_id = $1`,
        periodEnd ? [subscriptionId, periodEnd] : [subscriptionId]
      );
      console.log(`[Stripe] invoice.paid: subscription=${subscriptionId}`);
      break;
    }

    case 'invoice.payment_failed': {
      const subscriptionId = obj.subscription;
      if (!subscriptionId) return;
      await db.query(
        `UPDATE users SET subscription_status = 'past_due', tier = 'FREE'
         WHERE stripe_subscription_id = $1`,
        [subscriptionId]
      );
      await db.query(
        `UPDATE user_upgrades SET pro_monthly_active = false, updated_at = NOW()
         WHERE user_id = (SELECT id FROM users WHERE stripe_subscription_id = $1)`,
        [subscriptionId]
      );
      console.log(`[Stripe] invoice.payment_failed: subscription=${subscriptionId}`);
      break;
    }

    case 'customer.subscription.deleted': {
      const subscriptionId = obj.id;
      const customerId = obj.customer;
      let userId = obj.metadata?.userId;
      if (!userId) {
        const r = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
        if (r.rows.length > 0) userId = r.rows[0].id;
      }
      if (!userId) {
        const r = await db.query('SELECT id FROM users WHERE stripe_subscription_id = $1', [subscriptionId]);
        if (r.rows.length > 0) userId = r.rows[0].id;
      }
      if (!userId) {
        console.error('[Stripe] customer.subscription.deleted: no userId found');
        return;
      }
      await db.query(
        `UPDATE users SET subscription_status = 'canceled', tier = 'FREE' WHERE id = $1`,
        [userId]
      );
      await db.query(
        `UPDATE user_upgrades SET pro_monthly_active = false, updated_at = NOW() WHERE user_id = $1`,
        [userId]
      );
      console.log(`[Stripe] customer.subscription.deleted: userId=${userId}`);
      break;
    }

    default:
      console.log(`[Stripe] Unhandled event type: ${type}`);
  }
}

// ============================================================================
// HEARTBEAT – active user tracking
// ============================================================================
// _heartbeatStore is defined near the top of this file (alongside other Maps).

/**
 * POST /api/metrics/heartbeat
 * Body: { userId }
 * Stores lastSeen timestamp so /api/admin/stats can count active users.
 */
app.post('/api/metrics/heartbeat', apiLimiter, async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  _heartbeatStore.set(String(userId), new Date());
  // Also try Redis so multi-instance deploys work
  try {
    if (isRedisReady()) {
      await redis.set(`heartbeat:${userId}`, Date.now(), 'EX', 300);
    }
  } catch (_) { /* non-fatal */ }
  return res.json({ ok: true });
});

// ============================================================================
// BASKET – server-side shopping basket
// ============================================================================
// _baskets is defined near the top of this file (alongside other Maps).

/**
 * POST /api/basket/add
 * Body: { productKey }
 * (userId taken from auth token)
 */
app.post('/api/basket/add', apiLimiter, authMiddleware.requireAuth, (req, res) => {
  const { productKey } = req.body || {};
  const userId = req.user.userId;
  if (!productKey) return res.status(400).json({ error: 'productKey required' });
  if (!PRODUCTS[productKey]) return res.status(400).json({ error: `Unknown productKey: ${productKey}` });
  const basket = _baskets.get(userId) || new Set();
  basket.add(productKey);
  _baskets.set(userId, basket);
  return res.json({ basket: Array.from(basket) });
});

/**
 * POST /api/basket/remove
 * Body: { productKey }
 * (userId taken from auth token)
 */
app.post('/api/basket/remove', apiLimiter, authMiddleware.requireAuth, (req, res) => {
  const { productKey } = req.body || {};
  const userId = req.user.userId;
  if (!productKey) return res.status(400).json({ error: 'productKey required' });
  const basket = _baskets.get(userId) || new Set();
  basket.delete(productKey);
  _baskets.set(userId, basket);
  return res.json({ basket: Array.from(basket) });
});

/**
 * GET /api/basket
 * Query: ?userId= (ignored – uses auth token)
 */
app.get('/api/basket', apiLimiter, authMiddleware.requireAuth, (req, res) => {
  const userId = req.user.userId;
  const basket = _baskets.get(userId) || new Set();
  return res.json({ basket: Array.from(basket) });
});

// ============================================================================
// IAP – Apple In-App Purchase verification
// ============================================================================

/**
 * POST /api/iap/apple/verify
 * Body: { receiptData, userId }
 * ENV: APPLE_SHARED_SECRET
 */
app.post('/api/iap/apple/verify', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  const { receiptData } = req.body || {};
  const userId = req.user.userId;

  if (!receiptData) return res.status(400).json({ error: 'receiptData required' });

  const sharedSecret = process.env.APPLE_SHARED_SECRET;
  if (!sharedSecret) {
    console.error('[IAP/Apple] APPLE_SHARED_SECRET not set');
    return res.status(503).json({ error: 'Apple IAP not configured' });
  }

  // Verify with Apple – try production first, then sandbox
  const https = require('https');
  async function verifyWithApple(url, payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const opts = new URL(url);
      const reqOpts = {
        hostname: opts.hostname,
        path: opts.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const r = https.request(reqOpts, (resp) => {
        let data = '';
        resp.on('data', d => { data += d; });
        resp.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      r.on('error', reject);
      r.write(body);
      r.end();
    });
  }

  try {
    const payload = { 'receipt-data': receiptData, password: sharedSecret, 'exclude-old-transactions': true };
    let appleResp = await verifyWithApple('https://buy.itunes.apple.com/verifyReceipt', payload);

    // Status 21007 = sandbox receipt sent to production – retry with sandbox
    if (appleResp.status === 21007) {
      appleResp = await verifyWithApple('https://sandbox.itunes.apple.com/verifyReceipt', payload);
    }

    if (appleResp.status !== 0) {
      console.warn(`[IAP/Apple] Verification failed with status ${appleResp.status}`);
      return res.status(400).json({ error: `Apple verification failed: status ${appleResp.status}` });
    }

    const latestReceipts = appleResp.latest_receipt_info || appleResp.receipt?.in_app || [];
    const results = [];

    for (const receipt of latestReceipts) {
      const productId = receipt.product_id;
      const transactionId = receipt.transaction_id;
      const product = getProductByPlatformId('apple', productId);
      if (!product) {
        console.warn(`[IAP/Apple] Unknown productId: ${productId}`);
        continue;
      }
      try {
        const result = await applyPurchaseToUser({
          userId,
          productKey: product.key,
          provider: 'apple',
          providerTransactionId: transactionId,
          raw: receipt
        });
        results.push({ productId, productKey: product.key, ...result });
      } catch (err) {
        console.error(`[IAP/Apple] applyPurchaseToUser error for ${productId}:`, err.message);
      }
    }

    return res.json({ ok: true, results });
  } catch (err) {
    console.error('[IAP/Apple] Verification error:', err.message);
    return res.status(500).json({ error: 'Apple verification failed' });
  }
});

// ============================================================================
// IAP – Google Play Billing verification
// ============================================================================

/**
 * POST /api/iap/google/verify
 * Body: { packageName, productId, purchaseToken, userId }
 * ENV: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, GOOGLE_PLAY_PACKAGE_NAME
 */
app.post('/api/iap/google/verify', apiLimiter, authMiddleware.requireAuth, async (req, res) => {
  const { packageName: bodyPackageName, productId, purchaseToken } = req.body || {};
  const userId = req.user.userId;

  const packageName = bodyPackageName || process.env.GOOGLE_PLAY_PACKAGE_NAME;
  if (!productId || !purchaseToken) {
    return res.status(400).json({ error: 'productId and purchaseToken required' });
  }
  if (!packageName) {
    return res.status(400).json({ error: 'packageName required (or set GOOGLE_PLAY_PACKAGE_NAME)' });
  }

  const serviceAccountJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    console.error('[IAP/Google] GOOGLE_PLAY_SERVICE_ACCOUNT_JSON not set');
    return res.status(503).json({ error: 'Google Play IAP not configured' });
  }

  try {
    const serviceAccount = JSON.parse(serviceAccountJson);

    // Get access token via JWT + Google OAuth2
    const jwt = require('jsonwebtoken');
    const now = Math.floor(Date.now() / 1000);
    const jwtPayload = {
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    };
    const signedJwt = jwt.sign(jwtPayload, serviceAccount.private_key, { algorithm: 'RS256' });

    const https = require('https');
    async function postForm(url, formData) {
      return new Promise((resolve, reject) => {
        const body = new URLSearchParams(formData).toString();
        const opts = new URL(url);
        const reqOpts = {
          hostname: opts.hostname,
          path: opts.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
        };
        const r = https.request(reqOpts, (resp) => {
          let data = '';
          resp.on('data', d => { data += d; });
          resp.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          });
        });
        r.on('error', reject);
        r.write(body);
        r.end();
      });
    }

    async function getJson(url, accessToken) {
      return new Promise((resolve, reject) => {
        const opts = new URL(url);
        const reqOpts = {
          hostname: opts.hostname,
          path: opts.pathname + opts.search,
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` }
        };
        const r = https.request(reqOpts, (resp) => {
          let data = '';
          resp.on('data', d => { data += d; });
          resp.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          });
        });
        r.on('error', reject);
        r.end();
      });
    }

    const tokenResp = await postForm('https://oauth2.googleapis.com/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt
    });

    if (!tokenResp.access_token) {
      console.error('[IAP/Google] Failed to get access token:', tokenResp);
      return res.status(500).json({ error: 'Failed to authenticate with Google' });
    }

    // Determine if product is one-time or subscription and use appropriate API
    const product = getProductByPlatformId('google', productId);
    const productType = product ? product.type : 'one_time';

    let purchaseData;
    if (productType === 'subscription') {
      purchaseData = await getJson(
        `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/subscriptions/${productId}/tokens/${purchaseToken}`,
        tokenResp.access_token
      );
    } else {
      purchaseData = await getJson(
        `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/products/${productId}/tokens/${purchaseToken}`,
        tokenResp.access_token
      );
    }

    if (purchaseData.error) {
      console.warn('[IAP/Google] Purchase validation error:', purchaseData.error);
      return res.status(400).json({ error: `Google validation failed: ${purchaseData.error.message || 'unknown'}` });
    }

    if (!product) {
      console.warn(`[IAP/Google] Unknown productId: ${productId}`);
      return res.status(400).json({ error: `Unknown productId: ${productId}` });
    }

    const transactionId = purchaseToken; // Use token as unique transaction ID
    const result = await applyPurchaseToUser({
      userId,
      productKey: product.key,
      provider: 'google',
      providerTransactionId: transactionId,
      raw: purchaseData
    });

    return res.json({ ok: true, productKey: product.key, ...result });
  } catch (err) {
    console.error('[IAP/Google] Verification error:', err.message);
    return res.status(500).json({ error: 'Google Play verification failed' });
  }
});

// ============================================================================
// ADMIN helper
// ============================================================================

/**
 * isAdmin(email) - matches admin email exactly (case-insensitive).
 * Checks ADMIN_EMAILS env var (comma-separated) and the hardcoded admin email.
 * @param {string} email
 * @returns {boolean}
 */
function isAdmin(email) {
  if (!email) return false;
  const lc = email.trim().toLowerCase();
  // Delegate to auth middleware's isAdminEmail (reads ADMIN_EMAILS env var)
  if (authMiddleware.isAdminEmail(lc)) return true;
  // Fallback: check hardcoded admin email from ADMIN_EMAIL env var
  const hardcoded = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  return hardcoded !== '' && lc === hardcoded;
}

// Cleanup expired parties (Redis TTL handles expiration automatically)
// This function now only cleans up local WebSocket state for expired parties
function cleanupExpiredParties() {
  const now = Date.now();
  const expiredCodes = [];
  
  // Clean up expired parties from local storage (WebSocket connections)
  for (const [code, party] of parties.entries()) {
    if (party.createdAt && now - party.createdAt > PARTY_TTL_MS) {
      expiredCodes.push(code);
    }
  }
  
  if (expiredCodes.length > 0) {
    console.log(`[Cleanup] Removing ${expiredCodes.length} expired local parties (instance ${INSTANCE_ID}): ${expiredCodes.join(', ')}`);
    expiredCodes.forEach(code => {
      parties.delete(code);
      // Redis TTL will handle cleanup in shared store automatically
    });
  }
}

// Cleanup expired uploaded tracks
// SECTION 3: Track cleanup now handled by storage provider TTL
// Storage provider manages its own TTL, so this is a no-op stub
function cleanupExpiredTracks() {
  // No-op: Track cleanup is handled automatically by storage provider TTL
  // This function exists only to prevent ReferenceError when called from runCleanupJobs()
}

// Persist party scoreboard to database
async function persistPartyScoreboard(partyCode, party) {
  if (!party || !party.scoreState) {
    console.log(`[Database] No scoreState for party ${partyCode}, skipping persistence`);
    return;
  }
  
  try {
    const partyDurationMinutes = party.createdAt 
      ? Math.floor((Date.now() - party.createdAt) / 60000) 
      : 0;
    
    // Prepare guest scores array
    const guestScores = Object.values(party.scoreState.guests).map(guest => ({
      guestId: guest.guestId,
      nickname: guest.nickname,
      points: guest.points,
      emojis: guest.emojis,
      messages: guest.messages,
      rank: guest.rank
    }));
    
    // Save party scoreboard session
    await db.savePartyScoreboard({
      partyCode,
      hostUserId: party.scoreState.dj.djUserId,
      hostIdentifier: party.scoreState.dj.djIdentifier,
      djSessionScore: party.scoreState.dj.sessionScore,
      guestScores,
      partyDurationMinutes,
      totalReactions: party.scoreState.totalReactions,
      totalMessages: party.scoreState.totalMessages,
      peakCrowdEnergy: party.scoreState.peakCrowdEnergy
    });
    
    console.log(`[Database] Saved scoreboard for party ${partyCode}`);
    
    // Update DJ profile if logged in
    if (party.scoreState.dj.djUserId) {
      await db.updateDjProfileScore(
        party.scoreState.dj.djUserId, 
        party.scoreState.dj.sessionScore
      );
      console.log(`[Database] Updated DJ score for user ${party.scoreState.dj.djUserId}`);
    }
    
    // Update guest profiles (UPSERT pattern creates if not exists)
    for (const guest of guestScores) {
      try {
        // Update guest stats (UPSERT)
        await db.updateGuestProfile(guest.guestId, {
          contributionPoints: guest.points,
          reactionsCount: guest.emojis,
          messagesCount: guest.messages
        });
        
        // Increment parties_joined counter (once per party)
        await db.incrementGuestPartiesJoined(guest.guestId);
      } catch (err) {
        console.error(`[Database] Error updating guest profile ${guest.guestId}:`, err.message);
      }
    }
    
    console.log(`[Database] Updated ${guestScores.length} guest profiles`);
    
  } catch (error) {
    console.error(`[Database] Error persisting scoreboard for party ${partyCode}:`, error.message);
    throw error;
  }
}

// Combined cleanup job for parties and tracks
function runCleanupJobs() {
  cleanupExpiredParties();
  cleanupExpiredTracks();
}

// Start cleanup interval
let cleanupInterval;

// ============================================================================
// ERROR HANDLERS - Must be registered AFTER all routes
// ============================================================================

// Sentry error handler (if configured) - must come before custom error handler
if (process.env.NODE_ENV === 'production' && process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  app.use(Sentry.Handlers.errorHandler());
}

// Global JSON error handler — catches any unhandled errors and returns JSON
// instead of Express's default HTML error page. Must be registered after all routes.
// Express requires the 'next' parameter even though we may not call it for linting purposes.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err);
  const status = err.status || err.statusCode || 500;
  const message = (process.env.NODE_ENV === 'production' && status === 500)
    ? 'Internal server error'
    : (err.message || 'Internal server error');

  // If headers already sent, delegate to Express default error handler
  if (res.headersSent) {
    return next(err);
  }

  res.status(status).json({ error: message });
});

// Start the HTTP server only if not imported as a module
let server;
let wss;

async function startServer() {
  console.log("🚀 Server booting...");
  console.log(`   Instance ID: ${INSTANCE_ID}`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Version: ${APP_VERSION}`);
  
  // Initialize database schema
  console.log("⏳ Initializing database...");
  try {
    const dbHealth = await db.healthCheck();
    if (dbHealth.healthy) {
      console.log("✅ Database connected successfully");
      await db.initializeSchema();
      console.log("✅ Database schema initialized");
      dbReady = true;
    } else {
      console.warn(`⚠️  Database health check failed: ${dbHealth.error}`);
      console.warn("   Authentication features will not be available");
    }
  } catch (err) {
    console.warn(`⚠️  Database initialization error: ${err.message}`);
    console.warn("   Authentication features will not be available");
  }
  
  // Wait for Redis to be ready (with timeout)
  if (redis) {
    console.log("⏳ Waiting for Redis connection...");
    try {
      await waitForRedis(10000); // 10 second timeout
      console.log("✅ Redis connected and ready");
    } catch (err) {
      console.warn(`⚠️  Redis connection timeout: ${err.message}`);
      
      if (IS_PRODUCTION && !ALLOW_FALLBACK_IN_PRODUCTION) {
        console.error("");
        console.error("╔═══════════════════════════════════════════════════════════════╗");
        console.error("║  ⚠️  PRODUCTION REDIS NOT READY AFTER 10s                     ║");
        console.error("╟───────────────────────────────────────────────────────────────╢");
        console.error("║  Server will start but return 503 for party endpoints        ║");
        console.error("║                                                               ║");
        console.error("║  LIKELY CAUSES:                                               ║");
        console.error("║  1. REDIS_URL not set or incorrect                           ║");
        console.error("║  2. Redis service not running on Railway                     ║");
        console.error("║  3. Network/firewall blocking connection                     ║");
        console.error("║  4. TLS configuration mismatch (rediss:// required?)         ║");
        console.error("║  5. Authentication failed (wrong password)                   ║");
        console.error("║                                                               ║");
        console.error("║  DIAGNOSTICS:                                                 ║");
        console.error(`║  • Check /api/debug/redis for details                         ║`);
        console.error(`║  • Check /api/health for readiness status                     ║`);
        console.error(`║  • Error type: ${redisConnectionError ? getRedisErrorType(redisConnectionError).padEnd(30) : 'none'.padEnd(30)}           ║`);
        console.error("║                                                               ║");
        console.error("║  RAILWAY STEPS:                                               ║");
        console.error("║  1. Verify Redis plugin is active                            ║");
        console.error("║  2. Restart Redis service                                    ║");
        console.error("║  3. Restart this service                                     ║");
        console.error("╚═══════════════════════════════════════════════════════════════╝");
        console.error("");
      } else {
        console.warn("   Server will continue in fallback mode - parties will be stored locally");
      }
    }
  } else {
    console.warn("⚠️  Redis not configured - using fallback mode");
    
    if (IS_PRODUCTION && !ALLOW_FALLBACK_IN_PRODUCTION) {
      console.error("");
      console.error("╔═══════════════════════════════════════════════════════════════╗");
      console.error("║  ❌ REDIS NOT CONFIGURED IN PRODUCTION                        ║");
      console.error("╟───────────────────────────────────────────────────────────────╢");
      console.error("║  Server will start but return 503 for party endpoints        ║");
      console.error("║                                                               ║");
      console.error("║  Set REDIS_URL environment variable and restart              ║");
      console.error("║  Check /api/debug/redis for diagnostics                      ║");
      console.error("╚═══════════════════════════════════════════════════════════════╝");
      console.error("");
    }
  }
  
  // Initialize storage provider
  console.log("⏳ Initializing storage provider...");
  try {
    await initializeStorage();
    console.log("✅ Storage provider ready");
  } catch (err) {
    console.error(`❌ Storage initialization failed: ${err.message}`);
    console.warn("   Continuing without storage – file upload features will be unavailable");
  }
  
  server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
    console.log(`   Instance ID: ${INSTANCE_ID}`);
    console.log(`   Redis status: ${redis ? redis.status : 'NOT CONFIGURED'}`);
    console.log(`   Redis ready: ${redisReady ? 'YES' : 'NO'}`);
    console.log("🎉 Server ready to accept connections");
    
    // Initialize security modules
    initRateLimiter();
    console.log('🔒 Rate limiter initialized');
    
    // Log registered routes for debugging
    console.log("\n📋 Registered HTTP Routes:");
    const routes = getRegisteredRoutes();
    
    // Print all routes with formatting
    routes.forEach(route => {
      console.log(`   ${route.methods} ${route.path}`);
    });
    
    // Explicitly confirm critical routes
    const criticalRoutes = [
      { method: 'POST', path: '/api/create-party' },
      { method: 'POST', path: '/api/join-party' }
    ];
    
    console.log("\n✓ Critical Routes Verified:");
    criticalRoutes.forEach(({ method, path }) => {
      const isRegistered = routes.some(r => {
        const methodList = r.methods.split(', ');
        return methodList.includes(method) && r.path === path;
      });
      console.log(`   ${isRegistered ? '✓' : '✗'} ${method} ${path}`);
    });
    console.log("");
  });
  
  // Start cleanup interval
  cleanupInterval = setInterval(runCleanupJobs, CLEANUP_INTERVAL_MS);
  console.log(`[Server] Party cleanup job started (runs every ${CLEANUP_INTERVAL_MS / 1000}s, TTL: ${PARTY_TTL_MS / 1000}s, instance: ${INSTANCE_ID})`);
  console.log(`[Server] Track cleanup job started (runs every ${CLEANUP_INTERVAL_MS / 1000}s, TTL: ${TRACK_TTL_MS / 1000}s, instance: ${INSTANCE_ID})`);
  
  // Start Event Replay Manager for reliable message delivery
  eventReplayManager.start();
  console.log(`[Server] Event Replay System started (retry interval: ${eventReplayManager.config.retryIntervalMs}ms, max attempts: ${eventReplayManager.config.maxRetryAttempts})`);
  
  // WebSocket server setup
  wss = new WebSocket.Server({ server });

  wss.on("connection", (ws) => {
    const clientId = nextWsClientId++;
    clients.set(ws, { id: clientId, party: null });
    
    if (process.env.DEBUG === 'true') {
      console.log(`[WS] Client ${clientId} connected`);
    }
    
    // Set up heartbeat for this connection
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    
    // Send welcome message
    safeSend(ws, JSON.stringify({ t: "WELCOME", clientId }));
    
    ws.on("message", async (data) => {
      try {
        // SECTION 5A: Enforce message size limit (32KB)
        const MAX_WS_MESSAGE_SIZE = 32 * 1024; // 32KB
        if (data.length > MAX_WS_MESSAGE_SIZE) {
          console.warn(`[WS] Client ${clientId} sent oversized message: ${data.length} bytes (max: ${MAX_WS_MESSAGE_SIZE})`);
          safeSend(ws, JSON.stringify({
            t: 'ERROR',
            errorType: 'MESSAGE_TOO_LARGE',
            message: 'Message exceeds size limit'
          }));
          return;
        }

        const msg = JSON.parse(data.toString());
        
        // SECTION 5C: Improved logging - log metadata only, not raw payload
        const client = clients.get(ws);
        if (!client) return;
        const maskedPartyCode = client.party ? maskPartyCode(client.party) : 'none';
        if (process.env.DEBUG === 'true') {
          console.log(`[WS] Client ${clientId} sent type: ${msg.t}, partyCode: ${maskedPartyCode}, size: ${data.length}b`);
        }
        
        await handleMessage(ws, msg);
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.error(`[WS] Client ${clientId} sent invalid JSON`);
        } else {
          console.error(`[WS] Error processing message from client ${clientId}:`, err.message);
        }
      }
    });
    
    ws.on("close", () => {
      console.log(`[WS] Client ${clientId} disconnected`);
      handleDisconnect(ws);
      
      // Clean up rate limit data for this client
      clearClientRateLimit(clientId);
      
      clients.delete(ws);
    });
    
    ws.on("error", (err) => {
      console.error(`[WS] Client ${clientId} error:`, err);
    });
  });
  
  // WebSocket heartbeat interval - ping clients every 30 seconds
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        const client = clients.get(ws);
        if (client) {
          console.log(`[WS] Terminating dead connection for client ${client.id}`);
        }
        return ws.terminate();
      }
      
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000); // Ping every 30 seconds
  
  // Cleanup heartbeat interval on server close
  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  // When the HTTP server closes, shut down the WS server, the party cleanup
  // interval, Redis pub/sub connections, and the event replay system so that
  // Jest workers (and graceful process shutdowns) can exit without hanging.
  server.on("close", () => {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
    wss.close();
    eventReplayManager.stop();
    if (redisSub) { redisSub.disconnect(); redisSub = null; }
    if (redisPub) { redisPub.disconnect(); redisPub = null; }
  });
  
  // Wait for the server to be fully listening before returning
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }
  
  return server;
}

// Helper function to safely send WebSocket messages
// Guards against sending to closed/closing sockets which can cause crashes
function safeSend(ws, data) {
  if (!ws) {
    console.warn('[WS] safeSend: WebSocket is null or undefined');
    return false;
  }
  
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn(`[WS] safeSend: WebSocket not in OPEN state (readyState: ${ws.readyState})`);
    return false;
  }
  
  try {
    ws.send(data);
    return true;
  } catch (err) {
    console.error('[WS] safeSend: Error sending message:', err);
    return false;
  }
}

async function handleMessage(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  
  // 1. Validate payload structure
  const validation = validatePayload(msg);
  if (!validation.valid) {
    logValidationFailure(msg, validation.error, client.id);
    safeSend(ws, JSON.stringify({
      t: 'ERROR',
      errorType: 'INVALID_PAYLOAD',
      message: validation.error
    }));
    return;
  }
  
  // Use sanitized message
  const sanitizedMsg = validation.sanitized;
  
  // 2. Check rate limits
  const rateCheck = checkRateLimit(client.id, sanitizedMsg.t);
  if (!rateCheck.allowed) {
    safeSend(ws, JSON.stringify({
      t: 'ERROR',
      errorType: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please slow down.',
      retryAfterMs: rateCheck.retryAfterMs,
      limit: rateCheck.limit
    }));
    return;
  }
  
  // 3. Route message to appropriate handler
  switch (sanitizedMsg.t) {
    case "CREATE":
      handleCreate(ws, sanitizedMsg);
      break;
    case "JOIN":
      handleJoin(ws, sanitizedMsg);
      break;
    case "KICK":
      handleKick(ws, sanitizedMsg);
      break;
    case "SET_PRO":
      handleSetPro(ws, sanitizedMsg);
      break;
    case "APPLY_PROMO":
      handleApplyPromo(ws, sanitizedMsg);
      break;
    case "HOST_PLAY":
      handleHostPlay(ws, sanitizedMsg);
      break;
    case "HOST_PAUSE":
      handleHostPause(ws, sanitizedMsg);
      break;
    case "HOST_STOP":
      handleHostStop(ws, sanitizedMsg);
      break;
    case "HOST_TRACK_SELECTED":
      handleHostTrackSelected(ws, sanitizedMsg);
      break;
    case "HOST_NEXT_TRACK_QUEUED":
      handleHostNextTrackQueued(ws, sanitizedMsg);
      break;
    case "HOST_TRACK_CHANGED":
      handleHostTrackChanged(ws, sanitizedMsg);
      break;
    case "GUEST_MESSAGE":
      handleGuestMessage(ws, sanitizedMsg);
      break;
    case "GUEST_PLAY_REQUEST":
      handleGuestPlayRequest(ws, sanitizedMsg);
      break;
    case "GUEST_PAUSE_REQUEST":
      handleGuestPauseRequest(ws, sanitizedMsg);
      break;
    case "GUEST_QUICK_REPLY":
      handleGuestQuickReply(ws, sanitizedMsg);
      break;
    case "DJ_QUICK_BUTTON":
      handleDjQuickButton(ws, sanitizedMsg);
      break;
    case "CHAT_MODE_SET":
      handleChatModeSet(ws, sanitizedMsg);
      break;
    case "HOST_BROADCAST_MESSAGE":
      await handleHostBroadcastMessage(ws, sanitizedMsg);
      break;
    case "DJ_EMOJI":
      await handleDjEmoji(ws, sanitizedMsg);
      break;
    case "DJ_SHORT_MESSAGE":
      await handleDjShortMessage(ws, sanitizedMsg);
      break;
    case "TIME_PING":
      handleTimePing(ws, sanitizedMsg);
      break;
    case "CLOCK_PING":
      handleClockPing(ws, sanitizedMsg);
      break;
    case "PLAYBACK_FEEDBACK":
      handlePlaybackFeedback(ws, sanitizedMsg);
      break;
    case "REQUEST_SYNC_STATE":
      handleRequestSyncState(ws, sanitizedMsg);
      break;
    case "SYNC_ISSUE":
      handleSyncIssue(ws, sanitizedMsg);
      break;
    case "GET_SYNC_STATS":
      handleGetSyncStats(ws, sanitizedMsg);
      break;
    case "CLIENT_READY":
      handleClientReady(ws, sanitizedMsg);
      break;
    case "CLIENT_NOT_READY":
      handleClientNotReady(ws, sanitizedMsg);
      break;
    case "RESUME":
      handleResume(ws, sanitizedMsg);
      break;
    case "MESSAGE_ACK":
      handleMessageAck(ws, sanitizedMsg);
      break;
    case "OFFICIAL_APP_SYNC_SELECT":
      handleOfficialAppSyncSelect(ws, sanitizedMsg);
      break;
    default: {
      // Cap the echoed type to prevent log/response bloat
      const safeType = String(sanitizedMsg.t).substring(0, 50);
      console.log(`[WS] Unknown message type: ${safeType}`);
      safeSend(ws, JSON.stringify({
        t: 'ERROR',
        errorType: 'INVALID_PAYLOAD',
        message: `Unknown message type: ${safeType}`
      }));
    }
  }
}

// Handle TIME_PING for server clock synchronization (legacy)
function handleTimePing(ws, msg) {
  const serverNowMs = Date.now();
  const response = {
    t: "TIME_PONG",
    clientNowMs: msg.clientNowMs,
    serverNowMs: serverNowMs,
    pingId: msg.pingId
  };
  safeSend(ws, JSON.stringify(response));

  // OFFICIAL APP SYNC: check for drift and send SYNC_CORRECTION if needed
  const client = clients.get(ws);
  if (
    client && client.party &&
    msg.localPositionSeconds !== undefined &&
    msg.trackRef !== undefined
  ) {
    const party = parties.get(client.party);
    if (party && party.officialAppSync && party.officialAppSync.playing) {
      const sync = party.officialAppSync;
      if (sync.trackRef === msg.trackRef && sync.playStartedAtMs) {
        const targetPositionSeconds = (serverNowMs - sync.playStartedAtMs) / 1000;
        const drift = Math.abs((msg.localPositionSeconds || 0) - targetPositionSeconds);
        const DRIFT_THRESHOLD_SECONDS = 0.5;
        if (drift > DRIFT_THRESHOLD_SECONDS) {
          safeSend(ws, JSON.stringify({
            t: 'SYNC_CORRECTION',
            serverTimestampMs: serverNowMs,
            targetPositionSeconds
          }));
        }
      }
    }
  }
}

// Handle CLOCK_PING for advanced clock synchronization
function handleClockPing(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) {
    return;
  }

  const code = client.party;
  const syncEngine = partySyncEngines.get(code);
  
  if (!syncEngine) {
    // Fallback to simple response if sync engine not available
    const serverNowMs = Date.now();
    const response = {
      t: 'CLOCK_PONG',
      clientSentTime: msg.clientNowMs,
      serverNowMs: serverNowMs,
      clientId: client.id
    };
    safeSend(ws, JSON.stringify(response));
    return;
  }

  // Use sync engine for advanced clock sync
  const response = syncEngine.handleClockPing(client.id, msg.clientNowMs);
  if (response) {
    safeSend(ws, JSON.stringify(response));
  }
}

// Handle PLAYBACK_FEEDBACK for drift detection and correction
function handlePlaybackFeedback(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) {
    return;
  }

  const code = client.party;
  const syncEngine = partySyncEngines.get(code);
  
  if (!syncEngine) {
    return; // No sync engine, ignore feedback
  }

  // Process playback feedback and get drift correction if needed
  const correction = syncEngine.handlePlaybackFeedback(
    client.id,
    msg.position,
    msg.trackStart
  );

  // Send drift correction back to client if needed
  if (correction) {
    safeSend(ws, JSON.stringify(correction));
  }
}

// PHASE 3: Handle CLIENT_READY message
function handleClientReady(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  const { trackId, readyState, bufferedSec, canPlayThrough } = msg;
  if (!trackId) return;
  
  const key = `${client.party}:${trackId}`;
  
  // Initialize readiness entry if needed
  if (!readinessMap.has(key)) {
    readinessMap.set(key, {
      readySockets: new Set(),
      readyPayloads: new Map()
    });
  }
  
  const readiness = readinessMap.get(key);
  readiness.readySockets.add(ws);
  readiness.readyPayloads.set(ws, {
    bufferedSec: bufferedSec || 0,
    readyState: readyState || 0,
    canPlayThrough: canPlayThrough || false,
    timestamp: Date.now()
  });
  
  console.log(`[Ready] Client ready for ${trackId} in party ${client.party.substring(0, 3)}***, buffered: ${(bufferedSec || 0).toFixed(1)}s, readyState: ${readyState}`);
}

// PHASE 3: Handle CLIENT_NOT_READY message
function handleClientNotReady(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  const { trackId, reason } = msg;
  if (!trackId) return;
  
  console.log(`[Ready] Client NOT ready for ${trackId} in party ${client.party.substring(0, 3)}***, reason: ${reason}`);
}

// PHASE 5: Handle RESUME - Replay missed events after reconnect
function handleResume(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) {
    safeSend(ws, JSON.stringify({ 
      t: "ERROR", 
      message: "Not in a party" 
    }));
    return;
  }
  
  const { lastEventId } = msg;
  const partyCode = client.party;
  
  console.log(`[Resume] Client ${client.id} resuming, lastEventId: ${lastEventId || 'none'}`);
  
  // Get missed events
  const missedEvents = getEventsSince(partyCode, lastEventId || 0);
  
  if (missedEvents.length === 0) {
    // No missed events - send current state snapshot
    const party = parties.get(partyCode);
    if (!party) return;
    
    const history = partyEventHistory.get(partyCode);
    const currentEventId = history ? history.nextEventId - 1 : 0;
    
    const snapshot = {
      t: "STATE_SNAPSHOT",
      eventId: currentEventId,
      partyState: {
        currentTrack: party.currentTrack || null,
        queue: party.queue || []
      }
    };
    
    safeSend(ws, JSON.stringify(snapshot));
    console.log(`[Resume] Sent STATE_SNAPSHOT to ${client.id}, eventId: ${currentEventId}`);
  } else if (missedEvents.length > MAX_EVENT_HISTORY) {
    // Too many missed events - send snapshot
    const party = parties.get(partyCode);
    if (!party) return;
    
    const history = partyEventHistory.get(partyCode);
    const currentEventId = history ? history.nextEventId - 1 : 0;
    
    const snapshot = {
      t: "STATE_SNAPSHOT",
      eventId: currentEventId,
      partyState: {
        currentTrack: party.currentTrack || null,
        queue: party.queue || []
      }
    };
    
    safeSend(ws, JSON.stringify(snapshot));
    console.log(`[Resume] Too many missed events (${missedEvents.length}), sent STATE_SNAPSHOT to ${client.id}`);
  } else {
    // Replay missed events
    console.log(`[Resume] Replaying ${missedEvents.length} missed events to ${client.id}`);
    missedEvents.forEach(event => {
      safeSend(ws, JSON.stringify(event));
    });
  }
}

// Handle REQUEST_SYNC_STATE for late joiners
function handleRequestSyncState(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) {
    safeSend(ws, JSON.stringify({ 
      t: "ERROR", 
      message: "Not in a party" 
    }));
    return;
  }
  
  const party = parties.get(client.party);
  if (!party) {
    safeSend(ws, JSON.stringify({ 
      t: "ERROR", 
      message: ErrorMessages.partyNotFound() 
    }));
    return;
  }
  
  // Build sync state response
  const response = {
    t: "SYNC_STATE",
    serverNowMs: Date.now()
  };
  
  if (party.currentTrack) {
    const track = party.currentTrack;
    response.track = {
      trackId: track.trackId,
      trackUrl: track.trackUrl,
      title: track.title,
      filename: track.filename,
      durationMs: track.durationMs
    };
    
    response.status = track.status || 'stopped'; // 'playing', 'paused', 'stopped', 'preparing'
    
    if (track.status === 'playing' || track.status === 'preparing') {
      response.startAtServerMs = track.startAtServerMs;
      response.startPositionSec = track.startPositionSec || 0;
    } else if (track.status === 'paused') {
      response.pausedPositionSec = track.pausedPositionSec || 0;
      response.pausedAtServerMs = track.pausedAtServerMs;
    }
  } else {
    response.status = 'stopped';
  }
  
  // Include queue if available
  if (party.queue && party.queue.length > 0) {
    response.queue = party.queue;
  }
  
  console.log(`[SYNC_STATE] Sending state to client ${client.id}, status: ${response.status}`);
  safeSend(ws, JSON.stringify(response));
}

// Handle SYNC_ISSUE from guests reporting sync problems
function handleSyncIssue(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) {
    console.log(`[SYNC_ISSUE] Client not in party`);
    return;
  }
  
  const party = parties.get(client.party);
  if (!party) {
    console.log(`[SYNC_ISSUE] Party not found: ${client.party}`);
    return;
  }
  
  // Get member info
  const member = party.members.find(m => m.ws === ws);
  if (!member) {
    console.log(`[SYNC_ISSUE] Member not found in party`);
    return;
  }
  
  // Don't allow host to report sync issues (they're the source)
  if (member.isHost) {
    console.log(`[SYNC_ISSUE] Host cannot report sync issues`);
    return;
  }
  
  const guestName = member.name || "Guest";
  const guestId = member.id;
  const drift = msg.drift || "unknown";
  
  console.log(`[SYNC_ISSUE] Guest "${guestName}" (${guestId}) reported sync issue, drift: ${drift}ms`);
  
  // Send notification to host if they're connected
  if (party.host && party.host.readyState === WebSocket.OPEN) {
    const notification = {
      t: "SYNC_ISSUE_REPORT",
      guestName: guestName,
      guestId: guestId,
      drift: drift,
      timestamp: Date.now()
    };
    
    safeSend(party.host, JSON.stringify(notification));
    console.log(`[SYNC_ISSUE] Notification sent to host about ${guestName}'s sync issue`);
  } else {
    console.log(`[SYNC_ISSUE] Host not connected, cannot send notification`);
  }
  
  // Send acknowledgment back to guest
  safeSend(ws, JSON.stringify({
    t: "SYNC_ISSUE_ACK",
    message: "Sync issue reported to DJ"
  }));
}

// Handle GET_SYNC_STATS from dashboard
function handleGetSyncStats(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) {
    return;
  }

  const code = client.party;
  const syncEngine = partySyncEngines.get(code);
  
  if (!syncEngine) {
    return; // No sync engine, no stats
  }

  // Get stats from sync engine
  const stats = syncEngine.getSyncStats();
  
  // Send stats to requesting client
  safeSend(ws, JSON.stringify({
    t: 'SYNC_STATS',
    stats: stats
  }));
}

// Handle MESSAGE_ACK for event replay acknowledgment
function handleMessageAck(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  
  const messageId = msg.messageId;
  if (!messageId) {
    console.warn('[EventReplay] MESSAGE_ACK received without messageId');
    return;
  }
  
  eventReplayManager.handleAcknowledgment(client.id, messageId);
}

// Helper function to add and broadcast DJ auto-generated messages
function addDjMessage(code, message, type = "system") {
  const party = parties.get(code);
  if (!party) return;
  
  const ts = Date.now();
  const eventId = `${ts}-system-${nanoid(6)}`;
  
  const djMessage = {
    id: eventId,
    message,
    type, // "system", "prompt", "warning"
    timestamp: ts
  };
  
  // Initialize djMessages array if not exists
  if (!party.djMessages) {
    party.djMessages = [];
  }
  
  party.djMessages.push(djMessage);
  
  // Keep only last 20 messages
  if (party.djMessages.length > 20) {
    party.djMessages = party.djMessages.slice(-20);
  }
  
  console.log(`[DJ Message] ${code}: ${message}`);
  
  // Broadcast using new FEED_EVENT format (unified feed)
  const feedEvent = {
    id: eventId,
    ts: ts,
    kind: "system",
    senderId: "system",
    senderName: "System",
    text: message,
    isEmoji: false,
    ttlMs: MESSAGE_TTL_MS
  };
  
  const feedEventMsg = JSON.stringify({ t: "FEED_EVENT", event: feedEvent });
  party.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(feedEventMsg);
    }
  });
  
  // Also broadcast legacy DJ_MESSAGE for backward compatibility
  const legacyMsg = JSON.stringify({ 
    t: "DJ_MESSAGE", 
    message,
    type,
    timestamp: ts
  });
  
  party.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(legacyMsg);
    }
  });
}

async function handleCreate(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  
  // Runtime guard: Check if Redis is available
  if (!redis || !redisReady) {
    console.error(`[WS] Party creation blocked - Redis not ready, instanceId: ${INSTANCE_ID}`);
    safeSend(ws, JSON.stringify({ 
      t: "ERROR", 
      message: "Server not ready. Please retry in a moment." 
    }));
    return;
  }
  
  // Remove from current party if already in one
  if (client.party) {
    handleDisconnect(ws);
  }
  
  // Validate and sanitize name
  const name = (msg.djName || msg.name || "Host").trim().substring(0, 50);
  
  // Capture and validate source from host
  const source = msg.source === "external" || msg.source === "mic" ? msg.source : "local";
  
  try {
    // Use shared party creation function
    const { code, partyData } = await createPartyCommon({
      djName: name,
      source: source,
      hostId: client.id,
      hostConnected: true
    });
    
    console.log(`[WS] Party created: ${code}, clientId: ${client.id}, instanceId: ${INSTANCE_ID}, createdAt: ${partyData.createdAt}, storageBackend: redis, totalParties: ${parties.size + 1}`);
    
    const member = {
      ws,
      id: client.id,
      name,
      isPro: !!msg.isPro,
      isHost: true
    };
    
    // Store in local memory for WebSocket connections AFTER Redis confirms
    parties.set(code, {
      host: ws,
      members: [member],
      chatMode: partyData.chatMode,
      createdAt: partyData.createdAt,
      hostId: partyData.hostId,
      source: partyData.source, // IMPORTANT: Store source in local memory
      partyPro: partyData.partyPro,
      promoUsed: partyData.promoUsed,
      djMessages: [],
      currentTrack: null,
      queue: [],
      timeoutWarningTimer: null,
      scoreState: {
        dj: {
          djUserId: null,
          djIdentifier: client.id,
          djName: name,
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
    
    client.party = code;
    
    // Register client with event replay manager
    eventReplayManager.registerClient(client.id, ws, code);
    
    safeSend(ws, JSON.stringify({ t: "CREATED", code }));
    broadcastRoomState(code);
    
    // Send welcome DJ message to host
    addDjMessage(code, "🎧 Party started! Share your code with friends.", "system");
    
    // Schedule party timeout warning (30 minutes before expiry = 90 minutes after creation)
    const warningDelay = PARTY_TTL_MS - (30 * 60 * 1000); // 90 minutes
    const party = parties.get(code);
    if (party) {
      party.timeoutWarningTimer = setTimeout(() => {
        addDjMessage(code, "⏰ Party ending in 30 minutes!", "warning");
      }, warningDelay);
    }
  } catch (err) {
    console.error(`[WS] Error creating party, instanceId: ${INSTANCE_ID}:`, err.message);
    safeSend(ws, JSON.stringify({ 
      t: "ERROR", 
      message: "Failed to create party. Please try again." 
    }));
    return;
  }
}

async function handleJoin(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  
  const code = msg.code?.toUpperCase().trim();
  const timestamp = new Date().toISOString();
  
  console.log(`[WS] Attempting to join party: ${code}, clientId: ${client.id}, timestamp: ${timestamp}`);
  
  try {
    // First check Redis for party existence
    const partyData = await getPartyFromRedis(code);
    const storeReadResult = partyData ? "found" : "not_found";
    
    if (!partyData) {
      const totalParties = parties.size;
      const localPartyExists = parties.has(code);
      const rejectionReason = `Party ${code} not found. Checked Redis (${storeReadResult}) and local memory (${localPartyExists}). Total local parties: ${totalParties}`;
      console.log(`[WS] Join failed - party ${code} not found, timestamp: ${timestamp}, instanceId: ${INSTANCE_ID}, partyCode: ${code}, exists: false, rejectionReason: ${rejectionReason}, storeReadResult: ${storeReadResult}, localParties: ${totalParties}, storageBackend: redis`);
      safeSend(ws, JSON.stringify({ t: "ERROR", message: "Party not found" }));
      return;
    }
    
    // Normalize party data to ensure all fields exist
    const normalizedPartyData = normalizePartyData(partyData);
    
    // Then check local memory
    let party = parties.get(code);
    
    // If party exists in Redis but not locally, create local entry
    if (!party) {
      parties.set(code, {
        host: null,
        members: [],
        chatMode: normalizedPartyData.chatMode,
        createdAt: normalizedPartyData.createdAt,
        hostId: normalizedPartyData.hostId,
        source: normalizedPartyData.source, // IMPORTANT: Load source from Redis
        partyPro: normalizedPartyData.partyPro, // IMPORTANT: Load partyPro from Redis
        promoUsed: normalizedPartyData.promoUsed,
        tier: normalizedPartyData.tier, // IMPORTANT: Load tier from Redis
        partyPassExpiresAt: normalizedPartyData.partyPassExpiresAt, // IMPORTANT: Load expiry from Redis
        maxPhones: normalizedPartyData.maxPhones, // IMPORTANT: Load max phones from Redis
        djMessages: [],
        currentTrack: null,
        queue: [],
        timeoutWarningTimer: null,
        scoreState: {
          dj: {
            djUserId: null,
            djIdentifier: normalizedPartyData.hostId,
            djName: normalizedPartyData.djName,
            sessionScore: 0,
            lifetimeScore: 0
          },
          guests: {},
          totalReactions: 0,
          totalMessages: 0,
          currentCrowdEnergy: 0, // Current crowd energy (0-100, guest reactions only)
          peakCrowdEnergy: 0 // Peak crowd energy (guest reactions only)
        },
        reactionHistory: []
      });
      party = parties.get(code);
    }
    
    // Remove from current party if already in one
    if (client.party) {
      handleDisconnect(ws);
    }
    
    // Check if already a member (prevent duplicates)
    if (party.members.some(m => m.id === client.id)) {
      safeSend(ws, JSON.stringify({ t: "ERROR", message: "Already in this party" }));
      return;
    }
    
    // Enforce party capacity limits based on partyPro/partyPass
    const maxAllowed = await getMaxAllowedPhones(code, normalizedPartyData);
    const currentMemberCount = party.members.length;
    
    if (currentMemberCount >= maxAllowed) {
      console.log(`[WS] Join blocked - Party limit reached, partyCode: ${code}, clientId: ${client.id}, current: ${currentMemberCount}, max: ${maxAllowed}`);
      safeSend(ws, JSON.stringify({ 
        t: "ERROR", 
        message: maxAllowed === 2 ? "Free parties are limited to 2 phones" : `Party limit reached (${maxAllowed} devices)`
      }));
      return;
    }
    
    // Validate and sanitize name
    const name = (msg.name || "Guest").trim().substring(0, 50);
    
    // Check if this is the host joining their own party
    // Host is identified by msg.isHost flag (sent by client after HTTP party creation)
    // OR if this is the very first member joining a party with no host set yet
    const isHostJoining = msg.isHost === true;
    
    const member = {
      ws,
      id: client.id,
      name,
      isPro: !!msg.isPro,
      isHost: isHostJoining
    };
    
    // If this is the host, set party.host
    if (isHostJoining) {
      party.host = ws;
      console.log(`[WS] Host joined party ${code}, clientId: ${client.id}`);
    }
    
    party.members.push(member);
    client.party = code;
    
    // Register client with event replay manager
    eventReplayManager.registerClient(client.id, ws, code);
    
    // Register client with sync engine
    const syncEngine = partySyncEngines.get(code);
    if (syncEngine) {
      syncEngine.addClient(ws, client.id);
      console.log(`[Sync] Added client ${client.id} to sync engine for party ${code}`);
    }
    
    const guestCount = party.members.filter(m => !m.isHost).length;
    const totalParties = parties.size;
    
    // Update Redis with new guest count and hostConnected (fetch fresh to avoid race conditions)
    getPartyFromRedis(code).then(freshPartyData => {
      if (freshPartyData) {
        freshPartyData.guestCount = guestCount;
        freshPartyData.hostConnected = party.members.some(m => m.isHost);
        setPartyInRedis(code, freshPartyData).catch(err => {
          console.error(`[WS] Error updating guest count in Redis for ${code}:`, err.message);
        });
      }
    }).catch(err => {
      console.error(`[WS] Error fetching party for guest count update:`, err.message);
    });
    
    console.log(`[WS] Client ${client.id} joined party ${code}, instanceId: ${INSTANCE_ID}, partyCode: ${code}, exists: true, storeReadResult: ${storeReadResult}, guestCount: ${guestCount}, totalParties: ${totalParties}, storageBackend: redis`);
    
    // Send different message type based on role to prevent host routing to guest screen
    if (isHostJoining) {
      safeSend(ws, JSON.stringify({ t: "HOST_JOINED", code, role: "host", tier: normalizedPartyData.tier }));
    } else {
      safeSend(ws, JSON.stringify({ t: "JOINED", code, role: "guest" }));
    }
    
    // Send reaction history to newly joined client
    if (party.reactionHistory && party.reactionHistory.length > 0) {
      safeSend(ws, JSON.stringify({ 
        t: "REACTION_HISTORY", 
        items: party.reactionHistory 
      }));
    }
    
    // Send playback state to newly joined client (Phase 7)
    if (party.currentTrack || (party.queue && party.queue.length > 0)) {
      safeSend(ws, JSON.stringify({ 
        t: "PLAYBACK_STATE",
        currentTrack: party.currentTrack,
        queue: party.queue || [],
        serverTime: Date.now()
      }));
    }
    
    broadcastRoomState(code);
    
    // Send welcome DJ message for first guest
    if (guestCount === 1) {
      addDjMessage(code, `👋 ${name} joined the party!`, "system");
      // Encourage interaction after a few seconds
      setTimeout(() => {
        addDjMessage(code, "💬 Drop an emoji or message!", "prompt");
      }, 5000);
    } else {
      addDjMessage(code, `👋 ${name} joined! ${guestCount} guests in the party.`, "system");
    }
  } catch (err) {
    console.error(`[WS] Error in handleJoin for ${code}:`, err.message);
    safeSend(ws, JSON.stringify({ 
      t: "ERROR", 
      message: "Server error. Please try again." 
    }));
  }
}

// Helper function to ensure guest exists in scoreboard
function ensureGuestInScoreboard(party, guestId, nickname) {
  if (!party.scoreState.guests[guestId]) {
    party.scoreState.guests[guestId] = {
      guestId,
      nickname: nickname || "Guest",
      points: 0,
      emojis: 0,
      messages: 0,
      rank: 1
    };
  }
  return party.scoreState.guests[guestId];
}

function handleKick(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  const party = parties.get(client.party);
  if (!party) return;
  
  // Only host can kick
  if (party.host !== ws) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Only host can kick members" }));
    return;
  }
  
  // Validate targetId
  if (!msg.targetId || typeof msg.targetId !== 'number') {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Invalid target ID" }));
    return;
  }
  
  const targetMember = party.members.find(m => m.id === msg.targetId);
  
  if (!targetMember) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Member not found" }));
    return;
  }
  
  if (targetMember.isHost) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Cannot kick host" }));
    return;
  }
  
  // Check WebSocket state before sending
  if (targetMember.ws.readyState === WebSocket.OPEN) {
    targetMember.ws.send(JSON.stringify({ t: "KICKED" }));
  }
  
  party.members = party.members.filter(m => m.id !== msg.targetId);
  
  const targetClient = clients.get(targetMember.ws);
  if (targetClient) targetClient.party = null;
  
  console.log(`[Party] Client ${msg.targetId} kicked from party ${client.party}`);
  
  broadcastRoomState(client.party);
}

function handleSetPro(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  const party = parties.get(client.party);
  if (!party) return;
  
  const member = party.members.find(m => m.ws === ws);
  if (member) {
    member.isPro = !!msg.isPro;
    console.log(`[Party] Client ${client.id} set Pro to ${member.isPro}`);
    // Note: SET_PRO only affects member's badge, NOT party-wide Pro status
    broadcastRoomState(client.party);
  }
}

function handleApplyPromo(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) {
    safeSend(ws, JSON.stringify({ 
      t: "ERROR", 
      message: "Not in a party" 
    }));
    return;
  }
  
  const party = parties.get(client.party);
  if (!party) {
    safeSend(ws, JSON.stringify({ 
      t: "ERROR", 
      message: "Party not found" 
    }));
    return;
  }
  
  // Check if promo code already used
  if (party.promoUsed) {
    console.log(`[Promo] Attempt to reuse promo in party ${client.party}, clientId: ${client.id}`);
    safeSend(ws, JSON.stringify({ 
      t: "ERROR", 
      message: "This party already used a promo code." 
    }));
    return;
  }
  
  // Validate promo code (case-insensitive, trim spaces)
  const code = (msg.code || "").trim().toUpperCase();
  if (!PROMO_CODES.includes(code)) {
    console.log(`[Promo] Invalid promo code attempt: ${code}, partyCode: ${client.party}, clientId: ${client.id}`);
    safeSend(ws, JSON.stringify({ 
      t: "ERROR", 
      message: "Invalid or expired promo code." 
    }));
    return;
  }
  
  // Valid and unused - unlock party-wide Pro
  party.promoUsed = true;
  party.partyPro = true;
  console.log(`[Promo] Party ${client.party} unlocked with promo code ${code}, clientId: ${client.id}`);
  
  // CRITICAL: Persist to Redis so promo state survives refresh and works cross-instance
  // Use async IIFE to properly handle promises
  (async () => {
    try {
      const partyData = await getPartyFromRedis(client.party);
      if (partyData) {
        const normalizedData = normalizePartyData(partyData);
        normalizedData.promoUsed = true;
        normalizedData.partyPro = true;
        await setPartyInRedis(client.party, normalizedData);
        console.log(`[Promo] Successfully persisted promo state to Redis for ${client.party}`);
      } else {
        console.warn(`[Promo] Party ${client.party} not found in Redis during promo persist`);
      }
    } catch (err) {
      console.error(`[Promo] Error persisting promo to Redis for ${client.party}:`, err.message);
    }
  })();
  
  // Broadcast updated room state to all members
  broadcastRoomState(client.party);
}

function handleDisconnect(ws) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  // Capture partyCode before the member forEach loop nulls client.party
  const partyCode = client.party;
  
  // Unregister from event replay manager
  eventReplayManager.unregisterClient(client.id);
  
  const party = parties.get(partyCode);
  if (!party) return;
  
  const member = party.members.find(m => m.ws === ws);
  
  if (member?.isHost) {
    // Host left, end the party
    console.log(`[Party] Host left, ending party ${partyCode}, instanceId: ${INSTANCE_ID}`);
    
    // Persist scoreboard to database
    persistPartyScoreboard(partyCode, party).catch(err => {
      console.error(`[Database] Error persisting scoreboard for party ${partyCode}:`, err.message);
    });
    
    // Clear timeout warning timer
    if (party.timeoutWarningTimer) {
      clearTimeout(party.timeoutWarningTimer);
      party.timeoutWarningTimer = null;
    }
    
    party.members.forEach(m => {
      if (m.ws !== ws && m.ws.readyState === WebSocket.OPEN) {
        m.ws.send(JSON.stringify({ t: "ENDED" }));
      }
      const c = clients.get(m.ws);
      if (c) c.party = null;
    });
    
    // Clean up rate limit data
    cleanupRateLimitData(partyCode);
    
    // Clean up sync engine
    const syncEngine = partySyncEngines.get(partyCode);
    if (syncEngine) {
      partySyncEngines.delete(partyCode);
      console.log(`[Sync] Cleaned up sync engine for party ${partyCode}`);
    }

    // Clean up sync tick interval and event history
    stopSyncTick(partyCode);
    partyEventHistory.delete(partyCode);

    parties.delete(partyCode);
    
    // Delete from Redis
    deletePartyFromRedis(partyCode).catch(err => {
      console.error(`[Redis] Error deleting party ${partyCode}:`, err.message);
    });
  } else {
    // Regular member left
    party.members = party.members.filter(m => m.ws !== ws);
    console.log(`[Party] Client ${client.id} left party ${partyCode}, instanceId: ${INSTANCE_ID}`);
    
    // Remove from sync engine
    const syncEngine = partySyncEngines.get(partyCode);
    if (syncEngine) {
      syncEngine.removeClient(client.id);
      console.log(`[Sync] Removed client ${client.id} from sync engine`);
    }
    
    // Update guest count in Redis
    const guestCount = party.members.filter(m => !m.isHost).length;
    getPartyFromRedis(partyCode).then(partyData => {
      if (partyData) {
        partyData.guestCount = guestCount;
        setPartyInRedis(partyCode, partyData).catch(err => {
          console.error(`[Redis] Error updating guest count after disconnect:`, err.message);
        });
      }
    }).catch(err => {
      console.error(`[Redis] Error reading party for disconnect update:`, err.message);
    });
    
    broadcastRoomState(partyCode);
  }
  
  client.party = null;
}

async function broadcastRoomState(code) {
  const party = parties.get(code);
  if (!party) return;
  
  // Get party data from Redis for partyPass info
  let partyData = null;
  try {
    partyData = await getPartyFromRedis(code);
  } catch (err) {
    console.warn(`[broadcastRoomState] Could not fetch party data from Redis:`, err.message);
  }
  
  const snapshot = {
    members: party.members.map(m => ({
      id: m.id,
      name: m.name,
      isPro: m.isPro,
      isHost: m.isHost
    })),
    chatMode: party.chatMode || "OPEN",
    partyPro: !!party.partyPro, // Party-wide Pro status
    source: party.source || "local", // Host-selected source
    // Tier from backend entitlement validation
    tier: partyData?.tier || party?.tier || null,
    // Party Pass info (source of truth)
    partyPassActive: partyData ? isPartyPassActive(partyData) : false,
    partyPassExpiresAt: partyData ? (partyData.partyPassExpiresAt || null) : null,
    maxPhones: partyData ? getPartyMaxPhones(partyData) : 2
  };
  
  const message = JSON.stringify({ t: "ROOM", snapshot });
  
  // Broadcast to local members
  party.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(message);
    }
  });
  
  // Publish to other instances (Phase 8)
  publishToOtherInstances(code, "ROOM", { t: "ROOM", snapshot });
}

function broadcastScoreboard(code) {
  const party = parties.get(code);
  if (!party || !party.scoreState) return;
  
  // LEADERBOARD: Calculate rankings for GUESTS ONLY (exclude DJ)
  // DJ contributions never appear on the leaderboard
  const guestList = Object.values(party.scoreState.guests)
    .sort((a, b) => b.points - a.points)
    .map((guest, index) => ({
      ...guest,
      rank: index + 1
    }));
  
  // Update ranks in scoreState
  guestList.forEach(guest => {
    if (party.scoreState.guests[guest.guestId]) {
      party.scoreState.guests[guest.guestId].rank = guest.rank;
    }
  });
  
  const scoreboardData = {
    dj: {
      djName: party.scoreState.dj.djName,
      sessionScore: party.scoreState.dj.sessionScore,
      lifetimeScore: party.scoreState.dj.lifetimeScore
    },
    guests: guestList.slice(0, 10), // Top 10 guests (DJ excluded)
    totalReactions: party.scoreState.totalReactions,
    totalMessages: party.scoreState.totalMessages,
    currentCrowdEnergy: party.scoreState.currentCrowdEnergy || 0, // Current crowd energy (guest reactions only)
    peakCrowdEnergy: party.scoreState.peakCrowdEnergy // Peak crowd energy (guest reactions only)
  };
  
  const message = JSON.stringify({ 
    t: "SCOREBOARD_UPDATE", 
    scoreboard: scoreboardData
  });
  
  // Broadcast to local party members
  party.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(message);
    }
  });
  
  // Publish to other instances (Phase 8)
  publishToOtherInstances(code, "SCOREBOARD", { t: "SCOREBOARD_UPDATE", scoreboard: scoreboardData });
}

// Helper function to broadcast feed items (unified messaging system for Party Pass)
function broadcastFeedItem(code, item) {
  const party = parties.get(code);
  if (!party) return;
  
  // Ensure item has all required fields
  const feedItem = {
    id: item.id || `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
    ts: item.ts || Date.now(),
    kind: item.kind, // "guest_text" | "guest_emoji" | "guest_quick" | "host_quick" | "system_auto"
    name: item.name,
    senderId: item.senderId,
    text: item.text,
    ttlMs: item.ttlMs || MESSAGE_TTL_MS
  };
  
  const message = JSON.stringify({ t: "FEED_ITEM", item: feedItem });
  
  // Broadcast to local party members
  party.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(message);
    }
  });
  
  // Publish to other instances
  publishToOtherInstances(code, "FEED_ITEM", { t: "FEED_ITEM", item: feedItem });
}

function handleHostPlay(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  // SECURITY: Validate host authority using strict server-side check
  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'play');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('play', authCheck.error)));
    return;
  }
  
  const party = authCheck.party;
  
  // SECTION 1B: Server guard - reject play when trackUrl missing and party has guests
  const trackUrl = msg.trackUrl || party.currentTrack?.trackUrl || null;
  const memberCount = party.members ? party.members.length : 0;
  
  if (memberCount > 1 && !trackUrl) {
    // Multi-member party requires trackUrl for synced playback
    const maskedPartyCode = maskPartyCode(client.party);
    console.warn(`[Party] Host play rejected - no trackUrl, partyCode: ${maskedPartyCode}, clientId: ${client.id}, memberCount: ${memberCount}, event: host_play_rejected, reason: missing_track_url`);
    
    safeSend(ws, JSON.stringify({
      t: 'ERROR',
      errorType: 'INVALID_ACTION',
      message: 'Cannot start synced playback without a track URL. Please wait for upload to complete.'
    }));
    return;
  }
  
  console.log(`[Party] Host playing in party ${client.party}`);
  
  // Store track info in party state if provided
  const trackId = msg.trackId || party.currentTrack?.trackId || null;
  const filename = msg.filename || party.currentTrack?.filename || "Unknown Track";
  const title = msg.title || filename;
  const durationMs = msg.durationMs || party.currentTrack?.durationMs || null;
  
  // Check if resuming from pause - use pausedPositionSec if available
  let startPosition = msg.positionSec || 0;
  if (party.currentTrack && party.currentTrack.status === 'paused' && party.currentTrack.pausedPositionSec !== undefined) {
    startPosition = party.currentTrack.pausedPositionSec;
    console.log(`[Party] Resuming from pause at position ${startPosition.toFixed(2)}s`);
  }
  
  // Compute lead time for scheduled start (configurable 800-1500ms, default 1200ms)
  const leadTimeMs = 1200;
  const nowMs = Date.now();
  const startAtServerMs = nowMs + leadTimeMs;
  
  // Set party state to "preparing"
  party.currentTrack = {
    trackId,
    trackUrl,
    title,
    filename,
    durationMs,
    status: 'preparing',
    startAtServerMs: startAtServerMs,
    startPositionSec: startPosition
  };
  
  console.log(`[Party] Track scheduled: ${filename}, trackId: ${trackId}, position: ${startPosition}s, start in ${leadTimeMs}ms`);
  
  // Persist playback state to Redis (best-effort, async)
  persistPlaybackToRedis(client.party, party.currentTrack, party.queue || []);
  
  // Broadcast PREPARE_PLAY to ALL members with acknowledgment tracking (CRITICAL)
  broadcastToPartyWithAck(
    client.party,
    { 
      t: "PREPARE_PLAY",
      trackId,
      trackUrl,
      title,
      filename,
      durationMs,
      startAtServerMs: startAtServerMs,
      startPositionSec: startPosition
    },
    MessagePriority.CRITICAL
  );
  
  // Log PREPARE_PLAY broadcast (observability)
  console.log(`[Sync] PREPARE_PLAY broadcast: partyCode=${client.party}, trackId=${trackId}`);
  
  // PHASE 3: Wait for ready threshold before broadcasting PLAY_AT
  const readyKey = `${client.party}:${trackId}`;
  const readyTimeoutMs = 8000; // Max wait time
  const checkIntervalMs = 100; // Check readiness every 100ms
  let elapsed = 0;
  
  const checkReadiness = () => {
    elapsed += checkIntervalMs;
    
        // Re-check party still exists
    const updatedParty = parties.get(client.party);
    if (!updatedParty || !updatedParty.currentTrack) return;
    
    // Abort if the track has changed since this play command was issued
    if (updatedParty.currentTrack.trackId !== trackId) return;
    
    const memberCount = updatedParty.members ? updatedParty.members.length : 0;
    const readiness = readinessMap.get(readyKey);
    const readyCount = readiness ? readiness.readySockets.size : 0;
    const threshold = Math.max(1, Math.ceil(0.8 * memberCount));
    
    // Calculate buffered clients (bufferedSec >= READY_MIN_BUFFERED_SEC OR readyState >= READY_MIN_READYSTATE)
    let bufferedCount = 0;
    let totalBufferedSec = 0;
    if (readiness) {
      for (const [ws, payload] of readiness.readyPayloads) {
        if (payload.bufferedSec >= READY_MIN_BUFFERED_SEC || payload.readyState >= READY_MIN_READYSTATE) {
          bufferedCount++;
        }
        totalBufferedSec += payload.bufferedSec;
      }
    }
    const avgBufferedSec = readyCount > 0 ? totalBufferedSec / readyCount : 0;
    const bufferedThreshold = Math.ceil(0.7 * readyCount);
    
    const thresholdMet = readyCount >= threshold && bufferedCount >= bufferedThreshold;
    const timedOut = elapsed >= readyTimeoutMs;
    
    if (thresholdMet || timedOut) {
      // Clear readiness data for this track
      if (readiness) {
        readinessMap.delete(readyKey);
      }
      
      // Log readiness stats (no secrets)
      const maskedPartyCode = maskPartyCode(client.party);
      console.log(`[Ready] Starting playback: party=${maskedPartyCode}, trackId=${trackId}, ready=${readyCount}/${memberCount}, buffered=${bufferedCount}/${readyCount}, avgBuf=${avgBufferedSec.toFixed(1)}s, timeout=${timedOut}`);
      
      // Update status to playing
      updatedParty.currentTrack.status = 'playing';
      
      // Compute actual start time with 2s lead
      const actualStartMs = Date.now() + 2000;
      updatedParty.currentTrack.startAtServerMs = actualStartMs;
      
      console.log(`[Party] Track playing: ${filename} at server time ${actualStartMs}`);
      
      // Persist updated status
      persistPlaybackToRedis(client.party, updatedParty.currentTrack, updatedParty.queue || []);
      
      // Broadcast PLAY_AT to all members with acknowledgment tracking (CRITICAL)
      broadcastToPartyWithAck(
        client.party,
        { 
          t: "PLAY_AT",
          trackId,
          trackUrl,
          title,
          filename,
          durationMs,
          startAtServerMs: actualStartMs,
          startPositionSec: startPosition
        },
        MessagePriority.CRITICAL
      );
      
      // Log PLAY_AT broadcast (observability)
      console.log(`[Sync] PLAY_AT broadcast: partyCode=${client.party}, trackId=${trackId}, readyCount=${readyCount}/${memberCount}, startAtServerMs=${actualStartMs}`);
      
      // PHASE 4: Start SYNC_TICK broadcasting for drift correction
      startSyncTick(client.party);
    } else {
      // Keep waiting
      setTimeout(checkReadiness, checkIntervalMs);
    }
  };
  
  // Start checking after initial prepare time
  setTimeout(checkReadiness, leadTimeMs);
}

function handleHostPause(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  // SECURITY: Validate host authority using strict server-side check
  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'pause');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('pause', authCheck.error)));
    return;
  }
  
  const party = authCheck.party;
  
  console.log(`[Party] Host paused in party ${client.party}`);
  
  // Compute paused position based on current playback state
  const pausedAtServerMs = Date.now();
  let pausedPositionSec = msg.positionSec || 0;
  
  // If we have currentTrack with playback state, compute current position
  if (party.currentTrack && party.currentTrack.startAtServerMs && party.currentTrack.status === 'playing') {
    const elapsedSec = (pausedAtServerMs - party.currentTrack.startAtServerMs) / 1000;
    pausedPositionSec = (party.currentTrack.startPositionSec || 0) + elapsedSec;
  }
  
  // Update party state
  if (party.currentTrack) {
    party.currentTrack.status = 'paused';
    party.currentTrack.pausedPositionSec = pausedPositionSec;
    party.currentTrack.pausedAtServerMs = pausedAtServerMs;
  }
  
  // PHASE 4: Stop SYNC_TICK broadcasting
  stopSyncTick(client.party);
  
  // Persist playback state to Redis (best-effort, async)
  persistPlaybackToRedis(client.party, party.currentTrack, party.queue || []);
  
  // Broadcast PAUSE to all members with acknowledgment tracking (CRITICAL)
  // Exclude host as they initiated the pause
  const hostClientId = clients.get(ws)?.id;
  const excludeSet = hostClientId ? new Set([hostClientId]) : new Set();
  
  broadcastToPartyWithAck(
    client.party,
    { 
      t: "PAUSE",
      status: "paused",
      pausedAtServerMs,
      pausedPositionSec
    },
    MessagePriority.CRITICAL,
    excludeSet
  );
}

function handleHostStop(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  // SECURITY: Validate host authority using strict server-side check
  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'stop');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('stop', authCheck.error)));
    return;
  }
  
  const party = authCheck.party;
  
  console.log(`[Party] Host stopped playback in party ${client.party}`);
  
  // Reset current track position and set status to stopped
  if (party.currentTrack) {
    party.currentTrack.startPositionSec = 0;
    party.currentTrack.status = 'stopped';
    party.currentTrack.startAtServerMs = Date.now();
  }
  
  // PHASE 4: Stop SYNC_TICK broadcasting
  stopSyncTick(client.party);
  
  // Persist playback state to Redis (best-effort, async)
  persistPlaybackToRedis(client.party, party.currentTrack, party.queue || []);
  
  // Broadcast STOP to all members with acknowledgment tracking (CRITICAL)
  // Exclude host as they initiated the stop
  const hostClientId = clients.get(ws)?.id;
  const excludeSet = hostClientId ? new Set([hostClientId]) : new Set();
  
  broadcastToPartyWithAck(
    client.party,
    { 
      t: "STOP",
      status: "stopped"
    },
    MessagePriority.CRITICAL,
    excludeSet
  );
}

function handleHostTrackSelected(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  // SECURITY: Validate host authority using strict server-side check
  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'select track');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('select track', authCheck.error)));
    return;
  }

  const party = authCheck.party;
  
  const trackId = msg.trackId || null;
  const trackUrl = msg.trackUrl || null;
  const filename = msg.filename || "Unknown Track";
  
  console.log(`[Party] Host selected track "${filename}" (trackId: ${trackId}) in party ${client.party}`);
  
  // Store in party state
  party.currentTrack = {
    trackId,
    trackUrl,
    filename
  };
  
  // Broadcast to all guests (not host)
  const message = JSON.stringify({ 
    t: "TRACK_SELECTED", 
    trackId,
    trackUrl,
    filename 
  });
  party.members.forEach(m => {
    if (!m.isHost && m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(message);
    }
  });
}

/**
 * Check whether a party's tier grants access to Official App Sync mode.
 * Checks tier string and also falls back to checking partyPassExpiresAt.
 * @param {Object} partyData - party object
 * @returns {boolean}
 */
function isPaidForOfficialAppSyncParty(partyData) {
  if (!partyData) return false;
  const tier = partyData.tier;
  if (tierPolicyIsPaidForOfficialAppSync(tier)) return true;
  // Fallback: legacy partyPassExpiresAt without explicit tier field
  return isPartyPassActive(partyData);
}

/**
 * Handle OFFICIAL_APP_SYNC_SELECT from host:
 *   { t: "OFFICIAL_APP_SYNC_SELECT", platform, trackRef, positionSeconds?, playing? }
 *
 * Validates tier, normalizes trackRef, stores state, broadcasts TRACK_SELECTED.
 */
function handleOfficialAppSyncSelect(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;

  // SECURITY: Only the host can select a track
  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'official app sync select');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('official app sync select', authCheck.error)));
    return;
  }

  const party = authCheck.party;

  // TIER CHECK: Official App Sync is ONLY for paid tiers
  if (!isPaidForOfficialAppSyncParty(party)) {
    safeSend(ws, JSON.stringify({
      t: 'ERROR',
      errorType: 'TIER_NOT_PAID',
      message: 'Official App Sync is only available for Party Pass and Pro Monthly subscribers.'
    }));
    return;
  }

  const platform = (msg.platform || '').toLowerCase();
  const trackRef = msg.trackRef || '';
  const positionSeconds = typeof msg.positionSeconds === 'number' ? msg.positionSeconds : 0;
  const playing = msg.playing !== false; // default true

  if (!platform || !trackRef) {
    safeSend(ws, JSON.stringify({
      t: 'ERROR',
      errorType: 'INVALID_PAYLOAD',
      message: 'platform and trackRef are required for OFFICIAL_APP_SYNC_SELECT'
    }));
    return;
  }

  // Normalize trackRef per platform
  let normalizedRef;
  try {
    normalizedRef = normalizePlatformTrackRef(platform, trackRef);
  } catch (err) {
    safeSend(ws, JSON.stringify({
      t: 'ERROR',
      errorType: 'INVALID_TRACK_REF',
      message: err.message
    }));
    return;
  }

  const serverTimestampMs = Date.now();

  // Store Official App Sync state on the party
  party.officialAppSync = {
    platform,
    trackRef: normalizedRef,
    playStartedAtMs: playing ? serverTimestampMs - positionSeconds * 1000 : null,
    seekOffsetSeconds: positionSeconds,
    playing,
    serverTimestampMs
  };

  // Broadcast TRACK_SELECTED to ALL party members (including host)
  const broadcast = JSON.stringify({
    t: 'TRACK_SELECTED',
    mode: 'OFFICIAL_APP_SYNC',
    platform,
    trackRef: normalizedRef,
    serverTimestampMs,
    positionSeconds,
    playing
  });

  party.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(broadcast);
    }
  });

  console.log(`[OfficialAppSync] changerVersion=${CHANGER_VERSION} platform=${platform} trackRef=${normalizedRef} party=${client.party}`);
}

function handleHostNextTrackQueued(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;

  // SECURITY: Validate host authority using strict server-side check
  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'queue track');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('queue track', authCheck.error)));
    return;
  }

  const party = authCheck.party;
  
  const filename = msg.filename || null;
  console.log(`[Party] Host queued next track "${filename}" in party ${client.party}`);
  
  // Broadcast to all guests (not host)
  const message = JSON.stringify({ t: "NEXT_TRACK_QUEUED", filename });
  party.members.forEach(m => {
    if (!m.isHost && m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(message);
    }
  });
}

function handleHostTrackChanged(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  // SECURITY: Validate host authority using strict server-side check
  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'change track');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('change track', authCheck.error)));
    return;
  }

  const party = authCheck.party;
  
  const trackId = msg.trackId || null;
  const trackUrl = msg.trackUrl || null;
  const filename = msg.filename || "Unknown Track";
  const nextFilename = msg.nextFilename || null;
  const serverTimestamp = Date.now();
  const positionSec = msg.positionSec || 0;
  
  console.log(`[Party] Host changed to track "${filename}" (trackId: ${trackId}, next: "${nextFilename}") in party ${client.party}`);
  
  // Update party state
  party.currentTrack = {
    trackId,
    trackUrl,
    filename,
    startAtServerMs: serverTimestamp,
    startPositionSec: positionSec,
    status: 'playing' // TRACK_CHANGED event always indicates playing state
  };
  
  // Persist playback state to Redis (best-effort, async)
  persistPlaybackToRedis(client.party, party.currentTrack, party.queue || []);
  
  // Restart SYNC_TICK so drift corrections fire for the new playing track
  stopSyncTick(client.party);
  startSyncTick(client.party);
  
  // Broadcast to all guests (not host)
  const message = JSON.stringify({ 
    t: "TRACK_CHANGED", 
    trackId,
    trackUrl,
    filename, 
    nextFilename,
    serverTimestamp,
    positionSec
  });
  party.members.forEach(m => {
    if (!m.isHost && m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(message);
    }
  });
}

/**
 * Handle guest messages and emoji reactions (Party Pass feature)
 * 
 * ROLE-BASED ENFORCEMENT:
 * - Only guests can send GUEST_MESSAGE (not host/DJ)
 * - Guest emoji reactions DO affect crowd energy (+5 per emoji, +8 per text)
 * - Messages are broadcast to all clients with kind: "guest_message"
 * - Guest receives points (+5 for emoji, +10 for text)
 * - DJ receives engagement points (+2 for emoji, +3 for text)
 * - Updates leaderboard and scoreboard
 * 
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} msg - Message object with message and isEmoji fields
 */
async function handleGuestMessage(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  const party = parties.get(client.party);
  if (!party) return;
  
  // Only guests can send messages (not host)
  const member = party.members.find(m => m.ws === ws);
  if (!member || member.isHost) {
    console.warn(`[Role Enforcement] Host attempted to send guest message in party ${client.party}`);
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Only guests can send messages" }));
    return;
  }
  
  // Get party data to check Party Pass status
  let partyData = null;
  try {
    partyData = await getPartyFromRedis(client.party);
  } catch (err) {
    console.error(`[handleGuestMessage] Error getting party data:`, err.message);
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Server error" }));
    return;
  }
  
  // CHECK PARTY PASS GATING (source of truth)
  if (!partyData || !isPartyPassActive(partyData)) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Party Pass required to chat" }));
    return;
  }
  
  // Check chat mode restrictions
  const chatMode = party.chatMode || "OPEN";
  const isEmoji = msg.isEmoji || false;
  
  // LOCKED mode: no messages allowed
  if (chatMode === "LOCKED") {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Chat is locked by the DJ" }));
    return;
  }
  
  // EMOJI_ONLY mode: only emoji messages allowed
  if (chatMode === "EMOJI_ONLY" && !isEmoji) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Only emoji reactions allowed" }));
    return;
  }
  
  // Validate and sanitize message based on type
  let messageText = (msg.message || "").trim();
  
  if (isEmoji) {
    // Emoji: max 10 characters, sanitize
    messageText = sanitizeText(messageText).substring(0, 10);
  } else {
    // Text: max 60 characters, collapse whitespace, sanitize
    messageText = sanitizeText(messageText.replace(/\s+/g, ' ')).substring(0, 60);
  }
  
  // Reject empty messages
  if (!messageText) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Message cannot be empty" }));
    return;
  }
  
  // CHECK RATE LIMITS
  const rateLimitCheck = checkMessageRateLimit(client.party, member.id, false);
  if (!rateLimitCheck.allowed) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: rateLimitCheck.reason }));
    return;
  }
  
  const guestName = member.name || "Guest";
  
  console.log(`[Party] Guest "${guestName}" sent message "${messageText}" in party ${client.party}`);
  
  // LEADERBOARD: Update scoreboard - award points for messages/emojis (GUEST ONLY)
  const guestScore = ensureGuestInScoreboard(party, member.id, guestName);
  
  if (isEmoji) {
    guestScore.emojis += 1;
    guestScore.points += 5; // 5 points per emoji
    party.scoreState.totalReactions += 1;
  } else {
    guestScore.messages += 1;
    guestScore.points += 10; // 10 points per text message
    party.scoreState.totalMessages += 1;
  }
  
  // Award points to DJ for engagement
  party.scoreState.dj.sessionScore += (isEmoji ? 2 : 3);
  
  // CROWD ENERGY: Track crowd energy from GUEST reactions only
  // This is the key requirement - crowd energy bar only updates from guests
  // DJ emoji reactions do NOT update crowd energy (enforced in handleDjEmoji)
  const energyIncrease = isEmoji ? 5 : 8;
  const currentEnergy = (party.scoreState.currentCrowdEnergy || 0) + energyIncrease;
  const cappedEnergy = Math.min(100, currentEnergy);
  party.scoreState.currentCrowdEnergy = cappedEnergy;
  
  console.log(`[Role Enforcement] Guest reaction increased crowd energy by ${energyIncrease} (now ${cappedEnergy})`);
  
  // Update peak crowd energy if current exceeds peak
  if (cappedEnergy > (party.scoreState.peakCrowdEnergy || 0)) {
    party.scoreState.peakCrowdEnergy = cappedEnergy;
  }
  
  // Add to reaction history (for refresh/late join support)
  if (!party.reactionHistory) {
    party.reactionHistory = [];
  }
  const ts = Date.now();
  const eventId = `${ts}-${member.id}-${nanoid(6)}`;
  party.reactionHistory.push({
    id: eventId,
    type: isEmoji ? "emoji" : "text",
    message: messageText,
    guestName: guestName,
    guestId: member.id,
    ts: ts
  });
  // Keep only last 30 items
  if (party.reactionHistory.length > 30) {
    party.reactionHistory = party.reactionHistory.slice(-30);
  }
  
  // Persist reaction history to Redis (best-effort, async)
  persistReactionHistoryToRedis(client.party, party.reactionHistory);
  
  // Broadcast updated scoreboard to all party members
  broadcastScoreboard(client.party);
  
  // Broadcast using new FEED_EVENT format (unified feed)
  const feedEvent = {
    id: eventId,
    ts: ts,
    kind: "guest_message",
    senderId: member.id,
    senderName: guestName,
    text: messageText,
    isEmoji: isEmoji,
    ttlMs: MESSAGE_TTL_MS
  };
  
  const feedEventMsg = JSON.stringify({ t: "FEED_EVENT", event: feedEvent });
  party.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(feedEventMsg);
    }
  });
  
  // Also broadcast legacy GUEST_MESSAGE for backward compatibility
  const legacyMessage = JSON.stringify({ 
    t: "GUEST_MESSAGE", 
    message: messageText,
    guestName: guestName,
    guestId: member.id,
    isEmoji: isEmoji
  });
  
  party.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(legacyMessage);
    }
  });
  
  // Also use FEED_ITEM for compatibility with existing messaging feed
  broadcastFeedItem(client.party, {
    kind: isEmoji ? "guest_emoji" : "guest_text",
    name: guestName,
    senderId: member.id,
    text: messageText,
    ttlMs: MESSAGE_TTL_MS
  });
}

async function handleDjQuickButton(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  const party = parties.get(client.party);
  if (!party) return;
  
  // Only host can send quick buttons
  if (party.host !== ws) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Only host can use quick buttons" }));
    return;
  }
  
  // Get party data to check Party Pass status
  let partyData = null;
  try {
    partyData = await getPartyFromRedis(client.party);
  } catch (err) {
    console.error(`[handleDjQuickButton] Error getting party data:`, err.message);
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Server error" }));
    return;
  }
  
  // CHECK PARTY PASS GATING (source of truth)
  if (!partyData || !isPartyPassActive(partyData)) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Party Pass required for quick buttons" }));
    return;
  }
  
  // Validate button key
  const key = msg.key;
  if (!key || !HOST_QUICK_MESSAGES[key]) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Invalid quick button key" }));
    return;
  }
  
  // CHECK RATE LIMITS (use "dj" as userId for host)
  const rateLimitCheck = checkMessageRateLimit(client.party, "dj", true);
  if (!rateLimitCheck.allowed) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: rateLimitCheck.reason }));
    return;
  }
  
  const text = HOST_QUICK_MESSAGES[key];
  
  console.log(`[Party] DJ sent quick button "${key}": "${text}" in party ${client.party}`);
  
  // Broadcast using FEED_ITEM format
  broadcastFeedItem(client.party, {
    kind: "host_quick",
    name: "DJ",
    senderId: "dj",
    text: text,
    ttlMs: MESSAGE_TTL_MS
  });
}

async function handleGuestQuickReply(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  const party = parties.get(client.party);
  if (!party) return;
  
  // Only guests can send quick replies (not host)
  const member = party.members.find(m => m.ws === ws);
  if (!member || member.isHost) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Only guests can use quick replies" }));
    return;
  }
  
  // Get party data to check Party Pass status
  let partyData = null;
  try {
    partyData = await getPartyFromRedis(client.party);
  } catch (err) {
    console.error(`[handleGuestQuickReply] Error getting party data:`, err.message);
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Server error" }));
    return;
  }
  
  // CHECK PARTY PASS GATING (source of truth)
  if (!partyData || !isPartyPassActive(partyData)) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Party Pass required for quick replies" }));
    return;
  }
  
  // Validate reply key
  const key = msg.key;
  if (!key || !GUEST_QUICK_REPLIES[key]) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Invalid quick reply key" }));
    return;
  }
  
  // CHECK RATE LIMITS
  const rateLimitCheck = checkMessageRateLimit(client.party, member.id, false);
  if (!rateLimitCheck.allowed) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: rateLimitCheck.reason }));
    return;
  }
  
  const guestName = member.name || "Guest";
  const text = GUEST_QUICK_REPLIES[key];
  
  console.log(`[Party] Guest "${guestName}" sent quick reply "${key}": "${text}" in party ${client.party}`);
  
  // Update scoreboard: award points for quick reply (treat like emoji)
  const guestScore = ensureGuestInScoreboard(party, member.id, guestName);
  guestScore.emojis += 1;
  guestScore.points += 5;
  party.scoreState.totalReactions += 1;
  party.scoreState.dj.sessionScore += 2;
  
  // Broadcast updated scoreboard
  broadcastScoreboard(client.party);
  
  // Broadcast using FEED_ITEM format
  broadcastFeedItem(client.party, {
    kind: "guest_quick",
    name: guestName,
    senderId: member.id,
    text: text,
    ttlMs: MESSAGE_TTL_MS
  });
}

function handleGuestPlayRequest(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  const party = parties.get(client.party);
  if (!party) return;
  
  // Only guests can send playback requests (not host)
  const member = party.members.find(m => m.ws === ws);
  if (!member || member.isHost) {
    return; // Silently ignore if host sends this
  }
  
  const guestName = member.name || "Guest";
  console.log(`[Party] Guest "${guestName}" requested to play music in party ${client.party}`);
  
  // Send notification to host
  const message = JSON.stringify({ 
    t: "GUEST_PLAY_REQUEST", 
    guestName: guestName,
    guestId: member.id
  });
  
  if (party.host && party.host.readyState === WebSocket.OPEN) {
    party.host.send(message);
  }
}

function handleGuestPauseRequest(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  const party = parties.get(client.party);
  if (!party) return;
  
  // Only guests can send playback requests (not host)
  const member = party.members.find(m => m.ws === ws);
  if (!member || member.isHost) {
    return; // Silently ignore if host sends this
  }
  
  const guestName = member.name || "Guest";
  console.log(`[Party] Guest "${guestName}" requested to pause music in party ${client.party}`);
  
  // Send notification to host
  const message = JSON.stringify({ 
    t: "GUEST_PAUSE_REQUEST", 
    guestName: guestName,
    guestId: member.id
  });
  
  if (party.host && party.host.readyState === WebSocket.OPEN) {
    party.host.send(message);
  }
}

function handleChatModeSet(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  // SECURITY: Validate host authority using strict server-side check
  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'set chat mode');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('set chat mode', authCheck.error)));
    return;
  }

  const party = authCheck.party;
  
  const mode = msg.mode;
  if (!["OPEN", "EMOJI_ONLY", "LOCKED"].includes(mode)) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Invalid chat mode" }));
    return;
  }
  
  party.chatMode = mode;
  console.log(`[Party] Chat mode set to ${mode} in party ${client.party}`);
  
  // Persist chat mode to Redis
  getPartyFromRedis(client.party).then(partyData => {
    if (partyData) {
      partyData.chatMode = mode;
      setPartyInRedis(client.party, partyData).catch(err => {
        console.error(`[ChatMode] Error persisting chat mode to Redis for ${client.party}:`, err.message);
      });
    }
  }).catch(err => {
    console.error(`[ChatMode] Error fetching party for chat mode update:`, err.message);
  });
  
  // Broadcast to all members
  const message = JSON.stringify({ t: "CHAT_MODE_SET", mode });
  party.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(message);
    }
  });
}

async function handleHostBroadcastMessage(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  const party = parties.get(client.party);
  if (!party) return;
  
  // Only host can broadcast messages
  if (party.host !== ws) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Only host can broadcast messages" }));
    return;
  }
  
  // Get party data to check Party Pass status
  let partyData;
  try {
    partyData = await getPartyFromRedis(client.party);
  } catch (err) {
    console.error(`[handleHostBroadcastMessage] Error getting party data:`, err.message);
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Server error" }));
    return;
  }
  
  // CHECK PARTY PASS GATING (source of truth)
  if (!partyData || !isPartyPassActive(partyData)) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Party Pass required to send broadcast messages" }));
    return;
  }
  
  const messageText = (msg.message || "").trim().substring(0, 100);
  
  console.log(`[Party] Host broadcasting message "${messageText}" in party ${client.party}`);
  
  // Generate stable event ID
  const ts = Date.now();
  const eventId = `${ts}-host-${nanoid(6)}`;
  
  // Broadcast using new FEED_EVENT format (unified feed)
  const feedEvent = {
    id: eventId,
    ts: ts,
    kind: "host_broadcast",
    senderId: "host",
    senderName: "DJ",
    text: messageText,
    isEmoji: false,
    ttlMs: MESSAGE_TTL_MS
  };
  
  const feedEventMsg = JSON.stringify({ t: "FEED_EVENT", event: feedEvent });
  party.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(feedEventMsg);
    }
  });
  
  // Also broadcast legacy HOST_BROADCAST_MESSAGE for backward compatibility
  const legacyMsg = JSON.stringify({ 
    t: "HOST_BROADCAST_MESSAGE", 
    message: messageText
  });
  
  party.members.forEach(m => {
    // Send to all members including host for echo
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(legacyMsg);
    }
  });
}

/**
 * Handle DJ emoji reactions (Party Pass feature)
 * 
 * ROLE-BASED ENFORCEMENT:
 * - Only host/DJ can send DJ emojis (role check enforced)
 * - DJ emojis are broadcast to all clients with kind: "dj_emoji"
 * - DJ emojis appear in live reaction box but do NOT affect crowd energy
 * - DJ emojis do NOT generate DJ score (only guests can influence DJ score)
 * - Crowd energy and DJ score are ONLY updated by guest reactions
 * 
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} msg - Message object with emoji field
 */
async function handleDjEmoji(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  const party = parties.get(client.party);
  if (!party) return;
  
  // ROLE CHECK: Only host/DJ can send DJ emojis
  if (party.host !== ws) {
    console.warn(`[Role Enforcement] Non-host attempted to send DJ emoji in party ${client.party}`);
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Only DJ can send emojis" }));
    return;
  }
  
  // Get party data to check Party Pass status
  let partyData;
  try {
    partyData = await getPartyFromRedis(client.party);
  } catch (err) {
    console.error(`[handleDjEmoji] Error getting party data:`, err.message);
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Server error" }));
    return;
  }
  
  // CHECK PARTY PASS GATING (source of truth)
  if (!partyData || !isPartyPassActive(partyData)) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Emoji reactions require an active Party Pass" }));
    return;
  }
  
  const emoji = (msg.emoji || "").trim().substring(0, 10);
  
  console.log(`[Party] DJ sending emoji "${emoji}" in party ${client.party}`);
  
  // DJ emojis do NOT generate score - only guests can influence DJ score
  // Do NOT increment totalReactions - only guest reactions count
  
  // IMPORTANT: DJ emojis do NOT update crowd energy
  // Crowd energy is ONLY from guest reactions
  // Do NOT update party.scoreState.currentCrowdEnergy or peakCrowdEnergy here
  console.log(`[Role Enforcement] DJ emoji - NO crowd energy update (guest-only feature)`);
  
  // Add to reaction history (for refresh/late join support)
  if (!party.reactionHistory) {
    party.reactionHistory = [];
  }
  const ts = Date.now();
  const eventId = `${ts}-dj-${nanoid(6)}`;
  party.reactionHistory.push({
    id: eventId,
    type: "dj",
    message: emoji,
    guestName: "DJ",
    guestId: "dj",
    ts: ts
  });
  // Keep only last 30 items
  if (party.reactionHistory.length > 30) {
    party.reactionHistory = party.reactionHistory.slice(-30);
  }
  
  // Persist reaction history to Redis (best-effort, async)
  persistReactionHistoryToRedis(client.party, party.reactionHistory);
  
  // Broadcast updated scoreboard (DJ excluded from guest leaderboard)
  broadcastScoreboard(client.party);
  
  // Broadcast using new FEED_EVENT format (unified feed - LIVE REACTION BOX)
  // DJ reactions appear in live reaction box for both DJ and guests
  // Tagged with kind: "dj_emoji" for role-based filtering on client side
  const feedEvent = {
    id: eventId,
    ts: ts,
    kind: "dj_emoji",  // Role tag for client-side filtering
    senderId: "dj",     // Role-based sender ID
    senderName: "DJ",
    text: emoji,
    isEmoji: true,
    ttlMs: MESSAGE_TTL_MS
  };
  
  const feedEventMsg = JSON.stringify({ t: "FEED_EVENT", event: feedEvent });
  party.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(feedEventMsg);
    }
  });
  
  // Also broadcast legacy GUEST_MESSAGE for backward compatibility
  const legacyMsg = JSON.stringify({ 
    t: "GUEST_MESSAGE",
    message: emoji,
    guestName: "DJ",
    guestId: "dj",     // Role indicator in legacy format
    isEmoji: true
  });
  
  party.members.forEach(m => {
    // Send to all members including host
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(legacyMsg);
    }
  });
}

/**
 * Handle DJ short message (Party Pass / Pro Monthly feature)
 * DJ can send short text messages (max 30 chars) to all guests via the unified feed
 */
async function handleDjShortMessage(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;
  
  const party = parties.get(client.party);
  if (!party) return;
  
  // Only host can send DJ short messages
  if (party.host !== ws) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Only DJ can send short messages" }));
    return;
  }
  
  // Get party data to check Party Pass status
  let partyData;
  try {
    partyData = await getPartyFromRedis(client.party);
  } catch (err) {
    console.error(`[handleDjShortMessage] Error getting party data:`, err.message);
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "Server error" }));
    return;
  }
  
  // CHECK PRO_MONTHLY TIER GATING (source of truth)
  // DJ typed messages require PRO_MONTHLY tier only (not PARTY_PASS)
  if (!partyData || (partyData.tier !== 'PRO_MONTHLY' && partyData.tier !== 'PRO')) {
    safeSend(ws, JSON.stringify({ t: "ERROR", message: "DJ typed messages require Pro Monthly tier" }));
    return;
  }
  
  // Validate and sanitize the message
  const messageText = (msg.text || "").trim().substring(0, 30);
  
  if (!messageText) {
    console.log(`[Party] Empty DJ short message - ignoring`);
    return;
  }
  
  console.log(`[Party] DJ sending short message "${messageText}" in party ${client.party}`);
  
  // Generate stable event ID
  const ts = Date.now();
  const eventId = `${ts}-dj-msg-${nanoid(6)}`;
  
  // Broadcast using FEED_EVENT format (unified feed)
  const feedEvent = {
    id: eventId,
    ts: ts,
    kind: "dj_short_message",
    senderId: "dj",
    senderName: "DJ",
    text: messageText,
    isEmoji: false,
    ttlMs: MESSAGE_TTL_MS
  };
  
  const feedEventMsg = JSON.stringify({ t: "FEED_EVENT", event: feedEvent });
  party.members.forEach(m => {
    if (m.ws.readyState === WebSocket.OPEN) {
      m.ws.send(feedEventMsg);
    }
  });
}

// Helper function to wait for Redis to be ready (for tests)
function waitForRedis(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (redisReady) {
      resolve();
      return;
    }
    
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for Redis'));
    }, timeoutMs);
    
    if (redis) {
      redis.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
    } else {
      clearTimeout(timeout);
      reject(new Error('Redis not configured'));
    }
  });
}

// Helper to get Redis ready state (for tests)
function isRedisReady() {
  return redisReady;
}

// Process-level error handlers to prevent crashes
// These catch unhandled errors that could cause the server to exit
// NOTE: According to Node.js best practices, uncaughtException should trigger graceful shutdown.
// However, for Railway deployment where automatic restarts are handled by the platform,
// we log the error and continue to maintain visibility. In a production environment without
// platform-managed restarts, consider implementing graceful shutdown with process.exit(1).
process.on('uncaughtException', (err, origin) => {
  console.error(`❌ [CRITICAL] Uncaught Exception at ${origin}:`, err);
  console.error(`   Instance: ${INSTANCE_ID}, Version: ${APP_VERSION}`);
  console.error(`   Stack:`, err.stack);
  // Log the error for debugging. Railway/platform monitors will detect the error in logs.
  // For self-hosted deployments, consider adding graceful shutdown here:
  // setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`❌ [CRITICAL] Unhandled Rejection:`, reason);
  console.error(`   Instance: ${INSTANCE_ID}, Version: ${APP_VERSION}`);
  console.error(`   Promise:`, promise);
  if (reason instanceof Error) {
    console.error(`   Stack:`, reason.stack);
  }
  // Log but don't exit - let the application continue
});

// Graceful shutdown handler for Cloud Run (SIGTERM)
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received – beginning graceful shutdown');
  if (server) {
    server.close(() => {
      console.log('[Server] HTTP server closed');
      if (redis) {
        redis.quit().catch((err) => console.error('[Server] Redis disconnect error:', err)).finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
    // Force exit after 10 seconds if graceful shutdown stalls
    setTimeout(() => {
      console.error('[Server] Graceful shutdown timeout – forcing exit');
      process.exit(1);
    }, 10000).unref();
  } else {
    process.exit(0);
  }
});

// Start server if run directly (not imported as module)
if (require.main === module) {
  (async () => {
    try {
      await startServer();
    } catch (err) {
      console.error('❌ Server failed to start:', err);
      process.exit(1);
    }
  })();
}

// Export for testing
module.exports = {
  app,
  server,
  generateCode,
  parties,
  startServer,
  redis,
  getPartyFromRedis,
  setPartyInRedis,
  deletePartyFromRedis,
  getPartyFromFallback,
  setPartyInFallback,
  deletePartyFromFallback,
  fallbackPartyStorage,
  INSTANCE_ID,
  waitForRedis,
  isRedisReady,
  // New queue system functions
  normalizeTrack,
  validateHostAuth,
  loadPartyState,
  savePartyState,
  // Testing helpers
  _setStorageProvider: (provider) => { storageProvider = provider; },
  TRACK_MAX_BYTES,
  // Memory-stability testing hooks
  syncTickIntervals,
  partyEventHistory,
  // Billing / admin helpers
  isAdmin,
};
