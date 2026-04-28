/**
 * @pulsiia/pulse-agent — Public API
 */

const { PulseAgent } = require('./agent');
const { ToolExecutor } = require('./tools/executor');
const { TOOL_DEFINITIONS } = require('./tools/definitions');
const { buildSystemPrompt } = require('./prompts/system');
const { createPulseRouter } = require('./routes');
const { createMemoryRouter, createAlertsRouter } = require('./routes-extended');

// Memory
const { MemoryStore, CATEGORIES } = require('./memory/store');
const { MemoryLearner } = require('./memory/learner');
const {
  createEmbedder,
  VoyageEmbedder,
  OpenAIEmbedder,
  MockEmbedder,
} = require('./memory/embedder');
const { MEMORY_TOOL_DEFINITIONS } = require('./memory/tools');

// Proactive
const { Scanner, DEFAULT_PREFS } = require('./proactive/scanner');
const { Notifier } = require('./proactive/notifier');
const { Prioritizer } = require('./proactive/prioritizer');
const { RULES, SEVERITY } = require('./proactive/rules');

// MCP
const { TokenVault } = require('./mcp/vault');
const { OAuthHandler } = require('./mcp/oauth');
const { MCPConnectionManager } = require('./mcp/connection-manager');
const { SERVERS, getServer, listServers } = require('./mcp/registry');
const {
  MOCK_TOOL_DEFINITIONS,
  isMockTool,
  executeMockTool,
} = require('./mcp/mocks');
const { createMCPRouter } = require('./mcp/routes');

module.exports = {
  // Core
  PulseAgent,
  ToolExecutor,
  TOOL_DEFINITIONS,
  buildSystemPrompt,
  createPulseRouter,

  // Memory
  MemoryStore,
  MemoryLearner,
  MEMORY_TOOL_DEFINITIONS,
  CATEGORIES,
  createEmbedder,
  VoyageEmbedder,
  OpenAIEmbedder,
  MockEmbedder,
  createMemoryRouter,

  // Proactive
  Scanner,
  Notifier,
  Prioritizer,
  RULES,
  SEVERITY,
  DEFAULT_PREFS,
  createAlertsRouter,

  // MCP
  TokenVault,
  OAuthHandler,
  MCPConnectionManager,
  SERVERS,
  getServer,
  listServers,
  MOCK_TOOL_DEFINITIONS,
  isMockTool,
  executeMockTool,
  createMCPRouter,
};
