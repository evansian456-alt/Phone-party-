'use strict';

/**
 * Health-check controller.
 *
 * Thin request handlers that delegate to the health service.
 * Controllers should not contain business logic — they validate inputs,
 * call services, and shape HTTP responses.
 */

/**
 * GET /ping  — simple liveness probe
 */
function liveness(req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
}

module.exports = { liveness };
