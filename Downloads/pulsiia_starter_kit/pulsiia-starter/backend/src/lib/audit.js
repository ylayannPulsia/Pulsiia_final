// Journalisation des actions utilisateur (AuditLog)
const { prisma } = require('../middleware/tenant');

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || null;
}

/**
 * Enregistre une action dans AuditLog (ne bloque jamais la requête principale).
 * @param {import('express').Request|null} req
 * @param {{ action: string, resource?: string, metadata?: object, userId?: string, companyId?: string }} opts
 */
async function logAudit(req, opts) {
  const { action, resource, metadata, userId, companyId, subjectUserId, siteId } = opts;
  if (!action) return;

  const meta = { ...(metadata || {}) };
  if (subjectUserId && !meta.subjectUserId) meta.subjectUserId = subjectUserId;
  if (siteId && !meta.siteId) meta.siteId = siteId;

  if (meta.subjectUserId && !meta.siteId) {
    try {
      const subject = await prisma.user.findFirst({
        where: { id: meta.subjectUserId },
        select: { siteId: true },
      });
      if (subject?.siteId) meta.siteId = subject.siteId;
    } catch {
      /* ignore lookup failure */
    }
  }

  try {
    await prisma.auditLog.create({
      data: {
        userId: userId ?? req?.user?.id ?? null,
        companyId: companyId ?? req?.user?.companyId ?? null,
        action,
        resource: resource ?? null,
        ipAddress: req ? clientIp(req) : null,
        userAgent: req?.headers?.['user-agent']?.slice(0, 500) ?? null,
        metadata: Object.keys(meta).length ? meta : undefined,
      },
    });
  } catch (err) {
    console.error('[audit]', err.message);
  }
}

module.exports = { logAudit };
