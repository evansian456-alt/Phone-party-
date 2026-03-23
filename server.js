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

const createAuthRouter = require('./routes/auth');
const createTracksRouter = require('./routes/tracks');
const createPartyRouter = require('./routes/party');
const createAdminRouter = require('./routes/admin');
const createReferralRouter = require('./routes/referral');
const createStreamingRouter = require('./routes/streaming');
const createBasketRouter = require('./routes/basket');
const createBillingRouter = require('./routes/billing');



const app = express();
const PORT = parseInt(process.env.PORT || "8080", 10);
const APP_VERSION = "0.1.0-party-fix"; // Version identifier for debugging and version display

// Early boot log so Cloud Run logs confirm the process reached this point
console.log("[Boot] commit=" + (process.env.COMMIT_SHA || "unknown") + " port=" + PORT + " node=" + process.version);

// Log admin email configuration status at startup so operators can confirm it is set
if (process.env.ADMIN_EMAILS) {
  const adminCount = process.env.ADMIN_EMAILS.split(',').filter(s => s.trim()).length;
  console.log(`[Boot] ADMIN_EMAILS configured with ${adminCount} email(s). Admin accounts receive PRO tier for free.`);
} else {
  console.warn('[Boot] WARNING: ADMIN_EMAILS is not set. No accounts will have admin access. Set ADMIN_EMAILS in your environment (e.g. ADMIN_EMAILS=ianevans2023@outlook.com).');
}

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
const ENABLE_LOCAL_AUTH_FALLBACK = process.env.ENABLE_LOCAL_AUTH_FALLBACK === 'true';

// In-memory auth/subscription fallback used only for local development when DB is unavailable.
// This lets engineers run full UX flows end-to-end in constrained environments.
const localFallbackUsersByEmail = new Map();
const localFallbackUsersById = new Map();
let localFallbackUserIdSeq = 1;

function canUseLocalAuthFallback() {
  return ENABLE_LOCAL_AUTH_FALLBACK && !dbReady;
}

function buildLocalFallbackMePayload(user) {
  const hasPro = !!user.upgrades.pro_monthly_active;
  const hasPartyPass = !!user.upgrades.party_pass_active;
  const tier = hasPro ? 'PRO_MONTHLY' : (hasPartyPass ? 'PARTY_PASS' : 'FREE');

  return {
    user: {
      id: user.id,
      email: user.email,
      djName: user.djName,
      createdAt: user.createdAt,
      profileCompleted: !!user.profileCompleted,
      tier,
      subscriptionStatus: hasPro ? 'active' : null,
      currentPeriodEnd: hasPro ? new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString() : null,
      isAdmin: false,
    },
    profile: {
      djScore: 0,
      djRank: 'Bedroom DJ',
      activeVisualPack: user.profile.activeVisualPack,
      activeTitle: user.profile.activeTitle,
      verifiedBadge: !!user.profile.verifiedBadge,
      crownEffect: !!user.profile.crownEffect,
      animatedName: !!user.profile.animatedName,
      reactionTrail: !!user.profile.reactionTrail,
    },
    entitlements: user.entitlements,
    tierInfo: {
      tier,
      hasPartyPass,
      hasPro,
    }
  };
}

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

// Body size limits — skip JSON parsing for Stripe webhook endpoints so that
// express.raw() on those routes receives the raw body needed for signature verification.
const _jsonParser = express.json({ limit: '1mb' });
app.use((req, res, next) => {
  if (req.path === '/api/billing/webhook' || req.path === '/api/stripe/webhook') {
    return next();
  }
  return _jsonParser(req, res, next);
});
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

// Cache-Control for JS/CSS/SVG: revalidate but allow the browser to cache
// for up to 1 minute between checks.  The service worker uses CHANGER_VERSION
// as a cache-busting key, so a 60-second browser cache is safe and eliminates
// repeated round-trips for assets that haven't changed within a session.
const ASSET_CACHE = 'public, max-age=60, stale-while-revalidate=300, must-revalidate';

// Loose rate limiter for explicit static asset routes (1200 req / 15 min per IP).
// Prevents abuse of the sendFile file-system reads on these routes.
const staticLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1200 });

// Add version header to all responses
app.use((req, res, next) => {
  res.setHeader("X-App-Version", APP_VERSION);
  res.setHeader("X-Changer-Version", CHANGER_VERSION);
  next();
});

