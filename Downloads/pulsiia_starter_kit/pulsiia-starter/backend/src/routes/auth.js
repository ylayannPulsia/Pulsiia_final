// src/routes/auth.js — Login, refresh, logout, me, change-password
const router = require('express').Router();
const bcrypt = require('bcrypt');
const { signAccess, signRefresh, verifyAccess, verifyRefresh } = require('../lib/jwt');
const { body, query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { prisma } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const { logAudit } = require('../lib/audit');
const { sendPasswordResetEmail } = require('../lib/mail');
const {
  findUsersByEmail,
  syncPasswordHashForEmail,
  getInvitationByRawToken,
  acceptCompanyInvitation,
} = require('../lib/company-invitation');
const { generateSecret, keyUri, verifyToken } = require('../lib/totp');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 5,
  message: { error: 'Trop de tentatives de connexion, réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function userLoginPayload(user) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    avatarColor: user.avatarColor,
    companyId: user.companyId,
    siteId: user.siteId,
    companyName: user.company?.name || null,
  };
}

async function findActiveUsersWithPassword(email) {
  const users = await findUsersByEmail(email);
  return users.filter((u) => u.isActive && u.passwordHash);
}

async function verifyPasswordForEmail(email, password) {
  const candidates = await findActiveUsersWithPassword(email);
  if (!candidates.length) return { ok: false, users: [] };

  for (const user of candidates) {
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (valid) return { ok: true, users: candidates };
  }
  return { ok: false, users: candidates };
}

async function completeLogin(req, res, user) {
  const { accessToken, refreshToken } = generateTokens(user.id);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: { token: refreshToken, userId: user.id, expiresAt },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLogin: new Date() },
  });

  res.json({
    accessToken,
    refreshToken,
    user: userLoginPayload(user),
  });

  await logAudit(req, {
    action: 'auth.login',
    resource: `user:${user.id}`,
    userId: user.id,
    companyId: user.companyId,
    subjectUserId: user.id,
    siteId: user.siteId,
    metadata: { email: user.email },
  });
}

function generateTokens(userId) {
  const accessToken = signAccess({ userId });
  const refreshToken = signRefresh({ userId });
  return { accessToken, refreshToken };
}

// ── POST /api/auth/login ───────────────────────────────────────
router.post('/login',
  loginLimiter,
  [
    body('email').isEmail().withMessage('Adresse e-mail invalide.'),
    body('password').isLength({ min: 1 }).withMessage('Mot de passe requis.'),
  ],
  async (req, res, next) => {
    if (!handleValidation(req, res)) return;

    try {
      const { email, password } = req.body;
      const normalizedEmail = email.toLowerCase();
      const { ok, users } = await verifyPasswordForEmail(normalizedEmail, password);

      if (!users.length) {
        return res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' });
      }
      if (!ok) {
        return res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' });
      }

      if (users.length > 1) {
        const selectionToken = signAccess(
          { purpose: 'company-select', email: normalizedEmail },
          { expiresIn: '5m' },
        );
        return res.json({
          requiresCompanySelection: true,
          selectionToken,
          companies: users.map((u) => ({
            userId: u.id,
            companyId: u.companyId,
            companyName: u.company?.name || 'Entreprise',
            role: u.role,
            firstName: u.firstName,
            lastName: u.lastName,
          })),
          message: 'Choisissez l\'entreprise à laquelle vous connecter.',
        });
      }

      const user = users[0];

      if (user.twoFactorEnabled && user.twoFactorSecret) {
        const challengeToken = signAccess(
          { userId: user.id, purpose: '2fa' },
          { expiresIn: '5m' },
        );
        return res.json({
          requires2FA: true,
          challengeToken,
          message: 'Saisissez le code de votre application d\'authentification.',
        });
      }

      await completeLogin(req, res, user);
    } catch (err) {
      console.error('[auth/login]', err);
      if (err.name === 'PrismaClientInitializationError' || /Can't reach database/i.test(err.message)) {
        return res.status(503).json({
          error: 'Base de données indisponible. Lancez PostgreSQL : docker compose up -d postgres (dans pulsiia-starter).',
        });
      }
      next(err);
    }
  }
);

