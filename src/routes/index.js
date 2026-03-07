'use strict';

/**
 * Central route loader.
 *
 * Mounts all Express sub-routers onto the application.
 * server.js calls loadRoutes(app) during startup instead of registering
 * routes directly, keeping server.js focused on setup and lifecycle management.
 *
 * As business logic is migrated from server.js into this directory, new
 * router modules should be imported and mounted here.
 */

const healthRouter = require('./health');

/**
 * @param {import('express').Application} app
 */
function loadRoutes(app) {
  app.use('/', healthRouter);
}

module.exports = { loadRoutes };
