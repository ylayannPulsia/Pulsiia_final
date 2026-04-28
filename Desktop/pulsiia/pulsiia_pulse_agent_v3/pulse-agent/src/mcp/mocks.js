/**
 * Mock MCP Servers — fallback hybride
 *
 * L'API Anthropic ne peut PAS appeler des URL `mock://`. On intercepte donc
 * les appels MCP côté agent : avant d'envoyer la requête à Anthropic, on
 * remplace les serveurs mockés par des "tools" classiques (TOOL_DEFINITIONS),
 * que l'executor route vers ces handlers mock.
 *
 * Cela permet de :
 *  - Démontrer Pulse à un client SANS avoir à connecter Slack/Outlook/Silae
 *  - Tester en CI sans secrets
 *  - Migrer progressivement vers les vrais serveurs (toggle via env)
 */

// Définitions tool format Anthropic — mêmes noms que les vrais MCP tools
const MOCK_TOOL_DEFINITIONS = [
  // ─── Slack mocks ──
  {
    name: 'slack_post_message',
    description: '[Mock Slack] Poste un message dans un canal Slack.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Nom du canal (ex: #planning-paris)' },
        text: { type: 'string', description: 'Contenu du message' },
      },
      required: ['channel', 'text'],
    },
  },
  {
    name: 'slack_list_channels',
    description: '[Mock Slack] Liste les canaux du workspace.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', default: 50 } },
    },
  },
  {
    name: 'slack_send_dm',
    description: '[Mock Slack] Envoie un DM à un utilisateur.',
    input_schema: {
      type: 'object',
      properties: {
        user_email: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['user_email', 'text'],
    },
  },
  // ─── Outlook mocks ──
  {
    name: 'outlook_check_availability',
    description: "[Mock Outlook] Vérifie les disponibilités d'utilisateurs sur un créneau.",
    input_schema: {
      type: 'object',
      properties: {
        emails: { type: 'array', items: { type: 'string' } },
        start: { type: 'string', description: 'ISO 8601' },
        end: { type: 'string', description: 'ISO 8601' },
      },
      required: ['emails', 'start', 'end'],
    },
  },
  {
    name: 'outlook_create_event',
    description: '[Mock Outlook] Crée un événement calendrier.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' } },
      },
      required: ['subject', 'start', 'end'],
    },
  },
  // ─── Silae mocks ──
  {
    name: 'silae_export_variables',
    description: '[Mock Silae] Exporte les variables paie validées vers Silae.',
    input_schema: {
      type: 'object',
      properties: {
        periode: { type: 'string', description: 'YYYY-MM' },
        variable_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['periode'],
    },
  },
  {
    name: 'silae_get_bulletins',
    description: '[Mock Silae] Récupère les bulletins de paie d\'une période.',
    input_schema: {
      type: 'object',
      properties: {
        periode: { type: 'string' },
        collaborateur_id: { type: 'string' },
      },
      required: ['periode'],
    },
  },
];

/**
 * Map serverId → tools mockés exposés.
 */
const SERVER_TO_MOCK_TOOLS = {
  slack: ['slack_post_message', 'slack_list_channels', 'slack_send_dm'],
  outlook: ['outlook_check_availability', 'outlook_create_event'],
  silae: ['silae_export_variables', 'silae_get_bulletins'],
};

/**
 * Handlers — exécutés par ToolExecutor en mode mock.
 */
const MOCK_HANDLERS = {
  slack_post_message: async (input) => ({
    ok: true,
    channel: input.channel,
    ts: Date.now() + '.123456',
    message: '[MOCK] Message simulé envoyé à ' + input.channel,
  }),
  slack_list_channels: async () => ({
    ok: true,
    channels: [
      { id: 'C1', name: 'general' },
      { id: 'C2', name: 'planning-paris' },
      { id: 'C3', name: 'rh-equipe' },
    ],
  }),
  slack_send_dm: async (input) => ({
    ok: true,
    channel: 'D' + Math.random().toString(36).slice(2, 8),
    message: `[MOCK] DM simulé à ${input.user_email}`,
  }),
  outlook_check_availability: async (input) => ({
    ok: true,
    creneau: { start: input.start, end: input.end },
    disponibilites: input.emails.map((e) => ({
      email: e,
      libre: Math.random() > 0.3,
    })),
  }),
  outlook_create_event: async (input) => ({
    ok: true,
    event_id: 'evt_' + Math.random().toString(36).slice(2, 10),
    subject: input.subject,
    message: '[MOCK] Événement créé dans Outlook',
  }),
  silae_export_variables: async (input) => ({
    ok: true,
    periode: input.periode,
    variables_exportees: input.variable_ids?.length || 7,
    silae_batch_id: 'SLE-' + Date.now(),
    message: '[MOCK] Variables exportées vers Silae',
  }),
  silae_get_bulletins: async (input) => ({
    ok: true,
    periode: input.periode,
    bulletins: [
      { collaborateur: 'Thomas M.', net: 2150.0, brut: 2780.5 },
      { collaborateur: 'Léa A.', net: 1890.5, brut: 2410.0 },
    ],
  }),
};

/**
 * Pour un set de mockedServerIds, retourne les tool definitions à ajouter
 * et la map serveurId → tools fournis.
 */
function getMockToolsForServers(mockedServerIds) {
  const toolNames = new Set();
  for (const sid of mockedServerIds) {
    for (const t of SERVER_TO_MOCK_TOOLS[sid] || []) toolNames.add(t);
  }
  return MOCK_TOOL_DEFINITIONS.filter((t) => toolNames.has(t.name));
}

function isMockTool(toolName) {
  return Object.prototype.hasOwnProperty.call(MOCK_HANDLERS, toolName);
}

async function executeMockTool(toolName, input) {
  const handler = MOCK_HANDLERS[toolName];
  if (!handler) throw new Error(`mock handler manquant : ${toolName}`);
  return handler(input);
}

module.exports = {
  MOCK_TOOL_DEFINITIONS,
  SERVER_TO_MOCK_TOOLS,
  MOCK_HANDLERS,
  getMockToolsForServers,
  isMockTool,
  executeMockTool,
};
