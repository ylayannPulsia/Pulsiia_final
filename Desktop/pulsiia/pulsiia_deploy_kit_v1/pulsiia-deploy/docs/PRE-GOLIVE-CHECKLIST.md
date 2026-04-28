# Pulsiia — Checklist pré-go-live

> **À valider intégralement avant que le client pilote reçoive son lien.**
>
> Une seule case non cochée peut tout faire dérailler. Prends 2h pour tout vérifier.

---

## Phase 1 — Infrastructure (J-7)

### VPS
- [ ] VPS provisionné (recommandé : Hetzner CX22 4€/mois, ou Scaleway DEV1-S)
- [ ] OS Ubuntu 24.04 LTS ou Debian 12
- [ ] RAM minimum 4GB, idéalement 8GB
- [ ] Disque 80GB+ (DB + backups + images)
- [ ] IP publique fixe
- [ ] `bootstrap.sh` exécuté avec succès
- [ ] SSH avec clé fonctionne pour `deploy@`
- [ ] SSH root désactivé
- [ ] UFW actif, ports 22/80/443 uniquement
- [ ] Fail2ban actif
- [ ] Swap configuré si < 8GB RAM

### DNS
- [ ] `app.pulsiia.com` A record → IP VPS
- [ ] `pulsiia.com` A record → IP VPS
- [ ] `www.pulsiia.com` CNAME → `pulsiia.com`
- [ ] DNS propagé partout (`dig +short app.pulsiia.com` depuis 3 réseaux différents)
- [ ] Email DNS : SPF + DKIM + DMARC configurés (sinon emails Pulsiia spam)

### SSL
- [ ] `init-ssl.sh` exécuté avec succès
- [ ] Certificat valide pour `app.pulsiia.com`
- [ ] Certificat valide pour `pulsiia.com`
- [ ] Renewal certbot fonctionne (test : `certbot renew --dry-run`)
- [ ] SSL Labs grade A ou A+ (`https://www.ssllabs.com/ssltest/analyze.html?d=app.pulsiia.com`)

---

## Phase 2 — Secrets & configuration (J-5)

### Secrets générés
- [ ] `DB_PASSWORD` — 32 chars random fort
- [ ] `REDIS_PASSWORD` — 32 chars random fort
- [ ] `SESSION_SECRET` — 64 chars random
- [ ] `JWT_SECRET` — 64 chars random
- [ ] `PULSE_VAULT_KEY` — 64 hex (CRITIQUE — perdue = re-OAuth de tout)
- [ ] `DATA_ENCRYPTION_KEY` — 64 hex
- [ ] `HEALTH_TOKEN` — 32 chars (pour endpoint `/health/detailed`)

### Secrets externes
- [ ] `ANTHROPIC_API_KEY` créée avec spending cap (recommandé 50€/mois pour pilote)
- [ ] `VOYAGE_API_KEY` créée et testée (`curl ... voyage.../embeddings`)
- [ ] `RESEND_API_KEY` créée + domaine `pulsiia.com` vérifié dans Resend
- [ ] `SENTRY_DSN` créée (project `pulsiia-prod`)
- [ ] `VAPID_*` keys générées pour PWA push

### MCP (si activé pour le pilote)
- [ ] App Slack créée, scopes whitelist OK, redirect URI configurée
- [ ] App Azure AD créée, scopes Calendars.ReadWrite + offline_access, redirect URI OK
- [ ] API key Silae récupérée auprès du cabinet du client
- [ ] Tous les `MCP_*_URL` testés (ou laissés vides pour mode mock)

### Stockage `.env.production`
- [ ] Fichier en mode 600 sur le VPS (`chmod 600 .env.production`)
- [ ] Aucune valeur `CHANGEME` restante : `grep -i changeme .env.production`
- [ ] Fichier dans `.gitignore` (jamais commité)
- [ ] **Backup chiffré du fichier dans un secret manager** (1Password, Doppler, Bitwarden)
- [ ] **Vault key sauvegardée séparément en 2 endroits sûrs** (perdre = catastrophe)

