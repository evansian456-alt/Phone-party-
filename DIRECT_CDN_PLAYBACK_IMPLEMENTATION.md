# Phase 1: Direct R2/CDN Playback - Implementation Summary

## Overview
Implemented direct R2/CDN audio streaming to eliminate Railway bandwidth bottleneck and enable 10k+ scale.

## Changes Made

### 1. New Helper Function: `getPlaybackUrl()` (server.js, line ~780)
```javascript
function getPlaybackUrl({ trackId, key }) {
  // Priority order:
  // 1. CDN_BASE_URL (highest priority - Cloudflare CDN)
  // 2. S3_PUBLIC_BASE_URL (R2 public bucket URL)
  // 3. PUBLIC_BASE_URL + /api/track/:id (backwards compatible proxy)
  // 4. Relative /api/track/:id (dev fallback)
}
```

**Purpose**: Centralizes playback URL generation with proper fallback chain.

**Input**:
- `trackId`: Unique track identifier (e.g., "ABC123")
- `key`: Storage key from S3/R2 provider (e.g., "tracks/ABC123.mp3")

**Output**: Complete playback URL based on environment configuration

**Examples**:
- With CDN: `https://cdn.example.com/tracks/ABC123.mp3`
- With R2 public: `https://pub-xxx.r2.dev/tracks/ABC123.mp3`
- Fallback: `https://app.railway.app/api/track/ABC123`

### 2. Updated Upload Endpoint (server.js, line ~1898)
**Changed**: `/api/upload-track` now uses `getPlaybackUrl()` instead of hardcoded URL construction.

**Before**:
```javascript
let trackUrl;
if (process.env.PUBLIC_BASE_URL) {
  const baseUrl = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  trackUrl = `${baseUrl}/api/track/${trackId}`;
} else {
  const protocol = req.protocol;
  const host = req.get('host');
  trackUrl = `${protocol}://${host}/api/track/${trackId}`;
}
```

**After**:
```javascript
const trackUrl = getPlaybackUrl({
  trackId,
  key: uploadResult.key
});
```

**Impact**: trackUrl returned in upload response now supports direct CDN/R2 URLs.

### 3. Environment Variables (.env.example)
Added two new optional variables:

```bash
# Direct R2/CDN Playback URLs (eliminates Railway bandwidth bottleneck)
CDN_BASE_URL=https://cdn.example.com  # Cloudflare CDN (highest priority)
S3_PUBLIC_BASE_URL=https://pub-xxx.r2.dev  # R2 public bucket (fallback)
```

**Required**: No - both are optional. System falls back to existing `/api/track` proxy if not set.

### 4. Test Coverage
Created `getplaybackurl.test.js` with comprehensive test scenarios:
- Priority order validation
- Trailing slash handling
- Different file extensions
- Input validation
- Production scenarios

## Backwards Compatibility

✅ **FULLY BACKWARDS COMPATIBLE**

1. **No breaking changes**: All existing functionality preserved
2. **/api/track route retained**: Proxy route still exists for fallback
3. **Graceful degradation**: Works without new env vars set
4. **Existing trackUrls work**: Old URLs continue to function
5. **No client changes needed**: Clients use trackUrl from upload response

## Configuration Guide

### Option 1: No Changes (Current Behavior)
- Don't set `CDN_BASE_URL` or `S3_PUBLIC_BASE_URL`
- Audio streams through `/api/track/:id` proxy
- Railway handles all bandwidth
- **Use case**: Development, small deployments

### Option 2: R2 Public Bucket (Good for Scale)
```bash
S3_PUBLIC_BASE_URL=https://pub-a1b2c3d4e5f6.r2.dev
```
- Direct streaming from R2
- No Railway bandwidth usage
- ~$0.36/TB egress from R2
- **Use case**: Production without CDN

### Option 3: CDN + R2 (Best for Scale)
```bash
CDN_BASE_URL=https://cdn.syncspeaker.com
S3_PUBLIC_BASE_URL=https://pub-a1b2c3d4e5f6.r2.dev  # Fallback
```
- Direct streaming from Cloudflare CDN
- Free egress within Cloudflare network
- Ultra-low latency globally
- **Use case**: Production at scale (10k+ users)

## Manual Test Plan

### Test 1: Without CDN/S3 URLs (Baseline)
**Setup**: No `CDN_BASE_URL` or `S3_PUBLIC_BASE_URL` set

**Steps**:
1. Upload audio file via `/api/upload-track`
2. Check `trackUrl` in response
3. Expected: `https://your-app.railway.app/api/track/ABC123`
4. Verify audio plays correctly
5. Check Railway logs for streaming activity

**Pass Criteria**: trackUrl uses `/api/track/:id`, audio plays, Railway handles bandwidth

### Test 2: With S3_PUBLIC_BASE_URL
**Setup**: Set `S3_PUBLIC_BASE_URL=https://pub-xxx.r2.dev`

**Steps**:
1. Upload audio file
2. Check `trackUrl` in response
3. Expected: `https://pub-xxx.r2.dev/tracks/ABC123.mp3`
4. Verify audio plays correctly
5. Check Railway logs (should see no streaming activity)
6. Check R2 logs/metrics for direct access

**Pass Criteria**: trackUrl points to R2, audio plays, no Railway bandwidth usage

