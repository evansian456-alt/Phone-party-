# Stripe Billing

Phone Party uses **Stripe Checkout** for PRO monthly subscriptions (web only).

---

## Required Environment Variables

| Variable | Where to set | Description |
|---|---|---|
| `STRIPE_SECRET_KEY` | Cloud Run secret / `.env` | Stripe secret key (starts `sk_live_` or `sk_test_`) |
| `STRIPE_WEBHOOK_SECRET` | Cloud Run secret / `.env` | Signing secret from the Stripe webhook endpoint (starts `whsec_`) |
| `STRIPE_PRICE_ID_PRO_MONTHLY` | Cloud Run env var | Stripe Price ID for the PRO monthly plan |
| `PUBLIC_BASE_URL` | Cloud Run env var | Full HTTPS URL of the app, e.g. `https://syncspeaker-xxxxx.a.run.app` |

Optional:

| Variable | Description |
|---|---|
| `STRIPE_PORTAL_RETURN_URL` | URL to return to after the customer portal (defaults to `PUBLIC_BASE_URL`) |

---

## Webhook Endpoint

```
POST /api/billing/webhook
```

Configure this URL in your Stripe Dashboard → **Developers → Webhooks**.

### Events to enable

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`

---

## Database Migration

Run **migration 003** before deploying:

```bash
node scripts/db-migrate.js
```

or apply directly:

```sql
-- db/migrations/003_add_stripe_billing_columns.sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT NULL,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT NULL,
  ADD COLUMN IF NOT EXISTS subscription_status     TEXT NULL,
  ADD COLUMN IF NOT EXISTS current_period_end      TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS tier                    TEXT NOT NULL DEFAULT 'FREE';
```

---

## Tier Policy

| Subscription status | `users.tier` |
|---|---|
| `active` | `PRO` |
| `trialing` | `PRO` |
| `past_due` | `FREE` (conservative) |
| `canceled` / `deleted` | `FREE` |
| `unpaid` | `FREE` |

---

## Local Testing

### 1. Set up test keys

Add to your local `.env`:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...   # from stripe listen output
STRIPE_PRICE_ID_PRO_MONTHLY=price_...
PUBLIC_BASE_URL=http://localhost:8080
```

### 2. Forward webhooks with Stripe CLI (optional)

```bash
stripe listen --forward-to localhost:8080/api/billing/webhook
```

Copy the signing secret printed by `stripe listen` into `STRIPE_WEBHOOK_SECRET`.

### 3. Trigger a test checkout

1. Log in and click **Upgrade to Pro** on the party home screen.
2. Complete the Stripe test checkout (use card `4242 4242 4242 4242`).
3. You'll be redirected to `/?billing=success`.
4. The app polls `/api/billing/status` until `tier === 'PRO'`.

### 4. Running unit tests (no external services needed)

```bash
npm test -- billing.test.js
```

All tests mock Stripe and the database.

---

## Production Verification

```bash
# 1. Check billing status (replace TOKEN with a valid auth_token cookie value)
curl -s https://syncspeaker-xxxxx.a.run.app/api/billing/status \
  -H "Cookie: auth_token=TOKEN" | jq .

# 2. Confirm /api/me shows tier PRO after purchase
curl -s https://syncspeaker-xxxxx.a.run.app/api/me \
  -H "Cookie: auth_token=TOKEN" | jq '{tier, billing}'
```

---

## Cloud Run Rollout Steps

1. Add the four env vars to Cloud Run (via Secret Manager for secret values):
   - `STRIPE_SECRET_KEY` → Secret Manager secret
   - `STRIPE_WEBHOOK_SECRET` → Secret Manager secret
   - `STRIPE_PRICE_ID_PRO_MONTHLY` → plain env var
   - `PUBLIC_BASE_URL` → already set

2. Apply database migration 003.

3. Deploy new revision via Cloud Build.

4. In Stripe Dashboard → Webhooks → Add endpoint:
   - URL: `https://YOUR_SERVICE_URL/api/billing/webhook`
   - Select the six events listed above.
   - Copy the signing secret → update `STRIPE_WEBHOOK_SECRET` secret.

5. Verify with the `curl` commands above.
