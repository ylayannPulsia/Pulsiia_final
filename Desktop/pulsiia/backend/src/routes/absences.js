'use strict';

const { Router } = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { authenticate, requireRole, requireSelfOrRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

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

const absenceSchema = z.object({
  userId: z.string().cuid().optional(), // optionnel : si absent, = soi-même
  siteId: z.string().cuid().optional(),
  type: z.enum(['CP', 'RTT', 'MALADIE', 'MATERNITE', 'PATERNITE', 'ENFANT_MALADE', 'CONGE_SANS_SOLDE', 'FORMATION', 'ACCIDENT_TRAVAIL', 'EVENEMENT_FAMILIAL', 'AUTRE']),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().max(500).optional(),
});

const statusSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  rejectReason: z.string().max(500).optional(),
});

// ─── GET /api/absences — liste ────────────────────────────────────────────────
// ?userId=... &status=... &type=... &from=... &to=...

router.get('/', async (req, res, next) => {
  try {
    const { companyId, role, id: callerId } = req.user;
    const { userId, status, type, from, to, page = '1', limit = '50' } = req.query;
    const MANAGERS = ['MANAGER', 'RH', 'DRH', 'ADMIN'];
    const isManager = MANAGERS.includes(role);

    const where = { companyId };
    if (!isManager) {
      where.userId = callerId;
    } else {
      if (userId) where.userId = userId;
    }
    if (status) where.status = status;
    if (type) where.type = type;
    if (from || to) {
      where.startsAt = {};
      if (from) where.startsAt.gte = new Date(from);
      if (to) where.startsAt.lte = new Date(to);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [absences, total] = await Promise.all([
      prisma.absence.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, role: true } },
          validatedBy: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { startsAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.absence.count({ where }),
    ]);

    res.json({ absences, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/absences/stats/summary — stats pour dashboard ──────────────────

router.get('/stats/summary', requireRole('MANAGER'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const [byStatus, byType, pending] = await Promise.all([
      prisma.absence.groupBy({
        by: ['status'],
        where: { companyId, startsAt: { gte: monthStart, lt: monthEnd } },
        _count: true,
      }),
      prisma.absence.groupBy({
        by: ['type'],
        where: { companyId, startsAt: { gte: monthStart, lt: monthEnd } },
        _count: true,
      }),
      prisma.absence.count({ where: { companyId, status: 'PENDING' } }),
    ]);

    res.json({ byStatus, byType, pendingCount: pending });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/absences — créer une absence ───────────────────────────────────

router.post('/', validate(absenceSchema), audit('absence.create'), async (req, res, next) => {
  try {
    const { companyId, role, id: callerId } = req.user;
    const MANAGERS = ['MANAGER', 'RH', 'DRH', 'ADMIN'];
    const isManager = MANAGERS.includes(role);

    let targetUserId = req.body.userId || callerId;
    // Un collaborateur ne peut créer une absence que pour lui-même
    if (!isManager && targetUserId !== callerId) {
      return next(new ForbiddenError('Vous ne pouvez créer une absence que pour vous-même'));
    }

    const start = new Date(req.body.startsAt);
    const end = new Date(req.body.endsAt);
    if (end < start) return next(new ValidationError('endsAt doit être après startsAt'));

    // Vérifier la cible
    const targetUser = await prisma.user.findFirst({ where: { id: targetUserId, companyId } });
    if (!targetUser) return next(new NotFoundError('Utilisateur introuvable'));

    const absence = await prisma.absence.create({
      data: {
        companyId,
        userId: targetUserId,
        siteId: req.body.siteId || targetUser.primarySiteId || null,
        type: req.body.type,
        startsAt: start,
        endsAt: end,
        reason: req.body.reason,
        status: 'PENDING',
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    res.status(201).json(absence);
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/absences/:id/status — approuver/refuser ────────────────────────

router.put('/:id/status', requireRole('MANAGER'), validate(statusSchema), audit('absence.status'), async (req, res, next) => {
  try {
    const { companyId, id: callerId } = req.user;
    const { status, rejectReason } = req.body;

    const absence = await prisma.absence.findFirst({ where: { id: req.params.id, companyId } });
    if (!absence) return next(new NotFoundError('Absence introuvable'));
    if (absence.status !== 'PENDING') {
      return next(new ValidationError('Seules les absences en attente peuvent être traitées'));
    }

    if (status === 'REJECTED' && !rejectReason) {
      return next(new ValidationError('Un motif de refus est requis'));
    }

    const updated = await prisma.absence.update({
      where: { id: req.params.id },
      data: {
        status,
        rejectReason: status === 'REJECTED' ? rejectReason : null,
        validatedById: callerId,
        validatedAt: new Date(),
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        validatedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/absences/:id — annuler (owner ou RH+) ───────────────────────

router.delete('/:id', async (req, res, next) => {
  try {
    const { companyId, role, id: callerId } = req.user;
    const MANAGERS = ['RH', 'DRH', 'ADMIN'];

    const absence = await prisma.absence.findFirst({ where: { id: req.params.id, companyId } });
    if (!absence) return next(new NotFoundError('Absence introuvable'));

    const isOwner = absence.userId === callerId;
    const canManage = MANAGERS.includes(role);

    if (!isOwner && !canManage) return next(new ForbiddenError('Accès refusé'));
    if (absence.status !== 'PENDING' && !canManage) {
      return next(new ForbiddenError('Vous ne pouvez annuler qu\'une absence en attente'));
    }

    await prisma.absence.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
