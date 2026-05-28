// Calcul variables de paie depuis planning + absences + détection d'anomalies
const {
  startOfWeek, format, eachDayOfInterval, isSunday,
} = require('date-fns');
const { prisma, withCompany } = require('../middleware/tenant');
const {
  periodBoundsDates,
  prevPeriod,
  hsThresholdForPeriod,
} = require('./period-utils');

const HS_TYPES = ['HEURE_SUP_125', 'HEURE_SUP_150'];
const SHIFT_HOURS = { MATIN: 8, APREM: 8, NUIT: 8, JOURNEE: 8, OFF: 0, ABSENT: 0 };
const WEEKLY_CONTRACT = 35;
const PLANNING_TYPES = [
  'HEURE_NORMALE', 'HEURE_SUP_125', 'MAJORATION_NUIT',
  'MAJORATION_DIMANCHE', 'MAJORATION_FERIE',
];
const ABSENCE_PAY_TYPES = ['CONGES_PAYES', 'ABSENCE_MALADIE'];
const DEFAULT_HOURLY_RATE = parseFloat(process.env.PREPAIE_HOURLY_RATE || '15', 10);

/** Jours fériés métropole (YYYY-MM-DD) — extensible */
const PUBLIC_HOLIDAYS = new Set([
  '2026-01-01', '2026-04-06', '2026-05-01', '2026-05-08', '2026-05-14', '2026-05-25',
  '2026-07-14', '2026-08-15', '2026-11-01', '2026-11-11', '2026-12-25',
  '2025-01-01', '2025-04-21', '2025-05-01', '2025-05-08', '2025-05-29', '2025-06-09',
  '2025-07-14', '2025-08-15', '2025-11-01', '2025-11-11', '2025-12-25',
]);

const ABSENCE_TO_PAY = {
  CP: 'CONGES_PAYES',
  RTT: 'CONGES_PAYES',
  MALADIE: 'ABSENCE_MALADIE',
  ACCIDENT_TRAVAIL: 'ABSENCE_MALADIE',
  ENFANT_MALADE: 'ABSENCE_MALADIE',
};

function periodBounds(period) {
  return periodBoundsDates(period);
}

function isPublicHoliday(date) {
  return PUBLIC_HOLIDAYS.has(format(date, 'yyyy-MM-dd'));
}

function shiftHours(type, startTime, endTime, breakMin, breakStart, breakEnd) {
  if (type === 'JOURNEE' && startTime && endTime) {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    let s = sh * 60 + sm;
    let e = eh * 60 + em;
    if (e <= s) e += 24 * 60;
    let pauseMin = 0;
    if (breakStart && breakEnd) {
      const [bsh, bsm] = breakStart.split(':').map(Number);
      const [beh, bem] = breakEnd.split(':').map(Number);
      let bs = bsh * 60 + bsm;
      let be = beh * 60 + bem;
      if (be <= bs) be += 24 * 60;
      pauseMin = Math.max(0, be - bs);
    } else if (breakMin != null && breakMin > 0) {
      pauseMin = breakMin;
    }
    return Math.max(0, (e - s - pauseMin) / 60);
  }
  return SHIFT_HOURS[type] ?? 0;
}

function getUserHourlyRate(user) {
  if (user?.hourlyRate != null && user.hourlyRate > 0) return user.hourlyRate;
  return DEFAULT_HOURLY_RATE;
}

async function sumHsHoursForUser(userId, companyId, period, excludeId = null) {
  const rows = await prisma.payVariable.findMany({
    where: withCompany(companyId, {
      userId,
      period,
      type: { in: HS_TYPES },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    }),
    select: { value: true },
  });
  return rows.reduce((s, r) => s + Math.max(0, r.value), 0);
}

async function detectAnomalies({ userId, companyId, period, type, value, excludeId }) {
  const reasons = [];
  const absValue = Math.abs(value);
  const hsLimit = hsThresholdForPeriod(period);

  if (absValue > 200) {
    reasons.push(`Valeur anormalement élevée (${value}) — seuil 200.`);
  }
  if (HS_TYPES.includes(type) && value > hsLimit) {
    reasons.push(`Heures supplémentaires > ${hsLimit}h (${value}h déclarées).`);
  }
  if (type === 'MAJORATION_NUIT' && value > (hsLimit * 2.5)) {
    reasons.push(`Majoration nuit > ${hsLimit * 2.5}h (${value}h déclarées).`);
  }
  if (HS_TYPES.includes(type)) {
    const existingHs = await sumHsHoursForUser(userId, companyId, period, excludeId);
    if (existingHs + Math.max(0, value) > hsLimit) {
      reasons.push(`Cumul HS sur la période > ${hsLimit}h (${Math.round((existingHs + value) * 100) / 100}h).`);
    }
  }

  if (!reasons.length) return { isAnomaly: false, notes: null };
  return { isAnomaly: true, notes: `Anomalie: ${reasons.join(' ')}` };
}

