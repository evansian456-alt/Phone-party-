# Platform Changes Audit & Verification Test Plan

_Generated: 2026-03-03 | Branch: `copilot/audit-platform-changes` | Repo: evansian456-alt/House-party-_

---

## 1. Executive Summary

**What is real vs. what was assumed:**

| Claim | Reality |
|---|---|
| Platform logos (YouTube, Spotify, SoundCloud) exist | ✅ **REAL** — SVG files at `public/assets/platform-logos/`, served via dedicated route with no-cache headers |
| Cloud Build deploys to `syncspeaker` in `us-central1` | ✅ **REAL** — `cloudbuild.yaml` targets `syncspeaker` + `us-central1` exclusively; zero references to `house-party` or `europe-west1` |
| Cache-busting for platform assets is implemented | ⚠️ **PARTIALLY** — `NO_CACHE` was set on the dedicated SVG route (`server.js:961`) BUT `express.static` at line 773 intercepted all SVG requests first and did NOT set `no-cache`; **fixed in this audit** by adding `svg` to the `setHeaders` regex at `server.js:776` |
| UI for "Official App Sync" (select platform, paste URL, sync) | ✅ **REAL** — `index.html:600–668` has full UI with platform dropdown, track-ref input, "Open in App" buttons |
| Backend handler for `OFFICIAL_APP_SYNC_SELECT` | ✅ **REAL** — `server.js:7002–7085` validates, normalizes via `platform-normalizer.js`, broadcasts to party |
| Deep-link builder (open in official app) | ✅ **REAL** — `official-app-link.js` + mirrored in `app.js:11300–11410` |
| Platform normalizer (URL→canonical track ID) | ✅ **REAL** — `platform-normalizer.js` full implementation for all 3 platforms |
| Real-time search within the app | ❌ **NOT IMPLEMENTED** — No YouTube/Spotify/SoundCloud search API calls anywhere |
| In-app audio playback (stream within browser) | ❌ **NOT IMPLEMENTED** — Intentional design: playback delegates to official apps via deep link |
| OAuth / login with platform accounts | ❌ **NOT IMPLEMENTED** — No OAuth flow; not required for the "Official App Sync" model |
| YOUTUBE_API_KEY / SPOTIFY_CLIENT_ID / SOUNDCLOUD_CLIENT_ID | ❌ **NOT PRESENT** — No env vars for platform APIs; not needed for current deep-link model |

**The single biggest reason features were "not visible" historically:**  
The service worker was caching stale asset responses. After adding `CHANGER_VERSION` to the cache name and setting `Cache-Control: no-cache, must-revalidate` on every served file (including the SVG route), the browser/SW fetches fresh copies on every deploy. See §5 for full root-cause analysis.

---

## 2. Requested Changes Checklist

### A1 — Requested Changes (from commits, PRs, issues, code comments)

