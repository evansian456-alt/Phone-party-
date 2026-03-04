'use strict';

/**
 * Stress / load test orchestrator.
 *
 * Runs the configured ramp stages (see tests/stress/config.js) using the
 * in-process Express app via supertest — no live network, no paid services.
 *
 * Usage:
 *   npm run test:stress
 *   STRESS_MAX_STAGE=2 npm run test:stress
 *
 * What each stage does:
 *   For every party slot in the stage:
 *     1. Host signs up, logs in, creates a party.
 *     2. Guests sign up, log in, join the party concurrently.
 *     3. Host queues a stub track and starts playback.
 *     4. A random subset of users receives a simulated Stripe purchase.
 *     5. A random subset runs the basket add / remove round-trip.
 *     6. Admin stats endpoint is sampled and checked for consistency.
 *     7. /api/me is sampled from a subset of guests.
 *
 * Threshold checks after every stage:
 *   - error rate   < THRESHOLDS.errorRatePercent
 *   - p95 latency  < THRESHOLDS.p95LatencyMs
 *
 * Output: JSON report written to tests/stress/reports/.
 */

// ── Safety guard (must be before server import) ──────────────────────────────
const { assertStripeTestMode } = require('../helpers/stripe-guard');
assertStripeTestMode();

// ── Deps ─────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { STAGES, THRESHOLDS, REPORTS_DIR } = require('./config');
const { MetricsCollector, timed } = require('./metrics');
const hostScenario = require('./scenarios/host');
const guestScenario = require('./scenarios/guest');
const purchaseScenario = require('./scenarios/purchase');
const addonsScenario = require('./scenarios/addons');

const { app } = require('../../server');

// ── Helpers ───────────────────────────────────────────────────────────────────

let _uidCounter = 0;
function uid() {
  return `${Date.now()}_${(++_uidCounter).toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 5)}`;
}

function makeUser(role = 'stress') {
  const id = uid();
  return {
    email: `stress_${role}_${id}@test.invalid`,
    password: process.env.TEST_USER_PASSWORD || 'ChangeMe123!',
    djName: `DJ_${role}_${id}`.slice(0, 30),
  };
}

/**
 * Create an admin agent by signing up with an email that is in the
 * ADMIN_EMAILS allowlist (falls back to ADMIN_BOOTSTRAP_EMAIL).
 *
 * Returns null if no admin email is configured (admin checks are skipped).
 */
async function buildAdminAgent() {
  const adminEmail =
    (process.env.ADMIN_EMAILS || '').split(',')[0]?.trim() ||
    process.env.ADMIN_BOOTSTRAP_EMAIL?.trim() ||
    null;

  if (!adminEmail) return null;

  const agent = request.agent(app);
  const pw = process.env.TEST_USER_PASSWORD || 'ChangeMe123!';

  // Try signup (may already exist — that's fine)
  await agent
    .post('/api/auth/signup')
    .send({ email: adminEmail, password: pw, djName: 'StressAdmin' });

  const loginRes = await agent
    .post('/api/auth/login')
    .send({ email: adminEmail, password: pw });

  if (loginRes.status !== 200) return null;
  return agent;
}

/**
 * Sample /api/admin/stats and check basic consistency:
 *   - totalUsers must be >= 0
 *   - activeParties must be >= 0
 *   - no field should be negative
 * Returns `{ ok, violations }`.
 */
async function checkAdminStats(adminAgent) {
  if (!adminAgent) return { ok: true, violations: [] };

  let res;
  try {
    res = await adminAgent.get('/api/admin/stats');
  } catch (err) {
    return { ok: false, violations: [`admin/stats request failed: ${err.message}`] };
  }
  if (res.status !== 200) return { ok: false, violations: [`admin/stats returned ${res.status}`] };

  const stats = res.body;
  const violations = [];

  const numericChecks = [
    ['users.total', stats?.users?.total],
    ['parties.active', stats?.parties?.active],
    ['users.newLast24h', stats?.users?.newLast24h],
  ];

  for (const [label, val] of numericChecks) {
    if (val !== undefined && val !== null && Number(val) < 0) {
      violations.push(`${label} is negative: ${val}`);
    }
  }

  return { ok: violations.length === 0, violations };
}

// ── Main stage runner ─────────────────────────────────────────────────────────

/**
 * Run a single stress stage.
 *
 * @param {{stage:number, parties:number, hostsPerParty:number, guestsPerParty:number}} stageConfig
 * @param {MetricsCollector} metrics
 * @param {object|null} adminAgent
 * @returns {Promise<{
 *   stage: number,
 *   partiesCreated: number,
 *   usersTotal: number,
 *   purchaseResults: {tried:number, succeeded:number},
 *   adminConsistent: boolean,
 *   summary: ReturnType<MetricsCollector['summarise']>
 * }>}
 */
