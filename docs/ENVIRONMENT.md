# Environment Variables Specification

**Complete reference for all environment variables used in Phone Party**

This document is the single source of truth for environment variable configuration. Always refer to this when deploying or troubleshooting.

---

## Quick Reference

| Status | Meaning |
|--------|---------|
| 🔴 **REQUIRED (Production)** | Must be set in production or app will not function correctly |
| 🟡 **STRONGLY RECOMMENDED** | Optional but critical for security/functionality |
| 🟢 **OPTIONAL** | Nice to have, has safe defaults |
| 🔵 **DEV/TEST ONLY** | Only used in development/testing |

---

## Server Configuration

### `NODE_ENV`
- **Status:** 🟡 **STRONGLY RECOMMENDED**
- **Purpose:** Defines the runtime environment
- **Values:** `production`, `development`, `test`
- **Default:** `undefined` (treated as development)
- **Security Impact:** HIGH - Controls secure cookies, error verbosity, TLS validation
- **Example:** `NODE_ENV=production`
- **Notes:**
  - When `production`: Enables secure cookies, less verbose errors
  - When `development`: More logging, relaxed security for easier debugging
  - When `test`: Used by test suite

### `PORT`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** HTTP server listening port
- **Values:** Any valid port number (1-65535)
- **Default:** `8080`
- **Example:** `PORT=3000`
- **Notes:** Cloud platforms (Railway, Heroku) automatically set this

### `PUBLIC_BASE_URL`
- **Status:** 🔴 **REQUIRED (Production)** for proxy deployments
- **Purpose:** Public-facing base URL for HTTPS proxies
- **Format:** `https://your-domain.com` (no trailing slash)
- **Default:** Auto-detected from request (dev only)
- **Example:** 
  - Railway: `PUBLIC_BASE_URL=https://your-app.up.railway.app`
  - Custom domain: `PUBLIC_BASE_URL=https://phoneparty.example.com`
- **Security Impact:** HIGH - Affects uploaded audio URL generation
- **Notes:**
  - **REQUIRED** when running behind HTTPS proxies (Railway, Heroku, etc.)
  - Railway terminates HTTPS at proxy level
  - Without this, server generates `http://` URLs causing mixed-content errors
  - Used to generate correct trackUrl for uploaded audio files
  - Production MUST have this set for multi-instance deployments

---

## Storage Configuration (Audio Track Storage)

⚠️ **S3-compatible storage is REQUIRED for production multi-instance deployments.**

### `S3_BUCKET`
- **Status:** 🔴 **REQUIRED (Production)**
- **Purpose:** S3 bucket name for audio track storage
- **Default:** `undefined` (falls back to local disk in dev)
- **Example:** `S3_BUCKET=phoneparty-tracks`
- **Notes:**
  - Required for Railway, Heroku, and multi-instance deployments
  - Supports Railway Buckets, Cloudflare R2, AWS S3
  - Without this, uses local disk (ephemeral on Railway)

### `S3_ACCESS_KEY_ID`
- **Status:** 🔴 **REQUIRED (Production)**
- **Purpose:** S3 access key ID
- **Security Impact:** HIGH - Storage credential
- **Example:** `S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE`
- **Notes:** Get from your storage provider (Railway, R2, AWS)

### `S3_SECRET_ACCESS_KEY`
- **Status:** 🔴 **REQUIRED (Production)**
- **Purpose:** S3 secret access key
- **Security Impact:** CRITICAL - Storage credential
- **Example:** `S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`
- **Notes:** Keep secret, never commit to source control

### `S3_ENDPOINT`
- **Status:** 🟡 **STRONGLY RECOMMENDED**
- **Purpose:** S3-compatible endpoint URL
- **Default:** `undefined` (assumes AWS S3)
- **Example:** 
  - Railway: `S3_ENDPOINT=https://s3.railway.app`
  - Cloudflare R2: `S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com`
  - AWS S3: (can be omitted if using standard AWS)
- **Notes:** Required for non-AWS providers

### `S3_REGION`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** AWS region or equivalent
- **Default:** `us-east-1` (for AWS) or `auto` (for R2)
- **Example:** `S3_REGION=us-west-2` or `S3_REGION=auto`
- **Notes:** Set to `auto` for Cloudflare R2

