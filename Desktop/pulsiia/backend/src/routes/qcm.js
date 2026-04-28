const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { body, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = Router();
const prisma = new PrismaClient();

// GET /api/qcm
router.get('/', requireAuth, async (req, res) => {
  const campagnes = await prisma.qcmCampagne.findMany({
    include: {
      questions: { orderBy: { ordre: 'asc' } },
      _count: { select: { reponses: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return res.json(campagnes);
});

// GET /api/qcm/:id
router.get('/:id', requireAuth, async (req, res) => {
  const campagne = await prisma.qcmCampagne.findUnique({
    where: { id: req.params.id },
    include: {
      questions: { orderBy: { ordre: 'asc' } },
      reponses: {
        include: { user: { select: { nom: true, prenom: true } } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!campagne) return res.status(404).json({ error: 'Introuvable' });

  // Vérifier si l'utilisateur a déjà répondu
  if (req.user.role === 'COLLABORATEUR') {
    const dejaRepondu = campagne.reponses.some((r) => r.userId === req.user.id);
    return res.json({ ...campagne, dejaRepondu, reponses: [] });
  }

  return res.json(campagne);
});

// POST /api/qcm/:id/repondre
router.post('/:id/repondre', requireAuth, [
  body('reponses').isObject(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const campagne = await prisma.qcmCampagne.findUnique({ where: { id: req.params.id } });
  if (!campagne || campagne.statut !== 'ACTIVE') {
    return res.status(400).json({ error: 'Cette campagne n\'est pas active' });
  }

  const dejaRepondu = await prisma.qcmReponse.findFirst({
    where: { campagneId: req.params.id, userId: req.user.id },
  });
  if (dejaRepondu) return res.status(409).json({ error: 'Vous avez déjà répondu à ce QCM' });

  const reponse = await prisma.qcmReponse.create({
    data: {
      campagneId: req.params.id,
      userId: req.user.id,
      reponses: JSON.stringify(req.body.reponses),
    },
  });
  return res.status(201).json({ message: 'Réponse enregistrée', id: reponse.id });
});

// POST /api/qcm (créer campagne - RH seulement)
router.post('/', requireAuth, requireRole('RH'), [
  body('titre').trim().notEmpty(),
  body('dateDebut').isDate(),
  body('dateFin').isDate(),
  body('questions').isArray({ min: 1 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const campagne = await prisma.qcmCampagne.create({
    data: {
      titre: req.body.titre,
      description: req.body.description,
      dateDebut: req.body.dateDebut,
      dateFin: req.body.dateFin,
      statut: 'ACTIVE',
      questions: {
        create: req.body.questions.map((q, i) => ({
          texte: q.texte,
          type: q.type,
          ordre: i + 1,
          choix: q.choix ? JSON.stringify(q.choix) : null,
        })),
      },
    },
    include: { questions: true },
  });
  return res.status(201).json(campagne);
});

module.exports = router;
