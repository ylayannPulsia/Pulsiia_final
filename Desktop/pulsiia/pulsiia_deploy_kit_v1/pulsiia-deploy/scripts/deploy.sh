#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# deploy.sh — Zero-downtime deployment Pulsiia
# ─────────────────────────────────────────────────────────────
# Usage : ./scripts/deploy.sh <version-tag>
# Example : ./scripts/deploy.sh v1.0.3
#
# Étapes :
#   1. Pull la nouvelle image
#   2. Run migrations Prisma (séparément, sur l'image cible)
#   3. Recreate le service `app` avec rolling restart
#   4. Healthcheck post-deploy
#   5. Notification Slack (optionnel)
# ─────────────────────────────────────────────────────────────

set -euo pipefail

VERSION="${1:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SLACK_WEBHOOK="${DEPLOY_SLACK_WEBHOOK:-}"
HEALTH_URL="${HEALTH_URL:-https://app.pulsiia.com/health}"

if [ -z "$VERSION" ]; then
  echo "❌ Usage : $0 <version-tag>"
  echo "   Example : $0 v1.0.3"
  exit 1
fi

# Couleurs
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

log() { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[$(date +'%H:%M:%S')] WARN${NC} $1"; }
fail() { echo -e "${RED}[$(date +'%H:%M:%S')] FAIL${NC} $1"; exit 1; }

notify_slack() {
  [ -z "$SLACK_WEBHOOK" ] && return 0
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"$1\"}" "$SLACK_WEBHOOK" >/dev/null || true
}

# ─── Pré-checks ───────────────────────────────────────────
log "🔍 Pre-flight checks..."
[ -f .env.production ] || fail ".env.production missing"
[ -f "$COMPOSE_FILE" ] || fail "$COMPOSE_FILE missing"

# Charge la version dans l'env utilisé par compose
export PULSIIA_VERSION="$VERSION"

# ─── 1. Pull de la nouvelle image ──────────────────────────
log "📥 Pulling pulsiia/app:$VERSION..."
docker compose -f "$COMPOSE_FILE" pull app || fail "Pull failed"

# Sauvegarde l'ID de l'image actuelle (pour rollback)
CURRENT_IMAGE=$(docker inspect pulsiia-app --format='{{.Image}}' 2>/dev/null || echo "")
echo "$CURRENT_IMAGE" > .last-deployed-image
log "🔖 Current image saved : ${CURRENT_IMAGE:0:20}..."

# ─── 2. Migrations Prisma (sur container temporaire) ──────
log "🗃  Running database migrations..."
docker compose -f "$COMPOSE_FILE" run --rm \
  --entrypoint "" \
  app sh -c "npx prisma migrate deploy" \
  || fail "Migrations failed — STOPPING deploy. Old version still running."

# ─── 3. Backup pré-deploy (sécurité) ──────────────────────
log "💾 Pre-deploy backup..."
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "${DB_USER:-pulsiia}" "${DB_NAME:-pulsiia_prod}" \
  | gzip > "backups/pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz" \
  || warn "Backup failed but continuing"

# ─── 4. Recreate du service app (rolling) ─────────────────
log "🔄 Rolling restart app service..."
docker compose -f "$COMPOSE_FILE" up -d --no-deps --remove-orphans app

# ─── 5. Healthcheck ───────────────────────────────────────
log "🏥 Waiting for healthcheck..."
MAX_TRIES=30
for i in $(seq 1 $MAX_TRIES); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || echo "000")
  if [ "$STATUS" = "200" ]; then
    log "✅ Health OK after ${i}s"
    break
  fi
  if [ "$i" = "$MAX_TRIES" ]; then
    fail "Health check failed after ${MAX_TRIES}s. Run rollback.sh ASAP."
  fi
  sleep 1
done

# ─── 6. Cleanup vieilles images (free disk) ───────────────
log "🧹 Pruning old images..."
docker image prune -f --filter "until=168h" >/dev/null || true

# ─── 7. Vérif post-deploy ─────────────────────────────────
log "🔬 Post-deploy smoke test..."
docker compose -f "$COMPOSE_FILE" ps

# ─── Done ─────────────────────────────────────────────────
log "🎉 Deployment $VERSION successful !"
notify_slack "✅ Pulsiia deployed: \`$VERSION\` — health OK"
