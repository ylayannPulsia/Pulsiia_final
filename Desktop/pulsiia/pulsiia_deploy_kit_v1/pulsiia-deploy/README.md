# Pulsiia — Production Deployment Kit

> Kit complet de déploiement pour mettre Pulsiia en production sur un VPS Linux.
> Conçu pour un client pilote critique : zero-downtime, monitoring proactif,
> sécurité hardenée, runbook incident.

---

## 📦 Contenu du kit

```
pulsiia-deploy/
├── docker-compose.prod.yml          # Stack complète (app, postgres+pgvector, redis, nginx, certbot, backup)
├── .env.production.template         # Template des 50+ variables avec checklist
├── docker/
│   ├── Dockerfile.app               # Multi-stage build optimisé
│   └── postgres/
│       ├── postgresql.conf          # Tuning Postgres pour VPS 4GB
│       └── init/01-extensions.sql   # pgvector + pgcrypto
├── nginx/
│   ├── nginx.conf                   # Config principale hardenée (TLS, rate limit, gzip)
│   └── conf.d/pulsiia.conf          # vhost app.pulsiia.com avec security headers
├── scripts/
│   ├── bootstrap.sh                 # Hardening VPS Ubuntu/Debian (firewall, ssh, fail2ban, docker)
│   ├── init-ssl.sh                  # Émission Let's Encrypt
│   ├── deploy.sh                    # Zero-downtime deploy
│   ├── rollback.sh                  # Rollback rapide (image + DB optionnelle)
│   └── backup.sh                    # Backup quotidien DB + S3
├── monitoring/
│   ├── health.js                    # Endpoint /health enrichi (DB, Redis, Anthropic, Voyage)
│   ├── sentry.js                    # Intégration Sentry avec filtres anti-spam
│   └── external-monitoring.md       # Setup Better Stack / UptimeRobot
├── github-workflows/
│   └── ci-cd.yml                    # Test → Build → Deploy auto sur tag v*
└── docs/
    ├── PRE-GOLIVE-CHECKLIST.md      # 30 points à valider avant bascule
    ├── RUNBOOK-INCIDENT.md          # Que faire quand X tombe (à imprimer)
    └── CLIENT-ONBOARDING.md         # Emails, vidéo, support, plan 30 jours
```

---

## 🚀 Premier déploiement — parcours en 6 étapes

### Étape 1 — VPS (30 min)

Provisionne un VPS Linux. Recommandation : **Hetzner CX22** (4€/mois, 4GB RAM, 40GB SSD)
ou **Scaleway DEV1-S** si tu veux rester en France.

```bash
# Sur ta machine locale
ssh-keygen -t ed25519 -C "deploy@pulsiia"
cat ~/.ssh/id_ed25519.pub  # copie cette clé

# Connecte-toi en root au VPS via la console fournisseur ou ssh root@IP
# Copie bootstrap.sh, puis :
SSH_PUBKEY='ssh-ed25519 AAAA... deploy@pulsiia' bash bootstrap.sh

# Test SSH avec deploy depuis une autre fenêtre AVANT de quitter root :
ssh deploy@<VPS_IP>
```

### Étape 2 — DNS (10 min, propagation ~30 min)

Chez ton registrar :
```
A     app.pulsiia.com    → <VPS_IP>
A     pulsiia.com        → <VPS_IP>
CNAME www.pulsiia.com    → pulsiia.com
```

Vérifie : `dig +short app.pulsiia.com`

### Étape 3 — Code & secrets (1h)

```bash
ssh deploy@<VPS_IP>
cd /opt/pulsiia

# Clone le repo Pulsiia (monorepo + pulse-agent)
git clone git@github.com:<ton-org>/pulsiia.git .

# Copie ce kit dans le repo
cp -r pulsiia-deploy/* .

# Crée .env.production
cp .env.production.template .env.production
chmod 600 .env.production

# Génère les secrets et remplis le fichier
nano .env.production
```

Pour **chaque** variable `CHANGEME`, génère une valeur :

```bash
# Passwords / secrets simples
openssl rand -base64 32

# Clés hex (vault, encryption)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Session secrets longs
openssl rand -base64 64
```

**CRITIQUE** : sauvegarde `PULSE_VAULT_KEY` dans 2 endroits sûrs (1Password + autre). Sa perte = toutes les connexions OAuth perdues.

### Étape 4 — SSL + démarrage (15 min)

```bash
chmod +x scripts/*.sh

# Premier SSL (avec staging d'abord pour tester si tu veux)
LETSENCRYPT_EMAIL=admin@pulsiia.com bash scripts/init-ssl.sh

# Vérifie
curl -I https://app.pulsiia.com
```

