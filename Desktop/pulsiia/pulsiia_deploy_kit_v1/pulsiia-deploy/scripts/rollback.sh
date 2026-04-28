#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# rollback.sh — Rollback rapide en cas de souci post-deploy
# ─────────────────────────────────────────────────────────────
# Usage : ./scripts/rollback.sh [--restore-db <backup-file>]
#
# Par défaut, restore uniquement l'image précédente.
# Avec --restore-db, restore aussi la DB depuis un backup donné.
# ─────────────────────────────────────────────────────────────

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
HEALTH_URL="${HEALTH_URL:-https://app.pulsiia.com/health}"
SLACK_WEBHOOK="${DEPLOY_SLACK_WEBHOOK:-}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
log() { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

# Parse args
RESTORE_DB=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restore-db) RESTORE_DB="$2"; shift 2 ;;
    *) fail "Argument inconnu : $1" ;;
  esac
done

# ─── Confirmation interactive ─────────────────────────────
echo -e "${RED}⚠️  ROLLBACK PRODUCTION${NC}"
echo "Cette action va :"
echo "  - Restaurer l'image Docker précédente"
[ -n "$RESTORE_DB" ] && echo "  - Restaurer la DB depuis : $RESTORE_DB"
echo ""
read -p "Continuer ? (yes/NO) : " confirm
[ "$confirm" = "yes" ] || fail "Annulé"

# ─── 1. Récupère l'image précédente ───────────────────────
[ -f .last-deployed-image ] || fail ".last-deployed-image manquant — rollback impossible"
PREVIOUS_IMAGE=$(cat .last-deployed-image)
[ -z "$PREVIOUS_IMAGE" ] && fail "Image précédente vide"

log "🔙 Rolling back to ${PREVIOUS_IMAGE:0:20}..."

# ─── 2. Restore DB si demandé ─────────────────────────────
if [ -n "$RESTORE_DB" ]; then
  [ -f "$RESTORE_DB" ] || fail "Backup file not found: $RESTORE_DB"
  log "🗃  Restoring DB from $RESTORE_DB..."

  # Confirmation supplémentaire
  read -p "⚠️  Cela va ÉCRASER la DB actuelle. Confirmer ? (yes/NO) : " dbconfirm
  [ "$dbconfirm" = "yes" ] || fail "DB restore annulé"

  # Stop l'app pour qu'aucune requête n'arrive pendant le restore
  docker compose -f "$COMPOSE_FILE" stop app

  # Drop + recreate (PRUDENT — on devrait dump current avant)
  log "📸 Snapshot current DB before overwrite..."
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump -U "${DB_USER:-pulsiia}" "${DB_NAME:-pulsiia_prod}" \
    | gzip > "backups/pre-rollback-$(date +%Y%m%d-%H%M%S).sql.gz"

  log "♻️  Restoring..."
  if [[ "$RESTORE_DB" == *.gz ]]; then
    gunzip -c "$RESTORE_DB" | docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U "${DB_USER:-pulsiia}" "${DB_NAME:-pulsiia_prod}"
  else
    cat "$RESTORE_DB" | docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U "${DB_USER:-pulsiia}" "${DB_NAME:-pulsiia_prod}"
  fi
fi

# ─── 3. Restore image ─────────────────────────────────────
log "🔄 Restoring app image..."
docker tag "$PREVIOUS_IMAGE" pulsiia/app:rollback
PULSIIA_VERSION=rollback docker compose -f "$COMPOSE_FILE" up -d --no-deps app

# ─── 4. Healthcheck ───────────────────────────────────────
log "🏥 Verifying rollback..."
for i in $(seq 1 30); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || echo "000")
  if [ "$STATUS" = "200" ]; then
    log "✅ Rollback successful !"

    [ -n "$SLACK_WEBHOOK" ] && curl -s -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"⚠️ Pulsiia rolled back to ${PREVIOUS_IMAGE:0:20}\"}" "$SLACK_WEBHOOK" >/dev/null

    exit 0
  fi
  sleep 1
done

fail "Health check failed after rollback. Manual intervention required."
