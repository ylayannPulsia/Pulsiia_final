// Scope planning : managers limités à leur site + équipe (subordonnés directs)
const {
  prisma,
  withCompany,
  ensureUserInCompany,
  ensureSiteInCompany,
  ensureShiftInCompany,
} = require('../middleware/tenant');

const FULL_PLANNING_ROLES = ['DRH', 'RH', 'ADMIN'];

function hasFullPlanningAccess(role) {
  return FULL_PLANNING_ROLES.includes(role);
}

function isManagerRole(role) {
  return role === 'MANAGER';
}

function buildPlanningUsersWhere(req, extra = {}) {
  const base = { isActive: true, ...extra };

  if (hasFullPlanningAccess(req.user.role)) {
    return base;
  }

  if (isManagerRole(req.user.role)) {
    if (!req.user.siteId) {
      return { ...base, id: '__none__' };
    }
    return {
      ...base,
      siteId: req.user.siteId,
      OR: [
        { managerId: req.user.id },
        { id: req.user.id },
      ],
    };
  }

  return { ...base, id: req.user.id };
}

async function assertCanAccessPlanningSite(req, siteId, companyId) {
  const site = await ensureSiteInCompany(siteId, companyId);
  if (!site) {
    return { ok: false, status: 404, error: 'Site introuvable.' };
  }

  if (hasFullPlanningAccess(req.user.role)) {
    return { ok: true, site };
  }

  if (isManagerRole(req.user.role)) {
    if (!req.user.siteId || req.user.siteId !== siteId) {
      return { ok: false, status: 403, error: 'Vous ne pouvez gérer que le planning de votre établissement.' };
    }
    return { ok: true, site };
  }

  if (req.user.siteId && req.user.siteId !== siteId) {
    return { ok: false, status: 403, error: 'Accès refusé à ce site.' };
  }

  return { ok: true, site };
}

async function assertCanManagePlanningUser(req, userId, companyId) {
  if (hasFullPlanningAccess(req.user.role)) {
    const user = await ensureUserInCompany(userId, companyId);
    return user
      ? { ok: true, user }
      : { ok: false, status: 404, error: 'Utilisateur introuvable dans votre entreprise.' };
  }

  if (isManagerRole(req.user.role)) {
    if (!req.user.siteId) {
      return { ok: false, status: 403, error: 'Aucun établissement assigné à votre compte.' };
    }

    const user = await prisma.user.findFirst({
      where: withCompany(companyId, {
        id: userId,
        siteId: req.user.siteId,
        isActive: true,
        OR: [
          { managerId: req.user.id },
          { id: req.user.id },
        ],
      }),
    });

    return user
      ? { ok: true, user }
      : { ok: false, status: 403, error: 'Vous ne pouvez modifier que le planning de votre équipe.' };
  }

  return { ok: false, status: 403, error: 'Accès refusé.' };
}

async function assertCanManageShift(req, shiftId, companyId) {
  const shift = await ensureShiftInCompany(shiftId, companyId);
  if (!shift) {
    return { ok: false, status: 404, error: 'Shift introuvable.' };
  }

  const userCheck = await assertCanManagePlanningUser(req, shift.userId, companyId);
  if (!userCheck.ok) return userCheck;

  if (isManagerRole(req.user.role) && shift.siteId !== req.user.siteId) {
    return { ok: false, status: 403, error: 'Shift hors de votre établissement.' };
  }

  return { ok: true, shift };
}

async function assertAllCanManagePlanningUsers(req, userIds, companyId) {
  const unique = [...new Set(userIds)];
  for (const userId of unique) {
    const check = await assertCanManagePlanningUser(req, userId, companyId);
    if (!check.ok) return check;
  }
  return { ok: true, userIds: unique };
}

function applyManagerUsersListScope(req, where) {
  if (!isManagerRole(req.user.role)) return where;

  if (!req.user.siteId) {
    return { ...where, id: '__none__' };
  }

  const teamScope = {
    OR: [
      { managerId: req.user.id },
      { id: req.user.id },
    ],
  };

  const scoped = { ...where, siteId: req.user.siteId };

  if (scoped.OR) {
    scoped.AND = [...(scoped.AND || []), { OR: scoped.OR }, teamScope];
    delete scoped.OR;
  } else {
    scoped.AND = [...(scoped.AND || []), teamScope];
  }

  return scoped;
}

function getManagerSitesWhere(req, companyId) {
  if (hasFullPlanningAccess(req.user.role)) {
    return withCompany(companyId, { isActive: true });
  }
  if (isManagerRole(req.user.role) && req.user.siteId) {
    return withCompany(companyId, { id: req.user.siteId, isActive: true });
  }
  if (req.user.siteId) {
    return withCompany(companyId, { id: req.user.siteId, isActive: true });
  }
  return withCompany(companyId, { id: '__none__', isActive: true });
}

async function getManagedUserIds(req, companyId, siteId) {
  const users = await prisma.user.findMany({
    where: withCompany(companyId, buildPlanningUsersWhere(req, siteId ? { siteId } : {})),
    select: { id: true },
  });
  return users.map((u) => u.id);
}

async function filterWeeklyPlanningForScope(req, companyId, siteId, data) {
  if (hasFullPlanningAccess(req.user.role)) return data;

  const teamIds = new Set(await getManagedUserIds(req, companyId, siteId));
  return {
    ...data,
    employees: (data.employees || []).filter((e) => teamIds.has(e.id)),
    shifts: (data.shifts || []).filter((s) => teamIds.has(s.userId)),
  };
}

function buildPrepaieVariablesWhere(req, companyId, extra = {}) {
  const where = withCompany(companyId, extra);

  if (hasFullPlanningAccess(req.user.role)) {
    return where;
  }

  if (isManagerRole(req.user.role)) {
    where.user = buildPlanningUsersWhere(req);
  }

  return where;
}

async function assertPayVariableInScope(req, payVariable, companyId) {
  if (!payVariable) {
    return { ok: false, status: 404, error: 'Variable introuvable.' };
  }
  if (hasFullPlanningAccess(req.user.role)) {
    return { ok: true, variable: payVariable };
  }
  const check = await assertCanManagePlanningUser(req, payVariable.userId, companyId);
  if (!check.ok) {
    return {
      ok: false,
      status: check.status,
      error: 'Vous ne pouvez accéder qu\'aux variables de votre équipe.',
    };
  }
  return { ok: true, variable: payVariable };
}

function stripPrepaieSummaryForManager(req, summary) {
  if (!isManagerRole(req.user.role)) return summary;
  return {
    ...summary,
    estimatedOvertimeEuros: null,
    estimatedOvertimeEurosValidated: null,
    hourlyRateUsed: null,
    usesPerCollabRates: null,
    managerScope: true,
  };
}

module.exports = {
  FULL_PLANNING_ROLES,
  hasFullPlanningAccess,
  isManagerRole,
  buildPlanningUsersWhere,
  assertCanAccessPlanningSite,
  assertCanManagePlanningUser,
  assertCanManageShift,
  assertAllCanManagePlanningUsers,
  applyManagerUsersListScope,
  getManagerSitesWhere,
  getManagedUserIds,
  filterWeeklyPlanningForScope,
  buildPrepaieVariablesWhere,
  assertPayVariableInScope,
  stripPrepaieSummaryForManager,
};