async function runStage(stageConfig, metrics, adminAgent) {
  const { stage, parties, hostsPerParty, guestsPerParty } = stageConfig;

  let partiesCreated = 0;
  const allUsers = []; // { agent } for purchase scenario

  // ── Create parties concurrently ──────────────────────────────────────────
  const partyTasks = Array.from({ length: parties }, async () => {
    // 1. Host signup + login
    const hostUser = makeUser(`h${stage}`);
    const { ok: hostOk, agent: hostAgent } = await timed(
      metrics,
      'host-signup-login',
      () => hostScenario.signupAndLogin(request, app, hostUser)
    );
    if (!hostOk) return null;

    // 2. Create party
    const { ok: createOk, code: partyCode, hostId } = await timed(metrics, 'create-party', () =>
      hostScenario.createParty(hostAgent, hostUser.djName)
    );
    if (!createOk || !partyCode) return null;
    partiesCreated += 1;

    // Upgrade the party to Pro so guest capacity is unlimited during stress
    await timed(metrics, 'apply-promo', () =>
      hostScenario.applyPromo(hostAgent, partyCode)
    );

    // 3. Guests join concurrently
    const guestAgents = [];
    await Promise.all(
      Array.from({ length: guestsPerParty }, async () => {
        const guestUser = makeUser(`g${stage}`);
        const { ok: guestOk, agent: guestAgent } = await timed(
          metrics,
          'guest-signup-login',
          () => guestScenario.signupAndLogin(request, app, guestUser)
        );
        if (!guestOk) return;

        await timed(metrics, 'guest-join', () =>
          guestScenario.joinParty(guestAgent, partyCode, guestUser.djName)
        );

        guestAgents.push({ agent: guestAgent, user: guestUser });
        allUsers.push({ agent: guestAgent });
      })
    );

    // 4. Host queues and starts a track
    const { ok: queueOk, trackId, trackUrl } = await timed(metrics, 'queue-track', () =>
      hostScenario.queueTrack(hostAgent, partyCode, hostId)
    );

    if (queueOk && trackId) {
      await timed(metrics, 'start-track', () =>
        hostScenario.startTrack(hostAgent, partyCode, trackId, trackUrl)
      );
    }

    // 5. Guests poll state (simulate "listening")
    await Promise.all(
      guestAgents.slice(0, 3).map(({ agent }) =>
        timed(metrics, 'poll-state', () =>
          guestScenario.pollPartyState(agent, partyCode)
        )
      )
    );

    // 6. Host polls state
    await timed(metrics, 'host-poll-state', () =>
      hostScenario.getPartyState(hostAgent, partyCode)
    );

    // 7. Basket round-trip for a subset of guests
    if (guestAgents.length > 0) {
      const basketAgent = guestAgents[0].agent;
      await timed(metrics, 'basket-roundtrip', () =>
        addonsScenario.basketRoundTrip(basketAgent, 2)
      );
      await timed(metrics, 'basket-checkout', () =>
        addonsScenario.simulateCheckout(basketAgent)
      );
    }

    return { partyCode, hostAgent, guestAgents };
  });

  const results = await Promise.all(partyTasks);
  const validParties = results.filter(Boolean);

  // 8. Simulate purchases for a random 20% of collected user agents
  const purchaseResults = await purchaseScenario.randomPurchases(
    allUsers.map(({ agent }) => ({ agent, userId: `${Date.now()}` })),
    0.2
  );

  // 9. Sample /api/me for a few random guests
  await Promise.all(
    allUsers.slice(0, 5).map(({ agent }) =>
      timed(metrics, 'get-me', () => guestScenario.getMe(agent))
    )
  );

  // 10. Admin stats consistency check
  const { ok: adminConsistent, violations } = await checkAdminStats(adminAgent);
  if (!adminConsistent) {
    console.warn(`[Stress] Stage ${stage} admin-stats violations:`, violations);
  }

  const summary = metrics.summarise();

  return {
    stage,
    partiesCreated,
    usersTotal: allUsers.length + validParties.length,
    purchaseResults,
    adminConsistent,
    summary,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Jest test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Stress / Load — Ramp orchestrator', () => {
  const metrics = new MetricsCollector();
  let adminAgent = null;
  const fullReport = {
    runAt: new Date().toISOString(),
    isCI: process.env.CI === 'true',
    thresholds: THRESHOLDS,
    stages: [],
    maxStableStage: 0,
    maxStableParties: 0,
    maxStableUsers: 0,
    stoppedEarly: false,
  };

  // Build admin agent once for the whole run
  beforeAll(async () => {
    adminAgent = await buildAdminAgent();
  }, 30_000);

  // Write final JSON report to disk after all stages
  afterAll(() => {
    try {
      if (!fs.existsSync(REPORTS_DIR)) {
        fs.mkdirSync(REPORTS_DIR, { recursive: true });
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const reportPath = path.join(REPORTS_DIR, `stress-report-${ts}.json`);
      fs.writeFileSync(reportPath, JSON.stringify(fullReport, null, 2));
      console.log(`\n[Stress] Report saved → ${reportPath}`);
    } catch (err) {
      console.warn('[Stress] Failed to write report:', err.message);
    }

    // Print summary to stdout
    printSummary(fullReport);
  });

  /**
   * Single Jest test that runs ALL stages sequentially.
   *
   * The test PASSES as long as stage 1 (minimum viable load) is within
   * thresholds. If a later stage exceeds thresholds, the ramp stops and
   * the result is recorded — this is the expected "ramp-until-failure"
   * behaviour. The test only FAILS if stage 1 itself is unhealthy, which
   * would indicate a fundamental problem with the server under minimal load.
   */
  test(
    `Ramp through ${STAGES.length} stage(s) — must be healthy at stage 1, ramp until threshold`,
    async () => {
      for (const stageConfig of STAGES) {
        const { stage, parties, hostsPerParty, guestsPerParty } = stageConfig;

        metrics.reset();

        const stageResult = await runStage(stageConfig, metrics, adminAgent);
        fullReport.stages.push(stageResult);

        const { totals, p95LatencyMs } = stageResult.summary;
        const errorRatePct = totals.errorRatePercent;

        console.log(
          `\n[Stress] Stage ${stage} complete: ` +
            `parties=${stageResult.partiesCreated}/${parties}, ` +
            `users=${stageResult.usersTotal}, ` +
            `errors=${totals.err}/${totals.ok + totals.err} (${errorRatePct.toFixed(2)}%), ` +
            `p95=${p95LatencyMs}ms`
        );

        const withinThresholds =
          errorRatePct <= THRESHOLDS.errorRatePercent &&
          p95LatencyMs <= THRESHOLDS.p95LatencyMs;

        if (withinThresholds) {
          fullReport.maxStableStage = stage;
          fullReport.maxStableParties = stageResult.partiesCreated;
          fullReport.maxStableUsers = stageResult.usersTotal;
        } else {
          // Ramp has hit its limit — record and stop
          fullReport.stoppedEarly = true;
          console.log(
            `[Stress] Stage ${stage} exceeded thresholds ` +
              `(errorRate=${errorRatePct.toFixed(2)}% vs ${THRESHOLDS.errorRatePercent}%, ` +
              `p95=${p95LatencyMs}ms vs ${THRESHOLDS.p95LatencyMs}ms). ` +
              `Max stable: stage ${fullReport.maxStableStage}.`
          );

          // Stage 1 must always pass — it represents minimal viable load.
          if (stage === 1) {
            throw new Error(
              `[Stress] Stage 1 failed threshold checks — server is unhealthy under minimal load. ` +
                `errorRate=${errorRatePct.toFixed(2)}%, p95=${p95LatencyMs}ms`
            );
          }

          // Higher stages exceeding thresholds is normal — just stop here.
          break;
        }
      }
    },
    300_000 // allow up to 5 minutes for all stages
  );
});

// ── Report printer ────────────────────────────────────────────────────────────

function printSummary(report) {
  console.log('\n════════════════════════════════════════════════════════');
  console.log(' STRESS RUN SUMMARY');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  Run at:              ${report.runAt}`);
  console.log(`  CI:                  ${report.isCI}`);
  console.log(`  Max stable stage:    ${report.maxStableStage}`);
  console.log(`  Max stable parties:  ${report.maxStableParties}`);
  console.log(`  Max stable users:    ${report.maxStableUsers}`);

  for (const s of report.stages) {
    const { totals, byEndpoint, p95LatencyMs } = s.summary;
    console.log(`\n  — Stage ${s.stage} —`);
    console.log(`    Parties created:  ${s.partiesCreated}`);
    console.log(`    Total users:      ${s.usersTotal}`);
    console.log(`    Overall error %:  ${totals.errorRatePercent.toFixed(2)}%`);
    console.log(`    p95 latency:      ${p95LatencyMs}ms`);
    console.log(`    Admin consistent: ${s.adminConsistent}`);
    console.log(`    Purchases:        tried=${s.purchaseResults.tried}, ok=${s.purchaseResults.succeeded}`);
    console.log('    Endpoint breakdown:');
    for (const [ep, d] of Object.entries(byEndpoint)) {
      console.log(
        `      ${ep.padEnd(22)} calls=${d.calls} err=${d.err} ` +
          `p50=${d.p50}ms p95=${d.p95}ms p99=${d.p99}ms`
      );
    }
  }

  console.log('\n════════════════════════════════════════════════════════\n');
}
