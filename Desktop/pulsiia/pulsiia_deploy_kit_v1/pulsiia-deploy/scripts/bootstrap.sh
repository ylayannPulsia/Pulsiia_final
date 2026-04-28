#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# bootstrap.sh — Hardening + setup d'un VPS Ubuntu/Debian neuf
# ─────────────────────────────────────────────────────────────
# Usage : ssh root@VPS_IP, puis :
#   curl -O https://your-repo/bootstrap.sh && sudo bash bootstrap.sh
#
# Étapes :
#   1. Update système + packages essentiels
#   2. Création user non-root `deploy`
#   3. Hardening SSH (clé only, no root)
#   4. Firewall UFW (22/80/443 only)
#   5. Fail2ban (bruteforce protection)
#   6. Docker + Docker Compose
#   7. Swap si VPS < 4GB RAM
#   8. Timezone + NTP
#   9. Limites système (ulimit)
# ─────────────────────────────────────────────────────────────

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "❌ Run as root (sudo bash bootstrap.sh)"
  exit 1
fi

DEPLOY_USER="${DEPLOY_USER:-deploy}"
SSH_PUBKEY="${SSH_PUBKEY:-}"  # required, paste your public key

if [ -z "$SSH_PUBKEY" ]; then
  echo "❌ SSH_PUBKEY env var required"
  echo "   Example : SSH_PUBKEY='ssh-ed25519 AAAA...' bash bootstrap.sh"
  exit 1
fi

GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }

# ─── 1. Update système ────────────────────────────────────
log "📦 Updating system..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -yq
apt-get install -yq \
  curl wget git vim htop ncdu jq \
  ufw fail2ban unattended-upgrades \
  ca-certificates gnupg lsb-release \
  rsync cron logrotate

# ─── 2. Création user deploy ──────────────────────────────
if ! id "$DEPLOY_USER" &>/dev/null; then
  log "👤 Creating user $DEPLOY_USER..."
  useradd -m -s /bin/bash -G sudo "$DEPLOY_USER"
  echo "$DEPLOY_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/$DEPLOY_USER"
  chmod 440 "/etc/sudoers.d/$DEPLOY_USER"
fi

# Setup SSH key pour deploy
mkdir -p "/home/$DEPLOY_USER/.ssh"
echo "$SSH_PUBKEY" > "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
chmod 700 "/home/$DEPLOY_USER/.ssh"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"

# ─── 3. Hardening SSH ─────────────────────────────────────
log "🔐 Hardening SSH..."
cat > /etc/ssh/sshd_config.d/99-pulsiia-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
X11Forwarding no
PrintMotd no
ClientAliveInterval 300
ClientAliveCountMax 2
MaxAuthTries 3
LoginGraceTime 30
AllowUsers deploy
EOF
systemctl reload sshd

# ─── 4. Firewall UFW ──────────────────────────────────────
log "🛡  Configuring firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable

# ─── 5. Fail2ban ──────────────────────────────────────────
log "🚫 Configuring fail2ban..."
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 3
backend = systemd

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3

[nginx-limit-req]
enabled = true
filter = nginx-limit-req
port = http,https
logpath = /var/log/nginx/error.log
maxretry = 10
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban

# ─── 6. Docker ────────────────────────────────────────────
log "🐳 Installing Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

# Permet à deploy d'utiliser docker sans sudo
usermod -aG docker "$DEPLOY_USER"

# ─── 7. Swap (si pas déjà) ────────────────────────────────
log "💾 Checking swap..."
TOTAL_RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
if [ ! -f /swapfile ] && [ "$TOTAL_RAM_MB" -lt 4096 ]; then
  log "Creating 4GB swap (RAM = ${TOTAL_RAM_MB}MB)..."
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' >> /etc/sysctl.conf
  sysctl -p
fi

# ─── 8. Timezone + NTP ────────────────────────────────────
log "🕒 Setting timezone..."
timedatectl set-timezone Europe/Paris
timedatectl set-ntp true

# ─── 9. Limites système ───────────────────────────────────
log "📈 Setting system limits..."
cat > /etc/security/limits.d/99-pulsiia.conf <<'EOF'
* soft nofile 65535
* hard nofile 65535
* soft nproc 32768
* hard nproc 32768
EOF

cat >> /etc/sysctl.conf <<'EOF'

# Pulsiia tuning
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 300
fs.file-max = 2097152
EOF
sysctl -p

# ─── 10. Auto-updates de sécurité ─────────────────────────
log "🔄 Enabling unattended security upgrades..."
dpkg-reconfigure -plow unattended-upgrades || \
  echo 'APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades

# ─── Setup directories Pulsiia ────────────────────────────
log "📁 Creating Pulsiia directories..."
mkdir -p /opt/pulsiia/{backups,logs}
chown -R "$DEPLOY_USER:$DEPLOY_USER" /opt/pulsiia

# ─── Done ─────────────────────────────────────────────────
log "✅ Bootstrap complete !"
echo ""
echo "Next steps :"
echo "  1. Test SSH : ssh ${DEPLOY_USER}@<VPS_IP>"
echo "  2. Clone repo dans /opt/pulsiia"
echo "  3. Copy .env.production.template → .env.production et remplir"
echo "  4. Run : ./scripts/init-ssl.sh"
echo "  5. Run : docker compose -f docker-compose.prod.yml up -d"
echo ""
echo "⚠️  Ne te déconnecte PAS de cette session avant d'avoir vérifié"
echo "   que SSH avec deploy@ fonctionne dans une autre fenêtre !"
