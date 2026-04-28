# ─────────────────────────────────────────────────────────────
# Pulsiia App — Production Dockerfile (multi-stage)
# ─────────────────────────────────────────────────────────────
# Stage 1: deps install + build
# Stage 2: runtime image (~150MB Alpine + node only)
# ─────────────────────────────────────────────────────────────

# ─── Stage 1 : builder ───────────────────────────────────────
FROM node:20-alpine AS builder

# Outils requis pour bcrypt et compilation native
RUN apk add --no-cache python3 make g++ openssl

WORKDIR /build

# Cache layer pour deps
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --include=dev

# Copie du code et build
COPY . .

# Génère le client Prisma
RUN npx prisma generate

# Build (si TypeScript ou bundler — ajuster selon ton setup)
# RUN npm run build

# Cleanup dev deps
RUN npm prune --production

# ─── Stage 2 : runtime ───────────────────────────────────────
FROM node:20-alpine AS runtime

# Outils minimaux pour healthcheck et debug
RUN apk add --no-cache wget tini openssl ca-certificates && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copie depuis le builder (uniquement runtime + node_modules clean)
COPY --from=builder --chown=nodejs:nodejs /build/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /build/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /build/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /build/src ./src
COPY --from=builder --chown=nodejs:nodejs /build/packages ./packages

# Healthcheck endpoint baked-in
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Non-root user
USER nodejs

# Tini = init proper (signal handling, zombie cleanup)
ENTRYPOINT ["/sbin/tini", "--"]

EXPOSE 3000

# Migration auto au démarrage + start
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
