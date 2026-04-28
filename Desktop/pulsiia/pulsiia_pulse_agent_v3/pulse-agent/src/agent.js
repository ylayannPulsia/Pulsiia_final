/**
 * Pulse Agent — Agentic Loop
 *
 * Gère la conversation multi-tour avec Claude :
 *  user → claude → tool_use → executor → tool_result → claude → ... → text final
 *
 * Modèles :
 *  - claude-opus-4-7   : prod (raisonnement + tool use complexe)
 *  - claude-haiku-4-5  : tâches légères (classification, résumés)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { TOOL_DEFINITIONS } = require('./tools/definitions');
const { MEMORY_TOOL_DEFINITIONS } = require('./memory/tools');
const { buildSystemPrompt } = require('./prompts/system');
const { augmentPromptWithMemories } = require('./memory/injector');
const { getMockToolsForServers } = require('./mcp/mocks');

const DEFAULTS = {
  model: 'claude-opus-4-7',
  modelLight: 'claude-haiku-4-5',
  maxTokens: 2048,
  maxAgenticTurns: 8, // garde-fou anti boucle infinie
  mcpBetaHeader: 'mcp-client-2025-11-20',
};

class PulseAgent {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {ToolExecutor} opts.executor
   * @param {object} [opts.logger]
   * @param {string} [opts.model]
   * @param {MemoryStore} [opts.memoryStore] — optionnel, active la mémoire long terme
   * @param {MemoryLearner} [opts.memoryLearner] — optionnel, active l'apprentissage post-conversation
   * @param {MCPConnectionManager} [opts.mcpManager] — optionnel, active les MCP servers
   */
  constructor({
    apiKey,
    executor,
    logger,
    model,
    memoryStore,
    memoryLearner,
    mcpManager,
  } = {}) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY requis');
    this.client = new Anthropic({ apiKey });
    this.executor = executor;
    this.logger = logger || console;
    this.model = model || DEFAULTS.model;
    this.memoryStore = memoryStore || null;
    this.memoryLearner = memoryLearner || null;
    this.mcpManager = mcpManager || null;
  }

  get baseTools() {
    return this.memoryStore
      ? [...TOOL_DEFINITIONS, ...MEMORY_TOOL_DEFINITIONS]
      : TOOL_DEFINITIONS;
  }

  /**
   * Conversation simple en un appel (non-streaming).
   *
   * @param {Array<{role, content}>} messages — historique conversationnel
   * @param {object} ctx — { user, tenant, tenantId, sessionId }
   * @returns {Promise<{ reply: string, history: Array, usage: object, toolCalls: Array }>}
   */
  async chat(messages, ctx) {
    const baseSystem = buildSystemPrompt({
      user: ctx.user,
      tenant: ctx.tenant,
      currentDate: ctx.currentDate,
    });

    // Mémoire long terme : injection contextuelle (RAG sémantique)
    let system = baseSystem;
    let memoriesUsed = [];
    if (this.memoryStore) {
      const augmented = await augmentPromptWithMemories(
        baseSystem,
        messages,
        this.memoryStore,
        { tenantId: ctx.tenantId, userId: ctx.user.id }
      );
      system = augmented.prompt;
      memoriesUsed = augmented.memories || [];
    }

    // MCP : résolution des serveurs connectés + fallback mock
    let mcpServers = [];
    let mcpToolsets = [];
    let mockedServers = [];
    let extraMockTools = [];
    if (this.mcpManager) {
      const mcpParams = await this.mcpManager.buildApiParams(ctx);
      mcpServers = mcpParams.mcp_servers;
      mcpToolsets = mcpParams.mcp_toolsets;
      mockedServers = mcpParams.mockedServers;
      // Pour les serveurs en fallback mock, on ajoute des tools classiques
      // (l'executor route vers les mock handlers)
      if (mockedServers.length > 0) {
        extraMockTools = getMockToolsForServers(mockedServers);
        // Retire les serveurs mockés de la liste mcp_servers
        // (on ne peut pas appeler des URL mock:// via l'API Anthropic)
        mcpServers = mcpServers.filter((s) => !mockedServers.includes(s.name));
        mcpToolsets = mcpToolsets.filter(
          (t) => !mockedServers.includes(t.mcp_server_name)
        );
      }
    }

    const tools = [...this.baseTools, ...extraMockTools, ...mcpToolsets];

    const conversation = [...messages];
    const toolCallsLog = [];
    let usage = { input_tokens: 0, output_tokens: 0 };
    let turn = 0;

    while (turn < DEFAULTS.maxAgenticTurns) {
      turn++;

      const response = await this._callClaude({
        system,
        messages: conversation,
        tools,
        mcpServers,
      });

      // Aggregate token usage
      usage.input_tokens += response.usage?.input_tokens || 0;
      usage.output_tokens += response.usage?.output_tokens || 0;

      // Append assistant response to history
      conversation.push({ role: 'assistant', content: response.content });

      // Si Claude n'a plus de tool à appeler → on retourne le texte final
      if (response.stop_reason !== 'tool_use') {
        const replyText = response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();

        // Apprentissage asynchrone (fire-and-forget) — n'attend pas
        if (this.memoryLearner) {
          this.memoryLearner
            .learnFromConversation(conversation, {
              tenantId: ctx.tenantId,
              userId: ctx.user.id,
            })
            .catch((e) => this.logger.warn('[pulse] learn failed', e.message));
        }

        return {
          reply: replyText,
          history: conversation,
          usage,
          toolCalls: toolCallsLog,
          turns: turn,
          memoriesUsed: memoriesUsed.map((m) => ({
            id: m.id,
            category: m.category,
            content: m.content,
            similarity: m.similarity,
          })),
          mcp: {
            connected: mcpServers.map((s) => s.name),
            mocked: mockedServers,
          },
        };
      }

      // Sinon : exécuter chaque tool_use et préparer le tour suivant
      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUses) {
        this.logger.info('[pulse] tool_use', {
          name: toolUse.name,
          input: toolUse.input,
        });

        const result = await this.executor.execute(
          toolUse.name,
          toolUse.input,
          ctx
        );

        toolCallsLog.push({
          name: toolUse.name,
          input: toolUse.input,
          ok: result.ok,
          turn,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.ok
            ? JSON.stringify(result.data).slice(0, 8000)
            : `Erreur : ${result.error}`,
          is_error: !result.ok,
        });
      }

      conversation.push({ role: 'user', content: toolResults });
    }

    // Sortie de garde-fou : trop de tours
    this.logger.warn('[pulse] max agentic turns reached');
    return {
      reply:
        "Je suis désolé, je n'ai pas pu finaliser votre demande dans les délais. " +
        'Pouvez-vous la reformuler ?',
      history: conversation,
      usage,
      toolCalls: toolCallsLog,
      turns: turn,
      truncated: true,
    };
  }

  // ─────────────────────────────────────────────
  async _callClaude({ system, messages, tools, mcpServers, model, maxTokens }) {
    const params = {
      model: model || this.model,
      max_tokens: maxTokens || DEFAULTS.maxTokens,
      system,
      tools: tools || this.baseTools,
      messages,
    };

    // Si des serveurs MCP réels sont configurés, on passe par l'endpoint beta
    if (mcpServers && mcpServers.length > 0) {
      params.mcp_servers = mcpServers;
      params.betas = [DEFAULTS.mcpBetaHeader];
      return this.client.beta.messages.create(params);
    }

    return this.client.messages.create(params);
  }

  /**
   * Classifieur léger (Haiku) — utile pour router une intention
   * avant d'engager le modèle Opus.
   */
  async classifyIntent(userMessage) {
    const res = await this.client.messages.create({
      model: DEFAULTS.modelLight,
      max_tokens: 50,
      system:
        'Tu classes un message utilisateur en une catégorie parmi : ' +
        'PLANNING, PREPAIE, BIENETRE, ROI, AUTRE. ' +
        'Réponds UNIQUEMENT avec le mot-clé, sans phrase.',
      messages: [{ role: 'user', content: userMessage }],
    });
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      .toUpperCase();
    return ['PLANNING', 'PREPAIE', 'BIENETRE', 'ROI'].includes(text)
      ? text
      : 'AUTRE';
  }
}

module.exports = { PulseAgent, DEFAULTS };
