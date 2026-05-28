// src/routes/prepaie.js — Variables de paie, validation, exports Silae/Sage/ADP
const router = require('express').Router();
const { body, query, param } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { MANAGER_ROLES, BATCH_VALIDATE_ROLES, RH_PAY_ROLES } = require('../middleware/roles');
const {
  prisma,
  getCompanyId,
  withCompany,
  ensureUserInCompany,
  ensurePayVariableInCompany,
} = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { logAudit } = require('../lib/audit');
const { HS_TYPES, detectAnomalies, syncCompanyPayVariables, isPeriodLocked, getPeriodMeta, estimateHsEurosFromRows, prevPeriod } = require('../lib/prepaie-engine');
const {
  WEEK_PERIOD_REGEX,
  MONTH_PERIOD_REGEX,
  currentPeriod,
  periodBoundsStrings,
  periodLabel,
  weekPeriodsOverlappingMonth,
} = require('../lib/period-utils');
const {
  buildPrepaieVariablesWhere,
  assertPayVariableInScope,
  stripPrepaieSummaryForManager,
  isManagerRole,
  hasFullPlanningAccess,
} = require('../lib/planning-scope');
const HOURLY_RATE = parseFloat(process.env.PREPAIE_HOURLY_RATE || '15', 10);

const PAY_VARIABLE_TYPES = [
  'HEURE_NORMALE', 'HEURE_SUP_125', 'HEURE_SUP_150', 'MAJORATION_NUIT',
  'MAJORATION_DIMANCHE', 'MAJORATION_FERIE', 'ABSENCE_MALADIE', 'CONGES_PAYES',
  'PRIME_ANCIENNETE', 'PRIME_PERFORMANCE', 'PRIME_PANIER', 'REMBOURSEMENT_TRANSPORT',
  'AVANTAGE_NATURE', 'AUTRE',
];

const STATUS_DB = {
  'à valider': 'A_VALIDER', a_valider: 'A_VALIDER', pending: 'A_VALIDER',
  validé: 'VALIDE', valide: 'VALIDE', validated: 'VALIDE',
  rejeté: 'REJETE', rejete: 'REJETE', rejected: 'REJETE',
  anomalie: 'ANOMALIE', 'anomalie ia': 'ANOMALIE',
};

const TYPE_LABELS = {
  HEURE_NORMALE: 'Heure normale',
  HEURE_SUP_125: 'Heures supp. ×1.25',
  HEURE_SUP_150: 'Heures supp. ×1.50',
  MAJORATION_NUIT: 'Majoration nuit ×1.20',
  MAJORATION_DIMANCHE: 'Majoration dimanche',
  MAJORATION_FERIE: 'Majoration férié',
  ABSENCE_MALADIE: 'Absence maladie',
  CONGES_PAYES: 'Congés payés',
  PRIME_ANCIENNETE: 'Prime ancienneté',
  PRIME_PERFORMANCE: 'Prime performance',
  PRIME_PANIER: 'Prime panier',
  REMBOURSEMENT_TRANSPORT: 'Remboursement transport',
  AVANTAGE_NATURE: 'Avantage en nature',
  AUTRE: 'Autre',
};

const SILAE_RUBRIQUE = {
  HEURE_NORMALE: 'HN',
  HEURE_SUP_125: 'HS125',
  HEURE_SUP_150: 'HS150',
  MAJORATION_NUIT: 'NUIT',
  MAJORATION_DIMANCHE: 'DIM',
  MAJORATION_FERIE: 'FER',
  ABSENCE_MALADIE: 'MAL',
  CONGES_PAYES: 'CP',
  PRIME_ANCIENNETE: 'PRIME_ANC',
  PRIME_PERFORMANCE: 'PRIME_PERF',
  PRIME_PANIER: 'PRIME_PAN',
  REMBOURSEMENT_TRANSPORT: 'TRANS',
  AVANTAGE_NATURE: 'AVN',
  AUTRE: 'AUTRE',
};

