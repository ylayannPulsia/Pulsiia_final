// Filtrage de l'historique (AuditLog) : managers = leur site ; RH/DRH/ADMIN = entreprise
const { prisma } = require('../middleware/tenant');
const { hasFullPlanningAccess, isManagerRole } = require('./planning-scope');

async function getSiteUserIds(companyId, siteId) {
  const users = await prisma.user.findMany({
    where: { companyId, siteId, isActive: true },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

function pushResourceConditions(orConditions, prefix, ids) {
  for (const id of ids) {
    orConditions.push({ resource: `${prefix}${id}` });
  }
}

/**
 * Clause Prisma limitant les logs au périmètre site du manager.
 * @returns {Promise<object|null>} null = accès complet (RH/DRH/ADMIN)
 */
async function buildManagerAuditScope(companyId, siteId) {
  const siteUserIds = await getSiteUserIds(companyId, siteId);
  if (!siteUserIds.length) {
    return { id: '__none__' };
  }

  const orConditions = [
    { userId: { in: siteUserIds } },
    { metadata: { path: ['siteId'], equals: siteId } },
  ];

  for (const uid of siteUserIds) {
    orConditions.push({ metadata: { path: ['subjectUserId'], equals: uid } });
    orConditions.push({ metadata: { path: ['userId'], equals: uid } });
  }

  const [payVars, absences, shiftRows, planningWeeks] = await Promise.all([
    prisma.payVariable.findMany({
      where: { companyId, user: { siteId } },
      select: { id: true },
    }),
    prisma.absence.findMany({
      where: { companyId, user: { siteId } },
      select: { id: true },
    }),
    prisma.shift.findMany({
      where: { companyId, siteId },
      select: { id: true },
    }),
    prisma.planningWeek.findMany({
      where: { companyId, siteId },
      select: { id: true },
    }),
  ]);

  pushResourceConditions(orConditions, 'pay_variable:', payVars.map((r) => r.id));
  pushResourceConditions(orConditions, 'absence:', absences.map((r) => r.id));
  pushResourceConditions(orConditions, 'shift:', shiftRows.map((r) => r.id));
  pushResourceConditions(orConditions, 'planning_week:', planningWeeks.map((r) => r.id));

  return { OR: orConditions };
}

async function applyAuditScopeToWhere(req, companyId, where) {
  if (hasFullPlanningAccess(req.user.role)) {
    return where;
  }

  if (!isManagerRole(req.user.role)) {
    return { ...where, id: '__none__' };
  }

  if (!req.user.siteId) {
    return { ...where, id: '__none__' };
  }

  const scope = await buildManagerAuditScope(companyId, req.user.siteId);
  return { AND: [where, scope] };
}

function buildCategoryActionFilter(category) {
  if (!category || category === 'all') {
    return { NOT: { action: { startsWith: 'auth.' } } };
  }

  const prefixes = {
    prepaie: ['pay_variable.'],
    absence: ['absence.'],
    planning: ['shift.', 'planning.', 'planning_ai.'],
    auth: ['auth.'],
  };

  const list = prefixes[category];
  if (!list?.length) return null;

  if (list.length === 1) {
    return { action: { startsWith: list[0] } };
  }

  return { OR: list.map((p) => ({ action: { startsWith: p } })) };
}

async function getAuditScopeMeta(req, companyId) {
  if (hasFullPlanningAccess(req.user.role)) {
    return { mode: 'company', label: 'Journal complet · Traçabilité RH' };
  }

  if (isManagerRole(req.user.role) && req.user.siteId) {
    const site = await prisma.site.findFirst({
      where: { id: req.user.siteId, companyId, isActive: true },
      select: { name: true },
    });
    const name = site?.name || 'votre établissement';
    return {
      mode: 'site',
      siteId: req.user.siteId,
      siteName: name,
      label: `Historique · ${name}`,
    };
  }

  return { mode: 'restricted', label: 'Historique · périmètre limité' };
}

module.exports = {
  applyAuditScopeToWhere,
  buildCategoryActionFilter,
  getAuditScopeMeta,
  hasFullPlanningAccess,
  isManagerRole,
};
