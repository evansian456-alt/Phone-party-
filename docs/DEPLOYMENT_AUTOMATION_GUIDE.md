# Automated Deployment Setup Guide

This guide explains how to set up automated deployments to Railway using GitHub Actions.

## Overview

The automated deployment workflow (`.github/workflows/deploy.yml`) automatically deploys your application to Railway whenever code is pushed to the `main` branch.

## Prerequisites

1. **Railway Account**: Sign up at https://railway.app
2. **Railway Project**: Create a project with:
   - Node.js service (your app)
   - PostgreSQL database
   - Redis database
3. **GitHub Repository**: This repository with write access

## Setup Steps

### 1. Get Railway Token

1. Go to https://railway.app/account/tokens
2. Click "Create Token"
3. Give it a name (e.g., "GitHub Actions Deploy")
4. Copy the token (you won't see it again!)

### 2. Add GitHub Secret

1. Go to your GitHub repository → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Name: `RAILWAY_TOKEN`
4. Value: Paste your Railway token
5. Click "Add secret"

### 3. Configure Railway Service Name

The workflow expects a service named `syncspeaker`. If your Railway service has a different name:

1. Edit `.github/workflows/deploy.yml`
2. Find the line: `service: syncspeaker`
3. Change `syncspeaker` to your actual service name

### 4. Set Up Railway Environment Variables

In your Railway project dashboard, configure these environment variables:

#### Required
- `NODE_ENV=production`
- `PORT=8080`
- `DATABASE_URL` (automatically set by PostgreSQL plugin)
- `REDIS_URL` (automatically set by Redis plugin)

#### Recommended for Production
- `SENTRY_DSN` - Error tracking (from https://sentry.io)
- `GA_MEASUREMENT_ID` - Google Analytics (from https://analytics.google.com)
- `JWT_SECRET` - Generate with: `openssl rand -base64 32`
- `SESSION_SECRET` - Generate with: `openssl rand -base64 32`

### 5. Test the Deployment

1. Push a commit to the `main` branch:
   ```bash
   git add .
   git commit -m "Test automated deployment"
   git push origin main
   ```

2. Watch the deployment:
   - Go to GitHub → Actions tab
   - You should see a new workflow run
   - Click on it to see the progress

3. Verify deployment success:
   - Check Railway dashboard for new deployment
   - Visit your app URL
   - Check `/api/health` endpoint

## Workflow Features

The automated deployment workflow:

1. ✅ Runs on every push to `main`
2. ✅ Can be triggered manually (workflow_dispatch)
3. ✅ Installs dependencies with `npm ci`
4. ✅ Runs full test suite before deploying
5. ✅ Only deploys if tests pass
6. ✅ Deploys to Railway using official action
7. ✅ Shows success/failure notifications

## Manual Deployment Trigger

You can also trigger deployments manually:

1. Go to GitHub → Actions tab
2. Select "Deploy to Railway" workflow
3. Click "Run workflow"
4. Select the branch (usually `main`)
5. Click "Run workflow" button

## Troubleshooting

### Deployment fails with "railway_token" error
- Check that `RAILWAY_TOKEN` secret is set correctly in GitHub
- Verify the token hasn't expired (tokens don't expire, but can be revoked)

### Deployment succeeds but app doesn't work
- Check Railway logs for startup errors
- Verify all environment variables are set
- Check database connection (DATABASE_URL)
- Check Redis connection (REDIS_URL)

### Tests fail in CI
- Run tests locally: `npm test`
- Check test output in GitHub Actions logs
- Tests must pass before deployment proceeds

### Database migrations not applied
- Migrations are NOT automatically applied by the deployment workflow
- You must manually apply them after first deployment:
  ```bash
  # Get DATABASE_URL from Railway dashboard
  psql $DATABASE_URL -f db/migrations/001_add_performance_indexes.sql
  ```

## Security Notes

1. **Never commit the Railway token** - Always use GitHub Secrets
2. **Rotate tokens periodically** - Generate new tokens every 3-6 months
3. **Use environment-specific tokens** - Different tokens for staging/production
4. **Review deployment logs** - Check for exposed secrets or errors

## Monitoring Deployments

### GitHub Actions
- Go to Actions tab to see all deployment runs
- Click on any run to see detailed logs
- Green checkmark = successful deployment
- Red X = failed deployment

### Railway Dashboard
- See deployment history in Railway project
- View logs for each deployment
- Monitor resource usage and errors

## Advanced Configuration

### Deploy to Multiple Environments

To set up staging + production:

1. Create separate Railway projects for staging and production
2. Add separate GitHub secrets:
   - `RAILWAY_TOKEN_STAGING`
   - `RAILWAY_TOKEN_PRODUCTION`
3. Modify workflow to deploy based on branch:
   - `develop` → staging
   - `main` → production

See `.github/workflows/deploy.yml` comments for example configuration.

### Skip Tests for Hotfix

If you need to deploy without running tests (emergency only):

1. Go to GitHub → Actions
2. Select the workflow run
3. Click "Re-run jobs"
4. Modify the workflow temporarily to set `continue-on-error: true` for tests

**Note**: This is not recommended for regular deployments!

## Cost Considerations

- GitHub Actions: Free for public repositories, 2000 minutes/month for private
- Railway: Pay-as-you-go based on resource usage
- Typical deployment time: 2-5 minutes

## Next Steps

After setting up automated deployment:

1. ✅ Apply database migrations (see step above)
2. ✅ Configure custom domain in Railway
3. ✅ Set up error tracking (Sentry)
4. ✅ Configure analytics (Google Analytics)
5. ✅ Monitor first deployments closely
6. ✅ Set up alerts for deployment failures

## Support

- Railway docs: https://docs.railway.app
- GitHub Actions docs: https://docs.github.com/actions
- Deployment issues: Check GitHub Actions logs and Railway logs