### `S3_FORCE_PATH_STYLE`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Use path-style URLs instead of virtual-hosted
- **Values:** `true`, `false`
- **Default:** `false`
- **Example:** `S3_FORCE_PATH_STYLE=true`
- **Notes:** Set to `true` for R2 and some S3-compatible services

### `S3_PREFIX`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Folder prefix for organizing files
- **Default:** `tracks/`
- **Example:** `S3_PREFIX=audio/tracks/`
- **Notes:** Useful for organizing uploads in shared buckets

### `TRACK_TTL_MS`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Time-to-live for uploaded audio tracks (in milliseconds)
- **Default:** `300000` (5 minutes)
- **Example:** `TRACK_TTL_MS=600000` (10 minutes)
- **Notes:**
  - Track cleanup is handled automatically by storage provider TTL
  - This value is used primarily for logging and monitoring
  - Must be a positive integer
  - Invalid values will fallback to default with a warning

### `UPLOAD_DIR` (Dev Only)
- **Status:** 🔵 **DEV ONLY**
- **Purpose:** Local disk directory for file storage
- **Default:** `./uploads`
- **Example:** `UPLOAD_DIR=/tmp/uploads`
- **Notes:** Only used when S3 not configured (development)

### `ALLOW_LOCAL_DISK_IN_PROD`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Allow local disk storage in production
- **Values:** `true`, `false`
- **Default:** `false`
- **Example:** `ALLOW_LOCAL_DISK_IN_PROD=true`
- **⚠️ WARNING:** NOT recommended for multi-instance deployments
- **Notes:** Uploads won't survive restarts or work across instances

---

## Redis Configuration (Cache & Pub/Sub)

⚠️ **Redis is REQUIRED for multi-device sync and party discovery in production.**

### `REDIS_URL` (Recommended)
- **Status:** 🔴 **REQUIRED (Production)**
- **Purpose:** Full Redis connection URL
- **Format:** `redis://[user]:[password]@[host]:[port]` or `rediss://...` for TLS
- **Default:** `undefined` (falls back to REDIS_HOST/PORT in dev)
- **Example:** 
  - Standard: `redis://default:mypassword@redis.example.com:6379`
  - TLS: `rediss://default:mypassword@redis.example.com:6379`
- **Security Impact:** HIGH - Contains credentials
- **Notes:**
  - Railway/Heroku set this automatically when Redis is added
  - Use `rediss://` (double 's') for TLS connections
  - Production MUST use REDIS_URL or app will fail to start
- **Production Requirement:** YES - Server will crash on startup if missing

### `REDIS_HOST` (Alternative for Dev)
- **Status:** 🔵 **DEV ONLY**
- **Purpose:** Redis server hostname (alternative to REDIS_URL)
- **Default:** `localhost`
- **Example:** `REDIS_HOST=127.0.0.1`
- **Notes:** Only used when REDIS_URL is not set (development mode)

### `REDIS_PORT` (Alternative for Dev)
- **Status:** 🔵 **DEV ONLY**
- **Purpose:** Redis server port (alternative to REDIS_URL)
- **Default:** `6379`
- **Example:** `REDIS_PORT=6380`
- **Notes:** Only used when REDIS_URL is not set (development mode)

### `REDIS_PASSWORD` (Alternative for Dev)
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Redis authentication password (alternative to REDIS_URL)
- **Default:** `undefined` (no auth)
- **Example:** `REDIS_PASSWORD=supersecretpassword`
- **Security Impact:** HIGH - Redis credential
- **Notes:** Only used when REDIS_URL is not set

### `REDIS_TLS_REJECT_UNAUTHORIZED`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Enable/disable strict TLS certificate validation for Redis
- **Values:** `true`, `false`
- **Default:** `true` (strict validation enabled)
- **Example:** `REDIS_TLS_REJECT_UNAUTHORIZED=false`
- **Security Impact:** CRITICAL - Affects TLS security and protection against MITM attacks
- **Notes:**
  - **DEFAULT IS NOW `true` (strict certificate validation)**
  - Set to `false` ONLY in controlled development environments with self-signed certificates
  - **NEVER disable in production** - allows network attackers to impersonate Redis
  - Disabling verification exposes party/session state to man-in-the-middle attacks
  - Railway and most managed Redis services use valid certificates - keep validation enabled
  - Use only with explicit understanding of security risks
  - Automatically enabled when using `rediss://` URLs

---

