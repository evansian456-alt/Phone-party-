'use strict';

/**
 * Request-logger middleware.
 *
 * Emits a structured log entry for every incoming HTTP request.
 * In production the entry is JSON (Cloud Logging-compatible).
 * In development a human-readable line is printed instead.
 */

const logger = require('../utils/logger');

/**
 * Express middleware that logs method, URL, status, and response time.
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http request', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      durationMs,
      ip: req.ip,
    });
  });

  next();
}

module.exports = requestLogger;
