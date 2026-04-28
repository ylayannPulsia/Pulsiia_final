# Pulsiia — Runbook Incident

> **Imprime ce document. Garde-le accessible. Quand ça casse à 23h, tu dois pas chercher.**

## Numéros d'urgence

| Service | Status page | Support |
|---------|-------------|---------|
| Anthropic | https://status.anthropic.com | support@anthropic.com |
| Voyage AI | https://status.voyageai.com | support@voyageai.com |
| Resend (email) | https://status.resend.com | support@resend.com |
| Hébergeur VPS | _(à remplir)_ | _(à remplir)_ |
| Registrar domaine | _(à remplir)_ | _(à remplir)_ |
| Slack | https://status.slack.com | — |
| Microsoft Graph | https://status.microsoft.com/en-us/admin | — |

## Première chose à faire face à un incident

```
1. STAY CALM. Ouvre /opt/pulsiia/runbook.md
2. ACK l'alerte (Better Stack / mail) pour stopper l'escalation
3. Identifie : interne (notre code) ou externe (provider down) ?
4. Communique au client si > 5 min (status page + email)
5. Documente dans le journal d'incident pour le post-mortem
```

---

## INCIDENT 1 — "Pulse ne répond plus" / 503

### Diagnostic en 60 secondes

```bash
# Sur le VPS (ssh deploy@app.pulsiia.com)
cd /opt/pulsiia

# 1. État des containers
docker compose -f docker-compose.prod.yml ps

# 2. Health interne
curl -H "X-Health-Token: $HEALTH_TOKEN" https://app.pulsiia.com/health/detailed

# 3. Logs des 100 dernières lignes app
docker compose -f docker-compose.prod.yml logs --tail=100 app

# 4. Vérifie le quota Anthropic
# https://console.anthropic.com → Usage
```

### Causes probables et résolution

| Symptôme | Cause | Action |
|----------|-------|--------|
| Container `app` exited | Crash / OOM | `docker compose up -d app` puis logs |
| App OK mais 503 sur Pulse | Quota Anthropic dépassé | Augmenter cap dans console |
| Latence p99 > 30s | Anthropic ralenti ou DB lente | Vérifier status Anthropic + `pg_stat_activity` |
| Tous tools échouent | ENV manquant après deploy | `docker exec pulsiia-app env \| grep ANTHROPIC` |
| Erreur "vault" | `PULSE_VAULT_KEY` mal chargé | Vérifier `.env.production` |

### Commandes utiles

```bash
# Restart soft (ne perd pas la DB)
docker compose -f docker-compose.prod.yml restart app

# Restart hard (avec rebuild image)
docker compose -f docker-compose.prod.yml up -d --force-recreate app

# Voir les logs en temps réel
docker compose -f docker-compose.prod.yml logs -f app

# Si toujours KO après 10 min → ROLLBACK
./scripts/rollback.sh
```

---

## INCIDENT 2 — Database down / lente

### Diagnostic

```bash
# 1. Container postgres OK ?
docker compose -f docker-compose.prod.yml ps postgres

# 2. Stats Postgres en live
docker compose exec postgres psql -U pulsiia -d pulsiia_prod -c "
  SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
  FROM pg_stat_activity
  WHERE state != 'idle'
  ORDER BY duration DESC LIMIT 10;
"

# 3. Espace disque
df -h
docker system df

# 4. Top queries lentes (besoin pg_stat_statements activé)
docker compose exec postgres psql -U pulsiia -c "
  SELECT calls, mean_exec_time, query
  FROM pg_stat_statements
  ORDER BY mean_exec_time DESC LIMIT 10;
"
```

### Actions

| Cas | Solution |
|-----|----------|
| Disque plein | `docker system prune -af && docker volume prune -f` |
| Connections épuisées | Restart app pour libérer les pools |
| Query bloquante | `SELECT pg_terminate_backend(<pid>);` |
| DB corrompue | Restore depuis backup : `./scripts/rollback.sh --restore-db backups/<latest>` |

### Reset connection pool sans restart

```bash
docker compose exec postgres psql -U pulsiia -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE state = 'idle' AND state_change < now() - interval '10 minutes';
"
```

