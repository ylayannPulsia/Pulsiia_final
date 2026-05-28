// src/routes/company.js — Paramètres entreprise
const router = require('express').Router();
const { body } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { MANAGER_ROLES, ADMIN_ROLES } = require('../middleware/roles');
const { prisma, getCompanyId } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { logAudit } = require('../lib/audit');
const {
  normalizePlanningRules,
  CONTRACT_HOUR_PRESETS,
  DEFAULT_PLANNING_RULES,
} = require('../lib/labor-contract');

const DEFAULT_SETTINGS = {
  notifications: {
    planningRealtime: true,
    prepaieAuto: true,
    wellbeingWeekly: true,
    turnoverAi: false,
  },
  integrations: {
    silae: true,
    yousign: false,
  },
  planningRules: DEFAULT_PLANNING_RULES,
};

function normalizeSettings(raw) {
  const base = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
  return {
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(base.notifications || {}) },
    integrations: { ...DEFAULT_SETTINGS.integrations, ...(base.integrations || {}) },
    planningRules: normalizePlanningRules(base.planningRules),
  };
}

function formatSiret(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

async function fetchCompanySettings(companyId) {
  const [company, employeeCount] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        siret: true,
        convention: true,
        settings: true,
      },
    }),
    prisma.user.count({ where: { companyId, isActive: true } }),
  ]);

  if (!company) return null;

  return {
    id: company.id,
    name: company.name,
    siret: company.siret,
    convention: company.convention,
    employeeCount,
    settings: normalizeSettings(company.settings),
    contractHourPresets: CONTRACT_HOUR_PRESETS,
  };
}

router.get('/settings',
  authenticate,
  authorize(...MANAGER_ROLES),
  async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      const data = await fetchCompanySettings(companyId);
      if (!data) {
        res.status(404).json({ error: 'Entreprise introuvable.' });
        return;
      }
      res.json(data);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
    }
  },
);

router.patch('/settings',
  authenticate,
  authorize(...ADMIN_ROLES),
  [
    body('name').optional().trim().notEmpty().isLength({ max: 160 }),
    body('siret').optional({ nullable: true }).isString(),
    body('convention').optional({ nullable: true }).isString().isLength({ max: 200 }),
    body('settings').optional().isObject(),
    body('settings.notifications').optional().isObject(),
    body('settings.integrations').optional().isObject(),
    body('settings.planningRules').optional().isObject(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    try {
      const companyId = getCompanyId(req);
      const existing = await prisma.company.findUnique({
        where: { id: companyId },
        select: { settings: true },
      });
      if (!existing) {
        res.status(404).json({ error: 'Entreprise introuvable.' });
        return;
      }

      const data = {};
      if (req.body.name != null) data.name = String(req.body.name).trim();
      if (req.body.convention !== undefined) {
        data.convention = req.body.convention ? String(req.body.convention).trim() : null;
      }
      if (req.body.siret !== undefined) {
        const siret = formatSiret(req.body.siret);
        if (siret) {
          const siretDigits = siret.replace(/\s/g, '');
          const dup = await prisma.company.findFirst({
            where: { siret: siretDigits, NOT: { id: companyId } },
          });
          if (dup) {
            res.status(409).json({ error: 'Ce SIRET est déjà utilisé par une autre entreprise.' });
            return;
          }
        }
        data.siret = siret ? siret.replace(/\s/g, '') : null;
      }
      if (req.body.settings != null) {
        const current = normalizeSettings(existing.settings);
        const incoming = req.body.settings;
        const mergedPlanning = incoming.planningRules != null
          ? normalizePlanningRules({ ...current.planningRules, ...incoming.planningRules })
          : current.planningRules;
        data.settings = normalizeSettings({
          notifications: { ...current.notifications, ...(incoming.notifications || {}) },
          integrations: { ...current.integrations, ...(incoming.integrations || {}) },
          planningRules: mergedPlanning,
        });
      }

      await prisma.company.update({ where: { id: companyId }, data });
      const updated = await fetchCompanySettings(companyId);

      await logAudit(req, {
        action: 'company.settings_update',
        resource: `company:${companyId}`,
        metadata: { fields: Object.keys(data) },
      });

      res.json(updated);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Erreur serveur.' });
    }
  },
);

module.exports = router;