const USER_INCLUDE = {
  user: {
    select: {
      id: true,
      firstName: true,
            lastName: true,
            siteId: true,
            hourlyRate: true,
            site: { select: { id: true, name: true } },
    },
  },
};

const PERIOD_MSG = 'Période invalide (attendu : YYYY-MM-DD lundi de semaine).';
const MONTH_MSG = 'Mois invalide (attendu : YYYY-MM).';

function parseStatusFilter(raw) {
  if (!raw) return undefined;
  const key = String(raw).trim().toLowerCase();
  if (STATUS_DB[key]) return STATUS_DB[key];
  if (PAY_VARIABLE_TYPES.includes(raw) || ['A_VALIDER', 'VALIDE', 'REJETE', 'ANOMALIE'].includes(raw)) {
    return raw;
  }
  return undefined;
}

function formatValueDisplay(value, unit) {
  const sign = value >= 0 ? '+' : '−';
  const abs = Math.abs(value);
  if (unit === 'h') {
    const h = Math.floor(abs);
    const min = Math.round((abs - h) * 60);
    return min ? `${sign}${h}h${String(min).padStart(2, '0')}` : `${sign}${h}h00`;
  }
  if (unit === 'jours') return `${sign}${abs} jour${abs > 1 ? 's' : ''}`;
  if (unit === '€') return `${sign}${abs}€`;
  return `${sign}${abs}${unit}`;
}

function statusLabel(status) {
  const map = {
    A_VALIDER: 'À valider',
    VALIDE: 'Validé',
    REJETE: 'Rejeté',
    ANOMALIE: 'Anomalie IA',
  };
  return map[status] || status;
}

function sourceLabel(source) {
  const map = {
    planning_auto: 'Planning auto',
    absence_auto: 'Absences validées',
    manuel: 'Manuel',
    import: 'Import',
  };
  return map[source] || source;
}

function buildTraceability(v) {
  if (v.source === 'planning_auto') {
    return { kind: 'planning', userId: v.userId, period: v.period };
  }
  if (v.source === 'absence_auto') {
    return { kind: 'absence', userId: v.userId, period: v.period };
  }
  return null;
}

async function rejectIfPeriodLocked(companyId, period) {
  if (await isPeriodLocked(companyId, period)) {
    const err = new Error('PERIOD_LOCKED');
    err.status = 423;
    err.message = 'Période clôturée — déverrouillez-la pour modifier les variables.';
    throw err;
  }
}

