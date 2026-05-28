// src/routes/sites.js — Établissements
const router = require('express').Router();
const { body, param } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { MANAGER_ROLES, ADMIN_ROLES } = require('../middleware/roles');
const { prisma, getCompanyId, withCompany } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { logAudit } = require('../lib/audit');

router.get('/',
  authenticate,
  authorize(...MANAGER_ROLES),
  async (req, res) => {
    const companyId = getCompanyId(req);
    const sites = await prisma.site.findMany({
      where: withCompany(companyId, { isActive: true }),
      select: { id: true, name: true, city: true, address: true, postalCode: true },
      orderBy: { name: 'asc' },
    });
    res.json({ sites });
  },
);

router.post('/',
  authenticate,
  authorize(...ADMIN_ROLES),
  [
    body('name').trim().notEmpty().isLength({ max: 120 }),
    body('city').optional().isString(),
    body('address').optional().isString(),
    body('postalCode').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const name = String(req.body.name).trim();

    const dup = await prisma.site.findFirst({
      where: { companyId, name: { equals: name, mode: 'insensitive' } },
    });
    if (dup) {
      res.status(409).json({ error: 'Un établissement avec ce nom existe déjà.' });
      return;
    }

    const site = await prisma.site.create({
      data: {
        companyId,
        name,
        city: req.body.city?.trim() || null,
        address: req.body.address?.trim() || null,
        postalCode: req.body.postalCode?.trim() || null,
      },
      select: { id: true, name: true, city: true, address: true, postalCode: true },
    });

    await logAudit(req, { action: 'SITE_CREATE', resource: site.id, metadata: { name } });
    res.status(201).json({ site });
  },
);

router.patch('/:id',
  authenticate,
  authorize(...ADMIN_ROLES),
  [
    param('id').isString(),
    body('name').optional().trim().notEmpty(),
    body('city').optional({ nullable: true }).isString(),
    body('isActive').optional().isBoolean(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const existing = await prisma.site.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Établissement introuvable.' });
      return;
    }

    const data = {};
    if (req.body.name !== undefined) data.name = req.body.name.trim();
    if (req.body.city !== undefined) data.city = req.body.city || null;
    if (req.body.isActive !== undefined) data.isActive = req.body.isActive;

    const site = await prisma.site.update({
      where: { id: existing.id },
      data,
      select: { id: true, name: true, city: true, address: true, postalCode: true, isActive: true },
    });

    await logAudit(req, { action: 'SITE_UPDATE', resource: site.id });
    res.json({ site });
  },
);

module.exports = router;
