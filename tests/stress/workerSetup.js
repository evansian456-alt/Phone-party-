'use strict';

/**
 * Jest setupFilesAfterEnv for stress tests.
 *
 * Reads the container state file written by globalSetup.js and
 * injects DATABASE_URL / REDIS_URL into the worker's process.env so that
 * server.js (loaded via require) picks up the testcontainer endpoints.
 *
 * When DATABASE_URL is already present in the environment (CI), this is a
 * no-op.
 */

const path = require('path');
const fs = require('fs');

const STATE_FILE = path.resolve(__dirname, '../../.stress-container-state.json');

if (!process.env.DATABASE_URL && fs.existsSync(STATE_FILE)) {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state.DATABASE_URL) {
      process.env.DATABASE_URL = state.DATABASE_URL;
    }
    if (state.REDIS_URL && !process.env.REDIS_URL) {
      process.env.REDIS_URL = state.REDIS_URL;
    }
  } catch (_) {
    // Ignore read errors — tests will fail naturally if DB is unavailable.
  }
}
