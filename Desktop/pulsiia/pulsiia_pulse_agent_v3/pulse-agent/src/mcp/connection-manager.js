/**
 * MCP Connection Manager
 *
 * Pour une requête Pulse donnée :
 *  1. Liste les connexions MCP actives pour ce tenant + ce user
 *  2. Refresh les tokens expirés (si refresh_token disponible)
 *  3. Construit les paramètres `mcp_servers` et `tools` (mcp_toolset) à passer
 *     à l'API Anthropic
 *  4. Filtre les serveurs selon les rôles de l'utilisateur
 *
 * Mode hybride :
 *  - Si l'URL réelle (env) est configurée → utilise le serveur réel
 *  - Sinon → fallback sur un mock interne
 */

const { getServer, SERVERS } = require('./registry');

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min avant expiration

class MCPConnectionManager {
  /**
   * @param {object} opts
   * @param {object} opts.prisma
   * @param {TokenVault} opts.vault
   * @param {object} [opts.logger]
   */
  constructor({ prisma, vault, logger }) {
    this.prisma = prisma;
    this.vault = vault;
    this.logger = logger || console;
  }

  /**
   * Retourne la config MCP à passer à l'API Anthropic pour cette conversation.
   * @param {object} ctx — { tenantId, user: { id, role }, includeServers? }
   * @returns {Promise<{ mcp_servers: Array, mcp_toolsets: Array, mockedServers: Array }>}
   */
  async buildApiParams(ctx) {
    const allowedServerIds = this._serversForRole(ctx.user.role);
    const filterServerIds = ctx.includeServers || allowedServerIds;

    const connections = await this.prisma.mCPConnection.findMany({
      where: {
        tenantId: ctx.tenantId,
        serverId: { in: filterServerIds },
        revokedAt: null,
        OR: [
          { userId: '__TENANT__' },
          { userId: ctx.user.id },
        ],
      },
    });

    const mcp_servers = [];
    const mcp_toolsets = [];
    const mockedServers = [];

    for (const conn of connections) {
      const server = getServer(conn.serverId);
      if (!server) continue;

      let token;
      try {
        token = this.vault.decrypt(conn.encryptedToken);
      } catch (err) {
        this.logger.error(`[mcp] decrypt failed for ${conn.serverId}`, err.message);
        continue;
      }

      // Refresh si nécessaire
      if (this._needsRefresh(token) && token.refresh_token) {
        try {
          token = await this._refreshToken(server, token, conn);
        } catch (err) {
          this.logger.warn(`[mcp] refresh failed for ${conn.serverId}`, err.message);
          continue;
        }
      }

      // Choix URL réelle vs mock
      const url = server.url || server.mock_url;
      const isMocked = !server.url;
      if (isMocked) mockedServers.push(server.id);

      mcp_servers.push({
        type: 'url',
        url,
        name: server.name,
        authorization_token: token.access_token,
      });

      mcp_toolsets.push({
        type: 'mcp_toolset',
        mcp_server_name: server.name,
        default_config: { enabled: true, defer_loading: false },
        // Whitelist explicite (least privilege)
        ...(server.tools_allowed.length > 0 && {
          configs: Object.fromEntries(
            server.tools_allowed.map((t) => [t, { enabled: true }])
          ),
        }),
      });

      // Touch lastUsedAt
      this.prisma.mCPConnection
        .update({
          where: { id: conn.id },
          data: { lastUsedAt: new Date() },
        })
        .catch((e) => this.logger.warn('[mcp] touch lastUsedAt', e.message));
    }

    return { mcp_servers, mcp_toolsets, mockedServers };
  }

  /**
   * Liste les connexions actives pour l'UI "Mes intégrations".
   */
  async listConnections(ctx) {
    const conns = await this.prisma.mCPConnection.findMany({
      where: {
        tenantId: ctx.tenantId,
        revokedAt: null,
        OR: [{ userId: '__TENANT__' }, { userId: ctx.user.id }],
      },
      select: {
        id: true,
        serverId: true,
        userId: true,
        scope: true,
        connectedAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });

    // Enrichir avec metadata du registry
    return SERVERS.map((srv) => {
      const conn = conns.find((c) => c.serverId === srv.id);
      return {
        id: srv.id,
        label: srv.label,
        description: srv.description,
        icon: srv.icon,
        scope: srv.scope,
        available: !!srv.url,
        mocked: !srv.url,
        auth_type: srv.oauth.auth_type || 'oauth2',
        connected: !!conn,
        connectedAt: conn?.connectedAt || null,
        lastUsedAt: conn?.lastUsedAt || null,
        expiresAt: conn?.expiresAt || null,
      };
    });
  }

  // ─── private ─────────────────────────────────
  _serversForRole(role) {
    return SERVERS.filter((s) => (s.role_required || []).includes(role)).map(
      (s) => s.id
    );
  }

  _needsRefresh(token) {
    if (!token.expires_at) return false;
    const expiry = new Date(token.expires_at).getTime();
    return expiry - Date.now() < REFRESH_BUFFER_MS;
  }

  async _refreshToken(server, oldToken, conn) {
    const clientId = process.env[server.oauth.client_id_env];
    const clientSecret = process.env[server.oauth.client_secret_env];

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: oldToken.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const res = await fetch(server.oauth.token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`refresh failed: ${res.status}`);
    }
    const data = await res.json();

    const newToken = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || oldToken.refresh_token,
      token_type: data.token_type || 'Bearer',
      scope: data.scope || oldToken.scope,
      expires_at: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : null,
    };

    // Sauvegarde
    await this.prisma.mCPConnection.update({
      where: { id: conn.id },
      data: {
        encryptedToken: this.vault.encrypt(newToken),
        expiresAt: newToken.expires_at ? new Date(newToken.expires_at) : null,
      },
    });

    return newToken;
  }
}

module.exports = { MCPConnectionManager };