---

## Phase 3 — Application (J-3)

### Build & deploy
- [ ] Image Docker buildée et pushée sur GHCR (ou Docker Hub privé)
- [ ] Tag `v1.0.0` créé
- [ ] `docker compose up -d` démarre tous les services sans erreur
- [ ] `docker compose ps` montre tous les services healthy
- [ ] `pg_dump` test : DB accessible et dump fonctionnel

### Migrations
- [ ] `npx prisma migrate deploy` passé (toutes les migrations v1+v2+v3)
- [ ] pgvector extension activée : `CREATE EXTENSION IF NOT EXISTS vector;`
- [ ] Migration SQL pgvector appliquée (ajout colonne embedding)
- [ ] Tables présentes : `User`, `AuditLog`, `PulseMemory`, `ProactiveAlertSent`, `MCPConnection`, `OAuthState`

### Tests fonctionnels (smoke tests)
- [ ] `curl https://app.pulsiia.com/health` → 200 OK
- [ ] `curl https://app.pulsiia.com/health/detailed` (avec token) → tout green
- [ ] Page de login s'affiche correctement
- [ ] Login Google/Microsoft SSO fonctionne pour un compte test
- [ ] Création d'un user test DRH avec accès tous établissements
- [ ] Pulse répond à un "Bonjour" en français
- [ ] Pulse appelle correctement `lire_planning` avec données seedées
- [ ] Une variable paie peut être créée + validée par Pulse
- [ ] WebSocket connection établie côté frontend (pour alertes proactives)
- [ ] Email de bienvenue arrive bien (et pas en spam)

---

## Phase 4 — Données du pilote (J-2)

### Seed données client
- [ ] Tenant créé pour le client
- [ ] Établissements seedés (sites du client)
- [ ] Utilisateurs réels créés (Marie + au moins 1 manager + collaborateurs test)
- [ ] Convention collective configurée (ex : CHR si restauration)
- [ ] Au moins 1 semaine de planning seedée pour permettre démo immédiate
- [ ] Quelques variables paie de démo dans le système

### RGPD
- [ ] DPA signé avec le client (Data Processing Agreement)
- [ ] Mentions RGPD à jour sur la landing
- [ ] Politique de confidentialité publiée et accessible depuis l'app
- [ ] Sous-traitants déclarés au client (Anthropic, Voyage, Resend, Sentry, hébergeur)
- [ ] Procédure d'export RGPD (Article 20) testée pour un user
- [ ] Procédure de suppression (Article 17) testée

---

## Phase 5 — Observabilité (J-1)

### Monitoring externe
- [ ] Better Stack / UptimeRobot configuré sur `/health` (interval 30s)
- [ ] Monitor SSL expiry actif
- [ ] Status page publique créée et accessible (`status.pulsiia.com` recommandé)
- [ ] Test alerte : éteins l'app 30s, vérifie que tu reçois email + SMS

### Sentry
- [ ] Test : `throw new Error('test sentry')` dans une route → événement remonté
- [ ] Source maps uploadées pour symbolication des stack traces
- [ ] Notifications Sentry configurées vers ton email

### Logs
- [ ] `docker logs pulsiia-app` rotation activée (max 10MB × 5 fichiers configuré)
- [ ] Logs centralisés si Logtail configuré
- [ ] Logs structurés JSON (Winston en mode prod)
- [ ] Aucun secret loggué (test : grep `ANTHROPIC_API_KEY` dans logs récents = vide)

### Backups
- [ ] Backup quotidien automatique configuré
- [ ] **TEST DE RESTORE effectué** sur DB de staging (vital — un backup non testé = pas de backup)
- [ ] Backup S3 off-site fonctionnel si configuré
- [ ] Retention 30 jours OK
- [ ] Backup pré-deploy automatique dans `deploy.sh` testé

