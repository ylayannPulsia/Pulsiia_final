/**
 * Audit log — RGPD Article 30 (registre des traitements).
 * Chaque action de Pulse est loggée avec : qui, quoi, quand, sur quoi, résultat.
 *
 * Stocké en DB via Prisma. Rétention configurable via ENV (défaut 365j).
 */

async function auditLog({
  prisma,
  userId,
  tenantId,
  action,
  target,
  outcome,
  error,
  duration_ms,
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        tenantId,
        action,
        target: typeof target === 'object' ? JSON.stringify(target) : String(target ?? ''),
        outcome,
        error: error ? String(error).slice(0, 500) : null,
        durationMs: duration_ms ?? null,
        createdAt: new Date(),
      },
    });
  } catch (e) {
    // L'échec d'audit ne doit jamais casser la requête utilisateur
    console.error('[audit] write failed', e.message);
  }
}

module.exports = { auditLog };
