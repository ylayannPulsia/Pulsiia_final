/**
 * Unit tests — OAuthHandler
 */

const crypto = require('crypto');
const { OAuthHandler } = require('../../../src/mcp/oauth');
const { TokenVault } = require('../../../src/mcp/vault');

const TEST_KEY = crypto.randomBytes(32).toString('hex');

const mockPrisma = () => ({
  oAuthState: {
    create: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn(),
    delete: jest.fn().mockResolvedValue({}),
  },
  mCPConnection: {
    upsert: jest.fn().mockResolvedValue({ id: 'conn1' }),
    update: jest.fn().mockResolvedValue({}),
  },
});

describe('OAuthHandler', () => {
  let prisma, vault, handler;

  beforeEach(() => {
    process.env.SLACK_CLIENT_ID = 'slack-cid';
    process.env.SLACK_CLIENT_SECRET = 'slack-secret';
    process.env.MS_GRAPH_CLIENT_ID = 'ms-cid';
    process.env.MS_GRAPH_CLIENT_SECRET = 'ms-secret';
    process.env.SILAE_CLIENT_ID = 'silae-cid';
    process.env.SILAE_API_KEY = 'silae-key';

    prisma = mockPrisma();
    vault = new TokenVault({ masterKey: TEST_KEY });
    handler = new OAuthHandler({
      prisma,
      vault,
      redirectBaseUrl: 'https://app.pulsiia.com',
      logger: { info: () => {}, error: () => {}, warn: () => {} },
    });
  });

  describe('initiate', () => {
    it("génère une URL d'authorize Slack avec PKCE et state", async () => {
      const result = await handler.initiate('slack', {
        tenantId: 't1',
        userId: 'u1',
      });
      expect(result.authorize_url).toMatch(/^https:\/\/slack\.com\/oauth\/v2\/authorize\?/);
      expect(result.authorize_url).toContain('client_id=slack-cid');
      expect(result.authorize_url).toContain('code_challenge=');
      expect(result.authorize_url).toContain('code_challenge_method=S256');
      expect(result.authorize_url).toContain('redirect_uri=https%3A%2F%2Fapp.pulsiia.com%2Fapi%2Fpulse%2Fmcp%2Fcallback%2Fslack');
      expect(result.state).toBeDefined();

      // State persisté en DB
      expect(prisma.oAuthState.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          state: result.state,
          serverId: 'slack',
          tenantId: 't1',
          userId: null, // slack scope=tenant
          codeVerifier: expect.any(String),
        }),
      });
    });

    it("scope=user pour Outlook → persiste userId", async () => {
      const result = await handler.initiate('outlook', {
        tenantId: 't1',
        userId: 'u1',
      });
      expect(prisma.oAuthState.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'u1',
          serverId: 'outlook',
        }),
      });
    });

    it("rejette un serveur inconnu", async () => {
      await expect(
        handler.initiate('inexistant', { tenantId: 't1', userId: 'u1' })
      ).rejects.toThrow(/inconnu/);
    });

    it("rejette Silae (auth_type=api_key) via OAuth", async () => {
      await expect(
        handler.initiate('silae', { tenantId: 't1', userId: 'u1' })
      ).rejects.toThrow(/OAuth|api_key/);
    });

    it("erreur claire si client_id manquant", async () => {
      delete process.env.SLACK_CLIENT_ID;
      await expect(
        handler.initiate('slack', { tenantId: 't1', userId: 'u1' })
      ).rejects.toThrow(/SLACK_CLIENT_ID/);
    });
  });

  describe('callback', () => {
    beforeEach(() => {
      // Mock fetch global
      global.fetch = jest.fn();
    });
    afterEach(() => {
      delete global.fetch;
    });

    it("retourne erreur si OAuth provider a refusé", async () => {
      const result = await handler.callback('slack', { error: 'access_denied' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/refusé/);
    });

    it("rejette state inconnu", async () => {
      prisma.oAuthState.findUnique.mockResolvedValue(null);
      const result = await handler.callback('slack', { code: 'c', state: 'unknown' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/state invalide/);
    });

    it("rejette state expiré", async () => {
      prisma.oAuthState.findUnique.mockResolvedValue({
        state: 's1',
        serverId: 'slack',
        expiresAt: new Date(Date.now() - 1000),
      });
      const result = await handler.callback('slack', { code: 'c', state: 's1' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/expiré/);
    });

    it("échange code → tokens et chiffre+stocke", async () => {
      prisma.oAuthState.findUnique.mockResolvedValue({
        state: 's1',
        serverId: 'slack',
        tenantId: 't1',
        userId: null,
        codeVerifier: 'verifier123',
        expiresAt: new Date(Date.now() + 60000),
      });
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'xoxb-real-token',
          refresh_token: 'xoxr-refresh',
          expires_in: 3600,
          scope: 'chat:write channels:read',
        }),
      });

      const result = await handler.callback('slack', { code: 'authcode', state: 's1' });
      expect(result.ok).toBe(true);
      expect(result.connectionId).toBe('conn1');

      // Vérifie l'appel au token endpoint
      expect(global.fetch).toHaveBeenCalledWith(
        'https://slack.com/api/oauth.v2.access',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('code_verifier=verifier123'),
        })
      );

      // Vérifie que la connexion a été persistée avec un token chiffré
      const upsertCall = prisma.mCPConnection.upsert.mock.calls[0][0];
      expect(upsertCall.create.encryptedToken).toBeDefined();
      expect(upsertCall.create.encryptedToken).not.toContain('xoxb-real-token');
      // Et qu'on peut le déchiffrer
      const decrypted = vault.decrypt(upsertCall.create.encryptedToken);
      expect(decrypted.access_token).toBe('xoxb-real-token');

      // State nettoyé
      expect(prisma.oAuthState.delete).toHaveBeenCalledWith({ where: { state: 's1' } });
    });

    it("gère échec du token endpoint provider", async () => {
      prisma.oAuthState.findUnique.mockResolvedValue({
        state: 's1',
        serverId: 'slack',
        tenantId: 't1',
        codeVerifier: 'v',
        expiresAt: new Date(Date.now() + 60000),
      });
      global.fetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant',
      });
      const result = await handler.callback('slack', { code: 'c', state: 's1' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/token exchange failed/);
    });
  });

  describe('connectApiKey', () => {
    it("connecte Silae avec API key", async () => {
      const result = await handler.connectApiKey('silae', 'silae-secret-key-1234567890', {
        tenantId: 't1',
        userId: 'u1',
      });
      expect(result.ok).toBe(true);

      const upsertCall = prisma.mCPConnection.upsert.mock.calls[0][0];
      const decrypted = vault.decrypt(upsertCall.create.encryptedToken);
      expect(decrypted.access_token).toBe('silae-secret-key-1234567890');
    });

    it("refuse une API key trop courte", async () => {
      await expect(
        handler.connectApiKey('silae', 'short', { tenantId: 't1', userId: 'u1' })
      ).rejects.toThrow(/invalide/);
    });

    it("refuse pour un serveur OAuth standard", async () => {
      await expect(
        handler.connectApiKey('slack', 'somekey1234567890', {
          tenantId: 't1',
          userId: 'u1',
        })
      ).rejects.toThrow(/OAuth/);
    });
  });

  describe('disconnect', () => {
    it("révoque une connexion (soft delete)", async () => {
      const result = await handler.disconnect('slack', { tenantId: 't1', userId: 'u1' });
      expect(result.ok).toBe(true);
      expect(prisma.mCPConnection.update).toHaveBeenCalledWith({
        where: expect.any(Object),
        data: { revokedAt: expect.any(Date) },
      });
    });
  });
});
