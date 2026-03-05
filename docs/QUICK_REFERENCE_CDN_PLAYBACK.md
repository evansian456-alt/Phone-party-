# Direct R2/CDN Playback - Quick Reference

## What Changed?
Single function added to enable direct audio streaming from R2/CDN instead of proxying through Railway.

## The Function
```javascript
function getPlaybackUrl({ trackId, key }) {
  // 1. CDN_BASE_URL (if set) → https://cdn.example.com/tracks/ABC123.mp3
  // 2. S3_PUBLIC_BASE_URL (if set) → https://pub-xxx.r2.dev/tracks/ABC123.mp3  
  // 3. PUBLIC_BASE_URL + /api/track → https://app.railway.app/api/track/ABC123
  // 4. Dev fallback → /api/track/ABC123
}
```

## Usage
```javascript
// Upload endpoint (ONLY place trackUrl is generated)
const trackUrl = getPlaybackUrl({
  trackId,           // e.g., "ABC123"
  key: uploadResult.key  // e.g., "tracks/ABC123.mp3"
});
```

## Configuration

### Development (No Changes Needed)
```bash
# No CDN/S3 variables set
# Audio proxies through /api/track/:id
```

### Production Option 1: R2 Public Bucket
```bash
S3_PUBLIC_BASE_URL=https://pub-a1b2c3d4e5f6.r2.dev
```
- Direct streaming from R2
- ~$0.36/TB egress
- No Railway bandwidth

### Production Option 2: CDN + R2 (Recommended)
```bash
CDN_BASE_URL=https://cdn.syncspeaker.com
S3_PUBLIC_BASE_URL=https://pub-a1b2c3d4e5f6.r2.dev  # Fallback
```
- Direct streaming from Cloudflare CDN
- Free egress
- Global edge caching

## Testing

### Quick Test
```bash
# 1. Upload a track
curl -X POST https://your-app.railway.app/api/upload-track \
  -F "audio=@test.mp3"

# 2. Check the trackUrl in response
# With CDN: https://cdn.example.com/tracks/ABC123.mp3
# Without: https://your-app.railway.app/api/track/ABC123

# 3. Try playing the trackUrl directly in browser
# Should stream audio
```

### Verify Bandwidth Savings
```bash
# Before (with proxy):
# Railway bandwidth = total audio streamed

# After (with CDN/R2):
# Railway bandwidth = API traffic only
# R2/CDN bandwidth = audio traffic
```

## Rollback

### Quick (30 seconds)
```bash
railway variables:delete CDN_BASE_URL
railway variables:delete S3_PUBLIC_BASE_URL
railway up
```

### Full (2 minutes)
```bash
git revert <commit-hash>
git push origin main
```

## Monitoring

### Key Metrics
- ✅ Railway bandwidth (should decrease)
- ✅ R2 GET operations (should increase)
- ✅ CDN cache hit rate (aim for >90%)
- ✅ Audio playback errors (should stay ~0%)

### Log Messages
```
[HTTP] Track will be accessible at: https://cdn.example.com/...
                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                  Shows which URL type used
```

## FAQ

**Q: Do I need to change anything in my app?**
A: No. This is server-side only. Clients already use trackUrl from upload response.

**Q: Will old tracks still work?**
A: Yes. The /api/track/:id route is preserved. Old and new URLs coexist.

**Q: What if my R2 bucket isn't public?**
A: Don't set S3_PUBLIC_BASE_URL. System falls back to /api/track proxy.

**Q: Can I test CDN locally?**
A: Yes. Set CDN_BASE_URL to any URL. getPlaybackUrl will generate URLs using it.

**Q: Does this cost more?**
A: R2 egress: ~$0.36/TB (cheaper than Railway bandwidth). CDN: Free with Cloudflare.

**Q: What about CORS?**
A: R2 and CDN must allow CORS for browser audio access. Configure in R2/CDN settings.

**Q: Can I use AWS S3 instead of R2?**
A: Yes. Set S3_PUBLIC_BASE_URL to your S3 bucket's public URL.

## Implementation Notes

### Why Only Update Upload Endpoint?
- Upload is the ONLY place trackUrl is created
- All other endpoints receive trackUrl from client
- Client got trackUrl from upload response
- No need to regenerate anywhere else

### Key Design Decisions
1. **Priority order**: CDN > S3 > Proxy (most efficient first)
2. **Trailing slash handling**: Automatically removed
3. **Validation**: Requires both trackId and key
4. **Backwards compat**: Falls back to /api/track when not configured

### Security
- ✅ No secrets in URLs
- ✅ trackUrl already public (clients need it)
- ✅ R2 bucket security unchanged
- ✅ No new attack vectors

## Files Changed
- `server.js`: +47 lines (getPlaybackUrl function + usage)
- `.env.example`: +5 lines (documentation)
- `getplaybackurl.test.js`: +299 lines (tests)
- `DIRECT_CDN_PLAYBACK_IMPLEMENTATION.md`: +303 lines (docs)

**Total**: 654 lines added, 10 lines removed

## Status
✅ **PRODUCTION READY**
- Backwards compatible
- Tested and documented
- Rollback plan ready
- No breaking changes
