/**
 * Database Connection and Query Interface
 * Handles PostgreSQL connection pooling and common database operations
 */

const { Pool } = require('pg');

// Parse DATABASE_URL or use individual config values
let poolConfig;

if (process.env.DATABASE_URL) {
  // Parse DATABASE_URL for production/Railway
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  };
} else {
  // Use individual config for local development
  poolConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'syncspeaker',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD
  };
}

const pool = new Pool(poolConfig);

// Test connection on startup
pool.on('connect', () => {
  console.log('[Database] PostgreSQL connected successfully');
});

pool.on('error', (err) => {
  // Silently ignore 57P01 (terminating connection due to administrator command)
  // This fires during test teardown when the container stops, after Jest has finished.
  // Logging after Jest teardown causes "Cannot log after tests are done" failures.
  if (err.code === '57P01') return;
  console.error('[Database] Unexpected error on idle client', err);
});

/**
 * Query database
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    if (process.env.DEBUG === 'true') {
      const duration = Date.now() - start;
      console.log('[Database] Executed query', { text: text.substring(0, 50), duration, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    console.error('[Database] Query error', { text: text.substring(0, 50), error: error.message });
    throw error;
  }
}

/**
 * Get a client from the pool for transactions
 */
async function getClient() {
  return await pool.connect();
}

/**
 * Initialize database schema
 */
async function initializeSchema() {
  const fs = require('fs');
  const path = require('path');
  
  try {
    const schemaPath = path.join(__dirname, 'db', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    await query(schema);
    console.log('[Database] Schema initialized successfully');

    // Apply all migration files in sorted order (idempotent — all use IF NOT EXISTS).
    // Files must follow the NNN_description.sql naming convention so that sort()
    // produces the correct application order (e.g. 001_, 002_, …, 006_).
    const migrationsDir = path.join(__dirname, 'db', 'migrations');
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await query(sql);
        console.log(`[Database] Migration applied: ${file}`);
      }
    }

    return true;
  } catch (error) {
    console.error('[Database] Schema initialization error:', error.message);
    return false;
  }
}

/**
 * Check database health
 */
