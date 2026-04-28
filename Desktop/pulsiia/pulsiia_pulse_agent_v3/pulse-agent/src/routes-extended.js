/**
 * Routes — gestion de la mémoire et des préférences d'alerte.
 *
 * À monter dans le routeur principal Pulsiia :
 *   app.use('/api/pulse/memory', createMemoryRouter({...}))
 *   app.use('/api/pulse/alerts', createAlertsRouter({...}))
 */

const express = require('express');

function createMemoryRouter({ memoryStore, requireAuth, logger }) {
  const router = express.Router();

  // GET /api/pulse/memory — liste les mémoires de l'utilisateur
  router.get('/', requireAuth, async (req, res) => {
    try {
      const { category, limit, offset } = req.query;
      const memories = await memoryStore.list({
        tenantId: req.user.tenantId,
        userId: req.user.id,
        category,
        limit: limit ? parseInt(limit, 10) : 50,
        offset: offset ? parseInt(offset, 10) : 0,
      });
      res.json({ memories });
    } catch (err) {
      logger.error('[memory] list', err.message);
      res.status(500).json({ error: 'Erreur de chargement' });
    }
  });

  // POST /api/pulse/memory — création manuelle (Marie ajoute une préférence)
  router.post('/', requireAuth, async (req, res) => {
    try {
      const { category, content, metadata } = req.body;
      const created = await memoryStore.create({
        tenantId: req.user.tenantId,
        userId: category === 'PREFERENCE_USER' ? req.user.id : null,
        category,
        content,
        metadata: metadata || {},
        confidence: 0.95,
        source: 'user',
      });
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /api/pulse/memory/:id — RGPD Article 17
  router.delete('/:id', requireAuth, async (req, res) => {
    try {
      const result = await memoryStore.forget(req.params.id, {
        tenantId: req.user.tenantId,
        userId: req.user.id,
      });
      res.json(result);
    } catch (err) {
      res.status(403).json({ error: err.message });
    }
  });

  // POST /api/pulse/memory/:id/promote — Marie confirme une mémoire auto
  router.post('/:id/promote', requireAuth, async (req, res) => {
    try {
      const updated = await memoryStore.promote(req.params.id, {
        tenantId: req.user.tenantId,
        userId: req.user.id,
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

function createAlertsRouter({ prisma, scanner, requireAuth, logger }) {
  const router = express.Router();

  // GET /api/pulse/alerts/preferences
  router.get('/preferences', requireAuth, async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        alertPreferences: true,
        slackWebhookUrl: true,
        teamsWebhookUrl: true,
      },
    });
    res.json({
      preferences: user.alertPreferences || {
        enabled: true,
        intervalMinutes: 30,
        silenceFromHour: 19,
        silenceToHour: 7,
        timezone: 'Europe/Paris',
        channels: ['websocket', 'pwa', 'email'],
      },
      slackConfigured: !!user.slackWebhookUrl,
      teamsConfigured: !!user.teamsWebhookUrl,
    });
  });

  // PUT /api/pulse/alerts/preferences
  router.put('/preferences', requireAuth, async (req, res) => {
    try {
      const {
        enabled,
        intervalMinutes,
        silenceFromHour,
        silenceToHour,
        timezone,
        channels,
        slackWebhookUrl,
        teamsWebhookUrl,
      } = req.body;

      // Validation
      if (intervalMinutes != null && (intervalMinutes < 5 || intervalMinutes > 1440)) {
        return res.status(400).json({ error: 'intervalMinutes doit être entre 5 et 1440' });
      }
      const validChannels = ['websocket', 'email', 'pwa', 'slack', 'teams'];
      if (channels && !channels.every((c) => validChannels.includes(c))) {
        return res.status(400).json({ error: 'channel invalide' });
      }

      const data = {
        alertPreferences: {
          enabled: enabled ?? true,
          intervalMinutes: intervalMinutes ?? 30,
          silenceFromHour: silenceFromHour ?? 19,
          silenceToHour: silenceToHour ?? 7,
          timezone: timezone || 'Europe/Paris',
          channels: channels || ['websocket', 'pwa', 'email'],
        },
      };
      if (slackWebhookUrl !== undefined) data.slackWebhookUrl = slackWebhookUrl;
      if (teamsWebhookUrl !== undefined) data.teamsWebhookUrl = teamsWebhookUrl;

      await prisma.user.update({ where: { id: req.user.id }, data });
      res.json({ ok: true });
    } catch (err) {
      logger.error('[alerts] update prefs', err.message);
      res.status(500).json({ error: 'Erreur de sauvegarde' });
    }
  });

  // GET /api/pulse/alerts/recent
  router.get('/recent', requireAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const alerts = await prisma.proactiveAlertSent.findMany({
      where: { userId: req.user.id },
      orderBy: { sentAt: 'desc' },
      take: limit,
    });
    res.json({ alerts });
  });

  // POST /api/pulse/alerts/:id/read
  router.post('/:id/read', requireAuth, async (req, res) => {
    await prisma.proactiveAlertSent.update({
      where: { id: req.params.id, userId: req.user.id },
      data: { readAt: new Date() },
    }).catch(() => null);
    res.json({ ok: true });
  });

  // POST /api/pulse/alerts/:id/dismiss
  router.post('/:id/dismiss', requireAuth, async (req, res) => {
    await prisma.proactiveAlertSent.update({
      where: { id: req.params.id, userId: req.user.id },
      data: { dismissedAt: new Date() },
    }).catch(() => null);
    res.json({ ok: true });
  });

  // POST /api/pulse/alerts/scan-now — admin/debug : déclenche un scan immédiat
  router.post('/scan-now', requireAuth, async (req, res) => {
    if (!['DRH', 'ADMIN'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Permission refusée' });
    }
    try {
      const result = await scanner.runScan({ includeDigest: !!req.body.includeDigest });
      res.json(result);
    } catch (err) {
      logger.error('[alerts] scan-now', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createMemoryRouter, createAlertsRouter };
