'use strict';

const { Router } = require('express');
const { z } = require('zod');
const bcrypt = require('bcrypt');
const prisma = require('../lib/prisma');
const { authenticate, requireRole, requireSelfOrRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

const router = Router();
router.use(authenticate);

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 12);

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(new ValidationError(result.error.errors[0].message));
    req.body = result.data;
    next();
  };
}

const createSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  role: z.enum(['COLLABORATEUR', 'MANAGER', 'RH', 'DRH']).default('COLLABORATEUR'),
  primarySiteId: z.string().cuid().optional(),
  jobTitle: z.string().max(100).optional(),
  phone: z.string().max(20).optional(),
  password: z.string().min(8).optional(),
});

const patchSchema = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  role: z.enum(['COLLABORATEUR', 'MANAGER', 'RH', 'DRH']).optional(),
  primarySiteId: z.string().cuid().nullable().optional(),
  jobTitle: z.string().max(100).nullable().optional(),
  phone: z.string().max(20).nullable().optional(),
  isActive: z.boolean().optional(),
});

// ─── GET /api/users — liste ───────────────────────────────────────────────────

router.get('/', requireRole('MANAGER'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const { role, siteId, isActive, search, page = '1', limit = '50' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where = { companyId };
    if (role) where.role = role;
    if (siteId) where.primarySiteId = siteId;
    if (isActive !== undefined) where.isActive = isActive === 'true';
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, email: true, firstName: true, lastName: true, role: true,
          isActive: true, jobTitle: true, phone: true, lastLoginAt: true,
          primarySite: { select: { id: true, name: true, city: true } },
          createdAt: true,
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        skip,
        take: Number(limit),
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/users/:userId ───────────────────────────────────────────────────

router.get('/:userId', requireSelfOrRole('userId', 'MANAGER'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const user = await prisma.user.findFirst({
      where: { id: req.params.userId, companyId },
      select: {
        id: true, email: true, firstName: true, lastName: true, role: true,
        isActive: true, jobTitle: true, phone: true, lastLoginAt: true,
        totpEnabled: true, createdAt: true, updatedAt: true,
        primarySite: { select: { id: true, name: true, city: true } },
      },
    });
    if (!user) return next(new NotFoundError('Utilisateur introuvable'));
    res.json(user);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/users — créer un utilisateur ───────────────────────────────────

router.post('/', requireRole('DRH'), validate(createSchema), audit('user.create'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const { email, firstName, lastName, role, primarySiteId, jobTitle, phone, password } = req.body;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return next(new ConflictError('Cet email est déjà utilisé'));

    const passwordHash = password ? await bcrypt.hash(password, SALT_ROUNDS) : null;

    const user = await prisma.user.create({
      data: { companyId, email, firstName, lastName, role, primarySiteId, jobTitle, phone, passwordHash, isActive: true },
      select: {
        id: true, email: true, firstName: true, lastName: true, role: true,
        isActive: true, jobTitle: true, phone: true, createdAt: true,
      },
    });

    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/users/:userId ─────────────────────────────────────────────────

router.patch('/:userId', requireRole('RH'), validate(patchSchema), audit('user.update'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const existing = await prisma.user.findFirst({ where: { id: req.params.userId, companyId } });
    if (!existing) return next(new NotFoundError('Utilisateur introuvable'));

    const user = await prisma.user.update({
      where: { id: req.params.userId },
      data: req.body,
      select: {
        id: true, email: true, firstName: true, lastName: true, role: true,
        isActive: true, jobTitle: true, phone: true, updatedAt: true,
      },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/users/:userId — désactiver (soft delete) ────────────────────

router.delete('/:userId', requireRole('DRH'), audit('user.deactivate'), async (req, res, next) => {
  try {
    const { companyId, id: callerId } = req.user;
    if (req.params.userId === callerId) return next(new ValidationError('Vous ne pouvez pas vous désactiver vous-même'));

    const existing = await prisma.user.findFirst({ where: { id: req.params.userId, companyId } });
    if (!existing) return next(new NotFoundError('Utilisateur introuvable'));

    await prisma.user.update({ where: { id: req.params.userId }, data: { isActive: false } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
