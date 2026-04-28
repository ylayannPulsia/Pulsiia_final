# Pulse Agent — Guide d'intégration

Pulse est l'assistant IA conversationnel de Pulsiia. Ce module fournit :
- Une **boucle agentique** Claude (tool use multi-tour)
- Les **10 tools** correspondant aux 4 modules Pulsiia (Planning, Pré-paie, Bien-être, ROI)
- Les **routes Express** prêtes à monter dans le monorepo
- Un **système d'audit** RGPD (Article 30)
- Une **suite de tests** (unitaires + intégration + eval métier)

---

## 1. Installation dans le monorepo

```bash
# Depuis la racine du monorepo Pulsiia
cd packages/
cp -r ../pulse-agent ./pulse-agent
cd pulse-agent
npm install
```

Si vous utilisez un workspace (npm/yarn/pnpm) :

```json
// monorepo package.json
{
  "workspaces": ["packages/*"]
}
```

---

## 2. Variables d'environnement

Ajouter dans votre `.env` :

```env
ANTHROPIC_API_KEY=sk-ant-...
PULSE_MODEL=claude-opus-4-7        # optionnel
PULSE_MAX_TURNS=8                   # optionnel
```

La clé se gère depuis https://console.anthropic.com.

---

## 3. Schéma Prisma requis

Ajouter dans `prisma/schema.prisma` (ou ajuster selon vos modèles existants) :

```prisma
model AuditLog {
  id         String   @id @default(cuid())
  userId     String
  tenantId   String
  action     String   // ex: "pulse.lire_planning"
  target     String?  // JSON stringifié
  outcome    String   // "success" | "error"
  error      String?
  durationMs Int?
  createdAt  DateTime @default(now())

  @@index([tenantId, createdAt])
  @@index([userId, createdAt])
}
```

Puis :

```bash
npx prisma migrate dev --name add_audit_log
```

Les modèles `Shift`, `VariablePaie`, etc. existent déjà dans le monorepo Pulsiia. Le module les utilise via le client Prisma injecté.

---

## 4. Branchement dans Express

Dans votre fichier de routes principal (typiquement `src/api/index.js` du monorepo) :

```javascript
const { createPulseRouter } = require('@pulsiia/pulse-agent');
const { prisma } = require('./prisma');
const { logger } = require('./logger');
const { requireAuth } = require('./middleware/auth'); // votre middleware Passport

// Vos services métier existants
const planningService = require('./services/planning');
const prepaieService = require('./services/prepaie');
const bienetreService = require('./services/bienetre');
const roiService = require('./services/roi');

app.use(
  '/api/pulse',
  createPulseRouter({
    prisma,
    services: {
      planning: planningService,
      prepaie: prepaieService,
      bienetre: bienetreService,
      roi: roiService,
    },
    logger,
    requireAuth,
  })
);
```

### Endpoints exposés

| Méthode | URL | Description |
|---------|-----|-------------|
| POST | `/api/pulse/chat` | Envoie un message à Pulse |
| GET | `/api/pulse/health` | Healthcheck |

### Format requête `POST /api/pulse/chat`

```json
{
  "messages": [
    { "role": "user", "content": "Combien de variables paie j'ai à valider ?" }
  ],
  "sessionId": "optional-session-id"
}
```

### Format réponse

```json
{
  "reply": "Vous avez 7 variables à valider pour mars 2026 ...",
  "sessionId": "u1-1719393200000",
  "toolCalls": [
    {
      "name": "lister_variables_paie",
      "input": { "periode": "2026-03", "statut": "a_valider" },
      "ok": true,
      "turn": 1
    }
  ],
  "usage": { "input_tokens": 450, "output_tokens": 120 },
  "turns": 2
}
```

---

## 5. Branchement frontend (Pulse bottom-sheet)

Le composant Pulse existe déjà dans la maquette. Voici la fonction d'envoi :

```javascript
async function sendToPulse(userMessage, history) {
  const messages = [...history, { role: 'user', content: userMessage }];
  const res = await fetch('/api/pulse/chat', {
    method: 'POST',
    credentials: 'include', // cookie de session Passport
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages })
  });
  if (!res.ok) throw new Error('Pulse indisponible');
  return await res.json();
}
```

Adapter l'animation SVG de Pulse selon `state` :
- `idle` au repos
- `thinking` pendant le fetch (réponse pending)
- `speaking` à l'arrivée de `reply`

---

## 6. Permissions

Les tools sensibles vérifient `req.user.role` et `req.user.permissions.write`.

| Tool | Rôles autorisés |
|------|-----------------|
| `lire_planning` | Tous |
| `creer_shift` | DRH, RH, MANAGER (+ permissions.write) |
| `valider_variable_paie` | DRH, RH, COMPTABLE (+ permissions.write) |
| `predire_turnover` | DRH, RH |
| `analyser_bienetre_equipe` | Tous (toujours anonymisé) |

Adapter `_checkPermission()` dans `src/tools/executor.js` si vos rôles diffèrent.

---

## 7. Tests

```bash
npm test                  # toute la suite
npm run test:unit         # uniquement les tests unitaires (sans API)
npm run test:integration  # tests de l'agent loop (avec mock SDK)
npm run test:coverage     # rapport de couverture
npm run eval              # eval set métier (nécessite ANTHROPIC_API_KEY réelle)
```

L'eval set teste 15 prompts métier types et écrit un rapport JSON daté.
**Recommandation** : lancer l'eval à chaque modification du system prompt ou des tool definitions, et viser >90% de réussite avant déploiement.

---

## 8. Coûts estimés

Avec `claude-opus-4-7` :
- ~ 250 tokens IN + 100 tokens OUT par échange simple
- ~ 800 tokens IN + 300 tokens OUT par échange avec tool use

**Budget mensuel estimé** pour 100 collaborateurs actifs Pulsiia avec 5 messages/jour :
- ~ 750 000 tokens IN + 300 000 tokens OUT / mois
- Coût indicatif : à vérifier sur https://www.anthropic.com/pricing

Pour réduire les coûts :
- Utiliser `classifyIntent()` (Haiku) en pré-routage si nécessaire
- Limiter `maxAgenticTurns` (défaut 8, peut descendre à 5)
- Activer le **prompt caching** sur le system prompt (long et stable) — voir doc Anthropic

---

## 9. Sécurité & RGPD

✅ **Audit log** : chaque appel de tool est tracé (action, user, target, outcome, durée).
✅ **Anonymisation bien-être** : les données individuelles ne sortent jamais des services internes.
✅ **Permissions** : vérifiées côté backend avant chaque tool sensible.
✅ **Rate limiting** : 30 messages/min/utilisateur.
✅ **Rétention** : configurez la rétention des `AuditLog` selon votre politique (recommandé : 365 jours).

❌ **Limites connues** :
- Pas de chiffrement E2E des messages (les conversations transitent par l'API Anthropic — voir leur DPA)
- Pas de filtre PII automatique côté entrée — à ajouter si vos utilisateurs collent des numéros de sécu, etc.

---

## 10. Roadmap

Prochaines étapes possibles :
- [ ] **Streaming** des réponses (SSE) pour UX plus fluide
- [ ] **Mémoire long terme** par utilisateur (préférences, contextes récurrents)
- [ ] **Alertes proactives** : Pulse pousse un message quand une anomalie paie est détectée
- [ ] **MCP servers** : connecter Pulse à Slack, Outlook, paie externe (Silae, Sage)
- [ ] **Multi-langue** : EN, ES pour entreprises internationales
