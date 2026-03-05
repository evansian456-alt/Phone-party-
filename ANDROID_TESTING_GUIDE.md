# Android Testing Guide for Phone Party

## Quick Summary

This guide provides a comprehensive testing checklist for validating Phone Party on Android devices. Use this before launching the PWA to production.

---

## Device Testing Matrix

### Priority 1: Essential Devices (Must Test)

| Device Type | Example Model | Screen Size | Android Version | Priority |
|-------------|--------------|-------------|-----------------|----------|
| **Flagship Phone** | Pixel 7, Galaxy S22 | 1080x2400 | Android 13+ | HIGH |
| **Mid-Range Phone** | Pixel 6a, Galaxy A53 | 1080x2340 | Android 12+ | HIGH |
| **Budget Phone** | Moto G Power, Galaxy A13 | 720x1600 | Android 11+ | MEDIUM |
| **Tablet** | Galaxy Tab A8, Pixel Tablet | 1920x1200 | Android 12+ | MEDIUM |

### Priority 2: Browser Testing

Test on the following browsers (in order of priority):
1. **Chrome** (primary - 70% of Android users)
2. **Samsung Internet** (20% of Android users)
3. **Firefox** (5% of Android users)
4. **Edge** (3% of Android users)

---

## Pre-Testing Checklist

- [ ] App is deployed to production/staging server
- [ ] HTTPS is enabled (required for PWA features)
- [ ] All environment variables are set (SENTRY_DSN, GA_MEASUREMENT_ID)
- [ ] Service worker is registered and caching properly
- [ ] Test accounts created (1 host, 3+ guests)

---

## Functional Testing

### 1. PWA Installation

**Test Steps:**
- [ ] Open app in Chrome on Android
- [ ] Tap the "Add to Home Screen" prompt
- [ ] Verify icon appears on home screen
- [ ] Launch app from home screen
- [ ] Verify app opens in standalone mode (no browser UI)
- [ ] Check app icon and splash screen appearance

**Expected Results:**
- ✅ App installs without errors
- ✅ Icon shows correct branding
- ✅ App opens in fullscreen/standalone mode
- ✅ Splash screen displays correctly

**Known Issues:**
- Some Android versions may not show install prompt automatically
- Workaround: Use browser menu → "Add to Home Screen"

---

### 2. Party Creation (Host)

**Test Steps:**
- [ ] Sign up / log in as host
- [ ] Navigate to tier selection
- [ ] Select FREE tier
- [ ] Create a party
- [ ] Upload a music track (MP3)
- [ ] Verify party code is generated
- [ ] Verify QR code displays

**Expected Results:**
- ✅ Party created successfully
- ✅ 6-digit party code generated
- ✅ QR code displays and is scannable
- ✅ Track uploads without errors
- ✅ Track appears in queue

**Android-Specific Checks:**
- Audio file picker works correctly
- File upload completes on slow networks (3G/4G)
- No memory errors on low-RAM devices

---

### 3. Party Join (Guest)

**Test Steps:**
- [ ] Open app on second device
- [ ] Sign up / log in as guest (or use guest mode)
- [ ] Enter party code OR scan QR code
- [ ] Join party successfully
- [ ] Verify guest appears in party members list
- [ ] Verify host sees new guest joined

**Expected Results:**
- ✅ Party joins without errors
- ✅ QR code scanning works (camera permission granted)
- ✅ Guest UI displays correctly
- ✅ Connection status shows "Connected"

**Android-Specific Checks:**
- QR code scanner requests camera permission properly
- Camera preview renders correctly
- Manual code entry works as fallback

---

### 4. Audio Playback & Sync

**Test Steps:**
- [ ] Host starts playback
- [ ] Verify audio plays on host device
- [ ] Verify audio plays on all guest devices
- [ ] Check sync accuracy (use timer/stopwatch)
- [ ] Pause and resume playback
- [ ] Skip to next track
- [ ] Adjust volume on individual devices

**Expected Results:**
- ✅ Audio plays on all devices within 100ms of each other
- ✅ Pause/resume works synchronously
- ✅ Track changes sync across devices
- ✅ Volume controls work independently

**Android-Specific Checks:**
- AudioContext initializes after user gesture
- No audio glitches or stuttering
- Playback survives screen rotation
- Audio doesn't cut out when switching apps (if in foreground)

**Performance Targets:**
- **Sync accuracy:** ±100ms (excellent), ±200ms (good), >300ms (needs investigation)
- **Latency:** Audio starts within 500ms of play command
- **Drift:** Less than 50ms drift per minute

