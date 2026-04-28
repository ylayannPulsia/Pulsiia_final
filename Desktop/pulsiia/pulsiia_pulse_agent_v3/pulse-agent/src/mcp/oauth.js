/**
 * OAuth Handler
 *
 * Gère le flux OAuth2 (avec PKCE) pour connecter un serveur MCP à un tenant ou utilisateur.
 *
 * Flow standard :
 *  1. POST /api/pulse/mcp/connect/:serverId
 *     → génère state + PKCE, persiste dans `OAuthState`
 *     → renvoie l'URL d'authorize à laquelle le frontend redirige
 *  2. L'utilisateur autorise sur le provider (Slack/MS/Silae)
 *  3. GET /api/pulse/mcp/callback/:serverId?code=...&state=...
 *     → vérifie le state, exchange le code contre access+refresh tokens
 *     → chiffre et stocke dans `MCPConnection`
 *     → renvoie un HTML "Connexion réussie, vous pouvez fermer cette fenêtre"
 *  4. Pulse peut désormais utiliser le serveur dans ses appels API
 */

const { TokenVault } = require('./vault');
const { getServer } = require('./registry');

class OAuthHandler {
  constructor({ prisma, vault, redirectBaseUrl, logger }) {
    this.prisma = prisma;
    this.vault = vault;
    this.redirectBaseUrl = redirectBaseUrl; // ex: 'https://app.pulsiia.com'
    this.logger = logger || console;
  }

