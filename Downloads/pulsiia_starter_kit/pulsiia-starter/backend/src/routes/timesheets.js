// src/routes/timesheets.js — Feuilles d'heures & signature eIDAS (Yousign)
const fs = require('fs');
const router = require('express').Router();
const { body, param, query } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { MANAGER_ROLES, RH_PAY_ROLES } = require('../middleware/roles');
const {
  prisma,
  getCompanyId,
  withCompany,
  ensureUserInCompany,
} = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { logAudit } = require('../lib/audit');
const { filePath } = require('../lib/uploads');
const yousign = require('../lib/yousign');
const tsSvc = require('../lib/timesheet-service');
const {
  buildPrepaieVariablesWhere,
  isManagerRole,
} = require('../lib/planning-scope');

const USER_INCLUDE = {
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      siteId: true,
      site: { select: { id: true, name: true } },
    },
  },
};

const {
  WEEK_PERIOD_REGEX,
  currentPeriod,
} = require('../lib/period-utils');

async function findSheetInScope(req, id, companyId) {
  const sheet = await prisma.timesheetSheet.findFirst({
    where: withCompany(companyId, { id }),
    include: USER_INCLUDE,
  });
  if (!sheet) return null;

  if (req.user.role === 'COLLABORATEUR' && sheet.userId !== req.user.id) {
    return null;
  }

  if (isManagerRole(req.user.role) && req.user.role === 'MANAGER') {
    const subIds = await prisma.user.findMany({
      where: { companyId, managerId: req.user.id, isActive: true },
      select: { id: true },
    });
    const allowed = new Set([req.user.id, ...subIds.map((s) => s.id)]);
    if (!allowed.has(sheet.userId)) return null;
  }

  return sheet;
}

async function listEligibleUserIds(req, companyId, period) {
  if (req.user.role === 'COLLABORATEUR') {
    return [req.user.id];
  }

  const where = buildPrepaieVariablesWhere(req, companyId, { period });
  const rows = await prisma.payVariable.findMany({
    where,
    select: { userId: true },
    distinct: ['userId'],
  });

  return [...new Set(rows.map((r) => r.userId))];
}

router.get('/',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    query('period').optional().matches(WEEK_PERIOD_REGEX).withMessage('Période invalide (YYYY-MM-DD).'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const period = req.query.period || currentPeriod();

    const userIds = await listEligibleUserIds(req, companyId, period);
    const sheets = userIds.length
      ? await prisma.timesheetSheet.findMany({
        where: { companyId, period, userId: { in: userIds } },
        include: USER_INCLUDE,
        orderBy: { user: { lastName: 'asc' } },
      })
      : [];

    const byUser = new Map(sheets.map((s) => [s.userId, s]));
    const items = [];

    for (const userId of userIds) {
      const sheet = byUser.get(userId);
      if (sheet) {
        items.push(tsSvc.serializeSheet(sheet));
      } else {
        const u = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            site: { select: { name: true } },
          },
        });
        if (!u) continue;
        items.push({
          id: null,
          userId: u.id,
          collab: `${u.firstName} ${u.lastName.charAt(0)}.`,
          collabFull: `${u.firstName} ${u.lastName}`,
          site: u.site?.name || '—',
          period,
          reference: null,
          status: 'Non générée',
          statusCode: 'NONE',
          generatedAt: null,
          signedAt: null,
          signatureProvider: null,
          signatureStatus: null,
          signatureLink: null,
          hasFile: false,
        });
      }
    }

    res.json({
      period,
      signatureProvider: yousign.PROVIDER_NAME,
      signatureConfigured: yousign.isConfigured(),
      summary: {
        total: items.length,
        signed: items.filter((i) => i.statusCode === 'SIGNE').length,
        pending: items.filter((i) => i.statusCode === 'EN_ATTENTE_SIGNATURE').length,
        draft: items.filter((i) => ['BROUILLON', 'NONE'].includes(i.statusCode)).length,
      },
      timesheets: items,
    });
  },
);