function matriculeForUser(user) {
  return (user.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toUpperCase() || 'NA';
}

function extractRejectReason(notes) {
  if (!notes) return null;
  const match = notes.match(/^Rejet:\s*(.+)$/s);
  return match ? match[1].trim() : null;
}

function extractAnomalyMessage(notes, status) {
  if (status !== 'ANOMALIE') return null;
  if (!notes) return null;
  if (notes.startsWith('Rejet:')) return null;
  return notes.startsWith('Anomalie:') ? notes.replace(/^Anomalie:\s*/, '') : notes;
}

function serializeVariable(v) {
  const collab = `${v.user.firstName} ${v.user.lastName.charAt(0)}.`;
  const rejectReason = v.status === 'REJETE' ? extractRejectReason(v.notes) : null;
  const anomaly = extractAnomalyMessage(v.notes, v.status);

  return {
    id: v.id,
    userId: v.userId,
    collab,
    site: v.user.site?.name || '—',
    siteId: v.user.siteId,
    type: TYPE_LABELS[v.type] || v.type,
    typeCode: v.type,
    value: formatValueDisplay(v.value, v.unit),
    valueRaw: v.value,
    unit: v.unit,
    source: sourceLabel(v.source),
    sourceCode: v.source,
    status: statusLabel(v.status),
    statusCode: v.status,
    period: v.period,
    notes: v.notes,
    anomaly,
    rejectReason,
    validatedBy: v.validatedBy,
    validatedAt: v.validatedAt,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    traceability: buildTraceability(v),
  };
}

function estimateHsEuros(variables, usersById) {
  if (usersById) {
    return estimateHsEurosFromRows(variables, usersById);
  }
  let total = 0;
  for (const v of variables) {
    if (v.unit !== 'h' || !HS_TYPES.includes(v.type)) continue;
    const hours = Math.max(0, v.value);
    if (v.type === 'HEURE_SUP_125') total += hours * HOURLY_RATE * 1.25;
    if (v.type === 'HEURE_SUP_150') total += hours * HOURLY_RATE * 1.5;
  }
  return Math.round(total * 100) / 100;
}

function buildWhere(req, companyId, { period, status, siteId, siteName, userId }) {
  const extra = {};
  if (period) extra.period = period;
  const statusDb = parseStatusFilter(status);
  if (statusDb && ['A_VALIDER', 'VALIDE', 'REJETE', 'ANOMALIE'].includes(statusDb)) {
    extra.status = statusDb;
  }

  const where = buildPrepaieVariablesWhere(req, companyId, extra);

  if (userId) {
    where.userId = userId;
  }

  if (hasFullPlanningAccess(req.user.role)) {
    if (siteId) {
      where.user = { ...(where.user || {}), siteId };
    } else if (siteName) {
      where.user = { ...(where.user || {}), site: { name: siteName } };
    }
  }

  return where;
}

// ── GET /api/prepaie/variables ──────────────────────────────────
router.get('/variables',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    query('period').optional().matches(WEEK_PERIOD_REGEX).withMessage(PERIOD_MSG),
    query('status').optional().isString(),
    query('site').optional().isString(),
    query('siteId').optional().isString(),
    query('user').optional().isString(),
    query('userId').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const period = req.query.period || currentPeriod();
    const siteParam = req.query.site || req.query.siteId;
    const userId = req.query.user || req.query.userId;
    const siteIsId = siteParam && siteParam.length > 12 && !siteParam.includes(' ');

    const variables = await prisma.payVariable.findMany({
      where: buildWhere(req, companyId, {
        period,
        status: req.query.status,
        siteId: siteIsId ? siteParam : undefined,
        siteName: siteParam && !siteIsId ? siteParam : undefined,
        userId,
      }),
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            siteId: true,
            site: { select: { name: true } },
          },
        },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });

    res.json({
      period,
      total: variables.length,
      variables: variables.map(serializeVariable),
      ...(isManagerRole(req.user.role) ? { managerScope: true } : {}),
    });
  }
);

