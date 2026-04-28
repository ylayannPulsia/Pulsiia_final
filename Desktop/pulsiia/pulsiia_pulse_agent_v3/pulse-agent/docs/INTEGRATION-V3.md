# Pulse Agent v3 — Guide d'intégration MCP

> Ce guide complète `INTEGRATION.md` (v1) et `INTEGRATION-V2.md` (v2).
> v3 ajoute les **MCP servers** : Slack, Outlook (Microsoft 365), et Silae,
> avec mode **hybride** (real adapter + mock fallback) pour démo client.

---

## 1. Vue d'ensemble

Pulse v3 utilise le **MCP connector natif** d'Anthropic (`mcp-client-2025-11-20`).
Pas besoin d'implémenter de client MCP côté Pulsiia : Claude se connecte
directement aux serveurs MCP pendant la conversation.

| Server | Scope OAuth | Auth type | Use cases |
|--------|-------------|-----------|-----------|
| **Slack** | Tenant (1 workspace par entreprise) | OAuth2 + PKCE | Messages, canaux, DM |
| **Outlook** | User (chacun connecte son MS365) | OAuth2 + PKCE | Calendriers, dispos, événements |
| **Silae** | Tenant | API Key | Variables paie, bulletins |

### Mode hybride

- Si `MCP_<SERVER>_URL` est configuré dans `.env` → serveur réel utilisé via API Anthropic
- Sinon → fallback automatique sur **mock tools** (les memes interfaces, données simulées)

Cela permet de **démontrer Pulse à un prospect sans avoir à connecter son SI réel**.

---

## 2. Pré-requis

### 2.1 Migration Prisma

Copier `prisma/schema-additions-v3.prisma` dans le `schema.prisma` du monorepo, puis :

```bash
npx prisma migrate dev --name add_mcp_connections
```

### 2.2 Clé de chiffrement vault

Générer une clé maître AES-256 pour chiffrer les tokens OAuth :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Stocker dans `.env` (et dans votre secret manager prod) :

```env
PULSE_VAULT_KEY=<64 caractères hex>
```

⚠️ **Critique** : si vous perdez cette clé, toutes les connexions OAuth devront être refaites.
Si elle est compromise, rotater immédiatement et révoquer tous les tokens.

### 2.3 Variables d'environnement OAuth

```env
# ─── Slack ───
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
MCP_SLACK_URL=https://mcp.slack.com/v1/sse  # vide → mode mock

# ─── Outlook / Microsoft Graph ───
MS_GRAPH_CLIENT_ID=...
MS_GRAPH_CLIENT_SECRET=...
MCP_OUTLOOK_URL=https://mcp.microsoft.com/graph/sse  # vide → mode mock

# ─── Silae ───
SILAE_CLIENT_ID=...
SILAE_API_KEY=...
MCP_SILAE_URL=https://mcp.silae.fr/api/v1/sse  # vide → mode mock

# ─── Redirect URI base (pour OAuth callbacks) ───
PULSIIA_BASE_URL=https://app.pulsiia.com
```

### 2.4 Configuration provider OAuth

Dans la console développeur de chaque provider, déclarer le redirect URI :

| Provider | Redirect URI |
|----------|--------------|
| Slack | `https://app.pulsiia.com/api/pulse/mcp/callback/slack` |
| Microsoft Azure AD | `https://app.pulsiia.com/api/pulse/mcp/callback/outlook` |

---

## 3. Setup côté code

```javascript
const {
  PulseAgent,
  ToolExecutor,
  TokenVault,
  OAuthHandler,
  MCPConnectionManager,
  createPulseRouter,
  createMCPRouter,
  // ... v1+v2
  MemoryStore,
  MemoryLearner,
  createEmbedder,
} = require('@pulsiia/pulse-agent');

const vault = new TokenVault({ masterKey: process.env.PULSE_VAULT_KEY });

const oauthHandler = new OAuthHandler({
  prisma,
  vault,
  redirectBaseUrl: process.env.PULSIIA_BASE_URL,
  logger,
});

const mcpManager = new MCPConnectionManager({ prisma, vault, logger });

const executor = new ToolExecutor({
  prisma,
  services,
  logger,
  memoryStore,
});

const agent = new PulseAgent({
  apiKey: process.env.ANTHROPIC_API_KEY,
  executor,
  logger,
  memoryStore,
  memoryLearner,
  mcpManager, // ← active les MCP
});

// Routes
app.use('/api/pulse', createPulseRouter({ /* ... */ }));
app.use('/api/pulse/memory', createMemoryRouter({ /* ... */ }));
app.use('/api/pulse/alerts', createAlertsRouter({ /* ... */ }));
app.use(
  '/api/pulse/mcp',
  createMCPRouter({ oauthHandler, connectionManager: mcpManager, requireAuth, logger })
);
```

---

## 4. Endpoints MCP

| Méthode | URL | Description |
|---------|-----|-------------|
| `GET` | `/api/pulse/mcp/servers` | Liste les 3 serveurs + statut connexion |
| `POST` | `/api/pulse/mcp/connect/:serverId` | Initie OAuth → renvoie `authorize_url` |
| `GET` | `/api/pulse/mcp/callback/:serverId` | Callback OAuth (provider redirige ici) |
| `POST` | `/api/pulse/mcp/connect-api-key/:serverId` | Connexion Silae par API key |
| `DELETE` | `/api/pulse/mcp/connect/:serverId` | Révoque une connexion |

### Flux de connexion (UI)

