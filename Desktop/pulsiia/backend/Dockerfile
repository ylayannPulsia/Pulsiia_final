# Pulsiia backend — image de production
# Build : docker build -t pulsiia-backend ./backend
# Run   : utilisé par docker-compose.prod.yml (phase 5 du CDC)

FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl tini \
  && addgroup -S pulsiia && adduser -S pulsiia -G pulsiia
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY package*.json ./
COPY src ./src
RUN mkdir -p uploads keys && chown -R pulsiia:pulsiia /app
USER pulsiia
EXPOSE 3001
ENV NODE_ENV=production
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