// ── GET /api/prepaie/summary ─────────────────────────────────────
router.get('/summary',
  authenticate,
  authorize(...MANAGER_ROLES),
  [query('period').optional().matches(WEEK_PERIOD_REGEX).withMessage(PERIOD_MSG)],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const period = req.query.period || currentPeriod();
    const baseWhere = buildPrepaieVariablesWhere(req, companyId, { period });

    const [grouped, hsVariables, periodMeta, prevHsVariables, usersWithRate] = await Promise.all([
      prisma.payVariable.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.payVariable.findMany({
        where: { ...baseWhere, type: { in: HS_TYPES }, unit: 'h' },
        select: { type: true, value: true, unit: true, status: true, userId: true },
      }),
      getPeriodMeta(companyId, period),
      prisma.payVariable.findMany({
        where: buildPrepaieVariablesWhere(req, companyId, {
          period: prevPeriod(period),
          type: { in: HS_TYPES },
          unit: 'h',
        }),
        select: { value: true },
      }),
      hasFullPlanningAccess(req.user.role)
        ? prisma.user.findMany({
          where: withCompany(companyId, { isActive: true }),
          select: { id: true, hourlyRate: true },
        })
        : Promise.resolve([]),
    ]);

    const usersById = new Map(usersWithRate.map((u) => [u.id, u]));
    const counts = { A_VALIDER: 0, VALIDE: 0, REJETE: 0, ANOMALIE: 0 };
    for (const row of grouped) {
      counts[row.status] = row._count._all;
    }

    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    const validatedHs = hsVariables.filter((v) => v.status === 'VALIDE');
    const currHsTotal = hsVariables.reduce((s, v) => s + Math.max(0, v.value), 0);
    const prevHsTotal = prevHsVariables.reduce((s, v) => s + Math.max(0, v.value), 0);
    const hsMomDelta = Math.round((currHsTotal - prevHsTotal) * 100) / 100;
    const hsMomPct = prevHsTotal > 0 ? Math.round(((currHsTotal - prevHsTotal) / prevHsTotal) * 100) : null;

    res.json(stripPrepaieSummaryForManager(req, {
      period,
      pending: counts.A_VALIDER,
      validated: counts.VALIDE,
      rejected: counts.REJETE,
      anomalies: counts.ANOMALIE,
      total,
      estimatedOvertimeEuros: estimateHsEuros(hsVariables, usersById),
      estimatedOvertimeEurosValidated: estimateHsEuros(validatedHs, usersById),
      hourlyRateUsed: HOURLY_RATE,
      usesPerCollabRates: usersWithRate.some((u) => u.hourlyRate != null && u.hourlyRate > 0),
      lastSyncAt: periodMeta?.lastSyncAt || null,
      locked: Boolean(periodMeta?.lockedAt),
      lockedAt: periodMeta?.lockedAt || null,
      mom: {
        previousPeriod: prevPeriod(period),
        hsHoursDelta: hsMomDelta,
        hsHoursChangePct: hsMomPct,
        alert: hsMomPct != null && Math.abs(hsMomPct) >= 30
          ? `Heures supp. ${hsMomPct > 0 ? '+' : ''}${hsMomPct} % vs ${periodLabel(prevPeriod(period))}`
          : null,
      },
    }));
  }
);

// ── POST /api/prepaie/variables ─────────────────────────────────
router.post('/variables',
  authenticate,
  authorize(...RH_PAY_ROLES),
  [
    body('userId').isString().notEmpty().withMessage('Collaborateur requis.'),
    body('period').optional().matches(WEEK_PERIOD_REGEX).withMessage(PERIOD_MSG),
    body('type').isIn(PAY_VARIABLE_TYPES).withMessage('Type de variable invalide.'),
    body('value').isFloat().withMessage('Valeur numérique requise.'),
    body('unit').optional().isIn(['h', '€', 'jours']).withMessage('Unité invalide.'),
    body('notes').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const { userId, type, value, notes } = req.body;
    const period = req.body.period || currentPeriod();
    const unit = req.body.unit || (type.startsWith('PRIME') || type.includes('REMBOURSEMENT') || type === 'AVANTAGE_NATURE' ? '€' : type === 'CONGES_PAYES' ? 'jours' : 'h');

    try {
      await rejectIfPeriodLocked(companyId, period);
    } catch (e) {
      return res.status(e.status || 423).json({ error: e.message });
    }

    const user = await ensureUserInCompany(userId, companyId);
    if (!user) {
      return res.status(404).json({ error: 'Collaborateur introuvable.' });
    }

    const { isAnomaly, notes: anomalyNotes } = await detectAnomalies({
      userId,
      companyId,
      period,
      type,
      value,
    });

    const variable = await prisma.payVariable.create({
      data: {
        userId,
        companyId,
        period,
        type,
        value,
        unit,
        source: 'manuel',
        status: isAnomaly ? 'ANOMALIE' : 'A_VALIDER',
        notes: anomalyNotes || notes || null,
      },
      include: USER_INCLUDE,
    });

    res.status(201).json({
      variable: serializeVariable(variable),
      anomalyDetected: isAnomaly,
    });

    await logAudit(req, {
      action: 'pay_variable.create',
      resource: `pay_variable:${variable.id}`,
      subjectUserId: variable.userId,
      metadata: {
        collab: `${user.firstName} ${user.lastName.charAt(0)}.`,
        type: TYPE_LABELS[type] || type,
        period,
        value,
      },
    });
  }
);

