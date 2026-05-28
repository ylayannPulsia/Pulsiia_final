// Notifications in-app — calculées depuis les données réelles + état « lu »
const { startOfWeek, startOfDay, endOfDay, addDays, format } = require('date-fns');
const { prisma, withCompany } = require('../middleware/tenant');
const { MANAGER_ROLES } = require('../middleware/roles');
const {
  getManagerSitesWhere,
  buildPlanningUsersWhere,
} = require('../lib/planning-scope');
const { computeWellbeingScores, computeSiteTrends, roundScore } = require('../lib/bienetre-scores');
const { currentPeriod } = require('./period-utils');

const COVERAGE_TYPES = ['MATIN', 'APREM'];
const MIN_COVERAGE = 2;
const TYPE_PRIORITY = { red: 0, orange: 1, blue: 2, green: 3 };

const ABS_TYPE_LABELS = {
  CP: 'congé payé',
  RTT: 'RTT',
  MALADIE: 'arrêt maladie',
  ACCIDENT_TRAVAIL: 'accident du travail',
  SANS_SOLDE: 'congé sans solde',
  FORMATION: 'formation',
  AUTRE: 'absence',
};

function formatShiftDate(date) {
  return format(date, 'yyyy-MM-dd');
}

function formatRelativeTime(iso) {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'à l\'instant';
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `il y a ${diffH} h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return 'Hier';
  if (diffD < 7) return `il y a ${diffD} j`;
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function formatDaySlot(dateStr, type) {
  const d = new Date(`${dateStr}T12:00:00`);
  const dayName = d.toLocaleDateString('fr-FR', { weekday: 'long' });
  const slot = type === 'MATIN' ? 'matin' : 'après-midi';
  return `${dayName} ${slot}`;
}

function formatWeekLabel(weekStart) {
  const d = new Date(weekStart);
  const weekNum = format(d, 'w');
  return `S+${Math.max(1, parseInt(weekNum, 10) - format(new Date(), 'w') + 1)}`;
}

function wrapNotification({ key, type, text, createdAt, actionPage, readKeys }) {
  return {
    key,
    type,
    text,
    time: formatRelativeTime(createdAt),
    createdAt: new Date(createdAt).toISOString(),
    actionPage: actionPage || null,
    read: readKeys.has(key),
  };
}

function sortNotifications(items) {
  return items.sort((a, b) => {
    const pa = TYPE_PRIORITY[a.type] ?? 9;
    const pb = TYPE_PRIORITY[b.type] ?? 9;
    if (pa !== pb) return pa - pb;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

async function getReadKeys(userId) {
  const rows = await prisma.notificationRead.findMany({
    where: { userId },
    select: { key: true },
  });
  return new Set(rows.map((r) => r.key));
}

async function buildPlanningGapNotifications(req, companyId, readKeys) {
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

  if (!shifts.length) return [];

  const siteIds = new Set(sites.map((s) => s.id));
  const coverage = new Map();
  for (const shift of shifts) {
    if (!siteIds.has(shift.siteId)) continue;
    const dayKey = formatShiftDate(shift.date);
    const key = `${shift.siteId}|${dayKey}|${shift.type}`;
    if (!coverage.has(key)) coverage.set(key, new Set());
    coverage.get(key).add(shift.userId);
  }

  const items = [];
  for (let day = 0; day < 7; day++) {
    const date = formatShiftDate(addDays(monday, day));
    for (const site of sites) {
      for (const type of COVERAGE_TYPES) {
        const covKey = `${site.id}|${date}|${type}`;
        const count = coverage.get(covKey)?.size ?? 0;
        if (count < MIN_COVERAGE) {
          items.push({
            key: `planning-gap:${site.id}:${date}:${type}`,
            siteName: site.name,
            date,
            type,
            count,
            dayIndex: day,
          });
        }
      }
    }
  }

  if (!items.length) return [];

  items.sort((a, b) => {
    const dayA = new Date(`${a.date}T12:00:00`).getDay();
    const dayB = new Date(`${b.date}T12:00:00`).getDay();
    const weekendA = dayA === 6 || dayA === 0 ? 0 : 1;
    const weekendB = dayB === 6 || dayB === 0 ? 0 : 1;
    if (weekendA !== weekendB) return weekendA - weekendB;
    return a.count - b.count;
  });

  const first = items[0];
  const extra = items.length > 1 ? ` (+${items.length - 1} autre${items.length > 2 ? 's' : ''})` : '';

  return [wrapNotification({
    key: `planning-gaps:${formatShiftDate(monday)}`,
    type: 'red',
    text: `Poste découvert ${formatDaySlot(first.date, first.type)} — ${first.siteName}${extra}`,
    createdAt: new Date(`${first.date}T08:00:00`),
    actionPage: 'planning',
    readKeys,
  })];
}

async function buildPrepaieNotifications(companyId, readKeys) {
  const period = currentPeriod();
  const pendingCount = await prisma.payVariable.count({
    where: withCompany(companyId, { period, status: 'A_VALIDER' }),
  });
  if (!pendingCount) return [];

  const friday = new Date();
  const daysUntilFriday = (5 - friday.getDay() + 7) % 7 || 7;
  friday.setDate(friday.getDate() + daysUntilFriday);

  return [wrapNotification({
    key: `prepaie-pending:${period}`,
    type: 'orange',
    text: `${pendingCount} variable${pendingCount > 1 ? 's' : ''} paie à valider avant ${friday.toLocaleDateString('fr-FR', { weekday: 'long' })}`,
    createdAt: new Date(),
    actionPage: 'prepaie',
    readKeys,
  })];
}

async function buildWellbeingNotifications(req, companyId, readKeys) {
  const scores = await computeWellbeingScores(companyId);
  if (!scores.survey || !scores.bySite?.length) return [];

  const items = [];
  for (const site of scores.bySite) {
    if (!site.meetsAnonymity || site.averageScore == null) continue;

    let declining = false;
    if (site.siteId) {
      const trends = await computeSiteTrends(companyId, site.siteId, 2);
      if (trends.length >= 2) {
        const prev = trends[trends.length - 2]?.score;
        const curr = trends[trends.length - 1]?.score;
        if (prev != null && curr != null && curr < prev - 0.3) declining = true;
      }
    }

    if (site.averageScore < 6 || declining) {
      items.push(wrapNotification({
        key: `wellbeing:${site.siteId || 'team'}:${scores.survey.id}`,
        type: 'orange',
        text: `Score bien-être en baisse — ${site.siteName} (${roundScore(site.averageScore)})`,
        createdAt: scores.survey.createdAt || new Date(),
        actionPage: 'bienetre',
        readKeys,
      }));
    }
  }
  return items;
}

async function buildPlanningWeekNotifications(req, companyId, readKeys) {
  const siteWhere = getManagerSitesWhere(req, companyId);
  const sites = await prisma.site.findMany({
    where: siteWhere,
    select: { id: true },
  });
  const siteIds = sites.map((s) => s.id);
  if (!siteIds.length) return [];

  const weeks = await prisma.planningWeek.findMany({
    where: withCompany(companyId, {
      siteId: { in: siteIds },
      status: { in: ['PENDING_VALIDATION', 'AI_GENERATED'] },
    }),
    include: { site: { select: { name: true } } },
    orderBy: { weekStart: 'asc' },
    take: 5,
  });

  return weeks.map((w) => wrapNotification({
    key: `planning-week:${w.id}`,
    type: 'blue',
    text: `Planning semaine ${formatWeekLabel(w.weekStart)} prêt pour validation${w.site?.name ? ` — ${w.site.name}` : ''}`,
    createdAt: w.generatedAt || w.updatedAt,
    actionPage: 'planning',
    readKeys,
  }));
}

async function buildAutoValidatedNotifications(companyId, readKeys) {
  const since = new Date();
  since.setDate(since.getDate() - 7);

  const variables = await prisma.payVariable.findMany({
    where: withCompany(companyId, {
      status: 'VALIDE',
      source: 'planning_auto',
      validatedAt: { gte: since },
    }),
    include: {
      user: { select: { firstName: true, lastName: true } },
    },
    orderBy: { validatedAt: 'desc' },
    take: 5,
  });

  const TYPE_SHORT = {
    MAJORATION_NUIT: 'majoration nuit',
    HEURE_SUP_125: 'heures sup. ×1.25',
    HEURE_SUP_150: 'heures sup. ×1.50',
    MAJORATION_DIMANCHE: 'majoration dimanche',
    MAJORATION_FERIE: 'majoration férié',
  };

  return variables.map((v) => {
    const label = TYPE_SHORT[v.type] || 'variable paie';
    const name = `${v.user.firstName} ${v.user.lastName.charAt(0)}.`;
    return wrapNotification({
      key: `prepaie-auto:${v.id}`,
      type: 'green',
      text: `${name} — ${label} validée automatiquement`,
      createdAt: v.validatedAt || v.updatedAt,
      actionPage: 'prepaie',
      readKeys,
    });
  });
}

async function buildPendingAbsenceNotifications(req, companyId, readKeys) {
  const userWhere = buildPlanningUsersWhere(req);
  const pendingCount = await prisma.absence.count({
    where: withCompany(companyId, {
      status: 'EN_ATTENTE',
      user: userWhere,
    }),
  });
  if (!pendingCount) return [];

  const latest = await prisma.absence.findFirst({
    where: withCompany(companyId, { status: 'EN_ATTENTE', user: userWhere }),
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  return [wrapNotification({
    key: `absences-pending:${companyId}`,
    type: 'orange',
    text: `${pendingCount} demande${pendingCount > 1 ? 's' : ''} d'absence en attente de validation`,
    createdAt: latest?.createdAt || new Date(),
    actionPage: 'absences',
    readKeys,
  })];
}