function computeFromShifts(shifts, weeklyContract = 35) {
  const contractHours = Number.isFinite(weeklyContract) && weeklyContract > 0
    ? weeklyContract
    : WEEKLY_CONTRACT;
  const byWeek = new Map();
  let dimanche = 0;
  let ferie = 0;

  for (const s of shifts) {
    if (s.type === 'OFF' || s.type === 'ABSENT') continue;
    const h = shiftHours(s.type, s.startTime, s.endTime, s.breakMin, s.breakStart, s.breakEnd);
    if (h <= 0) continue;

    const dateKey = format(s.date, 'yyyy-MM-dd');
    const holiday = isPublicHoliday(s.date);
    const sunday = isSunday(s.date);

    if (holiday) ferie += h;
    else if (sunday) dimanche += h;

    const weekKey = format(startOfWeek(s.date, { weekStartsOn: 1 }), 'yyyy-MM-dd');
    if (!byWeek.has(weekKey)) byWeek.set(weekKey, { total: 0, nuit: 0 });
    const bucket = byWeek.get(weekKey);
    bucket.total += h;
    if (s.type === 'NUIT') bucket.nuit += h;
  }

  let normal = 0;
  let hs = 0;
  let nuit = 0;
  for (const bucket of byWeek.values()) {
    normal += Math.min(bucket.total, contractHours);
    hs += Math.max(0, bucket.total - contractHours);
    nuit += bucket.nuit;
  }

  return {
    HEURE_NORMALE: Math.round(normal * 100) / 100,
    HEURE_SUP_125: Math.round(hs * 100) / 100,
    MAJORATION_NUIT: Math.round(nuit * 100) / 100,
    MAJORATION_DIMANCHE: Math.round(dimanche * 100) / 100,
    MAJORATION_FERIE: Math.round(ferie * 100) / 100,
  };
}

function overlapDaysInPeriod(absence, periodStart, periodEnd) {
  const start = absence.startDate > periodStart ? absence.startDate : periodStart;
  const end = absence.endDate < periodEnd ? absence.endDate : periodEnd;
  if (start > end) return 0;
  const days = eachDayOfInterval({ start, end });
  return days.length;
}

function computeFromAbsences(absences, periodStart, periodEnd) {
  const totals = { CONGES_PAYES: 0, ABSENCE_MALADIE: 0 };
  for (const a of absences) {
    const payType = ABSENCE_TO_PAY[a.type];
    if (!payType) continue;
    const days = overlapDaysInPeriod(a, periodStart, periodEnd);
    if (days > 0) totals[payType] += days;
  }
  return {
    CONGES_PAYES: Math.round(totals.CONGES_PAYES * 10) / 10,
    ABSENCE_MALADIE: Math.round(totals.ABSENCE_MALADIE * 10) / 10,
  };
}

async function upsertAutoVariable({ userId, companyId, period, type, value, source, unit = 'h' }) {
  if (value <= 0) {
    const existing = await prisma.payVariable.findFirst({
      where: { userId, companyId, period, type, source },
    });
    if (existing && !['VALIDE', 'REJETE'].includes(existing.status)) {
      await prisma.payVariable.delete({ where: { id: existing.id } });
    }
    return null;
  }

  const existing = await prisma.payVariable.findFirst({
    where: { userId, companyId, period, type, source },
  });

  if (existing && ['VALIDE', 'REJETE'].includes(existing.status)) {
    return existing;
  }

  const { isAnomaly, notes } = await detectAnomalies({
    userId,
    companyId,
    period,
    type,
    value,
    excludeId: existing?.id,
  });

  const data = {
    value,
    unit,
    status: isAnomaly ? 'ANOMALIE' : 'A_VALIDER',
    notes: isAnomaly ? notes : null,
  };

  if (existing) {
    return prisma.payVariable.update({ where: { id: existing.id }, data });
  }

  return prisma.payVariable.create({
    data: { userId, companyId, period, type, source, ...data },
  });
}

