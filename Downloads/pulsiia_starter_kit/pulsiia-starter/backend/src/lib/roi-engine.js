// Calcul ROI réaliste — données réelles, pas de double comptage
const { prisma, withCompany } = require('../middleware/tenant');
const {
  hasFullPlanningAccess,
  isManagerRole,
  getManagedUserIds,
} = require('./planning-scope');
const { weekPeriodsOverlappingMonth } = require('./period-utils');

const HS_TYPES = ['HEURE_SUP_125', 'HEURE_SUP_150'];
const AUTO_SOURCES = ['planning_auto', 'absence_auto'];

/** Lignes générées en masse par sync — gain marginal faible unitairement */
const ROUTINE_TYPES = [
  'HEURE_NORMALE',
  'MAJORATION_NUIT',
  'MAJORATION_DIMANCHE',
  'MAJORATION_FERIE',
];

const MINUTES_PER_SYNC_BATCH = parseInt(process.env.ROI_MINUTES_SYNC_BATCH || '32', 10);
const MINUTES_PER_EXTRA_SYNC = parseInt(process.env.ROI_MINUTES_EXTRA_SYNC || '8', 10);
const MAX_FULL_SYNC_CREDITS = parseInt(process.env.ROI_MAX_SYNC_CREDITS || '4', 10);
const MINUTES_PER_COVERED_EMPLOYEE = parseInt(process.env.ROI_MINUTES_PER_EMPLOYEE || '10', 10);
const MINUTES_PER_COMPLEX_VAR = parseInt(process.env.ROI_MINUTES_COMPLEX_VAR || '6', 10);
const MINUTES_PER_ANOMALY_CAUGHT = parseInt(process.env.ROI_MINUTES_ANOMALY || '28', 10);
const MINUTES_PER_ABSENCE_FLOW = parseInt(process.env.ROI_MINUTES_ABSENCE || '14', 10);
const MINUTES_PER_PLANNING_PUBLISH = parseInt(process.env.ROI_MINUTES_PLANNING_PUBLISH || '12', 10);

const RH_HOURLY_COST = parseFloat(process.env.ROI_RH_HOURLY_COST || '42', 10);
const PAYROLL_ERROR_COST = parseFloat(process.env.ROI_PAYROLL_ERROR_COST || '95', 10);
const HS_HOURLY_RATE = parseFloat(process.env.PREPAIE_HOURLY_RATE || '15', 10);
const HS_COST_MULTIPLIER = parseFloat(process.env.ROI_HS_COST_MULTIPLIER || '1.25', 10);
const MANUAL_MINUTES_PER_USER = parseInt(process.env.ROI_MANUAL_MINUTES_PER_USER || '38', 10);
const SUBSCRIPTION_MONTHLY = parseFloat(process.env.ROI_SUBSCRIPTION_MONTHLY || '3400', 10);
const MAX_RH_HOURS_PER_USER = parseFloat(process.env.ROI_MAX_RH_HOURS_PER_USER || '1.8', 10);

function shiftPeriod(period, deltaMonths) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + deltaMonths, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function lastNPeriods(endPeriod, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(shiftPeriod(endPeriod, -i));
  }
  return out;
}

function periodDateRange(period) {
  const [y, m] = period.split('-').map(Number);
  return {
    start: new Date(y, m - 1, 1),
    end: new Date(y, m, 0, 23, 59, 59, 999),
  };
}

function periodShortLabel(period) {
  const [y, m] = period.split('-').map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short' });
  return label.charAt(0).toUpperCase() + label.slice(1).replace('.', '');
}

