# Phone Party

**Turn your phones into one massive speaker**

Browser prototype for Phone Party — Connect multiple phones together and play music in perfect sync. Create an epic sound experience for parties, gatherings, or just hanging out with friends!

## 🎵 What is Phone Party?

Phone Party lets you connect multiple phones together to play music in perfect synchronization. Take control with DJ mode, queue your tracks, and get real-time reactions from your guests. Everything you need to be the ultimate party host.

## ✨ Key Features

- **🎧 DJ Mode**: Full-screen DJ interface with visualizers and controls. Professional visual effects and real-time feedback.
- **⏭️ Up Next Queue**: Queue your next track and see what's coming up. Seamless transitions keep the party flowing.
- **💬 Guest Reactions**: Friends can send reactions directly to the DJ's screen with real-time crowd feedback.
- **📱 Browser-Ready**: Test instantly in your browser or run with full multi-device sync. No app store required.
- **🎶 Multi-Device Sync**: Music plays in perfect sync across all connected devices.
- **👥 Party Management**: Host controls, guest management, and party codes for easy joining.
- **🔊 Background Audio**: Music continues playing when the app is in the background, with lock screen controls.

## 💎 Pricing

| Plan | Price | Features |
|------|-------|----------|
| **Free Plan** | Free | • Up to 2 phones<br>• Basic features<br>• Includes ads |
| **Party Pass** 🎉 | £3.99 | • 2-hour session (single-use)<br>• Up to 4 phones<br>• Chat + emoji reactions<br>• DJ quick message buttons<br>• Guest quick replies<br>• Auto party prompts<br>• Party-wide unlock |
| **Pro Monthly** | £9.99/month | • Up to 10 phones<br>• No ads<br>• Pro DJ mode with visualizers<br>• Guest reactions & messaging<br>• Up Next queue system<br>• Priority sync stability<br>• Quality override warnings<br>• Speaker support<br>• Cancel anytime |

**Note**: Party Pass is a single-use purchase that unlocks Pro features for all guests in one party for 2 hours.

**Pro Monthly** is now available via **Stripe Checkout** on the web. See [docs/stripe-billing.md](docs/stripe-billing.md) for setup instructions.

## 📚 Documentation

### 👥 User Documentation
**New user or need help?** Start here:
- **[docs/USER_HELP_GUIDE.md](docs/USER_HELP_GUIDE.md)** - **📖 Complete user guide** - Everything you need to know
  - Quick start guide for hosts and guests
  - Troubleshooting common issues
  - Best practices and tips
- **[docs/KEYBOARD_SHORTCUTS.md](docs/KEYBOARD_SHORTCUTS.md)** - **⌨️ Keyboard shortcuts reference** - DJ mode shortcuts
- **[FAQ.md](FAQ.md)** - **❓ Frequently asked questions** including:
  - How will this app perform on Android?
  - How does it compare to AmpMe?
  - Technical questions and deployment options

### 🚀 What's Next? (START HERE!)
**Looking to see what's next for this app?** Check out:
- **[ROADMAP_VISUAL.md](ROADMAP_VISUAL.md)** - **📍 START HERE!** Visual guide to 3 paths forward with decision tree
- **[NEXT_STEPS.md](NEXT_STEPS.md)** - Comprehensive roadmap with detailed implementation plans

### 🚀 Improvement Guides
**Looking to improve or understand the codebase?** Start here:
- **[MISSING_FEATURES.md](MISSING_FEATURES.md)** - **📋 Complete list of identified gaps and missing features** (NEW!)
- **[IMPROVEMENT_GUIDE_INDEX.md](IMPROVEMENT_GUIDE_INDEX.md)** - Navigation guide for all improvements
- **[IMPROVEMENT_SUMMARY.md](IMPROVEMENT_SUMMARY.md)** - Quick reference: critical issues, quick wins, metrics
- **[ACTION_PLAN.md](ACTION_PLAN.md)** - Step-by-step roadmaps (Quick Launch, Sustainable Codebase, Understanding)
- **[ARCHITECTURE_VISUAL.md](ARCHITECTURE_VISUAL.md)** - Visual diagrams of current vs. proposed architecture
- **[IMPROVEMENT_SUGGESTIONS.md](IMPROVEMENT_SUGGESTIONS.md)** - Comprehensive analysis with code examples

