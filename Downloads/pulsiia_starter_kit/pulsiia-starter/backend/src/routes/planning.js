// src/routes/planning.js — Semaine, shifts CRUD, alertes postes découverts
const router = require('express').Router();
const { body, query, param } = require('express-validator');
const { startOfDay, endOfDay, addDays, format, startOfWeek } = require('date-fns');
const { authenticate, authorize } = require('../middleware/auth');
const { MANAGER_ROLES } = require('../middleware/roles');
const {
  prisma,
  getCompanyId,
  withCompany,
} = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { logAudit } = require('../lib/audit');
const { syncCompanyPayVariables, syncUserPayVariables } = require('../lib/prepaie-engine');
const { weekPeriodFromDate } = require('../lib/period-utils');
const {
  buildPlanningUsersWhere,
  assertCanAccessPlanningSite,
  assertCanManagePlanningUser,
  assertCanManageShift,
  assertAllCanManagePlanningUsers,
  getManagerSitesWhere,
} = require('../lib/planning-scope');

const COVERAGE_TYPES = ['MATIN', 'APREM'];
const MIN_COVERAGE = 2;

function parseDateParam(str) {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(`${str}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatShiftDate(date) {
  return format(date, 'yyyy-MM-dd');
}

function serializeShift(shift) {
  return {
    id: shift.id,
    userId: shift.userId,
    date: formatShiftDate(shift.date),
    type: shift.type,
    startTime: shift.startTime,
    endTime: shift.endTime,
    breakStart: shift.breakStart ?? null,
    breakEnd: shift.breakEnd ?? null,
    breakMin: shift.breakMin ?? null,
    siteId: shift.siteId,
  };
}

async function syncPrepaieForShift(userId, companyId, date) {
  // Pré-paie travaille sur une période hebdo (lundi YYYY-MM-DD), pas mensuelle.
  const period = weekPeriodFromDate(date);
  try {
    await syncUserPayVariables(userId, companyId, period);
  } catch (err) {
    console.error('[prepaie-sync]', err.message);
  }
}

// ── GET /api/planning/week?from=YYYY-MM-DD&siteId=xxx ───────────
router.get('/week',
  authenticate,
  [
    query('from').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Paramètre from invalide (attendu : YYYY-MM-DD).'),
    query('siteId').isString().notEmpty().withMessage('Paramètre siteId requis.'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { from, siteId } = req.query;
    const companyId = getCompanyId(req);

    const weekStart = parseDateParam(from);
    if (!weekStart) {
      return res.status(400).json({ error: 'Paramètre from invalide (attendu : YYYY-MM-DD).' });
    }

    const siteCheck = await assertCanAccessPlanningSite(req, siteId, companyId);
    if (!siteCheck.ok) {
      return res.status(siteCheck.status).json({ error: siteCheck.error });
    }

    const rangeStart = startOfDay(weekStart);
    const rangeEnd = endOfDay(addDays(weekStart, 6));

    const userWhere = buildPlanningUsersWhere(req, { siteId });
    const users = await prisma.user.findMany({
      where: withCompany(companyId, userWhere),
      select: {
        id: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        avatarColor: true,
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    const userIds = users.map((u) => u.id);

    const shifts = userIds.length
      ? await prisma.shift.findMany({
        where: withCompany(companyId, {
          siteId,
          userId: { in: userIds },
          date: { gte: rangeStart, lte: rangeEnd },
        }),
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      })
      : [];

    const shiftsByUser = shifts.reduce((acc, shift) => {
      if (!acc[shift.userId]) acc[shift.userId] = [];
      acc[shift.userId].push(serializeShift(shift));
      return acc;
    }, {});

    res.json({
      users: users.map((user) => ({
        ...user,
        shifts: shiftsByUser[user.id] || [],
      })),
    });
  }
);

// ── GET /api/planning/week-all?from=YYYY-MM-DD ─────────────────
router.get('/week-all',
  authenticate,
  [
    query('from').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Paramètre from invalide (attendu : YYYY-MM-DD).'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { from } = req.query;
    const companyId = getCompanyId(req);
    const weekStart = parseDateParam(from);
    if (!weekStart) {
      return res.status(400).json({ error: 'Paramètre from invalide (attendu : YYYY-MM-DD).' });
    }

    const rangeStart = startOfDay(weekStart);
    const rangeEnd = endOfDay(addDays(weekStart, 6));

    const userWhere = buildPlanningUsersWhere(req);
    const users = await prisma.user.findMany({
      where: withCompany(companyId, userWhere),
      select: {
        id: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        avatarColor: true,
        siteId: true,
        site: { select: { id: true, name: true } },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    const userIds = users.map((u) => u.id);

    const shifts = userIds.length
      ? await prisma.shift.findMany({
        where: withCompany(companyId, {
          userId: { in: userIds },
          date: { gte: rangeStart, lte: rangeEnd },
        }),
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      })
      : [];

    const shiftsByUser = shifts.reduce((acc, shift) => {
      if (!acc[shift.userId]) acc[shift.userId] = [];
      acc[shift.userId].push(serializeShift(shift));
      return acc;
    }, {});

    res.json({
      from,
      users: users.map((user) => ({
        ...user,
        shifts: shiftsByUser[user.id] || [],
      })),
    });
  },
);

// ── GET /api/planning/alerts ────────────────────────────────────
router.get('/alerts',
  authenticate,
  authorize(...MANAGER_ROLES),
  async (req, res) => {
    const companyId = getCompanyId(req);
    const monday = startOfWeek(new Date(), { weekStartsOn: 1 });
    const rangeStart = startOfDay(monday);
    const rangeEnd = endOfDay(addDays(monday, 6));

    const [sites, shifts] = await Promise.all([
      prisma.site.findMany({
        where: getManagerSitesWhere(req, companyId),
        select: { id: true, name: true },
      }),
      prisma.shift.findMany({
        where: withCompany(companyId, {
          date: { gte: rangeStart, lte: rangeEnd },
          type: { in: COVERAGE_TYPES },
        }),
        select: { siteId: true, date: true, userId: true, type: true },
      }),
    ]);

    if (!shifts.length) return res.json({ alerts: [] });

    const siteIds = new Set(sites.map((s) => s.id));
    const coverage = new Map();
    for (const shift of shifts) {
      if (!siteIds.has(shift.siteId)) continue;
      const dayKey = formatShiftDate(shift.date);
      const key = `${shift.siteId}|${dayKey}|${shift.type}`;
      if (!coverage.has(key)) coverage.set(key, new Set());
      coverage.get(key).add(shift.userId);
    }

    const alerts = [];
    for (let day = 0; day < 7; day++) {
      const date = formatShiftDate(addDays(monday, day));
      for (const site of sites) {
        for (const type of COVERAGE_TYPES) {
          const key = `${site.id}|${date}|${type}`;
          const count = coverage.get(key)?.size ?? 0;
          // Evite les alertes "fantômes" sur des créneaux totalement vides/non planifiés.
          if (count > 0 && count < MIN_COVERAGE) {
            const slot = type === 'MATIN' ? 'matin' : 'après-midi';
            alerts.push({
              severity: 'red',
              message: `Poste ${slot} découvert — ${count} personne${count > 1 ? 's' : ''} planifiée${count > 1 ? 's' : ''} sur ${site.name} (minimum ${MIN_COVERAGE}).`,
              siteId: site.id,
              date,
            });
          }
        }
      }
    }

    res.json({ alerts });
  }
);

// ── POST /api/planning/shifts ───────────────────────────────────
router.post('/shifts',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    body('userId').isString().notEmpty().withMessage('Utilisateur requis.'),
    body('siteId').isString().notEmpty().withMessage('Site requis.'),
    body('date').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Date invalide (attendu : YYYY-MM-DD).'),
    body('type').isIn(['MATIN', 'APREM', 'NUIT', 'JOURNEE', 'OFF', 'ABSENT']).withMessage('Type de shift invalide.'),
    body('startTime').optional({ nullable: true }).isString(),
    body('endTime').optional({ nullable: true }).isString(),
    body('breakStart').optional({ nullable: true }).isString(),
    body('breakEnd').optional({ nullable: true }).isString(),
    body('breakMin').optional({ nullable: true }).isInt({ min: 0, max: 480 }),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const { userId, siteId, date, type, startTime, endTime, breakStart, breakEnd, breakMin } = req.body;

    const parsedDate = parseDateParam(date);
    if (!parsedDate) {
      return res.status(400).json({ error: 'Date invalide (attendu : YYYY-MM-DD).' });
    }

    const [userCheck, siteCheck] = await Promise.all([
      assertCanManagePlanningUser(req, userId, companyId),
      assertCanAccessPlanningSite(req, siteId, companyId),
    ]);

    if (!userCheck.ok) {
      return res.status(userCheck.status).json({ error: userCheck.error });
    }
    if (!siteCheck.ok) {
      return res.status(siteCheck.status).json({ error: siteCheck.error });
    }

    const shift = await prisma.shift.create({
      data: {
        userId,
        siteId,
        companyId,
        date: startOfDay(parsedDate),
        type,
        startTime: startTime ?? null,
        endTime: endTime ?? null,
        breakStart: breakStart ?? null,
        breakEnd: breakEnd ?? null,
        breakMin: breakMin != null ? breakMin : null,
      },
    });

    res.status(201).json(serializeShift(shift));

    await logAudit(req, {
      action: 'shift.create',
      resource: `shift:${shift.id}`,
      subjectUserId: shift.userId,
      siteId: shift.siteId,
      metadata: {
        userId: shift.userId,
        date: formatShiftDate(shift.date),
        shiftType: shift.type,
      },
    });

    await syncPrepaieForShift(shift.userId, companyId, shift.date);
  }
);

// ── PUT /api/planning/shifts/:id ────────────────────────────────
router.put('/shifts/:id',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    param('id').isString().notEmpty().withMessage('Identifiant de shift requis.'),
    body('userId').optional().isString().notEmpty(),
    body('siteId').optional().isString().notEmpty(),
    body('date').optional().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Date invalide (attendu : YYYY-MM-DD).'),
    body('type').optional().isIn(['MATIN', 'APREM', 'NUIT', 'JOURNEE', 'OFF', 'ABSENT']),
    body('startTime').optional({ nullable: true }).isString(),
    body('endTime').optional({ nullable: true }).isString(),
    body('breakStart').optional({ nullable: true }).isString(),
    body('breakEnd').optional({ nullable: true }).isString(),
    body('breakMin').optional({ nullable: true }).isInt({ min: 0, max: 480 }),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const existingCheck = await assertCanManageShift(req, req.params.id, companyId);
    if (!existingCheck.ok) {
      return res.status(existingCheck.status).json({ error: existingCheck.error });
    }
    const existing = existingCheck.shift;

    const data = {};
    const { userId, siteId, date, type, startTime, endTime, breakStart, breakEnd, breakMin } = req.body;

    if (userId !== undefined) {
      const userCheck = await assertCanManagePlanningUser(req, userId, companyId);
      if (!userCheck.ok) {
        return res.status(userCheck.status).json({ error: userCheck.error });
      }
      data.userId = userId;
    }

    if (siteId !== undefined) {
      const siteCheck = await assertCanAccessPlanningSite(req, siteId, companyId);
      if (!siteCheck.ok) {
        return res.status(siteCheck.status).json({ error: siteCheck.error });
      }
      data.siteId = siteId;
    }

    if (date !== undefined) {
      const parsedDate = parseDateParam(date);
      if (!parsedDate) {
        return res.status(400).json({ error: 'Date invalide (attendu : YYYY-MM-DD).' });
      }
      data.date = startOfDay(parsedDate);
    }

    if (type !== undefined) data.type = type;
    if (startTime !== undefined) data.startTime = startTime;
    if (endTime !== undefined) data.endTime = endTime;
    if (breakStart !== undefined) data.breakStart = breakStart;
    if (breakEnd !== undefined) data.breakEnd = breakEnd;
    if (breakMin !== undefined) data.breakMin = breakMin;

    const shift = await prisma.shift.update({
      where: { id: existing.id },
      data,
    });

    res.json(serializeShift(shift));

    await logAudit(req, {
      action: 'shift.update',
      resource: `shift:${shift.id}`,
      subjectUserId: shift.userId,
      siteId: shift.siteId,
      metadata: {
        userId: shift.userId,
        date: formatShiftDate(shift.date),
        shiftType: shift.type,
      },
    });

    await syncPrepaieForShift(shift.userId, companyId, shift.date);
    if (existing.userId !== shift.userId || formatShiftDate(existing.date) !== formatShiftDate(shift.date)) {
      await syncPrepaieForShift(existing.userId, companyId, existing.date);
    }
  }
);

// ── DELETE /api/planning/shifts/:id ─────────────────────────────
router.delete('/shifts/:id',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString().notEmpty().withMessage('Identifiant de shift requis.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const existingCheck = await assertCanManageShift(req, req.params.id, companyId);
    if (!existingCheck.ok) {
      return res.status(existingCheck.status).json({ error: existingCheck.error });
    }
    const existing = existingCheck.shift;

    await prisma.shift.delete({ where: { id: existing.id } });
    res.json({ message: 'Shift supprimé.' });

    await logAudit(req, {
      action: 'shift.delete',
      resource: `shift:${existing.id}`,
      subjectUserId: existing.userId,
      siteId: existing.siteId,
      metadata: {
        userId: existing.userId,
        date: formatShiftDate(existing.date),
        shiftType: existing.type,
      },
    });

    await syncPrepaieForShift(existing.userId, companyId, existing.date);
  }
);

// ── POST /api/planning/publish-week ─────────────────────────────
// Publie une semaine complète : remplace les shifts des collaborateurs concernés
// puis recalcule les variables pré-paie pour chaque mois touché.
router.post('/publish-week',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    body('from').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Date de début de semaine invalide (YYYY-MM-DD).'),
    body('userIds').isArray({ min: 1 }).withMessage('Au moins un collaborateur requis.'),
    body('userIds.*').isString().notEmpty(),
    body('shifts').isArray().withMessage('Liste de shifts requise.'),
    body('forceReplaceEmpty').optional().isBoolean().withMessage('forceReplaceEmpty doit être un booléen.'),
    body('shifts.*.userId').isString().notEmpty(),
    body('shifts.*.siteId').isString().notEmpty(),
    body('shifts.*.date').matches(/^\d{4}-\d{2}-\d{2}$/),
    body('shifts.*.type').isIn(['MATIN', 'APREM', 'NUIT', 'JOURNEE', 'OFF', 'ABSENT']),
    body('shifts.*.startTime').optional({ nullable: true }).isString(),
    body('shifts.*.endTime').optional({ nullable: true }).isString(),
    body('shifts.*.breakStart').optional({ nullable: true }).isString(),
    body('shifts.*.breakEnd').optional({ nullable: true }).isString(),
    body('shifts.*.breakMin').optional({ nullable: true }).isInt({ min: 0, max: 480 }),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const { from, userIds, shifts, forceReplaceEmpty } = req.body;

    const weekStart = parseDateParam(from);
    if (!weekStart) {
      return res.status(400).json({ error: 'Date de début de semaine invalide.' });
    }

    const rangeStart = startOfDay(weekStart);
    const rangeEnd = endOfDay(addDays(weekStart, 6));

    const usersCheck = await assertAllCanManagePlanningUsers(req, userIds, companyId);
    if (!usersCheck.ok) {
      return res.status(usersCheck.status).json({ error: usersCheck.error });
    }
    const uniqueUserIds = usersCheck.userIds;

    for (const shift of shifts) {
      const [userCheck, siteCheck] = await Promise.all([
        assertCanManagePlanningUser(req, shift.userId, companyId),
        assertCanAccessPlanningSite(req, shift.siteId, companyId),
      ]);
      if (!userCheck.ok) {
        return res.status(userCheck.status).json({ error: userCheck.error });
      }
      if (!siteCheck.ok) {
        return res.status(siteCheck.status).json({ error: siteCheck.error });
      }
      const parsedDate = parseDateParam(shift.date);
      if (!parsedDate || parsedDate < rangeStart || parsedDate > rangeEnd) {
        return res.status(400).json({ error: `Date hors semaine publiée : ${shift.date}.` });
      }
    }

    const workShifts = shifts.filter((s) => s.type !== 'OFF');
    if (!workShifts.length) {
      const existingWorkCount = await prisma.shift.count({
        where: {
          companyId,
          userId: { in: uniqueUserIds },
          date: { gte: rangeStart, lte: rangeEnd },
          type: { not: 'OFF' },
        },
      });
      if (existingWorkCount > 0 && forceReplaceEmpty !== true) {
        return res.status(409).json({
          error: 'Publication bloquée: aucun shift travaillé dans le payload. Cela effacerait la semaine et mettrait tout le monde en repos. Vérifiez le planning avant de republier.',
        });
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.shift.deleteMany({
        where: {
          companyId,
          userId: { in: uniqueUserIds },
          date: { gte: rangeStart, lte: rangeEnd },
        },
      });

      if (workShifts.length) {
        await tx.shift.createMany({
          data: workShifts.map((s) => ({
            userId: s.userId,
            siteId: s.siteId,
            companyId,
            date: startOfDay(parseDateParam(s.date)),
            type: s.type,
            startTime: s.startTime ?? null,
            endTime: s.endTime ?? null,
            breakStart: s.breakStart ?? null,
            breakEnd: s.breakEnd ?? null,
            breakMin: s.breakMin != null ? s.breakMin : null,
          })),
        });
      }
    });

    const weekPeriod = weekPeriodFromDate(weekStart);
    await syncCompanyPayVariables(companyId, weekPeriod);

    res.json({
      from,
      shiftsCount: workShifts.length,
      syncedPeriods: [weekPeriod],
      syncedUsers: uniqueUserIds.length,
      message: `Planning publié (${workShifts.length} shift(s)) · Pré-paie synchronisée.`,
    });

    const publishSiteId = shifts.find((s) => s.siteId)?.siteId || req.user.siteId || null;
    await logAudit(req, {
      action: 'planning.publish',
      resource: `week:${from}`,
      siteId: publishSiteId,
      metadata: {
        from,
        siteId: publishSiteId,
        shiftsCount: workShifts.length,
        forceReplaceEmpty: forceReplaceEmpty === true,
        syncedPeriods: [weekPeriod],
        userCount: uniqueUserIds.length,
      },
    });

    if (forceReplaceEmpty === true && workShifts.length === 0) {
      await logAudit(req, {
        action: 'planning.publish_force_empty',
        resource: `week:${from}`,
        siteId: publishSiteId,
        metadata: {
          from,
          siteId: publishSiteId,
          shiftsCount: 0,
          userCount: uniqueUserIds.length,
          reason: 'Explicit confirmation from UI to replace week with OFF only',
        },
      });
    }
  }
);

module.exports = router;
