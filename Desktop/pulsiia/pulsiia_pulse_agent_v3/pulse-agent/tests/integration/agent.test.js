/**
 * Integration test — PulseAgent agentic loop
 * Mocks the Anthropic SDK to simulate tool_use → tool_result → final text.
 */

// Mock the SDK before requiring the agent
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn(),
    },
  }));
});

const Anthropic = require('@anthropic-ai/sdk');
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

const mockExecutor = (responses = {}) => ({
  execute: jest.fn(async (toolName) =>
    responses[toolName] || { ok: true, data: {} }
  ),
});

const mockLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
});

describe('PulseAgent — agentic loop', () => {
  let agent, anthropicCreate, executor;

  beforeEach(() => {
    Anthropic.mockClear();
    agent = new PulseAgent({
      apiKey: 'test-key',
      executor: (executor = mockExecutor()),
      logger: mockLogger(),
    });
    anthropicCreate = agent.client.messages.create;
  });

  it('retourne directement le texte si pas de tool_use', async () => {
    anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Bonjour Marie, comment puis-je vous aider ?' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 12 },
    });

    const result = await agent.chat(
      [{ role: 'user', content: 'Bonjour' }],
      baseCtx
    );

    expect(result.reply).toMatch(/Bonjour Marie/);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.turns).toBe(1);
  });

  it('exécute un tool_use puis retourne le texte final', async () => {
    executor.execute.mockResolvedValue({
      ok: true,
      data: { total: 7, par_statut: { A_VALIDER: 7 } },
    });

    anthropicCreate
      // Tour 1 : Claude appelle lister_variables_paie
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'lister_variables_paie',
            input: { periode: '2026-03', statut: 'a_valider' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 30 },
      })
      // Tour 2 : Claude répond après avoir vu le résultat
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'Vous avez 7 variables de paie à valider pour mars 2026.',
          },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 150, output_tokens: 25 },
      });

    const result = await agent.chat(
      [
        {
          role: 'user',
          content: 'Combien de variables j\'ai à valider ce mois-ci ?',
        },
      ],
      baseCtx
    );

    expect(executor.execute).toHaveBeenCalledWith(
      'lister_variables_paie',
      { periode: '2026-03', statut: 'a_valider' },
      baseCtx
    );
    expect(result.reply).toMatch(/7 variables/);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('lister_variables_paie');
    expect(result.turns).toBe(2);
    expect(result.usage.input_tokens).toBe(250);
  });

  it('gère une erreur de tool sans crasher', async () => {
    executor.execute.mockResolvedValue({
      ok: false,
      error: 'Permission refusée',
    });

    anthropicCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'valider_variable_paie',
            input: { variable_id: 'v1' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 80, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'Désolé, vous n\'avez pas les droits pour valider cette variable.',
          },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 18 },
      });

    const result = await agent.chat(
      [{ role: 'user', content: 'Valide la variable v1' }],
      baseCtx
    );

    expect(result.reply).toMatch(/droits/);
    expect(result.toolCalls[0].ok).toBe(false);
  });

  it('respecte la limite max de tours agentiques', async () => {
    // Boucle infinie simulée : Claude appelle toujours un tool
    anthropicCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'tx',
          name: 'lire_planning',
          input: { date_debut: '2026-03-03', date_fin: '2026-03-09' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    executor.execute.mockResolvedValue({ ok: true, data: { shifts: [] } });

    const result = await agent.chat(
      [{ role: 'user', content: 'test' }],
      baseCtx
    );

    expect(result.truncated).toBe(true);
    expect(result.reply).toMatch(/n'ai pas pu/);
    expect(result.turns).toBe(8); // DEFAULTS.maxAgenticTurns
  });

  it('chaîne plusieurs tool_use en parallèle dans un même tour', async () => {
    executor.execute
      .mockResolvedValueOnce({ ok: true, data: { shifts: [] } })
      .mockResolvedValueOnce({ ok: true, data: { uncovered: 2 } });

    anthropicCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'lire_planning',
            input: { date_debut: '2026-03-03', date_fin: '2026-03-09' },
          },
          {
            type: 'tool_use',
            id: 't2',
            name: 'detecter_postes_decouverts',
            input: { date_debut: '2026-03-03', date_fin: '2026-03-09' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 40 },
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'Le planning est complet sauf 2 postes découverts.',
          },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 25 },
      });

    const result = await agent.chat(
      [{ role: 'user', content: 'État du planning cette semaine ?' }],
      baseCtx
    );

    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.reply).toMatch(/2 postes/);
  });
});