// ── POST /api/auth/select-company ─────────────────────────────
router.post('/select-company',
  loginLimiter,
  [
    body('selectionToken').isString().notEmpty().withMessage('Jeton requis.'),
    body('userId').isString().notEmpty().withMessage('Entreprise requise.'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    let decoded;
    try {
      decoded = verifyAccess(req.body.selectionToken);
    } catch {
      return res.status(401).json({ error: 'Session expirée — reconnectez-vous.' });
    }

    if (decoded.purpose !== 'company-select' || !decoded.email) {
      return res.status(401).json({ error: 'Jeton invalide.' });
    }

    const user = await prisma.user.findFirst({
      where: {
        id: req.body.userId,
        email: decoded.email,
        isActive: true,
      },
      include: { company: { select: { name: true } } },
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Compte introuvable.' });
    }

    if (user.twoFactorEnabled && user.twoFactorSecret) {
      const challengeToken = signAccess(
        { userId: user.id, purpose: '2fa' },
        { expiresIn: '5m' },
      );
      return res.json({
        requires2FA: true,
        challengeToken,
        message: 'Saisissez le code de votre application d\'authentification.',
      });
    }

    await completeLogin(req, res, user);
  },
);

// ── GET /api/auth/invitation ──────────────────────────────────
router.get('/invitation',
  [query('token').isString().notEmpty().withMessage('Jeton requis.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const check = await getInvitationByRawToken(req.query.token);
    if (!check) {
      return res.status(404).json({ error: 'Invitation introuvable.' });
    }

    const { invitation, valid, reason } = check;
    res.json({
      valid: !!valid,
      reason: reason || null,
      invitation: {
        email: invitation.email,
        firstName: invitation.firstName,
        lastName: invitation.lastName,
        companyName: invitation.company?.name || null,
        expiresAt: invitation.expiresAt,
      },
    });
  },
);

// ── POST /api/auth/accept-invitation ──────────────────────────
router.post('/accept-invitation',
  loginLimiter,
  [body('token').isString().notEmpty().withMessage('Jeton requis.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    try {
      const authHeader = req.headers.authorization;
      let expectedEmail;
      if (authHeader?.startsWith('Bearer ')) {
        try {
          const decoded = verifyAccess(authHeader.slice(7));
          const sessionUser = await prisma.user.findUnique({ where: { id: decoded.userId } });
          expectedEmail = sessionUser?.email;
        } catch {
          /* optional auth */
        }
      }

      const { user, company } = await acceptCompanyInvitation(req.body.token, { expectedEmail });
      const fullUser = await prisma.user.findUnique({
        where: { id: user.id },
        include: { company: { select: { name: true } } },
      });

      if (expectedEmail) {
        await completeLogin(req, res, fullUser);
        return;
      }

      res.json({
        ok: true,
        message: `Vous avez rejoint ${company?.name || 'l\'entreprise'}. Connectez-vous avec votre e-mail et mot de passe habituels.`,
        companyName: company?.name || null,
        email: user.email,
      });
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Impossible d\'accepter l\'invitation.' });
    }
  },
);

// ── POST /api/auth/refresh ─────────────────────────────────────
router.post('/refresh',
  [body('refreshToken').isString().notEmpty().withMessage('Jeton de rafraîchissement requis.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { refreshToken } = req.body;

    try {
      const decoded = verifyRefresh(refreshToken);
      const stored = await prisma.refreshToken.findUnique({
        where: { token: refreshToken },
      });

      if (!stored || stored.expiresAt < new Date()) {
        return res.status(401).json({ error: 'Jeton de rafraîchissement invalide ou expiré.' });
      }

      const tokens = generateTokens(decoded.userId);

      await prisma.refreshToken.delete({ where: { token: refreshToken } });
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await prisma.refreshToken.create({
        data: { token: tokens.refreshToken, userId: decoded.userId, expiresAt },
      });

      res.json(tokens);
    } catch {
      res.status(401).json({ error: 'Jeton de rafraîchissement invalide.' });
    }
  }
);

// ── POST /api/auth/logout ──────────────────────────────────────
router.post('/logout',
  [body('refreshToken').optional().isString()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { refreshToken } = req.body;
    if (refreshToken) {
      await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
    }
    res.json({ message: 'Déconnexion réussie.' });
  }
);

// ── GET /api/auth/me ───────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      jobTitle: true,
      avatarColor: true,
      companyId: true,
      siteId: true,
      twoFactorEnabled: true,
      company: { select: { name: true } },
      site: { select: { name: true } },
    },
  });
  res.json(user);
});

