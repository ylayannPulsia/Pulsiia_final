// src/routes/absences.js — Liste, stats, création, validation, calendrier
const router = require('express').Router();
const fs = require('fs');
const { body, query, param } = require('express-validator');
const {
  startOfDay,
  endOfDay,
  eachDayOfInterval,
  format,
  parseISO,
  isValid,
  startOfMonth,
  endOfMonth,
} = require('date-fns');
const { authenticate, authorize } = require('../middleware/auth');
const { MANAGER_ROLES, STATUS_APPROVERS } = require('../middleware/roles');
const {
  prisma,
  getCompanyId,
  withCompany,
  ensureUserInCompany,
  ensureSiteInCompany,
  ensureAbsenceInCompany,
} = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { logAudit } = require('../lib/audit');
const { upload, filePath } = require('../lib/uploads');
const { syncUserAbsenceVariables } = require('../lib/prepaie-engine');
const { syncAbsenceToPlanningShifts } = require('../lib/absence-planning-sync');

const ABSENCE_TYPES = [
  'CP', 'RTT', 'MALADIE', 'ACCIDENT_TRAVAIL', 'MATERNITE', 'PATERNITE', 'PARENTAL',
  'SANS_SOLDE', 'FORMATION', 'ENFANT_MALADE', 'DECES', 'MARIAGE', 'DEMENAGEMENT', 'AUTRE',
];
const ACTIVE_STATUSES = ['EN_ATTENTE', 'APPROUVE'];

const TYPE_LABELS = {
  CP: 'Congés payés',
  RTT: 'RTT',
  MALADIE: 'Maladie',
  ACCIDENT_TRAVAIL: 'Accident du travail',
  MATERNITE: 'Congé maternité',
  PATERNITE: 'Congé paternité',
  PARENTAL: 'Congé parental',
  SANS_SOLDE: 'Sans solde',
  FORMATION: 'Formation',
  ENFANT_MALADE: 'Enfant malade',
  DECES: 'Décès',
  MARIAGE: 'Mariage',
  DEMENAGEMENT: 'Déménagement',
  AUTRE: 'Autre',
};

const USER_INCLUDE = {
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      avatarColor: true,
      jobTitle: true,
      siteId: true,
      site: { select: { id: true, name: true } },
    },
  },
};