// ── PUT /api/prepaie/variables/:id ──────────────────────────────
router.put('/variables/:id',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    param('id').isString().notEmpty().withMessage('Identifiant de variable requis.'),
    body('value').isFloat().withMessage('Valeur numérique requise.'),
    body('type').optional().isIn(PAY_VARIABLE_TYPES),
    body('notes').optional({ nullable: true }).isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const existing = await ensurePayVariableInCompany(req.params.id, companyId, USER_INCLUDE);
    if (!existing) {
      return res.status(404).json({ error: 'Variable introuvable.' });
    }
    const scopeCheck = await assertPayVariableInScope(req, existing, companyId);
    if (!scopeCheck.ok) {
      return res.status(scopeCheck.status).json({ error: scopeCheck.error });
    }
    if (!['A_VALIDER', 'ANOMALIE'].includes(existing.status)) {
      return res.status(400).json({ error: 'Seules les variables à valider ou en anomalie peuvent être modifiées.' });
    }

    try {
      await rejectIfPeriodLocked(companyId, existing.period);
    } catch (e) {
      return res.status(e.status || 423).json({ error: e.message });
    }

    const type = req.body.type || existing.type;
    const value = req.body.value;
    const { isAnomaly, notes: anomalyNotes } = await detectAnomalies({
      userId: existing.userId,
      companyId,
      period: existing.period,
      type,
      value,
      excludeId: existing.id,
    });

    const variable = await prisma.payVariable.update({
      where: { id: existing.id },
      data: {
        type,
        value,
        status: isAnomaly ? 'ANOMALIE' : 'A_VALIDER',
        notes: isAnomaly ? anomalyNotes : (req.body.notes ?? null),
      },
      include: USER_INCLUDE,
    });

    res.json({ variable: serializeVariable(variable) });

    await logAudit(req, {
      action: 'pay_variable.update',
      resource: `pay_variable:${variable.id}`,
      subjectUserId: variable.userId,
      metadata: {
        collab: serializeVariable(variable).collab,
        type: serializeVariable(variable).type,
        period: variable.period,
        value,
      },
    });
  }
);

// ── POST /api/prepaie/sync ──────────────────────────────────────
router.post('/sync',
  authenticate,
  authorize(...RH_PAY_ROLES),
  [
    body('period').optional().matches(WEEK_PERIOD_REGEX).withMessage(PERIOD_MSG),
    query('period').optional().matches(WEEK_PERIOD_REGEX).withMessage(PERIOD_MSG),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const period = req.body.period || req.query.period || currentPeriod();

    try {
      await rejectIfPeriodLocked(companyId, period);
    } catch (e) {
      return res.status(e.status || 423).json({ error: e.message });
    }

    const result = await syncCompanyPayVariables(companyId, period);

    res.json({
      ...result,
      lastSyncAt: new Date().toISOString(),
      message: `Synchronisation planning + absences → pré-paie (${result.syncedUsers} collaborateur(s)).`,
    });

    await logAudit(req, {
      action: 'pay_variable.sync',
      resource: `period:${period}`,
      metadata: { period, count: result.syncedUsers },
    });
  }
);

