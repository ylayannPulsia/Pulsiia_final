/**
 * Integration test — PulseAgent avec MCP
 * Vérifie que les MCP servers connectés sont passés à l'API Anthropic
 * et que les serveurs en mode mock sont remplacés par des tools classiques.
 */

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn(),
    },
    beta: {
      messages: {
        create: jest.fn(),
      },
    },
  }));
});

const { PulseAgent } = require('../../src/agent');

const baseCtx = {
  user: {
    id: 'u1',
    prenom: 'Marie',
    nom: 'Lambert',
    role: 'DRH',
    permissions: { write: true },
  },
  tenant: { nom: 'Saveurs & Co', etablissements: ['Paris 11', 'Lyon'] },
  tenantId: 'tenant-1',
  currentDate: '2026-03-04',
};

describe('PulseAgent — MCP integration', () => {
  let agent, executor, mcpManager;

  beforeEach(() => {
    executor = {
      execute: jest.fn().mockResolvedValue({ ok: true, data: {} }),
    };

    mcpManager = {
      buildApiParams: jest.fn(),
    };

    agent = new PulseAgent({
      apiKey: 'test-key',
      executor,
      mcpManager,
      logger: { info: () => {}, error: () => {}, warn: () => {} },
    });
  });

  it("passe mcp_servers et betas à l'API beta quand des serveurs réels sont connectés", async () => {
    mcpManager.buildApiParams.mockResolvedValue({
      mcp_servers: [
        {
          type: 'url',
          url: 'https://mcp.slack.example/sse',
          name: 'slack',
          authorization_token: 'xoxb-real',
        },
      ],
      mcp_toolsets: [
        {
          type: 'mcp_toolset',
          mcp_server_name: 'slack',
          default_config: { enabled: true, defer_loading: false },
        },
      ],
      mockedServers: [],
    });

    agent.client.beta.messages.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Message envoyé sur Slack !' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const result = await agent.chat(
      [{ role: 'user', content: 'Préviens Thomas dans Slack' }],
      baseCtx
    );

    // Vérifie que l'endpoint beta a été utilisé
    expect(agent.client.beta.messages.create).toHaveBeenCalled();
    expect(agent.client.messages.create).not.toHaveBeenCalled();

    const callParams = agent.client.beta.messages.create.mock.calls[0][0];
    expect(callParams.mcp_servers).toEqual([
      expect.objectContaining({
        url: 'https://mcp.slack.example/sse',
        name: 'slack',
        authorization_token: 'xoxb-real',
      }),
    ]);
    expect(callParams.betas).toContain('mcp-client-2025-11-20');
    expect(result.mcp.connected).toContain('slack');
    expect(result.mcp.mocked).toEqual([]);
  });

  it("utilise l'endpoint standard et ajoute des mock tools quand serveurs en fallback", async () => {
    mcpManager.buildApiParams.mockResolvedValue({
      mcp_servers: [
        { type: 'url', url: 'mock://silae', name: 'silae', authorization_token: 'k' },
      ],
      mcp_toolsets: [
        { type: 'mcp_toolset', mcp_server_name: 'silae' },
      ],
      mockedServers: ['silae'],
    });

    agent.client.messages.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    const result = await agent.chat(
      [{ role: 'user', content: 'Exporte les variables vers Silae' }],
      baseCtx
    );

    // beta non utilisée car aucun serveur réel restant
    expect(agent.client.beta.messages.create).not.toHaveBeenCalled();
    expect(agent.client.messages.create).toHaveBeenCalled();

    const callParams = agent.client.messages.create.mock.calls[0][0];
    // Les tools doivent inclure les mocks Silae
    const toolNames = callParams.tools.map((t) => t.name).filter(Boolean);
    expect(toolNames).toContain('silae_export_variables');
    expect(toolNames).toContain('silae_get_bulletins');
    // Pas de mcp_servers / betas
    expect(callParams.mcp_servers).toBeUndefined();
    expect(callParams.betas).toBeUndefined();

    expect(result.mcp.mocked).toContain('silae');
    expect(result.mcp.connected).toEqual([]);
  });

  it("mode hybride : Slack réel + Silae mock dans la même conversation", async () => {
    mcpManager.buildApiParams.mockResolvedValue({
      mcp_servers: [
        { type: 'url', url: 'https://slack.real/sse', name: 'slack', authorization_token: 't1' },
        { type: 'url', url: 'mock://silae', name: 'silae', authorization_token: 't2' },
      ],
      mcp_toolsets: [
        { type: 'mcp_toolset', mcp_server_name: 'slack' },
        { type: 'mcp_toolset', mcp_server_name: 'silae' },
      ],
      mockedServers: ['silae'],
    });

    agent.client.beta.messages.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const result = await agent.chat(
      [{ role: 'user', content: 'Test' }],
      baseCtx
    );

    const callParams = agent.client.beta.messages.create.mock.calls[0][0];
    // mcp_servers contient slack uniquement (silae filtré)
    expect(callParams.mcp_servers).toHaveLength(1);
    expect(callParams.mcp_servers[0].name).toBe('slack');
    // tools contient mock_toolset pour slack + tools mocks Silae
    const toolNames = callParams.tools.map((t) => t.name || t.mcp_server_name);
    expect(toolNames).toContain('slack'); // toolset
    expect(toolNames).toContain('silae_export_variables'); // mock tool

    expect(result.mcp.connected).toEqual(['slack']);
    expect(result.mcp.mocked).toEqual(['silae']);
  });

  it("aucun MCP manager → comportement v2 inchangé", async () => {
    const agentNoMcp = new PulseAgent({
      apiKey: 'test-key',
      executor,
      logger: { info: () => {}, error: () => {}, warn: () => {} },
    });

    agentNoMcp.client.messages.create.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Bonjour' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 30, output_tokens: 5 },
    });

    const result = await agentNoMcp.chat(
      [{ role: 'user', content: 'Bonjour' }],
      baseCtx
    );

    expect(agentNoMcp.client.messages.create).toHaveBeenCalled();
    expect(result.reply).toBe('Bonjour');
    expect(result.mcp).toEqual({ connected: [], mocked: [] });
  });
});
