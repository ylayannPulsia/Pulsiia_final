const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { body, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = Router();
const prisma = new PrismaClient();

const include = {
  user: { select: { nom: true, prenom: true, poste: true } },
  site: { select: { nom: true } },
};

// GET /api/planning
router.get('/', requireAuth, async (req, res) => {
  const { dateDebut, dateFin, siteId, userId } = req.query;
  const isRH = ['RH', 'MANAGER'].includes(req.user.role);

  const where = {
    ...(isRH ? {} : { userId: req.user.id }),
    ...(userId && isRH && { userId }),
    ...(siteId && { siteId }),
    ...(dateDebut && dateFin && { date: { gte: dateDebut, lte: dateFin } }),
    ...(dateDebut && !dateFin && { date: { gte: dateDebut } }),
  };

  const shifts = await prisma.planningShift.findMany({
    where,
    include,
    orderBy: [{ date: 'asc' }, { heureDebut: 'asc' }],
  });
  return res.json(shifts);
});

// GET /api/planning/semaine
router.get('/semaine', requireAuth, async (req, res) => {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - today.getDay() + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const fmt = (d) => d.toISOString().slice(0, 10);
  const isRH = ['RH', 'MANAGER'].includes(req.user.role);

  const shifts = await prisma.planningShift.findMany({
    where: {
      date: { gte: fmt(monday), lte: fmt(sunday) },
      ...(isRH ? {} : { userId: req.user.id }),
    },
    include,
    orderBy: [{ date: 'asc' }, { heureDebut: 'asc' }],
  });

  return res.json({ semaine: { debut: fmt(monday), fin: fmt(sunday) }, shifts });
});

// POST /api/planning
router.post('/', requireAuth, requireRole('RH', 'MANAGER'), [
  body('userId').notEmpty(),
  body('siteId').notEmpty(),
  body('date').isDate(),
  body('heureDebut').matches(/^\d{2}:\d{2}$/),
  body('heureFin').matches(/^\d{2}:\d{2}$/),
  body('poste').trim().notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const shift = await prisma.planningShift.create({
    data: {
      userId: req.body.userId,
      siteId: req.body.siteId,
      date: req.body.date,
      heureDebut: req.body.heureDebut,
      heureFin: req.body.heureFin,
      poste: req.body.poste,
      note: req.body.note,
    },
    include,
  });
  return res.status(201).json(shift);
});

// PATCH /api/planning/:id
router.patch('/:id', requireAuth, requireRole('RH', 'MANAGER'), async (req, res) => {
  const { statut, heureDebut, heureFin, poste, note } = req.body;
  const updated = await prisma.planningShift.update({
    where: { id: req.params.id },
    data: {
      ...(statut && { statut }),
      ...(heureDebut && { heureDebut }),
      ...(heureFin && { heureFin }),
      ...(poste && { poste }),
      ...(note !== undefined && { note }),
    },
    include,
  });
  return res.json(updated);
});

// DELETE /api/planning/:id
router.delete('/:id', requireAuth, requireRole('RH', 'MANAGER'), async (req, res) => {
  await prisma.planningShift.delete({ where: { id: req.params.id } });
  return res.json({ message: 'Shift supprimé' });
});

module.exports = router;