// ── PUT /api/prepaie/variables/:id/validate ─────────────────────
router.put('/variables/:id/validate',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString().notEmpty().withMessage('Identifiant de variable requis.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const existing = await ensurePayVariableInCompany(req.params.id, companyId, USER_INCLUDE);
    if (!existing) {
      return res.status(404).json({ error: 'Variable introuvable.' });
    }
    const scopeCheck = await assertPayVariableInScope(req, existing, companyId);
    if (!scopeCheck.ok) {
      return res.status(scopeCheck.status).json({ error: scopeCheck.error });
    }
    if (existing.status === 'VALIDE') {
      return res.status(400).json({ error: 'Variable déjà validée.' });
    }
    if (existing.status === 'REJETE') {
      return res.status(400).json({ error: 'Variable rejetée — création d\'une nouvelle entrée requise.' });
    }

    try {
      await rejectIfPeriodLocked(companyId, existing.period);
    } catch (e) {
      return res.status(e.status || 423).json({ error: e.message });
    }

    const variable = await prisma.payVariable.update({
      where: { id: existing.id },
      data: {
        status: 'VALIDE',
        validatedBy: req.user.id,
        validatedAt: new Date(),
        notes: existing.status === 'ANOMALIE' ? null : existing.notes,
      },
      include: USER_INCLUDE,
    });

    res.json({ variable: serializeVariable(variable) });

    await logAudit(req, {
      action: 'pay_variable.validate',
      resource: `pay_variable:${variable.id}`,
      subjectUserId: variable.userId,
      metadata: {
        collab: serializeVariable(variable).collab,
        type: serializeVariable(variable).type,
        period: variable.period,
      },
    });
  }
);

// ── PUT /api/prepaie/variables/:id/unvalidate ───────────────────
router.put('/variables/:id/unvalidate',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString().notEmpty().withMessage('Identifiant de variable requis.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const existing = await ensurePayVariableInCompany(req.params.id, companyId, USER_INCLUDE);
    if (!existing) {
      return res.status(404).json({ error: 'Variable introuvable.' });
    }
    const scopeCheck = await assertPayVariableInScope(req, existing, companyId);
    if (!scopeCheck.ok) {
      return res.status(scopeCheck.status).json({ error: scopeCheck.error });
    }
    if (existing.status !== 'VALIDE') {
      return res.status(400).json({ error: 'Seules les variables validées peuvent être annulées.' });
    }

    const variable = await prisma.payVariable.update({
      where: { id: existing.id },
      data: {
        status: 'A_VALIDER',
        validatedBy: null,
        validatedAt: null,
      },
      include: USER_INCLUDE,
    });

    res.json({ variable: serializeVariable(variable), message: 'Validation annulée — variable remise à valider.' });

    await logAudit(req, {
      action: 'pay_variable.unvalidate',
      resource: `pay_variable:${variable.id}`,
      subjectUserId: variable.userId,
      metadata: {
        collab: serializeVariable(variable).collab,
        type: serializeVariable(variable).type,
        period: variable.period,
      },
    });
  }
);

// ── PUT /api/prepaie/variables/:id/reject ───────────────────────
router.put('/variables/:id/reject',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    param('id').isString().notEmpty().withMessage('Identifiant de variable requis.'),
    body('reason').optional().isString(),
    body('motif').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const reason = (req.body.reason || req.body.motif || '').trim();
    if (!reason) {
      return res.status(400).json({ error: 'Motif de rejet obligatoire (reason ou motif).' });
    }

    const companyId = getCompanyId(req);
    const existing = await ensurePayVariableInCompany(req.params.id, companyId, USER_INCLUDE);
    if (!existing) {
      return res.status(404).json({ error: 'Variable introuvable.' });
    }
    const scopeCheck = await assertPayVariableInScope(req, existing, companyId);
    if (!scopeCheck.ok) {
      return res.status(scopeCheck.status).json({ error: scopeCheck.error });
    }
    if (existing.status === 'VALIDE') {
      return res.status(400).json({ error: 'Impossible de rejeter une variable déjà validée.' });
    }

    const variable = await prisma.payVariable.update({
      where: { id: existing.id },
      data: {
        status: 'REJETE',
        notes: `Rejet: ${reason}`,
        validatedBy: req.user.id,
        validatedAt: new Date(),
      },
      include: USER_INCLUDE,
    });

    res.json({ variable: serializeVariable(variable) });

    await logAudit(req, {
      action: 'pay_variable.reject',
      resource: `pay_variable:${variable.id}`,
      subjectUserId: variable.userId,
      metadata: {
        collab: serializeVariable(variable).collab,
        type: serializeVariable(variable).type,
        period: variable.period,
        reason,
      },
    });
  }
);

