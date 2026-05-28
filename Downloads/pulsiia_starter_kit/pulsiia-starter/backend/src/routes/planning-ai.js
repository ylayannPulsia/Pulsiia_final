// ═══════════════════════════════════════════════════════════════
// PULSIIA — Routes Planning Hybride (3 couches)
// /api/planning/ai/*  — accès RH/Manager/DRH/Admin
// ═══════════════════════════════════════════════════════════════

const router = require('express').Router();
const { body, query, param } = require('express-validator');
const { startOfDay, addDays, endOfDay, format } = require('date-fns');

const { authenticate, authorize } = require('../middleware/auth');
const { MANAGER_ROLES } = require('../middleware/roles');
const { prisma, getCompanyId, withCompany } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { logAudit } = require('../lib/audit');
const { syncCompanyPayVariables } = require('../lib/prepaie-engine');
const { weekPeriodFromDate } = require('../lib/period-utils');
const planningAi = require('../lib/planning-ai');
const {
  assertCanAccessPlanningSite,
  assertAllCanManagePlanningUsers,
  getManagerSitesWhere,
  buildPlanningUsersWhere,
  isManagerRole,
  getManagedUserIds,
  filterWeeklyPlanningForScope,
} = require('../lib/planning-scope');

function fmt(d) { return format(d, 'yyyy-MM-dd'); }

// ── GET /api/planning/ai/status ────────────────────────────────
router.get('/status',
  authenticate,
  authorize(...MANAGER_ROLES),
  (req, res) => {
    res.json({
      enabled: planningAi.isAiEnabled(),
      model: planningAi.AI_MODEL,
      mode: planningAi.PLANNING_MODE || 'hybrid',
      haiku: planningAi.isAiEnabled(),
      description: 'Moteur hybride : contraintes légales + optimiseur local + Claude Haiku (intentions/explications)',
    });
  });

// ── GET /api/planning/ai/sites ─────────────────────────────────
// Liste rapide des sites éligibles à la génération IA + résumé du dernier planning IA
router.get('/sites',
  authenticate,
  authorize(...MANAGER_ROLES),
  async (req, res) => {
    const companyId = getCompanyId(req);
    const sitesWhere = getManagerSitesWhere(req, companyId);

    const [sites, weeks] = await Promise.all([
      prisma.site.findMany({
        where: sitesWhere,
        select: {
          id: true,
          name: true,
          city: true,
        },
        orderBy: { name: 'asc' },
      }),
      prisma.planningWeek.findMany({
        where: withCompany(companyId, isManagerRole(req.user.role) && req.user.siteId
          ? { siteId: req.user.siteId }
          : {}),
        orderBy: { generatedAt: 'desc' },
        take: 50,
      }),
    ]);

    const teamCounts = {};
    if (isManagerRole(req.user.role)) {
      const teamUsers = await prisma.user.findMany({
        where: withCompany(companyId, buildPlanningUsersWhere(req)),
        select: { id: true, siteId: true },
      });
      for (const u of teamUsers) {
        teamCounts[u.siteId] = (teamCounts[u.siteId] || 0) + 1;
      }
    } else {
      const counts = await prisma.user.groupBy({
        by: ['siteId'],
        where: withCompany(companyId, { isActive: true, siteId: { not: null } }),
        _count: { id: true },
      });
      for (const row of counts) {
        teamCounts[row.siteId] = row._count.id;
      }
    }

    const sitesWithCounts = await Promise.all(sites.map(async (s) => ({
      ...s,
      _count: { users: teamCounts[s.id] || 0 },
    })));

    const lastBySite = {};
    for (const w of weeks) {
      if (!lastBySite[w.siteId]) lastBySite[w.siteId] = w;
    }

    res.json({
      sites: sitesWithCounts.map((s) => ({
        id: s.id,
        name: s.name,
        city: s.city,
        activeUsers: s._count?.users || 0,
        lastPlanning: lastBySite[s.id] ? {
          id: lastBySite[s.id].id,
          weekStart: lastBySite[s.id].weekStart,
          status: lastBySite[s.id].status,
          isAiGenerated: lastBySite[s.id].isAiGenerated,
          aiConfidence: lastBySite[s.id].aiConfidence,
          generatedAt: lastBySite[s.id].generatedAt,
          model: lastBySite[s.id].aiModel,
        } : null,
      })),
    });
  });

