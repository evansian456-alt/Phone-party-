/**
 * Jest configuration for integration tests.
 *
 * Integration tests run against ephemeral PostgreSQL + Redis containers
 * (started in globalSetup, stopped in globalTeardown). They use supertest
 * to test the Express app without binding to a real port.
 */

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/integration/**/*.test.js'],
  setupFilesAfterEnv: ['./jest.setup.js'],
  globalSetup: './tests/setup/globalSetup.js',
  globalTeardown: './tests/setup/globalTeardown.js',
  maxWorkers: 1, // Run integration tests sequentially to avoid DB conflicts
  testTimeout: 30000, // 30 seconds per test
  forceExit: false, // Let tests clean up properly
  detectOpenHandles: true, // Help identify resource leaks
};