async function healthCheck() {
  try {
    const result = await query('SELECT NOW() as time');
    return { healthy: true, time: result.rows[0].time };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
}

/**
 * Get or create guest profile
 */
async function getOrCreateGuestProfile(guestIdentifier, nickname = null) {
  try {
    // Single UPSERT: insert or return existing row in one round trip
    const result = await query(
      `INSERT INTO guest_profiles (guest_identifier, nickname)
       VALUES ($1, $2)
       ON CONFLICT (guest_identifier) DO UPDATE SET updated_at = guest_profiles.updated_at
       RETURNING *`,
      [guestIdentifier, nickname]
    );
    
    return result.rows[0];
  } catch (error) {
    console.error('[Database] Error in getOrCreateGuestProfile:', error.message);
    throw error;
  }
}

/**
 * Update guest profile stats with UPSERT to handle missing profiles
 */
async function updateGuestProfile(guestIdentifier, updates) {
  try {
    const { contributionPoints, reactionsCount, messagesCount } = updates;
    
    // Use UPSERT pattern to create profile if it doesn't exist
    const result = await query(
      `INSERT INTO guest_profiles (guest_identifier, total_contribution_points, total_reactions_sent, total_messages_sent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guest_identifier) 
       DO UPDATE SET 
         total_contribution_points = guest_profiles.total_contribution_points + $2,
         total_reactions_sent = guest_profiles.total_reactions_sent + $3,
         total_messages_sent = guest_profiles.total_messages_sent + $4,
         updated_at = NOW()
       RETURNING *`,
      [guestIdentifier, contributionPoints || 0, reactionsCount || 0, messagesCount || 0]
    );
    
    return result.rows[0];
  } catch (error) {
    console.error('[Database] Error in updateGuestProfile:', error.message);
    throw error;
  }
}

/**
 * Increment parties_joined counter for a guest (call once per party)
 */
async function incrementGuestPartiesJoined(guestIdentifier) {
  try {
    const result = await query(
      `UPDATE guest_profiles 
       SET parties_joined = parties_joined + 1,
           updated_at = NOW()
       WHERE guest_identifier = $1
       RETURNING *`,
      [guestIdentifier]
    );
    
    return result.rows[0];
  } catch (error) {
    console.error('[Database] Error in incrementGuestPartiesJoined:', error.message);
    throw error;
  }
}

/**
 * Update DJ profile score for a party session.
 *
 * Score is accumulated for all DJs. Pro Monthly subscription status is checked
 * and logged — only Pro Monthly users appear on the public leaderboard via getTopDjs().
 */
async function updateDjProfileScore(userId, sessionScore) {
  try {
    // Check Pro Monthly subscription status for leaderboard eligibility.
    // Scores are accumulated regardless; only Pro Monthly users surface in getTopDjs().
    const upgradesResult = await query(
      `SELECT pro_monthly_active FROM user_upgrades WHERE user_id = $1`,
      [userId]
    );
    const hasPro = upgradesResult.rows.length > 0 &&
      upgradesResult.rows[0].pro_monthly_active === true;

    if (!hasPro) {
      console.log(
        `[Database] User ${userId} has no active Pro Monthly subscription — ` +
        'score accumulated but hidden from the public leaderboard.'
      );
    }

    // UPSERT: create or increment the DJ profile score for this user.
    const result = await query(
      `INSERT INTO dj_profiles (user_id, dj_score, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET
         dj_score = dj_profiles.dj_score + $2,
         updated_at = NOW()
       RETURNING *`,
      [userId, sessionScore]
    );

    if (result.rows.length === 0) {
      console.log(`[Database] No DJ profile entry found for user ${userId} — score not updated`);
      return null;
    }

    return result.rows[0];
  } catch (error) {
    console.error('[Database] Error in updateDjProfileScore:', error.message);
    throw error;
  }
}

/**
 * Save party scoreboard session
 */
async function savePartyScoreboard(scoreboardData) {
  try {
    const {
      partyCode,
      hostUserId,
      hostIdentifier,
      djSessionScore,
      guestScores,
      partyDurationMinutes,
      totalReactions,
      totalMessages,
      peakCrowdEnergy
    } = scoreboardData;
    
    const result = await query(
      `INSERT INTO party_scoreboard_sessions 
       (party_code, host_user_id, host_identifier, dj_session_score, guest_scores, 
        party_duration_minutes, total_reactions, total_messages, peak_crowd_energy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        partyCode,
        hostUserId,
        hostIdentifier,
        djSessionScore,
        JSON.stringify(guestScores),
        partyDurationMinutes,
        totalReactions,
        totalMessages,
        peakCrowdEnergy
      ]
    );
    
    return result.rows[0];
  } catch (error) {
    console.error('[Database] Error in savePartyScoreboard:', error.message);
    throw error;
  }
}

/**
 * Get party scoreboard by code
 */
async function getPartyScoreboard(partyCode) {
  try {
    const result = await query(
      'SELECT * FROM party_scoreboard_sessions WHERE party_code = $1 ORDER BY created_at DESC LIMIT 1',
      [partyCode]
    );
    
    if (result.rows.length > 0) {
      // guest_scores is a JSONB column — pg auto-parses it to a JS object/array,
      // so JSON.parse is only needed when the value comes back as a raw string
      // (e.g. from a TEXT column or an older pg version without JSONB auto-parsing).
      const scoreboard = result.rows[0];
      if (typeof scoreboard.guest_scores === 'string') {
        scoreboard.guest_scores = JSON.parse(scoreboard.guest_scores);
      }
      scoreboard.guest_scores = scoreboard.guest_scores || [];
      return scoreboard;
    }
    
    return null;
  } catch (error) {
    console.error('[Database] Error in getPartyScoreboard:', error.message);
    throw error;
  }
}

/**
 * Get top DJs by score
 * Only returns DJs with active Pro Monthly subscription
 */
async function getTopDjs(limit = 10) {
  try {
    const result = await query(
      `SELECT u.dj_name, dp.dj_score, dp.dj_rank, dp.verified_badge
       FROM dj_profiles dp
       JOIN users u ON dp.user_id = u.id
       JOIN user_upgrades uu ON dp.user_id = uu.user_id
       WHERE uu.pro_monthly_active = TRUE
       ORDER BY dp.dj_score DESC
       LIMIT $1`,
      [limit]
    );
    
    return result.rows;
  } catch (error) {
    console.error('[Database] Error in getTopDjs:', error.message);
    throw error;
  }
}

/**
 * Get top guests by contribution points
 */
async function getTopGuests(limit = 10) {
  try {
    const result = await query(
      `SELECT nickname, total_contribution_points, guest_rank, parties_joined
       FROM guest_profiles
       ORDER BY total_contribution_points DESC
       LIMIT $1`,
      [limit]
    );
    
    return result.rows;
  } catch (error) {
    console.error('[Database] Error in getTopGuests:', error.message);
    throw error;
  }
}

/**
 * Get or create user upgrades record
 */
async function getOrCreateUserUpgrades(userId) {
  try {
    // Single UPSERT: insert or return existing row in one round trip
    const result = await query(
      `INSERT INTO user_upgrades (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = user_upgrades.updated_at
       RETURNING *`,
      [userId]
    );
    
    return result.rows[0];
  } catch (error) {
    console.error('[Database] Error in getOrCreateUserUpgrades:', error.message);
    throw error;
  }
}

/**
 * Update Party Pass expiration
 */
async function updatePartyPassExpiry(userId, expiresAt) {
  try {
    const result = await query(
      `INSERT INTO user_upgrades (user_id, party_pass_expires_at, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         party_pass_expires_at = $2,
         updated_at = NOW()
       RETURNING *`,
      [userId, expiresAt]
    );
    
    return result.rows[0];
  } catch (error) {
    console.error('[Database] Error in updatePartyPassExpiry:', error.message);
    throw error;
  }
}

/**
 * Activate Pro Monthly subscription
 */
async function activateProMonthly(userId, provider, providerSubscriptionId) {
  try {
    const result = await query(
      `INSERT INTO user_upgrades 
       (user_id, pro_monthly_active, pro_monthly_started_at, pro_monthly_renewal_provider, 
        pro_monthly_provider_subscription_id, updated_at)
       VALUES ($1, TRUE, NOW(), $2, $3, NOW())
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         pro_monthly_active = TRUE,
         pro_monthly_started_at = COALESCE(user_upgrades.pro_monthly_started_at, NOW()),
         pro_monthly_renewal_provider = $2,
         pro_monthly_provider_subscription_id = $3,
         updated_at = NOW()
       RETURNING *`,
      [userId, provider, providerSubscriptionId]
    );
    
    return result.rows[0];
  } catch (error) {
    console.error('[Database] Error in activateProMonthly:', error.message);
    throw error;
  }
}

/**
 * Deactivate Pro Monthly subscription
 */
async function deactivateProMonthly(userId) {
  try {
    const result = await query(
      `UPDATE user_upgrades 
       SET pro_monthly_active = FALSE,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [userId]
    );
    
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('[Database] Error in deactivateProMonthly:', error.message);
    throw error;
  }
}

/**
 * Resolve user entitlements from upgrades
 * Returns { hasPartyPass: boolean, hasPro: boolean }
 */
function resolveEntitlements(upgrades) {
  if (!upgrades) {
    return { hasPartyPass: false, hasPro: false };
  }
  
  const now = new Date();
  const hasPro = upgrades.pro_monthly_active === true;
  const hasPartyPass = hasPro || Boolean(
    upgrades.party_pass_expires_at && 
    new Date(upgrades.party_pass_expires_at) > now
  );
  
  return { hasPartyPass, hasPro };
}

module.exports = {
  query,
  getClient,
  pool,
  initializeSchema,
  healthCheck,
  getOrCreateGuestProfile,
  updateGuestProfile,
  updateDjProfileScore,
  savePartyScoreboard,
  getPartyScoreboard,
  getTopDjs,
  getTopGuests,
  incrementGuestPartiesJoined,
  getOrCreateUserUpgrades,
  updatePartyPassExpiry,
  activateProMonthly,
  deactivateProMonthly,
  resolveEntitlements
};