// ── POST /api/planning/ai/generate ─────────────────────────────
// Body : { siteId, weekStart: "YYYY-MM-DD" }
router.post('/generate',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    body('siteId').isString().notEmpty().withMessage('siteId requis.'),
    body('weekStart').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('weekStart attendu (YYYY-MM-DD).'),
    body('selectedUserIds').optional().isArray({ min: 1 }).withMessage('selectedUserIds doit contenir au moins 1 personne.'),
    body('selectedUserIds.*').optional().isString().notEmpty(),
    body('userConstraints').optional().isArray(),
    body('userConstraints.*.userId').optional().isString().notEmpty(),
    body('userConstraints.*.text').optional().isString().isLength({ max: 300 }),
    body('naturalInput').optional({ values: 'null' }).isString().isLength({ max: 800 }),
    body('structuredParams').optional({ values: 'null' }).isObject(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const { siteId, weekStart, naturalInput, structuredParams } = req.body;
    const selectedUserIds = Array.isArray(req.body.selectedUserIds)
      ? [...new Set(req.body.selectedUserIds.map((v) => String(v).trim()).filter(Boolean))]
      : null;
    const userConstraints = Array.isArray(req.body.userConstraints)
      ? req.body.userConstraints
        .map((c) => ({
          userId: String(c?.userId || '').trim(),
          text: String(c?.text || '').trim(),
        }))
        .filter((c) => c.userId && c.text)
      : [];

    const siteCheck = await assertCanAccessPlanningSite(req, siteId, companyId);
    if (!siteCheck.ok) return res.status(siteCheck.status).json({ error: siteCheck.error });

    if (selectedUserIds?.length) {
      const usersCheck = await assertAllCanManagePlanningUsers(req, selectedUserIds, companyId);
      if (!usersCheck.ok) return res.status(usersCheck.status).json({ error: usersCheck.error });
    }

    if (userConstraints.length) {
      const constraintIds = userConstraints.map((c) => c.userId);
      const usersCheck = await assertAllCanManagePlanningUsers(req, constraintIds, companyId);
      if (!usersCheck.ok) return res.status(usersCheck.status).json({ error: usersCheck.error });
    }

    let effectiveSelectedUserIds = selectedUserIds;
    if (isManagerRole(req.user.role) && (!effectiveSelectedUserIds || !effectiveSelectedUserIds.length)) {
      effectiveSelectedUserIds = await getManagedUserIds(req, companyId, siteId);
    }

    const existing = await prisma.planningWeek.findFirst({
      where: { companyId, siteId, weekStart: new Date(`${weekStart}T00:00:00`) },
    });
    const replacingExisting = Boolean(
      existing && ['VALIDATED', 'PUBLISHED', 'AI_GENERATED', 'PENDING_VALIDATION', 'DRAFT'].includes(existing.status),
    );

    try {
      const result = await planningAi.generateWeeklyPlanning({
        companyId,
        siteId,
        weekStart,
        generatedBy: req.user.id,
        selectedUserIds: effectiveSelectedUserIds,
        userConstraints,
        naturalInput: naturalInput?.trim() || null,
        structuredParams: structuredParams || null,
        replacingExisting,
        priorStatus: existing?.status || null,
      });

      await logAudit(req, {
        action: 'planning_ai.generate',
        resource: `planning_week:${result.planningWeekId}`,
        metadata: {
          siteId,
          weekStart,
          selectedUsersCount: selectedUserIds?.length || null,
          usedAi: result.usedAi,
          model: result.model,
          mode: result.mode,
          shiftsCount: result.shifts.length,
          conflictsCount: result.conflicts.length,
          coverageRate: result.stats?.coverageRate,
        },
      });

      res.json(result);
    } catch (err) {
      console.error('[planning-ai] generate error:', err);
      res.status(err.status || 500).json({ error: err.message || 'Erreur génération IA.' });
    }
  });

