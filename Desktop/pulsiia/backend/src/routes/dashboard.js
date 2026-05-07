'use strict';

const { Router } = require('express');
const prisma = require('../lib/prisma');
const { authenticate, requireRole } = require('../middleware/auth');
const { ValidationError } = require('../utils/errors');

const router = Router();
router.use(authenticate);
router.use(requireRole('MANAGER'));

// ─── GET /api/dashboard/kpis — KPIs clés ─────────────────────────────────────

router.get('/kpis', async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // Semaine en cours (lundi → dimanche)
    const day = now.getDay() || 7;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - day + 1);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);

    const [
      activeUserCount,
      pendingAbsences,
      pendingPayVars,
      latestSurvey,
      shiftsThisWeek,
      anomalyCount,
    ] = await Promise.all([
      prisma.user.count({ where: { companyId, isActive: true } }),
      prisma.absence.count({ where: { companyId, status: 'PENDING' } }),
      prisma.payVariable.count({ where: { companyId, status: 'PENDING' } }),
      prisma.survey.findFirst({
        where: { companyId, status: 'OPEN' },
        include: { _count: { select: { responses: true } } },
        orderBy: { weekStart: 'desc' },
      }),
      prisma.shift.count({ where: { companyId, startsAt: { gte: weekStart, lt: weekEnd } } }),
      prisma.payVariable.count({ where: { companyId, status: 'ANOMALY' } }),
    ]);

    // Score bien-être de la semaine courante
    let wellnessScore = null;
    if (latestSurvey) {
      const responses = await prisma.surveyResponse.findMany({
        where: { surveyId: latestSurvey.id },
        select: { score: true },
      });
      if (responses.length > 0) {
        wellnessScore = responses.reduce((s, r) => s + r.score, 0) / responses.length;
      }
    }

    res.json({
      activeUsers: activeUserCount,
      pendingAbsences,
      pendingPayVars,
      anomalyPayVars: anomalyCount,
      shiftsThisWeek,
      wellness: wellnessScore ? { score: wellnessScore, responseCount: latestSurvey._count.responses } : null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/dashboard/activity — flux d'activité récente ───────────────────

router.get('/activity', async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const limit = Math.min(Number(req.query.limit || 20), 100);

    const logs = await prisma.auditLog.findMany({
      where: { companyId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json({ activity: logs });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