| # | Requested Change | Source | Status | Evidence |
|---|---|---|---|---|
| 1 | Platform logos: `youtube.svg`, `spotify.svg`, `soundcloud.svg` | PR #9 description, commit history | ✅ Implemented | `public/assets/platform-logos/*.svg` |
| 2 | Serve SVGs via dedicated route with allowlist | PR #9 | ✅ Implemented | `server.js:958–962` |
| 3 | No-cache headers on SVG route (was broken: `express.static` intercepted before dedicated route) | PR #9 / cache issue reports + **this audit** | ✅ Fixed — `server.js:776` now includes `svg` in `setHeaders` regex |
| 4 | Fix service-worker stale caching on deploy | Caching issue | ✅ Implemented | `service-worker.js:7–10` (`CHANGER_VERSION` in cache name) |
| 5 | Cloud Build must target `syncspeaker` + `us-central1` | Deployment issue | ✅ Implemented | `cloudbuild.yaml:7,22,23` |
| 6 | Remove any deploy to old `house-party` / `europe-west1` | Deployment issue | ✅ Implemented | Zero references found in `cloudbuild.yaml` |
| 7 | Official App Sync UI (platform select + track-ref input) | Feature request | ✅ Implemented | `index.html:601–668` |
| 8 | "Open in App" deep-link buttons per platform | Feature request | ✅ Implemented | `index.html:649–663`, `app.js:11509–11529` |
| 9 | Backend WebSocket handler for `OFFICIAL_APP_SYNC_SELECT` | Feature request | ✅ Implemented | `server.js:7002–7085` |
| 10 | Platform track-ref normalizer | Feature request | ✅ Implemented | `platform-normalizer.js` |
| 11 | Official App Link deep-link builder | Feature request | ✅ Implemented | `official-app-link.js`, `app.js:11312` |
| 12 | Tier-gate Official App Sync (paid tiers only) | Business rule | ✅ Implemented | `server.js:7021–7029`, `tier-policy.js` |
| 13 | In-app search (YouTube/Spotify/SoundCloud search API) | NOT requested explicitly | ❌ Not Implemented | No search API code found anywhere |
| 14 | OAuth login with platform accounts | NOT requested explicitly | ❌ Not Implemented | No OAuth flow found; not needed for deep-link model |
| 15 | Automated asset-check script (`npm run verify-assets`) | This audit | ✅ Implemented (new) | `scripts/verify-assets.js` |

### A2 — Explicitly Required Areas

1. **Platform logos** — All 3 SVGs exist and are served. ✅  
2. **Cache fix** — `no-cache, must-revalidate` on all asset routes + CHANGER_VERSION-based SW cache busting. ✅  
3. **Deployment target** — `cloudbuild.yaml` is 100% `syncspeaker`/`us-central1`. ✅  
4. **"Actual use of these features":**
   - **Join party + select platform** → ✅ UI exists (`index.html:631–633`), gated behind paid tier
   - **Paste/submit track reference** → ✅ UI + WS handler exist
   - **Sync (broadcast to party)** → ✅ `server.js:7065–7080` broadcasts `TRACK_SELECTED` to all members
   - **Open in official app** → ✅ deep links built and opened via `openInApp()`
   - **In-app search** → ❌ NOT IMPLEMENTED (would need YouTube Data API / Spotify Web API / SoundCloud API keys)
   - **In-browser playback** → ❌ NOT IMPLEMENTED (intentional: delegates to official apps)

---

## 3. What Code Exists (Codebase Evidence Table)