// ── GET /api/planning/ai/week ──────────────────────────────────
router.get('/week',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    query('siteId').isString().notEmpty(),
    query('from').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('from attendu (YYYY-MM-DD).'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const { siteId, from } = req.query;

    const siteCheck = await assertCanAccessPlanningSite(req, siteId, companyId);
    if (!siteCheck.ok) return res.status(siteCheck.status).json({ error: siteCheck.error });

    try {
      const data = await planningAi.getWeeklyPlanning({ companyId, siteId, weekStart: from });
      const scoped = await filterWeeklyPlanningForScope(req, companyId, siteId, data);
      res.json(scoped);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

// ── POST /api/planning/ai/chat ─────────────────────────────────
// Chat temps réel pour modifier le brouillon (applique les ajustements)
router.post('/chat',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    body('siteId').isString().notEmpty(),
    body('weekStart').matches(/^\d{4}-\d{2}-\d{2}$/),
    body('message').isString().isLength({ min: 2, max: 800 }),
    body('planningWeekId').optional().isString(),
    body('selectedUserIds').optional().isArray(),
    body('selectedUserIds.*').optional().isString().notEmpty(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const { siteId, weekStart, message, planningWeekId, selectedUserIds } = req.body;

    const siteCheck = await assertCanAccessPlanningSite(req, siteId, companyId);
    if (!siteCheck.ok) return res.status(siteCheck.status).json({ error: siteCheck.error });

    if (Array.isArray(selectedUserIds) && selectedUserIds.length) {
      const usersCheck = await assertAllCanManagePlanningUsers(req, selectedUserIds, companyId);
      if (!usersCheck.ok) return res.status(usersCheck.status).json({ error: usersCheck.error });
    }

    let effectiveSelectedUserIds = Array.isArray(selectedUserIds) && selectedUserIds.length
      ? selectedUserIds
      : null;
    if (isManagerRole(req.user.role) && !effectiveSelectedUserIds?.length) {
      effectiveSelectedUserIds = await getManagedUserIds(req, companyId, siteId);
    }

    try {
      const result = await planningAi.chatPlanningWeek({
        companyId,
        siteId,
        weekStart,
        message,
        planningWeekId: planningWeekId || null,
        generatedBy: req.user.id,
        selectedUserIds: effectiveSelectedUserIds,
      });
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Erreur chat planning.' });
    }
  });

// ── POST /api/planning/ai/optimize ─────────────────────────────
router.post('/optimize',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    body('siteId').isString().notEmpty(),
    body('weekStart').matches(/^\d{4}-\d{2}-\d{2}$/),
    body('issue').isString().isLength({ min: 5, max: 500 }),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const { siteId, weekStart, issue } = req.body;

    const siteCheck = await assertCanAccessPlanningSite(req, siteId, companyId);
    if (!siteCheck.ok) return res.status(siteCheck.status).json({ error: siteCheck.error });

    try {
      const result = await planningAi.optimizePlanningWeek({ companyId, siteId, weekStart, issue });
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

// ── POST /api/planning/ai/:planningWeekId/validate ─────────────
router.post('/:planningWeekId/validate',
  authenticate,
  authorize('RH', 'DRH', 'ADMIN'),
  [param('planningWeekId').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const { planningWeekId } = req.params;

    try {
      const week = await planningAi.validatePlanningWeek({ companyId, planningWeekId, userId: req.user.id });

      const weekPeriod = weekPeriodFromDate(week.weekStart);
      try { await syncCompanyPayVariables(companyId, weekPeriod); } catch (e) { console.warn('[planning-ai] sync prepaie:', e.message); }

      await logAudit(req, {
        action: 'planning_ai.validate',
        resource: `planning_week:${week.id}`,
        metadata: { siteId: week.siteId, weekStart: fmt(week.weekStart) },
      });

      res.json({ planningWeek: week, syncedPeriods: [weekPeriod] });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

// ── POST /api/planning/ai/:planningWeekId/publish ──────────────
router.post('/:planningWeekId/publish',
  authenticate,
  authorize('RH', 'DRH', 'ADMIN'),
  [param('planningWeekId').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const week = await prisma.planningWeek.findFirst({
      where: { id: req.params.planningWeekId, companyId },
    });
    if (!week) return res.status(404).json({ error: 'Semaine introuvable.' });

    const updated = await prisma.planningWeek.update({
      where: { id: week.id },
      data: {
        status: 'PUBLISHED',
        validatedBy: week.validatedBy || req.user.id,
        validatedAt: week.validatedAt || new Date(),
      },
    });

    await logAudit(req, {
      action: 'planning_ai.publish',
      resource: `planning_week:${week.id}`,
      metadata: { siteId: week.siteId, weekStart: fmt(week.weekStart) },
    });

    res.json({ planningWeek: updated });
  });

// ── GET /api/planning/ai/alerts ────────────────────────────────
router.get('/alerts',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    query('siteId').optional().isString(),
    query('date').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    const companyId = getCompanyId(req);
    let { siteId, date } = req.query;

    if (isManagerRole(req.user.role)) {
      if (!req.user.siteId) {
        return res.json({ alerts: [] });
      }
      siteId = req.user.siteId;
    }

    const sites = siteId
      ? await prisma.site.findMany({ where: { id: siteId, companyId, isActive: true }, select: { id: true } })
      : await prisma.site.findMany({ where: getManagerSitesWhere(req, companyId), select: { id: true } });

    const allAlerts = [];
    for (const s of sites) {
      try {
        const alerts = await planningAi.detectUnderstaffedSlots({ companyId, siteId: s.id, date });
        allAlerts.push(...alerts);
      } catch (e) { console.warn('[planning-ai] alert error:', e.message); }
    }
    res.json({ alerts: allAlerts });
  });

// ── DELETE /api/planning/ai/:planningWeekId ────────────────────
// Annule un planning IA (supprime la semaine + ses shifts IA)
router.delete('/:planningWeekId',
  authenticate,
  authorize('RH', 'DRH', 'ADMIN'),
  [param('planningWeekId').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    const companyId = getCompanyId(req);
    const week = await prisma.planningWeek.findFirst({
      where: { id: req.params.planningWeekId, companyId },
    });
    if (!week) return res.status(404).json({ error: 'Semaine introuvable.' });
    if (['VALIDATED', 'PUBLISHED'].includes(week.status)) {
      return res.status(409).json({ error: 'Impossible de supprimer un planning validé ou publié.' });
    }

    const previousShiftsBackup = Array.isArray(week.aiPrompt?.previousShiftsBackup)
      ? week.aiPrompt.previousShiftsBackup
      : [];
    let restoredCount = 0;

    await prisma.$transaction(async (tx) => {
      await tx.shift.deleteMany({
        where: {
          companyId,
          siteId: week.siteId,
          date: { gte: startOfDay(week.weekStart), lte: endOfDay(week.weekEnd) },
          planningWeekId: week.id,
          isAiGenerated: true,
        },
      });

      if (previousShiftsBackup.length) {
        const restoredData = previousShiftsBackup
          .map((s) => {
            const date = String(s?.date || '').slice(0, 10);
            if (!s?.userId || !date) return null;
            return {
              companyId,
              siteId: week.siteId,
              userId: s.userId,
              date: startOfDay(new Date(`${date}T00:00:00`)),
              type: s.type || 'OFF',
              startTime: s.startTime ?? null,
              endTime: s.endTime ?? null,
              breakStart: s.breakStart ?? null,
              breakEnd: s.breakEnd ?? null,
              breakMin: s.breakMin != null ? s.breakMin : null,
              notes: s.notes ?? null,
              isAiGenerated: Boolean(s.isAiGenerated),
              aiConfidence: typeof s.aiConfidence === 'number' ? s.aiConfidence : null,
              planningWeekId: null,
            };
          })
          .filter(Boolean);

        if (restoredData.length) {
          await tx.shift.createMany({ data: restoredData });
          restoredCount = restoredData.length;
        }
      }

      await tx.planningWeek.delete({ where: { id: week.id } });
    });

    await logAudit(req, {
      action: 'planning_ai.delete',
      resource: `planning_week:${week.id}`,
      metadata: {
        siteId: week.siteId,
        weekStart: fmt(week.weekStart),
        restoredPreviousShifts: restoredCount,
      },
    });
    if (restoredCount > 0) {
      return res.json({
        message: `Planning IA supprimé. Planning précédent restauré (${restoredCount} shift(s)).`,
        restoredPreviousShifts: restoredCount,
      });
    }
    return res.json({ message: 'Planning IA supprimé.' });
  });

module.exports = router;
