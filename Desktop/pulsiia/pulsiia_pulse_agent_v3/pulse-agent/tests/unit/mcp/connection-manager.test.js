/**
 * Unit tests — MCPConnectionManager
 */

// IMPORTANT : env doit être set AVANT tous les requires car registry.js
// capture process.env.MCP_*_URL au require time.
process.env.MCP_SLACK_URL = 'https://mcp.slack.example/sse';
delete process.env.MCP_OUTLOOK_URL; // outlook → mock
delete process.env.MCP_SILAE_URL;   // silae → mock

const crypto = require('crypto');
const { MCPConnectionManager } = require('../../../src/mcp/connection-manager');
const { TokenVault } = require('../../../src/mcp/vault');

const TEST_KEY = crypto.randomBytes(32).toString('hex');

const baseCtx = {
  tenantId: 't1',
  user: { id: 'u1', role: 'DRH' },
};

describe('MCPConnectionManager', () => {
  let prisma, vault, manager;

  beforeEach(() => {
    prisma = {
      mCPConnection: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    vault = new TokenVault({ masterKey: TEST_KEY });
    manager = new MCPConnectionManager({ prisma, vault, logger: console });
  });

  describe('buildApiParams', () => {
    it("retourne vides si aucune connexion", async () => {
      const result = await manager.buildApiParams(baseCtx);
      expect(result.mcp_servers).toEqual([]);
      expect(result.mcp_toolsets).toEqual([]);
      expect(result.mockedServers).toEqual([]);
    });

    it("filtre les serveurs selon le rôle", async () => {
      // COMPTABLE : pas accès à Slack ni Outlook
      const ctxComptable = {
        tenantId: 't1',
        user: { id: 'u1', role: 'COMPTABLE' },
      };
      await manager.buildApiParams(ctxComptable);
      const callArgs = prisma.mCPConnection.findMany.mock.calls[0][0];
      // serverId in: doit contenir uniquement silae
      expect(callArgs.where.serverId.in).toEqual(['silae']);
    });

    it("DRH a accès aux 3 serveurs", async () => {
      await manager.buildApiParams(baseCtx);
      const callArgs = prisma.mCPConnection.findMany.mock.calls[0][0];
      expect(callArgs.where.serverId.in).toEqual(
        expect.arrayContaining(['slack', 'outlook', 'silae'])
      );
    });

    it("construit mcp_servers + mcp_toolsets pour Slack connecté (URL réelle)", async () => {
      const token = vault.encrypt({
        access_token: 'xoxb-1234',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
      prisma.mCPConnection.findMany.mockResolvedValue([
        {
          id: 'c1',
          serverId: 'slack',
          encryptedToken: token,
          userId: '__TENANT__',
          tenantId: 't1',
        },
      ]);

      const result = await manager.buildApiParams(baseCtx);
      expect(result.mcp_servers).toHaveLength(1);
      expect(result.mcp_servers[0]).toEqual({
        type: 'url',
        url: 'https://mcp.slack.example/sse',
        name: 'slack',
        authorization_token: 'xoxb-1234',
      });
      expect(result.mcp_toolsets).toHaveLength(1);
      expect(result.mcp_toolsets[0].type).toBe('mcp_toolset');
      expect(result.mcp_toolsets[0].mcp_server_name).toBe('slack');
      expect(result.mockedServers).toEqual([]);
    });

    it("marque les serveurs sans URL configurée comme mocked", async () => {
      const token = vault.encrypt({ access_token: 'silae-key' });
      prisma.mCPConnection.findMany.mockResolvedValue([
        {
          id: 'c1',
          serverId: 'silae',
          encryptedToken: token,
          userId: '__TENANT__',
          tenantId: 't1',
        },
      ]);

      const result = await manager.buildApiParams(baseCtx);
      expect(result.mockedServers).toEqual(['silae']);
      expect(result.mcp_servers[0].url).toBe('mock://silae');
    });

    it("ignore une connexion dont le token est corrompu", async () => {
      prisma.mCPConnection.findMany.mockResolvedValue([
        {
          id: 'c1',
          serverId: 'slack',
          encryptedToken: 'corrupted-blob',
          userId: '__TENANT__',
        },
      ]);

      const result = await manager.buildApiParams(baseCtx);
      expect(result.mcp_servers).toHaveLength(0);
    });

    it("filtre selon includeServers explicite", async () => {
      await manager.buildApiParams({ ...baseCtx, includeServers: ['slack'] });
      const callArgs = prisma.mCPConnection.findMany.mock.calls[0][0];
      expect(callArgs.where.serverId.in).toEqual(['slack']);
    });
  });

  describe('listConnections', () => {
    it("retourne les 3 serveurs avec leur statut", async () => {
      prisma.mCPConnection.findMany.mockResolvedValue([
        {
          id: 'c1',
          serverId: 'slack',
          userId: '__TENANT__',
          connectedAt: new Date('2026-04-01'),
          lastUsedAt: new Date('2026-04-25'),
        },
      ]);

      const result = await manager.listConnections(baseCtx);
      expect(result).toHaveLength(3);
      const slack = result.find((s) => s.id === 'slack');
      expect(slack.connected).toBe(true);
      expect(slack.lastUsedAt).toBeDefined();
      const outlook = result.find((s) => s.id === 'outlook');
      expect(outlook.connected).toBe(false);
      expect(outlook.mocked).toBe(true);
    });
  });
});
