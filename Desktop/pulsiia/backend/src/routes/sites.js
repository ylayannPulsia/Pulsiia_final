'use strict';

const { Router } = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { authenticate, requireRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { ValidationError, NotFoundError } = require('../utils/errors');

const router = Router();
router.use(authenticate);

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(new ValidationError(result.error.errors[0].message));
    req.body = result.data;
    next();
  };
}

const siteSchema = z.object({
  name: z.string().min(2).max(120),
  city: z.string().max(80).optional(),
  address: z.string().max(200).optional(),
  isHQ: z.boolean().default(false),
});

// ─── GET /api/sites ───────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const sites = await prisma.site.findMany({
      where: { companyId },
      include: {
        _count: { select: { users: true } },
      },
      orderBy: [{ isHQ: 'desc' }, { name: 'asc' }],
    });
    res.json({ sites });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/sites/:id ───────────────────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const site = await prisma.site.findFirst({
      where: { id: req.params.id, companyId },
      include: {
        users: {
          select: { id: true, firstName: true, lastName: true, role: true, isActive: true },
          where: { isActive: true },
          orderBy: [{ lastName: 'asc' }],
        },
      },
    });
    if (!site) return next(new NotFoundError('Site introuvable'));
    res.json(site);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/sites ──────────────────────────────────────────────────────────

router.post('/', requireRole('DRH'), validate(siteSchema), audit('site.create'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const { name, city, address, isHQ } = req.body;

    // Un seul siège possible
    if (isHQ) {
      const existingHQ = await prisma.site.findFirst({ where: { companyId, isHQ: true } });
      if (existingHQ) {
        return next(new ValidationError('Un siège social existe déjà. Retirez d\'abord le statut siège à l\'autre établissement.'));
      }
    }

    const site = await prisma.site.create({
      data: { companyId, name, city, address, isHQ },
    });

    res.status(201).json(site);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/sites/:id ─────────────────────────────────────────────────────

router.patch('/:id', requireRole('DRH'), validate(siteSchema.partial()), audit('site.update'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const existing = await prisma.site.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return next(new NotFoundError('Site introuvable'));

    if (req.body.isHQ && !existing.isHQ) {
      const existingHQ = await prisma.site.findFirst({ where: { companyId, isHQ: true } });
      if (existingHQ) {
        return next(new ValidationError('Un siège social existe déjà.'));
      }
    }

    const site = await prisma.site.update({ where: { id: req.params.id }, data: req.body });
    res.json(site);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/sites/:id ────────────────────────────────────────────────────

router.delete('/:id', requireRole('DRH'), audit('site.delete'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const existing = await prisma.site.findFirst({
      where: { id: req.params.id, companyId },
      include: { _count: { select: { users: true } } },
    });
    if (!existing) return next(new NotFoundError('Site introuvable'));
    if (existing._count.users > 0) {
      return next(new ValidationError('Impossible de supprimer un site qui a des collaborateurs assignés'));
    }

    await prisma.site.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
