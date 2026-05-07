'use strict';

const { Router } = require('express');
const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { signAccess, signRefresh, verifyRefresh, hashJti } = require('../lib/jwt');
const { authenticate } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { AuthError, ValidationError, NotFoundError, ConflictError } = require('../utils/errors');

const router = Router();

const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 12);
const RESET_TTL_MS = Number(process.env.RESET_TOKEN_TTL_MINUTES || 30) * 60 * 1000;

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function buildAccessPayload(user) {
  return {
    sub: user.id,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
  };
}

async function createRefreshToken(user, req) {
  const { token, jti } = signRefresh(buildAccessPayload(user));
  const tokenHash = hashJti(jti);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7j
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
      expiresAt,
    },
  });
  return token;
}

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const first = result.error.issues[0];
      return next(new ValidationError(first.message));
    }
    req.validated = result.data;
    next();
  };
}

// ─── POST /api/auth/check-domain ─────────────────────────────────────────────
// Retourne le mode d'auth selon le domaine email (CDC §5.2 étape 1)
router.post(
  '/check-domain',
  validate(z.object({ email: z.string().email('Adresse e-mail invalide') })),
  async (req, res, next) => {
    try {
      const { email } = req.validated;
      const domain = email.split('@')[1].toLowerCase();
      const company = await prisma.company.findFirst({
        where: { emailDomain: domain },
        select: { authMode: true, name: true },
      });
      // Si domaine inconnu → mode PASSWORD par défaut (pas d'info de sécurité exposée)
      res.json({
        authMode: company?.authMode ?? 'PASSWORD',
        companyName: company?.name ?? null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post(
  '/login',
  validate(
    z.object({
      email: z.string().email('Adresse e-mail invalide'),
      password: z.string().min(1, 'Mot de passe requis'),
    }),
  ),
  audit('auth.login'),
  async (req, res, next) => {
    try {
      const { email, password } = req.validated;
      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() },
      });

      if (!user || !user.passwordHash) {
        return next(new AuthError('Email ou mot de passe incorrect', 'INVALID_CREDENTIALS'));
      }
      if (!user.isActive) {
        return next(new AuthError('Compte désactivé — contactez votre administrateur', 'ACCOUNT_DISABLED'));
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return next(new AuthError('Email ou mot de passe incorrect', 'INVALID_CREDENTIALS'));
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      const accessToken = signAccess(buildAccessPayload(user));
      const refreshToken = await createRefreshToken(user, req);

      res.json({
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          companyId: user.companyId,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
router.post(
  '/refresh',
  validate(z.object({ refreshToken: z.string().min(1, 'Refresh token requis') })),
  async (req, res, next) => {
    try {
      const { refreshToken } = req.validated;
      let payload;
      try {
        payload = verifyRefresh(refreshToken);
      } catch {
        return next(new AuthError('Refresh token invalide ou expiré', 'TOKEN_INVALID'));
      }

      const tokenHash = hashJti(payload.jti);
      const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

      if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
        return next(new AuthError('Session révoquée — veuillez vous reconnecter', 'TOKEN_REVOKED'));
      }

      const user = await prisma.user.findUnique({ where: { id: stored.userId } });
      if (!user || !user.isActive) {
        return next(new AuthError('Compte désactivé', 'ACCOUNT_DISABLED'));
      }

      // Rotation du refresh token (single-use)
      await prisma.refreshToken.update({ where: { tokenHash }, data: { revokedAt: new Date() } });

      const newAccess = signAccess(buildAccessPayload(user));
      const newRefresh = await createRefreshToken(user, req);

      res.json({ accessToken: newAccess, refreshToken: newRefresh });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post(
  '/logout',
  validate(z.object({ refreshToken: z.string().optional() })),
  audit('auth.logout'),
  async (req, res, next) => {
    try {
      const { refreshToken } = req.validated;
      if (refreshToken) {
        try {
          const payload = verifyRefresh(refreshToken);
          const tokenHash = hashJti(payload.jti);
          await prisma.refreshToken.updateMany({
            where: { tokenHash, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        } catch {
          // Token déjà invalide → pas d'erreur, le logout doit toujours réussir
        }
      }
      res.json({ message: 'Déconnexion réussie' });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        role: true, companyId: true, jobTitle: true, phone: true,
        isActive: true, lastLoginAt: true, totpEnabled: true,
        primarySite: { select: { id: true, name: true, city: true } },
        company: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!user) return next(new AuthError());
    res.json(user);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/auth/change-password ──────────────────────────────────────────
router.post(
  '/change-password',
  authenticate,
  validate(
    z.object({
      currentPassword: z.string().min(1, 'Mot de passe actuel requis'),
      newPassword: z
        .string()
        .min(8, 'Le nouveau mot de passe doit faire au moins 8 caractères')
        .regex(/[A-Z]/, 'Doit contenir au moins une majuscule')
        .regex(/[0-9]/, 'Doit contenir au moins un chiffre'),
    }),
  ),
  audit('auth.change-password'),
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.validated;
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!user?.passwordHash) return next(new AuthError());

      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) return next(new AuthError('Mot de passe actuel incorrect', 'INVALID_CREDENTIALS'));

      const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
      await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
      // Révoquer tous les refresh tokens existants (sécurité)
      await prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      res.json({ message: 'Mot de passe modifié avec succès' });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────
router.post(
  '/forgot-password',
  validate(z.object({ email: z.string().email('Adresse e-mail invalide') })),
  async (req, res, next) => {
    try {
      const { email } = req.validated;
      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
      // Réponse identique que l'email existe ou non (anti-énumération)
      const SUCCESS = { message: 'Si ce compte existe, un email de réinitialisation a été envoyé' };
      if (!user || !user.isActive) return res.json(SUCCESS);

      const rawToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const resetTokenExpiresAt = new Date(Date.now() + RESET_TTL_MS);

      await prisma.user.update({
        where: { id: user.id },
        data: { resetTokenHash, resetTokenExpiresAt },
      });

      // TODO Phase 2 : envoyer l'email via services/email.js
      // await emailService.sendPasswordReset(user.email, rawToken);
      if (process.env.NODE_ENV === 'development') {
        console.log(`[DEV] Reset token for ${email}: ${rawToken}`);
      }

      res.json(SUCCESS);
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
router.post(
  '/reset-password',
  validate(
    z.object({
      token: z.string().min(1, 'Token requis'),
      newPassword: z
        .string()
        .min(8, 'Le mot de passe doit faire au moins 8 caractères')
        .regex(/[A-Z]/, 'Doit contenir au moins une majuscule')
        .regex(/[0-9]/, 'Doit contenir au moins un chiffre'),
    }),
  ),
  audit('auth.reset-password'),
  async (req, res, next) => {
    try {
      const { token, newPassword } = req.validated;
      const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const user = await prisma.user.findFirst({
        where: {
          resetTokenHash,
          resetTokenExpiresAt: { gt: new Date() },
          isActive: true,
        },
      });
      if (!user) {
        return next(new AuthError('Token invalide ou expiré — demandez un nouveau lien', 'TOKEN_INVALID'));
      }
      const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, resetTokenHash: null, resetTokenExpiresAt: null },
      });
      await prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      res.json({ message: 'Mot de passe réinitialisé avec succès — vous pouvez vous connecter' });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