// ── POST /api/auth/change-password ─────────────────────────────
router.post('/change-password',
  authenticate,
  [
    body('currentPassword').isLength({ min: 1 }).withMessage('Mot de passe actuel requis.'),
    body('newPassword').isLength({ min: 8 }).withMessage('Le nouveau mot de passe doit contenir au moins 8 caractères.'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { currentPassword, newPassword } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await syncPasswordHashForEmail(user.email, passwordHash);

    await prisma.refreshToken.deleteMany({ where: { user: { email: user.email.toLowerCase() } } });

    res.json({ message: 'Mot de passe modifié — toutes les sessions ont été déconnectées.' });
  }
);

// ── POST /api/auth/forgot-password ────────────────────────────
router.post('/forgot-password',
  loginLimiter,
  [body('email').isEmail().withMessage('Adresse e-mail invalide.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const email = req.body.email.toLowerCase();
    const users = await findActiveUsersWithPassword(email);

    const generic = { message: 'Si un compte existe avec cet e-mail, un lien de réinitialisation a été envoyé.' };

    if (!users.length) {
      return res.json(generic);
    }

    const user = users[0];

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetUrl = `${frontendUrl}/reset-password.html?token=${rawToken}`;

    try {
      const result = await sendPasswordResetEmail({
        to: user.email,
        firstName: user.firstName,
        resetUrl,
      });
      if (!result.sent) {
        console.log('[auth] reset link (dev):', resetUrl);
      }
    } catch (err) {
      console.warn('[auth] reset email failed:', err.message);
      console.log('[auth] reset link (fallback):', resetUrl);
    }

    await logAudit(req, { action: 'auth.forgot_password', resource: `user:${user.id}`, userId: user.id, companyId: user.companyId });
    res.json(generic);
  },
);

// ── POST /api/auth/reset-password ─────────────────────────────
router.post('/reset-password',
  loginLimiter,
  [
    body('token').isString().notEmpty().withMessage('Jeton requis.'),
    body('newPassword').isLength({ min: 8 }).withMessage('Le mot de passe doit contenir au moins 8 caractères.'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const tokenHash = crypto.createHash('sha256').update(req.body.token).digest('hex');
    const row = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!row || row.usedAt || row.expiresAt < new Date() || !row.user.isActive) {
      return res.status(400).json({ error: 'Lien invalide ou expiré — demandez un nouveau lien.' });
    }

    const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    const email = row.user.email.toLowerCase();
    await prisma.$transaction([
      prisma.user.updateMany({ where: { email }, data: { passwordHash } }),
      prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.deleteMany({ where: { user: { email } } }),
    ]);

    res.json({ message: 'Mot de passe réinitialisé — vous pouvez vous connecter.' });
  },
);

// ── POST /api/auth/2fa/verify-login ───────────────────────────
router.post('/2fa/verify-login',
  loginLimiter,
  [
    body('challengeToken').isString().notEmpty().withMessage('Jeton requis.'),
    body('code').isString().notEmpty().withMessage('Code requis.'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    let decoded;
    try {
      decoded = verifyAccess(req.body.challengeToken);
    } catch {
      return res.status(401).json({ error: 'Session expirée — reconnectez-vous.' });
    }

    if (decoded.purpose !== '2fa' || !decoded.userId) {
      return res.status(401).json({ error: 'Jeton invalide.' });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user || !user.isActive || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return res.status(401).json({ error: 'Compte ou 2FA invalide.' });
    }

    if (!verifyToken(user.twoFactorSecret, req.body.code)) {
      return res.status(401).json({ error: 'Code incorrect.' });
    }

    await completeLogin(req, res, user);
  },
);

// ── GET /api/auth/2fa/status ───────────────────────────────────
router.get('/2fa/status', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { twoFactorEnabled: true },
  });
  res.json({ enabled: !!user?.twoFactorEnabled });
});

