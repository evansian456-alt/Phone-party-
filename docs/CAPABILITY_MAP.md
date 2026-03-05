# CAPABILITY_MAP

Auto-generated capability map for SyncSpeaker Prototype.
Covers all HTTP endpoints, WebSocket message types, tier gates, DB tables,
purchase/add-on flows, upload/storage flows, background hooks, and env assumptions.

---

## HTTP Endpoints

### Health / Utility
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | None | Serves index.html (stable DOM marker: `data-app-ready`) |
| GET | `/health` | None | Returns `{ status: "ok", redis, db }` — used by CI preflight |
| GET | `/api/health` | None | Alias for `/health` (JSON) |
| GET | `/api/ping` | None | Simple ping → `{ pong: true }` |
| GET | `/api/routes` | None | Lists registered routes (debug) |

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/signup` | None | Create account — rate-limited (`authLimiter`), returns JWT |
| POST | `/api/auth/login` | None | Login — rate-limited, returns JWT |
| POST | `/api/auth/logout` | Optional | Clear session cookie |
| GET | `/api/me` | Required | Return authenticated user profile + tier |

### Store / Tiers / Purchase
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/store` | Optional | Return store catalog items |
| GET | `/api/tier-info` | None | Return tier definitions (FREE / PARTY_PASS / PRO_MONTHLY) |
| POST | `/api/purchase` | Required | Purchase item by `itemKey` → triggers entitlement write |
| POST | `/api/payment/initiate` | Required | Initiate Stripe payment session |
| POST | `/api/payment/confirm` | Required | Confirm payment and write entitlement |
| GET | `/api/user/entitlements` | Required | Return active entitlements for current user |
| POST | `/api/apply-promo` | None | Apply promo code to a party (maps to `handleApplyPromo` WS) |

### Tracks / Upload / Storage
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/tracks/presign-put` | None | Generate S3/R2 presigned PUT URL for direct upload |
| POST | `/api/upload-track` | None | Multipart upload via server (multer middleware) |
| POST | `/api/set-party-track` | None | Set active track URL for a party |
| GET | `/api/track/:trackId` | None | Retrieve track metadata / presigned GET URL |

### Party Lifecycle
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/create-party` | None | Create party — rate-limited; supports `tier`+`prototypeMode` |
| POST | `/api/join-party` | None | Join party by code |
| GET | `/api/party` | None | Get party by code (query param) |
| GET | `/api/party-state` | None | Full playback+roster state for a party |
| POST | `/api/leave-party` | None | Leave party (guest) |
| POST | `/api/end-party` | None | End party (host) |
| GET | `/api/party/:code` | None | Get party metadata |
| GET | `/api/party/:code/members` | None | List current members |
| GET | `/api/party/:code/scoreboard` | None | Party scoreboard |
| GET | `/api/party/:code/debug` | None | Debug dump (dev/test only) |

### Queue
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/party/:code/start-track` | None | Set + start current track |
| POST | `/api/party/:code/queue-track` | None | Enqueue a track |
| POST | `/api/party/:code/play-next` | None | Skip to next in queue |
| POST | `/api/party/:code/remove-track` | None | Remove track from queue |
| POST | `/api/party/:code/clear-queue` | None | Clear all queued tracks |
| POST | `/api/party/:code/reorder-queue` | None | Reorder queue positions |

### Leaderboard / Social
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/leaderboard/djs` | None | Global DJ leaderboard |
| GET | `/api/leaderboard/guests` | None | Global guest leaderboard |
| GET | `/api/referral/stats` | Required | User referral stats + invite link |
| POST | `/api/referral/track` | Required | Record referral conversion |

### Admin / Observability
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/admin/metrics` | Required + admin | Aggregated metrics from `metricsService` |

### Debug (test/dev)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/debug/redis` | None | Redis ping / key listing |
| GET | `/api/debug/parties` | None | Dump in-memory `parties` Map |
| GET | `/api/debug/party/:code` | None | Dump single party state |

