// src/routes/audit.js — Historique des actions (AuditLog)
const router = require('express').Router();
const { query } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { MANAGER_ROLES } = require('../middleware/roles');
const { prisma, getCompanyId } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const {
  applyAuditScopeToWhere,
  buildCategoryActionFilter,
  getAuditScopeMeta,
} = require('../lib/audit-scope');

const ACTION_LABELS = {
  'auth.login': 'Connexion',
  'pay_variable.create': 'Variable créée',
  'pay_variable.update': 'Variable modifiée',
  'pay_variable.sync': 'Sync planning → pré-paie',
  'pay_variable.period_lock': 'Clôture période pré-paie',
  'pay_variable.period_unlock': 'Réouverture période pré-paie',
  'pay_variable.validate': 'Variable validée',
  'pay_variable.unvalidate': 'Validation annulée',
  'pay_variable.reject': 'Variable rejetée',
  'pay_variable.delete': 'Variable supprimée',
  'pay_variable.validate_all': 'Validation en masse',
  'pay_variable.export': 'Export pré-paie',
  'absence.create': 'Demande d\'absence',
  'absence.approve': 'Absence approuvée',
  'absence.refuse': 'Absence refusée',
  'absence.cancel': 'Absence annulée',
  'shift.create': 'Shift créé',
  'shift.update': 'Shift modifié',
  'shift.delete': 'Shift supprimé',
  'planning.publish': 'Planning publié',
  'planning_ai.generate': 'Planning IA généré',
  'planning_ai.validate': 'Planning IA validé',
  'planning_ai.publish': 'Planning IA publié',
  'planning_ai.delete': 'Planning IA supprimé',
  USER_INVITE_RESEND: 'Invitation renvoyée',
  USER_INVITE_RESEND_BULK: 'Invitations renvoyées (lot)',
};

function formatLog(log, userMap) {
  const user = log.userId ? userMap[log.userId] : null;
  const userName = user
    ? `${user.firstName} ${user.lastName}`
    : (log.userId ? 'Utilisateur inconnu' : 'Système');

  return {
    id: log.id,
    action: log.action,
    actionLabel: ACTION_LABELS[log.action] || log.action,
    resource: log.resource,
    metadata: log.metadata,
    createdAt: log.createdAt,
    userId: log.userId,
    userName,
    userInitials: user
      ? `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.toUpperCase()
      : (log.userId ? '?' : '—'),
    ipAddress: log.ipAddress,
  };
}

function buildDescription(log) {
  const m = log.metadata || {};
  const parts = [];

  if (m.collab) parts.push(m.collab);
  if (m.type) parts.push(m.type);
  if (m.period) parts.push(m.period);
  if (m.absenceType) parts.push(m.absenceType);
  if (m.date) parts.push(m.date);
  if (m.shiftType) parts.push(m.shiftType);
  if (m.count != null) parts.push(`${m.count} élément(s)`);
  if (m.format) parts.push(`format ${m.format}`);
  if (m.reason) parts.push(`motif : ${m.reason}`);

  return parts.join(' · ') || log.resource || '—';
}

// ── GET /api/audit ──────────────────────────────────────────────
router.get('/',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    query('action').optional().isString(),
    query('category').optional().isIn(['prepaie', 'absence', 'planning', 'auth', 'all']),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const skip = (page - 1) * limit;

    const filters = [{ companyId }];

    if (req.query.action) {
      filters.push({ action: req.query.action });
    } else {
      const categoryFilter = buildCategoryActionFilter(req.query.category);
      if (categoryFilter) filters.push(categoryFilter);
    }

    if (req.query.from || req.query.to) {
      const createdAt = {};
      if (req.query.from) createdAt.gte = new Date(req.query.from);
      if (req.query.to) createdAt.lte = new Date(req.query.to);
      filters.push({ createdAt });
    }

    let where = filters.length === 1 ? filters[0] : { AND: filters };
    where = await applyAuditScopeToWhere(req, companyId, where);

    const scopeMeta = await getAuditScopeMeta(req, companyId);

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    const userIds = [...new Set(logs.map((l) => l.userId).filter(Boolean))];
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds }, companyId },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

    const items = logs.map((log) => {
      const formatted = formatLog(log, userMap);
      return { ...formatted, description: buildDescription(formatted) };
    });

    res.json({
      logs: items,
      scope: scopeMeta,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
      actionLabels: ACTION_LABELS,
    });
  }
);

module.exports = router;
