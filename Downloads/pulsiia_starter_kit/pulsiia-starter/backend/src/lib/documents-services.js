// Logique métier documents RH — signature Yousign, versioning
const fs = require('fs');
const { prisma } = require('../middleware/tenant');
const { filePath } = require('./uploads');
const yousign = require('./yousign');
const {
  sendDocumentSignatureEmail,
  sendDocumentReminderEmail,
} = require('./mail');

const LEVEL_LABELS = {
  electronic_signature: 'signature électronique simple (eIDAS)',
  advanced_electronic_signature: 'signature électronique avancée (eIDAS)',
  qualified_electronic_signature: 'signature électronique qualifiée (eIDAS)',
};

function needsSignature(status) {
  return status === 'En attente signature';
}

function resolveRootId(file) {
  return file.rootFileId || file.id;
}

async function initiateYousignSignature(file, user) {
  const disk = filePath(file.storedName);
  let mime = file.mimeType || '';
  if (!mime.includes('pdf') && fs.existsSync(disk)) {
    const buf = fs.readFileSync(disk).slice(0, 4).toString();
    if (buf === '%PDF') mime = 'application/pdf';
  }

  if (!mime.includes('pdf')) {
    return {
      skipped: true,
      reason: 'Le fichier doit être un PDF pour une signature Yousign eIDAS. Convertissez le document ou uploadez un PDF.',
    };
  }

  const procedure = await yousign.createSignatureProcedure({
    filePath: disk,
    fileName: file.originalName.endsWith('.pdf') ? file.originalName : `${file.originalName}.pdf`,
    documentName: file.originalName,
    signer: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone || undefined,
    },
  });

  const signatureStatus = procedure.mode === 'live' ? 'pending' : 'initiated';
  const level = procedure.level || yousign.signatureLevel();

  const updated = await prisma.uploadedFile.update({
    where: { id: file.id },
    data: {
      signatureProvider: 'yousign',
      signatureRequestId: procedure.requestId,
      signatureSignerId: procedure.signerId,
      signatureStatus,
      signatureLink: procedure.signatureLink,
      signatureLevel: level,
      notes: 'En attente signature',
    },
    include: {
      user: { select: { firstName: true, lastName: true, email: true, avatarColor: true } },
    },
  });

  if (user.email && procedure.signatureLink) {
    await sendDocumentSignatureEmail({
      to: user.email,
      firstName: user.firstName,
      documentName: file.originalName,
      signatureLink: procedure.signatureLink,
      providerName: yousign.PROVIDER_NAME,
      levelLabel: LEVEL_LABELS[level] || LEVEL_LABELS.advanced_electronic_signature,
    });
  }

  return { file: updated, procedure };
}

async function syncSignatureFromYousign(file) {
  if (!file.signatureRequestId || !yousign.isConfigured()) return file;
  const remote = await yousign.fetchSignatureRequest(file.signatureRequestId);
  if (!remote) return file;

  const localStatus = yousign.mapYousignStatusToLocal(remote.status);
  const data = { signatureStatus: localStatus };

  if (localStatus === 'signed') {
    data.notes = 'Signé';
  } else if (localStatus === 'declined') {
    data.notes = 'Refusé';
  } else if (localStatus === 'expired') {
    data.notes = 'Expiré';
  }

  return prisma.uploadedFile.update({
    where: { id: file.id },
    data,
    include: { user: { select: { firstName: true, lastName: true, email: true, avatarColor: true } } },
  });
}

async function sendSignatureReminder(file) {
  const user = file.user || await prisma.user.findUnique({ where: { id: file.userId } });
  if (!user?.email) {
    return { sent: false, reason: 'E-mail collaborateur manquant.' };
  }

  if (file.signatureRequestId && yousign.isConfigured()) {
    await syncSignatureFromYousign(file);
    const refreshed = await prisma.uploadedFile.findUnique({ where: { id: file.id } });
    if (refreshed?.signatureStatus === 'signed') {
      return { sent: false, reason: 'Document déjà signé.' };
    }
  }

  const mail = await sendDocumentReminderEmail({
    to: user.email,
    firstName: user.firstName,
    documentName: file.originalName,
    signatureLink: file.signatureLink,
  });

  return { sent: true, mail };
}

async function applyYousignWebhook(payload) {
  const requestId = payload?.data?.signature_request?.id
    || payload?.signature_request?.id
    || payload?.data?.id;

  if (!requestId) return { matched: false };

  const files = await prisma.uploadedFile.findMany({
    where: { signatureRequestId: requestId, isDeleted: false },
  });

  if (!files.length) return { matched: false, requestId };

  const event = payload?.event_name || payload?.type || '';
  let localStatus = 'pending';
  if (/done|completed|signed/i.test(event)) localStatus = 'signed';
  if (/declined|refused/i.test(event)) localStatus = 'declined';
  if (/expired|canceled|cancelled/i.test(event)) localStatus = 'expired';

  for (const file of files) {
    const data = { signatureStatus: localStatus };
    if (localStatus === 'signed') data.notes = 'Signé';
    if (localStatus === 'declined') data.notes = 'Refusé';
    if (localStatus === 'expired') data.notes = 'Expiré';
    await prisma.uploadedFile.update({ where: { id: file.id }, data });
  }

  return { matched: true, requestId, count: files.length, localStatus };
}

async function createNewVersion(existing, reqFile) {
  const rootId = resolveRootId(existing);
  const siblings = await prisma.uploadedFile.findMany({
    where: {
      OR: [{ id: rootId }, { rootFileId: rootId }],
      isDeleted: false,
    },
    orderBy: { versionNumber: 'desc' },
    take: 1,
  });
  const nextVersion = (siblings[0]?.versionNumber || 1) + 1;

  await prisma.uploadedFile.updateMany({
    where: {
      OR: [{ id: rootId }, { rootFileId: rootId }],
      isCurrentVersion: true,
    },
    data: { isCurrentVersion: false },
  });

  return prisma.uploadedFile.create({
    data: {
      userId: existing.userId,
      companyId: existing.companyId,
      originalName: existing.originalName,
      storedName: reqFile.filename,
      mimeType: reqFile.mimetype,
      size: reqFile.size,
      purpose: existing.purpose,
      relatedType: existing.relatedType,
      notes: existing.notes,
      rootFileId: rootId,
      versionNumber: nextVersion,
      isCurrentVersion: true,
      signatureProvider: null,
      signatureRequestId: null,
      signatureSignerId: null,
      signatureStatus: null,
      signatureLink: null,
      signatureLevel: null,
    },
    include: { user: { select: { firstName: true, lastName: true, email: true, avatarColor: true } } },
  });
}

module.exports = {
  needsSignature,
  resolveRootId,
  initiateYousignSignature,
  syncSignatureFromYousign,
  sendSignatureReminder,
  applyYousignWebhook,
  createNewVersion,
  LEVEL_LABELS,
};
