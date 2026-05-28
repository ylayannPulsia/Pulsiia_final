// lib/company-invitation.js — Invitations multi-sociétés (même e-mail, plusieurs entreprises)
const crypto = require('crypto');
const { prisma } = require('../middleware/tenant');

const INVITE_TTL_DAYS = 14;

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function buildAcceptInvitationUrl(rawToken) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  return `${frontendUrl}/accept-invitation.html?token=${encodeURIComponent(rawToken)}`;
}

async function findUsersByEmail(email) {
  return prisma.user.findMany({
    where: { email: email.toLowerCase() },
    include: { company: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
}

async function findCredentialSource(email) {
  const users = await findUsersByEmail(email);
  return users.find((u) => u.passwordHash) || users[0] || null;
}

async function syncPasswordHashForEmail(email, passwordHash) {
  await prisma.user.updateMany({
    where: { email: email.toLowerCase() },
    data: { passwordHash },
  });
}

async function findUserInCompany(email, companyId) {
  return prisma.user.findUnique({
    where: { companyId_email: { companyId, email: email.toLowerCase() } },
  });
}

async function findPendingInvitation(email, companyId) {
  const now = new Date();
  return prisma.companyInvitation.findFirst({
    where: {
      email: email.toLowerCase(),
      companyId,
      status: 'PENDING',
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
  });
}

function normalizeStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
}

function invitationProfileFromBody(body) {
  const role = body.role || 'COLLABORATEUR';
  const contractType = body.contractType || 'CDI';
  return {
    firstName: body.firstName,
    lastName: body.lastName,
    role: ['COLLABORATEUR', 'MANAGER', 'RH', 'DRH', 'ADMIN'].includes(role) ? role : 'COLLABORATEUR',
    jobTitle: body.jobTitle || null,
    phone: body.phone || null,
    siteId: body.siteId || null,
    managerId: body.managerId || null,
    contractType: ['CDI', 'CDD', 'INTERIM'].includes(contractType) ? contractType : 'CDI',
    contractEndDate: body.contractEndDate ? new Date(body.contractEndDate) : null,
    weeklyHours: body.weeklyHours != null ? Number(body.weeklyHours) : null,
    hourlyRate: body.hourlyRate != null ? Number(body.hourlyRate) : null,
    competences: normalizeStringArray(body.competences),
    secondaryRoles: normalizeStringArray(body.secondaryRoles),
    avatarColor: body.avatarColor || null,
  };
}

async function createCompanyInvitation({
  companyId,
  email,
  invitedById,
  profile,
}) {
  const normalizedEmail = email.toLowerCase();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.companyInvitation.updateMany({
    where: {
      email: normalizedEmail,
      companyId,
      status: 'PENDING',
    },
    data: { status: 'CANCELLED' },
  });

  const invitation = await prisma.companyInvitation.create({
    data: {
      tokenHash,
      email: normalizedEmail,
      companyId,
      invitedById: invitedById || null,
      expiresAt,
      ...profile,
    },
    include: {
      company: { select: { name: true } },
    },
  });

  return {
    invitation,
    rawToken,
    acceptUrl: buildAcceptInvitationUrl(rawToken),
  };
}

async function getInvitationByRawToken(rawToken) {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const row = await prisma.companyInvitation.findUnique({
    where: { tokenHash },
    include: { company: { select: { id: true, name: true } } },
  });
  if (!row) return null;
  if (row.status !== 'PENDING') return { invitation: row, valid: false, reason: 'used' };
  if (row.expiresAt < new Date()) {
    await prisma.companyInvitation.update({
      where: { id: row.id },
      data: { status: 'EXPIRED' },
    });
    return { invitation: row, valid: false, reason: 'expired' };
  }
  return { invitation: row, valid: true };
}

async function acceptCompanyInvitation(rawToken, { expectedEmail } = {}) {
  const check = await getInvitationByRawToken(rawToken);
  if (!check) {
    const err = new Error('Invitation introuvable.');
    err.status = 404;
    throw err;
  }
  if (!check.valid) {
    const msg = check.reason === 'expired'
      ? 'Cette invitation a expiré — demandez-en une nouvelle à votre RH.'
      : 'Cette invitation a déjà été utilisée ou annulée.';
    const err = new Error(msg);
    err.status = 400;
    throw err;
  }

  const inv = check.invitation;
  if (expectedEmail && inv.email !== expectedEmail.toLowerCase()) {
    const err = new Error('Cette invitation ne correspond pas à votre compte connecté.');
    err.status = 403;
    throw err;
  }

  const existing = await findUserInCompany(inv.email, inv.companyId);
  if (existing?.isActive) {
    const err = new Error('Vous faites déjà partie de cette entreprise.');
    err.status = 409;
    throw err;
  }

  const credentialSource = await findCredentialSource(inv.email);

  const userData = {
    email: inv.email,
    firstName: inv.firstName,
    lastName: inv.lastName,
    role: inv.role,
    jobTitle: inv.jobTitle,
    phone: inv.phone,
    siteId: inv.siteId,
    managerId: inv.managerId,
    contractType: inv.contractType,
    contractEndDate: inv.contractEndDate,
    weeklyHours: inv.weeklyHours,
    hourlyRate: inv.hourlyRate,
    competences: inv.competences,
    secondaryRoles: inv.secondaryRoles,
    avatarColor: inv.avatarColor,
    companyId: inv.companyId,
    isActive: true,
    passwordHash: credentialSource?.passwordHash || null,
  };

  let user;
  if (existing) {
    user = await prisma.user.update({
      where: { id: existing.id },
      data: userData,
    });
  } else {
    user = await prisma.user.create({ data: userData });
  }

  await prisma.companyInvitation.update({
    where: { id: inv.id },
    data: { status: 'ACCEPTED', acceptedAt: new Date() },
  });

  return { user, company: inv.company };
}

module.exports = {
  INVITE_TTL_DAYS,
  hashToken,
  buildAcceptInvitationUrl,
  findUsersByEmail,
  findCredentialSource,
  syncPasswordHashForEmail,
  findUserInCompany,
  findPendingInvitation,
  invitationProfileFromBody,
  createCompanyInvitation,
  getInvitationByRawToken,
  acceptCompanyInvitation,
};