```javascript
// 1. Marie clique "Connecter Slack"
const { authorize_url } = await fetch('/api/pulse/mcp/connect/slack', {
  method: 'POST',
  credentials: 'include',
}).then((r) => r.json());

// 2. Ouvrir dans une popup
const popup = window.open(authorize_url, 'oauth', 'width=520,height=640');

// 3. Écouter le postMessage du callback
window.addEventListener('message', (e) => {
  if (e.data.type === 'pulse.mcp_oauth_success') {
    refreshConnectionsList();
  } else if (e.data.type === 'pulse.mcp_oauth_error') {
    showError();
  }
});
```

### Connexion Silae (API key)

```javascript
await fetch('/api/pulse/mcp/connect-api-key/silae', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey: 'sl_xxx_clé_obtenue_chez_silae' }),
});
```

---

## 5. Sécurité

### 5.1 Chiffrement des tokens

Tous les tokens OAuth/API key sont chiffrés au repos avec **AES-256-GCM** :
- IV unique par enregistrement (12 bytes)
- Auth tag de 16 bytes (détecte toute altération)
- Clé maître jamais persistée en DB (uniquement env)

### 5.2 Permissions par rôle

| Tool MCP | Rôles autorisés |
|----------|-----------------|
| `slack_post_message`, `slack_send_dm` | DRH, RH, MANAGER |
| `slack_create_channel` | DRH, RH |
| `outlook_create_event`, `outlook_send_email` | DRH, RH, MANAGER |
| `silae_export_variables` | DRH, RH, COMPTABLE |
| `silae_get_bulletins` | DRH, RH, COMPTABLE |

Les autres rôles (MANAGER, COLLABORATEUR) ne voient pas ces tools côté API.

### 5.3 Scopes OAuth (least privilege)

Pulse demande uniquement les scopes nécessaires :
- **Slack** : `chat:write`, `channels:read`, `channels:manage`, `users:read`, `im:write`
- **MS Graph** : `Calendars.ReadWrite`, `MailboxSettings.Read`, `User.Read`, `offline_access`

### 5.4 Audit log

Tout appel MCP (réel ou mock) est loggé dans `AuditLog` (RGPD Article 30) :
- Action : `pulse.<tool_name>` ou `pulse.mcp_mock.<tool_name>`
- User, tenant, timing, succès/échec
- Préservé selon votre politique de rétention (défaut 365j)

### 5.5 Confirmation utilisateur obligatoire

Le system prompt instruit Pulse de **toujours confirmer** avant :
- Envoyer un message Slack
- Créer un événement Outlook
- Exporter des variables vers Silae
- Envoyer un email

### 5.6 PKCE + state CSRF

Tous les flux OAuth utilisent PKCE (Proof Key for Code Exchange) + state aléatoire
pour prévenir les attaques CSRF et l'interception du code d'autorisation.

---

## 6. Mode démo (mocks)

Quand `MCP_<SERVER>_URL` n'est pas défini, Pulse passe en mode mock :
- Les tools `slack_*`, `outlook_*`, `silae_*` retournent des données simulées
- Pulse mentionne "_(mode démo)_" dans ses réponses
- Idéal pour pitch client avant de connecter le SI réel

Pour passer un serveur de mock à réel sans redéploiement :
1. Ajouter `MCP_SLACK_URL=...` dans l'env
2. Redémarrer le service Pulse (ou hot-reload selon votre setup)
3. La prochaine conversation utilise le serveur réel

⚠️ **Migration progressive** : possible d'avoir Slack et Outlook en réel mais Silae en mock,
si Silae n'a pas encore exposé son MCP server officiel. Pulse gère ce cas hybride
de façon transparente (cf. test `agent-mcp.test.js`).

---

## 7. Coûts additionnels v3

L'usage MCP est facturé par Anthropic au même tarif que les tokens du modèle (pas de surcoût).
Les overhead par requête :

| Item | Tokens IN supplémentaires |
|------|---------------------------|
| MCP toolset description par serveur connecté | ~ 200-500 |
| Tool calls MCP (input + output) | variable selon usage |

Pour 100 utilisateurs RH actifs avec ~ 20% d'usage MCP : **~ 3-5 €/mois additionnels**.

---

## 8. Tests

```bash
# Tous (107 passent)
PULSE_VAULT_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npm test

# Uniquement MCP
npm test -- mcp/
```

Couverture MCP : **71%**. Les modules non couverts par les unit tests :
- `oauth.js` flux réseau (mockable mais nécessite e2e avec providers)
- `routes.js` Express (nécessite supertest e2e)

Pour tests e2e en staging, configurer un workspace Slack de test et un tenant Azure AD de test.

---

## 9. Migration v2 → v3

Pulse v2 reste **100% compatible**. Si vous n'injectez pas `mcpManager`
dans `PulseAgent`, tout fonctionne comme en v2. Pour activer v3 :

1. Lancer la migration Prisma
2. Générer et stocker `PULSE_VAULT_KEY`
3. Configurer les credentials OAuth des providers
4. Injecter `mcpManager` dans le constructeur de `PulseAgent`
5. Brancher `createMCPRouter` dans Express
6. Ajouter les boutons "Connecter Slack/Outlook/Silae" dans Paramètres > Intégrations

Aucune rupture de contrat sur les endpoints existants `/chat`, `/memory`, `/alerts`.

---

## 10. Roadmap v4 (suggestions)

- [ ] **Streaming SSE** des réponses Pulse (UX synchro avec animation Pulse)
- [ ] **MCP Approval API** : workflow d'approbation pour actions sensibles (Pulse propose, manager valide)
- [ ] **Plus de connecteurs** : Sage, ADP, Pennylane, Notion, Linear
- [ ] **Custom MCP server Pulsiia** : exposer les capacités Pulsiia comme serveur MCP pour usage par d'autres agents
- [ ] **OBO flow (On-Behalf-Of)** : audit trail "Marie a demandé via Pulse" plutôt que "Pulse"