---

### 5. Network Transition Testing

**Critical for Android:** Test how app handles network changes

**Test Steps:**
- [ ] Start party on WiFi
- [ ] Disable WiFi, enable mobile data (4G/5G)
- [ ] Verify WebSocket reconnects automatically
- [ ] Verify audio continues playing
- [ ] Switch back to WiFi
- [ ] Verify connection remains stable

**Expected Results:**
- ✅ WebSocket reconnects within 5 seconds
- ✅ Playback continues after reconnection
- ✅ No manual intervention required
- ✅ Sync re-establishes quickly

**Android-Specific Checks:**
- Exponential backoff reconnection works (1s, 2s, 4s, 8s, etc.)
- No crashes during network transitions
- Connection indicator updates accurately

---

### 6. Screen Rotation & Multi-Window

**Test Steps:**
- [ ] Rotate device from portrait to landscape
- [ ] Rotate back to portrait
- [ ] Test on device with split-screen mode
- [ ] Minimize app and return to it

**Expected Results:**
- ✅ Layout adapts to orientation changes
- ✅ No UI elements overlap or disappear
- ✅ Audio playback continues during rotation
- ✅ State persists when minimizing/restoring

**Android-Specific Checks:**
- No flashing or flickering during rotation
- Touch targets remain accessible in all orientations
- Split-screen mode works (if supported)

---

### 7. Purchase Flow (Stripe)

**Test Steps:**
- [ ] Navigate to store/upgrade section
- [ ] Select Party Pass or Pro Monthly
- [ ] Complete Stripe payment (use test card)
- [ ] Verify entitlement granted immediately
- [ ] Check max devices updated (4 or 10)
- [ ] Verify UI reflects new tier

**Expected Results:**
- ✅ Stripe payment UI loads correctly
- ✅ Payment completes without errors
- ✅ Tier upgrade applies instantly
- ✅ All party members see updated status

**Android-Specific Checks:**
- Payment UI renders properly on mobile
- Keyboard doesn't overlap input fields
- 3D Secure authentication works (if required)

**Test Cards (Stripe):**
- Success: `4242 4242 4242 4242`
- Decline: `4000 0000 0000 0002`
- 3D Secure: `4000 0027 6000 3184`

---

### 8. Performance Testing

**Test on Low-End Device (e.g., Moto G Power, 2GB RAM):**

**Test Steps:**
- [ ] Join party with 2 devices (FREE tier)
- [ ] Monitor CPU usage (use Android Studio Profiler or DevTools)
- [ ] Monitor memory usage
- [ ] Monitor network traffic
- [ ] Play party for 10 minutes continuously

**Performance Targets:**
- **CPU:** <15% average per device
- **Memory:** <50MB per device
- **Network:** ~12 Kbps per device
- **Battery drain:** <5% per 10 minutes

**Stress Test (Pro Tier - 10 Devices):**
- [ ] Connect 10 devices to single party
- [ ] Play audio for 5 minutes
- [ ] Check for lag, stuttering, or crashes
- [ ] Verify sync remains within ±200ms

**Expected Results:**
- ✅ No crashes or freezes
- ✅ Audio remains smooth
- ✅ UI remains responsive
- ✅ Sync accuracy acceptable (±200ms)

---

### 9. Battery Testing

**Test Steps:**
- [ ] Fully charge device
- [ ] Run party for 1 hour continuously
- [ ] Monitor battery level
- [ ] Repeat with screen off (if possible)

**Battery Targets:**
- **Active party (screen on):** 20-30% drain per hour
- **Background (screen off):** N/A for PWA (audio will pause)

**Android-Specific Checks:**
- No excessive wake locks
- App doesn't prevent battery saver mode
- No memory leaks over extended sessions

---

### 10. Touch & Gesture Testing

**Test Steps:**
- [ ] Test all buttons and controls
- [ ] Verify touch targets are >44x44px
- [ ] Test scrolling in all scrollable areas
- [ ] Test pinch-to-zoom (should be disabled)
- [ ] Test long-press (if applicable)

**Expected Results:**
- ✅ All buttons respond to tap
- ✅ No accidental taps
- ✅ Smooth scrolling
- ✅ No zoom interference

**Android-Specific Checks:**
- Touch latency <100ms
- No ghost touches
- Scrolling momentum feels natural

---

## CSS & Visual Testing

### Backdrop Blur Effects

**Test Steps:**
- [ ] Open app on Android Chrome
- [ ] Check modal backgrounds
- [ ] Check header/footer blur effects
- [ ] Compare to iOS (if available)

