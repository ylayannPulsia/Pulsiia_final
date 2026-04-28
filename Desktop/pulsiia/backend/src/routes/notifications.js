const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');

const router = Router();
const prisma = new PrismaClient();

// GET /api/notifications
router.get('/', requireAuth, async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  const unread = notifications.filter((n) => !n.lu).length;
  return res.json({ notifications, unread });
});

// PATCH /api/notifications/:id/lu
router.patch('/:id/lu', requireAuth, async (req, res) => {
  const notif = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!notif || notif.userId !== req.user.id) return res.status(404).json({ error: 'Introuvable' });
  const updated = await prisma.notification.update({ where: { id: req.params.id }, data: { lu: true } });
  return res.json(updated);
});

// POST /api/notifications/tout-lire
router.post('/tout-lire', requireAuth, async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user.id, lu: false }, data: { lu: true } });
  return res.json({ message: 'Tout marqué comme lu' });
});

// GET /api/sites
router.get('/sites', requireAuth, async (req, res) => {
  const sites = await prisma.site.findMany({ orderBy: { nom: 'asc' } });
  return res.json(sites);
});

module.exports = router;