function parseDateParam(str) {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(`${str}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseMonthParam(str) {
  if (!str || !/^\d{4}-\d{2}$/.test(str)) return null;
  const d = parseISO(`${str}-01`);
  return isValid(d) ? d : null;
}

function formatDate(date) {
  return format(date, 'yyyy-MM-dd');
}

function countWorkingDays(startDate, endDate) {
  const start = startOfDay(startDate);
  const end = startOfDay(endDate);
  if (end < start) return 0;

  return eachDayOfInterval({ start, end }).filter((day) => {
    const dow = day.getDay();
    return dow !== 0 && dow !== 6;
  }).length;
}

function periodBounds(period) {
  const monthStart = parseMonthParam(period);
  if (!monthStart) return null;
  return {
    start: startOfDay(monthStart),
    end: endOfDay(endOfMonth(monthStart)),
  };
}

function overlapWhere(startDate, endDate) {
  return {
    startDate: { lte: endOfDay(endDate) },
    endDate: { gte: startOfDay(startDate) },
  };
}

function formatAbsence(absence, file) {
  const fileMeta = file || absence.file || null;
  return {
    id: absence.id,
    userId: absence.userId,
    type: absence.type,
    typeLabel: TYPE_LABELS[absence.type] || absence.type,
    startDate: formatDate(absence.startDate),
    endDate: formatDate(absence.endDate),
    days: absence.days,
    status: absence.status,
    reason: absence.reason,
    refuseReason: absence.refuseReason,
    approvedBy: absence.approvedBy,
    approvedAt: absence.approvedAt,
    fileId: absence.fileId,
    file: fileMeta
      ? {
          id: fileMeta.id,
          name: fileMeta.originalName,
          mimeType: fileMeta.mimeType,
          size: fileMeta.size,
        }
      : null,
    createdAt: absence.createdAt,
    updatedAt: absence.updatedAt,
    user: absence.user
      ? {
          id: absence.user.id,
          firstName: absence.user.firstName,
          lastName: absence.user.lastName,
          fullName: `${absence.user.firstName} ${absence.user.lastName}`,
          avatarColor: absence.user.avatarColor,
          jobTitle: absence.user.jobTitle,
          siteId: absence.user.siteId,
          siteName: absence.user.site?.name ?? null,
        }
      : undefined,
  };
}

function baseCompanyWhere(req) {
  const where = withCompany(getCompanyId(req));
  if (req.user.role === 'COLLABORATEUR') {
    where.userId = req.user.id;
  }
  return where;
}

function applyListFilters(where, queryParams, userRole) {
  const { status, userId, siteId, period, from, to } = queryParams;

  if (status) where.status = status;
  if (userId && userRole !== 'COLLABORATEUR') where.userId = userId;
  if (siteId && userRole !== 'COLLABORATEUR') {
    where.user = { ...(where.user || {}), siteId };
  }
  if (period) {
    const bounds = periodBounds(period);
    if (bounds) {
      where.AND = [...(where.AND || []), overlapWhere(bounds.start, bounds.end)];
    }
  }
  if (from || to) {
    const start = from ? parseDateParam(from) : null;
    const end = to ? parseDateParam(to) : null;
    if (start && end) {
      where.AND = [...(where.AND || []), overlapWhere(start, end)];
    } else if (start) {
      where.endDate = { gte: startOfDay(start) };
    } else if (end) {
      where.startDate = { lte: endOfDay(end) };
    }
  }

  return where;
}

async function findConflicts(userId, companyId, startDate, endDate, excludeId = null) {
  const where = withCompany(companyId, {
    userId,
    status: { in: ACTIVE_STATUSES },
    ...overlapWhere(startDate, endDate),
  });
  if (excludeId) where.id = { not: excludeId };

  return prisma.absence.findMany({
    where,
    select: {
      id: true,
      type: true,
      startDate: true,
      endDate: true,
      status: true,
    },
  });
}

async function isSubordinate(managerId, userId, companyId) {
  const subordinate = await prisma.user.findFirst({
    where: withCompany(companyId, { id: userId, managerId }),
    select: { id: true },
  });
  return Boolean(subordinate);
}

async function loadFilesByIds(fileIds) {
  const ids = [...new Set(fileIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const files = await prisma.uploadedFile.findMany({
    where: { id: { in: ids }, isDeleted: false },
  });
  return new Map(files.map((f) => [f.id, f]));
}

async function formatAbsencesWithFiles(rows) {
  const fileMap = await loadFilesByIds(rows.map((a) => a.fileId));
  const approverIds = [...new Set(rows.map((a) => a.approvedBy).filter(Boolean))];
  let approverMap = new Map();
  if (approverIds.length) {
    const approvers = await prisma.user.findMany({
      where: { id: { in: approverIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    approverMap = new Map(approvers.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  }
  return rows.map((a) => {
    const formatted = formatAbsence(a, a.fileId ? fileMap.get(a.fileId) : null);
    if (a.approvedBy && approverMap.has(a.approvedBy)) {
      formatted.approvedByName = approverMap.get(a.approvedBy);
    }
    return formatted;
  });
}

const LEAVE_ENTITLEMENTS = { CP: 25, RTT: 8 };

async function canAccessAbsence(req, absence) {
  const companyId = getCompanyId(req);
  if (absence.companyId !== companyId) return false;
  if (req.user.role === 'COLLABORATEUR') return absence.userId === req.user.id;
  if (['DRH', 'RH', 'ADMIN'].includes(req.user.role)) return true;
  if (req.user.role === 'MANAGER') {
    return isSubordinate(req.user.id, absence.userId, companyId);
  }
  return false;
}

// ── GET /api/absences/stats/summary ─────────────────────────────
router.get('/stats/summary',
  authenticate,
  [query('period').optional().matches(/^\d{4}-\d{2}$/).withMessage('Période invalide (attendu : YYYY-MM).')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const period = req.query.period || format(new Date(), 'yyyy-MM');
    const bounds = periodBounds(period);
    if (!bounds) {
      return res.status(400).json({ error: 'Paramètre period invalide (attendu : YYYY-MM).' });
    }

    const baseWhere = withCompany(companyId, overlapWhere(bounds.start, bounds.end));
    if (req.user.role === 'COLLABORATEUR') {
      baseWhere.userId = req.user.id;
    }

    const todayStart = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());

    const statsWhere = req.user.role === 'COLLABORATEUR'
      ? baseWhere
      : { ...baseWhere, userId: undefined };
    if (statsWhere.userId === undefined) delete statsWhere.userId;

    const [enAttente, approuve, refuse, enCours, typeGroups, headcount, absenceDaysSum] = await Promise.all([
      prisma.absence.count({ where: { ...baseWhere, status: 'EN_ATTENTE' } }),
      prisma.absence.count({ where: { ...baseWhere, status: 'APPROUVE' } }),
      prisma.absence.count({ where: { ...baseWhere, status: 'REFUSE' } }),
      prisma.absence.count({
        where: {
          ...baseWhere,
          status: 'APPROUVE',
          startDate: { lte: todayEnd },
          endDate: { gte: todayStart },
        },
      }),
      prisma.absence.groupBy({
        by: ['type'],
        where: { ...baseWhere, status: { not: 'ANNULE' } },
        _count: { type: true },
        orderBy: { _count: { type: 'desc' } },
        take: 5,
      }),
      prisma.user.count({ where: withCompany(companyId, { isActive: true }) }),
      prisma.absence.aggregate({
        where: { ...statsWhere, status: 'APPROUVE' },
        _sum: { days: true },
      }),
    ]);

    const workingDaysInMonth = countWorkingDays(bounds.start, bounds.end);
    const totalAbsenceDays = absenceDaysSum._sum.days || 0;
    const effectiveHeadcount = req.user.role === 'COLLABORATEUR' ? 1 : headcount;
    const absenteeismRate = effectiveHeadcount > 0 && workingDaysInMonth > 0
      ? Math.round((totalAbsenceDays / (effectiveHeadcount * workingDaysInMonth)) * 1000) / 10
      : 0;

    res.json({
      period,
      kanban: { enAttente, approuve, refuse, enCours },
      absenteeismRate,
      headcount,
      topTypes: typeGroups.map((row) => ({
        type: row.type,
        label: TYPE_LABELS[row.type] || row.type,
        count: row._count.type,
      })),
    });
  }
);

// ── GET /api/absences/balance?userId=&year= ─────────────────────
router.get('/balance',
  authenticate,
  [
    query('userId').optional().isString(),
    query('year').optional().matches(/^\d{4}$/).withMessage('Année invalide (attendu : YYYY).'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    let targetUserId = req.query.userId || req.user.id;

    if (req.user.role === 'COLLABORATEUR') {
      if (req.query.userId && req.query.userId !== req.user.id) {
        return res.status(403).json({ error: 'Accès refusé.' });
      }
      targetUserId = req.user.id;
    } else if (req.query.userId) {
      const targetUser = await ensureUserInCompany(targetUserId, companyId);
      if (!targetUser) {
        return res.status(404).json({ error: 'Utilisateur introuvable.' });
      }
    }

    const year = parseInt(req.query.year || format(new Date(), 'yyyy'), 10);
    const yearStart = new Date(`${year}-01-01T00:00:00`);
    const yearEnd = new Date(`${year}-12-31T23:59:59`);

    const rows = await prisma.absence.findMany({
      where: withCompany(companyId, {
        userId: targetUserId,
        type: { in: ['CP', 'RTT'] },
        status: { in: ['EN_ATTENTE', 'APPROUVE'] },
        ...overlapWhere(yearStart, yearEnd),
      }),
      select: { type: true, days: true, status: true },
    });

    const used = { CP: 0, RTT: 0 };
    const pending = { CP: 0, RTT: 0 };
    for (const row of rows) {
      used[row.type] += row.days;
      if (row.status === 'EN_ATTENTE') pending[row.type] += row.days;
    }

    const buildBalance = (type) => {
      const total = LEAVE_ENTITLEMENTS[type];
      const taken = used[type] || 0;
      return {
        total,
        used: Math.round(taken * 10) / 10,
        pending: Math.round((pending[type] || 0) * 10) / 10,
        remaining: Math.round((total - taken) * 10) / 10,
      };
    };

    res.json({
      year,
      userId: targetUserId,
      cp: buildBalance('CP'),
      rtt: buildBalance('RTT'),
    });
  }
);

// ── GET /api/absences/calendar?month=YYYY-MM ────────────────────
router.get('/calendar',
  authenticate,
  [
    query('month').matches(/^\d{4}-\d{2}$/).withMessage('Paramètre month invalide (attendu : YYYY-MM).'),
    query('siteId').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const month = parseMonthParam(req.query.month);
    if (!month) {
      return res.status(400).json({ error: 'Paramètre month invalide (attendu : YYYY-MM).' });
    }

    const rangeStart = startOfMonth(month);
    const rangeEnd = endOfMonth(month);
    const companyId = getCompanyId(req);
    const { siteId } = req.query;

    const where = withCompany(companyId, {
      status: { in: ['EN_ATTENTE', 'APPROUVE'] },
      ...overlapWhere(rangeStart, rangeEnd),
    });
    if (req.user.role === 'COLLABORATEUR') {
      where.userId = req.user.id;
    }
    if (siteId) {
      const site = await ensureSiteInCompany(siteId, companyId);
      if (!site) {
        return res.status(404).json({ error: 'Site introuvable.' });
      }
      where.user = { siteId };
    }

    const absences = await prisma.absence.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatarColor: true,
            siteId: true,
            site: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ startDate: 'asc' }, { user: { lastName: 'asc' } }],
    });

    const days = {};
    for (const absence of absences) {
      const intervalStart = absence.startDate > rangeStart ? absence.startDate : rangeStart;
      const intervalEnd = absence.endDate < rangeEnd ? absence.endDate : rangeEnd;
      for (const day of eachDayOfInterval({ start: startOfDay(intervalStart), end: startOfDay(intervalEnd) })) {
        const key = formatDate(day);
        if (!days[key]) days[key] = [];
        days[key].push({
          id: absence.id,
          userId: absence.userId,
          firstName: absence.user.firstName,
          lastName: absence.user.lastName,
          avatarColor: absence.user.avatarColor,
          siteId: absence.user.siteId,
          siteName: absence.user.site?.name ?? null,
          type: absence.type,
          typeLabel: TYPE_LABELS[absence.type] || absence.type,
          status: absence.status,
          startDate: formatDate(absence.startDate),
          endDate: formatDate(absence.endDate),
        });
      }
    }

    res.json({ month: format(month, 'yyyy-MM'), days });
  }
);

// ── GET /api/absences ─────────────────────────────────────────
router.get('/',
  authenticate,
  [
    query('status').optional().isIn(['EN_ATTENTE', 'APPROUVE', 'REFUSE', 'ANNULE']).withMessage('Statut invalide.'),
    query('userId').optional().isString(),
    query('siteId').optional().isString(),
    query('period').optional().matches(/^\d{4}-\d{2}$/).withMessage('Période invalide (attendu : YYYY-MM).'),
    query('from').optional().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Date from invalide.'),
    query('to').optional().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Date to invalide.'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const where = applyListFilters(baseCompanyWhere(req), req.query, req.user.role);

    const absences = await prisma.absence.findMany({
      where,
      include: USER_INCLUDE,
      orderBy: [{ createdAt: 'desc' }],
    });

    res.json({ absences: await formatAbsencesWithFiles(absences) });
  }
);

// ── POST /api/absences ──────────────────────────────────────────
router.post('/',
  authenticate,
  [
    body('type').isIn(ABSENCE_TYPES).withMessage('Type d\'absence invalide.'),
    body('startDate').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Date de début invalide.'),
    body('endDate').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Date de fin invalide.'),
    body('userId').optional().isString(),
    body('reason').optional({ nullable: true }).isString(),
    body('fileId').optional({ nullable: true }).isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const startDate = parseDateParam(req.body.startDate);
    const endDate = parseDateParam(req.body.endDate);

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Dates invalides (attendu : YYYY-MM-DD).' });
    }
    if (endDate < startDate) {
      return res.status(400).json({ error: 'La date de fin doit être postérieure ou égale à la date de début.' });
    }

    let targetUserId = req.body.userId || req.user.id;

    if (req.user.role === 'COLLABORATEUR') {
      if (req.body.userId && req.body.userId !== req.user.id) {
        return res.status(403).json({ error: 'Vous ne pouvez créer une absence que pour vous-même.' });
      }
      targetUserId = req.user.id;
    } else if (req.body.userId) {
      const targetUser = await ensureUserInCompany(targetUserId, companyId);
      if (!targetUser) {
        return res.status(404).json({ error: 'Utilisateur introuvable dans votre entreprise.' });
      }
    } else {
      targetUserId = req.user.id;
    }

    const conflicts = await findConflicts(targetUserId, companyId, startDate, endDate);
    if (conflicts.length > 0) {
      return res.status(409).json({
        error: 'Chevauchement avec une autre absence sur cette période.',
        conflicts: conflicts.map((c) => ({
          id: c.id,
          type: c.type,
          startDate: formatDate(c.startDate),
          endDate: formatDate(c.endDate),
          status: c.status,
        })),
      });
    }

    const days = countWorkingDays(startDate, endDate);
    const autoApprove =
      ['RH', 'DRH'].includes(req.user.role) && targetUserId === req.user.id;

    const absence = await prisma.absence.create({
      data: {
        userId: targetUserId,
        companyId,
        type: req.body.type,
        startDate: startOfDay(startDate),
        endDate: startOfDay(endDate),
        days,
        reason: req.body.reason ?? null,
        fileId: req.body.fileId ?? null,
        status: autoApprove ? 'APPROUVE' : 'EN_ATTENTE',
        approvedBy: autoApprove ? req.user.id : null,
        approvedAt: autoApprove ? new Date() : null,
      },
      include: USER_INCLUDE,
    });

    res.status(201).json(formatAbsence(absence, absence.fileId ? await prisma.uploadedFile.findUnique({ where: { id: absence.fileId } }) : null));

    if (autoApprove) {
      try {
        await syncAbsenceToPlanningShifts(absence);
      } catch (err) {
        console.error('[absence-planning-sync]', err.message);
      }
    }

    const formatted = formatAbsence(absence);
    await logAudit(req, {
      action: 'absence.create',
      resource: `absence:${absence.id}`,
      subjectUserId: absence.userId,
      metadata: {
        collab: formatted.user?.fullName || 'Collaborateur',
        absenceType: formatted.typeLabel,
        startDate: formatted.startDate,
        endDate: formatted.endDate,
      },
    });
  }
);

// ── GET /api/absences/:id/file ──────────────────────────────────
router.get('/:id/file',
  authenticate,
  [param('id').isString().notEmpty().withMessage('Identifiant d\'absence requis.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const absence = await ensureAbsenceInCompany(req.params.id, companyId);
    if (!absence) {
      return res.status(404).json({ error: 'Absence introuvable.' });
    }
    if (!(await canAccessAbsence(req, absence))) {
      return res.status(403).json({ error: 'Accès refusé à cette pièce jointe.' });
    }
    if (!absence.fileId) {
      return res.status(404).json({ error: 'Aucune pièce jointe pour cette absence.' });
    }

    const file = await prisma.uploadedFile.findFirst({
      where: { id: absence.fileId, companyId, isDeleted: false },
    });
    if (!file) {
      return res.status(404).json({ error: 'Fichier introuvable.' });
    }

    const diskPath = filePath(file.storedName);
    if (!fs.existsSync(diskPath)) {
      return res.status(404).json({ error: 'Fichier introuvable sur le serveur.' });
    }

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(file.originalName)}"`,
    );
    fs.createReadStream(diskPath).pipe(res);
  },
);

