const { Router } = require('express');

module.exports = function createSyncRouter(context) {
  const { partySyncEngines, SYNC_TEST_MODE } = context;
  const router = Router();

  // GET /api/sync/metrics - Sync metrics snapshot for a party (test mode only)
  // Returns enhanced per-client metrics for the Playwright harness and dashboard.
  // Enabled in SYNC_TEST_MODE or DEBUG mode; returns 404 in production.
  router.get('/api/sync/metrics', async (req, res) => {
    if (!SYNC_TEST_MODE && process.env.NODE_ENV === 'production') {
      return res.status(404).json({ error: 'Not found' });
    }
    const partyId = req.query.partyId || req.query.code;
    if (!partyId) {
      return res.status(400).json({ error: 'partyId query parameter required' });
    }
    const code = partyId.trim().toUpperCase();
    const syncEngine = partySyncEngines.get(code);
    if (!syncEngine) {
      return res.status(404).json({ error: 'No sync engine found for party', code });
    }
    const stats = syncEngine.getEnhancedStats(code);
    if (SYNC_TEST_MODE) {
      console.log(`[SyncMetrics] ${JSON.stringify(stats)}`);
    }
    return res.json(stats);
  });

  return router;
};