| Area | File Path | Line(s) | Summary | Used in runtime path? | Quality |
|---|---|---|---|---|---|
| **Assets** | `public/assets/platform-logos/youtube.svg` | 1–8 | YouTube logo SVG (red play button + wordmark) | Yes — served by `/public/assets/platform-logos/youtube.svg` route | Real |
| **Assets** | `public/assets/platform-logos/spotify.svg` | 1–10 | Spotify logo SVG (green circle + wordmark) | Yes — served by `/public/assets/platform-logos/spotify.svg` route | Real |
| **Assets** | `public/assets/platform-logos/soundcloud.svg` | 1–12 | SoundCloud logo SVG (orange cloud + wordmark) | Yes — served by `/public/assets/platform-logos/soundcloud.svg` route | Real |
| **API** | `server.js` | 958–962 | GET `/public/assets/platform-logos/:platform.svg` with allowlist + no-cache | Yes | Real |
| **Caching** | `server.js` | 757–758 | `NO_CACHE = 'no-cache, must-revalidate'` constant | Yes — applied to all HTML/JS/CSS/SVG routes | Real |
| **Caching** | `server.js` | 772–780 | Middleware sets `Cache-Control: no-cache` for `.html`, `.js`, `.css` files | Yes | Real |
| **Caching** | `service-worker.js` | 7–10 | `CHANGER_VERSION` drives cache name; old caches deleted on activate | Yes — SW deletes stale caches on activate | Real |
| **Caching** | `service-worker.js` | 70–105 | Network-first fetch strategy | Yes | Real |
| **Deployment** | `cloudbuild.yaml` | 7, 22, 23, 30 | Builds/pushes/deploys to `syncspeaker` in `us-central1` | Yes — Cloud Build trigger | Real |
| **UI** | `index.html` | 600–668 | Official App Sync section: platform logos, dropdown, track-ref input, sync button, open-in-app buttons | Yes — visible to paid tier members | Real |
| **UI** | `index.html` | 606–609 | YouTube logo `<img>` tag | Yes | Real |
| **UI** | `index.html` | 610–613 | Spotify logo `<img>` tag | Yes | Real |
| **UI** | `index.html` | 614–617 | SoundCloud logo `<img>` tag | Yes | Real |
| **UI** | `index.html` | 631–633 | Platform `<select>` (youtube/spotify/soundcloud) | Yes | Real |
| **UI wiring** | `app.js` | 11571–11617 | `btnSyncTrack` click → sends `OFFICIAL_APP_SYNC_SELECT` WS message | Yes | Real |
| **UI wiring** | `app.js` | 1217 | `TRACK_SELECTED` with `mode=OFFICIAL_APP_SYNC` → calls `handleOfficialAppSyncTrackSelected` | Yes | Real |
| **UI wiring** | `app.js` | 11478–11555 | `handleOfficialAppSyncTrackSelected`: updates now-playing UI, builds deep link, auto-opens | Yes | Real |
| **UI wiring** | `app.js` | 11509–11529 | Shows "Open in App" buttons per platform, binds `openInApp` handler | Yes | Real |
| **Playback** | `app.js` | 11424–11467 | `openInApp(deepLink, webUrl)` — tries deep link, falls back to web URL | Yes | Real |
| **Playback** | `app.js` | 11300–11410 | `buildOfficialAppLink(platform, trackRef)` — deep-link + web-URL builder | Yes | Real |
| **Backend/API** | `server.js` | 7002–7085 | `handleOfficialAppSyncSelect` — tier check, normalizes ref, broadcasts `TRACK_SELECTED` | Yes | Real |
| **Backend/API** | `platform-normalizer.js` | 1–120 | `normalizePlatformTrackRef` for YouTube/Spotify/SoundCloud | Yes — called by server.js | Real |
| **Backend/API** | `official-app-link.js` | 1–80+ | `buildOfficialAppLink` — same logic mirrored server-side | Yes — used in tests and app.js | Real |
| **Auth** | `tier-policy.js` | — | `isPaidForOfficialAppSync(tier)` — tier gate for feature | Yes | Real |
| **Auth** | `server.js` | 57–61 | Imports tier policy, validates host authority before sync | Yes | Real |
| **Docs** | `CAPABILITY_MAP.md` | — | Previously generated capability matrix | Docs only | Real |

---

## 4. Testing Results

### 4a. Automated Asset Check (`npm run verify-assets`)

Run with:
```bash
npm run verify-assets
```

The script (`scripts/verify-assets.js`) starts a temporary local server and validates:
1. All 3 platform SVG routes return HTTP 200
2. Response `Content-Type` is `image/svg+xml`
3. `Cache-Control` header contains `no-cache`
4. Response body is a valid SVG (starts with `<svg`)
5. An unknown platform returns HTTP 404 (allowlist works)
6. `/__version` endpoint returns valid JSON with `appVersion` and `changerVersion`

**Expected output (all green):**
```
[verify-assets] Starting local server on port 19876…
✅  GET /public/assets/platform-logos/youtube.svg   → 200  image/svg+xml  no-cache
✅  GET /public/assets/platform-logos/spotify.svg   → 200  image/svg+xml  no-cache
✅  GET /public/assets/platform-logos/soundcloud.svg → 200  image/svg+xml  no-cache
✅  GET /public/assets/platform-logos/unknown.svg    → 404  (allowlist blocks unknown platform)
✅  GET /__version                                   → 200  JSON with appVersion + changerVersion
All checks passed.
```

### 4b. Production Verification Steps