// ── POST /api/auth/2fa/setup ───────────────────────────────────
router.post('/2fa/setup', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  if (user.twoFactorEnabled) {
    return res.status(409).json({ error: 'La double authentification est déjà activée.' });
  }

  const secret = generateSecret();
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorPendingSecret: secret },
  });

  const otpauthUrl = keyUri(user.email, secret);
  res.json({
    secret,
    otpauthUrl,
    message: 'Scannez le QR code ou saisissez la clé dans Google Authenticator, puis validez avec un code.',
  });
});

// ── POST /api/auth/2fa/enable ──────────────────────────────────
router.post('/2fa/enable',
  authenticate,
  [body('code').isString().notEmpty().withMessage('Code requis.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user?.twoFactorPendingSecret) {
      return res.status(400).json({ error: 'Aucune configuration en cours — relancez l\'activation.' });
    }
    if (!verifyToken(user.twoFactorPendingSecret, req.body.code)) {
      return res.status(401).json({ error: 'Code incorrect.' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: true,
        twoFactorSecret: user.twoFactorPendingSecret,
        twoFactorPendingSecret: null,
      },
    });

    await logAudit(req, { action: 'auth.2fa_enable', resource: `user:${user.id}`, userId: user.id, companyId: user.companyId });
    res.json({ enabled: true, message: 'Double authentification activée.' });
  },
);

// ── POST /api/auth/2fa/disable ─────────────────────────────────
router.post('/2fa/disable',
  authenticate,
  [
    body('password').isLength({ min: 1 }).withMessage('Mot de passe requis.'),
    body('code').isString().notEmpty().withMessage('Code requis.'),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user?.twoFactorEnabled || !user.twoFactorSecret) {
      return res.status(400).json({ error: 'La double authentification n\'est pas activée.' });
    }

    const validPwd = await bcrypt.compare(req.body.password, user.passwordHash);
    if (!validPwd) return res.status(401).json({ error: 'Mot de passe incorrect.' });
    if (!verifyToken(user.twoFactorSecret, req.body.code)) {
      return res.status(401).json({ error: 'Code incorrect.' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorPendingSecret: null,
      },
    });

    await logAudit(req, { action: 'auth.2fa_disable', resource: `user:${user.id}`, userId: user.id, companyId: user.companyId });
    res.json({ enabled: false, message: 'Double authentification désactivée.' });
  },
);

// ── POST /api/auth/revoke-sessions ─────────────────────────────
router.post('/revoke-sessions', authenticate, async (req, res) => {
  await prisma.refreshToken.deleteMany({ where: { userId: req.user.id } });
  await logAudit(req, { action: 'auth.revoke_sessions', resource: `user:${req.user.id}`, userId: req.user.id, companyId: req.user.companyId });
  res.json({ message: 'Toutes les sessions ont été déconnectées.' });
});

// ── POST /api/auth/check-domain ────────────────────────────────
router.post('/check-domain',
  [body('email').isEmail().withMessage('Adresse e-mail invalide.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { email } = req.body;
    const domain = email.split('@')[1];
    const company = await prisma.company.findFirst({
      where: { ssoDomain: domain },
      select: { ssoProvider: true, name: true },
    });

    if (company?.ssoProvider) {
      return res.json({
        mode: 'sso',
        provider: company.ssoProvider,
        companyName: company.name,
      });
    }

    res.json({ mode: 'password' });
  }
);

module.exports = router;
