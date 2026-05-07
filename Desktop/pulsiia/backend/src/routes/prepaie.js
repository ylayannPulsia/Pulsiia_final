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

const varSchema = z.object({
  userId: z.string().cuid(),
  kind: z.enum(['HEURES_SUPP', 'PRIME', 'ABSENCE', 'CONGE', 'AVANTAGE_NATURE', 'AUTRE']),
  periodYear: z.number().int().min(2020).max(2100),
  periodMonth: z.number().int().min(1).max(12),
  amount: z.number().positive(),
  unit: z.string().max(10).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ─── GET /api/prepaie/variables — liste des variables ────────────────────────
// ?year=2026 &month=5 &status=... &userId=...

router.get('/variables', requireRole('RH'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const { year, month, status, userId, page = '1', limit = '100' } = req.query;

    const where = { companyId };
    if (year) where.periodYear = Number(year);
    if (month) where.periodMonth = Number(month);
    if (status) where.status = status;
    if (userId) where.userId = userId;

    const skip = (Number(page) - 1) * Number(limit);
    const [variables, total] = await Promise.all([
      prisma.payVariable.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true } },
          validatedBy: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: Number(limit),
      }),
      prisma.payVariable.count({ where }),
    ]);

    res.json({ variables, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/prepaie/variables/summary — récap mensuel ──────────────────────

router.get('/variables/summary', requireRole('RH'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const now = new Date();
    const year = Number(req.query.year || now.getFullYear());
    const month = Number(req.query.month || now.getMonth() + 1);

    const [byStatus, byKind, anomalies] = await Promise.all([
      prisma.payVariable.groupBy({
        by: ['status'],
        where: { companyId, periodYear: year, periodMonth: month },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.payVariable.groupBy({
        by: ['kind'],
        where: { companyId, periodYear: year, periodMonth: month },
        _count: true,
        _sum: { amount: true },
      }),
      prisma.payVariable.findMany({
        where: { companyId, periodYear: year, periodMonth: month, status: 'ANOMALY' },
        include: { user: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({ year, month, byStatus, byKind, anomalies });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/prepaie/variables — créer une variable ────────────────────────

router.post('/variables', requireRole('RH'), validate(varSchema), audit('prepaie.variable.create'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const { userId, kind, periodYear, periodMonth, amount, unit, metadata } = req.body;

    const targetUser = await prisma.user.findFirst({ where: { id: userId, companyId } });
    if (!targetUser) return next(new NotFoundError('Utilisateur introuvable'));

    const variable = await prisma.payVariable.create({
      data: { companyId, userId, kind, periodYear, periodMonth, amount, unit, metadata },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });

    res.status(201).json(variable);
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/prepaie/variables/:id/validate — valider ───────────────────────

router.put('/variables/:id/validate', requireRole('DRH'), audit('prepaie.variable.validate'), async (req, res, next) => {
  try {
    const { companyId, id: callerId } = req.user;
    const variable = await prisma.payVariable.findFirst({ where: { id: req.params.id, companyId } });
    if (!variable) return next(new NotFoundError('Variable introuvable'));
    if (!['PENDING', 'ANOMALY'].includes(variable.status)) {
      return next(new ValidationError('Cette variable ne peut pas être validée dans son état actuel'));
    }

    const updated = await prisma.payVariable.update({
      where: { id: req.params.id },
      data: { status: 'VALIDATED', validatedById: callerId, validatedAt: new Date() },
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

// ─── PUT /api/prepaie/variables/:id/reject — rejeter ─────────────────────────

router.put('/variables/:id/reject', requireRole('DRH'), async (req, res, next) => {
  try {
    const { companyId, id: callerId } = req.user;
    const { reason } = req.body;
    if (!reason) return next(new ValidationError('Un motif de rejet est requis'));

    const variable = await prisma.payVariable.findFirst({ where: { id: req.params.id, companyId } });
    if (!variable) return next(new NotFoundError('Variable introuvable'));

    const updated = await prisma.payVariable.update({
      where: { id: req.params.id },
      data: { status: 'REJECTED', rejectReason: reason, validatedById: callerId, validatedAt: new Date() },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/prepaie/variables/validate-all — tout valider (DRH) ───────────

router.post('/variables/validate-all', requireRole('DRH'), audit('prepaie.variable.validate_all'), async (req, res, next) => {
  try {
    const { companyId, id: callerId } = req.user;
    const { year, month } = req.body;
    if (!year || !month) return next(new ValidationError('year et month sont requis'));

    const { count } = await prisma.payVariable.updateMany({
      where: { companyId, periodYear: Number(year), periodMonth: Number(month), status: 'PENDING' },
      data: { status: 'VALIDATED', validatedById: callerId, validatedAt: new Date() },
    });

    res.json({ validated: count });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/prepaie/export — export CSV (Silae / Sage / ADP) ───────────────

router.get('/export', requireRole('DRH'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const { year, month, format = 'silae' } = req.query;
    if (!year || !month) return next(new ValidationError('year et month sont requis'));

    const variables = await prisma.payVariable.findMany({
      where: { companyId, periodYear: Number(year), periodMonth: Number(month), status: 'VALIDATED' },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: [{ user: { lastName: 'asc' } }, { kind: 'asc' }],
    });

    // CSV générique — en production, adapter selon le format logiciel paie
    const header = 'matricule;nom;prenom;type;montant;unite;periode\n';
    const rows = variables.map(v => {
      const period = `${v.periodYear}-${String(v.periodMonth).padStart(2, '0')}`;
      return [v.userId, v.user.lastName, v.user.firstName, v.kind, v.amount, v.unit || '', period].join(';');
    }).join('\n');

    const filename = `prepaie_${format}_${year}_${String(month).padStart(2, '0')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + header + rows); // BOM UTF-8 pour Excel
  } catch (err) {
    next(err);
  }
});

module.exports = router;
