'use strict';

/**
 * Global error-handling middleware for Express.
 *
 * Must be registered AFTER all routes so Express routes errors here.
 * Returns JSON (not HTML) for all unhandled errors, which is important for
 * API clients and Cloud Run health-check probes.
 */

const logger = require('../utils/logger');

/**
 * Express error handler middleware (4-argument signature required by Express).
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  // Don't expose internal details in production for 5xx errors.
  const message =
    isProduction && status >= 500
      ? 'Internal server error'
      : err.message || 'Internal server error';

  logger.error('Unhandled request error', {
    status,
    method: req.method,
    url: req.url,
    message: err.message,
    stack: isProduction ? undefined : err.stack,
  });

  // If headers already sent, delegate to Express default error handler so it
  // can properly close the response stream.
  if (res.headersSent) {
    return next(err);
  }

  res.status(status).json({ error: message });
}

module.exports = errorHandler;