**Expected Results:**
- ✅ Blur effects render (may be less pronounced on Android)
- ✅ Fallback transparent background if blur not supported
- ✅ No visual glitches

**Known Limitations:**
- `backdrop-filter` support varies by Android version
- Android 10+: Full support
- Android 8-9: Partial support
- Android <8: No support (falls back to semi-transparent background)

---

## Security Testing

### HTTPS & Permissions

**Test Steps:**
- [ ] Verify app loads over HTTPS
- [ ] Test camera permission (QR code scanning)
- [ ] Test microphone permission (if using)
- [ ] Test storage permission (file uploads)

**Expected Results:**
- ✅ All permissions requested clearly
- ✅ App functions gracefully if permission denied
- ✅ HTTPS lock icon in browser

---

## Edge Cases & Error Handling

### Test Scenarios:

1. **Poor Network Conditions**
   - [ ] Enable network throttling (2G, 3G)
   - [ ] Verify app remains functional
   - [ ] Check for graceful degradation

2. **App Backgrounding**
   - [ ] Start party, minimize app
   - [ ] Wait 30 seconds
   - [ ] Return to app
   - [ ] Verify state persists (may lose audio)

3. **Incoming Phone Call**
   - [ ] Start party with audio playing
   - [ ] Receive phone call (or simulate)
   - [ ] Answer call
   - [ ] End call
   - [ ] Verify audio resumes (may need manual restart)

4. **Low Battery Mode**
   - [ ] Enable battery saver mode
   - [ ] Verify app still functions
   - [ ] Check for performance degradation

5. **Multiple Tabs**
   - [ ] Open app in two browser tabs
   - [ ] Verify no conflicts
   - [ ] Check which tab controls audio

---

## Accessibility Testing

**Test Steps:**
- [ ] Enable TalkBack (Android screen reader)
- [ ] Navigate through app with TalkBack
- [ ] Verify all buttons are labeled
- [ ] Test with large text (Android accessibility settings)

**Expected Results:**
- ✅ All interactive elements have labels
- ✅ Navigation is logical
- ✅ Text scales properly

---

## Regression Testing

After any code changes, re-test:
- [ ] PWA installation
- [ ] Party creation
- [ ] Audio sync (2-4 devices)
- [ ] Network transition
- [ ] Purchase flow

---

## Reporting Issues

When reporting bugs, include:
1. **Device:** Model, Android version, browser
2. **Steps to reproduce:** Detailed sequence
3. **Expected vs Actual:** What should happen vs what happens
4. **Screenshots/Video:** Visual evidence
5. **Console logs:** Open DevTools → Console tab
6. **Network logs:** DevTools → Network tab

Example Bug Report:
```
Device: Samsung Galaxy A53 (Android 13, Chrome 120)
Issue: Audio stutters during playback with 4 devices
Steps:
1. Create party as host
2. Join with 3 guests
3. Start playback
4. Observe audio stuttering after 30 seconds
Expected: Smooth playback
Actual: Stuttering every 5 seconds
Console: "WebSocket ping timeout" errors
```

---

## Test Completion Checklist

### Before Production Launch:

- [ ] Tested on 2+ Android devices (different manufacturers)
- [ ] Tested on Chrome and Samsung Internet
- [ ] PWA installation verified
- [ ] Audio sync accuracy <200ms on WiFi
- [ ] Network transitions handled gracefully
- [ ] Purchase flow completes successfully
- [ ] No critical bugs identified
- [ ] Performance targets met
- [ ] Accessibility checked
- [ ] Documentation updated

---

## Quick Commands

```bash
# Start local dev server
npm run dev

# Run PWA validation
npm run validate:pwa

# Run all tests
npm test

# Run E2E tests with Android emulator
npm run test:e2e -- --project=android-chrome
```

---

## Resources

- **Android Chrome DevTools:** chrome://inspect
- **PWA Testing:** [Lighthouse](https://developers.google.com/web/tools/lighthouse)
- **Network Throttling:** Chrome DevTools → Network tab
- **Device Testing:** [BrowserStack](https://www.browserstack.com/) or [LambdaTest](https://www.lambdatest.com/)

---

## Next Steps

After completing all tests:
1. Document any issues found
2. Fix critical bugs
3. Re-test affected areas
4. Update documentation
5. Deploy to production
6. Monitor analytics and error logs

---

**Last Updated:** February 16, 2026  
**Status:** Ready for manual testing  
**Contact:** Report issues via GitHub Issues
