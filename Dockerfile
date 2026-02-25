# Phone Party - Production Dockerfile
# Multi-stage build for minimal production image


# ============================================================================
# Stage 1: Dependencies
# ============================================================================
FROM node:18-alpine AS dependencies

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# ============================================================================
# Stage 2: Production
# ============================================================================
FROM node:18-alpine AS production

# Install dumb-init to handle signals properly
RUN apk add --no-cache dumb-init curl

# Create non-root user for security
RUN addgroup -g 1001 -S phoneparty && \
    adduser -S -u 1001 -G phoneparty phoneparty


	# Copy production dependencies from previous stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy application files
COPY --chown=phoneparty:phoneparty . .

# Create directory for uploads (if needed)
RUN mkdir -p /app/uploads && chown phoneparty:phoneparty /app/uploads

# Switch to non-root user
USER phoneparty

# Expose port (can be overridden by PORT env var)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Use dumb-init to handle signals
ENTRYPOINT ["dumb-init", "--"]

# Start application
CMD ["node", "server.js"]