// Serve config.js dynamically so the frontend API_BASE adjusts per environment.
// When running in a web browser the page origin already points at the right server,
// so we use an empty string (relative URLs).  For Capacitor native apps the HTML is
// loaded from the local device (capacitor://localhost), so they need the explicit
// production URL.  This route MUST be registered before express.static() so the
// dynamic handler takes precedence over the static file on disk.
app.get('/config.js', (req, res) => {
  const prodUrl = 'https://syncspeaker-262593928124.us-central1.run.app';
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', NO_CACHE);
  // Runtime check: native Capacitor apps need the production URL because their
  // page origin is capacitor://localhost (relative URLs would not reach the server).
  // In all web-browser contexts (local dev, CI, production Cloud Run) an empty
  // string works — fetch('/api/...') automatically targets the serving origin.
  let js = `const API_BASE = (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform()) ? ${JSON.stringify(prodUrl)} : '';\n`;
  if (publicBaseUrl) {
    js += `window.PUBLIC_BASE_URL = ${JSON.stringify(publicBaseUrl)};\n`;
  }
  res.send(js);
});

// Serve static files from the repo root.
// - HTML, JS, CSS: no-cache (content changes on every deploy; no URL fingerprinting)
// - SVG icons served from /icons/: long-lived cache (brand assets, stable across deploys)
// - Everything else: Express default (ETag-based revalidation)
app.use(express.static(__dirname, {
  setHeaders(res, filePath) {
    if (/\.html$/.test(filePath)) {
      // HTML: always revalidate so users get the latest shell immediately
      res.setHeader('Cache-Control', NO_CACHE);
    } else if (/service-worker\.js$/.test(filePath)) {
      // Service worker must never be cached — browsers manage SW updates separately
      res.setHeader('Cache-Control', NO_CACHE);
    } else if (/\.(js|css|svg)$/.test(filePath)) {
      // JS/CSS/SVG: allow a short browser cache; SW handles versioned invalidation
      res.setHeader('Cache-Control', ASSET_CACHE);
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
  // Allow short browser cache; SW versioned cache handles invalidation on deploy
  res.setHeader('Cache-Control', ASSET_CACHE);
  res.sendFile(path.join(__dirname, "app.js"));
});

app.get("/service-worker.js", staticLimiter, (req, res) => {
  // Service worker must never be cached — browsers have their own SW update check
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(__dirname, "service-worker.js"));
});

app.get("/manifest.json", staticLimiter, (req, res) => {
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(__dirname, "manifest.json"));
});

// Platform logo SVG assets — single parameterized route with allowlist validation.
const ALLOWED_PLATFORM_LOGOS = new Set(['youtube', 'spotify', 'soundcloud']);
app.get("/public/assets/platform-logos/:platform.svg", staticLimiter, (req, res) => {
  if (!ALLOWED_PLATFORM_LOGOS.has(req.params.platform)) return res.status(404).end();
  res.setHeader('Cache-Control', ASSET_CACHE);
  res.sendFile(path.join(__dirname, "public/assets/platform-logos", `${req.params.platform}.svg`));
});

// Streaming Party provider SVG assets — identical allowlist, served from providers/ directory
app.get("/public/assets/providers/:platform.svg", staticLimiter, (req, res) => {
  if (!ALLOWED_PLATFORM_LOGOS.has(req.params.platform)) return res.status(404).end();
  res.setHeader('Cache-Control', ASSET_CACHE);
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
  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
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
async function createPartyCommon({ djName, source, hostId, hostConnected, hostUserId }) {
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
    hostUserId: hostUserId || null,
    hostConnected,
    guestCount: 0,
    guests: [],
    status: "active",
    expiresAt: createdAt + PARTY_TTL_MS,
    // Tier-based fields (set by backend entitlement validation only)
    tier: null,
    maxPhones: null,
    partyPassExpiresAt: null,
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
      const productType = obj.metadata?.productType; // test/fallback identifier
      const validProductTypes = ['party_pass', 'pro_monthly'];
      const resolvedProductType = validProductTypes.includes(productType) ? productType : null;
      if (!priceId && !resolvedProductType) {
        try {
          const expanded = await stripeClient.checkout.sessions.retrieve(obj.id, { expand: ['line_items'] });
          priceId = expanded.line_items?.data?.[0]?.price?.id;
        } catch (err) {
          console.error('[Stripe] Failed to retrieve line_items:', err.message);
        }
      }
      if (priceId === STRIPE_PRICE_PARTY_PASS || resolvedProductType === 'party_pass') {
        const expiresAt = new Date(Date.now() + PARTY_PASS_DURATION_MS);
        await db.query(
          `INSERT INTO user_upgrades (user_id, party_pass_expires_at)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET party_pass_expires_at = $2, updated_at = NOW()`,
          [userId, expiresAt]
        );
        await db.query(`UPDATE users SET tier = 'PARTY_PASS' WHERE id = $1`, [userId]);
        console.log(`[Stripe] Party Pass activated for user ${userId} (expires ${expiresAt.toISOString()})`);
      } else if (priceId === STRIPE_PRICE_PRO_MONTHLY || resolvedProductType === 'pro_monthly') {
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
        console.log(`[Stripe] checkout.session.completed: unrecognised priceId=${priceId}, productType=${productType}`);
      }
      break;
    }

    case 'invoice.paid': {
      const subscriptionId = obj.subscription;
      if (!subscriptionId) return;
      // Try to resolve userId directly from metadata first (used in test webhooks and
      // real Stripe webhooks where the invoice metadata was set at subscription creation).
      const directUserId = obj.metadata?.userId || obj.lines?.data?.[0]?.metadata?.userId;
      const periodEnd = obj.period_end ? new Date(obj.period_end * 1000) : null;
      if (directUserId) {
        // Update user record and set stripe_subscription_id for future webhook lookups.
        await db.query(
          `UPDATE users SET subscription_status = 'active', tier = 'PRO',
            stripe_subscription_id = COALESCE(stripe_subscription_id, $2)
            ${periodEnd ? ', current_period_end = $3' : ''}
           WHERE id = $1`,
          periodEnd ? [directUserId, subscriptionId, periodEnd] : [directUserId, subscriptionId]
        );
        // Also update user_upgrades so /api/me entitlements.hasPro is correct.
        await db.query(
          `INSERT INTO user_upgrades (user_id, pro_monthly_active, pro_monthly_started_at,
             pro_monthly_renewal_provider, pro_monthly_provider_subscription_id)
           VALUES ($1, true, NOW(), 'stripe', $2)
           ON CONFLICT (user_id) DO UPDATE SET
             pro_monthly_active = true,
             pro_monthly_started_at = COALESCE(user_upgrades.pro_monthly_started_at, NOW()),
             pro_monthly_renewal_provider = 'stripe',
             pro_monthly_provider_subscription_id = $2,
             updated_at = NOW()`,
          [directUserId, subscriptionId]
        );
      } else {
        // Fall back to stripe_subscription_id lookup for webhooks without userId metadata.
        await db.query(
          `UPDATE users SET subscription_status = 'active', tier = 'PRO'${periodEnd ? ', current_period_end = $2' : ''}
           WHERE stripe_subscription_id = $1`,
          periodEnd ? [subscriptionId, periodEnd] : [subscriptionId]
        );
      }
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

// GET /api/basket, POST /api/basket/add are defined earlier in this file (BASKET/CART
// section using userBaskets). The _baskets/productKey duplicates have been removed.

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
// COPYRIGHT REPORTING
// ============================================================================

const COPYRIGHT_REPORT_THRESHOLD = 3; // Number of reports before auto-hiding a track

/**
 * POST /api/report-copyright
 * Allows any user (authenticated or not) to submit a copyright infringement report for a track.
 */
app.post('/api/report-copyright', rateLimit({ windowMs: 60000, max: 10, skip: shouldBypassRateLimit }), authMiddleware.optionalAuth, async (req, res) => {
  const { trackId, partyId, reason, description, timestamp } = req.body || {};

  if (!trackId || typeof trackId !== 'string' || trackId.trim() === '') {
    return res.status(400).json({ error: 'trackId is required' });
  }
  if (!partyId || typeof partyId !== 'string' || partyId.trim() === '') {
    return res.status(400).json({ error: 'partyId is required' });
  }
  const validReasons = ['copyright_infringement', 'unauthorized_upload', 'other'];
  if (!reason || !validReasons.includes(reason)) {
    return res.status(400).json({ error: 'reason must be one of: ' + validReasons.join(', ') });
  }

  const reporterUserId = (req.user && req.user.userId) ? req.user.userId : null;
  const safeDescription = description && typeof description === 'string' ? description.slice(0, 500) : null;

  try {
    const result = await db.query(
      `INSERT INTO copyright_reports (track_id, party_id, reporter_user_id, reason, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [trackId.trim(), partyId.trim(), reporterUserId, reason, safeDescription]
    );

    const reportId = result.rows[0].id;

    // Check if this track has hit the report threshold — auto-hide from party
    const countResult = await db.query(
      `SELECT COUNT(*) AS cnt FROM copyright_reports WHERE track_id = $1 AND status = 'pending'`,
      [trackId.trim()]
    );
    const reportCount = parseInt(countResult.rows[0].cnt, 10);

    if (reportCount >= COPYRIGHT_REPORT_THRESHOLD) {
      // Flag track in Redis party state if the party is active
      try {
        const partyData = await loadPartyState(partyId.trim());
        if (partyData) {
          if (!partyData.hiddenTracks) partyData.hiddenTracks = [];
          if (!partyData.hiddenTracks.includes(trackId.trim())) {
            partyData.hiddenTracks.push(trackId.trim());
            await savePartyState(partyId.trim(), partyData);
            console.log(`[CopyrightReport] Track ${trackId} auto-hidden in party ${partyId} after ${reportCount} reports`);

            // Notify party host via broadcast
            broadcastToParty(partyId.trim(), {
              t: 'COPYRIGHT_TRACK_HIDDEN',
              trackId: trackId.trim(),
              reason: 'Multiple copyright reports received. Track hidden pending review.'
            });
          }
        }
      } catch (partyErr) {
        // Non-fatal: log but don't fail the report submission
        console.warn('[CopyrightReport] Could not auto-hide track in party:', partyErr.message);
      }
    }

    return res.status(201).json({ ok: true, reportId, message: 'Report submitted successfully' });
  } catch (err) {
    console.error('[CopyrightReport] DB error:', err.message);
    return res.status(500).json({ error: 'Failed to submit report' });
  }
});

/**
 * GET /admin/copyright-reports
 * Admin-only endpoint to list copyright reports with pagination and status filtering.
 */
app.get('/admin/copyright-reports', rateLimit({ windowMs: 60000, max: 60, skip: shouldBypassRateLimit }), authMiddleware.requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const statusFilter = req.query.status || null;

  const validStatuses = ['pending', 'reviewed', 'removed', 'dismissed'];
  if (statusFilter && !validStatuses.includes(statusFilter)) {
    return res.status(400).json({ error: 'Invalid status filter' });
  }

  try {
    const countQuery = statusFilter
      ? `SELECT COUNT(*) AS total FROM copyright_reports WHERE status = $1`
      : `SELECT COUNT(*) AS total FROM copyright_reports`;
    const countParams = statusFilter ? [statusFilter] : [];
    const countResult = await db.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total, 10);

    const dataQuery = statusFilter
      ? `SELECT cr.id, cr.track_id, cr.party_id, cr.reporter_user_id, cr.reason, cr.description,
                cr.created_at, cr.status,
                u.email AS reporter_email, u.dj_name AS reporter_name
         FROM copyright_reports cr
         LEFT JOIN users u ON u.id::TEXT = cr.reporter_user_id
         WHERE cr.status = $1
         ORDER BY cr.created_at DESC
         LIMIT $2 OFFSET $3`
      : `SELECT cr.id, cr.track_id, cr.party_id, cr.reporter_user_id, cr.reason, cr.description,
                cr.created_at, cr.status,
                u.email AS reporter_email, u.dj_name AS reporter_name
         FROM copyright_reports cr
         LEFT JOIN users u ON u.id::TEXT = cr.reporter_user_id
         ORDER BY cr.created_at DESC
         LIMIT $1 OFFSET $2`;
    const dataParams = statusFilter ? [statusFilter, limit, offset] : [limit, offset];
    const dataResult = await db.query(dataQuery, dataParams);

    return res.json({
      ok: true,
      reports: dataResult.rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('[Admin/CopyrightReports] DB error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

/**
 * PATCH /admin/copyright-reports/:id
 * Admin action: update status of a report (reviewed, removed, dismissed) and optionally remove the track.
 */
app.patch('/admin/copyright-reports/:id', rateLimit({ windowMs: 60000, max: 60, skip: shouldBypassRateLimit }), authMiddleware.requireAdmin, async (req, res) => {
  const reportId = parseInt(req.params.id, 10);
  if (isNaN(reportId)) {
    return res.status(400).json({ error: 'Invalid report id' });
  }

  const { action } = req.body || {};
  const validActions = ['reviewed', 'removed', 'dismissed'];
  if (!action || !validActions.includes(action)) {
    return res.status(400).json({ error: 'action must be one of: ' + validActions.join(', ') });
  }

  try {
    const updateResult = await db.query(
      `UPDATE copyright_reports SET status = $1 WHERE id = $2 RETURNING id, track_id, party_id`,
      [action, reportId]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const { track_id: trackId, party_id: partyId } = updateResult.rows[0];

    // If admin chose to remove, also remove the track from the party's queue in Redis
    if (action === 'removed' && trackId && partyId) {
      try {
        const partyData = await loadPartyState(partyId);
        if (partyData && partyData.queue) {
          partyData.queue = partyData.queue.filter(t => t.trackId !== trackId);
          if (!partyData.hiddenTracks) partyData.hiddenTracks = [];
          if (!partyData.hiddenTracks.includes(trackId)) partyData.hiddenTracks.push(trackId);
          await savePartyState(partyId, partyData);
          broadcastToParty(partyId, {
            t: 'QUEUE_UPDATED',
            queue: partyData.queue,
            reason: 'Track removed by moderator'
          });
        }
      } catch (partyErr) {
        console.warn('[Admin/CopyrightReports] Could not remove track from party:', partyErr.message);
      }
    }

    return res.json({ ok: true, action, reportId });
  } catch (err) {
    console.error('[Admin/CopyrightReports] Update error:', err.message);
    return res.status(500).json({ error: 'Failed to update report' });
  }
});

// ============================================================================
// END COPYRIGHT REPORTING
// ============================================================================

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

// ============================================================================
// ROUTE MODULES
// ============================================================================

const routeDeps = {
  db,
  redis,
  authMiddleware,
  storeCatalog,
  paymentProvider,
  apiLimiter,
  authLimiter,
  purchaseLimiter,
  partyCreationLimiter,
  uploadLimiter,
  isStreamingPartyEnabled,
  isHttpsRequest,
  buildLocalFallbackMePayload,
  ErrorMessages,
  setSecureCookie,
  canUseLocalAuthFallback,
  localFallbackUsersById,
  localFallbackUsersByEmail,
  get localFallbackUserIdSeq() { return localFallbackUserIdSeq; },
  set localFallbackUserIdSeq(v) { localFallbackUserIdSeq = v; },
  rateLimit,
  stripeClient,
  PRODUCTS,
  getProductByPlatformId,
  applyPurchaseToUser,
  verifyStripeSignature,
  processStripeWebhook,
  metricsService,
  shouldBypassRateLimit,
  get storageProvider() { return storageProvider; },
  TRACK_MAX_BYTES,
  getPlaybackUrl,
  upload,
  parties,
  clients,
  readinessMap,
  syncTickIntervals,
  partySyncEngines,
  eventReplayManager,
  partyEventHistory,
  fallbackPartyStorage,
  loadPartyState,
  savePartyState,
  createPartyCommon,
  broadcastToParty,
  broadcastToPartyWithAck,
  broadcastRoomState,
  broadcastScoreboard,
  broadcastFeedItem,
  persistPlaybackToRedis,
  persistReactionHistoryToRedis,
  trackPartyEvent,
  getEventsSince,
  persistPartyScoreboard,
  startSyncTick,
  stopSyncTick,
  initializePartyEventHistory,
  getPartyFromRedis,
  setPartyInRedis,
  getPartyFromFallback,
  setPartyInFallback,
  get redisReady() { return redisReady; },
  get redisConnectionError() { return redisConnectionError; },
  PARTY_KEY_PREFIX,
  SYNC_TEST_MODE,
  validatePayload,
  logValidationFailure,
  validateHostAuth: validateHostAuth,
  validateHostAuthorityHTTP,
  createUnauthorizedError,
  normalizePlatformTrackRef,
  safeJsonParse,
  sanitizeText,
  normalizePartyCode,
  normalizePartyData,
  maskPartyCode,
  normalizeTrack,
  checkUserEntitlements,
  hasProAccess,
  hasStreamingAccess,
  isPartyPassActive: checkPartyPassActive,
  hasPartyPassAccess,
  getPartyMaxPhones,
  getMaxAllowedPhones,
  checkMessageRateLimit,
  cleanupRateLimitData,
  validateSessionCreation,
  validateSessionJoin,
  validateFeatureAccess,
  getTierLimits,
  checkPartyPassActive,
  tierPolicyIsPaidForOfficialAppSync,
  getPolicyForTier,
  isPaidForOfficialAppSyncParty,
  INSTANCE_ID,
  TEST_MODE,
  DEBUG_MODE,
  IS_PRODUCTION,
  ALLOW_FALLBACK_IN_PRODUCTION,
  getRedisErrorType,
  redisConfigSource,
  PROMO_CODES,
  FREE_LIMIT: FREE_PARTY_LIMIT,
  PARTY_PASS_LIMIT: 4,
  PRO_LIMIT: 100,
  FREE_DEFAULT_MAX_PHONES,
  MAX_PRO_PARTY_DEVICES,
  PARTY_PASS_DURATION_MS,
  MESSAGE_TTL_MS,
  HOST_QUICK_MESSAGES,
  GUEST_QUICK_REPLIES,
  HOST_RATE_LIMIT,
  GUEST_RATE_LIMIT,
  SyncEngine,
  checkRateLimit,
  clearClientRateLimit,
  publishToOtherInstances,
  promiseWithTimeout,
  customAlphabet,
  nanoid,
  requireStreamingEnabled,
  requireStreamingEntitled,
  referralSystem,
  _heartbeatStore,
};

app.use('/api', createAuthRouter(routeDeps));
app.use('/api', createTracksRouter(routeDeps));
app.use('/api', createPartyRouter(routeDeps));
app.use('/', createAdminRouter(routeDeps));
app.use('/api/referral', createReferralRouter(routeDeps));
app.use('/api/streaming', createStreamingRouter(routeDeps));
app.use('/api', createBasketRouter(routeDeps));
app.use('/', createBillingRouter(routeDeps));

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
    case "HOST_YOUTUBE_VIDEO":
      handleHostYouTubeVideo(ws, sanitizedMsg);
      break;
    case "HOST_YOUTUBE_PLAY":
      handleHostYouTubePlay(ws, sanitizedMsg);
      break;
    case "HOST_YOUTUBE_PAUSE":
      handleHostYouTubePause(ws, sanitizedMsg);
      break;
    case "HOST_SOUNDCLOUD_TRACK":
      handleHostSoundCloudTrack(ws, sanitizedMsg);
      break;
    case "HOST_SOUNDCLOUD_PLAY":
      handleHostSoundCloudPlay(ws, sanitizedMsg);
      break;
    case "HOST_SOUNDCLOUD_PAUSE":
      handleHostSoundCloudPause(ws, sanitizedMsg);
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

    // Replay current Official App Sync track state to late-joining client
    if (party.officialAppSync && party.officialAppSync.trackRef) {
      const sync = party.officialAppSync;
      const serverNowMs = Date.now();
      // Recalculate current playback position so guest syncs from the right spot
      const currentPositionSeconds = sync.playing && sync.playStartedAtMs
        ? Math.max(0, (serverNowMs - sync.playStartedAtMs) / 1000)
        : (sync.seekOffsetSeconds || 0);
      safeSend(ws, JSON.stringify({
        t: 'TRACK_SELECTED',
        mode: 'OFFICIAL_APP_SYNC',
        platform: sync.platform,
        trackRef: sync.trackRef,
        serverTimestampMs: serverNowMs,
        positionSeconds: currentPositionSeconds,
        playing: sync.playing
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
  const promoCode = (msg.code || "").trim().toUpperCase();
  const partyCode = client.party;
  const userId = client.userId || null;

  // Check DB-backed admin promo codes first (async, then fall back to legacy)
  (async () => {
    try {
      let dbPromo = null;
      try {
        const dbResult = await db.query(
          `SELECT id, code, type, is_used FROM promo_codes WHERE code = $1`,
          [promoCode]
        );
        if (dbResult.rows.length > 0) dbPromo = dbResult.rows[0];
      } catch (dbErr) { console.warn('[Promo] WS DB lookup unavailable, falling back to legacy codes:', dbErr.message); }

      if (dbPromo) {
        if (dbPromo.is_used) {
          safeSend(ws, JSON.stringify({ t: "ERROR", message: "This promo code has already been used." }));
          return;
        }
        // Atomically mark as used
        const updated = await db.query(
          `UPDATE promo_codes SET is_used = TRUE, used_at = NOW(), used_by = $1
           WHERE id = $2 AND is_used = FALSE RETURNING id`,
          [userId, dbPromo.id]
        );
        if (updated.rows.length === 0) {
          safeSend(ws, JSON.stringify({ t: "ERROR", message: "This promo code has already been used." }));
          return;
        }

        // Apply pro_monthly to the authenticated user (no expiry — provider-managed)
        if (dbPromo.type === 'pro_monthly' && userId) {
          await db.activateProMonthly(userId, 'promo', promoCode);
          console.log(`[Promo] WS DB promo ${promoCode} (pro_monthly) applied for user ${userId}`);
          safeSend(ws, JSON.stringify({ t: "PROMO_APPLIED", type: 'pro_monthly', message: "Pro Monthly activated!" }));
          return;
        }

        // monthly_subscription_one_time — grant exactly 1 month from redemption
        if (dbPromo.type === 'monthly_subscription_one_time' && userId) {
          await db.activateProMonthlyWithExpiry(userId, 'promo_one_time', promoCode, new Date());
          console.log(`[Promo] WS DB promo ${promoCode} (monthly_subscription_one_time) granted 1 month for user ${userId}`);
          safeSend(ws, JSON.stringify({ t: "PROMO_APPLIED", type: 'monthly_subscription_one_time', message: "1-Month Pro Subscription activated!" }));
          return;
        }

        // party_pass_one_time — grant a timed Party Pass to the user's account (2 hours)
        if (dbPromo.type === 'party_pass_one_time' && userId) {
          const partyPassExpiry = new Date();
          partyPassExpiry.setHours(partyPassExpiry.getHours() + 2);
          await db.updatePartyPassExpiry(userId, partyPassExpiry);
          console.log(`[Promo] WS DB promo ${promoCode} (party_pass_one_time) granted party pass to user ${userId}`);
          safeSend(ws, JSON.stringify({ t: "PROMO_APPLIED", type: 'party_pass_one_time', message: "Party Pass activated!" }));
          return;
        }

        // party_pass type — unlock party-wide Pro
        await _applyPromoToParty(partyCode, promoCode);
        safeSend(ws, JSON.stringify({ t: "PROMO_APPLIED", type: dbPromo.type, partyPro: true, message: "Pro unlocked for this party!" }));
        return;
      }

      // Legacy hardcoded codes
      if (!PROMO_CODES.includes(promoCode)) {
        console.log(`[Promo] Invalid promo code attempt: ${promoCode}, partyCode: ${partyCode}, clientId: ${client.id}`);
        safeSend(ws, JSON.stringify({ t: "ERROR", message: "Invalid or expired promo code." }));
        return;
      }

      await _applyPromoToParty(partyCode, promoCode);
      safeSend(ws, JSON.stringify({ t: "PROMO_APPLIED", partyPro: true, message: "Pro unlocked for this party!" }));
    } catch (err) {
      console.error(`[Promo] WS error applying promo ${promoCode} to party ${partyCode}:`, err.message);
      safeSend(ws, JSON.stringify({ t: "ERROR", message: "Failed to apply promo code." }));
    }
  })();
}

/** Shared helper: mark party as promoUsed+partyPro and persist to Redis */
async function _applyPromoToParty(partyCode, promoCode) {
  const party = parties.get(partyCode);
  if (party) {
    party.promoUsed = true;
    party.partyPro = true;
  }
  console.log(`[Promo] Party ${partyCode} unlocked with promo code ${promoCode}`);
  // Persist to Redis
  try {
    const partyData = await getPartyFromRedis(partyCode);
    if (partyData) {
      const normalizedData = normalizePartyData(partyData);
      normalizedData.promoUsed = true;
      normalizedData.partyPro = true;
      await setPartyInRedis(partyCode, normalizedData);
      console.log(`[Promo] Successfully persisted promo state to Redis for ${partyCode}`);
    } else {
      console.warn(`[Promo] Party ${partyCode} not found in Redis during promo persist`);
    }
  } catch (err) {
    console.error(`[Promo] Error persisting promo to Redis for ${partyCode}:`, err.message);
  }
  broadcastRoomState(partyCode);
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

// ============================================================================
// YOUTUBE PARTY PLAYER — WebSocket sync handlers
// ============================================================================

/**
 * Handle HOST_YOUTUBE_VIDEO — host loaded a new YouTube video.
 * Validates host authority + tier, then broadcasts YOUTUBE_VIDEO to all guests.
 */
function handleHostYouTubeVideo(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;

  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'youtube video');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('youtube video', authCheck.error)));
    return;
  }

  const party = authCheck.party;

  const videoId = (msg.videoId || '').trim();
  if (!videoId || videoId.length !== 11 || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    safeSend(ws, JSON.stringify({
      t: 'ERROR',
      errorType: 'INVALID_PAYLOAD',
      message: 'A valid 11-character YouTube videoId is required.'
    }));
    return;
  }

  const title = (msg.title || null);

  // Store YouTube state on party
  party.youtubeSync = {
    videoId,
    title,
    isPlaying: false,
    currentTime: 0,
    updatedAtMs: Date.now()
  };

  // Broadcast to all guests (exclude sender)
  broadcastToParty(client.party, {
    t: 'YOUTUBE_VIDEO',
    videoId,
    title
  });

  console.log(`[YouTubeParty] HOST_YOUTUBE_VIDEO videoId=${videoId} party=${client.party}`);
}

/**
 * Handle HOST_YOUTUBE_PLAY — host pressed play.
 * Broadcasts YOUTUBE_PLAY to all guests with current timestamp.
 */
function handleHostYouTubePlay(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;

  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'youtube play');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('youtube play', authCheck.error)));
    return;
  }

  const party = authCheck.party;

  const videoId = (msg.videoId || (party.youtubeSync && party.youtubeSync.videoId) || '').trim();
  const currentTime = typeof msg.currentTime === 'number' ? msg.currentTime : 0;

  if (party.youtubeSync) {
    party.youtubeSync.isPlaying = true;
    party.youtubeSync.currentTime = currentTime;
    party.youtubeSync.updatedAtMs = Date.now();
  }

  broadcastToParty(client.party, {
    t: 'YOUTUBE_PLAY',
    videoId,
    currentTime
  });

  console.log(`[YouTubeParty] HOST_YOUTUBE_PLAY videoId=${videoId} currentTime=${currentTime} party=${client.party}`);
}

/**
 * Handle HOST_YOUTUBE_PAUSE — host pressed pause.
 * Broadcasts YOUTUBE_PAUSE to all guests.
 */
function handleHostYouTubePause(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;

  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'youtube pause');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('youtube pause', authCheck.error)));
    return;
  }

  const party = authCheck.party;

  const videoId = (msg.videoId || (party.youtubeSync && party.youtubeSync.videoId) || '').trim();
  const currentTime = typeof msg.currentTime === 'number' ? msg.currentTime : 0;

  if (party.youtubeSync) {
    party.youtubeSync.isPlaying = false;
    party.youtubeSync.currentTime = currentTime;
    party.youtubeSync.updatedAtMs = Date.now();
  }

  broadcastToParty(client.party, {
    t: 'YOUTUBE_PAUSE',
    videoId,
    currentTime
  });

  console.log(`[YouTubeParty] HOST_YOUTUBE_PAUSE videoId=${videoId} currentTime=${currentTime} party=${client.party}`);
}

// ============================================================================
// END YOUTUBE PARTY PLAYER
// ============================================================================

// ============================================================================
// SOUNDCLOUD PARTY PLAYER — WebSocket sync handlers
// ============================================================================

/**
 * Handle HOST_SOUNDCLOUD_TRACK — host loaded a new SoundCloud track.
 * Validates host authority + tier, then broadcasts SOUNDCLOUD_TRACK to all guests.
 */
function handleHostSoundCloudTrack(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;

  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'soundcloud track');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('soundcloud track', authCheck.error)));
    return;
  }

  const party = authCheck.party;

  // Validate the track URL — must be a SoundCloud URL (or a short canonical path)
  const trackUrl = (msg.trackUrl || '').trim();
  if (!trackUrl || !/^https?:\/\/(www\.)?soundcloud\.com\/.+/.test(trackUrl)) {
    safeSend(ws, JSON.stringify({
      t: 'ERROR',
      errorType: 'INVALID_PAYLOAD',
      message: 'A valid SoundCloud track URL is required (https://soundcloud.com/...).'
    }));
    return;
  }

  const title = (msg.title || null);

  // Store SoundCloud state on party (in-memory only, like youtubeSync)
  party.soundcloudSync = {
    trackUrl,
    title,
    isPlaying: false,
    currentTime: 0,
    updatedAtMs: Date.now()
  };

  // Broadcast to all guests (exclude sender)
  broadcastToParty(client.party, {
    t: 'SOUNDCLOUD_TRACK',
    trackUrl,
    title
  });

  console.log(`[SoundCloudParty] HOST_SOUNDCLOUD_TRACK trackUrl=${trackUrl} party=${client.party}`);
}

/**
 * Handle HOST_SOUNDCLOUD_PLAY — host pressed play.
 * Broadcasts SOUNDCLOUD_PLAY to all guests with current timestamp.
 * Note: SoundCloud Widget API position is in milliseconds; currentTime here is in seconds
 * for consistency with the YouTube pattern (converted client-side when calling seekTo).
 */
function handleHostSoundCloudPlay(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;

  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'soundcloud play');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('soundcloud play', authCheck.error)));
    return;
  }

  const party = authCheck.party;

  const trackUrl = (msg.trackUrl || (party.soundcloudSync && party.soundcloudSync.trackUrl) || '').trim();
  const currentTime = typeof msg.currentTime === 'number' ? msg.currentTime : 0;

  if (party.soundcloudSync) {
    party.soundcloudSync.isPlaying = true;
    party.soundcloudSync.currentTime = currentTime;
    party.soundcloudSync.updatedAtMs = Date.now();
  }

  broadcastToParty(client.party, {
    t: 'SOUNDCLOUD_PLAY',
    trackUrl,
    currentTime
  });

  console.log(`[SoundCloudParty] HOST_SOUNDCLOUD_PLAY trackUrl=${trackUrl} currentTime=${currentTime} party=${client.party}`);
}

/**
 * Handle HOST_SOUNDCLOUD_PAUSE — host pressed pause.
 * Broadcasts SOUNDCLOUD_PAUSE to all guests.
 */
function handleHostSoundCloudPause(ws, msg) {
  const client = clients.get(ws);
  if (!client || !client.party) return;

  const authCheck = validateHostAuthority(ws, clients, parties, client.party, 'soundcloud pause');
  if (!authCheck.valid) {
    safeSend(ws, JSON.stringify(createUnauthorizedError('soundcloud pause', authCheck.error)));
    return;
  }

  const party = authCheck.party;

  const trackUrl = (msg.trackUrl || (party.soundcloudSync && party.soundcloudSync.trackUrl) || '').trim();
  const currentTime = typeof msg.currentTime === 'number' ? msg.currentTime : 0;

  if (party.soundcloudSync) {
    party.soundcloudSync.isPlaying = false;
    party.soundcloudSync.currentTime = currentTime;
    party.soundcloudSync.updatedAtMs = Date.now();
  }

  broadcastToParty(client.party, {
    t: 'SOUNDCLOUD_PAUSE',
    trackUrl,
    currentTime
  });

  console.log(`[SoundCloudParty] HOST_SOUNDCLOUD_PAUSE trackUrl=${trackUrl} currentTime=${currentTime} party=${client.party}`);
}

// ============================================================================
// END SOUNDCLOUD PARTY PLAYER
// ============================================================================

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
