'use strict';

/**
 * Rate-limiter middleware factory.
 *
 * Centralises rate-limit configuration so every limiter shares the same
 * bypass logic (TEST_MODE / DISABLE_RATE_LIMIT) and JSON error-response format.
 *
 * Usage in server.js:
 *   const { authLimiter, apiLimiter } = require('./src/middleware/rateLimiter');
 *   app.post('/api/auth/signup', authLimiter, handler);
 */

const rateLimit = require('express-rate-limit');

/**
 * Returns true when rate limiting should be bypassed.
 * Evaluated at request time so env changes after module load
 * (e.g. in integration tests) are respected.
 */
function shouldBypassRateLimit() {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.DISABLE_RATE_LIMIT === 'true'
  );
}

/** No-op middleware used when rate limiting is bypassed. */
const rateLimitBypass = (_req, _res, next) => next();

/**
 * Rate-limit handler that always returns application/json so API clients
 * can reliably parse the error body.
 */
function jsonRateLimitHandler(req, res, _next, options) {
  res.status(options.statusCode).json(options.message);
}

/**
 * Build a rate limiter with shared defaults.
 * If bypass mode is active, returns the no-op middleware instead.
 *
 * @param {import('express-rate-limit').Options} options
 * @param {boolean} [alwaysBypass=false] Force bypass regardless of env vars.
 */
function makeLimiter(options, alwaysBypass = false) {
  if (alwaysBypass || shouldBypassRateLimit()) return rateLimitBypass;
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    handler: jsonRateLimitHandler,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Named limiters — all use `skip: shouldBypassRateLimit` so the bypass
// decision is re-evaluated per request (not frozen at module load time).
// ---------------------------------------------------------------------------

/** Strict limiter for auth endpoints (signup / login). */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many authentication attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: shouldBypassRateLimit,
  handler: jsonRateLimitHandler,
});

/** General API limiter – skipped in test/CI mode. */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: shouldBypassRateLimit,
  handler: jsonRateLimitHandler,
});

/** Purchase endpoint limiter. */
const purchaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many purchase requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: shouldBypassRateLimit,
  handler: jsonRateLimitHandler,
});

/** Party creation limiter. */
const partyCreationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many party creation attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: shouldBypassRateLimit,
  handler: jsonRateLimitHandler,
});

/** Upload endpoint limiter. */
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many upload requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: shouldBypassRateLimit,
  handler: jsonRateLimitHandler,
});

module.exports = {
  shouldBypassRateLimit,
  jsonRateLimitHandler,
  authLimiter,
  apiLimiter,
  purchaseLimiter,
  partyCreationLimiter,
  uploadLimiter,
};
