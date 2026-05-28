// Feuilles d'heures — génération PDF, signature Yousign eIDAS
const fs = require('fs');
const { randomUUID } = require('crypto');
const { prisma } = require('../middleware/tenant');
const { filePath, UPLOAD_DIR } = require('./uploads');
const { buildTimesheetPdf } = require('./timesheet-pdf');
const yousign = require('./yousign');
const { sendDocumentSignatureEmail, sendDocumentReminderEmail } = require('./mail');

const TYPE_LABELS = {
  HEURE_NORMALE: 'Heure normale',
  HEURE_SUP_125: 'Heures supp. ×1.25',
  HEURE_SUP_150: 'Heures supp. ×1.50',
  MAJORATION_NUIT: 'Majoration nuit ×1.20',
  MAJORATION_DIMANCHE: 'Majoration dimanche',
  MAJORATION_FERIE: 'Majoration férié',
  ABSENCE_MALADIE: 'Absence maladie',
  CONGES_PAYES: 'Congés payés',
  PRIME_ANCIENNETE: 'Prime ancienneté',
  PRIME_PERFORMANCE: 'Prime performance',
  PRIME_PANIER: 'Prime panier',
  REMBOURSEMENT_TRANSPORT: 'Remboursement transport',
  AVANTAGE_NATURE: 'Avantage en nature',
  AUTRE: 'Autre',
};

const STATUS_LABELS = {
  A_VALIDER: 'À valider',
  VALIDE: 'Validé',
  REJETE: 'Rejeté',
  ANOMALIE: 'Anomalie IA',
};

const SHEET_STATUS_LABELS = {
  BROUILLON: 'Brouillon',
  EN_ATTENTE_SIGNATURE: 'En attente signature',
  SIGNE: 'Signé',
  REFUSE: 'Refusé',
  EXPIRE: 'Expiré',
};

const USER_INCLUDE = {
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      siteId: true,
      site: { select: { id: true, name: true } },
    },
  },
};

const { periodBoundsDates } = require('./period-utils');

function makeReference(period, userId) {
  const suffix = userId.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
  return `FH-${period}-${suffix}`;
}

function serializeSheet(sheet) {
  const u = sheet.user;
  const collab = u ? `${u.firstName} ${u.lastName.charAt(0)}.` : '—';
  return {
    id: sheet.id,
    userId: sheet.userId,
    collab,
    collabFull: u ? `${u.firstName} ${u.lastName}` : '—',
    site: u?.site?.name || '—',
    period: sheet.period,
    reference: sheet.reference,
    status: SHEET_STATUS_LABELS[sheet.status] || sheet.status,
    statusCode: sheet.status,
    generatedAt: sheet.generatedAt,
    signedAt: sheet.signedAt,
    signatureProvider: sheet.signatureProvider,
    signatureStatus: sheet.signatureStatus,
    signatureLink: sheet.signatureLink,
    signatureLevel: sheet.signatureLevel,
    hasFile: Boolean(sheet.storedName),
  };
}

async function fetchSheetData(companyId, userId, period) {
  const { start, end } = periodBoundsDates(period);
  const [user, company, variables, shifts] = await Promise.all([
    prisma.user.findFirst({
      where: { id: userId, companyId, isActive: true },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        site: { select: { name: true } },
      },
    }),
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }),
    prisma.payVariable.findMany({
      where: { companyId, userId, period },
      orderBy: { type: 'asc' },
    }),
    prisma.shift.findMany({
      where: {
        companyId,
        userId,
        date: { gte: start, lte: end },
      },
      orderBy: { date: 'asc' },
    }),
  ]);

  if (!user) return null;
  return { user, company, variables, shifts };
}

