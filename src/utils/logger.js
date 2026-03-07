'use strict';

/**
 * Structured JSON logger compatible with Google Cloud Logging.
 *
 * Replaces bare console.log calls with structured JSON so every log entry is
 * automatically parsed by Cloud Logging's structured-logging agent and becomes
 * searchable/filterable in the GCP console.
 *
 * Usage:
 *   const logger = require('./src/utils/logger');
 *   logger.info('server started', { port: 8080 });
 *   logger.error('db error', { err });
 */

const IS_PRODUCTION =
  process.env.NODE_ENV === 'production' ||
  !!process.env.RAILWAY_ENVIRONMENT ||
  !!process.env.REDIS_URL;

/**
 * Emit a structured log entry.
 * In production each entry is a single JSON line (Cloud Logging-compatible).
 * In development a human-readable prefix is used instead.
 *
 * @param {'DEBUG'|'INFO'|'WARNING'|'ERROR'|'CRITICAL'} severity
 * @param {string} message
 * @param {object} [extra]  Additional key-value pairs merged into the log entry.
 */
function log(severity, message, extra = {}) {
  if (IS_PRODUCTION) {
    const entry = {
      severity,
      message,
      ...extra,
      timestamp: new Date().toISOString(),
    };
    // Use the appropriate console method so Cloud Logging captures the right
    // log stream without needing special parsing.
    const method =
      severity === 'ERROR' || severity === 'CRITICAL'
        ? 'error'
        : severity === 'WARNING'
        ? 'warn'
        : 'log';
    console[method](JSON.stringify(entry));
  } else {
    const prefix = `[${severity}]`;
    const method =
      severity === 'ERROR' || severity === 'CRITICAL'
        ? 'error'
        : severity === 'WARNING'
        ? 'warn'
        : 'log';
    if (Object.keys(extra).length > 0) {
      console[method](prefix, message, extra);
    } else {
      console[method](prefix, message);
    }
  }
}

const logger = {
  debug: (message, extra) => log('DEBUG', message, extra),
  info: (message, extra) => log('INFO', message, extra),
  warn: (message, extra) => log('WARNING', message, extra),
  error: (message, extra) => log('ERROR', message, extra),
  critical: (message, extra) => log('CRITICAL', message, extra),
};

module.exports = logger;
