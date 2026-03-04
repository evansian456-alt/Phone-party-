'use strict';

/**
 * Global teardown for stress tests.
 *
 * Stops any Testcontainers that were started by stressGlobalSetup.
 * If containers were not started (CI mode), this is a no-op.
 */

const path = require('path');
const fs = require('fs');

const STATE_FILE = path.resolve(__dirname, '../../.stress-container-state.json');

module.exports = async function stressGlobalTeardown() {
  // Stop containers via globalThis (same-process Jest --runInBand)
  const containers = globalThis.__stressContainers;
  if (containers) {
    const { pgContainer, redisContainer } = containers;
    if (pgContainer) {
      console.log('[stressTeardown] Stopping PostgreSQL container…');
      await pgContainer.stop().catch(() => {});
    }
    if (redisContainer) {
      console.log('[stressTeardown] Stopping Redis container…');
      await redisContainer.stop().catch(() => {});
    }
  }

  // Clean up state file
  if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
  }

  console.log('[stressTeardown] ✅ Stress global teardown complete.');
};