async function generateTimesheetSheet({ companyId, userId, period, generatedBy }) {
  const data = await fetchSheetData(companyId, userId, period);
  if (!data) {
    const err = new Error('Collaborateur introuvable.');
    err.status = 404;
    throw err;
  }

  const reference = makeReference(period, userId);
  const pdfBuffer = buildTimesheetPdf({
    companyName: data.company?.name,
    user: data.user,
    period,
    reference,
    variables: data.variables,
    shifts: data.shifts,
    typeLabels: TYPE_LABELS,
    statusLabels: STATUS_LABELS,
  });

  const storedName = `${randomUUID()}.pdf`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(filePath(storedName), pdfBuffer);

  const existing = await prisma.timesheetSheet.findUnique({
    where: { companyId_userId_period: { companyId, userId, period } },
  });

  if (existing?.storedName && existing.storedName !== storedName) {
    const oldPath = filePath(existing.storedName);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  const sheet = await prisma.timesheetSheet.upsert({
    where: { companyId_userId_period: { companyId, userId, period } },
    create: {
      userId,
      companyId,
      period,
      reference,
      storedName,
      status: 'BROUILLON',
      generatedBy,
      generatedAt: new Date(),
      signatureProvider: null,
      signatureRequestId: null,
      signatureSignerId: null,
      signatureStatus: null,
      signatureLink: null,
      signatureLevel: null,
      signedAt: null,
    },
    update: {
      reference,
      storedName,
      status: 'BROUILLON',
      generatedBy,
      generatedAt: new Date(),
      signatureProvider: null,
      signatureRequestId: null,
      signatureSignerId: null,
      signatureStatus: null,
      signatureLink: null,
      signatureLevel: null,
      signedAt: null,
    },
    include: USER_INCLUDE,
  });

  return sheet;
}

async function initiateTimesheetSignature(sheet) {
  if (!sheet.storedName) {
    return { skipped: true, reason: 'Générez d\'abord la feuille d\'heures (PDF).' };
  }

  const user = sheet.user || await prisma.user.findUnique({
    where: { id: sheet.userId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
    },
  });

  if (!user?.email) {
    return { skipped: true, reason: 'E-mail du collaborateur manquant.' };
  }

  const disk = filePath(sheet.storedName);
  const fileName = `feuille_heures_${sheet.period}_${user.lastName}.pdf`;

  const procedure = await yousign.createSignatureProcedure({
    filePath: disk,
    fileName,
    documentName: `Feuille d'heures — ${sheet.period}`,
    signer: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone || undefined,
    },
  });

  const signatureStatus = procedure.mode === 'live' ? 'pending' : 'initiated';
  const level = procedure.level || yousign.signatureLevel();

  const updated = await prisma.timesheetSheet.update({
    where: { id: sheet.id },
    data: {
      signatureProvider: 'yousign',
      signatureRequestId: procedure.requestId,
      signatureSignerId: procedure.signerId,
      signatureStatus,
      signatureLink: procedure.signatureLink,
      signatureLevel: level,
      status: 'EN_ATTENTE_SIGNATURE',
    },
    include: USER_INCLUDE,
  });

  if (user.email && procedure.signatureLink) {
    await sendDocumentSignatureEmail({
      to: user.email,
      firstName: user.firstName,
      documentName: `Feuille d'heures — ${sheet.period}`,
      signatureLink: procedure.signatureLink,
      providerName: yousign.PROVIDER_NAME,
      levelLabel: 'signature électronique avancée (eIDAS)',
    });
  }

  return { sheet: updated, procedure };
}

async function syncTimesheetSignature(sheet) {
  if (!sheet.signatureRequestId || !yousign.isConfigured()) return sheet;
  const remote = await yousign.fetchSignatureRequest(sheet.signatureRequestId);
  if (!remote) return sheet;

  const localStatus = yousign.mapYousignStatusToLocal(remote.status);
  const data = { signatureStatus: localStatus };

  if (localStatus === 'signed') {
    data.status = 'SIGNE';
    data.signedAt = new Date();
  } else if (localStatus === 'declined') {
    data.status = 'REFUSE';
  } else if (localStatus === 'expired') {
    data.status = 'EXPIRE';
  } else if (localStatus === 'pending' || localStatus === 'initiated') {
    data.status = 'EN_ATTENTE_SIGNATURE';
  }

  return prisma.timesheetSheet.update({
    where: { id: sheet.id },
    data,
    include: USER_INCLUDE,
  });
}

async function sendTimesheetReminder(sheet) {
  const user = sheet.user || await prisma.user.findUnique({ where: { id: sheet.userId } });
  if (!user?.email) {
    return { sent: false, reason: 'E-mail collaborateur manquant.' };
  }

  if (sheet.signatureRequestId && yousign.isConfigured()) {
    const refreshed = await syncTimesheetSignature(sheet);
    if (refreshed.status === 'SIGNE') {
      return { sent: false, reason: 'Feuille d\'heures déjà signée.' };
    }
    sheet = refreshed;
  }

  await sendDocumentReminderEmail({
    to: user.email,
    firstName: user.firstName,
    documentName: `Feuille d'heures — ${sheet.period}`,
    signatureLink: sheet.signatureLink,
  });

  return { sent: true };
}

async function applyTimesheetYousignWebhook(payload) {
  const requestId = payload?.data?.signature_request?.id
    || payload?.signature_request?.id
    || payload?.data?.id;

  if (!requestId) return { matched: false };

  const sheets = await prisma.timesheetSheet.findMany({
    where: { signatureRequestId: requestId },
  });

  if (!sheets.length) return { matched: false, requestId };

  const event = payload?.event_name || payload?.type || '';
  let localStatus = 'pending';
  if (/done|completed|signed/i.test(event)) localStatus = 'signed';
  if (/declined|refused/i.test(event)) localStatus = 'declined';
  if (/expired|canceled|cancelled/i.test(event)) localStatus = 'expired';

  for (const sheet of sheets) {
    const data = { signatureStatus: localStatus };
    if (localStatus === 'signed') {
      data.status = 'SIGNE';
      data.signedAt = new Date();
    } else if (localStatus === 'declined') {
      data.status = 'REFUSE';
    } else if (localStatus === 'expired') {
      data.status = 'EXPIRE';
    }
    await prisma.timesheetSheet.update({ where: { id: sheet.id }, data });
  }

  return { matched: true, requestId, count: sheets.length, localStatus, kind: 'timesheet' };
}

module.exports = {
  TYPE_LABELS,
  STATUS_LABELS,
  SHEET_STATUS_LABELS,
  serializeSheet,
  generateTimesheetSheet,
  initiateTimesheetSignature,
  syncTimesheetSignature,
  sendTimesheetReminder,
  applyTimesheetYousignWebhook,
  periodBoundsDates,
};
