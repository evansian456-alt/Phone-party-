# Leaderboard and Scoring Pro Monthly Subscription Filter

## Summary
This document describes the changes made to ensure that **only hosts who pay the monthly subscription fee (Pro Monthly) are added to the leaderboard and score system**.

## Problem Statement
Previously, all hosts (regardless of subscription status) could have their scores updated and appear on the DJ leaderboard. This needed to be restricted to only Pro Monthly subscribers.

## Changes Made

### 1. Database Layer (`database.js`)

#### `updateDjProfileScore(userId, sessionScore)`
**Before**: Updated DJ scores for any logged-in user
**After**: Only updates scores for users with active Pro Monthly subscription

**Implementation**:
```javascript
// First check if user has active Pro Monthly subscription
const upgradesResult = await query(
  'SELECT pro_monthly_active FROM user_upgrades WHERE user_id = $1',
  [userId]
);

// Only update score if user has active Pro Monthly subscription
if (upgradesResult.rows.length === 0 || !upgradesResult.rows[0].pro_monthly_active) {
  console.log(`[Database] Skipping DJ score update for user ${userId} - no active Pro Monthly subscription`);
  return null;
}
```

**Key Points**:
- Returns `null` if user doesn't have Pro Monthly subscription
- Logs a message for tracking
- Prevents FREE and PARTY_PASS users from accumulating DJ scores

#### `getTopDjs(limit)`
**Before**: Returned all DJs from `dj_profiles` table
**After**: Only returns DJs with active Pro Monthly subscription

**Implementation**:
```sql
SELECT u.dj_name, dp.dj_score, dp.dj_rank, dp.verified_badge
FROM dj_profiles dp
JOIN users u ON dp.user_id = u.id
JOIN user_upgrades uu ON dp.user_id = uu.user_id
WHERE uu.pro_monthly_active = TRUE
ORDER BY dp.dj_score DESC
LIMIT $1
```

**Key Points**:
- Joins with `user_upgrades` table
- Filters by `pro_monthly_active = TRUE`
- Only Pro Monthly subscribers appear on leaderboard

### 2. Server Layer (`server.js`)
**No changes required** - The existing code in `persistPartyScoreboard` already calls `updateDjProfileScore`, which now handles the subscription check internally.

## Tier System Integration

### FREE Tier
- Users **cannot** accumulate DJ scores
- Users **do not** appear on leaderboard
- Party creation works normally
- Guest interactions still tracked

### PARTY_PASS Tier
- Users **cannot** accumulate DJ scores (temporary party access only)
- Users **do not** appear on leaderboard
- Party creation works with extended features
- Guest interactions still tracked

### PRO_MONTHLY Tier
- Users **can** accumulate DJ scores
- Users **appear** on leaderboard
- Full party features available
- Guest interactions tracked and DJ scores updated

## Testing

### Unit Tests (`leaderboard-subscription-check.test.js`)
- 13 tests verifying SQL query structure
- Tests for Pro Monthly subscription checks
- Tests for leaderboard filtering
- All tests passing ✓

### Integration Tests (`leaderboard-integration.test.js`)
- 9 tests verifying end-to-end behavior
- Tests for each tier (FREE, PARTY_PASS, PRO_MONTHLY)
- Tests for API endpoints
- All tests passing ✓

### Existing Tests
- `scoreboard.test.js` - All 13 tests passing ✓
- `leaderboard-profile.test.js` - All 12 tests passing ✓
- `tier-info.test.js` - All 4 tests passing ✓
- `pro-monthly-entitlement.test.js` - All 8 tests passing ✓

## Database Schema Requirements

The implementation assumes the following database schema:

```sql
-- user_upgrades table must have pro_monthly_active column
CREATE TABLE IF NOT EXISTS user_upgrades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pro_monthly_active BOOLEAN NOT NULL DEFAULT FALSE,
  -- ... other columns
);
```

## API Behavior

### `/api/leaderboard/djs`
- Returns only DJs with `pro_monthly_active = TRUE`
- Empty array if no Pro Monthly subscribers
- Ordered by `dj_score` descending

### `/api/leaderboard/guests`
- **Unchanged** - Guest leaderboard is independent of DJ subscription status
- All guests can appear on guest leaderboard

## Migration Notes

### For Existing Data
If there are existing DJ profiles in the database:
1. Only those with `pro_monthly_active = TRUE` will appear on leaderboard
2. Existing FREE/PARTY_PASS users will **not** accumulate new scores
3. Historical scores remain in database but won't be incremented

### For New Users
1. FREE tier: No scores accumulated, no leaderboard presence
2. PARTY_PASS tier: No scores accumulated, no leaderboard presence
3. PRO_MONTHLY tier: Scores accumulated, appears on leaderboard

## Security Considerations

1. **Database-level enforcement**: The check is at the database layer, not just UI
2. **No bypass possible**: Even if UI is manipulated, database won't update scores
3. **Audit trail**: Log messages track when score updates are skipped

## Future Enhancements

Potential improvements for consideration:
1. Add grace period for expired subscriptions
2. Track historical subscription status changes
3. Implement score decay for inactive Pro Monthly users
4. Add separate leaderboards for different time periods

## Verification Checklist

- [x] `updateDjProfileScore` checks Pro Monthly subscription
- [x] `getTopDjs` filters by Pro Monthly subscription
- [x] Tests verify FREE users cannot accumulate scores
- [x] Tests verify PARTY_PASS users cannot accumulate scores
- [x] Tests verify PRO_MONTHLY users can accumulate scores
- [x] All existing tests still pass
- [x] Documentation updated

## Contact
For questions or issues, refer to the main repository documentation or open an issue.