// ── POST /api/absences/:id/file ─────────────────────────────────
router.post('/:id/file',
  authenticate,
  [param('id').isString().notEmpty().withMessage('Identifiant d\'absence requis.')],
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Erreur lors de l\'upload.' });
      }
      next();
    });
  },
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    if (!req.file) {
      return res.status(400).json({ error: 'Fichier requis (PDF, JPG, PNG ou WEBP — max 10 Mo).' });
    }

    const companyId = getCompanyId(req);
    const absence = await ensureAbsenceInCompany(req.params.id, companyId, USER_INCLUDE);
    if (!absence) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Absence introuvable.' });
    }
    if (!(await canAccessAbsence(req, absence))) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Vous ne pouvez pas joindre de fichier à cette absence.' });
    }

    if (absence.fileId) {
      await prisma.uploadedFile.updateMany({
        where: { id: absence.fileId, companyId },
        data: { isDeleted: true, deletedAt: new Date() },
      });
    }

    const uploaded = await prisma.uploadedFile.create({
      data: {
        userId: absence.userId,
        companyId,
        originalName: req.file.originalname,
        storedName: req.file.filename,
        mimeType: req.file.mimetype,
        size: req.file.size,
        purpose: 'justificatif_absence',
        relatedId: absence.id,
        relatedType: absence.type,
      },
    });

    const updated = await prisma.absence.update({
      where: { id: absence.id },
      data: { fileId: uploaded.id },
      include: USER_INCLUDE,
    });

    res.status(201).json(formatAbsence(updated, uploaded));
  },
);

