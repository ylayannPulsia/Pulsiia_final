'use strict';

const { Router } = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { authenticate, requireRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

const router = Router();
router.use(authenticate);

// ─── Validation helper ───────────────────────────────────────────────────────

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(new ValidationError(result.error.errors[0].message));
    req.body = result.data;
    next();
  };
}

const shiftSchema = z.object({
  userId: z.string().cuid(),
  siteId: z.string().cuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  type: z.enum(['MATIN', 'APRES_MIDI', 'NUIT', 'JOURNEE', 'REPOS']).default('JOURNEE'),
  notes: z.string().max(500).optional(),
  isPublished: z.boolean().default(false),
});

const shiftPatchSchema = shiftSchema.partial();

// ─── GET /api/planning/week — vue semaine ────────────────────────────────────
// ?weekStart=2026-05-05 (lundi ISO) — défaut : lundi en cours
// Filtre : ?siteId=... &userId=... (manager/RH/DRH seulement)

router.get('/week', async (req, res, next) => {
  try {
    const { weekStart, siteId, userId } = req.query;
    const { companyId, role, id: callerId } = req.user;

    let start;
    if (weekStart) {
      start = new Date(weekStart);
      if (isNaN(start)) return next(new ValidationError('weekStart doit être une date ISO valide'));
    } else {
      const now = new Date();
      const day = now.getDay() || 7;
      start = new Date(now);
      start.setDate(now.getDate() - day + 1);
      start.setHours(0, 0, 0, 0);
    }
    const end = new Date(start);
    end.setDate(start.getDate() + 7);

    const MANAGERS = ['MANAGER', 'RH', 'DRH', 'ADMIN'];
    const isManager = MANAGERS.includes(role);

    const where = {
      companyId,
      startsAt: { gte: start, lt: end },
    };

    // Collaborateur ne voit que ses propres shifts
    if (!isManager) {
      where.userId = callerId;
    } else {
      if (siteId) where.siteId = siteId;
      if (userId) where.userId = userId;
    }

    const shifts = await prisma.shift.findMany({
      where,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, role: true } },
        site: { select: { id: true, name: true, city: true } },
      },
      orderBy: { startsAt: 'asc' },
    });

    res.json({ weekStart: start.toISOString(), shifts });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/planning/alerts — alertes (chevauchements, dépassements) ────────

router.get('/alerts', requireRole('MANAGER'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const now = new Date();
    const weekEnd = new Date(now);
    weekEnd.setDate(now.getDate() + 14);

    // Shifts futurs à checker
    const shifts = await prisma.shift.findMany({
      where: { companyId, startsAt: { gte: now, lt: weekEnd } },
      orderBy: [{ userId: 'asc' }, { startsAt: 'asc' }],
    });

    const alerts = [];
    const byUser = {};
    for (const s of shifts) {
      if (!byUser[s.userId]) byUser[s.userId] = [];
      byUser[s.userId].push(s);
    }

    for (const [uid, userShifts] of Object.entries(byUser)) {
      // Chevauchements
      for (let i = 0; i < userShifts.length - 1; i++) {
        const a = userShifts[i];
        const b = userShifts[i + 1];
        if (new Date(a.endsAt) > new Date(b.startsAt)) {
          alerts.push({ type: 'OVERLAP', userId: uid, shiftA: a.id, shiftB: b.id });
        }
      }
      // Semaine > 48h (directive européenne)
      const weekHours = userShifts.reduce((sum, s) => sum + Number(s.hoursWorked), 0);
      if (weekHours > 48) {
        alerts.push({ type: 'HOURS_EXCEEDED', userId: uid, totalHours: weekHours });
      }
    }

    res.json({ alerts });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/planning/shifts — créer un shift ───────────────────────────────

router.post('/shifts', requireRole('MANAGER'), validate(shiftSchema), audit('planning.shift.create'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const { userId, siteId, startsAt, endsAt, type, notes, isPublished } = req.body;

    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (end <= start) return next(new ValidationError('endsAt doit être après startsAt'));

    const hoursWorked = (end - start) / 3600000;

    // Vérifier que l'utilisateur appartient à la même entreprise
    const targetUser = await prisma.user.findFirst({ where: { id: userId, companyId } });
    if (!targetUser) return next(new NotFoundError('Utilisateur introuvable dans cette entreprise'));

    const shift = await prisma.shift.create({
      data: { companyId, userId, siteId, startsAt: start, endsAt: end, type, notes, isPublished, hoursWorked },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        site: { select: { id: true, name: true } },
      },
    });

    res.status(201).json(shift);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/planning/shifts/:id ──────────────────────────────────────────

router.patch('/shifts/:id', requireRole('MANAGER'), validate(shiftPatchSchema), audit('planning.shift.update'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const existing = await prisma.shift.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return next(new NotFoundError('Shift introuvable'));

    const data = { ...req.body };
    if (data.startsAt) data.startsAt = new Date(data.startsAt);
    if (data.endsAt) data.endsAt = new Date(data.endsAt);

    const start = data.startsAt || existing.startsAt;
    const end = data.endsAt || existing.endsAt;
    if (end <= start) return next(new ValidationError('endsAt doit être après startsAt'));
    data.hoursWorked = (new Date(end) - new Date(start)) / 3600000;

    const shift = await prisma.shift.update({
      where: { id: req.params.id },
      data,
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        site: { select: { id: true, name: true } },
      },
    });

    res.json(shift);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/planning/shifts/:id ─────────────────────────────────────────

router.delete('/shifts/:id', requireRole('MANAGER'), audit('planning.shift.delete'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const existing = await prisma.shift.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return next(new NotFoundError('Shift introuvable'));
    await prisma.shift.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/planning/shifts/publish — publier la semaine ──────────────────

router.post('/shifts/publish', requireRole('MANAGER'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const { weekStart } = req.body;
    const start = new Date(weekStart);
    if (isNaN(start)) return next(new ValidationError('weekStart invalide'));
    const end = new Date(start);
    end.setDate(start.getDate() + 7);

    const { count } = await prisma.shift.updateMany({
      where: { companyId, startsAt: { gte: start, lt: end }, isPublished: false },
      data: { isPublished: true },
    });

    res.json({ published: count });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
