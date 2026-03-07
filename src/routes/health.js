'use strict';

/**
 * Health-check routes.
 *
 * Mounted by server.js so the main file stays clean.
 * Each route delegates to a controller; no business logic lives here.
 *
 * NOTE: Full health probes (/health, /healthz, /readyz) with DB + Redis checks
 * remain in server.js to avoid shadowing those handlers. This router only
 * adds /ping which was not previously registered.
 */

const express = require('express');
const { liveness } = require('../controllers/healthController');

const router = express.Router();

// Simple liveness alias used by some monitoring tools
router.get('/ping', liveness);

module.exports = router;