## Database Configuration (PostgreSQL)

### `DATABASE_URL` (Recommended)
- **Status:** 🔴 **REQUIRED (Production)**
- **Purpose:** PostgreSQL connection string
- **Format:** `postgresql://[user]:[password]@[host]:[port]/[database]`
- **Default:** `undefined` (falls back to individual DB_ vars)
- **Example:** `postgresql://dbuser:dbpass@db.example.com:5432/phoneparty`
- **Security Impact:** HIGH - Contains credentials
- **Notes:**
  - Railway/Heroku set this automatically when PostgreSQL is added
  - Production MUST have database configured

### `DB_HOST` (Alternative)
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** PostgreSQL hostname (alternative to DATABASE_URL)
- **Default:** `localhost`
- **Example:** `DB_HOST=db.example.com`

### `DB_PORT` (Alternative)
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** PostgreSQL port (alternative to DATABASE_URL)
- **Default:** `5432`
- **Example:** `DB_PORT=5433`

### `DB_NAME` (Alternative)
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** PostgreSQL database name (alternative to DATABASE_URL)
- **Default:** `syncspeaker`
- **Example:** `DB_NAME=phoneparty`

### `DB_USER` (Alternative)
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** PostgreSQL username (alternative to DATABASE_URL)
- **Default:** `postgres`
- **Example:** `DB_USER=phoneparty_user`

### `DB_PASSWORD` (Alternative)
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** PostgreSQL password (alternative to DATABASE_URL)
- **Default:** `undefined` (no password)
- **Example:** `DB_PASSWORD=supersecretdbpassword`
- **Security Impact:** HIGH - Database credential

---

## Authentication & Security

### `JWT_SECRET`
- **Status:** 🟡 **STRONGLY RECOMMENDED**
- **Purpose:** Secret key for signing JWT authentication tokens
- **Format:** Random string, minimum 32 characters
- **Default:** `'syncspeaker-no-auth-mode'` ⚠️ **INSECURE FALLBACK**
- **Example:** `JWT_SECRET=your-super-secret-random-string-min-32-chars`
- **Security Impact:** CRITICAL
- **⚠️ WARNING:** 
  - When not set or using default, **ALL AUTHENTICATION IS DISABLED**
  - All protected routes become publicly accessible
  - This is a temporary hotfix - must be set in production
- **Generation:** 
  ```bash
  # Generate secure random secret
  openssl rand -base64 48
  node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
  ```
- **Production Requirement:** STRONGLY RECOMMENDED (auth disabled without it)

---

## Payment Integration (Optional)

All payment variables are optional. The app functions without them, but paid features will be unavailable.

### `STRIPE_SECRET_KEY`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Stripe API secret key for payment processing
- **Format:** `sk_live_...` (live) or `sk_test_...` (test)
- **Default:** `undefined`
- **Example:** `STRIPE_SECRET_KEY=sk_live_YOUR_KEY_HERE`
- **Security Impact:** HIGH - Payment processing credential
- **Notes:** Required only if accepting payments via Stripe

### `STRIPE_WEBHOOK_SECRET`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Stripe webhook signature verification
- **Format:** `whsec_...`
- **Default:** `undefined`
- **Example:** `STRIPE_WEBHOOK_SECRET=whsec_YOUR_SECRET_HERE`
- **Security Impact:** HIGH - Webhook validation
- **Notes:** Required for Stripe webhooks to prevent spoofing

### `APPLE_IAP_SHARED_SECRET`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Apple In-App Purchase receipt validation
- **Default:** `undefined`
- **Example:** `APPLE_IAP_SHARED_SECRET=YOUR_SHARED_SECRET_HERE`
- **Security Impact:** HIGH
- **Notes:** Required only for iOS app payments

### `GOOGLE_PLAY_SERVICE_ACCOUNT`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Google Play service account for purchase validation
- **Default:** `undefined`
- **Example:** `GOOGLE_PLAY_SERVICE_ACCOUNT=path/to/service-account.json`
- **Security Impact:** HIGH
- **Notes:** Required only for Android app payments

---

## Monitoring & Observability (Optional)

### `SENTRY_DSN`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Sentry error tracking and monitoring
- **Format:** `https://[key]@[org].ingest.sentry.io/[project]`
- **Default:** `undefined` (error tracking disabled)
- **Example:** `SENTRY_DSN=https://abc123@o123456.ingest.sentry.io/123456`
- **Security Impact:** LOW - Project ID is not sensitive
- **Notes:**
  - Only initialized when `NODE_ENV=production` AND this is set
  - Get DSN from https://sentry.io project settings

