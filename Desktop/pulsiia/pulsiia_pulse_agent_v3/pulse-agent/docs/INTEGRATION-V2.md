# Pulse Agent v2 — Guide d'intégration des nouvelles features

> Ce guide complète `INTEGRATION.md` (v1). Il couvre les ajouts v2 :
> **mémoire long terme (RAG sémantique)** et **alertes proactives multi-canal**.

---

## 1. Pré-requis additionnels

### 1.1 Activer pgvector dans Postgres

```sql
-- Via psql ou pgAdmin (DBA seulement)
CREATE EXTENSION IF NOT EXISTS vector;
```

### 1.2 Mettre à jour Prisma

Copier le contenu de `prisma/schema-additions.prisma` dans votre `schema.prisma` du monorepo, puis :

```bash
# Le model PulseMemory (sans embedding pour Prisma)
npx prisma migrate dev --name add_pulse_memory_and_alerts

# Puis appliquer la migration SQL pgvector pour ajouter la colonne `embedding`
psql $DATABASE_URL -f prisma/migrations/pulse_memory_pgvector.sql
```

**Important** : Ajouter aussi ces 4 champs au model `User` existant :

```prisma
model User {
  // ... champs existants ...
  alertPreferences  Json?
  slackWebhookUrl   String?
  teamsWebhookUrl   String?
  lastScanAt        DateTime?
}
```

### 1.3 Embeddings provider

Pulse utilise Voyage AI par défaut (recommandé Anthropic). Variable env :

```env
PULSE_EMBEDDER_PROVIDER=voyage   # ou 'openai' ou 'mock' (pour tests)
VOYAGE_API_KEY=pa-...            # https://www.voyageai.com
# ou
OPENAI_API_KEY=sk-...
```

Coût indicatif : ~ **0,02 $ / 1M tokens** d'embedding (~ 5 000 mémoires créées et 50 000 lookups par mois pour quelques euros).

---

## 2. Activer la mémoire long terme

### 2.1 Setup

```javascript
const {
  PulseAgent,
  ToolExecutor,
  MemoryStore,
  MemoryLearner,
  createEmbedder,
  createPulseRouter,
  createMemoryRouter,
} = require('@pulsiia/pulse-agent');

const embedder = createEmbedder(); // lit PULSE_EMBEDDER_PROVIDER

const memoryStore = new MemoryStore({
  prisma,
  embedder,
  logger,
});

const memoryLearner = new MemoryLearner({
  apiKey: process.env.ANTHROPIC_API_KEY,
  store: memoryStore,
  logger,
});

const executor = new ToolExecutor({
  prisma,
  services,
  logger,
  memoryStore, // ← active les 3 nouveaux tools mémoire
});

const agent = new PulseAgent({
  apiKey: process.env.ANTHROPIC_API_KEY,
  executor,
  logger,
  memoryStore,    // ← active l'injection contextuelle
  memoryLearner,  // ← active l'apprentissage post-conversation
});
```

### 2.2 Routes API

```javascript
app.use(
  '/api/pulse/memory',
  createMemoryRouter({ memoryStore, requireAuth, logger })
);
```

