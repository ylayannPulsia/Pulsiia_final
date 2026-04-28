#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# init-ssl.sh — Première émission des certificats Let's Encrypt
# ─────────────────────────────────────────────────────────────
# À lancer UNE FOIS au premier déploiement, avant de démarrer
# le stack complet.
#
# Étapes :
#   1. Démarre nginx en mode HTTP-only temporaire
#   2. Demande les certs pour app.pulsiia.com et pulsiia.com
#   3. Reload nginx en mode HTTPS
# ─────────────────────────────────────────────────────────────

set -euo pipefail

DOMAINS=("app.pulsiia.com" "pulsiia.com" "www.pulsiia.com")
EMAIL="${LETSENCRYPT_EMAIL:-admin@pulsiia.com}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
STAGING="${STAGING:-0}"  # mettre à 1 pour tester (pas de rate limit LE)

# ─── Vérifs ───────────────────────────────────────────────
[ -f "$COMPOSE_FILE" ] || { echo "❌ $COMPOSE_FILE manquant"; exit 1; }
[ -f .env.production ] || { echo "❌ .env.production manquant"; exit 1; }

# ─── Vérifie que les domaines pointent vers ce serveur ───
echo "🔍 Vérification DNS..."
SERVER_IP=$(curl -s ifconfig.me)
for domain in "${DOMAINS[@]}"; do
  RESOLVED=$(dig +short "$domain" | tail -1)
  if [ "$RESOLVED" != "$SERVER_IP" ]; then
    echo "⚠️  $domain résout vers $RESOLVED (attendu: $SERVER_IP)"
    read -p "Continuer quand même ? (yes/NO) : " confirm
    [ "$confirm" = "yes" ] || exit 1
  else
    echo "✅ $domain → $SERVER_IP"
  fi
done

# ─── 1. Crée un nginx HTTP-only temporaire pour l'ACME ────
echo "🚀 Démarrage Nginx temporaire..."
mkdir -p ./nginx/conf.d-bootstrap
cat > ./nginx/conf.d-bootstrap/bootstrap.conf <<EOF
server {
  listen 80;
  server_name ${DOMAINS[*]};

  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }

  location / {
    return 200 "Pulsiia bootstrap";
    add_header Content-Type text/plain;
  }
}
EOF

docker run -d --rm \
  --name pulsiia-nginx-bootstrap \
  -p 80:80 \
  -v "$(pwd)/nginx/conf.d-bootstrap:/etc/nginx/conf.d:ro" \
  -v pulsiia-certbot-www:/var/www/certbot \
  nginx:1.27-alpine

sleep 3

# ─── 2. Demande des certs ─────────────────────────────────
STAGING_FLAG=""
[ "$STAGING" = "1" ] && STAGING_FLAG="--staging"

DOMAIN_ARGS=""
for d in "${DOMAINS[@]}"; do
  DOMAIN_ARGS="$DOMAIN_ARGS -d $d"
done

echo "🔐 Requesting Let's Encrypt cert for: ${DOMAINS[*]}"
docker run --rm \
  -v pulsiia-certbot:/etc/letsencrypt \
  -v pulsiia-certbot-www:/var/www/certbot \
  certbot/certbot:latest \
  certonly --webroot -w /var/www/certbot \
  --email "$EMAIL" \
  --agree-tos --no-eff-email \
  $STAGING_FLAG \
  --non-interactive \
  $DOMAIN_ARGS

# ─── 3. Stop nginx bootstrap ──────────────────────────────
echo "🧹 Cleanup bootstrap..."
docker stop pulsiia-nginx-bootstrap
rm -rf ./nginx/conf.d-bootstrap

# ─── 4. Démarre le stack complet ──────────────────────────
echo "🚀 Démarrage stack production..."
docker compose -f "$COMPOSE_FILE" up -d

echo ""
echo "✅ SSL setup complete !"
echo ""
echo "Vérifie dans ~30s :"
echo "  curl -I https://app.pulsiia.com"
echo "  curl https://www.ssllabs.com/ssltest/analyze.html?d=app.pulsiia.com"
