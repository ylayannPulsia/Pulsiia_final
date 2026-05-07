'use strict';

const { verifyAccess } = require('../lib/jwt');
const { AuthError, ForbiddenError } = require('../utils/errors');

const ROLE_HIERARCHY = {
  COLLABORATEUR: 0,
  MANAGER: 1,
  RH: 2,
  DRH: 3,
  ADMIN: 4,
};

// Extrait et vérifie le Bearer token → attache req.user
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AuthError('Token manquant ou invalide'));
  }
  const token = header.slice(7);
  try {
    const payload = verifyAccess(token);
    req.user = {
      id: payload.sub,
      role: payload.role,
      companyId: payload.companyId,
      email: payload.email,
    };
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError'
      ? 'Session expirée — veuillez vous reconnecter'
      : 'Token invalide';
    next(new AuthError(msg, 'TOKEN_INVALID'));
  }
}

// Autorise si le rôle de l'utilisateur est >= au rôle minimum requis
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new AuthError());
    const userLevel = ROLE_HIERARCHY[req.user.role] ?? -1;
    const minLevel = Math.min(...roles.map((r) => ROLE_HIERARCHY[r] ?? Infinity));
    if (userLevel < minLevel) {
      return next(new ForbiddenError(
        `Accès réservé aux rôles : ${roles.join(', ')}`,
        'INSUFFICIENT_ROLE',
      ));
    }
    next();
  };
}

// Vérifie que l'utilisateur accède à ses propres données ou est RH/DRH/ADMIN
function requireSelfOrRole(paramKey = 'userId', ...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new AuthError());
    const targetId = req.params[paramKey];
    if (req.user.id === targetId) return next();
    const userLevel = ROLE_HIERARCHY[req.user.role] ?? -1;
    const minLevel = Math.min(...roles.map((r) => ROLE_HIERARCHY[r] ?? Infinity));
    if (userLevel >= minLevel) return next();
    next(new ForbiddenError('Accès refusé à cette ressource', 'SELF_OR_ROLE_REQUIRED'));
  };
}

module.exports = { authenticate, requireRole, requireSelfOrRole, ROLE_HIERARCHY };