### Test 3: With CDN_BASE_URL (Priority Test)
**Setup**: Set both `CDN_BASE_URL=https://cdn.example.com` and `S3_PUBLIC_BASE_URL=https://pub-xxx.r2.dev`

**Steps**:
1. Upload audio file
2. Check `trackUrl` in response
3. Expected: `https://cdn.example.com/tracks/ABC123.mp3` (CDN takes priority)
4. Verify audio plays correctly
5. Check CDN logs for cache hits

**Pass Criteria**: trackUrl uses CDN (not S3), audio plays from CDN

### Test 4: Backwards Compatibility
**Setup**: Use existing party with old trackUrl format

**Steps**:
1. Create party with track uploaded before this change
2. Verify old trackUrl (`/api/track/:id`) still works
3. Upload new track
4. Verify new trackUrl uses CDN/R2 if configured
5. Verify both tracks play correctly in queue

**Pass Criteria**: Old and new trackUrls coexist, both play correctly

### Test 5: Range Request Support
**Setup**: Any configuration

**Steps**:
1. Upload track and get trackUrl
2. If using CDN/R2, verify R2 bucket allows public Range requests
3. Play track and seek to different positions
4. Check network tab for Range requests

**Pass Criteria**: Audio seeking works correctly with all URL types

## Rollback Plan

### Quick Rollback (No Code Changes)
**If issues with CDN/R2 access**:
1. Remove `CDN_BASE_URL` and `S3_PUBLIC_BASE_URL` from environment
2. Restart server
3. System reverts to `/api/track` proxy immediately
4. All existing tracks continue to work

**Steps**:
```bash
# Railway dashboard or CLI
railway variables:delete CDN_BASE_URL
railway variables:delete S3_PUBLIC_BASE_URL
railway up  # Redeploy
```

**Recovery Time**: ~30 seconds (Railway restart time)

### Full Rollback (Code Revert)
**If function causes issues**:
```bash
git revert <commit-hash>  # Revert this commit
git push origin main
```

**Files to revert**:
- `server.js` (remove `getPlaybackUrl()`, restore old URL construction)
- `.env.example` (remove CDN/S3 variables)
- `getplaybackurl.test.js` (delete test file)

**Recovery Time**: ~2 minutes (git + redeploy)

### Partial Rollback (Keep Function, Disable CDN)
**If only CDN has issues**:
1. Keep code changes
2. Only remove `CDN_BASE_URL` variable
3. Falls back to `S3_PUBLIC_BASE_URL` or `/api/track`

## Security Considerations

✅ **No sensitive data exposed**
- trackUrl is already public (clients need it to play audio)
- No credentials in URLs
- Storage keys follow existing S3/R2 security model

✅ **No new attack vectors**
- Public R2 buckets require explicit configuration
- CDN URLs follow existing CORS/access patterns
- `/api/track` fallback maintains current security

⚠️ **Configuration Notes**
- R2 bucket must be configured for public read access
- CDN must allow Range requests for seeking
- CORS headers required for browser access

## Performance Impact

### Positive Impacts
✅ Eliminates Railway bandwidth bottleneck
✅ Reduces Railway compute load (no audio streaming)
✅ Lower latency for guests (CDN edge locations)
✅ Better scaling to 10k+ concurrent users

### Neutral Impacts
⚪ Code: Single function call replaces 10 lines
⚪ Memory: No change
⚪ Database: No change

### Potential Concerns
⚠️ R2 egress costs (~$0.36/TB if not using CDN)
⚠️ Requires R2 bucket configuration
⚠️ May need CDN cache tuning for optimal performance

## Monitoring Recommendations

### Metrics to Track
1. **Railway bandwidth**: Should decrease when CDN/R2 enabled
2. **R2 operations**: Monitor GET requests and egress
3. **CDN cache hit rate**: Optimize if < 90%
4. **Audio playback errors**: Watch for 404s/CORS issues
5. **Client audio load times**: Should improve with CDN

### Log Messages
- `[HTTP] Track will be accessible at:` - Shows which URL type generated
- `[HTTP] Streaming track` - Only appears when using `/api/track` proxy
- Storage provider logs will show R2 direct access

## Next Steps

### Immediate (This PR)
- ✅ Implement `getPlaybackUrl()` function
- ✅ Update upload endpoint
- ✅ Add environment variables
- ✅ Document changes

### Follow-up (Separate PR/Task)
- Configure R2 bucket for public access
- Set up Cloudflare CDN
- Update Railway environment variables
- Monitor bandwidth and performance
- Document CDN configuration

### Future Enhancements
- Consider presigned URLs for private content
- Add CDN cache invalidation API
- Implement CDN purge on track delete
- Add CDN analytics integration

## Files Changed

| File | Lines Changed | Purpose |
|------|---------------|---------|
| `server.js` | +47, -10 | Add `getPlaybackUrl()`, update upload endpoint |
| `.env.example` | +5 | Document new environment variables |
| `getplaybackurl.test.js` | +299 | Test coverage for URL generation |

**Total**: ~351 lines added/changed across 3 files

## Status

✅ **READY FOR DEPLOYMENT**

- Code complete and tested
- Backwards compatible
- Documentation complete
- Rollback plan defined
- No breaking changes
