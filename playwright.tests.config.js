// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright configuration for tests/e2e/ (API-level and lightweight UI tests).
 *
 * Run via: npx playwright test --config=playwright.tests.config.js
 * Or: npm run test:e2e:new
 *
 * These tests are designed to run against a live server (started by e2e-runner.js
 * or manually). They use the Playwright APIRequestContext heavily and only open
 * a real browser for the few UI-check tests.
 */
module.exports = defineConfig({
  testDir: './tests/e2e',

  /* Global setup/teardown: starts Testcontainers (Postgres + Redis) */
  globalSetup: './tests/setup/globalSetup.js',
  globalTeardown: './tests/setup/globalTeardown.js',

  /* Sequential execution — tests share session cookies within a describe block */
  fullyParallel: false,
  workers: 1,

  /* Fail build on accidental test.only */
  forbidOnly: !!process.env.CI,

  /* Retry failed tests once on CI */
  retries: process.env.CI ? 1 : 0,

  /* Per-test timeout: 30 s */
  timeout: 30_000,

  /* Global timeout: 10 minutes */
  globalTimeout: 10 * 60 * 1000,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report-tests', open: 'never' }],
  ],

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:8080',
    trace: 'on',
    screenshot: 'on',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
