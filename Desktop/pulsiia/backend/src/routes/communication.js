const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { body, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = Router();
const prisma = new PrismaClient();

// GET /api/communication
router.get('/', requireAuth, async (req, res) => {
  const messages = await prisma.message.findMany({
    include: { auteur: { select: { nom: true, prenom: true, role: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return res.json(messages);
});

// POST /api/communication
router.post('/', requireAuth, requireRole('RH', 'MANAGER'), [
  body('titre').trim().notEmpty(),
  body('contenu').trim().notEmpty(),
  body('type').optional().isIn(['ANNONCE', 'INDIVIDUEL', 'GROUPE']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const message = await prisma.message.create({
    data: {
      auteurId: req.user.id,
      titre: req.body.titre,
      contenu: req.body.contenu,
      type: req.body.type || 'ANNONCE',
    },
    include: { auteur: { select: { nom: true, prenom: true } } },
  });

  // Créer notification pour tous les collaborateurs
  const collabs = await prisma.user.findMany({ where: { actif: true }, select: { id: true } });
  await prisma.notification.createMany({
    data: collabs
      .filter((c) => c.id !== req.user.id)
      .map((c) => ({
        userId: c.id,
        titre: req.body.titre,
        message: req.body.contenu.slice(0, 120),
        type: 'INFO',
      })),
  });

  return res.status(201).json(message);
});

module.exports = router;