// ── PUT /api/absences/:id/status ────────────────────────────────
router.put('/:id/status',
  authenticate,
  authorize(...STATUS_APPROVERS),
  [
    param('id').isString().notEmpty().withMessage('Identifiant d\'absence requis.'),
    body('status').isIn(['APPROUVE', 'REFUSE']).withMessage('Statut invalide (APPROUVE ou REFUSE).'),
    body('refuseReason').optional({ nullable: true }).isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { status, refuseReason } = req.body;
    if (status === 'REFUSE' && !refuseReason?.trim()) {
      return res.status(400).json({ error: 'Le motif de refus est obligatoire.' });
    }

    const companyId = getCompanyId(req);
    const absence = await ensureAbsenceInCompany(req.params.id, companyId, USER_INCLUDE);
    if (!absence) {
      return res.status(404).json({ error: 'Absence introuvable.' });
    }
    if (absence.status !== 'EN_ATTENTE' && status === 'APPROUVE') {
      return res.status(400).json({ error: 'Seules les demandes en attente peuvent être validées.' });
    }
    if (status === 'REFUSE' && !['EN_ATTENTE', 'APPROUVE'].includes(absence.status)) {
      return res.status(400).json({ error: 'Cette absence ne peut plus être refusée ou annulée.' });
    }

    if (req.user.role === 'MANAGER') {
      const allowed = await isSubordinate(req.user.id, absence.userId, companyId);
      if (!allowed) {
        return res.status(403).json({ error: 'Vous ne pouvez valider que les absences de vos subordonnés.' });
      }
    }

    const updated = await prisma.absence.update({
      where: { id: absence.id },
      data: {
        status,
        refuseReason: status === 'REFUSE' ? refuseReason.trim() : null,
        approvedBy: req.user.id,
        approvedAt: new Date(),
      },
      include: USER_INCLUDE,
    });

    const file = updated.fileId
      ? await prisma.uploadedFile.findFirst({ where: { id: updated.fileId, isDeleted: false } })
      : null;

    res.json(formatAbsence(updated, file));

    const formatted = formatAbsence(updated);
    const action = status === 'APPROUVE'
      ? 'absence.approve'
      : (absence.status === 'APPROUVE' ? 'absence.cancel' : 'absence.refuse');
    await logAudit(req, {
      action,
      resource: `absence:${updated.id}`,
      subjectUserId: updated.userId,
      metadata: {
        collab: formatted.user?.fullName || 'Collaborateur',
        absenceType: formatted.typeLabel,
        reason: status === 'REFUSE' ? refuseReason?.trim() : undefined,
      },
    });

    if (status === 'APPROUVE') {
      try {
        await syncAbsenceToPlanningShifts(updated);
      } catch (err) {
        console.error('[absence-planning-sync]', err.message);
      }
      try {
        const periods = new Set();
        let cursor = startOfMonth(updated.startDate);
        const endM = startOfMonth(updated.endDate);
        while (cursor <= endM) {
          periods.add(format(cursor, 'yyyy-MM'));
          cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
        }
        for (const p of periods) {
          await syncUserAbsenceVariables(updated.userId, companyId, p);
        }
      } catch (err) {
        console.error('[prepaie-absence-sync]', err.message);
      }
    }
  }
);

