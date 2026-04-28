/**
 * MCP Routes — OAuth flow et gestion des connexions
 *
 * Endpoints :
 *   GET    /api/pulse/mcp/servers              — liste des serveurs disponibles + statut
 *   POST   /api/pulse/mcp/connect/:serverId    — initie l'OAuth (renvoie URL d'authorize)
 *   GET    /api/pulse/mcp/callback/:serverId   — callback OAuth (provider redirige ici)
 *   POST   /api/pulse/mcp/connect-api-key/:id  — connexion via API key (Silae)
 *   DELETE /api/pulse/mcp/connect/:serverId    — révoque une connexion
 */

const express = require('express');
const { listServers } = require('./registry');

function createMCPRouter({
  oauthHandler,
  connectionManager,
  requireAuth,
  logger,
}) {
  const router = express.Router();

  // ─── GET /servers ─────────────────────────────
  router.get('/servers', requireAuth, async (req, res) => {
    try {
      const connections = await connectionManager.listConnections({
        tenantId: req.user.tenantId,
        user: req.user,
      });
      res.json({ servers: connections });
    } catch (err) {
      logger.error('[mcp] list servers', err.message);
      res.status(500).json({ error: 'Erreur de chargement' });
    }
  });

  // ─── POST /connect/:serverId ──────────────────
  router.post('/connect/:serverId', requireAuth, async (req, res) => {
    try {
      const { authorize_url, state } = await oauthHandler.initiate(
        req.params.serverId,
        { tenantId: req.user.tenantId, userId: req.user.id }
      );
      res.json({ authorize_url, state });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── GET /callback/:serverId ──────────────────
  router.get('/callback/:serverId', async (req, res) => {
    // Note : pas de requireAuth ici car c'est un callback OAuth public.
    // La sécurité repose sur le `state` (anti-CSRF) qu'on a stocké à l'initiate.
    const { code, state, error } = req.query;
    const result = await oauthHandler.callback(req.params.serverId, {
      code,
      state,
      error,
    });

    // HTML de réponse — la fenêtre OAuth se ferme et notifie l'app
    const status = result.ok ? 'success' : 'error';
    const message = result.ok
      ? 'Connexion réussie !'
      : `Erreur : ${result.error}`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang="fr"><head>
<meta charset="UTF-8"><title>Pulsiia · Connexion ${req.params.serverId}</title>
<style>
  body { font-family: 'DM Sans', system-ui, sans-serif; margin: 0; padding: 0;
         display: flex; align-items: center; justify-content: center; height: 100vh;
         background: #F7F8FA; color: #111827; }
  .card { background: white; padding: 40px; border-radius: 12px; max-width: 380px;
          text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,.08); }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 14px; color: #6B7280; line-height: 1.5; margin: 0 0 20px; }
  button { background: #2563EB; color: white; border: none; padding: 10px 20px;
           border-radius: 7px; font-size: 14px; cursor: pointer; font-weight: 500; }
</style></head>
<body>
  <div class="card">
    <div class="icon">${result.ok ? '✅' : '❌'}</div>
    <h1>${escape(message)}</h1>
    <p>Vous pouvez fermer cette fenêtre et retourner sur Pulsiia.</p>
    <button onclick="window.close()">Fermer</button>
  </div>
  <script>
    // Notifie l'app parente si elle écoute (postMessage)
    if (window.opener) {
      window.opener.postMessage({
        type: 'pulse.mcp_oauth_${status}',
        serverId: '${escape(req.params.serverId)}'
      }, '*');
      setTimeout(() => window.close(), 2500);
    }
  </script>
</body></html>`);
  });

  // ─── POST /connect-api-key/:serverId (Silae) ──
  router.post('/connect-api-key/:serverId', requireAuth, async (req, res) => {
    if (!['DRH', 'RH', 'COMPTABLE', 'ADMIN'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Permission refusée' });
    }
    try {
      const { apiKey } = req.body;
      const result = await oauthHandler.connectApiKey(
        req.params.serverId,
        apiKey,
        { tenantId: req.user.tenantId, userId: req.user.id }
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── DELETE /connect/:serverId ────────────────
  router.delete('/connect/:serverId', requireAuth, async (req, res) => {
    try {
      await oauthHandler.disconnect(req.params.serverId, {
        tenantId: req.user.tenantId,
        userId: req.user.id,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

function escape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { createMCPRouter };