function periodLongLabel(period) {
  const [y, m] = period.split('-').map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function roundEuros(n) {
  return Math.round(Math.max(0, n));
}

function roundHours(n) {
  return Math.round(Math.max(0, n) * 100) / 100;
}

function formatHoursDisplay(hours) {
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (totalMin === 0) return '0 min';
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, '0')}`;
}

function scaleSyncCount(syncCount, teamUsers, companyUsers) {
  if (!companyUsers || !teamUsers) return syncCount;
  if (teamUsers >= companyUsers) return syncCount;
  const ratio = teamUsers / companyUsers;
  return Math.max(0, Math.round(syncCount * ratio * 100) / 100);
}

function computeSyncMinutes(syncCount) {
  const full = Math.min(syncCount, MAX_FULL_SYNC_CREDITS);
  const extra = Math.max(0, syncCount - MAX_FULL_SYNC_CREDITS);
  return full * MINUTES_PER_SYNC_BATCH + extra * MINUTES_PER_EXTRA_SYNC;
}

function capRhHours(hours, activeUsers) {
  const cap = activeUsers * MAX_RH_HOURS_PER_USER;
  return cap > 0 ? Math.min(hours, cap) : hours;
}

async function resolveRoiScope(req, companyId) {
  if (hasFullPlanningAccess(req.user.role)) {
    return { userIds: null, managerScope: false, siteId: null };
  }

  if (isManagerRole(req.user.role)) {
    if (!req.user.siteId) {
      return { forbidden: true, status: 403, error: 'Aucun établissement assigné à votre compte.' };
    }
    const userIds = await getManagedUserIds(req, companyId, req.user.siteId);
    return { userIds, managerScope: true, siteId: req.user.siteId };
  }

  return { userIds: null, managerScope: false, siteId: null };
}

function buildUserFilter(userIds) {
  return userIds ? { userId: { in: userIds } } : {};
}

/** Pré-paie hebdo (YYYY-MM-DD) + legacy mensuel (YYYY-MM) pour un mois calendaire */
function monthPeriodKeys(monthPeriod) {
  const weeks = weekPeriodsOverlappingMonth(monthPeriod);
  return [...new Set([monthPeriod, ...weeks])];
}

function monthPeriodFilter(monthPeriod) {
  return { period: { in: monthPeriodKeys(monthPeriod) } };
}

async function computePeriodMetrics(companyId, period, userIds, companyActiveUsers = null) {
  const { start, end } = periodDateRange(period);
  const userFilter = buildUserFilter(userIds);
  const periodFilter = monthPeriodFilter(period);

  const [
    autoVarRows,
    coveredEmployees,
    complexAuto,
    absenceFlows,
    anomalies,
    validatedComplex,
    syncCountRaw,
    publishCount,
    hsAgg,
    activeUsers,
    approvedAbsences,
    pendingVariables,
    companyUsers,
  ] = await Promise.all([
    prisma.payVariable.count({
      where: { companyId, ...periodFilter, source: { in: AUTO_SOURCES }, ...userFilter },
    }),
    prisma.payVariable.groupBy({
      by: ['userId'],
      where: { companyId, ...periodFilter, source: { in: AUTO_SOURCES }, ...userFilter },
    }),
    prisma.payVariable.count({
      where: {
        companyId,
        ...periodFilter,
        source: 'planning_auto',
        type: { notIn: ROUTINE_TYPES },
        ...userFilter,
      },
    }),
    prisma.payVariable.count({
      where: { companyId, ...periodFilter, source: 'absence_auto', ...userFilter },
    }),
    prisma.payVariable.count({
      where: {
        companyId,
        ...periodFilter,
        source: { in: AUTO_SOURCES },
        status: 'ANOMALIE',
        ...userFilter,
      },
    }),
    prisma.payVariable.count({
      where: {
        companyId,
        ...periodFilter,
        source: { in: AUTO_SOURCES },
        status: 'VALIDE',
        type: { notIn: ROUTINE_TYPES },
        ...userFilter,
      },
    }),
    prisma.auditLog.count({
      where: {
        companyId,
        action: 'pay_variable.sync',
        createdAt: { gte: start, lte: end },
      },
    }),
    prisma.auditLog.count({
      where: {
        companyId,
        action: 'planning.publish',
        createdAt: { gte: start, lte: end },
      },
    }),
    prisma.payVariable.aggregate({
      where: {
        companyId,
        ...periodFilter,
        type: { in: HS_TYPES },
        unit: 'h',
        ...userFilter,
      },
      _sum: { value: true },
    }),
    userIds
      ? prisma.user.count({ where: { id: { in: userIds }, isActive: true } })
      : prisma.user.count({ where: withCompany(companyId, { isActive: true }) }),
    prisma.absence.aggregate({
      where: {
        companyId,
        status: 'APPROUVE',
        ...userFilter,
        startDate: { lte: end },
        endDate: { gte: start },
      },
      _sum: { days: true },
    }),
    prisma.payVariable.count({
      where: { companyId, ...periodFilter, status: 'A_VALIDER', ...userFilter },
    }),
    companyActiveUsers != null
      ? Promise.resolve(companyActiveUsers)
      : prisma.user.count({ where: withCompany(companyId, { isActive: true }) }),
  ]);

  const coveredCount = coveredEmployees.length;
  const syncCount = scaleSyncCount(syncCountRaw, coveredCount || activeUsers, companyUsers);

  const rhMinutesRaw =
    computeSyncMinutes(syncCount) +
    coveredCount * MINUTES_PER_COVERED_EMPLOYEE +
    complexAuto * MINUTES_PER_COMPLEX_VAR +
    absenceFlows * MINUTES_PER_ABSENCE_FLOW +
    anomalies * MINUTES_PER_ANOMALY_CAUGHT +
    publishCount * MINUTES_PER_PLANNING_PUBLISH;

  const rhHoursSaved = roundHours(
    capRhHours(rhMinutesRaw / 60, activeUsers),
  );

  const errorsAvoided = anomalies + Math.min(
    Math.floor(validatedComplex / 4),
    Math.max(1, Math.ceil(coveredCount / 6)),
  );

  const eurosFromRh = roundEuros(rhHoursSaved * RH_HOURLY_COST);
  const eurosFromErrors = roundEuros(errorsAvoided * PAYROLL_ERROR_COST);
  const baselineSansPulsiia = roundEuros(
    (activeUsers * MANUAL_MINUTES_PER_USER / 60) * RH_HOURLY_COST,
  );

  const hsHours = roundHours(hsAgg._sum.value || 0);
  const absenceDays = roundHours(approvedAbsences._sum.days || 0);

  return {
    period,
    autoVariables: autoVarRows,
    coveredEmployees: coveredCount,
    complexAuto,
    absenceFlows,
    anomalies,
    validatedComplex,
    syncCount,
    syncCountRaw,
    publishCount,
    hsHours,
    absenceDays,
    activeUsers,
    pendingVariables,
    rhHoursSaved,
    rhMinutesRaw,
    errorsAvoided,
    eurosFromRh,
    eurosFromErrors,
    baselineSansPulsiia,
    companyUsers,
  };
}

function applyHsSavings(current, previous) {
  const prevHs = previous?.hsHours || 0;
  const currHs = current.hsHours || 0;
  const rawReduction = roundHours(prevHs - currHs);

  // Ne créditer que si baisse significative (> 3 % ou > 2 h) et plafonnée à 15 % du stock M-1
  const minDrop = Math.max(2, prevHs * 0.03);
  const maxCredit = prevHs * 0.15;
  const hsReduction = prevHs > 0 && rawReduction >= minDrop
    ? roundHours(Math.min(rawReduction, maxCredit))
    : 0;

  const hsEuros = roundEuros(hsReduction * HS_HOURLY_RATE * HS_COST_MULTIPLIER);
  const eurosSaved = current.eurosFromRh + current.eurosFromErrors + hsEuros;

  return {
    ...current,
    hsReductionHours: hsReduction,
    hsEuros,
    eurosSaved,
  };
}

function buildLevers(raw, hsData) {
  const levers = [];

  if (raw.syncCount > 0 || raw.publishCount > 0) {
    const syncMin = computeSyncMinutes(raw.syncCount) + raw.publishCount * MINUTES_PER_PLANNING_PUBLISH;
    levers.push({
      id: 'sync_planning',
      label: 'Sync planning → paie',
      measure: raw.syncCount >= 1
        ? `${Math.round(raw.syncCount * 10) / 10} sync · ${raw.coveredEmployees} collab. couverts`
        : `${raw.publishCount} publication${raw.publishCount > 1 ? 's' : ''} planning`,
      source: 'Journal d\'audit · pré-paie',
      gainEuros: roundEuros((syncMin / 60) * RH_HOURLY_COST),
      kind: 'measured',
    });
  }

  if (raw.complexAuto > 0) {
    const min = raw.complexAuto * MINUTES_PER_COMPLEX_VAR;
    levers.push({
      id: 'complex_vars',
      label: 'Variables complexes auto',
      measure: `${raw.complexAuto} ligne${raw.complexAuto > 1 ? 's' : ''} (HS, absences…)`,
      source: 'Pré-paie · sans ressaisie',
      gainEuros: roundEuros((min / 60) * RH_HOURLY_COST),
      kind: 'measured',
    });
  }

  if (raw.absenceFlows > 0) {
    const min = raw.absenceFlows * MINUTES_PER_ABSENCE_FLOW;
    levers.push({
      id: 'absence_sync',
      label: 'Absences → paie',
      measure: `${raw.absenceFlows} flux absence validé${raw.absenceFlows > 1 ? 's' : ''}`,
      source: 'Absences · corrélation auto',
      gainEuros: roundEuros((min / 60) * RH_HOURLY_COST),
      kind: 'measured',
    });
  }

  if (raw.anomalies > 0) {
    levers.push({
      id: 'anomalies',
      label: 'Anomalies détectées',
      measure: `${raw.anomalies} alerte${raw.anomalies > 1 ? 's' : ''} avant clôture`,
      source: 'Contrôles pré-paie Pulsiia',
      gainEuros: roundEuros(
        (raw.anomalies * MINUTES_PER_ANOMALY_CAUGHT / 60) * RH_HOURLY_COST
        + raw.anomalies * PAYROLL_ERROR_COST,
      ),
      kind: 'measured',
    });
  }

  if (hsData.hsReductionHours > 0) {
    levers.push({
      id: 'hs_optim',
      label: 'HS maîtrisées',
      measure: `−${hsData.hsReductionHours}h vs M−1`,
      source: 'Pré-paie · comparaison mensuelle',
      gainEuros: hsData.hsEuros,
      kind: 'estimated',
    });
  }

  if (raw.errorsAvoided > raw.anomalies && raw.validatedComplex > 0) {
    const extraErrors = raw.errorsAvoided - raw.anomalies;
    levers.push({
      id: 'validations',
      label: 'Contrôles validés',
      measure: `${raw.validatedComplex} ligne${raw.validatedComplex > 1 ? 's' : ''} complexe${raw.validatedComplex > 1 ? 's' : ''} vérifiée${raw.validatedComplex > 1 ? 's' : ''}`,
      source: 'Pré-paie · validation RH',
      gainEuros: roundEuros(extraErrors * PAYROLL_ERROR_COST),
      kind: 'estimated',
    });
  }

  const leverSum = levers.reduce((s, l) => s + l.gainEuros, 0);
  const totalGainEuros = hsData.eurosSaved;

  return {
    levers,
    totalGainEuros,
    leverSum,
  };
}

function buildMethodology() {
  return {
    measured: [
      'Sync planning → paie (journal d\'audit, plafonnées à 4 sync « complètes »/mois)',
      'Collaborateurs couverts par variables auto (≈10 min/collab./mois)',
      'Lignes complexes (HS, absences) — pas les heures normales de masse',
      'Anomalies détectées avant clôture paie',
    ],
    estimated: [
      `Coût horaire RH : ${RH_HOURLY_COST} €/h`,
      `Correction paie évitée : ${PAYROLL_ERROR_COST} €/anomalie`,
      `HS maîtrisées : baisse vs M−1 (max 15 % du stock), coût HS × ${HS_COST_MULTIPLIER}`,
      `Baseline sans Pulsiia : ${MANUAL_MINUTES_PER_USER} min/collab./mois de saisie manuelle`,
    ],
    constants: {
      minutesPerSyncBatch: MINUTES_PER_SYNC_BATCH,
      minutesPerEmployee: MINUTES_PER_COVERED_EMPLOYEE,
      minutesPerComplexVar: MINUTES_PER_COMPLEX_VAR,
      rhHourlyCost: RH_HOURLY_COST,
      payrollErrorCost: PAYROLL_ERROR_COST,
      hsHourlyRate: HS_HOURLY_RATE,
      manualMinutesPerUser: MANUAL_MINUTES_PER_USER,
      subscriptionMonthly: SUBSCRIPTION_MONTHLY,
      maxRhHoursPerUser: MAX_RH_HOURS_PER_USER,
    },
  };
}

function scopedSubscription(activeUsers, companyUsers, userIds) {
  if (!userIds || !activeUsers || !companyUsers) return SUBSCRIPTION_MONTHLY;
  return roundEuros(SUBSCRIPTION_MONTHLY * (activeUsers / companyUsers));
}

async function computeRoiReport(companyId, userIds, months = 6) {
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const periods = lastNPeriods(currentPeriod, months);

  const companyUsers = await prisma.user.count({
    where: withCompany(companyId, { isActive: true }),
  });

  const metricsByPeriod = {};
  for (const period of periods) {
    metricsByPeriod[period] = await computePeriodMetrics(
      companyId,
      period,
      userIds,
      companyUsers,
    );
  }

  const monthly = [];
  let cumulativeAvec = 0;

  for (const period of periods) {
    const raw = metricsByPeriod[period];
    const prevPeriod = shiftPeriod(period, -1);
    const prevRaw = metricsByPeriod[prevPeriod] || { hsHours: 0 };
    const withHs = applyHsSavings(raw, prevRaw);

    cumulativeAvec += withHs.eurosSaved;

    monthly.push({
      period,
      label: periodShortLabel(period),
      avecPulsiia: cumulativeAvec,
      sansPulsiia: raw.baselineSansPulsiia,
      monthlyGainEuros: withHs.eurosSaved,
      rhHoursSaved: withHs.rhHoursSaved,
      errorsAvoided: withHs.errorsAvoided,
      breakdown: {
        eurosFromRh: withHs.eurosFromRh,
        eurosFromErrors: withHs.eurosFromErrors,
        hsEuros: withHs.hsEuros,
        hsReductionHours: withHs.hsReductionHours,
      },
    });
  }

  const currentRaw = metricsByPeriod[currentPeriod];
  const prevRaw = metricsByPeriod[shiftPeriod(currentPeriod, -1)] || { hsHours: 0 };
  const prevPrevRaw = metricsByPeriod[shiftPeriod(currentPeriod, -2)] || { hsHours: 0 };

  const current = applyHsSavings(currentRaw, prevRaw);
  const previousMonth = applyHsSavings(prevRaw, prevPrevRaw);

  const { levers, totalGainEuros } = buildLevers(currentRaw, current);

  const subscriptionCost = scopedSubscription(
    currentRaw.activeUsers,
    companyUsers,
    userIds,
  );

  const roiMultiplier = subscriptionCost > 0
    ? Math.round((current.eurosSaved / subscriptionCost) * 10) / 10
    : null;

  return {
    period: currentPeriod,
    periodLabel: periodLongLabel(currentPeriod),
    methodology: buildMethodology(),
    current: {
      eurosSaved: current.eurosSaved,
      rhHoursSaved: current.rhHoursSaved,
      rhHoursDisplay: formatHoursDisplay(current.rhHoursSaved),
      errorsAvoided: current.errorsAvoided,
      roiMultiplier,
      subscriptionCost,
      pendingVariables: currentRaw.pendingVariables,
      activeUsers: currentRaw.activeUsers,
      coveredEmployees: currentRaw.coveredEmployees,
      deltas: {
        euros: current.eurosSaved - (previousMonth.eurosSaved || 0),
        rhHours: roundHours(current.rhHoursSaved - (previousMonth.rhHoursSaved || 0)),
        errors: current.errorsAvoided - (previousMonth.errorsAvoided || 0),
      },
    },
    monthly,
    levers,
    totalGainEuros,
    prepaieVariablesReady: currentRaw.validatedComplex + currentRaw.pendingVariables,
  };
}

function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function buildExportCsv(companyId, userIds, type, period) {
  const report = await computeRoiReport(companyId, userIds, 6);
  const p = period || report.period;
  const companyUsers = await prisma.user.count({
    where: withCompany(companyId, { isActive: true }),
  });
  const metrics = await computePeriodMetrics(companyId, p, userIds, companyUsers);
  const prev = await computePeriodMetrics(companyId, shiftPeriod(p, -1), userIds, companyUsers);
  const withHs = applyHsSavings(metrics, prev);
  const lines = [];

  if (type === 'roi-mensuel' || type === 'roi') {
    lines.push('Rapport ROI mensuel Pulsiia');
    lines.push(`Période;${p}`);
    lines.push('');
    lines.push('Indicateur;Valeur;Source');
    lines.push(`Économies estimées;${withHs.eurosSaved} €;Moteur ROI Pulsiia`);
    lines.push(`Heures RH récupérées;${formatHoursDisplay(withHs.rhHoursSaved)};Sync + collab. + lignes complexes`);
    lines.push(`Erreurs paie évitées;${withHs.errorsAvoided};Anomalies + contrôles validés`);
    lines.push(`Collaborateurs couverts;${metrics.coveredEmployees};Pré-paie auto`);
    lines.push(`Lignes complexes auto;${metrics.complexAuto};HS, absences…`);
    lines.push(`Sync planning→paie;${metrics.syncCount};Audit (prorata équipe si manager)`);
    lines.push(`Anomalies détectées;${metrics.anomalies};Pré-paie`);
    lines.push(`HS vs M-1;${withHs.hsReductionHours} h;Pré-paie`);
  } else if (type === 'absenteisme') {
    lines.push('Rapport absentéisme');
    lines.push(`Période;${p}`);
    lines.push('');
    lines.push('Jours absence approuvés;Effectif actif;Taux estimé');
    const rate = metrics.activeUsers
      ? Math.round((metrics.absenceDays / (metrics.activeUsers * 22)) * 1000) / 10
      : 0;
    lines.push(`${metrics.absenceDays};${metrics.activeUsers};${rate} %`);
    const absences = await prisma.absence.findMany({
      where: {
        companyId,
        status: 'APPROUVE',
        ...buildUserFilter(userIds),
        startDate: { lte: periodDateRange(p).end },
        endDate: { gte: periodDateRange(p).start },
      },
      include: { user: { select: { firstName: true, lastName: true } } },
      orderBy: { startDate: 'desc' },
      take: 200,
    });
    lines.push('');
    lines.push('Collaborateur;Type;Début;Fin;Jours');
    for (const a of absences) {
      lines.push([
        csvEscape(`${a.user.firstName} ${a.user.lastName}`),
        a.type,
        a.startDate.toISOString().slice(0, 10),
        a.endDate.toISOString().slice(0, 10),
        a.days,
      ].join(';'));
    }
  } else if (type === 'heures-sup' || type === 'heures-supplementaires') {
    lines.push('Rapport heures supplémentaires');
    lines.push(`Période;${p}`);
    lines.push('');
    lines.push('Collaborateur;Type;Heures;Statut;Source');
    const vars = await prisma.payVariable.findMany({
      where: {
        companyId,
        ...monthPeriodFilter(p),
        type: { in: HS_TYPES },
        ...buildUserFilter(userIds),
      },
      include: { user: { select: { firstName: true, lastName: true } } },
      orderBy: [{ userId: 'asc' }, { type: 'asc' }],
    });
    for (const v of vars) {
      lines.push([
        csvEscape(`${v.user.firstName} ${v.user.lastName}`),
        v.type,
        v.value,
        v.status,
        v.source,
      ].join(';'));
    }
  } else if (type === 'prepaie') {
    lines.push('Export pré-paie — variables');
    lines.push(`Période;${p}`);
    lines.push('');
    lines.push('Collaborateur;Type;Valeur;Unité;Statut;Source');
    const vars = await prisma.payVariable.findMany({
      where: { companyId, ...monthPeriodFilter(p), ...buildUserFilter(userIds) },
      include: { user: { select: { firstName: true, lastName: true } } },
      orderBy: [{ userId: 'asc' }, { type: 'asc' }],
    });
    for (const v of vars) {
      lines.push([
        csvEscape(`${v.user.firstName} ${v.user.lastName}`),
        v.type,
        v.value,
        v.unit,
        v.status,
        v.source,
      ].join(';'));
    }
  } else if (type === 'bien-etre' || type === 'bienetre') {
    lines.push('Rapport bien-être — participation');
    lines.push(`Période;${p}`);
    const survey = await prisma.survey.findFirst({
      where: withCompany(companyId, { status: 'ACTIVE' }),
      include: {
        responses: {
          where: userIds ? { userId: { in: userIds } } : undefined,
          include: { answers: { select: { score: true } } },
        },
      },
    });
    if (survey) {
      const scores = survey.responses.flatMap((r) => r.answers.map((a) => a.score));
      const avg = scores.length
        ? Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 10) / 10
        : null;
      lines.push(`Réponses;${survey.responses.length}`);
      lines.push(`Score moyen;${avg ?? 'N/A'}`);
    } else {
      lines.push('Aucun sondage actif');
    }
  } else if (type === 'turnover') {
    lines.push('Rapport turnover');
    lines.push(`Période;${p}`);
    const { start, end } = periodDateRange(p);
    const deactivated = await prisma.user.count({
      where: {
        companyId,
        isActive: false,
        updatedAt: { gte: start, lte: end },
        ...(userIds ? { id: { in: userIds } } : {}),
      },
    });
    lines.push(`Désactivations sur la période;${deactivated}`);
    lines.push(`Effectif actif;${metrics.activeUsers}`);
    const rate = metrics.activeUsers
      ? Math.round((deactivated / metrics.activeUsers) * 1000) / 10
      : 0;
    lines.push(`Taux turnover (période);${rate} %`);
  } else {
    lines.push('Type de rapport inconnu');
  }

  return lines.join('\r\n');
}

function buildRoiCompletCsv(report) {
  const c = report.current || {};
  const lines = [];

  lines.push('Rapport ROI complet — Pulsiia');
  lines.push(`Période;${report.periodLabel || report.period}`);
  lines.push(`Périmètre;${report.managerScope ? 'Équipe gérée' : 'Entreprise'}`);
  lines.push('');
  lines.push('=== Indicateurs clés ===');
  lines.push('Indicateur;Valeur');
  lines.push(`Économies totales;${c.eurosSaved} €`);
  lines.push(`Heures RH récupérées;${c.rhHoursDisplay || c.rhHoursSaved}`);
  lines.push(`Erreurs paie évitées;${c.errorsAvoided ?? 0}`);
  lines.push(`ROI mensuel;${c.roiMultiplier ?? '—'}`);
  lines.push(`Coût abonnement;${c.subscriptionCost ?? '—'} €`);
  lines.push(`Collaborateurs couverts;${c.coveredEmployees ?? '—'}`);
  lines.push('');
  lines.push('=== Évolution 6 mois ===');
  lines.push('Mois;Cumul avec Pulsiia (€);Baseline sans Pulsiia (€);Gain mensuel (€)');
  for (const m of report.monthly || []) {
    lines.push([
      csvEscape(m.label),
      m.avecPulsiia,
      m.sansPulsiia,
      m.monthlyGainEuros,
    ].join(';'));
  }
  lines.push('');
  lines.push('=== Leviers ROI ===');
  lines.push('Levier;Mesure;Source;Gain/mois (€)');
  for (const l of report.levers || []) {
    lines.push([
      csvEscape(l.label),
      csvEscape(l.measure),
      csvEscape(l.source),
      l.gainEuros,
    ].join(';'));
  }
  lines.push(`Total mensuel;;;${report.totalGainEuros ?? c.eurosSaved ?? 0}`);

  return lines.join('\r\n');
}

module.exports = {
  computeRoiReport,
  computePeriodMetrics,
  resolveRoiScope,
  buildExportCsv,
  buildRoiCompletCsv,
  periodLongLabel,
  formatHoursDisplay,
  shiftPeriod,
};
