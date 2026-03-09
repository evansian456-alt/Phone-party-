// Set environment for tests
process.env.NODE_ENV = 'test';
process.env.TEST_MODE = 'true';

// Set JWT_SECRET for auth tests
process.env.JWT_SECRET = 'test-secret-for-testing-only-do-not-use-in-production';

// Use port 0 so every test worker that starts a server gets a random free port —
// prevents EADDRINUSE conflicts between parallel Jest workers.
process.env.PORT = '0';

// Ensure test-storage-tmp directory exists before tests run
const fs = require('fs');
const path = require('path');
const storageDir = path.join(process.cwd(), 'test-storage-tmp');
if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

// ── Zero-skips enforcement (always on) ───────────────────────────────────────
// Any call to describe.skip / it.skip / test.skip / xit / xdescribe / xtest
// throws immediately, making the suite fail-fast.
// To temporarily disable during local debugging set ENFORCE_NO_SKIPS=0.
// All other values (unset, "1", etc.) enforce the ban — CI never sets it to 0.
if (process.env.ENFORCE_NO_SKIPS !== '0') {
  const noSkip = (name) => {
    throw new Error(
      `[ENFORCE_NO_SKIPS] Skipping is forbidden — remove the skip from: "${name}". ` +
      'Fix the root cause instead of skipping.'
    );
  };
  global.describe.skip = noSkip;
  global.it.skip = noSkip;
  global.test.skip = noSkip;
  global.xdescribe = noSkip;
  global.xit = noSkip;
  global.xtest = noSkip;
}

// Mock ioredis with ioredis-mock for tests.
// The factory must be self-contained (no out-of-scope variable references) to
// satisfy Jest's babel-jest hoisting restrictions.
jest.mock('ioredis', () => {
  const RedisMock = require('ioredis-mock');
  // Create a custom Redis mock that is immediately ready
  class MockCustomRedis extends RedisMock {
    constructor(...args) {
      super(...args);
      // Set status to ready immediately
      this.status = 'ready';
      // Emit ready event synchronously for tests
      process.nextTick(() => {
        this.emit('ready');
      });
    }
  }
  return MockCustomRedis;
});
