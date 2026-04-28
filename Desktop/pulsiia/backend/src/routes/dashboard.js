const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = Router();
const prisma = new PrismaClient();

// GET /api/dashboard/kpis
router.get('/kpis', requireAuth, async (req, res) => {
  const [totalCollabs, absencesEnCours, shiftsDecouverts, variablesAValider] = await Promise.all([
    prisma.user.count({ where: { role: 'COLLABORATEUR', actif: true } }),
    prisma.absence.count({ where: { statut: 'EN_ATTENTE' } }),
    prisma.planningShift.count({ where: { statut: 'REMPLACEMENT_REQUIS' } }),
    prisma.prepaieVariable.count({ where: { statut: 'A_VALIDER', periode: 'mars-2026' } }),
  ]);

  return res.json({
    totalCollabs,
    absencesEnCours,
    shiftsDecouverts,
    variablesAValider,
    tauxPresence: Math.round(((totalCollabs - absencesEnCours) / totalCollabs) * 100),
    periode: 'Mars 2026',
    sites: 5,
  });
});

// GET /api/dashboard/flux
router.get('/flux', requireAuth, async (req, res) => {
  const absences = await prisma.absence.findMany({
    where: { statut: 'EN_ATTENTE' },
    include: { user: { select: { nom: true, prenom: true, poste: true, site: { select: { nom: true } } } } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  const shifts = await prisma.planningShift.findMany({
    where: { statut: 'REMPLACEMENT_REQUIS' },
    include: { user: { select: { nom: true, prenom: true } }, site: { select: { nom: true } } },
    take: 5,
  });

  return res.json({ absences, shifts });
});

// GET /api/dashboard/alertes
router.get('/alertes', requireAuth, requireRole('RH', 'MANAGER'), async (req, res) => {
  const [absencesUrgentes, anomalies] = await Promise.all([
    prisma.absence.findMany({
      where: { statut: 'EN_ATTENTE', type: 'MALADIE' },
      include: { user: { select: { nom: true, prenom: true, site: { select: { nom: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 3,
    }),
    prisma.prepaieVariable.findMany({
      where: { statut: 'ANOMALIE' },
      include: { user: { select: { nom: true, prenom: true } } },
      take: 3,
    }),
  ]);

  return res.json({ absencesUrgentes, anomalies });
});

module.exports = router;
