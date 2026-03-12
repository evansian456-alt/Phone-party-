// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright audit configuration.
 *
 * Runs the full audit suite against a self-managed ephemeral stack
 * (PostgreSQL + Redis + App server), on both Desktop and Mobile viewports.
 *
 * Usage:
 *   npx playwright test --config=playwright.audit.config.js
 *   npm run test:e2e:audit
 */
module.exports = defineConfig({
  testDir: './tests/e2e',

  /* Audit setup/teardown: starts containers + app server */
  globalSetup: './tests/setup/auditSetup.js',
  globalTeardown: './tests/setup/auditTeardown.js',

  /* Sequential — tests share server state */
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,

  /* Two retries on CI */
  retries: process.env.CI ? 2 : 1,

  /* 45 s per test */
  timeout: 45_000,

  /* 30 min global cap */
  globalTimeout: 30 * 60 * 1000,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-audit-report', open: 'never' }],
    ['json', { outputFile: 'playwright-audit-report/results.json' }],
  ],

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:8080',
    trace: 'on',           // always capture traces
    screenshot: 'on',      // screenshot every test
    video: 'on',           // record video for every test
    actionTimeout: 15_000,
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },

  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 393, height: 851 },
      },
    },
  ],
});
