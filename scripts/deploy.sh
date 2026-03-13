#!/usr/bin/env bash
# =============================================================================
# Cloud Run Deployment Script
# =============================================================================
# Usage: ./scripts/deploy.sh [SERVICE_NAME] [REGION] [PROJECT_ID]
#
# REQUIRED production environment variables (set in GCP Secret Manager):
#   JWT_SECRET      REQUIRED — JWT signing secret (min 32 chars).
#                   Create: echo "$(openssl rand -base64 48)" | \
#                     gcloud secrets create JWT_SECRET --data-file=-
#
# REQUIRED production environment variables (set as Cloud Run env vars):
#   DATABASE_URL    REQUIRED — PostgreSQL connection string.
#   REDIS_URL       REQUIRED — Redis connection URL for multi-device sync.
#   NODE_ENV        Set to "production" automatically by this script.
#
# OPTIONAL:
#   SENTRY_DSN      Recommended — error tracking.
#   STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET — payment processing.
#   PUBLIC_BASE_URL — HTTPS base URL (auto-detected from Cloud Run if unset).
#
# Setup GCP Secret Manager (one-time):
#   gcloud secrets create JWT_SECRET --replication-policy=automatic
#   echo -n "your-secret-value" | gcloud secrets versions add JWT_SECRET --data-file=-
#
# =============================================================================
set -euo pipefail

SERVICE="${1:-syncspeaker}"
REGION="${2:-${GCP_REGION:-us-central1}}"
PROJECT="${3:-${GCP_PROJECT_ID:?GCP_PROJECT_ID must be set}}"
DATABASE_URL="${DATABASE_URL:-}"
REDIS_URL="${REDIS_URL:-}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://app.phone-party.com}"

echo "Deploying $SERVICE to Cloud Run (region=$REGION, project=$PROJECT) ..."

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT" \
  --allow-unauthenticated \
  --update-env-vars "NODE_ENV=production,DATABASE_URL=${DATABASE_URL},REDIS_URL=${REDIS_URL},PUBLIC_BASE_URL=${PUBLIC_BASE_URL}" \
  --update-secrets JWT_SECRET=JWT_SECRET:latest

echo "Deployment complete."