// ── DELETE /api/prepaie/variables/:id ───────────────────────────
router.delete('/variables/:id',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString().notEmpty().withMessage('Identifiant de variable requis.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const existing = await ensurePayVariableInCompany(req.params.id, companyId);
    if (!existing) {
      return res.status(404).json({ error: 'Variable introuvable.' });
    }
    const scopeCheck = await assertPayVariableInScope(req, existing, companyId);
    if (!scopeCheck.ok) {
      return res.status(scopeCheck.status).json({ error: scopeCheck.error });
    }
    if (existing.status === 'VALIDE') {
      return res.status(409).json({ error: 'Suppression impossible : variable déjà validée.' });
    }

    await prisma.payVariable.delete({ where: { id: existing.id } });
    res.json({ message: 'Variable supprimée.' });

    await logAudit(req, {
      action: 'pay_variable.delete',
      resource: `pay_variable:${existing.id}`,
      subjectUserId: existing.userId,
      metadata: {
        type: TYPE_LABELS[existing.type] || existing.type,
        period: existing.period,
      },
    });
  }
);

// ── POST /api/prepaie/validate-all ──────────────────────────────
router.post('/validate-all',
  authenticate,
  authorize(...BATCH_VALIDATE_ROLES),
  [
    body('period').optional().matches(WEEK_PERIOD_REGEX).withMessage(PERIOD_MSG),
    query('period').optional().matches(WEEK_PERIOD_REGEX).withMessage(PERIOD_MSG),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const period = req.body.period || req.query.period || currentPeriod();
    const companyId = getCompanyId(req);

    try {
      await rejectIfPeriodLocked(companyId, period);
    } catch (e) {
      return res.status(e.status || 423).json({ error: e.message });
    }

    const result = await prisma.payVariable.updateMany({
      where: withCompany(companyId, { period, status: { in: ['A_VALIDER', 'ANOMALIE'] } }),
      data: {
        status: 'VALIDE',
        validatedBy: req.user.id,
        validatedAt: new Date(),
        notes: null,
      },
    });

    res.json({
      period,
      validatedCount: result.count,
      message: `${result.count} variable(s) validée(s) (y compris anomalies corrigées).`,
    });

    await logAudit(req, {
      action: 'pay_variable.validate_all',
      resource: `period:${period}`,
      metadata: { period, count: result.count },
    });
  }
);

