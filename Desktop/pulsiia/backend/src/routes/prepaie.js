const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { body, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = Router();
const prisma = new PrismaClient();

const include = { user: { select: { nom: true, prenom: true, poste: true, site: { select: { nom: true } } } } };

// GET /api/prepaie
router.get('/', requireAuth, async (req, res) => {
  const { periode, statut } = req.query;
  const isRH = ['RH', 'MANAGER'].includes(req.user.role);

  const where = {
    ...(isRH ? {} : { userId: req.user.id }),
    ...(periode ? { periode } : { periode: 'mars-2026' }),
    ...(statut && { statut }),
  };

  const variables = await prisma.prepaieVariable.findMany({ where, include, orderBy: { createdAt: 'desc' } });

  const stats = {
    total: variables.length,
    aValider: variables.filter((v) => v.statut === 'A_VALIDER').length,
    valides: variables.filter((v) => v.statut === 'VALIDE').length,
    anomalies: variables.filter((v) => v.statut === 'ANOMALIE').length,
    montantTotal: variables.reduce((s, v) => s + v.montant, 0),
  };

  return res.json({ variables, stats });
});

// POST /api/prepaie
router.post('/', requireAuth, requireRole('RH', 'MANAGER'), [
  body('userId').notEmpty(),
  body('periode').notEmpty(),
  body('type').notEmpty(),
  body('montant').isFloat({ min: 0 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const variable = await prisma.prepaieVariable.create({
    data: {
      userId: req.body.userId,
      periode: req.body.periode,
      type: req.body.type,
      montant: parseFloat(req.body.montant),
      statut: 'A_VALIDER',
    },
    include,
  });
  return res.status(201).json(variable);
});

// PATCH /api/prepaie/:id/statut
router.patch('/:id/statut', requireAuth, requireRole('RH'), [
  body('statut').isIn(['VALIDE', 'A_VALIDER', 'ANOMALIE']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const updated = await prisma.prepaieVariable.update({
    where: { id: req.params.id },
    data: { statut: req.body.statut, ...(req.body.anomalie !== undefined && { anomalie: req.body.anomalie }) },
    include,
  });
  return res.json(updated);
});

// POST /api/prepaie/valider-tout
router.post('/valider-tout', requireAuth, requireRole('RH'), async (req, res) => {
  const { periode = 'mars-2026' } = req.body;
  const result = await prisma.prepaieVariable.updateMany({
    where: { periode, statut: 'A_VALIDER' },
    data: { statut: 'VALIDE' },
  });
  return res.json({ message: `${result.count} variable(s) validée(s)` });
});

// GET /api/prepaie/export
router.get('/export', requireAuth, requireRole('RH'), async (req, res) => {
  const { periode = 'mars-2026', format = 'json' } = req.query;
  const variables = await prisma.prepaieVariable.findMany({
    where: { periode, statut: 'VALIDE' },
    include,
  });

  if (format === 'csv') {
    const header = 'Collaborateur,Poste,Site,Type,Montant,Statut\n';
    const rows = variables.map((v) =>
      `"${v.user.prenom} ${v.user.nom}","${v.user.poste || ''}","${v.user.site?.nom || ''}","${v.type}",${v.montant},${v.statut}`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="prepaie-${periode}.csv"`);
    return res.send(header + rows);
  }

  return res.json({ periode, variables, exportedAt: new Date() });
});

module.exports = router;
