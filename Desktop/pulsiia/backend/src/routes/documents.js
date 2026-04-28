const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { body, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = Router();
const prisma = new PrismaClient();

const include = { user: { select: { nom: true, prenom: true } } };

// GET /api/documents
router.get('/', requireAuth, async (req, res) => {
  const { type, userId } = req.query;
  const isRH = ['RH', 'MANAGER'].includes(req.user.role);

  const where = {
    ...(isRH ? (userId ? { userId } : {}) : { userId: req.user.id }),
    ...(type && { type }),
  };

  const docs = await prisma.document.findMany({ where, include, orderBy: { createdAt: 'desc' } });
  return res.json(docs);
});

// POST /api/documents
router.post('/', requireAuth, requireRole('RH'), [
  body('nom').trim().notEmpty(),
  body('type').isIn(['Bulletin', 'Contrat', 'Attestation', 'Avenant', 'Autre']),
  body('userId').optional(),
  body('periode').optional().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const doc = await prisma.document.create({
    data: {
      nom: req.body.nom,
      type: req.body.type,
      userId: req.body.userId || null,
      periode: req.body.periode,
      taille: req.body.taille || '—',
    },
    include,
  });
  return res.status(201).json(doc);
});

// DELETE /api/documents/:id
router.delete('/:id', requireAuth, requireRole('RH'), async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ error: 'Introuvable' });
  await prisma.document.delete({ where: { id: req.params.id } });
  return res.json({ message: 'Document supprimé' });
});

module.exports = router;