---

## INCIDENT 3 — Erreur OAuth Slack/Outlook/Silae

### Diagnostic

```bash
# Vérifie l'état des connexions MCP
docker compose exec postgres psql -U pulsiia -d pulsiia_prod -c "
  SELECT \"serverId\", \"connectedAt\", \"expiresAt\", \"revokedAt\"
  FROM \"MCPConnection\"
  ORDER BY \"connectedAt\" DESC;
"
```

### Causes & actions

- **Token expiré sans refresh** : Marie reconnecte via UI Pulsiia
- **Provider OAuth a révoqué la connexion** : refaire le flux OAuth complet
- **Erreur "Invalid PKCE"** : state expiré (>10 min entre clic et callback) — refaire
- **Redirect URI mismatch** : vérifier dans Azure/Slack que l'URI exact correspond au callback

### Si le serveur MCP réel est down → fallback temporaire vers mock

```bash
# Édite .env.production
# Commenter MCP_SLACK_URL=...

# Reload app (les futurs chats utiliseront le mock)
docker compose -f docker-compose.prod.yml restart app
```

---

## INCIDENT 4 — Disque VPS plein

### Diagnostic

```bash
# Top 10 plus gros répertoires
du -h / 2>/dev/null | sort -h | tail -20

# Backups Pulsiia
du -sh /var/lib/docker/volumes/pulsiia-backups
```

### Cleanup d'urgence

```bash
# 1. Vieux backups (gardes les 7 derniers)
docker run --rm -v pulsiia-backups:/b alpine \
  sh -c 'cd /b && ls -t pulsiia-*.sql.gz | tail -n +8 | xargs rm -f'

# 2. Images Docker non utilisées
docker system prune -af --volumes

# 3. Logs Docker volumineux
truncate -s 0 /var/lib/docker/containers/*/*-json.log

# 4. Logs système
journalctl --vacuum-time=7d
apt-get clean
```

---

## INCIDENT 5 — SSL expiré

### Diagnostic
```bash
echo | openssl s_client -connect app.pulsiia.com:443 2>/dev/null \
  | openssl x509 -noout -dates
```

### Forcer un renouvellement
```bash
docker run --rm \
  -v pulsiia-certbot:/etc/letsencrypt \
  -v pulsiia-certbot-www:/var/www/certbot \
  certbot/certbot:latest renew --force-renewal

docker compose -f docker-compose.prod.yml restart nginx
```

---

## INCIDENT 6 — Anthropic API down ou rate limited

### Diagnostic
```bash
curl https://status.anthropic.com/api/v2/status.json | jq .status
```

### Fallback

Pulsiia ne s'arrête PAS si Anthropic est down — Pulse devient indisponible mais le reste de l'app continue. Communique à Marie :

> "L'assistant Pulse est temporairement indisponible suite à un incident chez notre fournisseur IA. Les autres fonctionnalités (planning, paie, bien-être) restent opérationnelles."

Si rate limit (429) persistant, augmenter le quota dans console Anthropic.

---

## Post-incident — checklist 24h après

- [ ] Journal d'incident rédigé (timeline, cause racine, fix)
- [ ] Client pilote informé du résolution + ce qui sera fait pour éviter récidive
- [ ] Métriques de l'incident (downtime, requêtes échouées) extraites
- [ ] Si récurrent : créer une règle d'alerte préventive pour next time
- [ ] Améliorer ce runbook avec ce qui a été appris

## Post-mortem template

```markdown
# Incident #YYYY-MM-DD-N

## Résumé
1 phrase sur ce qui s'est passé.

## Timeline (UTC)
- HH:MM — Premier signal
- HH:MM — Détection
- HH:MM — Mitigation lancée
- HH:MM — Résolution

## Impact
- Durée : X min
- Utilisateurs affectés : Y
- Requêtes échouées : Z

## Cause racine
Pourquoi est-ce arrivé.

## Détection
Comment on l'a su (alerte, client, hasard).

## Résolution
Ce qu'on a fait.

## Action items
- [ ] Action 1 (owner: X, due: date)
- [ ] Action 2
```
