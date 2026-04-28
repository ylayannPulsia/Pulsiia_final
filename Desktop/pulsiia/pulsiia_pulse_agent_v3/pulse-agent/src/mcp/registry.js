/**
 * MCP Server Registry
 *
 * Catalogue des serveurs MCP supportés par Pulse.
 *
 * Pour chaque serveur :
 *  - id, name, label (UI), description
 *  - url : endpoint MCP (Streamable HTTP ou SSE selon le serveur)
 *  - scope : 'tenant' (1 connexion / entreprise) ou 'user' (1 connexion / utilisateur)
 *  - oauth : config OAuth2 (authorize URL, token URL, scopes, PKCE)
 *  - tools_allowed : whitelist d'outils Pulse expose à Claude (least privilege)
 *  - role_required : rôles Pulsiia autorisés à appeler ce serveur
 *  - sensitive_actions : tools nécessitant confirmation utilisateur explicite
 *  - mock_url : endpoint de fallback si l'environnement n'est pas configuré
 */

const SERVERS = [
  // ─── SLACK ─────────────────────────────────────
  {
    id: 'slack',
    name: 'slack',
    label: 'Slack',
    description: 'Messagerie d\'équipe — envoyer des messages, créer des canaux, notifier des collaborateurs.',
    icon: 'slack',
    url: process.env.MCP_SLACK_URL || null, // ex: 'https://mcp.slack.com/v1/sse'
    mock_url: 'mock://slack',
    scope: 'tenant', // 1 workspace Slack par entreprise Pulsiia
    oauth: {
      authorize_url: 'https://slack.com/oauth/v2/authorize',
      token_url: 'https://slack.com/api/oauth.v2.access',
      scopes: [
        'chat:write',
        'channels:read',
        'channels:manage',
        'users:read',
        'im:write',
      ],
      use_pkce: true,
      client_id_env: 'SLACK_CLIENT_ID',
      client_secret_env: 'SLACK_CLIENT_SECRET',
    },
    tools_allowed: [
      'slack_post_message',
      'slack_list_channels',
      'slack_create_channel',
      'slack_search_users',
      'slack_send_dm',
    ],
    role_required: ['DRH', 'RH', 'MANAGER'],
    sensitive_actions: [
      'slack_post_message',
      'slack_create_channel',
      'slack_send_dm',
    ],
  },

  // ─── OUTLOOK / MICROSOFT 365 ───────────────────
  {
    id: 'outlook',
    name: 'outlook',
    label: 'Outlook & Microsoft 365',
    description: 'Calendriers, disponibilités, événements et e-mails Outlook.',
    icon: 'microsoft',
    url: process.env.MCP_OUTLOOK_URL || null, // ex: 'https://mcp.microsoft.com/graph/sse'
    mock_url: 'mock://outlook',
    scope: 'user', // chaque utilisateur connecte SON Outlook
    oauth: {
      authorize_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      token_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: [
        'Calendars.ReadWrite',
        'MailboxSettings.Read',
        'User.Read',
        'offline_access',
      ],
      use_pkce: true,
      client_id_env: 'MS_GRAPH_CLIENT_ID',
      client_secret_env: 'MS_GRAPH_CLIENT_SECRET',
    },
    tools_allowed: [
      'outlook_check_availability',
      'outlook_create_event',
      'outlook_list_events',
      'outlook_send_email',
    ],
    role_required: ['DRH', 'RH', 'MANAGER'],
    sensitive_actions: [
      'outlook_create_event',
      'outlook_send_email',
    ],
  },

  // ─── SILAE (paie) ──────────────────────────────
  {
    id: 'silae',
    name: 'silae',
    label: 'Silae',
    description: 'Logiciel de paie — export des variables validées, récupération des bulletins.',
    icon: 'silae',
    url: process.env.MCP_SILAE_URL || null, // serveur MCP custom à déployer
    mock_url: 'mock://silae',
    scope: 'tenant', // 1 cabinet Silae par entreprise
    oauth: {
      // Silae n'expose pas de flux OAuth public en 2026 — auth via API key/token
      authorize_url: null,
      token_url: null,
      scopes: [],
      use_pkce: false,
      auth_type: 'api_key', // au lieu d'OAuth standard
      client_id_env: 'SILAE_CLIENT_ID',
      client_secret_env: 'SILAE_API_KEY',
    },
    tools_allowed: [
      'silae_export_variables',
      'silae_get_bulletins',
      'silae_get_employee_summary',
    ],
    role_required: ['DRH', 'RH', 'COMPTABLE'],
    sensitive_actions: ['silae_export_variables'], // écriture dans Silae = critique
  },
];

function getServer(id) {
  return SERVERS.find((s) => s.id === id) || null;
}

function listServers() {
  return SERVERS.map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    icon: s.icon,
    scope: s.scope,
    role_required: s.role_required,
    available: !!s.url,
    auth_type: s.oauth.auth_type || 'oauth2',
  }));
}

module.exports = { SERVERS, getServer, listServers };