| Méthode | URL | Description |
|---------|-----|-------------|
| GET | `/api/pulse/memory` | Liste les mémoires de l'utilisateur |
| POST | `/api/pulse/memory` | Crée manuellement (ex : depuis l'UI Marie) |
| DELETE | `/api/pulse/memory/:id` | RGPD Article 17 — oubli |
| POST | `/api/pulse/memory/:id/promote` | Confirme une mémoire auto |

### 2.3 Comment Pulse l'utilise

À chaque message utilisateur :
1. Pulse fait une recherche sémantique sur la query → top 6 mémoires pertinentes
2. Elles sont **injectées dans le system prompt** sous un bloc structuré
3. Claude les exploite naturellement dans sa réponse
4. **Après chaque conversation**, le `MemoryLearner` (Haiku) extrait des candidats mémoires et les stocke en `source: 'auto'`

L'utilisateur peut explicitement dire "retiens que..." → Pulse appelle `enregistrer_memoire` avec `source: 'user'` (confiance 0.95).

### 2.4 Cycle de vie d'une mémoire

```
créée auto (0.7) → utilisée souvent → reste 0.7
créée auto (0.7) → utilisateur dit "non c'est faux" → corriger_memoire → 0.5
                                                                     ↓
créée auto (0.7) → utilisateur confirme → promote → 0.95 (source=user)
                                                                     ↓
créée user (0.95) → jamais supprimée sans demande explicite (RGPD)
                                                                     ↓
toute mémoire → utilisateur dit "oublie..." → oublier_memoire → DELETE
```

### 2.5 RGPD

- ✅ **Article 17 (oubli)** : tool `oublier_memoire` + `DELETE /memory/:id`
- ✅ **Article 20 (portabilité)** : utilisez l'export RGPD existant Pulsiia, étendez-le pour inclure `PulseMemory`
- ✅ **Multi-tenant** : isolation stricte par `tenantId` dans toutes les requêtes
- ✅ **Pas de PII bien-être** : le `MemoryLearner` est instruit de ne jamais extraire de données nominatives bien-être

---

## 3. Activer les alertes proactives

### 3.1 Setup

```javascript
const { Scanner, Notifier, createAlertsRouter } = require('@pulsiia/pulse-agent');

// Adaptateurs — connectez aux services existants du monorepo
const adapters = {
  // WebSocket : utilisez votre socket.io / ws déjà en place
  websocket: {
    send: (userId, payload) => io.to(`user:${userId}`).emit('pulse.alert', payload),
  },
  // Email : vous avez déjà 8 templates Resend/SendGrid
  email: {
    send: ({ to, subject, html }) => emailService.send({ to, subject, html }),
  },
  // PWA push : VAPID est déjà configuré dans le monorepo
  pwa: {
    push: (userId, payload) => pushService.sendToUser(userId, payload),
  },
  // Slack : webhook fetch
  slack: {
    send: (webhookUrl, payload) =>
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
  },
  // Teams : même pattern
  teams: {
    send: (webhookUrl, payload) =>
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
  },
};

const notifier = new Notifier({ adapters, prisma, logger });
const scanner = new Scanner({ prisma, services, notifier, logger });

// Routes API
app.use('/api/pulse/alerts', createAlertsRouter({ prisma, scanner, requireAuth, logger }));
```

### 3.2 Cron job

Ajouter un cron (8ᵉ job dans le monorepo) qui exécute le scanner. Avec `node-cron` ou votre orchestrateur :

```javascript
const cron = require('node-cron');

// Toutes les 15 min : scan général
cron.schedule('*/15 * * * *', async () => {
  try {
    const result = await scanner.runScan();
    logger.info('[pulse cron] scan ok', result);
  } catch (err) {
    logger.error('[pulse cron] scan failed', err);
  }
}, { timezone: 'Europe/Paris' });

// Tous les jours à 8h : digest matinal forcé
cron.schedule('0 8 * * *', async () => {
  await scanner.runScan({ includeDigest: true });
}, { timezone: 'Europe/Paris' });
```

Le scanner vérifie pour **chaque utilisateur** si l'intervalle de son préférence est écoulé — un cron fréquent (15 min) ne déclenchera donc pas un scan pour un user qui a réglé son intervalle à 60 min.

### 3.3 Routes API utilisateur

| Méthode | URL | Description |
|---------|-----|-------------|
| GET | `/api/pulse/alerts/preferences` | Récupère prefs utilisateur |
| PUT | `/api/pulse/alerts/preferences` | Met à jour intervalle, silence, canaux, webhooks |
| GET | `/api/pulse/alerts/recent` | Historique alertes reçues |
| POST | `/api/pulse/alerts/:id/read` | Marquer comme lu |
| POST | `/api/pulse/alerts/:id/dismiss` | Ignorer |
| POST | `/api/pulse/alerts/scan-now` | Scan immédiat (DRH/admin uniquement) |

### 3.4 Format préférences utilisateur

```json
{
  "enabled": true,
  "intervalMinutes": 30,
  "silenceFromHour": 19,
  "silenceToHour": 7,
  "timezone": "Europe/Paris",
  "channels": ["websocket", "pwa", "email", "slack"],
  "slackWebhookUrl": "https://hooks.slack.com/services/T0/B0/xxx",
  "teamsWebhookUrl": null
}
```

### 3.5 Règles disponibles

| Rule ID | Severity | Cooldown | Trigger |
|---------|----------|----------|---------|
| `planning.uncovered_shift_24h` | 🔴 CRITICAL | 60 min | Poste découvert dans les 24h (passe le silence) |
| `planning.uncovered_shift_72h` | 🟠 HIGH | 4h | Poste découvert dans les 72h |
| `paie.anomaly_detected` | 🟠 HIGH | 6h | Anomalie détectée par l'IA paie |
| `paie.cloture_imminente` | 🟡 MED | 24h | < 3 jours avant clôture, variables non validées |
| `bienetre.score_drop` | 🟠 HIGH | 24h | Chute ≥ 1 pt sur 14j |
| `bienetre.turnover_risk` | 🟠 HIGH | 72h | Risque turnover ≥ 70% |
| `digest.morning` | 🟢 LOW | 24h | Récap matinal 7h-9h |

Pour ajouter une règle, éditer `src/proactive/rules.js` (ou créer une PR — schéma défini, simple à étendre).

### 3.6 Anti-spam intégré

- ✅ **Cooldown par règle + target** : pas de re-déclenchement avant N min (configurable)
- ✅ **Heures de silence** : seules les CRITICAL passent dans la fenêtre
- ✅ **Cap horaire** : max 5 alertes non-CRITICAL / heure / utilisateur
- ✅ **Tri par sévérité** : CRITICAL → HIGH → MED → LOW
- ✅ **Désactivation** : `enabled: false` dans les prefs coupe tout

---

## 4. Coûts additionnels v2

Pour 100 utilisateurs RH actifs avec scan toutes les 30 min :

| Poste | Volume estimé | Coût mensuel |
|-------|---------------|--------------|
| Embeddings (création + lookup) | ~ 1M tokens | < 1 $ |
| MemoryLearner (Haiku, 1 appel/conversation) | ~ 500 conversations × 800 tokens | ~ 0,4 $ |
| Pulse chat avec mémoire (overhead) | +200 tokens/req sur Opus | +5 $ |
| Scanner (lecture DB seule) | 0 LLM call | 0 $ |
| **Total v2 add-on** | | **~ 7 $ / mois** |

---

## 5. Tests

```bash
npm test                                 # 58 tests passent
npm run test:unit -- memory/             # tests mémoire
npm run test:unit -- proactive/          # tests alertes
```

---

## 6. Migration v1 → v2

Pulse v1 reste **100% compatible**. Si vous n'injectez pas `memoryStore` et `memoryLearner` dans `PulseAgent`, tout fonctionne comme avant. Il suffit de :

1. Lancer la migration SQL pgvector
2. Ajouter les 4 champs `User`
3. Mettre à jour le constructeur de `PulseAgent` en injectant memory + learner
4. Brancher les routes `/memory` et `/alerts`
5. Ajouter le cron du scanner

Aucune rupture de contrat, aucun re-déploiement frontal nécessaire (les nouveaux endpoints sont additifs).
