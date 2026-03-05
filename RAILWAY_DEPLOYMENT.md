# Railway Deployment Guide for Phone Party

This guide covers deploying Phone Party to Railway with proper Redis configuration.

## Prerequisites

- GitHub account with this repository
- Railway account (https://railway.app)
- PostgreSQL database (for auth features)
- Redis (for party sync)

## Initial Deployment

### 1. Create Railway Project

1. Go to https://railway.app/new
2. Choose "Deploy from GitHub repo"
3. Select this repository
4. Railway will auto-detect Node.js and deploy

### 2. Add Redis Service

1. In your Railway project, click "+ New"
2. Select "Database" → "Add Redis"
3. Railway automatically sets `REDIS_URL` variable
4. Verify format is `rediss://default:xxx@xxx.railway.internal:6379` (note `rediss://` with double 's')

### 3. Add PostgreSQL Service (for auth)

1. Click "+ New"
2. Select "Database" → "Add PostgreSQL"
3. Railway automatically sets `DATABASE_URL` variable

### 4. Configure Environment Variables

Go to your app service → Variables tab and set:

#### Required Variables
```
NODE_ENV=production
REDIS_URL=(automatically set by Redis plugin)
DATABASE_URL=(automatically set by PostgreSQL plugin)
PORT=8080
```

#### Optional Security Variables
```
JWT_SECRET=(generate with: openssl rand -base64 32)
SESSION_SECRET=(generate with: openssl rand -base64 32)
```

#### Monitoring & Analytics (Recommended)
```
# Error Tracking - Get from https://sentry.io
SENTRY_DSN=https://YOUR_KEY@YOUR_ORG.ingest.sentry.io/YOUR_PROJECT_ID

# Analytics - Get from https://analytics.google.com
GA_MEASUREMENT_ID=G-XXXXXXXXXX
```

#### Optional Configuration
```
# TLS certificate verification (default: false for Railway)
REDIS_TLS_REJECT_UNAUTHORIZED=false

# Emergency fallback (NOT recommended for production)
# ALLOW_FALLBACK_IN_PRODUCTION=false
```

### 5. Apply Database Migrations

After first deployment, apply the performance indexes:

```bash
# Connect to Railway PostgreSQL (get connection string from Railway dashboard)
psql $DATABASE_URL -f db/migrations/001_add_performance_indexes.sql
```

Or use Railway's built-in shell:
1. Go to your PostgreSQL service → Shell tab
2. Copy and paste the contents of `db/migrations/001_add_performance_indexes.sql`

### 6. Verify Deployment

1. Wait for deployment to complete
2. Check logs for successful startup:
   ```
   ✅ Redis connected and ready
   ✅ Database connected successfully
   🎉 Server ready to accept connections
   ```

3. Test health endpoint:
   ```bash
   curl https://your-app.railway.app/api/health
   ```
   
   Should return:
   ```json
   {
     "ok": true,
     "redis": {
       "connected": true,
       "status": "ready"
     }
   }
   ```

## Service Configuration

### Railway.json (Optional)

Create `railway.json` in project root for advanced configuration:

```json
{
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "numReplicas": 1,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

## Troubleshooting

### Redis Connection Issues

If you see "Server not ready - Redis unavailable":

1. **Check Redis service is running:**
   - Go to Redis service in Railway dashboard
   - Verify status is "Active"

2. **Check REDIS_URL format:**
   - Should be `rediss://` (double 's' for TLS)
   - Should be `@xxx.railway.internal:6379` (Railway internal network)

3. **Restart services in order:**
   - First: Restart Redis service
   - Wait 30 seconds
   - Then: Restart app service

4. **Check logs:**
   - Look for Redis connection errors
   - See `REDIS_DIAGNOSIS.md` for detailed troubleshooting

### Database Connection Issues

If database features aren't working:

1. Verify `DATABASE_URL` is set
2. Check PostgreSQL service is running
3. Review logs for database errors
4. Ensure schema initialization succeeded

### Health Check Shows 503

This means server started but Redis isn't ready:

1. Check `/api/debug/redis` for detailed diagnostics
2. Verify REDIS_URL is correctly formatted
3. Restart Redis service first, then app
4. See `REDIS_DIAGNOSIS.md` for complete checklist

## Scaling Considerations

### Single Instance (Current)
- Default configuration
- Suitable for most use cases
- All features work correctly

### Multi-Instance (Advanced)
Phone Party supports multi-instance deployment with Redis Pub/Sub:

1. **Enable in Railway:**
   - Currently limited to 1 replica
   - Contact Railway for multi-replica access

2. **Verify configuration:**
   - `ENABLE_PUBSUB` should be `true` (default)
   - Redis must be healthy across all instances

3. **Test sync:**
   - Create party on instance A
   - Join from instance B
   - Verify sync works correctly

## Monitoring

### Health Endpoints

Set up monitoring with these endpoints:

1. **Basic health:** `GET /health`
   - Quick status check
   - Returns 200 if server is running

2. **Detailed health:** `GET /api/health`
   - Returns 200 if ready, 503 if not
   - Includes Redis connection status
   - Use for uptime monitoring

3. **Debug endpoint:** `GET /api/debug/redis`
   - Detailed Redis diagnostics
   - Connection details (no secrets)
   - Useful for troubleshooting

### Recommended Alerts

Set up alerts for:
- `/api/health` returns 503
- Response time > 5 seconds
- Error rate > 5%

## Performance Optimization

### 1. Enable Keep-Alive
Already enabled in production configuration.

### 2. Connection Pooling
Redis connection pool is automatically managed by ioredis.

### 3. WebSocket Configuration
- Heartbeat: 30s
- Automatic reconnection enabled
- Max payload: 10MB

## Security Best Practices

### 1. Environment Variables
✅ Never commit secrets to git
✅ Use Railway's secret management
✅ Rotate JWT_SECRET periodically

### 2. Redis Security
✅ Use `rediss://` (TLS) - Railway default
✅ Authentication enabled automatically
✅ Internal network only (Railway)

### 3. Database Security
✅ TLS connections - Railway default
✅ Strong passwords - Railway generated
✅ Internal network only (Railway)

### 4. Rate Limiting
Built-in rate limiting:
- Auth endpoints: 10 requests per 15 minutes
- General API: 100 requests per minute
- Party creation: 5 per minute

## Backup and Recovery

### Redis Persistence
Railway Redis includes:
- Automatic snapshots
- Point-in-time recovery
- Managed backups

### Database Backups
Railway PostgreSQL includes:
- Daily automated backups
- 7-day retention
- One-click restore

## Cost Optimization

### Current Resource Usage
- App: ~512MB RAM, 0.5 vCPU
- Redis: ~100MB RAM
- PostgreSQL: ~100MB RAM

### Tips
1. Use single instance until traffic requires scaling
2. Monitor resource usage in Railway dashboard
3. Set up alerts for unusual spikes

## Deployment Checklist

Before going to production:

- [ ] Redis service active and connected
- [ ] PostgreSQL service active and connected
- [ ] All environment variables set
- [ ] `/api/health` returns 200 OK
- [ ] Test party creation and joining
- [ ] Test multi-device sync
- [ ] Set up health monitoring
- [ ] Configure custom domain (optional)
- [ ] Review logs for errors
- [ ] Test WebSocket connections
- [ ] Verify rate limiting works
- [ ] Check security headers

## Support

### Railway Support
- Documentation: https://docs.railway.app
- Community: https://discord.gg/railway
- Status: https://status.railway.app

### Application Issues
- Check `REDIS_DIAGNOSIS.md` for Redis issues
- Review logs in Railway dashboard
- Check `/api/debug/redis` for diagnostics

## Update Process

To deploy updates:

1. **Automatic (recommended):**
   - Push to main branch on GitHub
   - Railway auto-deploys

2. **Manual:**
   - Go to Railway dashboard
   - Click "Redeploy" on latest commit

3. **Rollback:**
   - Go to Deployments
   - Click on previous successful deployment
   - Select "Redeploy"

## Next Steps

After successful deployment:
1. Set up custom domain in Railway
2. Configure health monitoring
3. Test all features end-to-end
4. Monitor logs for first 24 hours
5. Set up alerting for critical issues

---

**Note:** This guide assumes Railway's default configuration. For advanced setups or custom infrastructure, refer to Railway documentation.
