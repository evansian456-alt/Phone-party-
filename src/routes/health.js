'use strict';

/**
 * Health-check routes.
 *
 * Mounted by server.js so the main file stays clean.
 * Each route delegates to a controller; no business logic lives here.
 */

const express = require('express');
const { liveness } = require('../controllers/healthController');

const router = express.Router();

// Lightweight liveness probe — used by Cloud Run / load-balancers
// The full /health endpoint with DB + Redis checks remains in server.js
// until the service layer is ready to support it.
router.get('/healthz', (_req, res) => res.json({ ok: true }));

// Simple liveness alias used by some monitoring tools
router.get('/ping', liveness);

module.exports = router;