### 👨‍💻 Developer Documentation
**Contributing or deploying?** Check out:
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - **🤝 Contributing guide** - Code style, testing, PR process
- **[docs/API_REFERENCE.md](docs/API_REFERENCE.md)** - **📡 API documentation** - Complete REST API reference
- **[docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md)** - **🚀 Deployment guide** - Legacy deployment instructions

### 🚀 Production Deployment (NEW!)
**Ready to deploy to production?** Start here:
- **[docs/PRODUCTION_CHECKLIST.md](docs/PRODUCTION_CHECKLIST.md)** - **✅ START HERE!** - Complete pre-launch checklist
- **[docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)** - **🔐 Environment variables** - Complete reference for all config
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** - **📖 Deployment guide** - Platform-agnostic deployment instructions
- **[docs/HEALTH_CHECKS.md](docs/HEALTH_CHECKS.md)** - **❤️ Health checks** - Monitoring and operational readiness
- **[docs/DOCKER.md](docs/DOCKER.md)** - **🐳 Docker guide** - Container deployment instructions

### Sync System Documentation
For a comprehensive explanation of how the multi-device synchronization works, see:
- **[docs/SYNC_ARCHITECTURE_EXPLAINED.md](docs/SYNC_ARCHITECTURE_EXPLAINED.md)** - Complete explanation of the sync architecture
  - How host controls playback and broadcasts state to guests
  - Multi-level drift detection and correction strategies
  - Clock synchronization protocol (NTP-like)
  - Manual sync button implementation and use cases
  - Role-based permissions (host vs guest)

### Background Audio Feature
- **[docs/BACKGROUND_AUDIO.md](docs/BACKGROUND_AUDIO.md)** - Background audio playback documentation
  - Media Session API integration
  - Lock screen controls
  - Browser compatibility
  - Troubleshooting guide

### Add-ons & Optional Upgrades
- **[docs/ADD_ONS_USER_GUIDE.md](docs/ADD_ONS_USER_GUIDE.md)** - **💎 Complete guide to Phone Party add-ons**
  - Visual Packs, Profile Upgrades, DJ Titles, Party Extensions, and Hype Effects
  - What each add-on does, how it works, and what happens when you buy it
  - Pricing, use cases, strategic recommendations, and FAQs
- **[docs/ADD_ONS_VISUAL_REFERENCE.md](docs/ADD_ONS_VISUAL_REFERENCE.md)** - **🎨 Where effects appear and what they look like**
  - Exact UI locations for each add-on type
  - Visual descriptions, animations, colors, and effects
  - Technical rendering details and implementation
- **[docs/ADD_ONS_QUICK_REFERENCE.md](docs/ADD_ONS_QUICK_REFERENCE.md)** - Quick reference card for add-ons

### Technical Documentation
- **[SYNCSPEAKER_AMPSYNC_DOCS.md](SYNCSPEAKER_AMPSYNC_DOCS.md)** - AmpSync+ technical documentation
- **[AMPSYNC_QUICK_REF.md](AMPSYNC_QUICK_REF.md)** - Quick reference guide
- **[docs/guides/HOUSE_PARTY_SYNC_README.md](docs/guides/HOUSE_PARTY_SYNC_README.md)** - User guide for sync system

## 📶 Important Information

- **Connection**: Hotspot or Wi-Fi recommended for best connection quality
- **Music Source**: You provide the music — this app syncs playback. Music files come from your device (local files, Spotify, YouTube, etc.)
- **Browser Compatibility**: Works in modern browsers with Web Audio API support

