// src/routes/rgpd.js — Consentements, export données, suppression compte
const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { body, param } = require('express-validator');
const { addDays } = require('date-fns');
const { authenticate } = require('../middleware/auth');
const { prisma, getCompanyId } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { logAudit } = require('../lib/audit');
const { UPLOAD_DIR } = require('../lib/uploads');

const CONSENT_TYPES = ['terms', 'privacy', 'push', 'analytics'];
const RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '730', 10);

function consentVersion(type) {
  if (type === 'terms') return process.env.TERMS_VERSION || '1.0';
  if (type === 'privacy') return process.env.PRIVACY_VERSION || '1.0';
  return '1.0';
}

// ── GET /api/rgpd/me/consents ─────────────────────────────────
router.get('/me/consents', authenticate, async (req, res) => {
  const logs = await prisma.consentLog.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
  });

  const latest = {};
  logs.forEach((l) => {
    if (!latest[l.type]) latest[l.type] = l;
  });

  res.json({
    consents: CONSENT_TYPES.map((type) => ({
      type,
      version: consentVersion(type),
      accepted: latest[type]?.accepted ?? false,
      acceptedAt: latest[type]?.createdAt ?? null,
    })),
    termsVersion: process.env.TERMS_VERSION || '1.0',
    privacyVersion: process.env.PRIVACY_VERSION || '1.0',
    dataRetentionDays: RETENTION_DAYS,
  });
});

// ── POST /api/rgpd/me/consents ──────────────────────────────────
router.post('/me/consents',
  authenticate,
  [
    body('type').isIn(CONSENT_TYPES),
    body('accepted').isBoolean(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { type, accepted } = req.body;
    const log = await prisma.consentLog.create({
      data: {
        userId: req.user.id,
        type,
        version: consentVersion(type),
        accepted,
        ipAddress: req.ip || null,
        userAgent: req.get('user-agent') || null,
      },
    });

    await logAudit(req, { action: 'RGPD_CONSENT', resource: type, metadata: { accepted } });
    res.status(201).json({ consent: log });
  },
);

// ── POST /api/rgpd/me/export ────────────────────────────────────
router.post('/me/export', authenticate, async (req, res) => {
  const userId = req.user.id;
  const companyId = getCompanyId(req);

  const [user, absences, variables, responses, files, consents] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, firstName: true, lastName: true, role: true,
        jobTitle: true, phone: true, iban: true, contractType: true, weeklyHours: true,
        competences: true, secondaryRoles: true, createdAt: true,
        company: { select: { name: true } },
        site: { select: { name: true } },
      },
    }),
    prisma.absence.findMany({ where: { userId, companyId } }),
    prisma.payVariable.findMany({ where: { userId, companyId } }),
    prisma.surveyResponse.findMany({
      where: { userId },
      include: { answers: true },
    }),
    prisma.uploadedFile.findMany({ where: { userId, companyId, isDeleted: false } }),
    prisma.consentLog.findMany({ where: { userId } }),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    profile: user,
    absences,
    payVariables: variables,
    surveyResponses: responses,
    files: files.map((f) => ({ id: f.id, name: f.originalName, purpose: f.purpose, createdAt: f.createdAt })),
    consents,
  };

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const storedName = `export-${userId}-${randomUUID()}.json`;
  const fullPath = path.join(UPLOAD_DIR, storedName);
  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), 'utf8');

  const expiresAt = addDays(new Date(), 7);
  const downloadUrl = `/api/rgpd/me/export/download/${storedName}`;

  const exportReq = await prisma.dataExportRequest.create({
    data: {
      userId,
      status: 'READY',
      downloadUrl,
      expiresAt,
      completedAt: new Date(),
    },
  });

  await logAudit(req, { action: 'RGPD_EXPORT', resource: exportReq.id });
  res.status(201).json({
    export: exportReq,
    downloadUrl,
    expiresAt,
    message: 'Export prêt — lien valable 7 jours.',
  });
});

// ── GET /api/rgpd/me/export/download/:filename ────────────────
router.get('/me/export/download/:filename', authenticate, [
  param('filename').isString().notEmpty(),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const filename = path.basename(req.params.filename);
  if (!filename.startsWith(`export-${req.user.id}-`)) {
    return res.status(403).json({ error: 'Accès refusé.' });
  }

  const fullPath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'Export expiré ou introuvable.' });
  }

  res.download(fullPath, `pulsiia-export-${req.user.id}.json`);
});

// ── GET /api/rgpd/me/deletion ─────────────────────────────────
router.get('/me/deletion', authenticate, async (req, res) => {
  const pending = await prisma.deletionRequest.findFirst({
    where: { userId: req.user.id, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ request: pending });
});

// ── POST /api/rgpd/me/deletion ──────────────────────────────────
router.post('/me/deletion',
  authenticate,
  [body('reason').optional().isString().isLength({ max: 500 })],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const existing = await prisma.deletionRequest.findFirst({
      where: { userId: req.user.id, status: 'PENDING' },
    });
    if (existing) {
      res.status(409).json({ error: 'Une demande de suppression est déjà en cours.', request: existing });
      return;
    }

    const scheduledAt = addDays(new Date(), 30);
    const request = await prisma.deletionRequest.create({
      data: {
        userId: req.user.id,
        reason: req.body.reason?.trim() || null,
        status: 'PENDING',
        scheduledAt,
      },
    });

    await logAudit(req, { action: 'RGPD_DELETION_REQUEST', resource: request.id });
    res.status(201).json({
      request,
      message: `Demande enregistrée — suppression prévue le ${scheduledAt.toLocaleDateString('fr-FR')}.`,
    });
  },
);

// ── DELETE /api/rgpd/me/deletion — annuler ────────────────────
router.delete('/me/deletion', authenticate, async (req, res) => {
  const updated = await prisma.deletionRequest.updateMany({
    where: { userId: req.user.id, status: 'PENDING' },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
  res.json({ cancelled: updated.count > 0 });
});

module.exports = router;
