# @pulsiia/pulse-agent

> Pulse — l'assistant IA conversationnel de Pulsiia.
> v3 : tool use Claude + **mémoire long terme** + **alertes proactives** + **MCP servers** (Slack, Outlook, Silae).

## Quick start

```bash
npm install
cp .env.example .env  # ajouter ANTHROPIC_API_KEY + VOYAGE_API_KEY + PULSE_VAULT_KEY
npm test               # 107 tests passent
```

## Structure

```
pulse-agent/
├── src/
│   ├── agent.js              # Boucle agentique avec mémoire + MCP intégrés
│   ├── routes.js             # Express : POST /chat
│   ├── routes-extended.js    # Express : /memory, /alerts
│   ├── index.js              # Public API
│   ├── prompts/system.js     # System prompt FR (mention MCP si connecté)
│   ├── tools/                # 10 tools métier
│   ├── memory/               # ── v2 ── pgvector + Voyage embeddings
│   ├── proactive/            # ── v2 ── 7 règles, 5 canaux
│   ├── mcp/                  # ── v3 ── MCP servers
│   │   ├── registry.js       # Catalogue Slack/Outlook/Silae
│   │   ├── vault.js          # AES-256-GCM token storage + PKCE
│   │   ├── oauth.js          # OAuth2 flow + PKCE + state
│   │   ├── connection-manager.js # Build mcp_servers params + refresh
│   │   ├── mocks.js          # Mock fallback hybride
│   │   └── routes.js         # Express : /mcp/connect, /mcp/callback
│   └── middleware/audit.js   # RGPD Article 30
├── prisma/
│   ├── schema-additions.prisma     # v1 (audit log)
│   ├── schema-additions-v3.prisma  # v3 (MCPConnection + OAuthState)
│   └── migrations/pulse_memory_pgvector.sql  # v2
├── tests/                    # 107 tests
└── docs/
    ├── INTEGRATION.md        # Guide v1
    ├── INTEGRATION-V2.md     # Guide mémoire + alertes
    └── INTEGRATION-V3.md     # Guide MCP servers
```

## Modèles utilisés

- **Production** : `claude-opus-4-7` (raisonnement + tool use + MCP)
- **Léger** : `claude-haiku-4-5` (memory learner, classifier)
- **Embeddings** : Voyage `voyage-3-lite` ou OpenAI `text-embedding-3-small`
- **MCP beta header** : `mcp-client-2025-11-20`

## Capacités

| Module | Tools | Alertes proactives | MCP |
|--------|-------|---------------------|-----|
| Planning | 4 | uncovered 24h/72h | — |
| Pré-paie | 3 | anomalie, clôture imminente | Silae |
| Bien-être | 2 | score drop, turnover risk | — |
| ROI | 1 | digest matinal | — |
| Mémoire | 3 | — | — |
| Communication | — | — | Slack |
| Calendriers | — | — | Outlook |

## Sécurité

- ✅ AES-256-GCM token vault (clé maître via env)
- ✅ OAuth2 + PKCE + state CSRF
- ✅ Permissions par rôle (DRH, RH, MANAGER, COMPTABLE)
- ✅ Confirmation utilisateur obligatoire pour actions sensibles
- ✅ Audit log RGPD de chaque appel
- ✅ Anonymisation forcée bien-être
- ✅ Rate limiting (30 msg/min/user)

## Voir aussi

- [Guide v1](./docs/INTEGRATION.md) — setup core
- [Guide v2](./docs/INTEGRATION-V2.md) — mémoire + alertes
- [Guide v3](./docs/INTEGRATION-V3.md) — MCP servers
- [Eval cases](./tests/eval/cases.js)