---

## Phase 6 — Performance & sécurité (J-1)

### Performance
- [ ] Lighthouse score > 80 (perf + accessibility)
- [ ] Pulse répond en < 5s pour un message simple
- [ ] Pulse répond en < 15s pour un message avec tools
- [ ] Page principale charge en < 2s sur 4G
- [ ] CSS/JS minifiés et compressés gzip/brotli

### Sécurité
- [ ] Aucun port DB exposé publiquement (`nmap` du VPS depuis l'extérieur)
- [ ] HTTPS forcé partout, pas de HTTP en clair
- [ ] HSTS header activé (1 an + includeSubDomains)
- [ ] CSP header configuré et testé
- [ ] CORS strict (`CORS_ORIGIN=https://app.pulsiia.com` uniquement)
- [ ] Cookies `Secure`, `HttpOnly`, `SameSite=Lax`
- [ ] Rate limiting Express + Nginx fonctionne (test : 100 req en 1s → 429)
- [ ] Test injection SQL basique sur formulaires login → bloqué
- [ ] Test XSS basique sur champs texte → échappé
- [ ] `npm audit --audit-level=high` → 0 vulnérabilité
- [ ] Pas de fichiers `.env` accessibles via web (test : `curl https://app.pulsiia.com/.env` → 404)

---

## Phase 7 — Documentation client (J-0 matin)

### Pour Marie (DRH)
- [ ] Email de bienvenue prêt avec lien de connexion
- [ ] Identifiants temporaires créés (ou SSO direct configuré)
- [ ] Mini guide PDF "Démarrer avec Pulsiia" (10 pages max)
- [ ] Vidéo de démo 5 min enregistrée (Loom suffit)
- [ ] FAQ technique de base (mot de passe oublié, rapport bug, etc.)
- [ ] Numéro WhatsApp / canal Slack direct entre toi et Marie

### Pour ses collaborateurs
- [ ] Email d'annonce générique pour Marie à diffuser
- [ ] Comment installer la PWA sur mobile (1 page)
- [ ] Comment voir leur planning (1 page)

---

## Phase 8 — Plan de bascule (J-0)

### Avant l'envoi du lien
- [ ] Validation finale `curl https://app.pulsiia.com/health` → 200
- [ ] Sentry vide (zéro erreur sur les 24 dernières heures)
- [ ] Tu es disponible les 4 prochaines heures pour réagir
- [ ] Marie est disponible pour ses 30 premières minutes (call planifié)

### Pendant l'envoi
- [ ] Email envoyé à Marie avec lien
- [ ] Toi en stand-by sur Sentry / Better Stack pendant 1h
- [ ] Premier login de Marie observé en live (pour aider si bug)
- [ ] Premier message Pulse de Marie observé (vérifier qu'il fait sens)

### Suivi J+1
- [ ] Email de check-in à Marie ("comment s'est passée votre première journée ?")
- [ ] Review des logs / Sentry / metrics
- [ ] Liste des éventuels bugs / friction à fixer dans la semaine
- [ ] Premier journal d'incident si quelque chose est arrivé

---

## Plan de rollback d'urgence

Si quelque chose tourne TRÈS mal pendant les premières heures :

1. `./scripts/rollback.sh` (image précédente)
2. Si pas de version précédente : `docker compose down && message à Marie`
3. Communication transparente : "Nous avons identifié un problème, retour à la normale dans X min"
4. Post-mortem dans les 24h, **partagé au client**

---

## Estimation temps

- Phase 1-2 : 4h (provisioning + secrets)
- Phase 3 : 2h (deploy + tests)
- Phase 4 : 3h (données client + RGPD)
- Phase 5-6 : 3h (monitoring + perf/sec)
- Phase 7 : 4h (docs + vidéo)
- Phase 8 : 1h (bascule)

**Total : 17h** soit ~ 3 jours focus. Idéal : J-5 à J-1 + J-0 matin.