#### Step 1 — Verify the SVG routes and cache headers
```bash
# Replace PROJECT_ID with your GCP project ID
SERVICE_URL=$(gcloud run services describe syncspeaker \
  --region=us-central1 \
  --format='value(status.url)')

# YouTube SVG
curl -sI "$SERVICE_URL/public/assets/platform-logos/youtube.svg" | grep -E "HTTP|content-type|cache-control"

# Spotify SVG
curl -sI "$SERVICE_URL/public/assets/platform-logos/spotify.svg" | grep -E "HTTP|content-type|cache-control"

# SoundCloud SVG
curl -sI "$SERVICE_URL/public/assets/platform-logos/soundcloud.svg" | grep -E "HTTP|content-type|cache-control"

# Unknown platform (should 404)
curl -sI "$SERVICE_URL/public/assets/platform-logos/unknown.svg" | grep "HTTP"
```

**Expected "good" output for each SVG:**
```
HTTP/2 200
content-type: image/svg+xml
cache-control: no-cache, must-revalidate
```

**Expected "good" output for unknown platform:**
```
HTTP/2 404
```

#### Step 2 — Confirm deployed revision and version
```bash
# Get the currently-serving revision
gcloud run revisions list \
  --service=syncspeaker \
  --region=us-central1 \
  --format="table(name,status.observedGeneration,spec.containers[0].image)" \
  --filter="status.conditions.type=Active AND status.conditions.status=True"

# Hit the version endpoint
curl -s "$SERVICE_URL/__version" | python3 -m json.tool
```

**Expected "good" output:**
```json
{
  "appVersion": "0.1.0-party-fix",
  "changerVersion": "2026-02-27-a",
  "instanceId": "...",
  "nodeEnv": "production"
}
```

#### Step 3 — Verify source commit → image → running revision
```bash
# 1. Get latest Cloud Build run for the main branch
gcloud builds list \
  --filter="substitutions.BRANCH_NAME=main" \
  --format="table(id,status,substitutions.COMMIT_SHA,finishTime)" \
  --limit=5

# 2. Get the commit SHA from the latest successful build
COMMIT_SHA=$(gcloud builds list \
  --filter="substitutions.BRANCH_NAME=main AND status=SUCCESS" \
  --format="value(substitutions.COMMIT_SHA)" \
  --limit=1)
echo "Latest deployed commit: $COMMIT_SHA"

# 3. Find the image in Artifact Registry
gcloud artifacts docker images list \
  us-central1-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/syncspeaker/syncspeaker \
  --filter="tags=$COMMIT_SHA" \
  --format="table(IMAGE,DIGEST,TAGS,UPDATE_TIME)"

# 4. Get the image digest from the running revision
gcloud run revisions describe \
  $(gcloud run services describe syncspeaker --region=us-central1 --format='value(status.latestReadyRevisionName)') \
  --region=us-central1 \
  --format='value(spec.containers[0].image)'
```

**"Good" output:** The image tag in step 4 matches `$COMMIT_SHA` from step 2. The digest in step 3 matches step 4.

---

## 5. Why Changes Were "Not Visible" Historically (Root Causes, Ranked)

| Rank | Root Cause | Evidence |
|---|---|---|
| 1 | **`express.static` did not set `no-cache` on SVG files** — the `setHeaders` callback in `server.js:776` only matched `.html|.js|.css`, so SVG files (including platform logos) were served with the default browser-cacheable headers (`public, max-age=0`). The dedicated SVG route at `server.js:959` was unreachable because `express.static` intercepted the request first | Fixed: `server.js:776` — regex changed from `/\.(html|js|css)$/` to `/\.(html|js|css|svg)$/` |
| 2 | **Service worker served stale cached assets** — SW would cache JS/HTML/SVG on install, and old cache names persisted across deploys | `service-worker.js` now uses `CHANGER_VERSION` in the cache name (`service-worker.js:7–10`); old caches deleted on activate |
| 3 | **Cloud Run was still routing to old `house-party` service** — if the trigger was pushing to the old service, users would see the old version | Fixed: `cloudbuild.yaml` targets only `syncspeaker`/`us-central1`; no references to old service exist |
| 4 | **Missing `skipWaiting`/`clients.claim()` calls** — a new SW version would install but not immediately take control | Fixed: `service-worker.js:39` calls `self.skipWaiting()`, line ~70 calls `self.clients.claim()` |
| 5 | **Official App Sync section is hidden by default** — the section has class `hidden` and only shows for paid-tier users; free users could not see it | `index.html:602` — `class="box hidden"` on `#officialAppSyncSection`; expected behavior but can cause confusion |