### `GA_MEASUREMENT_ID`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Google Analytics 4 measurement ID
- **Format:** `G-XXXXXXXXXX`
- **Default:** `undefined` (analytics disabled)
- **Example:** `GA_MEASUREMENT_ID=G-ABC123XYZ`
- **Security Impact:** NONE - Public identifier
- **Notes:** Get ID from https://analytics.google.com

---

## Admin Configuration

### `ADMIN_EMAILS`
- **Status:** 🔴 **PRODUCTION REQUIRED** for admin access
- **Purpose:** Comma-separated list of email addresses that have admin access
- **Format:** Comma-separated email list; comparison is case-insensitive and whitespace-trimmed
- **Default:** `undefined` (no admin accounts — all admin routes return 403)
- **Example:** `ADMIN_EMAILS=ianevans2023@outlook.com,backup-admin@example.com`
- **Security Impact:** HIGH — accounts with matching emails receive full admin access and PRO tier for free
- **How it works:**
  1. On login, the server calls `isAdminEmail(user.email)` (defined in `auth-middleware.js`)
  2. If the email is in the allowlist and `is_admin` is not already `TRUE` in the database, the server runs `UPDATE users SET is_admin = TRUE WHERE id = $1`
  3. The JWT issued for that session includes `isAdmin: true`
  4. All `/api/admin/*` routes check this JWT claim via the `requireAdmin` middleware (401 if not logged in, 403 if logged in but not admin)
  5. `/api/me` returns `isAdmin: true` and sets `effectiveTier: PRO` automatically for admin accounts
- **Adding an admin email:**
  1. Set (or append to) the `ADMIN_EMAILS` env var on your deployment platform (Railway / Cloud Run / Heroku / `.env`)
  2. The target user must **log in again** — admin status is promoted on the next successful login
  3. No code changes or database migrations are required
- **Removing admin access:**
  1. Remove the email from `ADMIN_EMAILS`
  2. Manually set `is_admin = FALSE` for that user in the database (the flag is only promoted, never demoted automatically)
- **Notes:**
  - Do **not** hardcode email addresses in source code — always use this env var
  - Supports multiple admins: `ADMIN_EMAILS=alice@example.com,bob@example.com`
  - Whitespace around emails is ignored: `alice@example.com , BOB@EXAMPLE.COM` works correctly
  - Legacy `ADMIN_BOOTSTRAP_EMAIL` single-email variable is also supported for backwards compatibility

---

## Admin & Debug (Development Only)

### `ADMIN_SECRET`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Secret key for admin dashboard access
- **Default:** `undefined` (admin access denied, except in development)
- **Example:** `ADMIN_SECRET=my-admin-secret-key`
- **Security Impact:** MEDIUM - Admin access
- **Notes:** 
  - Legacy variable kept for backwards compatibility
  - The current admin system uses `ADMIN_EMAILS` + JWT; `ADMIN_SECRET` is no longer the primary access control
  - Only used by the legacy `/admin` dashboard route check

### `DEBUG`
- **Status:** 🔵 **DEV ONLY**
- **Purpose:** Enable verbose debug logging
- **Values:** `true`, `false`
- **Default:** `false` (or `true` if NODE_ENV=development)
- **Example:** `DEBUG=true`
- **Notes:** Never use in production (performance impact)

### `TEST_MODE`
- **Status:** 🔵 **DEV/TEST ONLY**
- **Purpose:** Enable test mode behaviors (mocks, shortcuts)
- **Values:** `true`, `false`
- **Default:** Auto-detected (true if NODE_ENV !== production)
- **Example:** `TEST_MODE=true`
- **Notes:** Automatically enabled in test environment

---

## Feature Flags (Advanced)

### `ENABLE_PUBSUB`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Enable/disable Redis pub/sub messaging
- **Values:** `true`, `false`
- **Default:** `true`
- **Example:** `ENABLE_PUBSUB=false`
- **Notes:** Should remain `true` for multi-instance deployments

### `ENABLE_REACTION_HISTORY`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Enable/disable reaction history storage
- **Values:** `true`, `false`
- **Default:** `true`
- **Example:** `ENABLE_REACTION_HISTORY=false`

