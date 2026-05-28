#!/bin/bash
# ============================================================
#  Pulsiia — Setup VPS Scaleway DEV1-S (Ubuntu 22.04 LTS)
#  Calibré pour production ~30 utilisateurs — DEV1-M (3 vCPU / 4 GB)
#  Usage : bash setup-vps.sh
#  Datacenter : Paris fr-par-1 — RGPD compliant
# ============================================================
set -euo pipefail

APP_USER="pulsiia"
APP_DIR="/home/$APP_USER/app"
NODE_VERSION="20"

echo "╔══════════════════════════════════════════════════════╗"
echo "║   Pulsiia — Setup VPS Scaleway Paris (Prod DEV1-M)   ║"
echo "╚══════════════════════════════════════════════════════╝"

# ─── 1. Mise à jour système ───────────────────────────────────
echo ""
echo "▶ [1/8] Mise à jour du système..."
apt-get update -qq && apt-get upgrade -y -qq
apt-get install -y -qq \
  curl wget git unzip \
  ca-certificates gnupg lsb-release \
  ufw fail2ban certbot python3-certbot-nginx \
  htop

# ─── 2. Utilisateur applicatif ────────────────────────────────
echo ""
echo "▶ [2/8] Création de l'utilisateur $APP_USER..."
if ! id "$APP_USER" &>/dev/null; then
  useradd -m -s /bin/bash "$APP_USER"
  usermod -aG sudo "$APP_USER"
  # Copie la clé SSH root → pulsiia
  mkdir -p /home/$APP_USER/.ssh
  cp /root/.ssh/authorized_keys /home/$APP_USER/.ssh/ 2>/dev/null || true
  chown -R $APP_USER:$APP_USER /home/$APP_USER/.ssh
  chmod 700 /home/$APP_USER/.ssh
  chmod 600 /home/$APP_USER/.ssh/authorized_keys 2>/dev/null || true
  echo "✅ Utilisateur $APP_USER créé avec accès SSH"
else
  echo "✅ Utilisateur $APP_USER existe déjà"
fi

# ─── 3. Sécuriser SSH ─────────────────────────────────────────
echo ""
echo "▶ [3/8] Sécurisation SSH (port 2222)..."
SSH_CONFIG="/etc/ssh/sshd_config"
cp "$SSH_CONFIG" "${SSH_CONFIG}.bak"
sed -i 's/^#\?Port .*/Port 2222/' "$SSH_CONFIG"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$SSH_CONFIG"
sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' "$SSH_CONFIG"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' "$SSH_CONFIG"
systemctl restart sshd
echo "✅ SSH sécurisé (port 2222, clés uniquement)"

# ─── 4. Firewall UFW ──────────────────────────────────────────
echo ""
echo "▶ [4/8] Firewall UFW..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 2222/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable
echo "✅ UFW actif — 2222/80/443 ouverts, tout le reste fermé"
echo "   PostgreSQL (:5432) → non exposé sur internet ✅"

# ─── 5. Fail2ban ──────────────────────────────────────────────
echo ""
echo "▶ [5/8] Fail2ban..."
cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = systemd

[sshd]
enabled  = true
port     = 2222
logpath  = %(sshd_log)s

[nginx-http-auth]
enabled  = true

[nginx-limit-req]
enabled  = true
filter   = nginx-limit-req
logpath  = /var/log/nginx/error.log
maxretry = 10
EOF
systemctl enable fail2ban
systemctl restart fail2ban
echo "✅ Fail2ban actif (ban 1h après 5 tentatives)"

# ─── 6. Node.js 20 + PM2 ──────────────────────────────────────
echo ""
echo "▶ [6/8] Node.js $NODE_VERSION LTS + PM2..."
curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
apt-get install -y nodejs
npm install -g pm2
echo "✅ Node.js $(node -v) — PM2 $(pm2 -v)"

# ─── 7. Docker (pour PostgreSQL) ──────────────────────────────
echo ""
echo "▶ [7/8] Docker..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
usermod -aG docker "$APP_USER"
systemctl enable docker
echo "✅ Docker $(docker --version | cut -d' ' -f3)"

# ─── 8. Dossiers + logs ───────────────────────────────────────
echo ""
echo "▶ [8/8] Dossiers applicatifs..."
mkdir -p "$APP_DIR"
mkdir -p /var/log/pulsiia
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
chown -R "$APP_USER":"$APP_USER" /var/log/pulsiia

# Logrotate
cat > /etc/logrotate.d/pulsiia << 'EOF'
/var/log/pulsiia/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
}
EOF

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              ✅ Setup VPS terminé !                      ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Prochaines étapes :                                     ║"
echo "║  1. Reconnecte-toi : ssh -p 2222 pulsiia@TON_IP         ║"
echo "║  2. git clone https://github.com/TON/pulsiia ~/app       ║"
echo "║  3. cp backend/.env.production.example backend/.env      ║"
echo "║  4. nano backend/.env  (remplis les variables)           ║"
echo "║  5. docker compose up -d postgres                        ║"
echo "║  6. cd backend && npm ci --omit=dev                      ║"
echo "║     npx prisma migrate deploy                            ║"
echo "║     node prisma/seed.js  (1 seule fois)                  ║"
echo "║     cd .. && cd frontend && npm ci --omit=dev && cd ..   ║"
echo "║  7. pm2 start ecosystem.config.js --env production       ║"
echo "║     pm2 save && pm2 startup                              ║"
echo "║  8. bash scripts/setup-nginx.sh TON_DOMAINE TON_EMAIL    ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  💰 Coût prod 30 users (DEV1-M) :                         ║"
echo "║  • VPS DEV1-M   : ~6.35€/mois (3 vCPU / 4 GB RAM)      ║"
echo "║  • Domaine .fr  : ~7€/an (~0.58€/mois)                  ║"
echo "║  • Total        : ~7€/mois tout compris                  ║"
echo "╚══════════════════════════════════════════════════════════╝"