---

## 6. Next Steps

### Small PR Plan

| PR | Title | Files | Milestone |
|---|---|---|---|
| PR-A | **Add `npm run verify-assets` CI check** | `scripts/verify-assets.js`, `package.json` | Merge immediately — automated proof that SVG routes + headers are correct after every deploy |
| PR-B | **Bump `CHANGER_VERSION`** on any JS/HTML change | `service-worker.js`, `server.js` | Merge with each feature PR — ensures SW cache is busted |
| PR-C | **Expose Official App Sync section in free demo mode** | `index.html`, `app.js` | Optional — show feature to free users (read-only/demo) to improve visibility |
| PR-D | **Add YouTube Data API search** (optional phase 2) | New `routes/platform-search.js`, `.env.example` | Requires `YOUTUBE_API_KEY`; enables in-app search before opening deep link |
| PR-E | **Add Spotify Web API search** (optional phase 2) | New OAuth flow + search route | Requires `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` |

---

## 7. Platform Capability Matrix

| Capability | YouTube | Spotify | SoundCloud |
|---|---|---|---|
| **Logo SVG asset** | ✅ Implemented — `public/assets/platform-logos/youtube.svg:1–8` | ✅ Implemented — `public/assets/platform-logos/spotify.svg:1–10` | ✅ Implemented — `public/assets/platform-logos/soundcloud.svg:1–12` |
| **Logo served via HTTP with no-cache** | ✅ Implemented — `server.js:958–962` | ✅ Implemented — `server.js:958–962` | ✅ Implemented — `server.js:958–962` |
| **UI selection (platform dropdown)** | ✅ Implemented — `index.html:631` | ✅ Implemented — `index.html:632` | ✅ Implemented — `index.html:633` |
| **Track-ref input + validation** | ✅ Implemented — `platform-normalizer.js:16–46`, `server.js:7043–7057` | ✅ Implemented — `platform-normalizer.js:54–87` | ✅ Implemented — `platform-normalizer.js:95–116` |
| **Backend sync broadcast** | ✅ Implemented — `server.js:7065–7080` | ✅ Implemented — `server.js:7065–7080` | ✅ Implemented — `server.js:7065–7080` |
| **Deep-link builder** | ✅ Implemented — `official-app-link.js`, `app.js:11325–11348` | ✅ Implemented — `app.js:11351–11375` | ✅ Implemented — `app.js:11379–11407` |
| **"Open in App" button** | ✅ Implemented — `index.html:651–655`, `app.js:11512–11523` | ✅ Implemented — `index.html:656–660`, `app.js:11512–11523` | ✅ Implemented — `index.html:661–665`, `app.js:11512–11523` |
| **Auth (OAuth / login)** | ❌ NOT FOUND — no OAuth for platform login | ❌ NOT FOUND | ❌ NOT FOUND |
| **In-app search** | ❌ NOT FOUND — no YouTube Data API calls | ❌ NOT FOUND — no Spotify Web API calls | ❌ NOT FOUND — no SoundCloud API calls |
| **In-browser playback** | ❌ NOT FOUND — intentional (delegates to official app) | ❌ NOT FOUND — intentional | ❌ NOT FOUND — intentional |
| **Tier gate (paid only)** | ✅ Implemented — `server.js:7021–7029`, `tier-policy.js` | ✅ Implemented | ✅ Implemented |