### Étape 5 — Tests (30 min)

Suis intégralement `docs/PRE-GOLIVE-CHECKLIST.md`. Ne saute aucune phase.

### Étape 6 — Bascule client (J-0)

Suis `docs/CLIENT-ONBOARDING.md` :
1. Envoie l'email de bienvenue à Marie
2. Reste en stand-by 4h
3. Premier check-in J+1

---

## 🔧 Opérations courantes

### Déployer une nouvelle version

```bash
# Sur ta machine locale, après merge sur main :
git tag v1.0.1
git push origin v1.0.1

# CI/CD GitHub Actions s'occupe du reste :
# test → build image → push GHCR → SSH deploy → smoke test
```

Ou manuellement sur le VPS :
```bash
ssh deploy@<VPS_IP>
cd /opt/pulsiia
./scripts/deploy.sh v1.0.1
```

### Rollback urgent

```bash
ssh deploy@<VPS_IP>
cd /opt/pulsiia
./scripts/rollback.sh

# Si la migration DB est aussi en cause :
./scripts/rollback.sh --restore-db backups/pre-deploy-20260427-080000.sql.gz
```

### Voir les logs

```bash
docker compose -f docker-compose.prod.yml logs -f app    # app uniquement
docker compose -f docker-compose.prod.yml logs --tail=200 # tous services, derniers 200
```

### Backup manuel ad hoc

```bash
docker compose -f docker-compose.prod.yml exec backup /usr/local/bin/backup.sh
```

### Restaurer un backup

```bash
gunzip -c backups/pulsiia-20260427-030000.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U pulsiia pulsiia_prod
```

---

## 🛡️ Sécurité — résumé des couches

| Couche | Protection |
|--------|-----------|
| Réseau | UFW (3 ports), Fail2ban, Cloudflare optionnel devant |
| SSH | Clé only, no root, fail2ban |
| TLS | Let's Encrypt auto-renew, TLS 1.2/1.3, HSTS preload-eligible |
| HTTP | Security headers (CSP, X-Frame, Permissions-Policy), rate limiting Nginx + Express |
| App | Sentry filtré (no secrets), audit log RGPD, role-based perms |
| Données | AES-256-GCM (Pulse vault), Postgres data checksums, backups chiffrés S3 |
| Secrets | `.env.production` mode 600, jamais en git, sauvegardés en secret manager |

---

## 📊 Coûts mensuels estimés (pilote)

| Poste | Coût |
|-------|------|
| VPS Hetzner CX22 | 4 € |
| Domaine .com | 1 €/mois (12€/an) |
| Anthropic API (Pulse) | 30-80 € selon usage |
| Voyage embeddings | < 5 € |
| Resend (10k emails/mois) | gratuit |
| Sentry (Developer plan) | gratuit |
| Better Stack | gratuit (10 monitors) |
| Backups S3 (Scaleway, ~10GB) | < 1 € |
| **Total** | **~ 50-100 €/mois** |

Ratio coûts vs subscription pilote : si Marie paie ~ 10€/employé × 100 employés = 1000€/mois, tu as une marge confortable pour itérer.

---

## 🩺 Diagnostic rapide

```bash
# Tout va bien ?
curl https://app.pulsiia.com/health

# Diagnostic détaillé (DB, Redis, Anthropic, Voyage)
curl -H "X-Health-Token: <token>" https://app.pulsiia.com/health/detailed | jq

# Conteneurs
docker compose -f docker-compose.prod.yml ps

# Sentry events des dernières 24h
# → console Sentry web

# Top requêtes lentes
docker compose exec postgres psql -U pulsiia -c \
  "SELECT mean_exec_time, calls, query FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"
```

---

## 📞 En cas de problème

1. Ouvre `docs/RUNBOOK-INCIDENT.md`
2. Suis le diagnostic 60 secondes
3. Trouve ton symptôme dans la liste
4. Applique l'action recommandée

Si rien ne marche : `./scripts/rollback.sh` et email transparent à Marie.

---

## ✅ Definition of Done — pilote prêt

- [ ] Phases 1-8 du PRE-GOLIVE-CHECKLIST cochées intégralement
- [ ] Email de bienvenue envoyé à Marie
- [ ] Toi en stand-by 4 premières heures
- [ ] Sentry vide à l'envoi
- [ ] Backup pré-bascule créé
- [ ] Runbook imprimé / accessible offline

**Tu es prêt. Bonne chance avec Marie. 🚀**
