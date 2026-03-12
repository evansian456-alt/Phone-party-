# Local Full-Flow Run Report

Date: 2026-03-12

## Goal
Run the app locally and execute the complete end-to-end user journey:
- Sign up
- Create profile
- Log in
- Start party as host
- Join as guests
- Buy add-ons
- Exercise messaging/sync/scoreboard features

## What I ran

1. Installed dependencies:

```bash
npm ci
```

2. Started the app locally:

```bash
PORT=8080 NODE_ENV=development npm run dev
```

3. Attempted the built-in comprehensive journey suite (covers all requested user flows):

```bash
BASE_URL=http://127.0.0.1:8080 npx playwright test e2e-tests/16-comprehensive-user-journey.spec.js --project=chromium
```

4. Attempted to install Playwright Chromium so the full journey suite could execute:

```bash
npx playwright install chromium
```

## Results

- The server starts successfully in local development mode and exposes all core routes including auth, party lifecycle, store/add-ons, basket/checkout, leaderboard, and sync endpoints.
- The comprehensive journey test file is present and explicitly designed to run the full app journey (tiers, add-ons, host/guest, messaging, scale).
- Full browser-driven execution is blocked in this environment because Playwright Chromium cannot be downloaded (403 Forbidden from Playwright CDN), so tests fail before UI steps begin.

## Blockers encountered

1. `docker` is unavailable in this environment, so the `scripts/e2e-runner.js` bootstrap cannot auto-start Redis.
2. Direct Playwright runs are blocked by missing browser binaries.
3. Browser installation fails due network/CDN access restriction (`403 Forbidden`), preventing full UI automation execution.

## How to run the exact full flow on a machine without this restriction

1. Ensure Redis is available (local service or Docker).
2. Install Playwright browser binaries:

```bash
npx playwright install chromium
```

3. Run the comprehensive full-flow suite:

```bash
npm run test:e2e -- e2e-tests/16-comprehensive-user-journey.spec.js --project=chromium
```

This suite is the repository's canonical start-to-finish user simulation covering signup/profile/login, host/guest flows, purchases/add-ons, messaging, sync, and scale scenarios.