async function syncUserPayVariables(userId, companyId, period) {
  const { start, end } = periodBounds(period);
  const [shifts, user] = await Promise.all([
    prisma.shift.findMany({
      where: withCompany(companyId, {
        userId,
        date: { gte: start, lte: end },
        type: { notIn: ['OFF'] },
      }),
    }),
    prisma.user.findFirst({
      where: { id: userId, companyId },
      select: { weeklyHours: true },
    }),
  ]);

  const weeklyContract = user?.weeklyHours != null && user.weeklyHours > 0
    ? user.weeklyHours
    : WEEKLY_CONTRACT;
  const computed = computeFromShifts(shifts, weeklyContract);
  const results = [];

  for (const type of PLANNING_TYPES) {
    const row = await upsertAutoVariable({
      userId,
      companyId,
      period,
      type,
      value: computed[type] || 0,
      source: 'planning_auto',
      unit: 'h',
    });
    if (row) results.push(row);
  }

  return results;
}

async function syncUserAbsenceVariables(userId, companyId, period) {
  const { start, end } = periodBounds(period);
  const absences = await prisma.absence.findMany({
    where: withCompany(companyId, {
      userId,
      status: 'APPROUVE',
      startDate: { lte: end },
      endDate: { gte: start },
    }),
  });

  const computed = computeFromAbsences(absences, start, end);
  const results = [];

  for (const type of ABSENCE_PAY_TYPES) {
    const unit = 'jours';
    const row = await upsertAutoVariable({
      userId,
      companyId,
      period,
      type,
      value: computed[type] || 0,
      source: 'absence_auto',
      unit,
    });
    if (row) results.push(row);
  }

  return results;
}

async function collectUserIdsForPeriod(companyId, period) {
  const { start, end } = periodBounds(period);
  const [shiftRows, absenceRows, varRows] = await Promise.all([
    prisma.shift.findMany({
      where: withCompany(companyId, { date: { gte: start, lte: end } }),
      select: { userId: true },
    }),
    prisma.absence.findMany({
      where: withCompany(companyId, {
        status: 'APPROUVE',
        startDate: { lte: end },
        endDate: { gte: start },
      }),
      select: { userId: true },
    }),
    prisma.payVariable.findMany({
      where: withCompany(companyId, { period }),
      select: { userId: true },
    }),
  ]);
  return [...new Set([
    ...shiftRows.map((r) => r.userId),
    ...absenceRows.map((r) => r.userId),
    ...varRows.map((r) => r.userId),
  ])];
}

async function syncCompanyPayVariables(companyId, period) {
  const userIds = await collectUserIdsForPeriod(companyId, period);

  for (const userId of userIds) {
    await syncUserPayVariables(userId, companyId, period);
    await syncUserAbsenceVariables(userId, companyId, period);
  }

  const delegate = prepaieMetaDelegate();
  if (delegate) {
    await delegate.upsert({
      where: { companyId_period: { companyId, period } },
      create: { companyId, period, lastSyncAt: new Date() },
      update: { lastSyncAt: new Date() },
    });
  }

  return { period, syncedUsers: userIds.length };
}

function prepaieMetaDelegate() {
  const d = prisma.prepaiePeriodMeta;
  if (!d?.findUnique) {
    console.warn('[prepaie] Client Prisma obsolète — exécutez : npx prisma generate');
    return null;
  }
  return d;
}

async function isPeriodLocked(companyId, period) {
  const delegate = prepaieMetaDelegate();
  if (!delegate) return false;
  const meta = await delegate.findUnique({
    where: { companyId_period: { companyId, period } },
  });
  return Boolean(meta?.lockedAt);
}

async function getPeriodMeta(companyId, period) {
  const delegate = prepaieMetaDelegate();
  if (!delegate) return null;
  return delegate.findUnique({
    where: { companyId_period: { companyId, period } },
  });
}

function estimateHsEurosFromRows(variables, usersById) {
  let total = 0;
  for (const v of variables) {
    if (v.unit !== 'h' || !HS_TYPES.includes(v.type)) continue;
    const hours = Math.max(0, v.value);
    const rate = getUserHourlyRate(usersById.get(v.userId));
    if (v.type === 'HEURE_SUP_125') total += hours * rate * 1.25;
    if (v.type === 'HEURE_SUP_150') total += hours * rate * 1.5;
  }
  return Math.round(total * 100) / 100;
}

module.exports = {
  HS_TYPES,
  DEFAULT_HOURLY_RATE,
  detectAnomalies,
  sumHsHoursForUser,
  syncUserPayVariables,
  syncUserAbsenceVariables,
  syncCompanyPayVariables,
  computeFromShifts,
  computeFromAbsences,
  isPeriodLocked,
  getPeriodMeta,
  getUserHourlyRate,
  estimateHsEurosFromRows,
  prevPeriod,
  periodBounds,
};
