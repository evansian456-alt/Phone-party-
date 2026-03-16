# Admin Configuration Guide

This document explains how admin users are configured in Phone Party, including how the
system determines who has admin access, which files contain the admin logic, and how to
add or update admin email addresses.

---

## How Admin Access Works

Admin status is determined entirely by an **environment variable allowlist** (`ADMIN_EMAILS`).
There are no hardcoded email addresses in the source code.

### Flow

```
User logs in
     │
     ▼
server.js: POST /api/auth/login
     │
     ├─ isAdminEmail(user.email)    ← reads ADMIN_EMAILS env var
     │       │
     │       ├─ TRUE  → UPDATE users SET is_admin = TRUE WHERE id = $1
     │       │           (promotes on first login; no-op if already admin)
     │       └─ FALSE → no change
     │
     ▼
generateToken({ userId, email, isAdmin: user.is_admin })
     │
     ▼
JWT cookie set (auth_token, HTTP-only, 7 days)
     │
     ▼
Any /api/admin/* request
     │
     ▼
requireAdmin middleware (auth-middleware.js)
     ├─ No cookie      → 401 Unauthorized
     ├─ Invalid token  → 401 Unauthorized
     ├─ isAdmin=false  → 403 Forbidden
     └─ isAdmin=true   → ✅ allowed
```

---

## Files Containing Admin Logic

| File | What it does |
|------|-------------|
| `auth-middleware.js` | `isAdminEmail()` — reads `ADMIN_EMAILS` and checks membership; `requireAdmin` — Express middleware that gates all `/api/admin/*` routes |
| `server.js` | Login handler promotes user on first login (lines ~1735–1751); `/api/me` returns `isAdmin` and `effectiveTier`; all `/api/admin/*` routes use `requireAdmin` |
| `db/migrations/004_add_is_admin_column.sql` | Adds `is_admin BOOLEAN NOT NULL DEFAULT FALSE` column to the `users` table |
| `db/schema.sql` | Base schema includes the `is_admin` column |
| `.env.example` | Documents `ADMIN_EMAILS` with example value |
| `docs/ENVIRONMENT.md` | Full specification for the `ADMIN_EMAILS` variable |

---

## Exact Code Responsible for Admin Authorization

### `auth-middleware.js` — `isAdminEmail()`

```javascript
function isAdminEmail(email) {
  if (!email) return false;
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes(email.trim().toLowerCase());
}
```

Reads `process.env.ADMIN_EMAILS` at **call time** (not at module load), so the env var can
be changed without restarting the process in tests. In production you must restart the server
after changing `ADMIN_EMAILS`.

### `auth-middleware.js` — `requireAdmin` middleware

```javascript
function requireAdmin(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = decoded;
  if (!decoded.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
```

### `server.js` — Admin bootstrap on login

```javascript
// Admin bootstrap: promote user on first successful login if email is in ADMIN_EMAILS allowlist
const isAdminByAllowlist = authMiddleware.isAdminEmail(user.email);
const legacyBootstrapEmail = process.env.ADMIN_BOOTSTRAP_EMAIL
  ? process.env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase()
  : null;
const shouldBeAdmin = isAdminByAllowlist || (legacyBootstrapEmail && user.email === legacyBootstrapEmail);
if (shouldBeAdmin && !user.is_admin) {
  await db.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [user.id]);
  user.is_admin = true;
}

// JWT includes isAdmin so requireAdmin middleware works without a DB query
const token = authMiddleware.generateToken({
  userId: user.id,
  email: user.email,
  isAdmin: user.is_admin || false
});
```

### Admin Routes (all protected by `requireAdmin`)

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/admin/stats` | Live dashboard statistics |
| `GET` | `/api/admin/recent` | Recent signups and logins |
| `GET` | `/api/admin/moderation/reports` | Content moderation reports |
| `GET` | `/api/admin/moderation/flagged-messages` | Flagged chat messages |
| `GET` | `/api/admin/moderation/user-history/:userId` | Per-user moderation history |
| `POST` | `/api/admin/moderation/action` | Apply moderation action |
| `POST` | `/api/admin/promo-codes` | Create a promo code |
| `GET` | `/api/admin/promo-codes` | List all promo codes |

---

## Setting or Updating the Admin Email

### Step 1 — Set the environment variable

Add `ADMIN_EMAILS` to your deployment's environment configuration.
Comma-separate multiple emails; whitespace and letter-case are ignored.

```bash
# Single admin
ADMIN_EMAILS=ianevans2023@outlook.com

# Multiple admins
ADMIN_EMAILS=ianevans2023@outlook.com,backup-admin@example.com
```

#### Platform-specific instructions

**Railway:**
1. Open your project → *Variables* tab
2. Add `ADMIN_EMAILS` with your email value
3. Redeploy (Railway redeploys automatically on variable changes)

**Google Cloud Run:**
```bash
gcloud run services update phone-party \
  --update-env-vars ADMIN_EMAILS=your@email.com
```

**Local development (`.env` file):**
```bash
# .env  (never commit this file)
ADMIN_EMAILS=your@email.com
```

**Heroku:**
```bash
heroku config:set ADMIN_EMAILS=your@email.com
```

### Step 2 — Log in with the admin account

Admin status is **promoted on the first successful login** after the env var is set.
Simply log in with the matching email address; no manual database changes are needed.

### Step 3 — Verify

Call `/api/me` with the authenticated session. The response should include:
```json
{
  "isAdmin": true,
  "effectiveTier": "PRO"
}
```

---

## Revoking Admin Access

Admin status is only promoted, never automatically demoted. To remove an admin:

1. Remove the email from `ADMIN_EMAILS` and restart the server.
2. Manually clear the database flag:
   ```sql
   UPDATE users SET is_admin = FALSE WHERE email = 'former-admin@example.com';
   ```

After step 2 the user's next login will not include `isAdmin: true` in their JWT, and all
`/api/admin/*` requests will return `403`.

---

## Admin Effects on a User Account

| Benefit | Description |
|---------|-------------|
| `isAdmin: true` in JWT | Grants access to all `/api/admin/*` endpoints |
| `effectiveTier: PRO` | Admin accounts behave as PRO tier regardless of their purchased tier |
| `hasPartyPass: true` | Party pass features are always unlocked |
| `hasPro: true` | PRO features are always unlocked |
| Never charged | Admin accounts bypass billing/paywall checks |

---

## Security Notes

- **Never hardcode emails** in source code. Always use `ADMIN_EMAILS`.
- `ADMIN_EMAILS` should be treated as a secret on your deployment platform (access is equivalent to full app admin).
- The `isAdmin` JWT claim is checked on every admin route — there is no session-level caching beyond the token lifetime (7 days). If you need to revoke access immediately, also invalidate the JWT by rotating `JWT_SECRET`.
- The legacy `ADMIN_BOOTSTRAP_EMAIL` single-email variable is still supported for backwards compatibility but `ADMIN_EMAILS` is preferred.

---

**Last Updated:** March 2026