// ── DELETE /api/absences/:id (soft → ANNULE) ────────────────────
router.delete('/:id',
  authenticate,
  [param('id').isString().notEmpty().withMessage('Identifiant d\'absence requis.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const absence = await ensureAbsenceInCompany(req.params.id, companyId, USER_INCLUDE);
    if (!absence) {
      return res.status(404).json({ error: 'Absence introuvable.' });
    }
    if (absence.status === 'ANNULE') {
      return res.status(400).json({ error: 'Cette absence est déjà annulée.' });
    }

    if (req.user.role === 'COLLABORATEUR') {
      if (absence.userId !== req.user.id) {
        return res.status(403).json({ error: 'Vous ne pouvez annuler que vos propres demandes.' });
      }
      if (absence.status !== 'EN_ATTENTE') {
        return res.status(403).json({ error: 'Vous ne pouvez annuler que les demandes en attente.' });
      }
    }

    const updated = await prisma.absence.update({
      where: { id: absence.id },
      data: { status: 'ANNULE' },
      include: USER_INCLUDE,
    });

    res.json({ message: 'Demande annulée.', absence: formatAbsence(updated) });

    const formatted = formatAbsence(updated);
    await logAudit(req, {
      action: 'absence.cancel',
      resource: `absence:${updated.id}`,
      subjectUserId: updated.userId,
      metadata: {
        collab: formatted.user?.fullName || 'Collaborateur',
        absenceType: formatted.typeLabel,
      },
    });
  }
);

module.exports = router;
