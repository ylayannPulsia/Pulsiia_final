const { Router } = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/security');

const router = Router();
const prisma = new PrismaClient();

const signAccess = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role, nom: user.nom, prenom: user.prenom, siteId: user.siteId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );

const signRefresh = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN });

// POST /api/auth/login
router.post(
  '/login',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Email ou mot de passe invalide' });

    const { email, password } = req.body;
    const user = await prisma.user.findUnique({
      where: { email },
      include: { site: { select: { nom: true } } },
    });

    if (!user || !user.actif) return res.status(401).json({ error: 'Identifiants incorrects' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Identifiants incorrects' });

    const accessToken = signAccess(user);
    const refreshToken = signRefresh(user.id);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await prisma.refreshToken.create({ data: { userId: user.id, token: refreshToken, expiresAt } });

    return res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        nom: user.nom,
        prenom: user.prenom,
        role: user.role,
        poste: user.poste,
        siteId: user.siteId,
        siteNom: user.site?.nom,
      },
    });
  }
);

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Token manquant' });

  let payload;
  try {
    payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token invalide' });
  }

  const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
  if (!stored || new Date(stored.expiresAt) < new Date()) {
    return res.status(401).json({ error: 'Session expirée' });
  }

  const user = await prisma.user.findUnique({ where: { id: payload.id } });
  if (!user || !user.actif) return res.status(401).json({ error: 'Compte désactivé' });

  return res.json({ accessToken: signAccess(user) });
});

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
  }
  return res.json({ message: 'Déconnecté' });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, email: true, nom: true, prenom: true, role: true, poste: true, telephone: true, siteId: true, site: { select: { nom: true } } },
  });
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  return res.json(user);
});

// PATCH /api/auth/profile
router.patch('/profile', requireAuth, [
  body('nom').optional().trim().notEmpty(),
  body('prenom').optional().trim().notEmpty(),
  body('telephone').optional().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { nom, prenom, telephone } = req.body;
  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: { ...(nom && { nom }), ...(prenom && { prenom }), ...(telephone !== undefined && { telephone }) },
    select: { id: true, email: true, nom: true, prenom: true, role: true, poste: true, telephone: true },
  });
  return res.json(updated);
});

// PATCH /api/auth/password
router.patch('/password', requireAuth, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Données invalides' });

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const ok = await bcrypt.compare(req.body.currentPassword, user.password);
  if (!ok) return res.status(400).json({ error: 'Mot de passe actuel incorrect' });

  const hashed = await bcrypt.hash(req.body.newPassword, 12);
  await prisma.user.update({ where: { id: req.user.id }, data: { password: hashed } });
  await prisma.refreshToken.deleteMany({ where: { userId: req.user.id } });
  return res.json({ message: 'Mot de passe modifié. Reconnectez-vous.' });
});

module.exports = router;
