'use strict';

const { Router } = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { authenticate, requireRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');

const router = Router();
router.use(authenticate);

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(new ValidationError(result.error.errors[0].message));
    req.body = result.data;
    next();
  };
}

function slugify(str) {
  return str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const channelSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(300).optional(),
  kind: z.enum(['ANNOUNCEMENT', 'TEAM', 'CUSTOM']).default('TEAM'),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/).optional(),
});

const messageSchema = z.object({
  content: z.string().min(1).max(4000),
  parentId: z.string().cuid().optional(),
});

// ─── CHANNELS ────────────────────────────────────────────────────────────────

// GET /api/communication/channels
router.get('/channels', async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const { archived } = req.query;

    const channels = await prisma.channel.findMany({
      where: {
        companyId,
        isArchived: archived === 'true' ? true : false,
      },
      include: {
        _count: { select: { messages: true } },
      },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });

    res.json({ channels });
  } catch (err) {
    next(err);
  }
});

// POST /api/communication/channels
router.post('/channels', requireRole('RH'), validate(channelSchema), audit('communication.channel.create'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const { name, description, kind } = req.body;
    const slug = req.body.slug || slugify(name);

    const existing = await prisma.channel.findUnique({ where: { companyId_slug: { companyId, slug } } });
    if (existing) return next(new ValidationError('Un canal avec ce slug existe déjà'));

    const channel = await prisma.channel.create({
      data: { companyId, name, description, kind, slug },
    });

    res.status(201).json(channel);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/communication/channels/:id
router.patch('/channels/:id', requireRole('RH'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const channel = await prisma.channel.findFirst({ where: { id: req.params.id, companyId } });
    if (!channel) return next(new NotFoundError('Canal introuvable'));

    const { name, description, isArchived } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (isArchived !== undefined) data.isArchived = isArchived;

    const updated = await prisma.channel.update({ where: { id: req.params.id }, data });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/communication/channels/:id
router.delete('/channels/:id', requireRole('DRH'), audit('communication.channel.delete'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const channel = await prisma.channel.findFirst({ where: { id: req.params.id, companyId } });
    if (!channel) return next(new NotFoundError('Canal introuvable'));
    await prisma.channel.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── MESSAGES ────────────────────────────────────────────────────────────────

// GET /api/communication/channels/:channelId/messages
// ?before=<cursor_id> &limit=50 (pagination curseur)
router.get('/channels/:channelId/messages', async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const { before, limit = '50' } = req.query;
    const take = Math.min(Number(limit), 100);

    const channel = await prisma.channel.findFirst({ where: { id: req.params.channelId, companyId } });
    if (!channel) return next(new NotFoundError('Canal introuvable'));

    const where = { channelId: channel.id, parentId: null }; // messages racine uniquement
    if (before) {
      const cursor = await prisma.message.findUnique({ where: { id: before } });
      if (cursor) where.createdAt = { lt: cursor.createdAt };
    }

    const messages = await prisma.message.findMany({
      where,
      include: {
        author: { select: { id: true, firstName: true, lastName: true, role: true } },
        replies: {
          include: {
            author: { select: { id: true, firstName: true, lastName: true } },
          },
          orderBy: { createdAt: 'asc' },
          take: 3, // aperçu du thread
        },
        _count: { select: { replies: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    res.json({ messages: messages.reverse(), hasMore: messages.length === take });
  } catch (err) {
    next(err);
  }
});

// POST /api/communication/channels/:channelId/messages
router.post('/channels/:channelId/messages', validate(messageSchema), audit('communication.message.create'), async (req, res, next) => {
  try {
    const { companyId, id: callerId, role } = req.user;
    const { content, parentId } = req.body;

    const channel = await prisma.channel.findFirst({ where: { id: req.params.channelId, companyId } });
    if (!channel) return next(new NotFoundError('Canal introuvable'));
    if (channel.isArchived) return next(new ForbiddenError('Ce canal est archivé'));

    // Canal ANNOUNCEMENT : seuls RH+ peuvent écrire (sauf en réponse à un thread)
    if (channel.kind === 'ANNOUNCEMENT' && !parentId) {
      const MANAGERS = ['RH', 'DRH', 'ADMIN'];
      if (!MANAGERS.includes(role)) {
        return next(new ForbiddenError('Seuls les RH+ peuvent publier dans un canal d\'annonces'));
      }
    }

    if (parentId) {
      const parent = await prisma.message.findFirst({ where: { id: parentId, channelId: channel.id } });
      if (!parent) return next(new NotFoundError('Message parent introuvable'));
    }

    const message = await prisma.message.create({
      data: { channelId: channel.id, authorId: callerId, content, parentId: parentId || null },
      include: {
        author: { select: { id: true, firstName: true, lastName: true, role: true } },
      },
    });

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/communication/messages/:id — modifier son propre message
router.patch('/messages/:id', async (req, res, next) => {
  try {
    const { companyId, id: callerId, role } = req.user;
    const { content } = req.body;
    if (!content || content.trim().length === 0) return next(new ValidationError('Le contenu est requis'));

    const message = await prisma.message.findFirst({
      where: { id: req.params.id },
      include: { channel: { select: { companyId: true } } },
    });
    if (!message || message.channel.companyId !== companyId) return next(new NotFoundError('Message introuvable'));

    const ADMIN_ROLES = ['DRH', 'ADMIN'];
    if (message.authorId !== callerId && !ADMIN_ROLES.includes(role)) {
      return next(new ForbiddenError('Vous ne pouvez modifier que vos propres messages'));
    }

    const updated = await prisma.message.update({
      where: { id: req.params.id },
      data: { content: content.trim(), editedAt: new Date() },
      include: { author: { select: { id: true, firstName: true, lastName: true } } },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/communication/messages/:id
router.delete('/messages/:id', async (req, res, next) => {
  try {
    const { companyId, id: callerId, role } = req.user;
    const ADMIN_ROLES = ['DRH', 'ADMIN'];

    const message = await prisma.message.findFirst({
      where: { id: req.params.id },
      include: { channel: { select: { companyId: true } } },
    });
    if (!message || message.channel.companyId !== companyId) return next(new NotFoundError('Message introuvable'));
    if (message.authorId !== callerId && !ADMIN_ROLES.includes(role)) {
      return next(new ForbiddenError('Vous ne pouvez supprimer que vos propres messages'));
    }

    await prisma.message.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/communication/messages/:id/pin — épingler (RH+)
router.post('/messages/:id/pin', requireRole('RH'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const message = await prisma.message.findFirst({
      where: { id: req.params.id },
      include: { channel: { select: { companyId: true } } },
    });
    if (!message || message.channel.companyId !== companyId) return next(new NotFoundError('Message introuvable'));

    const updated = await prisma.message.update({
      where: { id: req.params.id },
      data: { isPinned: !message.isPinned },
    });

    res.json({ isPinned: updated.isPinned });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