### `ALLOW_FALLBACK_IN_PRODUCTION`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Allow in-memory fallback storage when Redis unavailable in production
- **Values:** `true`, `false`
- **Default:** `false`
- **⚠️ WARNING:** Should ALWAYS remain `false` in production
- **Example:** `ALLOW_FALLBACK_IN_PRODUCTION=false`
- **Notes:** In-memory storage breaks multi-instance deployments

---

## Platform-Specific (Auto-Set)

### `RAILWAY_ENVIRONMENT`
- **Status:** Auto-set by Railway
- **Purpose:** Indicates deployment on Railway platform
- **Values:** `production`, `staging`, etc.
- **Notes:** Used to detect production environment

### `CI`
- **Status:** Auto-set by CI systems
- **Purpose:** Indicates running in CI environment
- **Notes:** Used by test suite for CI-specific behaviors

### `BASE_URL`
- **Status:** 🟢 **OPTIONAL**
- **Purpose:** Base URL of application (for links, referrals)
- **Default:** `https://phone-party.up.railway.app`
- **Example:** `BASE_URL=https://phoneparty.example.com`

---

## Production Minimum Configuration

**Absolute minimum for production deployment:**

```bash
# Environment
NODE_ENV=production

# Redis (REQUIRED)
REDIS_URL=rediss://default:password@redis.example.com:6379

# Database (REQUIRED)
DATABASE_URL=postgresql://user:pass@db.example.com:5432/phoneparty

# Security (STRONGLY RECOMMENDED)
JWT_SECRET=your-random-secret-min-32-chars-generated-securely
```

**Recommended production configuration:**

```bash
# Environment
NODE_ENV=production
PORT=8080

# Redis (REQUIRED)
REDIS_URL=rediss://default:password@redis.example.com:6379
REDIS_TLS_REJECT_UNAUTHORIZED=true

# Database (REQUIRED)
DATABASE_URL=postgresql://user:pass@db.example.com:5432/phoneparty

# Security (CRITICAL)
JWT_SECRET=your-random-secret-min-32-chars-generated-securely

# Admin access (set to your email address)
ADMIN_EMAILS=your-admin-email@example.com

# Monitoring (RECOMMENDED)
SENTRY_DSN=https://abc@o123.ingest.sentry.io/456

# Payments (If using Stripe)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

---

## Development Configuration

**Minimal development setup:**

```bash
# Environment
NODE_ENV=development

# Redis (local)
REDIS_HOST=localhost
REDIS_PORT=6379

# Database (local)
DATABASE_URL=postgresql://localhost:5432/phoneparty

# Auth (dev only - use any value)
JWT_SECRET=dev-secret-not-for-production
```

---

## Validation & Troubleshooting

### Check Configuration
```bash
# Check health endpoint
curl http://localhost:8080/health

# Expected response (production with all services ready):
{
  "status": "ok",
  "instanceId": "server-abc123",
  "redis": "ready",
  "version": "1.0.0",
  "configSource": "REDIS_URL",
  "uptimeSeconds": 123
}
```

### Common Issues

**Redis shows "fallback":**
- REDIS_URL not set
- Redis connection failed
- Check Redis is running and accessible

**Redis shows "error":**
- Invalid REDIS_URL
- Network connectivity issue
- Check `redisError` field in response for details

**Authentication not working:**
- JWT_SECRET not set or using default value
- Check console for warning: "Authentication is DISABLED"
- Set a secure JWT_SECRET value

---

## Security Best Practices

1. **Never commit secrets to version control**
   - Use `.env` files (add to `.gitignore`)
   - Use platform-specific secret management

2. **Generate strong random secrets**
   ```bash
   openssl rand -base64 48
   ```

3. **Use TLS for all external connections**
   - Redis: Use `rediss://` URLs
   - Database: Enable SSL
   - Set `NODE_ENV=production` for secure cookies

4. **Rotate secrets periodically**
   - JWT_SECRET: Invalidates all sessions
   - Database passwords: Coordinate with DB admin
   - API keys: Follow provider guidelines

5. **Use least-privilege credentials**
   - Database user: Only permissions needed
   - Redis: Enable password auth
   - Admin secret: Only when needed

---

**Last Updated:** February 19, 2026  
**Version:** 1.0  
**Maintained by:** DevOps Team