  /**
   * Étape 1 — initie le flux OAuth.
   * @param {string} serverId — id du registry
   * @param {object} ctx — { tenantId, userId }
   * @returns {Promise<{ authorize_url: string, state: string }>}
   */
  async initiate(serverId, ctx) {
    const server = getServer(serverId);
    if (!server) throw new Error(`Serveur MCP inconnu : ${serverId}`);

    if (server.oauth.auth_type === 'api_key') {
      throw new Error(
        `${server.label} ne supporte pas OAuth — utilisez l'endpoint manuel /connect-api-key`
      );
    }

    const clientId = process.env[server.oauth.client_id_env];
    if (!clientId) {
      throw new Error(`${server.oauth.client_id_env} non configuré`);
    }

    const state = TokenVault.generateState();
    const pkce = server.oauth.use_pkce ? TokenVault.generatePKCE() : null;

    // Persiste state + PKCE pour vérifier le callback
    await this.prisma.oAuthState.create({
      data: {
        state,
        serverId,
        tenantId: ctx.tenantId,
        userId: server.scope === 'user' ? ctx.userId : null,
        codeVerifier: pkce?.verifier || null,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min
      },
    });

    const redirectUri = this._redirectUri(serverId);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: server.oauth.scopes.join(' '),
      state,
      ...(pkce && {
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
      }),
    });

    const authorize_url = `${server.oauth.authorize_url}?${params.toString()}`;
    return { authorize_url, state };
  }

  /**
   * Étape 3 — handle le callback OAuth, exchange code → tokens.
   * @param {string} serverId
   * @param {object} query — { code, state, error }
   * @returns {Promise<{ ok: boolean, connectionId?: string, error?: string }>}
   */
  async callback(serverId, { code, state, error }) {
    if (error) {
      return { ok: false, error: `OAuth refusé : ${error}` };
    }
    if (!code || !state) {
      return { ok: false, error: 'code et state requis' };
    }

    const server = getServer(serverId);
    if (!server) return { ok: false, error: 'serveur inconnu' };

    // 1. Vérifie le state
    const stateRow = await this.prisma.oAuthState.findUnique({ where: { state } });
    if (!stateRow) return { ok: false, error: 'state invalide' };
    if (stateRow.expiresAt < new Date()) {
      return { ok: false, error: 'state expiré, veuillez recommencer' };
    }
    if (stateRow.serverId !== serverId) {
      return { ok: false, error: 'state ne correspond pas au serveur' };
    }

    // 2. Exchange code → tokens
    const clientId = process.env[server.oauth.client_id_env];
    const clientSecret = process.env[server.oauth.client_secret_env];

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this._redirectUri(serverId),
      client_id: clientId,
      client_secret: clientSecret,
      ...(stateRow.codeVerifier && { code_verifier: stateRow.codeVerifier }),
    });

    let tokenData;
    try {
      const res = await fetch(server.oauth.token_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) {
        const errBody = await res.text();
        return { ok: false, error: `token exchange failed (${res.status}): ${errBody.slice(0, 200)}` };
      }
      tokenData = await res.json();
    } catch (err) {
      this.logger.error('[oauth] token exchange', err.message);
      return { ok: false, error: 'erreur réseau lors de l\'échange' };
    }

    if (!tokenData.access_token) {
      return { ok: false, error: 'access_token absent de la réponse' };
    }

    // 3. Chiffre + stocke
    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    const tokenBundle = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      token_type: tokenData.token_type || 'Bearer',
      scope: tokenData.scope || server.oauth.scopes.join(' '),
      expires_at: expiresAt ? expiresAt.toISOString() : null,
      raw: tokenData, // permet d'extraire des champs spécifiques (team_id Slack, tid MS...)
    };

    const encrypted = this.vault.encrypt(tokenBundle);

    // Upsert : remplace une éventuelle connexion existante
    const where =
      server.scope === 'user'
        ? { tenantId_userId_serverId: {
            tenantId: stateRow.tenantId,
            userId: stateRow.userId,
            serverId,
          } }
        : { tenantId_userId_serverId: {
            tenantId: stateRow.tenantId,
            userId: '__TENANT__',
            serverId,
          } };

    const data = {
      tenantId: stateRow.tenantId,
      userId: stateRow.userId || '__TENANT__',
      serverId,
      encryptedToken: encrypted,
      expiresAt,
      scope: tokenBundle.scope,
      connectedAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
    };

    const conn = await this.prisma.mCPConnection.upsert({
      where,
      update: data,
      create: data,
    });

    // Cleanup state
    await this.prisma.oAuthState.delete({ where: { state } });

    return { ok: true, connectionId: conn.id, scope: tokenBundle.scope };
  }

  /**
   * Déconnecte (révoque) une connexion MCP.
   */
  async disconnect(serverId, ctx) {
    const server = getServer(serverId);
    if (!server) throw new Error('serveur inconnu');

    const userId = server.scope === 'user' ? ctx.userId : '__TENANT__';

    await this.prisma.mCPConnection.update({
      where: {
        tenantId_userId_serverId: { tenantId: ctx.tenantId, userId, serverId },
      },
      data: { revokedAt: new Date() },
    });

    return { ok: true };
  }

  /**
   * Connexion par API key (Silae) — pas de flux OAuth, juste sauvegarde du token.
   */
  async connectApiKey(serverId, apiKey, ctx) {
    const server = getServer(serverId);
    if (!server) throw new Error('serveur inconnu');
    if (server.oauth.auth_type !== 'api_key') {
      throw new Error(`${server.label} utilise OAuth, pas une API key`);
    }
    if (!apiKey || apiKey.length < 16) {
      throw new Error('API key invalide');
    }

    const tokenBundle = {
      access_token: apiKey,
      token_type: 'Bearer',
      scope: 'api_key',
      expires_at: null, // API keys typiquement long-lived
    };

    const encrypted = this.vault.encrypt(tokenBundle);
    const userId = server.scope === 'user' ? ctx.userId : '__TENANT__';

    const conn = await this.prisma.mCPConnection.upsert({
      where: {
        tenantId_userId_serverId: { tenantId: ctx.tenantId, userId, serverId },
      },
      update: {
        encryptedToken: encrypted,
        connectedAt: new Date(),
        revokedAt: null,
      },
      create: {
        tenantId: ctx.tenantId,
        userId,
        serverId,
        encryptedToken: encrypted,
        connectedAt: new Date(),
      },
    });

    return { ok: true, connectionId: conn.id };
  }

  _redirectUri(serverId) {
    return `${this.redirectBaseUrl}/api/pulse/mcp/callback/${serverId}`;
  }
}

module.exports = { OAuthHandler };