async function buildManagerNotifications(req, companyId, readKeys) {
  const [
    gaps,
    prepaie,
    wellbeing,
    planningWeeks,
    autoValidated,
    pendingAbsences,
  ] = await Promise.all([
    buildPlanningGapNotifications(req, companyId, readKeys),
    buildPrepaieNotifications(companyId, readKeys),
    buildWellbeingNotifications(req, companyId, readKeys),
    buildPlanningWeekNotifications(req, companyId, readKeys),
    buildAutoValidatedNotifications(companyId, readKeys),
    buildPendingAbsenceNotifications(req, companyId, readKeys),
  ]);

  return sortNotifications([
    ...gaps,
    ...prepaie,
    ...wellbeing.slice(0, 3),
    ...planningWeeks,
    ...pendingAbsences,
    ...autoValidated,
  ]).slice(0, 20);
}

async function buildCollabNotifications(req, companyId, readKeys) {
  const userId = req.user.id;
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const [absences, documents] = await Promise.all([
    prisma.absence.findMany({
      where: {
        userId,
        companyId,
        updatedAt: { gte: since },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    }),
    prisma.uploadedFile.findMany({
      where: {
        userId,
        companyId,
        isDeleted: false,
        purpose: { in: ['document_rh', 'document_bulletin', 'document_contrat'] },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
  ]);

  const items = [];

  for (const a of absences) {
    const typeLabel = ABS_TYPE_LABELS[a.type] || 'absence';
    const start = formatShiftDate(a.startDate);
    const end = formatShiftDate(a.endDate);
    const period = start === end ? start : `${start} – ${end}`;

    if (a.status === 'REFUSE') {
      items.push(wrapNotification({
        key: `absence:${a.id}:${a.status}`,
        type: 'red',
        text: `Votre demande de ${typeLabel} (${period}) a été refusée`,
        createdAt: a.updatedAt,
        actionPage: 'mes-docs',
        readKeys,
      }));
    } else if (a.status === 'APPROUVE') {
      items.push(wrapNotification({
        key: `absence:${a.id}:${a.status}`,
        type: 'green',
        text: `Votre ${typeLabel} (${period}) a été approuvé`,
        createdAt: a.updatedAt,
        actionPage: 'mon-planning',
        readKeys,
      }));
    } else if (a.status === 'EN_ATTENTE') {
      items.push(wrapNotification({
        key: `absence:${a.id}:pending`,
        type: 'orange',
        text: `Demande de ${typeLabel} (${period}) en attente de validation`,
        createdAt: a.createdAt,
        actionPage: 'accueil-collab',
        readKeys,
      }));
    }
  }

  for (const doc of documents) {
    items.push(wrapNotification({
      key: `document:${doc.id}`,
      type: 'green',
      text: `Document disponible — ${doc.originalName}`,
      createdAt: doc.createdAt,
      actionPage: 'mes-docs',
      readKeys,
    }));
  }

  return sortNotifications(items).slice(0, 15);
}

async function listNotifications(req) {
  const companyId = req.user.companyId;
  const readKeys = await getReadKeys(req.user.id);

  const notifications = MANAGER_ROLES.includes(req.user.role)
    ? await buildManagerNotifications(req, companyId, readKeys)
    : await buildCollabNotifications(req, companyId, readKeys);

  const unreadCount = notifications.filter((n) => !n.read).length;
  return { notifications, unreadCount };
}

async function markNotificationRead(userId, companyId, key) {
  await prisma.notificationRead.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, companyId, key },
    update: { readAt: new Date() },
  });
}

async function markAllNotificationsRead(userId, companyId, keys) {
  if (!keys.length) return;
  await prisma.$transaction(
    keys.map((key) =>
      prisma.notificationRead.upsert({
        where: { userId_key: { userId, key } },
        create: { userId, companyId, key },
        update: { readAt: new Date() },
      }),
    ),
  );
}

module.exports = {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
};
