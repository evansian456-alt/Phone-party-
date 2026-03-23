/**
 * db-migrations/add-party-song-addons.js
 *
 * Creates the party_song_addons table for tracking extra-upload addon
 * entitlements.  Each row records a single addon purchase and the
 * party-scoped upload grant it represents.
 *
 * Run with: node db-migrations/add-party-song-addons.js
 */

'use strict';

const { Pool } = require('pg');

async function runMigration() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  console.log('[Migration] Starting party_song_addons migration...');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('[Migration] Creating party_song_addons table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS party_song_addons (
        id                  SERIAL PRIMARY KEY,
        user_id             TEXT NOT NULL,
        party_code          TEXT NOT NULL,
        product_key         TEXT NOT NULL,
        addon_type          TEXT NOT NULL DEFAULT 'extra_uploads',
        songs_granted       INTEGER NOT NULL CHECK (songs_granted > 0),
        provider            TEXT NOT NULL,
        provider_session_id TEXT NOT NULL UNIQUE,
        idempotency_key     TEXT UNIQUE,
        status              TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('pending', 'active', 'cancelled', 'reversed')),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_party_song_addons_user_party
        ON party_song_addons (user_id, party_code)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_party_song_addons_party
        ON party_song_addons (party_code)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_party_song_addons_session
        ON party_song_addons (provider_session_id)
    `);

    await client.query('COMMIT');
    console.log('[Migration] party_song_addons migration completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Migration] Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(err => {
  console.error('[Migration] Fatal error:', err);
  process.exit(1);
});
