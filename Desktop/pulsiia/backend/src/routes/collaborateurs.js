const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { body, validationResult, query } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = Router();
const prisma = new PrismaClient();

const SELECT_COLLAB = {
  id: true, email: true, nom: true, prenom: true, role: true,
  poste: true, telephone: true, actif: true, siteId: true, createdAt: true,
  site: { select: { nom: true } },
};

// GET /api/collaborateurs
router.get('/', requireAuth, requireRole('RH', 'MANAGER'), async (req, res) => {
  const { search, siteId, role } = req.query;
  const where = {
    ...(search && {
      OR: [
        { nom: { contains: search } },
        { prenom: { contains: search } },
        { email: { contains: search } },
        { poste: { contains: search } },
      ],
    }),
    ...(siteId && { siteId }),
    ...(role && { role }),
  };

  const collabs = await prisma.user.findMany({
    where,
    select: SELECT_COLLAB,
    orderBy: [{ nom: 'asc' }, { prenom: 'asc' }],
  });

  return res.json(collabs);
});

// GET /api/collaborateurs/:id
router.get('/:id', requireAuth, async (req, res) => {
  if (req.user.role === 'COLLABORATEUR' && req.user.id !== req.params.id) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      ...SELECT_COLLAB,
      absences: { orderBy: { createdAt: 'desc' }, take: 5 },
      shifts: { orderBy: { date: 'desc' }, take: 10, include: { site: { select: { nom: true } } } },
    },
  });
  if (!user) return res.status(404).json({ error: 'Introuvable' });
  return res.json(user);
});

// POST /api/collaborateurs
router.post('/', requireAuth, requireRole('RH'), [
  body('email').isEmail().normalizeEmail(),
  body('nom').trim().notEmpty(),
  body('prenom').trim().notEmpty(),
  body('role').isIn(['RH', 'MANAGER', 'COLLABORATEUR']),
  body('poste').optional().trim(),
  body('siteId').optional(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const existing = await prisma.user.findUnique({ where: { email: req.body.email } });
  if (existing) return res.status(409).json({ error: 'Email déjà utilisé' });

  const tempPassword = Math.random().toString(36).slice(2, 10) + 'A1!';
  const hashed = await bcrypt.hash(tempPassword, 12);

  const user = await prisma.user.create({
    data: {
      email: req.body.email,
      password: hashed,
      nom: req.body.nom,
      prenom: req.body.prenom,
      role: req.body.role,
      poste: req.body.poste,
      siteId: req.body.siteId,
    },
    select: SELECT_COLLAB,
  });

  return res.status(201).json({ ...user, tempPassword });
});

// PATCH /api/collaborateurs/:id
router.patch('/:id', requireAuth, requireRole('RH', 'MANAGER'), [
  body('nom').optional().trim().notEmpty(),
  body('prenom').optional().trim().notEmpty(),
  body('poste').optional().trim(),
  body('telephone').optional().trim(),
  body('siteId').optional(),
  body('actif').optional().isBoolean(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { nom, prenom, poste, telephone, siteId, actif } = req.body;
  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: {
      ...(nom && { nom }),
      ...(prenom && { prenom }),
      ...(poste !== undefined && { poste }),
      ...(telephone !== undefined && { telephone }),
      ...(siteId !== undefined && { siteId }),
      ...(actif !== undefined && { actif }),
    },
    select: SELECT_COLLAB,
  });
  return res.json(updated);
});

module.exports = router;
