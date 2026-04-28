const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { body, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = Router();
const prisma = new PrismaClient();

const ABSENCE_TYPES = ['MALADIE', 'CONGES_PAYES', 'RTT', 'EVENEMENT_FAMILIAL', 'SANS_SOLDE'];
const ABSENCE_STATUTS = ['EN_ATTENTE', 'APPROUVE', 'REFUSE'];

const include = { user: { select: { nom: true, prenom: true, poste: true, site: { select: { nom: true } } } } };

// GET /api/absences
router.get('/', requireAuth, async (req, res) => {
  const { statut, type, siteId } = req.query;
  const isRH = ['RH', 'MANAGER'].includes(req.user.role);

  const where = {
    ...(isRH ? {} : { userId: req.user.id }),
    ...(statut && { statut }),
    ...(type && { type }),
    ...(siteId && isRH && { user: { siteId } }),
  };

  const absences = await prisma.absence.findMany({
    where,
    include,
    orderBy: { createdAt: 'desc' },
  });
  return res.json(absences);
});

// GET /api/absences/:id
router.get('/:id', requireAuth, async (req, res) => {
  const abs = await prisma.absence.findUnique({ where: { id: req.params.id }, include });
  if (!abs) return res.status(404).json({ error: 'Introuvable' });
  if (req.user.role === 'COLLABORATEUR' && abs.userId !== req.user.id) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  return res.json(abs);
});

// POST /api/absences
router.post('/', requireAuth, [
  body('type').isIn(ABSENCE_TYPES),
  body('dateDebut').isDate(),
  body('dateFin').isDate(),
  body('motif').optional().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { type, dateDebut, dateFin, motif } = req.body;
  const userId = req.user.role === 'COLLABORATEUR' ? req.user.id : (req.body.userId || req.user.id);

  if (new Date(dateFin) < new Date(dateDebut)) {
    return res.status(400).json({ error: 'La date de fin doit être après la date de début' });
  }

  const absence = await prisma.absence.create({
    data: { userId, type, dateDebut, dateFin, motif, statut: 'EN_ATTENTE' },
    include,
  });

  // Créer notification pour RH
  const rhs = await prisma.user.findMany({ where: { role: 'RH' }, select: { id: true } });
  await prisma.notification.createMany({
    data: rhs.map((rh) => ({
      userId: rh.id,
      titre: `Absence ${type}`,
      message: `${absence.user.prenom} ${absence.user.nom} - du ${dateDebut} au ${dateFin}`,
      type: type === 'MALADIE' ? 'URGENT' : 'INFO',
    })),
  });

  return res.status(201).json(absence);
});

// PATCH /api/absences/:id/statut (RH seulement)
router.patch('/:id/statut', requireAuth, requireRole('RH', 'MANAGER'), [
  body('statut').isIn(['APPROUVE', 'REFUSE']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const abs = await prisma.absence.findUnique({ where: { id: req.params.id }, include });
  if (!abs) return res.status(404).json({ error: 'Introuvable' });

  const updated = await prisma.absence.update({
    where: { id: req.params.id },
    data: { statut: req.body.statut },
    include,
  });

  // Notifier le collaborateur
  await prisma.notification.create({
    data: {
      userId: abs.userId,
      titre: req.body.statut === 'APPROUVE' ? 'Absence approuvée' : 'Absence refusée',
      message: `Votre demande d'absence du ${abs.dateDebut} au ${abs.dateFin} a été ${req.body.statut === 'APPROUVE' ? 'approuvée' : 'refusée'}`,
      type: req.body.statut === 'APPROUVE' ? 'INFO' : 'ALERTE',
    },
  });

  return res.json(updated);
});

// DELETE /api/absences/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const abs = await prisma.absence.findUnique({ where: { id: req.params.id } });
  if (!abs) return res.status(404).json({ error: 'Introuvable' });
  if (req.user.role === 'COLLABORATEUR' && abs.userId !== req.user.id) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  if (abs.statut !== 'EN_ATTENTE') {
    return res.status(400).json({ error: 'Impossible de supprimer une absence déjà traitée' });
  }
  await prisma.absence.delete({ where: { id: req.params.id } });
  return res.json({ message: 'Supprimé' });
});

module.exports = router;