router.get('/mine',
  authenticate,
  [
    query('period').optional().matches(WEEK_PERIOD_REGEX).withMessage('Période invalide (YYYY-MM-DD).'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const period = req.query.period || currentPeriod();

    const sheet = await prisma.timesheetSheet.findUnique({
      where: {
        companyId_userId_period: {
          companyId,
          userId: req.user.id,
          period,
        },
      },
      include: USER_INCLUDE,
    });

    res.json({
      period,
      signatureConfigured: yousign.isConfigured(),
      timesheet: sheet ? tsSvc.serializeSheet(sheet) : null,
    });
  },
);

router.post('/generate',
  authenticate,
  authorize(...RH_PAY_ROLES),
  [
    body('period').optional().matches(WEEK_PERIOD_REGEX).withMessage('Période invalide (YYYY-MM-DD).'),
    body('userIds').optional().isArray(),
    body('userIds.*').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const period = req.body.period || currentPeriod();
    let userIds = req.body.userIds;

    if (!userIds?.length) {
      userIds = await listEligibleUserIds(req, companyId, period);
    } else {
      for (const uid of userIds) {
        const ok = await ensureUserInCompany(uid, companyId);
        if (!ok) {
          return res.status(400).json({ error: 'Collaborateur hors entreprise.' });
        }
      }
    }

    const results = [];
    for (const userId of userIds) {
      try {
        const sheet = await tsSvc.generateTimesheetSheet({
          companyId,
          userId,
          period,
          generatedBy: req.user.id,
        });
        results.push({ userId, ok: true, timesheet: tsSvc.serializeSheet(sheet) });
      } catch (err) {
        results.push({ userId, ok: false, error: err.message });
      }
    }

    await logAudit(req, {
      action: 'timesheet.generate',
      resource: `period:${period}`,
      metadata: { period, count: results.filter((r) => r.ok).length },
    });

    res.json({
      period,
      generated: results.filter((r) => r.ok).length,
      results,
      message: `${results.filter((r) => r.ok).length} feuille(s) d'heures générée(s).`,
    });
  },
);

router.post('/send-signatures',
  authenticate,
  authorize(...RH_PAY_ROLES),
  [
    body('period').optional().matches(WEEK_PERIOD_REGEX).withMessage('Période invalide (YYYY-MM-DD).'),
    body('userIds').optional().isArray(),
    body('userIds.*').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const period = req.body.period || currentPeriod();
    const userIds = req.body.userIds;

    const where = { companyId, period, storedName: { not: null } };
    if (userIds?.length) where.userId = { in: userIds };

    const sheets = await prisma.timesheetSheet.findMany({
      where,
      include: USER_INCLUDE,
    });

    const results = [];
    for (const sheet of sheets) {
      if (sheet.status === 'SIGNE') {
        results.push({ id: sheet.id, ok: false, error: 'Déjà signée.' });
        continue;
      }
      if (sheet.signatureRequestId && sheet.status === 'EN_ATTENTE_SIGNATURE') {
        results.push({ id: sheet.id, ok: false, error: 'Signature déjà en cours.' });
        continue;
      }
      try {
        const sig = await tsSvc.initiateTimesheetSignature(sheet);
        if (sig.skipped) {
          results.push({ id: sheet.id, ok: false, error: sig.reason });
        } else {
          results.push({ id: sheet.id, ok: true, timesheet: tsSvc.serializeSheet(sig.sheet) });
        }
      } catch (err) {
        results.push({ id: sheet.id, ok: false, error: err.message });
      }
    }

    await logAudit(req, {
      action: 'timesheet.signature_batch',
      resource: `period:${period}`,
      metadata: { period, sent: results.filter((r) => r.ok).length },
    });

    res.json({
      period,
      sent: results.filter((r) => r.ok).length,
      results,
      provider: yousign.PROVIDER_NAME,
      eidas: true,
      message: results.filter((r) => r.ok).length
        ? 'Procédures Yousign lancées — e-mails envoyés aux collaborateurs.'
        : 'Aucune signature lancée. Générez d\'abord les feuilles d\'heures.',
    });
  },
);

router.post('/:id/signature',
  authenticate,
  authorize(...RH_PAY_ROLES),
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const sheet = await findSheetInScope(req, req.params.id, companyId);
    if (!sheet) {
      return res.status(404).json({ error: 'Feuille d\'heures introuvable.' });
    }

    try {
      const sig = await tsSvc.initiateTimesheetSignature(sheet);
      if (sig.skipped) {
        return res.status(400).json({ error: sig.reason });
      }
      await logAudit(req, {
        action: 'timesheet.signature_start',
        resource: `timesheet:${sheet.id}`,
        subjectUserId: sheet.userId,
        metadata: { period: sheet.period, provider: 'yousign' },
      });
      res.json({
        timesheet: tsSvc.serializeSheet(sig.sheet),
        signature: sig.procedure,
        provider: yousign.PROVIDER_NAME,
        eidas: true,
      });
    } catch (err) {
      res.status(400).json({
        error: err.message || 'Impossible de démarrer la signature Yousign.',
        provider: yousign.PROVIDER_NAME,
      });
    }
  },
);

router.get('/:id/signature/status',
  authenticate,
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    let sheet = await findSheetInScope(req, req.params.id, companyId);
    if (!sheet) {
      return res.status(404).json({ error: 'Feuille d\'heures introuvable.' });
    }

    sheet = await tsSvc.syncTimesheetSignature(sheet);
    res.json({ timesheet: tsSvc.serializeSheet(sheet) });
  },
);

router.post('/:id/remind',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const sheet = await findSheetInScope(req, req.params.id, companyId);
    if (!sheet) {
      return res.status(404).json({ error: 'Feuille d\'heures introuvable.' });
    }

    if (sheet.status !== 'EN_ATTENTE_SIGNATURE') {
      return res.status(400).json({ error: 'Aucune signature en attente pour cette feuille.' });
    }

    const result = await tsSvc.sendTimesheetReminder(sheet);
    if (!result.sent) {
      return res.status(400).json({ error: result.reason });
    }

    res.json({ message: 'Rappel de signature envoyé par e-mail.' });
  },
);

router.get('/:id/file',
  authenticate,
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const sheet = await findSheetInScope(req, req.params.id, companyId);
    if (!sheet?.storedName) {
      return res.status(404).json({ error: 'Fichier introuvable.' });
    }

    const disk = filePath(sheet.storedName);
    if (!fs.existsSync(disk)) {
      return res.status(404).json({ error: 'Fichier PDF absent sur le serveur.' });
    }

    const filename = `feuille_heures_${sheet.period}_${sheet.user?.lastName || 'collab'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(disk).pipe(res);
  },
);

module.exports = router;
