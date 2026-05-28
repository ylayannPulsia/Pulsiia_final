// src/middleware/auth.js — JWT + RBAC
const { verifyAccess } = require('../lib/jwt');
const { prisma } = require('./tenant');

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant.' });
  }

  const token = header.slice(7);
  try {
    const decoded = verifyAccess(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, companyId: true, siteId: true, isActive: true },
    });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Compte introuvable ou désactivé.' });
    }
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expiré.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Token invalide.' });
  }
}

function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Non authentifié.' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès refusé pour ce rôle.' });
    }
    next();
  };
}

module.exports = { authenticate, authorize };
