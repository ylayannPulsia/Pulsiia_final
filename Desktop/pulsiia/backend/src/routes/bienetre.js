const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = Router();
const prisma = new PrismaClient();

// GET /api/bienetre/stats
router.get('/stats', requireAuth, requireRole('RH', 'MANAGER'), async (req, res) => {
  const reponses = await prisma.qcmReponse.findMany({
    include: { campagne: { select: { titre: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  // Calculer les moyennes sur les réponses
  const scores = reponses
    .map((r) => {
      try {
        const data = JSON.parse(r.reponses);
        const vals = Object.values(data).filter((v) => typeof v === 'number');
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      } catch { return null; }
    })
    .filter(Boolean);

  const scoreMoyen = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0;

  return res.json({
    scoreMoyen,
    participation: reponses.length,
    evolution: '+0.3',
    thematiques: [
      { label: 'Charge de travail', score: 3.8, color: '#059669' },
      { label: 'Relations équipe', score: 4.2, color: '#2563EB' },
      { label: 'Ambiance', score: 4.5, color: '#7C3AED' },
      { label: 'Management', score: 3.6, color: '#D97706' },
      { label: 'Équilibre vie pro/perso', score: 3.2, color: '#DC2626' },
    ],
  });
});

module.exports = router;