### Webhooks
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/stripe/webhook` | Stripe signature | Handle Stripe events (checkout.session.completed, etc.) |

---

## WebSocket Message Types

### Client → Server (inbound)
| Type | Description | Auth Required |
|------|-------------|---------------|
| `CREATE` | Create party (requires `djName`, `source`) | No |
| `JOIN` | Join party by `code` (requires `name`) | No |
| `KICK` | Kick member by `targetId` | Host only |
| `SET_PRO` | Activate PRO tier for party | Host only |
| `APPLY_PROMO` | Apply promo code | Host only |
| `HOST_PLAY` | Start playback (`trackUrl`, `trackId`, `filename`, `durationMs`) | Host only |
| `HOST_PAUSE` | Pause playback (`positionSec`) | Host only |
| `HOST_STOP` | Stop playback | Host only |
| `HOST_TRACK_SELECTED` | Notify track selected | Host only |
| `HOST_NEXT_TRACK_QUEUED` | Notify next track queued | Host only |
| `HOST_TRACK_CHANGED` | Notify track changed | Host only |
| `HOST_BROADCAST_MESSAGE` | Broadcast DJ message to all guests | Host only |
| `GUEST_MESSAGE` | Send guest chat message (tier-gated: PARTY_PASS+) | Guest |
| `GUEST_PLAY_REQUEST` | Request host to play | Guest |
| `GUEST_PAUSE_REQUEST` | Request host to pause | Guest |
| `GUEST_QUICK_REPLY` | Send quick reply emoji/reaction | Guest |
| `DJ_QUICK_BUTTON` | DJ quick-action button | Host only |
| `DJ_EMOJI` | Send DJ emoji broadcast | Host only |
| `DJ_SHORT_MESSAGE` | Send DJ short message (tier-gated) | Host only |
| `CHAT_MODE_SET` | Set chat moderation mode | Host only |
| `CLIENT_READY` | Signal client buffer readiness for playback | Any |
| `CLIENT_NOT_READY` | Signal client not ready | Any |
| `TIME_PING` | Legacy clock sync request | Any |
| `CLOCK_PING` | Advanced clock sync request | Any |
| `PLAYBACK_FEEDBACK` | Report drift/position offset | Any |
| `REQUEST_SYNC_STATE` | Request current sync state | Any |
| `SYNC_ISSUE` | Report sync issue | Any |
| `GET_SYNC_STATS` | Request sync stats | Any |
| `RESUME` | Resume after reconnect | Any |
| `MESSAGE_ACK` | Acknowledge received message | Any |

### Server → Client (outbound)
| Type | Description |
|------|-------------|
| `WELCOME` | Sent on connect — includes `clientId` |
| `CREATED` | Party created — includes `code` |
| `HOST_JOINED` | Host joined own party — includes `code`, `role`, `tier` |
| `JOINED` | Guest joined — includes `code`, `role` |
| `ROOM` | Room state snapshot (roster, track, tier) |
| `PREPARE_PLAY` | Clients must buffer track before `PLAY_AT` fires |
| `PLAY_AT` | Absolute-timestamp playback start (`startAtServerMs`) |
| `PAUSE` | Playback paused |
| `STOP` | Playback stopped |
| `SYNC_TICK` | Periodic sync heartbeat (`trackId`, `expectedPositionSec`) |
| `CLOCK_PONG` | Response to `CLOCK_PING` |
| `TIME_PONG` | Response to `TIME_PING` |
| `ENDED` | Party ended (sent to guests when host disconnects) |
| `GUEST_MESSAGE` | Broadcast of guest chat message |
| `CHAT_MODE_SET` | Chat mode changed |
| `ERROR` | Error response (`errorType`, `message`) |

---

## Tier Gates

| Feature | FREE | PARTY_PASS | PRO_MONTHLY |
|---------|------|------------|-------------|
| Max phones | 2 | 4 | 10 |
| Duration | Unlimited | 2 hours | 30 days |
| Guest messaging (`GUEST_MESSAGE`) | ❌ | ✅ | ✅ |
| Custom messages (`HOST_BROADCAST_MESSAGE`) | ❌ | ❌ | ✅ |
| DJ short messages | ❌ | ❌ | ✅ |
| Analytics | ❌ | ❌ | ✅ |
| Audio sync | ✅ | ✅ | ✅ |
| Party pass expiry check | N/A | `partyPassExpiresAt > Date.now()` | `partyPassExpiresAt > Date.now()` |

### WS-created parties
WS `CREATE` always creates FREE tier (maxPhones=2) and does not accept `tier`/`prototypeMode` parameters.
HTTP `POST /api/create-party` supports `tier` + `prototypeMode: true` for prototype upgrades.

---

## DB Tables

| Table | Purpose |
|-------|---------|
| `users` | Registered users (id UUID, email, password_hash, tier, created_at) |
| `subscriptions` | Active subscriptions (user_id, plan, status, stripe_subscription_id) |
| `user_upgrades` | One-time upgrade records |
| `dj_profiles` | DJ profile metadata (bio, avatar, total_sessions, total_listeners) |
| `entitlements` | Active feature entitlements (user_id, feature, expires_at) |
| `purchases` | Purchase history (user_id, item_key, amount, status, stripe_payment_intent_id) |
| `party_memberships` | Party membership records (party_code, user_id, role, joined_at) |
| `guest_profiles` | Anonymous guest profiles (guest_id, nickname, party_code) |
| `party_scoreboard_sessions` | Per-party scoreboard snapshots |
| `session_metrics` | Session telemetry (party_code, user_id TEXT, action, ts) |
| `revenue_metrics` | Revenue telemetry (user_id TEXT, amount, currency, ts) |
| `user_referrals` | Referral program records |
| `referral_tracking` | Referral conversion tracking |
| `user_entitlements` | User-level entitlement records (user_id, tier, expires_at) |

> Note: `session_metrics.user_id` and `revenue_metrics.user_id` are TEXT (not UUID) because
> `trackSessionCreated()` passes WS client integer IDs or `'anonymous'`.

---

## Purchase / Add-on Flow

```
1. User calls POST /api/payment/initiate  →  Stripe session created
2. Stripe redirects to client            →  client calls POST /api/payment/confirm
   OR Stripe sends webhook               →  POST /api/stripe/webhook