## 🔧 PR Conflict Resolution

**If you're here to resolve PR conflicts**, see **[QUICK_START.md](QUICK_START.md)** for simple instructions.

PR #28 and PR #26 had merge conflicts that have been resolved. The resolved files and instructions are in this repository.

---

## Getting Started

### Quick Start (Browser-Only Mode)

For **single-device testing** without installing dependencies:

1. Open `index.html` directly in your browser, or
2. Use Python's built-in HTTP server:
   ```bash
   python3 -m http.server 8080
   # Then open http://localhost:8080
   ```

**Browser-Only Features:**
- ✅ Landing page and UI testing
- ✅ Create party (local/offline mode)
- ✅ Music file selection and playback
- ✅ Party Pass activation (simulated)
- ✅ Single-device party experience

**Limitations in Browser-Only Mode:**
- ❌ Multi-device sync (requires server)
- ❌ Join party from other devices
- ❌ WebSocket real-time updates

### Full Installation (Multi-Device Mode)

For **multi-device testing** with real-time sync:

#### Prerequisites
- Node.js (v14 or higher)
- Redis server (required for multi-instance party discovery)
- PostgreSQL 12+ (required for user accounts, subscriptions, and purchases)

#### Database Setup
See [db/README.md](db/README.md) for database schema setup instructions.

Quick start:
```bash
# Create database
createdb phoneparty

# Apply schema
psql -d phoneparty -f db/schema.sql
```

#### Redis Setup
See [REDIS_SETUP.md](REDIS_SETUP.md) for detailed installation and configuration instructions.

Quick start:
```bash
# Ubuntu/Debian
sudo apt-get install redis-server
sudo systemctl start redis-server

# macOS
brew install redis
brew services start redis

# Docker
docker run -d -p 6379:6379 redis:7-alpine
```

#### Server Setup
```bash
npm install
npm start
# or for development
npm run dev
```

The server will start on `http://localhost:8080`

**Full Server Features:**
- ✅ All browser-only features
- ✅ Multi-device party sync
- ✅ Join party from other devices
- ✅ WebSocket real-time updates
- ✅ Party state management
- ✅ Cross-instance party discovery (via Redis)

#### Configuration
Copy `.env.example` to `.env` and customize if needed:
```bash
cp .env.example .env
```

Default configuration connects to Redis at `localhost:6379` and PostgreSQL at `localhost:5432`. See [REDIS_SETUP.md](REDIS_SETUP.md) and [db/README.md](db/README.md) for production configuration.

## Production Deployment (Railway)

Phone Party requires Redis for multi-device party discovery and synchronization. Follow these steps to deploy on Railway:

### 1. Add Redis Plugin

1. Go to your Railway project dashboard
2. Click **"+ New"** → **"Database"** → **"Add Redis"**
3. Railway will automatically provision a Redis instance and set the `REDIS_URL` environment variable

### 2. Verify REDIS_URL

1. Go to your app service in Railway
2. Click on **"Variables"** tab
3. Confirm that `REDIS_URL` is set (it should be automatically linked from the Redis plugin)
4. The URL format should be: `redis://default:[password]@[host]:[port]`

### 3. Deploy Your App

Railway will automatically deploy your app with Redis connected. 

### 4. Health Check

After deployment, verify Redis connection:
```bash
curl https://your-app.railway.app/health
```

Expected response:
```json
{
  "status": "ok",
  "instanceId": "server-abc123",
  "redis": "connected",
  "version": "0.1.0-party-fix"
}
```

**Important**: If `redis` shows `"missing"` or `"error"`, party creation will fail. Check your Railway Redis plugin configuration.

### Common Issues

- **Redis shows "missing"**: The `REDIS_URL` environment variable is not set. Add the Redis plugin in Railway.
- **Redis shows "error"**: Redis connection failed. Check Redis plugin status and network connectivity.
- **Party creation returns 503**: Redis is not ready. Wait a few seconds for Redis to connect, or check logs.

