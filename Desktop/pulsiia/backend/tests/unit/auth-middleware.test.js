'use strict';

// Tests unitaires — CDC §14.2 "auth.test.js — JWT verify, RBAC checks (9 tests)"

const { authenticate, requireRole, requireSelfOrRole, ROLE_HIERARCHY } = require('../../src/middleware/auth');
const { signAccess } = require('../../src/lib/jwt');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('ROLE_HIERARCHY', () => {
  it('doit ordonner les rôles correctement', () => {
    expect(ROLE_HIERARCHY.COLLABORATEUR).toBeLessThan(ROLE_HIERARCHY.MANAGER);
    expect(ROLE_HIERARCHY.MANAGER).toBeLessThan(ROLE_HIERARCHY.RH);
    expect(ROLE_HIERARCHY.RH).toBeLessThan(ROLE_HIERARCHY.DRH);
    expect(ROLE_HIERARCHY.DRH).toBeLessThan(ROLE_HIERARCHY.ADMIN);
  });
});

describe('authenticate', () => {
  it('rejette une requête sans Authorization header', () => {
    const req = { headers: {} };
    const next = jest.fn();
    authenticate(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('rejette un token malformé', () => {
    const req = { headers: { authorization: 'Bearer pas-un-jwt-valide' } };
    const next = jest.fn();
    authenticate(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('attache req.user sur un token valide', () => {
    const payload = { sub: 'u1', email: 'a@b.fr', role: 'DRH', companyId: 'c1' };
    const token = signAccess(payload);
    const req = { headers: { authorization: `Bearer ${token}` } };
    const next = jest.fn();
    authenticate(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(); // sans erreur
    expect(req.user).toMatchObject({ id: 'u1', role: 'DRH', companyId: 'c1' });
  });
});

describe('requireRole', () => {
  function reqWithRole(role) {
    const payload = { sub: 'u1', email: 'a@b.fr', role, companyId: 'c1' };
    const token = signAccess(payload);
    const req = { headers: { authorization: `Bearer ${token}` } };
    authenticate(req, mockRes(), () => {});
    return req;
  }

  it('autorise un DRH sur une route requireRole("DRH")', () => {
    const req = reqWithRole('DRH');
    const next = jest.fn();
    requireRole('DRH')(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('autorise un ADMIN sur une route requireRole("DRH") (niveau supérieur)', () => {
    const req = reqWithRole('ADMIN');
    const next = jest.fn();
    requireRole('DRH')(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('bloque un COLLABORATEUR sur une route requireRole("RH")', () => {
    const req = reqWithRole('COLLABORATEUR');
    const next = jest.fn();
    requireRole('RH')(req, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('bloque si req.user est absent', () => {
    const next = jest.fn();
    requireRole('RH')({}, mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});

describe('requireSelfOrRole', () => {
  function req(userId, role, paramUserId) {
    return {
      user: { id: userId, role, companyId: 'c1' },
      params: { userId: paramUserId },
    };
  }

  it('autorise l\'utilisateur à accéder à ses propres données', () => {
    const next = jest.fn();
    requireSelfOrRole('userId', 'RH')(req('u1', 'COLLABORATEUR', 'u1'), mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('autorise un RH à accéder aux données d\'un autre utilisateur', () => {
    const next = jest.fn();
    requireSelfOrRole('userId', 'RH')(req('u2', 'RH', 'u1'), mockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('bloque un MANAGER qui essaie d\'accéder aux données d\'un autre', () => {
    const next = jest.fn();
    requireSelfOrRole('userId', 'RH')(req('u2', 'MANAGER', 'u1'), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});
