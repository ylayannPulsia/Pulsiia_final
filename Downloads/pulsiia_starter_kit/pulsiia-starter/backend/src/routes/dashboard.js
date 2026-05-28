// src/routes/dashboard.js — KPIs et activité récente
const router = require('express').Router();
const { query } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { MANAGER_ROLES } = require('../middleware/roles');
const { prisma, getCompanyId, withCompany } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { currentPeriod } = require('../lib/period-utils');

// ── GET /api/dashboard/kpis ─────────────────────────────────────
router.get('/kpis',
  authenticate,
  authorize(...MANAGER_ROLES),
  async (req, res) => {
    const companyId = getCompanyId(req);
    const period = currentPeriod();

    const [activeUsers, pendingAbsences, pendingVariables, surveyResponses, totalUsersInCompany] = await Promise.all([
      prisma.user.count({ where: withCompany(companyId, { isActive: true }) }),
      prisma.absence.count({ where: withCompany(companyId, { status: 'EN_ATTENTE' }) }),
      prisma.payVariable.count({ where: withCompany(companyId, { period, status: 'A_VALIDER' }) }),
      prisma.surveyResponse.count({
        where: { survey: withCompany(companyId, { status: 'ACTIVE' }) },
      }),
      prisma.user.count({ where: withCompany(companyId, { isActive: true }) }),
    ]);

    const responses = await prisma.surveyResponse.findMany({
      where: { survey: withCompany(companyId, { status: 'ACTIVE' }) },
      include: { answers: { select: { score: true } } },
    });
    const allScores = responses.flatMap((r) => r.answers.map((a) => a.score));
    const wellbeingAvg = allScores.length
      ? Math.round((allScores.reduce((s, v) => s + v, 0) / allScores.length) * 10) / 10
      : null;

    const participationRate = totalUsersInCompany
      ? Math.round((surveyResponses / totalUsersInCompany) * 100)
      : 0;

    res.json({
      activeUsers,
      pendingAbsences,
      pendingVariables,
      wellbeingScore: wellbeingAvg,
      participationRate,
      period,
    });
  }
);

// ── GET /api/dashboard/activity ────────────────────────────────
router.get('/activity',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('La limite doit être entre 1 et 50.'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const limit = parseInt(req.query.limit, 10) || 10;

    const [absences, variables] = await Promise.all([
      prisma.absence.findMany({
        where: withCompany(companyId),
        include: { user: { select: { firstName: true, lastName: true, avatarColor: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.payVariable.findMany({
        where: withCompany(companyId, { status: 'VALIDE' }),
        include: { user: { select: { firstName: true, lastName: true, avatarColor: true } } },
        orderBy: { validatedAt: 'desc' },
        take: limit,
      }),
    ]);

    const activities = [
      ...absences.map((a) => ({
        type: 'absence',
        user: `${a.user.firstName} ${a.user.lastName}`,
        avatar: a.user.avatarColor,
        text: `a déposé une demande d'absence (${a.type})`,
        date: a.createdAt,
      })),
      ...variables.map((v) => ({
        type: 'prepaie',
        user: `${v.user.firstName} ${v.user.lastName}`,
        avatar: v.user.avatarColor,
        text: `variable ${v.type} validée (${v.value}${v.unit})`,
        date: v.validatedAt,
      })),
    ]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, limit);

    res.json({ activities });
  }
);

module.exports = router;