// ── GET /api/prepaie/export ─────────────────────────────────────
router.get('/export',
  authenticate,
  authorize(...RH_PAY_ROLES),
  [
    query('format').isIn(['silae', 'sage', 'adp', 'csv', 'generic']).withMessage('Format d\'export invalide.'),
    query('period').optional().matches(WEEK_PERIOD_REGEX).withMessage(PERIOD_MSG),
    query('month').optional().matches(MONTH_PERIOD_REGEX).withMessage(MONTH_MSG),
    query('status').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const month = req.query.month;
    const period = req.query.period || currentPeriod();
    const exportFormat = req.query.format === 'generic' ? 'csv' : req.query.format;
    const statusFilter = req.query.status ? parseStatusFilter(req.query.status) : 'VALIDE';

    const periodFilter = month
      ? { period: { in: weekPeriodsOverlappingMonth(month) } }
      : { period };

    const variables = await prisma.payVariable.findMany({
      where: withCompany(companyId, {
        ...periodFilter,
        status: statusFilter || 'VALIDE',
      }),
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: [{ user: { lastName: 'asc' } }, { type: 'asc' }],
    });

    const exportPeriod = month || period;
    const { start, end } = periodBoundsStrings(month || period);
    const filenameBase = month ? `prepaie_${month}_consolide` : `prepaie_${period}`;

    await logAudit(req, {
      action: 'pay_variable.export',
      resource: `period:${exportPeriod}`,
      metadata: { period: exportPeriod, month: month || null, format: exportFormat, count: variables.length },
    });

    if (exportFormat === 'silae') {
      const lines = [
        'matricule;rubrique;valeur;unite;date_debut;date_fin',
        ...variables.map((v) => {
          const mat = matriculeForUser(v.user);
          const rub = SILAE_RUBRIQUE[v.type] || v.type;
          return `${mat};${rub};${v.value};${v.unit};${start};${end}`;
        }),
      ];
      const body = lines.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_silae.csv"`);
      return res.send(`\uFEFF${body}`);
    }

    if (exportFormat === 'sage') {
      const lines = variables.map((v) => {
        const mat = matriculeForUser(v.user);
        const rub = SILAE_RUBRIQUE[v.type] || v.type;
        return [mat, rub, v.value, v.unit, start, end].join('|');
      });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_sage.txt"`);
      return res.send(lines.join('\n'));
    }

    if (exportFormat === 'adp') {
      const rows = variables.map((v) => {
        const mat = matriculeForUser(v.user);
        const rub = SILAE_RUBRIQUE[v.type] || v.type;
        return `    <Variable matricule="${mat}" code="${rub}" valeur="${v.value}" unite="${v.unit}" debut="${start}" fin="${end}" />`;
      }).join('\n');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ExportADP periode="${exportPeriod}">\n${rows}\n</ExportADP>\n`;
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_adp.xml"`);
      return res.send(xml);
    }

    const lines = [
      'matricule,nom,prenom,type,rubrique,valeur,unite,periode,statut',
      ...variables.map((v) => {
        const mat = matriculeForUser(v.user);
        const rub = SILAE_RUBRIQUE[v.type] || v.type;
        const nom = `"${v.user.lastName.replace(/"/g, '""')}"`;
        const prenom = `"${v.user.firstName.replace(/"/g, '""')}"`;
        return `${mat},${nom},${prenom},${v.type},${rub},${v.value},${v.unit},${v.period},${v.status}`;
      }),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
    return res.send(`\uFEFF${lines.join('\n')}`);
  }
);

// ── POST /api/prepaie/period/lock ───────────────────────────────
router.post('/period/lock',
  authenticate,
  authorize(...BATCH_VALIDATE_ROLES),
  [body('period').optional().matches(WEEK_PERIOD_REGEX).withMessage(PERIOD_MSG)],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    const companyId = getCompanyId(req);
    const period = req.body.period || currentPeriod();
    const pending = await prisma.payVariable.count({
      where: withCompany(companyId, { period, status: { in: ['A_VALIDER', 'ANOMALIE'] } }),
    });
    if (pending > 0) {
      return res.status(400).json({
        error: `${pending} variable(s) encore en attente — validez ou rejetez avant clôture.`,
        pendingCount: pending,
      });
    }
    const meta = await prisma.prepaiePeriodMeta.upsert({
      where: { companyId_period: { companyId, period } },
      create: { companyId, period, lockedAt: new Date(), lockedBy: req.user.id },
      update: { lockedAt: new Date(), lockedBy: req.user.id },
    });
    res.json({ period, locked: true, lockedAt: meta.lockedAt, message: `${periodLabel(period)} clôturée.` });
    await logAudit(req, { action: 'pay_variable.period_lock', resource: `period:${period}`, metadata: { period } });
  }
);

// ── POST /api/prepaie/period/unlock ─────────────────────────────
router.post('/period/unlock',
  authenticate,
  authorize(...BATCH_VALIDATE_ROLES),
  [body('period').optional().matches(WEEK_PERIOD_REGEX).withMessage(PERIOD_MSG)],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    const companyId = getCompanyId(req);
    const period = req.body.period || currentPeriod();
    await prisma.prepaiePeriodMeta.upsert({
      where: { companyId_period: { companyId, period } },
      create: { companyId, period, lockedAt: null, lockedBy: null },
      update: { lockedAt: null, lockedBy: null },
    });
    res.json({ period, locked: false, message: `${periodLabel(period)} rouverte.` });
    await logAudit(req, { action: 'pay_variable.period_unlock', resource: `period:${period}`, metadata: { period } });
  }
);

module.exports = router;
