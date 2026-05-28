// Extracted helpers for users routes (testable without Express)
function parseListParam(val) {
  if (!val) return [];
  return String(val).split(',').map((s) => s.trim()).filter(Boolean);
}

function buildUserWhere(req, companyId) {
  const where = { companyId };
  if (req.query.includeInactive !== 'true') {
    where.isActive = true;
  }

  const siteIds = parseListParam(req.query.siteIds || req.query.siteId);
  if (siteIds.length === 1) where.siteId = siteIds[0];
  else if (siteIds.length > 1) where.siteId = { in: siteIds };

  if (req.query.role) where.role = req.query.role;

  const contractTypes = parseListParam(req.query.contractTypes || req.query.contractType);
  if (contractTypes.length === 1) where.contractType = contractTypes[0];
  else if (contractTypes.length > 1) where.contractType = { in: contractTypes };

  if (req.query.siteName && !siteIds.length) {
    const name = String(req.query.siteName).trim();
    where.site = { name: { contains: name, mode: 'insensitive' } };
  }

  if (req.query.search) {
    const q = String(req.query.search).trim();
    where.OR = [
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { jobTitle: { contains: q, mode: 'insensitive' } },
      { competences: { has: q } },
    ];
  }

  return where;
}

function buildUserOrderBy(sort, order) {
  const dir = order === 'desc' ? 'desc' : 'asc';
  if (sort === 'firstName') return [{ firstName: dir }, { lastName: dir }];
  if (sort === 'createdAt') return [{ createdAt: dir }];
  if (sort === 'email') return [{ email: dir }];
  return [{ lastName: dir }, { firstName: dir }];
}

function csvEscape(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

module.exports = {
  parseListParam,
  buildUserWhere,
  buildUserOrderBy,
  csvEscape,
};
