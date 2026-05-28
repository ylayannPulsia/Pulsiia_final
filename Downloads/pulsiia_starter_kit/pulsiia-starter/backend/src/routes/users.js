// src/routes/users.js — Collaborateurs & organigramme
const router = require('express').Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');

/**
 * Génère un mot de passe aléatoire sécurisé
 * Format : 3 majuscules + 3 chiffres + 3 minuscules + 1 symbole = 10 caractères
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*';
  const rand = (str) => str[crypto.randomInt(0, str.length)];
  const parts = [
    rand(upper), rand(upper), rand(upper),
    rand(digits), rand(digits), rand(digits),
    rand(lower), rand(lower), rand(lower),
    rand(symbols),
  ];
  // Mélange aléatoire
  for (let i = parts.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [parts[i], parts[j]] = [parts[j], parts[i]];
  }
  return parts.join('');
}
const { body, query, param } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { MANAGER_ROLES, RH_PAY_ROLES } = require('../middleware/roles');
const {
  prisma,
  getCompanyId,
  withCompany,
  ensureUserInCompany,
  ensureSiteInCompany,
} = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { logAudit } = require('../lib/audit');
const { normalizeIban, formatIban, isValidIban } = require('../lib/iban');
const {
  sendUserInviteEmail,
  sendCompanyInviteEmail,
  buildLoginUrl,
  sendMail,
  mailDiagnostics,
  verifyMailTransport,
} = require('../lib/mail');
const {
  findUsersByEmail,
  findUserInCompany,
  findPendingInvitation,
  invitationProfileFromBody,
  createCompanyInvitation,
} = require('../lib/company-invitation');
const { computeContractLimits, normalizePlanningRules } = require('../lib/labor-contract');
const { getUserHourlyRate } = require('../lib/prepaie-engine');
const {
  parseListParam,
  buildUserWhere,
  buildUserOrderBy,
  csvEscape,
} = require('./users.helpers');
const {
  applyManagerUsersListScope,
  getManagerSitesWhere,
  assertCanManagePlanningUser,
  assertAllCanManagePlanningUsers,
} = require('../lib/planning-scope');

const USER_ROLES = ['COLLABORATEUR', 'MANAGER', 'RH', 'DRH', 'ADMIN'];
const CONTRACT_TYPES = ['CDI', 'CDD', 'INTERIM'];
const AVATAR_COLORS = ['#3B82F6', '#059669', '#D97706', '#7C3AED', '#DC2626', '#0891B2', '#F472B6', '#FF8A5B'];

function canEditHourlyRate(role) {
  return RH_PAY_ROLES.includes(role);
}

async function resendInviteForUser(user, companyName) {
  const defaultPassword = generatePassword();
  const passwordHash = await bcrypt.hash(defaultPassword, 12);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash },
  });

  const loginUrl = buildLoginUrl();
  let emailResult = { sent: false, dev: true };
  try {
    emailResult = await sendUserInviteEmail({
      to: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      loginUrl,
      defaultPassword,
      companyName,
    });
  } catch (mailErr) {
    console.warn(`[users] resend invite failed for ${user.email}:`, mailErr.message);
    emailResult = { sent: false, error: mailErr.message };
  }

  const result = {
    userId: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    emailSent: emailResult.sent,
  };
  if (!emailResult.sent) {
    result.defaultPassword = defaultPassword;
    result.dev = emailResult.dev;
    result.message = emailResult.message || emailResult.error;
  }
  return result;
}

async function resendInvitesInParallel(users, companyName, concurrency = 5) {
  const results = [];
  for (let i = 0; i < users.length; i += concurrency) {
    const chunk = users.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map((user) => resendInviteForUser(user, companyName)),
    );
    results.push(...chunkResults);
  }
  return results;
}

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  jobTitle: true,
  phone: true,
  iban: true,
  avatarColor: true,
  avatarUrl: true,
  managerId: true,
  contractType: true,
  contractEndDate: true,
  weeklyHours: true,
  competences: true,
  secondaryRoles: true,
  hourlyRate: true,
  isActive: true,
  createdAt: true,
  site: { select: { id: true, name: true, city: true } },
  manager: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      avatarColor: true,
    },
  },
};

function shortName(firstName, lastName) {
  const ln = lastName || '';
  return `${firstName} ${ln.charAt(0) ? `${ln.charAt(0)}.` : ''}`.trim();
}

function initials(firstName, lastName) {
  return `${(firstName || '')[0] || ''}${(lastName || '')[0] || ''}`.toUpperCase();
}

function deptFromJob(jobTitle, role) {
  const j = (jobTitle || '').toLowerCase();
  if (role === 'DRH' || role === 'RH') return 'RH';
  if (j.includes('directeur') || j.includes('drh') || role === 'ADMIN') return 'Direction';
  if (j.includes('cuisin') || j.includes('chef') || j.includes('pâtiss')) return 'Cuisine';
  if (j.includes('serve') || j.includes('sommelier') || j.includes('barman')) return 'Service';
  if (j.includes('accueil') || j.includes('hôte')) return 'Accueil';
  return 'Service';
}

function contractLabel(type) {
  if (type === 'INTERIM') return 'Intérim';
  return type || 'CDI';
}

function contractBadgeClass(type) {
  if (type === 'CDD') return 'cdd';
  if (type === 'INTERIM') return 'interim';
  return 'cdi';
}

function normalizeStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
}

function mapUserBase(u) {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    shortName: shortName(u.firstName, u.lastName),
    fullName: `${u.firstName} ${u.lastName}`,
    initials: initials(u.firstName, u.lastName),
    role: u.role,
    jobTitle: u.jobTitle,
    dept: deptFromJob(u.jobTitle, u.role),
    phone: u.phone,
    avatarColor: u.avatarColor || '#6B7280',
    avatarUrl: u.avatarUrl || null,
    site: u.site,
    siteId: u.site?.id || null,
    siteName: u.site?.name || null,
    managerId: u.managerId,
    manager: u.manager
      ? {
          id: u.manager.id,
          name: shortName(u.manager.firstName, u.manager.lastName),
          fullName: `${u.manager.firstName} ${u.manager.lastName}`,
          jobTitle: u.manager.jobTitle,
        }
      : null,
    contractType: u.contractType || 'CDI',
    contractEndDate: u.contractEndDate ? u.contractEndDate.toISOString().slice(0, 10) : null,
    contractLabel: contractLabel(u.contractType),
    contractBadgeClass: contractBadgeClass(u.contractType),
    weeklyHours: u.weeklyHours,
    competences: u.competences || [],
    secondaryRoles: u.secondaryRoles || [],
    hourlyRate: u.hourlyRate,
    createdAt: u.createdAt,
    entree: u.createdAt ? u.createdAt.toISOString().slice(0, 10) : null,
    isActive: u.isActive !== false,
  };
}

async function enrichUsers(users, companyId) {
  if (!users.length) return [];
  const userIds = users.map((u) => u.id);
  const period = new Date().toISOString().slice(0, 7);
  const [pendingAbsences, anomalies, company] = await Promise.all([
    prisma.absence.findMany({
      where: withCompany(companyId, { status: 'EN_ATTENTE', userId: { in: userIds } }),
      select: { userId: true, type: true, status: true },
    }),
    prisma.payVariable.findMany({
      where: withCompany(companyId, { period, status: 'ANOMALIE', userId: { in: userIds } }),
      select: { userId: true, type: true },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    }),
  ]);

  const planningRules = normalizePlanningRules(company?.settings?.planningRules);
  const absByUser = new Map(pendingAbsences.map((a) => [a.userId, a]));
  const anomByUser = new Map(anomalies.map((a) => [a.userId, a]));

  return users.map((u) => {
    const limits = computeContractLimits(u, planningRules);
    return {
      ...mapUserBase(u),
      ...limits,
      pendingAbsence: absByUser.get(u.id) || null,
      payAnomaly: anomByUser.has(u.id),
      payAnomalyType: anomByUser.get(u.id)?.type || null,
    };
  });
}

function attachSelfIban(user, rawIban) {
  if (!user) return user;
  user.iban = rawIban ? formatIban(rawIban) : null;
  return user;
}

async function fetchUserById(userId, companyId, { activeOnly = false } = {}) {
  const where = { id: userId, companyId };
  if (activeOnly) where.isActive = true;
  const raw = await prisma.user.findFirst({
    where,
    select: USER_SELECT,
  });
  if (!raw) return null;
  const [enriched] = await enrichUsers([raw], companyId);
  return enriched;
}

const ORG_PHONE_ROLES = new Set(['DRH', 'RH', 'ADMIN']);

async function inviteExistingAccountHolder(req, res, {
  companyId,
  email,
  firstName,
  lastName,
  profileExtras,
}) {
  const pending = await findPendingInvitation(email, companyId);
  if (pending) {
    res.status(409).json({
      error: 'Une invitation est déjà en attente pour cet e-mail.',
      pendingInvitation: true,
    });
    return true;
  }

  const profile = invitationProfileFromBody({
    firstName,
    lastName,
    ...profileExtras,
  });

  const { acceptUrl } = await createCompanyInvitation({
    companyId,
    email,
    invitedById: req.user.id,
    profile,
  });

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true },
  });

  let emailResult = { sent: false, dev: true };
  try {
    emailResult = await sendCompanyInviteEmail({
      to: email,
      firstName,
      companyName: company?.name,
      acceptUrl,
      inviterName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || null,
    });
  } catch (mailErr) {
    console.warn('[users] company invite email failed:', mailErr.message);
    emailResult = { sent: false, error: mailErr.message };
  }

  await logAudit(req, {
    action: 'USER_INVITE_EXISTING',
    resource: email,
    metadata: { email, companyId },
  });

  const invite = {
    email,
    acceptUrl,
    emailSent: emailResult.sent,
    existingAccount: true,
    message: emailResult.sent
      ? `Invitation envoyée à ${email} — le collaborateur pourra rejoindre votre entreprise avec son compte existant.`
      : `Invitation créée pour ${email}. Lien : ${acceptUrl}${emailResult.dev ? ` (${emailResult.message || 'e-mail non envoyé — redémarrez le backend'})` : ''}`,
  };

  res.status(201).json({ invited: true, invite });
  return true;
}

function mapOrgNode(u, viewerRole) {
  const node = {
    id: u.id,
    name: u.shortName,
    fullName: u.fullName,
    role: u.jobTitle || u.role,
    dept: u.dept,
    site: u.siteName || u.site?.name || '',
    color: u.avatarColor,
    manager: u.managerId,
    email: u.email,
    contrat: u.contractLabel,
    entree: u.entree,
    userRole: u.role,
  };
  if (ORG_PHONE_ROLES.has(viewerRole) && u.phone) {
    node.tel = u.phone;
  }
  return node;
}

async function fetchCompanyCatalog(companyId) {
  try {
    const [jobPositions, operationalPoles, skills] = await Promise.all([
      prisma.jobPosition.findMany({
        where: { companyId, isActive: true },
        select: { id: true, name: true, createdAt: true },
        orderBy: { name: 'asc' },
      }),
      prisma.operationalPole.findMany({
        where: { companyId, isActive: true },
        select: { id: true, name: true, createdAt: true },
        orderBy: { name: 'asc' },
      }),
      prisma.skill.findMany({
        where: { companyId, isActive: true },
        select: { id: true, name: true, createdAt: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { jobPositions, operationalPoles, skills };
  } catch (err) {
    console.warn('[users] catalogue indisponible:', err.message);
    return { jobPositions: [], operationalPoles: [], skills: [] };
  }
}

function normalizeCatalogName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

// ── GET /api/users/catalog ────────────────────────────────────
router.get('/catalog',
  authenticate,
  authorize(...MANAGER_ROLES),
  async (req, res) => {
    const companyId = getCompanyId(req);
    const catalog = await fetchCompanyCatalog(companyId);
    res.json(catalog);
  },
);

// ── POST /api/users/catalog/job-positions ─────────────────────
router.post('/catalog/job-positions',
  authenticate,
  authorize(...MANAGER_ROLES),
  [body('name').trim().notEmpty().isLength({ max: 120 })],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const name = normalizeCatalogName(req.body.name);
    if (!name) {
      res.status(400).json({ error: 'Nom de poste invalide.' });
      return;
    }

    const existing = await prisma.jobPosition.findFirst({
      where: { companyId, name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) {
      if (!existing.isActive) {
        const restored = await prisma.jobPosition.update({
          where: { id: existing.id },
          data: { isActive: true },
          select: { id: true, name: true, createdAt: true },
        });
        await logAudit(req, { action: 'JOB_POSITION_CREATE', resource: restored.id, metadata: { name } });
        res.status(201).json({ jobPosition: restored });
        return;
      }
      res.status(409).json({ error: 'Ce poste existe déjà.' });
      return;
    }

    const jobPosition = await prisma.jobPosition.create({
      data: { companyId, name },
      select: { id: true, name: true, createdAt: true },
    });
    await logAudit(req, { action: 'JOB_POSITION_CREATE', resource: jobPosition.id, metadata: { name } });
    res.status(201).json({ jobPosition });
  },
);

// ── POST /api/users/catalog/operational-poles ─────────────────
router.post('/catalog/operational-poles',
  authenticate,
  authorize(...MANAGER_ROLES),
  [body('name').trim().notEmpty().isLength({ max: 80 })],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const name = normalizeCatalogName(req.body.name);
    if (!name) {
      res.status(400).json({ error: 'Nom de pôle invalide.' });
      return;
    }

    const existing = await prisma.operationalPole.findFirst({
      where: { companyId, name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) {
      if (!existing.isActive) {
        const restored = await prisma.operationalPole.update({
          where: { id: existing.id },
          data: { isActive: true },
          select: { id: true, name: true, createdAt: true },
        });
        await logAudit(req, { action: 'OPERATIONAL_POLE_CREATE', resource: restored.id, metadata: { name } });
        res.status(201).json({ operationalPole: restored });
        return;
      }
      res.status(409).json({ error: 'Ce pôle existe déjà.' });
      return;
    }

    const operationalPole = await prisma.operationalPole.create({
      data: { companyId, name },
      select: { id: true, name: true, createdAt: true },
    });
    await logAudit(req, { action: 'OPERATIONAL_POLE_CREATE', resource: operationalPole.id, metadata: { name } });
    res.status(201).json({ operationalPole });
  },
);

// ── DELETE /api/users/catalog/job-positions/:id ───────────────
router.delete('/catalog/job-positions/:id',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const row = await prisma.jobPosition.findFirst({
      where: { id: req.params.id, companyId, isActive: true },
    });
    if (!row) {
      res.status(404).json({ error: 'Poste introuvable.' });
      return;
    }

    await prisma.jobPosition.update({ where: { id: row.id }, data: { isActive: false } });
    await logAudit(req, { action: 'JOB_POSITION_DELETE', resource: row.id, metadata: { name: row.name } });
    res.json({ ok: true });
  },
);

// ── DELETE /api/users/catalog/operational-poles/:id ───────────
router.delete('/catalog/operational-poles/:id',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const row = await prisma.operationalPole.findFirst({
      where: { id: req.params.id, companyId, isActive: true },
    });
    if (!row) {
      res.status(404).json({ error: 'Pôle introuvable.' });
      return;
    }

    await prisma.operationalPole.update({ where: { id: row.id }, data: { isActive: false } });
    await logAudit(req, { action: 'OPERATIONAL_POLE_DELETE', resource: row.id, metadata: { name: row.name } });
    res.json({ ok: true });
  },
);

// ── POST /api/users/catalog/skills ────────────────────────────
router.post('/catalog/skills',
  authenticate,
  authorize(...MANAGER_ROLES),
  [body('name').trim().notEmpty().isLength({ max: 80 })],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const name = normalizeCatalogName(req.body.name);
    if (!name) {
      res.status(400).json({ error: 'Nom de compétence invalide.' });
      return;
    }

    const existing = await prisma.skill.findFirst({
      where: { companyId, name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) {
      if (!existing.isActive) {
        const restored = await prisma.skill.update({
          where: { id: existing.id },
          data: { isActive: true },
          select: { id: true, name: true, createdAt: true },
        });
        res.status(201).json({ skill: restored });
        return;
      }
      res.status(409).json({ error: 'Cette compétence existe déjà.' });
      return;
    }

    const skill = await prisma.skill.create({
      data: { companyId, name },
      select: { id: true, name: true, createdAt: true },
    });
    res.status(201).json({ skill });
  },
);

// ── DELETE /api/users/catalog/skills/:id ────────────────────────
router.delete('/catalog/skills/:id',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const row = await prisma.skill.findFirst({
      where: { id: req.params.id, companyId, isActive: true },
    });
    if (!row) {
      res.status(404).json({ error: 'Compétence introuvable.' });
      return;
    }

    await prisma.skill.update({ where: { id: row.id }, data: { isActive: false } });
    res.json({ ok: true });
  },
);

// ── GET /api/users/export ─────────────────────────────────────
router.get('/export',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    query('siteId').optional().isString(),
    query('siteIds').optional().isString(),
    query('siteName').optional().isString(),
    query('role').optional().isString(),
    query('contractType').optional().isString(),
    query('contractTypes').optional().isString(),
    query('search').optional().isString(),
    query('sort').optional().isIn(['lastName', 'firstName', 'email', 'createdAt']),
    query('order').optional().isIn(['asc', 'desc']),
    query('includeInactive').optional().isIn(['true', 'false']),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    const companyId = getCompanyId(req);
    const where = { ...buildUserWhere(req, companyId) };
    const sort = req.query.sort || 'lastName';
    const order = req.query.order === 'desc' ? 'desc' : 'asc';

    const rawUsers = await prisma.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: buildUserOrderBy(sort, order),
    });
    const users = await enrichUsers(rawUsers, companyId);

    const header = ['Prénom', 'Nom', 'Email', 'Poste', 'Établissement', 'Contrat', 'Fin contrat', 'Rôle', 'Manager', 'Volume h', 'Taux horaire', 'Compétences', 'Pôles'];
    const rows = users.map((u) => [
      u.firstName,
      u.lastName,
      u.email,
      u.jobTitle || '',
      u.siteName || '',
      u.contractLabel,
      u.contractEndDate || '',
      u.role,
      u.manager?.fullName || '',
      u.weeklyHours != null ? u.weeklyHours : '',
      u.hourlyRate != null ? u.hourlyRate : '',
      (u.competences || []).join('; '),
      (u.secondaryRoles || []).join('; '),
    ].map(csvEscape).join(','));

    const csv = [header.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="collaborateurs.csv"');
    res.send('\uFEFF' + csv);
  },
);

// ── GET /api/users/sites ──────────────────────────────────────
router.get('/sites',
  authenticate,
  authorize(...MANAGER_ROLES),
  async (req, res) => {
    const companyId = getCompanyId(req);
    const sites = await prisma.site.findMany({
      where: withCompany(companyId, { isActive: true }),
      select: { id: true, name: true, city: true },
      orderBy: { name: 'asc' },
    });
    res.json({ sites });
  },
);

// ── GET /api/users ──────────────────────────────────────────────
router.get('/',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    query('siteId').optional().isString(),
    query('siteIds').optional().isString(),
    query('siteName').optional().isString(),
    query('role').optional().isString(),
    query('contractType').optional().isString(),
    query('contractTypes').optional().isString(),
    query('search').optional().isString(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('sort').optional().isIn(['lastName', 'firstName', 'email', 'createdAt']),
    query('order').optional().isIn(['asc', 'desc']),
    query('includeInactive').optional().isIn(['true', 'false']),
    query('includeCatalog').optional().isIn(['true', 'false']),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const where = applyManagerUsersListScope(req, buildUserWhere(req, companyId));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 24));
    const sort = req.query.sort || 'lastName';
    const order = req.query.order === 'desc' ? 'desc' : 'asc';
    const includeCatalog = req.query.includeCatalog !== 'false';

    const [rawUsers, total, siteCount, sites, catalog] = await Promise.all([
      prisma.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: buildUserOrderBy(sort, order),
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
      prisma.site.count({ where: getManagerSitesWhere(req, companyId) }),
      prisma.site.findMany({
        where: getManagerSitesWhere(req, companyId),
        select: { id: true, name: true, city: true },
        orderBy: { name: 'asc' },
      }),
      includeCatalog ? fetchCompanyCatalog(companyId) : Promise.resolve(null),
    ]);

    const users = await enrichUsers(rawUsers, companyId);

    res.json({
      users,
      sites,
      ...(catalog ? { catalog } : {}),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        sort,
        order,
      },
      stats: {
        total,
        sites: siteCount,
      },
    });
  },
);

// ── GET /api/users/org-chart ──────────────────────────────────
router.get('/org-chart',
  authenticate,
  [
    query('siteId').optional().isString(),
    query('search').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const viewerRole = req.user.role;
    const where = buildUserWhere(req, companyId);

    const [rawUsers, siteCount, company] = await Promise.all([
      prisma.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      }),
      prisma.site.count({ where: withCompany(companyId, { isActive: true }) }),
      prisma.company.findUnique({
        where: { id: companyId },
        select: { name: true },
      }),
    ]);

    const users = await enrichUsers(rawUsers, companyId);
    const people = users.map((u) => mapOrgNode(u, viewerRole));

    res.json({
      people,
      total: people.length,
      stats: {
        total: people.length,
        sites: siteCount,
        companyName: company?.name || null,
      },
      permissions: {
        canViewPhone: ORG_PHONE_ROLES.has(viewerRole),
      },
    });
  },
);

// ── GET /api/users/me/salary ──────────────────────────────────
router.get('/me/salary',
  authenticate,
  [query('period').optional().matches(/^\d{4}-\d{2}$/).withMessage('Période invalide (format AAAA-MM).')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    const companyId = getCompanyId(req);
    const userId = req.user.id;
    const period = req.query.period || new Date().toISOString().slice(0, 7);

    const [userRow, variables] = await Promise.all([
      prisma.user.findFirst({
        where: { id: userId, companyId },
        select: { hourlyRate: true },
      }),
      prisma.payVariable.findMany({
        where: { userId, companyId, period },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const hourlyRate = getUserHourlyRate(userRow);
    const hourlyRateFromProfile = userRow?.hourlyRate != null && userRow.hourlyRate > 0;

    const hours = {
      normal: 0,
      night: 0,
      sup125: 0,
      sup150: 0,
    };
    let prime = 0;

    for (const v of variables) {
      if (v.unit === '€') {
        if (v.type === 'PRIME_ANCIENNETE' || v.type === 'PRIME_PERFORMANCE' || v.type === 'PRIME_PANIER') {
          prime += Math.abs(v.value);
        }
        continue;
      }
      const val = Math.abs(v.value);
      if (v.type === 'HEURE_NORMALE') hours.normal += val;
      else if (v.type === 'MAJORATION_NUIT') hours.night += val;
      else if (v.type === 'HEURE_SUP_125') hours.sup125 += val;
      else if (v.type === 'HEURE_SUP_150') hours.sup150 += val;
    }

    const baseNorm = hours.normal * hourlyRate;
    const baseNuit = hours.night * hourlyRate * 1.2;
    const baseSup125 = hours.sup125 * hourlyRate * 1.25;
    const baseSup150 = hours.sup150 * hourlyRate * 1.5;
    const brut = baseNorm + baseNuit + baseSup125 + baseSup150 + prime;
    const net = brut * 0.77;

    res.json({
      period,
      hourlyRate,
      hourlyRateFromProfile,
      hours,
      prime,
      brut: Math.round(brut * 100) / 100,
      net: Math.round(net * 100) / 100,
      variables: variables.map((v) => ({
        id: v.id,
        type: v.type,
        value: v.value,
        unit: v.unit,
        status: v.status,
      })),
    });
  },
);

// ── GET /api/users/me ─────────────────────────────────────────
router.get('/me',
  authenticate,
  async (req, res) => {
    const companyId = getCompanyId(req);
    const user = await fetchUserById(req.user.id, companyId);
    if (!user) {
      res.status(404).json({ error: 'Profil introuvable.' });
      return;
    }
    const raw = await prisma.user.findFirst({
      where: { id: req.user.id, companyId, isActive: true },
      select: { iban: true },
    });
    attachSelfIban(user, raw?.iban);
    res.json({ user });
  },
);

// ── PATCH /api/users/me ───────────────────────────────────────
router.patch('/me',
  authenticate,
  [
    body('phone').optional({ nullable: true }).isString(),
    body('iban').optional({ nullable: true }).isString().custom((value) => {
      if (value === null || value === '') return true;
      if (!isValidIban(value)) throw new Error('IBAN invalide.');
      return true;
    }),
    body('avatarColor').optional().isString(),
    body('firstName').optional().trim().notEmpty(),
    body('lastName').optional().trim().notEmpty(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const data = {};
    if (req.body.phone !== undefined) data.phone = req.body.phone || null;
    if (req.body.iban !== undefined) data.iban = normalizeIban(req.body.iban);
    if (req.body.avatarColor !== undefined) data.avatarColor = req.body.avatarColor;
    if (req.body.firstName !== undefined) data.firstName = req.body.firstName;
    if (req.body.lastName !== undefined) data.lastName = req.body.lastName;

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: USER_SELECT,
    });

    const [user] = await enrichUsers([updated], companyId);
    attachSelfIban(user, updated.iban);
    res.json({ user });
  },
);

// ── POST /api/users/me/avatar ─────────────────────────────────
router.post('/me/avatar',
  authenticate,
  (req, res, next) => {
    const { upload } = require('../lib/uploads');
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Erreur upload.' });
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Fichier image requis.' });
    }
    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'Seules les images sont acceptées.' });
    }

    const companyId = getCompanyId(req);
    const file = await prisma.uploadedFile.create({
      data: {
        userId: req.user.id,
        companyId,
        originalName: req.file.originalname,
        storedName: req.file.filename,
        mimeType: req.file.mimetype,
        size: req.file.size,
        purpose: 'avatar',
      },
    });

    const apiBase = process.env.API_URL || 'http://localhost:3001';
    const avatarUrl = `${apiBase}/api/files/${file.id}`;

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { avatarUrl },
      select: USER_SELECT,
    });

    const [user] = await enrichUsers([updated], companyId);
    res.json({ user, fileId: file.id, avatarUrl });
  },
);

// ── POST /api/users/import ────────────────────────────────────
router.post('/import',
  authenticate,
  authorize(...MANAGER_ROLES),
  [body('csv').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const lines = req.body.csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      return res.status(400).json({ error: 'CSV vide ou sans données.' });
    }

    const header = lines[0].toLowerCase().split(/[,;]/).map((s) => s.trim());
    const idx = (name) => header.indexOf(name);

    const sites = await prisma.site.findMany({ where: { companyId, isActive: true } });
    const siteByName = new Map(sites.map((s) => [s.name.toLowerCase(), s.id]));

    const created = [];
    const errors = [];
    let emailsSent = 0;

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });
    const loginUrl = buildLoginUrl();

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(/[,;]/).map((s) => s.trim().replace(/^"|"$/g, ''));
      const firstName = cols[idx('firstname')] || cols[idx('prenom')] || cols[0];
      const lastName = cols[idx('lastname')] || cols[idx('nom')] || cols[1];
      const email = (cols[idx('email')] || cols[2] || '').toLowerCase();
      if (!firstName || !lastName || !email) {
        errors.push({ line: i + 1, error: 'Prénom, nom ou e-mail manquant.' });
        continue;
      }

      const inCompany = await findUserInCompany(email, companyId);
      if (inCompany?.isActive) {
        errors.push({ line: i + 1, email, error: 'Déjà dans votre entreprise.' });
        continue;
      }
      const existingElsewhere = await findUsersByEmail(email);
      if (existingElsewhere.length > 0 && !inCompany) {
        try {
          const profile = invitationProfileFromBody({
            firstName,
            lastName,
            role: USER_ROLES.includes(role) ? role : 'COLLABORATEUR',
            jobTitle,
            siteId,
            contractType: CONTRACT_TYPES.includes(contractType) ? contractType : 'CDI',
            weeklyHours: weeklyHours != null && !Number.isNaN(weeklyHours) ? weeklyHours : null,
            hourlyRate: hourlyRate != null && !Number.isNaN(hourlyRate) && hourlyRate > 0 ? hourlyRate : null,
          });
          const { acceptUrl } = await createCompanyInvitation({
            companyId,
            email,
            invitedById: req.user.id,
            profile,
          });
          await sendCompanyInviteEmail({
            to: email,
            firstName,
            companyName: company?.name,
            acceptUrl,
          }).catch(() => {});
          created.push({ email, firstName, lastName, invited: true });
          emailsSent += 1;
        } catch (err) {
          errors.push({ line: i + 1, email, error: err.message });
        }
        continue;
      }

      const siteName = cols[idx('site')] || cols[idx('etablissement')] || '';
      const siteId = siteByName.get(siteName.toLowerCase()) || null;
      const jobTitle = cols[idx('jobtitle')] || cols[idx('poste')] || null;
      const contractType = cols[idx('contracttype')] || cols[idx('contrat')] || 'CDI';
      const role = cols[idx('role')] || 'COLLABORATEUR';
      const weeklyHoursRaw = cols[idx('volume h')] || cols[idx('weeklyhours')] || cols[idx('volume_h')] || '';
      const hourlyRateRaw = cols[idx('taux horaire')] || cols[idx('hourlyrate')] || cols[idx('taux_horaire')] || '';
      const weeklyHours = weeklyHoursRaw ? parseFloat(weeklyHoursRaw.replace(',', '.')) : null;
      const hourlyRate = hourlyRateRaw ? parseFloat(hourlyRateRaw.replace(',', '.')) : null;

      try {
        const userPassword = generatePassword();
        const userPasswordHash = await bcrypt.hash(userPassword, 12);
        const user = await prisma.user.create({
          data: {
            email,
            passwordHash: userPasswordHash,
            firstName,
            lastName,
            role: USER_ROLES.includes(role) ? role : 'COLLABORATEUR',
            jobTitle,
            siteId,
            contractType: CONTRACT_TYPES.includes(contractType) ? contractType : 'CDI',
            weeklyHours: weeklyHours != null && !Number.isNaN(weeklyHours) ? weeklyHours : null,
            hourlyRate: hourlyRate != null && !Number.isNaN(hourlyRate) && hourlyRate > 0 ? hourlyRate : null,
            companyId,
            avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
          },
          select: { id: true, email: true, firstName: true, lastName: true },
        });
        created.push({ ...user, defaultPassword: userPassword });

        try {
          const emailResult = await sendUserInviteEmail({
            to: email,
            firstName,
            lastName,
            loginUrl,
            defaultPassword: userPassword,
            companyName: company?.name,
          });
          if (emailResult.sent) emailsSent += 1;
        } catch (mailErr) {
          console.warn(`[users/import] invite email failed for ${email}:`, mailErr.message);
        }
      } catch (err) {
        errors.push({ line: i + 1, email, error: err.message });
      }
    }

    res.status(201).json({
      created: created.length,
      emailsSent,
      errors,
      message: `${created.length} collaborateur(s) importé(s)${emailsSent ? `, ${emailsSent} invitation(s) envoyée(s)` : ''}${errors.length ? `, ${errors.length} erreur(s)` : ''}.`,
    });
  },
);

// ── POST /api/users/test-email — diagnostic envoi (RH / DRH / ADMIN) ─
router.post('/test-email',
  authenticate,
  authorize(...RH_PAY_ROLES),
  [body('to').optional().isEmail().normalizeEmail()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const to = req.body.to || req.user.email;
    const diag = mailDiagnostics();
    const verify = await verifyMailTransport();

    if (!verify.ok) {
      res.status(503).json({
        error: `Configuration e-mail invalide : ${verify.error}`,
        hint: 'Sur le VPS, vérifiez backend/.env (SMTP_USER, SMTP_PASS, EMAIL_FROM validé chez Mailjet).',
        diagnostics: diag,
        verify,
      });
      return;
    }

    try {
      const result = await sendMail({
        to,
        subject: 'Test Pulsiia — e-mail transactionnel',
        text: [
          'Ceci est un e-mail de test Pulsiia.',
          '',
          `Environnement : ${process.env.NODE_ENV || 'unknown'}`,
          `Date : ${new Date().toISOString()}`,
          `Expéditeur configuré : ${diag.from}`,
        ].join('\n'),
        html: `<p>Ceci est un <strong>e-mail de test Pulsiia</strong>.</p><p>Environnement : ${process.env.NODE_ENV}</p>`,
      });

      res.json({
        ok: result.sent,
        to,
        diagnostics: diag,
        verify,
        result,
        message: result.sent
          ? `E-mail de test envoyé à ${to} — vérifiez la boîte de réception et les spams.`
          : (result.message || 'E-mail non envoyé — voir les logs serveur.'),
      });
    } catch (err) {
      console.error('[users/test-email]', err);
      res.status(502).json({
        error: err.message,
        diagnostics: diag,
        verify,
        hint: 'Consultez Mailjet → Statistiques / logs pour voir si le message est bloqué ou rejeté.',
      });
    }
  },
);

// ── POST /api/users/resend-invites — renvoyer identifiants (lot) ─
router.post('/resend-invites',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    body('userIds').optional().isArray(),
    body('userIds.*').optional().isString(),
    body('siteIds').optional().isArray(),
    body('siteIds.*').optional().isString(),
    body('includeInactive').optional().isBoolean(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const { userIds, siteIds, includeInactive } = req.body;

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });

    let targets;

    if (userIds?.length) {
      const access = await assertAllCanManagePlanningUsers(req, userIds, companyId);
      if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
      }
      targets = await prisma.user.findMany({
        where: withCompany(companyId, {
          id: { in: access.userIds },
          ...(includeInactive ? {} : { isActive: true }),
        }),
        select: { id: true, email: true, firstName: true, lastName: true, isActive: true },
      });
    } else {
      let where = withCompany(companyId, {
        ...(includeInactive ? {} : { isActive: true }),
      });
      if (siteIds?.length) {
        where = { ...where, siteId: { in: siteIds } };
      }
      where = applyManagerUsersListScope(req, where);
      targets = await prisma.user.findMany({
        where,
        select: { id: true, email: true, firstName: true, lastName: true, isActive: true },
      });
    }

    if (!targets.length) {
      res.json({
        processed: 0,
        emailsSent: 0,
        results: [],
        message: 'Aucun collaborateur éligible.',
      });
      return;
    }

    const eligible = targets.filter((u) => u.isActive || includeInactive);
    const companyName = company?.name;

    const mailCheck = await verifyMailTransport();
    if (!mailCheck.ok) {
      res.status(503).json({
        error: `Envoi e-mail impossible : ${mailCheck.error}`,
        hint: 'Sur le VPS : SMTP_USER / SMTP_PASS Mailjet incorrects (health?mail=1 → 401).',
        mailVerify: mailCheck,
      });
      return;
    }

    // Réponse immédiate : nginx en prod coupe souvent à 60s (50+ e-mails ≈ 1–2 min).
    res.json({
      accepted: true,
      queued: eligible.length,
      async: true,
      message: `${eligible.length} invitation(s) en cours d'envoi. Les e-mails arrivent dans les prochaines minutes (vérifiez les spams).`,
    });

    setImmediate(async () => {
      try {
        const results = await resendInvitesInParallel(eligible, companyName);
        const emailsSent = results.filter((r) => r.emailSent).length;
        console.log(`[users] resend-invites background: ${emailsSent}/${results.length} e-mail(s) envoyé(s)`);
        if (emailsSent < results.length) {
          const failed = results.filter((r) => !r.emailSent);
          console.warn('[users] resend-invites sans e-mail:', failed.map((r) => r.email).join(', '));
        }
        await logAudit(req, {
          action: 'USER_INVITE_RESEND_BULK',
          metadata: {
            count: results.length,
            emailsSent,
            userIds: userIds?.length ? userIds : undefined,
            async: true,
          },
        });
      } catch (err) {
        console.error('[users] resend-invites background failed:', err);
      }
    });
  },
);

// ── POST /api/users/:id/resend-invite — renvoyer identifiants (1) ─
router.post('/:id/resend-invite',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const userId = req.params.id;

    const access = await assertCanManagePlanningUser(req, userId, companyId);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { id: userId, companyId },
      select: { id: true, email: true, firstName: true, lastName: true, isActive: true },
    });
    if (!user) {
      res.status(404).json({ error: 'Collaborateur introuvable.' });
      return;
    }
    if (!user.isActive) {
      res.status(400).json({ error: 'Impossible de renvoyer une invitation à un compte inactif.' });
      return;
    }

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });

    const mailCheck = await verifyMailTransport();
    if (!mailCheck.ok) {
      res.status(503).json({
        error: `Envoi e-mail impossible : ${mailCheck.error}`,
        hint: 'Sur le VPS : recopiez SMTP_USER et SMTP_PASS depuis Mailjet (API Key + Secret Key), puis pm2 reload.',
        mailVerify: mailCheck,
      });
      return;
    }

    const invite = await resendInviteForUser(user, company?.name);

    await logAudit(req, {
      action: 'USER_INVITE_RESEND',
      resource: userId,
      metadata: { email: user.email, emailSent: invite.emailSent },
    });

    if (!invite.emailSent) {
      res.status(502).json({
        error: invite.message || invite.error || 'E-mail non envoyé.',
        invite,
        hint: 'Vérifiez Mailjet (expéditeur validé) ou les logs : pm2 logs pulsiia-api',
      });
      return;
    }

    res.json({
      invite,
      message: `Invitation envoyée à ${user.email} — vérifiez la boîte de réception et les spams.`,
    });
  },
);

// ── GET /api/users/:id ────────────────────────────────────────
router.get('/:id',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const user = await fetchUserById(req.params.id, companyId);
    if (!user) {
      res.status(404).json({ error: 'Collaborateur introuvable.' });
      return;
    }
    res.json({ user });
  },
);

// ── POST /api/users ───────────────────────────────────────────
router.post('/',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    body('email').isEmail().normalizeEmail(),
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('role').optional().isIn(USER_ROLES),
    body('jobTitle').optional().isString(),
    body('phone').optional().isString(),
    body('siteId').optional({ nullable: true }).isString(),
    body('managerId').optional({ nullable: true }).isString(),
    body('contractType').optional().isIn(CONTRACT_TYPES),
    body('contractEndDate').optional({ nullable: true }).isISO8601(),
    body('weeklyHours').optional({ nullable: true }).isFloat({ min: 0, max: 80 }),
    body('hourlyRate').optional({ nullable: true }).isFloat({ min: 0, max: 999 }),
    body('competences').optional().isArray(),
    body('secondaryRoles').optional().isArray(),
    body('avatarColor').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const {
      email, firstName, lastName, role, jobTitle, phone,
      siteId, managerId, contractType, contractEndDate, weeklyHours, hourlyRate,
      competences, secondaryRoles, avatarColor,
    } = req.body;

    if (hourlyRate != null && !canEditHourlyRate(req.user.role)) {
      res.status(403).json({ error: 'Seuls les profils RH peuvent renseigner le taux horaire.' });
      return;
    }

    const inCompany = await findUserInCompany(email, companyId);
    if (inCompany?.isActive) {
      res.status(409).json({ error: 'Ce collaborateur fait déjà partie de votre entreprise.' });
      return;
    }

    if (inCompany && !inCompany.isActive) {
      await prisma.companyInvitation.updateMany({
        where: { companyId, email: email.toLowerCase(), status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      if (siteId) {
        const site = await ensureSiteInCompany(siteId, companyId);
        if (!site) {
          res.status(400).json({ error: 'Établissement invalide.' });
          return;
        }
      }
      if (managerId) {
        const manager = await ensureUserInCompany(managerId, companyId);
        if (!manager) {
          res.status(400).json({ error: 'Manager invalide.' });
          return;
        }
      }
      const color = avatarColor || inCompany.avatarColor || AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
      const reactivated = await prisma.user.update({
        where: { id: inCompany.id },
        data: {
          isActive: true,
          firstName,
          lastName,
          role: role || 'COLLABORATEUR',
          jobTitle: jobTitle || null,
          phone: phone || null,
          siteId: siteId || null,
          managerId: managerId || null,
          contractType: contractType || 'CDI',
          contractEndDate: contractEndDate ? new Date(contractEndDate) : null,
          weeklyHours: weeklyHours != null ? Number(weeklyHours) : null,
          hourlyRate: hourlyRate != null ? Number(hourlyRate) : null,
          competences: normalizeStringArray(competences),
          secondaryRoles: normalizeStringArray(secondaryRoles),
          avatarColor: color,
        },
        select: USER_SELECT,
      });
      const [user] = await enrichUsers([reactivated], companyId);
      await logAudit(req, { action: 'USER_REACTIVATE', resource: reactivated.id, metadata: { email } });
      res.status(200).json({
        user,
        reactivated: true,
        invite: { message: `${firstName} ${lastName} a été réactivé dans votre entreprise.` },
      });
      return;
    }

    const existingAccounts = await findUsersByEmail(email);
    if (existingAccounts.length > 0) {
      const sent = await inviteExistingAccountHolder(req, res, {
        companyId,
        email,
        firstName,
        lastName,
        profileExtras: {
          role, jobTitle, phone, siteId, managerId, contractType, contractEndDate,
          weeklyHours, hourlyRate, competences, secondaryRoles, avatarColor,
        },
      });
      if (sent) return;
    }

    if (siteId) {
      const site = await ensureSiteInCompany(siteId, companyId);
      if (!site) {
        res.status(400).json({ error: 'Établissement invalide.' });
        return;
      }
    }

    if (managerId) {
      const manager = await ensureUserInCompany(managerId, companyId);
      if (!manager) {
        res.status(400).json({ error: 'Manager invalide.' });
        return;
      }
    }

    const defaultPassword = generatePassword();
    const passwordHash = await bcrypt.hash(defaultPassword, 12);
    const color = avatarColor || AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

    const created = await prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName,
        lastName,
        role: role || 'COLLABORATEUR',
        jobTitle: jobTitle || null,
        phone: phone || null,
        siteId: siteId || null,
        managerId: managerId || null,
        contractType: contractType || 'CDI',
        contractEndDate: contractEndDate ? new Date(contractEndDate) : null,
        weeklyHours: weeklyHours != null ? Number(weeklyHours) : null,
        hourlyRate: hourlyRate != null ? Number(hourlyRate) : null,
        competences: normalizeStringArray(competences),
        secondaryRoles: normalizeStringArray(secondaryRoles),
        avatarColor: color,
        companyId,
      },
      select: USER_SELECT,
    });

    const [user] = await enrichUsers([created], companyId);

    await logAudit(req, {
      action: 'USER_CREATE',
      resource: created.id,
      metadata: { email, role: created.role },
    });

    const loginUrl = buildLoginUrl();
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });

    let emailResult = { sent: false, dev: true };
    try {
      emailResult = await sendUserInviteEmail({
        to: email,
        firstName,
        lastName,
        loginUrl,
        defaultPassword,
        companyName: company?.name,
      });
    } catch (mailErr) {
      console.error('[users] invite email failed:', mailErr.message);
      emailResult = { sent: false, error: mailErr.message };
    }
    if (emailResult.sent) {
      console.log(`[users] invitation envoyée → ${email}`);
    } else if (emailResult.dev) {
      console.warn(`[users] invitation NON envoyée (pas de SMTP/API) → ${email} · MDP: ${defaultPassword}`);
    }

    const invite = {
      email,
      loginUrl,
      defaultPassword,
      emailSent: emailResult.sent,
      message: emailResult.sent
        ? `Invitation envoyée à ${email}`
        : `Compte créé pour ${firstName} ${lastName}. E-mail : ${email} · Mot de passe temporaire : ${defaultPassword}${emailResult.dev ? ` (${emailResult.message || 'e-mail non envoyé — redémarrez le backend'})` : ''}`,
    };

    res.status(201).json({ user, defaultPassword, invite });
  },
);

// ── PATCH /api/users/:id ──────────────────────────────────────
router.patch('/:id',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    param('id').isString(),
    body('email').optional().isEmail().normalizeEmail(),
    body('firstName').optional().trim().notEmpty(),
    body('lastName').optional().trim().notEmpty(),
    body('role').optional().isIn(USER_ROLES),
    body('jobTitle').optional({ nullable: true }).isString(),
    body('phone').optional({ nullable: true }).isString(),
    body('siteId').optional({ nullable: true }).isString(),
    body('managerId').optional({ nullable: true }).isString(),
    body('contractType').optional().isIn(CONTRACT_TYPES),
    body('contractEndDate').optional({ nullable: true }).isISO8601(),
    body('weeklyHours').optional({ nullable: true }).isFloat({ min: 0, max: 80 }),
    body('hourlyRate').optional({ nullable: true }).isFloat({ min: 0, max: 999 }),
    body('competences').optional().isArray(),
    body('secondaryRoles').optional().isArray(),
    body('avatarColor').optional().isString(),
    body('isActive').optional().isBoolean(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const userId = req.params.id;

    const existing = await prisma.user.findFirst({
      where: { id: userId, companyId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Collaborateur introuvable.' });
      return;
    }

    if (req.body.hourlyRate !== undefined && !canEditHourlyRate(req.user.role)) {
      res.status(403).json({ error: 'Seuls les profils RH peuvent modifier le taux horaire.' });
      return;
    }

    const data = {};
    const fields = [
      'firstName', 'lastName', 'role', 'jobTitle', 'phone',
      'contractType', 'avatarColor',
    ];
    for (const f of fields) {
      if (req.body[f] !== undefined) data[f] = req.body[f];
    }

    if (req.body.email !== undefined) {
      const dup = await prisma.user.findFirst({
        where: {
          email: req.body.email,
          companyId,
          NOT: { id: userId },
        },
      });
      if (dup) {
        res.status(409).json({ error: 'Cet e-mail est déjà utilisé dans votre entreprise.' });
        return;
      }
      data.email = req.body.email;
    }

    if (req.body.weeklyHours !== undefined) {
      data.weeklyHours = req.body.weeklyHours == null ? null : Number(req.body.weeklyHours);
    }

    if (req.body.hourlyRate !== undefined) {
      data.hourlyRate = req.body.hourlyRate == null ? null : Number(req.body.hourlyRate);
    }

    if (req.body.contractEndDate !== undefined) {
      data.contractEndDate = req.body.contractEndDate ? new Date(req.body.contractEndDate) : null;
    }

    if (req.body.competences !== undefined) {
      data.competences = normalizeStringArray(req.body.competences);
    }
    if (req.body.secondaryRoles !== undefined) {
      data.secondaryRoles = normalizeStringArray(req.body.secondaryRoles);
    }

    if (req.body.siteId !== undefined) {
      if (req.body.siteId) {
        const site = await ensureSiteInCompany(req.body.siteId, companyId);
        if (!site) {
          res.status(400).json({ error: 'Établissement invalide.' });
          return;
        }
      }
      data.siteId = req.body.siteId || null;
    }

    if (req.body.managerId !== undefined) {
      if (req.body.managerId) {
        if (req.body.managerId === userId) {
          res.status(400).json({ error: 'Un collaborateur ne peut pas être son propre manager.' });
          return;
        }
        const manager = await ensureUserInCompany(req.body.managerId, companyId);
        if (!manager) {
          res.status(400).json({ error: 'Manager invalide.' });
          return;
        }
      }
      data.managerId = req.body.managerId || null;
    }

    if (req.body.isActive !== undefined) {
      data.isActive = !!req.body.isActive;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data,
      select: USER_SELECT,
    });

    const [user] = await enrichUsers([updated], companyId);

    await logAudit(req, {
      action: data.isActive === false ? 'USER_DEACTIVATE' : data.isActive === true ? 'USER_REACTIVATE' : 'USER_UPDATE',
      resource: userId,
      metadata: { fields: Object.keys(data) },
    });

    res.json({ user });
  },
);

// ── DELETE /api/users/:id (désactivation) ─────────────────────
router.delete('/:id',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const userId = req.params.id;

    if (userId === req.user.id) {
      res.status(400).json({ error: 'Vous ne pouvez pas désactiver votre propre compte.' });
      return;
    }

    const existing = await prisma.user.findFirst({
      where: { id: userId, companyId, isActive: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Collaborateur introuvable.' });
      return;
    }

    await prisma.$transaction([
      prisma.user.updateMany({
        where: { companyId, managerId: userId },
        data: { managerId: null },
      }),
      prisma.companyInvitation.updateMany({
        where: {
          companyId,
          email: existing.email.toLowerCase(),
          status: 'PENDING',
        },
        data: { status: 'CANCELLED' },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { isActive: false },
      }),
    ]);

    await logAudit(req, {
      action: 'USER_DEACTIVATE',
      resource: userId,
    });

    res.json({ ok: true });
  },
);

module.exports = router;
