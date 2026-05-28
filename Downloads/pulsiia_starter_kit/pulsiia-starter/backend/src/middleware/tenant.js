// Multi-tenant — companyId obligatoire, rejet cross-tenant
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/** companyId du JWT (refuse si absent). */
function getCompanyId(req) {
  const companyId = req.user?.companyId;
  if (!companyId) {
    const err = new Error('Non authentifié.');
    err.status = 401;
    throw err;
  }
  return companyId;
}

/** Fusionne companyId dans un filtre Prisma. */
function withCompany(companyId, where = {}) {
  return { ...where, companyId };
}

async function ensureUserInCompany(userId, companyId, select) {
  return prisma.user.findFirst({
    where: { id: userId, companyId, isActive: true },
    ...(select ? { select } : {}),
  });
}

async function ensureSiteInCompany(siteId, companyId, select) {
  return prisma.site.findFirst({
    where: { id: siteId, companyId, isActive: true },
    ...(select ? { select } : {}),
  });
}

async function ensureAbsenceInCompany(id, companyId, include) {
  return prisma.absence.findFirst({
    where: { id, companyId },
    ...(include ? { include } : {}),
  });
}

async function ensureShiftInCompany(id, companyId, include) {
  return prisma.shift.findFirst({
    where: { id, companyId },
    ...(include ? { include } : {}),
  });
}

async function ensurePayVariableInCompany(id, companyId, include) {
  return prisma.payVariable.findFirst({
    where: { id, companyId },
    ...(include ? { include } : {}),
  });
}

async function ensureSurveyInCompany(id, companyId, include) {
  return prisma.survey.findFirst({
    where: { id, companyId },
    ...(include ? { include } : {}),
  });
}

module.exports = {
  prisma,
  getCompanyId,
  withCompany,
  ensureUserInCompany,
  ensureSiteInCompany,
  ensureAbsenceInCompany,
  ensureShiftInCompany,
  ensurePayVariableInCompany,
  ensureSurveyInCompany,
};