### 5. Set JWT_SECRET for Stable Authentication

**Required for all production-like deployments** (Railway, Cloud Run, or any environment with `REDIS_URL` or `RAILWAY_ENVIRONMENT` set).

```
JWT_SECRET=replace_with_long_random_string_at_least_32_chars
```

> **Important**: Deployments with multiple instances (Cloud Run, Railway, etc.) **must use the same `JWT_SECRET` for all instances**. Using a different or missing secret per instance will cause login tokens to be rejected after signup (auth bounce-back), since tokens signed by one instance cannot be verified by another.

Generate a secure secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

If `JWT_SECRET` is missing in a production-like environment, the server will refuse to start with a clear error message.

## Testing

This project includes a comprehensive test suite for server-side functions and utilities.

### Running Tests

Run all tests:
```bash
npm test
```

Run tests in watch mode (auto-rerun on file changes):
```bash
npm run test:watch
```

Run tests with coverage report:
```bash
npm run test:coverage
```

### E2E Tests

E2E (end-to-end) tests use [Playwright](https://playwright.dev/) and require both **Redis** and the **app server** to be running.  The `npm run test:e2e` command handles all of this automatically — you do not need to start anything manually.

#### Running E2E Tests Locally

```bash
# Headless (default) — auto-starts Redis via Docker if not already running
npm run test:e2e

# Visible browser
npm run test:e2e:headed

# Interactive Playwright UI
npm run test:e2e:ui
```

**What happens under the hood** (`scripts/e2e-runner.js`):

1. **Redis boot** — Checks whether Redis is reachable at `REDIS_URL` (default `redis://localhost:6379`).  If not, it starts a temporary Docker container (`redis:6-alpine`) automatically.  If `REDIS_URL` is explicitly set but unreachable, it fails fast with a clear error.
2. **Server boot** — Spawns `node server.js` with `NODE_ENV=test` on a free port.
3. **Readiness gating** — Polls Redis (`PING`) and the server (`/health`) with 500 ms intervals until both respond, or times out (Redis: 30 s, server: 60 s).  No fixed sleeps.
4. **Tests** — Runs Playwright.  `BASE_URL` is passed automatically.
5. **Teardown** — Kills the server process and (if started) removes the Redis container, even on test failure or Ctrl-C.

#### Required Environment Variables

| Variable | Default (test mode) | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string.  If unset, Docker Redis is started automatically. |
| `DATABASE_URL` | — | Postgres connection string (required for party/user features). |
| `JWT_SECRET` | built-in test secret | Must be set to a real secret in CI/production. |
| `SERVER_PORT` | random free port | Pin the app port (optional). |
| `BASE_URL` | set by runner | Override the Playwright base URL (optional). |

#### How CI Provisions Redis and the Server

The `.github/workflows/ci.yml` `e2e` job:

- Provisions **Redis** as a GitHub Actions service container (`redis:6`) with a health-check — guaranteed ready before any step runs.
- Provisions **Postgres** as a GitHub Actions service container (`postgres:12`) with a health-check.
- Sets `REDIS_URL=redis://localhost:6379` in the environment so the runner knows Redis is already available (skips Docker start).
- Runs `npm run test:e2e` — the runner starts the server, waits for readiness, runs Playwright, and tears down.

No `|| true` is used; a failing E2E test fails the CI job.



Current test coverage:
- **111 tests** covering:
  - HTTP endpoints (health check, ping, create party, join party, leave party, end party, party state)
  - Static file serving
  - Server-side utilities (party code generation)
  - Client-side utilities (HTML escaping, file size formatting, hashing)
  - Party management (guest join/leave, party end, expiry handling)
  - Multi-instance Redis sync

Tests are located in:
- `server.test.js` - HTTP endpoint tests (85 tests)
- `utils.test.js` - Utility function tests (26 tests)

## Manual Testing Checklist

Use this checklist to verify all features are working correctly before deployment or release.

### Browser-Only Mode Testing
- [ ] **Landing Page**
  - [ ] Page loads without errors
  - [ ] All buttons and UI elements are visible
  - [ ] Party Pass pricing information displays correctly
  
- [ ] **Create Party (Browser-Only)**
  - [ ] Click "Start Party" button
  - [ ] Party code is generated and displayed
  - [ ] Party interface loads correctly
  - [ ] Music file selection dialog opens
  
- [ ] **Music Playback (Single Device)**
  - [ ] Select a music file from local device
  - [ ] Music plays correctly
  - [ ] Playback controls (play/pause/skip) work
  - [ ] Volume controls function properly
  
- [ ] **Party Pass Activation (Simulated)**
  - [ ] Party Pass modal can be opened
  - [ ] Simulated activation completes successfully
  - [ ] Pro features are unlocked (if implemented)

### Multi-Device Sync Testing

#### Prerequisites
- [ ] Node.js server is running (`npm start`)
- [ ] Redis server is connected (verify with `/health` endpoint)
- [ ] At least 2 devices are available for testing

#### Party Creation and Join Flow
- [ ] **Host Device - Create Party**
  - [ ] Navigate to app URL
  - [ ] Click "Start Party"
  - [ ] Party code is displayed (6 characters)
  - [ ] "Waiting for guests..." message appears
  - [ ] Party code can be copied/shared
  
- [ ] **Guest Device - Join Party**
  - [ ] Navigate to app URL
  - [ ] Click "Join Party"
  - [ ] Enter party code
  - [ ] Optional: Enter nickname
  - [ ] Click "Join party" button
  - [ ] Transition to "Joined Party" screen (NOT stuck on "Joining...")
  - [ ] Party code is displayed
  - [ ] Guest count is shown
  - [ ] Time remaining countdown is visible
  
- [ ] **Host Device - Guest Joined**
  - [ ] Guest count updates from "Waiting for guests..." to "1 guest joined"
  - [ ] Update occurs within 1-3 seconds
  - [ ] Guest nickname appears in guest list (if provided)

#### Multi-Guest Testing
- [ ] **Add Second Guest**
  - [ ] Third device joins the same party
  - [ ] Both existing devices show updated guest count
  - [ ] All devices show correct time remaining
  
- [ ] **Polling Updates**
  - [ ] Guest count updates on all devices every 2 seconds
  - [ ] Time remaining counts down synchronously
  - [ ] No polling errors in browser console

#### Music Sync Testing
- [ ] **Host Plays Music**
  - [ ] Host selects and plays a music file
  - [ ] All guest devices receive playback notification
  - [ ] Music plays in sync across all devices
  - [ ] Playback position stays synchronized
  
- [ ] **Playback Controls**
  - [ ] Host pauses - all devices pause
  - [ ] Host resumes - all devices resume
  - [ ] Host skips track - all devices skip
  - [ ] Volume changes sync across devices

#### DJ Mode Testing
- [ ] **DJ Mode Activation**
  - [ ] Host activates DJ mode
  - [ ] Full-screen DJ interface appears
  - [ ] Visualizers are displayed and respond to music
  - [ ] DJ controls are accessible
  
- [ ] **Up Next Queue**
  - [ ] Queue interface is visible
  - [ ] Tracks can be added to queue
  - [ ] Queue updates across all devices
  - [ ] Track transitions happen smoothly

#### Guest Reactions Testing
- [ ] **Send Reaction**
  - [ ] Guest device can access reactions
  - [ ] Guest sends a reaction (emoji/message)
  - [ ] Host receives reaction in real-time
  - [ ] Reaction appears on DJ screen
  
- [ ] **Multiple Reactions**
  - [ ] Multiple guests can send reactions simultaneously
  - [ ] All reactions appear on host screen
  - [ ] Reactions don't cause performance issues

#### Leave and End Party Flow
- [ ] **Guest Leaves Party**
  - [ ] Guest clicks "Leave Party" button
  - [ ] Guest returns to landing page
  - [ ] Host sees guest count decrement within 1-3 seconds
  - [ ] Remaining guests see updated count
  
- [ ] **Host Ends Party**
  - [ ] Host clicks "End Party" or "Leave" button
  - [ ] All guests see "Party has ended" message
  - [ ] All guests return to landing page
  - [ ] Party cannot be rejoined after ending

#### Error Handling
- [ ] **Invalid Party Code**
  - [ ] Enter non-existent party code
  - [ ] Appropriate error message is displayed
  - [ ] User can retry with different code
  
- [ ] **Expired Party**
  - [ ] Join party that expired (after party TTL duration)
  - [ ] "Party not found or expired" error appears
  - [ ] User is redirected appropriately
  
- [ ] **Network Interruption**
  - [ ] Disable network mid-session
  - [ ] App shows connection lost indicator
  - [ ] Re-enable network
  - [ ] App reconnects and resumes

### Railway Deployment Testing

- [ ] **Health Check**
  - [ ] Navigate to `https://your-app.railway.app/health`
  - [ ] Response shows `"status": "ok"`
  - [ ] Response shows `"redis": "connected"`
  - [ ] Instance ID is present
  
- [ ] **Redis Connection**
  - [ ] REDIS_URL environment variable is set
  - [ ] Redis plugin is running in Railway dashboard
  - [ ] No Redis connection errors in logs
  
- [ ] **Create Party (Production)**
  - [ ] Create party on deployed app
  - [ ] Party code is generated
  - [ ] No 503 errors
  - [ ] Check Railway logs for successful creation
  
- [ ] **Join Party (Production)**
  - [ ] Guest joins party on deployed app
  - [ ] Join succeeds immediately
  - [ ] Check Railway logs for:
    - `POST /api/create-party` success
    - `POST /api/join-party` success
    - Correct party code in logs
  
- [ ] **Multi-Instance Testing** (if applicable)
  - [ ] Multiple Railway instances are running
  - [ ] Party created on instance A
  - [ ] Guest joins on instance B
  - [ ] Party state syncs via Redis
  - [ ] All features work across instances

### Performance Testing

- [ ] **Load Testing**
  - [ ] Test with maximum guests (per plan limit)
  - [ ] All guests receive updates
  - [ ] No significant lag or delays
  - [ ] Server remains responsive
  
- [ ] **Long Session Testing**
  - [ ] Party runs for extended period (30+ minutes)
  - [ ] No memory leaks
  - [ ] Polling continues reliably
  - [ ] Time remaining countdown is accurate

### Browser Compatibility

- [ ] **Desktop Browsers**
  - [ ] Chrome/Edge (latest)
  - [ ] Firefox (latest)
  - [ ] Safari (latest)
  
- [ ] **Mobile Browsers**
  - [ ] iOS Safari
  - [ ] Android Chrome
  - [ ] Responsive design works on all screen sizes

### Security Testing

- [ ] **Input Validation**
  - [ ] Party codes are validated (6 characters)
  - [ ] Nicknames are sanitized (HTML escaping)
  - [ ] Invalid inputs are rejected
  
- [ ] **Authorization**
  - [ ] Only host can end party
  - [ ] Only host can access DJ controls
  - [ ] Guests cannot perform host-only actions

## API Endpoints

### GET /health
Returns server health status and Redis connection state
```json
{
  "status": "ok",
  "instanceId": "server-abc123",
  "redis": "connected",
  "version": "0.1.0-party-fix"
}
```

Redis status values:
- `"connected"` - Redis is connected and ready
- `"missing"` - Redis configuration not found (REDIS_URL not set)
- `"error"` - Redis connection error (includes `redisError` field with details)

### GET /api/ping
Ping endpoint for testing connectivity
```json
{ "message": "pong", "timestamp": 1234567890 }
```

### POST /api/create-party
Creates a new party and returns a party code
```json
Response: { "partyCode": "ABC123", "hostId": 1 }
```

### POST /api/join-party
Join an existing party
```json
Request: { 
  "partyCode": "ABC123",
  "nickname": "Guest1" // optional
}
Response: { 
  "ok": true,
  "guestId": "guest-1",
  "nickname": "Guest1",
  "partyCode": "ABC123"
}
```

Error responses:
- `400` - Party code required or invalid length
- `404` - Party not found or expired
- `410` - Party has ended or expired
- `503` - Server not ready (Redis unavailable)

### GET /api/party
Get current party state with guests
```json
Request: GET /api/party?code=ABC123

Response: {
  "exists": true,
  "partyCode": "ABC123",
  "status": "active",
  "expiresAt": 1234567890000,
  "timeRemainingMs": 7200000,
  "guestCount": 2,
  "guests": [
    {
      "guestId": "guest-1",
      "nickname": "Guest1",
      "joinedAt": 1234567890000
    }
  ],
  "chatMode": "OPEN",
  "createdAt": 1234567890000
}
```

Query parameters:
- `code` - Party code (required)
- `t` - Cache buster timestamp (optional, recommended)

Status values:
- `"active"` - Party is active and accepting guests
- `"ended"` - Party was ended by host
- `"expired"` - Party TTL expired (2 hours)

### POST /api/leave-party
Remove guest from party
```json
Request: {
  "partyCode": "ABC123",
  "guestId": "guest-1"
}
Response: {
  "ok": true,
  "guestCount": 1
}
```

### POST /api/end-party
End party (host only)
```json
Request: { "partyCode": "ABC123" }
Response: { "ok": true }
```

After ending, the party status is set to "ended" and remains accessible for 5 minutes before being deleted.

## How to Test with Two Phones

This guide will help you verify that multi-device sync works correctly.

### Prerequisites
1. Both phones must be on the same network as the server, OR
2. Server must be deployed to Railway with a public URL

### Testing Steps

#### Option 1: Local Network (Development)
1. **Start the server** on your computer:
   ```bash
   npm start
   ```
   Note the local IP address (e.g., `http://192.168.1.100:8080`)

2. **Phone 1 (Host)**:
   - Open browser and navigate to `http://[your-ip]:8080`
   - Click "Start Party"
   - Note the 6-character party code displayed
   - You should see "Waiting for guests..."

3. **Phone 2 (Guest)**:
   - Open browser and navigate to `http://[your-ip]:8080`
   - Click "Join Party"
   - Enter the party code from Phone 1
   - Click "Join party"

4. **Verification**:
   - **Phone 2** should show "Joined Party" screen with party code and guest count
   - **Phone 1** should update within 1-3 seconds showing "1 guest joined"
   - Both phones should show time remaining countdown

#### Option 2: Railway Deployment (Production)
1. **Deploy to Railway** (see Production Deployment section above)
2. **Phone 1 (Host)**:
   - Open `https://your-app.railway.app`
   - Click "Start Party"
   - Note the party code

3. **Phone 2 (Guest)**:
   - Open `https://your-app.railway.app`
   - Click "Join Party"
   - Enter the party code
   - Click "Join party"

4. **Verification**:
   - Same as Option 1 above

### What Success Looks Like

✅ **Guest Join Flow**:
- Guest enters code → clicks Join → sees "Joined Party" screen (not stuck on "Joining...")
- Guest screen shows: party code, guest count, time remaining
- Host sees guest count update from "Waiting for guests..." to "1 guest joined" within 1-3 seconds

✅ **Polling Updates**:
- When a second guest joins, both phones update guest count
- Time remaining counts down on both phones
- Updates happen every 2 seconds

✅ **Leave/End Flow**:
- Guest clicks "Leave Party" → returns to landing page
- Host sees guest count decrement within 1-3 seconds
- Host clicks "Leave" → party ends for everyone
- All guests see "Party has ended" and return to landing page

### Viewing Railway Logs

To confirm joins are working on Railway:
1. Go to Railway dashboard → your app service
2. Click "Deployments" tab → Latest deployment → "View Logs"
3. Look for log entries like:
   ```
   [HTTP] POST /api/create-party at [timestamp]
   [HTTP] Party created: ABC123, hostId: 1
   [HTTP] POST /api/join-party at [timestamp]
   [HTTP] Party joined: ABC123, guestId: guest-1, guestCount: 1
   ```

### Troubleshooting

**Guest stuck on "Joining..."**:
- ✅ Fixed! Guest now transitions immediately to "Joined Party" screen
- Check browser console for errors

**Host doesn't see guest join**:
- Check if polling is working (should see GET /api/party requests in Network tab)
- Verify Redis is connected (check /health endpoint)
- Check Railway logs for join-party success

**"Party not found" error**:
- Party may have expired (2 hour TTL)
- Host may have ended the party
- Check party code is correct (case-insensitive, 6 characters)

## WebSocket API

The application also supports WebSocket connections for real-time party management.

WebSocket message types:
- `CREATE` - Create a new party
- `JOIN` - Join an existing party
- `KICK` - Kick a member (host only)
- `SET_PRO` - Set Pro status
- `ROOM` - Broadcast room state updates
- `ENDED` - Party ended notification


---

## 📱 Mobile Builds (Capacitor)

Phone Party ships as a PWA and can be packaged as a native Android / iOS app using [Capacitor](https://capacitorjs.com/).

### Prerequisites

Install the Capacitor CLI and platform dependencies:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap init "Phone Party" com.houseparty.syncspeaker --web-dir public
```

> The `capacitor.config.json` at the repo root is already pre-filled with the correct `appId`, `appName`, and `webDir`.

### Sync web assets to native projects

After any frontend change, copy the latest web files into the native platforms:

```bash
npm run cap:sync   # equivalent to: npx cap sync
```

### Android (Android Studio)

1. Install [Android Studio](https://developer.android.com/studio).
2. Run `npm run cap:android` to open the project in Android Studio.
3. Connect a device or start an emulator.
4. Click **Run ▶** in Android Studio.

To run directly from the terminal:

```bash
npm run cap:run:android
```

### iOS (Xcode)

1. Install [Xcode](https://developer.apple.com/xcode/) (macOS only).
2. Run `npm run cap:ios` to open the project in Xcode.
3. Select your target device or simulator.
4. Click **Run ▶** in Xcode.

To run directly from the terminal:

```bash
npm run cap:run:ios
```

### Connecting to the Cloud Run backend

By default `capacitor.config.json` omits the `server` block so the native app loads its own bundled web files. To point a build at a live Cloud Run backend, add a `server` block temporarily (do **not** commit it):

```json
{
  "server": {
    "url": "https://YOUR_CLOUD_RUN_URL"
  }
}
```

Only add `"cleartext": true` if your backend is HTTP (not HTTPS). For production Cloud Run deployments this is never needed.

---

## 🏗️ App State Machine

View switching is managed by `ui/stateMachine.js`.  All auth-gated navigation goes through:

```js
window.AppStateMachine.transitionTo(window.AppStateMachine.STATES.PARTY_HUB);
```

| State | View shown | Header nav |
|---|---|---|
| `LOGGED_OUT` | Landing page | Hidden |
| `PROFILE_INCOMPLETE` | Complete Profile form | Visible |
| `PARTY_HUB` | Create / Join party hub | Visible |
| `IN_PARTY` | Party session view | Visible |

Tests live in `nav-auth.test.js` and use jest-environment-jsdom.
