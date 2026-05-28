// src/routes/reports.js — Rapports ROI (données réelles)
const router = require('express').Router();
const { query } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { MANAGER_ROLES } = require('../middleware/roles');
const { getCompanyId } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const {
  computeRoiReport,
  resolveRoiScope,
  buildExportCsv,
  buildRoiCompletCsv,
} = require('../lib/roi-engine');
const { buildRoiCompletPdf } = require('../lib/roi-pdf');

const REPORT_TYPE_MAP = {
  'roi-mensuel': 'roi-mensuel',
  'roi-complet': 'roi-complet',
  roi: 'roi-mensuel',
  absenteisme: 'absenteisme',
  turnover: 'turnover',
  'bien-etre': 'bien-etre',
  bienetre: 'bien-etre',
  'heures-sup': 'heures-sup',
  'heures-supplementaires': 'heures-sup',
  prepaie: 'prepaie',
};

const FORMAT_EXT = { csv: 'csv', excel: 'xls', pdf: 'pdf' };

function exportFilename(type, period, format = 'csv') {
  const safe = type.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const ext = FORMAT_EXT[format] || 'csv';
  return `pulsiia-rapport-${safe}-${period}.${ext}`;
}

// ── GET /api/reports/roi ────────────────────────────────────────
router.get('/roi',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    query('months').optional().isInt({ min: 3, max: 12 }).withMessage('months entre 3 et 12'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const scope = await resolveRoiScope(req, companyId);
    if (scope.forbidden) {
      return res.status(scope.status).json({ error: scope.error });
    }

    const months = parseInt(req.query.months, 10) || 6;
    const report = await computeRoiReport(companyId, scope.userIds, months);

    res.json({
      ...report,
      managerScope: scope.managerScope,
      siteId: scope.siteId || null,
    });
  },
);

// ── GET /api/reports/roi/export ─────────────────────────────────
router.get('/roi/export',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    query('type').notEmpty().withMessage('Type de rapport requis'),
    query('period').optional().matches(/^\d{4}-\d{2}$/).withMessage('Période AAAA-MM'),
    query('format').optional().isIn(['csv', 'excel', 'pdf']).withMessage('format: csv, excel ou pdf'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const scope = await resolveRoiScope(req, companyId);
    if (scope.forbidden) {
      return res.status(scope.status).json({ error: scope.error });
    }

    const rawType = String(req.query.type).toLowerCase();
    const type = REPORT_TYPE_MAP[rawType] || rawType;
    const period = req.query.period || new Date().toISOString().slice(0, 7);
    const format = String(req.query.format || 'csv').toLowerCase();
    const filename = exportFilename(type, period, format);

    if (format === 'pdf' || type === 'roi-complet') {
      const months = 6;
      const report = await computeRoiReport(companyId, scope.userIds, months);
      const effectivePeriod = period || report.period;

      if (format === 'pdf') {
        const pdf = buildRoiCompletPdf(
          { ...report, period: effectivePeriod },
          { managerScope: scope.managerScope },
        );
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${exportFilename('roi-complet', effectivePeriod, 'pdf')}"`);
        return res.send(pdf);
      }

      const csv = buildRoiCompletCsv({ ...report, period: effectivePeriod, managerScope: scope.managerScope });
      const contentType = format === 'excel'
        ? 'application/vnd.ms-excel; charset=utf-8'
        : 'text/csv; charset=utf-8';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${exportFilename('roi-complet', effectivePeriod, format)}"`);
      return res.send('\ufeff' + csv);
    }

    const csv = await buildExportCsv(companyId, scope.userIds, type, period);
    const contentType = format === 'excel'
      ? 'application/vnd.ms-excel; charset=utf-8'
      : 'text/csv; charset=utf-8';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(type, period, format)}"`);
    res.send('\ufeff' + csv);
  },
);

module.exports = router;
