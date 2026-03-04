'use strict';

/**
 * Jest configuration for stress / load tests.
 *
 * Used by: npm run test:stress
 *
 * Intentionally separate from the root jest config so:
 *   - Stress tests are not run as part of the normal `npm test` suite.
 *   - Stress tests can have their own (longer) timeouts.
 *   - testPathIgnorePatterns does NOT exclude tests/stress/.
 */

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/stress/**/*.test.js', '<rootDir>/tests/stress/orchestrator.js'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/stress/scenarios/',
    '/tests/stress/reports/',
  ],
  transform: {},
  transformIgnorePatterns: ['node_modules/(?!(nanoid)/)'],
  setupFilesAfterEnv: [
    // Must run first: read testcontainer URLs from state file into process.env
    '<rootDir>/tests/stress/workerSetup.js',
    // Must run second: apply global test mocks (ioredis-mock, skip enforcement, etc.)
    '<rootDir>/jest.setup.js',
  ],
  globalSetup: '<rootDir>/tests/stress/globalSetup.js',
  globalTeardown: '<rootDir>/tests/stress/globalTeardown.js',
  testTimeout: 120000,
  maxWorkers: 1,
  forceExit: true,
};
