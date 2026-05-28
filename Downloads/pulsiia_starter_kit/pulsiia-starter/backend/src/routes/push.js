// src/routes/push.js — Notifications push Web Push (VAPID)
const router = require('express').Router();
const { body } = require('express-validator');
const webpush = require('web-push');
const { authenticate } = require('../middleware/auth');
const { prisma, getCompanyId } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');

function configureVapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const email = process.env.VAPID_EMAIL || 'admin@pulsiia.com';

  if (!publicKey || !privateKey) {
    return false;
  }

  webpush.setVapidDetails(`mailto:${email}`, publicKey, privateKey);
  return true;
}

// ── GET /api/push/vapid-public-key ──────────────────────────────
router.get('/vapid-public-key', (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return res.status(503).json({
      error: 'Notifications push non configurées. Générez les clés VAPID dans .env.',
    });
  }
  res.json({ publicKey });
});

// ── POST /api/push/subscribe ────────────────────────────────────
router.post('/subscribe',
  authenticate,
  [
    body('subscription').isObject().withMessage('Subscription Web Push requise.'),
    body('subscription.endpoint').isString().notEmpty(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const { subscription } = req.body;

    await prisma.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: {
        endpoint: subscription.endpoint,
        subscription: JSON.stringify(subscription),
        userId: req.user.id,
        companyId,
      },
      update: {
        subscription: JSON.stringify(subscription),
        userId: req.user.id,
        companyId,
      },
    });

    res.json({ message: 'Abonnement push enregistré.' });
  },
);

// ── POST /api/push/unsubscribe ──────────────────────────────────
router.post('/unsubscribe',
  authenticate,
  [body('endpoint').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    await prisma.pushSubscription.deleteMany({
      where: { endpoint: req.body.endpoint, userId: req.user.id },
    });

    res.json({ message: 'Abonnement supprimé.' });
  },
);

// ── POST /api/push/test — envoi test à l'utilisateur connecté ───
router.post('/test',
  authenticate,
  async (req, res) => {
    if (!configureVapid()) {
      return res.status(503).json({ error: 'Clés VAPID manquantes dans .env.' });
    }

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: req.user.id },
    });

    if (!subs.length) {
      return res.status(404).json({ error: 'Aucun abonnement push pour ce compte.' });
    }

    const payload = JSON.stringify({
      title: 'Pulsiia — Test',
      body: 'Les notifications push fonctionnent correctement ✓',
      url: '/dashboard',
    });

    let sent = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(JSON.parse(sub.subscription), payload);
        sent += 1;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } });
        }
      }
    }

    res.json({ message: `${sent} notification(s) envoyée(s).`, sent });
  },
);

module.exports = router;
