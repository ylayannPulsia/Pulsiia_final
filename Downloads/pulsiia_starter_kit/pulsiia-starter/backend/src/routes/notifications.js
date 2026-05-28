// src/routes/notifications.js — Notifications in-app (données réelles)
const router = require('express').Router();
const { param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { getCompanyId } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../lib/notifications');

// ── GET /api/notifications ─────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const data = await listNotifications(req);
    res.json(data);
  } catch (err) {
    console.error('[notifications]', err);
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
});

// ── PATCH /api/notifications/read-all ──────────────────────────
router.patch('/read-all', authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const { notifications } = await listNotifications(req);
    const keys = notifications.map((n) => n.key);
    await markAllNotificationsRead(req.user.id, companyId, keys);
    res.json({ message: 'Toutes les notifications marquées comme lues.', unreadCount: 0 });
  } catch (err) {
    console.error('[notifications read-all]', err);
    res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
  }
});

// ── PATCH /api/notifications/:key/read ─────────────────────────
router.patch('/:key/read',
  authenticate,
  [
    param('key').isString().notEmpty().withMessage('Clé de notification requise.'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    try {
      const companyId = getCompanyId(req);
      const key = decodeURIComponent(req.params.key);
      await markNotificationRead(req.user.id, companyId, key);
      res.json({ message: 'Notification marquée comme lue.', key });
    } catch (err) {
      console.error('[notifications read]', err);
      res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
    }
  },
);

module.exports = router;
