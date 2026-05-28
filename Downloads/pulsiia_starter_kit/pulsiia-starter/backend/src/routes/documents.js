// src/routes/documents.js — Documents RH & documents collaborateur
const fs = require('fs');
const router = require('express').Router();
const { body, param, query } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { MANAGER_ROLES } = require('../middleware/roles');
const { prisma, getCompanyId } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { logAudit } = require('../lib/audit');
const { upload, filePath } = require('../lib/uploads');
const { streamDocumentsZip } = require('../lib/document-export');
const yousign = require('../lib/yousign');
const docSvc = require('../lib/documents-services');

const RH_PURPOSES = ['document_rh', 'document_contrat', 'document_bulletin'];
const MINE_PURPOSES = ['document_contrat', 'document_bulletin', 'document_perso', 'document_rh'];

const PURPOSE_BY_TYPE = {
  'Bulletin de paie': 'document_bulletin',
  'Contrat CDI': 'document_contrat',
  'Contrat CDD': 'document_contrat',
  Avenant: 'document_rh',
  Attestation: 'document_rh',
  Rupture: 'document_rh',
  'Rupture conventionnelle': 'document_rh',
  Autre: 'document_rh',
};

function isManager(role) {
  return MANAGER_ROLES.includes(role);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function formatDateFr(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function shortName(firstName, lastName) {
  const ln = lastName || '';
  return `${firstName} ${ln.charAt(0) ? `${ln.charAt(0)}.` : ''}`.trim();
}

function docIcon(type) {
  if ((type || '').includes('Bulletin')) return '🧾';
  if ((type || '').includes('Contrat')) return '📄';
  if ((type || '').includes('Attestation')) return '🔐';
  return '📄';
}

function purposeForType(type) {
  return PURPOSE_BY_TYPE[type] || 'document_rh';
}

function normalizeCompanyName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function allowDemoPlaceholder(companyName) {
  const normalized = normalizeCompanyName(companyName);
  return normalized === 'saveurs-co' || normalized === 'groupe-saveurs-co';
}

const USER_DOC_SELECT = {
  firstName: true,
  lastName: true,
  avatarColor: true,
  email: true,
  phone: true,
  siteId: true,
  site: { select: { id: true, name: true } },
};

function mapRhDocument(file) {
  const collab = file.user
    ? shortName(file.user.firstName, file.user.lastName)
    : '—';
  return {
    id: file.id,
    userId: file.userId,
    name: file.originalName,
    collab,
    type: file.relatedType || 'Autre',
    date: file.createdAt.toISOString().slice(0, 10),
    status: file.notes || 'Émis',
    size: formatSize(file.size),
    mimeType: file.mimeType,
    purpose: file.purpose,
    initials: file.user
      ? `${(file.user.firstName || '')[0] || ''}${(file.user.lastName || '')[0] || ''}`.toUpperCase()
      : '—',
    avatarColor: file.user?.avatarColor || '#6B7280',
    siteId: file.user?.siteId || null,
    siteName: file.user?.site?.name || null,
    versionNumber: file.versionNumber || 1,
    rootFileId: file.rootFileId || file.id,
    signatureProvider: file.signatureProvider,
    signatureStatus: file.signatureStatus,
    signatureLink: file.signatureLink,
    signatureLevel: file.signatureLevel,
    signatureLevelLabel: file.signatureLevel
      ? (docSvc.LEVEL_LABELS[file.signatureLevel] || file.signatureLevel)
      : null,
  };
}

function buildRhListWhere(companyId, query) {
  const where = {
    companyId,
    isDeleted: false,
    isCurrentVersion: true,
    purpose: { in: RH_PURPOSES },
  };

  if (query.type && query.type !== 'Tous') {
    where.relatedType = { contains: query.type, mode: 'insensitive' };
  }

  if (query.siteId) {
    where.user = { siteId: String(query.siteId) };
  }

  if (query.search) {
    const q = String(query.search).trim();
    where.OR = [
      { originalName: { contains: q, mode: 'insensitive' } },
      { relatedType: { contains: q, mode: 'insensitive' } },
      { user: { firstName: { contains: q, mode: 'insensitive' } } },
      { user: { lastName: { contains: q, mode: 'insensitive' } } },
    ];
  }

  return where;
}

function mapCollabDocument(file) {
  const catMap = {
    document_contrat: 'contrat',
    document_bulletin: 'bulletin',
    document_perso: 'perso',
  };
  return {
    id: file.id,
    name: file.originalName,
    cat: catMap[file.purpose] || 'perso',
    size: formatSize(file.size),
    date: formatDateFr(file.createdAt),
    from: file.purpose === 'document_perso' ? 'Moi' : 'RH',
    icon: docIcon(file.relatedType),
    type: file.relatedType,
    mimeType: file.mimeType,
  };
}

async function findRhDocument(id, companyId, opts = {}) {
  const { currentOnly = true } = opts;
  return prisma.uploadedFile.findFirst({
    where: {
      id,
      companyId,
      isDeleted: false,
      purpose: { in: RH_PURPOSES },
      ...(currentOnly ? { isCurrentVersion: true } : {}),
    },
    include: { user: { select: USER_DOC_SELECT } },
  });
}

async function findAccessibleDocument(id, companyId, userId, role) {
  const manager = isManager(role);
  return prisma.uploadedFile.findFirst({
    where: {
      id,
      companyId,
      isDeleted: false,
      ...(manager
        ? { purpose: { in: RH_PURPOSES } }
        : { userId, purpose: { in: MINE_PURPOSES } }),
    },
    include: { user: { select: USER_DOC_SELECT } },
  });
}

function streamPlaceholder(res, file, inline) {
  const lines = [
    'PULSIIA — Document RH (aperçu)',
    '',
    `Nom : ${file.originalName}`,
    `Type : ${file.relatedType || '—'}`,
    `Statut : ${file.notes || 'Émis'}`,
    `Date : ${file.createdAt.toISOString().slice(0, 10)}`,
    '',
    'Le fichier original n\'est pas encore disponible sur ce serveur de démo.',
  ];
  const text = lines.join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const disp = inline ? 'inline' : 'attachment';
  res.setHeader(
    'Content-Disposition',
    `${disp}; filename="${encodeURIComponent((file.originalName || 'document').replace(/\.[^.]+$/, '') + '.txt')}"`,
  );
  res.send(text);
}

function pipeFile(res, file, inline, options = {}) {
  const diskPath = filePath(file.storedName);
  if (!fs.existsSync(diskPath)) {
    if (options.allowDemoPlaceholder) {
      return streamPlaceholder(res, file, inline);
    }
    res.status(404).json({ error: 'Fichier source introuvable sur le stockage.' });
    return false;
  }
  const disp = inline ? 'inline' : 'attachment';
  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${disp}; filename="${encodeURIComponent(file.originalName)}"`,
  );
  fs.createReadStream(diskPath).pipe(res);
  return true;
}

// ── GET /api/documents — tous les docs RH (managers+) ─────────
router.get('/',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    query('type').optional().isString(),
    query('search').optional().isString(),
    query('siteId').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const where = buildRhListWhere(companyId, req.query);

    const files = await prisma.uploadedFile.findMany({
      where,
      include: { user: { select: USER_DOC_SELECT } },
      orderBy: { createdAt: 'desc' },
    });

    const documents = files.map(mapRhDocument);

    res.json({
      documents,
      signatureProvider: yousign.PROVIDER_NAME,
      signatureConfigured: yousign.isConfigured(),
      stats: {
        total: documents.length,
        bulletins: documents.filter((d) => d.type === 'Bulletin de paie').length,
        contrats: documents.filter((d) => (d.type || '').startsWith('Contrat')).length,
        pending: documents.filter((d) => d.status === 'En attente signature').length,
      },
    });
  },
);

// ── GET /api/documents/export/zip — archive PDF des docs filtrés ─
router.get('/export/zip',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    query('type').optional().isString(),
    query('search').optional().isString(),
    query('siteId').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const files = await prisma.uploadedFile.findMany({
      where: buildRhListWhere(companyId, req.query),
      include: { user: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    });

    if (!files.length) {
      return res.status(404).json({ error: 'Aucun document à exporter.' });
    }

    const entries = files.map((f) => ({
      originalName: f.originalName,
      storedName: f.storedName,
      collabLabel: f.user ? shortName(f.user.firstName, f.user.lastName) : '',
    }));

    streamDocumentsZip(res, entries, 'documents_rh');
    await logAudit(req, {
      action: 'document.export_zip',
      metadata: { count: files.length },
    });
  },
);

// ── GET /api/documents/mine — docs du collaborateur connecté ────
router.get('/mine',
  authenticate,
  async (req, res) => {
    const companyId = getCompanyId(req);
    const userId = req.user.id;

    const files = await prisma.uploadedFile.findMany({
      where: {
        companyId,
        userId,
        isDeleted: false,
        purpose: { in: MINE_PURPOSES },
      },
      orderBy: { createdAt: 'desc' },
    });

    const documents = files.map(mapCollabDocument);
    const usedBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);

    res.json({
      documents,
      stats: {
        total: documents.length,
        contrat: documents.filter((d) => d.cat === 'contrat').length,
        bulletin: documents.filter((d) => d.cat === 'bulletin').length,
        perso: documents.filter((d) => d.cat === 'perso').length,
        usedBytes,
        quotaBytes: 5 * 1024 * 1024 * 1024,
      },
    });
  },
);

// ── POST /api/documents/mine — upload document personnel ──────
router.post('/mine',
  authenticate,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Erreur lors de l\'upload.' });
      }
      next();
    });
  },
  [
    body('name').optional().isString().trim(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    if (!req.file) {
      return res.status(400).json({ error: 'Fichier requis (PDF, JPG, PNG ou WEBP — max 10 Mo).' });
    }

    const companyId = getCompanyId(req);
    const name = String(req.body.name || req.file.originalname).trim() || req.file.originalname;

    const file = await prisma.uploadedFile.create({
      data: {
        userId: req.user.id,
        companyId,
        originalName: name,
        storedName: req.file.filename,
        mimeType: req.file.mimetype,
        size: req.file.size,
        purpose: 'document_perso',
        relatedType: 'Document personnel',
        notes: 'Déposé',
      },
    });

    await logAudit(req, {
      action: 'document.upload_perso',
      resource: `file:${file.id}`,
      metadata: { name },
    });

    res.status(201).json({ document: mapCollabDocument(file) });
  },
);

// ── DELETE /api/documents/mine/:id — supprimer doc personnel ───
router.delete('/mine/:id',
  authenticate,
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const file = await prisma.uploadedFile.findFirst({
      where: {
        id: req.params.id,
        companyId,
        userId: req.user.id,
        isDeleted: false,
        purpose: 'document_perso',
      },
    });

    if (!file) {
      return res.status(404).json({ error: 'Document introuvable ou non supprimable.' });
    }

    await prisma.uploadedFile.update({
      where: { id: file.id },
      data: { isDeleted: true, deletedAt: new Date() },
    });

    await logAudit(req, {
      action: 'document.delete_perso',
      resource: `file:${file.id}`,
      metadata: { name: file.originalName },
    });

    res.json({ ok: true });
  },
);

// ── POST /api/documents/webhooks/yousign — callbacks Yousign ───
router.post('/webhooks/yousign', async (req, res) => {
  try {
    const tsSvc = require('../lib/timesheet-service');
    const docResult = await docSvc.applyYousignWebhook(req.body || {});
    const tsResult = await tsSvc.applyTimesheetYousignWebhook(req.body || {});
    res.json({ ok: true, documents: docResult, timesheets: tsResult });
  } catch (err) {
    console.error('[yousign webhook]', err.message);
    res.status(500).json({ error: 'Webhook error' });
  }
});

// ── POST /api/documents — créer un document RH ────────────────
router.post('/',
  authenticate,
  authorize(...MANAGER_ROLES),
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Erreur lors de l\'upload.' });
      }
      next();
    });
  },
  [
    body('userId').isString().notEmpty().withMessage('Collaborateur requis.'),
    body('name').isString().trim().notEmpty().withMessage('Nom du document requis.'),
    body('type').isString().trim().notEmpty().withMessage('Type requis.'),
    body('status').optional().isString(),
    body('date').optional().isISO8601().toDate(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const user = await prisma.user.findFirst({
      where: { id: req.body.userId, companyId, isActive: true },
    });
    if (!user) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Collaborateur introuvable.' });
    }

    const type = String(req.body.type).trim();
    const status = String(req.body.status || 'Émis').trim();
    const createdAt = req.body.date ? new Date(req.body.date) : undefined;

    let storedName = `${require('crypto').randomUUID()}.pdf`;
    let mimeType = 'application/pdf';
    let size = 0;

    if (req.file) {
      storedName = req.file.filename;
      mimeType = req.file.mimetype;
      size = req.file.size;
    } else {
      const placeholderPath = filePath(storedName);
      const text = `Document RH Pulsiia\n${req.body.name}\n`;
      fs.writeFileSync(placeholderPath, text, 'utf8');
      size = Buffer.byteLength(text, 'utf8');
      mimeType = 'text/plain';
    }

    let file = await prisma.uploadedFile.create({
      data: {
        userId: user.id,
        companyId,
        originalName: String(req.body.name).trim(),
        storedName,
        mimeType,
        size,
        purpose: purposeForType(type),
        relatedType: type,
        notes: status,
        isCurrentVersion: true,
        versionNumber: 1,
        ...(createdAt ? { createdAt } : {}),
      },
      include: { user: { select: USER_DOC_SELECT } },
    });

    let signatureInfo = null;
    if (docSvc.needsSignature(status)) {
      try {
        const sig = await docSvc.initiateYousignSignature(file, user);
        if (sig.file) file = sig.file;
        signatureInfo = sig.procedure;
      } catch (sigErr) {
        signatureInfo = { error: sigErr.message };
      }
    }

    await logAudit(req, {
      action: 'document.create',
      resource: `file:${file.id}`,
      metadata: { name: file.originalName, type, collab: shortName(user.firstName, user.lastName) },
    });

    res.status(201).json({
      document: mapRhDocument(file),
      signature: signatureInfo,
    });
  },
);

// ── PUT /api/documents/:id — modifier métadonnées RH ──────────
router.put('/:id',
  authenticate,
  authorize(...MANAGER_ROLES),
  [
    param('id').isString().notEmpty(),
    body('name').optional().isString().trim().notEmpty(),
    body('type').optional().isString().trim().notEmpty(),
    body('status').optional().isString(),
    body('date').optional().isISO8601().toDate(),
    body('userId').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const existing = await findRhDocument(req.params.id, companyId);
    if (!existing) {
      return res.status(404).json({ error: 'Document introuvable.' });
    }

    const data = {};
    if (req.body.name) data.originalName = req.body.name.trim();
    if (req.body.type) {
      data.relatedType = req.body.type.trim();
      data.purpose = purposeForType(data.relatedType);
    }
    if (req.body.status !== undefined) data.notes = String(req.body.status).trim();
    if (req.body.date) data.createdAt = new Date(req.body.date);

    if (req.body.userId && req.body.userId !== existing.userId) {
      const user = await prisma.user.findFirst({
        where: { id: req.body.userId, companyId, isActive: true },
      });
      if (!user) {
        return res.status(400).json({ error: 'Collaborateur introuvable.' });
      }
      data.userId = user.id;
    }

    let file = await prisma.uploadedFile.update({
      where: { id: existing.id },
      data,
      include: { user: { select: USER_DOC_SELECT } },
    });

    if (docSvc.needsSignature(file.notes) && !file.signatureRequestId) {
      try {
        const user = file.user || await prisma.user.findUnique({
          where: { id: file.userId },
          select: USER_DOC_SELECT,
        });
        const sig = await docSvc.initiateYousignSignature(file, user);
        if (sig.file) file = sig.file;
      } catch (_e) { /* statut conservé, signature manuelle via bouton */ }
    }

    await logAudit(req, {
      action: 'document.update',
      resource: `file:${file.id}`,
      metadata: { name: file.originalName },
    });

    res.json({ document: mapRhDocument(file) });
  },
);

// ── DELETE /api/documents/:id — supprimer (RH, soft delete) ───
router.delete('/:id',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const file = await findRhDocument(req.params.id, companyId);
    if (!file) {
      return res.status(404).json({ error: 'Document introuvable.' });
    }

    await prisma.uploadedFile.update({
      where: { id: file.id },
      data: { isDeleted: true, deletedAt: new Date() },
    });

    await logAudit(req, {
      action: 'document.delete',
      resource: `file:${file.id}`,
      metadata: { name: file.originalName },
    });

    res.json({ ok: true });
  },
);

// ── GET /api/documents/:id/versions — historique des versions ─
router.get('/:id/versions',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const file = await findRhDocument(req.params.id, companyId, { currentOnly: false });
    if (!file) {
      return res.status(404).json({ error: 'Document introuvable.' });
    }

    const rootId = docSvc.resolveRootId(file);
    const versions = await prisma.uploadedFile.findMany({
      where: {
        companyId,
        isDeleted: false,
        OR: [{ id: rootId }, { rootFileId: rootId }],
      },
      include: { user: { select: USER_DOC_SELECT } },
      orderBy: { versionNumber: 'desc' },
    });

    res.json({
      versions: versions.map((v) => ({
        ...mapRhDocument(v),
        isCurrent: v.isCurrentVersion,
      })),
    });
  },
);

// ── POST /api/documents/:id/versions — nouvelle version (fichier) ─
router.post('/:id/versions',
  authenticate,
  authorize(...MANAGER_ROLES),
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Erreur upload.' });
      }
      next();
    });
  },
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    if (!req.file) {
      return res.status(400).json({ error: 'Fichier requis pour la nouvelle version.' });
    }

    const companyId = getCompanyId(req);
    const existing = await findRhDocument(req.params.id, companyId);
    if (!existing) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Document introuvable.' });
    }

    const file = await docSvc.createNewVersion(existing, req.file);

    await logAudit(req, {
      action: 'document.new_version',
      resource: `file:${file.id}`,
      metadata: { version: file.versionNumber, name: file.originalName },
    });

    res.status(201).json({ document: mapRhDocument(file) });
  },
);

// ── POST /api/documents/:id/signature — lancer signature Yousign ─
router.post('/:id/signature',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    let file = await findRhDocument(req.params.id, companyId);
    if (!file) {
      return res.status(404).json({ error: 'Document introuvable.' });
    }

    const user = file.user || await prisma.user.findUnique({
      where: { id: file.userId },
      select: USER_DOC_SELECT,
    });

    try {
      const sig = await docSvc.initiateYousignSignature(file, user);
      if (sig.skipped) {
        return res.status(400).json({ error: sig.reason });
      }
      await logAudit(req, {
        action: 'document.signature_start',
        resource: `file:${file.id}`,
        metadata: { provider: 'yousign', mode: sig.procedure?.mode },
      });
      res.json({
        document: mapRhDocument(sig.file),
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

// ── GET /api/documents/:id/signature/status — sync statut Yousign
router.get('/:id/signature/status',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const file = await findRhDocument(req.params.id, companyId);
    if (!file) {
      return res.status(404).json({ error: 'Document introuvable.' });
    }

    const updated = await docSvc.syncSignatureFromYousign(file);
    res.json({ document: mapRhDocument(updated) });
  },
);

// ── GET /api/documents/:id/file — télécharger / aperçu ────────
router.get('/:id/file',
  authenticate,
  [param('id').isString().notEmpty(), query('inline').optional().isIn(['true', 'false', '1', '0'])],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const file = await findAccessibleDocument(
      req.params.id,
      companyId,
      req.user.id,
      req.user.role,
    );
    if (!file) {
      return res.status(404).json({ error: 'Document introuvable.' });
    }

    const inline = req.query.inline === 'true' || req.query.inline === '1';
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });
    pipeFile(res, file, inline, {
      allowDemoPlaceholder: allowDemoPlaceholder(company?.name),
    });
  },
);

// ── POST /api/documents/:id/remind — relance signature ───────
router.post('/:id/remind',
  authenticate,
  authorize(...MANAGER_ROLES),
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const file = await findRhDocument(req.params.id, companyId);
    if (!file) {
      return res.status(404).json({ error: 'Document introuvable.' });
    }
    if (file.notes !== 'En attente signature') {
      return res.status(400).json({ error: 'Ce document n\'est pas en attente de signature.' });
    }

    const collab = file.user
      ? shortName(file.user.firstName, file.user.lastName)
      : 'le collaborateur';

    const remind = await docSvc.sendSignatureReminder(file);

    await logAudit(req, {
      action: 'document.remind',
      resource: `file:${file.id}`,
      metadata: { collab, email: file.user?.email, mailSent: remind.sent },
    });

    if (!remind.sent && remind.reason) {
      return res.status(400).json({ error: remind.reason });
    }

    res.json({
      ok: true,
      message: `Relance envoyée à ${collab}${remind.mail?.dev ? ' (e-mail loggé — SMTP non configuré)' : ''}`,
      collab,
      provider: yousign.PROVIDER_NAME,
    });
  },
);

module.exports = router;
