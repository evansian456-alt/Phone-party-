'use strict';

/**
 * Health-check controller.
 *
 * Thin request handlers that delegate to the health service.
 * Controllers should not contain business logic — they validate inputs,
 * call services, and shape HTTP responses.
 */

/**
 * GET /health  — liveness probe (lightweight, no external checks)
 */
function liveness(req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
}

module.exports = { liveness };
