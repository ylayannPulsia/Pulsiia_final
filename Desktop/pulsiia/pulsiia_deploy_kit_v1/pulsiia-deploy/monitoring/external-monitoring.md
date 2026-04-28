# ─────────────────────────────────────────────────────────────
# Monitoring externe — Better Stack (Logtail + Uptime)
# ─────────────────────────────────────────────────────────────
# https://betterstack.com — gratuit jusqu'à 10 monitors
#
# Alternative gratuite : UptimeRobot (50 monitors, check 5 min).
# ─────────────────────────────────────────────────────────────

## Monitors à créer (via UI Better Stack)

### 1. App health — public
- **Type** : HTTPS
- **URL** : https://app.pulsiia.com/health
- **Expected status** : 200
- **Expected body** : ok
- **Check interval** : 30s
- **Alerts** : Email + Slack + SMS si critique
- **Regions** : Europe (Frankfurt + Paris) au minimum

### 2. App health — détaillé (backend monitoring privé)
- **Type** : HTTPS
- **URL** : https://app.pulsiia.com/health/detailed
- **HTTP headers** : `X-Health-Token: <HEALTH_TOKEN>`
- **Check interval** : 1m
- **Body match** : `"ok":true`
- Permet de voir DB/Redis/Anthropic/Voyage status

### 3. SSL certificate expiry
- **Type** : Certificate expiration
- **Domain** : app.pulsiia.com
- **Alert** : 14 days before expiry

### 4. Domain expiry
- **Type** : Domain expiration
- **Domain** : pulsiia.com
- **Alert** : 30 days before

## Status page (Better Stack inclus)

Crée une status page publique : `status.pulsiia.com`

Composants :
- **API Pulsiia** (lié au monitor #1)
- **Pulse IA** (lié au monitor #2 sur le check Anthropic)
- **Database**
- **Email delivery**

Avantage pour le pilote : Marie peut voir en autonomie si un problème
est en cours plutôt que t'appeler.

## Logs (Logtail)

Si tu veux centraliser les logs :

1. Créer une "source" dans Better Stack
2. Récupérer le token Logtail
3. Dans le monorepo, ajouter le transport Winston :

```javascript
const { Logtail } = require("@logtail/node");
const { LogtailTransport } = require("@logtail/winston");

const logtail = new Logtail(process.env.LOGTAIL_TOKEN);

const logger = winston.createLogger({
  transports: [
    new winston.transports.Console(),
    new LogtailTransport(logtail),
  ],
});
```

## Alerting — chaîne d'escalation

```
Erreur critique détectée
    ↓
[1] Email immédiat à toi (SLA 5 min)
    ↓
[2] Si non acknowledgé en 10 min → SMS + Slack
    ↓
[3] Si non acknowledgé en 30 min → appel téléphonique (Better Stack le fait)
```

Configuration recommandée pour le pilote :
- **Critical** (DB down, app 5xx > 50%) : Email + SMS immédiat
- **Warning** (Anthropic latence élevée, disk > 80%) : Slack uniquement
- **Info** (deploys, healthcheck blip) : Slack channel #pulsiia-monitoring

## Pour démarrer rapidement

```bash
# 1. Crée compte Better Stack
# 2. Add monitor app.pulsiia.com/health → 30s
# 3. Add SSL expiration check
# 4. Configure email + Slack webhook
# 5. Test : éteins ton app 30s, vérifie que tu reçois l'alerte
```

Coût : **gratuit** jusqu'à 10 monitors, 1GB logs/mois.
Plan payant à 30€/mois si tu dépasses.
