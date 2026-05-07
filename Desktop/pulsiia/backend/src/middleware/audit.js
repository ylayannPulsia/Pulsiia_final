'use strict';

const prisma = require('../lib/prisma');

// Middleware qui loggue les actions sensibles dans AuditLog.
// Usage : router.post('/route', authenticate, audit('action.name'), handler)
function audit(action, resourceFn) {
  return async (req, res, next) => {
    // On exécute le vrai handler, puis on log après la réponse (non-bloquant).
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      originalJson(body);
      // Log de façon asynchrone, on ne bloque pas la réponse
      setImmediate(async () => {
        try {
          const resource = typeof resourceFn === 'function' ? resourceFn(req, body) : null;
          await prisma.auditLog.create({
            data: {
              companyId: req.user?.companyId ?? null,
              userId: req.user?.id ?? null,
              action,
              resource,
              ipAddress: req.ip,
              userAgent: req.headers['user-agent'],
              metadata: {
                method: req.method,
                path: req.path,
                statusCode: res.statusCode,
              },
            },
          });
        } catch {
          // Ne jamais faire crasher l'app pour un log raté
        }
      });
    };
    next();
  };
}

module.exports = { audit };