3. Server writes to `purchases` + `user_entitlements` / `entitlements`
4. Server broadcasts tier change via WS (if party active)
5. Client state unlocks gated features
6. On refresh: GET /api/user/entitlements returns active tier
7. On reconnect: WS JOIN includes current tier in ROOM snapshot
```

Denial flows:
- Before purchase: tier-gated WS actions return `ERROR { errorType: 'TIER_REQUIRED' }`
- After expiry: `isPartyPassActive()` returns false → same error path

---

## Upload / Storage Flow

```
Direct upload (preferred):
  1. Client calls POST /api/tracks/presign-put  →  S3/R2 presigned PUT URL
  2. Client uploads directly to S3/R2
  3. Client calls POST /api/set-party-track with resulting trackUrl

Server-side upload (fallback):
  1. Client submits multipart form to POST /api/upload-track
  2. Multer saves to local disk / passes to S3 via storage provider
  3. Response includes trackUrl

Playback:
  GET /api/track/:trackId  →  presigned GET URL (if private) or direct URL (if public CDN)
```

---

## Background Hooks

| Hook | Trigger | Effect |
|------|---------|--------|
| `startSyncTick(partyCode)` | First HOST_PLAY | Starts 1s interval broadcasting `SYNC_TICK` |
| `stopSyncTick(partyCode)` | Host disconnect / HOST_STOP | Clears interval, removes from `syncTickIntervals` |
| `persistPartyScoreboard()` | Host disconnect | Persists scoreboard to `party_scoreboard_sessions` |
| `cleanupRateLimitData()` | Host disconnect | Removes per-party rate limit buckets |
| `partyEventHistory.delete()` | Host disconnect | Removes event history for party |
| `partySyncEngines.delete()` | Host disconnect | Removes adaptive sync engine for party |
| `deletePartyFromRedis()` | Host disconnect | Removes party from Redis |
| `broadcastRoomState()` | Guest join/leave | Broadcasts `ROOM` snapshot to all members |
| `trackSessionCreated()` | Party create | Logs to `session_metrics` |

---

## In-Memory Structures (Memory Stability)

| Structure | Key | Cleaned on |
|-----------|-----|-----------|
| `parties` (Map) | partyCode → party object | Host disconnect |
| `clients` (Map) | WebSocket → client metadata | WS close |
| `readinessMap` (Map) | `${partyCode}:${trackId}` → readiness state | Implicit (per-track) |
| `syncTickIntervals` (Map) | partyCode → intervalId | `stopSyncTick()` on host disconnect |
| `partyEventHistory` (Map) | partyCode → event array | Host disconnect |
| `partySyncEngines` (Map) | partyCode → SyncEngine | Host disconnect |

---

## Environment Assumptions

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NODE_ENV` | Yes | `development` | Affects rate limiting, error verbosity |
| `PORT` | No | `8080` | HTTP/WS listen port |
| `REDIS_URL` | Yes (prod) | — | Redis connection string |
| `REDIS_HOST` | No | `localhost` | Dev Redis host |
| `REDIS_PORT` | No | `6379` | Dev Redis port |
| `DATABASE_URL` | Yes (prod) | — | PostgreSQL connection string |
| `JWT_SECRET` | Yes (prod) | — | Min 32 chars, no insecure defaults |
| `STRIPE_SECRET_KEY` | No | — | Stripe payments |
| `STRIPE_WEBHOOK_SECRET` | No | — | Stripe webhook validation |
| `S3_BUCKET` | No | — | S3/R2 bucket for track storage |
| `S3_ACCESS_KEY_ID` | No | — | S3/R2 credentials |
| `S3_SECRET_ACCESS_KEY` | No | — | S3/R2 credentials |
| `S3_ENDPOINT` | No | — | S3-compatible endpoint (e.g. R2) |
| `S3_REGION` | No | `auto` | AWS region or `auto` for R2 |
| `CDN_BASE_URL` | No | — | CloudFront/CDN URL for track delivery |
| `S3_PUBLIC_BASE_URL` | No | — | Direct R2 public URL |
| `ADMIN_SECRET` | No | — | X-Admin-Secret header for `/admin/metrics` |
| `ENFORCE_NO_SKIPS` | No | — | CI: throw on skipped tests |
| `TEST_MODE` | No | — | Enables test-only behavior |
| `STRESS_TEST_MODE` | No | — | Enables 30s memory monitoring logs |
