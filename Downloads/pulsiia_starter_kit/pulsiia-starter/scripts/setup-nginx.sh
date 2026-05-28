#!/bin/bash
# ============================================================
#  Pulsiia — Setup Nginx + SSL Let's Encrypt
#  À lancer APRÈS setup-vps.sh
#  Usage : bash setup-nginx.sh pulsiia.com votre@email.com
# ============================================================
set -euo pipefail

DOMAIN="${1:-pulsiia.com}"
EMAIL="${2:-admin@pulsiia.com}"

echo "▶ Installation Nginx..."
apt-get install -y nginx
systemctl enable nginx

# ─── Config Nginx ─────────────────────────────────────────────
echo "▶ Configuration Nginx pour $DOMAIN..."

# Désactiver le site par défaut
rm -f /etc/nginx/sites-enabled/default

# Créer la config Pulsiia
cat > /etc/nginx/sites-available/pulsiia << EOF
# ── Rate limiting global ──────────────────────────────────────
limit_req_zone \$binary_remote_addr zone=api:10m rate=30r/m;
limit_req_zone \$binary_remote_addr zone=auth:10m rate=5r/m;
limit_conn_zone \$binary_remote_addr zone=conn_limit:10m;

# ── Redirect HTTP → HTTPS ─────────────────────────────────────
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN api.$DOMAIN;

    # Let's Encrypt challenge
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

# ── Landing page / Frontend : pulsiia.com ─────────────────────
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN www.$DOMAIN;

    # SSL (sera rempli par Certbot)
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # Headers sécurité
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    # Connexions simultanées par IP
    limit_conn conn_limit 20;

    # Logs
    access_log /var/log/nginx/pulsiia-access.log;
    error_log  /var/log/nginx/pulsiia-error.log warn;

    # Proxy vers Node.js (backend sert aussi le frontend statique)
    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # Rate limit sur les routes auth
    location /api/auth/ {
        limit_req zone=auth burst=5 nodelay;
        proxy_pass         http://127.0.0.1:3001;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }

    # Rate limit sur l'API générale
    location /api/ {
        limit_req zone=api burst=20 nodelay;
        proxy_pass         http://127.0.0.1:3001;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }

    # Bloquer les fichiers sensibles
    location ~ /\.(env|git|htaccess|htpasswd) {
        deny all;
        return 404;
    }

    # Taille max upload (documents RH)
    client_max_body_size 10M;
}
EOF

# Activer le site
ln -sf /etc/nginx/sites-available/pulsiia /etc/nginx/sites-enabled/pulsiia

# Vérifier la config
nginx -t

echo "✅ Config Nginx créée et vérifiée"

# ─── SSL Let's Encrypt ────────────────────────────────────────
echo "▶ Génération certificat SSL Let's Encrypt..."

# Créer le dossier pour le challenge ACME
mkdir -p /var/www/certbot

# Obtenir le certificat
certbot --nginx \
  -d "$DOMAIN" \
  -d "www.$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  --redirect

# Renouvellement automatique (cron)
echo "0 3 * * * root certbot renew --quiet --deploy-hook 'systemctl reload nginx'" \
  > /etc/cron.d/certbot-renew

systemctl reload nginx
echo "✅ SSL Let's Encrypt configuré, renouvellement auto activé"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅ Nginx + SSL configurés !                             ║"
echo "║  https://$DOMAIN → sécurisé 🔒                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
